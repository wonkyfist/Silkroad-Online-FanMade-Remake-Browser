/**
 * @sro/nav against the real vSRO 1.188 Jangan data (9 regions 167..169 x 96..98), built straight from the client
 * files. Skipped without sro.config.json. Coordinates in comments are glTF metres of the world viewer's frame
 * (origin = SW corner of region 168x97), the frame of docs/NAVIGATION.md §8 "lookAt".
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseBms, parseBsr, parseNvm, parseObjectIfo } from '@sro/formats'
import { openArchive, REPO_ROOT } from '../../convert/src/node-io.ts'
import {
  NavGltf, NavWorld, TERRAIN_SURFACE, buildNavData, createObjectNavMeshResolver, decodeNavData, encodeNavData,
  type NavData, type NavMoveResult, type NavPosition,
} from '../src/index.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const REGION = 1920
const X0 = 167 * REGION, X1 = 170 * REGION, Z0 = 96 * REGION, Z1 = 99 * REGION
/** The lead's test point next to the fountain, glTF metres. */
const PLAZA: [number, number] = [100.84, -71.5]
/** Fountain centre (region-local (979, 856)). */
const FOUNTAIN: [number, number] = [97.9, -85.6]

let data: NavData
let w: NavWorld
let g: NavGltf
let buildMs = 0
let warnings: string[] = []

const modelOf = (p: NavPosition | { surface: NavPosition['surface'] }) =>
  p.surface.kind === 'object' ? w.instanceInfo(p.surface.instance).model.split('/').pop()! : 'terrain'

/** Surface height every `step` metres along the legs (glTF), plus the XZ of each sample. */
function samples(r: NavMoveResult, step = 0.1): { x: number; z: number; y: number; terrain: boolean }[] {
  const out: { x: number; z: number; y: number; terrain: boolean }[] = []
  for (const l of r.legs) {
    const n = Math.max(1, Math.ceil(Math.hypot(l.x1 - l.x0, l.z1 - l.z0) / step))
    for (let i = 0; i <= n; i++) {
      const x = l.x0 + ((l.x1 - l.x0) * i) / n
      const z = l.z0 + ((l.z1 - l.z0) * i) / n
      out.push({ x, z, y: g.heightOn(l.surface, x, z), terrain: l.surface.kind === 'terrain' })
    }
  }
  return out
}

/** Largest height change between consecutive samples (m). */
const maxJump = (s: { y: number }[]) => s.reduce((m, p, i) => (i ? Math.max(m, Math.abs(p.y - s[i - 1]!.y)) : 0), 0)

/**
 * Terrain samples (away from the leg ends, where the walker meets an edge) that lie under an object floor 0.3..3 m
 * above the terrain: the "sunk into the plaza" symptom.
 */
function sunk(r: NavMoveResult): number {
  let n = 0
  for (const l of r.legs) {
    if (l.surface !== TERRAIN_SURFACE) continue
    const len = Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
    const k = Math.floor(len / 0.1)
    for (let i = 1; i < k; i++) {
      const x = g.fileX(l.x0 + ((l.x1 - l.x0) * i) / k)
      const z = g.fileZ(l.z0 + ((l.z1 - l.z0) * i) / k)
      const th = w.terrainHeight(x, z)
      const p = w.locate(x, z, th + 16.5)
      if (p && p.surface.kind === 'object' && p.y - th > 3 && p.y - th < 30) n++
    }
  }
  return n
}

function walk(start: NavPosition, points: [number, number][]): NavMoveResult[] {
  let pos = start
  return points.map(([x, z]) => {
    const r = g.moveStraight(pos, x, z)
    pos = r.end
    return r
  })
}

describe.skipIf(!hasConfig)('Jangan navigation (real client data)', () => {
  beforeAll(() => {
    const archive = openArchive('Data')
    const read = (p: string) => (archive.has(p) ? archive.read(p) : undefined)
    const t0 = performance.now()
    const ifo = parseObjectIfo(archive.read('navmesh/object.ifo'))
    const regions = []
    for (let rz = 96; rz <= 98; rz++) {
      for (let rx = 167; rx <= 169; rx++) {
        const id = (rz << 8) | rx
        regions.push({ id, nvm: parseNvm(archive.read(`navmesh/nv_${id.toString(16).padStart(4, '0')}.nvm`)) })
      }
    }
    warnings = []
    data = buildNavData({ regions, objectNavMesh: createObjectNavMeshResolver(ifo, read, warnings) }, warnings)
    w = new NavWorld(data)
    g = new NavGltf(w, { x: 168, z: 97 })
    buildMs = performance.now() - t0
  })

  it('builds the 547 nav instances and 6 links of NAVIGATION.md §8, and round-trips', () => {
    expect(warnings).toEqual([])
    expect(data.regions).toHaveLength(9)
    expect(data.instances).toHaveLength(547)
    expect(data.instances.reduce((n, i) => n + i.links.length, 0)).toBe(6)
    const gate = data.instances.filter(i => data.models[i.model]!.key.endsWith('cj_jang_gate06.bms'))
    expect(gate).toHaveLength(1)
    expect(data.models[gate[0]!.model]!.cells.length / 3).toBe(180)
    const t0 = performance.now()
    const bytes = encodeNavData(data)
    const back = decodeNavData(bytes)
    const codecMs = performance.now() - t0
    expect(back).toEqual(data)
    console.log(`jangan nav: ${data.models.length} models, ${data.instances.length} instances, ${bytes.length} bytes SRNV; ` +
      `build from client ${buildMs.toFixed(0)} ms, encode+decode ${codecMs.toFixed(1)} ms`)
  })

  it('stands on the plaza at the test point, not on the terrain 1.5 m below', () => {
    const p = g.locate(...PLAZA, -3.3)!
    expect(modelOf(p)).toBe('cj_jang_gate06.bms')
    expect(p.surface).toMatchObject({ cell: 85 })
    expect(p.y).toBeGreaterThan(-3.35)
    expect(p.y).toBeLessThan(-3.25)
    expect(p.y).toBeCloseTo(-3.261, 2)
    expect(w.terrainHeight(g.fileX(PLAZA[0]), g.fileZ(PLAZA[1])) / 10).toBeCloseTo(-4.791, 2)
    // Walking in from the street (region-local (1300, 450)) reaches the same surface, whatever y it started with.
    const street = g.locate(g.gltfX(168 * REGION + 1300), g.gltfZ(97 * REGION + 450), 0)!
    expect(street.surface).toBe(TERRAIN_SURFACE)
    const r = g.moveStraight(street, ...PLAZA)
    expect(r.blocked).toBe(false)
    expect(r.end.surface).toEqual(p.surface)
    expect(r.end.y).toBeCloseTo(p.y, 6)
    // The nearest-height rule is for spawns only: from the old terrain-only height it picks the terrain.
    expect(g.locate(...PLAZA, -4.79)!.surface).toBe(TERRAIN_SURFACE)
    expect(g.locate(...PLAZA, Infinity)!.surface).toEqual(p.surface)
  })

  it('plaza height agrees with the gate render meshes (independent geometry)', () => {
    // Ray-cast the render meshes of cj_jang_gate.bsr other than the collision/nav mesh at the test point.
    const archive = openArchive('Data')
    const bsr = parseBsr(archive.read('res/bldg/china/jangan01/cj_jang_gate.bsr'))
    const nav = bsr.collision.meshPath.replace(/\\/g, '/').toLowerCase()
    const inst = data.instances.find(i => data.models[i.model]!.key === nav)!
    const x = g.fileX(PLAZA[0]), z = g.fileZ(PLAZA[1])
    const c = Math.cos(inst.yaw), s = Math.sin(inst.yaw)
    const lx = c * (x - inst.x) + s * (z - inst.z)
    const lz = -s * (x - inst.x) + c * (z - inst.z)
    const hits: number[] = []
    for (const m of bsr.meshes) {
      if (m.path.replace(/\\/g, '/').toLowerCase() === nav) continue
      const bms = parseBms(archive.read(m.path))
      const P = bms.positions
      for (let t = 0; t < bms.indices.length; t += 3) {
        const [a, b, d] = [bms.indices[t]! * 3, bms.indices[t + 1]! * 3, bms.indices[t + 2]! * 3]
        const det = (P[b]! - P[a]!) * (P[d + 2]! - P[a + 2]!) - (P[d]! - P[a]!) * (P[b + 2]! - P[a + 2]!)
        if (Math.abs(det) < 1e-9) continue
        const u = ((lx - P[a]!) * (P[d + 2]! - P[a + 2]!) - (P[d]! - P[a]!) * (lz - P[a + 2]!)) / det
        const v = ((P[b]! - P[a]!) * (lz - P[a + 2]!) - (lx - P[a]!) * (P[b + 2]! - P[a + 2]!)) / det
        if (u < 0 || v < 0 || u + v > 1) continue
        hits.push((inst.y + P[a + 1]! + u * (P[b + 1]! - P[a + 1]!) + v * (P[d + 1]! - P[a + 1]!)) / 10)
      }
    }
    const navY = g.locate(...PLAZA, -3.3)!.y
    const nearest = hits.reduce((best, y) => (Math.abs(y - navY) < Math.abs(best - navY) ? y : best), Infinity)
    expect(Math.abs(nearest - navY)).toBeLessThan(0.02)
    // The render floor is nowhere near the terrain height.
    expect(hits.every(y => Math.abs(y + 4.79) > 0.5)).toBe(true)
  })

  it('walking north toward the fountain stops at the terrace rim and never enters the basin', () => {
    const start = g.locate(...PLAZA, -3.3)!
    for (const target of [[100.84, -83.87], FOUNTAIN] as [number, number][]) {
      const r = g.moveStraight(start, ...target)
      expect(r.blocked).toBe(true)
      expect(r.hit).toMatchObject({ kind: 'edge', outline: true, flag: 3 })
      expect(modelOf(r.end)).toBe('cj_jang_gate06.bms')
      expect(r.end.y).toBeCloseTo(-3.26, 1)
      for (const p of samples(r)) expect(Math.hypot(p.x - FOUNTAIN[0], p.z - FOUNTAIN[1])).toBeGreaterThan(9)
    }
    // NAVIGATION.md §8 walk table: stop at region-local (999.6, 757.3) on octagon edge 48.
    const r = g.moveStraight(start, ...FOUNTAIN)
    expect(r.hit!.edge).toBe(48)
    expect(g.fileX(r.end.x) - 168 * REGION).toBeCloseTo(999.6, 0)
    expect(g.fileZ(r.end.z) - 97 * REGION).toBeCloseTo(757.3, 0)
    // From every direction around the fountain.
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI
      const from = g.locate(FOUNTAIN[0] + 20 * Math.cos(a), FOUNTAIN[1] + 20 * Math.sin(a), -3.3)!
      if (modelOf(from) !== 'cj_jang_gate06.bms') continue
      const rr = g.moveStraight(from, ...FOUNTAIN)
      expect(rr.blocked).toBe(true)
      expect(Math.hypot(rr.end.x - FOUNTAIN[0], rr.end.z - FOUNTAIN[1])).toBeGreaterThan(9)
    }
  })

  it('reproduces the walk table: off the plaza, onto it, and across it to the cj_luxury wall', () => {
    const start = g.locate(...PLAZA, -3.3)!
    const off = g.moveStraight(start, 150, -30)
    expect(off.blocked).toBe(false)
    expect(off.end.surface).toBe(TERRAIN_SURFACE)
    const exit = off.legs.find(l => l.surface === TERRAIN_SURFACE)!
    expect(exit.x0).toBeCloseTo(121.4, 0)
    expect(exit.z0).toBeCloseTo(-54.1, 0)
    // Straight across: onto the plaza at x ~ 58.8, off at ~ 136.0, stopped by cj_luxury at ~ 154.3.
    const across = g.moveStraight(g.locate(20, -70, 0)!, 170, -70)
    const objectLegs = across.legs.filter(l => l.surface.kind === 'object')
    expect(objectLegs[0]!.x0).toBeCloseTo(58.8, 0)
    expect(objectLegs[objectLegs.length - 1]!.x1).toBeCloseTo(136.0, 0)
    expect(across.blocked).toBe(true)
    expect(across.end.x).toBeCloseTo(154.3, 0)
    // cj_luxury.bsr's collision navmesh.
    expect(w.instanceInfo(across.hit!.instance!).model).toMatch(/cj_luxu_floor\.bms$/)
  })

  it('plaza -> palace stairs -> palace floor: continuous heights, never sunk under a floor', () => {
    const rs = walk(g.locate(...PLAZA, -3.3)!, [[125, -90], [110, -110], [100, -150], [98, -190], [98, -215], [98, -250], [98, -275]])
    for (const r of rs) {
      expect(r.blocked).toBe(false)
      expect(maxJump(samples(r))).toBeLessThan(0.8)
      expect(sunk(r)).toBe(0)
    }
    const all = rs.flatMap(r => r.legs)
    const models = new Set(all.map(l => modelOf(l)))
    expect(models).toContain('cj_pal_center_stair01.bms')
    expect(models).toContain('cj_pal_indoor_floor01.bms')
    // Stairs climb from the street (0 m) to the palace terrace (4 m).
    const stair = rs[5]!
    const ys = samples(stair).map(p => p.y)
    expect(Math.min(...ys)).toBeGreaterThan(-0.1)
    expect(Math.min(...ys)).toBeLessThan(0.05)
    expect(Math.max(...ys)).toBeCloseTo(4, 1)
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]! - 0.1)
    const end = rs[rs.length - 1]!.end
    expect(modelOf(end)).toBe('cj_pal_indoor_floor01.bms')
  })

  it('plaza -> south gate -> outside the walls: through the arches, blocked by the masonry', () => {
    const rs = walk(g.locate(...PLAZA, -3.3)!, [[98, -40], [98, -10], [98, 60]])
    for (const r of rs) {
      expect(r.blocked).toBe(false)
      expect(maxJump(samples(r))).toBeLessThan(0.8)
      expect(sunk(r)).toBe(0)
    }
    expect(rs[2]!.end.surface).toBe(TERRAIN_SURFACE)
    // The gate's three arches (x ~ 83, 98, 114) pass under the flag-16 wall walkway; the piers are flag 3.
    for (const x of [84, 98, 114]) {
      const r = g.moveStraight(g.locate(x, -10, 0)!, x, 60)
      expect(r.blocked).toBe(false)
    }
    for (const x of [90, 106]) {
      const r = g.moveStraight(g.locate(x, -10, 0)!, x, 60)
      expect(r.blocked).toBe(true)
      expect(r.hit).toMatchObject({ kind: 'edge', flag: 3 })
    }
    // Further out the wall's footprint is closed terrain.
    for (const x of [60, 130]) {
      const r = g.moveStraight(g.locate(x, -10, 0)!, x, 60)
      expect(r.blocked).toBe(true)
      expect(r.hit!.flag ?? 0).not.toBe(16)
      expect(r.end.z).toBeLessThan(1)
    }
  })

  it('every open outline edge can be entered from outside and left from inside', () => {
    let tested = 0
    for (const e of w.debugEdges(X0, Z0, X1, Z1)) {
      if (!e.outline || e.flag !== 0) continue
      const mx = (e.ax + e.bx) / 2, mz = (e.az + e.bz) / 2, my = (e.ay + e.by) / 2
      let nx = e.bz - e.az, nz = -(e.bx - e.ax)
      const len = Math.hypot(nx, nz)
      nx /= len
      nz /= len
      const inside = (d: number) => {
        const p = w.locate(mx - nx * d, mz - nz * d, my)
        return p?.surface.kind === 'object' && p.surface.instance === e.instance
      }
      if (!inside(0.5)) {
        nx = -nx
        nz = -nz
      }
      if (!inside(0.5) || !w.terrainOpen(mx + nx * 2, mz + nz * 2)) continue
      if (mx < X0 + 5 || mx > X1 - 5 || mz < Z0 + 5 || mz > Z1 - 5) continue
      tested++
      const enter = w.moveStraight({ x: mx + nx * 2, y: 0, z: mz + nz * 2, surface: TERRAIN_SURFACE }, mx - nx * 3, mz - nz * 3)
      // Enters this object (or an overlapping neighbour whose open edge comes first).
      expect(enter.end.surface.kind).toBe('object')
      const inner = w.locate(mx - nx, mz - nz, my)!
      if (inner.surface.kind !== 'object' || inner.surface.instance !== e.instance) continue // an overlapping neighbour
      const exit = w.moveStraight(inner, mx + nx * 6, mz + nz * 6)
      expect(exit.legs.some(l => l.surface === TERRAIN_SURFACE)).toBe(true)
    }
    expect(tested).toBeGreaterThan(300)
  })

  // Heights: walkable object floors can lie below the terrain height map where the terrain is open, e.g. the sunken
  // monster-stadium building cj_monstad_martbuil01_01 at glTF (205, -36): nav floor -2.686 m, its render mesh
  // cj_monstad_martbuil01_01_06.bms -2.686 m, terrain 0 m. So the bound is [terrain - 3 m, terrain + 40 m] over open
  // terrain (the city-wall walkways reach 21.9 m). Over closed terrain the height map bounds nothing.
  // Spawns skip sealed objects (every outline edge blocked, no link: collision footprints such as
  // cj_pal_dam_left01_wall, 4.5 m under the palace terrace), which no walk can reach.
  it('random-walk stress: 5,000 moves never end blocked-in, never NaN, heights in [terrain - 3 m, terrain + 40 m]', () => {
    let seed = 20260927
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const sealed = (i: number) => {
      const inst = data.instances[i]!
      return !inst.links.length && data.models[inst.model]!.outline.flags.every(f => f !== 0)
    }
    const spawn = (): NavPosition => {
      for (;;) {
        const x = X0 + rnd() * (X1 - X0)
        const z = Z0 + rnd() * (Z1 - Z0)
        const p = w.locate(x, z, rnd() < 0.5 ? 1e9 : w.terrainHeight(x, z))
        if (p && !(p.surface.kind === 'object' && sealed(p.surface.instance))) return p
      }
    }
    const N = 5000
    const moves: [NavPosition, number, number][] = []
    const results: NavMoveResult[] = []
    let pos = spawn()
    let moveMs = 0
    let onObject = 0
    let blocked = 0
    for (let i = 0; i < N; i++) {
      if (i % 100 === 0) pos = spawn()
      const a = rnd() * 2 * Math.PI
      const d = rnd() * 600
      const tx = Math.min(X1 - 1, Math.max(X0 + 1, pos.x + Math.cos(a) * d))
      const tz = Math.min(Z1 - 1, Math.max(Z0 + 1, pos.z + Math.sin(a) * d))
      const t0 = performance.now()
      const r = w.moveStraight(pos, tx, tz)
      moveMs += performance.now() - t0
      moves.push([pos, tx, tz])
      results.push(r)
      pos = r.end
    }
    for (const r of results) {
      const e = r.end
      expect(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z) && Number.isFinite(r.distance)).toBe(true)
      if (e.surface.kind === 'terrain') {
        expect(w.terrainOpen(e.x, e.z)).toBe(true)
      } else {
        onObject++
        // Inside its own cell: settling keeps the cell and the point.
        const s = w.settle(e.surface, e.x, e.z)!
        expect(s.surface).toEqual(e.surface)
        expect(s.x).toBe(e.x)
      }
      if (r.blocked) blocked++
      const dy = e.y - w.terrainHeight(e.x, e.z)
      if (w.terrainOpen(e.x, e.z)) expect(dy).toBeGreaterThan(-30)
      expect(dy).toBeLessThan(400)
    }
    expect(onObject).toBeGreaterThan(500)
    // Repeatable: the same moves give the same results.
    for (let i = 0; i < 200; i++) expect(w.moveStraight(...moves[i]!)).toEqual(results[i])
    console.log(`jangan nav stress: ${N} moves in ${moveMs.toFixed(1)} ms = ${Math.round(N / (moveMs / 1000))} moves/s ` +
      `(${onObject} end on objects, ${blocked} blocked)`)
  })
})
