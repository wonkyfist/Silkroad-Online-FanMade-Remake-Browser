/**
 * The town part (docs/TOWN_LIFE.md §2.3, §3, §4, §8; docs/WAVE_PLAN7.md §6.1 TL-C). World calls `createTownPart` on
 * the PBR path only (World.town stays null on the Classic path: the Low guard).
 *
 * `TownLife` ties the pieces together once per frame, after the life part:
 * - the **folk crowd** (crowd.ts: VAT + thin instances, one draw per variant) on the town's schedule, and the **animal
 *   crowd** (animals.ts) on theirs, both capped per preset and per player count (`folkCap`, `animalCap`);
 * - the **pigeons** (and the pond's ducks on High+) as life species with a route-aware landing (animals.ts);
 * - the **blob shadows** and the **carried lanterns** (props.ts), one draw each;
 * - the **bubbles** (bubbles.ts): `bubbles(out)`, `pickFolk(ray)`, `say(agent)` and `setPlayers(n)` are read by the
 *   app's town feature (apps/game world/features/town.ts) through `World.town`, duck-typed (`TownBubbleSource`);
 * - the **time base** (F5): the VAT managers' time is `nowS − t0`, re-based before the hour is up;
 * - the **TAA answer** (G5-11, D4): the part asks the post stack for MSAA ×4 in place of TAA while the player is in
 *   town (with a hysteresis, so the stack is not rebuilt at every step); the post swaps only when it runs TAA, so this
 *   follows the AA actually in use (High, Ultra, or Medium with the Advanced row on TAA), not the preset name;
 * - the **warm-up** (D25): a warm-up hook compiles every crowd effect at world load (no compile when the first
 *   townsperson walks into range).
 *
 * What it reads from the world: the quality (TOWN_PRESETS), the sky's solar time (who is out), the weather's rain,
 * the nav (ground heights of poses without one), the life part (birds), the post stack (the TAA swap) and the
 * character material decoration (the crowd looks like the characters).
 *
 * **Sources (until X1 and TL-R):** the folk schedule is `plazaStandIn` (a deterministic stand-in on Jangan's plaza: loop
 * walkers with dwells, chat rings, vendors, fountain sitters, guard pairs, running children; pure in the server clock)
 * until TL-R's `town/schedule.ts` lands behind a `CrowdSchedule` adapter (`TownSources.plan`); the drawables are TL-V's
 * export when `town/index.json` loads, else the procedural stand-ins (`stubCrowdAssets`).
 */
import { Vector3, type AbstractMesh, type Camera, type Material, type Scene } from '@babylonjs/core'
import type { TownFile } from '../../../shared/src/town.ts'
import { clockDays, solarTime } from '../../../shared/src/world-clock.ts'
import { nightLightsOf } from '../night-lights.ts'
import { addWarmupHook } from '../warmup-hooks.ts'
import type { World } from '../world.ts'
import { AnimalSchedule, nearRoute, plazaHabitat, pondHabitat, registerTownBirds, type AnimalPlan, type PlazaArea, type TownRoutes } from './animals.ts'
import { BUBBLE_S, CALL_RANGE_M, CLICK_RANGE_M, callText, clickText, nearestBubbles, townLines, vendorCallAt, type TownBubble, type TownLinesLite } from './bubbles.ts'
import {
  REBASE_MAX_S,
  REBASE_MIN_S,
  THREATS_MAX,
  TOWN_PRESETS,
  TownCrowd,
  animalCap,
  folkCap,
  hash01,
  loadCrowdAssets,
  newDrawn,
  stubCrowdAssets,
  type CrowdAgent,
  type CrowdAssets,
  type CrowdCircle,
  type CrowdPose,
  type CrowdQuery,
  type CrowdSchedule,
  type TownPreset,
  type TownPresetName,
} from './crowd.ts'
import { attachTownDressing, type TownDressingLayer } from './decals.ts'
import { createTownFx, type TownFx, type TownFxHost } from './fx.ts'
import { TownBlobs, TownLanterns } from './props.ts'
import { TownSchedule, alarmStart, newTownAgentState, townNominalSpeed, type TownSolar } from './schedule.ts'
import type { TownCircle, TownClock, TownConfig, TownHost, TownPart, TownThreats } from './types.ts'
import { CrowdLatch } from '../crowd-latch.ts'

export { TOWN_TAG, isTownMesh, townCountScale } from './types.ts'
export type { TownCircle, TownClock, TownConfig, TownFactory, TownHost, TownLifeLevel, TownPart, TownThreats } from './types.ts'

// ---- the plan: what a town is made of ------------------------------------------------------------------------------

/** One town as the part runs it: the folk schedule and everything placed around it. */
export interface TownPlan {
  folk: CrowdSchedule
  /** Route segments and dwell spots (the pigeons keep clear of them). */
  routes: TownRoutes
  /** The pigeons' paving (null: no pigeons). */
  plaza: PlazaArea | null
  /** The VAT animals (null: none). */
  animals: AnimalPlan | null
  /** The ducks' pond (centre, radius; High+). */
  pond: { x: number; z: number; r: number } | null
  /** Vendor calls and flavour lines. */
  lines: TownLinesLite
  /** Where the town is (the TAA swap's area). */
  area: { x: number; z: number; r: number }
  /** The same town routed round `noFolk` circles (TL-R's schedule takes them at build); absent: the crowd skips them. */
  replan?(noFolk: readonly CrowdCircle[]): TownPlan
  /** The circles this plan was routed round (absent: none); the part replans only when its own differ (H11-HI-2). */
  noFolk?: readonly CrowdCircle[]
}

/** Where the part's pieces come from (tests and the viewer pass their own; the defaults otherwise). */
export interface TownSources {
  /**
   * The town of a world (default `defaultPlan`: TL-R's schedule on the export's town.json, else the plaza stand-in on
   * Jangan); null: no townsfolk here. `noFolk` is the part's live list (changed in place by `configure`): a source that
   * builds later (when its file arrives) reads the circles of that moment and sets `TownPlan.noFolk` (H11-HI-2).
   */
  plan?: (world: World, noFolk: readonly CrowdCircle[]) => TownPlan | null | Promise<TownPlan | null>
  /** The drawables (default: TL-V's export, else `stubCrowdAssets`). */
  assets?: (scene: Scene, decorate: (m: Material) => void) => CrowdAssets | Promise<CrowdAssets>
}

/** What the app's town feature reads from World.town (duck-typed: the TownPart seam is W11-S's). */
export interface TownBubbleSource {
  /** Fills `out` with the bubbles to show now (the clicked answer first, then vendor calls, nearest first); returns how many. */
  bubbles(out: TownBubble[]): number
  /** The townsperson a view ray hits within CLICK_RANGE_M of the player, or −1. */
  pickFolk(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number
  /** A clicked townsperson answers (a flavour line, BUBBLE_S, local). False: not drawn. */
  say(agent: number): boolean
  /** Player characters within the crowd's range (the cap gives way to them). */
  setPlayers(n: number): void
  /** The crowd's range (m). */
  readonly range: number
  /** Townsfolk drawn within r of (x, z) (the town bed's count). */
  folkNear(x: number, z: number, r: number): number
}

// ---- the Jangan plaza stand-in (until TL-R's schedule) ----------------------------------------------------------

/** Jangan's plaza (glTF metres; the prototype's survey, TOWN_LIFE §11.1). */
export const PLAZA = { x: 99, z: -82, fountainR: 13, box: { x0: 58, x1: 142, z0: -150, z1: -30 } } as const
/** The plaza's exits (the stand-in's doors: walkers leave and come back through them; the alarm sends them there). */
export const PLAZA_DOORS: ReadonlyArray<readonly [number, number]> = [[99, -32], [99, -148], [60, -90], [140, -90]]
/** Where the guard pairs gather in the alarm (inside the south gate). */
export const SOUTH_GATE: readonly [number, number] = [99, -26]
/** The retail WALK's own speed (1.7 m per 1.166 s loop, TOWN_LIFE §3.4). */
export const WALK_SPEED = 1.457
/** The alarm's hurry (TOWN_LIFE Q5, D19). */
export const ALARM_HURRY = 1.3

/** A closed polyline walked by the stand-in's walkers. */
class Loop {
  readonly pts: Float64Array
  readonly cum: Float64Array
  readonly len: number

  constructor(points: ReadonlyArray<readonly [number, number]>) {
    this.pts = Float64Array.from(points.flat())
    const n = points.length
    this.cum = new Float64Array(n + 1)
    for (let k = 0; k < n; k++) {
      const a = points[k]!
      const b = points[(k + 1) % n]!
      this.cum[k + 1] = this.cum[k]! + Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    this.len = this.cum[n]!
  }

  /** The arc length `at` reads (a field: no boxed argument per call). */
  s = 0.5

  /** The point at arc length `this.s` (wrapped) into out.x, out.z. */
  at(out: { x: number; z: number }): void {
    const n = this.pts.length / 2
    let u = this.s % this.len
    if (u < 0) u += this.len
    let lo = 0
    let hi = n
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid]! <= u) lo = mid
      else hi = mid
    }
    const seg = this.cum[lo + 1]! - this.cum[lo]!
    const f = seg > 0 ? (u - this.cum[lo]!) / seg : 0
    const b = (lo + 1) % n
    out.x = this.pts[lo * 2]! + (this.pts[b * 2]! - this.pts[lo * 2]!) * f
    out.z = this.pts[lo * 2 + 1]! + (this.pts[b * 2 + 1]! - this.pts[lo * 2 + 1]!) * f
  }

  /** The segments as (x0, z0, x1, z1) quads. */
  segments(): number[] {
    const n = this.pts.length / 2
    const out: number[] = []
    for (let k = 0; k < n; k++) {
      const b = (k + 1) % n
      out.push(this.pts[k * 2]!, this.pts[k * 2 + 1]!, this.pts[b * 2]!, this.pts[b * 2 + 1]!)
    }
    return out
  }
}

const circle = (x: number, z: number, r: number, n = 32): Array<[number, number]> =>
  Array.from({ length: n }, (_, k) => [x + Math.cos((k / n) * Math.PI * 2) * r, z + Math.sin((k / n) * Math.PI * 2) * r] as [number, number])

const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]

/** The hour bands of TOWN_LIFE §3.5: from (solar hour) and share; the last band wraps past midnight. */
const SHARE_FROM = [5, 7, 18, 20, 23] as const
const SHARE_VAL = [0.25, 1, 0.6, 0.25, 0.08] as const

function shareAtHour(h: number): number {
  let v: number = SHARE_VAL[4]
  for (let k = 0; k < SHARE_FROM.length; k++) if (h >= SHARE_FROM[k]!) v = SHARE_VAL[k]!
  return v
}

/** Share of the town out by solar hour (TOWN_LIFE §3.5), with half-hour ramps at the band edges. No allocation. */
export function dayShare(solarT: number): number {
  const h = ((solarT % 1) + 1) % 1 * 24
  for (let k = 0; k < SHARE_FROM.length; k++) {
    const d = h - SHARE_FROM[k]!
    if (d > -0.25 && d < 0.25) {
      const before = shareAtHour(SHARE_FROM[k]! - 0.3)
      return before + (SHARE_VAL[k]! - before) * ((d + 0.25) / 0.5)
    }
  }
  return shareAtHour(h)
}

type StandInKind = 'walker' | 'chat' | 'vendor' | 'sitter' | 'guard' | 'child'

interface StandInAgent {
  kind: StandInKind
  loop: number
  dir: number
  s0: number
  speed: number
  /** Walk legs and dwell times alternating: walk metres, dwell seconds (walkers). */
  legs: Float64Array
  period: number
  phase: number
  /** A fixed spot (chat member, vendor, sitter). */
  x: number
  z: number
  yaw: number
  /** Chat ring: its size and the member's index. */
  ring: number
  member: number
}

const TALK_CLIPS = ['EMOTION01', 'EMOTION02', 'EMOTION04', 'EMOTION07'] as const

/**
 * The stand-in schedule on Jangan's plaza (pure in the server clock; until TL-R's `town/schedule.ts`). Loops: two
 * rings round the fountain and the avenue's south and north blocks; doors at the plaza's four exits.
 */
export class PlazaStandIn implements CrowdSchedule {
  readonly agents: CrowdAgent[] = []
  readonly loops: Loop[]
  readonly routes: TownRoutes
  private readonly plans: StandInAgent[] = []
  private readonly tmp = { x: 0.5, z: 0.5 }
  private readonly tmp2 = { x: 0.5, z: 0.5 }
  /** The evaluation's server second, solar time and arc length (fields, not arguments: no boxing per call). */
  private atS = 0.5
  private atSolar = 0.5
  private arc = 0.5
  private readonly base: CrowdPose = { x: 0, y: Number.NaN, z: 0, yaw: 0, clip: 'STAND1', clipT: 0, rate: 1, distM: Number.NaN, speed: 0, alpha: 1 }

  constructor(seed = 0x7a17, population = 150) {
    const P = PLAZA
    this.loops = [
      new Loop(circle(P.x, P.z, 17)),
      new Loop(circle(P.x, P.z, 24, 40)),
      new Loop(rect(89, -148, 111, -104)),
      new Loop(rect(89, -60, 111, -36)),
      new Loop(circle(P.x, P.z, 14.6, 28)),
    ]
    let id = 1
    const r01 = (k: number) => hash01(seed + id * 977, k)
    const agent = (role: CrowdAgent['role'], female: boolean, extra: Partial<CrowdAgent> = {}): CrowdAgent => {
      const a: CrowdAgent = { id, role, female, rank: role === 'guard' ? 0.001 * id : hash01(seed ^ id, 1), ...extra }
      this.agents.push(a)
      id++
      return a
    }
    const plan = (p: Partial<StandInAgent> & { kind: StandInKind }): void => {
      this.plans.push({ loop: 0, dir: 1, s0: 0, speed: 0, legs: new Float64Array(0), period: 1, phase: 0, x: 0, z: 0, yaw: 0, ring: 0, member: 0, ...p })
    }
    // Guards: two pairs, one on each avenue block, 1.6 m apart on the loop.
    for (let pair = 0; pair < 2; pair++) {
      for (let m = 0; m < 2; m++) {
        const loop = 2 + pair
        const L = this.loops[loop]!.len
        plan({ kind: 'guard', loop, dir: pair ? -1 : 1, s0: m * 1.6 + pair * L * 0.5, speed: 1.2, phase: 0 })
        agent('guard', false)
      }
    }
    // Vendors: round the octagon's paving (its apothem ≈ 38 m), 34 m out on the diagonals, facing the fountain (the
    // survey's top view: the corners beyond the octagon are planted beds).
    const goods = ['fruit', 'silk', 'buns', 'tea', 'iron', 'herbs']
    const vendorDeg = [30, 60, 120, 150, 210, 240]
    for (let k = 0; k < goods.length; k++) {
      const a = (vendorDeg[k]! * Math.PI) / 180
      const x = P.x + Math.cos(a) * 34
      const z = P.z + Math.sin(a) * 34
      plan({ kind: 'vendor', x, z, yaw: Math.atan2(P.x - x, P.z - z), phase: r01(2) * 100 })
      agent('vendor', k % 2 === 1, { goods: goods[k] })
    }
    // Sitters on the fountain rim, facing out.
    for (let k = 0; k < 6; k++) {
      const a = -0.6 + k * 0.42 + (k > 2 ? Math.PI : 0)
      plan({ kind: 'sitter', x: P.x + Math.sin(a) * 11.6, z: P.z + Math.cos(a) * 11.6, yaw: a, phase: r01(3) * 10 })
      agent('sitter', k % 2 === 0)
    }
    // Chat rings of 3–4, between the outer ring (24 m) and the vendors (34 m).
    const chatDeg = [15, 75, 105, 165, 195, 285, 345]
    for (const deg of chatDeg) {
      const cx = P.x + Math.cos((deg * Math.PI) / 180) * 29.5
      const cz = P.z + Math.sin((deg * Math.PI) / 180) * 29.5
      const ring = 3 + (r01(4) < 0.5 ? 1 : 0)
      const rot = r01(5) * 6.283
      const ph = r01(6) * 100
      for (let m = 0; m < ring; m++) {
        const ang = rot + (m / ring) * Math.PI * 2
        const x = cx + Math.cos(ang) * 0.85
        const z = cz + Math.sin(ang) * 0.85
        plan({ kind: 'chat', x, z, yaw: Math.atan2(cx - x, cz - z), ring, member: m, phase: ph })
        agent('chatter', r01(7) < 0.5)
      }
    }
    // Children running round the fountain.
    for (let k = 0; k < 2; k++) {
      plan({ kind: 'child', loop: 4, dir: 1, s0: k * 3, speed: 2.6 })
      agent('child', true, { scale: 0.82 })
    }
    // Walkers: the rest, on the loops, with three dwells a lap.
    const loops = [0, 1, 2, 3]
    const weights = loops.map(l => this.loops[l]!.len)
    const total = weights.reduce((a, b) => a + b, 0)
    while (this.agents.length < population) {
      let u = r01(8) * total
      let loop = 0
      while (loop < loops.length - 1 && u > weights[loop]!) u -= weights[loop++]!
      const L = this.loops[loop]!.len
      const speed = WALK_SPEED * (0.9 + r01(9) * 0.2)
      const cuts = [r01(10), r01(11), r01(12)].sort((a, b) => a - b)
      const legs = new Float64Array(6)
      let prev = 0
      let period = 0
      for (let k = 0; k < 3; k++) {
        const end = k === 2 ? 1 : cuts[k + 1]!
        legs[k * 2] = (end - prev) * L
        legs[k * 2 + 1] = 2 + r01(13 + k) * 8
        period += legs[k * 2]! / speed + legs[k * 2 + 1]!
        prev = end
      }
      plan({ kind: 'walker', loop, dir: r01(16) < 0.5 ? 1 : -1, s0: r01(17) * L, speed, legs, period, phase: r01(18) * period })
      agent('walker', r01(19) < 0.45)
    }
    const segs: number[] = []
    for (const l of this.loops) segs.push(...l.segments())
    const spotsXZ: number[] = []
    for (const p of this.plans) if (p.kind === 'vendor' || p.kind === 'chat' || p.kind === 'sitter') spotsXZ.push(p.x, p.z)
    this.routes = { segments: Float32Array.from(segs), spots: Float32Array.from(spotsXZ) }
  }

  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const p = this.plans[i]
    const a = this.agents[i]
    if (!p || !a) return false
    const inAlarm = q.alarmUntilS > q.nowS && q.nowS >= q.alarmFromS && p.kind !== 'vendor'
    if (inAlarm) return this.alarmPose(i, p, a, q, out)
    // the time goes through fields, not arguments (a double argument of a call that is not inlined is boxed)
    this.atS = q.nowS
    this.atSolar = q.solarT
    if (!this.basePose(p, a, out)) return false
    // back from the alarm: fade in at the schedule's place
    const since = q.nowS - q.alarmUntilS
    if (q.alarmUntilS > 0 && since >= 0 && since < 0.6 && p.kind !== 'vendor') out.alpha *= since / 0.6
    return out.alpha > 0
  }

  /** The schedule without the alarm, at server second `atS` and solar time `atSolar`. */
  private basePose(p: StandInAgent, a: CrowdAgent, out: CrowdPose): boolean {
    const nowS = this.atS
    const solarT = this.atSolar
    out.y = Number.NaN
    out.rate = 1
    out.alpha = 1
    out.distM = Number.NaN
    out.speed = 0
    // Who is out: guards always; vendors by day; the rest by the hour's share and their rank.
    if (p.kind === 'vendor') {
      const h = ((solarT % 1) + 1) % 1 * 24
      out.alpha = Math.max(0, Math.min(1, Math.min(h - 6.25, 18.75 - h) / 0.25))
    } else if (p.kind !== 'guard') {
      out.alpha = Math.max(0, Math.min(1, (dayShare(solarT) - a.rank) / 0.03))
    }
    if (out.alpha <= 0) return false
    switch (p.kind) {
      case 'vendor':
        out.x = p.x
        out.z = p.z
        out.yaw = p.yaw
        out.clip = 'VENDOR01'
        out.clipT = nowS + p.phase
        return true
      case 'sitter':
        out.x = p.x
        out.z = p.z
        out.yaw = p.yaw
        out.clip = 'SIT'
        out.clipT = nowS + p.phase
        return true
      case 'chat': {
        const turn = Math.floor((nowS + p.phase) / 4)
        const talker = turn % p.ring
        out.x = p.x
        out.z = p.z
        out.yaw = p.yaw
        if (talker === p.member) {
          out.clip = TALK_CLIPS[Math.floor(hash01(a.id, turn) * TALK_CLIPS.length)] ?? 'EMOTION01'
          out.clipT = nowS + p.phase - turn * 4
        } else {
          out.clip = hash01(a.id, 77) < 0.5 ? 'STAND1' : 'STAND3'
          out.clipT = nowS + p.phase
        }
        return true
      }
      case 'guard':
      case 'child': {
        const loop = this.loops[p.loop]!
        const dist = nowS * p.speed + p.s0
        this.arc = dist
        this.onLoop(loop, p.dir, out)
        out.clip = p.kind === 'child' ? 'RUN' : 'WALK'
        out.distM = dist
        out.speed = p.speed
        out.clipT = nowS
        out.rate = p.speed / WALK_SPEED
        return true
      }
      case 'walker': {
        const loop = this.loops[p.loop]!
        const t = nowS + p.phase
        const lap = Math.floor(t / p.period)
        let u = t - lap * p.period
        let walked = 0
        for (let k = 0; k < 3; k++) {
          const w = p.legs[k * 2]!
          const ws = w / p.speed
          if (u < ws) {
            walked += u * p.speed
            this.arc = p.s0 + walked
            this.onLoop(loop, p.dir, out)
            out.clip = 'WALK'
            out.distM = lap * loop.len + walked
            out.speed = p.speed
            out.clipT = u
            out.rate = p.speed / WALK_SPEED
            return true
          }
          u -= ws
          walked += w
          const d = p.legs[k * 2 + 1]!
          if (u < d) {
            this.arc = p.s0 + walked
            this.onLoop(loop, p.dir, out)
            out.clip = hash01(a.id, lap * 3 + k) < 0.6 ? 'STAND1' : 'STAND3'
            out.clipT = u
            return true
          }
          u -= d
        }
        this.arc = p.s0 + loop.len
        this.onLoop(loop, p.dir, out)
        out.clip = 'STAND1'
        out.clipT = 0
        return true
      }
    }
  }

  /** Position and heading at arc position dir × `arc` (the heading from ±0.5 m around it: corners round off). */
  private onLoop(loop: Loop, dir: number, out: CrowdPose): void {
    const s = dir * this.arc
    loop.s = s
    loop.at(this.tmp)
    out.x = this.tmp.x
    out.z = this.tmp.z
    loop.s = s - dir * 0.5
    loop.at(this.tmp)
    const bx = this.tmp.x
    const bz = this.tmp.z
    loop.s = s + dir * 0.5
    loop.at(this.tmp2)
    out.yaw = Math.atan2(this.tmp2.x - bx, this.tmp2.z - bz)
  }

  /** The alarm (D19): everyone but the vendors hurries to the nearest door and goes in; the guards to the south gate. */
  private alarmPose(_i: number, p: StandInAgent, a: CrowdAgent, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const b = this.base
    this.atS = q.alarmFromS
    this.atSolar = q.solarT
    if (!this.basePose(p, a, b)) return false
    let tx = SOUTH_GATE[0]
    let tz = SOUTH_GATE[1]
    if (p.kind !== 'guard') {
      let best = Infinity
      for (let k = 0; k < PLAZA_DOORS.length; k++) {
        const door = PLAZA_DOORS[k]!
        const d2 = (door[0] - b.x) ** 2 + (door[1] - b.z) ** 2
        if (d2 < best) {
          best = d2
          tx = door[0]
          tz = door[1]
        }
      }
    }
    const v = (p.kind === 'guard' ? 1.2 : Math.max(WALK_SPEED, p.speed)) * ALARM_HURRY
    const D = Math.hypot(tx - b.x, tz - b.z)
    const t = q.nowS - q.alarmFromS
    const yaw = D > 1e-3 ? Math.atan2(tx - b.x, tz - b.z) : b.yaw
    out.y = Number.NaN
    out.alpha = b.alpha
    if (t * v < D) {
      const f = (t * v) / D
      out.x = b.x + (tx - b.x) * f
      out.z = b.z + (tz - b.z) * f
      out.yaw = yaw
      out.clip = 'WALK'
      out.distM = t * v
      out.speed = v
      out.clipT = t
      out.rate = v / WALK_SPEED
      return true
    }
    out.x = tx
    out.z = tz
    out.distM = Number.NaN
    out.speed = 0
    out.rate = 1
    if (p.kind === 'guard') {
      // the gate's watch, facing into the town (north is −Z)
      out.yaw = Math.PI
      out.clip = 'STAND1'
      out.clipT = t
      return true
    }
    // at the door: in through it (the 0.6 s fade), then not out until the alarm ends
    out.yaw = yaw
    out.clip = 'STAND1'
    out.clipT = t
    out.alpha *= Math.max(0, 1 - (t - D / v) / 0.6)
    return out.alpha > 0
  }
}

/** Jangan's world (the stand-in plan only runs there). */
export function isJangan(world: Pick<World, 'manifest'>): boolean {
  return /^jangan/i.test(world.manifest?.name ?? '')
}

/** The stand-in plan for Jangan (the plaza crowd, the hens' yard, the cat's walls, the dogs, the pond). */
export function plazaStandIn(world: Pick<World, 'manifest'>): TownPlan | null {
  if (!isJangan(world)) return null
  const folk = new PlazaStandIn()
  const owner = folk.agents.findIndex(a => a.role === 'walker')
  return {
    folk,
    routes: folk.routes,
    plaza: { ...PLAZA.box, holes: [[PLAZA.x, PLAZA.z, PLAZA.fountainR + 2]] },
    animals: {
      // H11 P3: was (165, −155) r 4, which straddled cj_etc_wall02 near (167.5, −152.4) with a walkers' edge 1 m from its
      // centre; here every hen spot is on flat walkable ground outside the nav solids, 5.3 m from the nearest edge
      yard: { x: 163, z: -150.5, r: 3 },
      hens: 8,
      // H11 P4: the second spot was (124, −76): the leg from (75, −70) crossed the fountain's south-east planter (108.55,
      // −74.96); from (124, −72) it passes 3.6 m north of it
      catSpots: [[75, -70], [124, -72], [118, -105], [80, -100]],
      dogOwner: owner,
      dogRest: [130, -82, -Math.PI / 2],
    },
    pond: { x: 228, z: -222, r: 26 },
    lines: townLines(null),
    area: { x: PLAZA.x, z: -100, r: 140 },
  }
}

// ---- TL-R's schedule behind the crowd's seam ----------------------------------------------------------------------

/**
 * TL-R's `TownSchedule` as a `CrowdSchedule`: the agents (id = index + 1, the look seed, the cap rank, the goods; a
 * pack horse or a rider's horse is drawn as a 'horse'), `stateAt` into the crowd's pose (a walk's distance from its
 * clip time × the clip's nominal speed, so the crowd's own clip sets the feet), the alarm forwarded (the schedule keeps
 * it). The solar function is the world clock's, allocation-free (`clockDays` + `solarTime`).
 */
export class ScheduleAdapter implements CrowdSchedule {
  readonly agents: CrowdAgent[]
  private readonly st = newTownAgentState()
  /** The sky's solar time at a server second (TL-R decides who is out at each trip's start). */
  solar: TownSolar = 0.5
  /**
   * I-11: the world whose clock gives `solar` (schedulePlan; `follow`). TownSchedule caches each agent's presence per
   * trip and per solar source, so a clock that arrives after the first frames (the world loads before the server's
   * clock message) or moves (a GM /time) must give a new source; else a client that came in earlier keeps the old
   * answers for up to a trip (480 s) while a friend who came in later sees other people out (TOWN_LIFE §2.1).
   */
  private clockWorld: Pick<World, 'worldClock' | 'skyState'> | null = null
  private clockRef: World['worldClock'] = null
  private clockAnchorMs = Number.NaN
  private clockAnchorDays = Number.NaN
  private clockDayMs = Number.NaN
  private clockNight = Number.NaN
  private clockRunning = false
  private checkedAt = Number.NaN

  constructor(readonly schedule: TownSchedule) {
    this.agents = schedule.agents.map(a => ({
      id: a.index + 1,
      role: a.kind === 'horse' || a.kind === 'rider' ? 'horse' : a.role,
      female: a.female,
      rank: a.rank,
      scale: a.scale,
      seed: a.look,
      ...(a.goods ? { goods: a.goods } : {}),
    }))
  }

  /** Takes the solar time from `world`'s clock from now on (a new source whenever the clock arrives or moves). */
  follow(world: Pick<World, 'worldClock' | 'skyState'>): void {
    this.clockWorld = world
    this.clockRef = null
    this.checkedAt = Number.NaN
    this.solar = solarOf(world)
  }

  /** Once per server time asked (a frame): a new solar source when the world clock came, went or moved (allocates only then). */
  private syncSolar(nowS: number): void {
    if (nowS === this.checkedAt) return
    this.checkedAt = nowS
    const w = this.clockWorld
    if (!w) return
    const c = w.worldClock
    if (!c) {
      // no clock yet: the sky's own time, as a number (the schedule's cache follows a number by value)
      this.clockRef = null
      this.solar = w.skyState?.t ?? 0.5
      return
    }
    if (c === this.clockRef && c.anchorMs === this.clockAnchorMs && c.anchorDays === this.clockAnchorDays && c.dayMs === this.clockDayMs &&
      c.nightSpeedup === this.clockNight && c.running === this.clockRunning && typeof this.solar === 'function') return
    this.clockRef = c
    this.clockAnchorMs = c.anchorMs
    this.clockAnchorDays = c.anchorDays
    this.clockDayMs = c.dayMs
    this.clockNight = c.nightSpeedup
    this.clockRunning = c.running
    this.solar = solarOf(w)
  }

  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    this.syncSolar(q.nowS)
    const st = this.schedule.stateAt(i, q.nowS, this.solar, this.st)
    if (!st.visible) return false
    out.x = st.x
    out.y = st.y
    out.z = st.z
    out.yaw = st.yaw
    out.clip = st.clip
    out.clipT = st.clipTime
    out.rate = st.clipRate
    out.alpha = st.alpha
    if (st.moving && st.speed > 0) {
      const a = this.schedule.agents[i]!
      // the world distance walked: clipTime runs at speed / (nominal × scale), so the stride is nominal × scale
      out.distM = st.clipTime * townNominalSpeed(a.kind, st.clip) * (a.scale > 0 ? a.scale : 1)
      out.speed = st.speed
    } else {
      out.distM = Number.NaN
      out.speed = 0
    }
    return true
  }

  alarm(nowS: number, sec: number): void {
    this.schedule.alarm(nowS, sec)
  }

  /** The schedule's people within r of (x, z) among the first `limit` agents (the bed's count without a crowd). */
  populationNear(x: number, z: number, r: number, nowS: number, limit: number): number {
    this.syncSolar(nowS)
    return this.schedule.populationNear(x, z, r, nowS, this.solar, limit)
  }
}

/** The town file's routes for the pigeons: every graph edge, and every dwell place and seat. */
export function routesOf(schedule: TownSchedule): TownRoutes {
  const segs: number[] = []
  for (const [a, b] of schedule.edges) {
    const na = schedule.nodes[a]
    const nb = schedule.nodes[b]
    if (na && nb) segs.push(na.x, na.z, nb.x, nb.z)
  }
  const spots: number[] = []
  for (const p of schedule.places) {
    if (p.kind === 'door') continue
    spots.push(p.x, p.z)
    for (const s of p.seats) spots.push(s.x, s.z)
  }
  return { segments: Float32Array.from(segs), spots: Float32Array.from(spots) }
}

/** The solar time at server second s from the world's clock (no allocation); the sky's t without a clock. */
function solarOf(world: Pick<World, 'worldClock' | 'skyState'>): (s: number) => number {
  return s => {
    const c = world.worldClock
    if (!c) return world.skyState?.t ?? 0.5
    const days = clockDays(c, s * 1000)
    const t = solarTime(days - Math.floor(days), c.nightSpeedup)
    return t - Math.floor(t)
  }
}

/** A plan on TL-R's schedule of a town file (Jangan's animals, pond and plaza from the stand-in's survey). */
export function schedulePlan(file: TownFile, world: World, noFolk: readonly CrowdCircle[]): TownPlan {
  // a copy: the caller's list may be the part's live one (changed in place by configure)
  const circles = noFolk.map(c => ({ x: c.x, z: c.z, r: c.r }))
  const schedule = new TownSchedule(file, { noFolk: circles.length ? circles : null })
  const folk = new ScheduleAdapter(schedule)
  folk.follow(world)
  const base = plazaStandIn(world)
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const n of schedule.nodes) {
    x0 = Math.min(x0, n.x)
    x1 = Math.max(x1, n.x)
    z0 = Math.min(z0, n.z)
    z1 = Math.max(z1, n.z)
  }
  const area = Number.isFinite(x0) ? { x: (x0 + x1) / 2, z: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2 } : base?.area ?? { x: 0, z: 0, r: 0 }
  const owner = folk.agents.findIndex(a => a.role === 'walker')
  return {
    folk,
    routes: routesOf(schedule),
    plaza: base?.plaza ?? null,
    animals: base?.animals ? { ...base.animals, dogOwner: owner } : null,
    pond: base?.pond ?? null,
    lines: townLines(file.lines as unknown as TownLinesLite),
    area,
    replan: next => schedulePlan(file, world, next),
    noFolk: circles,
  }
}

/**
 * The default plan: the export's `town.json` (TL-R's content, copied by the converter at X1) on TL-R's schedule; else,
 * on Jangan, the plaza stand-in; elsewhere none.
 */
export function defaultPlan(world: World, noFolk: readonly CrowdCircle[]): TownPlan | null | Promise<TownPlan | null> {
  if (!isJangan(world)) return null
  const assets = world.assets
  if (!assets || typeof assets.json !== 'function') return plazaStandIn(world)
  return assets.json<TownFile>('town.json').then(
    file => {
      if (!file || file.kind !== 'town' || !file.graph?.nodes?.length) return plazaStandIn(world)
      return schedulePlan(file, world, noFolk)
    },
    () => plazaStandIn(world),
  )
}

// ---- the part ----------------------------------------------------------------------------------------------------

function sameCircles(a: readonly CrowdCircle[], b: readonly CrowdCircle[]): boolean {
  return a.length === b.length && a.every((k, i) => k.x === b[i]!.x && k.z === b[i]!.z && k.r === b[i]!.r)
}

/** The TAA swap's hysteresis beyond the town's area + the crowd range (m). */
const TEMPORAL_ON_M = 20
const TEMPORAL_OFF_M = 80

/** Duck-typed world pieces (each may be absent in a test world). */
interface PostLike {
  setTemporalOverride?(owner: string, mode: 'none' | 'msaa4'): void
}

/** The town part: the crowds, the birds, the props and the bubbles (see the file header). */
export class TownLife implements TownPart, TownBubbleSource {
  readonly scene: Scene
  readonly world: World
  plan: TownPlan | null = null
  enabled = true
  assets: CrowdAssets | null = null
  folk: TownCrowd | null = null
  animals: TownCrowd | null = null
  animalSchedule: AnimalSchedule | null = null
  blobs: TownBlobs | null = null
  lanterns: TownLanterns | null = null
  /** TL-M's motion layers (smoke, steam, spray, leaves, ripple points) and TL-B's dressing (decals, the pond profile). */
  fx: TownFx | null = null
  dressing: TownDressingLayer | null = null
  /** The last frame's update time (ms; stats). */
  updateMs = 0
  private clock: TownClock | null = null
  private threats: TownThreats | null = null
  private counts = 1
  private noFolk: CrowdCircle[] = []
  private players = 0
  /** CR-1: the no-folk line's latch (on at the preset's noFolkFrom, off 3 players below it). */
  private latch: CrowdLatch | null = null
  private crowdLatch(onAt: number): CrowdLatch {
    if (this.latch?.onAt !== onAt) this.latch = new CrowdLatch(onAt)
    return this.latch
  }
  private alarmFromS = 0
  private alarmUntilS = 0
  private t0 = Number.NaN
  private T = 0
  private presetName: TownPresetName | null = null
  private preset: Readonly<TownPreset> = TOWN_PRESETS.medium
  private readonly q: CrowdQuery = { nowS: 0, solarT: 0.5, alarmFromS: 0, alarmUntilS: 0, rain: 0 }
  private readonly threatXZ = new Float32Array(THREATS_MAX * 2)
  private readonly focus = { x: 0, z: 0 }
  private birdsOff: (() => void) | null = null
  private birdsDucks = false
  private warmOff: (() => void) | null = null
  private warmed = false
  private temporalAsked: PostLike | null = null
  private clicked = -1
  private clickUntilS = 0
  private clickLine = ''
  private vendors = new Int32Array(0)
  private readonly drawn = newDrawn()
  private disposed = false
  /** A plan or the assets still loading (the warm-up waits for them). */
  private pending = false
  private settle: () => void = () => {}
  /** H11-HI-1 (TownPart.loaded): the plan and the drawables are in, or never will be. */
  readonly loaded: Promise<void> = new Promise<void>(r => (this.settle = r))
  /** A town's world (the motion layers and the dressing run here); the motion layers failed to start. */
  private readonly townWorld: boolean
  private fxFailed = false
  private readonly decorate: (m: Material) => void
  private readonly assetSource: (scene: Scene, decorate: (m: Material) => void) => CrowdAssets | Promise<CrowdAssets>

  constructor(host: TownHost, sources: TownSources = {}) {
    this.scene = host.scene
    this.world = host.world
    this.decorate = (m: Material) => {
      try {
        host.world.materials?.pbr?.decorateCharacterMaterial(m)
      } catch {
        // a test world without the PBR surfaces: the plain material
      }
    }
    this.assetSource = sources.assets ?? defaultAssets(host.world)
    let plan: TownPlan | null | Promise<TownPlan | null> = null
    try {
      plan = (sources.plan ?? defaultPlan)(host.world, this.noFolk)
    } catch (err) {
      console.warn('[town] no town plan:', err)
    }
    this.warmOff = addWarmupHook(this.scene, () => this.warm())
    // TL-M's motion layers and TL-B's dressing: the town part owns their wiring (fx.ts, decals.ts), on a town's world
    // only (Jangan, a world whose manifest lists town files, or a plan given by the caller).
    this.townWorld = sources.plan !== undefined || isJangan(host.world) || !!(host.world.manifest as { town?: unknown } | undefined)?.town
    if (this.townWorld) {
      try {
        this.dressing = attachTownDressing(host)
      } catch (err) {
        console.warn('[town] no dressing:', err)
        this.dressing = null
      }
    }
    this.ensureFx()
    if (plan instanceof Promise) {
      this.pending = true
      plan.then(p => this.withPlan(p), err => {
        console.warn('[town] the town plan failed:', err)
        this.withPlan(null)
      })
    } else this.withPlan(plan)
  }

  /** The plan is known: no town here, or the assets next (sync or async). */
  private withPlan(plan: TownPlan | null): void {
    if (this.disposed) return
    if (!plan) {
      this.pending = false
      this.settle()
      return
    }
    // a noFolk circle configured while the town file was loading (the stage): route round it from the start, unless
    // the source already read it when the file came (defaultPlan: one schedule, not two; H11-HI-2)
    if (plan.replan && !sameCircles(plan.noFolk ?? [], this.noFolk)) {
      try {
        plan = plan.replan(this.noFolk)
      } catch (err) {
        console.warn('[town] replan failed:', err)
      }
    }
    this.plan = plan
    let made: CrowdAssets | Promise<CrowdAssets>
    try {
      made = this.assetSource(this.scene, this.decorate)
    } catch (err) {
      console.warn('[town] the crowd assets failed, using the stand-ins:', err)
      made = stubCrowdAssets(this.scene, this.decorate)
    }
    if (made instanceof Promise) {
      this.pending = true
      made.then(a => this.adopt(a), err => {
        console.info('[town] no crowd export yet (town/index.json), using the stand-ins:', String(err))
        if (!this.disposed) this.adopt(stubCrowdAssets(this.scene, this.decorate))
      }).catch(err => {
        this.pending = false
        this.settle()
        console.warn('[town] the crowd could not start:', err)
      })
    } else this.adopt(made)
  }

  /** Builds the crowds on loaded assets (the part may have been disposed meanwhile). */
  private adopt(assets: CrowdAssets): void {
    this.pending = false
    if (this.disposed) {
      assets.dispose()
      return
    }
    this.assets = assets
    try {
      this.buildCrowds()
    } finally {
      this.settle()
    }
  }

  /** (Re)builds the folk and animal crowds, the blobs and the lanterns on the current plan and assets. */
  private buildCrowds(): void {
    const plan = this.plan
    const assets = this.assets
    if (!plan || !assets) return
    this.folk?.dispose()
    this.animals?.dispose()
    this.blobs?.dispose()
    this.lanterns?.dispose()
    const heightAt = (x: number, z: number) => this.world.heightAt?.(x, z) ?? null
    const preset = this.presetOf()
    this.folk = new TownCrowd(assets, plan.folk, { kinds: ['folk', 'guard', 'elder'], variants: preset.variants, preset: this.presetKey(), heightAt })
    this.animalSchedule = plan.animals ? new AnimalSchedule(plan.animals, plan.folk) : null
    this.animals = this.animalSchedule ? new TownCrowd(assets, this.animalSchedule, { kinds: ['chicken', 'dog', 'cat', 'horse'], preset: this.presetKey(), heightAt }) : null
    const total = plan.folk.agents.length + (this.animalSchedule?.agents.length ?? 0)
    this.blobs = new TownBlobs(this.scene, total)
    this.lanterns = new TownLanterns(this.scene, plan.folk.agents)
    this.vendors = Int32Array.from(plan.folk.agents.flatMap((a, i) => (a.role === 'vendor' ? [i] : [])))
    if (this.alarmUntilS > 0) plan.folk.alarm?.(this.alarmFromS, this.alarmUntilS - this.alarmFromS)
    this.clicked = -1
    this.presetName = null
    this.warmed = false
    this.syncBirds()
  }

  // ---- TownPart --------------------------------------------------------------------------------------------------

  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    this.fx?.setEnabled(on)
    if (!on) this.hideAll()
    this.syncBirds()
    if (!on) this.askTemporal(false)
  }

  setClock(fn: TownClock | null): void {
    this.clock = fn
  }

  setThreats(fn: TownThreats | null): void {
    this.threats = fn
  }

  configure(config: TownConfig): void {
    if (config.counts !== undefined) this.counts = Math.max(0, Number.isFinite(config.counts) ? config.counts : 1)
    if (config.noFolk !== undefined) {
      const c = config.noFolk
      const next = !c ? [] : (Array.isArray(c) ? (c as readonly TownCircle[]) : [c as TownCircle]).map(k => ({ x: k.x, z: k.z, r: k.r }))
      const same = sameCircles(next, this.noFolk)
      // in place: a plan source still loading its file reads the list when the file comes (H11-HI-2)
      this.noFolk.splice(0, this.noFolk.length, ...next)
      // A schedule that routes round the circles (TL-R's) is made again with them; the crowd skips them either way.
      if (!same && this.plan?.replan) {
        try {
          this.plan = this.plan.replan(next)
          this.buildCrowds()
        } catch (err) {
          console.warn('[town] replan failed:', err)
        }
      }
    }
  }

  alarm(nowS: number, sec: number): void {
    if (!Number.isFinite(nowS) || !(sec > 0)) return
    nowS = alarmStart(nowS) // the start every client agrees on (H11-DET-1; the schedule floors it the same way)
    if (this.alarmUntilS > nowS) this.alarmUntilS = Math.max(this.alarmUntilS, nowS + sec)
    else {
      this.alarmFromS = nowS
      this.alarmUntilS = nowS + sec
    }
    this.plan?.folk.alarm?.(nowS, sec)
  }

  /** Server seconds now (the shared clock; the page's own without one). */
  now(): number {
    const t = this.clock ? this.clock() : Date.now() / 1000
    return Number.isFinite(t) ? t : Date.now() / 1000
  }

  update(camera: Camera | null, dt: number): void {
    if (this.disposed) return
    this.ensureFx()
    this.fx?.update(camera, dt)
    this.dressing?.update()
    if (!this.enabled || !this.folk || !this.plan) return
    const t0 = performance.now()
    this.syncPreset()
    const folk = this.folk
    const animals = this.animals
    const nowS = this.now()
    // The time base (F5): manager.time = nowS − t0 in [REBASE_MIN_S, REBASE_MAX_S).
    let T = nowS - this.t0
    if (!(T >= REBASE_MIN_S && T < REBASE_MAX_S)) {
      this.t0 = nowS - REBASE_MIN_S
      T = REBASE_MIN_S
      folk.invalidateClips()
      animals?.invalidateClips()
    }
    this.T = T
    for (const v of this.assets!.vats) v.manager.time = T
    const q = this.q
    q.nowS = nowS
    q.solarT = this.world.skyState?.t ?? 0.5
    q.alarmFromS = this.alarmFromS
    q.alarmUntilS = this.alarmUntilS
    q.rain = this.world.weatherState?.rain ?? 0
    // The focus: the camera's target (the player; the stage's spot), else the camera.
    if (camera) {
      const target = (camera as Camera & { target?: Vector3 }).target
      const p = target instanceof Vector3 ? target : camera.globalPosition
      this.focus.x = p.x
      this.focus.z = p.z
    }
    const fx = this.focus.x
    const fz = this.focus.z
    const preset = this.preset
    // The actors near the focus (the sidestep and the turn).
    let tc = 0
    const list = this.threats?.() ?? null
    if (list) {
      const r2 = (preset.rangeM + 3) ** 2
      for (let k = 0; k < list.length && tc < THREATS_MAX; k++) {
        const t = list[k]!
        if ((t.x - fx) ** 2 + (t.z - fz) ** 2 > r2) continue
        this.threatXZ[tc * 2] = t.x
        this.threatXZ[tc * 2 + 1] = t.z
        tc++
      }
    }
    const crowded = preset.noFolkFrom !== undefined ? this.crowdLatch(preset.noFolkFrom).update(this.players) : undefined
    folk.configure(folkCap(preset, this.players, this.counts, crowded), preset.rangeM, this.noFolk)
    folk.update(q, T, fx, fz, dt, this.threatXZ, tc)
    if (animals) {
      animals.configure(animalCap(preset, this.players, this.counts), Math.min(preset.rangeM, 60), this.noFolk)
      animals.update(q, T, fx, fz, dt, this.threatXZ, tc)
    }
    const blobs = this.blobs!
    blobs.begin()
    if (preset.shadows === 'blob') {
      blobs.addCrowd(folk, this.plan.folk.agents.length)
      if (animals) blobs.addCrowd(animals, this.animalSchedule!.agents.length)
    }
    blobs.end()
    if (this.lanterns!.holders) {
      // display-referred at the post's exposure (H11-NT-2); the ≤ 4 nearest carry a cluster light (H11-NT-3)
      const sky = this.world.skyState
      this.lanterns!.maxLights = preset.lanternLights
      this.lanterns!.update(folk, q.solarT, sky?.exposure ?? Number.NaN, sky?.night ?? 0, nightLightsOf(this.scene), fx, fz, dt)
    }
    // The TAA answer (G5-11): MSAA ×4 in place of TAA while in town. Asked on every preset, not only those whose
    // default AA is TAA (`temporalFix`): the Advanced row can turn TAA on for Medium, and the post only swaps when it
    // actually runs TAA (a stack without TAA keeps its plan, no rebuild; H11-NT-1).
    {
      const a = this.plan.area
      const d = Math.hypot(fx - a.x, fz - a.z) - a.r - preset.rangeM
      if (d < TEMPORAL_ON_M) this.askTemporal(true)
      else if (d > TEMPORAL_OFF_M) this.askTemporal(false)
      else if (this.temporalAsked && this.temporalAsked !== this.post()) this.askTemporal(true)
    }
    if (this.clicked >= 0 && nowS >= this.clickUntilS) this.clicked = -1
    this.updateMs = performance.now() - t0
  }

  meshes(): AbstractMesh[] {
    const out: AbstractMesh[] = []
    if (this.folk) out.push(...this.folk.meshes())
    if (this.animals) out.push(...this.animals.meshes())
    if (this.blobs) out.push(this.blobs.mesh)
    if (this.lanterns) out.push(this.lanterns.mesh)
    if (this.fx) out.push(...this.fx.meshes())
    if (this.dressing) out.push(...this.dressing.meshes())
    return out
  }

  stats(): Readonly<Record<string, number>> {
    const f = this.folk?.frame
    const a = this.animals?.frame
    const draws = (f?.draws ?? 0) + (a?.draws ?? 0) + (this.blobs?.count ? 1 : 0) + (this.lanterns?.count ? 1 : 0)
    return {
      ...(this.fx?.stats() ?? {}),
      ...(this.dressing?.stats() ?? {}),
      folk: f?.drawn ?? 0,
      animals: a?.drawn ?? 0,
      draws,
      inRange: f?.inRange ?? 0,
      near30: f?.near30 ?? 0,
      cap: this.folk?.cap ?? 0,
      animalCap: this.animals?.cap ?? 0,
      players: this.players,
      clipWrites: (f?.clipWrites ?? 0) + (a?.clipWrites ?? 0),
      updateMs: this.updateMs,
      vatTime: this.T,
      stub: this.assets?.stub ? 1 : 0,
      enabled: this.enabled && !this.disposed ? 1 : 0,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.settle()
    this.askTemporal(false)
    this.birdsOff?.()
    this.birdsOff = null
    this.warmOff?.()
    this.warmOff = null
    this.folk?.dispose()
    this.animals?.dispose()
    this.blobs?.dispose()
    this.lanterns?.dispose()
    this.fx?.dispose()
    this.dressing?.dispose()
    this.fx = null
    this.dressing = null
    this.assets?.dispose()
    this.folk = null
    this.animals = null
    this.blobs = null
    this.lanterns = null
    this.assets = null
    this.clock = null
    this.threats = null
  }

  // ---- TownBubbleSource (the app's town feature) -----------------------------------------------------------------

  setPlayers(n: number): void {
    this.players = Math.max(0, Math.floor(n) || 0)
  }

  /** The crowd's range on this preset (m; the app counts the players within it). */
  get range(): number {
    return this.preset.rangeM
  }

  /**
   * Whether townsfolk are drawn now (enabled, loaded, a cap above 0). False under cut 20 (Medium, 15+ players in
   * range) and Town life Off: the game's town sound then counts the schedule and plays the built-in stall murmurs
   * (apps/game world/features/town.ts syncCounter).
   */
  get drawsFolk(): boolean {
    return this.enabled && !this.disposed && !!this.folk && this.folk.cap > 0
  }

  /**
   * Townsfolk drawn within r of (x, z) (the town bed's count, TL-S). While the crowd gives way to the players entirely
   * (cut 20: Medium with ≥ 15 players in range) the bed keeps the schedule's count, so the sound stays.
   */
  folkNear(x: number, z: number, r: number): number {
    if (!this.enabled || !this.folk) return 0
    if (this.folk.cap === 0 && this.preset.folk > 0 && this.counts > 0) {
      const adapter = this.plan?.folk
      if (adapter instanceof ScheduleAdapter) return adapter.populationNear(x, z, r, this.now(), folkCap(this.preset, 0, this.counts))
    }
    return this.folk.countNear(x, z, r)
  }

  bubbles(out: TownBubble[]): number {
    const folk = this.folk
    const plan = this.plan
    if (!folk || !plan || !this.enabled || this.disposed) return 0
    const nowS = this.q.nowS || this.now()
    const d = this.drawn
    let n = 0
    if (this.clicked >= 0 && nowS < this.clickUntilS && n < out.length && folk.drawnOf(this.clicked, d) && d.alpha > 0.5) {
      this.fill(out[n++]!, this.clicked, this.clickLine, d, true)
    }
    const r2 = CALL_RANGE_M * CALL_RANGE_M
    for (let k = 0; k < this.vendors.length && n < out.length; k++) {
      const i = this.vendors[k]!
      if (i === this.clicked || !folk.drawnOf(i, d) || d.alpha < 0.5) continue
      if ((d.x - this.focus.x) ** 2 + (d.z - this.focus.z) ** 2 > r2) continue
      const a = plan.folk.agents[i]!
      const call = vendorCallAt(a.id, nowS)
      if (!call) continue
      this.fill(out[n++]!, i, callText(plan.lines, a.goods, a.id, call.slot), d, false)
    }
    return nearestBubbles(out, n)
  }

  private fill(b: TownBubble, agent: number, text: string, d: { x: number; y: number; z: number; h: number }, click: boolean): void {
    b.agent = agent
    b.text = text
    b.x = d.x
    b.y = d.y + d.h + 0.12
    b.z = d.z
    b.dist = Math.hypot(d.x - this.focus.x, d.z - this.focus.z)
    b.click = click
  }

  pickFolk(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    if (!this.folk || !this.enabled || this.disposed) return -1
    return this.folk.pick(ox, oy, oz, dx, dy, dz, 400, this.focus.x, this.focus.z, CLICK_RANGE_M).agent
  }

  say(agent: number): boolean {
    const plan = this.plan
    if (!plan || !this.folk || !this.folk.drawnOf(agent, this.drawn)) return false
    const a = plan.folk.agents[agent]
    if (!a) return false
    const nowS = this.now()
    this.clicked = agent
    this.clickUntilS = nowS + BUBBLE_S
    this.clickLine = clickText(plan.lines, a.role, a.id, nowS)
    return true
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private presetKey(): TownPresetName {
    const q = this.world.quality
    return q === 'low' || q === 'medium' || q === 'high' || q === 'ultra' ? q : 'medium'
  }

  private presetOf(): Readonly<TownPreset> {
    return TOWN_PRESETS[this.presetKey()]
  }

  /**
   * TL-M's layers, made once the world's quality is above Low (createTownFx is null on Low; a path switch can make the
   * part on PBR a moment before the quality comes back from Low).
   */
  private ensureFx(): void {
    if (this.fx || this.fxFailed || !this.townWorld || this.disposed || this.world.quality === 'low') return
    // a world without placements to read (a test world) has no layers
    if (typeof (this.world as { objects?: { addRegionListener?: unknown } }).objects?.addRegionListener !== 'function') return
    try {
      this.fx = createTownFx({ scene: this.scene, world: this.world } as unknown as TownFxHost)
      if (this.fx && !this.enabled) this.fx.setEnabled(false)
    } catch (err) {
      console.warn('[town] no motion layers:', err)
      this.fx = null
      this.fxFailed = true
    }
  }

  /** The world's quality → the preset (counts, range, variants, shadows, ducks, the TAA swap); applied on a change. */
  private syncPreset(): void {
    const name = this.presetKey()
    if (name === this.presetName) return
    const first = this.presetName === null
    this.presetName = name
    this.preset = this.presetOf()
    // Another preset draws other variants: the crowds are made again on the same assets (a preset change, not per frame).
    if (!first && this.folk) {
      this.buildCrowds()
      this.presetName = name
    }
    if (this.birdsDucks !== this.preset.ducks) this.syncBirds()
  }

  private hideAll(): void {
    this.folk?.hideAll()
    this.animals?.hideAll()
    if (this.blobs) {
      this.blobs.begin()
      this.blobs.end()
    }
    if (this.lanterns) this.lanterns.update(this.folk!, 0.5)
  }

  /** The pigeons (and the ducks on High+) while the part is on and has a plaza. */
  private syncBirds(): void {
    this.birdsOff?.()
    this.birdsOff = null
    const plan = this.plan
    const life = this.world.life
    if (!plan || !life || !this.enabled || this.disposed || !plan.plaza || !this.folk) return
    const preset = this.presetOf()
    const groundAt = (x: number, z: number) => this.world.heightAt?.(x, z) ?? null
    const waterAt = (x: number, z: number) => this.world.waterLevelAt?.(x, z) ?? null
    this.birdsDucks = preset.ducks
    const pond = preset.ducks && plan.pond ? pondHabitat(plan.pond.x, plan.pond.z, plan.pond.r, waterAt) : null
    this.birdsOff = registerTownBirds(life, plazaHabitat(plan.plaza, plan.routes, groundAt), pond)
  }

  private post(): PostLike | null {
    const p = (this.world.render as unknown as { post?: unknown } | undefined)?.post as PostLike | null | undefined
    return p && typeof p.setTemporalOverride === 'function' ? p : null
  }

  /** Asks (or takes back) MSAA ×4 in place of TAA (RenderPost.setTemporalOverride, D4). */
  private askTemporal(on: boolean): void {
    if (on) {
      const p = this.post()
      if (!p || p === this.temporalAsked) return
      this.temporalAsked?.setTemporalOverride?.('town', 'none')
      p.setTemporalOverride!('town', 'msaa4')
      this.temporalAsked = p
    } else if (this.temporalAsked) {
      this.temporalAsked.setTemporalOverride?.('town', 'none')
      this.temporalAsked = null
    }
  }

  /** The warm-up hook (D25): compiles every crowd effect (a mesh with no instance gets one, hidden, for the check). */
  private warm(): boolean | 'loading' {
    if (this.disposed || this.warmed) return true
    // H11-HI-1: the plan or the drawables still arriving: the warm-up holds its shader stage for them
    if (this.pending) return 'loading'
    if (!this.plan || !this.folk) return true
    let ready = true
    for (const m of this.meshes()) {
      if (m.isDisposed()) continue
      const mesh = m as AbstractMesh & { thinInstanceCount?: number }
      const had = mesh.thinInstanceCount ?? 0
      if (had === 0 && mesh.thinInstanceCount !== undefined) mesh.thinInstanceCount = 1
      try {
        if (!m.isReady(true)) ready = false
      } finally {
        if (had === 0 && mesh.thinInstanceCount !== undefined) mesh.thinInstanceCount = 0
      }
    }
    if (ready) this.warmed = true
    return ready
  }

  /** Whether the pigeons may land at (x, z) (tests: the route rule). */
  landingClear(x: number, z: number): boolean {
    return !this.plan || !nearRoute(this.plan.routes, x, z)
  }
}

/** The default drawables: TL-V's export (`/out/town/`, beside the world folders), else the stand-ins. */
function defaultAssets(world: World): (scene: Scene, decorate: (m: Material) => void) => CrowdAssets | Promise<CrowdAssets> {
  return (scene, decorate) => {
    const assets = world.assets
    if (!assets || typeof assets.sub !== 'function') return stubCrowdAssets(scene, decorate)
    return loadCrowdAssets(scene, assets.sub('../../town'), decorate)
  }
}

/** The town of a world (TL-C): the crowd, the animals, the birds, the props and the bubbles. */
export function createTownPart(host: TownHost, sources?: TownSources): TownPart | null {
  return new TownLife(host, sources)
}

/** A factory with fixed sources (tests, the viewer): `LoadWorldOptions.parts.town = townPartWith({...})`. */
export function townPartWith(sources: TownSources): (host: TownHost) => TownPart | null {
  return host => new TownLife(host, sources)
}

/** The stub kept for the seam tests (W11-S): a part that keeps its wiring and draws nothing. */
export class StubTown implements TownPart {
  enabled = true
  clock: TownClock | null = null
  threats: TownThreats | null = null
  readonly config: TownConfig = { counts: 1, noFolk: null }
  /** The last alarm (server seconds it ends at; 0: none). */
  alarmUntilS = 0
  private disposed = false

  constructor(readonly host: TownHost) {}

  setEnabled(on: boolean): void {
    this.enabled = on
  }

  setClock(fn: TownClock | null): void {
    this.clock = fn
  }

  setThreats(fn: TownThreats | null): void {
    this.threats = fn
  }

  configure(config: TownConfig): void {
    if (config.counts !== undefined) this.config.counts = Math.max(0, Number.isFinite(config.counts) ? config.counts : 1)
    if (config.noFolk !== undefined) this.config.noFolk = config.noFolk
  }

  alarm(nowS: number, sec: number): void {
    if (Number.isFinite(nowS) && sec > 0) this.alarmUntilS = Math.max(this.alarmUntilS, nowS + sec)
  }

  update(_camera: Camera | null, _dt: number): void {}

  meshes(): AbstractMesh[] {
    return []
  }

  stats(): Readonly<Record<string, number>> {
    return { folk: 0, animals: 0, draws: 0, enabled: this.enabled && !this.disposed ? 1 : 0 }
  }

  dispose(): void {
    this.disposed = true
    this.clock = null
    this.threats = null
  }
}

export { BUBBLE_S, CALL_RANGE_M, CLICK_RANGE_M, MAX_BUBBLES, newBubble, type TownBubble } from './bubbles.ts'
export { FADE_S, TOWN_PRESETS, folkCap, animalCap, type TownPreset } from './crowd.ts'
