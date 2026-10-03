/**
 * Walkable components (reach.ts, docs/NAVIGATION.md §11): synthetic worlds, then the real Jangan export
 * (work/out/world/jangan: manifest.json + nav.bin; skipped when missing). Real-data coordinates are glTF metres of the
 * manifest frame, like jangan.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../convert/src/node-io.ts'
import {
  NavGltf, NavWorld, TERRAIN_SURFACE, buildNavData, decodeNavData,
  type NavMeshInput, type NavPosition, type NvmInput,
} from '../src/index.ts'
import { NavReach, type ReachSource } from '../src/reach.ts'
import { OX, OZ, REGION_ID, flatRegion, grid, mesh, placement } from './synthetic.ts'

type Obj = { nav: NavMeshInput; x: number; y: number; z: number; links?: { edge: number; target: number; targetEdge: number }[] }

function world(objects: Obj[], region: NvmInput = flatRegion()): NavWorld {
  const nvm: NvmInput = {
    ...region,
    objects: objects.map((o, i) => placement(i, i + 1, o.x, o.y, o.z, 0,
      (o.links ?? []).map(l => ({ linkedObject: l.target, linkedObjectEdge: l.targetEdge, edge: l.edge })))),
  }
  return new NavWorld(buildNavData({ regions: [{ id: REGION_ID, nvm }], objectNavMesh: id => ({ key: `m${id}`, navMesh: objects[id]!.nav }) }))
}

/** Terrain position at region-local (x, z). */
const ground = (w: NavWorld, x: number, z: number): NavPosition => ({ x: OX + x, y: w.terrainHeight(OX + x, OZ + z), z: OZ + z, surface: TERRAIN_SURFACE })
const at = (w: NavWorld, x: number, z: number, y: number): NavPosition => w.locate(OX + x, OZ + z, y)!

let seed = 1
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Random walks from located points: every end must lie in a component reachable from the start's. */
function soundness(w: NavWorld, x0: number, z0: number, x1: number, z1: number, n: number, maxD: number, yHints: number[]) {
  let walks = 0, oneWay = 0
  let p: NavPosition | null = null
  for (let i = 0; i < n; i++) {
    if (!p || i % 20 === 0) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0)
      const h = yHints[Math.floor(rnd() * yHints.length)]!
      p = w.locate(x, z, Number.isNaN(h) ? w.terrainHeight(x, z) : h)
      if (!p) continue
    }
    const a = rnd() * 2 * Math.PI, d = (rnd() < 0.3 ? 0.03 : 1) * rnd() * maxD
    const r = w.moveStraight(p, p.x + Math.cos(a) * d, p.z + Math.sin(a) * d)
    const ca = w.componentOf(p), cb = w.componentOf(r.end)
    walks++
    expect(ca).toBeGreaterThanOrEqual(0)
    expect(cb).toBeGreaterThanOrEqual(0)
    if (!w.componentReaches(ca, cb)) throw new Error(`walk from ${JSON.stringify(p)} (component ${ca}) ended in ${cb}: ${JSON.stringify(r.end)}`)
    if (ca !== cb && !r.blocked) oneWay++
    p = r.end
  }
  return { walks, oneWay }
}

describe('reachability on synthetic worlds', () => {
  // A plaza 10 units above flat terrain: 200 x 200 (local -100..100), open outer edges, a walled 40 x 40 hole in the
  // middle (flag 3), like the Jangan fountain.
  const g = grid(-100, 100, -100, 100, 5, 5)
  const inHole = (v: number) => Math.abs(g.vertices[v]![0]) <= 20 && Math.abs(g.vertices[v]![2]) <= 20
  const ring = mesh(g.vertices, g.triangles.filter((_, i) => i !== 24 && i !== 25), (a, b) => (inHole(a) && inHole(b) ? 3 : 0)).nav
  const w = world([{ nav: ring, x: 960, y: 10, z: 960 }])

  it('a walled hole is a sink that only the terrain under the plaza reaches', () => {
    const outside = ground(w, 700, 960)
    const plaza = at(w, 1040, 960, 10)
    const under = ground(w, 1040, 960)
    const hole = ground(w, 960, 970)
    expect(plaza.surface.kind).toBe('object')
    const [O, U, H] = [w.componentOf(outside), w.componentOf(under), w.componentOf(hole)]
    expect(w.componentOf(plaza)).toBe(O)
    expect(w.sameComponent(outside, plaza)).toBe(true)
    expect(new Set([O, U, H]).size).toBe(3)
    expect(O).toBe(0) // the largest
    // One way: under the plaza you walk out and into the hole; nobody walks back.
    expect(w.componentReaches(U, O)).toBe(true)
    expect(w.componentReaches(U, H)).toBe(true)
    expect(w.componentReaches(O, U)).toBe(false)
    expect(w.componentReaches(O, H)).toBe(false)
    expect(w.componentReaches(H, O)).toBe(false)
    expect(w.componentReaches(H, U)).toBe(false)
    // The walker agrees.
    expect(w.componentOf(w.moveStraight(under, OX + 960, OZ + 965).end)).toBe(H)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI
      const r = w.moveStraight(hole, hole.x + 300 * Math.cos(a), hole.z + 300 * Math.sin(a))
      expect(r.blocked).toBe(true)
      expect(w.componentOf(r.end)).toBe(H)
    }
    const info = w.componentInfo(H)!
    expect(info.areaM2).toBeCloseTo(16, 6)
    expect(info).toMatchObject({ id: H, terrainFaces: 1, objectCells: 0, exits: 0, entries: 1 })
    expect([info.minX - OX, info.maxX - OX, info.minZ - OZ, info.maxZ - OZ]).toEqual([940, 980, 940, 980].map(v => expect.closeTo(v, 6)))
    expect(w.componentInfo(U)).toMatchObject({ entries: 0 })
  })

  it('locateIn keeps to one component: the plaza above the terrain under it', () => {
    const O = w.componentOf(ground(w, 700, 960))
    const p = w.locateIn(OX + 1040, OZ + 960, 0, O)!
    expect(p.surface.kind).toBe('object')
    expect(p.y).toBeCloseTo(10, 9)
    expect(w.locate(OX + 1040, OZ + 960, 0)!.surface).toBe(TERRAIN_SURFACE)
    expect(w.locateIn(OX + 960, OZ + 970, 0, O)).toBeNull()
    expect(w.locateIn(OX + 700, OZ + 960, 0, O)!.surface).toBe(TERRAIN_SURFACE)
    expect(w.locateIn(OX + 700, OZ + 960, 0, -1)).toBeNull()
  })

  it('components are sorted by area, their samples lie in them, and random walks stay sound', () => {
    const list = w.components()
    expect(list.map(c => c.id)).toEqual(list.map((_, i) => i))
    for (let i = 1; i < list.length; i++) expect(list[i]!.areaM2).toBeLessThanOrEqual(list[i - 1]!.areaM2)
    for (const c of list) expect(w.componentOf(w.componentSample(c.id)!)).toBe(c.id)
    expect(list.reduce((s, c) => s + c.terrainAreaM2, 0)).toBeCloseTo(1920 * 1920 / 100, 3)
    seed = 5
    const r = soundness(w, OX + 800, OZ + 800, OX + 1120, OZ + 1120, 4000, 150, [NaN, 10, Infinity])
    expect(r.oneWay).toBeGreaterThan(0)
  })

  it('a solid prop is isolated; the terrain under it only walks out', () => {
    const box = grid(-10, 10, -10, 10, 1, 1)
    const w2 = world([{ nav: mesh(box.vertices, box.triangles, () => 3).nav, x: 500, y: 3, z: 500 }])
    const top = at(w2, 500, 500, 5)
    const under = ground(w2, 500, 500)
    const outside = ground(w2, 400, 500)
    const [T, U, O] = [w2.componentOf(top), w2.componentOf(under), w2.componentOf(outside)]
    expect(new Set([T, U, O]).size).toBe(3)
    expect(w2.componentInfo(T)).toMatchObject({ objectCells: 2, exits: 0, entries: 0, instances: 1 })
    expect(w2.componentReaches(U, O)).toBe(true)
    expect(w2.componentReaches(O, U)).toBe(false)
    expect(w2.moveStraight(under, OX + 400, OZ + 500).blocked).toBe(false)
    expect(w2.moveStraight(outside, OX + 500, OZ + 500).blocked).toBe(true)
  })

  it('closed tiles: a boxed-in pocket is its own component, a closed tile has none', () => {
    // A ring of closed tiles around tile (50, 50); tile (60, 60) closed.
    const closed = (tx: number, tz: number) => (Math.max(Math.abs(tx - 50), Math.abs(tz - 50)) === 1) || (tx === 60 && tz === 60)
    const w3 = world([], flatRegion(0, closed))
    const pocket = ground(w3, 50 * 20 + 10, 50 * 20 + 10)
    const open = ground(w3, 40 * 20 + 10, 40 * 20 + 10)
    expect(w3.componentOf(pocket)).not.toBe(w3.componentOf(open))
    expect(w3.componentInfo(w3.componentOf(pocket))).toMatchObject({ areaM2: 4, exits: 0, entries: 0 })
    expect(w3.componentOf(ground(w3, 60 * 20 + 10, 60 * 20 + 10))).toBe(-1)
    expect(w3.components()).toHaveLength(2)
  })

  it('a flag-7 island inside a floor is its own component', () => {
    const f = grid(-60, 60, -60, 60, 3, 3)
    const inCentre = (v: number) => Math.abs(f.vertices[v]![0]) <= 20 && Math.abs(f.vertices[v]![2]) <= 20
    const nav = mesh(f.vertices, f.triangles, () => 0, (a, b) => (inCentre(a) && inCentre(b) && (
      Math.abs(f.vertices[a]![0]) === 20 && f.vertices[a]![0] === f.vertices[b]![0] ||
      Math.abs(f.vertices[a]![2]) === 20 && f.vertices[a]![2] === f.vertices[b]![2]) ? 7 : 4)).nav
    const w4 = world([{ nav, x: 500, y: 5, z: 500 }])
    const floor = at(w4, 450, 500, 5), island = at(w4, 500, 500, 5)
    expect(w4.componentOf(floor)).toBe(w4.componentOf(ground(w4, 300, 500)))
    expect(w4.componentOf(island)).not.toBe(w4.componentOf(floor))
    expect(w4.componentInfo(w4.componentOf(island))).toMatchObject({ objectCells: 2, exits: 0, entries: 0 })
  })

  it('a linked seam joins two raised objects; unlinked they are separate', () => {
    const quad = (open: number) => {
      const q = grid(-50, 50, -50, 50, 1, 1)
      const m = mesh(q.vertices, q.triangles, (a, b) => (q.vertices[a]![0] === open && q.vertices[b]![0] === open ? 8 : 3))
      const edge = [...m.outlineIndex].find(([k]) => k.split(',').map(Number).every(v => q.vertices[v]![0] === open))![1]
      return { nav: m.nav, edge }
    }
    const a = quad(50), b = quad(-50)
    const build = (linked: boolean) => world([
      { nav: a.nav, x: 500, y: 20, z: 500, links: linked ? [{ edge: a.edge, target: 1, targetEdge: b.edge }] : [] },
      { nav: b.nav, x: 600, y: 22, z: 500, links: linked ? [{ edge: b.edge, target: 0, targetEdge: a.edge }] : [] },
    ])
    const linked = build(true)
    expect(linked.sameComponent(at(linked, 480, 500, 20), at(linked, 620, 500, 22))).toBe(true)
    expect(linked.componentInfo(linked.componentOf(at(linked, 480, 500, 20)))).toMatchObject({ instances: 2, objectCells: 4 })
    const apart = build(false)
    expect(apart.sameComponent(at(apart, 480, 500, 20), at(apart, 620, 500, 22))).toBe(false)
  })
})

const OUT = join(REPO_ROOT, 'work/out/world/jangan')
const manifest = existsSync(join(OUT, 'manifest.json'))
  ? (JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { nav?: { file?: string }; spawn?: { x: number; y: number; z: number } })
  : null
const HAVE = !!manifest?.spawn && typeof manifest.nav?.file === 'string' && existsSync(join(OUT, manifest.nav.file))

describe.skipIf(!HAVE)('reachability on the Jangan export', () => {
  let w: NavWorld
  let g: NavGltf
  let town: NavPosition
  let T: number
  /** Saved under the old terrain-only nav: terrain inside the fountain basin. */
  const BASIN = { x: 91.98856, y: -5.43942, z: -88.56615, surface: TERRAIN_SURFACE }

  beforeAll(() => {
    const bytes = readFileSync(join(OUT, manifest!.nav!.file!))
    w = new NavWorld(decodeNavData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)))
    g = new NavGltf(w, { x: 168, z: 97 })
    const s = manifest!.spawn!
    town = g.locate(s.x, s.z, s.y)!
    T = g.componentOf(town)
    const st = w.reachStats()
    console.log(`jangan reachability: ${st.components} components, ${st.terrainPieces} terrain pieces (${st.cutTiles} cut tiles), ` +
      `${st.terrainFaces} faces, ${st.transitions} transitions, built in ${st.buildMs.toFixed(0)} ms, ${(st.bytes / 1e6).toFixed(1)} MB`)
  })

  it('the fountain basin is not in the town spawn component; the plaza rim, the spawn and the south gate are', () => {
    expect(town.surface.kind).toBe('object')
    expect(T).toBe(0)
    const basin = g.componentOf(BASIN)
    expect(basin).toBeGreaterThan(0)
    expect(g.sameComponent(BASIN, town)).toBe(false)
    expect(w.componentReaches(basin, T)).toBe(false)
    const info = w.componentInfo(basin)!
    expect(info).toMatchObject({ exits: 0, objectCells: 0 })
    expect(info.areaM2).toBeGreaterThan(250)
    expect(info.areaM2).toBeLessThan(400)
    // The plaza next to the rim (where a walk toward the fountain stops), and the terrain outside the south gate.
    const rim = g.locate(99.96, -75.73, -3.26)!
    expect(rim.surface.kind).toBe('object')
    expect(g.componentOf(rim)).toBe(T)
    const south = g.locate(98, 60, 0)!
    expect(south.surface).toBe(TERRAIN_SURFACE)
    expect(g.componentOf(south)).toBe(T)
    // The server rule: from the basin, the highest town surface within 10 m is the plaza, outside the rim. (With the
    // basin's own y as the hint it would be the terrain under the plaza, which the corner-exit quirk below puts in
    // the town component.)
    let best: NavPosition | null = null
    for (let r = 1; r <= 10 && !best; r++) {
      for (let k = 0; k < 64 && !best; k++) best = g.locateIn(BASIN.x + r * Math.sin(k / 10), BASIN.z + r * Math.cos(k / 10), Infinity, T)
    }
    expect(best?.surface.kind).toBe('object')
    expect(best!.y).toBeCloseTo(-3.26, 1)
    expect(Math.hypot(best!.x - BASIN.x, best!.z - BASIN.z)).toBeLessThan(5)
    // Every walk out of the basin stays in it.
    const from = g.toFile(BASIN)
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * 2 * Math.PI
      expect(w.componentOf(w.moveStraight(from, from.x + 300 * Math.cos(a), from.z + 300 * Math.sin(a)).end)).toBe(basin)
    }
  })

  // Pins current walker behaviour, not a wish: with the exit fix proposed in NAVIGATION.md §11 this flips.
  it('sharp plaza corners: an exit next to one stays on the plaza, so the town can never walk into the basin', () => {
    // Gate cell 149's open side ends at a sharp reflex corner of the plaza outline (glTF ~ (60.24, -71.92)). The exit
    // nudge (0.2 units outside the side) would land on the terrain under the plaza, from where the terrain walker (which
    // ignores the plaza's edges crossed from inside) reached the basin. The walker now refuses an exit that lands back
    // inside the object's own footprint (NavWorld.insideFootprint), and the reachability graph mirrors that.
    const gate = town.surface.kind === 'object' ? town.surface.instance : -1
    const corner = g.locate(60.4, -71.95, -3.26)
    expect(corner?.surface).toMatchObject({ kind: 'object', instance: gate })
    const basin = g.componentOf(BASIN)
    expect(w.componentReaches(T, basin)).toBe(false)
    let tried = 0
    for (let i = 0; i < 400; i++) {
      // Click just past the corner from points on the plaza around it; then try to walk to the basin.
      const a = (i / 400) * 2 * Math.PI
      const from = g.locate(60.24 + 0.3 * Math.cos(a), -71.92 + 0.3 * Math.sin(a), -3.26)
      if (from?.surface.kind !== 'object') continue
      tried++
      const r = g.moveStraight(from, 60.24 - 0.02 * Math.cos(a), -71.92 - 0.02 * Math.sin(a))
      const end = g.moveStraight(r.end, BASIN.x, BASIN.z).end
      expect(g.componentOf(end)).not.toBe(basin)
    }
    expect(tried).toBeGreaterThan(50)
  })

  it('no traps: nothing the town component reaches is a component it cannot come back from', () => {
    const traps = w.components().filter(c => c.id !== T && w.componentReaches(T, c.id) && !w.componentReaches(c.id, T) && c.areaM2 >= 0.01)
    expect(traps.map(c => `#${c.id} ${c.areaM2.toFixed(1)} m2 at ${c.sample.x.toFixed(1)},${c.sample.z.toFixed(1)}`)).toEqual([])
  })

  it('soundness: random 30 m walks never leave the components reachable from their start', () => {
    seed = 20260927
    const X0 = 167 * 1920, X1 = 170 * 1920, Z0 = 96 * 1920, Z1 = 99 * 1920
    const r = soundness(w, X0, Z0, X1, Z1, 20000, 300, [Infinity, NaN, -Infinity])
    expect(r.walks).toBeGreaterThan(15000)
    console.log(`jangan reachability soundness: ${r.walks} walks, ${r.oneWay} unblocked walks into another component (one way)`)
  })

  it('reverse sampling: walks from every other component never reach a component it cannot reach', () => {
    seed = 77
    let walks = 0
    for (const c of w.components()) {
      if (c.id === T) continue
      // The sample, and located points of the component (hairline faces of float residue may have no locatable point).
      const spots: NavPosition[] = [w.componentSample(c.id)!].filter(p => w.componentOf(p) === c.id)
      for (let i = 0; i < 20 && spots.length < 4; i++) {
        const x = c.minX + rnd() * (c.maxX - c.minX), z = c.minZ + rnd() * (c.maxZ - c.minZ)
        for (const y of [Infinity, w.terrainHeight(x, z), -Infinity]) {
          const p = w.locateIn(x, z, y, c.id)
          if (p) spots.push(p)
        }
      }
      for (const p of spots) {
        for (let k = 0; k < 6; k++) {
          const a = rnd() * 2 * Math.PI, d = rnd() * 300
          const end = w.moveStraight(p, p.x + d * Math.cos(a), p.z + d * Math.sin(a)).end
          walks++
          const e = w.componentOf(end)
          if (!w.componentReaches(c.id, e)) throw new Error(`component ${c.id}: walk from ${JSON.stringify(p)} reached ${e}`)
          if (!w.componentReaches(c.id, T)) expect(e).not.toBe(T)
        }
      }
    }
    expect(walks).toBeGreaterThan(20000)
  })

  it('every component sample lies in its component; ids follow area', () => {
    const list = w.components()
    expect(list.length).toBeGreaterThan(100)
    for (const c of list) {
      // Below 1e-6 m² a face is float residue between near-coincident lines: its sample need not locate back.
      if (c.areaM2 >= 1e-6) expect(w.componentOf(w.componentSample(c.id)!)).toBe(c.id)
      if (c.id > 0) expect(c.areaM2).toBeLessThanOrEqual(list[c.id - 1]!.areaM2)
    }
    expect(list[T]!.areaM2).toBeGreaterThan(100000)
  })

  it('tightness: the walker really makes the terrain links the graph derives (probes across each stretch)', () => {
    // A second build of the same world with the builder's trace hook (NavWorld keeps its runtime model private).
    const inner = w as unknown as { regions: ReachSource['regions']; instances: ReachSource['instances']; tileState(tx: number, tz: number): number }
    const links: [string, number, number, number, number, number, number][] = []
    const reach = new NavReach({
      regions: inner.regions, instances: inner.instances,
      tileState: (tx, tz) => inner.tileState(tx, tz), terrainHeight: (x, z) => w.terrainHeight(x, z),
      trace: (kind, a, b, ax, az, bx, bz) => { links.push([kind, a, b, ax, az, bx, bz]) },
    })
    expect(reach.stats.components).toBe(w.reachStats().components)
    const terrain = (x: number, z: number): NavPosition => ({ x, y: w.terrainHeight(x, z), z, surface: TERRAIN_SURFACE })
    let checked = 0
    for (let i = 0; i < links.length; i += 3) {
      const [kind, X, Y, ax, az, bx, bz] = links[i]!
      const l = Math.hypot(bx - ax, bz - az)
      if (l < 1e-4) continue
      // Probe points either side of the stretch's midpoint, identified by the pieces they fall in.
      const d = Math.min(1e-3, l / 20), nx = (bz - az) / l, nz = -(bx - ax) / l, mx = (ax + bx) / 2, mz = (az + bz) / 2
      let p = [mx + nx * d, mz + nz * d] as const, q = [mx - nx * d, mz - nz * d] as const
      const pp = reach.pieceAt(p[0], p[1]), pq = reach.pieceAt(q[0], q[1])
      if (pp !== X) [p, q] = [q, p]
      if (reach.pieceAt(p[0], p[1]) !== X || (kind !== 'enter' && reach.pieceAt(q[0], q[1]) !== Y) || pp === pq) continue
      checked++
      const r = w.moveStraight(terrain(p[0], p[1]), q[0], q[1])
      if (kind === 'enter') {
        // The entry nudge lands within the arrival radius here, so the entered cell may show only as the end surface.
        const surfaces = [...r.legs.map(leg => leg.surface), r.end.surface]
        expect(surfaces.some(s => s.kind === 'object' && reach.cellNode(s.instance, s.cell) === Y)).toBe(true)
      } else {
        expect(r.blocked || r.end.surface.kind !== 'terrain').toBe(false)
        if (kind === 'union') expect(w.moveStraight(terrain(q[0], q[1]), p[0], p[1]).blocked).toBe(false)
      }
    }
    expect(checked).toBeGreaterThan(30000)
  })
})
