import { dirname, join } from 'node:path'
import {
  LIGHTNING_GM_DIST_M,
  STRIKE_RADIUS_M,
  STRIKE_VERTICAL_M,
  telegraphMs,
  type HazardCause,
  type LightningStrike,
  type ServerMessage,
  type SkillStatusKind,
  type StrikeSource,
  type Vec3,
} from '@sro/shared'
import type { ServerConfig } from '../config.ts'
import type { GmResult } from '../gm.ts'
import type { GameplayModule } from '../modules.ts'
import type { StrikeSink } from '../weather.ts'
import type { Mob, Player } from '../world.ts'
import { STRIKE_STUN_MS, strikeDamage } from './damage.ts'
import { loadRods, type RodIndex, type RodKind } from './rods.ts'
import { CLOSE_M, CLOSE_SHARE, NEAR_M, pickFar, pickNear, pickSky, strikeClass, type Body, type StrikeTarget } from './select.ts'

/**
 * Lightning that strikes (docs/WEATHER.md §2.7). A GameplayModule named `lightning` and the weather's StrikeSink:
 *
 * - **Rolls**: the weather keeps its Poisson roll at the blended rate (storm 5 a minute; heavy rain 0.3 × intensity),
 *   scaled here by the players in the world (√n, 1..3), at least 4 s apart. Each roll anchors on a random living player
 *   and is a sky flash, a near strike or a far one (select.ts).
 * - **Telegraph**: a strike that can hurt is sent as `strike` (to every player in the world, and to anyone entering
 *   while it is pending) STRIKE_TELEGRAPH_MS (1.2–1.8 s, seeded) before it lands: the client crackles and glows on the
 *   spot. The spot is fixed then; whoever stands in the radius when it lands is hit, whoever stepped out is not.
 * - **Landing**: every living player and monster whose feet lie within the radius (plus its own radius) of the strike's
 *   ground point and within STRIKE_VERTICAL_M of its height, outside a safe area, takes strikeDamage (damage.ts) through
 *   Gameplay.hazardHit (the combat path: shields, `combat` with `cause: 'lightning'`, deaths, kill credit, the modules'
 *   hooks) and a short stun.
 * - **Older clients**: each strike also goes to each player as the old `lightning {at, distM, bearing}` with its own
 *   distance and bearing (and the strike's id, which a newer client uses to skip it), so they still flash and thunder.
 * - **Events**: `onStrike(fn)` tells other modules about every strike, at the telegraph ('warn') and when it lands
 *   ('land', with the hits): the hook for the storm series (monsters reacting, a tornado, destructible walls).
 */

/** Other modules' view of a strike. */
export interface StrikeHit {
  id: number
  kind: 'player' | 'mob'
  damage: number
  killed: boolean
}

export interface StrikeEvent {
  phase: 'warn' | 'land'
  strike: Readonly<LightningStrike>
  /** Who it hit ('land' only). */
  hits: readonly StrikeHit[]
}

/** What the module needs of Gameplay (tests pass a stand-in). */
export interface LightningHost {
  config: Pick<ServerConfig, 'world' | 'outDir' | 'outOptDir' | 'worldExport' | 'log'>
  world: {
    players: ReadonlyMap<number, Player>
    mobs: ReadonlyMap<number, Mob>
    positionAt(p: { pos: Vec3; move?: Player['move'] }, now: number): Vec3
    clamp(x: number, z: number): [number, number]
    byName(name: string): Player | null
  }
  nav: { readonly kind: 'flat' | 'mesh'; heightAt(x: number, z: number, yHint?: number): number | null }
  data: { inSafeArea(world: string, x: number, z: number): boolean }
  rng: () => number
  hazardHit(t: Player | Mob, damage: number, cause: HazardCause, now: number, strike?: number, nonLethal?: boolean): { dealt: number; killed: boolean }
  skills: { applyHazardStatus(t: Player | Mob, status: SkillStatusKind, durationMs: number, now: number): void }
}

export const LIGHTNING_STRIKE_USAGE = 'weather strike [here | sky | tree | wall | tower | <100-3000 m> | at <x> <z> | <player>]'

/** Players in the world scale the strike rate by √n, between these. */
export const RATE_SCALE = [1, 3] as const
/** Prominence: a body's feet against the mean ground this far around it (m). */
export const PROMINENCE_M = 15
/** GM `tree` / `wall` / `tower`: the nearest one within this (m). */
const GM_ROD_M = 400
const TAU = Math.PI * 2

const ok = (message: string, data?: unknown): GmResult => ({ ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

function r2(x: number): number {
  return Math.round(x * 100) / 100
}

export class LightningService implements GameplayModule, StrikeSink {
  readonly name = 'lightning'
  private rods: RodIndex | null = null
  private rodsState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private readonly pending: LightningStrike[] = []
  /** Pending strikes that never kill (a tornado's bolts): the ids. */
  private readonly nonLethal = new Set<number>()
  private nextId = 1
  private readonly listeners = new Set<(e: StrikeEvent) => void>()
  /**
   * Siege of Jangan (docs/SIEGE.md §2.5): false for a wall-walk rod whose wall is down (a breached third has no top),
   * so a strike there lands as ground. Set by the walls module; null: every rod stands.
   */
  wallRodUp: ((x: number, z: number) => boolean) | null = null

  constructor(
    private readonly g: LightningHost,
    opts: { rods?: RodIndex | null } = {},
  ) {
    if (opts.rods !== undefined) {
      this.rods = opts.rods
      this.rodsState = 'ready'
    }
  }

  // ---- events (the storm series builds on these) ---------------------------------------------------------

  /** Calls `fn` at every strike's telegraph and landing. Returns the unsubscribe. */
  onStrike(fn: (e: StrikeEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Strikes telegraphed and not landed yet (oldest first). */
  get pendingStrikes(): readonly Readonly<LightningStrike>[] {
    return this.pending
  }

  /** The rods once loaded (null before, or without a world export). */
  get rodIndex(): RodIndex | null {
    return this.rods
  }

  private emit(e: StrikeEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e)
      } catch (err) {
        this.g.config.log(`lightning listener failed: ${(err as Error)?.stack ?? err}`)
      }
    }
  }

  // ---- StrikeSink (weather.ts) ---------------------------------------------------------------------------

  /** √(living players), 1..3: more players spread over the world see about as many strikes each. */
  rateScale(): number {
    let n = 0
    for (const p of this.g.world.players.values()) if (!p.dead) n++
    return Math.min(RATE_SCALE[1], Math.max(RATE_SCALE[0], Math.sqrt(n)))
  }

  /** Starts loading the rods (a storm is coming, or a GM strikes). Idempotent; asynchronous. */
  prepare(): void {
    if (this.rodsState !== 'idle') return
    const c = this.g.config
    if (!c.outDir) {
      this.rodsState = 'failed'
      return
    }
    this.rodsState = 'loading'
    const dirs = [c.outDir, c.outOptDir ?? join(dirname(c.outDir), 'out-opt')]
    const nav = this.g.nav
    const topAt = (x: number, z: number) => (nav.kind === 'mesh' ? nav.heightAt(x, z, Infinity) : null)
    void loadRods(dirs, c.worldExport ?? c.world, topAt)
      .then(({ index, problem }) => {
        this.rods = index
        this.rodsState = index ? 'ready' : 'failed'
        if (index) c.log(`lightning: ${index.counts.tree} trees, ${index.counts.wall} wall points, ${index.counts.tower} towers as rods`)
        else c.log(`lightning: no rods (${problem}); strikes pick the ground and bodies only`)
      })
      .catch((e) => {
        this.rodsState = 'failed'
        c.log(`lightning: rods failed to load: ${(e as Error)?.message ?? e}`)
      })
  }

  /** The weather rolled a strike: place one around a random living player. false = nobody to anchor on. */
  roll(now: number): boolean {
    this.prepare()
    const anchors = [...this.g.world.players.values()].filter((p) => !p.dead)
    if (anchors.length === 0) return false
    const rng = this.g.rng
    const a = anchors[Math.min(anchors.length - 1, Math.floor(rng() * anchors.length))]!
    const at = this.g.world.positionAt(a, now)
    const cls = strikeClass(rng())
    let t: StrikeTarget | null = null
    if (cls === 'near') t = this.near(at, rng() < CLOSE_SHARE ? CLOSE_M : NEAR_M, now)
    else if (cls === 'far') t = pickFar({ anchor: { x: at[0], z: at[2] }, ground: this.groundAt, safe: this.safeAt, rng, clamp: (x, z) => this.g.world.clamp(x, z) })
    this.place(t ?? pickSky({ x: at[0], y: at[1], z: at[2] }, rng), now)
    return true
  }

  // ---- GM (`weather strike ...`) --------------------------------------------------------------------------

  gm(args: string[], self: Player | null, now: number): GmResult {
    this.prepare()
    const a = (args[0] ?? '').toLowerCase()
    const usage = fail(`Usage: ${LIGHTNING_STRIKE_USAGE}`)
    const me = self ? this.g.world.positionAt(self, now) : null
    const anchor = me ?? this.anyPlayer(now)
    let t: StrikeTarget | null = null
    if (args.length === 0) {
      if (!anchor) return fail('Nobody is in the world to strike near.')
      t = this.near(anchor, NEAR_M, now) ?? pickSky({ x: anchor[0], y: anchor[1], z: anchor[2] }, this.g.rng)
    } else if (a === 'here') {
      if (!self || !me || args.length !== 1) return fail('`weather strike here` needs your character in the world.')
      t = { kind: 'entity', x: me[0], y: me[1], z: me[2], ground: me[1], radiusM: STRIKE_RADIUS_M.entity, target: self.id }
    } else if (a === 'sky') {
      if (!anchor || args.length !== 1) return anchor ? usage : fail('Nobody is in the world to flash near.')
      t = pickSky({ x: anchor[0], y: anchor[1], z: anchor[2] }, this.g.rng)
    } else if (a === 'tree' || a === 'wall' || a === 'tower') {
      if (!me || args.length !== 1) return fail(`\`weather strike ${a}\` needs your character in the world.`)
      if (!this.rods) return fail(this.rodsState === 'loading' ? 'The lightning rods are still loading; try again in a moment.' : 'No lightning rods in this world export.')
      const rod = this.rods.nearest(me[0], me[2], GM_ROD_M, a as RodKind)
      if (!rod) return fail(`No ${a} within ${GM_ROD_M} m.`)
      t = { kind: rod.kind, x: rod.x, y: rod.y, z: rod.z, ground: rod.ground, radiusM: STRIKE_RADIUS_M[rod.kind] }
    } else if (a === 'at') {
      const x = Number(args[1])
      const z = Number(args[2])
      if (args.length !== 3 || !Number.isFinite(x) || !Number.isFinite(z)) return usage
      const [cx, cz] = this.g.world.clamp(x, z)
      const y = this.groundAt(cx, cz) ?? me?.[1] ?? 0
      t = { kind: 'ground', x: cx, y, z: cz, ground: y, radiusM: STRIKE_RADIUS_M.ground }
    } else if (/^\d+(\.\d+)?$/.test(a)) {
      const d = Number(a)
      if (args.length !== 1 || d < LIGHTNING_GM_DIST_M[0] || d > LIGHTNING_GM_DIST_M[1]) return fail(`Usage: weather strike [${LIGHTNING_GM_DIST_M[0]}-${LIGHTNING_GM_DIST_M[1]} metres]`)
      if (!anchor) return fail('Nobody is in the world to strike near.')
      t = pickFar({ anchor: { x: anchor[0], z: anchor[2] }, ground: this.groundAt, safe: this.safeAt, rng: this.g.rng, clamp: (x, z) => this.g.world.clamp(x, z) }, d)
      if (!t) return fail(`No open ground ${Math.round(d)} m from ${me ? 'you' : 'the players'} inside the world.`)
    } else {
      if (args.length !== 1) return usage
      const p = this.g.world.byName(args[0]!)
      if (!p || p.dead) return fail(`No living player named ${args[0]} is in the world.`)
      const q = this.g.world.positionAt(p, now)
      t = { kind: 'entity', x: q[0], y: q[1], z: q[2], ground: q[1], radiusM: STRIKE_RADIUS_M.entity, target: p.id }
    }
    const s = this.place(t, now)
    const where = `${s.kind} at ${Math.round(s.pos[0])}, ${Math.round(s.pos[2])}`
    const dist = me ? Math.round(Math.hypot(s.pos[0] - me[0], s.pos[2] - me[2])) : null
    const lands = s.warnAt !== undefined ? `, lands in ${((s.at - now) / 1000).toFixed(1)} s` : ''
    const harmless = s.radiusM === 0 && s.kind !== 'sky' ? ' (a safe area: harmless)' : ''
    return ok(`Weather: lightning, ${where}${dist !== null ? ` (${dist} m away)` : ''}${lands}${harmless}.`, s)
  }

  /**
   * A strike another module aims (a tornado's bolts, docs/WEATHER.md §13): placed, telegraphed and landed like the
   * weather's own. `nonLethal`: every hit leaves the body at least 1 HP. `source` goes out on the wire.
   */
  strikeAt(t: StrikeTarget, now: number, opts: { nonLethal?: boolean; source?: StrikeSource } = {}): LightningStrike {
    this.prepare()
    return this.place(t, now, opts)
  }

  // ---- module hooks ----------------------------------------------------------------------------------------

  /** A player entering while strikes are telegraphed sees them too. */
  enter(p: Player, now: number): void {
    for (const s of this.pending) if (s.at > now) p.send({ t: 'strike', strike: s })
  }

  tick(now: number): void {
    while (this.pending.length && this.pending[0]!.at <= now) this.land(this.pending.shift()!, now)
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private readonly groundAt = (x: number, z: number): number | null => {
    const y = this.g.nav.heightAt(x, z)
    return y === null || !Number.isFinite(y) ? (this.g.nav.kind === 'flat' ? 0 : null) : y
  }

  private readonly safeAt = (x: number, z: number): boolean => this.g.data.inSafeArea(this.g.config.world, x, z)

  private anyPlayer(now: number): Vec3 | null {
    for (const p of this.g.world.players.values()) if (!p.dead) return this.g.world.positionAt(p, now)
    return null
  }

  /** The bodies (players, monsters) around (x, z) that a near strike may aim at. */
  private bodies(x: number, z: number, r: number, now: number): Body[] {
    const out: Body[] = []
    const add = (id: number, pos: Vec3, height: number) => {
      if ((pos[0] - x) ** 2 + (pos[2] - z) ** 2 > r * r) return
      out.push({ id, x: pos[0], y: pos[1], z: pos[2], height, prominence: this.prominence(pos) })
    }
    for (const p of this.g.world.players.values()) if (!p.dead && !p.trance && !p.invisible) add(p.id, this.g.world.positionAt(p, now), 1.8)
    for (const m of this.g.world.mobs.values()) if (m.ai !== 'dead') add(m.id, this.g.world.positionAt(m, now), Math.min(6, Math.max(1, m.radius * 2)))
    return out
  }

  /** How far `pos` stands above the mean ground PROMINENCE_M around it (0 where that is unknown or higher). */
  private prominence(pos: Vec3): number {
    let sum = 0
    let n = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const y = this.g.nav.heightAt(pos[0] + dx * PROMINENCE_M, pos[2] + dz * PROMINENCE_M, -Infinity)
      if (y === null || !Number.isFinite(y)) continue
      sum += y
      n++
    }
    return n ? Math.max(0, pos[1] - sum / n) : 0
  }

  private near(at: Vec3, within: number, now: number): StrikeTarget | null {
    return pickNear({
      anchor: { x: at[0], z: at[2] },
      rods: (this.rods?.near(at[0], at[2], within) ?? []).filter((r) => r.kind !== 'wall' || !this.wallRodUp || this.wallRodUp(r.x, r.z)),
      bodies: this.bodies(at[0], at[2], within, now),
      ground: this.groundAt,
      safe: this.safeAt,
      rng: this.g.rng,
      within,
    })
  }

  /** Sends a strike: its telegraph now (or, for a sky flash, the flash itself), and queues its landing. */
  private place(t: StrikeTarget, now: number, opts: { nonLethal?: boolean; source?: StrikeSource } = {}): LightningStrike {
    const seed = Math.floor(this.g.rng() * 0x100000000) >>> 0
    const id = this.nextId
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1
    const sky = t.kind === 'sky'
    // a strike whose ground point lies in a safe area cannot hurt (a GM's strike on the plaza): no telegraph radius
    const radiusM = sky || this.safeAt(t.x, t.z) ? 0 : t.radiusM
    const s: LightningStrike = { id, at: sky ? now : now + telegraphMs(seed), kind: t.kind, pos: [r2(t.x), r2(t.y), r2(t.z)], radiusM, seed }
    if (!sky) s.warnAt = now
    if (Math.abs(t.ground - t.y) > 0.01) s.groundY = r2(t.ground)
    if (t.target !== undefined) s.target = t.target
    if (opts.source) s.source = opts.source
    if (opts.nonLethal && !sky) this.nonLethal.add(id)
    for (const p of this.g.world.players.values()) {
      p.send({ t: 'strike', strike: s })
      p.send(this.legacy(s, p, now))
    }
    this.emit({ phase: 'warn', strike: s, hits: [] })
    if (sky) this.emit({ phase: 'land', strike: s, hits: [] })
    else {
      this.pending.push(s)
      this.pending.sort((x, y) => x.at - y.at)
    }
    return s
  }

  /** The old `lightning` of a strike for one player: its own distance (100..3000 m) and bearing (0 = east, π/2 = north). */
  private legacy(s: LightningStrike, p: Player, now: number): ServerMessage {
    const at = this.g.world.positionAt(p, now)
    const dx = s.pos[0] - at[0]
    const dz = s.pos[2] - at[2]
    const distM = Math.round(Math.min(LIGHTNING_GM_DIST_M[1], Math.max(LIGHTNING_GM_DIST_M[0], Math.hypot(dx, dz))))
    const b = (((Math.atan2(-dz, dx) % TAU) + TAU) % TAU)
    return { t: 'lightning', at: s.at, distM, bearing: Math.min(TAU, Math.floor(b * 1e4) / 1e4), strike: s.id }
  }

  /** The bolt lands: every body in the radius is hit (outside safe areas), then the listeners hear of it. */
  private land(s: LightningStrike, now: number): void {
    const hits: StrikeHit[] = []
    const nonLethal = this.nonLethal.delete(s.id)
    if (s.radiusM > 0) {
      const gx = s.pos[0]
      const gz = s.pos[2]
      const gy = s.groundY ?? s.pos[1]
      const inRadius = (pos: Vec3, radius: number): number | null => {
        const d = Math.hypot(pos[0] - gx, pos[2] - gz)
        // a tree or a tower is struck at its top; the bodies under it stand around its foot
        const y = s.kind === 'wall' ? s.pos[1] : gy
        if (d > s.radiusM + radius || Math.abs(pos[1] - y) > STRIKE_VERTICAL_M) return null
        return this.safeAt(pos[0], pos[2]) ? null : Math.max(0, d - radius)
      }
      const struck: { e: Player | Mob; d: number }[] = []
      for (const p of this.g.world.players.values()) {
        if (p.dead || p.trance || p.invisible) continue
        const d = inRadius(this.g.world.positionAt(p, now), p.radius)
        if (d !== null) struck.push({ e: p, d })
      }
      for (const m of this.g.world.mobs.values()) {
        if (m.ai === 'dead') continue
        const d = inRadius(this.g.world.positionAt(m, now), m.radius)
        if (d !== null) struck.push({ e: m, d })
      }
      for (const { e, d } of struck) {
        const r = strikeDamage({ kind: e.kind, hp: e.hp, maxHp: e.maxHp, level: e.level, variant: e.kind === 'mob' ? e.variant : undefined, piloted: e.kind === 'mob' && !!e.pilot }, d, s.radiusM)
        if (r.damage <= 0) continue
        const h = this.g.hazardHit(e, r.damage, 'lightning', now, s.id, nonLethal)
        if (h.dealt <= 0 && !h.killed) continue
        hits.push({ id: e.id, kind: e.kind, damage: h.dealt, killed: h.killed })
        if (!h.killed && r.stun) this.g.skills.applyHazardStatus(e, 'stun', STRIKE_STUN_MS, now)
      }
    }
    this.emit({ phase: 'land', strike: s, hits })
  }
}
