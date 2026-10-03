/**
 * The town files of wave 11 (docs/TOWN_LIFE.md §2.4, §3, §7; docs/WAVE_PLAN7.md §3.2, D18). Two reviewable JSON
 * files per town, both checked by validateTownFile():
 *
 * - `content/town/<town>.json`, kind 'town' (lane TL-R): the route graph, the places, the folk, the hour bands and the
 *   English lines. The converter validates it and copies it into the export as `world/<world>/town.json`; the client's
 *   pure schedule (`packages/world-render/src/town/schedule.ts`) turns it into townsfolk as a function of the server
 *   clock, so friends see the same crowd.
 * - `content/town/<town>-dressing.json`, kind 'townDressing' (lane TL-B): new static props, banners, lamps, decals,
 *   crack-grass bands and the pond profile; applied by the converter only.
 *
 * Coordinates are glTF metres in the world manifest frame (docs/CONVENTIONS.md "World space"), as NestDef's; yaw in
 * radians. Hours are solar hours 0..24 (0 = midnight, the sky's clock). Nav checks (edges on the navmesh, props off
 * the paths) are the build scripts', not the validator's. Unknown keys are allowed. Environment-neutral.
 */

import { townManualProblems, type TownManual } from './town-manual.ts'

export const TOWN_FILE_SCHEMA = 1

/** Where townsfolk go (docs/TOWN_LIFE.md §2.4). People appear and leave only at a `door`. */
export type TownPlaceKind =
  | 'stall' | 'teaTable' | 'bench' | 'fountainRim' | 'chatSpot' | 'guardPost' | 'door' | 'well' | 'smithAnvil'
  | 'stable' | 'templeSteps' | 'pondEdge'

export const TOWN_PLACE_KINDS: readonly TownPlaceKind[] = [
  'stall', 'teaTable', 'bench', 'fountainRim', 'chatSpot', 'guardPost', 'door', 'well', 'smithAnvil', 'stable',
  'templeSteps', 'pondEdge',
]

/** Roles of the crowd (docs/TOWN_LIFE.md §3.3). */
export type TownRole =
  | 'walker' | 'chatter' | 'sitter' | 'vendor' | 'porter' | 'guard' | 'child' | 'rider' | 'lanternCarrier' | 'worker'

export const TOWN_ROLES: readonly TownRole[] = [
  'walker', 'chatter', 'sitter', 'vendor', 'porter', 'guard', 'child', 'rider', 'lanternCarrier', 'worker',
]

/** How a seated or standing agent holds a seat: `chair` = SIT_CHAIR (a stool, a bench), `floor` = the retail SIT. */
export type TownSeatPose = 'chair' | 'floor' | 'stand'

export const TOWN_SEAT_POSES: readonly TownSeatPose[] = ['chair', 'floor', 'stand']

/** A seat is "by its place": at most this far (m) from the place's point. */
export const TOWN_SEAT_MAX_DIST_M = 8

/** Longest English line (a speech bubble). */
export const TOWN_LINE_MAX = 120

// ---- the town file (kind 'town') ------------------------------------------------------------------

export interface TownNode {
  id: string
  x: number
  z: number
  /** Ground height (m) on the navmesh, written by the build script; absent: the client samples the ground. */
  y?: number
}

/** A straight walkable segment between two nodes, both ways. */
export interface TownEdge {
  a: string
  b: string
}

export interface TownSeat {
  x: number
  z: number
  /** Ground height (m), as TownNode.y. */
  y?: number
  /** Facing, radians: forward = (sin yaw, cos yaw), the game's convention (`Math.atan2(dx, dz)`). */
  yaw: number
  pose: TownSeatPose
}

export interface TownPlace {
  id: string
  kind: TownPlaceKind
  x: number
  z: number
  /** Ground height (m), as TownNode.y. */
  y?: number
  yaw: number
  /** The graph node agents walk to before stepping onto the place (the segment node → point, node → each seat is walkable). */
  node: string
  /** Seats or standing spots (tea tables, benches, the fountain rim, a chat ring, a vendor's spot). */
  seats?: TownSeat[]
  /** Under an eave or awning: chatters and sitters keep it in rain. */
  sheltered?: boolean
  /** A stall's goods: the `lines.calls` key of its vendor's calls, e.g. 'fruit', 'silk', 'tea'. */
  goods?: string
  /** District id (TownFolk.districts). */
  district?: string
}

/** A fixed agent (the smith's apprentice, a sitter elder, a vendor): always at `place`, on seat index `seat`. */
export interface TownFixedAgent {
  role: TownRole
  place: string
  seat?: number
  /** Solar hours [from, to) the agent is at its place (wraps past midnight); absent: by the role's share of the hour curve. */
  hours?: [number, number]
  /** Clip name while at the place (e.g. 'HAMMER', 'VENDOR01'); absent: by the role and the seat's pose. */
  clip?: string
}

/** A closed loop of graph nodes walked by a patrol (guards) or a recurring rider; consecutive nodes share an edge. */
export interface TownRoute {
  id: string
  role: TownRole
  nodes: string[]
  /** Agents on the loop (spread evenly). */
  count: number
  /** Solar hours [from, to) the route is walked (wraps past midnight); absent: at every hour. */
  hours?: [number, number]
  /** Walk in pairs side by side (guards). */
  pairs?: boolean
}

export interface TownDistrict {
  id: string
  x: number
  z: number
  radius: number
  /** Relative share of the roaming crowd. */
  weight: number
  /**
   * Relative share of the evening and night crowd (the roamers still out when the hour curve is low: the tea house
   * fills, the market empties; TOWN_LIFE §3.5). Default: `weight`.
   */
  evening?: number
}

export interface TownFolk {
  /** Roaming agents at the day peak (share 1), before the preset caps (Medium 60 / High 100 / Ultra 140). */
  population: number
  /** Relative shares of the roaming roles, e.g. {walker: 40, chatter: 20, sitter: 15, vendor: 8, porter: 5, child: 4}. */
  roles: Partial<Record<TownRole, number>>
  /** Share of women among the roaming crowd, 0..1. */
  female?: number
  districts?: TownDistrict[]
  fixed?: TownFixedAgent[]
  routes?: TownRoute[]
}

/** Share of the population out between solar hours `from` and `to` (wraps past midnight when `from` > `to`). */
export interface TownHourBand {
  from: number
  to: number
  share: number
}

export interface TownSchedule {
  /** Must cover the whole day exactly once (docs/TOWN_LIFE.md §3.5). */
  bands: TownHourBand[]
  /** Rain level (0..1) above which walkers hurry and outside sitters leave; default the life part's 0.25. */
  rainShelter?: number
}

export interface TownLines {
  /** Vendor calls by stall goods (TownPlace.goods). */
  calls: Record<string, string[]>
  /** Flavour lines of a clicked townsperson, by role. */
  flavour: Partial<Record<TownRole, string[]>>
  /** Rumours tied to the local player's act of the main questline. */
  rumours?: Array<{ act: number; text: string }>
}

export interface TownFile {
  schema: typeof TOWN_FILE_SCHEMA
  kind: 'town'
  /** World folder (base name), e.g. 'jangan'. */
  world: string
  /** towns.json code, e.g. 'jangan'. */
  town: string
  /** The crowd's seed: every agent's itinerary is hash(seed, agentId). */
  seed: number
  graph: { nodes: TownNode[]; edges: TownEdge[] }
  places: TownPlace[]
  folk: TownFolk
  schedule: TownSchedule
  lines: TownLines
  /** Wave 12 (WE-T): the World Editor's hand edits, kept and applied by `town-graph` (./town-manual.ts). */
  manual?: TownManual
}

// ---- the dressing file (kind 'townDressing') ------------------------------------------------------

/** Cloth sway kinds (docs/TOWN_LIFE.md §5.1): pinned along the top, along the high edge, or at the base. */
export type TownClothKind = 'hanging' | 'awning' | 'tent'

export const TOWN_CLOTH_KINDS: readonly TownClothKind[] = ['hanging', 'awning', 'tent']

export type TownDecalKind = 'dirt' | 'moss' | 'puddle'

export const TOWN_DECAL_KINDS: readonly TownDecalKind[] = ['dirt', 'moss', 'puddle']

/** A placed model: a retail resource (`res/...bsr`) or one of our props (`/out/...glb`). */
export interface TownProp {
  id?: string
  model: string
  x: number
  z: number
  /** Absent = on the ground (the converter samples the terrain or the object below). */
  y?: number
  yaw: number
  scale?: number
  /** Reclass the prop's cloth materials to sway with this kind. */
  cloth?: TownClothKind
}

/** A banner on a pole (a prop whose cloth sways). */
export interface TownBanner {
  id?: string
  model: string
  x: number
  z: number
  yaw: number
  /** Cloth height (m) below its pin. */
  height: number
  kind: TownClothKind
}

/** An ambient row for a placed model, so it becomes a night light (docs/TOWN_LIFE.md §7.1, WAVE_PLAN7 D15). */
export interface TownLamp {
  /** The model's resource or base name, e.g. 'cj_field_lamp'. */
  model: string
  /** Effect, e.g. 'map/cj_pal_lamp_light.efp' (a NIGHT_LIGHT_KINDS efp to give a light). */
  efp: string
  /** Offset from the model's origin (m), default [0, 0, 0]. */
  offset?: [number, number, number]
}

export interface TownDecal {
  kind: TownDecalKind
  x: number
  z: number
  yaw: number
  /** Width and length (m). */
  size: [number, number]
}

/** Sparse short grass along a polyline (the paving's edges, the walls' feet). */
export interface TownCrackBand {
  /** [x, z] points, at least two. */
  points: Array<[number, number]>
  /** Band width (m). */
  width: number
  /** Blades per m². */
  density: number
}

/** The water material's 'town' profile for the town's ponds (docs/TOWN_LIFE.md §7.5). */
export interface TownPondProfile {
  /** Region ids (z << 8 | x) that take the profile. */
  regions: number[]
  /** Linear RGB 0..1. */
  color: [number, number, number]
  /** 0 = clear, 1 = opaque. */
  turbidity: number
  /** Reflection strength 0..1. */
  reflection?: number
}

export interface TownDressingFile {
  schema: typeof TOWN_FILE_SCHEMA
  kind: 'townDressing'
  world: string
  town: string
  props: TownProp[]
  banners: TownBanner[]
  lamps: TownLamp[]
  decals: TownDecal[]
  crackBands: TownCrackBand[]
  pond?: TownPondProfile
}

// ---- validation -----------------------------------------------------------------------------------

export type TownFileResult =
  | { ok: true; file: TownFile | TownDressingFile }
  | { ok: false; problems: string[] }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

class Check {
  readonly problems: string[] = []
  bad(where: string, what: string): void {
    this.problems.push(`${where}: ${what}`)
  }
  num(o: Record<string, unknown>, k: string, where: string, min = -Infinity, max = Infinity, opt = false): boolean {
    const v = o[k]
    if (v === undefined && opt) return true
    if (!isNum(v) || v < min || v > max) {
      this.bad(`${where}.${k}`, `expected a number in ${min}..${max}`)
      return false
    }
    return true
  }
  str(o: Record<string, unknown>, k: string, where: string, opt = false): boolean {
    const v = o[k]
    if (v === undefined && opt) return true
    if (!isStr(v)) {
      this.bad(`${where}.${k}`, 'expected a non-empty string')
      return false
    }
    return true
  }
  oneOf(o: Record<string, unknown>, k: string, values: readonly string[], where: string, opt = false): boolean {
    const v = o[k]
    if (v === undefined && opt) return true
    if (typeof v !== 'string' || !values.includes(v)) {
      this.bad(`${where}.${k}`, `expected one of ${values.join(', ')}`)
      return false
    }
    return true
  }
  list(o: Record<string, unknown>, k: string, where: string, opt = false): unknown[] {
    const v = o[k]
    if (v === undefined && opt) return []
    if (!Array.isArray(v)) {
      this.bad(`${where}.${k}`, 'expected an array')
      return []
    }
    return v
  }
  xz(o: Record<string, unknown>, where: string): void {
    this.num(o, 'x', where)
    this.num(o, 'z', where)
  }
  /** Optional `hours: [from, to]` solar hours 0..24, from ≠ to. */
  hours(o: Record<string, unknown>, where: string): void {
    const h = o.hours
    if (h === undefined) return
    if (!Array.isArray(h) || h.length !== 2 || !h.every((n) => isNum(n) && n >= 0 && n <= 24) || h[0] === h[1]) {
      this.bad(`${where}.hours`, 'expected [from, to] solar hours 0..24, from != to')
    }
  }
  line(v: unknown, where: string): void {
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > TOWN_LINE_MAX) this.bad(where, `expected a line of 1..${TOWN_LINE_MAX} characters`)
  }
}

/**
 * Checks a parsed town file of either kind ('town' or 'townDressing'). Problems name the path, e.g.
 * `town.graph.edges[3].b: unknown node n77`. Reference checks: edges and places name existing nodes, ids are unique,
 * seats lie by their place, fixed agents name an existing place and seat, routes walk existing edges, a stall's goods
 * have calls, the hour bands cover the day exactly once, and at least one `door` exists.
 */
export function validateTownFile(json: unknown): TownFileResult {
  if (!isObj(json)) return { ok: false, problems: ['town file: expected an object'] }
  const c = new Check()
  if (json.schema !== TOWN_FILE_SCHEMA) c.bad('schema', `expected ${TOWN_FILE_SCHEMA}`)
  c.str(json, 'world', 'file')
  c.str(json, 'town', 'file')
  if (json.kind === 'town') checkTown(c, json)
  else if (json.kind === 'townDressing') checkDressing(c, json)
  else c.bad('kind', "expected 'town' or 'townDressing'")
  return c.problems.length ? { ok: false, problems: c.problems } : { ok: true, file: json as unknown as TownFile | TownDressingFile }
}

function checkTown(c: Check, f: Record<string, unknown>): void {
  c.num(f, 'seed', 'town', 0, 2 ** 32)
  // graph
  const nodes = new Map<string, { x: number; z: number }>()
  const edges = new Set<string>()
  const g = f.graph
  if (!isObj(g)) c.bad('town.graph', 'expected {nodes, edges}')
  else {
    c.list(g, 'nodes', 'town.graph').forEach((n, i) => {
      const w = `town.graph.nodes[${i}]`
      if (!isObj(n)) return c.bad(w, 'expected an object')
      c.str(n, 'id', w)
      c.xz(n, w)
      c.num(n, 'y', w, -Infinity, Infinity, true)
      if (isStr(n.id)) {
        if (nodes.has(n.id)) c.bad(`${w}.id`, `duplicate node ${n.id}`)
        nodes.set(n.id, { x: n.x as number, z: n.z as number })
      }
    })
    c.list(g, 'edges', 'town.graph').forEach((e, i) => {
      const w = `town.graph.edges[${i}]`
      if (!isObj(e)) return c.bad(w, 'expected an object')
      for (const k of ['a', 'b']) {
        if (!c.str(e, k, w)) continue
        if (!nodes.has(e[k] as string)) c.bad(`${w}.${k}`, `unknown node ${String(e[k])}`)
      }
      if (isStr(e.a) && e.a === e.b) c.bad(w, 'an edge needs two different nodes')
      if (isStr(e.a) && isStr(e.b)) edges.add(edgeKey(e.a, e.b))
    })
  }
  // lines (before places: a stall's goods need calls)
  const calls = new Set<string>()
  const l = f.lines
  if (!isObj(l)) c.bad('town.lines', 'expected {calls, flavour}')
  else {
    if (!isObj(l.calls)) c.bad('town.lines.calls', 'expected an object')
    else for (const [k, v] of Object.entries(l.calls)) {
      if (!Array.isArray(v) || v.length === 0) c.bad(`town.lines.calls.${k}`, 'expected a non-empty list of lines')
      else v.forEach((s, j) => c.line(s, `town.lines.calls.${k}[${j}]`))
      calls.add(k)
    }
    if (!isObj(l.flavour)) c.bad('town.lines.flavour', 'expected an object')
    else for (const [k, v] of Object.entries(l.flavour)) {
      if (!(TOWN_ROLES as readonly string[]).includes(k)) c.bad(`town.lines.flavour.${k}`, 'unknown role')
      if (!Array.isArray(v)) c.bad(`town.lines.flavour.${k}`, 'expected a list of lines')
      else v.forEach((s, j) => c.line(s, `town.lines.flavour.${k}[${j}]`))
    }
    c.list(l, 'rumours', 'town.lines', true).forEach((r, i) => {
      const w = `town.lines.rumours[${i}]`
      if (!isObj(r)) return c.bad(w, 'expected {act, text}')
      c.num(r, 'act', w, 0)
      c.line(r.text, `${w}.text`)
    })
  }
  // folk districts (places may name one)
  const folk = isObj(f.folk) ? f.folk : null
  const districts = new Set<string>()
  if (folk) c.list(folk, 'districts', 'town.folk', true).forEach((d, i) => {
    const w = `town.folk.districts[${i}]`
    if (!isObj(d)) return c.bad(w, 'expected an object')
    if (c.str(d, 'id', w)) districts.add(d.id as string)
    c.xz(d, w)
    c.num(d, 'radius', w, 0)
    c.num(d, 'weight', w, 0)
    c.num(d, 'evening', w, 0, Infinity, true)
  })
  // places
  const places = new Map<string, number>()
  let doors = 0
  c.list(f, 'places', 'town').forEach((p, i) => {
    const w = `town.places[${i}]`
    if (!isObj(p)) return c.bad(w, 'expected an object')
    c.str(p, 'id', w)
    c.oneOf(p, 'kind', TOWN_PLACE_KINDS, w)
    c.xz(p, w)
    c.num(p, 'y', w, -Infinity, Infinity, true)
    c.num(p, 'yaw', w)
    if (c.str(p, 'node', w) && !nodes.has(p.node as string)) c.bad(`${w}.node`, `unknown node ${String(p.node)}`)
    if (p.sheltered !== undefined && typeof p.sheltered !== 'boolean') c.bad(`${w}.sheltered`, 'expected a boolean')
    if (c.str(p, 'goods', w, true) && p.goods !== undefined && !calls.has(p.goods as string)) c.bad(`${w}.goods`, `no lines.calls.${String(p.goods)}`)
    if (c.str(p, 'district', w, true) && p.district !== undefined && !districts.has(p.district as string)) c.bad(`${w}.district`, `unknown district ${String(p.district)}`)
    if (p.kind === 'door') doors++
    const seats = c.list(p, 'seats', w, true)
    seats.forEach((s, j) => {
      const ws = `${w}.seats[${j}]`
      if (!isObj(s)) return c.bad(ws, 'expected an object')
      c.xz(s, ws)
      c.num(s, 'y', ws, -Infinity, Infinity, true)
      c.num(s, 'yaw', ws)
      c.oneOf(s, 'pose', TOWN_SEAT_POSES, ws)
      if (isNum(s.x) && isNum(s.z) && isNum(p.x) && isNum(p.z) && Math.hypot(s.x - p.x, s.z - p.z) > TOWN_SEAT_MAX_DIST_M) {
        c.bad(ws, `dangling seat: more than ${TOWN_SEAT_MAX_DIST_M} m from its place`)
      }
    })
    if (isStr(p.id)) {
      if (places.has(p.id)) c.bad(`${w}.id`, `duplicate place ${p.id}`)
      else places.set(p.id, seats.length)
    }
  })
  if (doors === 0) c.bad('town.places', "expected at least one 'door' (people appear and leave only at doors)")
  // folk
  if (!folk) c.bad('town.folk', 'expected an object')
  else {
    c.num(folk, 'population', 'town.folk', 0, 1000)
    c.num(folk, 'female', 'town.folk', 0, 1, true)
    if (!isObj(folk.roles)) c.bad('town.folk.roles', 'expected an object')
    else for (const [k, v] of Object.entries(folk.roles)) {
      if (!(TOWN_ROLES as readonly string[]).includes(k)) c.bad(`town.folk.roles.${k}`, 'unknown role')
      if (!isNum(v) || v < 0) c.bad(`town.folk.roles.${k}`, 'expected a share >= 0')
    }
    const held = new Set<string>()
    c.list(folk, 'fixed', 'town.folk', true).forEach((a, i) => {
      const w = `town.folk.fixed[${i}]`
      if (!isObj(a)) return c.bad(w, 'expected an object')
      c.oneOf(a, 'role', TOWN_ROLES, w)
      c.hours(a, w)
      c.str(a, 'clip', w, true)
      if (!c.str(a, 'place', w)) return
      const n = places.get(a.place as string)
      if (n === undefined) return c.bad(`${w}.place`, `unknown place ${String(a.place)}`)
      if (a.seat !== undefined && (!Number.isInteger(a.seat) || (a.seat as number) < 0 || (a.seat as number) >= n)) {
        c.bad(`${w}.seat`, `dangling seat: place ${String(a.place)} has ${n} seat(s)`)
      }
      const key = `${String(a.place)}#${String(a.seat ?? -1)}`
      if (held.has(key)) c.bad(w, `seat ${String(a.seat ?? '(the place)')} of ${String(a.place)} is held by two fixed agents`)
      held.add(key)
    })
    const ids = new Set<string>()
    c.list(folk, 'routes', 'town.folk', true).forEach((r, i) => {
      const w = `town.folk.routes[${i}]`
      if (!isObj(r)) return c.bad(w, 'expected an object')
      if (c.str(r, 'id', w)) {
        if (ids.has(r.id as string)) c.bad(`${w}.id`, `duplicate route ${String(r.id)}`)
        ids.add(r.id as string)
      }
      c.oneOf(r, 'role', TOWN_ROLES, w)
      c.num(r, 'count', w, 0, 100)
      c.hours(r, w)
      if (r.pairs !== undefined && typeof r.pairs !== 'boolean') c.bad(`${w}.pairs`, 'expected a boolean')
      const ns = c.list(r, 'nodes', w)
      if (ns.length < 2) return c.bad(`${w}.nodes`, 'expected at least two nodes')
      ns.forEach((n, j) => {
        if (typeof n !== 'string' || !nodes.has(n)) return c.bad(`${w}.nodes[${j}]`, `unknown node ${String(n)}`)
        const next = ns[(j + 1) % ns.length]
        if (typeof next === 'string' && nodes.has(next) && next !== n && !edges.has(edgeKey(n, next))) c.bad(`${w}.nodes[${j}]`, `no edge ${n} - ${next}`)
      })
    })
  }
  // schedule
  const s = f.schedule
  if (!isObj(s)) c.bad('town.schedule', 'expected {bands}')
  else {
    c.num(s, 'rainShelter', 'town.schedule', 0, 1, true)
    const bands: TownHourBand[] = []
    c.list(s, 'bands', 'town.schedule').forEach((b, i) => {
      const w = `town.schedule.bands[${i}]`
      if (!isObj(b)) return c.bad(w, 'expected {from, to, share}')
      const ok = [c.num(b, 'from', w, 0, 24), c.num(b, 'to', w, 0, 24), c.num(b, 'share', w, 0, 1)].every(Boolean)
      if (ok && b.from === b.to) c.bad(w, 'an empty band')
      else if (ok) bands.push(b as unknown as TownHourBand)
    })
    // every quarter hour covered exactly once (sampled mid-quarter, so touching ends never double-count)
    for (let q = 0; q < 96; q++) {
      const h = q / 4 + 0.125
      const n = bands.filter((b) => inTownHourBand(b, h)).length
      if (n !== 1) {
        c.bad('town.schedule.bands', `hour ${h.toFixed(3)} is covered ${n} times, expected once`)
        break
      }
    }
  }  // wave 12 (WE-T): the editor's overlay
  if (f.manual !== undefined) c.problems.push(...townManualProblems(f.manual))
}

function checkDressing(c: Check, f: Record<string, unknown>): void {
  const model = (o: Record<string, unknown>, w: string) => c.str(o, 'model', w)
  c.list(f, 'props', 'dressing').forEach((p, i) => {
    const w = `dressing.props[${i}]`
    if (!isObj(p)) return c.bad(w, 'expected an object')
    c.str(p, 'id', w, true)
    model(p, w)
    c.xz(p, w)
    c.num(p, 'y', w, -Infinity, Infinity, true)
    c.num(p, 'yaw', w)
    c.num(p, 'scale', w, 0.01, 100, true)
    c.oneOf(p, 'cloth', TOWN_CLOTH_KINDS, w, true)
  })
  c.list(f, 'banners', 'dressing').forEach((b, i) => {
    const w = `dressing.banners[${i}]`
    if (!isObj(b)) return c.bad(w, 'expected an object')
    c.str(b, 'id', w, true)
    model(b, w)
    c.xz(b, w)
    c.num(b, 'yaw', w)
    c.num(b, 'height', w, 0.01, 50)
    c.oneOf(b, 'kind', TOWN_CLOTH_KINDS, w)
  })
  c.list(f, 'lamps', 'dressing').forEach((l, i) => {
    const w = `dressing.lamps[${i}]`
    if (!isObj(l)) return c.bad(w, 'expected an object')
    model(l, w)
    if (c.str(l, 'efp', w) && !(l.efp as string).endsWith('.efp')) c.bad(`${w}.efp`, 'expected an .efp path')
    const off = l.offset
    if (off !== undefined && (!Array.isArray(off) || off.length !== 3 || !off.every(isNum))) c.bad(`${w}.offset`, 'expected [x, y, z]')
  })
  c.list(f, 'decals', 'dressing').forEach((d, i) => {
    const w = `dressing.decals[${i}]`
    if (!isObj(d)) return c.bad(w, 'expected an object')
    c.oneOf(d, 'kind', TOWN_DECAL_KINDS, w)
    c.xz(d, w)
    c.num(d, 'yaw', w)
    const sz = d.size
    if (!Array.isArray(sz) || sz.length !== 2 || !sz.every((n) => isNum(n) && n > 0)) c.bad(`${w}.size`, 'expected [width, length] > 0')
  })
  c.list(f, 'crackBands', 'dressing').forEach((b, i) => {
    const w = `dressing.crackBands[${i}]`
    if (!isObj(b)) return c.bad(w, 'expected an object')
    const pts = b.points
    if (!Array.isArray(pts) || pts.length < 2 || !pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) c.bad(`${w}.points`, 'expected at least two [x, z] points')
    c.num(b, 'width', w, 0.01, 10)
    c.num(b, 'density', w, 0, 100)
  })
  const p = f.pond
  if (p !== undefined) {
    const w = 'dressing.pond'
    if (!isObj(p)) return c.bad(w, 'expected an object')
    if (!Array.isArray(p.regions) || p.regions.length === 0 || !p.regions.every((r) => Number.isInteger(r) && r >= 0 && r <= 0xffff)) c.bad(`${w}.regions`, 'expected region ids')
    const col = p.color
    if (!Array.isArray(col) || col.length !== 3 || !col.every((n) => isNum(n) && n >= 0 && n <= 1)) c.bad(`${w}.color`, 'expected linear RGB 0..1')
    c.num(p, 'turbidity', w, 0, 1)
    c.num(p, 'reflection', w, 0, 1, true)
  }
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/** True when solar hour `h` lies in the band (half-open [from, to), wrapping past midnight when from > to). */
export function inTownHourBand(b: TownHourBand, h: number): boolean {
  return b.from < b.to ? h >= b.from && h < b.to : h >= b.from || h < b.to
}
