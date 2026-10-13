import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_NAME, CONTENT_FILES, MAX_COMBAT_HITS, checkCosDef, contentEntries, isTransportCos, type CombatHit, type CosDef, type GameplayRequest, type ItemDef, type ServerMessage, type SkillDef } from '@sro/shared'
import { knob } from './config.ts'
import type { Store } from './db.ts'
import { CORPSE_MS, PLAYER_BASE, POTION_COOLDOWN_MS } from './formulas.ts'
import type { Gameplay, HitExtra } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import { fail, takeFromBag, type Fail, type InvDraft, type InvItem, type Result } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from './modules.ts'
import { moveMul } from './walk.ts'
import { wirePos, wireYaw, type Cos, type Mob, type Npc, type Player } from './world.ts'

/**
 * Horses (docs/SYSTEMS_COMBAT.md §1.3; docs/WAVE_PLAN2.md D43, D49, D52; lane MR-S).
 *
 * - **Summon**: `itemUse` of an item with `use.summon` (ItemUses dispatches it here, D52). Checks in order: alive,
 *   the item's level (`requirements`), no horse yet (`cos_active`), no combat for COS_COMBAT_LOCK_MS (`in_combat`),
 *   no skill action or return-scroll cast (`busy`), not berserk (`berserk_active`, D49). The item STAYS in the bag (it
 *   is the horse: releasing the horse or its death deletes one); the horse appears under the player (with the HP it had
 *   when it was sent home, else full) and the player is mounted at once:
 *   actionResult -> (itemCooldown) -> spawn {cos} -> entityUpdate {p.mount} + entityUpdate {cos.rider}.
 *   While a bound horse is out its item must stay in the bag: when it leaves (sold, traded, stored, dropped) the horse
 *   goes home (checked on inventoryChanged and every ITEM_CHECK_MS).
 * - **Mounted**: speed x runSpeed / PLAYER_RETAIL_RUN (1.8 for the Red Horse) through the SkillEngine mod provider
 *   (`mountSpeed`, which replaces buff speed), radius max(player, horse). Attacks and skills are refused `mounted`
 *   (the `refuse` seam), except: with a bow, basic attacks and the bow rows; with any weapon, the element imbues
 *   (mountedSkillOk, `refuseCombat`); the `gate` refuses sit, emote, stallCreate, alchemyReinforce and berserk with `mounted` (D43).
 *   Hits on the rider land on the horse (the `redirect` seam), except DoT ticks; statuses stay on the rider.
 * - A ridden horse shares its rider's MoveState and is never sent `move`s: `tick` copies the rider's move/pos, and a
 *   warp of the rider carries the horse along. A dismounted horse FOLLOWS its owner like a pet (followStep, every
 *   FOLLOW_STEP_MS): it walks to FOLLOW_GAP_M behind the owner, runs when farther, and is put beside the owner when
 *   farther than COS_PARK_RANGE_M (the knob), stuck for FOLLOW_STUCK_MS, or when the owner warps.
 * - `mountDismount` (not while moving) sets the rider 1.2 m to the horse's left; `mountRide` walks to the own horse
 *   (the 'board' action) and mounts within COS_BOARD_RANGE; `mountDismiss` sends the horse home (despawn, the item and
 *   the horse's HP are kept); `mountRelease` releases it for good: despawn + one summoning item deleted, one transaction.
 * - The horse dies at 0 HP: the rider lands on its feet, the corpse leaves after CORPSE_MS, the saved row and (bound)
 *   one summoning item are deleted: a dead horse is gone like a released one.
 *   Horses do not regenerate; Recovery Kits (`use.target === 'mount'`) heal the own horse (ridden, or parked within
 *   KIT_RANGE_M): actionResult -> inventoryUpdate -> itemCooldown -> entityUpdate {cos.hp} -> itemEffect {id: cos}.
 * - Persistence: `char_mount` (migrations 8 and 29), written on summon, ride, dismount, heal, damage (at most every
 *   SAVE_EVERY_MS), send-home and logout. A logout despawns the horse and keeps it out: enter-world re-creates it
 *   (ridden or following) with its HP. A sent-home row (`out` 0) only keeps the HP for the next summon.
 * - GM `/horse [cos code]` summons without an item (level, lockout and berserk ignored), `/horse off` dismisses.
 */

export const HORSE_USAGE = 'horse [cos code] | horse off'
/** GM `/horse` without a code: the Red Horse (the only horse within the level cap). */
const DEFAULT_HORSE = 'COS_C_HORSE1'

/** Retail player run speed (CHAR_CH_* col 47 = 50 units/s) in m/s: a horse's speed factor is runSpeed / this. */
export const PLAYER_RETAIL_RUN = 5
/** Rule (§1.3): a player boards its parked horse from this far (metres); farther, the server walks it there first. */
export const COS_BOARD_RANGE = 2
/** Rule (§1.3): a Recovery Kit reaches a parked horse this far away (metres). */
export const KIT_RANGE_M = 30
/** Rule (§1.3): the rider steps down this far to the horse's left (metres). */
export const DISMOUNT_SIDE_M = 1.2
/** Rule (§1.3): horse HP is saved at most this often while it takes damage (and on logout). */
export const SAVE_EVERY_MS = 5000
/** A dismounted horse takes a follow step this often (ms). */
export const FOLLOW_STEP_MS = 250
/** It stands this far behind its owner (metres). */
export const FOLLOW_GAP_M = 2.5
/** Closer than this it walks (WALK clip speed); farther it runs (metres). */
export const FOLLOW_WALK_M = 5
/** Walking speed of a following horse (m/s; under the clients' 3.2 m/s run threshold, so it plays its walk). */
export const FOLLOW_WALK_SPEED = 2.5
/** No closer for this long while it should move: it is put beside its owner (ms). */
export const FOLLOW_STUCK_MS = 3000
/** A bound horse's item is looked for in the bag at least this often (ms; trade, stall and storage moves). */
export const ITEM_CHECK_MS = 2000
/** The protocol's bound on cooldown times (validate.ts MAX_ACTION_MS). */
const MAX_WIRE_MS = 600_000

/**
 * Requests the mounts gate refuses while riding (D43; `jump`: docs/MOVEMENT.md §4.3, wave 10). attack/useSkill have
 * their own seam checks (`refuse`).
 */
export const MOUNTED_REFUSED: readonly GameplayRequest[] = ['sit', 'emote', 'stallCreate', 'alchemyReinforce', 'berserk', 'jump']

interface MountRow {
  code: string
  hp: number
  mounted: number
  /** 1 = in the world with its owner; 0 = sent home (the row keeps its HP). */
  out: number
  /** 1 = tied to a summoning item in the bag. */
  bound: number
}

/**
 * Mounted combat (owner, 2026-10-13): whether skill row `row` may be used on horseback.
 * - Bow rows (single shots, the arrow combos, the line and area arrows, Mind Bow, Soul Arrow buffs) with a bow in hand,
 *   except the hawk summons (`_BOW_CALL_`: a planted, arm-raised call for the bird to land). See mountedNeedsBow.
 * - The element imbues (Cold, Fire, Lightning, Force = SKILL_CH_WATER; kind 'imbue') with any weapon or none.
 * - Everything else is refused `mounted`: melee weapon rows, and the other element rows (nukes, buffs, heals, debuffs:
 *   they have their own on-foot animations, so the player steps down first).
 */
export const MOUNTED_EXCLUDED = /_BOW_CALL_/
export const MOUNTED_ELEMENT = /^SKILL_CH_(COLD|FIRE|LIGHTNING|WATER)_/
export function mountedSkillOk(row: Pick<SkillDef, 'code' | 'group' | 'weapons' | 'kind'>): boolean {
  const group = row.group ?? row.code
  if (row.weapons.includes('bow')) {
    if (MOUNTED_EXCLUDED.test(group)) return false
    return row.kind === 'attack' || row.kind === 'buff' || row.kind === 'imbue'
  }
  return row.weapons.length === 0 && row.kind === 'imbue' && MOUNTED_ELEMENT.test(group)
}

/** Whether a row mountedSkillOk allows also needs the bow in hand (bow rows do; the element imbues do not). */
export function mountedNeedsBow(row: Pick<SkillDef, 'weapons'>): boolean {
  return row.weapons.length > 0
}

/** Runtime state of a live horse beyond the Cos entity (keyed by the horse's entity id). */
interface HorseState {
  def: CosDef
  /** Unsaved HP change (damage is saved at most every SAVE_EVERY_MS). */
  dirty: boolean
  savedAt: number
  /** Summoned from an item that stays in the bag (MountRow.bound). */
  bound: boolean
  /** Next item presence check (server ms). */
  checkAt: number
  /** Next follow step, and the closest it got to its owner since `closerAt` (stuck detection). */
  stepAt: number
  best: number
  closerAt: number
}

/** char_mount statements (migration 8). */
function openMountStore(store: Store) {
  const db = store.db
  const q = {
    get: db.prepare<[number], MountRow>('SELECT code, hp, mounted, out, bound FROM char_mount WHERE character_id = ?'),
    put: db.prepare<[number, string, number, number, number, number]>(
      'INSERT INTO char_mount (character_id, code, hp, mounted, out, bound) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET code = excluded.code, hp = excluded.hp, mounted = excluded.mounted, out = excluded.out, bound = excluded.bound',
    ),
    del: db.prepare<[number]>('DELETE FROM char_mount WHERE character_id = ?'),
  }
  return {
    load: (characterId: number): MountRow | undefined => q.get.get(characterId),
    save: (characterId: number, code: string, hp: number, mounted: boolean, out = true, bound = false): void =>
      void q.put.run(characterId, code, Math.max(1, Math.round(hp)), mounted ? 1 : 0, out ? 1 : 0, bound ? 1 : 0),
    remove: (characterId: number): void => void q.del.run(characterId),
  }
}

/** Reads cos.json from OUT_DIR/data (the SkillBook.load pattern): valid records by code. Never throws. */
export function loadCosDefs(outDir: string, log: (m: string) => void = () => {}): Map<string, CosDef> {
  const out = new Map<string, CosDef>()
  let text: string
  try {
    text = readFileSync(join(outDir, 'data', CONTENT_FILES.cos), 'utf8')
  } catch {
    log(`content ${CONTENT_FILES.cos}: missing (no horses)`)
    return out
  }
  let raw: unknown[]
  try {
    raw = contentEntries<unknown>(JSON.parse(text), 'cos')
  } catch (e) {
    log(`content ${CONTENT_FILES.cos}: unreadable (${(e as Error).message})`)
    return out
  }
  let skipped = 0
  raw.forEach((v, i) => {
    if (checkCosDef(v, `cos[${i}]`).length === 0) out.set((v as CosDef).code, v as CosDef)
    else skipped++
  })
  log(`content ${CONTENT_FILES.cos}: ${out.size} loaded${skipped ? `, ${skipped} skipped` : ''}`)
  return out
}

export class Mounts implements GameplayModule {
  readonly name = 'mounts'
  readonly handles: readonly GameplayRequest[] = ['mountRide', 'mountDismount', 'mountDismiss', 'mountRelease']
  readonly whileDead: readonly GameplayRequest[] = ['mountDismiss']
  /** cos.json by code (tests may add records). */
  readonly defs: Map<string, CosDef>
  /** characterId -> that character's live horse (ridden, parked or a corpse). One horse per character. */
  private readonly horses = new Map<number, Cos>()
  private readonly state = new Map<number, HorseState>()
  private db: ReturnType<typeof openMountStore> | null = null

  constructor(readonly g: Gameplay) {
    this.defs = loadCosDefs(g.config.outDir, (m) => g.config.log(m))
    // Speed while riding (docs/SYSTEMS_COMBAT.md §1.3): replaces buff speed in SkillEngine.applyStats.
    g.skills.addModProvider((p) => {
      const c = this.ridden(p)
      const def = c && this.state.get(c.id)?.def
      return def && def.runSpeed > 0 ? [{ stat: 'mountSpeed', value: def.runSpeed / PLAYER_RETAIL_RUN }] : []
    })
    // EntityState.mount of a rider for anyone who sees it later (spawn, worldEnter snapshots).
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player') return
      const c = this.ridden(e)
      if (c) s.mount = c.id
    })
  }

  private get store(): ReturnType<typeof openMountStore> {
    return (this.db ??= openMountStore(this.g.store))
  }

  // ---- queries -------------------------------------------------------------------------------------------

  /** The live horse `p` owns (ridden or parked; not a corpse), or null. */
  horseOf(p: Player): Cos | null {
    const c = this.horses.get(p.characterId)
    return c && c.diedAt === 0 ? c : null
  }

  /** The horse `p` rides now, or null. */
  ridden(p: Player): Cos | null {
    const c = this.horses.get(p.characterId)
    return c && c.diedAt === 0 && c.rider === p.id ? c : null
  }

  // ---- seams ---------------------------------------------------------------------------------------------

  /** The entity a hit on `t` lands on: a mounted player's horse (unless `extra.dot`), else `t` itself. */
  redirect(t: Player | Mob | Cos, extra: HitExtra, _now: number): Player | Mob | Cos {
    if (t.kind !== 'player' || extra.dot) return t
    // docs/JOBS.md §5.4: a Trader riding his trade transport is hit through it, like a horse
    return this.ridden(t) ?? this.g.transports?.ridden(t) ?? t
  }

  /** Applies rolled hits of `a` on horse `c` (HP, the `combat` message, its death). Gameplay.dealHits' result shape. */
  hitCos(a: Player | Mob, c: Cos, rolled: CombatHit[], extra: HitExtra, now: number): { dealt: number; killed: boolean; hits: CombatHit[] } {
    if (c.diedAt !== 0 || c.hp <= 0) return { dealt: 0, killed: false, hits: [] }
    const hits: CombatHit[] = []
    let dealt = 0
    for (const h of rolled.slice(0, MAX_COMBAT_HITS)) {
      const damage = Math.min(Math.max(0, h.damage), Math.ceil(c.hp))
      c.hp = Math.max(0, c.hp - damage)
      dealt += damage
      hits.push({ ...h, damage, hp: Math.round(c.hp) })
      if (c.hp <= 0) break
    }
    if (hits.length === 0) return { dealt: 0, killed: false, hits }
    const killed = c.hp <= 0
    a.lastCombatAt = now
    const rider = c.rider === null ? undefined : this.g.world.players.get(c.rider)
    // The rider is in the fight: the 20 s boarding lockout and the regen pause count from here.
    if (rider) rider.lastCombatAt = now
    const msg: ServerMessage = { t: 'combat', attacker: a.id, target: c.id, hits }
    if (extra.skill !== undefined) msg.skill = extra.skill
    if (extra.instance !== undefined) msg.instance = extra.instance
    if (extra.at !== undefined) msg.at = extra.at
    if (extra.aoe) msg.aoe = true
    if (killed) msg.killed = true
    this.g.world.broadcastAboutEither(a, c, msg)
    const st = this.state.get(c.id)
    if (st) st.dirty = true
    if (killed) this.died(c, now)
    return { dealt, killed, hits }
  }

  /** Why `p` may not attack or use a skill now (`mounted`), or null. */
  refuse(p: Player, what: 'attack' | 'skill'): Fail | null {
    if (!this.ridden(p) && !this.g.transports?.ridden(p)) return null
    return fail('mounted', what === 'skill' ? 'Cannot use the skill while on the vehicle.' : 'Cannot attack while riding.')
  }

  /**
   * attack / useSkill of `p` (gameplay.ts, the SkillEngine's plan): `refuse`, except on a horse (never a trade
   * transport): basic attacks go through with a bow equipped; skills go through when mountedSkillOk allows the row
   * (bow rows with the bow in hand, element imbues with any weapon). Melee attacks and every other row stay refused
   * `mounted` (the client steps down first). A skill asked without its row waits for the row (null now; the
   * SkillEngine asks again with it).
   */
  refuseCombat(p: Player, what: 'attack' | 'skill', row?: SkillDef): Fail | null {
    const no = this.refuse(p, what)
    if (!no || !this.ridden(p)) return no
    const bow = p.combat.weapon === 'bow'
    if (what === 'attack') return bow ? null : no
    if (!row) return null
    if (mountedSkillOk(row) && (bow || !mountedNeedsBow(row))) return null
    return fail('mounted', 'That skill cannot be used on horseback.')
  }

  /** D43: while mounted, sit, emote, stallCreate, alchemyReinforce and berserk are refused `mounted`. */
  gate(p: Player, t: GameplayRequest | 'moveTo', _now: number): Fail | null {
    if (t === 'moveTo' || !MOUNTED_REFUSED.includes(t)) return null
    return this.ridden(p) || this.g.transports?.ridden(p) ? fail('mounted') : null
  }

  /** itemUse of a horse item (`use.summon`) or a Recovery Kit (`use.target === 'mount'`), after the cooldown check. */
  useItem(p: Player, def: ItemDef, bag: number, answer: Answer, now: number): void {
    if (p.dead) return answer(fail('dead'))
    if (def.use?.summon) return this.summonItem(p, def, bag, answer, now)
    return this.kit(p, def, bag, answer, now)
  }

  // ---- requests ------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t === 'mountRide') return this.ride(p, msg.cos, answer, now)
    if (msg.t === 'mountDismount') return this.dismount(p, answer, now)
    if (msg.t === 'mountDismiss') return this.dismissRequest(p, answer, now)
    if (msg.t === 'mountRelease') return this.release(p, answer, now)
    answer(fail('not_found'))
  }

  private summonItem(p: Player, def: ItemDef, bag: number, answer: Answer, now: number): void {
    const cos = this.defs.get(def.use!.summon!)
    if (!cos) return answer(fail('not_usable', 'That horse is not available.'))
    // docs/JOBS.md §5.4: the trade transports are the job system's (layer 3), never a riding horse
    if (isTransportCos(cos.code)) return answer(fail('not_usable', 'Trade transports are summoned by Traders at a trade post.'))
    if (p.progress.level < def.reqLevel) return answer(fail('requirements'))
    if (this.horseOf(p) || this.g.transports?.of(p.characterId)) return answer(fail('cos_active', 'Cannot summon more than one transport.'))
    const why = this.boardProblem(p, now)
    if (why) return answer(why)
    // The item stays in the bag (it is the horse); a horse sent home earlier comes back with the HP it had.
    const row = this.store.load(p.characterId)
    const hp = row && row.out === 0 && row.code === cos.code ? Math.min(cos.hp, Math.max(1, row.hp)) : cos.hp
    const ms = Math.min(MAX_WIRE_MS, Math.max(0, Math.round(def.use!.cooldownMs ?? 0)))
    const group = def.use!.cooldownGroup ?? def.code
    if (ms > 0) p.cooldowns.set(group, now + ms)
    answer(true)
    if (ms > 0) p.send({ t: 'itemCooldown', group, readyInMs: ms, totalMs: ms })
    this.summon(p, cos, hp, true, now, true)
    this.g.config.log(`mounts: ${p.name} (#${p.characterId}) summoned ${cos.code} from ${def.code} (bag ${bag})`)
  }

  /** Recovery Kit: heals the own horse, ridden or parked within KIT_RANGE_M. */
  private kit(p: Player, def: ItemDef, bag: number, answer: Answer, now: number): void {
    const c = this.horseOf(p)
    if (!c) return answer(fail('not_usable', 'You have no horse.'))
    if (c.rider !== p.id && this.g.world.distance(p, c, now) > KIT_RANGE_M) return answer(fail('too_far'))
    const use = def.use!
    if (!this.take(p, bag, use.cooldownGroup ?? def.code, use.cooldownMs ?? POTION_COOLDOWN_MS, answer, now)) return
    const hp = Math.min(c.maxHp, c.hp + (use.hp ?? 0) + ((use.hpPct ?? 0) * c.maxHp) / 100)
    if (Math.round(hp) !== Math.round(c.hp)) {
      c.hp = hp
      this.g.world.broadcastAbout(c, { t: 'entityUpdate', id: c.id, hp: Math.round(c.hp) })
    } else c.hp = hp
    this.save(c, now)
    this.g.world.broadcastAbout(c, { t: 'itemEffect', id: c.id, item: def.code })
  }

  /** mountRide: board the own parked horse, walking there first when it is farther than COS_BOARD_RANGE. */
  private ride(p: Player, id: number, answer: Answer, now: number): void {
    const c = this.horseOf(p)
    if (!c || c.id !== id || !p.known.has(id)) return answer(fail('not_found'))
    if (c.rider !== null) return answer(fail('mounted'))
    const why = this.boardProblem(p, now)
    if (why) return answer(why)
    if (this.g.world.distance(p, c, now) <= COS_BOARD_RANGE) {
      answer(true)
      return this.board(p, c, now)
    }
    p.action = { kind: 'board', cos: c.id, chaseAt: 0, chaseTo: null }
    answer(true)
  }

  /**
   * Why `p` may not summon or board now: `in_combat` (the 20 s lockout), `busy` (a skill, an item cast or a pending
   * alchemy fuse: D43 allows no alchemy while mounted, so a fuse also blocks mounting), `berserk_active` (D49), or null.
   */
  private boardProblem(p: Player, now: number): Fail | null {
    if (now - p.lastCombatAt < knob(this.g.config, 'cosCombatLockMs')) return fail('in_combat', 'Cannot board a transport for 20 seconds after the end of combat.')
    if (this.g.itemUses.skillBusy(p, now) || this.g.itemUses.casting(p) || this.g.skills.held(p, now)) return fail('busy')
    if (this.g.alchemy.fusing(p)) return fail('busy')
    if (this.berserking(p)) return fail('berserk_active')
    return null
  }

  /** D49: whether `p` is berserk (Berserk.active, lane BZ; asked duck-typed so this file never depends on its build order). */
  private berserking(p: Player): boolean {
    const b = this.g.berserk as unknown as { active?(p: Player): boolean }
    return typeof b.active === 'function' && b.active(p) === true
  }

  private dismount(p: Player, answer: Answer, now: number): void {
    const c = this.ridden(p)
    if (!c) return answer(fail('not_mounted'))
    if (p.move && this.g.world.arrivalTime(p.move) > now) return answer(fail('moving', 'Cannot step down while the transport is moving.'))
    answer(true)
    this.stepDown(p, c, now, true)
    this.save(c, now)
  }

  /** mountDismiss ("Send home"): the horse despawns; its item stays in the bag and its HP is kept for the next summon. */
  private dismissRequest(p: Player, answer: Answer, _now: number): void {
    const c = this.horseOf(p)
    if (!c) return answer(fail('not_found', 'You have no horse.'))
    answer(true)
    this.sendHome(p, c)
  }

  /**
   * mountRelease ("Release for good"): one transaction deletes one summoning item of a bound horse and the saved row;
   * then the horse despawns. Only the own live horse (horseOf); a second release finds none (`not_found`), so one
   * horse never costs less or more than one item.
   */
  private release(p: Player, answer: Answer, _now: number): void {
    const c = this.horseOf(p)
    if (!c) return answer(fail('not_found', 'You have no horse.'))
    const bound = this.state.get(c.id)?.bound ?? false
    const { result, draft } = this.g.store.inventoryTx(
      p.characterId,
      (d): Result<InvItem | null> => (bound ? this.takeHorseItem(d, c.code) : { ok: true, value: null }),
      () => this.store.remove(p.characterId),
    )
    if (!result.ok) return answer(result)
    answer(true)
    this.unseat(p, c)
    this.removeHorse(c)
    const item = result.value?.code ?? 'no item'
    this.g.config.log(`mounts: ${p.name} (#${p.characterId}) released ${c.code} for good (${item} deleted)`)
    if (draft.changed) this.g.afterInventory(p, draft)
    p.send({ t: 'chat', channel: 'system', text: `${c.name} has been released for good.` })
  }

  /** Takes one summoning item of horse `code` from the bag (lowest slot), or not_found. */
  private takeHorseItem(d: InvDraft, code: string): Result<InvItem> {
    for (let i = 0; i < d.bagSize; i++) {
      const it = d.bag[i]
      if (it && this.g.data.item(it.code)?.use?.summon === code) return takeFromBag(d, i, 1)
    }
    return fail('not_found', "Your horse's item is not in your bag.")
  }

  /** Whether `p`'s bag holds a summoning item of horse `code` (a bag read). */
  private hasHorseItem(p: Player, code: string): boolean {
    return this.g.store.loadInventory(p.characterId).bag.some((it) => !!it && this.g.data.item(it.code)?.use?.summon === code)
  }

  /** A bound horse whose item left the bag goes home (sold, traded, stored, dropped). False when it went. */
  private checkItem(p: Player, c: Cos, now: number): boolean {
    const st = this.state.get(c.id)
    if (!st?.bound) return true
    st.checkAt = now + ITEM_CHECK_MS
    if (this.hasHorseItem(p, c.code)) return true
    this.sendHome(p, c)
    p.send({ t: 'chat', channel: 'system', text: `${c.name} went home: its item left your bag.` })
    return false
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------

  /** Enter-world (D35): re-creates the horse that was out at logout, ridden when it was (and the player is alive). */
  enter(p: Player, now: number): void {
    const row = this.store.load(p.characterId)
    if (!row || row.out === 0) return
    const def = this.defs.get(row.code)
    if (!def) {
      // cos.json lacks the code (a partial export): keep the row for when it returns.
      this.g.config.log(`mounts: ${p.name} has a saved horse ${row.code} that cos.json does not list`)
      return
    }
    const old = this.horses.get(p.characterId)
    if (old) this.removeHorse(old)
    const hp = Math.min(def.hp, Math.max(1, row.hp))
    if (row.bound === 1 && !this.hasHorseItem(p, def.code)) {
      this.store.save(p.characterId, def.code, hp, false, false, true)
      return
    }
    this.summon(p, def, hp, row.mounted === 1 && !p.dead, now, row.bound === 1)
  }

  /** A walk to the own horse (the 'board' PlayerAction) mounts on arrival. */
  tickPlayer(p: Player, now: number): void {
    const a = p.action
    if (a?.kind !== 'board') return
    const c = this.horseOf(p)
    if (!c || c.id !== a.cos || c.rider !== null) {
      p.action = null
      return
    }
    // Gameplay.approach reads only the position of its target (a following horse: where it is now).
    const spot: Npc = { kind: 'npc', id: c.id, code: c.code, name: c.name, pos: this.g.world.positionAt(c, now), yaw: c.yaw }
    if (!this.g.approach(p, spot, COS_BOARD_RANGE, a, now)) return
    p.action = null
    const why = this.boardProblem(p, now)
    if (why) {
      this.g.world.halt(p, now)
      if (why.message) p.send({ t: 'chat', channel: 'system', text: why.message })
      return
    }
    this.board(p, c, now)
  }

  /** Ridden horses carry their riders; the others follow them like pets; corpses despawn; damage is saved. */
  tick(now: number): void {
    for (const c of [...this.horses.values()]) {
      if (c.diedAt !== 0) {
        if (now - c.diedAt >= CORPSE_MS) this.removeHorse(c)
        continue
      }
      const owner = this.g.world.players.get(c.owner)
      if (!owner || owner.characterId !== c.ownerChar) {
        // The owner left without `forget` (should not happen): the entity goes, the saved row stays.
        this.removeHorse(c)
        continue
      }
      const st = this.state.get(c.id)
      if (st?.bound && now >= st.checkAt && !this.checkItem(owner, c, now)) continue
      if (c.rider !== null) this.follow(c, owner)
      else if (st && now >= st.stepAt) {
        st.stepAt = now + FOLLOW_STEP_MS
        this.followStep(c, owner, st, now)
      }
      if (st?.dirty && now - st.savedAt >= SAVE_EVERY_MS) this.save(c, now)
    }
  }

  /** End of Gameplay.afterInventory: a bound horse whose item just left the bag goes home. */
  inventoryChanged(p: Player): void {
    const c = this.horseOf(p)
    if (c) this.checkItem(p, c, this.g.now)
  }

  /** A ridden horse travels with its rider; a following one is put beside its owner (§1.3). */
  warped(p: Player, _reason: WarpReason, now: number): void {
    const c = this.horseOf(p)
    if (!c) return
    if (c.rider === p.id) {
      this.follow(c, p)
      this.g.world.refreshAround(c, now)
    } else this.catchUp(c, p, now)
  }

  /** Only DoT can kill a rider: it lands on its feet first; the horse waits and is put beside it at the respawn warp. */
  playerDied(p: Player, now: number): void {
    const c = this.ridden(p)
    if (!c) return
    this.stepDown(p, c, now, false)
    this.save(c, now)
  }

  /** Logout: the horse despawns and is saved out (ridden or following) with its HP; it comes back at enter-world. */
  forget(p: Player): void {
    const c = this.horses.get(p.characterId)
    if (!c || c.owner !== p.id) return
    if (c.diedAt === 0) this.store.save(p.characterId, c.code, c.hp, c.rider === p.id, true, this.state.get(c.id)?.bound ?? false)
    this.removeHorse(c)
  }

  // ---- following -----------------------------------------------------------------------------------------

  /**
   * One follow step of a dismounted horse: it stands within FOLLOW_GAP_M of its owner, walks there when close and runs
   * (at least as fast as the owner) when farther; it is put beside the owner when farther than the park range knob or
   * stuck for FOLLOW_STUCK_MS. A dead owner is waited for.
   */
  private followStep(c: Cos, owner: Player, st: HorseState, now: number): void {
    const w = this.g.world
    if (owner.dead) {
      if (c.move) w.halt(c, now)
      return
    }
    const o = w.positionAt(owner, now)
    const h = w.positionAt(c, now)
    const d = Math.hypot(o[0] - h[0], o[2] - h[2])
    if (d > knob(this.g.config, 'cosParkRangeM')) return this.catchUp(c, owner, now)
    if (d <= FOLLOW_GAP_M + 0.5) {
      if (c.move) w.halt(c, now)
      st.best = d
      st.closerAt = now
      return
    }
    if (d < st.best - 0.5) {
      st.best = d
      st.closerAt = now
    } else if (now - st.closerAt >= FOLLOW_STUCK_MS) return this.catchUp(c, owner, now)
    const k = (d - FOLLOW_GAP_M) / d
    const gx = h[0] + (o[0] - h[0]) * k
    const gz = h[2] + (o[2] - h[2]) * k
    const ownerSpeed = owner.move ? owner.move.speed : w.moveSpeed * moveMul(owner)
    const speed = d <= FOLLOW_WALK_M ? FOLLOW_WALK_SPEED : Math.max(st.def.runSpeed > 0 ? st.def.runSpeed : ownerSpeed, ownerSpeed * 1.2)
    const m = c.move
    if (m && m.speed === speed && Math.hypot(m.to[0] - gx, m.to[2] - gz) < 1 && w.arrivalTime(m) > now) return
    // blocked at once: it stands, and the stuck timer puts it beside the owner
    w.moveEntity(c, gx, gz, speed, now)
  }

  /** Puts the horse FOLLOW_GAP_M behind its owner (a wall in between: as far as the walk goes) and refreshes interest. */
  private catchUp(c: Cos, owner: Player, now: number): void {
    const w = this.g.world
    const here = w.livePoint(owner, now)
    const walk = this.g.nav.walk(here, here.x - Math.sin(owner.yaw) * FOLLOW_GAP_M, here.z - Math.cos(owner.yaw) * FOLLOW_GAP_M)
    const to = walk?.end ?? here
    c.pos = [to.x, Number.isFinite(to.y) ? to.y : here.y, to.z]
    c.surface = to.surface ?? here.surface
    c.move = null
    c.path = null
    c.yaw = owner.yaw
    const st = this.state.get(c.id)
    if (st) {
      st.best = Infinity
      st.closerAt = now
    }
    w.broadcastAbout(c, { t: 'stop', id: c.id, pos: wirePos(c.pos), yaw: wireYaw(c.yaw) })
    w.refreshAround(c, now)
  }

  // ---- actions -------------------------------------------------------------------------------------------

  /** Creates `p`'s horse at its feet (spawn to viewers) and, when `mount`, boards it at once. Saves the row. */
  private summon(p: Player, def: CosDef, hp: number, mount: boolean, now: number, bound = false): Cos {
    // A corpse still lying there (COS_COMBAT_LOCK_MS below CORPSE_MS) goes first: `horses` holds one horse per
    // character and tick() walks only that map, so an overwritten corpse would never despawn.
    const old = this.horses.get(p.characterId)
    if (old && old.diedAt !== 0) this.removeHorse(old)
    const at = this.g.world.livePoint(p, now)
    const c: Cos = {
      kind: 'cos',
      id: this.g.world.newId(),
      code: def.code,
      name: def.name ?? def.code,
      level: def.level,
      owner: p.id,
      ownerChar: p.characterId,
      hp,
      maxHp: def.hp,
      radius: def.radius,
      rider: null,
      diedAt: 0,
      pos: [at.x, at.y, at.z],
      yaw: p.yaw,
      move: null,
      surface: at.surface,
      path: null,
    }
    this.horses.set(p.characterId, c)
    this.state.set(c.id, { def, dirty: false, savedAt: now, bound, checkAt: now + ITEM_CHECK_MS, stepAt: now, best: Infinity, closerAt: now })
    this.g.world.addEntity(c, now)
    if (mount) this.board(p, c, now)
    else this.save(c, now)
    return c
  }

  /** Mounts `p` on its parked horse `c`: stop -> (onto the saddle) -> entityUpdate {p.mount} + {cos.rider}. */
  private board(p: Player, c: Cos, now: number): void {
    p.action = null
    this.g.posture.standUp(p)
    this.g.world.halt(p, now)
    // a following horse stops where it is now
    if (c.move) this.g.world.halt(c, now)
    if (Math.hypot(p.pos[0] - c.pos[0], p.pos[2] - c.pos[2]) > 0.01) {
      p.pos = [...c.pos]
      p.surface = c.surface ?? null
      this.g.world.broadcastAbout(p, { t: 'stop', id: p.id, pos: wirePos(p.pos), yaw: wireYaw(p.yaw) })
    }
    c.rider = p.id
    this.follow(c, p)
    const def = this.state.get(c.id)?.def
    p.radius = Math.max(PLAYER_BASE.radius, def?.radius ?? c.radius)
    this.g.refresh(p)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, mount: c.id })
    this.g.world.broadcastAbout(c, { t: 'entityUpdate', id: c.id, rider: p.id })
    this.save(c, now)
  }

  /** Play the Boss (docs/PLAY_THE_BOSS.md §3.3): a rider steps down where it stands (before the trance warp). */
  stepDownFor(p: Player, now: number): void {
    const c = this.ridden(p)
    if (c) this.stepDown(p, c, now, false)
  }

  /**
   * The rider leaves the saddle: the horse stays parked where it stands. `aside`: the rider is placed DISMOUNT_SIDE_M
   * to the horse's left (`stop`); otherwise it stays where it is (horse death, rider death).
   */
  private stepDown(p: Player, c: Cos, now: number, aside: boolean): void {
    const w = this.g.world
    const here = w.livePoint(p, now)
    c.rider = null
    c.move = null
    c.path = null
    c.pos = [here.x, here.y, here.z]
    c.surface = here.surface
    c.yaw = p.yaw
    if (aside) {
      w.halt(p, now)
      // The left of a yaw (forward = (sin, cos)) is (cos, -sin); a wall in between stops the step short.
      const walk = this.g.nav.walk(here, here.x + Math.cos(p.yaw) * DISMOUNT_SIDE_M, here.z - Math.sin(p.yaw) * DISMOUNT_SIDE_M)
      const to = walk?.end ?? here
      p.pos = [to.x, Number.isFinite(to.y) ? to.y : here.y, to.z]
      p.surface = to.surface ?? here.surface
      w.broadcastAbout(p, { t: 'stop', id: p.id, pos: wirePos(p.pos), yaw: wireYaw(p.yaw) })
    }
    p.radius = PLAYER_BASE.radius
    this.g.refresh(p)
    w.broadcastAbout(p, { t: 'entityUpdate', id: p.id, mount: null })
    w.broadcastAbout(c, { t: 'entityUpdate', id: c.id, rider: null })
  }

  /** A rider of `c` is set down where it is (no step aside). */
  private unseat(p: Player, c: Cos): void {
    if (c.rider !== p.id) return
    c.rider = null
    p.radius = PLAYER_BASE.radius
    this.g.refresh(p)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, mount: null })
  }

  /** Sends `p`'s horse home (ridden or following): it despawns, the row keeps its HP (`out` 0) and the item stays. */
  private sendHome(p: Player, c: Cos): void {
    this.unseat(p, c)
    const bound = this.state.get(c.id)?.bound ?? false
    if (c.diedAt === 0 && c.hp >= 1) this.store.save(p.characterId, c.code, c.hp, false, false, bound)
    else this.store.remove(p.characterId)
    this.removeHorse(c)
  }

  /** The horse died: corpse, the rider lands on its feet, the saved row goes. */
  private died(c: Cos, now: number): void {
    const w = this.g.world
    const rider = c.rider === null ? undefined : w.players.get(c.rider)
    if (rider) {
      const here = w.livePoint(rider, now)
      c.pos = [here.x, here.y, here.z]
      c.surface = here.surface
    }
    c.hp = 0
    c.diedAt = now
    c.move = null
    c.path = null
    w.broadcastAbout(c, { t: 'entityUpdate', id: c.id, hp: 0, state: 'dead' })
    if (rider) {
      c.rider = null
      rider.radius = PLAYER_BASE.radius
      this.g.refresh(rider)
      w.broadcastAbout(rider, { t: 'entityUpdate', id: rider.id, mount: null })
      w.broadcastAbout(c, { t: 'entityUpdate', id: c.id, rider: null })
    }
    // A dead horse is gone like a released one: the row and (bound) one summoning item go in one transaction.
    const owner = w.players.get(c.owner)
    const live = owner && owner.characterId === c.ownerChar ? owner : null
    if (live && this.state.get(c.id)?.bound) {
      const { result, draft } = this.g.store.inventoryTx(c.ownerChar, (d) => this.takeHorseItem(d, c.code), () => this.store.remove(c.ownerChar))
      if (!result.ok) this.store.remove(c.ownerChar)
      else {
        this.g.config.log(`mounts: ${live.name} (#${c.ownerChar}) lost ${c.code} (died; ${result.value.code} deleted)`)
        this.g.afterInventory(live, draft)
      }
    } else this.store.remove(c.ownerChar)
    if (live) live.send({ t: 'chat', channel: 'system', text: 'Your horse has died.' })
  }

  /** A ridden horse shares its rider's move and position (world.ts Cos). */
  private follow(c: Cos, rider: Player): void {
    c.pos = [...rider.pos]
    c.move = rider.move
    c.path = rider.path ?? null
    c.surface = rider.surface ?? null
    c.yaw = rider.yaw
  }

  /** Takes the entity out of the world and forgets it (the saved row is untouched). */
  private removeHorse(c: Cos): void {
    if (this.horses.get(c.ownerChar) === c) this.horses.delete(c.ownerChar)
    this.state.delete(c.id)
    this.g.world.removeEntity(c.id)
  }

  private save(c: Cos, now: number): void {
    if (c.diedAt !== 0 || c.hp < 1 || this.horses.get(c.ownerChar) !== c) return
    this.store.save(c.ownerChar, c.code, c.hp, c.rider !== null, true, this.state.get(c.id)?.bound ?? false)
    const st = this.state.get(c.id)
    if (st) {
      st.dirty = false
      st.savedAt = now
    }
  }

  /** Takes one of the item at `bag` and arms `group` for `cooldownMs`; the answer goes out after the commit. */
  private take(p: Player, bag: number, group: string, cooldownMs: number, answer: Answer, now: number): boolean {
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => takeFromBag(d, bag, 1))
    if (!result.ok) {
      answer(result)
      return false
    }
    const ms = Math.min(MAX_WIRE_MS, Math.max(0, Math.round(cooldownMs)))
    if (ms > 0) p.cooldowns.set(group, now + ms)
    answer(true)
    this.g.afterInventory(p, draft)
    if (ms > 0) p.send({ t: 'itemCooldown', group, readyInMs: ms, totalMs: ms })
    return true
  }

  // ---- GM ------------------------------------------------------------------------------------------------

  /** GM `horse [cos code]`: summons (and mounts) without an item (not bound), replacing a horse it has; `horse off` sends it home. */
  gm(self: Player, args: string[]): GmResult {
    const now = this.g.now
    const arg = args[0]
    if (arg !== undefined && arg.toLowerCase() === 'off') {
      const c = this.horseOf(self)
      if (!c) return { ok: false, message: 'You have no horse.' }
      this.sendHome(self, c)
      return { ok: true, message: `${c.name} sent home.` }
    }
    if (self.dead) return { ok: false, message: 'You are dead.' }
    const code = arg !== undefined ? arg.toUpperCase() : this.defs.has(DEFAULT_HORSE) ? DEFAULT_HORSE : [...this.defs.keys()].find((k) => !isTransportCos(k))
    if (code !== undefined && !CODE_NAME.test(code)) return { ok: false, message: `Usage: ${HORSE_USAGE}` }
    const def = code === undefined ? undefined : this.defs.get(code)
    if (!def) return { ok: false, message: code === undefined ? 'No horses in cos.json.' : `No horse ${code} in cos.json.` }
    const old = this.horses.get(self.characterId)
    if (old) {
      this.unseat(self, old)
      this.removeHorse(old)
    }
    const c = this.summon(self, def, def.hp, true, now)
    return { ok: true, message: `${c.name} summoned (${c.hp} HP).` }
  }
}
