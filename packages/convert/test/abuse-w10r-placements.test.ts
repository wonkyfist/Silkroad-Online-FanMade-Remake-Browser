/**
 * Adversarial hunt, wave 10r (lens "placements"): retail placements on the regraded coast ring and in the new sea.
 *
 * Reads the shipped export (work/out/world/jangan-fields) and, for the "before" ground, the retail Map archive. Skips
 * when either is missing. Each `it` is a failing proof of one finding (docs/COAST.md §3B.5 / §5.4 step 4, rule C9):
 * - vegetation must never stand on a sea texel below the sea level (C9's "dropped: new ground below SL + 0.5 m");
 * - a re-snapped placement must stand on the exported ground, at or above SL + 0.5 m;
 * - a kept retail placement whose origin ground moved by more than 0.5 m must have been dropped or re-snapped.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assembleRegionGrid, parseMapM } from '@sro/formats'
import { grassTileTable } from '../../world-render/src/grass/bake.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { decodeTerrainBin } from '../src/world/format.ts'
import type { WorldManifest } from '../src/world/manifest.ts'

const DIR = join(REPO_ROOT, 'work/out/world/jangan-fields')
const run = existsSync(join(DIR, 'manifest.json')) && existsSync(join(REPO_ROOT, 'sro.config.json'))
const G = 97

/** Minimal PNG decode (8-bit RGBA, non-interlaced) of coast/field.png. */
function decodeRgbaPng(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  let o = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (o < buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    const body = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 6) throw new Error('field.png: expected 8-bit RGBA')
    } else if (type === 'IDAT') idat.push(body)
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = new Uint8Array(width * height * bpp)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0
      const r = raw[src + x]!
      let v: number
      if (f === 0) v = r
      else if (f === 1) v = r + a
      else if (f === 2) v = r + b
      else if (f === 3) v = r + ((a + b) >> 1)
      else {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      out[y * stride + x] = v & 255
    }
  }
  return { width, height, data: out }
}

/** The rendered triangulation (scatter.ts heightAt); lxM east, lzM north, metres from the region's SW corner. */
function heightAt(h: ArrayLike<number>, lxM: number, lzM: number): number {
  const last = G - 1
  const gx = Math.min(Math.max(lxM / 2, 0), last)
  const gz = Math.min(Math.max(lzM / 2, 0), last)
  const ix = Math.min(Math.floor(gx), last - 1)
  const iz = Math.min(Math.floor(gz), last - 1)
  const fx = gx - ix
  const fz = gz - iz
  const h00 = h[iz * G + ix]!
  const h11 = h[(iz + 1) * G + ix + 1]!
  if (fx >= fz) {
    const h10 = h[iz * G + ix + 1]!
    return h00 + (h10 - h00) * fx + (h11 - h10) * fz
  }
  const h01 = h[(iz + 1) * G + ix]!
  return h00 + (h01 - h00) * fz + (h11 - h01) * fx
}

const VEGETATION = /[\\/]nature[\\/].*(tree|twig|brhwood|weed|bush|grass|flower|stump|dry)/i
const short = (s: string) => s.split(/[\\/]/).pop()!

describe.skipIf(!run)('abuse w10r placements: the coast ring and the new sea', () => {
  const m = run ? (JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as WorldManifest) : (null as unknown as WorldManifest)
  const coast = m?.coast
  const SL = coast?.seaLevelM ?? 0
  const report = () => (m.report as unknown as { coast: Record<string, any> }).coast
  const cache = new Map<string, Float32Array>()
  const region = (x: number, z: number) =>
    m.regions.find(r => x >= r.origin[0] && x < r.origin[0] + 192 && z <= r.origin[2] && z > r.origin[2] - 192)
  const ground = (x: number, z: number): number | null => {
    const r = region(x, z)
    if (!r) return null
    const k = `${r.x},${r.z}`
    if (!cache.has(k)) cache.set(k, decodeTerrainBin(new Uint8Array(readFileSync(join(DIR, r.terrain.file)))).heights)
    return heightAt(cache.get(k)!, x - r.origin[0], r.origin[2] - z)
  }
  let field: { width: number; height: number; data: Uint8Array } | null = null
  const seaTexel = (x: number, z: number) => {
    const f = coast!.field
    field ??= decodeRgbaPng(readFileSync(join(DIR, f.file)))
    const c = Math.floor((x - f.x0) / f.metresPerTexel)
    const r = Math.floor((z - f.z0) / f.metresPerTexel)
    if (c < 0 || r < 0 || c >= field.width || r >= field.height) return false
    return field.data[(r * field.width + c) * 4]! >= 128
  }

  it('no vegetation placement stands on a sea texel below the sea level (trees in the sea)', () => {
    const wet: string[] = []
    for (const p of m.placements) {
      if (!VEGETATION.test(p.source)) continue
      const [x, y, z] = p.position
      const g = ground(x, z)
      if (g === null || g >= SL || !seaTexel(x, z)) continue
      wet.push(`${p.region}/${p.uid} ${short(p.source)} at (${x.toFixed(0)}, ${z.toFixed(0)}) y ${y.toFixed(2)}, ground ${g.toFixed(2)} (${(SL - g).toFixed(1)} m under the sea)`)
    }
    expect(wet).toEqual([])
  })

  it('every re-snapped placement stands on exported ground at or above SL + 0.5 m (C9 resnaps only there)', () => {
    // placements.ts re-snaps by `y + delta` (the retail offset to the ground is kept, so a retail tree 1.7 m deep stays
    // 1.7 m deep: accepted). What must hold is the rule's own condition: there is ground, and it is >= SL + 0.5 m.
    const byKey = new Map(m.placements.map(p => [`${p.region}/${p.uid}`, p]))
    const bad: string[] = []
    for (const r of report().placements.resnapped as { region: number; uid: number; fromY: number; toY: number }[]) {
      const p = byKey.get(`${r.region}/${r.uid}`)
      if (!p) continue
      const g = ground(p.position[0], p.position[2])
      if (g === null || g < SL + 0.5) {
        const at = g === null ? 'no exported region under it' : `exported ground ${g.toFixed(2)}`
        bad.push(`${r.region}/${r.uid} ${short(p.source)} at (${p.position[0].toFixed(0)}, ${p.position[2].toFixed(0)}) y ${p.position[1].toFixed(2)}, ${at}${seaTexel(p.position[0], p.position[2]) ? ', on a sea texel' : ''}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('a kept retail placement whose origin ground moved by more than 0.5 m was dropped or re-snapped (C9)', () => {
    const map = openArchive('Map')
    const resnapped = new Set((report().placements.resnapped as { region: number; uid: number }[]).map(r => `${r.region}/${r.uid}`))
    // the world edits' own record (report.edits): objects the user moved or added stand where the user put them (the
    // editor's "keep objects on the ground" follow is a move), and the edits pass re-snaps the rest on moved ground
    // (edits/placements.ts); none of them may float over the exported ground
    const ed = m.report.edits?.placements
    const edited = new Set([...(ed?.added ?? []), ...(ed?.resnapped ?? [])].map(r => `${r.region}/${r.uid}`))
    const floating: string[] = []
    const retail = new Map<string, Float32Array | null>()
    const moved: string[] = []
    let compared = 0
    for (const p of m.placements) {
      const [x, y, z] = p.position
      const r = region(x, z)
      if (!r) continue
      const k = `${r.x},${r.z}`
      if (!retail.has(k)) {
        let h: Float32Array | null = null
        try {
          const grid = assembleRegionGrid(parseMapM(map.read(`${r.z}/${r.x}.m`)))
          h = Float32Array.from(grid.heights, v => v * 0.1)
        } catch {
          h = null
        }
        retail.set(k, h)
      }
      const old = retail.get(k)
      if (!old) continue
      const before = heightAt(old, x - r.origin[0], r.origin[2] - z)
      const after = ground(x, z)!
      compared++
      const key = `${p.region}/${p.uid}`
      if (Math.abs(after - before) <= 0.5 || resnapped.has(key)) continue
      if (edited.has(key)) {
        if (y - after > 0.5) floating.push(`${key} ${short(p.source)} in ${k}: y ${y.toFixed(2)} over ground ${after.toFixed(2)}`)
        continue
      }
      moved.push(`${key} ${short(p.source)} in ${k}: y ${y.toFixed(2)}, ground ${before.toFixed(2)} -> ${after.toFixed(2)}`)
    }
    expect(compared).toBeGreaterThan(1000)
    expect(moved).toEqual([])
    expect(floating).toEqual([])
  }, 120_000)

  it('grass never feathers onto water-typed ground: every tile typed Water (or Stone) is hard for the edge feather', () => {
    // The swamp's c_dust_swmp_05 / _06 are typed Water but their names carry no HARD_NAME word, so the feather treats
    // them as soft bare ground and carries grass tongues onto them; ~48.8k of their vertices have no water plane over
    // them, ~8k of those within 6 m of grass (swamp regions 158..167 x 94..101).
    const table = grassTileTable(m.tiles as never)
    const soft = m.tiles
      .filter(t => (t.typeName === 'Water' || t.typeName === 'Stone') && !table.hard.has(t.id))
      .map(t => `${t.id} ${t.typeName} ${short(t.source ?? '')}`)
    expect(soft).toEqual([])
  })

  it('a kept non-vegetation model never hangs over ground the coast lowered (floating cliffs on the ring)', () => {
    // The footprint check (placements.ts) only LISTS a kept model whose footprint covers moved ground. Measure what
    // the regrade did under it: the gap between the model's lowest point (bounds) and the ground, on a 9 x 9 grid over
    // its footprint, before (retail Map) and after (the export). A model that sat on its ground and now hangs > 3 m
    // over a lowered corner is a floating prop.
    const map = openArchive('Map')
    const retailCache = new Map<string, Float32Array>()
    const retailGround = (x: number, z: number): number | null => {
      const r = region(x, z)
      if (!r) return null
      const k = `${r.x},${r.z}`
      if (!retailCache.has(k)) {
        try {
          const grid = assembleRegionGrid(parseMapM(map.read(`${r.z}/${r.x}.m`)))
          retailCache.set(k, Float32Array.from(grid.heights, v => v * 0.1))
        } catch {
          return null
        }
      }
      return heightAt(retailCache.get(k)!, x - r.origin[0], r.origin[2] - z)
    }
    const byKey = new Map(m.placements.map(p => [`${p.region}/${p.uid}`, p]))
    const floating: string[] = []
    for (const f of report().footprintsOnMovedGround as { region: number; uid: number; source: string }[]) {
      if (VEGETATION.test(f.source)) continue
      const p = byKey.get(`${f.region}/${f.uid}`)
      const model = p && m.models[p.models[0] ?? -1]
      if (!p || !model || model.kind === 'failed') continue
      const [ax, ay, az] = model.boundsMin
      const [bx, , bz] = model.boundsMax
      const c = Math.cos(p.yaw)
      const s = Math.sin(p.yaw)
      const bottom = p.position[1] + ay
      let before = 0
      let after = 0
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const mx = ax + ((bx - ax) * i) / 8
          const mz = az + ((bz - az) * j) / 8
          const x = p.position[0] + mx * c + mz * s
          const z = p.position[2] - mx * s + mz * c
          const g0 = retailGround(x, z)
          const g1 = ground(x, z)
          if (g0 === null || g1 === null) continue
          before = Math.max(before, bottom - g0)
          after = Math.max(after, bottom - g1)
        }
      }
      if (after > 3 && after > before + 2) {
        floating.push(`${f.region}/${f.uid} ${short(f.source)} at (${p.position[0].toFixed(0)}, ${p.position[2].toFixed(0)}): lowest point ${before.toFixed(1)} m over the retail ground, ${after.toFixed(1)} m over the new ground`)
      }
    }
    expect(floating).toEqual([])
  }, 120_000)
})
