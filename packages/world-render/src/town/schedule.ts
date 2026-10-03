/**
 * The pure town schedule (docs/TOWN_LIFE.md §2.1, §2.2, §3.3–§3.6; docs/WAVE_PLAN7.md §6.1 TL-R, D19). Lane TL-R.
 *
 * The town file (`town.json`, kind 'town', packages/shared/src/town.ts) becomes a list of agents, each with a cyclic
 * itinerary compiled once at load, and `stateAt(agent, nowS, solar)` says where every townsperson is, what it plays and
 * how visible it is, as a function of the shared server clock alone: no state is kept between frames, so two clients
 * that agree on the server time draw the same crowd, and a client that joins late, reloads or teleports in computes the
 * same scene at once (option C of TOWN_LIFE §2.1). It never touches Babylon; the crowd (town/crowd.ts, TL-C) draws it.
 *
 * - **Time base.** Positions and clips use server real seconds (`serverNow() / 1000`, §2.2). Who is out uses the solar
 *   time of the sky's clock (`TownSolar`: a constant t for the stage and the viewer, or `serverS → t` from the world
 *   clock), evaluated at the start of each trip, so a trip is all-or-nothing and nobody pops in or out mid-street.
 * - **Itineraries (§3.4).** Every roaming agent has `TOWN_TRIP_VARIANTS` trips of `TOWN_TRIP_S` seconds, each a loop
 *   from its home door through places and stops and back; trip k (counted on the server clock with the agent's phase)
 *   plays variant k mod V. A trip is taken when the agent's presence rank is below the hour curve's share at the trip's
 *   start (§3.5). Leaving and appearing happen only at doors, with a `TOWN_FADE_S` dither fade (alpha).
 * - **Fixed agents** (vendors, the smith's apprentice, elders) hold one seat for their hours; they walk in from the
 *   nearest door when their day starts and out when it ends. **Routes** (guard patrols, the rider, the dusk lantern
 *   carriers) loop over graph nodes; a route with hours enters and leaves through a door.
 * - **Groups** (chat rings of 3–4, couples, a porter and his pack horse) share one plan; each member's legs are the
 *   leader's shifted by its lag and ending at its own formation spot, so a member never steps onto another.
 * - **Seats** are booked at compile time on the common period (`TOWN_TRIP_VARIANTS × TOWN_TRIP_S`): no two agents ever
 *   sit on one seat at the same time.
 * - **The alarm (D19).** `alarm(nowS, sec)`: walkers, chatters, sitters, porters, children and lantern carriers hurry
 *   (×`TOWN_HURRY`) along the graph to the nearest door and go in; guards walk to the south gate; vendors, workers and
 *   the rider keep their schedule. After the alarm everyone rejoins the schedule at a node it will pass, walking out of
 *   a door in time to meet it there (or stays in until its next trip), so nobody pops in the middle of a street.
 *
 * Coordinates are glTF metres (the manifest frame); yaw is the game's (`forward = (sin yaw, cos yaw)`). y is the
 * navmesh height the build script stored, NaN where the file has none (the crowd then samples the ground).
 *
 * Budget (TOWN_LIFE §9.2): `stateAt` for 300 agents ≤ 0.05 ms per frame; no allocation per call (pass `out`).
 */
import { inTownHourBand, type TownDistrict, type TownFile, type TownHourBand, type TownPlaceKind, type TownRole, type TownSeatPose } from '../../../shared/src/town.ts'
import type { TownCircle } from './types.ts'

// ---- numbers -------------------------------------------------------------------------------------------------------

/** Length of one roaming trip (s): a home-door loop. A game hour is ≈ 300 s, so the crowd follows the hour curve. */
export const TOWN_TRIP_S = 480
/** Trip variants per roaming agent: trip k plays variant k mod V; the seat-booking period is V × TOWN_TRIP_S. */
export const TOWN_TRIP_VARIANTS = 3
/** The dither fade at a door (s). */
export const TOWN_FADE_S = 0.6
/** Heading blend into and out of a dwell (s): turns are not snaps. */
export const TOWN_TURN_S = 0.4
/** Corner rounding of a walk polyline's heading (m each side of a corner). */
export const TOWN_CORNER_M = 0.5
/** Hurry factor of the alarm (walkers to the doors). */
export const TOWN_HURRY = 1.3
/** A chat ring's talking turn (s). */
export const TOWN_CHAT_TURN_S = 4
/** The hour curve's ramp at a band boundary (hours each side). */
export const TOWN_HOUR_RAMP_H = 0.5
/** Spacing of a walking group (m), and the porter's horse behind him. */
export const TOWN_GROUP_GAP_M = 1.0
export const TOWN_HORSE_GAP_M = 2.4
/** Half the spacing of a guard pair walking side by side (m). */
export const TOWN_PAIR_SIDE_M = 0.45
/**
 * How a roaming role leans in the presence order (added to a 0..1 random key; lower stays out later): who is still out
 * when the hour curve thins the crowd (TOWN_LIFE §3.5: the tea house fills at dusk, the children are home by dark).
 */
export const TOWN_RANK_LEAN: Readonly<Partial<Record<TownRole, number>>> = { sitter: -0.35, chatter: -0.15, walker: 0, porter: 0.45, child: 0.9 }
/** Roamers whose presence rank is below this are the evening and night crowd (districts' `evening` weights). */
export const TOWN_EVENING_RANK = 0.3
/** A roaming trip with more slack than this (s) before its walk home takes one more stop out of doors. */
export const TOWN_SLACK_S = 12
/**
 * How far a stop on a bare graph node stands aside of it (m, at most; 70–100 % of it): out of the line of the walkers
 * passing through the node, still inside its clear disk (graph nodes keep ≥ 1.2 m from nav edges).
 */
export const TOWN_NODE_ASIDE_M = 0.85
/** A place whose point lies this close to one of its seats is no look target (m): the looker would stand in the sitter. */
export const TOWN_LOOK_CLEAR_M = 0.6

/** Clips the schedule asks for (TOWN_LIFE §3.1, §3.3). A crowd without a clip plays TOWN_CLIP_FALLBACK[clip]. */
export const TOWN_CLIPS = [
  'STAND1', 'STAND3', 'WALK', 'RUN', 'SIT', 'SIT_CHAIR', 'VENDOR01', 'EMOTION01', 'EMOTION02', 'EMOTION04', 'EMOTION07',
  'CARRY', 'HAMMER', 'TALK', 'SWEEP',
] as const
export type TownClip = (typeof TOWN_CLIPS)[number]

/** The retail fallback of each hand-keyed clip (TL-A2's SIT_CHAIR, CARRY, TALK, SWEEP land later, §3.1). */
export const TOWN_CLIP_FALLBACK: Readonly<Partial<Record<TownClip, TownClip>>> = {
  SIT_CHAIR: 'SIT', CARRY: 'WALK', TALK: 'STAND3', SWEEP: 'STAND1',
}

/** What an agent is drawn as: a dressed body, a patrol guard, a pack horse, a horse with its rider. */
export type TownAgentKind = 'person' | 'guard' | 'horse' | 'rider'

/** Walk speed (m/s) at clip rate 1, by kind and clip (WALK 17 dm / 1.166 s; RUN 33.3 dm / 0.666 s [sidecars]). */
export function townNominalSpeed(kind: TownAgentKind, clip: TownClip): number {
  if (kind === 'horse' || kind === 'rider') return 1.8
  if (kind === 'guard') return 1.4
  return clip === 'RUN' ? 5.0 : 1.46
}

/** The sky's solar time t (0..1, 0 = midnight): a constant (stage, viewer, tests) or the world clock at server second s. */
export type TownSolar = number | ((serverS: number) => number)

/** Where an agent is and what it does (TownSchedule.stateAt). Reuse one per agent: nothing is allocated per call. */
export interface TownAgentState {
  /** alpha > 0. */
  visible: boolean
  /** 0..1, the dither fade at doors. */
  alpha: number
  x: number
  /** NaN where the town file has no height (sample the ground). */
  y: number
  z: number
  yaw: number
  clip: TownClip
  /** Seconds into the clip at rate 1 (already × clipRate since the clip started); the crowd wraps it by the clip length. */
  clipTime: number
  /** Playback rate of the clip (a walk scaled to its speed so feet do not slide). */
  clipRate: number
  /** Walking (the sidestep applies). */
  moving: boolean
  /** m/s along the path (0 when dwelling). */
  speed: number
  /** Index of the dwell place in `schedule.places`, -1 when walking or stopping on a bare node. */
  place: number
  /** Seat index at that place, -1 when none. */
  seat: number
  /** The talker of a chat ring this turn (a bubble hint). */
  talking: boolean
}

export function newTownAgentState(): TownAgentState {
  return {
    visible: false, alpha: 0, x: 0, y: NaN, z: 0, yaw: 0, clip: 'STAND1', clipTime: 0, clipRate: 1, moving: false, speed: 0,
    place: -1, seat: -1, talking: false,
  }
}

// ---- compiled data -------------------------------------------------------------------------------------------------

export interface TownSchedulePlace {
  readonly index: number
  readonly id: string
  readonly kind: TownPlaceKind
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  /** Graph node index. */
  readonly node: number
  readonly seats: ReadonlyArray<{ x: number; y: number; z: number; yaw: number; pose: TownSeatPose }>
  readonly sheltered: boolean
  readonly goods: string | null
  readonly district: string | null
}

/** How an agent decides it is out: by the hour curve (rank < share), at every hour, or within solar hours. */
type Presence = { kind: 'share'; rank: number } | { kind: 'always' } | { kind: 'hours'; from: number; to: number }

export interface TownAgent {
  readonly index: number
  readonly id: string
  readonly role: TownRole
  readonly kind: TownAgentKind
  readonly female: boolean
  /** Body scale (a child 0.82). */
  readonly scale: number
  /** Seed for the look: variant, tint, gait style (hash). */
  readonly look: number
  /** Group id (-1 none) and member index (0 = leader). */
  readonly group: number
  readonly member: number
  /** The walk speed (m/s). */
  readonly speed: number
  /** Home door place index (where it appears), -1 for routes without hours. */
  readonly home: number
  /** Period (s) and phase (s): trip k = floor((nowS + phase) / period). */
  readonly period: number
  readonly phase: number
  /** Fixed agents: their place and seat. */
  readonly place: number
  readonly seat: number
  /** Cap rank 0..1 (index order): a crowd that draws fewer agents keeps the lowest ranks, the same on every client. */
  readonly rank: number
  /** A vendor's goods (TownPlace.goods, the `lines.calls` key), else null. */
  readonly goods: string | null
  /** @internal */
  readonly presence: Presence
  /** @internal: roaming: V trips; fixed: [stay, arrive, leave, arrive+leave]; routes: [loop]. */
  readonly trips: readonly Trip[]
  /** @internal */
  readonly mode: 'roam' | 'fixed' | 'route'
  /** @internal: reacts to the alarm: 'door' hurries in, 'gate' walks to the guards' gate, 'none' keeps its schedule. */
  readonly alarm: 'door' | 'gate' | 'none'
}

const LEG_WALK = 0
const LEG_DWELL = 1

/** One trip: legs with start times (t[n] = the period) and their points (x, y, z, cumulative s, segment yaw). */
class Trip {
  readonly n: number
  readonly t: Float64Array
  readonly kind: Uint8Array
  readonly clip: Uint8Array
  readonly rate: Float32Array
  readonly speed: Float32Array
  readonly p0: Int32Array
  readonly pn: Int32Array
  readonly yawFrom: Float32Array
  readonly yaw: Float32Array
  readonly place: Int16Array
  readonly seat: Int16Array
  readonly ring: Uint8Array
  readonly ringT0: Float32Array
  readonly anchor: Int32Array
  /** stride 5: x, y, z, s (cumulative within the leg), yaw of the segment starting at this point. */
  readonly pts: Float64Array
  /** Graph node of each point, -1 off the graph. */
  readonly ptNode: Int32Array
  constructor(legs: readonly LegSpec[], period: number) {
    const n = legs.length
    this.n = n
    this.t = new Float64Array(n + 1)
    this.kind = new Uint8Array(n)
    this.clip = new Uint8Array(n)
    this.rate = new Float32Array(n)
    this.speed = new Float32Array(n)
    this.p0 = new Int32Array(n)
    this.pn = new Int32Array(n)
    this.yawFrom = new Float32Array(n)
    this.yaw = new Float32Array(n)
    this.place = new Int16Array(n)
    this.seat = new Int16Array(n)
    this.ring = new Uint8Array(n)
    this.ringT0 = new Float32Array(n)
    this.anchor = new Int32Array(n)
    let np = 0
    for (const l of legs) np += l.pts.length
    this.pts = new Float64Array(np * 5)
    this.ptNode = new Int32Array(np)
    let t = 0
    let p = 0
    let lastYaw = legs.length && legs[0]!.kind === 'dwell' ? legs[0]!.yaw : 0
    for (let i = 0; i < n; i++) {
      const l = legs[i]!
      this.t[i] = t
      t += l.dur
      this.kind[i] = l.kind === 'walk' ? LEG_WALK : LEG_DWELL
      this.clip[i] = clipIndex(l.clip)
      this.rate[i] = l.rate
      this.speed[i] = l.speed
      this.p0[i] = p
      this.pn[i] = l.pts.length
      this.place[i] = l.place
      this.seat[i] = l.seat
      this.ring[i] = l.ring
      this.ringT0[i] = l.ringT0
      this.anchor[i] = l.anchor
      this.yawFrom[i] = lastYaw
      let s = 0
      for (let j = 0; j < l.pts.length; j++) {
        const a = l.pts[j]!
        const b = l.pts[j + 1]
        const o = (p + j) * 5
        this.pts[o] = a.x
        this.pts[o + 1] = a.y
        this.pts[o + 2] = a.z
        this.pts[o + 3] = s
        this.pts[o + 4] = b ? Math.atan2(b.x - a.x, b.z - a.z) : this.pts[o - 1] ?? 0
        this.ptNode[p + j] = a.node
        if (b) s += Math.hypot(b.x - a.x, b.z - a.z)
      }
      if (l.kind === 'walk') {
        if (l.pts.length === 1) this.pts[p * 5 + 4] = lastYaw
        lastYaw = this.pts[(p + Math.max(0, l.pts.length - 2)) * 5 + 4]!
        this.yaw[i] = lastYaw
      } else {
        this.yaw[i] = l.yaw
        lastYaw = l.yaw
      }
      p += l.pts.length
    }
    this.t[n] = period
    if (Math.abs(t - period) > 1e-6) throw new Error(`town schedule: a trip lasts ${t} s, expected ${period} s`)
  }
}

interface SpotPoint {
  x: number
  y: number
  z: number
  /** Graph node of this point (-1 off the graph). */
  node: number
}

interface LegSpec {
  kind: 'walk' | 'dwell'
  dur: number
  clip: TownClip
  rate: number
  speed: number
  pts: SpotPoint[]
  yaw: number
  place: number
  seat: number
  ring: number
  ringT0: number
  /** The graph node a dwell steps back to (the alarm's escape and the walk's own nodes). */
  anchor: number
}

const CLIP_INDEX = new Map<string, number>(TOWN_CLIPS.map((c, i) => [c, i]))
function clipIndex(c: string): number {
  return CLIP_INDEX.get(c) ?? 0
}

// ---- small pure helpers --------------------------------------------------------------------------------------------

/** 32-bit mix (lowbias32). */
export function townHash(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return h >>> 0
}

function strHash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAU = Math.PI * 2

function lerpAngle(a: number, b: number, f: number): number {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  else if (d < -Math.PI) d += TAU
  return a + d * f
}

function mod(a: number, m: number): number {
  const r = a % m
  return r < 0 ? r + m : r
}

/** Solar hour (0..24) of a TownSolar at server second s. */
function solarHour(solar: TownSolar, s: number): number {
  const t = typeof solar === 'number' ? solar : solar(s)
  return mod(t, 1) * 24
}

function inHours(h: number, from: number, to: number): boolean {
  return from < to ? h >= from && h < to : h >= from || h < to
}

/**
 * The hour curve (TOWN_LIFE §3.5): the band's share, ramped linearly over ±TOWN_HOUR_RAMP_H to the mean with the
 * neighbouring band at each boundary, so the town fills and empties smoothly. `bands` must cover the day once.
 */
export function townShareAt(bands: readonly TownHourBand[], hour: number): number {
  const h = mod(hour, 24)
  const n = bands.length
  if (n === 0) return 1
  let i = 0
  for (; i < n; i++) if (inTownHourBand(bands[i]!, h)) break
  if (i === n) return 0
  const b = bands[i]!
  const len = mod(b.to - b.from, 24) || 24
  const ramp = Math.min(TOWN_HOUR_RAMP_H, len / 2)
  const sinceStart = mod(h - b.from, 24)
  const toEnd = len - sinceStart
  if (sinceStart < ramp) {
    const prev = bandAt(bands, b.from - 1e-6)
    return lerp((prev.share + b.share) / 2, b.share, sinceStart / ramp)
  }
  if (toEnd < ramp) {
    const next = bandAt(bands, b.to + 1e-6)
    return lerp((next.share + b.share) / 2, b.share, toEnd / ramp)
  }
  return b.share
}

function bandAt(bands: readonly TownHourBand[], hour: number): TownHourBand {
  const h = mod(hour, 24)
  for (const b of bands) if (inTownHourBand(b, h)) return b
  return bands[0]!
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f
}

// ---- the graph -----------------------------------------------------------------------------------------------------

class Graph {
  readonly n: number
  readonly ids: string[]
  readonly x: Float64Array
  readonly y: Float64Array
  readonly z: Float64Array
  readonly start: Int32Array
  readonly adj: Int32Array
  readonly len: Float64Array
  readonly index = new Map<string, number>()
  private readonly cache = new Map<number, { dist: Float64Array; prev: Int32Array }>()

  constructor(nodes: ReadonlyArray<{ id: string; x: number; z: number; y?: number }>, edges: ReadonlyArray<[number, number]>) {
    this.n = nodes.length
    this.ids = nodes.map((n) => n.id)
    this.x = Float64Array.from(nodes, (n) => n.x)
    this.y = Float64Array.from(nodes, (n) => (typeof n.y === 'number' ? n.y : NaN))
    this.z = Float64Array.from(nodes, (n) => n.z)
    nodes.forEach((n, i) => this.index.set(n.id, i))
    const deg = new Int32Array(this.n + 1)
    for (const [a, b] of edges) {
      deg[a]!++
      deg[b]!++
    }
    this.start = new Int32Array(this.n + 1)
    for (let i = 0; i < this.n; i++) this.start[i + 1] = this.start[i]! + deg[i]!
    this.adj = new Int32Array(this.start[this.n]!)
    this.len = new Float64Array(this.start[this.n]!)
    const fill = this.start.slice(0, this.n)
    for (const [a, b] of edges) {
      const d = Math.hypot(this.x[a]! - this.x[b]!, this.z[a]! - this.z[b]!)
      this.adj[fill[a]!] = b
      this.len[fill[a]!++] = d
      this.adj[fill[b]!] = a
      this.len[fill[b]!++] = d
    }
  }

  point(i: number): SpotPoint {
    return { x: this.x[i]!, y: this.y[i]!, z: this.z[i]!, node: i }
  }

  /** Multi-source Dijkstra: dist to the nearest source and the next hop toward it (prev). */
  dijkstra(sources: readonly number[]): { dist: Float64Array; prev: Int32Array } {
    const dist = new Float64Array(this.n).fill(Infinity)
    const prev = new Int32Array(this.n).fill(-1)
    const heap = new MinHeap(this.n)
    for (const s of sources) {
      if (s < 0 || s >= this.n) continue
      dist[s] = 0
      heap.push(s, 0)
    }
    while (heap.size) {
      const u = heap.pop()
      const du = dist[u]!
      for (let k = this.start[u]!; k < this.start[u + 1]!; k++) {
        const v = this.adj[k]!
        const dv = du + this.len[k]!
        if (dv < dist[v]!) {
          dist[v] = dv
          prev[v] = u
          heap.push(v, dv)
        }
      }
    }
    return { dist, prev }
  }

  /** Single-source tree, cached by source. */
  from(src: number): { dist: Float64Array; prev: Int32Array } {
    let r = this.cache.get(src)
    if (!r) this.cache.set(src, (r = this.dijkstra([src])))
    return r
  }

  /** Node path a → b (inclusive), or null when unreachable. */
  path(a: number, b: number): number[] | null {
    if (a === b) return [a]
    const { dist, prev } = this.from(a)
    if (!Number.isFinite(dist[b]!)) return null
    const out: number[] = []
    for (let v = b; v !== -1; v = prev[v]!) out.push(v)
    return out.reverse()
  }

  dist(a: number, b: number): number {
    return a === b ? 0 : this.from(a).dist[b]!
  }

  clearCache(): void {
    this.cache.clear()
  }
}

class MinHeap {
  private readonly k: Int32Array
  private readonly v: Float64Array
  size = 0
  constructor(cap: number) {
    this.k = new Int32Array(Math.max(4, cap * 4))
    this.v = new Float64Array(Math.max(4, cap * 4))
  }
  push(key: number, val: number): void {
    let i = this.size++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.v[p]! <= val) break
      this.k[i] = this.k[p]!
      this.v[i] = this.v[p]!
      i = p
    }
    this.k[i] = key
    this.v[i] = val
  }
  pop(): number {
    const top = this.k[0]!
    const lk = this.k[--this.size]!
    const lv = this.v[this.size]!
    let i = 0
    for (;;) {
      let c = i * 2 + 1
      if (c >= this.size) break
      if (c + 1 < this.size && this.v[c + 1]! < this.v[c]!) c++
      if (this.v[c]! >= lv) break
      this.k[i] = this.k[c]!
      this.v[i] = this.v[c]!
      i = c
    }
    this.k[i] = lk
    this.v[i] = lv
    return top
  }
}

// ---- building ------------------------------------------------------------------------------------------------------

export interface TownScheduleOptions {
  /** Where no townsperson walks or stands (the character stage's palace steps, WAVE_PLAN7 D17). */
  noFolk?: TownCircle | readonly TownCircle[] | null
  /** The guards' alarm gate (a door place id); default 'gate-south', else the door nearest the graph's centre. */
  alarmGate?: string
}

/** A dwell or stop of a plan (before it is compiled per member). */
interface PlanStop {
  /** 'point': a node, door or place point; 'seat': one seat; 'ring': a chat ring (member m on seat m). */
  spot: 'point' | 'seat' | 'ring'
  x: number
  y: number
  z: number
  node: number
  yaw: number
  place: number
  seat: number
  clip: TownClip
  dur: number
}

interface PlanWalk {
  nodes: number[]
  clip: TownClip
}

/** A leader's plan: stop, walk, stop, …, stop (the first and last stops at the home door for roaming trips). */
interface Plan {
  stops: PlanStop[]
  walks: PlanWalk[]
}

interface Area {
  nodes: number[]
  rings: TownSchedulePlace[]
  seats: TownSchedulePlace[]
  looks: TownSchedulePlace[]
}

/** The booking key of a place's look spot (its point), beside its seats 0..n−1. */
const LOOK_SEAT = -1
/** The booking key of a bare graph node's spot (negative, apart from the places' indices). */
const nodeKey = (node: number): number => -2 - node
const SEAT_KINDS: readonly TownPlaceKind[] = ['teaTable', 'bench', 'fountainRim', 'pondEdge', 'templeSteps']
const LOOK_KINDS: readonly TownPlaceKind[] = ['stall', 'fountainRim', 'well', 'stable', 'pondEdge', 'smithAnvil', 'templeSteps']
const ROAM_ROLES: readonly TownRole[] = ['walker', 'chatter', 'sitter', 'porter', 'child']

/**
 * The alarm's start is floored to this (s): every client plans the alarm from the same second (H11-DET-1). The notice's
 * server stamp (`uniqueNotice.at`, when the server sends one) gives every client the same value already; the floor
 * covers the receipt-time fallback (two clients a few tens of ms apart agree unless they straddle a whole second).
 */
export const ALARM_QUANTUM_S = 1

/** The alarm start every client agrees on for a notice at server second `s`. */
export function alarmStart(s: number): number {
  return Math.floor(s / ALARM_QUANTUM_S) * ALARM_QUANTUM_S
}

/**
 * The compiled crowd of one town file. Build once per world load (a few ms for ~300 agents); `stateAt` and
 * `populationNear` are then pure functions of (server second, solar time, the alarm window).
 */
export class TownSchedule {
  readonly file: TownFile
  readonly places: readonly TownSchedulePlace[]
  /** Priority order: routes, fixed agents, then the roaming crowd in a seeded shuffle (any prefix is a fair sample). */
  readonly agents: readonly TownAgent[]
  /** Graph node positions (x, z) for the crowd's own needs (pigeon landings, debug). */
  readonly nodes: ReadonlyArray<{ id: string; x: number; z: number }>
  readonly edges: ReadonlyArray<[number, number]>
  readonly bands: readonly TownHourBand[]
  private readonly g: Graph
  private readonly doorNodes: number[]
  /** Nearest-door field: distance, next hop toward the nearest door, and that door's place index. */
  private readonly doorDist: Float64Array
  private readonly doorNext: Int32Array
  private readonly doorOf: Int32Array
  private readonly gate: number
  private readonly scratch = newTownAgentState()
  private readonly scratch2 = newTownAgentState()
  /** Seat bookings (global time mod V × P): `${place}#${seat}` → [start, end) pairs. */
  private readonly bookings = new Map<string, number[]>()
  // alarm
  private alarmA0 = NaN
  private alarmA1 = NaN
  private readonly plans: Array<AlarmPlan | null | undefined>
  private readonly allPlaces: { rings: TownSchedulePlace[]; seats: TownSchedulePlace[]; market: TownSchedulePlace[] }
  /** Presence cache per agent: the trip k and solar it was computed for, bits prev 1, on 2, next 4 (same answers). */
  private readonly pk: Float64Array
  private readonly pSolar: Array<TownSolar | null>
  private readonly pBits: Uint8Array

  constructor(file: TownFile, opts: TownScheduleOptions = {}) {
    this.file = file
    this.bands = [...file.schedule.bands].sort((a, b) => a.from - b.from)
    const circles = opts.noFolk ? ((Array.isArray(opts.noFolk) ? opts.noFolk : [opts.noFolk]) as TownCircle[]) : []
    const inCircle = (x: number, z: number) => circles.some((c) => Math.hypot(x - c.x, z - c.z) < c.r)
    const segInCircle = (ax: number, az: number, bx: number, bz: number) => circles.some((c) => segDist(c.x, c.z, ax, az, bx, bz) < c.r)
    // nodes and edges, minus the noFolk circles
    const keep = file.graph.nodes.filter((n) => !inCircle(n.x, n.z))
    const idx = new Map(keep.map((n, i) => [n.id, i]))
    const edges: Array<[number, number]> = []
    for (const e of file.graph.edges) {
      const a = idx.get(e.a)
      const b = idx.get(e.b)
      if (a === undefined || b === undefined) continue
      const na = keep[a]!
      const nb = keep[b]!
      if (segInCircle(na.x, na.z, nb.x, nb.z)) continue
      edges.push([a, b])
    }
    this.g = new Graph(keep, edges)
    this.nodes = keep.map((n) => ({ id: n.id, x: n.x, z: n.z }))
    this.edges = edges
    // places (dropped when their point, node or a seat lies in a noFolk circle)
    const places: TownSchedulePlace[] = []
    for (const p of file.places) {
      const node = this.g.index.get(p.node)
      if (node === undefined || inCircle(p.x, p.z)) continue
      const seats = (p.seats ?? []).map((s) => ({ x: s.x, y: s.y ?? NaN, z: s.z, yaw: s.yaw, pose: s.pose }))
      if (seats.some((s) => inCircle(s.x, s.z))) continue
      places.push({
        index: places.length, id: p.id, kind: p.kind, x: p.x, y: p.y ?? NaN, z: p.z, yaw: p.yaw, node, seats,
        sheltered: p.sheltered === true, goods: p.goods ?? null, district: p.district ?? null,
      })
    }
    this.places = places
    // doors and the nearest-door field
    const doors = places.filter((p) => p.kind === 'door')
    this.doorNodes = doors.map((d) => d.node)
    const field = this.g.dijkstra(this.doorNodes)
    this.doorDist = field.dist
    this.doorNext = field.prev
    this.doorOf = new Int32Array(this.g.n).fill(-1)
    for (const d of doors) if (this.doorOf[d.node] === -1) this.doorOf[d.node] = d.index
    for (let i = 0; i < this.g.n; i++) {
      let v = i
      let guard = 0
      while (v !== -1 && this.doorOf[v] === -1 && guard++ < this.g.n) v = this.doorNext[v]!
      if (v !== -1 && this.doorOf[i] === -1) this.doorOf[i] = this.doorOf[v]!
    }
    const gateId = opts.alarmGate ?? 'gate-south'
    this.gate = places.find((p) => p.id === gateId && p.kind === 'door')?.index ?? this.centralDoor(doors)
    this.allPlaces = {
      rings: places.filter((p) => p.kind === 'chatSpot'),
      seats: places.filter((p) => SEAT_KINDS.includes(p.kind) && p.seats.length > 0),
      market: places.filter((p) => p.kind === 'stall' || p.kind === 'stable'),
    }
    this.agents = this.buildAgents()
    this.pk = new Float64Array(this.agents.length).fill(NaN)
    this.pSolar = new Array(this.agents.length).fill(null)
    this.pBits = new Uint8Array(this.agents.length)
    this.plans = new Array(this.agents.length).fill(undefined)
    this.g.clearCache()
  }

  /** The graph's nearest door place (index into `places`) to a node, -1 when none is reachable. */
  doorFor(node: number): number {
    return node >= 0 && node < this.g.n ? this.doorOf[node]! : -1
  }

  /** Graph distance (m) between two node indices (Infinity when unconnected). */
  graphDistance(a: number, b: number): number {
    return this.g.dist(a, b)
  }

  /** The hour curve's share at solar hour `hour` (0..24). */
  shareAt(hour: number): number {
    return townShareAt(this.bands, hour)
  }

  // ---- the alarm ----

  /**
   * The unique's appear notice (D19): from server second `nowS`, for `sec` seconds, the alarm override. A second call
   * while one runs extends it; a call after one has ended starts a new one. The start is floored to ALARM_QUANTUM_S
   * (alarmStart) so two clients whose notice arrived a few ms apart plan the same escapes (H11-DET-1; the alarm's
   * choices at its start are discrete: who is out, the anchor node, the door, the rejoin trip).
   */
  alarm(nowS: number, sec: number): void {
    if (!Number.isFinite(nowS) || !(sec > 0)) return
    nowS = alarmStart(nowS)
    if (Number.isFinite(this.alarmA0) && nowS >= this.alarmA0 && nowS < this.alarmA1) {
      this.alarmA1 = Math.max(this.alarmA1, nowS + sec)
      // escape plans end at the alarm's end; recompute them with the new end
      this.plans.fill(undefined)
      return
    }
    this.alarmA0 = nowS
    this.alarmA1 = nowS + sec
    this.plans.fill(undefined)
  }

  /** The alarm window [from, to) in server seconds, or null. */
  alarmWindow(): { from: number; to: number } | null {
    return Number.isFinite(this.alarmA0) ? { from: this.alarmA0, to: this.alarmA1 } : null
  }

  clearAlarm(): void {
    this.alarmA0 = NaN
    this.alarmA1 = NaN
    this.plans.fill(undefined)
  }

  // ---- evaluation ----

  /**
   * Where agent `a` is at server second `nowS` under solar time `solar` (TOWN_LIFE §3.4): O(log legs), no allocation
   * (fills and returns `out`). The same on every client that agrees on the server time and the alarm's start.
   */
  stateAt(a: TownAgent | number, nowS: number, solar: TownSolar, out: TownAgentState = newTownAgentState()): TownAgentState {
    const agent = typeof a === 'number' ? this.agents[a]! : a
    if (agent.alarm !== 'none' && nowS >= this.alarmA0 && nowS < this.alarmA1 + 4 * TOWN_TRIP_S) {
      let plan = this.plans[agent.index]
      if (plan === undefined) plan = this.plans[agent.index] = this.planAlarm(agent, solar)
      if (plan && nowS < plan.end) return evalPlan(plan, agent, nowS, out)
    }
    return this.scheduleAt(agent, nowS, solar, out)
  }

  /**
   * People (not horses) visible within `r` m of (x, z), counting the first `limit` agents (the crowd's cap; default
   * all). On Low (no crowd) the town's sound bed uses it (TL-S); with the crowd's cap it matches the drawn count.
   */
  populationNear(x: number, z: number, r: number, nowS: number, solar: TownSolar, limit = this.agents.length): number {
    const st = this.scratch2
    const r2 = r * r
    let n = 0
    const m = Math.min(limit, this.agents.length)
    for (let i = 0; i < m; i++) {
      const a = this.agents[i]!
      if (a.kind === 'horse') continue
      this.stateAt(a, nowS, solar, st)
      if (!st.visible) continue
      const dx = st.x - x
      const dz = st.z - z
      if (dx * dx + dz * dz <= r2) n++
    }
    return n
  }

  /** The pure schedule (no alarm). */
  scheduleAt(agent: TownAgent, nowS: number, solar: TownSolar, out: TownAgentState): TownAgentState {
    const P = agent.period
    const g = nowS + agent.phase
    const k = Math.floor(g / P)
    const tau = g - k * P
    let bits: number
    const ai = agent.index
    if (agent.presence.kind === 'always') bits = 7
    else if (this.pk[ai] === k && this.pSolar[ai] === solar) bits = this.pBits[ai]!
    else {
      bits = (this.present(agent, k - 1, solar) ? 1 : 0) | (this.present(agent, k, solar) ? 2 : 0) | (this.present(agent, k + 1, solar) ? 4 : 0)
      this.pk[ai] = k
      this.pSolar[ai] = solar
      this.pBits[ai] = bits
    }
    if ((bits & 2) === 0) return hidden(agent, this.places, out)
    const fadeIn = (bits & 1) === 0
    const fadeOut = (bits & 4) === 0
    const trip = agent.mode === 'fixed' ? agent.trips[(fadeIn ? 1 : 0) + (fadeOut ? 2 : 0)]! : agent.mode === 'roam' ? agent.trips[mod(k, agent.trips.length)]! : agent.trips[0]!
    evalTrip(trip, tau, agent, out)
    let alpha = 1
    if (fadeIn && tau < TOWN_FADE_S) alpha = tau / TOWN_FADE_S
    if (fadeOut && P - tau < TOWN_FADE_S) alpha = Math.min(alpha, (P - tau) / TOWN_FADE_S)
    // a roaming trip starts and ends at its home door: the agent waits inside (between two trips, or at the door's turn
    // of a group), fading out through the door as it arrives and in as it leaves, so nobody idles in a doorway in a heap
    if (agent.mode === 'roam' && trip.n > 2) {
      const e0 = trip.t[1]!
      const s1 = trip.t[trip.n - 1]!
      if (tau < e0 && trip.kind[0] === LEG_DWELL) {
        const f = Math.min(TOWN_FADE_S, e0)
        alpha = Math.min(alpha, Math.max(0, (tau - (e0 - f)) / f))
      } else if (tau >= s1 && trip.kind[trip.n - 1] === LEG_DWELL) {
        const f = Math.min(TOWN_FADE_S, P - s1)
        alpha = Math.min(alpha, Math.max(0, (s1 + f - tau) / f))
      }
    }
    out.alpha = alpha
    out.visible = alpha > 0
    return out
  }

  /** Whether the agent takes trip k (decided by the solar time at the trip's start). */
  private present(agent: TownAgent, k: number, solar: TownSolar): boolean {
    const p = agent.presence
    if (p.kind === 'always') return true
    const h = solarHour(solar, k * agent.period - agent.phase)
    if (p.kind === 'hours') return inHours(h, p.from, p.to)
    return p.rank < townShareAt(this.bands, h)
  }

  // ---- compile ----

  private centralDoor(doors: readonly TownSchedulePlace[]): number {
    if (!doors.length) return -1
    let cx = 0
    let cz = 0
    for (let i = 0; i < this.g.n; i++) {
      cx += this.g.x[i]!
      cz += this.g.z[i]!
    }
    cx /= Math.max(1, this.g.n)
    cz /= Math.max(1, this.g.n)
    let best = doors[0]!
    for (const d of doors) if (Math.hypot(d.x - cx, d.z - cz) < Math.hypot(best.x - cx, best.z - cz)) best = d
    return best.index
  }

  private buildAgents(): TownAgent[] {
    const f = this.file
    const seed = f.seed >>> 0
    const routes: TownAgent[] = []
    const fixed: TownAgent[] = []
    const roam: TownAgent[] = []
    if (this.g.n === 0 || this.doorNodes.length === 0) return []
    // routes
    for (const r of f.folk.routes ?? []) {
      const nodes = r.nodes.map((id) => this.g.index.get(id) ?? -1)
      if (nodes.some((n) => n < 0) || nodes.length < 2) continue
      this.addRoute(routes, r.id, r.role, nodes, r.count, r.hours ?? null, r.pairs === true, seed)
    }
    // fixed
    ;(f.folk.fixed ?? []).forEach((fx, i) => {
      const place = this.places.find((p) => p.id === fx.place)
      if (!place) return
      const seat = fx.seat !== undefined && fx.seat < place.seats.length ? fx.seat : -1
      this.addFixed(fixed, i, fx.role, place, seat, fx.hours ?? null, fx.clip ?? null, seed)
    })
    // roaming
    this.addRoaming(roam, seed)
    const all = [...routes, ...fixed, ...roam]
    // one object shape for every agent (monomorphic property reads in stateAt)
    return all.map((a, i): TownAgent => ({
      index: i, id: a.id, role: a.role, kind: a.kind, female: a.female, scale: a.scale, look: a.look, group: a.group,
      member: a.member, speed: a.speed, home: a.home, period: a.period, phase: a.phase, place: a.place, seat: a.seat,
      rank: (i + 0.5) / all.length, goods: a.goods, presence: a.presence, trips: a.trips, mode: a.mode,
      alarm: a.alarm,
    }))
  }

  private agentBase(id: string, role: TownRole, kind: TownAgentKind, look: number, speed: number): Omit<TownAgent, 'index' | 'trips' | 'presence' | 'mode' | 'period' | 'phase' | 'home' | 'place' | 'seat'> {
    return {
      id, role, kind, female: (look & 1) === 1, scale: 1, look, group: -1, member: 0, speed, rank: 0, goods: null,
      alarm: role === 'guard' ? 'gate' : role === 'vendor' || role === 'worker' || role === 'rider' ? 'none' : 'door',
    }
  }

  private addRoute(out: TownAgent[], id: string, role: TownRole, nodes: number[], count: number, hours: [number, number] | null, pairs: boolean, seed: number): void {
    const kind: TownAgentKind = role === 'guard' ? 'guard' : role === 'rider' ? 'rider' : 'person'
    const rnd = rng(townHash(seed, strHash(id)))
    const speed = townNominalSpeed(kind, 'WALK') * (role === 'guard' ? 1 : 0.95 + rnd() * 0.1)
    // the loop's polyline (closed), with a stop at every guard post on it
    const posts = new Map<number, TownSchedulePlace>()
    for (const p of this.places) if (p.kind === 'guardPost') posts.set(p.node, p)
    const loop = [...nodes, nodes[0]!]
    const nodeStop = (n: number, dur: number, yaw: number): PlanStop => ({ spot: 'point', ...this.g.point(n), yaw, place: -1, seat: -1, clip: 'STAND1', dur })
    let door: TownSchedulePlace | null = null
    const plan: Plan = { stops: [], walks: [] }
    if (hours) {
      // a route with hours enters and leaves through the door nearest its start (TOWN_LIFE §3.4: appear only at doors)
      door = this.places[this.doorOf[nodes[0]!]!] ?? null
      if (!door) return
      const p = this.g.path(door.node, nodes[0]!)
      if (!p) return
      plan.stops.push(doorStop(door, 1 + TOWN_FADE_S))
      plan.walks.push({ nodes: p, clip: 'WALK' })
    }
    plan.stops.push(nodeStop(nodes[0]!, 0, 0))
    // the loop as walks between guard posts (a post on the loop is an 8 s stop facing the post's yaw)
    let cur = [loop[0]!]
    for (let i = 1; i < loop.length; i++) {
      const p = this.g.path(loop[i - 1]!, loop[i]!)
      if (!p) return
      cur.push(...p.slice(1))
      const post = posts.get(loop[i]!)
      if (post && i < loop.length - 1) {
        plan.walks.push({ nodes: cur, clip: 'WALK' })
        plan.stops.push(nodeStop(loop[i]!, 8, post.yaw))
        cur = [loop[i]!]
      }
    }
    plan.walks.push({ nodes: cur, clip: 'WALK' })
    plan.stops.push(nodeStop(loop[0]!, 0, 0))
    if (hours && door) {
      plan.walks.push({ nodes: this.g.path(nodes[0]!, door.node) ?? [nodes[0]!, door.node], clip: 'WALK' })
      plan.stops.push(doorStop(door, 1 + TOWN_FADE_S))
    }
    const period = this.planWalkTime(plan, speed) + plan.stops.reduce((a, st) => a + st.dur, 0)
    if (!(period > 1)) return
    const n = Math.max(1, Math.round(count))
    const members = pairs ? 2 : 1
    for (let j = 0; j < n; j++) {
      const phase = (j * period) / n + (townHash(seed, strHash(id) + j) % 1000) / 1000
      for (let m = 0; m < members; m++) {
        const look = townHash(seed, strHash(id) * 31 + j * 2 + m)
        // a pair walks side by side: each on its own parallel path (offset polylines, mitred at the corners)
        const side = members > 1 ? (m === 0 ? -TOWN_PAIR_SIDE_M : TOWN_PAIR_SIDE_M) : 0
        const trip = this.compile(plan, speed, kind, 0, 1, 0, period, false, 1, side, !hours)
        out.push({
          ...this.agentBase(`${id}.${j}${members > 1 ? '.' + m : ''}`, role, kind, look, speed),
          group: members > 1 ? 100000 + strHash(id) % 100000 + j : -1, member: m,
          index: 0, mode: 'route', period, phase, home: door?.index ?? -1, place: -1, seat: -1,
          presence: hours ? { kind: 'hours', from: hours[0], to: hours[1] } : { kind: 'always' }, trips: [trip],
        })
      }
    }
  }

  private addFixed(out: TownAgent[], i: number, role: TownRole, place: TownSchedulePlace, seat: number, hours: [number, number] | null, clipName: string | null, seed: number): void {
    const look = townHash(seed, 0x51ed + i)
    const rnd = rng(look)
    const door = this.places[this.doorOf[place.node]!]
    if (!door) return
    const s = seat >= 0 ? place.seats[seat]! : null
    const pose = s?.pose ?? 'stand'
    const byRole: TownClip = role === 'vendor' ? 'VENDOR01' : role === 'worker' ? 'HAMMER' : pose === 'chair' ? 'SIT_CHAIR' : pose === 'floor' ? 'SIT' : 'STAND1'
    const clip: TownClip = clipName && (TOWN_CLIPS as readonly string[]).includes(clipName) ? (clipName as TownClip) : byRole
    const at: PlanStop = s
      ? { spot: 'seat', x: s.x, y: s.y, z: s.z, node: place.node, yaw: s.yaw, place: place.index, seat, clip, dur: 0 }
      : { spot: 'point', x: place.x, y: place.y, z: place.z, node: place.node, yaw: place.yaw, place: place.index, seat: -1, clip, dur: 0 }
    if (seat >= 0) this.book(place.index, seat, 0, TOWN_TRIP_S * TOWN_TRIP_VARIANTS)
    const speed = 1.46 * (0.92 + rnd() * 0.12)
    const P = TOWN_TRIP_S
    const path = this.g.path(door.node, place.node) ?? [door.node, place.node]
    const wIn = polyLen(this.walkPoints(path, door, at)) / speed
    const wOut = polyLen(this.walkPoints([...path].reverse(), at, door)) / speed
    const doorDur = 1 + TOWN_FADE_S
    const mk = (arrive: boolean, leave: boolean): Trip => {
      const plan: Plan = { stops: [], walks: [] }
      let rest = P
      if (arrive) {
        plan.stops.push(doorStop(door, doorDur))
        plan.walks.push({ nodes: path, clip: 'WALK' })
        rest -= doorDur + wIn
      }
      if (leave) rest -= doorDur + wOut
      plan.stops.push({ ...at, dur: Math.max(5, rest) })
      if (leave) {
        plan.walks.push({ nodes: [...path].reverse(), clip: 'WALK' })
        plan.stops.push(doorStop(door, doorDur))
      }
      const total = plan.stops.reduce((a, st) => a + st.dur, 0) + (arrive ? wIn : 0) + (leave ? wOut : 0)
      // a far door and a short period: stretch the period's last stop instead of failing (rare)
      const fix = P - total
      plan.stops[plan.stops.length - 1]!.dur += fix
      if (plan.stops[plan.stops.length - 1]!.dur < 0.1) plan.stops[plan.stops.length - 1]!.dur = 0.1
      return this.compile(plan, speed, 'person', 0, 1, 0, P, true)
    }
    let trips: Trip[]
    try {
      trips = [mk(false, false), mk(true, false), mk(false, true), mk(true, true)]
    } catch {
      return
    }
    const rank = role === 'vendor' ? 0.62 + rnd() * 0.3 : role === 'worker' ? 0.18 + rnd() * 0.05 : role === 'sitter' ? 0.1 + rnd() * 0.1 : 0.3 + rnd() * 0.2
    out.push({
      ...this.agentBase(`fixed.${i}.${place.id}`, role, 'person', look, speed),
      index: 0, mode: 'fixed', period: P, phase: rnd() * P, home: door.index, place: place.index, seat, goods: role === 'vendor' ? place.goods : null,
      presence: hours ? { kind: 'hours', from: hours[0], to: hours[1] } : { kind: 'share', rank }, trips,
    })
  }

  private addRoaming(out: TownAgent[], seed: number): void {
    const folk = this.file.folk
    const shares = ROAM_ROLES.map((r) => Math.max(0, folk.roles[r] ?? 0))
    // vendors, guards, riders, workers in the roaming shares become walkers (they are fixed agents and routes)
    let extra = 0
    for (const [r, v] of Object.entries(folk.roles)) if (!ROAM_ROLES.includes(r as TownRole)) extra += Math.max(0, v ?? 0)
    shares[0]! += extra
    const sum = shares.reduce((a, b) => a + b, 0) || 1
    const total = Math.max(0, Math.round(folk.population))
    const counts = shares.map((s) => Math.round((s / sum) * total))
    const districts: readonly TownDistrict[] = folk.districts?.length ? folk.districts : [{ id: '*', x: 0, z: 0, radius: 1e9, weight: 1 }]
    const dw = districts.reduce((a, d) => a + d.weight, 0) || 1
    const de = districts.reduce((a, d) => a + (d.evening ?? d.weight), 0) || 1
    const rnd = rng(townHash(seed, 0x70e))
    // groups: chat rings of 3–4, couples among walkers, a horse behind half the porters
    interface Group { role: TownRole; size: number; horse: boolean }
    const groups: Group[] = []
    ROAM_ROLES.forEach((role, i) => {
      let left = counts[i]!
      while (left > 0) {
        let size = 1
        if (role === 'chatter') size = Math.min(left, rnd() < 0.5 ? 3 : 4)
        else if (role === 'walker' && left >= 2 && rnd() < 0.2) size = 2
        groups.push({ role, size, horse: role === 'porter' && rnd() < 0.5 })
        left -= size
      }
    })
    // seeded shuffle, then stratified presence ranks per group, weighted by the group's people (the hour curve's count
    // of people comes out exact); the order leans by role (TOWN_RANK_LEAN): the evening and the night keep sitters,
    // chatters and strollers, the children and the porters go home first (TOWN_LIFE §3.5)
    for (let i = groups.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[groups[i], groups[j]] = [groups[j]!, groups[i]!]
    }
    const key = groups.map((g) => (TOWN_RANK_LEAN[g.role] ?? 0) + rnd())
    const rankOrder = groups.map((_, i) => i).sort((a, b) => key[a]! - key[b]! || a - b)
    const people = groups.reduce((a, g) => a + g.size, 0) || 1
    const rankOf = new Float64Array(groups.length)
    let before = 0
    for (const g of rankOrder) {
      rankOf[g] = (before + groups[g]!.size / 2) / people
      before += groups[g]!.size
    }
    let gid = 0
    groups.forEach((grp, gi) => {
      const gseed = townHash(seed, 0x1000 + gi)
      const r = rng(gseed)
      // district (the evening and night crowd by the districts' evening weights)
      const evening = rankOf[gi]! < TOWN_EVENING_RANK
      let pick = r() * (evening ? de : dw)
      let d = districts[0]!
      for (const di of districts) {
        pick -= evening ? (di.evening ?? di.weight) : di.weight
        if (pick <= 0) {
          d = di
          break
        }
      }
      // children trot (a quick WALK): every agent stays ≤ 1.8 m/s, so clients 80 ms apart agree within 0.15 m
      const speed = (grp.role === 'child' ? 1.62 : 1.46) * (0.92 + r() * 0.16)
      const lags: number[] = []
      for (let m = 0; m < grp.size + (grp.horse ? 1 : 0); m++) lags.push(m === 0 ? 0 : grp.horse && m === grp.size ? TOWN_HORSE_GAP_M / speed : (m * TOWN_GROUP_GAP_M) / speed)
      const home = this.pickHome(grp.role, d, r)
      if (!home) return
      const phase = r() * TOWN_TRIP_S * TOWN_TRIP_VARIANTS
      const plans: Plan[] = []
      for (let v = 0; v < TOWN_TRIP_VARIANTS; v++) plans.push(this.planTrip(grp.role, grp.size, home, d, r, speed, lags[lags.length - 1]!, v, phase))
      const n = lags.length
      const group = n > 1 ? gid++ : -1
      for (let m = 0; m < n; m++) {
        const horse = grp.horse && m === n - 1
        const kind: TownAgentKind = horse ? 'horse' : 'person'
        const look = townHash(gseed, 0xabc + m)
        let trips: Trip[]
        try {
          trips = plans.map((p) => this.compile(p, speed, kind, m, n, lags[m]!, TOWN_TRIP_S, false, grp.role === 'child' ? 0.82 : 1))
        } catch {
          return
        }
        out.push({
          ...this.agentBase(`roam.${gi}.${m}`, horse ? 'porter' : grp.role, kind, look, speed),
          scale: grp.role === 'child' ? 0.82 : 1, group, member: m,
          index: 0, mode: 'roam', period: TOWN_TRIP_S, phase, home: home.index, place: -1, seat: -1,
          presence: { kind: 'share', rank: rankOf[gi]! }, trips,
        })
      }
    })
  }

  private pickHome(role: TownRole, d: { x: number; z: number; radius: number }, r: () => number): TownSchedulePlace | null {
    const doors = this.places.filter((p) => p.kind === 'door')
    if (!doors.length) return null
    if (role === 'porter') {
      const gates = doors.filter((p) => p.id.startsWith('gate-'))
      if (gates.length) return gates[Math.floor(r() * gates.length)]!
    }
    const near = doors
      .map((p) => ({ p, d: Math.hypot(p.x - d.x, p.z - d.z) }))
      .sort((a, b) => a.d - b.d)
    const inside = near.filter((e) => e.d <= d.radius)
    // a gate's square: its folk are travellers, in and out through the gate itself
    const gate = inside.filter((e) => e.p.id.startsWith('gate-'))
    const pool = (gate.length && inside.length < 3 ? gate : inside.length >= 3 ? inside : near.slice(0, 4)).slice(0, 12)
    return pool[Math.floor(r() * pool.length)]!.p
  }

  /** The leader's plan of one trip: home door → stops → home door, exactly TOWN_TRIP_S long. */
  private planTrip(role: TownRole, size: number, home: TownSchedulePlace, d: { x: number; z: number; radius: number }, r: () => number, speed: number, lagMax: number, v: number, phase: number): Plan {
    const P = TOWN_TRIP_S
    const doorDur = 1 + TOWN_FADE_S + lagMax
    const plan: Plan = { stops: [doorStop(home, doorDur)], walks: [] }
    let t = doorDur
    let cur = home.node
    let curStop: PlanStop | null = plan.stops[0]!
    const homeDist = (n: number) => this.g.dist(n, home.node)
    const reserve = doorDur + 2
    const area = this.nodesNear(d.x, d.z, role === 'child' ? Math.min(d.radius, 40) : d.radius)
    // every stop is booked on the common period (global time mod V × P), so two groups never stand inside each other:
    // seats, rings, a place's look spot (a stall's customers' spot, the stable's rail) and a bare node's spot
    const claim = (stop: PlanStop, a: number, b: number): boolean => {
      const t0 = v * P + a - phase
      const t1 = v * P + b - phase + lagMax + 1
      const keys: Array<[number, number]> = stop.spot === 'ring'
        ? this.places[stop.place]!.seats.map((_, i) => [stop.place, i])
        : stop.spot === 'seat' ? [[stop.place, stop.seat]] : stop.place >= 0 ? [[stop.place, LOOK_SEAT]] : [[nodeKey(stop.node), 0]]
      if (!keys.every(([pl, st]) => this.free(pl, st, t0, t1))) return false
      for (const [pl, st] of keys) this.book(pl, st, t0, t1)
      return true
    }
    let tries = 0
    let first = true
    let curEnd = t
    while (tries++ < 24) {
      const target = this.pickTarget(role, size, area, cur, r, first)
      if (!target) break
      const path = this.g.path(cur, target.node)
      if (!path) continue
      const wt = polyLen(this.walkPoints(path, curStop, target)) / speed
      const back = (homeDist(target.node) + 4) / speed
      let dur = target.dur
      const room = P - t - wt - back - reserve
      // too far for what is left of the trip: try a nearer one (the trip's slack is spent inside the home door)
      if (room < 2) continue
      dur = Math.min(dur, room)
      if (!claim(target, t + wt, t + wt + dur)) continue
      target.dur = dur
      const clip: TownClip = role === 'porter' && first ? 'CARRY' : 'WALK'
      plan.walks.push({ nodes: path, clip })
      plan.stops.push(target)
      t += wt + dur
      curEnd = t
      cur = target.node
      curStop = target
      first = false
    }
    // the trip's slack is spent out of doors, not in a long wait inside the home door: on the last stop when nobody
    // else books it (a bare node), else on one more bare-node stop that fits
    const homeWalk = (from: number, stop: PlanStop | null) => polyLen(this.walkPoints(this.g.path(from, home.node) ?? [from, home.node], stop, null, home)) / speed
    let slack = P - t - homeWalk(cur, curStop) - doorDur
    if (slack > 0 && curStop && curStop !== plan.stops[0] && curStop.spot === 'point' && curStop.place < 0 && claim(curStop, curEnd, curEnd + slack)) {
      curStop.dur += slack
      t += slack
      slack = 0
    }
    for (let k = 0; slack > TOWN_SLACK_S && k < 12; k++) {
      const n = area.nodes[Math.floor(r() * area.nodes.length)]!
      const p = this.g.path(cur, n)
      if (!p || n === cur) continue
      const stop = this.pickTarget('child', 1, { nodes: [n], rings: [], seats: [], looks: [] }, cur, r, false)!
      const wt = polyLen(this.walkPoints(p, curStop, stop)) / speed
      const room = P - t - wt - homeWalk(n, stop) - doorDur
      if (room < 2 || !claim(stop, t + wt, t + wt + room)) continue
      stop.dur = room
      plan.walks.push({ nodes: p, clip: 'WALK' })
      plan.stops.push(stop)
      t += wt + room
      cur = n
      curStop = stop
      slack = 0
    }
    const path = this.g.path(cur, home.node) ?? [cur, home.node]
    const wt = polyLen(this.walkPoints(path, curStop, null, home)) / speed
    plan.walks.push({ nodes: path, clip: 'WALK' })
    const last = doorStop(home, Math.max(doorDur, P - t - wt))
    plan.stops.push(last)
    // exact period: trim the longest stop when the home walk overran (the reserve covers it in practice)
    const total = plan.stops.reduce((a, s) => a + s.dur, 0) + this.planWalkTime(plan, speed)
    let over = total - P
    if (over > 1e-9) {
      for (const s of [...plan.stops].sort((a, b) => b.dur - a.dur)) {
        const cut = Math.min(over, Math.max(0, s.dur - 0.5))
        s.dur -= cut
        over -= cut
        if (over <= 1e-9) break
      }
    } else last.dur -= over
    return plan
  }

  private planWalkTime(plan: Plan, speed: number): number {
    let t = 0
    plan.walks.forEach((w, i) => (t += polyLen(this.walkPoints(w.nodes, plan.stops[i]!, plan.stops[i + 1]!)) / speed))
    return t
  }

  private readonly areas = new Map<string, Area>()

  /** The nodes within r of (x, z) (all nodes when fewer than 4), and the places by kind on them (cached). */
  private nodesNear(x: number, z: number, r: number): Area {
    const key = `${x},${z},${r}`
    let a = this.areas.get(key)
    if (a) return a
    let nodes: number[] = []
    for (let i = 0; i < this.g.n; i++) if (Math.hypot(this.g.x[i]! - x, this.g.z[i]! - z) <= r) nodes.push(i)
    if (nodes.length < 4) nodes = Array.from({ length: this.g.n }, (_, i) => i)
    const set = new Set(nodes)
    const local = this.places.filter((p) => set.has(p.node))
    a = {
      nodes,
      rings: local.filter((p) => p.kind === 'chatSpot'),
      seats: local.filter((p) => SEAT_KINDS.includes(p.kind) && p.seats.length > 0),
      // a look stands on the place's point: never one that is a seat's own spot (the anvil, where the apprentice works)
      looks: local.filter((p) => LOOK_KINDS.includes(p.kind) && !p.seats.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < TOWN_LOOK_CLEAR_M)),
    }
    this.areas.set(key, a)
    return a
  }

  private pickTarget(role: TownRole, size: number, area: Area, cur: number, r: () => number, first: boolean): PlanStop | null {
    const nodes = area.nodes
    const choose = <T>(list: readonly T[]): T | null => (list.length ? list[Math.floor(r() * list.length)]! : null)
    const stand = (): TownClip => (r() < 0.5 ? 'STAND1' : 'STAND3')
    const atPlace = (p: TownSchedulePlace, dur: number, clip: TownClip): PlanStop => ({
      spot: 'point', x: p.x, y: p.y, z: p.z, node: p.node, yaw: p.yaw, place: p.index, seat: -1, clip, dur,
    })
    // a stop on a bare node stands a little aside of it (nodes keep ≥ 1.2 m clear), so two never stand inside each other
    const atNode = (n: number, dur: number): PlanStop => {
      const p = this.g.point(n)
      const a = r() * TAU
      const d = TOWN_NODE_ASIDE_M * (0.7 + 0.3 * r())
      return { spot: 'point', x: p.x + Math.sin(a) * d, y: p.y, z: p.z + Math.cos(a) * d, node: n, yaw: r() * TAU, place: -1, seat: -1, clip: stand(), dur }
    }
    if (role === 'chatter' && size > 1 && (first || r() < 0.3)) {
      const rings = area.rings.filter((p) => p.seats.length >= size)
      const p = choose(rings.length ? rings : this.allPlaces.rings.filter((q) => q.seats.length >= size))
      if (p) return { spot: 'ring', x: p.x, y: p.y, z: p.z, node: p.node, yaw: p.yaw, place: p.index, seat: 0, clip: 'STAND1', dur: 60 + r() * 140 }
    }
    if (role === 'sitter' && size === 1 && (first || r() < 0.4)) {
      const p = choose(area.seats.length ? area.seats : this.allPlaces.seats)
      if (p) {
        const s = Math.floor(r() * p.seats.length)
        const seat = p.seats[s]!
        const clip: TownClip = seat.pose === 'chair' ? 'SIT_CHAIR' : seat.pose === 'floor' ? 'SIT' : stand()
        return { spot: 'seat', x: seat.x, y: seat.y, z: seat.z, node: p.node, yaw: seat.yaw, place: p.index, seat: s, clip, dur: 40 + r() * 110 }
      }
    }
    if (role === 'porter') {
      const p = first ? choose(this.allPlaces.market) : null
      if (p) return atPlace(p, 10 + r() * 10, 'STAND1')
    }
    if (role === 'child') return atNode(choose(nodes)!, 2 + r() * 3)
    if (r() < 0.35) {
      const p = choose(area.looks)
      if (p) return atPlace(p, 8 + r() * 22, stand())
    }
    let n = choose(nodes)!
    if (n === cur) n = choose(nodes)!
    return atNode(n, 3 + r() * 11)
  }

  private free(place: number, seat: number, t0: number, t1: number): boolean {
    const S = TOWN_TRIP_S * TOWN_TRIP_VARIANTS
    const list = this.bookings.get(`${place}#${seat}`)
    if (!list) return true
    const a0 = mod(t0, S)
    const len = t1 - t0
    for (let i = 0; i < list.length; i += 2) {
      const b0 = list[i]!
      const blen = list[i + 1]! - b0
      if (blen >= S || len >= S) return false
      // circular overlap of [a0, a0 + len) and [b0, b0 + blen)
      const d = mod(b0 - a0, S)
      if (d < len || mod(a0 - b0, S) < blen) return false
    }
    return true
  }

  private book(place: number, seat: number, t0: number, t1: number): void {
    const S = TOWN_TRIP_S * TOWN_TRIP_VARIANTS
    const key = `${place}#${seat}`
    let list = this.bookings.get(key)
    if (!list) this.bookings.set(key, (list = []))
    const a0 = t1 - t0 >= S ? 0 : mod(t0, S)
    list.push(a0, a0 + Math.min(S, t1 - t0))
  }

  /** Booked intervals of a seat on the common period (tests: seats are never double-booked). */
  seatBookings(place: number, seat: number): ReadonlyArray<[number, number]> {
    const list = this.bookings.get(`${place}#${seat}`) ?? []
    const out: Array<[number, number]> = []
    for (let i = 0; i < list.length; i += 2) out.push([list[i]!, list[i + 1]!])
    return out
  }

  /** A walk's points: [from spot, path nodes…, to spot] without repeats. */
  private walkPoints(path: readonly number[], from: PlanStop | TownSchedulePlace | null, to: PlanStop | TownSchedulePlace | null, toDoor?: TownSchedulePlace): SpotPoint[] {
    const pts: SpotPoint[] = []
    const push = (p: SpotPoint) => {
      const last = pts[pts.length - 1]
      if (last && Math.hypot(last.x - p.x, last.z - p.z) < 0.05) {
        if (p.node >= 0) last.node = p.node
        return
      }
      pts.push(p)
    }
    // a stall's vendor steps in and out through the customers' spot (the place point), between the goods set out in front
    const via = (s: PlanStop | TownSchedulePlace | null): TownSchedulePlace | null => {
      if (!s || !('spot' in s) || s.spot !== 'seat' || s.place < 0) return null
      const p = this.places[s.place]!
      return p.kind === 'stall' ? p : null
    }
    if (from) push({ x: from.x, y: from.y, z: from.z, node: -1 })
    const vf = via(from)
    if (vf) push({ x: vf.x, y: vf.y, z: vf.z, node: -1 })
    for (const n of path) push(this.g.point(n))
    const end = to ?? toDoor ?? null
    const vt = via(to)
    if (vt) push({ x: vt.x, y: vt.y, z: vt.z, node: -1 })
    if (end) push({ x: end.x, y: end.y, z: end.z, node: -1 })
    return pts
  }

  /**
   * Compiles a leader's plan for member `m` of `n` (lag `lag` s): its walks start `lag` later and end at its own spot
   * (a ring seat, or a queue place behind the leader along the arrival direction), so the trip still lasts `period`.
   */
  private compile(plan: Plan, speed: number, kind: TownAgentKind, m: number, n: number, lag: number, period: number, fixed: boolean, scale = 1, side = 0, loop = false): Trip {
    const legs: LegSpec[] = []
    const spots: SpotPoint[] = []
    const yaws: number[] = []
    // member spots per stop
    for (let i = 0; i < plan.stops.length; i++) {
      const st = plan.stops[i]!
      if (st.spot === 'ring') {
        const seats = this.places[st.place]!.seats
        const seat = seats[m % seats.length]!
        spots.push({ x: seat.x, y: seat.y, z: seat.z, node: -1 })
        yaws.push(seat.yaw)
        continue
      }
      if (m === 0 || fixed) {
        spots.push({ x: st.x, y: st.y, z: st.z, node: st.spot === 'point' && st.place < 0 ? st.node : -1 })
        yaws.push(st.yaw)
        continue
      }
      // queue: behind the leader along the arrival direction (or the departure for the first stop), a little aside
      const w = plan.walks[i - 1] ?? plan.walks[i]
      let dx = 0
      let dz = 1
      if (w) {
        const pts = this.walkPoints(w.nodes, plan.stops[i - 1] ?? st, plan.walks[i - 1] ? st : plan.stops[i + 1]!)
        const a = plan.walks[i - 1] ? pts[Math.max(0, pts.length - 2)]! : pts[0]!
        const b = plan.walks[i - 1] ? pts[pts.length - 1]! : pts[Math.min(1, pts.length - 1)]!
        const l = Math.hypot(b.x - a.x, b.z - a.z)
        if (l > 1e-6) {
          dx = (b.x - a.x) / l
          dz = (b.z - a.z) / l
        }
        if (!plan.walks[i - 1]) {
          dx = -dx
          dz = -dz
        }
      }
      const horse = kind === 'horse'
      const back = horse ? TOWN_HORSE_GAP_M : TOWN_GROUP_GAP_M * (m >= 3 ? 1.6 : 0.7)
      const side = horse ? 0 : m === 1 ? -0.5 : m === 2 ? 0.5 : 0
      const isDoor = st.place >= 0 && this.places[st.place]!.kind === 'door'
      // at a door the group lines up along the wall (sideways), never into the building
      const bx = isDoor ? 0 : -dx * back
      const bz = isDoor ? 0 : -dz * back
      const sx = dz * (isDoor ? (m % 2 ? -1 : 1) * Math.ceil(m / 2) * 0.6 : side)
      const sz = -dx * (isDoor ? (m % 2 ? -1 : 1) * Math.ceil(m / 2) * 0.6 : side)
      spots.push({ x: st.x + bx + sx, y: st.y, z: st.z + bz + sz, node: -1 })
      yaws.push(Math.atan2(dx, dz))
    }
    // legs: stop 0, walk 0, stop 1, …; member walks shifted by lag (first stop longer, last stop shorter)
    for (let i = 0; i < plan.stops.length; i++) {
      const st = plan.stops[i]!
      const spot = spots[i]!
      let dur = st.dur
      if (i === 0) dur += lag
      if (i === plan.stops.length - 1) dur -= lag
      const ring = st.spot === 'ring' ? Math.min(n, this.places[st.place]!.seats.length) : 0
      const anchor = st.node
      legs.push({
        kind: 'dwell', dur: Math.max(0, dur), clip: st.clip, rate: 1, speed: 0, pts: [spot], yaw: yaws[i]!, place: st.place,
        seat: st.spot === 'seat' ? st.seat : st.spot === 'ring' ? m % Math.max(1, this.places[st.place]!.seats.length) : -1,
        ring, ringT0: 0, anchor,
      })
      const w = plan.walks[i]
      if (!w) break
      const leaderPts = this.walkPoints(w.nodes, st, plan.stops[i + 1]!)
      const pts = leaderPts.map((p) => ({ ...p }))
      pts[0] = { ...spots[i]! }
      pts[pts.length - 1] = { ...spots[i + 1]! }
      const leaderTime = polyLen(leaderPts) / speed
      const len = polyLen(pts)
      const sp = leaderTime > 0 ? len / leaderTime : speed
      const nominal = townNominalSpeed(kind, w.clip) * scale
      legs.push({
        kind: 'walk', dur: leaderTime, clip: w.clip, rate: nominal > 0 ? sp / nominal : 1, speed: sp, pts, yaw: 0, place: -1,
        seat: -1, ring: 0, ringT0: 0, anchor: -1,
      })
    }
    // ring turns run on the leader's clock: the leader's dwell start (the member's start minus its lag)
    for (let i = 0, li = 0; i < legs.length; i++) {
      const l = legs[i]!
      if (l.kind !== 'dwell') continue
      let start = 0
      for (let j = 0; j < i; j++) start += legs[j]!.dur
      l.ringT0 = li === 0 ? start : start - lag
      li++
    }
    if (side !== 0) offsetLegs(legs, side, loop)
    // tiny drift from float sums: absorb into the last dwell
    const sum = legs.reduce((a, l) => a + l.dur, 0)
    legs[legs.length - 1]!.dur += period - sum
    if (legs[legs.length - 1]!.dur < 0) throw new Error('town schedule: a trip overruns its period')
    return new Trip(legs, period)
  }

  // ---- the alarm plans ----

  private planAlarm(agent: TownAgent, solar: TownSolar): AlarmPlan | null {
    const a0 = this.alarmA0
    const a1 = this.alarmA1
    const st = this.scheduleAt(agent, a0, solar, this.scratch)
    const toGate = agent.alarm === 'gate'
    const target = toGate ? this.places[this.gate] ?? null : null
    let pts: SpotPoint[]
    let arrive: number
    const vh = agent.speed * TOWN_HURRY
    if (!st.visible) {
      // already indoors (or between trips): stays in through the alarm
      pts = []
      arrive = a0
    } else {
      const anchor = this.anchorAt(agent, a0)
      const chain: number[] = []
      if (toGate && target) {
        const p = this.g.path(anchor, target.node)
        if (p) chain.push(...p)
      } else {
        for (let v = anchor, guard = 0; v !== -1 && guard < this.g.n; v = this.doorNext[v]!, guard++) chain.push(v)
      }
      const door = toGate ? target : this.places[this.doorOf[chain[chain.length - 1] ?? anchor] ?? -1] ?? null
      pts = [{ x: st.x, y: st.y, z: st.z, node: -1 }]
      for (const n of chain) pts.push(this.g.point(n))
      if (door) {
        const ring = toGate ? gateSpot(door, agent.index) : { x: door.x, z: door.z }
        pts.push({ x: ring.x, y: door.y, z: ring.z, node: -1 })
      }
      pts = dedupe(pts)
      arrive = a0 + polyLen(pts) / vh
    }
    const hide = !toGate
    // indoors for a moment at least: the fade-out at one door and the fade-in at another never meet
    const rejoinFrom = Math.max(a1, hide ? arrive + TOWN_FADE_S + 2 : arrive)
    const rejoin = this.planRejoin(agent, solar, rejoinFrom, toGate ? (target?.node ?? -1) : -1, pts.length ? pts[pts.length - 1]! : null)
    return makePlan(pts, a0, vh, arrive, hide, st.yaw, rejoin)
  }

  /** The graph node the agent steps to from its scheduled position at server second s (the alarm's escape). */
  private anchorAt(agent: TownAgent, s: number): number {
    const P = agent.period
    const g = s + agent.phase
    const k = Math.floor(g / P)
    const tau = g - k * P
    const trip = agent.mode === 'roam' ? agent.trips[mod(k, agent.trips.length)]! : agent.trips[0]!
    const i = legAt(trip, tau)
    if (trip.kind[i] === LEG_DWELL) return trip.anchor[i]! >= 0 ? trip.anchor[i]! : this.nearestNode(trip.pts[trip.p0[i]! * 5]!, trip.pts[trip.p0[i]! * 5 + 2]!)
    // walking: the next node on the polyline, else the previous one
    const d = (tau - trip.t[i]!) * trip.speed[i]!
    const p0 = trip.p0[i]!
    const pn = trip.pn[i]!
    let j = 0
    while (j < pn - 1 && trip.pts[(p0 + j + 1) * 5 + 3]! <= d) j++
    for (let q = j + 1; q < pn; q++) if (trip.ptNode[p0 + q]! >= 0) return trip.ptNode[p0 + q]!
    for (let q = j; q >= 0; q--) if (trip.ptNode[p0 + q]! >= 0) return trip.ptNode[p0 + q]!
    return this.nearestNode(trip.pts[(p0 + j) * 5]!, trip.pts[(p0 + j) * 5 + 2]!)
  }

  private nearestNode(x: number, z: number): number {
    let best = 0
    let bd = Infinity
    for (let i = 0; i < this.g.n; i++) {
      const d = (this.g.x[i]! - x) ** 2 + (this.g.z[i]! - z) ** 2
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return best
  }

  /**
   * After the alarm: the first node N the schedule passes (walking) at time t* ≥ `from` that the agent can reach in
   * time, walking out of the door nearest N (or from the gate for a guard). Before that it stays in (or at the gate);
   * a trip the schedule spends indoors ends the plan at its start (the schedule hides it anyway).
   */
  private planRejoin(agent: TownAgent, solar: TownSolar, from: number, gateNode: number, gatePt: SpotPoint | null): Rejoin | null {
    const P = agent.period
    const v = agent.speed
    let gateTree: { dist: Float64Array; prev: Int32Array } | null = null
    if (gateNode >= 0) gateTree = this.g.from(gateNode)
    // the way out: from the gate (guards) or the door nearest the node, along the graph to the node
    const pathFrom = (node: number): SpotPoint[] | null => {
      const chain: number[] = []
      if (gateTree && gatePt) {
        if (!Number.isFinite(gateTree.dist[node]!)) return null
        for (let u = node, guard = 0; u !== -1 && guard < this.g.n; u = gateTree.prev[u]!, guard++) chain.push(u)
        chain.reverse()
        return [gatePt, ...chain.map((c) => this.g.point(c))]
      }
      const door = this.places[this.doorOf[node]!]
      if (!door) return null
      for (let u = node, guard = 0; u !== -1 && guard < this.g.n; u = this.doorNext[u]!, guard++) chain.push(u)
      chain.reverse()
      return [{ x: door.x, y: door.y, z: door.z, node: -1 }, ...chain.map((c) => this.g.point(c))]
    }
    const g0 = from + agent.phase
    const k0 = Math.floor(g0 / P)
    for (let k = k0; k <= k0 + 2; k++) {
      const start = k * P - agent.phase
      if (!this.present(agent, k, solar)) return { at: Math.max(from, start), pts: [], depart: Math.max(from, start), speed: v }
      const trip = this.tripFor(agent, k, solar)
      for (let i = 0; i < trip.n; i++) {
        const p0 = trip.p0[i]!
        if (trip.kind[i] === LEG_DWELL) {
          // meet it at a dwell (a seat, a ring, a stop): walk out to the anchor node and step onto the spot
          const anchor = trip.anchor[i]!
          if (anchor < 0) continue
          const head = pathFrom(anchor)
          if (!head) continue
          const o = p0 * 5
          const pts = dedupe([...head, { x: trip.pts[o]!, y: trip.pts[o + 1]!, z: trip.pts[o + 2]!, node: -1 }])
          const len = polyLen(pts)
          const ts = start + trip.t[i]!
          const te = start + trip.t[i + 1]!
          for (const sp of [v, v * TOWN_HURRY]) {
            const tStar = Math.max(ts, from + TOWN_FADE_S + len / sp)
            if (tStar <= te - 0.5) return { at: tStar, pts, depart: tStar - len / sp, speed: sp }
          }
          continue
        }
        for (let q = 0; q < trip.pn[i]!; q++) {
          const node = trip.ptNode[p0 + q]!
          if (node < 0) continue
          const tStar = start + trip.t[i]! + trip.pts[(p0 + q) * 5 + 3]! / trip.speed[i]!
          if (tStar < from + TOWN_FADE_S) continue
          const head = pathFrom(node)
          if (!head) continue
          // end exactly where the schedule has it (a pair's offset path)
          const o = (p0 + q) * 5
          const pts = dedupe([...head, { x: trip.pts[o]!, y: trip.pts[o + 1]!, z: trip.pts[o + 2]!, node }])
          const len = polyLen(pts)
          for (const sp of [v, v * TOWN_HURRY]) {
            const depart = tStar - len / sp
            if (depart >= from) return { at: tStar, pts, depart, speed: sp }
          }
        }
      }
    }
    return null
  }

  private tripFor(agent: TownAgent, k: number, solar: TownSolar): Trip {
    if (agent.mode === 'roam') return agent.trips[mod(k, agent.trips.length)]!
    if (agent.mode === 'fixed') {
      const prev = this.present(agent, k - 1, solar)
      const next = this.present(agent, k + 1, solar)
      return agent.trips[(prev ? 0 : 1) + (next ? 0 : 2)]!
    }
    return agent.trips[0]!
  }
}

// ---- evaluation helpers --------------------------------------------------------------------------------------------

function doorStop(door: TownSchedulePlace, dur: number): PlanStop {
  return { spot: 'point', x: door.x, y: door.y, z: door.z, node: door.node, yaw: door.yaw, place: door.index, seat: -1, clip: 'STAND1', dur }
}

function gateSpot(door: TownSchedulePlace, i: number): { x: number; z: number } {
  const a = (townHash(i, 0x9a7e) / 4294967296) * TAU
  const r = 1.2 + (i % 3) * 0.7
  return { x: door.x + Math.sin(a) * r, z: door.z + Math.cos(a) * r }
}

function polyLen(pts: readonly SpotPoint[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z)
  return s
}

function dedupe(pts: SpotPoint[]): SpotPoint[] {
  const out: SpotPoint[] = []
  for (const p of pts) {
    const l = out[out.length - 1]
    if (l && Math.hypot(l.x - p.x, l.z - p.z) < 0.05) continue
    out.push(p)
  }
  return out
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax
  const ez = bz - az
  const l2 = ex * ex + ez * ez
  const u = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / l2)) : 0
  return Math.hypot(ax + ex * u - px, az + ez * u - pz)
}

function legAt(trip: Trip, tau: number): number {
  let lo = 0
  let hi = trip.n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (trip.t[mid]! <= tau) lo = mid
    else hi = mid - 1
  }
  return lo
}

function hidden(agent: TownAgent, places: readonly TownSchedulePlace[], out: TownAgentState): TownAgentState {
  const home = agent.home >= 0 ? places[agent.home] : null
  out.visible = false
  out.alpha = 0
  out.x = home ? home.x : 0
  out.y = home ? home.y : NaN
  out.z = home ? home.z : 0
  out.yaw = home ? home.yaw : 0
  out.clip = 'STAND1'
  out.clipTime = 0
  out.clipRate = 1
  out.moving = false
  out.speed = 0
  out.place = -1
  out.seat = -1
  out.talking = false
  return out
}

const CHAT_CLIPS: readonly TownClip[] = ['EMOTION01', 'EMOTION02', 'EMOTION04', 'EMOTION07']

function evalTrip(trip: Trip, tau: number, agent: TownAgent, out: TownAgentState): void {
  const i = legAt(trip, tau)
  const dt = tau - trip.t[i]!
  const p0 = trip.p0[i]!
  const pts = trip.pts
  out.talking = false
  if (trip.kind[i] === LEG_DWELL) {
    const o = p0 * 5
    out.x = pts[o]!
    out.y = pts[o + 1]!
    out.z = pts[o + 2]!
    out.yaw = dt < TOWN_TURN_S ? lerpAngle(trip.yawFrom[i]!, trip.yaw[i]!, dt / TOWN_TURN_S) : trip.yaw[i]!
    out.moving = false
    out.speed = 0
    out.place = trip.place[i]!
    out.seat = trip.seat[i]!
    out.clipRate = 1
    const ring = trip.ring[i]!
    if (ring > 1) {
      const rt = tau - trip.ringT0[i]!
      const turn = Math.floor(rt / TOWN_CHAT_TURN_S)
      const talker = mod(turn + (agent.group >= 0 ? agent.group : 0), ring)
      if (rt >= 0 && talker === agent.member % ring) {
        out.talking = true
        out.clip = CHAT_CLIPS[mod(turn + agent.member, CHAT_CLIPS.length)]!
        out.clipTime = rt - turn * TOWN_CHAT_TURN_S
      } else {
        out.clip = (agent.member & 1) === 0 ? 'STAND1' : 'STAND3'
        out.clipTime = dt
      }
    } else {
      out.clip = TOWN_CLIPS[trip.clip[i]!]!
      out.clipTime = dt
    }
    return
  }
  // walk
  const sp = trip.speed[i]!
  const d = dt * sp
  const pn = trip.pn[i]!
  let lo = 0
  let hi = pn - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pts[(p0 + mid) * 5 + 3]! <= d) lo = mid
    else hi = mid - 1
  }
  const j = Math.min(lo, Math.max(0, pn - 2))
  const o = (p0 + j) * 5
  if (pn < 2) {
    out.x = pts[o]!
    out.y = pts[o + 1]!
    out.z = pts[o + 2]!
    out.yaw = pts[o + 4]!
  } else {
    const sa = pts[o + 3]!
    const sb = pts[o + 8]!
    const segLen = sb - sa
    const f = segLen > 1e-9 ? Math.min(1, Math.max(0, (d - sa) / segLen)) : 1
    out.x = pts[o]! + (pts[o + 5]! - pts[o]!) * f
    out.y = pts[o + 1]! + (pts[o + 6]! - pts[o + 1]!) * f
    out.z = pts[o + 2]! + (pts[o + 7]! - pts[o + 2]!) * f
    let yaw = pts[o + 4]!
    const c = Math.min(TOWN_CORNER_M, segLen / 2)
    if (j > 0 && d - sa < c) yaw = lerpAngle(pts[o - 1]!, yaw, 0.5 + (0.5 * (d - sa)) / c)
    else if (j < pn - 2 && sb - d < c) yaw = lerpAngle(yaw, pts[o + 9]!, 0.5 - (0.5 * (sb - d)) / c)
    out.yaw = dt < TOWN_TURN_S ? lerpAngle(trip.yawFrom[i]!, yaw, dt / TOWN_TURN_S) : yaw
  }
  out.moving = true
  out.speed = sp
  out.place = -1
  out.seat = -1
  out.clip = TOWN_CLIPS[trip.clip[i]!]!
  out.clipRate = trip.rate[i]!
  out.clipTime = dt * trip.rate[i]!
}

/**
 * Offsets a compiled leg list sideways by `side` m (right of the walking direction; a guard pair's other half): every
 * walk point by the mitre of its two segments, every stop by the mitre of its arrival and departure, so the parallel
 * path stays continuous; walk durations are kept (the speed follows the new length). `loop`: the last stop is the
 * first (a patrol loop), so both take the same spot.
 */
function offsetLegs(legs: LegSpec[], side: number, loop: boolean): void {
  const walks = legs.filter((l) => l.kind === 'walk' && l.pts.length >= 2)
  const dir = (a: SpotPoint, b: SpotPoint): [number, number] | null => {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const l = Math.hypot(dx, dz)
    return l > 1e-6 ? [dx / l, dz / l] : null
  }
  const firstDir = (l: LegSpec): [number, number] | null => {
    for (let j = 1; j < l.pts.length; j++) {
      const d = dir(l.pts[j - 1]!, l.pts[j]!)
      if (d) return d
    }
    return null
  }
  const lastDir = (l: LegSpec): [number, number] | null => {
    for (let j = l.pts.length - 1; j > 0; j--) {
      const d = dir(l.pts[j - 1]!, l.pts[j]!)
      if (d) return d
    }
    return null
  }
  const mitre = (a: [number, number] | null, b: [number, number] | null): [number, number] => {
    const p = a ?? b
    const q = b ?? a
    if (!p || !q) return [0, 0]
    // right of forward (dx, dz) is (dz, -dx)
    let mx = p[1] + q[1]
    let mz = -p[0] - q[0]
    const ml = Math.hypot(mx, mz)
    if (ml < 1e-6) return [p[1] * side, -p[0] * side]
    mx /= ml
    mz /= ml
    const scale = 1 / Math.max(0.5, mx * p[1] - mz * p[0])
    return [mx * side * scale, mz * side * scale]
  }
  // stops
  const stopOff: Array<[number, number]> = []
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]!
    if (l.kind !== 'dwell') continue
    let prev: LegSpec | undefined
    let next: LegSpec | undefined
    for (let j = i - 1; j >= 0 && !prev; j--) if (legs[j]!.kind === 'walk') prev = legs[j]
    for (let j = i + 1; j < legs.length && !next; j++) if (legs[j]!.kind === 'walk') next = legs[j]
    if (loop && !prev) prev = walks[walks.length - 1]
    if (loop && !next) next = walks[0]
    const o = mitre(prev ? lastDir(prev) : null, next ? firstDir(next) : null)
    stopOff[i] = o
    l.pts = l.pts.map((pt) => ({ ...pt, x: pt.x + o[0], z: pt.z + o[1] }))
  }
  // walks: ends at the neighbouring stops' spots, interior points mitred
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]!
    if (l.kind !== 'walk' || l.pts.length < 2) continue
    const src = l.pts
    const out = src.map((pt, j) => {
      if (j === 0 && legs[i - 1]?.kind === 'dwell') return { ...legs[i - 1]!.pts[0]!, node: pt.node }
      if (j === src.length - 1 && legs[i + 1]?.kind === 'dwell') return { ...legs[i + 1]!.pts[0]!, node: pt.node }
      const o = mitre(j > 0 ? dir(src[j - 1]!, pt) : null, j < src.length - 1 ? dir(pt, src[j + 1]!) : null)
      return { ...pt, x: pt.x + o[0], z: pt.z + o[1] }
    })
    const len = polyLen(out)
    const sp = l.dur > 0 ? len / l.dur : l.speed
    l.rate = l.speed > 0 ? (l.rate * sp) / l.speed : l.rate
    l.speed = sp
    l.pts = out
  }
}

// ---- alarm plans ---------------------------------------------------------------------------------------------------

interface Rejoin {
  /** Server second the agent is back on its schedule. */
  at: number
  /** The walk out (door or gate → the node it meets the schedule at), departing at `depart`; empty: stays in until `at`. */
  pts: SpotPoint[]
  depart: number
  speed: number
}

interface AlarmPlan {
  /** Escape polyline (x, y, z, cumulative s), from a0 at speed `vh`; empty: indoors already. */
  esc: Float64Array
  escN: number
  a0: number
  vh: number
  arrive: number
  /** Hides at the door (walkers) or stands at the gate (guards). */
  hide: boolean
  yaw0: number
  rejoin: Rejoin | null
  ret: Float64Array
  retN: number
  /** Server second the plan ends (the schedule takes over). */
  end: number
}

function packPts(pts: readonly SpotPoint[]): Float64Array {
  const a = new Float64Array(pts.length * 4)
  let s = 0
  pts.forEach((p, i) => {
    if (i > 0) s += Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z)
    a[i * 4] = p.x
    a[i * 4 + 1] = p.y
    a[i * 4 + 2] = p.z
    a[i * 4 + 3] = s
  })
  return a
}

function makePlan(pts: SpotPoint[], a0: number, vh: number, arrive: number, hide: boolean, yaw0: number, rejoin: Rejoin | null): AlarmPlan {
  const ret = rejoin ? packPts(rejoin.pts) : new Float64Array(0)
  return {
    esc: packPts(pts), escN: pts.length, a0, vh, arrive, hide, yaw0, rejoin, ret, retN: rejoin?.pts.length ?? 0,
    // without a rejoin the agent stays in (or at the gate) until the alarm is long over, then the schedule takes over
    end: rejoin ? rejoin.at : Math.max(arrive, a0) + 2 * TOWN_TRIP_S,
  }
}

function polyAt(a: Float64Array, n: number, d: number, out: TownAgentState): void {
  if (n === 0) return
  if (n === 1 || d <= 0) {
    out.x = a[0]!
    out.y = a[1]!
    out.z = a[2]!
    if (n > 1) out.yaw = Math.atan2(a[4]! - a[0]!, a[6]! - a[2]!)
    return
  }
  let j = 0
  while (j < n - 2 && a[(j + 1) * 4 + 3]! <= d) j++
  const o = j * 4
  const segLen = a[o + 7]! - a[o + 3]!
  const f = segLen > 1e-9 ? Math.min(1, Math.max(0, (d - a[o + 3]!) / segLen)) : 1
  out.x = a[o]! + (a[o + 4]! - a[o]!) * f
  out.y = a[o + 1]! + (a[o + 5]! - a[o + 1]!) * f
  out.z = a[o + 2]! + (a[o + 6]! - a[o + 2]!) * f
  if (segLen > 1e-9) out.yaw = Math.atan2(a[o + 4]! - a[o]!, a[o + 6]! - a[o + 2]!)
}

function evalPlan(p: AlarmPlan, agent: TownAgent, nowS: number, out: TownAgentState): TownAgentState {
  out.place = -1
  out.seat = -1
  out.talking = false
  const rj = p.rejoin
  // the walk out of the door (or back from the gate) to meet the schedule
  if (rj && rj.pts.length && nowS >= rj.depart) {
    const dt = nowS - rj.depart
    out.yaw = p.yaw0
    polyAt(p.ret, p.retN, dt * rj.speed, out)
    out.moving = true
    out.speed = rj.speed
    out.clip = 'WALK'
    out.clipRate = rj.speed / townNominalSpeed(agent.kind, 'WALK') / agent.scale
    out.clipTime = dt * out.clipRate
    out.alpha = p.hide ? Math.min(1, dt / TOWN_FADE_S) : 1
    out.visible = out.alpha > 0
    return out
  }
  if (p.escN === 0) {
    out.visible = false
    out.alpha = 0
    out.moving = false
    out.speed = 0
    return out
  }
  if (nowS < p.arrive) {
    const dt = nowS - p.a0
    out.yaw = p.yaw0
    polyAt(p.esc, p.escN, dt * p.vh, out)
    out.moving = true
    out.speed = p.vh
    out.clip = 'WALK'
    out.clipRate = p.vh / townNominalSpeed(agent.kind, 'WALK') / agent.scale
    out.clipTime = dt * out.clipRate
    out.alpha = 1
    out.visible = true
    return out
  }
  // arrived: guards stand at the gate; the others go in
  polyAt(p.esc, p.escN, Infinity, out)
  out.moving = false
  out.speed = 0
  out.clip = 'STAND1'
  out.clipRate = 1
  out.clipTime = nowS - p.arrive
  out.alpha = p.hide ? Math.max(0, 1 - (nowS - p.arrive) / TOWN_FADE_S) : 1
  out.visible = out.alpha > 0
  return out
}
