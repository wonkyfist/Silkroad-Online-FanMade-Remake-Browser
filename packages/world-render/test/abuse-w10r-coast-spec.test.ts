/**
 * W10R adversarial hunt, lens "coast-spec" (docs/COAST.md §12.9 H-CST and §12.13's beach lenses): flooding, the sea
 * mask, seams at the bounds line and the bay mouth, S1, nav holes. Read on the shipped export
 * (work/out/world/jangan-fields: manifest, coast/field.png through the client's own CoastField and its `drawsWater`
 * rule, the terrain bins, nav.bin); skipped without it. No product code is changed.
 *
 * Passing guards:
 * - no flooding: away from the waterline the ocean never draws over dry ground more than 1 m below the sea level
 *   (the town at -3.26 m, the moat, the ruins basin, the east bound at z 99-101, 170,102);
 * - S1 (170.5, 90.6) is in the town's nav component with every region outside the bounds closed (G1).
 *
 * Findings (failing):
 * 1. Water walls along the bounds line (convert, coast pass). Where a retail water block at the sea level (+5 m) ends
 *    at the line, the ground just outside is kept export ground below the sea level that the pass leaves dry
 *    (pass.ts step 9: `h < SL && (u >= 0 || !kept || bandFill)`, the X2 "hollow behind the dune" rule, applied to the
 *    kept retail rows outside the bounds), and the ocean does not draw there: the +5 m plane ends in mid-air over a
 *    dry trench. East line 175.0 x 100.0-100.6 (the spot COAST §13 names: ~110 m, 5 m drop), N4 (the bay's east arm)
 *    170.4-170.8 x 103.0 (~70 m, up to 10 m), the S2 mouth 165.0 x 90.0 (~17 m, 5 m).
 * 2. S1 (convert, the S1 height patch). The S2 river's +5 m plane (165_90) ends at x = -384 (166.0) over the patch's
 *    first dry columns, which start at the retail 0 m and stay below the sea level for ~6 m before the dune: a 5 m
 *    water wall for ~190 m along the S1 dune's west foot, and at 166.0-166.3 x 90.95-91.0 a dry retail channel down to
 *    -27 m beside the river (a 32 m drop). That pit is walkable and in the town's nav component.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NavWorld, TERRAIN_SURFACE, decodeNavData } from '@sro/nav'
import { beforeAll, describe, expect, it } from 'vitest'
import { closeRing } from '../../convert/src/world/coast/links.ts'
import { decodeTerrainBin, terrainHeightAt, type TerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { CoastField, decodePng, drawsWater, joinBlocks, type FieldSample } from '../src/ocean/field.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUT = join(ROOT, 'work', 'out', 'world', 'jangan-fields')
const COAST = join(ROOT, 'content', 'coast', 'coast.json')
const hasExport = existsSync(join(OUT, 'manifest.json')) && existsSync(join(OUT, 'nav.bin')) && existsSync(COAST)

/** Region units (x east, z as the region grid) of glTF (x, z): the export's origin region is 168, 97. */
const RX = (x: number) => 168 + x / 192
const RZ = (z: number) => 97 - z / 192

interface Ground {
  h: number
  water: { heightM: number } | null
}

describe.skipIf(!hasExport)('H-CST on the shipped jangan-fields export', () => {
  let m: WorldManifest
  let field: CoastField
  let SL: number
  let patches: Array<{ x: [number, number]; z: [number, number] }>
  let corridor: { x: [number, number]; z: [number, number] } | null
  const regions = new Map<string, { r: WorldManifest['regions'][number]; t: TerrainBin }>()
  const s: FieldSample = { sea: 0, distanceM: 0, elevationM: 0, join: 0 }

  const ground = (x: number, z: number): Ground | null => {
    const e = regions.get(`${168 + Math.floor(x / 192)}_${97 + Math.floor(-z / 192)}`)
    if (!e) return null
    const o = e.r.origin
    const lx = (x - o[0]) * 10
    const lz = (o[2] - z) * 10
    const b = e.r.blocks?.[Math.min(5, Math.floor(lz / 320)) * 6 + Math.min(5, Math.floor(lx / 320))]
    return { h: terrainHeightAt(e.t.heights, lx, lz), water: b?.water ?? null }
  }
  const inBounds = (x: number, z: number) => x > m.bounds!.minX && x < m.bounds!.maxX && z > m.bounds!.minZ && z < m.bounds!.maxZ
  // every height patch (S1, and S2-bank since the W10R fix: the river channel beside S1 is the patch's sea)
  const inPatch = (x: number, z: number) => patches.some(p => RX(x) > p.x[0] && RX(x) <= p.x[1] && RZ(z) >= p.z[0] && RZ(z) < p.z[1])
  // Option A's corridor is retail scenery, bit for bit (COAST C12): its banks are retail's own
  const inCorridor = (x: number, z: number) => !!corridor && RX(x) >= corridor.x[0] && RX(x) <= corridor.x[1] && RZ(z) >= corridor.z[0] && RZ(z) <= corridor.z[1]
  /** Within 2 m outside the bounds line, the point mirrored across it is dry ground more than 0.5 m under the sea
   *  level with no water block: the plane's edge there is retail's own in-bounds edge, carried one lattice cell on. */
  const retailEdgeCarried = (x: number, z: number) => {
    const b = m.bounds!
    const mx = x > b.maxX && x - b.maxX < 2 ? 2 * b.maxX - x : x < b.minX && b.minX - x < 2 ? 2 * b.minX - x : null
    const mz = z > b.maxZ && z - b.maxZ < 2 ? 2 * b.maxZ - z : z < b.minZ && b.minZ - z < 2 ? 2 * b.minZ - z : null
    if (mx === null && mz === null) return false
    const g = ground(mx ?? x, mz ?? z)
    return !!g && !g.water && g.h < SL - 0.5
  }
  const oceanAt = (x: number, z: number) => drawsWater(field.sample(x, z, s))

  beforeAll(async () => {
    m = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as WorldManifest
    SL = m.coast!.seaLevelM
    const img = await decodePng(new Uint8Array(readFileSync(join(OUT, m.coast!.field.file))))
    field = new CoastField(m.coast!, img, joinBlocks(m, SL))
    for (const r of m.regions) if (r.terrain) regions.set(`${r.x}_${r.z}`, { r, t: decodeTerrainBin(new Uint8Array(readFileSync(join(OUT, r.terrain.file)))) })
    const cfg = JSON.parse(readFileSync(COAST, 'utf8')) as {
      allowHeightPatches: Array<{ name: string; x: [number, number]; z: [number, number] }>
      corridor: { x: [number, number]; z: [number, number] } | null
    }
    patches = cfg.allowHeightPatches
    corridor = cfg.corridor
  }, 120_000)

  /**
   * The edges (1 m steps, probed 1 m either side) of every retail water block at the sea level whose plane shows at
   * its edge (ground under it inside) and whose outer side is dry ground more than 0.5 m below the plane, with no water
   * block and no ocean: a water wall. Grouped by 0.1 region.
   */
  function waterWalls(keep: (x: number, z: number) => boolean): Array<{ at: string; metres: number; dropM: number }> {
    const walls = new Map<string, { metres: number; dropM: number }>()
    for (const b of joinBlocks(m, SL)) {
      for (let t = 0.5; t < 32; t += 1) {
        const probes: Array<[number, number, number, number]> = [
          [b.x0 + t, b.z0 - 1, b.x0 + t, b.z0 + 1], [b.x0 + t, b.z1 + 1, b.x0 + t, b.z1 - 1],
          [b.x0 - 1, b.z0 + t, b.x0 + 1, b.z0 + t], [b.x1 + 1, b.z0 + t, b.x1 - 1, b.z0 + t],
        ]
        for (const [ox, oz, ix, iz] of probes) {
          if (!keep(ox, oz)) continue
          const out = ground(ox, oz)
          const inn = ground(ix, iz)
          if (!out || !inn || out.water || inn.h >= SL || out.h >= SL - 0.5 || oceanAt(ox, oz)) continue
          const at = `${RX(ox).toFixed(1)},${RZ(oz).toFixed(1)}`
          const w = walls.get(at) ?? { metres: 0, dropM: 0 }
          w.metres++
          w.dropM = Math.max(w.dropM, +(SL - out.h).toFixed(1))
          walls.set(at, w)
        }
      }
    }
    return [...walls].map(([at, w]) => ({ at, ...w })).sort((a, b) => a.at.localeCompare(b.at))
  }

  it('guard: away from the waterline the ocean never draws over dry ground more than 1 m below the sea level', () => {
    const f = m.coast!.field
    const floods: string[] = []
    for (let z = f.z0 + 2; z < f.z0 + f.height * f.metresPerTexel; z += 4) {
      for (let x = f.x0 + 2; x < f.x0 + f.width * f.metresPerTexel; x += 4) {
        const g = ground(x, z)
        if (!g || g.h >= SL - 1 || (g.water && g.water.heightM > g.h)) continue
        if (!oceanAt(x, z)) continue
        // The sea itself (and S1's in-bounds sea); the swash band only right at the waterline (the filtering).
        if (s.sea >= 0.5 && (!inBounds(x, z) || inPatch(x, z))) continue
        if (s.sea < 0.5 && s.distanceM > -4) continue
        floods.push(`${RX(x).toFixed(2)},${RZ(z).toFixed(2)} ground ${g.h.toFixed(1)}`)
      }
    }
    expect(floods).toEqual([])
  }, 120_000)

  it('guard: S1 is in the town\'s nav component with every region outside the bounds closed (G1)', () => {
    const nav = new NavWorld(closeRing(decodeNavData(new Uint8Array(readFileSync(join(OUT, 'nav.bin')))), m.stream!.playable))
    const o = m.space.originRegion
    const home = nav.locate(o.x * 1920 + m.spawn!.x * 10, o.z * 1920 - m.spawn!.z * 10, m.spawn!.y * 10)!
    const hc = nav.componentOf(home)
    const s1 = nav.componentOf({ x: 170.5 * 1920, z: 90.6 * 1920, surface: TERRAIN_SURFACE })
    expect(hc).toBeGreaterThanOrEqual(0)
    expect(s1 >= 0 && nav.componentReaches(hc, s1) && nav.componentReaches(s1, hc)).toBe(true)
  }, 60_000)

  it('finding 1: no sea-level water plane ends over a dry trench below the sea level outside the bounds', () => {
    // the corridor (C12) and retail's own in-bounds edges carried one cell past the line are not the coast's walls
    const walls = waterWalls((x, z) => !inBounds(x, z) && !inCorridor(x, z) && !retailEdgeCarried(x, z))
    // Fails: the east line (175.0, 100.0-100.6), N4 (170.4-170.8, 103.0) and the S2 mouth (165.0, 90.0).
    expect(walls).toEqual([])
  }, 120_000)

  it('finding 2: S1 - the S2 river\'s plane never ends over dry patch ground below the sea level', () => {
    const walls = waterWalls((x, z) => inBounds(x, z) && RX(x) >= 165.95 && RX(x) < 166.5 && RZ(z) >= 90 && RZ(z) <= 91.01)
    // Fails: ~190 m of a 5 m wall along x = -384 (166.0, 90.0-90.9), up to 32 m at the channel (166.0-166.3, 91.0).
    expect(walls).toEqual([])
  }, 120_000)

  it('finding 2: the dry channel beside the S2 river (166.03, 90.95; ground -27 m) is not walkable from town', () => {
    const x = -379
    const z = 1161
    const g = ground(x, z)!
    // Since the W10R fix the channel is the S2-bank patch's sea (coast/banks.ts): the ocean continues the river over it
    // and its nav closes (knee-deep, C7). Either way it must not be a dry pit, nor walkable from town.
    expect(g.h >= SL - 0.4 || !!g.water || oceanAt(x, z), 'a dry pit beside the river').toBe(true)
    const nav = new NavWorld(closeRing(decodeNavData(new Uint8Array(readFileSync(join(OUT, 'nav.bin')))), m.stream!.playable))
    const o = m.space.originRegion
    const hc = nav.componentOf(nav.locate(o.x * 1920 + m.spawn!.x * 10, o.z * 1920 - m.spawn!.z * 10, m.spawn!.y * 10)!)
    const c = nav.componentOf({ x: o.x * 1920 + x * 10, z: o.z * 1920 - z * 10, surface: TERRAIN_SURFACE })
    // Fails: a player walks from town down into a dry pit 32 m under the river's surface, next to the new beach.
    expect(c >= 0 && nav.componentReaches(hc, c), 'the pit is in the town\'s component').toBe(false)
  }, 60_000)
})
