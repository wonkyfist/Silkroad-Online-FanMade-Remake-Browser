import {
  PILOT_REQUESTS,
  PILOT_TAUNT_LINES,
  mergePilotSettings,
  mulberry32,
  type GameplayRequest,
  type HuntEventView,
  type HuntOutcome,
  type PilotEndReason,
  type ServerMessage,
} from '@sro/shared'
import { addGold, fail, type Fail } from '../inventory.ts'
import type { Gameplay } from '../gameplay.ts'
import type { Answer, GameplayMessage, GameplayModule, KillOwner } from '../modules.ts'
import { findPlace } from '../places.ts'
import type { Uniques } from '../uniques.ts'
import type { UniqueDef } from '@sro/shared'
import type { Mob, Player } from '../world.ts'
import { Lottery } from './call.ts'
import { HuntSignals, freezeAssociates, isAssociate } from './hunt.ts'
import { Kit, kitView, resolveKit } from './kit.ts'
import { HuntScaler } from './scale.ts'
import { loadPatch } from './settings.ts'
import { clampToArea, rewardGold, steerSpeed } from './steer.ts'
import { PilotStore, type PilotEventRow } from './store.ts'
import { registerBossAdmin } from './admin.ts'
import { pilotGm } from './gm.ts'
import {
  EVENT_EVERY_MS,
  EXIT_MS,
  HUNTING_MS,
  IDLE_WARN_MS,
  SAVE_EVERY_MS,
  type EventPhase,
  type HuntEvent,
  type PilotConf,
  type Turn,
} from './types.ts'

/**
 * Play the Boss (docs/PLAY_THE_BOSS.md), the server module `pilot`: a player steers a unique (Tiger Girl) while everyone
 * else hunts her. Layers 1–3 (§8): steering with the AI fallback, the kit and the hunt's signals, and the event a GM or
 * an admin starts with a chosen pilot. Layer 4 (call.ts, lottery.ts, settings.ts): the call for volunteers, the draw,
 * the weekly "Night of the Tiger", the settings patch the admin panel edits and the lottery blocks. Layer 5 (scale.ts):
 * her max HP and band summons follow the crowd.
 *
 * - **She stays a monster** (§0.1): the pilot's input drives her mob through the calls her AI uses (World.moveEntity,
 *   MobSkills.use). Notices, loot, summons, enrage and the server's checks keep working unchanged.
 * - **A turn** (`Turn`): `Mob.pilot` = {player, steering} for the whole session, `Player.viewFrom` = her id (interest
 *   centres on her), `Player.trance` on the body (warped to the trance place, never a target, locked by `gate`).
 *   `steer` (connection.ts, before any moveTo) moves her at her own speed inside the hunt circle; `pilotAct` runs the kit
 *   (kit.ts). No input for `idleSec`, a disconnect, `pilotQuit` or a GM kill of the body: her AI steers again
 *   (Gameplay.tick runs thinkMob once `steering` is 'ai', with her home at the circle's centre and the leash its radius);
 *   any input takes her back. While `Mob.pilot` is set she never regenerates or refills at home (gameplay.ts).
 * - **GM attach** (`/unique pilot attach <name>`, layer 1's test tool): a turn on the living unique with no event rules
 *   (no timer, no downs, no rewards); `detach` ends it.
 * - **The call** (layer 4): a scheduled night, `/unique pilot start` or the admin's Start opens it for `call.minutes`;
 *   eligible players volunteer, then the draw offers the turn to one volunteer after another (call.ts).
 * - **The event** (`HuntEvent`, layer 3): `/unique pilot <name>` or the admin route `boss/pick` offers the turn (30 s;
 *   during a call it closes the call: a force-pick); on accept she is taken over where she stands (alive) or spawns at a
 *   random camp; the hunt runs `surviveMin` with the
 *   fury off and no leash reset (`Uniques.setEvent`). It ends `killed` (today's kill path; the pilot's associates were
 *   stripped from her damage map first, `beforeShares`), `survived` (the timer), `downs` (`downsTarget` reached),
 *   `cancelled` (GM / admin stop) or `restart` (found open at boot; the turn is refunded). Rewards: gold by performance,
 *   the title on a win (migration 13); nothing after a quit, a disconnect or a suspect death.
 * - Every phase change writes `pilot_events` and a `pilot_log` line (migration 12). GM commands are audited by gm.ts,
 *   admin calls by the admin router.
 */
export class Pilot implements GameplayModule {
  readonly name = 'pilot'
  readonly handles: readonly GameplayRequest[] = PILOT_REQUESTS
  readonly whileDead: readonly GameplayRequest[] = ['pilotVolunteer']
  /** The module's own random stream (ping offsets, the pack's ring): seeded in tests, as Uniques.rng. */
  rng: () => number
  readonly kit: Kit
  readonly signals: HuntSignals
  readonly lottery: Lottery
  readonly scaler: HuntScaler
  /** The live turn (one at a time) and the event (call, offer / draw, hunt). */
  turn: Turn | null = null
  event: HuntEvent | null = null
  /** Bosses leaving after a win: removed silently at `at`. */
  private exits: { code: string; mob: number; at: number }[] = []
  /** Fear Roar's lock: player id -> until when its moveTo / attack / useSkill are refused. */
  private readonly locks = new Map<number, number>()
  private storeCache: PilotStore | null = null
  private confs = new WeakMap<object, PilotConf | null>()
  private honors = new Map<number, string | null>()
  private accounts = new Map<number, number | null>()
  private booted = false
  private ipLookup: ((p: Player) => string | null) | null = null

  constructor(
    readonly g: Gameplay,
    readonly uniques: Uniques,
  ) {
    this.rng = g.config.rng ? mulberry32(0x0b055) : Math.random
    this.kit = new Kit(this)
    this.signals = new HuntSignals(this)
    this.lottery = new Lottery(this)
    this.scaler = new HuntScaler(this)
    uniques.pilotGm = (self, args, now) => pilotGm(this, self, args, now)
    uniques.pilotScale = (m) => this.scaler.factorOf(m)
    registerBossAdmin()
    // Late joiners and every spawn see the trance, the title and who steers (docs/WAVE_PLAN.md decision 37).
    g.world.decorators.push((e, s) => {
      if (e.kind === 'player') {
        if (e.trance) s.trance = true
        const h = this.honorOf(e.characterId)
        if (h) s.honor = h
      } else if (e.kind === 'mob' && e.pilot && e.pilot.steering === 'player' && e.pilot.player !== null) s.piloted = true
    })
  }

  /** game.ts: the game socket's IP of a player (same-IP associates). */
  connect(c: { ipOf(p: Player): string | null }): void {
    this.ipLookup = c.ipOf
  }

  get store(): PilotStore {
    return (this.storeCache ??= new PilotStore(this.g.store.db))
  }

  // ---- configuration ----------------------------------------------------------------------------------------

  /** The steerable uniques of this world (those with a `pilot` block). */
  steerable(): PilotConf[] {
    const out: PilotConf[] = []
    for (const u of this.uniques.uniques) {
      const c = this.confOf(u.def)
      if (c) out.push(c)
    }
    return out
  }

  private confOf(def: UniqueDef): PilotConf | null {
    if (!def.pilot) return null
    let c = this.confs.get(def)
    if (c === undefined) {
      const mob = this.g.data.mob(def.mob)
      if (mob) {
        // Layer 4: the admin panel's stored patch over the content's defaults (settings.ts).
        const { patch, rev } = loadPatch(this.store, { code: def.mob, def: def.pilot }, this.g.config.levelCap, this.g.config.log)
        c = {
          code: def.mob,
          name: mob.name ?? def.mob,
          def: def.pilot,
          settings: mergePilotSettings(def.pilot.defaults, patch),
          defaults: mergePilotSettings(def.pilot.defaults),
          patch,
          rev,
          kit: resolveKit(def.mob, def.pilot, (code) => this.g.skills.book.skill(code), this.g.config.log, (code) => this.g.data.mob(code) !== undefined),
        }
      } else c = null
      this.confs.set(def, c)
    }
    return c
  }

  /** The steerable unique a GM / admin means: by code or name (a part of one), or the only one. A string = the error. */
  conf(q = ''): PilotConf | string {
    const all = this.steerable()
    if (all.length === 0) return 'No unique on this world can be steered (no pilot block in content/uniques.json).'
    const s = q.trim().toLowerCase()
    if (!s) return all[0]
    const hit = all.filter((c) => c.code.toLowerCase() === s || c.name.toLowerCase() === s)
    if (hit.length === 1) return hit[0]
    const part = all.filter((c) => c.code.toLowerCase().includes(s) || c.name.toLowerCase().includes(s))
    return part.length === 1 ? part[0] : `No steerable unique matches "${q.trim()}". Steerable: ${all.map((c) => c.name).join(', ')}.`
  }

  // ---- lookups ------------------------------------------------------------------------------------------------

  accountOf(characterId: number): number | null {
    let a = this.accounts.get(characterId)
    if (a === undefined) {
      a = this.g.store.characterById(characterId)?.account_id ?? null
      this.accounts.set(characterId, a)
    }
    return a
  }

  /** The player's game-socket IP for the same-IP rule; a loopback address (a dev server's own PC, tests) never counts. */
  ipOf(p: Player): string | null {
    const ip = this.ipLookup?.(p) ?? null
    if (!ip || /^(127\.|::1$|::ffff:127\.)/.test(ip)) return null
    return ip
  }

  private honorOf(characterId: number): string | null {
    let h = this.honors.get(characterId)
    if (h === undefined) {
      try {
        h = this.store.honorOf(characterId)
      } catch {
        h = null
      }
      this.honors.set(characterId, h)
    }
    return h
  }

  /** The live turn of player `p` (it steers now, or its AI does while it is still the pilot). */
  turnOf(p: Player): Turn | null {
    const t = this.turn
    return t && t.player === p.id ? t : null
  }

  /** Her body, alive, of a turn. */
  mobOf(t: Turn): Mob | null {
    const m = this.g.world.mobs.get(t.mob)
    return m && m.ai !== 'dead' ? m : null
  }

  speedOf(t: Turn, m: Mob): number {
    const st = t.stalk?.entry.def
    return steerSpeed(m.def, t.conf.settings.hunt.speedMul, st && 'kind' in st && st.kind === 'stalk' ? st.speedMul : null)
  }

  /** Her move in progress restarts at the current speed (Stalk on or off). */
  respeed(t: Turn, m: Mob, now: number): void {
    const mv = m.move
    if (mv && this.g.world.arrivalTime(mv) > now) this.g.world.moveEntity(m, mv.to[0], mv.to[2], this.speedOf(t, m), now)
  }

  /** Fear Roar's lock on a hunter. */
  lock(q: Player, until: number): void {
    this.locks.set(q.id, Math.max(until, this.locks.get(q.id) ?? 0))
  }

  /** A Fear Roar: the distant hunters hear it too. */
  roared(t: Turn, m: Mob, now: number): void {
    if (t.event?.phase === 'hunt') this.signals.roar(t.event, m, now)
  }

  // ---- the turn ------------------------------------------------------------------------------------------------

  /** The trance place (a places.json / manifest name; the town's return point when it is missing). */
  private trancePoint(conf: PilotConf): { x: number; y: number; z: number; at: ReturnType<Gameplay['townPoint']> } {
    const place = findPlace(this.g.setup.places, conf.def.trancePlace)
    if (place) {
      const at = this.g.world.placeFor(place.x, place.z, place.y ?? Infinity)
      return { x: place.x, y: place.y ?? at?.y ?? 0, z: place.z, at }
    }
    const at = this.g.townPoint()
    const s = this.g.setup.spawn
    return { x: at?.x ?? s.x, y: at?.y ?? s.y, z: at?.z ?? s.z, at }
  }

  /**
   * A turn starts (§3.3, §3.2 "the link"): the body dismounts, is warped to the trance place, healed and cleansed, and
   * rests in a trance; she is linked to the pilot and the pilot's view moves to her; `pilotStart`.
   */
  private startTurn(conf: PilotConf, p: Player, m: Mob, event: HuntEvent | null, area: Turn['area'], now: number): Turn {
    const w = this.g.world
    this.g.mounts.stepDownFor(p, now)
    this.g.skills.cure(p, 10_000, now)
    p.action = null
    p.trance = true
    const tp = this.trancePoint(conf)
    w.warp(p, tp.x, tp.y, tp.z, now, tp.at)
    this.g.warped(p, 'gm', now)
    w.broadcastAbout(p, { t: 'entityUpdate', id: p.id, trance: true })
    this.g.setVitals(p, p.maxHp, p.maxMp)
    const t: Turn = {
      conf,
      event,
      mob: m.id,
      player: p.id,
      characterId: p.characterId,
      accountId: this.accountOf(p.characterId) ?? 0,
      name: p.name,
      steering: 'player',
      lastInputAt: now,
      steeredMs: 0,
      steerSince: now,
      lastActAt: -Infinity,
      claw: null,
      pending: null,
      queued: null,
      ready: new Map(),
      charges: new Map(conf.kit.filter((k) => k.charges !== undefined).map((k) => [k.id, k.charges!])),
      busyUntil: 0,
      leap: null,
      stalk: null,
      tauntAt: -Infinity,
      area,
      restore: null,
      left: false,
      sentState: '',
      stateAt: 0,
    }
    this.turn = t
    m.pilot = { player: p.id, steering: 'player' }
    m.ai = 'chase'
    m.target = null
    w.halt(m, now)
    p.viewFrom = m.id
    w.refreshAround(p, now)
    w.broadcastAbout(m, { t: 'entityUpdate', id: m.id, piloted: true })
    p.send({
      t: 'pilotStart',
      event: event?.id ?? 0,
      mob: m.id,
      kit: conf.kit.map(kitView),
      huntEndsAt: event ? event.huntEndsAt : 0,
      downsTarget: event ? conf.settings.win.downsTarget : 0,
      area: { x: round1(area.x), z: round1(area.z), r: area.r },
      taunts: PILOT_TAUNT_LINES,
      senseM: conf.settings.hunt.senseM,
      place: conf.def.trancePlace,
    })
    this.sendState(t, now, true)
    this.g.config.log(`pilot: ${p.name} steers ${m.name} (id ${m.id})${event ? `, event ${event.id}` : ' (attach)'}`)
    return t
  }

  /** The body wakes up at the trance place and the pilot's view goes back to it. */
  private release(t: Turn, now: number): void {
    const p = t.player === null ? undefined : this.g.world.players.get(t.player)
    t.player = null
    if (!p) return
    delete p.viewFrom
    delete p.trance
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, trance: false })
    this.g.world.refreshAround(p, now)
  }

  /** Player time so far (ms). */
  steered(t: Turn, now: number): number {
    return t.steeredMs + (t.steerSince === null ? 0 : Math.max(0, now - t.steerSince))
  }

  /** Any input of the pilot: the idle clock restarts and, while her AI steers, the pilot takes her back (§3.4). */
  input(t: Turn, now: number): void {
    t.lastInputAt = now
    if (t.steering === 'ai' && t.player !== null && !t.left) this.toPlayer(t, now)
  }

  private toPlayer(t: Turn, now: number): void {
    const m = this.mobOf(t)
    if (!m || !m.pilot) return
    t.steering = 'player'
    t.steerSince = now
    m.pilot.steering = 'player'
    m.ai = 'chase'
    m.target = null
    this.g.world.halt(m, now)
    this.g.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, piloted: true })
    if (t.event) this.store.log(t.event.id, 'player', {}, now)
    this.sendState(t, now, true)
  }

  /** Her own AI steers (idle, a disconnect, a quit, a GM kill of the body): from the next tick (§3.4). */
  private toAi(t: Turn, now: number, why: string): void {
    const m = this.mobOf(t)
    if (t.steerSince !== null) t.steeredMs += Math.max(0, now - t.steerSince)
    t.steerSince = null
    if (t.steering === 'ai') return
    t.steering = 'ai'
    this.kit.stopOrders(t)
    if (m) {
      this.kit.endStalk(t, m, now)
      if (m.pilot) m.pilot.steering = 'ai'
      m.nextThinkAt = 0
      this.g.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, piloted: false })
    }
    if (t.event) this.store.log(t.event.id, 'ai', { why }, now)
    this.g.config.log(`pilot: ${t.name}'s ${t.conf.name}: her AI steers (${why})`)
    this.sendState(t, now, true)
  }

  /** The pilot leaves the turn (quit, disconnect, GM kill of the body): her AI finishes; the reward is forfeit. */
  private pilotLeft(t: Turn, now: number, why: 'quit' | 'disconnect' | 'body killed'): void {
    if (t.left) return
    this.toAi(t, now, why)
    t.left = true
    const p = t.player === null ? undefined : this.g.world.players.get(t.player)
    if (t.event) {
      this.store.log(t.event.id, 'flag', { flag: 'pilot_left', why }, now)
      if (!t.event.flags.includes('pilot_left')) t.event.flags.push('pilot_left')
      p?.send({ t: 'pilotEnd', event: t.event.id, reason: 'quit', downs: t.event.downs, steeredMs: Math.round(this.steered(t, now)) })
    } else p?.send({ t: 'pilotEnd', event: 0, reason: 'quit', steeredMs: Math.round(this.steered(t, now)) })
    this.release(t, now)
    const m = this.g.world.mobs.get(t.mob)
    if (m?.pilot) m.pilot.player = null
    // A GM attach session ends with its pilot (her normal rules come back).
    if (!t.event) this.endAttach(t, now)
  }

  /** pilotState (§5.2), when it differs from the last one sent (or `force`). */
  sendState(t: Turn, now: number, force = false): void {
    const p = t.player === null ? undefined : this.g.world.players.get(t.player)
    const m = this.g.world.mobs.get(t.mob)
    if (!p || !m) return
    const idleMs = t.conf.settings.hunt.idleSec * 1000
    const ready: Record<string, number> = {}
    for (const e of t.conf.kit) {
      const r = this.kit.readyAt(t, m, e)
      if (r > now) ready[e.id] = Math.round(r)
    }
    const msg: Extract<ServerMessage, { t: 'pilotState' }> = {
      t: 'pilotState',
      steering: t.steering,
      hunting: t.event ? this.hunting(t.event, now) : 0,
      downs: t.event?.downs ?? 0,
      charges: Object.fromEntries(t.charges),
      ready,
    }
    if (t.steering === 'player' && now - t.lastInputAt >= idleMs - IDLE_WARN_MS) msg.idleWarnAt = Math.round(t.lastInputAt + idleMs)
    if ((m.damageMul ?? 1) > 1) msg.enraged = true
    if (t.stalk) msg.stalkUntil = Math.round(t.stalk.until)
    const json = JSON.stringify(msg)
    if (!force && json === t.sentState) return
    t.sentState = json
    t.stateAt = now
    p.send(msg)
  }

  // ---- input (connection.ts, requests) ------------------------------------------------------------------------

  /**
   * connection.ts, before any moveTo (§3.2): false = `p` is not a live pilot (the normal path runs). Else her move:
   * input reclaims her from the AI; held or busy: dropped; the target is clamped into the hunt circle; a point in a safe
   * area is refused; the walk is a navmesh chord from her live point at the speed the server picks.
   */
  steer(p: Player, x: number, z: number, now = Date.now()): boolean {
    const t = this.turnOf(p)
    if (!t) return false
    this.g.now = now
    const m = this.mobOf(t)
    if (!m || m.pilot?.player !== p.id) return true
    this.input(t, now)
    // A move order ends auto-claw and a walk-in even when the move itself is dropped (held, busy).
    this.kit.stopOrders(t)
    if (this.g.skills.held(m, now) || this.kit.busy(t, m, now)) return true
    const [cx, cz] = clampToArea(x, z, t.area)
    if (this.g.data.inSafeArea(this.g.config.world, cx, cz)) return true
    this.g.world.moveEntity(m, cx, cz, this.speedOf(t, m), now)
    return true
  }

  /** connection.ts: the pilot's free chat is refused for the whole turn (§3.10). */
  chatBlocked(p: Player): boolean {
    return this.turnOf(p) !== null
  }

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'pilotVolunteer':
        return answer(this.lottery.volunteer(p, msg.on, now))
      case 'pilotAnswer':
        return answer(this.answerOffer(p, msg.event, msg.accept, now))
      case 'pilotAct': {
        const t = this.turnOf(p)
        const m = t && this.mobOf(t)
        if (!t || !m || m.pilot?.player !== p.id || this.exiting(m)) return answer(fail('no_event'))
        this.input(t, now)
        const r = this.kit.act(t, m, p, msg, now)
        answer(r)
        this.sendState(t, now)
        return
      }
      case 'pilotTaunt': {
        const t = this.turnOf(p)
        const m = t && this.mobOf(t)
        if (!t || !m) return answer(fail('no_event'))
        if (msg.line >= PILOT_TAUNT_LINES) return answer(fail('not_found'))
        this.input(t, now)
        if (now - t.tauntAt < t.conf.settings.guards.tauntCooldownSec * 1000) return answer(fail('cooldown'))
        t.tauntAt = now
        answer(true)
        this.g.world.broadcastAbout(m, { t: 'huntTaunt', id: m.id, line: msg.line })
        return
      }
      case 'pilotQuit': {
        const t = this.turnOf(p)
        if (!t) return answer(fail('no_event'))
        answer(true)
        return this.pilotLeft(t, now, 'quit')
      }
    }
    answer(fail('not_found'))
  }

  // ---- GameplayModule hooks -----------------------------------------------------------------------------------

  /**
   * The trance (§3.3): the body refuses every request (and moveTo) but stopAction, which halts her (`stopped`). Fear
   * Roar's lock (§3.5): moveTo, attack and useSkill refused (cant_act) until it ends.
   */
  gate(p: Player, t: GameplayRequest | 'moveTo', now: number): Fail | null {
    if (p.trance && t !== 'stopAction') return fail('piloting', 'Your body rests in a trance while you steer the boss.')
    const until = this.locks.get(p.id)
    if (until !== undefined) {
      if (now >= until) this.locks.delete(p.id)
      else if (t === 'moveTo' || t === 'attack' || t === 'useSkill') return fail('cant_act')
    }
    return null
  }

  /** stopAction of the pilot halts her (and ends auto-claw). */
  stopped(p: Player, now: number): void {
    const t = this.turnOf(p)
    const m = t && this.mobOf(t)
    if (!t || !m) return
    this.input(t, now)
    this.kit.stopOrders(t)
    if (!this.kit.busy(t, m, now)) this.g.world.halt(m, now)
  }

  /** Late joiners get the event (§2.2; during a call with their own `you`). */
  enter(p: Player, now: number): void {
    const ev = this.event
    if (ev && ev.phase !== 'ended') this.sendEventTo(ev, p, now)
  }

  forget(p: Player): void {
    const now = this.g.now
    this.locks.delete(p.id)
    const t = this.turnOf(p)
    if (t) this.pilotLeft(t, now, 'disconnect')
    const ev = this.event
    if (ev?.phase === 'offer' && ev.offer?.playerId === p.id) this.offerGone(ev, now, 'left')
    ev?.recent.delete(p.id)
    ev?.trailSeen.delete(p.id)
    ev?.youSent.delete(p.id)
  }

  /** A death: the body killed by a GM ends the pilot's turn; a hunter mauled by her (or her pack) may be a down (§3.8). */
  playerDied(p: Player, now: number, killer?: Player | Mob): void {
    const t = this.turnOf(p)
    if (t) return this.pilotLeft(t, now, 'body killed')
    const ev = this.event
    if (!ev || ev.phase !== 'hunt' || !ev.turn) return
    const rec = ev.recent.get(p.id)
    ev.recent.delete(p.id)
    if (!killer || killer.kind !== 'mob') return
    const her = ev.turn.mob
    if (killer.id !== her && this.g.mobSkills.summonerOf(killer.id) !== her) return
    const s = ev.conf.settings.win
    if (isAssociate(this, ev.associates, p) || p.level < s.downMinLevel || (rec?.damage ?? 0) < s.downMinDamage) return
    ev.downs++
    this.store.log(ev.id, 'down', { name: p.name, character: p.characterId, downs: ev.downs }, now)
    const line = `[Hunt] ${p.name} was mauled by ${ev.conf.name}! (${ev.downs} / ${s.downsTarget})`
    for (const q of this.g.world.players.values()) q.send({ t: 'chat', channel: 'system', text: line })
    this.broadcastEvent(ev, now, true)
    this.sendState(ev.turn, now, true)
  }

  /** Damage to or from her and her summons (Gameplay.dealHits): hunters, the fight flag, Stalk ends on damage taken. */
  onHits(a: Player | Mob, t: Player | Mob | { kind: string; id: number }, dealt: number, now: number): void {
    const turn = this.turn
    if (!turn || dealt <= 0) return
    const her = turn.mob
    const ev = turn.event
    if (t.kind === 'mob' && a.kind === 'player') {
      const theirs = t.id === her || this.g.mobSkills.summonerOf(t.id) === her
      if (!theirs) return
      if (t.id === her && turn.stalk) {
        const m = this.mobOf(turn)
        if (m) this.kit.endStalk(turn, m, now)
      }
      if (!ev || ev.phase !== 'hunt') return
      ev.fightAt = now
      if (isAssociate(this, ev.associates, a)) return
      const rec = ev.recent.get(a.id) ?? { damage: 0, lastHitAt: 0 }
      rec.damage += dealt
      rec.lastHitAt = now
      ev.recent.set(a.id, rec)
      ev.hunters.add(a.characterId)
      // Layer 5: her own damage counts toward N (§3.7), not her summons'.
      if (t.id === her) this.scaler.hit(ev, a.characterId, dealt, now)
    } else if (a.kind === 'mob' && t.kind === 'player' && ev?.phase === 'hunt' && (a.id === her || this.g.mobSkills.summonerOf(a.id) === her)) ev.fightAt = now
  }

  /**
   * Gameplay.mobDied, before the shares (§3.9): the pilot's associates leave her damage map, so they get no EXP, loot,
   * quest credit or Berserk from her; their share is kept for the suspect flag.
   */
  beforeShares(m: Mob, _now: number): void {
    const ev = this.event
    if (!ev || ev.phase !== 'hunt' || ev.turn?.mob !== m.id) return
    let total = 0
    let theirs = 0
    for (const [id, d] of [...m.damage]) {
      total += d
      const q = this.g.world.players.get(id)
      if (q && isAssociate(this, ev.associates, q)) {
        theirs += d
        m.damage.delete(id)
      }
    }
    ev.associatePct = total > 0 ? (100 * theirs) / total : 0
  }

  /** A rewarded kill of the boss: the hunters win (§2.3). */
  mobDied(m: Mob, now: number, _credit: ReadonlySet<number>, _owner: KillOwner): void {
    const t = this.turn
    if (!t || t.mob !== m.id) return
    if (t.event?.phase === 'hunt') this.endHunt(t.event, 'killed', now)
    else if (!t.event) this.endAttach(t, now)
  }

  tick(now: number): void {
    this.boot(now)
    const ev = this.event
    if (ev?.phase === 'call') {
      if (now >= ev.callEndsAt) this.lottery.close(ev, now)
      else this.broadcastEvent(ev, now)
    } else if (ev?.phase === 'offer') {
      if (ev.offer && now >= ev.offer.expiresAt) this.offerGone(ev, now, 'timeout')
      else if (!ev.offer && ev.drawAt > 0 && now >= ev.drawAt) this.lottery.next(ev, now)
    }
    for (const conf of this.steerable()) this.lottery.schedule(conf, now)
    const t = this.turn
    if (t) this.tickTurn(t, now)
    if (this.event?.phase === 'hunt') this.tickHunt(this.event, now)
    if (this.exits.length) {
      const due = this.exits.filter((x) => now >= x.at)
      if (due.length) {
        this.exits = this.exits.filter((x) => now < x.at)
        for (const x of due) this.uniques.endEvent(x.code, now, 'left after the hunt')
      }
    }
  }

  private tickTurn(t: Turn, now: number): void {
    const m = this.mobOf(t)
    if (!m) {
      // She died or vanished without a rewarded kill (a GM /kill, /unique despawn): the session ends.
      if (t.event?.phase === 'hunt') this.endHunt(t.event, 'cancelled', now)
      else if (!t.event) this.endAttach(t, now)
      return
    }
    if (this.exiting(m)) return
    const pilot = t.player === null ? null : (this.g.world.players.get(t.player) ?? null)
    this.kit.tick(t, m, pilot, now)
    if (t.steering === 'player' && now - t.lastInputAt >= t.conf.settings.hunt.idleSec * 1000) this.toAi(t, now, 'idle')
    this.sendState(t, now)
  }

  private tickHunt(ev: HuntEvent, now: number): void {
    const t = ev.turn
    const m = t && this.mobOf(t)
    if (!t || !m) return
    if (now >= ev.huntEndsAt) return this.endHunt(ev, 'survived', now)
    if (ev.downs >= ev.conf.settings.win.downsTarget) return this.endHunt(ev, 'downs', now)
    this.scaler.tick(ev, m, now)
    this.signals.tick(ev, m, now)
    this.broadcastEvent(ev, now)
    if (now - ev.savedAt >= SAVE_EVERY_MS) {
      ev.savedAt = now
      this.store.update(ev.id, { downs: ev.downs, hunters: ev.hunters.size, steered_ms: Math.round(this.steered(t, now)) })
    }
  }

  // ---- the event (layer 3) ------------------------------------------------------------------------------------

  /** Hunters who hit her (or her summons) within the last minute (HUNTING YOU). */
  hunting(ev: HuntEvent, now: number): number {
    let n = 0
    for (const r of ev.recent.values()) if (now - r.lastHitAt <= HUNTING_MS) n++
    return n
  }

  /** The event's public view (§5.2); the pilot's name only once it ended. The call's `you` is per recipient (viewFor). */
  view(ev: HuntEvent, _now: number): HuntEventView {
    const v: HuntEventView = { id: ev.id, mob: ev.conf.code, name: ev.conf.name, phase: ev.phase }
    if (ev.fromCall && (ev.phase === 'call' || ev.phase === 'offer')) {
      v.callEndsAt = Math.round(ev.callEndsAt)
      v.volunteers = ev.volunteers
      if (ev.phase === 'call') v.minLevel = ev.conf.settings.eligibility.minLevel
    }
    if (ev.huntStartedAt > 0) {
      v.huntEndsAt = Math.round(ev.huntEndsAt)
      v.downs = ev.downs
      v.downsTarget = ev.conf.settings.win.downsTarget
      v.hunters = ev.hunters.size
      if (ev.area) v.area = ev.area
      if (ev.turn) v.steering = ev.turn.steering
      if (ev.phase === 'hunt' && Number.isFinite(ev.nextPingAt)) v.nextPingAt = Math.round(ev.nextPingAt)
    }
    if (ev.phase === 'ended') {
      if (ev.outcome) v.outcome = ev.outcome
      // Only a pilot who steered her is named (a declined or expired offer names nobody).
      if (ev.turn) v.pilot = ev.turn.name
    }
    return v
  }

  /**
   * huntEvent to every world player when it changed (the hunters count at most every 2 s). During the call each player
   * also gets its own `you`: checked every 2 s (a level up, a death, a block), sent when it or the public part changed.
   */
  broadcastEvent(ev: HuntEvent, now: number, force = false): void {
    const v = this.view(ev, now)
    const json = JSON.stringify(v)
    if (ev.phase === 'call') {
      if (!force && now - ev.eventAt < EVENT_EVERY_MS) return
      const changed = force || json !== ev.eventSent
      ev.eventSent = json
      ev.eventAt = now
      for (const p of this.g.world.players.values()) this.sendCall(ev, p, v, now, changed)
      return
    }
    if (json === ev.eventSent) return
    if (!force && now - ev.eventAt < EVENT_EVERY_MS) return
    ev.eventSent = json
    ev.eventAt = now
    ev.youSent.clear()
    for (const p of this.g.world.players.values()) p.send({ t: 'huntEvent', event: v })
  }

  /** The call's huntEvent with `p`'s own `you`; `always` = even when neither part changed for `p`. */
  private sendCall(ev: HuntEvent, p: Player, base: HuntEventView, now: number, always: boolean): void {
    const you = this.lottery.you(ev, p, now)
    const key = JSON.stringify(you)
    if (!always && ev.youSent.get(p.id) === key) return
    ev.youSent.set(p.id, key)
    p.send({ t: 'huntEvent', event: { ...base, you } })
  }

  /** The current event to one player now (enter-world, its own volunteer toggle). */
  sendEventTo(ev: HuntEvent, p: Player, now: number): void {
    const v = this.view(ev, now)
    if (ev.phase === 'call') this.sendCall(ev, p, v, now, true)
    else p.send({ t: 'huntEvent', event: v })
  }

  /** Why an event cannot start now, or null. */
  busyWhy(conf: PilotConf): string | null {
    if (this.event && this.event.phase !== 'ended') return `An event is running (${this.event.phase}, event ${this.event.id}).`
    if (this.turn) return `${this.turn.name} steers ${this.turn.conf.name} already (attach); /unique pilot detach first.`
    if (this.exits.some((x) => x.code === conf.code)) return `${conf.name} is leaving after the last hunt; try again in a few seconds.`
    return null
  }

  /** A fresh event in `phase` (its row exists already as `id`). */
  makeEvent(id: number, conf: PilotConf, origin: HuntEvent['origin'], phase: EventPhase, now: number): HuntEvent {
    return {
      id,
      conf,
      origin,
      phase,
      createdAt: now,
      callEndsAt: 0,
      fromCall: false,
      draws: 0,
      volunteers: 0,
      drawAt: 0,
      youSent: new Map(),
      offer: null,
      turn: null,
      camp: null,
      area: '',
      huntStartedAt: 0,
      huntEndsAt: 0,
      downs: 0,
      hunters: new Set(),
      recent: new Map(),
      associates: { chars: new Set(), accounts: new Set(), ip: null },
      associatePct: 0,
      fightAt: 0,
      flags: [],
      outcome: null,
      nextPingAt: Infinity,
      nextRoarAt: Infinity,
      trail: [],
      trailAt: 0,
      trailSentAt: 0,
      trailSeen: new Map(),
      eventAt: 0,
      eventSent: '',
      savedAt: now,
      scale: null,
    }
  }

  /**
   * A call for volunteers opens now (§2.5 `pilot start [minutes]`, §6.3 `boss/start`): `minutes` 1–60, default the
   * setting. Returns the event, or the error.
   */
  startCall(confQ: string, minutes: number | undefined, origin: 'gm' | 'admin', now: number): { ok: true; event: HuntEvent; message: string } | { ok: false; status: number; message: string } {
    this.boot(now)
    const conf = this.conf(confQ)
    if (typeof conf === 'string') return { ok: false, status: 404, message: conf }
    const min = minutes ?? conf.settings.call.minutes
    if (!(Number.isFinite(min) && min >= 1 && min <= 60)) return { ok: false, status: 400, message: 'The call lasts 1 to 60 minutes.' }
    const why = this.busyWhy(conf)
    if (why) return { ok: false, status: 409, message: why }
    const ev = this.lottery.open(conf, origin, min, now)
    return { ok: true, event: ev, message: `The call for ${conf.name} is open (event ${ev.id}); the draw in ${mmssOf(ev.callEndsAt - now)}.` }
  }

  /**
   * A GM / admin pick (§2.5 `pilot <name>`, §6.3 `boss/pick`): offers the turn to the named online character now
   * (eligibility skipped, consent still asked). During a call (or while a draw waits) it closes the call and the offer
   * goes out on that event; a decline then draws from its volunteers. Returns the event, or the error.
   */
  pick(confQ: string, name: string, origin: 'gm' | 'admin', now: number): { ok: true; event: HuntEvent; message: string } | { ok: false; status: number; message: string } {
    this.boot(now)
    const conf = this.conf(confQ)
    if (typeof conf === 'string') return { ok: false, status: 404, message: conf }
    const cur = this.event
    const closing = cur && cur.conf === conf && (cur.phase === 'call' || (cur.phase === 'offer' && !cur.offer)) ? cur : null
    if (!closing) {
      const why = this.busyWhy(conf)
      if (why) return { ok: false, status: 409, message: why }
    }
    const p = this.g.world.byName(name.replace(/^@/, ''))
    if (!p) return { ok: false, status: 404, message: `No online character named ${name}.` }
    if (p.dead) return { ok: false, status: 409, message: `${p.name} is dead.` }
    let ev: HuntEvent
    if (closing) {
      ev = closing
      this.store.log(ev.id, 'gm', { action: 'pick', by: origin, name: p.name }, now)
      if (ev.phase === 'call') {
        ev.phase = 'offer'
        ev.volunteers = this.store.volunteerCount(ev.id)
        this.store.update(ev.id, { phase: 'draw' })
      }
      ev.drawAt = 0
    } else {
      ev = this.makeEvent(this.store.create(conf.code, origin, 'draw', now), conf, origin, 'offer', now)
      this.event = ev
    }
    this.offerTo(ev, p, now, false)
    return { ok: true, event: ev, message: `${conf.name} offered to ${p.name} (event ${ev.id}); ${conf.settings.call.acceptSec} s to accept.` }
  }

  /** The turn is offered to `p` (`drawn` by the lottery, else a force-pick): `pilotOffer`, `acceptSec` to answer. */
  offerTo(ev: HuntEvent, p: Player, now: number, drawn: boolean): void {
    const s = ev.conf.settings
    ev.phase = 'offer'
    ev.offer = { playerId: p.id, characterId: p.characterId, accountId: this.accountOf(p.characterId) ?? 0, name: p.name, expiresAt: now + s.call.acceptSec * 1000, drawn }
    this.store.log(ev.id, 'offer', drawn ? { name: p.name, character: p.characterId, origin: 'draw', draw: ev.draws } : { name: p.name, character: p.characterId, origin: ev.origin }, now)
    p.send({ t: 'pilotOffer', event: ev.id, expiresAt: Math.round(ev.offer.expiresAt), surviveMin: s.win.surviveMin, downsTarget: s.win.downsTarget, idleSec: s.hunt.idleSec })
    this.broadcastEvent(ev, now, true)
    this.g.config.log(`pilot: event ${ev.id} (${drawn ? `draw ${ev.draws}` : ev.origin}): ${ev.conf.name} offered to ${p.name}`)
  }

  /** `pilotAnswer`: only the offered account, inside its window. */
  private answerOffer(p: Player, id: number, accept: boolean, now: number): Fail | true {
    const ev = this.event
    const o = ev?.offer
    if (!ev || ev.phase !== 'offer' || !o || ev.id !== id) return fail('no_event')
    if (o.characterId !== p.characterId || o.accountId !== (this.accountOf(p.characterId) ?? 0)) return fail('no_event')
    if (now >= o.expiresAt) {
      this.offerGone(ev, now, 'timeout')
      return fail('no_event', 'The offer ran out.')
    }
    if (!accept) {
      this.offerGone(ev, now, 'decline')
      return true
    }
    if (p.dead) return fail('dead')
    if (this.store.volunteerOf(ev.id, o.accountId)?.character_id === o.characterId) this.store.setDraw(ev.id, o.accountId, 'accepted')
    // A GM pick that is accepted while she cannot be had (no camp places) is cancelled inside startHunt.
    this.startHunt(ev, p, now)
    return true
  }

  /** The offer was declined, ran out, or the player left: after a call the next volunteer is drawn, else it ends. */
  private offerGone(ev: HuntEvent, now: number, why: 'decline' | 'timeout' | 'left'): void {
    const o = ev.offer
    this.store.log(ev.id, why === 'decline' ? 'decline' : 'timeout', { name: o?.name, why }, now)
    if (o && this.store.volunteerOf(ev.id, o.accountId)?.character_id === o.characterId) this.store.setDraw(ev.id, o.accountId, why === 'decline' ? 'declined' : why)
    ev.offer = null
    if (ev.fromCall) return this.lottery.next(ev, now)
    this.finish(ev, 'no_volunteers', now)
  }

  /**
   * Nobody (else) accepted (§2.3 no_volunteers): the event ends; after a call she appears as her normal AI self at the
   * hunt's time when she is not alive (today's rules).
   */
  noVolunteers(ev: HuntEvent, now: number, why: string): void {
    this.store.log(ev.id, 'flag', { flag: 'no_volunteers', why }, now)
    this.finish(ev, 'no_volunteers', now)
    if (!ev.fromCall || this.uniques.unique(ev.conf.code)?.live) return
    const m = this.uniques.spawnForEvent(ev.conf.code, now)
    if (m) this.store.log(ev.id, 'spawn', { mob: m.id, ai: true }, now)
  }

  /**
   * Accepted (§2.2 hunt): she is taken over where she stands (alive: HP and fight kept) or spawns at a random camp; her
   * home becomes the camp's centre, her leash the hunt circle, the fury off; the turn starts with the event's rules.
   */
  private startHunt(ev: HuntEvent, p: Player, now: number): void {
    const conf = ev.conf
    const s = conf.settings
    let u = this.uniques.unique(conf.code)
    let m = u?.live ?? null
    const takeover = m !== null
    if (!m) m = this.uniques.spawnForEvent(conf.code, now)
    u = this.uniques.unique(conf.code)
    if (!m || !u) {
      this.store.log(ev.id, 'flag', { flag: 'no_camp_places' }, now)
      ev.flags.push('no_camp_places')
      p.send({ t: 'chat', channel: 'system', text: `${conf.name} cannot appear now (no camp places); the hunt is cancelled.` })
      return this.finish(ev, 'cancelled', now)
    }
    const camp = u.camp
    const centre: [number, number] = camp ? [camp.x, camp.z] : [m.pos[0], m.pos[2]]
    m.home = centre
    m.leashRange = s.hunt.radiusM
    this.uniques.setEvent(conf.code, true)
    ev.phase = 'hunt'
    ev.camp = camp?.id ?? null
    ev.area = this.uniques.area(centre[0], centre[1])
    ev.huntStartedAt = now
    ev.huntEndsAt = now + s.win.surviveMin * 60_000
    ev.associates = freezeAssociates(this, p)
    ev.nextPingAt = now + s.hunt.pingSec * 1000
    ev.nextRoarAt = now + 30_000
    ev.fightAt = takeover && m.damage.size > 0 ? now : 0
    // The call's hold on her timer is over; layer 5 scales her from her max HP now (§3.7).
    this.uniques.hold(conf.code, 0)
    this.scaler.start(ev, m, now)
    this.store.log(ev.id, 'accept', { name: p.name }, now)
    this.store.log(ev.id, takeover ? 'takeover' : 'spawn', { mob: m.id, camp: ev.camp, hpPct: Math.round((100 * m.hp) / m.maxHp), area: ev.area }, now)
    this.store.update(ev.id, {
      phase: 'hunt',
      hunt_started_at: now,
      hunt_ends_at: Math.round(ev.huntEndsAt),
      pilot_account: this.accountOf(p.characterId),
      pilot_character: p.characterId,
      pilot_name: p.name,
      camp: ev.camp,
    })
    ev.turn = this.startTurn(conf, p, m, ev, { x: centre[0], z: centre[1], r: s.hunt.radiusM }, now)
    ev.offer = null
    // The hunt banner (§2.2): "Tiger Girl was sighted! Area: ..."
    this.broadcastEvent(ev, now, true)
  }

  /** The hunt ended (§2.3): rewards, her exit, the announcements, the row. */
  private endHunt(ev: HuntEvent, outcome: HuntOutcome, now: number): void {
    const t = ev.turn
    if (!t) return this.finish(ev, outcome, now)
    const m = this.g.world.mobs.get(t.mob)
    if (t.steerSince !== null) t.steeredMs += Math.max(0, now - t.steerSince)
    t.steerSince = null
    if (m && m.ai !== 'dead') this.kit.endStalk(t, m, now)
    const steeredMs = Math.round(t.steeredMs)
    const won = outcome === 'survived' || outcome === 'downs'
    const s = ev.conf.settings
    const p = t.player === null ? undefined : this.g.world.players.get(t.player)
    // Suspect (§3.9): she died with associates doing ≥ associateDamagePct of the damage, or within earlyDeathMin.
    if (outcome === 'killed') {
      if (ev.associatePct >= s.guards.associateDamagePct && ev.associatePct > 0) ev.flags.push(`suspect_associates_${Math.round(ev.associatePct)}pct`)
      if (now - ev.huntStartedAt < s.guards.earlyDeathMin * 60_000) ev.flags.push('suspect_early_death')
    }
    const suspect = ev.flags.some((f) => f.startsWith('suspect'))
    let gold = 0
    let honor: string | null = null
    if (p && !t.left && outcome !== 'cancelled' && outcome !== 'restart' && !suspect) {
      gold = rewardGold(s.rewards, ev.downs, steeredMs, won)
      if (gold > 0) {
        const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addGold(d, gold))
        if (result.ok) this.g.afterInventory(p, draft)
        else gold = 0
      }
      if (won && s.rewards.title) {
        honor = s.rewards.title
        if (this.store.grantHonor(p.characterId, honor, now)) {
          this.honors.set(p.characterId, honor)
          this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, honor })
        }
      }
      // The cosmetic (§3.9): none until Wardrobe ships its dyes; the setting is logged for then.
      if (won && s.rewards.cosmetic) this.store.log(ev.id, 'reward', { cosmetic: s.rewards.cosmetic, granted: false, why: 'no cosmetics yet' }, now)
      this.store.log(ev.id, 'reward', { gold, honor, downs: ev.downs, steeredMs }, now)
    }
    const reason: PilotEndReason = t.left ? 'quit' : outcome === 'restart' || outcome === 'no_volunteers' ? 'cancelled' : outcome
    if (p && !t.left) {
      const end: Extract<ServerMessage, { t: 'pilotEnd' }> = { t: 'pilotEnd', event: ev.id, reason, downs: ev.downs, steeredMs }
      if (gold > 0) end.gold = gold
      if (honor) end.honor = honor
      p.send(end)
    }
    this.release(t, now)
    this.turn = null
    // Her exit.
    if (m) {
      delete m.veil
      if (m.ai === 'dead') delete m.pilot
      else if (won) {
        // She roars (FIND) and leaves 8 s later, evading every hit meanwhile (§2.3).
        m.pilot = { player: null, steering: 'player' }
        this.g.world.halt(m, now)
        m.ai = 'return'
        m.target = null
        this.g.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, piloted: false })
        this.g.world.broadcastAbout(m, { t: 'cast', id: m.id, skill: `${t.conf.kit.find((k) => k.def.kind === 'fear')?.castId ?? 'PILOT_ROAR'}`, instance: 1_999_999_999, prepareMs: 0, castMs: 0, actionMs: 1500, clip: 'FIND' })
        this.exits.push({ code: ev.conf.code, mob: m.id, at: now + EXIT_MS })
      } else {
        // cancelled: a silent despawn and her normal timer.
        this.uniques.endEvent(ev.conf.code, now, `hunt ${outcome}`)
      }
    }
    if (m?.ai === 'dead' || outcome === 'killed') this.uniques.setEvent(ev.conf.code, false)
    ev.turn = t
    this.store.update(ev.id, { reward_gold: gold, steered_ms: steeredMs })
    // The result (§2.2 ended; the pilot named only now) is huntEvent 'ended': the client's banner and chat line.
    this.finish(ev, outcome, now)
  }

  /**
   * The event row ends with `outcome`; huntEvent 'ended' to everyone; the event is over. A restart or a cancel refunds
   * the turn (§2.3: it does not count for the lottery's cooldown); the call's hold on her timer ends.
   */
  private finish(ev: HuntEvent, outcome: HuntOutcome, now: number): void {
    ev.phase = 'ended'
    ev.outcome = outcome
    ev.offer = null
    const stats: Record<string, unknown> = { associatePct: Math.round(ev.associatePct * 10) / 10, area: ev.area, origin: ev.origin }
    if (ev.fromCall) Object.assign(stats, { volunteers: this.store.volunteerCount(ev.id), draws: ev.draws })
    if (ev.scale) Object.assign(stats, { peakHunters: ev.scale.peakHunters, peakMaxHp: ev.scale.peakMaxHp, baseMaxHp: ev.scale.baseMaxHp })
    this.store.update(ev.id, {
      phase: 'ended',
      ended_at: now,
      outcome,
      downs: ev.downs,
      hunters: ev.hunters.size,
      flags: JSON.stringify(ev.flags),
      stats: JSON.stringify(stats),
      ...(outcome === 'restart' || outcome === 'cancelled' ? { refunded: 1 } : {}),
    })
    this.store.log(ev.id, 'end', { outcome, downs: ev.downs, hunters: ev.hunters.size, flags: ev.flags }, now)
    this.uniques.hold(ev.conf.code, 0)
    this.lottery.forgetRecent()
    this.broadcastEvent(ev, now, true)
    this.g.config.log(`pilot: event ${ev.id} ended: ${outcome}${ev.turn ? ` (pilot ${ev.turn.name}, ${ev.downs} downs)` : ''}`)
    if (this.event === ev) this.event = null
  }

  /** A GM / admin stop (§2.5): the current event at any phase, or an attach session. */
  stop(confQ: string, who: string, now: number): { ok: true; message: string; event: number | null } | { ok: false; status: number; message: string } {
    const ev = this.event
    if (ev && ev.phase !== 'ended') {
      if (confQ) {
        const conf = this.conf(confQ)
        if (typeof conf === 'string') return { ok: false, status: 404, message: conf }
        if (conf !== ev.conf) return { ok: false, status: 409, message: `No event runs on ${conf.name}.` }
      }
      this.store.log(ev.id, 'gm', { action: 'stop', by: who }, now)
      if (ev.phase === 'call') {
        this.finish(ev, 'cancelled', now)
        return { ok: true, message: `Event ${ev.id} cancelled (the call was called off).`, event: ev.id }
      }
      if (ev.phase === 'offer') {
        const what = ev.offer || !ev.fromCall ? 'the offer was withdrawn' : 'the draw was called off'
        this.finish(ev, 'cancelled', now)
        return { ok: true, message: `Event ${ev.id} cancelled (${what}).`, event: ev.id }
      }
      this.endHunt(ev, 'cancelled', now)
      return { ok: true, message: `Event ${ev.id} cancelled; ${ev.conf.name} left silently (her normal timer runs).`, event: ev.id }
    }
    if (this.turn && !this.turn.event) {
      const name = this.turn.name
      this.detach(now)
      return { ok: true, message: `${name}'s attach session ended.`, event: null }
    }
    return { ok: false, status: 409, message: 'Nothing is running.' }
  }

  // ---- GM attach (layer 1's test tool) ------------------------------------------------------------------------

  attach(confQ: string, name: string, now: number): { ok: boolean; message: string } {
    this.boot(now)
    const conf = this.conf(confQ)
    if (typeof conf === 'string') return { ok: false, message: conf }
    const why = this.busyWhy(conf)
    if (why) return { ok: false, message: why }
    const p = this.g.world.byName(name.replace(/^@/, ''))
    if (!p) return { ok: false, message: `No online character named ${name}.` }
    if (p.dead) return { ok: false, message: `${p.name} is dead.` }
    const m = this.uniques.unique(conf.code)?.live
    if (!m) return { ok: false, message: `${conf.name} is not alive. /unique spawn ${conf.name.toLowerCase()} first.` }
    const restore = { home: [m.home[0], m.home[1]] as [number, number], leashRange: m.leashRange }
    m.leashRange = Math.max(m.leashRange, conf.settings.hunt.radiusM)
    const t = this.startTurn(conf, p, m, null, { x: m.home[0], z: m.home[1], r: conf.settings.hunt.radiusM }, now)
    t.restore = restore
    return { ok: true, message: `${p.name} steers ${m.name} (id ${m.id}); no event rules. /unique pilot detach ends it.` }
  }

  detach(now: number): { ok: boolean; message: string } {
    const t = this.turn
    if (!t || t.event) return { ok: false, message: t ? 'An event runs; /unique pilot stop ends it.' : 'Nobody is attached.' }
    const p = t.player === null ? undefined : this.g.world.players.get(t.player)
    p?.send({ t: 'pilotEnd', event: 0, reason: 'cancelled', steeredMs: Math.round(this.steered(t, now)) })
    const name = t.name
    this.release(t, now)
    this.endAttach(t, now)
    return { ok: true, message: `${name} no longer steers ${t.conf.name}.` }
  }

  /** An attach session is over: her normal rules come back (home, leash, regen, refill). */
  private endAttach(t: Turn, now: number): void {
    if (this.turn === t) this.turn = null
    this.release(t, now)
    const m = this.g.world.mobs.get(t.mob)
    if (!m) return
    if (m.ai !== 'dead') this.kit.endStalk(t, m, now)
    delete m.pilot
    delete m.veil
    if (t.restore) {
      m.home = t.restore.home
      m.leashRange = t.restore.leashRange
    }
    if (m.ai !== 'dead') this.g.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, piloted: false })
  }

  /** Whether `m` is a boss on her way out after a win. */
  private exiting(m: Mob): boolean {
    return this.exits.some((x) => x.mob === m.id)
  }

  // ---- restarts (§2.4) ----------------------------------------------------------------------------------------

  /** The restart recovery runs once, before this process starts any event of its own (the first tick or pick). */
  private boot(now: number): void {
    if (!this.booted) this.recover(now)
  }

  /**
   * Boot (§2.4): the newest call or draw found open resumes (call.ts `resume`); every other open event (a hunt, a GM
   * pick's offer) ends with the restart (outcome `restart`, the turn refunded). Then the schedule's first pass: a
   * night whose call should have opened during the downtime opens now when it is at most 30 min late.
   */
  recover(now: number): void {
    this.booted = true
    let open: PilotEventRow[]
    try {
      open = this.store.open()
    } catch (e) {
      this.g.config.log(`pilot: cannot read pilot_events: ${(e as Error).message}`)
      return
    }
    const confs = this.steerable()
    const keep = this.event ? undefined : open.filter((r) => (r.phase === 'call' || r.phase === 'draw') && r.call_ends_at !== null && confs.some((c) => c.code === r.code)).at(-1)
    for (const r of open) {
      if (r === keep) {
        this.lottery.resume(r, confs.find((c) => c.code === r.code)!, now)
        continue
      }
      if (this.event?.id === r.id) continue
      this.store.update(r.id, { phase: 'ended', ended_at: now, outcome: 'restart', refunded: 1 })
      this.store.log(r.id, 'end', { outcome: 'restart', phase: r.phase }, now)
      this.g.config.log(`pilot: event ${r.id} (${r.phase}) ended by the restart; the turn is refunded`)
    }
    for (const conf of confs) this.lottery.schedule(conf, now, true)
  }

  // ---- status (GM, admin) -------------------------------------------------------------------------------------

  status(now: number): { text: string; data: Record<string, unknown> } {
    const lines: string[] = []
    const ev = this.event
    const t = this.turn
    const data: Record<string, unknown> = { event: null, turn: null }
    if (ev && ev.phase !== 'ended') {
      if (ev.phase === 'call') lines.push(`Event ${ev.id}: the call for volunteers (${ev.origin}), the draw in ${mmssOf(ev.callEndsAt - now)}, ${ev.volunteers} volunteer${ev.volunteers === 1 ? '' : 's'}.`)
      else if (ev.phase === 'offer' && ev.offer) lines.push(`Event ${ev.id}: offered to ${ev.offer.name}${ev.offer.drawn ? ` (draw ${ev.draws} / ${ev.conf.settings.call.maxDraws})` : ''} (${Math.max(0, Math.ceil((ev.offer.expiresAt - now) / 1000))} s left).`)
      else if (ev.phase === 'offer') lines.push(`Event ${ev.id}: drawing a volunteer${ev.drawAt > now ? ` in ${mmssOf(ev.drawAt - now)}` : ''} (${ev.volunteers} volunteers, ${ev.draws} drawn).`)
      else {
        const m = ev.turn ? this.g.world.mobs.get(ev.turn.mob) : undefined
        const scale = ev.scale && m ? `, max HP ${m.maxHp} (${ev.scale.hunters} hunters in the last ${ev.conf.settings.scaling.windowSec} s)` : ''
        lines.push(`Event ${ev.id}: hunt${ev.area ? ` (${ev.area})` : ''}, ${mmssOf(ev.huntEndsAt - now)} left, downs ${ev.downs} / ${ev.conf.settings.win.downsTarget}, ${ev.hunters.size} hunters (${this.hunting(ev, now)} now)${scale}`)
      }
      data.event = this.view(ev, now)
    }
    if (t) {
      const m = this.g.world.mobs.get(t.mob)
      const hp = m ? Math.round((100 * m.hp) / m.maxHp) : 0
      lines.push(`${t.conf.name} (id ${t.mob}): ${t.player !== null ? `steered by ${t.name}` : `${t.name} left`}, steering ${t.steering}, HP ${hp}%, steered ${mmssOf(this.steered(t, now))}${t.event ? '' : ' (attach)'}.`)
      data.turn = { mob: t.mob, pilot: t.name, steering: t.steering, hpPct: hp, steeredMs: Math.round(this.steered(t, now)), attach: !t.event, left: t.left }
    }
    if (lines.length === 0) {
      const conf = this.steerable()[0]
      const night = conf ? this.lottery.nextNight(conf) : null
      lines.push(`Nothing is running. ${night !== null ? `Next Night of the Tiger: ${new Date(night).toISOString().slice(0, 16).replace('T', ' ')} UTC. ` : ''}/unique pilot start opens a call; /unique pilot <name> offers the boss to a player.`)
    }
    return { text: lines.join('\n'), data }
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10

function mmssOf(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
