/**
 * The navigation shipped with the Jangan world (work/out/world/jangan: nav.bin + manifest.nav + manifest.spawn), as
 * written by `pnpm sro convert-region --preset jangan`. Skips without that output or without sro.config.json.
 *
 * Ground truth besides the output's self-consistency:
 * - nav.bin must equal @sro/nav rebuilt straight from the client's .nvm/.bms files (catches a stale output);
 * - the spawn must be Media textdata teleportdata.txt's GATE_CH row (read here with the plain textdata parser, not
 *   the converter's) converted with space.ts;
 * - the render meshes (not the navmesh) of the objects around the spawn must have a floor at the spawn height and
 *   nothing within a character's height above it;
 * - the original npcpos.txt heights of the NPCs standing on Jangan's plaza must equal the nav surface there, well
 *   above the terrain (the "sunk into the plaza" bug).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseBms, parseBsr, parseNvm, parseObjectIfo, parseTextdata } from '@sro/formats'
import {
  buildNavData, createObjectNavMeshResolver, decodeNavData, NavGltf, NavWorld, TERRAIN_SURFACE, type NavData,
  type NavPosition,
} from '@sro/nav'
import { toGltfPosition } from '../src/gltf/space.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { validateWorldManifest, type WorldManifest } from '../src/world/manifest.ts'
import { spawnProblem } from '../src/world/nav.ts'

const OUT = join(REPO_ROOT, 'work', 'out', 'world', 'jangan')
const hasOutput = existsSync(join(OUT, 'manifest.json'))
const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const REGION = 1920
/** The lead's test point next to the fountain (glTF metres), on the plaza 1.5 m above the terrain. */
const PLAZA: [number, number] = [100.84, -71.5]
const PLAZA_MESH = 'prim/mesh/bldg/china/jangan01/cj_jang_gate06.bms'

describe.skipIf(!hasOutput || !hasConfig)('world navigation output (work/out/world/jangan)', () => {
  let m: WorldManifest
  let data: NavData
  let w: NavWorld
  let g: NavGltf
  const keyOf = (p: NavPosition) => (p.surface.kind === 'object' ? w.instanceInfo(p.surface.instance).model : 'terrain')
  const textdata = (name: string) => parseTextdata(openArchive('Media').read(`server_dep/silkroad/textdata/${name}`), name).rows

  beforeAll(() => {
    m = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as WorldManifest
    data = decodeNavData(new Uint8Array(readFileSync(join(OUT, m.nav!.file))))
    w = new NavWorld(data)
    g = new NavGltf(w, m.space.originRegion)
  })

  it('loads nav.bin as described by manifest.nav, identical to @sro/nav built from the client', () => {
    expect(validateWorldManifest(m)).toEqual([])
    expect(m.nav).toMatchObject({ file: 'nav.bin', format: 'SRNV', version: 1, space: 'file', instances: 547, links: 6, models: 134 })
    expect(readFileSync(join(OUT, m.nav!.file)).byteLength).toBe(m.nav!.bytes)
    expect(data.regions.map(r => r.id)).toEqual(m.regions.map(r => r.id))
    expect(data.instances).toHaveLength(547)
    // The old per-region navmesh bins are still there.
    for (const r of m.regions) expect(existsSync(join(OUT, r.navmesh!.file))).toBe(true)
    // Rebuilt from the client: same data (so the output is current and nothing was lost in the file).
    const archive = openArchive('Data')
    const read = (p: string) => (archive.has(p) ? archive.read(p) : undefined)
    const regions = m.regions.map(r => ({ id: r.id, nvm: parseNvm(archive.read(`navmesh/nv_${r.id.toString(16).padStart(4, '0')}.nvm`)) }))
    const warnings: string[] = []
    const fresh = buildNavData({ regions, objectNavMesh: createObjectNavMeshResolver(parseObjectIfo(archive.read('navmesh/object.ifo')), read, warnings) }, warnings)
    expect(warnings).toEqual([])
    expect(data).toEqual(fresh)
    // Every placement whose object has a navmesh is a nav instance, big objects owned by neighbours included.
    const ids = new Set(data.instances.map(i => i.id))
    const withNav = m.placements.filter(p => data.instances.some(i => i.objId === p.objId))
    expect(withNav.every(p => ids.has(p.region * 0x10000 + p.uid))).toBe(true)
    const outside = m.placements.filter(p => !p.inConvertedRegion && ids.has(p.region * 0x10000 + p.uid))
    expect(outside.length).toBe(m.nav!.neighbourInstances)
    expect(m.nav!.neighbourInstances).toBeGreaterThan(0)
  })

  it('spawns at teleportdata GATE_CH (Jangan\'s return point), converted with space.ts', () => {
    const row = textdata('teleportdata.txt').find(r => r.cells[0] === '1' && r.cells[2] === 'GATE_CH')!.cells
    // Service, ID, CodeName, AssocRefObjID (2094 = STORE_CH_GATE), ZoneName, GenRegionID, GenPos X/Y/Z, radius, CanBeResurrectPos
    expect(row.slice(2, 11)).toEqual(['GATE_CH', '2094', 'SN_ZONE_22001', '25000', '969', '0', '1369', '150', '1'])
    const region = Number(row[5])
    const [rx, rz] = [region & 0xff, region >> 8]
    const o = m.space.originRegion
    const p = toGltfPosition([REGION * (rx - o.x) + Number(row[6]), 0, REGION * (rz - o.z) + Number(row[8])])
    const sp = m.spawn!
    expect(sp.x).toBeCloseTo(p[0], 4)
    expect(sp.z).toBeCloseTo(p[2], 4)
    expect([sp.x, sp.z]).toEqual([96.9, -136.9])
    expect(sp.yaw).toBe(0)
    expect(sp.source).toContain('GATE_CH')
    // The nav glTF frame agrees with space.ts at the spawn.
    expect(g.fileX(sp.x)).toBeCloseTo(REGION * rx + 969, 6)
    expect(g.fileZ(sp.z)).toBeCloseTo(REGION * rz + 1369, 6)
  })

  it('has a spawn y that is the walkable surface locate() returns (the plaza), not inside an object', () => {
    const sp = m.spawn!
    const at = g.locate(sp.x, sp.z, sp.y)!
    expect(at.y).toBeCloseTo(sp.y, 3)
    // The native spawn rule (nearest height to GenPos_Y = 0) and the highest surface agree.
    expect(g.locate(sp.x, sp.z, 0)!.y).toBeCloseTo(sp.y, 3)
    expect(g.locate(sp.x, sp.z, Infinity)!.y).toBeCloseTo(sp.y, 3)
    expect(keyOf(at)).toBe(PLAZA_MESH)
    expect(sp.y).toBeCloseTo(-3.261, 3)
    expect(g.canStand(sp.x, sp.z, sp.y)).toBe(true)
    expect(spawnProblem(w, g.toFile(at))).toBeNull()
    // Walk 10 m in 8 directions: never blocked, never off the plaza or below it (north it steps up 0.74 m).
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 2 * Math.PI
      const r = g.moveStraight(at, sp.x + 10 * Math.sin(a), sp.z + 10 * Math.cos(a))
      expect(r.blocked).toBe(false)
      expect(keyOf(r.end)).toBe(PLAZA_MESH)
      expect(r.end.y - sp.y).toBeGreaterThan(-0.01)
      expect(r.end.y - sp.y).toBeLessThan(1)
    }
  })

  /**
   * Vertical rays through the render meshes of the placements within 60 m, over a 0.4 m disc around glTF (x, z):
   * the floor nearest `y` (m, centre ray; meshes other than the collision/nav mesh only, so it does not depend on the
   * navmesh) and every hit of any mesh 0.2..2 m above `y`.
   */
  function renderCast(x: number, z: number, y: number): { floorGap: number; above: string[]; meshes: number } {
    const archive = openArchive('Data')
    const fx = g.fileX(x), fz = g.fileZ(z), fy = y * 10
    const o = m.space.originRegion
    let floorGap = Infinity
    const above: string[] = []
    let meshes = 0
    for (const pl of m.placements) {
      const px = REGION * o.x + pl.position[0] * 10
      const pz = REGION * o.z - pl.position[2] * 10
      if (Math.hypot(px - fx, pz - fz) > 600) continue
      const c = Math.cos(pl.yaw), s = Math.sin(pl.yaw)
      for (const mi of pl.models) {
        const bsr = parseBsr(archive.read(m.models[mi]!.source))
        const nav = bsr.collision.meshPath.replace(/\\/g, '/').toLowerCase()
        for (const mesh of bsr.meshes) {
          const isNav = mesh.path.replace(/\\/g, '/').toLowerCase() === nav
          meshes++
          const bms = parseBms(archive.read(mesh.path))
          const P = bms.positions
          for (let k = 0; k < 9; k++) {
            const [dx, dz] = k === 0 ? [0, 0] : [4 * Math.cos(k * Math.PI / 4), 4 * Math.sin(k * Math.PI / 4)]
            const wx = fx + dx - px, wz = fz + dz - pz
            const lx = c * wx + s * wz, lz = -s * wx + c * wz
            for (let t = 0; t < bms.indices.length; t += 3) {
              const [a, b, d] = [bms.indices[t]! * 3, bms.indices[t + 1]! * 3, bms.indices[t + 2]! * 3]
              const det = (P[b]! - P[a]!) * (P[d + 2]! - P[a + 2]!) - (P[d]! - P[a]!) * (P[b + 2]! - P[a + 2]!)
              if (Math.abs(det) < 1e-9) continue
              const u = ((lx - P[a]!) * (P[d + 2]! - P[a + 2]!) - (P[d]! - P[a]!) * (lz - P[a + 2]!)) / det
              const v = ((P[b]! - P[a]!) * (lz - P[a + 2]!) - (lx - P[a]!) * (P[b + 2]! - P[a + 2]!)) / det
              if (u < 0 || v < 0 || u + v > 1) continue
              const hy = pl.position[1] * 10 + P[a + 1]! + u * (P[b + 1]! - P[a + 1]!) + v * (P[d + 1]! - P[a + 1]!)
              if (k === 0 && !isNav) floorGap = Math.min(floorGap, Math.abs(hy - fy) / 10)
              if (hy > fy + 2 && hy < fy + 20) above.push(`${mesh.path.split(/[\\/]/).pop()} +${((hy - fy) / 10).toFixed(2)} m`)
            }
          }
        }
      }
    }
    return { floorGap, above, meshes }
  }

  it('has render geometry under the spawn at its height and a character\'s headroom above (independent of the navmesh)', () => {
    const sp = m.spawn!
    const at = renderCast(sp.x, sp.z, sp.y)
    expect(at.meshes).toBeGreaterThan(0)
    // A rendered floor within 5 cm of the spawn height (the plaza's paving, cj_jang_gate.bsr's render meshes).
    expect(at.floorGap).toBeLessThan(0.05)
    // Nothing rendered from 0.2 m to 2 m above the feet: the character is not inside an object.
    expect(at.above).toEqual([])
    // Control: the same cast inside the stone statue c_sta_01 17 m west (on the terrain, -3.317 m) does find it.
    const control = renderCast(79.874, -137.028, -3.317)
    console.log(`spawn render cast: floor gap ${at.floorGap.toFixed(3)} m over ${at.meshes} meshes; statue control: ${control.above.length} hit(s), e.g. ${control.above.slice(0, 3).join(', ')}`)
    expect(control.above.length).toBeGreaterThan(0)
  })

  it('resolves the fountain point (100.84, -71.5) to the plaza surface, 1.5 m above the terrain', () => {
    for (const hint of [Infinity, -3.3, 0]) {
      const p = g.locate(...PLAZA, hint)!
      expect(keyOf(p)).toBe(PLAZA_MESH)
      expect(p.y).toBeCloseTo(-3.261, 2)
    }
    expect(w.terrainHeight(g.fileX(PLAZA[0]), g.fileZ(PLAZA[1])) / 10).toBeCloseTo(-4.791, 2)
    // From the spawn (51 m north of the fountain) straight at it: the fountain lies in between, so the walker stops
    // at the basin's rim (a flag-3 outline edge of the plaza), on the plaza, 9+ m from the fountain centre.
    const start = g.locate(m.spawn!.x, m.spawn!.z, m.spawn!.y)!
    const direct = g.moveStraight(start, ...PLAZA)
    expect(direct.blocked).toBe(true)
    expect(direct.hit).toMatchObject({ kind: 'edge', outline: true, flag: 3 })
    expect(keyOf(direct.end)).toBe(PLAZA_MESH)
    expect(Math.hypot(direct.end.x - 97.9, direct.end.z + 85.6)).toBeGreaterThan(9)
    // Around the fountain's east side it arrives, never leaving the plaza surface.
    let pos = start
    for (const [x, z] of [[115, -100], [115, -75], PLAZA] as [number, number][]) {
      const r = g.moveStraight(pos, x, z)
      expect(r.blocked).toBe(false)
      expect(r.legs.every(l => l.surface !== TERRAIN_SURFACE)).toBe(true)
      pos = r.end
    }
    expect(keyOf(pos)).toBe(PLAZA_MESH)
    expect(pos.y).toBeCloseTo(-3.261, 2)
  })

  it('matches the original npcpos.txt heights of the NPCs standing on the plaza', () => {
    // npcpos: NPC id, region, x, y, z (region-local file units; y as the original server places the NPC).
    const onPlaza: string[] = []
    for (const { cells } of textdata('npcpos.txt')) {
      const region = Number(cells[1])
      if (region !== 0x61a8) continue
      const x = REGION * 168 + Number(cells[2]), y = Number(cells[3]), z = REGION * 97 + Number(cells[4])
      const p = w.locate(x, z, y)!
      if (keyOf(p) !== PLAZA_MESH) continue
      onPlaza.push(cells[0]!)
      expect(Math.abs(p.y - y)).toBeLessThan(0.5) // 5 cm
      expect(y - w.terrainHeight(x, z)).toBeGreaterThan(15) // > 1.5 m above the terrain height map
    }
    expect(onPlaza.length).toBeGreaterThanOrEqual(5)
  })
})
