import { describe, expect, it } from 'vitest'
import { toGltfPosition } from '../../convert/src/gltf/space.ts'
import {
  NAV_CONTACT_BACKOFF, NAV_TILE_BACKOFF, NavGltf, NavWorld, TERRAIN_SURFACE, buildNavData, decodeNavData, encodeNavData,
  type NavMeshInput, type NavMoveResult, type NavPosition, type NvmInput,
} from '../src/index.ts'
import { OX, OZ, REGION_ID, flatRegion, grid, mesh, placement } from './synthetic.ts'

type Obj = { nav: NavMeshInput; x: number; y: number; z: number; yaw?: number; links?: { edge: number; target: number; targetEdge: number }[] }

/** One synthetic region (flat terrain at 0 unless given) with objects placed in region-local coordinates. */
function world(objects: Obj[], region: NvmInput = flatRegion()): NavWorld {
  const nvm: NvmInput = {
    ...region,
    objects: objects.map((o, i) => placement(i, i + 1, o.x, o.y, o.z, o.yaw ?? 0,
      (o.links ?? []).map(l => ({ linkedObject: l.target, linkedObjectEdge: l.targetEdge, edge: l.edge })))),
  }
  const data = buildNavData({ regions: [{ id: REGION_ID, nvm }], objectNavMesh: id => ({ key: `m${id}`, navMesh: objects[id]!.nav }) })
  return new NavWorld(data)
}

const W = (x: number, z: number) => [OX + x, OZ + z] as const
const on = (w: NavWorld, x: number, z: number, y: number): NavPosition => w.locate(OX + x, OZ + z, y)!
const kinds = (r: NavMoveResult) => r.legs.map(l => (l.surface.kind === 'terrain' ? 'T' : `O${l.surface.instance}`))
  .filter((k, i, a) => i === 0 || a[i - 1] !== k)

/** Samples the owned-surface height along the legs every `step` units; returns the samples. */
function profile(w: NavWorld, r: NavMoveResult, step = 0.5): number[] {
  const ys: number[] = []
  for (const l of r.legs) {
    const n = Math.max(1, Math.ceil(Math.hypot(l.x1 - l.x0, l.z1 - l.z0) / step))
    for (let i = 0; i <= n; i++) ys.push(w.heightOn(l.surface, l.x0 + ((l.x1 - l.x0) * i) / n, l.z0 + ((l.z1 - l.z0) * i) / n))
  }
  return ys
}

/** A flat 100 x 100 platform (local -50..50) at height y, outline flag `flag`. */
function platform(flag = 0, n = 2): NavMeshInput {
  const g = grid(-50, 50, -50, 50, n, n)
  return mesh(g.vertices, g.triangles, () => flag).nav
}

describe('flat object cell above terrain', () => {
  const w = world([{ nav: platform(), x: 500, y: 10, z: 500 }])

  it('locate picks the nearest surface, terrain on ties', () => {
    expect(on(w, 500, 500, 9).surface).toMatchObject({ kind: 'object', instance: 0 })
    expect(on(w, 500, 500, 9).y).toBeCloseTo(10, 9)
    expect(on(w, 500, 500, 1).surface).toBe(TERRAIN_SURFACE)
    expect(on(w, 500, 500, 5).surface).toBe(TERRAIN_SURFACE)
    expect(on(w, 400, 500, 10).surface).toBe(TERRAIN_SURFACE)
    expect(on(w, 500, 500, Infinity).surface).toMatchObject({ kind: 'object' })
    expect(on(w, 500, 500, -Infinity).surface).toBe(TERRAIN_SURFACE)
    expect(on(w, 400, 500, Infinity).surface).toBe(TERRAIN_SURFACE)
    expect(w.heightAt(OX + 500, OZ + 500, 12)).toBeCloseTo(10, 9)
    expect(w.canStand(OX + 500, OZ + 500, 10.5, 1)).toBe(true)
    expect(w.canStand(OX + 500, OZ + 500, 5, 1)).toBe(false)
  })

  it('walks onto the platform through an open outline edge and off the far side', () => {
    const r = w.moveStraight(on(w, 300, 500, 0), ...W(700, 500))
    expect(r.blocked).toBe(false)
    expect(kinds(r)).toEqual(['T', 'O0', 'T'])
    expect(r.end.surface).toBe(TERRAIN_SURFACE)
    expect(r.end.x).toBe(OX + 700)
    const ys = profile(w, r)
    expect(Math.min(...ys)).toBe(0)
    expect(Math.max(...ys)).toBeCloseTo(10, 9)
    // Entry at x = 450 (then 0.2 units toward the entered cell's centroid), exit at x = 550.
    const obj = r.legs.filter(l => l.surface.kind === 'object')
    expect(Math.hypot(obj[0]!.x0 - OX - 450, obj[0]!.z0 - OZ - 500)).toBeCloseTo(NAV_CONTACT_BACKOFF, 9)
    expect(obj[0]!.x0 - OX).toBeGreaterThan(450)
    expect(obj[obj.length - 1]!.x1 - OX).toBeCloseTo(550, 6)
  })

  it('ends on the platform when the click is on it, and keeps that surface', () => {
    const r = w.moveStraight(on(w, 300, 500, 0), ...W(500, 520))
    expect(r.end.surface).toMatchObject({ kind: 'object', instance: 0 })
    expect(r.end.y).toBeCloseTo(10, 9)
    // The retained surface wins over the (nearer-to-zero) terrain: no re-guessing from y.
    const r2 = w.moveStraight({ ...r.end, y: 0 }, ...W(520, 480))
    expect(r2.end.surface.kind).toBe('object')
    expect(r2.end.y).toBeCloseTo(10, 9)
  })

  it('places rotated instances with world = (px + c x - s z, pz + s x + c z)', () => {
    const g = grid(0, 100, -10, 10, 2, 1)
    const w2 = world([{ nav: mesh(g.vertices, g.triangles).nav, x: 500, y: 10, z: 500, yaw: Math.PI / 2 }])
    expect(on(w2, 500, 550, 10).surface.kind).toBe('object')
    expect(on(w2, 550, 500, 10).surface.kind).toBe('terrain')
    expect(on(w2, 495, 590, 10).surface.kind).toBe('object')
  })

  it('settle keeps the cell, moves to a neighbour or clamps', () => {
    const p = on(w, 500, 500, 10)
    const s = w.settle(p.surface, OX + 510, OZ + 470)!
    expect(s.surface.kind).toBe('object')
    expect(s.y).toBeCloseTo(10, 9)
    const out = w.settle(p.surface, OX + 600, OZ + 500)!
    expect(out.surface).toEqual(expect.objectContaining({ kind: 'object' }))
    expect(out.x - OX).toBeLessThanOrEqual(550)
  })
})

describe('stairs', () => {
  // A ramp along +x from y 0 to 20 over 100 units, 5 flights; open ends, blocked sides.
  const g = grid(0, 100, -20, 20, 5, 1, x => x / 5)
  const nav = mesh(g.vertices, g.triangles, (a, b) => {
    const [xa] = g.vertices[a]!, [xb] = g.vertices[b]!
    return xa === xb ? 0 : 3 // the x = const sides are the ends
  }).nav
  const w = world([{ nav, x: 500, y: 0, z: 500 }])

  it('climbs with continuous heights and stays on the stairs', () => {
    const r = w.moveStraight(on(w, 450, 500, 0), ...W(580, 500))
    expect(r.blocked).toBe(false)
    expect(r.end.surface.kind).toBe('object')
    expect(r.end.y).toBeCloseTo(16, 6)
    const ys = profile(w, r, 0.5)
    for (let i = 1; i < ys.length; i++) expect(Math.abs(ys[i]! - ys[i - 1]!)).toBeLessThan(0.2)
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]! - 1e-9)
  })

  it('blocks the side walls from the terrain, and from the stairs', () => {
    const r = w.moveStraight(on(w, 550, 450, 0), ...W(550, 550))
    expect(r.blocked).toBe(true)
    expect(r.hit).toMatchObject({ kind: 'edge', flag: 3, outline: true })
    expect(r.end.z - OZ).toBeCloseTo(480 - NAV_CONTACT_BACKOFF, 6)
    const up = w.moveStraight(on(w, 450, 500, 0), ...W(550, 500)).end
    const side = w.moveStraight(up, ...W(550, 600))
    expect(side.blocked).toBe(true)
    expect(side.end.surface.kind).toBe('object')
    expect(side.end.y).toBeCloseTo(10, 1)
    expect(side.end.z - OZ).toBeLessThan(520)
  })

  it('drops to the terrain off the top end (no step limit)', () => {
    const r = w.moveStraight(on(w, 450, 500, 0), ...W(700, 500))
    expect(kinds(r)).toEqual(['T', 'O0', 'T'])
    expect(r.end.y).toBe(0)
  })
})

describe('bridge over terrain', () => {
  const deck = (side: number) => {
    const g = grid(-100, 100, -20, 20, 4, 1)
    return mesh(g.vertices, g.triangles, (a, b) => (g.vertices[a]![0] === g.vertices[b]![0] ? 0 : side)).nav
  }

  it('the deck owns the walker end to end, high above the terrain', () => {
    const w = world([{ nav: deck(3), x: 500, y: 30, z: 500 }])
    const r = w.moveStraight(on(w, 350, 500, 30), ...W(650, 500))
    expect(kinds(r)).toEqual(['T', 'O0', 'T'])
    const ys = profile(w, r)
    expect(ys.filter(y => y === 30).length).toBeGreaterThan(300)
    const onDeck = w.moveStraight(on(w, 350, 500, 0), ...W(500, 505))
    expect(onDeck.end.surface.kind).toBe('object')
    expect(onDeck.end.y).toBe(30)
  })

  it('flag-3 sides block walkers underneath (no height test)', () => {
    const w = world([{ nav: deck(3), x: 500, y: 30, z: 500 }])
    const r = w.moveStraight(on(w, 500, 400, 0), ...W(500, 600))
    expect(r.blocked).toBe(true)
    expect(r.end.surface).toBe(TERRAIN_SURFACE)
  })

  it('flag-16 sides let walkers pass under and act as railings on the deck', () => {
    const w = world([{ nav: deck(16), x: 500, y: 30, z: 500 }])
    const under = w.moveStraight(on(w, 500, 400, 0), ...W(500, 600))
    expect(under.blocked).toBe(false)
    expect(kinds(under)).toEqual(['T'])
    expect(under.end.y).toBe(0)
    const deckPos = w.moveStraight(on(w, 350, 500, 0), ...W(500, 500)).end
    expect(deckPos.y).toBe(30)
    const rail = w.moveStraight(deckPos, ...W(500, 600))
    expect(rail.blocked).toBe(true)
    expect(rail.hit).toMatchObject({ flag: 16, outline: true })
    expect(rail.end.surface.kind).toBe('object')
    // Backed off (at most 0.2) toward the centroid of the cell it is in.
    expect(rail.end.z - OZ).toBeLessThan(520)
    expect(rail.end.z - OZ).toBeGreaterThanOrEqual(520 - NAV_CONTACT_BACKOFF)
  })
})

describe('walls', () => {
  it('a blocked inline edge (island) stops the object walker', () => {
    // 3 x 3 grid of quads; the centre quad's boundary is flag 7.
    const g = grid(-60, 60, -60, 60, 3, 3)
    const inCentre = (v: number) => Math.abs(g.vertices[v]![0]) <= 20 && Math.abs(g.vertices[v]![2]) <= 20
    const nav = mesh(g.vertices, g.triangles, () => 0, (a, b) => (inCentre(a) && inCentre(b) && (
      Math.abs(g.vertices[a]![0]) === 20 && g.vertices[a]![0] === g.vertices[b]![0] ||
      Math.abs(g.vertices[a]![2]) === 20 && g.vertices[a]![2] === g.vertices[b]![2]) ? 7 : 4)).nav
    const w = world([{ nav, x: 500, y: 5, z: 500 }])
    const start = on(w, 450, 500, 5)
    const r = w.moveStraight(start, ...W(550, 500))
    expect(r.blocked).toBe(true)
    expect(r.hit).toMatchObject({ kind: 'edge', outline: false, flag: 7 })
    expect(r.end.x - OX).toBeGreaterThan(480 - NAV_CONTACT_BACKOFF - 1e-9)
    expect(r.end.x - OX).toBeLessThan(480)
    expect(r.end.y).toBe(5)
  })

  it('an outline wall stops a terrain walker 0.2 short, repeat clicks stay put', () => {
    const w = world([{ nav: platform(3), x: 500, y: 0, z: 500 }])
    const r = w.moveStraight(on(w, 300, 500, 0), ...W(500, 500))
    expect(r.blocked).toBe(true)
    expect(r.end.x - OX).toBeCloseTo(450 - NAV_CONTACT_BACKOFF, 9)
    const again = w.moveStraight(r.end, ...W(500, 500))
    expect(again.blocked).toBe(true)
    expect(again.end.x).toBeCloseTo(r.end.x, 6)
    // Walking away is free.
    expect(w.moveStraight(r.end, ...W(300, 500)).blocked).toBe(false)
  })
})

describe('T-junction of objects and links', () => {
  // A (x -50..50) and B (x 50..150) meet at x = 50 with global (8) edges; C abuts A's south side, unlinked.
  const quad = (x0: number, x1: number, z0: number, z1: number, flagAt: (x: number, z: number, x2: number, z2: number) => number) => {
    const g = grid(x0, x1, z0, z1, 1, 1)
    const m = mesh(g.vertices, g.triangles, (a, b) => flagAt(g.vertices[a]![0], g.vertices[a]![2], g.vertices[b]![0], g.vertices[b]![2]))
    const edgeAt = (x: number) => [...m.outlineIndex].find(([k]) => k.split(',').map(Number).every(v => g.vertices[v]![0] === x))![1]
    const edgeAtZ = (z: number) => [...m.outlineIndex].find(([k]) => k.split(',').map(Number).every(v => g.vertices[v]![2] === z))![1]
    return { nav: m.nav, edgeAt, edgeAtZ }
  }
  const a = quad(-50, 50, -50, 50, (x, _z, x2, z2) => (x === 50 && x2 === 50 ? 8 : _z === -50 && z2 === -50 ? 8 : 3))
  const b = quad(-50, 50, -50, 50, (x, _z, x2) => (x === -50 && x2 === -50 ? 8 : 3))
  const c = quad(-50, 50, -50, 50, (_x, z, _x2, z2) => (z === 50 && z2 === 50 ? 8 : 3))
  const build = (linked: boolean) => world([
    { nav: a.nav, x: 500, y: 20, z: 500, links: linked ? [{ edge: a.edgeAt(50), target: 1, targetEdge: b.edgeAt(-50) }] : [] },
    { nav: b.nav, x: 600, y: 22, z: 500, links: linked ? [{ edge: b.edgeAt(-50), target: 0, targetEdge: a.edgeAt(50) }] : [] },
    { nav: c.nav, x: 500, y: 20, z: 400 },
  ])

  it('crosses a linked seam from object to object without touching the terrain', () => {
    const w = build(true)
    const r = w.moveStraight(on(w, 480, 500, 20), ...W(640, 510))
    expect(r.blocked).toBe(false)
    expect(kinds(r)).toEqual(['O0', 'O1'])
    expect(r.end.surface).toMatchObject({ kind: 'object', instance: 1 })
    expect(r.end.y).toBe(22)
    const back = w.moveStraight(r.end, ...W(460, 490))
    expect(kinds(back)).toEqual(['O1', 'O0'])
  })

  it('an unlinked global edge blocks (the seam to C, and A-B without links)', () => {
    const w = build(true)
    const r = w.moveStraight(on(w, 500, 480, 20), ...W(500, 400))
    expect(r.blocked).toBe(true)
    expect(r.hit).toMatchObject({ flag: 8, outline: true, instance: 0 })
    const w2 = build(false)
    const r2 = w2.moveStraight(on(w2, 480, 500, 20), ...W(640, 500))
    expect(r2.blocked).toBe(true)
    expect(r2.end.surface).toMatchObject({ instance: 0 })
  })
})

describe('terrain walker', () => {
  it('stops just before a closed tile and cannot squeeze through a closed corner', () => {
    const closed = new Set(['30,25', '31,26'])
    const w = world([], flatRegion(0, (tx, tz) => closed.has(`${tx},${tz}`) || tx === 60))
    const r = w.moveStraight(on(w, 500, 510, 0), ...W(700, 510))
    expect(r.blocked).toBe(true)
    expect(r.hit!.kind).toBe('tile')
    expect(r.end.x - OX).toBeCloseTo(600 - NAV_TILE_BACKOFF, 9)
    // Axis-aligned chords (one direction component 0), both axes and signs.
    const north = w.moveStraight(on(w, 610, 400, 0), ...W(610, 700))
    expect(north.hit!.kind).toBe('tile')
    expect(north.end.z - OZ).toBeCloseTo(500 - NAV_TILE_BACKOFF, 9)
    const west = w.moveStraight(on(w, 1300, 505, 0), ...W(1100, 505))
    expect(west.hit!.kind).toBe('tile')
    expect(west.end.x - OX).toBeCloseTo(1220 + NAV_TILE_BACKOFF, 9)
    // Diagonal through the shared corner (620, 520) of the closed tiles (30,25) [600..620 x 500..520] and
    // (31,26) [620..640 x 520..540]: the open tiles (31,25) and (30,26) touch only at that corner.
    const diag = w.moveStraight(on(w, 640, 500, 0), ...W(600, 540))
    expect(diag.blocked).toBe(true)
    expect(diag.hit!.kind).toBe('tile')
  })

  it('stops at the edge of the loaded world, and a start inside a closed area may leave it', () => {
    const w = world([], flatRegion(0, tx => tx < 10))
    const r = w.moveStraight({ x: OX + 1900, y: 0, z: OZ + 100, surface: TERRAIN_SURFACE }, OX + 2100, OZ + 100)
    expect(r.hit!.kind).toBe('world')
    expect(r.end.x - OX).toBeCloseTo(1920 - NAV_TILE_BACKOFF, 9)
    const esc = w.moveStraight({ x: OX + 50, y: 0, z: OZ + 100, surface: TERRAIN_SURFACE }, OX + 400, OZ + 100)
    expect(esc.blocked).toBe(false)
    const back = w.moveStraight(esc.end, OX + 50, OZ + 100)
    expect(back.blocked).toBe(true)
  })

  it('uses the triangle split of the height grid, not a bilinear patch', () => {
    const region = flatRegion()
    region.heights[0 * 97 + 1] = 20 // (x 20, z 0)
    const w = world([], region)
    // Tile (0,0), split along (0,0)-(20,20): at (15, 5) (fx >= fz) the (20, 0) corner weighs fx - fz = 0.5.
    expect(w.terrainHeight(OX + 15, OZ + 5)).toBeCloseTo(10, 6)
    expect(w.terrainHeight(OX + 5, OZ + 15)).toBeCloseTo(0, 6)
  })

  it('native leg limit: six legs per move', () => {
    const objects = [0, 1, 2].map(i => ({ nav: platform(0), x: 400 + 200 * i, y: 5, z: 500 }))
    const w = world(objects)
    const two = w.moveStraight(on(w, 200, 500, 0), ...W(750, 500))
    expect(two.blocked).toBe(false)
    const three = w.moveStraight(on(w, 200, 500, 0), ...W(1000, 500))
    expect(three.blocked).toBe(true)
    expect(three.hit!.kind).toBe('legs')
    expect(three.end.x - OX).toBeCloseTo(850 + NAV_CONTACT_BACKOFF, 6)
  })
})

describe('serialization and frames', () => {
  const objects: Obj[] = [{ nav: platform(0, 3), x: 500, y: 10, z: 500, yaw: 0.3 }, { nav: platform(3), x: 900, y: 0, z: 500, yaw: -1.1 }]
  const w = world(objects, flatRegion(-3, tx => tx === 80))

  it('round-trips NavData exactly and moves identically', () => {
    const bytes = encodeNavData(w.data)
    const back = decodeNavData(bytes)
    expect(back).toEqual(w.data)
    expect(encodeNavData(back)).toEqual(bytes)
    const w2 = new NavWorld(back)
    for (const [tx, tz] of [[1200, 520], [500, 505], [950, 480], [1700, 600]] as const) {
      const a = w.moveStraight(on(w, 300, 500, 0), ...W(tx, tz))
      const b = w2.moveStraight(on(w2, 300, 500, 0), ...W(tx, tz))
      expect(b).toEqual(a)
    }
    expect(() => decodeNavData(bytes.subarray(0, bytes.length - 4))).toThrow(/SRNV/)
  })

  it('is deterministic', () => {
    const a = w.moveStraight(on(w, 300, 500, 0), ...W(1200, 530))
    const b = w.moveStraight(on(w, 300, 500, 0), ...W(1200, 530))
    expect(b).toEqual(a)
  })

  it('glTF frame matches space.ts toGltfPosition of the world offset', () => {
    const g = new NavGltf(w, { x: 99, z: 101 })
    const p = on(w, 500, 500, 10)
    const q = g.toGltf(p)
    const expected = toGltfPosition([p.x - 1920 * 99, p.y, p.z - 1920 * 101])
    expect(q.x).toBeCloseTo(expected[0], 9)
    expect(q.y).toBeCloseTo(expected[1], 9)
    expect(q.z).toBeCloseTo(expected[2], 9)
    expect(g.locate(q.x, q.z, q.y)!.surface).toEqual(p.surface)
    const r = g.moveStraight(q, g.gltfX(OX + 300), g.gltfZ(OZ + 500))
    expect(r.end.x).toBeCloseTo(g.gltfX(OX + 300), 9)
    expect(r.end.surface).toBe(TERRAIN_SURFACE)
    expect(g.heightOn(r.end.surface, r.end.x, r.end.z)).toBeCloseTo(-0.3, 9)
  })
})
