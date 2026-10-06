import type Database from 'better-sqlite3'
import { WINTER_PLAY, snowballFlightMs, snowballPeakM, type GameplayRequest, type ServerMessage, type Vec3, type WinterBoard } from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Mob, Player } from '../world.ts'
import type { WinterPlay } from './service.ts'

/**
 * Snowball fights (docs/WINTER.md §13.2). A GameplayModule named `snowballs` that answers `snowball` and `winterBoard`:
 *
 * - A player scoops and throws when the winter layer is on and the snow lies deep enough (SNOWBALL_COVER), at a target
 *   in sight (a player or a monster) or at a point on the ground, at most 20 m (a farther point falls short), once per
 *   1.2 s. Refused while riding. Works in towns.
 * - The flight is `snowballFlightMs` long and drawn as an arc by everyone who sees the thrower or the target. At the
 *   landing a target that moved more than 2.5 m from where it stood dodged it (the snowball splats on the ground); a
 *   ground throw splats anyone within 1.2 m of the point.
 * - A hit player: never damage, just a 1.5 s slow (SNOWBALL_SLOW_PCT) and a "Splat!". A hit monster takes 1 damage and
 *   turns on the thrower (not from inside a town).
 * - Stats per character and winter (migration 16, winter_stats): hits, thrown, hit by. The board: the top 10 by hits.
 */

export const SNOWBALL_USAGE = 'snowball [test [seconds] | stats [player] | reset]'

/** The thrower's hand and a body's chest, above the feet (m). */
const HAND_Y = 1.6
const CHEST_Y = 1.1

interface Flight {
  id: number
  thrower: number
  throwerChar: number
  from: Vec3
  to: Vec3
  target: number | null
  /** Where the target stood at the throw (its dodge is measured from here). */
  stood: Vec3 | null
  landAt: number
  big: boolean
  /** A ground throw splats anyone within this of the point (m). */
  radiusM: number
}

interface StatRow {
  hits: number
  thrown: number
  hit_by: number
}

export class SnowballService implements GameplayModule {
  readonly name = 'snowballs'
  readonly handles: readonly GameplayRequest[] = ['snowball', 'winterBoard']
  private readonly flights = new Map<number, Flight>()
  private readonly ready = new Map<number, number>()
  private nextId = 1
  /** GM `snowball test`: snowballs allowed without the season or the snow until this server ms. */
  testUntil = 0
  private stmts: {
    get: Database.Statement<[number, string], StatRow>
    bump: Database.Statement<{ character_id: number; season: string; hits: number; thrown: number; hit_by: number; gifts: number; at: number }>
    top: Database.Statement<[string, number], { name: string; hits: number }>
    rank: Database.Statement<[string, number], { n: number }>
    reset: Database.Statement<[string]>
  } | null = null

  constructor(
    private readonly g: Gameplay,
    private readonly play: WinterPlay,
  ) {}

  /** Whether snowballs can be scooped now (the layer on and the snow deep enough, or a GM test). */
  allowed(now: number): boolean {
    return now < this.testUntil || (this.play.isOn && this.play.snowDeep(now))
  }

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t === 'winterBoard') {
      answer(true)
      p.send({ t: 'winterBoard', board: this.board(p, now) })
      return
    }
    if (msg.t !== 'snowball') return answer(fail('not_found'))
    if (!(now < this.testUntil) && !this.play.isOn) return answer(fail('not_usable', 'Snowballs are only for the snow season.'))
    if (!this.allowed(now)) return answer(fail('not_usable', 'The snow is not deep enough for a snowball.'))
    const riding = this.g.mounts.refuse(p, 'attack')
    if (riding) return answer(riding)
    if ((this.ready.get(p.id) ?? 0) > now) return answer(fail('cooldown'))
    const S = WINTER_PLAY.snowball
    const at = this.g.world.livePoint(p, now)
    const from: Vec3 = [at.x, at.y + HAND_Y, at.z]
    let to: Vec3
    let target: Player | Mob | null = null
    if (msg.target !== undefined) {
      const e = this.g.world.entity(msg.target)
      if (!e || !p.known.has(e.id) || e.id === p.id) return answer(fail('not_found'))
      if (e.kind !== 'player' && e.kind !== 'mob') return answer(fail('invalid_target'))
      if (e.kind === 'player' ? e.dead || e.trance || (e.invisible && !p.staff) : e.ai === 'dead') return answer(fail('invalid_target'))
      const q = this.g.world.livePoint(e, now)
      if (Math.hypot(q.x - at.x, q.z - at.z) > S.rangeM) return answer(fail('too_far'))
      target = e
      to = [q.x, q.y + CHEST_Y, q.z]
    } else {
      let dx = (msg.x ?? at.x) - at.x
      let dz = (msg.z ?? at.z) - at.z
      const d = Math.hypot(dx, dz)
      if (d > S.rangeM) {
        dx *= S.rangeM / d
        dz *= S.rangeM / d
      }
      const [x, z] = this.g.world.clamp(at.x + dx, at.z + dz)
      const w = this.g.nav.kind === 'mesh' ? this.g.nav.walk(at, x, z) : null
      to = [x, w && Number.isFinite(w.end.y) ? w.end.y : at.y, z]
    }
    this.ready.set(p.id, now + S.cooldownMs)
    answer(true)
    this.launch(p, from, to, target, now, false)
    this.bump(p.characterId, now, { thrown: 1 })
  }

  /** Sends a snowball on its way (a player's, or the Ice Yeti's barrage with `big`). Returns its id. */
  launch(by: Player | Mob, from: Vec3, to: Vec3, target: Player | Mob | null, now: number, big: boolean, radiusM: number = WINTER_PLAY.snowball.hitRadiusM): number {
    const id = this.nextId++
    const dist = Math.hypot(to[0] - from[0], to[2] - from[2])
    const ms = snowballFlightMs(dist)
    const stood = target ? this.g.world.positionAt(target, now) : null
    this.flights.set(id, { id, thrower: by.id, throwerChar: by.kind === 'player' ? by.characterId : 0, from, to, target: target?.id ?? null, stood, landAt: now + ms, big, radiusM })
    const msg: ServerMessage = { t: 'snowball', id, from: by.id, fromPos: round3(from), to: round3(to), at: Math.round(now), ms, peakM: Math.round(snowballPeakM(dist) * 100) / 100 }
    if (target) msg.target = target.id
    if (big) msg.big = true
    if (target) this.g.world.broadcastAboutEither(by, target, msg)
    else this.g.world.broadcastAbout(by, msg)
    return id
  }

  /** The Ice Yeti's barrage lands here (yeti.ts sets it): damage instead of the slow. */
  onBigHit: ((thrower: number, hit: Player, now: number) => void) | null = null

  tick(now: number): void {
    for (const f of [...this.flights.values()]) {
      if (now < f.landAt) continue
      this.flights.delete(f.id)
      this.land(f, now)
    }
  }

  private land(f: Flight, now: number): void {
    const S = WINTER_PLAY.snowball
    const thrower = this.g.world.players.get(f.thrower) ?? this.g.world.mobs.get(f.thrower)
    let hit: Player | Mob | null = null
    let pos: Vec3 = f.to
    if (f.target !== null) {
      const t = this.g.world.players.get(f.target) ?? this.g.world.mobs.get(f.target)
      if (t && this.hittable(t) && f.stood) {
        const q = this.g.world.positionAt(t, now)
        if (Math.hypot(q[0] - f.stood[0], q[2] - f.stood[2]) <= S.dodgeM) {
          hit = t
          pos = [q[0], q[1] + CHEST_Y, q[2]]
        }
      }
    } else {
      let best = f.radiusM
      const near = [...this.g.world.playersNear(f.to[0], f.to[2], best, now), ...(f.big ? [] : this.mobsNear(f.to[0], f.to[2], best, now))]
      for (const e of near) {
        if (e.id === f.thrower || !this.hittable(e)) continue
        const q = this.g.world.positionAt(e, now)
        const d = Math.hypot(q[0] - f.to[0], q[2] - f.to[2])
        if (d <= best) {
          best = d
          hit = e
        }
      }
    }
    // a big snowball (the yeti) only hurts players; a player's never hurts a player
    if (f.big && hit?.kind === 'mob') hit = null
    const msg: ServerMessage = { t: 'snowballSplat', id: f.id, pos: round3(pos) }
    let score: number | undefined
    if (hit) {
      msg.hit = hit.id
      if (hit.kind === 'player' && !f.big) {
        const k = this.play.knobs()
        if (k.snowballSlowPct > 0) {
          this.play.slow(hit, k.snowballSlowPct, S.slowMs, now)
          msg.slowMs = S.slowMs
        }
        this.bump(hit.characterId, now, { hit_by: 1 })
      }
      if (f.throwerChar > 0) score = this.bump(f.throwerChar, now, { hits: 1 })
    }
    // everyone who saw it fly (the thrower's and the target's viewers) and whoever it hit
    for (const p of this.g.world.players.values()) {
      const sees = p.id === f.thrower || p.known.has(f.thrower) || (f.target !== null && (p.id === f.target || p.known.has(f.target))) || (hit !== null && (p.id === hit.id || p.known.has(hit.id)))
      if (sees) p.send(p.id === f.thrower && score !== undefined ? { ...msg, score } : msg)
    }
    if (!hit) return
    if (f.big && hit.kind === 'player') this.onBigHit?.(f.thrower, hit, now)
    else if (hit.kind === 'mob' && thrower?.kind === 'player') this.pelt(thrower, hit, now)
  }

  /** A player's snowball on a monster: a little damage and its attention (not from inside a town). */
  private pelt(p: Player, m: Mob, now: number): void {
    const [x, , z] = this.g.world.positionAt(p, now)
    if (this.g.data.inSafeArea(this.g.config.world, x, z) || m.ai === 'dead') return
    const dmg = WINTER_PLAY.snowball.mobDamage
    this.g.dealHits(p, m, [{ outcome: 'hit', damage: dmg, hp: 0 }], {}, now)
  }

  private hittable(e: Player | Mob): boolean {
    return e.kind === 'player' ? !e.dead && !e.trance && !e.invisible : e.ai !== 'dead'
  }

  private mobsNear(x: number, z: number, r: number, now: number): Mob[] {
    const out: Mob[] = []
    for (const m of this.g.world.mobs.values()) {
      const q = this.g.world.positionAt(m, now)
      if ((q[0] - x) ** 2 + (q[2] - z) ** 2 <= r * r) out.push(m)
    }
    return out
  }

  forget(p: Player): void {
    this.ready.delete(p.id)
  }

  /** In-flight snowballs (tests, the leak check). */
  get inFlight(): number {
    return this.flights.size
  }

  // ---- stats (winter_stats, migration 16) ---------------------------------------------------------------------

  private prepare(): NonNullable<SnowballService['stmts']> {
    if (this.stmts) return this.stmts
    const db = this.g.store.db
    this.stmts = {
      get: db.prepare('SELECT hits, thrown, hit_by FROM winter_stats WHERE character_id = ? AND season = ?'),
      bump: db.prepare(
        `INSERT INTO winter_stats (character_id, season, hits, thrown, hit_by, gifts, updated_at) VALUES (@character_id, @season, @hits, @thrown, @hit_by, @gifts, @at)
         ON CONFLICT(character_id, season) DO UPDATE SET hits = hits + excluded.hits, thrown = thrown + excluded.thrown, hit_by = hit_by + excluded.hit_by, gifts = gifts + excluded.gifts, updated_at = excluded.updated_at`,
      ),
      top: db.prepare(
        `SELECT c.name AS name, w.hits AS hits FROM winter_stats w JOIN characters c ON c.id = w.character_id
         WHERE w.season = ? AND w.hits > 0 AND c.deleted_at IS NULL ORDER BY w.hits DESC, w.updated_at ASC LIMIT ?`,
      ),
      rank: db.prepare(`SELECT COUNT(*) AS n FROM winter_stats w JOIN characters c ON c.id = w.character_id WHERE w.season = ? AND w.hits > ? AND c.deleted_at IS NULL`),
      reset: db.prepare('DELETE FROM winter_stats WHERE season = ?'),
    }
    return this.stmts
  }

  /** Adds to a character's stats of this winter; returns its hits. */
  bump(characterId: number, now: number, d: Partial<StatRow & { gifts: number }>): number {
    const q = this.prepare()
    const season = this.play.seasonKey(now)
    q.bump.run({ character_id: characterId, season, hits: d.hits ?? 0, thrown: d.thrown ?? 0, hit_by: d.hit_by ?? 0, gifts: d.gifts ?? 0, at: Math.round(now) })
    return q.get.get(characterId, season)?.hits ?? 0
  }

  stats(characterId: number, now: number): StatRow {
    return this.prepare().get.get(characterId, this.play.seasonKey(now)) ?? { hits: 0, thrown: 0, hit_by: 0 }
  }

  board(p: Player, now: number): WinterBoard {
    const q = this.prepare()
    const season = this.play.seasonKey(now)
    const me = this.stats(p.characterId, now)
    const b: WinterBoard = {
      season,
      top: q.top.all(season, WINTER_PLAY.snowball.boardSize).map((r) => ({ name: r.name, hits: r.hits })),
      me: { hits: me.hits, thrown: me.thrown, hitBy: me.hit_by },
    }
    if (me.hits > 0) b.me.rank = (q.rank.get(season, me.hits)?.n ?? 0) + 1
    return b
  }

  // ---- GM --------------------------------------------------------------------------------------------------

  gm(self: Player | null, args: string[], now: number): GmResult {
    const a = (args[0] ?? '').toLowerCase()
    const usage: GmResult = { ok: false, message: `Usage: ${SNOWBALL_USAGE}` }
    if (args.length === 0) {
      const s = self ? this.stats(self.characterId, now) : null
      const why = now < this.testUntil ? `a GM test runs for ${Math.ceil((this.testUntil - now) / 1000)} s` : !this.play.isOn ? 'the winter layer is off' : this.play.snowDeep(now) ? 'the snow is deep enough' : 'the snow is too thin'
      return { ok: true, message: `Snowballs: ${this.allowed(now) ? 'on' : 'off'} (${why}); ${this.flights.size} in flight; season ${this.play.seasonKey(now)}${s ? `; you: ${s.hits} hits, ${s.thrown} thrown, hit ${s.hit_by} times` : ''}.` }
    }
    if (a === 'test') {
      const sec = args[1] === undefined ? 600 : Number(args[1])
      if (!Number.isFinite(sec) || sec < 0 || sec > 7200 || args.length > 2) return usage
      this.testUntil = sec > 0 ? now + sec * 1000 : 0
      this.play.broadcastState(now)
      return { ok: true, message: sec > 0 ? `Snowball test: everyone can throw snowballs for ${sec} s, season and snow or not (B, or a hotbar action). \`snowball test 0\` ends it.` : 'Snowball test ended.' }
    }
    if (a === 'stats') {
      const who = args[1] ? this.g.world.byName(args[1]) : self
      if (!who || args.length > 2) return args[1] && !who ? { ok: false, message: `No player named ${args[1]} in the world.` } : usage
      const s = this.stats(who.characterId, now)
      return { ok: true, message: `${who.name}, winter ${this.play.seasonKey(now)}: ${s.hits} hits, ${s.thrown} thrown, hit ${s.hit_by} times.`, data: s }
    }
    if (a === 'reset') {
      if (args.length !== 1) return usage
      const n = this.prepare().reset.run(this.play.seasonKey(now)).changes
      return { ok: true, message: `Snowball scoreboard of ${this.play.seasonKey(now)} cleared (${n} rows).` }
    }
    return usage
  }
}

function round3(v: Vec3): Vec3 {
  return [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000]
}
