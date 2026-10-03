/**
 * S-NAV (docs/WAVE_PLAN8.md §4.1, docs/WORLD_EDITOR.md §F10): object instance edits, on the data (editNavInstances)
 * and in place (NavWorld.editInstances). Replace = remove + add; ids regionId << 16 | uid unchanged.
 */
import { describe, expect, it } from 'vitest'
import {
  NavWorld, buildNavData, editNavInstances, navInstanceId,
  type NavData, type NavInstanceEdits, type NavMeshInput, type NavPosition,
} from '../src/index.ts'
import { OX, OZ, REGION_ID, flatRegion, grid, mesh, placement } from './synthetic.ts'

type Obj = { nav: NavMeshInput; uid: number; x: number; y: number; z: number; yaw?: number; links?: { edge: number; target: number; targetEdge: number }[] }

/** A flat 100 x 100 wall block (local -50..50), outline flag 3: blocks terrain walkers. */
function block(): NavMeshInput {
  const g = grid(-50, 50, -50, 50, 2, 2)
  return mesh(g.vertices, g.triangles, () => 3).nav
}

function data(objects: Obj[]): NavData {
  const nvm = {
    ...flatRegion(),
    objects: objects.map((o, i) => placement(i, o.uid, o.x, o.y, o.z, o.yaw ?? 0,
      (o.links ?? []).map(l => ({ linkedObject: l.target, linkedObjectEdge: l.targetEdge, edge: l.edge })))),
  }
  return buildNavData({ regions: [{ id: REGION_ID, nvm }], objectNavMesh: id => ({ key: `m${id}`, navMesh: objects[id]!.nav }) })
}

const ground = (x: number, z: number): NavPosition => ({ x: OX + x, y: 0, z: OZ + z, surface: { kind: 'terrain' } })
const walk = (w: NavWorld, x0: number, z0: number, x1: number, z1: number) => w.moveStraight(ground(x0, z0), OX + x1, OZ + z1)

/** Every instance as (id, objId, model key, transform), in index order. */
const infos = (w: NavWorld) => Array.from({ length: w.instanceCount }, (_, i) => w.instanceInfo(i))

/** Straight walks across the region from a fixed fan of starts: the end points and blocked flags. */
function probe(w: NavWorld): string[] {
  const out: string[] = []
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2
    const r = walk(w, 600 + Math.cos(a) * 400, 600 + Math.sin(a) * 400, 600 - Math.cos(a) * 400, 600 - Math.sin(a) * 400)
    out.push(`${r.blocked} ${r.end.x.toFixed(6)} ${r.end.z.toFixed(6)} ${r.end.surface.kind}`)
  }
  return out
}

const ID = (uid: number) => navInstanceId(REGION_ID, uid)

describe('navInstanceId', () => {
  it('is regionId << 16 | uid, unsigned', () => {
    expect(navInstanceId(0x61ab, 0x8002)).toBe(0x61ab8002)
    expect(navInstanceId(0x61ab, 0x8002)).toBeGreaterThan(0)
    expect(ID(0xe000)).toBe(((REGION_ID << 16) | 0xe000) >>> 0)
  })
})

describe('editNavInstances (data)', () => {
  const base = () => data([
    { nav: block(), uid: 0x8002, x: 600, y: 0, z: 600 },
    { nav: block(), uid: 0x8003, x: 900, y: 0, z: 900 },
  ])

  it('a move keeps the id and the index and equals a world built with the instance at the new spot', () => {
    const d = base()
    const r = editNavInstances(d, { put: [{ id: ID(0x8002), objId: 0, model: 0, x: OX + 300, y: 0, z: OZ + 600, yaw: 0.5 }] })
    expect(r.replaced).toBe(1)
    expect(Array.from(r.remap)).toEqual([0, 1])
    expect(r.data.instances.map(i => i.id)).toEqual(d.instances.map(i => i.id))
    const fresh = data([
      { nav: block(), uid: 0x8002, x: 300, y: 0, z: 600, yaw: 0.5 },
      { nav: block(), uid: 0x8003, x: 900, y: 0, z: 900 },
    ])
    expect(infos(new NavWorld(r.data))).toEqual(infos(new NavWorld(fresh)))
    expect(probe(new NavWorld(r.data))).toEqual(probe(new NavWorld(fresh)))
    // The input is not mutated.
    expect(d.instances[0]!.x).toBe(OX + 600)
  })

  it('replace = remove + add of the same id', () => {
    const put = { id: ID(0x8002), objId: 0, model: 0, x: OX + 300, y: 0, z: OZ + 600, yaw: 0.5 }
    const a = editNavInstances(base(), { put: [put] })
    const b = editNavInstances(base(), { remove: [ID(0x8002)], put: [put] })
    expect(b.data.instances).toEqual(a.data.instances)
    expect(Array.from(b.remap)).toEqual(Array.from(a.remap))
    expect(b.removed).toBe(0)
    expect(b.replaced).toBe(1)
  })

  it('a drop compacts the slots, keeps the other ids and reports the remap; unknown ids are listed', () => {
    const r = editNavInstances(base(), { remove: [ID(0x8002), ID(0x1234)] })
    expect(r.removed).toBe(1)
    expect(r.missing).toEqual([ID(0x1234)])
    expect(Array.from(r.remap)).toEqual([-1, 0])
    expect(r.data.instances.map(i => i.id)).toEqual([ID(0x8003)])
  })

  it('an add appends an editor uid instance; a model passed by value is appended once', () => {
    const d = base()
    const model = { ...d.models[0]!, key: 'Res/Nature/NEW_Tree.bms' }
    const r = editNavInstances(d, {
      put: [
        { id: ID(0xe000), objId: 7, model, x: OX + 200, y: 0, z: OZ + 200, yaw: 0 },
        { id: ID(0xe001), objId: 7, model, x: OX + 1200, y: 0, z: OZ + 200, yaw: 0 },
      ],
    })
    expect(r.added).toBe(2)
    expect(r.data.models.length).toBe(d.models.length + 1)
    expect(r.data.models.at(-1)!.key).toBe('res/nature/new_tree.bms')
    expect(r.data.instances.slice(2).map(i => [i.id, i.model])).toEqual([[ID(0xe000), d.models.length], [ID(0xe001), d.models.length]])
  })

  it('refuses a duplicate put and a non-finite transform', () => {
    const p = { id: ID(0xe000), objId: 0, model: 0, x: OX, y: 0, z: OZ, yaw: 0 }
    expect(() => editNavInstances(base(), { put: [p, p] })).toThrow(/twice/)
    expect(() => editNavInstances(base(), { put: [{ ...p, x: NaN }] })).toThrow(/non-finite/)
    expect(() => editNavInstances(base(), { put: [{ ...p, model: 9 }] })).toThrow(/out of range/)
  })

  it('never edits links: removing or moving a linked piece (or its target) throws', () => {
    const quad = mesh(grid(-50, 50, -50, 50, 1, 1).vertices, grid(-50, 50, -50, 50, 1, 1).triangles, () => 8)
    const d = data([
      { nav: quad.nav, uid: 1, x: 500, y: 20, z: 500, links: [{ edge: 0, target: 1, targetEdge: 0 }] },
      { nav: quad.nav, uid: 2, x: 600, y: 20, z: 500 },
      { nav: block(), uid: 3, x: 900, y: 0, z: 900 },
    ])
    expect(() => editNavInstances(d, { remove: [ID(1)] })).toThrow(/linked/)
    expect(() => editNavInstances(d, { remove: [ID(2)] })).toThrow(/linked/)
    expect(() => editNavInstances(d, { put: [{ id: ID(2), objId: 1, model: 1, x: OX, y: 0, z: OZ, yaw: 0 }] })).toThrow(/linked/)
    // Dropping an unlinked instance before the linked pair re-indexes the links.
    const d2 = data([
      { nav: block(), uid: 3, x: 900, y: 0, z: 900 },
      { nav: quad.nav, uid: 1, x: 500, y: 20, z: 500, links: [{ edge: 0, target: 2, targetEdge: 0 }] },
      { nav: quad.nav, uid: 2, x: 600, y: 20, z: 500 },
    ])
    const r = editNavInstances(d2, { remove: [ID(3)] })
    expect(r.data.instances[0]!.links).toEqual([{ edge: 0, target: 1, targetEdge: 0 }])
  })
})

describe('NavWorld.editInstances (in place)', () => {
  const objs = (): Obj[] => [
    { nav: block(), uid: 0x8002, x: 600, y: 0, z: 600 },
    { nav: block(), uid: 0x8003, x: 900, y: 0, z: 300 },
    { nav: block(), uid: 0x8004, x: 300, y: 0, z: 900, yaw: 1 },
  ]
  const edits: NavInstanceEdits = {
    remove: [ID(0x8003)],
    put: [
      { id: ID(0x8002), objId: 0, model: 0, x: OX + 700, y: 0, z: OZ + 500, yaw: 0.25 },
      { id: ID(0xe000), objId: 1, model: 1, x: OX + 450, y: 0, z: OZ + 450, yaw: 0 },
    ],
  }

  it('equals the objects-only rebuild (a world built from the edited data)', () => {
    const w = new NavWorld(data(objs()))
    const before = probe(w)
    const remap = w.editInstances(edits)
    expect(Array.from(remap)).toEqual([0, -1, 1])
    const rebuilt = new NavWorld(editNavInstances(data(objs()), edits).data)
    expect(infos(w)).toEqual(infos(rebuilt))
    expect(probe(w)).toEqual(probe(rebuilt))
    expect(probe(w)).not.toEqual(before)
    expect(w.data.instances.map(i => i.id)).toEqual([ID(0x8002), ID(0x8004), ID(0xe000)])
    expect(w.components().length).toBe(rebuilt.components().length)
  })

  it('moves the obstacle: the old spot walks through, the new spot blocks', () => {
    const w = new NavWorld(data(objs()))
    expect(walk(w, 600, 400, 600, 800).blocked).toBe(true)
    w.editInstances({ put: [{ id: ID(0x8002), objId: 0, model: 0, x: OX + 1500, y: 0, z: OZ + 600, yaw: 0 }] })
    expect(walk(w, 600, 400, 600, 800).blocked).toBe(false)
    expect(walk(w, 1500, 400, 1500, 800).blocked).toBe(true)
    expect(w.instanceInfo(0).id).toBe(ID(0x8002))
  })

  it('keeps the streamed regions and survives a refused (linked) edit unchanged', () => {
    const d = data(objs())
    const w = new NavWorld({ ...d, regions: [] })
    w.addRegion(d.regions[0]!)
    w.editInstances({ remove: [ID(0x8004)] })
    expect(w.terrainOpen(OX + 100, OZ + 100)).toBe(true)
    expect(w.data.regions).toEqual([])

    const quad = mesh(grid(-50, 50, -50, 50, 1, 1).vertices, grid(-50, 50, -50, 50, 1, 1).triangles, () => 8)
    const linked = new NavWorld(data([
      { nav: quad.nav, uid: 1, x: 500, y: 20, z: 500, links: [{ edge: 0, target: 1, targetEdge: 0 }] },
      { nav: quad.nav, uid: 2, x: 600, y: 20, z: 500 },
    ]))
    const snapshot = infos(linked)
    expect(() => linked.editInstances({ remove: [ID(1)] })).toThrow(/linked/)
    expect(infos(linked)).toEqual(snapshot)
  })
})
