import {
  JOB_LIMITS,
  STRIKE_VERTICAL_M,
  TRADE_POINT_IDS,
  ambushCount,
  ambushPoints,
  ambushRoster,
  holdAdd,
  holdCrates,
  holdSpill,
  holdTake,
  holdValue,
  isTransportCos,
  thiefTransportExp,
  tornadoAt,
  tradeKm,
  tradeStars,
  type CombatHit,
  type GameplayRequest,
  type HazardCause,
  type HoldEntry,
  type ItemDef,
  type JobRequest,
  type LightningStrike,
  type ServerMessage,
  type TradePointId,
  type TransportDef,
  type TransportView,
} from '@sro/shared'
import { attacksMagically, CORPSE_MS, rollSkillHit, type CombatStats } from '../formulas.ts'
import type { Gameplay, HitExtra } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, fail, type Fail } from '../inventory.ts'
import { strikeDamage } from '../lightning/damage.ts'
import type { Answer, GameplayMessage, GameplayModule, KillOwner, WarpReason } from '../modules.ts'
import { PLAYER_RETAIL_RUN } from '../mounts.ts'
import type { Cos, Mob, Player } from '../world.ts'
import type { TransportRow } from './trade-store.ts'

/**
 * The job system, layer 3: trade transports (docs/JOBS.md §5.4, §6.2, §6.3, §6.5, §7, §9.2). A GameplayModule named
 * `transports`, after `market`. A transport is a `Cos` entity (the retail COS_T_* model) beside the horses of mounts.ts:
 * one per character, never with a horse.
 *
 * - **Summon**: `tradeSummon {npc, tier}` at a trade point's trader (the tier's price in gold: the single-use summon), or
 *   the tier's scroll (`ITEM_COS_T_*`, `itemUse`) within `transport.ringM` of a trader. A Trader in the suit whose job
 *   level reaches the tier (§3.2). HP, hold and speed are the content's (jobs.json), the model cos.json's.
 * - **Follow**: it walks its Trader's trail (breadcrumbs, never its own pathing; §13), `transport.gapM` behind; past
 *   `transport.leashM` straight at the Trader; past `transport.waitM` it stops and waits. `transportRide {on}`: the
 *   Trader rides it at its walk speed (mountSpeed; hits on the rider land on it, no attacking from it, like a horse).
 *   Snow season: `storm.snowSpeedPct` outside town.
 * - **Attacked** while loaded by monsters (the AI sees it as a target, gameplay.ts / ai.ts), Thieves in the suit (not
 *   associates or recorded contacts of the owner, not in a job-safe place; against the tier's `transport.thiefDefence`,
 *   × `transport.thiefMul`), lightning (as a player,
 *   lightning/damage.ts), tornadoes (`storm.tornadoScatterPct` of the crates fall as bags along its path). Never healed
 *   but by GMs; no regeneration.
 * - **Death** (§6.3): `thief.dropPct` of each good's crates fall as goods bags around it, the rest is destroyed; the gold
 *   paid stays paid. Its Trader's death: it stays `transport.ownerDeathS` (a target), then dies the same way. Thieves who
 *   dealt ≥ 25 % of its HP get job EXP (§3.1).
 * - **Bags** last `thief.bagLifeMin`, are shown (`bag` / `bagGone`) to players in job mode and the owner; `bagPick`: the
 *   owner or his party put them back into the owner's transport (no transport: into the owner's own sack, layer 4);
 *   Thieves take them as stolen goods, Bounty Hunters as recovered goods (jobs/robbery.ts).
 * - **Ambushes** (§6.2): on leaving the post where the load was bought, `ambushCount(stars)` groups wait at
 *   `ambush.fromPct-toPct` of the straight road to the declared destination; one springs `ambush.offRoadM` off the road
 *   when the transport passes its point: `ambush.groupMin-groupMax` Bandits (ambushRoster: B5 near Jangan, B7 / B8 past
 *   `ambush.farKm`; the Climb's rows keep their monster roles) charging the transport. Unkilled, they leave after
 *   `ambush.lifeMin`.
 * - **Refusals while loaded**: return scrolls (item-use hook), the suit off and leaving the job (jobs.carrying),
 *   dismissing (`loaded`).
 * - **Persistence** (`transports`, migration 26): written on every change of the hold, its HP (at most every SAVE_MS)
 *   and its spot. Logout: an empty one is dismissed; a loaded one lingers `transport.lingerS` (a target), then is kept and
 *   comes back where it stood at the next login (a relog within the linger takes it over at once).
 * - GM `transport`, `ambush`, `bag`; the admin view's transports list.
 */

const SAVE_MS = 5000
const STEP_MS = 250
const TRAIL_STEP_M = 3
const TRAIL_MAX = 400
/** A goods bag is picked up from this close (m). */
export const BAG_PICK_M = 4
/** The rider boards from this close (m). */
const BOARD_M = 4
const RIDE_COMBAT_LOCK_MS = 10_000
const BAG_SYNC_MS = 1000
const ATTACK_NOTE_MS = 10_000
/** A Thief who dealt this share of its HP is credited with the kill (§3.1). */
const THIEF_CREDIT = 0.25

/** A transport's defence (no level of its own in the cap's world): a sturdy pack animal of level 20. */
export const TRANSPORT_COMBAT: CombatStats = {
  level: 20,
  physAttack: [0, 0],
  magAttack: [0, 0],
  physDefence: 60,
  magDefence: 60,
  physAbsorb: 0,
  magAbsorb: 0,
  hitRate: 0,
  parryRate: 20,
  blockRate: 0,
  critRate: 0,
  balance: 1,
}

/** A transport's defence against players (Thieves): the tier's `transport.thiefDefence` (§5.4; monsters: TRANSPORT_COMBAT). */
export function transportCombatVsPlayers(tier: number, thiefDefence: readonly number[]): CombatStats {
  const d = Math.max(0, thiefDefence[Math.min(thiefDefence.length, Math.max(1, tier)) - 1] ?? TRANSPORT_COMBAT.physDefence)
  return { ...TRANSPORT_COMBAT, physDefence: d, magDefence: d }
}

export interface LiveTransport {
  c: Cos
  def: TransportDef
  characterId: number
  ownerName: string
  hold: HoldEntry[]
  dest: TradePointId | null
  from: TradePointId | null
  stars: number
  crates: number
  capacity: number
  trail: { x: number; z: number }[]
  waiting: boolean
  /** Told to stay where it stands (`transportFollow {on: false}`): no follow steps until told to follow or ridden. */
  staying: boolean
  nextStepAt: number
  /** Its Trader died at (0: alive). */
  ownerDiedAt: number
  /** Its Trader logged out: it leaves the world then (0: online). */
  lingerUntil: number
  /** Ambush points still ahead (fractions of the road), and whether they were planned for this load. */
  ambushAt: number[]
  ambushPlanned: boolean
  /** Ambush groups sprung on this load. */
  ambushes: number
  /** Damage by player character id (the Thieves' credit). */
  damage: Map<number, number>
  /** Tornadoes that already scattered it. */
  scattered: Set<number>
  dirty: boolean
  savedAt: number
  lastNoteAt: number
}

export interface Bag {
  id: number
  /** The robbery it fell from (a transport's death, a tornado, a carrier's death): the pair rule counts robberies by it. */
  batch: number
  x: number
  y: number
  z: number
  good: string
  crates: number
  cost: number
  ownerChar: number
  ownerName: string
  expiresAt: number
}

export class TransportService implements GameplayModule {
  readonly name = 'transports'
  readonly handles: readonly GameplayRequest[] = ['tradeSummon', 'transportRide', 'transportDismiss', 'transportFollow', 'bagPick'] satisfies readonly JobRequest[]
  /** characterId -> its transport (alive, lingering or a corpse). */
  private readonly live = new Map<number, LiveTransport>()
  private readonly byEntity = new Map<number, LiveTransport>()
  readonly bags = new Map<number, Bag>()
  /** Player entity id -> the bag ids it was sent. */
  private readonly bagViews = new Map<number, Set<number>>()
  /** Ambushers alive: mob id -> when they leave. */
  private readonly ambushers = new Map<number, number>()
  private nextBagSync = 0

  constructor(private readonly g: Gameplay) {
    g.world.decorators.push((e, s) => {
      if (e.kind === 'player') {
        const r = this.riddenLive(e)
        if (r) s.mount = r.c.id
        return
      }
      if (e.kind !== 'cos') return
      const t = this.byEntity.get(e.id)
      if (t && t.stars > 0 && t.c.diedAt === 0) s.stars = t.stars
    })
    // riding at the transport's walk pace (the horse's mountSpeed seam)
    g.skills.addModProvider((p) => {
      const t = this.riddenLive(p)
      return t ? [{ stat: 'mountSpeed', value: this.speed(t, this.g.now) / PLAYER_RETAIL_RUN }] : []
    })
    g.lightning.onStrike((e) => {
      if (e.phase === 'land') this.strike(e.strike, this.g.now)
    })
    g.itemUses.hooks.push((p, def, bag, group, answer, now) => this.itemHook(p, def, bag, group, answer, now))
    g.jobs.carrying.push((p) => (this.loaded(p.characterId) ? `Your ${this.of(p.characterId)!.def.name} is loaded: sell the goods first.` : null))
  }

  private get s() {
    return this.g.jobs.settings
  }

  // ---- queries --------------------------------------------------------------------------------------------------------------

  /** The live (not dead) transport of a character. */
  of(characterId: number): LiveTransport | null {
    const t = this.live.get(characterId)
    return t && t.c.diedAt === 0 ? t : null
  }

  /** The live transport entity `id`. */
  byId(id: number): LiveTransport | null {
    const t = this.byEntity.get(id)
    return t && t.c.diedAt === 0 ? t : null
  }

  /** Whether `c` is a trade transport (dealHits routes its hits here). */
  owns(c: Cos): boolean {
    return this.byEntity.has(c.id)
  }

  loaded(characterId: number): boolean {
    const t = this.of(characterId)
    return !!t && t.crates > 0
  }

  private riddenLive(p: Player): LiveTransport | null {
    const t = this.of(p.characterId)
    return t && t.c.rider === p.id ? t : null
  }

  /** The transport `p` rides (mounts.ts treats it like a ridden horse). */
  ridden(p: Player): Cos | null {
    return this.riddenLive(p)?.c ?? null
  }

  /** Its walk speed now (the snow season slows it outside town). */
  speed(t: LiveTransport, now: number): number {
    let v = t.def.speed
    if (this.g.winter.active(now)) {
      const [x, , z] = this.g.world.positionAt(t.c, now)
      if (!this.g.data.inSafeArea(this.g.config.world, x, z)) v *= 1 + this.s.storm.snowSpeedPct / 100
    }
    return Math.max(0.5, v)
  }

  view(t: LiveTransport): TransportView {
    return {
      id: t.c.id,
      tier: t.def.tier,
      name: t.def.name,
      hp: Math.round(t.c.hp),
      maxHp: t.c.maxHp,
      capacity: t.capacity,
      hold: t.hold.map((e) => ({ ...e })),
      stars: t.stars,
      dest: t.dest,
      from: t.from,
      ridden: t.c.rider !== null,
      ...(t.staying ? { staying: true } : {}),
    }
  }

  private sendState(t: LiveTransport | null, characterId: number): void {
    const p = this.g.jobs.playerOf(characterId)
    if (p) p.send({ t: 'transportState', transport: t && t.c.diedAt === 0 ? this.view(t) : null })
  }

  // ---- the hold (the market's calls) ------------------------------------------------------------------------------------------

  private restar(t: LiveTransport, now: number): void {
    const before = t.stars
    t.crates = holdCrates(t.hold)
    t.stars = t.crates > 0 ? tradeStars(holdValue(t.hold), this.s.trade.starThresholds) : 0
    if (t.stars !== before && t.c.diedAt === 0) this.g.world.broadcastAbout(t.c, { t: 'entityUpdate', id: t.c.id, stars: t.stars })
    if (t.crates === 0) {
      t.ambushAt = []
      t.ambushPlanned = false
      t.ambushes = 0
    }
    this.save(t, now)
    this.sendState(t, t.characterId)
  }

  /** Crates bought into the hold (market.ts); the destination is declared, the ambushes are planned on departure. */
  load(t: LiveTransport, good: string, crates: number, cost: number, dest: TradePointId, from: TradePointId, now: number): void {
    t.hold = holdAdd(t.hold, good, crates, cost)
    t.dest = dest
    t.from = from
    t.ambushAt = []
    t.ambushPlanned = false
    this.restar(t, now)
  }

  /** Crates sold out of the hold (market.ts). */
  unload(t: LiveTransport, good: string, crates: number, now: number): { crates: number; cost: number } {
    const r = holdTake(t.hold, good, crates)
    t.hold = r.hold
    if (holdCrates(t.hold) === 0) {
      t.dest = null
      t.from = null
    }
    this.restar(t, now)
    return { crates: r.crates, cost: r.cost }
  }

  // ---- requests -------------------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'tradeSummon':
        return answer(this.summonAt(p, msg.npc, msg.tier, now))
      case 'transportRide':
        return answer(msg.on ? this.board(p, now) : this.stepDownReq(p, now))
      case 'transportDismiss': {
        const t = this.of(p.characterId)
        if (!t) return answer(fail('not_found', 'You have no transport.'))
        if (t.crates > 0) return answer(fail('loaded', `Your ${t.def.name} is loaded: sell the goods first.`))
        answer(true)
        return this.remove(t, true)
      }
      case 'transportFollow':
        return answer(this.setFollow(p, msg.on, now))
      case 'bagPick':
        return answer(this.pick(p, msg.id, now))
      default:
        return answer(fail('not_found'))
    }
  }

  /** Why `p` may not summon a transport of `def` now (null: may). */
  private summonProblem(p: Player, def: TransportDef, now: number): Fail | null {
    if (p.dead) return fail('dead')
    if (this.g.jobs.jobOf(p.characterId) !== 'trader') return fail('requirements', 'Only Traders summon trade transports.')
    if (!this.g.jobs.inMode(p.characterId)) return fail('not_job_mode', 'Put on your Trader suit first.')
    const level = this.g.jobs.levelOf(p.characterId)
    if (level < def.jobLevel) return fail('requirements', `The ${def.name} is for Traders of job level ${def.jobLevel}.`)
    if (this.of(p.characterId) || this.g.mounts.horseOf(p)) return fail('cos_active', 'Cannot summon more than one transport.')
    if (now - p.lastCombatAt < RIDE_COMBAT_LOCK_MS) return fail('in_combat')
    return null
  }

  private defOf(tier: number): TransportDef | undefined {
    return this.g.jobs.content.transports.find((d) => d.tier === tier)
  }

  /** `tradeSummon`: at a trade point's trader, paying the tier's price. */
  summonAt(p: Player, npcId: number, tier: number, now: number): true | Fail {
    const at = this.g.market.at(p, npcId, now)
    if ('reason' in at) return at
    const def = this.defOf(tier)
    if (!def) return fail('not_found')
    const why = this.summonProblem(p, def, now)
    if (why) return why
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) =>
      d.gold < def.price ? fail('not_enough_gold', `A ${def.name} costs ${def.price.toLocaleString('en-US')} gold.`) : addGold(d, -def.price),
    )
    if (!result.ok) return result as Fail
    this.g.afterInventory(p, draft)
    this.summon(p, def, def.hp, null, now)
    this.g.market.log(p.characterId, 'summon', at.post.id, null, 0, def.price, 0, now)
    return true
  }

  /** The tier's scroll (itemUse): within the ring of a trade point's trader. Return scrolls are refused while loaded. */
  private itemHook(p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number): boolean {
    if (def.use?.returnToTown && this.loaded(p.characterId)) {
      answer(fail('loaded', 'Not with a loaded transport: the goods would stay on the road.'))
      return true
    }
    const code = def.use?.summon
    if (!code || !isTransportCos(code)) return false
    const td = this.g.jobs.content.transports.find((d) => d.cos === code)
    if (!td) {
      answer(fail('not_usable', 'That transport is not available.'))
      return true
    }
    const why = this.summonProblem(p, td, now)
    if (why) {
      answer(why)
      return true
    }
    const ring = this.s.transport.ringM
    const near = [...this.g.world.npcs.values()].some((n) => this.g.market.offers(n.code) && this.g.world.distance(p, n, now) <= ring)
    if (!near) {
      answer(fail('wrong_place', 'Trade transports are summoned at a trade post (or by Jodaesan in Jangan).'))
      return true
    }
    if (this.g.itemUses.consume(p, def, bag, group, answer, now)) this.summon(p, td, td.hp, null, now)
    return true
  }

  /** Creates the transport at `p`'s feet (or at a saved spot), empty unless `row` restores one. */
  private summon(p: Player, def: TransportDef, hp: number, row: TransportRow | null, now: number): LiveTransport {
    const cosDef = this.g.mounts.defs.get(def.cos)
    let at = this.g.world.livePoint(p, now)
    if (row) {
      const q = this.g.nav.place(row.x, row.z, row.y, 6)
      at = q ?? { x: row.x, y: row.y, z: row.z, surface: null }
    }
    const c: Cos = {
      kind: 'cos',
      id: this.g.world.newId(),
      code: def.cos,
      name: def.name,
      level: cosDef?.level ?? 20,
      owner: p.id,
      ownerChar: p.characterId,
      hp: Math.max(1, Math.min(def.hp, hp)),
      maxHp: def.hp,
      radius: cosDef?.radius ?? 1.2,
      rider: null,
      diedAt: 0,
      pos: [at.x, at.y, at.z],
      yaw: p.yaw,
      move: null,
      surface: at.surface,
      path: null,
    }
    let hold: HoldEntry[] = []
    if (row) {
      try {
        hold = (JSON.parse(row.hold) as HoldEntry[]).filter((e) => e && typeof e.good === 'string' && e.crates > 0)
      } catch {
        hold = []
      }
    }
    const t: LiveTransport = {
      c,
      def,
      characterId: p.characterId,
      ownerName: p.name,
      hold,
      dest: row && TRADE_POINT_IDS.includes(row.dest as TradePointId) ? (row.dest as TradePointId) : null,
      from: row && TRADE_POINT_IDS.includes(row.origin as TradePointId) ? (row.origin as TradePointId) : null,
      stars: 0,
      crates: 0,
      capacity: def.hold,
      trail: [],
      waiting: false,
      staying: false,
      nextStepAt: 0,
      ownerDiedAt: 0,
      lingerUntil: 0,
      ambushAt: [],
      ambushPlanned: false,
      ambushes: 0,
      damage: new Map(),
      scattered: new Set(),
      dirty: false,
      savedAt: now,
      lastNoteAt: 0,
    }
    const old = this.live.get(p.characterId)
    if (old) this.drop(old)
    this.live.set(p.characterId, t)
    this.byEntity.set(c.id, t)
    t.crates = holdCrates(hold)
    t.stars = t.crates > 0 ? tradeStars(holdValue(hold), this.s.trade.starThresholds) : 0
    this.g.world.addEntity(c, now)
    this.save(t, now)
    this.sendState(t, p.characterId)
    if (!row) p.send({ t: 'chat', channel: 'system', text: `Your ${def.name} is ready: it carries ${def.hold} crates and follows you.` })
    return t
  }

  private board(p: Player, now: number): true | Fail {
    const t = this.of(p.characterId)
    if (!t) return fail('not_found', 'You have no transport.')
    if (t.c.rider !== null) return fail('mounted')
    if (p.dead) return fail('dead')
    if (this.g.mounts.ridden(p)) return fail('mounted')
    if (now - p.lastCombatAt < RIDE_COMBAT_LOCK_MS) return fail('in_combat')
    if (this.g.world.distance(p, t.c, now) > BOARD_M) return fail('too_far')
    this.g.posture.standUp(p)
    this.g.world.halt(p, now)
    t.c.rider = p.id
    t.trail = []
    t.staying = false
    this.follow(t, p)
    this.g.refresh(p)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, mount: t.c.id })
    this.g.world.broadcastAbout(t.c, { t: 'entityUpdate', id: t.c.id, rider: p.id })
    this.sendState(t, p.characterId)
    return true
  }

  /** `transportFollow`: it follows its Trader again, or stays where it stands (not while ridden). */
  setFollow(p: Player, on: boolean, now: number): true | Fail {
    const t = this.of(p.characterId)
    if (!t) return fail('not_found', 'You have no transport.')
    if (t.c.rider !== null) return fail('mounted', 'Step down first.')
    if (t.staying === !on) return true
    t.staying = !on
    t.trail = []
    t.waiting = false
    t.nextStepAt = 0
    if (!on && t.c.move) this.g.world.halt(t.c, now)
    p.send({ t: 'chat', channel: 'system', text: on ? `Your ${t.def.name} follows you again.` : `Your ${t.def.name} stays here.` })
    this.sendState(t, p.characterId)
    return true
  }

  private stepDownReq(p: Player, now: number): true | Fail {
    const t = this.riddenLive(p)
    if (!t) return fail('not_mounted')
    this.stepDown(t, p, now)
    return true
  }

  private stepDown(t: LiveTransport, p: Player, now: number): void {
    const here = this.g.world.livePoint(p, now)
    t.c.rider = null
    t.c.move = null
    t.c.path = null
    t.c.pos = [here.x, here.y, here.z]
    t.c.surface = here.surface
    this.g.refresh(p)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, mount: null })
    this.g.world.broadcastAbout(t.c, { t: 'entityUpdate', id: t.c.id, rider: null })
    this.sendState(t, p.characterId)
  }

  private follow(t: LiveTransport, rider: Player): void {
    const c = t.c
    c.pos = [...rider.pos]
    c.move = rider.move
    c.path = rider.path ?? null
    c.surface = rider.surface ?? null
    c.yaw = rider.yaw
  }

  // ---- the road -----------------------------------------------------------------------------------------------------------------

  /** One follow step of a transport whose Trader walks (§5.4): the trail, the leash, the wait. */
  private step(t: LiveTransport, owner: Player, now: number): void {
    const w = this.g.world
    const set = this.s.transport
    const o = w.positionAt(owner, now)
    const last = t.trail.at(-1)
    if (!last || Math.hypot(o[0] - last.x, o[2] - last.z) >= TRAIL_STEP_M) {
      t.trail.push({ x: o[0], z: o[2] })
      if (t.trail.length > TRAIL_MAX) t.trail.splice(0, t.trail.length - TRAIL_MAX)
    }
    const c = w.positionAt(t.c, now)
    const d = Math.hypot(o[0] - c[0], o[2] - c[2])
    if (d > set.waitM) {
      if (t.c.move) w.halt(t.c, now)
      t.trail = []
      if (!t.waiting) {
        t.waiting = true
        owner.send({ t: 'chat', channel: 'system', text: `Your ${t.def.name} stops and waits for you (farther than ${set.waitM} m).` })
      }
      return
    }
    t.waiting = false
    if (d <= set.gapM + 0.5) {
      if (t.c.move) w.halt(t.c, now)
      t.trail = []
      return
    }
    // breadcrumbs it has reached (or passed: closer to the Trader than it) go
    while (t.trail.length > 0) {
      const b = t.trail[0]!
      if (Math.hypot(b.x - c[0], b.z - c[2]) < 1.5 || Math.hypot(b.x - o[0], b.z - o[2]) > d + 0.5) t.trail.shift()
      else break
    }
    let goal: { x: number; z: number }
    const b = t.trail[0]
    if (d > set.leashM || !b || Math.hypot(b.x - o[0], b.z - o[2]) <= set.gapM) {
      const k = (d - set.gapM) / d
      goal = { x: c[0] + (o[0] - c[0]) * k, z: c[2] + (o[2] - c[2]) * k }
    } else goal = b
    const m = t.c.move
    if (m && Math.hypot(m.to[0] - goal.x, m.to[2] - goal.z) < 1 && w.arrivalTime(m) > now) return
    w.moveEntity(t.c, goal.x, goal.z, this.speed(t, now), now)
  }

  /** Plans the load's ambushes when it leaves its post; springs them as it passes their points (§6.2). */
  private road(t: LiveTransport, now: number): void {
    if (t.crates === 0 || !t.from || !t.dest) return
    const from = this.g.market.post(t.from)
    const dest = this.g.market.post(t.dest)
    if (!from || !dest) return
    const [x, , z] = this.g.world.positionAt(t.c, now)
    if (!t.ambushPlanned) {
      if (Math.hypot(x - from.x, z - from.z) <= this.s.transport.ringM * 2) return
      t.ambushPlanned = true
      t.ambushAt = ambushPoints(ambushCount(t.stars, this.s.ambush.perStar.map((n) => n * this.g.caravan.mul('ambush', now)), this.g.rng), this.s.ambush, this.g.rng)
    }
    const dx = dest.x - from.x
    const dz = dest.z - from.z
    const len2 = dx * dx + dz * dz
    if (len2 <= 0) return
    const f = ((x - from.x) * dx + (z - from.z) * dz) / len2
    while (t.ambushAt.length > 0 && t.ambushAt[0]! <= f) {
      t.ambushAt.shift()
      this.ambush(t, now)
    }
  }

  /** One bandit group charges transport `t` (GM `ambush` too). Returns how many came. */
  ambush(t: LiveTransport, now: number, size?: number): number {
    const a = this.s.ambush
    const [x, , z] = this.g.world.positionAt(t.c, now)
    const jangan = this.g.market.post('jangan')
    const far = jangan ? tradeKm(jangan, { x, z }) > a.farKm : false
    const danger = Math.max(this.g.market.post(t.from ?? 'jangan')?.danger ?? 0, this.g.market.post(t.dest ?? 'jangan')?.danger ?? 0)
    const def = ambushRoster(far, danger)
      .map((code) => this.g.data.mob(code))
      .find((m) => m !== undefined)
    if (!def) {
      this.g.config.log('transports: no ambush (none of the bandit rows is in mobs.json)')
      return 0
    }
    const lo = Math.min(a.groupMin, a.groupMax)
    const hi = Math.max(a.groupMin, a.groupMax)
    const n = size ?? lo + Math.floor(this.g.rng() * (hi - lo + 1))
    // off the road: across the way it travels (or any side when it stands)
    const heading = t.c.move ? Math.atan2(t.c.move.to[0] - t.c.move.from[0], t.c.move.to[2] - t.c.move.from[2]) : this.g.rng() * Math.PI * 2
    const side = (this.g.rng() < 0.5 ? -1 : 1) * (Math.PI / 2)
    const cx = x + Math.sin(heading + side) * a.offRoadM
    const cz = z + Math.cos(heading + side) * a.offRoadM
    let made = 0
    for (let i = 0; i < n; i++) {
      const at = this.g.nav.place(cx + (this.g.rng() - 0.5) * 8, cz + (this.g.rng() - 0.5) * 8, NaN, 10) ?? this.g.nav.place(x, z, NaN, 10)
      if (!at) continue
      const m = this.g.createMob(def, 'normal', at.x, at.z, at.y, null, now, at.surface, undefined, (m) => {
        m.aggressive = true
        m.sightRange = Math.max(m.sightRange, 40)
        m.leashRange = Math.max(m.leashRange, a.offRoadM + 120)
        m.roamRadius = 5
        m.ai = 'chase'
        m.target = t.c.id
        m.nextThinkAt = 0
      })
      this.ambushers.set(m.id, now + a.lifeMin * 60_000)
      made++
    }
    if (made > 0) {
      t.ambushes++
      const p = this.g.jobs.playerOf(t.characterId)
      p?.send({ t: 'chat', channel: 'system', text: `Bandits leap out of hiding: ${made} ${def.name ?? 'bandits'} after your ${t.def.name}!` })
      this.g.config.log(`transports: ambush of ${made} ${def.code} on ${t.ownerName}'s ${t.def.name} (${t.stars} stars)`)
    }
    return made
  }

  /** Ambushers alive now (tests, GM). */
  get ambusherCount(): number {
    return this.ambushers.size
  }

  // ---- combat ---------------------------------------------------------------------------------------------------------------------

  /** Why player `p` may not attack transport `t` (§4, §7; null: may). */
  attackRefusal(p: Player, t: LiveTransport, now: number): Fail | null {
    if (t.c.diedAt !== 0) return fail('target_dead')
    if (t.characterId === p.characterId) return fail('invalid_target')
    const jobs = this.g.jobs
    if (!jobs.settings.jobs.enabled || jobs.jobOf(p.characterId) !== 'thief' || !jobs.inMode(p.characterId)) return fail('invalid_target', 'Only Thieves in their suit rob caravans.')
    if (t.crates === 0) return fail('invalid_target', 'An empty transport is not worth robbing.')
    const [px, , pz] = this.g.world.positionAt(p, now)
    const [tx, , tz] = this.g.world.positionAt(t.c, now)
    if (jobs.inJobSafe(px, pz) || jobs.inJobSafe(tx, tz)) return fail('safe_zone', 'Towns and the trade posts are safe: the job war is fought on the roads.')
    const law = this.g.law
    const assoc = law.associates(p)
    const ownerAcc = law.accountOf(t.characterId)
    const owner = jobs.playerOf(t.characterId)
    if (assoc.chars.has(t.characterId) || (ownerAcc !== null && assoc.accounts.has(ownerAcc)) || (owner && law.isAssociate(assoc, owner))) {
      return fail('invalid_target', 'You cannot rob your own party, guild, account or friends.')
    }
    const acc = law.accountOf(p.characterId)
    if (acc !== null && ownerAcc !== null) {
      try {
        if (law.store.contactSince(acc, ownerAcc, now - law.settings.contactDays * 86_400_000)) return fail('invalid_target', 'You cannot rob someone you travelled with lately.')
      } catch {
        // no law tables in a test
      }
    }
    return null
  }

  /** Every live loaded transport (the Thieves' caravan pings, robbery.ts). */
  loadedTransports(): LiveTransport[] {
    return [...this.byEntity.values()].filter((t) => t.c.diedAt === 0 && t.crates > 0)
  }

  /** A monster's target: a loaded, live transport outside the safe areas. */
  mobTarget(id: number): Cos | undefined {
    const t = this.byId(id)
    if (!t || t.crates === 0) return undefined
    const [x, , z] = this.g.world.positionAt(t.c, this.g.now)
    return this.g.data.inSafeArea(this.g.config.world, x, z) ? undefined : t.c
  }

  /** Loaded transports within `range` of x/z (an aggressive monster's sight). */
  targetsNear(x: number, z: number, range: number): Cos[] {
    const out: Cos[] = []
    for (const t of this.byEntity.values()) {
      if (t.c.diedAt !== 0 || t.crates === 0) continue
      const [tx, , tz] = this.g.world.positionAt(t.c, this.g.now)
      if (Math.hypot(tx - x, tz - z) <= range && !this.g.data.inSafeArea(this.g.config.world, tx, tz)) out.push(t.c)
    }
    return out
  }

  /** A monster's swing at a transport (its basic attack against the transport's defence). */
  mobSwing(m: Mob, c: Cos, now: number): void {
    const h = rollSkillHit(m.combat, TRANSPORT_COMBAT, { pct: 100 * (m.damageMul ?? 1), magic: attacksMagically(m.combat) }, this.g.rng)
    this.g.dealHits(m, c, [{ outcome: h.outcome, damage: h.damage, hp: 0 }], {}, now)
  }

  /** The defence players' hits roll against on transport `c` (its tier's `transport.thiefDefence`). */
  combatVsPlayers(c: Cos): CombatStats {
    const t = this.byId(c.id)
    return transportCombatVsPlayers(t?.def.tier ?? 1, this.s.transport.thiefDefence)
  }

  /** A Thief's basic attack on a transport. */
  playerSwing(p: Player, c: Cos, now: number): void {
    const b = this.g.skills.basicFor(p)
    const def = this.combatVsPlayers(c)
    const hits: CombatHit[] = []
    for (let i = 0; i < Math.max(1, b.hits); i++) {
      const h = rollSkillHit(p.combat, def, { pct: b.pct }, this.g.rng)
      hits.push({ outcome: h.outcome, damage: h.damage, hp: 0 })
    }
    this.g.dealHits(p, c, hits, {}, now)
  }

  /** Rolled hits of `a` on transport `c` (Gameplay.dealHits' result shape). Players: the Thief's rule, × `transport.thiefMul`. */
  hit(a: Player | Mob, c: Cos, rolled: CombatHit[], extra: HitExtra, now: number): { dealt: number; killed: boolean; hits: CombatHit[] } {
    const t = this.byId(c.id)
    if (!t || c.hp <= 0) return { dealt: 0, killed: false, hits: [] }
    if (a.kind === 'player' && this.attackRefusal(a, t, now)) return { dealt: 0, killed: false, hits: [] }
    const hits: CombatHit[] = []
    let dealt = 0
    for (const h of rolled.slice(0, 10)) {
      let damage = Math.max(0, h.damage)
      if (a.kind === 'player' && damage > 0) damage = Math.max(1, Math.round(damage * this.s.transport.thiefMul))
      damage = Math.min(damage, Math.ceil(c.hp))
      c.hp = Math.max(0, c.hp - damage)
      dealt += damage
      hits.push({ ...h, damage, hp: Math.round(c.hp) })
      if (c.hp <= 0) break
    }
    if (hits.length === 0) return { dealt: 0, killed: false, hits }
    a.lastCombatAt = now
    const rider = c.rider === null ? undefined : this.g.world.players.get(c.rider)
    if (rider) rider.lastCombatAt = now
    if (a.kind === 'player' && dealt > 0) {
      t.damage.set(a.characterId, (t.damage.get(a.characterId) ?? 0) + dealt)
      this.g.hunters.markPvp(a.characterId, now)
    }
    const killed = c.hp <= 0
    const msg: ServerMessage = { t: 'combat', attacker: a.id, target: c.id, hits }
    if (extra.skill !== undefined) msg.skill = extra.skill
    if (extra.aoe) msg.aoe = true
    if (killed) msg.killed = true
    this.g.world.broadcastAboutEither(a, c, msg)
    t.dirty = true
    this.note(t, now)
    if (killed) this.died(t, now, a)
    else this.sendState(t, t.characterId)
    return { dealt, killed, hits }
  }

  /** Damage without an attacker (lightning): the transport counts as a player hit. */
  hazard(t: LiveTransport, damage: number, cause: HazardCause, now: number, strike?: number): number {
    const c = t.c
    if (c.diedAt !== 0 || damage <= 0) return 0
    const dealt = Math.min(Math.round(damage), Math.ceil(c.hp))
    c.hp = Math.max(0, c.hp - dealt)
    const killed = c.hp <= 0
    const msg: ServerMessage = { t: 'combat', attacker: 0, target: c.id, hits: [{ outcome: 'hit', damage: dealt, hp: Math.round(c.hp) }], cause }
    if (strike !== undefined) msg.strike = strike
    if (killed) msg.killed = true
    this.g.world.broadcastAbout(c, msg)
    t.dirty = true
    if (killed) this.died(t, now)
    else this.sendState(t, t.characterId)
    return dealt
  }

  /** "Your Donkey is under attack!" to its Trader, at most every ATTACK_NOTE_MS. */
  private note(t: LiveTransport, now: number): void {
    if (now - t.lastNoteAt < ATTACK_NOTE_MS) return
    t.lastNoteAt = now
    this.g.jobs.playerOf(t.characterId)?.send({ t: 'chat', channel: 'system', text: `Your ${t.def.name} is under attack!` })
  }

  /** A lightning bolt landed: transports in its radius are hit as players are (lightning/damage.ts). */
  strike(s: Readonly<LightningStrike>, now: number): void {
    if (s.radiusM <= 0) return
    const gy = s.groundY ?? s.pos[1]
    const y = s.kind === 'wall' ? s.pos[1] : gy
    for (const t of [...this.byEntity.values()]) {
      if (t.c.diedAt !== 0) continue
      const pos = this.g.world.positionAt(t.c, now)
      const d = Math.hypot(pos[0] - s.pos[0], pos[2] - s.pos[2])
      if (d > s.radiusM + t.c.radius || Math.abs(pos[1] - y) > STRIKE_VERTICAL_M) continue
      if (this.g.data.inSafeArea(this.g.config.world, pos[0], pos[2])) continue
      const r = strikeDamage({ kind: 'player', hp: t.c.hp, maxHp: t.c.maxHp, level: t.c.level }, Math.max(0, d - t.c.radius), s.radiusM)
      this.hazard(t, r.damage, 'lightning', now, s.id)
    }
  }

  /** A tornado on the ground scatters `storm.tornadoScatterPct` of the crates of a loaded transport it catches (§6.5). */
  private tornado(now: number): void {
    const s = this.g.tornado.current
    if (!s) return
    const at = tornadoAt(s, now)
    if (at.phase !== 'active') return
    for (const t of this.byEntity.values()) {
      if (t.c.diedAt !== 0 || t.crates === 0 || t.scattered.has(s.id)) continue
      const p = this.g.world.positionAt(t.c, now)
      if (Math.hypot(p[0] - at.pos[0], p[2] - at.pos[2]) > s.coreM + t.c.radius) continue
      if (this.g.data.inSafeArea(this.g.config.world, p[0], p[2])) continue
      t.scattered.add(s.id)
      this.scatter(t, this.s.storm.tornadoScatterPct, at.heading, now)
    }
  }

  /** `pct` of the crates fall as bags along `heading` (a tornado's path). */
  scatter(t: LiveTransport, pct: number, heading: number, now: number): number {
    const { spilled, kept } = holdSpill(t.hold, pct)
    if (spilled.length === 0) return 0
    t.hold = kept
    const [x, y, z] = this.g.world.positionAt(t.c, now)
    const batch = this.g.robbery.newBatch(now)
    spilled.forEach((e, i) => {
      const r = 4 + i * 3
      this.addBag(t, e, x + Math.sin(heading) * r, y, z + Math.cos(heading) * r, now, batch)
    })
    const n = holdCrates(spilled)
    this.restar(t, now)
    this.g.jobs.playerOf(t.characterId)?.send({ t: 'chat', channel: 'system', text: `The tornado tears ${n} crate(s) off your ${t.def.name}: pick them up before they are gone.` })
    return n
  }

  /** The transport died: bags (`thief.dropPct`), the rest destroyed, the Thieves' credit, the row gone (§6.3). */
  died(t: LiveTransport, now: number, killer?: Player | Mob): void {
    const c = t.c
    const w = this.g.world
    if (c.rider !== null) {
      const rider = w.players.get(c.rider)
      if (rider) this.stepDown(t, rider, now)
    }
    c.hp = 0
    c.diedAt = now
    c.move = null
    c.path = null
    const stars = t.stars
    const crates = t.crates
    const value = holdValue(t.hold)
    const { spilled } = holdSpill(t.hold, this.s.thief.dropPct)
    const [x, y, z] = w.positionAt(c, now)
    const batch = this.g.robbery.newBatch(now)
    spilled.forEach((e, i) => {
      const a = (i / Math.max(1, spilled.length)) * Math.PI * 2 + this.g.rng()
      this.addBag(t, e, x + Math.sin(a) * 2.5, y, z + Math.cos(a) * 2.5, now, batch)
    })
    t.hold = []
    t.crates = 0
    t.stars = 0
    w.broadcastAbout(c, { t: 'entityUpdate', id: c.id, hp: 0, state: 'dead', stars: 0 })
    try {
      this.g.market.store.deleteTransport(t.characterId)
    } catch {
      // no table in a test
    }
    const robbed = killer?.kind === 'player'
    this.g.market.log(t.characterId, robbed ? 'robbed' : 'lost', null, null, crates, value, stars, now)
    // the Thieves who did the work (≥ THIEF_CREDIT of its HP)
    for (const [cid, dmg] of t.damage) {
      if (dmg < c.maxHp * THIEF_CREDIT || this.g.jobs.jobOf(cid) !== 'thief') continue
      this.g.jobs.addExp(cid, thiefTransportExp(Math.max(1, stars), this.s.exp), now, `killed ${t.ownerName}'s ${t.def.name}`)
    }
    const dropped = holdCrates(spilled)
    const owner = this.g.jobs.playerOf(t.characterId)
    owner?.send({ t: 'chat', channel: 'system', text: `Your ${t.def.name} has died: ${dropped} of ${crates} crate(s) fell to the ground, the rest is lost.` })
    this.sendState(null, t.characterId)
    this.g.config.log(`transports: ${t.ownerName}'s ${t.def.name} died (${crates} crates, ${stars} stars, ${robbed ? 'robbed' : 'lost'}); ${dropped} dropped`)
  }

  // ---- bags ------------------------------------------------------------------------------------------------------------------------

  private addBag(t: LiveTransport, e: HoldEntry, x: number, y: number, z: number, now: number, batch: number): Bag {
    return this.dropBag(e, { characterId: t.characterId, name: t.ownerName }, batch, x, y, z, now)
  }

  /** Goods on the ground (a transport's, or a carrier's who died: layer 4), owned by the Trader `owner`. */
  dropBag(e: HoldEntry, owner: { characterId: number; name: string }, batch: number, x: number, y: number, z: number, now: number): Bag {
    const [cx, cz] = this.g.world.clamp(x, z)
    const b: Bag = {
      id: this.g.world.newId(),
      x: cx,
      y,
      z: cz,
      good: e.good,
      crates: Math.min(JOB_LIMITS.crates, e.crates),
      cost: e.cost,
      batch,
      ownerChar: owner.characterId,
      ownerName: owner.name,
      expiresAt: now + this.s.thief.bagLifeMin * 60_000,
    }
    this.bags.set(b.id, b)
    this.nextBagSync = 0
    return b
  }

  private bagMsg(b: Bag): ServerMessage {
    return { t: 'bag', id: b.id, x: b.x, z: b.z, good: b.good, crates: b.crates, owner: b.ownerName, expiresAt: b.expiresAt }
  }

  removeBag(id: number): void {
    if (!this.bags.delete(id)) return
    for (const [pid, seen] of this.bagViews) {
      if (!seen.delete(id)) continue
      this.g.world.players.get(pid)?.send({ t: 'bagGone', id })
    }
  }

  /** Who sees bags: players in job mode, the owner, staff; within the view range. */
  private syncBags(now: number): void {
    const range = this.g.world.viewRange
    for (const p of this.g.world.players.values()) {
      let seen = this.bagViews.get(p.id)
      const eligible = this.bags.size > 0 && (p.staff || this.g.jobs.inMode(p.characterId))
      if (!eligible && !seen && ![...this.bags.values()].some((b) => b.ownerChar === p.characterId)) continue
      seen ??= new Set()
      this.bagViews.set(p.id, seen)
      const [x, , z] = this.g.world.positionAt(p, now)
      for (const b of this.bags.values()) {
        const may = (eligible || b.ownerChar === p.characterId) && Math.hypot(b.x - x, b.z - z) <= range
        if (may && !seen.has(b.id)) {
          seen.add(b.id)
          p.send(this.bagMsg(b))
        } else if (!may && seen.has(b.id)) {
          seen.delete(b.id)
          p.send({ t: 'bagGone', id: b.id })
        }
      }
      for (const id of [...seen]) {
        if (this.bags.has(id)) continue
        seen.delete(id)
        p.send({ t: 'bagGone', id })
      }
    }
  }

  /**
   * `bagPick` (§6.3): the owner or his party put the goods back into the owner's transport; the owner without one takes
   * them into his own sack (layer 4); a Thief or a Bounty Hunter in the suit takes them as stolen / recovered goods
   * (jobs/robbery.ts: the anti-collusion rules, the robbery warrant).
   */
  pick(p: Player, id: number, now: number): true | Fail {
    const b = this.bags.get(id)
    if (!b || !this.bagViews.get(p.id)?.has(id)) return fail('not_found')
    if (p.dead) return fail('dead')
    const [x, , z] = this.g.world.positionAt(p, now)
    if (Math.hypot(b.x - x, b.z - z) > BAG_PICK_M) return fail('too_far')
    const mine = b.ownerChar === p.characterId || this.g.party.partyOf(b.ownerChar)?.members.some((m) => m.characterId === p.characterId) === true
    if (!mine) {
      const r = this.g.robbery.pickUp(p, b, now)
      if (r === true) this.removeBag(id)
      return r
    }
    const t = this.of(b.ownerChar)
    if (!t) {
      if (b.ownerChar !== p.characterId) return fail('not_found', 'The goods have no transport to go back into: the owner must pick them up himself.')
      const r = this.g.robbery.pickOwn(p, b, now)
      if (r === true) this.removeBag(id)
      return r
    }
    if (t.crates + b.crates > t.capacity) return fail('hold_full')
    t.hold = holdAdd(t.hold, b.good, b.crates, b.cost)
    this.removeBag(id)
    this.restar(t, now)
    this.g.market.log(b.ownerChar, 'recovered', null, b.good, b.crates, b.cost, t.stars, now)
    return true
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------------

  tick(now: number): void {
    const s = this.s.transport
    for (const t of [...this.live.values()]) {
      const c = t.c
      if (c.diedAt !== 0) {
        if (now - c.diedAt >= CORPSE_MS) this.drop(t)
        continue
      }
      if (t.lingerUntil !== 0) {
        if (now >= t.lingerUntil) {
          this.save(t, now)
          this.drop(t)
        }
        continue
      }
      const owner = this.g.jobs.playerOf(t.characterId)
      if (!owner) {
        this.save(t, now)
        this.drop(t)
        continue
      }
      if (t.ownerDiedAt !== 0) {
        if (!owner.dead && this.g.world.distance(owner, c, now) <= s.waitM) t.ownerDiedAt = 0
        else if (now - t.ownerDiedAt >= s.ownerDeathS * 1000) {
          this.died(t, now)
          continue
        }
      }
      if (c.rider === owner.id) this.follow(t, owner)
      else if (!owner.dead && t.ownerDiedAt === 0 && !t.staying && now >= t.nextStepAt) {
        t.nextStepAt = now + STEP_MS
        this.step(t, owner, now)
      }
      this.road(t, now)
      if (t.dirty && now - t.savedAt >= SAVE_MS) this.save(t, now)
    }
    this.tornado(now)
    for (const b of [...this.bags.values()]) if (now >= b.expiresAt) this.removeBag(b.id)
    for (const [id, until] of [...this.ambushers]) {
      const m = this.g.world.mobs.get(id)
      if (!m || m.ai === 'dead') this.ambushers.delete(id)
      else if (now >= until && m.ai !== 'chase') {
        this.ambushers.delete(id)
        this.g.world.removeEntity(id)
      }
    }
    if (now >= this.nextBagSync) {
      this.nextBagSync = now + BAG_SYNC_MS
      this.syncBags(now)
    }
  }

  mobDied(m: Mob, _now: number, _credit: ReadonlySet<number>, _owner: KillOwner): void {
    this.ambushers.delete(m.id)
  }

  /** Enter-world: a lingering transport is taken over; a saved one comes back where it stood. */
  enter(p: Player, now: number): void {
    const t = this.live.get(p.characterId)
    if (t && t.c.diedAt === 0) {
      t.c.owner = p.id
      t.lingerUntil = 0
      t.trail = []
      this.g.world.refreshAround(t.c, now)
      this.sendState(t, p.characterId)
      return
    }
    let row: TransportRow | null = null
    try {
      row = this.g.market.store.transport(p.characterId)
    } catch {
      row = null
    }
    if (!row) return
    const def = this.defOf(row.tier)
    if (!def || this.g.jobs.jobOf(p.characterId) !== 'trader') {
      this.g.config.log(`transports: ${p.name}'s saved transport (tier ${row.tier}) cannot come back; kept`)
      return
    }
    this.summon(p, def, row.hp, row, now)
  }

  /** Logout: an empty transport goes; a loaded one lingers `transport.lingerS` (a target), then is saved. */
  forget(p: Player): void {
    const t = this.of(p.characterId)
    this.bagViews.delete(p.id)
    if (!t) return
    const now = this.g.now
    if (t.c.rider === p.id) this.stepDown(t, p, now)
    if (t.crates === 0) return this.remove(t, false)
    t.lingerUntil = now + this.s.transport.lingerS * 1000
    if (t.c.move) this.g.world.halt(t.c, now)
    this.save(t, now)
  }

  playerDied(p: Player, now: number): void {
    const t = this.of(p.characterId)
    if (!t) return
    if (t.c.rider === p.id) this.stepDown(t, p, now)
    if (t.c.move) this.g.world.halt(t.c, now)
    if (t.crates > 0) t.ownerDiedAt = now
    else this.remove(t, true)
  }

  /** A ridden transport travels with its rider (a GM warp); an empty one goes home; a loaded one waits where it is. */
  warped(p: Player, _reason: WarpReason, now: number): void {
    const t = this.of(p.characterId)
    if (!t) return
    if (t.c.rider === p.id) {
      this.follow(t, p)
      this.g.world.refreshAround(t.c, now)
      return
    }
    t.trail = []
    if (t.crates === 0) this.remove(t, true)
  }

  /** Dismisses: the entity and the saved row go. */
  private remove(t: LiveTransport, tell: boolean): void {
    const p = this.g.jobs.playerOf(t.characterId)
    if (p && t.c.rider === p.id) this.stepDown(t, p, this.g.now)
    try {
      this.g.market.store.deleteTransport(t.characterId)
    } catch {
      // no table in a test
    }
    this.drop(t)
    this.sendState(null, t.characterId)
    if (tell && p) p.send({ t: 'chat', channel: 'system', text: `Your ${t.def.name} went home.` })
  }

  /** The entity leaves the world (the saved row is untouched). */
  private drop(t: LiveTransport): void {
    if (this.live.get(t.characterId) === t) this.live.delete(t.characterId)
    this.byEntity.delete(t.c.id)
    if (this.g.world.cos.has(t.c.id)) this.g.world.removeEntity(t.c.id)
  }

  private save(t: LiveTransport, now: number): void {
    if (t.c.diedAt !== 0 || this.live.get(t.characterId) !== t) return
    const [x, y, z] = this.g.world.positionAt(t.c, now)
    try {
      this.g.market.store.putTransport({
        character_id: t.characterId,
        tier: t.def.tier,
        code: t.def.cos,
        hp: t.c.hp,
        hold: JSON.stringify(t.hold),
        dest: t.dest,
        origin: t.from,
        stars: t.stars,
        x,
        y,
        z,
        saved_at: now,
      })
    } catch (e) {
      this.g.config.log(`transports: could not save ${t.ownerName}'s transport: ${(e as Error).message}`)
    }
    t.dirty = false
    t.savedAt = now
  }

  // ---- GM and admin (§9.5) ---------------------------------------------------------------------------------------------------------

  /** `transport <name> [status|spawn <tier>|load <stars>|kill|heal|dismiss]`. */
  gm(args: readonly string[], now: number): GmResult {
    const [name, verb, arg] = args
    if (!name) return { ok: false, message: `Usage: ${TRANSPORT_USAGE}` }
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return { ok: false, message: `No character named ${name}.` }
    const p = this.g.jobs.playerOf(row.id)
    const t = this.of(row.id)
    const v = (verb ?? 'status').toLowerCase()
    if (v === 'status') {
      if (!t) return { ok: true, message: `${row.name} has no transport${this.g.market.store.transport(row.id) ? ' in the world (one is saved)' : ''}.` }
      return { ok: true, message: `${row.name}'s ${t.def.name}: ${Math.round(t.c.hp)}/${t.c.maxHp} HP, ${t.crates}/${t.capacity} crates (${holdValue(t.hold)} gold, ${t.stars} stars), ${t.from ?? '-'} -> ${t.dest ?? '-'}, ambushes ${t.ambushes} sprung, ${t.ambushAt.length} waiting.` }
    }
    if (v === 'spawn') {
      if (!p) return { ok: false, message: `${row.name} is not online.` }
      const def = this.defOf(Number(arg ?? 1))
      if (!def) return { ok: false, message: 'Usage: transport <name> spawn <1-4>' }
      if (t) this.remove(t, false)
      const h = this.g.mounts.horseOf(p)
      if (h) this.g.mounts.gm(p, ['off'])
      const n = this.summon(p, def, def.hp, null, now)
      return { ok: true, message: `${row.name}'s ${n.def.name} summoned.` }
    }
    if (!t) return { ok: false, message: `${row.name} has no transport.` }
    if (v === 'load') {
      const stars = Math.min(5, Math.max(1, Math.floor(Number(arg ?? 1))))
      const th = this.s.trade.starThresholds
      const want = stars === 1 ? 1000 : th[stars - 2]!
      const good = this.g.jobs.content.goods.filter((x) => x.origin === 'jangan').sort((a, b) => b.base - a.base)[0]
      if (!good) return { ok: false, message: 'No goods in the content.' }
      const crates = Math.min(t.capacity, Math.max(1, Math.ceil(want / good.base)))
      t.hold = []
      this.load(t, good.code, crates, Math.max(want, crates * good.base), (arg2(args) as TradePointId) ?? 'sea-cliffs', 'jangan', now)
      return { ok: true, message: `${row.name}'s ${t.def.name}: ${crates} ${good.name}, ${t.stars} stars, bound for ${t.dest}.` }
    }
    if (v === 'kill') {
      this.died(t, now)
      return { ok: true, message: `${row.name}'s ${t.def.name} killed.` }
    }
    if (v === 'heal') {
      t.c.hp = t.c.maxHp
      this.g.world.broadcastAbout(t.c, { t: 'entityUpdate', id: t.c.id, hp: t.c.hp })
      this.save(t, now)
      this.sendState(t, t.characterId)
      return { ok: true, message: `${row.name}'s ${t.def.name} healed.` }
    }
    if (v === 'dismiss') {
      this.remove(t, true)
      return { ok: true, message: `${row.name}'s ${t.def.name} dismissed (its goods are gone).` }
    }
    return { ok: false, message: `Usage: ${TRANSPORT_USAGE}` }
  }

  /** `ambush <name> [n]`: n bandit groups at the character's transport now. */
  gmAmbush(args: readonly string[], now: number): GmResult {
    const row = args[0] ? this.g.store.characterByName(args[0].replace(/^@/, '')) : undefined
    if (!row) return { ok: false, message: `Usage: ${AMBUSH_USAGE}` }
    const t = this.of(row.id)
    if (!t) return { ok: false, message: `${row.name} has no transport.` }
    const n = Math.min(5, Math.max(1, Math.floor(Number(args[1] ?? 1)) || 1))
    let made = 0
    for (let i = 0; i < n; i++) made += this.ambush(t, now)
    return { ok: made > 0, message: made > 0 ? `${made} bandits charge ${row.name}'s ${t.def.name}.` : 'No bandit rows in mobs.json.' }
  }

  /** `bag [status|clear]`. */
  gmBag(args: readonly string[]): GmResult {
    const v = (args[0] ?? 'status').toLowerCase()
    if (v === 'clear') {
      const n = this.bags.size
      for (const id of [...this.bags.keys()]) this.removeBag(id)
      return { ok: true, message: `${n} goods bag(s) cleared.` }
    }
    if (v !== 'status') return { ok: false, message: `Usage: ${BAG_USAGE}` }
    const list = [...this.bags.values()].map((b) => `${b.crates} ${b.good} of ${b.ownerName} at ${Math.round(b.x)},${Math.round(b.z)}`)
    return { ok: true, message: list.length ? `Goods bags: ${list.slice(0, 10).join('; ')}${list.length > 10 ? ` (+${list.length - 10})` : ''}` : 'No goods bags.' }
  }

  adminTransports(): NonNullable<import('@sro/shared').AdminJobsView['transports']> {
    const out: NonNullable<import('@sro/shared').AdminJobsView['transports']> = []
    const now = this.g.now
    for (const t of this.live.values()) {
      if (t.c.diedAt !== 0) continue
      const [x, , z] = this.g.world.positionAt(t.c, now)
      out.push({ characterId: t.characterId, name: t.ownerName, tier: t.def.tier, hp: Math.round(t.c.hp), maxHp: t.c.maxHp, crates: t.crates, value: holdValue(t.hold), stars: t.stars, dest: t.dest, x, z, live: true })
    }
    try {
      for (const r of this.g.market.store.transports()) {
        if (this.live.has(r.character_id)) continue
        let hold: HoldEntry[] = []
        try {
          hold = JSON.parse(r.hold) as HoldEntry[]
        } catch {
          hold = []
        }
        const def = this.defOf(r.tier)
        out.push({
          characterId: r.character_id,
          name: this.g.store.characterById(r.character_id)?.name ?? `#${r.character_id}`,
          tier: r.tier,
          hp: r.hp,
          maxHp: def?.hp ?? r.hp,
          crates: holdCrates(hold),
          value: holdValue(hold),
          stars: r.stars,
          dest: (r.dest as TradePointId | null) ?? null,
          x: r.x,
          z: r.z,
          live: false,
        })
      }
    } catch {
      // no table
    }
    return out
  }
}

function arg2(args: readonly string[]): string | undefined {
  const d = args[3]?.toLowerCase()
  return d && (TRADE_POINT_IDS as readonly string[]).includes(d) ? d : undefined
}

export const TRANSPORT_USAGE = 'transport <name> [status|spawn <1-4>|load <stars> [dest]|kill|heal|dismiss]'
export const AMBUSH_USAGE = 'ambush <name> [groups 1-5]'
export const BAG_USAGE = 'bag [status|clear]'
