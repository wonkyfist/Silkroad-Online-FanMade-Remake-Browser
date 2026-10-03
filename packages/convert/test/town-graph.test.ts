/**
 * The town graph and places (docs/TOWN_LIFE.md §2.4, §12.2 TL-R; docs/WAVE_PLAN7.md §6.1): `content/town/jangan.json`
 * against the export's navigation. Every edge lies on the navmesh at 0.5 m steps and keeps 0.4 m from nav edges, and
 * its linear height keeps to the ground; every place and seat is reachable from its node, standing spots on their own
 * ground; no townsperson the schedule moves ever stands inside a house, walks off the walkable ground or wades.
 * Skipped without an export (work/out/world/jangan-fields).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateTownFile, type TownFile } from '../../shared/src/town.ts'
import { TownSchedule, TOWN_TRIP_S, TOWN_TRIP_VARIANTS, newTownAgentState } from '../../world-render/src/town/schedule.ts'
import { JANGAN_GRAPH, TOWN_EDGE_CLEAR_M, TOWN_EDGE_STEP_M, dressingRows, loadTownNav, routeNodes, townFileText, type TownNav } from '../src/town/build-graph.ts'
import { REPO_ROOT, loadConfig } from '../src/node-io.ts'

const FILE = JSON.parse(readFileSync(join(REPO_ROOT, 'content/town/jangan.json'), 'utf8')) as TownFile
const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const worldDir = hasConfig ? join(loadConfig().workDir, 'out', 'world', 'jangan-fields') : ''
const hasExport = hasConfig && existsSync(join(worldDir, 'nav.bin'))

describe('town graph: the content file (no export needed)', () => {
  it('validates, and the writer keeps it compact and stable', () => {
    expect(validateTownFile(FILE).ok).toBe(true)
    const text = townFileText(FILE)
    expect(JSON.parse(text)).toEqual(FILE)
    expect(text.length).toBeLessThanOrEqual(200 * 1024)
    expect(TOWN_EDGE_STEP_M).toBe(0.5)
    expect(TOWN_EDGE_CLEAR_M).toBe(0.4)
  })

  it('routes are closed loops of adjacent nodes', () => {
    const edges = new Set(FILE.graph.edges.flatMap((e) => [`${e.a}|${e.b}`, `${e.b}|${e.a}`]))
    for (const r of FILE.folk.routes ?? []) {
      r.nodes.forEach((n, i) => {
        const next = r.nodes[(i + 1) % r.nodes.length]!
        expect(edges.has(`${n}|${next}`), `${r.id}: ${n} - ${next}`).toBe(true)
      })
    }
    // the waypoint snapper makes such loops
    const loop = routeNodes(FILE.graph.nodes, FILE.graph.edges, [[97, -110], [130, -110], [130, -130]])
    expect(loop).not.toBeNull()
    loop!.forEach((n, i) => expect(edges.has(`${n}|${loop![(i + 1) % loop!.length]}`)).toBe(true))
  })
})

describe('town graph: the dressing stays a keep-out after the re-convert places it (TL-R2)', () => {
  it('a placed row keeps its bounds and takes its height from the export; an unplaced one has none', () => {
    const dressing = {
      schema: 1, kind: 'townDressing', world: 'w', town: 't', banners: [], lamps: [], decals: [], crackBands: [],
      props: [{ id: 'a', model: 'res/x/w_etc03.bsr', x: 10, z: 20, yaw: 0 }, { id: 'b', model: 'res/x/w_etc03.bsr', x: 50, z: 20, yaw: 0 }],
    }
    const manifest = {
      models: [{ source: 'res\\x\\w_etc03.bsr', boundsMin: [-2.9, 0, -2.2], boundsMax: [2.7, 2.8, 0.7] }],
      placements: [{ source: 'res\\x\\w_etc03.bsr', models: [0], position: [10.1, -3.25, 20], yaw: 0, uid: 1_000_000 }],
    }
    const rows = dressingRows(dressing as never, manifest as never, '/nowhere')
    expect(rows.length).toBe(2)
    expect(rows[0]!.y).toBe(-3.25)
    expect(rows[0]!.max[0]).toBe(2.7)
    expect(rows[1]!.y).toBeUndefined()
  })

  it('the dressing stalls are served from their front: the vendor outside the stall, the customers past the goods', () => {
    const stalls = FILE.places.filter((p) => p.kind === 'stall')
    expect(stalls.length).toBe(8)
    // TL-B's east-market stalls (w_etc03 at yaw π/2, its front facing +x): the vendor east of the counter, customers further
    for (const id of ['stall-3', 'stall-4', 'stall-5']) {
      const p = stalls.find((q) => q.id === id)!
      expect(p.seats![0]!.x, id).toBeGreaterThan(145.4)
      expect(p.x, id).toBeGreaterThan(p.seats![0]!.x + 1.4)
    }
  })
})

describe.skipIf(!hasExport)('town graph on the export\'s navmesh (work/out/world/jangan-fields)', () => {
  let navCache: TownNav | null = null
  const nav = () => (navCache ??= loadTownNav(worldDir, JANGAN_GRAPH).nav)
  const nodes = new Map(FILE.graph.nodes.map((n) => [n.id, n]))
  const isHouse = (key: string) => JANGAN_GRAPH.buildingKey.test(key) && !JANGAN_GRAPH.notBuildingKey.test(key.split('/').pop()!)

  it('every edge lies on the walkable navmesh at 0.5 m steps and keeps 0.4 m from every nav edge', () => {
    const bad: string[] = []
    for (const e of FILE.graph.edges) {
      const a = nodes.get(e.a)!
      const b = nodes.get(e.b)!
      const why = nav().checkSegment(a.x, a.z, a.y ?? Infinity, b.x, b.z, b.y ?? Infinity, TOWN_EDGE_CLEAR_M)
      if (why) bad.push(`${e.a}-${e.b}: ${why}`)
    }
    expect(bad).toEqual([])
    expect(FILE.graph.edges.length).toBeGreaterThan(500)
  }, 120_000)

  it('every node stands on the walkable ground, and every place and seat is reachable from its node', () => {
    for (const n of FILE.graph.nodes) expect(nav().ground(n.x, n.z, n.y ?? Infinity), n.id).not.toBeNull()
    for (const p of FILE.places) {
      const n = nodes.get(p.node)!
      expect(nav().checkSegment(n.x, n.z, n.y ?? Infinity, p.x, p.z, p.y ?? Infinity, 0.25), `${p.id} from ${p.node}`).toBeNull()
      for (const s of p.seats ?? []) {
        // a seat may sit on its bench's own footprint: the last 1.2 m is the step onto it
        const d = Math.hypot(s.x - n.x, s.z - n.z)
        if (d < 1.3) continue
        const f = (d - 1.2) / d
        expect(nav().checkSegment(n.x, n.z, n.y ?? Infinity, n.x + (s.x - n.x) * f, n.z + (s.z - n.z) * f, NaN, 0.2), `${p.id} seat from ${p.node}`).toBeNull()
      }
      // never inside a house
      const sol = nav().solids.at(p.x, p.z, p.y ?? 0)
      expect(sol < 0 || !isHouse(nav().solids.key[sol]!), `${p.id} inside ${sol >= 0 ? nav().solids.key[sol] : ''}`).toBe(true)
    }
  }, 120_000)

  it('feet on the ground: a walker\'s height, linear between two nodes, keeps within 0.3 m of the surface on every edge', () => {
    // TOWN_LIFE §3.4; F-11 (H-11 P1): the build splits edges at slope breaks (splitSlopeEdges)
    const bad: string[] = []
    for (const e of FILE.graph.edges) {
      const a = nodes.get(e.a)!
      const b = nodes.get(e.b)!
      if (a.y === undefined || b.y === undefined) continue
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / TOWN_EDGE_STEP_M))
      let prev = a.y
      for (let i = 0; i <= steps; i++) {
        const f = i / steps
        const p = nav().surfaceAt(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, prev)
        if (!p) continue
        prev = p.y
        const off = a.y + (b.y - a.y) * f - p.y
        if (Math.abs(off) > 0.3) {
          bad.push(`${e.a}-${e.b}: ${off > 0 ? 'floats' : 'sinks'} ${Math.abs(off).toFixed(2)} m at sample ${i}/${steps}`)
          break
        }
      }
    }
    expect(bad, bad.slice(0, 8).join('\n')).toEqual([])
  }, 120_000)

  it('every standing spot (chat rings, the pond edge, stalls) is at its own ground height', () => {
    // F-11 (H-11 P2): ring spots take their own ground, and a ring never straddles a step
    const bad: string[] = []
    for (const p of FILE.places) {
      for (const [i, s] of (p.seats ?? []).entries()) {
        if (s.pose !== 'stand' || s.y === undefined) continue
        const g = nav().g.locate(s.x, s.z, s.y)
        if (g && Math.abs(g.y - s.y) > 0.2) bad.push(`${p.id} spot ${i}: y ${s.y}, ground ${g.y.toFixed(2)}`)
      }
    }
    expect(bad, bad.join('\n')).toEqual([])
  }, 60_000)

  it('no townsperson ever stands inside a house, walks off the walkable ground or wades (a whole booking period)', () => {
    const s = new TownSchedule(FILE)
    const st = newTownAgentState()
    const T0 = Date.UTC(2026, 9, 1, 12) / 1000
    let walking = 0
    const g = nav()
    const seats = FILE.places.flatMap((p) => p.seats ?? [])
    for (let t = T0; t < T0 + TOWN_TRIP_S * TOWN_TRIP_VARIANTS; t += 2) {
      for (const a of s.agents) {
        s.stateAt(a, t, 0.5, st)
        if (!st.visible) continue
        const y = Number.isFinite(st.y) ? st.y : Infinity
        const p = g.g.locate(st.x, st.z, y)
        const sol = g.solids.at(st.x, st.z, p?.y ?? (Number.isFinite(st.y) ? st.y : 0))
        expect(sol < 0 || !isHouse(g.solids.key[sol]!), `${a.id} inside ${sol >= 0 ? g.solids.key[sol] : ''} at (${st.x.toFixed(1)}, ${st.z.toFixed(1)})`).toBe(true)
        // walking: on the ground, except the last 1.3 m step onto a seat on its bench's own footprint
        if (st.moving && !seats.some((q) => Math.hypot(q.x - st.x, q.z - st.z) < 1.3)) {
          walking++
          expect(g.ground(st.x, st.z, y), `${a.id} walks off the ground at (${st.x.toFixed(1)}, ${st.z.toFixed(1)})`).not.toBeNull()
        }
      }
    }
    expect(walking).toBeGreaterThan(50_000)
  }, 180_000)
})
