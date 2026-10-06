import { dirname, join } from 'node:path'
import {
  LIFT_MS,
  STORM_TABLE,
  STRIKE_RADIUS_M,
  TORNADO_TABLE,
  pathLength,
  pullVelocity,
  throwDamage,
  tornadoAt,
  tornadoPhase,
  tornadoRoll,
  type GameplayRequest,
  type ServerMessage,
  type TornadoState,
  type TornadoTable,
  type Vec3,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { fail as failReason, type Fail } from '../inventory.ts'
import type { StrikeTarget } from '../lightning/select.ts'
import type { GameplayModule } from '../modules.ts'
import type { MeshNav, NavPoint } from '../nav.ts'
import type { Mob, Player } from '../world.ts'
import { goodPoint, pickStart, planPath, rectDist, type PathWorld } from './tornado-path.ts'
import { loadWater, type WaterIndex } from './water.ts'

/**
 * The lightning tornado (docs/WEATHER.md §13, storm series step 3). A GameplayModule named `tornado`:
 *
 * - **Spawns**: during a storm event, once per storm with TORNADO_CHANCE (seeded by the storm, `tornadoRoll`), at a
 *   seeded share of the storm, drawn to a random player out in the fields; or by a GM (`storm tornado [here|<player>]`).
 *   One at a time. Announced to every player (`tornado`, the warning) TORNADO_TABLE.warnMs before touchdown.
 * - **Path** (tornado-path.ts): straight legs over open outdoor ground, never within townMarginM of a town's safe area,
 *   never across water (water.ts), inside the world bounds. Sent whole, so the clients place it themselves.
 * - **Pull** (every pullTickMs): a body inside pullM drifts toward the funnel (`pullVelocity`, with a swirl) while its
 *   own walk carries on (its intended destination is kept and re-walked), as a server move along the navmesh; a body
 *   standing still also gets `displace {kind: 'pull'}` (the client slides it without a walking clip).
 * - **Throw**: a body inside coreM is caught: knocked down for the flight and lockMs (a short loss of control: the
 *   module's gate refuses moves and actions), thrown THROW_M out along the navmesh (a straight walk, so never through a
 *   wall; never landing in water, a town or out of the world: the farthest fit point along the throw, at least
 *   throwMinM away; else it is only spun in place), `displace {kind: 'throw'}` for the arc, and `throwDamage` on
 *   landing through Gameplay.hazardHit (cause `tornado`; capped per throw and at damageTotalPct per tornado, so a
 *   healthy body survives; it kills one already low only with TORNADO_LETHAL, the normal death path, nobody's kill).
 *   Then immuneMs before it can be pulled or caught again.
 * - **Its lightning**: a bolt every boltMs (scaled by the strength) at a body, a tree or the ground in the ring around
 *   it, placed through LightningService.strikeAt (telegraphed like every strike, `source: 'tornado'`, non-lethal).
 * - **Immune**: uniques (Tiger Girl among them), the Play the Boss body, a body in a trance, invisible GMs, the dead,
 *   anyone inside a safe area. A rider is hurt and stunned but not thrown (the horse owns the move; mounts.ts).
 * - **The end**: its walk ends (the path, or its life), the storm passes (a natural one), a GM stops it, or the weather
 *   is switched off: it lifts over LIFT_MS, then `tornadoEnd`.
 *
 * Later (not built): destructible Jangan walls and a siege hook `onTornado` (where it walks, when it ends) next to
 * LightningService.onStrike.
 */

export const TORNADO_USAGE = 'storm tornado [here | <player> | stop]'

/** What other modules hear of the tornado (the siege and wall hooks of a later step). */
export interface TornadoEvent {
  phase: 'warn' | 'lift' | 'end'
  tornado: Readonly<TornadoState>
}

/** Requests refused while a thrown body is in the air or getting up. */
const LOCKED: ReadonlySet<GameplayRequest | 'moveTo'> = new Set<GameplayRequest | 'moveTo'>(['moveTo', 'attack', 'useSkill', 'pickup', 'npcTalk', 'sit', 'emote', 'jump', 'mountRide', 'stallCreate', 'stallVisit'])

/** Natural spawns retry this often while no player stands out in the fields (ms). */
const RETRY_MS = 10_000
/** How often caught bodies are looked for (ms). */
const CATCH_MS = 100
const TIGER_GIRL = /^MOB_[A-Z]+_TIGERWOMAN/

const ok = (message: string, data?: unknown): GmResult => ({ ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

function r2(x: number): number {
  return Math.round(x * 100) / 100
}

type Body = Player | Mob

interface Thrown {
  landAt: number
  /** Control comes back then. */
  lockUntil: number
  damage: number
  /** The landing may take the last HP (TORNADO_LETHAL when it was caught). */
  lethal: boolean
}

/** A throw direction whose landing reaches this share of the intended distance is taken at once. */
const FAR_ENOUGH = 0.75
/** The fallback walks back from a blocked landing in steps of this (m). */
const BACK_STEP_M = 3

export class TornadoService implements GameplayModule {
  readonly name = 'tornado'
  readonly table: TornadoTable = TORNADO_TABLE
  private state: TornadoState | null = null
  private nextId = 1
  private nextPullAt = 0
  private nextCatchAt = 0
  private nextBoltAt = 0
  private nextTryAt = 0
  /** Storm events already rolled (keyed by their start). */
  private readonly decided = new Map<number, { spawn: boolean; at: number; done: boolean }>()
  private readonly thrown = new Map<number, Thrown>()
  /** No pull, no catch until then. */
  private readonly immune = new Map<number, number>()
  /** A pulled body's own destination (its walk carries on under the pull). */
  private readonly intent = new Map<number, { x: number; z: number; speed: number }>()
  /** The startedAt of the last move this module gave a body (a different one is the body's own). */
  private readonly ours = new Map<number, number>()
  /** HP the current tornado's throws already took from each body (capped at damageTotalPct). */
  private readonly taken = new Map<number, number>()
  private water: WaterIndex | null = null
  private waterState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private readonly listeners = new Set<(e: TornadoEvent) => void>()

  constructor(private readonly g: Gameplay) {}

  // ---- queries -----------------------------------------------------------------------------------------------

  /** The tornado up now (warning, on the ground or lifting), or null. */
  get current(): Readonly<TornadoState> | null {
    return this.state
  }

  /** Bodies thrown and not yet back in control. */
  get airborne(): ReadonlyMap<number, Readonly<Thrown>> {
    return this.thrown
  }

  /** The strength knob (TORNADO_STRENGTH, 0..2). */
  strength(): number {
    return Math.max(0, Math.min(2, this.g.config.tornadoStrength ?? STORM_TABLE.tornadoStrength))
  }

  /** The chance knob (TORNADO_CHANCE, 0..1); 0 in the snow season unless WINTER_TORNADO (docs/WINTER.md §4). */
  chance(): number {
    if (!this.g.winter.tornadoes(this.g.now)) return 0
    return Math.max(0, Math.min(1, this.g.config.tornadoChance ?? STORM_TABLE.tornadoChance))
  }

  /** Whether its throws can kill a body already low on HP (TORNADO_LETHAL, default on). */
  lethal(): boolean {
    return this.g.config.tornadoLethal ?? STORM_TABLE.tornadoLethal
  }

  /** Untouched by a tornado: uniques (Tiger Girl), the Play the Boss body, the dead. */
  exempt(e: Body): boolean {
    if (e.kind === 'player') return e.dead || !!e.trance || e.invisible
    return e.ai === 'dead' || e.variant === 'unique' || !!e.pilot || TIGER_GIRL.test(e.def.code)
  }

  /** Calls `fn` at the warning, the lift and the end of every tornado. Returns the unsubscribe. */
  onTornado(fn: (e: TornadoEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ---- the world as the path sees it -----------------------------------------------------------------------------

  private safe(x: number, z: number): boolean {
    return this.g.data.inSafeArea(this.g.config.world, x, z)
  }

  /** Open outdoor ground at x/z (its height), or null: placeable, an open cell, not water. */
  private ground(x: number, z: number): number | null {
    const nav = this.g.nav
    const p = nav.place(x, z, Infinity)
    if (!p) return null
    if (nav.kind === 'mesh' && p.surface?.kind === 'terrain' && !(nav as MeshNav).terrainOpen(p.x, p.z)) return null
    if (this.water?.wet(x, z, p.y)) return null
    return Number.isFinite(p.y) ? p.y : 0
  }

  private townDist(x: number, z: number): number {
    let d = Infinity
    for (const t of this.g.data.towns) if (t.world === this.g.config.world && t.safeArea) d = Math.min(d, rectDist(x, z, t.safeArea))
    return d
  }

  /** The PathWorld of this server (tornado-path.ts). */
  pathWorld(): PathWorld {
    return { ground: (x, z) => this.ground(x, z), townDist: (x, z) => this.townDist(x, z), bounds: this.g.world.bounds }
  }

  /** Starts loading the water planes (a storm or a GM). Idempotent; asynchronous. */
  prepare(): void {
    if (this.waterState !== 'idle') return
    const c = this.g.config
    if (!c.outDir) {
      this.waterState = 'failed'
      return
    }
    this.waterState = 'loading'
    void loadWater([c.outDir, c.outOptDir ?? join(dirname(c.outDir), 'out-opt')], c.worldExport ?? c.world)
      .then(({ index, problem }) => {
        this.water = index
        this.waterState = index ? 'ready' : 'failed'
        c.log(index ? `tornado: ${index.planes} water planes` : `tornado: no water planes (${problem}); the navmesh alone keeps it out of deep water`)
      })
      .catch((e) => {
        this.waterState = 'failed'
        c.log(`tornado: water failed to load: ${(e as Error)?.message ?? e}`)
      })
  }

  /** Tests: the water planes as given. */
  setWater(w: WaterIndex | null): void {
    this.water = w
    this.waterState = 'ready'
  }

  // ---- spawning --------------------------------------------------------------------------------------------------

  /**
   * A tornado drawn to `anchor`: touchdown `dist` from it (default: TORNADO_TABLE.spawnM), the warning now, a life of
   * `lifeMs` (default: uniform in lifeMs). null when no path of at least a leg fits there.
   */
  spawn(anchor: { x: number; z: number }, now: number, opts: { dist?: number; lifeMs?: number; gm?: boolean } = {}): TornadoState | null {
    this.prepare()
    const t = this.table
    const rng = this.g.rng
    const w = this.pathWorld()
    for (let k = 0; k < 4; k++) {
      const start = pickStart(w, anchor, rng, t, opts.dist)
      if (!start) continue
      const speed = t.speedMs[0] + (t.speedMs[1] - t.speedMs[0]) * rng()
      const life = Math.max(t.minLifeMs, opts.lifeMs ?? t.lifeMs[0] + (t.lifeMs[1] - t.lifeMs[0]) * rng())
      const path = planPath(w, start, (speed * life) / 1000, rng, t)
      const len = pathLength(path)
      if (len < t.legM[0]) continue
      const touchAt = Math.round(now + t.warnMs)
      const walkMs = Math.min(life, (len / speed) * 1000)
      const area = this.g.data.zoneName(start.pos[0], start.pos[2], this.g.setup.regionOrigin)
      const s: TornadoState = {
        id: this.nextId,
        seed: Math.floor(rng() * 0x100000000) >>> 0,
        warnAt: Math.round(now),
        touchAt,
        endAt: Math.round(touchAt + walkMs),
        path: path.map((p) => [r2(p[0]), r2(p[1]), r2(p[2])] as Vec3),
        speedMs: r2(speed),
        pullM: t.pullM,
        coreM: t.coreM,
        strength: this.strength(),
      }
      if (area) s.area = area
      if (opts.gm) s.gm = true
      this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1
      this.state = s
      this.taken.clear()
      this.nextPullAt = this.nextCatchAt = touchAt
      this.nextBoltAt = touchAt + 2000
      this.g.config.log(`tornado ${s.id}: warning${area ? ` near ${area}` : ''}, touchdown at ${Math.round(s.path[0]![0])}, ${Math.round(s.path[0]![2])} in ${t.warnMs / 1000} s, ${Math.round(len)} m over ${((s.endAt - touchAt) / 60_000).toFixed(1)} min${opts.gm ? ' (GM)' : ''}`)
      this.g.world.broadcast({ t: 'tornado', tornado: s })
      this.emit({ phase: 'warn', tornado: s })
      return s
    }
    return null
  }

  /** It lifts now (early): the clients see it rise; the effects stop at once. false when there is none on the ground. */
  lift(now: number): boolean {
    const s = this.state
    if (!s || tornadoPhase(s, now) === 'lifting' || tornadoPhase(s, now) === 'gone') return false
    s.liftAt = Math.round(Math.max(now, s.warnAt))
    this.release(now)
    this.g.world.broadcast({ t: 'tornado', tornado: s })
    this.emit({ phase: 'lift', tornado: s })
    return true
  }

  private end(now: number): void {
    const s = this.state
    if (!s) return
    this.state = null
    this.taken.clear()
    this.release(now)
    this.g.world.broadcast({ t: 'tornadoEnd', id: s.id, at: Math.round(now) })
    this.emit({ phase: 'end', tornado: s })
  }

  private emit(e: TornadoEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e)
      } catch (err) {
        this.g.config.log(`tornado listener failed: ${(err as Error)?.stack ?? err}`)
      }
    }
  }

  /** Natural spawns: once per storm event, with the chance, at its seeded time, near a player out in the fields. */
  private natural(now: number): void {
    if (this.state || this.g.weather.mode === 'off') return
    const ev = this.g.storm.event(now)
    if (!ev) return
    this.prepare()
    if (now < ev.start) return
    let d = this.decided.get(ev.start)
    if (!d) {
      const r = tornadoRoll(ev.seed, this.chance(), this.table)
      d = { spawn: r.spawn, at: ev.start + r.frac * (ev.end - ev.start), done: false }
      this.decided.set(ev.start, d)
      for (const k of this.decided.keys()) if (k < now - 2 * 86_400_000) this.decided.delete(k)
    }
    if (!d.spawn || d.done || now < d.at || now < this.nextTryAt) return
    const room = ev.end - now - this.table.warnMs - 15_000
    if (room < this.table.minLifeMs) {
      d.done = true
      return
    }
    this.nextTryAt = now + RETRY_MS
    const out = [...this.g.world.players.values()].filter((p) => !p.dead && !p.trance && !p.invisible && !this.inSafe(p, now))
    if (out.length === 0) return
    const p = out[Math.min(out.length - 1, Math.floor(this.g.rng() * out.length))]!
    const at = this.g.world.positionAt(p, now)
    const life = Math.min(room, this.table.lifeMs[0] + (this.table.lifeMs[1] - this.table.lifeMs[0]) * this.g.rng())
    if (this.spawn({ x: at[0], z: at[2] }, now, { lifeMs: life })) d.done = true
  }

  private inSafe(e: Body, now: number): boolean {
    const q = this.g.world.positionAt(e, now)
    return this.safe(q[0], q[2])
  }

  // ---- module hooks ----------------------------------------------------------------------------------------------

  enter(p: Player): void {
    // the water planes load with the first player in the world, well before any tornado plans a path
    this.prepare()
    if (this.state) p.send({ t: 'tornado', tornado: this.state })
  }

  forget(p: Player): void {
    this.drop(p.id)
  }

  mobDied(m: Mob): void {
    this.drop(m.id)
  }

  /** A thrown body has no control until it is up again. */
  gate(p: Player, t: GameplayRequest | 'moveTo', now: number): Fail | null {
    const th = this.thrown.get(p.id)
    if (!th || now >= th.lockUntil || !LOCKED.has(t)) return null
    return failReason('cant_act', 'You were thrown by the tornado.')
  }

  tick(now: number): void {
    this.land(now)
    if (!this.state) {
      this.natural(now)
      return
    }
    const s = this.state
    const phase = tornadoPhase(s, now)
    if (phase === 'gone') return this.end(now)
    if (phase === 'lifting') return
    // a natural tornado goes with its storm; any goes when the weather is switched off
    if (this.g.weather.mode === 'off' || (!s.gm && !this.g.storm.event(now))) {
      this.lift(now)
      return
    }
    if (phase !== 'active' || s.strength <= 0) return
    const centre = tornadoAt(s, now).pos
    if (now >= this.nextCatchAt) {
      this.nextCatchAt = now + CATCH_MS
      this.catchAll(s, centre, now)
    }
    if (now >= this.nextPullAt) {
      this.nextPullAt = now + this.table.pullTickMs
      this.pullAll(s, centre, now)
    }
    if (now >= this.nextBoltAt) {
      const [lo, hi] = this.table.boltMs
      this.nextBoltAt = now + (lo + (hi - lo) * this.g.rng()) / Math.max(0.25, s.strength)
      this.bolt(centre, now)
    }
  }

  // ---- pull and throw --------------------------------------------------------------------------------------------

  /** Living, unexempt bodies within `r` of (x, z) outside safe areas, with their distance. */
  private bodiesNear(x: number, z: number, r: number, now: number): { e: Body; at: Vec3; d: number }[] {
    const out: { e: Body; at: Vec3; d: number }[] = []
    const add = (e: Body) => {
      if (this.exempt(e)) return
      const at = this.g.world.positionAt(e, now)
      const d = Math.hypot(at[0] - x, at[2] - z)
      if (d > r + e.radius || this.safe(at[0], at[2])) return
      out.push({ e, at, d })
    }
    for (const p of this.g.world.players.values()) add(p)
    for (const m of this.g.world.mobs.values()) add(m)
    return out
  }

  private catchAll(s: TornadoState, c: Vec3, now: number): void {
    for (const { e, d } of this.bodiesNear(c[0], c[2], s.coreM, now)) {
      if (d > s.coreM + e.radius || this.thrown.has(e.id) || (this.immune.get(e.id) ?? 0) > now) continue
      this.throwBody(s, e, c, now)
    }
  }

  /**
   * A landing for a body at `from` thrown away from `c`: per direction (the tangent first, then turning), the farthest
   * fit point of the straight navmesh walk that way (so never past a wall, nor over a town's edge); the first reaching
   * FAR_ENOUGH of its throw is taken, else the farthest found. null when none is fit.
   */
  landing(s: TornadoState, from: NavPoint, c: Vec3): NavPoint | null {
    const t = this.table
    const rng = this.g.rng
    const reach = Math.min(1.4, Math.sqrt(Math.max(0, s.strength)))
    const dx = from.x - c[0]
    const dz = from.z - c[2]
    // outward, turned the way the funnel spins (the body leaves on the tangent)
    const out = Math.hypot(dx, dz) > 0.3 ? Math.atan2(dz, dx) : rng() * Math.PI * 2
    const base = out + 0.9
    let best: NavPoint | null = null
    let bestD = 0
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const a = base + turn
      const dist = (t.throwM[0] + (t.throwM[1] - t.throwM[0]) * rng()) * reach
      const end = this.farthestLanding(s, from, c, a, dist)
      if (!end) continue
      const d = Math.hypot(end.x - from.x, end.z - from.z)
      if (d >= dist * FAR_ENOUGH) return end
      if (d > bestD) {
        best = end
        bestD = d
      }
    }
    return best
  }

  /** The farthest fit landing on the straight navmesh walk from `from` along angle `a`, at most `dist` away. */
  private farthestLanding(s: TornadoState, from: NavPoint, c: Vec3, a: number, dist: number): NavPoint | null {
    const [x, z] = this.g.world.clamp(from.x + Math.cos(a) * dist, from.z + Math.sin(a) * dist)
    const walk = this.g.nav.walk(from, x, z)
    if (!walk) return null
    const ex = walk.end.x - from.x
    const ez = walk.end.z - from.z
    const len = Math.hypot(ex, ez)
    if (!(len >= this.table.throwMinM)) return null
    // never over a town's edge: only the stretch before the first point inside a safe area
    let reach = len
    for (let d = BACK_STEP_M; d < len + BACK_STEP_M; d += BACK_STEP_M) {
      const f = Math.min(1, d / len)
      if (this.safe(from.x + ex * f, from.z + ez * f)) {
        reach = d - BACK_STEP_M
        break
      }
    }
    if (reach === len && this.fitLanding(s, from, walk.end, c)) return walk.end
    for (let d = Math.min(reach, len - BACK_STEP_M); d >= this.table.throwMinM; d -= BACK_STEP_M) {
      const f = d / len
      const px = from.x + ex * f
      const pz = from.z + ez * f
      // cheap checks first (closed or wet ground), the walk only for a likely spot
      if (!this.g.nav.canWalk(px, pz) || this.ground(px, pz) === null) continue
      const w = this.g.nav.walk(from, px, pz)
      if (w && this.fitLanding(s, from, w.end, c)) return w.end
    }
    return null
  }

  /** A landing is fit: far enough, out of the core, open ground, not water, not a town, inside the world. */
  fitLanding(s: TornadoState, from: NavPoint, end: NavPoint, c: Vec3): boolean {
    if (![end.x, end.y, end.z].every(Number.isFinite)) return false
    if (Math.hypot(end.x - from.x, end.z - from.z) < this.table.throwMinM) return false
    if (Math.hypot(end.x - c[0], end.z - c[2]) < s.coreM + 3) return false
    const [cx, cz] = this.g.world.clamp(end.x, end.z)
    if (Math.abs(cx - end.x) > 0.01 || Math.abs(cz - end.z) > 0.01) return false
    if (this.safe(end.x, end.z) || !this.g.nav.canWalk(end.x, end.z)) return false
    if (this.water?.wet(end.x, end.z, end.y)) return false
    return true
  }

  private throwBody(s: TornadoState, e: Body, c: Vec3, now: number): void {
    const t = this.table
    const w = this.g.world
    const lethal = this.lethal()
    const damage = throwDamage(e.hp, e.maxHp, s.strength, t, { taken: this.taken.get(e.id) ?? 0, lethal })
    if (damage > 0) this.taken.set(e.id, (this.taken.get(e.id) ?? 0) + damage)
    const riding = e.kind === 'player' && !!this.g.mounts.ridden(e)
    const from = w.livePoint(e, now)
    const end = riding ? null : this.landing(s, from, c)
    this.intent.delete(e.id)
    this.ours.delete(e.id)
    if (!end) {
      // a rider, or nowhere fit to land: spun in place, hurt, stunned a moment
      this.g.skills.applyHazardStatus(e, 'stun', t.lockMs, now)
      this.thrown.set(e.id, { landAt: now, lockUntil: now + t.lockMs, damage, lethal })
      this.immune.set(e.id, now + t.immuneMs)
      this.land(now)
      return
    }
    const dist = Math.hypot(end.x - from.x, end.z - from.z)
    const k = Math.max(0, Math.min(1, (dist - t.throwM[0]) / Math.max(1, t.throwM[1] - t.throwM[0])))
    const ms = Math.round(t.throwMs[0] + (t.throwMs[1] - t.throwMs[0]) * k)
    const peakM = r2(t.throwPeakM[0] + (t.throwPeakM[1] - t.throwPeakM[0]) * k)
    // knocked down for the flight and the getting up (halts whatever it was doing), then the flight itself
    this.g.skills.applyHazardStatus(e, 'knockdown', ms + t.lockMs, now)
    if (e.kind === 'mob') {
      e.target = null
      if (e.ai === 'chase') e.ai = 'idle'
    } else e.action = null
    const moved = w.walkEntity(e, end.x, end.z, dist / (ms / 1000), now)
    if (moved && e.move) {
      this.ours.set(e.id, e.move.startedAt)
      const msg: ServerMessage = { t: 'displace', id: e.id, kind: 'throw', from: [r2(from.x), r2(from.y), r2(from.z)], to: [...e.move.to], at: Math.round(now), ms, peakM, tornado: s.id }
      w.broadcastAbout(e, msg)
    }
    this.thrown.set(e.id, { landAt: now + ms, lockUntil: now + ms + t.lockMs, damage, lethal })
    this.immune.set(e.id, now + ms + t.immuneMs)
  }

  /**
   * Thrown bodies that came down take their damage (it kills one already low only when it was lethal: the normal death
   * path, nobody's kill, loot only when a player had fought the monster); control comes back after lockMs.
   */
  private land(now: number): void {
    for (const [id, th] of this.thrown) {
      if (th.damage > 0 && now >= th.landAt) {
        const e = this.g.world.players.get(id) ?? this.g.world.mobs.get(id)
        const dmg = th.damage
        th.damage = 0
        if (e && !this.exempt(e)) this.g.hazardHit(e, dmg, 'tornado', now, undefined, !th.lethal)
      }
      if (now >= th.lockUntil) this.thrown.delete(id)
    }
    for (const [id, until] of this.immune) if (until <= now) this.immune.delete(id)
  }

  /** The drift of every body in the pull radius (their own walk carries on), and the walk given back to those leaving. */
  private pullAll(s: TornadoState, c: Vec3, now: number): void {
    const w = this.g.world
    const stepS = (this.table.pullTickMs / 1000) * 1.25
    const seen = new Set<number>()
    for (const { e } of this.bodiesNear(c[0], c[2], s.pullM, now)) {
      if (this.thrown.has(e.id) || (this.immune.get(e.id) ?? 0) > now) continue
      if (e.kind === 'player' && this.g.mounts.ridden(e)) continue
      if (e.kind === 'mob' && this.g.skills.held(e, now)) continue
      const L = w.livePoint(e, now)
      const dx = L.x - c[0]
      const dz = L.z - c[2]
      if (Math.hypot(dx, dz) >= s.pullM) continue
      seen.add(e.id)
      // the body's own walk: a move this module did not give it
      if (e.move && this.ours.get(e.id) !== e.move.startedAt) this.intent.set(e.id, { x: e.move.to[0], z: e.move.to[2], speed: e.move.speed })
      else if (!e.move && !this.ours.has(e.id)) this.intent.delete(e.id)
      const goal = this.intent.get(e.id)
      let vx = 0
      let vz = 0
      if (goal) {
        const gd = Math.hypot(goal.x - L.x, goal.z - L.z)
        if (gd < 0.5) this.intent.delete(e.id)
        else {
          vx = ((goal.x - L.x) / gd) * goal.speed
          vz = ((goal.z - L.z) / gd) * goal.speed
        }
      }
      const [px, pz] = pullVelocity(dx, dz, s.strength, this.table)
      vx += px
      vz += pz
      const speed = Math.hypot(vx, vz)
      if (speed < 0.2) continue
      const [tx, tz] = w.clamp(L.x + vx * stepS, L.z + vz * stepS)
      if (this.safe(tx, tz)) continue
      const walk = this.g.nav.walk(L, tx, tz)
      if (!walk || this.water?.wet(walk.end.x, walk.end.z, walk.end.y)) continue
      const moved = w.walkEntity(e, tx, tz, speed, now)
      if (!moved || !e.move) {
        this.ours.delete(e.id)
        continue
      }
      this.ours.set(e.id, e.move.startedAt)
      if (!this.intent.has(e.id)) {
        const len = Math.hypot(e.move.to[0] - L.x, e.move.to[2] - L.z)
        const msg: ServerMessage = { t: 'displace', id: e.id, kind: 'pull', from: [r2(L.x), r2(L.y), r2(L.z)], to: [...e.move.to], at: Math.round(now), ms: Math.max(1, Math.round((len / speed) * 1000)), tornado: s.id }
        w.broadcastAbout(e, msg)
      }
    }
    // the ones that left the pull (or are no longer pulled): their own walk back, or a stop where they are
    for (const id of [...this.ours.keys()]) {
      if (seen.has(id) || this.thrown.has(id)) continue
      this.giveBack(id, now)
    }
  }

  /** A body this module no longer moves: back to its own destination, if it had one. */
  private giveBack(id: number, now: number): void {
    const goal = this.intent.get(id)
    this.intent.delete(id)
    this.ours.delete(id)
    const e = this.g.world.players.get(id) ?? this.g.world.mobs.get(id)
    if (!e || !goal || this.exempt(e) || this.g.skills.held(e, now)) return
    const at = this.g.world.positionAt(e, now)
    if (Math.hypot(goal.x - at[0], goal.z - at[2]) >= 0.5) this.g.world.walkEntity(e, goal.x, goal.z, goal.speed, now)
  }

  /** Every pulled body goes back to its own walk (the tornado lifted or left). */
  private release(now: number): void {
    for (const id of [...this.ours.keys()]) if (!this.thrown.has(id)) this.giveBack(id, now)
  }

  private drop(id: number): void {
    this.thrown.delete(id)
    this.immune.delete(id)
    this.intent.delete(id)
    this.ours.delete(id)
    this.taken.delete(id)
  }

  // ---- its lightning ---------------------------------------------------------------------------------------------

  /** One bolt in the ring around the funnel: at a body, a tree or the ground (a telegraphed, non-lethal strike). */
  private bolt(c: Vec3, now: number): void {
    const t = this.table
    const rng = this.g.rng
    const [lo, hi] = t.boltRingM
    let target: StrikeTarget | null = null
    if (rng() < t.boltBodyShare) {
      const ring = this.bodiesNear(c[0], c[2], hi, now).filter((b) => b.d >= lo * 0.5)
      if (ring.length) {
        const b = ring[Math.min(ring.length - 1, Math.floor(rng() * ring.length))]!
        target = { kind: 'entity', x: b.at[0], y: b.at[1], z: b.at[2], ground: b.at[1], radiusM: STRIKE_RADIUS_M.entity, target: b.e.id }
      }
    }
    if (!target && rng() < 0.4) {
      const trees = (this.g.lightning.rodIndex?.near(c[0], c[2], hi) ?? []).filter((r) => r.kind === 'tree' && Math.hypot(r.x - c[0], r.z - c[2]) >= lo && !this.safe(r.x, r.z))
      const tree = trees.length ? trees[Math.min(trees.length - 1, Math.floor(rng() * trees.length))]! : null
      if (tree) target = { kind: 'tree', x: tree.x, y: tree.y, z: tree.z, ground: tree.ground, radiusM: STRIKE_RADIUS_M.tree }
    }
    for (let k = 0; !target && k < 6; k++) {
      const a = rng() * Math.PI * 2
      const d = lo + (hi - lo) * Math.sqrt(rng())
      const [x, z] = this.g.world.clamp(c[0] + Math.cos(a) * d, c[2] + Math.sin(a) * d)
      if (this.safe(x, z)) continue
      const y = goodPoint({ ground: (gx, gz) => this.ground(gx, gz), townDist: () => Infinity, bounds: null }, x, z, { ...t, townMarginM: 0, edgeMarginM: 0 })
      if (y === null) continue
      target = { kind: 'ground', x, y, z, ground: y, radiusM: STRIKE_RADIUS_M.ground }
    }
    if (target) this.g.lightning.strikeAt(target, now, { nonLethal: true, source: 'tornado' })
  }

  // ---- GM (`storm tornado ...`) -----------------------------------------------------------------------------------

  gm(args: string[], now: number, self: Player | null): GmResult {
    const a = (args[0] ?? '').toLowerCase()
    if (args.length > 1) return fail(`Usage: ${TORNADO_USAGE}`)
    if (a === 'stop') {
      const s = this.state
      if (!s) return fail('No tornado is up.')
      if (tornadoPhase(s, now) === 'lifting') return fail('The tornado is already lifting.')
      this.lift(now)
      return ok(`Tornado ${s.id}: lifting now (gone in ${Math.round((s.liftAt! + LIFT_MS - now) / 1000)} s).`)
    }
    if (this.g.weather.mode === 'off') return fail('Weather is off on this server (WEATHER=off): no tornadoes.')
    if (this.state) return fail(`A tornado is already up (${this.describe(now)}). \`storm tornado stop\` first.`)
    let anchor: Player | null = self
    let dist: number | undefined
    if (a === 'here') {
      if (!self) return fail('`storm tornado here` needs your character in the world.')
      dist = 0
    } else if (a !== '') {
      anchor = this.g.world.byName(args[0]!)
      if (!anchor || anchor.dead) return fail(`No living player named ${args[0]} is in the world.`)
    }
    if (!anchor) return fail('`storm tornado` needs your character in the world, or a player name.')
    const at = this.g.world.positionAt(anchor, now)
    const s = this.spawn({ x: at[0], z: at[2] }, now, { dist, gm: true })
    if (!s) return fail(`No open ground for a tornado ${dist === 0 ? 'here' : `${TORNADO_TABLE.spawnM[0]}-${TORNADO_TABLE.spawnM[1]} m from ${anchor === self ? 'you' : anchor.name}`} (it keeps ${TORNADO_TABLE.townMarginM} m from towns, off water and inside the world).`)
    const p0 = s.path[0]!
    const away = Math.round(Math.hypot(p0[0] - at[0], p0[2] - at[2]))
    const storm = this.g.storm.event(now) ? '' : ' (no storm is raging: it comes anyway)'
    return ok(`Tornado ${s.id}: touches down in ${Math.round((s.touchAt - now) / 1000)} s at ${Math.round(p0[0])}, ${Math.round(p0[2])} (${away} m from ${anchor === self ? 'you' : anchor.name})${s.area ? `, ${s.area}` : ''}; walks ${Math.round(pathLength(s.path))} m over ${((s.endAt - s.touchAt) / 60_000).toFixed(1)} min${storm}.`, s)
  }

  describe(now: number): string {
    const s = this.state
    if (!s) return `no tornado (chance ${Math.round(this.chance() * 100)}% per storm, strength ${this.strength()})`
    const at = tornadoAt(s, now)
    return `tornado ${s.id} ${at.phase} at ${Math.round(at.pos[0])}, ${Math.round(at.pos[2])}${s.area ? ` (${s.area})` : ''}, ${this.thrown.size} airborne`
  }
}
