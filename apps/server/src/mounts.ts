import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_NAME, CONTENT_FILES, MAX_COMBAT_HITS, checkCosDef, contentEntries, type CombatHit, type CosDef, type GameplayRequest, type ItemDef, type ServerMessage } from '@sro/shared'
import { knob } from './config.ts'
import type { Store } from './db.ts'
import { CORPSE_MS, PLAYER_BASE, POTION_COOLDOWN_MS } from './formulas.ts'
import type { Gameplay, HitExtra } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import { fail, takeFromBag, type Fail } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from './modules.ts'
import type { Cos, Mob, Npc, Player } from './world.ts'

/**
 * Horses (docs/SYSTEMS_COMBAT.md §1.3; docs/WAVE_PLAN2.md D43, D49, D52; lane MR-S).
 *
 * - **Summon**: `itemUse` of an item with `use.summon` (ItemUses dispatches it here, D52). Checks in order: alive,
 *   the item's level (`requirements`), no horse yet (`cos_active`), no combat for COS_COMBAT_LOCK_MS (`in_combat`),
 *   no skill action or return-scroll cast (`busy`), not berserk (`berserk_active`, D49). One item is consumed, the
 *   horse appears under the player with full HP and the player is mounted at once:
 *   actionResult -> inventoryUpdate -> spawn {cos} -> entityUpdate {p.mount} + entityUpdate {cos.rider}.
 * - **Mounted**: speed x runSpeed / PLAYER_RETAIL_RUN (1.8 for the Red Horse) through the SkillEngine mod provider
 *   (`mountSpeed`, which replaces buff speed), radius max(player, horse). Attacks and skills are refused `mounted`
 *   (the `refuse` seam); the `gate` refuses sit, emote, stallCreate, alchemyReinforce and berserk with `mounted` (D43).
 *   Hits on the rider land on the horse (the `redirect` seam), except DoT ticks; statuses stay on the rider.
 * - A ridden horse shares its rider's MoveState and is never sent `move`s: `tick` copies the rider's move/pos, and a
 *   warp of the rider carries the horse along. A parked horse stays put; it is dismissed when its owner goes farther
 *   than COS_PARK_RANGE_M, warps, or leaves the world.
 * - `mountDismount` (not while moving) parks the horse and puts the rider 1.2 m to its left; `mountRide` walks to the
 *   own parked horse (the 'board' action) and mounts within COS_BOARD_RANGE; `mountDismiss` removes the horse.
 * - The horse dies at 0 HP: the rider lands on its feet, the corpse leaves after CORPSE_MS, the saved row is deleted.
 *   Horses do not regenerate; Recovery Kits (`use.target === 'mount'`) heal the own horse (ridden, or parked within
 *   KIT_RANGE_M): actionResult -> inventoryUpdate -> itemCooldown -> entityUpdate {cos.hp} -> itemEffect {id: cos}.
 * - Persistence: `char_mount` (migration 8), written on summon, ride, dismount, heal, damage (at most every
 *   SAVE_EVERY_MS) and logout. Enter-world re-creates the saved horse (mounted or parked) with its HP; a logout while
 *   parked dismisses it.
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
}

/** Runtime state of a live horse beyond the Cos entity (keyed by the horse's entity id). */
interface HorseState {
  def: CosDef
  /** Unsaved HP change (damage is saved at most every SAVE_EVERY_MS). */
  dirty: boolean
  savedAt: number
}

/** char_mount statements (migration 8). */
function openMountStore(store: Store) {
  const db = store.db
  const q = {
    get: db.prepare<[number], MountRow>('SELECT code, hp, mounted FROM char_mount WHERE character_id = ?'),
    put: db.prepare<[number, string, number, number]>(
      'INSERT INTO char_mount (character_id, code, hp, mounted) VALUES (?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET code = excluded.code, hp = excluded.hp, mounted = excluded.mounted',
    ),
    del: db.prepare<[number]>('DELETE FROM char_mount WHERE character_id = ?'),
  }
  return {
    load: (characterId: number): MountRow | undefined => q.get.get(characterId),
    save: (characterId: number, code: string, hp: number, mounted: boolean): void => void q.put.run(characterId, code, Math.max(1, Math.round(hp)), mounted ? 1 : 0),
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
  readonly handles: readonly GameplayRequest[] = ['mountRide', 'mountDismount', 'mountDismiss']
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
    return this.ridden(t) ?? t
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
    if (!this.ridden(p)) return null
    return fail('mounted', what === 'skill' ? 'Cannot use the skill while on the vehicle.' : 'Cannot attack while riding.')
  }

  /** D43: while mounted, sit, emote, stallCreate, alchemyReinforce and berserk are refused `mounted`. */
  gate(p: Player, t: GameplayRequest | 'moveTo', _now: number): Fail | null {
    if (t === 'moveTo' || !MOUNTED_REFUSED.includes(t)) return null
    return this.ridden(p) ? fail('mounted') : null
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
    answer(fail('not_found'))
  }

  private summonItem(p: Player, def: ItemDef, bag: number, answer: Answer, now: number): void {
    const cos = this.defs.get(def.use!.summon!)
    if (!cos) return answer(fail('not_usable', 'That horse is not available.'))
    if (p.progress.level < def.reqLevel) return answer(fail('requirements'))
    if (this.horseOf(p)) return answer(fail('cos_active', 'Cannot summon more than one transport.'))
    const why = this.boardProblem(p, now)
    if (why) return answer(why)
    const group = def.use!.cooldownGroup ?? def.code
    if (!this.take(p, bag, group, def.use!.cooldownMs ?? 0, answer, now)) return
    this.summon(p, cos, cos.hp, true, now)
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

  private dismissRequest(p: Player, answer: Answer, now: number): void {
    const c = this.horseOf(p)
    if (!c) return answer(fail('not_found', 'You have no horse.'))
    answer(true)
    this.dismiss(p, c)
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------

  /** Enter-world (D35): re-creates the saved horse beside the player, mounted when it was (and the player is alive). */
  enter(p: Player, now: number): void {
    const row = this.store.load(p.characterId)
    if (!row) return
    const def = this.defs.get(row.code)
    if (!def) {
      // cos.json lacks the code (a partial export): keep the row for when it returns.
      this.g.config.log(`mounts: ${p.name} has a saved horse ${row.code} that cos.json does not list`)
      return
    }
    const old = this.horses.get(p.characterId)
    if (old) this.removeHorse(old)
    this.summon(p, def, Math.min(def.hp, Math.max(1, row.hp)), row.mounted === 1 && !p.dead, now)
  }

  /** A walk to the own parked horse (the 'board' PlayerAction) mounts on arrival. */
  tickPlayer(p: Player, now: number): void {
    const a = p.action
    if (a?.kind !== 'board') return
    const c = this.horseOf(p)
    if (!c || c.id !== a.cos || c.rider !== null) {
      p.action = null
      return
    }
    // Gameplay.approach reads only the position of its target; a parked horse stands still.
    const spot: Npc = { kind: 'npc', id: c.id, code: c.code, name: c.name, pos: c.pos, yaw: c.yaw }
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

  /** Ridden horses follow their riders; parked ones leave past the park range; corpses despawn; damage is saved. */
  tick(now: number): void {
    const range = knob(this.g.config, 'cosParkRangeM')
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
      if (c.rider !== null) this.follow(c, owner)
      else if (this.g.world.distance(owner, c, now) > range) {
        this.dismiss(owner, c)
        owner.send({ t: 'chat', channel: 'system', text: 'Your horse went home.' })
        continue
      }
      const st = this.state.get(c.id)
      if (st?.dirty && now - st.savedAt >= SAVE_EVERY_MS) this.save(c, now)
    }
  }

  /** A ridden horse travels with its rider; a parked one is dismissed (§1.3). */
  warped(p: Player, _reason: WarpReason, now: number): void {
    const c = this.horseOf(p)
    if (!c) return
    if (c.rider === p.id) {
      this.follow(c, p)
      this.g.world.refreshAround(c, now)
    } else this.dismiss(p, c)
  }

  /** Only DoT can kill a rider: it lands on its feet first; the parked horse is dismissed at the respawn warp. */
  playerDied(p: Player, now: number): void {
    const c = this.ridden(p)
    if (!c) return
    this.stepDown(p, c, now, false)
    this.save(c, now)
  }

  /** Logout: a ridden horse is saved (mounted, with its HP) and leaves with its rider; a parked one is dismissed. */
  forget(p: Player): void {
    const c = this.horses.get(p.characterId)
    if (!c || c.owner !== p.id) return
    if (c.diedAt === 0 && c.rider === p.id) {
      this.store.save(p.characterId, c.code, c.hp, true)
      this.removeHorse(c)
    } else {
      if (c.diedAt === 0) this.store.remove(p.characterId)
      this.removeHorse(c)
    }
  }

  // ---- actions -------------------------------------------------------------------------------------------

  /** Creates `p`'s horse at its feet (spawn to viewers) and, when `mount`, boards it at once. Saves the row. */
  private summon(p: Player, def: CosDef, hp: number, mount: boolean, now: number): Cos {
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
    this.state.set(c.id, { def, dirty: false, savedAt: now })
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
    if (Math.hypot(p.pos[0] - c.pos[0], p.pos[2] - c.pos[2]) > 0.01) {
      p.pos = [...c.pos]
      p.surface = c.surface ?? null
      this.g.world.broadcastAbout(p, { t: 'stop', id: p.id, pos: [...p.pos], yaw: p.yaw })
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
      w.broadcastAbout(p, { t: 'stop', id: p.id, pos: [...p.pos], yaw: p.yaw })
    }
    p.radius = PLAYER_BASE.radius
    this.g.refresh(p)
    w.broadcastAbout(p, { t: 'entityUpdate', id: p.id, mount: null })
    w.broadcastAbout(c, { t: 'entityUpdate', id: c.id, rider: null })
  }

  /** Removes `p`'s horse (ridden or parked) and its saved row. A rider is set down where it is. */
  private dismiss(p: Player, c: Cos): void {
    if (c.rider === p.id) {
      c.rider = null
      p.radius = PLAYER_BASE.radius
      this.g.refresh(p)
      this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, mount: null })
    }
    this.store.remove(p.characterId)
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
    this.store.remove(c.ownerChar)
    const owner = w.players.get(c.owner)
    if (owner && owner.characterId === c.ownerChar) owner.send({ t: 'chat', channel: 'system', text: 'Your horse has died.' })
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
    this.store.save(c.ownerChar, c.code, c.hp, c.rider !== null)
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

  /** GM `horse [cos code]`: summons (and mounts) without an item, replacing a horse it has; `horse off` dismisses. */
  gm(self: Player, args: string[]): GmResult {
    const now = this.g.now
    const arg = args[0]
    if (arg !== undefined && arg.toLowerCase() === 'off') {
      const c = this.horseOf(self)
      if (!c) return { ok: false, message: 'You have no horse.' }
      this.dismiss(self, c)
      return { ok: true, message: `${c.name} dismissed.` }
    }
    if (self.dead) return { ok: false, message: 'You are dead.' }
    const code = arg !== undefined ? arg.toUpperCase() : this.defs.has(DEFAULT_HORSE) ? DEFAULT_HORSE : this.defs.keys().next().value
    if (code !== undefined && !CODE_NAME.test(code)) return { ok: false, message: `Usage: ${HORSE_USAGE}` }
    const def = code === undefined ? undefined : this.defs.get(code)
    if (!def) return { ok: false, message: code === undefined ? 'No horses in cos.json.' : `No horse ${code} in cos.json.` }
    const old = this.horses.get(self.characterId)
    if (old) {
      if (old.diedAt === 0) this.dismiss(self, old)
      else this.removeHorse(old)
    }
    const c = this.summon(self, def, def.hp, true, now)
    return { ok: true, message: `${c.name} summoned (${c.hp} HP).` }
  }
}
