/**
 * The town file's `manual` overlay (docs/WORLD_EDITOR.md §4.11, §F18, D32; WAVE_PLAN8 lane WE-T): validateTownFile
 * checks it, `applyTownManual` applies it to a regenerated graph (by position, every entry, idempotent per entry),
 * repairs the references (places, routes, fixed agents), and `TownManualLog` keeps the overlay minimal as the editor
 * records changes. The editor model and the real rebuild are tested in apps/viewer/test/town-routes.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { validateTownFile, type TownFile } from '../src/town.ts'
import {
  TownManualLog, applyTownManual, repairTownRefs, townManualCount, townManualEmpty, townManualProblems, townPath,
  type TownManual,
} from '../src/town-manual.ts'

/** A 3 × 2 grid town: n0 n1 n2 / n3 n4 n5, 10 m apart, a bench by n4 and a door by n0, a patrol round the edge. */
function grid(): TownFile {
  const nodes = [0, 1, 2, 3, 4, 5].map(i => ({ id: `n${i}`, x: (i % 3) * 10, z: -Math.floor(i / 3) * 10, y: 1 }))
  const edges = [['n0', 'n1'], ['n1', 'n2'], ['n3', 'n4'], ['n4', 'n5'], ['n0', 'n3'], ['n1', 'n4'], ['n2', 'n5']].map(([a, b]) => ({ a: a!, b: b! }))
  return {
    schema: 1, kind: 'town', world: 'jangan-fields', town: 'jangan', seed: 1,
    graph: { nodes, edges },
    places: [
      { id: 'door-0', kind: 'door', x: 0, z: 1, yaw: 0, node: 'n0' },
      { id: 'bench-0', kind: 'bench', x: 10, z: -12, yaw: 0, node: 'n4', seats: [{ x: 9.55, z: -13, yaw: 0, pose: 'chair' }, { x: 10.45, z: -13, yaw: 0, pose: 'chair' }] },
    ],
    folk: {
      population: 10, roles: { walker: 1 },
      fixed: [{ role: 'sitter', place: 'bench-0', seat: 1 }],
      routes: [{ id: 'patrol', role: 'guard', count: 1, nodes: ['n0', 'n1', 'n2', 'n5', 'n4', 'n3'] }],
    },
    schedule: { bands: [{ from: 0, to: 24, share: 1 }] },
    lines: { calls: {}, flavour: {} },
  }
}

const edgeSet = (f: TownFile) => new Set(f.graph.edges.map(e => [e.a, e.b].sort().join('-')))

describe('the manual overlay: validation', () => {
  it('validateTownFile accepts a well-formed overlay and names the bad entries', () => {
    const f = grid()
    expect(validateTownFile(f).ok).toBe(true)
    f.manual = { nodes: [{ id: 'm0', x: 5, z: 5 }], moved: [{ from: [0, 0], x: 1, z: 1 }], removed: [[20, 0]], edges: [{ a: [5, 5], b: [0, 0] }], cut: [], seats: [{ place: [10, -12], x: 11, z: -13, yaw: 0, pose: 'chair' }], seatsMoved: [], seatsRemoved: [[9.55, -13]] }
    expect(validateTownFile(f).ok).toBe(true)
    const bad = townManualProblems({ nodes: [{ id: 'n7', x: 1, z: 2 }, { id: 'm1', x: 'a', z: 2 }, { id: 'm1', x: 0, z: 0 }], edges: [{ a: [1, 1], b: [1, 1] }, { a: [1] }], seats: [{ place: [0, 0], x: 0, z: 0, yaw: 0, pose: 'lying' }], removed: 3 })
    expect(bad.join('\n')).toMatch(/nodes\[0\]\.id: expected m<number>/)
    expect(bad.join('\n')).toMatch(/nodes\[1\]: expected x, z numbers/)
    expect(bad.join('\n')).toMatch(/nodes\[2\]\.id: duplicate node m1/)
    expect(bad.join('\n')).toMatch(/edges\[0\]: an edge needs two different points/)
    expect(bad.join('\n')).toMatch(/edges\[1\]: expected/)
    expect(bad.join('\n')).toMatch(/seats\[0\]\.pose/)
    expect(bad.join('\n')).toMatch(/removed: expected an array/)
    const g = grid() as unknown as Record<string, unknown>
    g.manual = 'no'
    const r = validateTownFile(g)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems).toContain('town.manual: expected an object')
  })
})

describe('the manual overlay: applied to a regenerated graph', () => {
  it('removes, moves, adds, cuts and joins by position, edits seats, and repairs routes and fixed agents', () => {
    const f = grid()
    const manual: TownManual = {
      removed: [[20.4, 0.3]], // n2, a little off (the navmesh shifted it): within 1 m
      moved: [{ from: [10, 0], x: 11, z: 1, y: 1.5 }], // n1
      nodes: [{ id: 'm0', x: 30, z: -10, y: 1 }],
      cut: [{ a: [11, 1], b: [10, -10] }], // n1-n4, named by n1's new spot
      edges: [{ a: [20, -10], b: [30, -10] }, { a: [30, -10], b: [11, 1] }], // n5-m0, m0-n1
      seatsRemoved: [[9.55, -13]],
      seatsMoved: [{ from: [10.45, -13], x: 10.6, z: -13.2, yaw: 0.3 }],
      seats: [{ place: [10, -12], x: 11.2, z: -13, yaw: 0, pose: 'chair' }],
    }
    const report = applyTownManual(f, manual)
    expect(report[0]).toBe('manual: 9 hand edits applied')
    expect(f.graph.nodes.map(n => n.id)).toEqual(['n0', 'n1', 'n3', 'n4', 'n5', 'm0'])
    expect(f.graph.nodes.find(n => n.id === 'n1')).toEqual({ id: 'n1', x: 11, z: 1, y: 1.5 })
    expect(edgeSet(f)).toEqual(new Set(['n0-n1', 'n3-n4', 'n4-n5', 'n0-n3', 'm0-n5', 'm0-n1']))
    const bench = f.places.find(p => p.id === 'bench-0')!
    expect(bench.seats).toEqual([{ x: 10.6, z: -13.2, yaw: 0.3, pose: 'chair' }, { x: 11.2, z: -13, yaw: 0, pose: 'chair' }])
    // the sitter held seat 1 of 2: it still exists (the moved seat is now index 0, the added one index 1)
    expect(f.folk.fixed).toEqual([{ role: 'sitter', place: 'bench-0', seat: 1 }])
    // the patrol lost n2 and the n1-n4 path: re-pathed over the edited graph, every step an edge
    const r = f.folk.routes![0]!
    const es = edgeSet(f)
    r.nodes.forEach((n, i) => {
      const m = r.nodes[(i + 1) % r.nodes.length]!
      expect(es.has([n, m].sort().join('-')), `${n}-${m}`).toBe(true)
    })
    expect(r.nodes).not.toContain('n2')
    expect(validateTownFile(f).ok).toBe(true)
  })

  it('reports entries that match nothing and leaves the graph alone for them; the overlay is never changed', () => {
    const f = grid()
    const manual: TownManual = { removed: [[100, 100]], moved: [{ from: [55, 55], x: 0, z: 0 }], cut: [{ a: [0, 0], b: [20, -10] }], seatsMoved: [{ from: [0, 0], x: 1, z: 1, yaw: 0 }] }
    const before = JSON.stringify(manual)
    const report = applyTownManual(f, manual)
    expect(report[0]).toBe('manual: 4 hand edits applied (4 matched nothing)')
    expect(report.filter(l => l.includes('matches nothing'))).toHaveLength(4)
    expect(f.graph).toEqual(grid().graph)
    expect(JSON.stringify(manual)).toBe(before)
  })

  it('a navmesh check keeps failing added edges out (the overlay keeps them) and drops failing paths at a moved node', () => {
    const f = grid()
    const manual: TownManual = { moved: [{ from: [0, 0], x: 0, z: 5 }], edges: [{ a: [0, 5], b: [20, -10] }] }
    // a wall along z = 2: anything that crosses it fails
    const check = (a: { z: number }, b: { z: number }) => ((a.z - 2) * (b.z - 2) < 0 ? 'crosses the wall' : null)
    const report = applyTownManual(f, manual, { check })
    expect(edgeSet(f).has('n0-n5')).toBe(false)
    expect(edgeSet(f).has('n0-n1')).toBe(false) // n0 (now z 5) - n1 (z 0) crosses
    expect(report.join('\n')).toMatch(/kept in the overlay, not applied/)
    expect(report.join('\n')).toMatch(/at a moved node fails the navmesh check/)
  })

  it('a removed route node with no way round drops the route; a fixed agent on a removed seat goes', () => {
    const f = grid()
    f.folk.routes = [{ id: 'short', role: 'guard', count: 1, nodes: ['n0', 'n1'] }]
    applyTownManual(f, { cut: [{ a: [0, 0], b: [10, 0] }, { a: [0, 0], b: [0, -10] }], seatsRemoved: [[10.45, -13]] })
    expect(f.folk.routes).toEqual([])
    expect(f.folk.fixed).toEqual([])
    expect(townPath(f, 'n0', 'n5')).toBeNull()
  })

  it('repairTownRefs relinks a place whose node is gone to the nearest node', () => {
    const f = grid()
    f.graph.nodes = f.graph.nodes.filter(n => n.id !== 'n4')
    f.graph.edges = f.graph.edges.filter(e => e.a !== 'n4' && e.b !== 'n4')
    const out = repairTownRefs(f)
    expect(f.places.find(p => p.id === 'bench-0')!.node).toBe('n3')
    expect(out.join('\n')).toMatch(/bench-0: its node n4 is gone, linked to n3/)
  })
})

describe('the manual overlay: the editor log keeps it minimal', () => {
  it('a moved added node edits its entry; a moved moved node keeps its first spot; moving back drops the entry', () => {
    const log = new TownManualLog({})
    log.addNode({ id: 'm0', x: 1, z: 2 })
    log.addEdge({ id: 'm0', x: 1, z: 2 }, { id: 'n0', x: 0, z: 0 })
    log.moveNode({ id: 'm0', x: 1, z: 2 }, 3, 4, 1)
    expect(log.manual.nodes).toEqual([{ id: 'm0', x: 3, z: 4, y: 1 }])
    expect(log.manual.edges).toEqual([{ a: [3, 4], b: [0, 0] }])
    log.moveNode({ id: 'n0', x: 0, z: 0 }, 5, 5)
    log.moveNode({ id: 'n0', x: 5, z: 5 }, 6, 6)
    expect(log.manual.moved).toEqual([{ from: [0, 0], x: 6, z: 6 }])
    expect(log.manual.edges).toEqual([{ a: [3, 4], b: [6, 6] }])
    log.moveNode({ id: 'n0', x: 6, z: 6 }, 0, 0)
    expect(log.manual.moved).toEqual([])
    expect(townManualCount(log.compact())).toBe(2)
  })

  it('removing an added node drops it and its edges; removing a moved node removes it at its first spot', () => {
    const log = new TownManualLog({})
    log.addNode({ id: 'm0', x: 1, z: 2 })
    log.addEdge({ id: 'm0', x: 1, z: 2 }, { id: 'n0', x: 0, z: 0 })
    log.removeNode({ id: 'm0', x: 1, z: 2 })
    expect(townManualEmpty(log.compact())).toBe(true)
    log.moveNode({ id: 'n3', x: 0, z: -10 }, 1, -11)
    log.removeNode({ id: 'n3', x: 1, z: -11 })
    expect(log.compact()).toEqual({ removed: [[0, -10]] })
  })

  it('cutting an added edge drops its entry; joining a cut edge again drops the cut', () => {
    const log = new TownManualLog({})
    const a = { id: 'n0', x: 0, z: 0 }
    const b = { id: 'n1', x: 10, z: 0 }
    log.addEdge(a, b)
    log.cutEdge(b, a)
    expect(townManualEmpty(log.compact())).toBe(true)
    log.cutEdge(a, b)
    log.addEdge(b, a)
    expect(townManualEmpty(log.compact())).toBe(true)
  })

  it('seats: a moved added seat edits its entry, a removed moved seat is removed at its first spot', () => {
    const log = new TownManualLog({})
    log.addSeat({ id: 'p', kind: 'bench', x: 0, z: 0, yaw: 0, node: 'n0' }, { x: 1, z: 1, yaw: 0, pose: 'chair' })
    log.moveSeat({ x: 1, z: 1, yaw: 0, pose: 'chair' }, 2, 2, undefined, 1)
    expect(log.manual.seats).toEqual([{ place: [0, 0], x: 2, z: 2, yaw: 1, pose: 'chair' }])
    log.moveSeat({ x: 5, z: 5, yaw: 0, pose: 'floor' }, 6, 6, 1, 0)
    log.removeSeat({ x: 6, z: 6, yaw: 0, pose: 'floor' })
    expect(log.manual.seatsMoved).toEqual([])
    expect(log.manual.seatsRemoved).toEqual([[5, 5]])
  })
})
