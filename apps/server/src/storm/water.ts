import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Where the water is (docs/WEATHER.md §13.3), for the tornado: its path never crosses water and nothing it throws lands
 * in it. The navmesh already closes deep water (closed terrain cells), but shallow lakes and river edges stay walkable;
 * the world export's water planes (manifest `regions[].blocks[].water`, one flat plane per 32 m block, TERRAIN.md 4)
 * tell them apart: a point is wet when the plane stands more than WATER_DEPTH_M above the surface there (a bridge over
 * a river stands above its plane, so it stays dry).
 *
 * Loaded once, lazily and asynchronously, from the manifest the server already serves (like the lightning rods); until
 * it is ready (or without an export) nothing counts as water.
 */

/** A plane at least this far above the ground (m) makes the point water. */
export const WATER_DEPTH_M = 0.35

const REGION_M = 192
const BLOCK_M = 32

/** The parts of a world manifest (packages/convert world/manifest.ts) read here. */
export interface WaterManifest {
  regions: { origin: number[]; blocks?: ({ water: { heightM: number } | null } | null)[] }[]
}

export class WaterIndex {
  /** "rx,rz" (region index from the floating origin) -> 36 plane heights (NaN: none). */
  private readonly regions = new Map<string, Float32Array>()
  readonly planes: number

  constructor(m: WaterManifest) {
    let planes = 0
    for (const r of m.regions ?? []) {
      const o = r.origin
      if (!Array.isArray(o) || o.length < 3 || !Array.isArray(r.blocks)) continue
      const h = new Float32Array(36).fill(NaN)
      let any = false
      r.blocks.forEach((b, i) => {
        const w = b?.water
        if (i < 36 && w && Number.isFinite(w.heightM)) {
          h[i] = w.heightM
          any = true
          planes++
        }
      })
      if (any) this.regions.set(`${Math.round(o[0]! / REGION_M)},${Math.round(-o[2]! / REGION_M)}`, h)
    }
    this.planes = planes
  }

  /** The water plane's height over x/z (glTF metres), or null. */
  planeAt(x: number, z: number): number | null {
    const rx = Math.floor(x / REGION_M)
    const rz = Math.floor(-z / REGION_M)
    const h = this.regions.get(`${rx},${rz}`)
    if (!h) return null
    // the region spans x in [rx·192, rx·192 + 192] and z in [-(rz+1)·192, -rz·192]; block bz counts northward (-z)
    const bx = Math.min(5, Math.max(0, Math.floor((x - rx * REGION_M) / BLOCK_M)))
    const bz = Math.min(5, Math.max(0, Math.floor((-z - rz * REGION_M) / BLOCK_M)))
    const v = h[bz * 6 + bx]!
    return Number.isNaN(v) ? null : v
  }

  /** Whether a body standing at x/z on a surface at height `y` would stand in water. */
  wet(x: number, z: number, y: number): boolean {
    const p = this.planeAt(x, z)
    return p !== null && Number.isFinite(y) && p - y > WATER_DEPTH_M
  }
}

/** Reads the water planes of `folder` from the first of `dirs` with a manifest; null (with the reason) without one. */
export async function loadWater(dirs: readonly string[], folder: string): Promise<{ index: WaterIndex | null; problem: string }> {
  let problem = 'no world manifest'
  for (const dir of dirs) {
    const file = join(dir, 'world', folder, 'manifest.json')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    try {
      const m = JSON.parse(text) as WaterManifest
      if (!Array.isArray(m.regions)) {
        problem = `${file} has no regions`
        continue
      }
      return { index: new WaterIndex(m), problem: '' }
    } catch (e) {
      problem = `${file}: ${(e as Error).message}`
    }
  }
  return { index: null, problem }
}
