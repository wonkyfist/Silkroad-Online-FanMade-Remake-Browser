/**
 * The authored coast layers (docs/COAST.md §6.3, §6.4): the Blender round trip's per-region height layers in
 * content/coast/height/<x>_<z>.png, merged into the procedural base by weight. The converter reads them here; the
 * round trip itself (export, readback, the full validator with its guards) is CST-B's ../../tools/coast-blender.ts.
 *
 * Format: 97 x 97 16-bit grey + alpha (LA16), PNG row 0 = north, column 0 = west; L = round((h + 100) / 500 * 65535),
 * A = the override weight (65535: the authored height wins, 0: the procedural base). Merge: h = lerp(h, authored, w),
 * never on the frozen playable set (outside the height patches), the corridor (Option A's retail land bridge) nor the
 * tomb keep, which win afterwards (the frozen check). A layer that breaks a rule is refused whole (the converter warns and keeps the base there).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { CELLS_PER_REGION } from './lattice.ts'
import type { CoastResult } from './pass.ts'

export const LA16_MIN_M = -100
export const LA16_SPAN_M = 500
const G = CELLS_PER_REGION + 1

export interface AuthoredHeightLayer {
  x: number
  z: number
  /** 97 x 97 heights (m), index gz * 97 + gx (gz = 0 the south edge). */
  h: Float32Array
  /** 97 x 97 weights 0..1. */
  w: Float32Array
  file: string
}

/** The height layers under `dir` (content/coast); problems (format, names) go to `errors` and skip the file. */
export async function readAuthoredHeights(dir: string, errors: string[]): Promise<AuthoredHeightLayer[]> {
  const hdir = join(dir, 'height')
  if (!existsSync(hdir)) return []
  const out: AuthoredHeightLayer[] = []
  for (const f of readdirSync(hdir).sort()) {
    if (!f.endsWith('.png')) continue
    const m = /^(\d+)_(\d+)\.png$/.exec(f)
    if (!m) {
      errors.push(`coast/height/${f}: expected <x>_<z>.png`)
      continue
    }
    const file = join(hdir, f)
    const meta = await sharp(file).metadata()
    if (meta.width !== G || meta.height !== G || meta.channels !== 2 || (meta.bitsPerSample ?? 16) !== 16) {
      errors.push(`coast/height/${f}: expected ${G} x ${G} 16-bit grey + alpha, got ${meta.width} x ${meta.height}, ${meta.channels} channel(s)`)
      continue
    }
    // without toColourspace('grey16') sharp silently reads LA16 as 8-bit RGBA (docs/COAST.md §6.3)
    const { data } = await sharp(file).toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
    const px = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
    const h = new Float32Array(G * G)
    const w = new Float32Array(G * G)
    for (let row = 0; row < G; row++) {
      for (let gx = 0; gx < G; gx++) {
        const k = (row * G + gx) * 2
        const g = (G - 1 - row) * G + gx
        h[g] = (px[k]! / 65535) * LA16_SPAN_M + LA16_MIN_M
        w[g] = px[k + 1]! / 65535
      }
    }
    out.push({ x: Number(m[1]), z: Number(m[2]), h, w, file })
  }
  return out
}

/**
 * Merges the layers into the pass result's heights (in place) and returns what it did. A layer outside the lattice,
 * with weight on the frozen playable set (outside a height patch), on the corridor or on a land edge, or whose shared
 * edges disagree with a neighbour layer, is refused (listed in `errors`).
 */
export function mergeAuthoredHeights(r: CoastResult, layers: readonly AuthoredHeightLayer[], errors: string[]): { layers: number; weighted: number } {
  const l = r.shape
  const byKey = new Map(layers.map(L => [`${L.x},${L.z}`, L]))
  let merged = 0
  let weighted = 0
  for (const L of layers) {
    if (L.x < l.x0 || L.x > l.x1 || L.z < l.z0 || L.z > l.z1) {
      errors.push(`coast/height/${L.x}_${L.z}.png: outside the coast domain`)
      continue
    }
    const problems: string[] = []
    for (let gz = 0; gz < G && problems.length < 4; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const g = gz * G + gx
        if (!(L.w[g]! > 0)) continue
        const k = ((l.z1 - L.z) * CELLS_PER_REGION + CELLS_PER_REGION - gz) * l.cols + (L.x - l.x0) * CELLS_PER_REGION + gx
        if (r.masks.inPlay[k] && !r.masks.patch[k]) problems.push(`vertex (${gx}, ${gz}) is on the frozen playable set`)
        else if (r.masks.inCorr[k] && r.masks.have[k]) problems.push(`vertex (${gx}, ${gz}) is on the corridor (retail scenery)`)
        // a phase-2 layer under a phase-1 config (the scope-cut fallback) would move a land edge
        else if (r.landFade[k]! >= 0.5 && r.masks.have[k]) problems.push(`vertex (${gx}, ${gz}) is on a land edge (kept retail)`)
        // a weighted edge vertex needs the same value in the neighbour's layer
        const nb: Array<[number, number, number, number]> = []
        if (gx === 0) nb.push([L.x - 1, L.z, CELLS_PER_REGION, gz])
        if (gx === CELLS_PER_REGION) nb.push([L.x + 1, L.z, 0, gz])
        if (gz === 0) nb.push([L.x, L.z - 1, gx, CELLS_PER_REGION])
        if (gz === CELLS_PER_REGION) nb.push([L.x, L.z + 1, gx, 0])
        for (const [nx, nz, ngx, ngz] of nb) {
          const N = byKey.get(`${nx},${nz}`)
          const j = ngz * G + ngx
          if (!N) problems.push(`weighted edge vertex (${gx}, ${gz}) but ${nx}_${nz}.png is missing`)
          else if (N.w[j] !== L.w[g] || Math.abs(N.h[j]! - L.h[g]!) > 1e-6) problems.push(`seam with ${nx}_${nz}.png differs at (${gx}, ${gz})`)
        }
        if (problems.length >= 4) break
      }
    }
    if (problems.length) {
      errors.push(`coast/height/${L.x}_${L.z}.png refused: ${problems.join('; ')}`)
      continue
    }
    merged++
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const g = gz * G + gx
        const w = L.w[g]!
        if (!(w > 0)) continue
        const k = ((l.z1 - L.z) * CELLS_PER_REGION + CELLS_PER_REGION - gz) * l.cols + (L.x - l.x0) * CELLS_PER_REGION + gx
        if (r.masks.tombKeep[k]) continue
        r.h[k] = r.h[k]! + (L.h[g]! - r.h[k]!) * Math.min(1, w)
        weighted++
      }
    }
  }
  return { layers: merged, weighted }
}
