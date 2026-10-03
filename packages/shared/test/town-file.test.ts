/** The town files (wave 11, docs/WAVE_PLAN7.md §3.2, D18; docs/TOWN_LIFE.md §2.4, §7): validateTownFile, both kinds. */
import { describe, expect, it } from 'vitest'
import { TOWN_PLACE_KINDS, inTownHourBand, validateTownFile, type TownDressingFile, type TownFile } from '../src/index.ts'

const town = (): TownFile => ({
  schema: 1,
  kind: 'town',
  world: 'jangan',
  town: 'jangan',
  seed: 1234,
  graph: {
    nodes: [{ id: 'gate', x: 0, z: -40 }, { id: 'avenue', x: 0, z: -10 }, { id: 'plaza', x: 0, z: 10 }, { id: 'market', x: 20, z: 10 }],
    edges: [{ a: 'gate', b: 'avenue' }, { a: 'avenue', b: 'plaza' }, { a: 'plaza', b: 'market' }, { a: 'market', b: 'avenue' }],
  },
  places: [
    { id: 'southGate', kind: 'door', x: 0, z: -42, yaw: 0, node: 'gate' },
    { id: 'teaHouse', kind: 'teaTable', x: 4, z: 12, yaw: 1.2, node: 'plaza', sheltered: true, district: 'plaza', seats: [{ x: 5, z: 12, yaw: 0, pose: 'chair' }, { x: 3, z: 12, yaw: 3.1, pose: 'chair' }] },
    { id: 'fruitStall', kind: 'stall', x: 22, z: 12, yaw: 3.14, node: 'market', goods: 'fruit', seats: [{ x: 22, z: 13, yaw: 3.14, pose: 'stand' }] },
    { id: 'rim', kind: 'fountainRim', x: 0, z: 8, yaw: 0, node: 'plaza', seats: [{ x: 1, z: 7, yaw: 0, pose: 'floor' }] },
  ],
  folk: {
    population: 120,
    roles: { walker: 40, chatter: 20, sitter: 15, vendor: 8, porter: 5, child: 4 },
    female: 0.5,
    districts: [{ id: 'plaza', x: 0, z: 10, radius: 30, weight: 1 }],
    fixed: [{ role: 'vendor', place: 'fruitStall', seat: 0 }, { role: 'sitter', place: 'teaHouse', seat: 1 }],
    routes: [{ id: 'patrol', role: 'guard', nodes: ['avenue', 'plaza', 'market'], count: 2 }],
  },
  schedule: {
    bands: [{ from: 5, to: 7, share: 0.25 }, { from: 7, to: 18, share: 1 }, { from: 18, to: 20, share: 0.6 }, { from: 20, to: 23, share: 0.25 }, { from: 23, to: 5, share: 0.08 }],
    rainShelter: 0.25,
  },
  lines: {
    calls: { fruit: ['Fresh peaches! Sweet as honey!'] },
    flavour: { walker: ['Lovely day for it.'], guard: ['Keep moving, traveller.'] },
    rumours: [{ act: 1, text: 'They say the Seal is gone from the temple...' }],
  },
})

const dressing = (): TownDressingFile => ({
  schema: 1,
  kind: 'townDressing',
  world: 'jangan',
  town: 'jangan',
  props: [{ id: 'stall4', model: 'res/bldg/china/jangan/cj_streetstall.bsr', x: 24, z: 14, yaw: 0, cloth: 'awning' }, { model: '/out/town/props/crate.glb', x: 25, z: 15, yaw: 0.3, scale: 1.1 }],
  banners: [{ model: '/out/town/props/banner_red.glb', x: 3, z: -20, yaw: 1.57, height: 2.4, kind: 'hanging' }],
  lamps: [{ model: 'cj_field_lamp', efp: 'map/cj_pal_lamp_light.efp', offset: [0, 3.1, 0] }],
  decals: [{ kind: 'dirt', x: 0, z: -40, yaw: 0, size: [4, 6] }],
  crackBands: [{ points: [[0, 0], [10, 0], [10, 10]], width: 0.5, density: 4 }],
  pond: { regions: [(97 << 8) | 169], color: [0.18, 0.22, 0.12], turbidity: 0.6, reflection: 0.8 },
})

const problems = (v: unknown): string[] => {
  const r = validateTownFile(v)
  return r.ok ? [] : r.problems
}

describe('validateTownFile: the town file', () => {
  it('accepts a valid town file and returns it', () => {
    const r = validateTownFile(town())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.file.kind).toBe('town')
  })

  it('accepts a JSON round trip (the converter copies the file into the export)', () => {
    expect(problems(JSON.parse(JSON.stringify(town())))).toEqual([])
  })

  it('fails on an unknown place kind', () => {
    const f = town() as unknown as { places: Record<string, unknown>[] }
    f.places[1]!.kind = 'tavern'
    expect(problems(f)).toEqual([`town.places[1].kind: expected one of ${TOWN_PLACE_KINDS.join(', ')}`])
  })

  it('fails on an edge to a missing node', () => {
    const f = town()
    f.graph.edges.push({ a: 'plaza', b: 'n77' })
    expect(problems(f)).toEqual(['town.graph.edges[4].b: unknown node n77'])
  })

  it('fails on a dangling seat: far from its place, or a fixed agent on a seat the place lacks', () => {
    const f = town()
    f.places[3]!.seats![0]!.x = 40
    expect(problems(f)).toEqual(['town.places[3].seats[0]: dangling seat: more than 8 m from its place'])
    const g = town()
    g.folk.fixed![0]!.seat = 3
    expect(problems(g)).toEqual(['town.folk.fixed[0].seat: dangling seat: place fruitStall has 1 seat(s)'])
    const h = town()
    h.folk.fixed![1]!.place = 'inn'
    expect(problems(h)).toEqual(['town.folk.fixed[1].place: unknown place inn'])
  })

  it('fails on a place without a known node, duplicate ids, no door', () => {
    const f = town()
    f.places[1]!.node = 'nowhere'
    f.places[3]!.id = 'teaHouse'
    f.graph.nodes.push({ id: 'gate', x: 1, z: 1 })
    expect(problems(f)).toEqual([
      'town.graph.nodes[4].id: duplicate node gate',
      'town.places[1].node: unknown node nowhere',
      'town.places[3].id: duplicate place teaHouse',
    ])
    const g = town()
    g.places = g.places.filter((p) => p.kind !== 'door')
    expect(problems(g)).toEqual(["town.places: expected at least one 'door' (people appear and leave only at doors)"])
  })

  it('fails on a route that leaves the edges, a stall without calls, an unknown role', () => {
    const f = town()
    f.folk.routes![0]!.nodes = ['gate', 'plaza']
    expect(problems(f)).toEqual(['town.folk.routes[0].nodes[0]: no edge gate - plaza', 'town.folk.routes[0].nodes[1]: no edge plaza - gate'])
    const g = town()
    g.places[2]!.goods = 'silk'
    expect(problems(g)).toEqual(['town.places[2].goods: no lines.calls.silk'])
    const h = town() as unknown as { folk: { roles: Record<string, number> } }
    h.folk.roles.juggler = 3
    expect(problems(h)).toEqual(['town.folk.roles.juggler: unknown role'])
  })

  it('fails when the hour bands leave a gap or overlap', () => {
    const f = town()
    f.schedule.bands.pop()
    expect(problems(f)).toEqual(['town.schedule.bands: hour 0.125 is covered 0 times, expected once'])
    const g = town()
    g.schedule.bands.push({ from: 12, to: 13, share: 1 })
    expect(problems(g)).toEqual(['town.schedule.bands: hour 12.125 is covered 2 times, expected once'])
  })

  it('fails on bad lines', () => {
    const f = town()
    f.lines.calls.fruit = ['']
    f.lines.flavour.walker = ['x'.repeat(121)]
    expect(problems(f)).toEqual(['town.lines.calls.fruit[0]: expected a line of 1..120 characters', 'town.lines.flavour.walker[0]: expected a line of 1..120 characters'])
  })

  it('hour bands wrap past midnight', () => {
    const night = { from: 23, to: 5, share: 0.08 }
    expect([23.5, 0, 4.9].every((h) => inTownHourBand(night, h))).toBe(true)
    expect(inTownHourBand(night, 5)).toBe(false)
    expect(inTownHourBand({ from: 7, to: 18, share: 1 }, 18)).toBe(false)
  })
})

describe('validateTownFile: the dressing file', () => {
  it('accepts a valid dressing file, with and without a pond', () => {
    expect(problems(dressing())).toEqual([])
    const f = dressing()
    delete f.pond
    const r = validateTownFile(f)
    expect(r.ok && r.file.kind).toBe('townDressing')
  })

  it('fails on bad props, banners, lamps, decals, bands and pond', () => {
    const f = dressing() as unknown as Record<string, Record<string, unknown>[] | Record<string, unknown>>
    ;(f.props as Record<string, unknown>[])[0]!.cloth = 'flag'
    ;(f.banners as Record<string, unknown>[])[0]!.height = 0
    ;(f.lamps as Record<string, unknown>[])[0]!.efp = 'map/cj_pal_lamp_light.png'
    ;(f.decals as Record<string, unknown>[])[0]!.kind = 'graffiti'
    ;(f.crackBands as Record<string, unknown>[])[0]!.points = [[0, 0]]
    ;(f.pond as Record<string, unknown>).color = [2, 0, 0]
    expect(problems(f)).toEqual([
      'dressing.props[0].cloth: expected one of hanging, awning, tent',
      'dressing.banners[0].height: expected a number in 0.01..50',
      'dressing.lamps[0].efp: expected an .efp path',
      'dressing.decals[0].kind: expected one of dirt, moss, puddle',
      'dressing.crackBands[0].points: expected at least two [x, z] points',
      'dressing.pond.color: expected linear RGB 0..1',
    ])
  })

  it('fails on a missing list', () => {
    const f = dressing() as unknown as Record<string, unknown>
    delete f.decals
    expect(problems(f)).toEqual(['dressing.decals: expected an array'])
  })
})

describe('validateTownFile: the wrapper', () => {
  it('fails on an unknown kind, a bad schema, a missing world', () => {
    expect(problems(null)).toEqual(['town file: expected an object'])
    expect(problems({ ...town(), kind: 'towns' })).toEqual(["kind: expected 'town' or 'townDressing'"])
    expect(problems({ ...town(), schema: 2 })).toEqual(['schema: expected 1'])
    expect(problems({ ...dressing(), world: '' })).toEqual(['file.world: expected a non-empty string'])
  })
})

describe('validateTownFile: TL-R refinements (heights, hours, pairs, held seats)', () => {
  it('accepts node, place and seat heights, route hours and pairs, fixed hours and clips', () => {
    const f = town()
    f.graph.nodes[0]!.y = -3.2
    f.places[1]!.y = 0.5
    f.places[1]!.seats![0]!.y = 0.6
    f.folk.routes![0]!.hours = [18, 20]
    f.folk.routes![0]!.pairs = true
    f.folk.fixed![0]!.hours = [6, 20]
    f.folk.fixed![0]!.clip = 'VENDOR01'
    f.folk.districts = [{ id: 'plaza', x: 0, z: 10, radius: 30, weight: 1, evening: 2 }]
    expect(problems(f)).toEqual([])
  })

  it('refuses bad hours, a bad pairs flag and a non-numeric height', () => {
    const f = town() as unknown as { graph: { nodes: Array<Record<string, unknown>> }; folk: { routes: Array<Record<string, unknown>>; fixed: Array<Record<string, unknown>> } }
    f.graph.nodes[0]!.y = 'low'
    f.folk.routes[0]!.hours = [18, 18]
    f.folk.routes[0]!.pairs = 'yes'
    f.folk.fixed[0]!.hours = [6]
    ;(f.folk as unknown as { districts: unknown[] }).districts = [{ id: 'square', x: 0, z: 0, radius: 30, weight: 1, evening: -1 }]
    const p = problems(f)
    expect(p.some((s) => s.startsWith('town.graph.nodes[0].y'))).toBe(true)
    expect(p.some((s) => s.startsWith('town.folk.routes[0].hours'))).toBe(true)
    expect(p.some((s) => s.startsWith('town.folk.routes[0].pairs'))).toBe(true)
    expect(p.some((s) => s.startsWith('town.folk.fixed[0].hours'))).toBe(true)
    expect(p.some((s) => s.startsWith('town.folk.districts[0].evening'))).toBe(true)
  })

  it('refuses one seat held by two fixed agents', () => {
    const f = town()
    f.folk.fixed!.push({ role: 'vendor', place: 'fruitStall', seat: 0 })
    expect(problems(f).some((s) => /held by two fixed agents/.test(s))).toBe(true)
  })
})
