import {
  MAX_COMBAT_HITS,
  MAX_EFFECTS_PER_ENTITY,
  MOUSE_SLOT,
  yawTowards,
  type CombatHit,
  type EffectRemoveReason,
  type GameplayRequest,
  type HotbarEntry,
  type MasteryCode,
  type ServerMessage,
  type SkillDef,
  type SkillStatus,
  type SkillStatusKind,
  applyClimbArts,
  climbArtsHitMul,
} from '@sro/shared'
import { BASIC_ATTACK, imbueDamage, mobCombatStats, reductionMul, rollSkillHit, type CombatStats } from '../formulas.ts'
import type { Gameplay } from '../gameplay.ts'
import { fail, takeFromBag, type Result } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from '../modules.ts'
import type { Mob, Player } from '../world.ts'
import { SkillBook, groupOf } from './book.ts'
import { EffectTable, STATUS_RULES, effectState, overlapClass, type Effect } from './effects.ts'
import { checkLearn, checkMasteryUp } from './learn.ts'
import { applyMods, modsFromParams, sumMods, type ModTotals, type StatMod } from './mods.ts'
import { SkillStore, emptyMasteries, type SkillSave } from './store.ts'
import { selectTargets, type Candidate } from './targeting.ts'
import { arrivalAt, projectileOf, timeline, type Timeline } from './timing.ts'

/**
 * Skills engine (docs/SKILLS.md §1-§5, §10.1; docs/WAVE_PLAN.md §4.3, decisions 7-15; lane SK-S).
 *
 * - Learning: `masteryUp` (SP per levels.json, capped at the character level and CH_MASTERY_TOTAL) and `skillLearn`
 *   (the next row of a line), persisted with the SP in one transaction (skills/store.ts).
 * - The hotbar (40 slots) is persisted per character; item entries only for usable items (decision 7).
 * - `useSkill` validates in the SKILLS §10.1 order, walks into range like auto-attack, then runs the action on the
 *   tick: prepare -> cast (release: damage, heal, buff) -> action. One skill can be queued behind the running one.
 *   Moving, stopAction, a warp, death or a stun before the release interrupt it (`castEnd`; the cost and cooldown
 *   stay). Instant skills (imbues, Grass Walk) apply at once and leave the running action alone.
 * - Cooldowns are per skill group and keyed by character id: they survive a relog, not a restart (decision 8).
 * - Every hit goes through Gameplay.dealHits (decision 15): basic attacks, skills, imbue bounces and burn ticks.
 * - Effects (buffs, debuffs, imbues, toggles, statuses) live in an EffectTable; their stat mods, plus the passives,
 *   are applied in Gameplay.refresh through applyStats(); EntityState.effects comes from a World decorator.
 */

/** Rule: a chain continues while its target is within the skill's reach plus this slack (metres). */
const CHAIN_SLACK_M = 1
/**
 * Rule: at the release a targeted skill still needs its target known and within the skill's reach plus this slack
 * (metres): a friend who stepped a little away during a 2 s heal still gets it, one who warped or ran off does not.
 */
const RELEASE_SLACK_M = 10
/** Rule: fallback length of a buff whose row has no duration. */
const DEFAULT_BUFF_MS = 60_000
/** Rule: a projectile pierce line is this long when the skill has no own range (metres). */
const PROJECTILE_LINE_M = 15

/** A running action (docs/SKILLS.md §10.1 "Runtime state"). */
interface Cast {
  instance: number
  /** The row running now (a chain segment after the first follows its head). */
  row: SkillDef
  head: SkillDef
  /** Target entity id (the caster itself for self skills). */
  target: number
  tl: Timeline
  released: boolean
  /** Auto-attack target to resume when the action ends (null: none). */
  resume: number | null
  /** The caster's basic-swing time before this action (a pre-release interrupt gives it back, never earlier). */
  swingAt: number
  /**
   * A moveTo / stopAction after the release: the action still runs to its end (it cannot be cancelled, SKILLS
   * §10.1), but no chain segment and no auto-attack resume follow it.
   */
  stopped: boolean
}

interface CasterState {
  save: SkillSave
  cast: Cast | null
  queued: { skill: string; target?: number } | null
}

/** A validated use: what start() needs. */
interface Plan {
  row: SkillDef
  head: SkillDef
  group: string
  target: Player | Mob
  mp: number
  hp: number
}

/** A status a hit will inflict once it lands. */
export interface StatusRoll {
  status: SkillStatus
  row: SkillDef
}

/** Rolled hits in flight (projectiles) until `at`. */
interface Flight {
  at: number
  caster: number
  target: number
  code: string
  instance?: number
  aoe: boolean
  hits: CombatHit[]
  statuses: (StatusRoll | null)[]
}

const PARAM = (s: SkillDef | undefined, tag: string): number[] | undefined => s?.params?.find((p) => p.tag === tag)?.args

export class SkillEngine implements GameplayModule {
  readonly name = 'skills'
  readonly handles: readonly GameplayRequest[] = ['useSkill', 'skillLearn', 'masteryUp', 'buffCancel', 'hotbarSet']
  readonly whileDead: readonly GameplayRequest[] = ['hotbarSet']

  /** skills.json + masteries.json (replaceable in tests). */
  book: SkillBook
  readonly effects = new EffectTable()
  private readonly casters = new Map<number, CasterState>()
  /** characterId -> skill group -> ready time (decision 8: survives a relog, not a restart). */
  private readonly cooldowns = new Map<number, Map<string, number>>()
  /** Player id -> the move-speed multipliers last applied (GM speed x buff speed). */
  private readonly speeds = new Map<number, { applied: number; buff: number }>()
  private flights: Flight[] = []
  /** Wave 8 (docs/SYSTEMS_COMBAT.md §6.4): extra stat mods per player (mounts: speed; Berserk: damage and speed). */
  private readonly providers: ((p: Player) => StatMod[])[] = []
  /** characterId -> HP/MP when it left (world.add clamps them to the maxima without passives; enter restores). */
  private readonly lastVitals = new Map<number, { hp: number; mp: number }>()
  private nextInstance = 1
  private db: SkillStore | null = null

  constructor(readonly g: Gameplay) {
    this.book = SkillBook.load(g.config.outDir, (m) => g.config.log(m))
    g.world.decorators.push((e, s) => {
      const list = this.effects.list(e.id)
      if (list.length === 0) return
      const now = Date.now()
      s.effects = list.slice(-MAX_EFFECTS_PER_ENTITY).map((x) => effectState(x, now))
    })
  }

  private get store(): SkillStore {
    return (this.db ??= new SkillStore(this.g.store))
  }

  private state(p: Player): CasterState {
    let s = this.casters.get(p.id)
    if (!s) this.casters.set(p.id, (s = { save: this.store.load(p.characterId), cast: null, queued: null }))
    return s
  }

  private cooldownsOf(characterId: number): Map<string, number> {
    let m = this.cooldowns.get(characterId)
    if (!m) this.cooldowns.set(characterId, (m = new Map()))
    return m
  }

  private instanceId(): number {
    const id = this.nextInstance
    this.nextInstance = this.nextInstance >= 2 ** 31 ? 1 : this.nextInstance + 1
    return id
  }

  // ---- requests ------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'useSkill':
        return this.use(p, msg.skill, msg.target, answer, now)
      case 'skillLearn':
        return this.learn(p, msg.skill, answer, now)
      case 'masteryUp':
        return this.masteryUp(p, msg.mastery, answer)
      case 'buffCancel':
        return this.buffCancel(p, msg.skill, answer, now)
      case 'hotbarSet':
        return this.hotbarSet(p, msg.slot, msg.entry, answer)
    }
    answer(fail('not_found'))
  }

  private use(p: Player, code: string, targetId: number | undefined, answer: Answer, now: number): void {
    const s = this.state(p)
    // Using a toggle that is on turns it off (docs/SKILLS.md §10.2), before the cost and cooldown checks.
    const any = this.book.skill(code)
    if (any && any.toggle && !p.dead) {
      const on = this.effects.list(p.id).find((e) => e.kind === 'toggle' && e.group === groupOf(this.book.head(any)))
      if (on) {
        answer(true)
        return this.removeEffect(on, 'cancelled', now)
      }
    }
    const r = this.plan(p, code, targetId, now)
    if (!r.ok) return answer(r)
    const plan = r.value
    if (!plan.row.instant && s.cast) {
      // Busy: queue one skill (a newer request replaces it); it starts when the current action ends.
      s.queued = targetId === undefined ? { skill: plan.row.code } : { skill: plan.row.code, target: targetId }
      return answer(true)
    }
    answer(true)
    this.begin(p, plan, now)
  }

  /** SKILLS §10.1 validation, in order. The target is the caster itself for self skills. */
  plan(p: Player, code: string, targetId: number | undefined, now: number): Result<Plan> {
    // Wave 8: no skills while mounted (mounts.ts).
    const mounted = this.g.mounts.refuse(p, 'skill')
    if (mounted) return mounted
    const s = this.state(p)
    const any = this.book.skill(code)
    if (!any || any.basicAttack || any.mastery === null) return fail('not_found')
    const head = this.book.head(any)
    const group = groupOf(head)
    const have = s.save.skills.get(group) ?? 0
    if (have < head.skillLevel) return fail('not_learned')
    // The client may send any learned level: the highest learned one runs. The Climb's Arts (docs/CLIMB.md §5.1,
    // S-ARTS) change the row's numbers for this caster (a copy; climb/rewards.ts).
    const row = this.artRow(p, this.book.row(group, have) ?? head)
    if (row.kind === 'passive') return fail('not_usable', 'Passive skills work on their own.')
    if (p.dead) return fail('dead')
    // Wave 8: a broken weapon refuses the rows that need one (durability.ts).
    const broken = this.g.durability.refuse(p, row)
    if (broken) return broken
    if (this.effects.blocked(p.id, now)) return fail('cant_act')
    const req = this.requirement(p, row)
    if (req) return req
    if ((this.cooldownsOf(p.characterId).get(group) ?? 0) > now) return fail('cooldown')
    const mp = Math.round(row.mp + ((row.mpPct ?? 0) / 100) * p.maxMp)
    const hp = Math.round((row.hp ?? 0) + ((row.hpPct ?? 0) / 100) * p.maxHp)
    if (p.mp < mp) return fail('not_enough_mp')
    if (hp > 0 && p.hp <= hp) return fail('requirements', 'Not enough HP.')
    const t = this.resolveTarget(p, row, targetId, now)
    if (!t.ok) return t
    // the Hunter / Wanted fight is allowed in a safe area (docs/SIEGE.md §8.3); everything else is not
    if (this.hostile(row) && t.value.kind !== 'player') {
      const [x, , z] = this.g.world.positionAt(p, now)
      if (this.g.data.inSafeArea(this.g.config.world, x, z)) return fail('safe_zone', 'no fighting in town')
    }
    return { ok: true, value: { row, head, group, target: t.value, mp, hp } }
  }

  private hostile(row: SkillDef): boolean {
    const g = row.targets?.groups ?? []
    return row.kind === 'attack' || row.kind === 'debuff' || g.includes('enemy_mob') || g.includes('enemy_player')
  }

  /** Weapon, required item and ammunition (docs/SKILLS.md §1.4). */
  private requirement(p: Player, row: SkillDef): Result<never> | null {
    const gear = this.gear(p, row)
    if (gear) return gear
    if ((row.reqStr ?? 0) > p.progress.str || (row.reqInt ?? 0) > p.progress.int) return fail('requirements', 'Not enough STR or INT.')
    if (this.ammoNeeded(row) && this.ammoSlot(p, row.consumes!) === null) return fail('no_ammo')
    return null
  }

  /**
   * The weapon and required item (a shield) of a row. Checked at plan time and again whenever the equipment changes
   * during an action, at the release and before each chain segment, so a mid-cast weapon swap cannot release a skill
   * with another weapon's stats.
   */
  private gear(p: Player, row: SkillDef): Result<never> | null {
    if (row.weapons.length > 0 && !row.weapons.includes(p.combat.weapon as never)) return fail('wrong_weapon')
    if (row.requiresItem && !this.wears(p, row.requiresItem.typeId3, row.requiresItem.typeId4)) {
      return fail('requirements', row.requiresItem.typeId3 === 4 ? 'Needs a shield.' : 'Needs the right equipment.')
    }
    return null
  }

  private wears(p: Player, typeId3: number, typeId4: number): boolean {
    for (const st of Object.values(p.equip)) {
      const t = st ? this.g.data.item(st.code)?.typeId : undefined
      if (t && t[2] === typeId3 && t[3] === typeId4) return true
    }
    return false
  }

  private ammoNeeded(row: SkillDef | undefined): boolean {
    return (this.g.config.skillAmmo ?? 0) === 1 && !!row?.consumes && row.consumes.count > 0
  }

  /** Lowest bag slot holding enough of the ammunition, or null. */
  private ammoSlot(p: Player, c: NonNullable<SkillDef['consumes']>): number | null {
    const inv = this.g.store.loadInventory(p.characterId)
    for (let i = 0; i < inv.bag.length; i++) {
      const it = inv.bag[i]
      const t = it ? this.g.data.item(it.code)?.typeId : undefined
      if (it && t && t[2] === c.typeId3 && t[3] === c.typeId4 && it.count >= c.count) return i
    }
    return null
  }

  private takeAmmo(p: Player, row: SkillDef): boolean {
    if (!this.ammoNeeded(row)) return true
    const slot = this.ammoSlot(p, row.consumes!)
    if (slot === null) return false
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => takeFromBag(d, slot, row.consumes!.count))
    if (result.ok) this.g.afterInventory(p, draft)
    return result.ok
  }

  /** The target of a use (docs/SKILLS.md §10.1 step 5; decision 13: friendly skills may target any visible player). */
  private resolveTarget(p: Player, row: SkillDef, targetId: number | undefined, _now: number): Result<Player | Mob> {
    const w = this.g.world
    const groups = row.targets?.groups ?? []
    if (this.hostile(row)) {
      if (targetId === undefined) return fail('invalid_target', 'Select a target first.')
      const e = w.entity(targetId)
      if (!e || !p.known.has(targetId)) return fail('not_found')
      if (e.kind === 'player') {
        // Siege of Jangan layer 6 (docs/SIEGE.md §8.3): a Hunter's / a Wanted's single-target skill on the other side
        const why = this.g.hunters.refusal(p, e, this.g.now)
        return why ?? { ok: true, value: e }
      }
      if (e.kind !== 'mob') return fail('invalid_target')
      if (e.ai === 'dead') return fail('target_dead')
      if (row.requiresTargetState === 1 && !this.effects.status(e.id, 'knockdown', this.g.now)) return fail('invalid_target', 'The target must be knocked down.')
      return { ok: true, value: e }
    }
    if (row.kind === 'resurrect' || row.targets?.deadBody) {
      if (targetId === undefined || targetId === p.id) return fail('invalid_target')
      const e = w.players.get(targetId)
      if (!e || !p.known.has(targetId)) return fail('not_found')
      if (!e.dead) return fail('invalid_target', 'The target is not dead.')
      return { ok: true, value: e }
    }
    const others = groups.includes('ally') || groups.includes('party')
    if (!others || targetId === undefined || targetId === p.id) return { ok: true, value: p }
    const e = w.entity(targetId)
    if (!e || !p.known.has(targetId)) return fail('not_found')
    // A monster or NPC selected: the friendly skill lands on the caster (as the client's own target rule does).
    if (e.kind !== 'player') return { ok: true, value: p }
    if (e.dead) return fail('target_dead')
    // Party-only friendly rows (no 'ally' flag) land on the caster unless the target is in its party (decision 13).
    if (!groups.includes('ally') && !this.g.party.sameParty(p, e)) return { ok: true, value: p }
    return { ok: true, value: e }
  }

  /** Reach for a targeted action (docs/SKILLS.md §10.1 "Range"). */
  private reach(p: Player, row: SkillDef, t: Player | Mob): number {
    return (row.range > 0 ? row.range : p.combat.range) + p.radius + t.radius
  }

  private begin(p: Player, plan: Plan, now: number): void {
    if (plan.row.instant) return this.instant(p, plan, now)
    const t = plan.target
    if (t.id !== p.id && this.g.world.distance(p, t, now) > this.reach(p, plan.row, t)) {
      // Walk into range first (the auto-attack chase), then start (tickPlayer).
      p.action = { kind: 'skill', skill: plan.row.code, target: t.id, chaseAt: 0, chaseTo: null }
      return
    }
    this.start(p, plan, now)
  }

  /** t0, first half: the arrow (if ammunition is on) and the cooldown. false: the arrow is gone. */
  private arm(p: Player, plan: Plan, now: number): boolean {
    if (!this.takeAmmo(p, plan.row)) return false
    this.cooldownsOf(p.characterId).set(plan.group, now + plan.row.cooldownMs)
    return true
  }

  /** t0, second half (after `cast`, so clients see actionResult -> cast -> statsDelta): the MP and HP cost. */
  private pay(p: Player, plan: Plan): void {
    if (plan.mp > 0 || plan.hp > 0) this.g.setVitals(p, Math.max(1, p.hp - plan.hp), Math.max(0, p.mp - plan.mp))
  }

  private castMsg(p: Player, row: SkillDef, instance: number, target: number, tl: { prepareMs: number; castMs: number; actionMs: number }, instant = false): ServerMessage {
    const m: ServerMessage = { t: 'cast', id: p.id, skill: row.code, instance, prepareMs: tl.prepareMs, castMs: tl.castMs, actionMs: tl.actionMs }
    if (target !== p.id) m.target = target
    if (instant) m.instant = true
    return m
  }

  /** Instant skills (activity 1): applied now, no action; the running action is left alone. */
  private instant(p: Player, plan: Plan, now: number): void {
    if (!this.arm(p, plan, now)) return
    const instance = this.instanceId()
    this.g.world.broadcastAbout(p, this.castMsg(p, plan.row, instance, plan.target.id, { prepareMs: 0, castMs: 0, actionMs: 0 }, true))
    this.pay(p, plan)
    this.applyBuff(p, plan.row, plan.target, now, instance)
  }

  /** t0 (docs/SKILLS.md §5.1): cost, cooldown, `cast`, then the tick runs release and end. */
  private start(p: Player, plan: Plan, now: number, chain?: Cast): void {
    const s = this.state(p)
    if (!chain && !this.arm(p, plan, now)) return
    const t = plan.target
    const tl = timeline(plan.row, now)
    const prev = p.action
    const resume = plan.row.kind === 'attack' && t.kind === 'mob' ? t.id : prev?.kind === 'attack' ? prev.target : (chain?.resume ?? null)
    const c: Cast = { instance: chain?.instance ?? this.instanceId(), row: plan.row, head: plan.head, target: t.id, tl, released: false, resume, swingAt: p.nextSwingAt, stopped: false }
    s.cast = c
    p.action = null
    const w = this.g.world
    if (t.id !== p.id) {
      const pp = w.positionAt(p, now)
      const tp = w.positionAt(t, now)
      w.halt(p, now, yawTowards(tp[0] - pp[0], tp[2] - pp[2]))
    } else if (p.move) w.halt(p, now)
    p.nextSwingAt = Math.max(p.nextSwingAt, tl.endAt)
    w.broadcastAbout(p, this.castMsg(p, plan.row, c.instance, t.id, tl))
    if (!chain) this.pay(p, plan)
    this.advance(p, s, now)
  }

  /** Runs the release and the end of the running action when their time has come. */
  private advance(p: Player, s: CasterState, now: number): void {
    const c = s.cast
    if (!c) return
    if (!c.released && now >= c.tl.releaseAt) this.release(p, s, c, now)
    if (s.cast === c && c.released && now >= c.tl.endAt) this.finish(p, s, c, now)
  }

  private release(p: Player, s: CasterState, c: Cast, now: number): void {
    c.released = true
    const row = c.row
    const t = c.target === p.id ? p : this.g.world.players.get(c.target) ?? this.g.world.mobs.get(c.target)
    // The weapon or shield changed during the cast (inventoryChanged normally catches it first), or the weapon broke
    // mid-cast (a bow's earlier arrow, a hit taken): a broken weapon refuses every row that needs one (COMBAT §3.2).
    if (this.gear(p, row) || this.g.durability.refuse(p, row)) {
      this.g.world.broadcastAbout(p, { t: 'castEnd', id: p.id, instance: c.instance, reason: 'interrupted' })
      s.cast = null
      return this.afterAction(p, s, null, now)
    }
    const gone = !t || (t.kind === 'mob' ? t.ai === 'dead' : row.kind !== 'resurrect' && t.dead)
    // A target other than the caster must still be in view and within reach (plus slack): no heals across the map.
    const away = !!t && t.id !== p.id && (!p.known.has(t.id) || this.g.world.distance(p, t, now) > this.reach(p, row, t) + RELEASE_SLACK_M)
    if (gone || away || (row.kind === 'resurrect' && !(t as Player).dead)) {
      this.g.world.broadcastAbout(p, { t: 'castEnd', id: p.id, instance: c.instance, reason: 'target_lost' })
      s.cast = null
      return this.afterAction(p, s, null, now)
    }
    switch (row.kind) {
      case 'attack':
      case 'debuff':
        if (t.kind === 'player' && t.id !== p.id && !this.g.hunters.allowed(p, t, now)) {
          this.g.world.broadcastAbout(p, { t: 'castEnd', id: p.id, instance: c.instance, reason: 'target_lost' })
          s.cast = null
          return this.afterAction(p, s, null, now)
        }
        return this.strike(p, row, t, c.instance, now)
      case 'heal':
        return this.heal(p, row, t as Player, now)
      case 'resurrect':
        return this.resurrect(p, row, t as Player, now)
      case 'cure':
        this.cureStates(t, PARAM(row, 'curt')?.[1] ?? 0, PARAM(row, 'rcur')?.[0] ?? 2, now)
        return
      default:
        return this.applyBuff(p, row, t, now, c.instance)
    }
  }

  /** End of the action: the next chain segment, else the queued skill and the auto-attack. */
  private finish(p: Player, s: CasterState, c: Cast, now: number): void {
    s.cast = null
    // Stopped after the release: the action has run its course, but no chain segment or auto-attack follows.
    if (c.stopped) return this.afterAction(p, s, null, now)
    const next = this.book.chain(c.row)
    if (next) {
      // a chain on a player (the Hunter / Wanted fight) goes on while the fight is allowed
      const pt = this.g.world.players.get(c.target)
      const t = this.g.world.mobs.get(c.target) ?? (pt && pt.id !== p.id && !pt.dead && this.g.hunters.allowed(p, pt, now) ? pt : undefined)
      // A segment that broke the weapon ends the chain: the later segments need the weapon too (COMBAT §3.2).
      if (this.gear(p, next) || this.g.durability.refuse(p, next)) {
        this.g.world.broadcastAbout(p, { t: 'castEnd', id: p.id, instance: c.instance, reason: 'interrupted' })
        return this.afterAction(p, s, null, now)
      }
      if (!t || (t.kind === 'mob' && t.ai === 'dead') || !p.known.has(t.id) || this.g.world.distance(p, t, now) > this.reach(p, next, t) + CHAIN_SLACK_M) {
        this.g.world.broadcastAbout(p, { t: 'castEnd', id: p.id, instance: c.instance, reason: 'target_lost' })
        return this.afterAction(p, s, null, now)
      }
      return this.start(p, { row: this.artRow(p, next), head: c.head, group: groupOf(c.head), target: t, mp: 0, hp: 0 }, now, c)
    }
    this.afterAction(p, s, c.resume, now)
  }

  private afterAction(p: Player, s: CasterState, resume: number | null, now: number): void {
    const q = s.queued
    s.queued = null
    if (q) {
      const r = this.plan(p, q.skill, q.target, now)
      if (r.ok) return this.begin(p, r.value, now)
    }
    if (resume !== null && p.action === null) {
      const m = this.g.world.mobs.get(resume)
      if (m && m.ai !== 'dead' && p.known.has(m.id)) p.action = { kind: 'attack', target: m.id, chaseAt: 0, chaseTo: null }
    }
  }

  /**
   * A moveTo, stopAction, stun, warp or death during an action (docs/SKILLS.md §5, §10.1). Before the release the
   * action ends at once (`castEnd`; cost and cooldown stay) and the basic swing is free again, but never earlier than
   * before the skill. After the release the action cannot be cancelled: a moveTo / stopAction (`hard` false) only stops
   * the chain and the auto-attack resume, and the caster stays busy until the action's end (no animation cancel).
   * `hard` (death, warp, stun, GM reset) drops a released action too.
   */
  interrupt(p: Player, reason: 'interrupted' | 'cancelled', now: number, hard = true): void {
    const s = this.casters.get(p.id)
    if (!s) return
    s.queued = null
    const c = s.cast
    if (!c) return
    if (c.released && !hard) {
      c.stopped = true
      return
    }
    s.cast = null
    if (c.released) return
    this.g.world.broadcastAbout(p, { t: 'castEnd', id: p.id, instance: c.instance, reason })
    p.nextSwingAt = Math.min(p.nextSwingAt, Math.max(c.swingAt, now))
  }

  /**
   * A skill action (prepare, cast or action phase, or a chain between segments) is running for `p` (ItemUses asks;
   * decision 9). It stays busy until the engine's own tick has closed the action, so nothing slips in between.
   */
  busy(p: Player, _now = this.g.now): boolean {
    return !!this.casters.get(p.id)?.cast
  }

  /** Stunned, frozen or knocked down: no actions (mobs skip their AI; players cannot use skills). */
  held(e: Player | Mob, now: number): boolean {
    return this.effects.blocked(e.id, now)
  }

  // ---- damage --------------------------------------------------------------------------------------------

  /** Basic attack of a weapon (docs/WAVE_PLAN.md decision 10): its `_BASE_01` row, else BASIC_ATTACK. */
  basicFor(p: Player): { hits: number; pct: number; intervalMs: number; row: SkillDef | null } {
    const weapon = p.equip.weapon ? this.g.data.item(p.equip.weapon.code) : undefined
    const row = this.book.basic(p.combat.weapon, weapon?.basicAttack) ?? null
    if (row?.damage) return { hits: Math.max(1, row.damage.hits), pct: row.damage.physPct || row.damage.magPct, intervalMs: Math.max(200, row.cooldownMs || row.actionMs), row }
    const b = BASIC_ATTACK[p.combat.weapon as keyof typeof BASIC_ATTACK] ?? BASIC_ATTACK.fist
    return { hits: b.hits, pct: b.pct, intervalMs: b.intervalMs, row: null }
  }

  /** One basic attack of a player (all its hits), with the imbue's component and statuses. */
  basicAttack(p: Player, t: Player | Mob, now: number): void {
    const b = this.basicFor(p)
    if (b.row && this.ammoNeeded(b.row) && !this.takeAmmo(p, b.row)) {
      p.action = null
      p.send({ t: 'chat', channel: 'system', text: 'You have no arrows.' })
      return
    }
    const hits: CombatHit[] = []
    for (let i = 0; i < Math.min(MAX_COMBAT_HITS, b.hits); i++) {
      const h = rollSkillHit(p.combat, t.combat, { pct: b.pct }, this.g.rng)
      hits.push({ outcome: h.outcome, damage: h.damage, hp: 0 })
    }
    const statuses = this.imbue(p, t, hits, 1, now)
    this.land(p, t, b.row?.code, hits, statuses, {}, now)
  }

  /**
   * Rolls a skill's hits on one target (docs/SKILLS.md §10.1 "At release"): `mc` hits of the 'att' record, the
   * critical bonus ('cr'), the down-attack bonus ('da') on a knocked-down target, `mul` (area reduction), then the
   * imbue's component and every status roll.
   */
  private rollHits(a: Player, t: Player | Mob, row: SkillDef, mul: number, now: number): { hits: CombatHit[]; statuses: (StatusRoll | null)[] } {
    const d = row.damage
    if (!d) {
      // Debuffs (Cold wave - Arrest): no damage, the statuses ride one empty hit.
      const hits: CombatHit[] = [{ outcome: 'hit', damage: 0, hp: 0 }]
      return { hits, statuses: [this.rollStatuses(row, t, hits[0])] }
    }
    const magic = d.physPct === 0 && d.magPct > 0
    const da = PARAM(row, 'da')?.[0]
    const down = da !== undefined && this.effects.status(t.id, 'knockdown', now) ? da / 100 : 1
    // Storms (docs/WEATHER.md §12.2): fire force is weaker in the rain, lightning and cold stronger.
    const weather = this.g.storm?.elementMul(row) ?? 1
    // the Climb's Executioner (docs/CLIMB.md §5.1): more damage on a target under 30 % HP
    const art = this.artHitMul(a, t, row)
    const spec = { pct: magic ? d.magPct : d.physPct, flat: d.flat, magic, critBonus: PARAM(row, 'cr')?.[0] ?? 0, mul: mul * down * weather * art }
    const hits: CombatHit[] = []
    const statuses: (StatusRoll | null)[] = []
    for (let i = 0; i < Math.min(MAX_COMBAT_HITS, Math.max(1, d.hits)); i++) {
      const h = rollSkillHit(a.combat, t.combat, spec, this.g.rng)
      const hit: CombatHit = { outcome: h.outcome, damage: h.damage, hp: 0 }
      hits.push(hit)
      statuses.push(h.outcome === 'hit' || h.outcome === 'crit' ? this.rollStatuses(row, t, hit) : null)
    }
    const imbued = this.imbue(a, t, hits, mul, now)
    return { hits, statuses: statuses.map((s, i) => s ?? imbued[i]) }
  }

  /** Rolls a row's statuses for one landed hit; the first that succeeds marks the hit. Public for monster skills (wave 8). */
  rollStatuses(row: SkillDef, t: Player | Mob, hit: CombatHit): StatusRoll | null {
    for (const st of row.statuses ?? []) {
      const rule = STATUS_RULES[st.status]
      if (!rule) continue
      // Abnormal states are resisted by targets above their level (docs/SKILLS.md §4.1); crowd control is not.
      if (rule.abnormal && st.level < t.level) continue
      if (this.g.rng() * 100 >= st.chancePct) continue
      hit.status = st.status
      if (st.status === 'knockdown') hit.down = true
      return { status: st, row }
    }
    return null
  }

  /**
   * The imbue component (docs/SKILLS.md §10.1 "Imbues"): every landed hit of the carrier adds the imbue's magical
   * damage and rolls its statuses; a `chain` imbue (Thunder Tiger Force) bounces that component to the nearest others.
   */
  private imbue(a: Player | Mob, t: Player | Mob, hits: CombatHit[], mul: number, now: number): (StatusRoll | null)[] {
    const out: (StatusRoll | null)[] = hits.map(() => null)
    if (a.kind !== 'player' || t.kind !== 'mob') return out
    const e = this.effects.imbue(a.id)
    const row = e?.skill
    if (!e || !row?.damage || (e.until !== 0 && e.until <= now)) return out
    const d = row.damage
    let bounce = 0
    // Storms (docs/WEATHER.md §12.2): the imbue's element in the rain.
    const weather = this.g.storm?.elementMul(row) ?? 1
    hits.forEach((h, i) => {
      if (h.outcome !== 'hit' && h.outcome !== 'crit') return
      const extra = imbueDamage(a.combat, t.combat, d.magPct || d.physPct, d.flat, this.g.rng, mul * weather)
      h.damage += extra
      if (!bounce) bounce = extra
      if (!h.status) out[i] = this.rollStatuses(row, t, h)
    })
    if (bounce > 0 && row.area?.shape === 'chain') {
      const others = this.candidates(a, t, row.area.distance + 2, now)
      const [, ...next] = selectTargets(row.area, this.xz(a, now), this.cand(t, now), others)
      const part = Math.max(1, Math.round(bounce * reductionMul(row.area.reductionPct)))
      for (const c of next) {
        const m = this.g.world.mobs.get(c.id)
        if (m) this.land(a, m, row.code, [{ outcome: 'hit', damage: part, hp: 0 }], [null], { aoe: true }, now)
      }
    }
    return out
  }

  /** Applies hits through Gameplay.dealHits (decision 15), then the statuses of the hits that landed. */
  private land(a: Player | Mob, t: Player | Mob, code: string | undefined, hits: CombatHit[], statuses: (StatusRoll | null)[], extra: { instance?: number; at?: number; aoe?: boolean }, now: number): void {
    const r = this.g.dealHits(a, t, hits, code === undefined ? extra : { ...extra, skill: code }, now)
    if (r.killed) return
    for (let i = 0; i < r.hits.length; i++) {
      const st = statuses[i]
      if (st && r.hits[i].outcome !== 'miss' && r.hits[i].outcome !== 'block') this.applyStatus(a, t, st, now)
    }
  }

  private xz(e: Player | Mob, now: number): { x: number; z: number } {
    const p = this.g.world.positionAt(e, now)
    return { x: p[0], z: p[2] }
  }

  private cand(e: Player | Mob, now: number): Candidate {
    const p = this.g.world.positionAt(e, now)
    return { id: e.id, x: p[0], z: p[2], radius: e.radius }
  }

  /** Living enemies (mobs; no PvP) within `range` of `around`, as area candidates. */
  private candidates(caster: Player | Mob, around: Player | Mob, range: number, now: number): Candidate[] {
    const c = this.xz(around, now)
    const out: Candidate[] = []
    for (const m of this.g.world.mobs.values()) {
      if (m.ai === 'dead' || m.ai === 'return') continue
      if (caster.kind === 'player' && !caster.known.has(m.id)) continue
      const q = this.cand(m, now)
      if (Math.hypot(q.x - c.x, q.z - c.z) <= range + q.radius) out.push(q)
    }
    return out
  }

  /** An attack or debuff at release: area targets, hits per target, projectiles held until they land. */
  private strike(p: Player, row: SkillDef, primary: Player | Mob, instance: number, now: number): void {
    // a player (the Hunter / Wanted fight, docs/SIEGE.md §8.3): the primary only; areas never reach other players
    const area = primary.kind === 'player' ? undefined : row.area
    const proj = projectileOf(row)
    let targets: Candidate[] = [this.cand(primary, now)]
    if (area) {
      const from = area.shape === 'caster' ? p : primary
      const lineLen = area.shape === 'projectile_pierce' ? Math.max(row.range, PROJECTILE_LINE_M) : 0
      const range = Math.max(area.distance, lineLen, this.g.world.distance(p, primary, now)) + 3
      targets = selectTargets(area, this.xz(p, now), this.cand(primary, now), this.candidates(p, from, range, now), lineLen)
    }
    targets.forEach((c, i) => {
      const t = c.id === primary.id ? primary : this.g.world.mobs.get(c.id)
      if (!t) return
      const aoe = i > 0
      const { hits, statuses } = this.rollHits(p, t, row, aoe && area ? reductionMul(area.reductionPct) : 1, now)
      if (proj) {
        const at = arrivalAt(now, this.g.world.distance(p, t, now), proj)
        this.flights.push({ at, caster: p.id, target: t.id, code: row.code, instance, aoe, hits, statuses })
      } else this.land(p, t, row.code, hits, statuses, aoe ? { instance, aoe } : { instance }, now)
    })
  }

  // ---- heal, resurrect, cure -----------------------------------------------------------------------------

  private heal(_p: Player, row: SkillDef, t: Player, _now: number): void {
    const h = row.heal
    if (!h || t.dead) return
    const hp = Math.min(t.maxHp, t.hp + h.hp + (h.hpPct / 100) * t.maxHp)
    const mp = Math.min(t.maxMp, t.mp + h.mp + (h.mpPct / 100) * t.maxMp)
    this.g.setVitals(t, hp, mp)
  }

  /** Soul Rebirth Art (decision 14): the corpse stands up where it lies with the row's HP/MP share; no warp. */
  private resurrect(caster: Player, row: SkillDef, t: Player, _now: number): void {
    if (!t.dead) return
    const h = row.heal ?? { hp: 0, hpPct: 10, mp: 0, mpPct: 10 }
    t.dead = false
    t.hp = Math.max(1, Math.min(t.maxHp, h.hp + (h.hpPct / 100) * t.maxHp))
    t.mp = Math.min(t.maxMp, h.mp + (h.mpPct / 100) * t.maxMp)
    t.action = null
    this.g.world.broadcastAbout(t, { t: 'entityUpdate', id: t.id, state: 'alive', hp: Math.round(t.hp), maxHp: t.maxHp })
    t.send({ t: 'stats', stats: this.g.stats(t) })
    t.send({ t: 'chat', channel: 'system', text: 'You have been resurrected.' })
    // The Climb (docs/CLIMB.md §6.3): a resurrection on the corpse refunds part of the death penalty.
    // the Rebirth Art (§5.1): the whole loss back
    this.g.penalty?.resurrected(t, this.g.climbRewards?.rebirth(caster) === true)
  }

  /** Abnormal states of `e` at or below `level`, worst first. */
  private abnormal(e: Player | Mob, level: number): Effect[] {
    return this.effects
      .list(e.id)
      .filter((x) => x.kind === 'status' && x.status !== undefined && STATUS_RULES[x.status].abnormal && (x.level ?? 0) <= level)
      .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
  }

  private cureStates(e: Player | Mob, level: number, count: number, now: number): number {
    const list = this.abnormal(e, level).slice(0, Math.max(1, count))
    for (const x of list) this.removeEffect(x, 'cured', now)
    return list.length
  }

  /** Universal pills (ItemUses): whether `p` has an abnormal state a pill of `cureLevel` removes. */
  curable(p: Player, cureLevel: number): boolean {
    return this.abnormal(p, cureLevel).length > 0
  }

  cure(p: Player, cureLevel: number, now: number): void {
    for (const x of this.abnormal(p, cureLevel)) this.removeEffect(x, 'cured', now)
  }

  // ---- effects -------------------------------------------------------------------------------------------

  private applyBuff(p: Player, row: SkillDef, carrier: Player | Mob, now: number, instance: number): void {
    const group = groupOf(this.book.head(row))
    const kind: Effect['kind'] = row.toggle ? 'toggle' : row.kind === 'imbue' ? 'imbue' : row.kind === 'debuff' ? 'debuff' : 'buff'
    const e: Effect = {
      instance,
      carrier: carrier.id,
      source: p.id,
      kind,
      skill: row,
      group,
      level: row.skillLevel,
      overlap: overlapClass(row) || (kind === 'imbue' ? 1 : 0),
      mods: modsFromParams(row.params),
      startedAt: now,
      until: row.toggle ? 0 : now + (row.durationMs && row.durationMs > 0 ? row.durationMs : DEFAULT_BUFF_MS),
    }
    if (row.toggle) e.tick = { everyMs: Math.max(500, row.toggle.intervalMs), next: now + Math.max(500, row.toggle.intervalMs), mp: row.toggle.mp }
    const pw = PARAM(row, 'pw')
    if (pw) e.wall = pw[1] ?? 0
    this.addEffect(e, now)
  }

  /** Applies a rolled status of `source` to `t`. Public for monster skills (wave 8, docs/SYSTEMS_COMBAT.md §2.3). */
  applyStatus(source: Player | Mob, t: Player | Mob, roll: StatusRoll, now: number): void {
    const st = roll.status
    const rule = STATUS_RULES[st.status]
    if (t.kind === 'player' ? t.dead : t.ai === 'dead') return
    if (t.kind === 'player') {
      // Fire Shield ('bgra'): lowers the chance of incoming abnormal states.
      const resist = this.modsFor(t).statusResistPct
      if (rule.abnormal && resist > 0 && this.g.rng() * 100 < resist) return
    }
    const e: Effect = {
      instance: this.instanceId(),
      carrier: t.id,
      source: source.id,
      kind: 'status',
      skill: roll.row,
      status: st.status,
      level: st.level,
      overlap: 0,
      mods: st.status === 'shock' ? [{ stat: 'parryPct', value: -(st.extra?.[0] ?? 50) }] : [],
      startedAt: now,
      until: now + (st.durationMs && st.durationMs > 0 ? st.durationMs : rule.durationMs),
    }
    if (rule.tickMs) e.tick = { everyMs: rule.tickMs, next: now + rule.tickMs, damage: Math.max(1, st.extra?.[0] ?? 1) }
    if (rule.blocks) {
      this.g.world.halt(t, now)
      if (t.kind === 'player') this.interrupt(t, 'interrupted', now)
    }
    this.addEffect(e, now)
  }

  /**
   * A status with no skill and no caster (lightning's stun, docs/WEATHER.md §2.7): source 0, level 0, no resist roll
   * (it is not an abnormal state), blocking per STATUS_RULES; replaces the same status kind like any other.
   */
  applyHazardStatus(t: Player | Mob, status: SkillStatusKind, durationMs: number, now: number): void {
    if (t.kind === 'player' ? t.dead : t.ai === 'dead') return
    const rule = STATUS_RULES[status]
    const e: Effect = { instance: this.instanceId(), carrier: t.id, source: 0, kind: 'status', status, level: 0, overlap: 0, mods: [], startedAt: now, until: now + Math.max(1, durationMs) }
    if (rule.blocks) {
      this.g.world.halt(t, now)
      if (t.kind === 'player') this.interrupt(t, 'interrupted', now)
    }
    this.addEffect(e, now)
  }

  private addEffect(e: Effect, now: number): void {
    for (const old of this.effects.replacedBy(e)) this.removeEffect(old, 'replaced', now, false)
    this.effects.add(e)
    const carrier = this.g.world.players.get(e.carrier) ?? this.g.world.mobs.get(e.carrier)
    if (!carrier) return
    this.g.world.broadcastAbout(carrier, { t: 'effectAdd', id: carrier.id, effect: effectState(e, now) })
    if (e.mods.length > 0) this.restatAny(carrier, now)
  }

  removeEffect(e: Effect, reason: EffectRemoveReason, now: number, restat = true): void {
    if (!this.effects.remove(e.carrier, e.instance)) return
    const carrier = this.g.world.players.get(e.carrier) ?? this.g.world.mobs.get(e.carrier)
    if (!carrier) return
    this.g.world.broadcastAbout(carrier, { t: 'effectRemove', id: carrier.id, instance: e.instance, reason })
    if (restat && (e.mods.length > 0 || e.kind === 'toggle')) this.restatAny(carrier, now)
  }

  private restatAny(e: Player | Mob, now: number): void {
    if (e.kind === 'player') this.restat(e, now)
    else this.restatMob(e, now)
  }

  /** Derived stats changed (passive learned, buff on/off): recompute, send `stats`, show a new max HP. */
  restat(p: Player, _now: number): void {
    const changed = this.g.refresh(p)
    p.send({ t: 'stats', stats: this.g.stats(p) })
    if (changed) this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hp: Math.round(p.hp), maxHp: p.maxHp })
  }

  private restatMob(m: Mob, now: number): void {
    // The quest-encounter attack multiplier survives a buff or debuff (I8; MS-S found it lost here).
    const base = mobCombatStats(m.def, m.variant, m.tuning?.attackMul ?? 1)
    const mods = sumMods(this.activeMods(m.id, now))
    const { range: _r, ...combat } = applyMods({ ...base, range: 0 }, mods)
    m.combat = combat
  }

  private activeMods(id: number, now: number): StatMod[] {
    const out: StatMod[] = []
    for (const e of this.effects.list(id)) if (e.until === 0 || e.until > now) out.push(...e.mods)
    return out
  }

  /** Passive mods of the learned passives (docs/SKILLS.md §10.1): only while their required item is worn. */
  private passiveMods(p: Player): StatMod[] {
    const s = this.casters.get(p.id)
    if (!s) return []
    const out: StatMod[] = []
    for (const [group, level] of s.save.skills) {
      const row = this.book.row(group, level)
      if (row?.kind !== 'passive') continue
      if (row.requiresItem && !this.wears(p, row.requiresItem.typeId3, row.requiresItem.typeId4)) continue
      out.push(...modsFromParams(row.params))
    }
    return out
  }

  /** Every stat mod on `p` now: passives, buffs, debuffs and statuses, and (wave 8) the registered providers'. */
  // ---- the Climb's Arts (docs/CLIMB.md §5.1; climb/rewards.ts) ------------------------------------------------

  /** A row as caster `p`'s Arts change it (the row itself when none applies). */
  private artRow(p: Player, row: SkillDef): SkillDef {
    const arts = this.g.climbRewards?.arts(p)
    return arts && arts.length ? applyClimbArts(row, arts) : row
  }

  private artHitMul(a: Player, t: Player | Mob, row: SkillDef): number {
    const arts = this.g.climbRewards?.arts(a)
    return arts && arts.length ? climbArtsHitMul(arts, row, (100 * t.hp) / Math.max(1, t.maxHp)) : 1
  }

  /** Whether `p` learned any level of skill group `group`. */
  learned(p: Player, group: string): boolean {
    return (this.state(p).save.skills.get(group) ?? 0) > 0
  }

  /** Whether a buff or toggle of skill group `group` is on `p` now. */
  effectActive(p: Player, group: string): boolean {
    return this.effects.list(p.id).some((e) => e.group === group)
  }

  modsFor(p: Player): ModTotals {
    return sumMods([...this.passiveMods(p), ...this.activeMods(p.id, this.g.now), ...this.providers.flatMap((f) => f(p))])
  }

  /**
   * Wave 8 (docs/SYSTEMS_COMBAT.md §6.4): adds stat mods of another module (mounts, Berserk) to every modsFor call.
   * The module calls Gameplay.refresh(p) (then `stats`) when its mods change. Returns an unregister function.
   */
  addModProvider(fn: (p: Player) => StatMod[]): () => void {
    this.providers.push(fn)
    return () => {
      const i = this.providers.indexOf(fn)
      if (i >= 0) this.providers.splice(i, 1)
    }
  }

  /**
   * The last step of Gameplay.refresh: mods onto the derived combat stats, and the move-speed multiplier into
   * `p.speedMul` (combined with a GM speed).
   */
  applyStats<T extends CombatStats & { range: number }>(p: Player, base: T, mods: ModTotals = this.modsFor(p)): T {
    const shield = p.equip.shield ? this.g.data.item(p.equip.shield.code)?.stats?.physDefence : undefined
    const shieldPd = shield ? (shield[0] + shield[1]) / 2 : 0
    // A mount's factor replaces the buff speed while mounted (wave 8, docs/SYSTEMS_COMBAT.md §1.3).
    this.applySpeed(p, mods.mountSpeed > 0 ? mods.mountSpeed : Math.max(0.1, 1 + mods.speedPct / 100))
    return applyMods(base, mods, shieldPd)
  }

  private applySpeed(p: Player, buff: number): void {
    const prev = this.speeds.get(p.id) ?? { applied: p.speedMul, buff: 1 }
    const gm = Math.abs(p.speedMul - prev.applied) > 1e-9 ? p.speedMul : prev.applied / prev.buff
    const next = gm * buff
    this.speeds.set(p.id, { applied: next, buff })
    if (Math.abs(next - p.speedMul) > 1e-9) this.g.world.setSpeed(p, next, this.g.now)
  }

  /**
   * Incoming damage on a player (Gameplay.dealHits): Crystal Wall ('pw') absorbs physical damage until it breaks,
   * Snow Shield ('dgmp') takes its share from MP. Returns the HP damage.
   */
  absorb(t: Player, damage: number, now: number): number {
    let left = damage
    for (const e of this.effects.list(t.id)) {
      if (e.wall === undefined || e.wall <= 0 || left <= 0) continue
      const took = Math.min(e.wall, left)
      e.wall -= took
      left -= took
      // A toggled wall (Crystal Wall) is rebuilt at its next MP upkeep; any other wall breaks.
      if (e.wall <= 0 && e.kind !== 'toggle') this.removeEffect(e, 'expired', now)
    }
    const pct = this.modsFor(t).damageToMpPct
    if (pct > 0 && left > 0) {
      const fromMp = Math.min(Math.floor((left * pct) / 100), Math.floor(t.mp))
      if (fromMp > 0) {
        t.mp -= fromMp
        left -= fromMp
        t.send({ t: 'statsDelta', stats: { mp: Math.round(t.mp) } })
      }
    }
    return left
  }

  // ---- learning and the hotbar ----------------------------------------------------------------------------

  private learn(p: Player, code: string, answer: Answer, now: number): void {
    const s = this.state(p)
    const any = this.book.skill(code)
    if (!any) return answer(fail('not_found'))
    const row = this.book.head(any)
    const r = checkLearn(row, this.book, p.progress.sp, s.save.masteries, s.save.skills)
    if (!r.ok) return answer(r.message ? fail(r.reason, r.message) : fail(r.reason))
    const group = groupOf(row)
    const progress = { ...p.progress, sp: p.progress.sp - r.sp }
    this.store.learn(p.characterId, { skills: [[group, row.skillLevel]], progress })
    p.progress = progress
    s.save.skills.set(group, row.skillLevel)
    answer(true)
    p.send({ t: 'skillsUpdate', learned: [row.code] })
    p.send({ t: 'statsDelta', stats: { sp: progress.sp } })
    if (row.kind === 'passive') this.restat(p, now)
  }

  private masteryUp(p: Player, code: MasteryCode, answer: Answer): void {
    const s = this.state(p)
    const r = checkMasteryUp({ level: p.progress.level, sp: p.progress.sp }, s.save.masteries, code, this.g.data.levels)
    if (!r.ok) return answer(r.message ? fail(r.reason, r.message) : fail(r.reason))
    const level = s.save.masteries[code] + 1
    const progress = { ...p.progress, sp: p.progress.sp - r.sp }
    this.store.learn(p.characterId, { mastery: [[code, level]], progress })
    p.progress = progress
    s.save.masteries[code] = level
    answer(true)
    p.send({ t: 'skillsUpdate', masteries: { [code]: level } })
    p.send({ t: 'statsDelta', stats: { sp: progress.sp } })
  }

  private buffCancel(p: Player, code: string, answer: Answer, now: number): void {
    const any = this.book.skill(code)
    if (!any) return answer(fail('not_found'))
    const group = groupOf(this.book.head(any))
    const e = this.effects.list(p.id).find((x) => x.group === group && (x.kind === 'buff' || x.kind === 'toggle' || x.kind === 'imbue'))
    if (!e) return answer(fail('not_found'))
    answer(true)
    this.removeEffect(e, 'cancelled', now)
  }

  private hotbarSet(p: Player, slot: number, entry: HotbarEntry | null, answer: Answer): void {
    // 0..HOTBAR_SLOTS-1 = the bar, MOUSE_SLOT = the mouse quick slot (same entries, same rules).
    if (!Number.isInteger(slot) || slot < 0 || slot > MOUSE_SLOT) return answer(fail('invalid_slot'))
    const s = this.state(p)
    let saved: HotbarEntry | null = null
    if (entry?.kind === 'skill') {
      const any = this.book.skill(entry.code)
      if (!any || any.basicAttack || any.mastery === null) return answer(fail('not_found'))
      const head = this.book.head(any)
      if ((s.save.skills.get(groupOf(head)) ?? 0) < 1) return answer(fail('not_learned'))
      saved = { kind: 'skill', code: head.code }
    } else if (entry?.kind === 'item') {
      // Decision 7: only consumables (ItemDef.use); the slot holds the code, pressing it uses the lowest bag slot.
      const def = this.g.data.item(entry.code)
      if (!def) return answer(fail('not_found'))
      if (!def.use) return answer(fail('not_usable'))
      saved = { kind: 'item', code: def.code }
    }
    this.store.setHotbar(p.characterId, slot, saved)
    if (slot === MOUSE_SLOT) s.save.mouse = saved
    else s.save.hotbar[slot] = saved
    answer(true)
    p.send({ t: 'skillsUpdate', hotbar: [{ slot, entry: saved }] })
  }

  /** The `skills` snapshot (enter-world, GM reset). */
  snapshot(p: Player, now: number): ServerMessage {
    const s = this.state(p)
    const skills: string[] = []
    for (const [group, level] of s.save.skills) {
      const row = this.book.row(group, level)
      if (row) skills.push(row.code)
    }
    const cooldowns: { group: string; readyInMs: number }[] = []
    for (const [group, at] of this.cooldownsOf(p.characterId)) if (at > now) cooldowns.push({ group, readyInMs: Math.min(600_000, Math.round(at - now)) })
    const msg: ServerMessage = { t: 'skills', masteries: { ...s.save.masteries }, skills: skills.slice(0, 512), hotbar: [...s.save.hotbar] }
    if (cooldowns.length) msg.cooldowns = cooldowns
    if (s.save.mouse) msg.mouse = { ...s.save.mouse }
    return msg
  }

  // ---- GM (skills/gm-skill.ts) ---------------------------------------------------------------------------

  /** Sets masteries and learned levels directly (no SP, no caps), persists, and tells the client. */
  gmSet(p: Player, masteries: Partial<Record<MasteryCode, number>>, skills: [string, number][], now: number): string[] {
    const s = this.state(p)
    const m: [MasteryCode, number][] = Object.entries(masteries).map(([c, l]) => [c as MasteryCode, Math.max(0, Math.min(300, Math.round(l!)))])
    this.store.learn(p.characterId, { mastery: m, skills })
    for (const [c, l] of m) s.save.masteries[c] = l
    const learned: string[] = []
    for (const [g, l] of skills) {
      s.save.skills.set(g, l)
      const row = this.book.row(g, l)
      if (row) learned.push(row.code)
    }
    const up: ServerMessage = { t: 'skillsUpdate' }
    if (m.length) up.masteries = Object.fromEntries(m)
    if (learned.length) up.learned = learned.slice(0, 512)
    p.send(up)
    this.restat(p, now)
    return learned
  }

  gmReset(p: Player, now: number): void {
    const s = this.state(p)
    this.interrupt(p, 'cancelled', now)
    for (const e of this.effects.list(p.id)) if (e.kind !== 'status') this.removeEffect(e, 'cancelled', now, false)
    this.store.reset(p.characterId)
    s.save.masteries = emptyMasteries()
    s.save.skills.clear()
    this.cooldowns.delete(p.characterId)
    p.send(this.snapshot(p, now))
    this.restat(p, now)
  }

  gmAddSp(p: Player, n: number): number {
    const progress = { ...p.progress, sp: Math.min(2_000_000_000, p.progress.sp + n) }
    this.g.store.saveProgress(p.characterId, progress)
    p.progress = progress
    p.send({ t: 'statsDelta', stats: { sp: progress.sp } })
    return progress.sp
  }

  gmClearCooldowns(p: Player): void {
    this.cooldowns.delete(p.characterId)
  }

  masteriesOf(p: Player): Record<MasteryCode, number> {
    return { ...this.state(p).save.masteries }
  }

  // ---- hooks ---------------------------------------------------------------------------------------------

  enter(p: Player, now: number): void {
    this.casters.delete(p.id)
    this.state(p)
    // world.add clamped the HP/MP to the maxima without passives: restore them (relog in this process) once they count.
    const last = this.lastVitals.get(p.characterId)
    this.lastVitals.delete(p.characterId)
    const before = { maxHp: p.maxHp, maxMp: p.maxMp }
    this.g.refresh(p)
    if (last && !p.dead) {
      p.hp = Math.min(p.maxHp, Math.max(p.hp, last.hp))
      p.mp = Math.min(p.maxMp, Math.max(p.mp, last.mp))
    }
    p.send(this.snapshot(p, now))
    if (p.maxHp !== before.maxHp || p.maxMp !== before.maxMp || this.passiveMods(p).length > 0) {
      p.send({ t: 'stats', stats: this.g.stats(p) })
      this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hp: Math.round(p.hp), maxHp: p.maxHp })
    }
  }

  moved(p: Player, now: number): void {
    this.interrupt(p, 'interrupted', now, false)
  }

  stopped(p: Player, now: number): void {
    this.interrupt(p, 'cancelled', now, false)
  }

  warped(p: Player, _reason: WarpReason, now: number): void {
    this.interrupt(p, 'interrupted', now)
    if (p.action?.kind === 'skill') p.action = null
  }

  /** Death clears everything but the passives (docs/SKILLS.md §10.1). */
  playerDied(p: Player, now: number): void {
    this.interrupt(p, 'interrupted', now)
    const list = this.effects.list(p.id)
    for (const e of list) this.removeEffect(e, 'death', now, false)
    if (list.length) this.restat(p, now)
  }

  inventoryChanged(p: Player): void {
    // The weapon or shield a running cast needs was swapped out: the cast ends before its release (no other weapon's
    // stats on a skill). A released action has already landed; its next chain segment is checked in finish().
    const c = this.casters.get(p.id)?.cast
    if (c && !c.released && this.gear(p, c.row)) this.interrupt(p, 'interrupted', this.g.now)
    // A required item taken off (shield) ends the buffs that needed it.
    for (const e of this.effects.list(p.id)) {
      const req = e.skill?.requiresItem
      if (e.kind !== 'status' && req && !this.wears(p, req.typeId3, req.typeId4)) this.removeEffect(e, 'cancelled', this.g.now)
    }
  }

  forget(p: Player): void {
    if (!p.dead) this.lastVitals.set(p.characterId, { hp: p.hp, mp: p.mp })
    this.casters.delete(p.id)
    this.speeds.delete(p.id)
    this.effects.drop(p.id)
    this.flights = this.flights.filter((f) => f.caster !== p.id && f.target !== p.id)
  }

  tickPlayer(p: Player, now: number): void {
    const s = this.casters.get(p.id)
    if (!s) return
    if (p.action?.kind === 'skill' && !s.cast) this.chase(p, p.action, now)
    this.advance(p, s, now)
  }

  /** Walking into range of a skill's target (the auto-attack chase); starts it on arrival. */
  private chase(p: Player, a: Extract<Player['action'], { kind: 'skill' }>, now: number): void {
    const t = this.g.world.players.get(a.target) ?? this.g.world.mobs.get(a.target)
    const row = this.book.skill(a.skill)
    if (!t || !row || !p.known.has(t.id) || (t.kind === 'mob' && t.ai === 'dead')) {
      p.action = null
      return
    }
    if (!this.g.approach(p, t, this.reach(p, row, t), a, now)) return
    p.action = null
    const r = this.plan(p, a.skill, a.target, now)
    if (r.ok) this.start(p, r.value, now)
    else p.send({ t: 'chat', channel: 'system', text: `Could not use the skill: ${r.reason.replace(/_/g, ' ')}.` })
  }

  tick(now: number): void {
    if (this.flights.length) {
      const due = this.flights.filter((f) => f.at <= now)
      if (due.length) {
        this.flights = this.flights.filter((f) => f.at > now)
        for (const f of due) this.arrive(f, now)
      }
    }
    for (const id of this.effects.carriers()) {
      const carrier = this.g.world.players.get(id) ?? this.g.world.mobs.get(id)
      if (!carrier || (carrier.kind === 'mob' && carrier.ai === 'dead')) {
        this.effects.drop(id)
        continue
      }
      for (const e of this.effects.list(id)) this.tickEffect(carrier, e, now)
    }
  }

  private arrive(f: Flight, now: number): void {
    const a = this.g.world.players.get(f.caster)
    const t = this.g.world.mobs.get(f.target) ?? this.g.world.players.get(f.target)
    if (!a || !t || (t.kind === 'mob' ? t.ai === 'dead' : t.dead || !this.g.hunters.allowed(a, t, now))) return
    this.land(a, t, f.code, f.hits, f.statuses, { instance: f.instance, at: f.at, aoe: f.aoe || undefined }, now)
  }

  private tickEffect(carrier: Player | Mob, e: Effect, now: number): void {
    const tk = e.tick
    if (tk && now >= tk.next && (e.until === 0 || tk.next <= e.until)) {
      tk.next += tk.everyMs
      if (tk.damage) {
        // Burn / poison: a damage tick from the caster (EXP credit stays theirs), through dealHits.
        const src = this.g.world.players.get(e.source) ?? this.g.world.mobs.get(e.source) ?? carrier
        // `dot`: no horse redirect and no durability wear for a tick (wave 8, docs/SYSTEMS_COMBAT.md §1.3).
        this.g.dealHits(src, carrier, [{ outcome: 'hit', damage: tk.damage, hp: 0 }], e.skill ? { skill: e.skill.code, dot: true } : { dot: true }, now)
        if (!this.effects.get(carrier.id, e.instance)) return
      }
      if (tk.mp && carrier.kind === 'player') {
        if (carrier.mp < tk.mp) return this.removeEffect(e, 'expired', now)
        this.g.setVitals(carrier, carrier.hp, carrier.mp - tk.mp)
        const pw = PARAM(e.skill, 'pw')
        if (pw) e.wall = pw[1] ?? 0
      }
    }
    if (e.until !== 0 && now >= e.until) this.removeEffect(e, 'expired', now)
  }
}

