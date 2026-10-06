import {
  FENCE_SERVICE,
  LAW_CODES,
  LAW_REQUESTS,
  fenceNpc,
  installSiegeLawContent,
  kegSpot,
  wallName,
  wallOpen,
  type GameplayRequest,
  type ItemDef,
  type ServerMessage,
  type SiegeEventSettings,
  type Vec3,
  type WallStage,
  type WallsExport,
} from '@sro/shared'
import { addBaseNpc } from '../editors/overrides.ts'
import type { Gameplay } from '../gameplay.ts'
import { addGold, addItem, fail, takeFromBag, type Fail, type InvDraft } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from '../modules.ts'
import type { Player } from '../world.ts'
import type { Associates } from './law.ts'
import type { WallService } from './walls.ts'

/**
 * Siege of Jangan: kegs at the foot of the wall (docs/SIEGE.md §7, §7.1). The keg rules both kinds share (the sappers'
 * of layer 4 in siege/event.ts, the players' here): one id space, the `keg` message, the defuse channel (any player
 * within 3 m, `defuseSec`, broken by moving, damage or death), the blast (25 % of max HP within 6 m, non-lethal for
 * players).
 *
 * Layer 5, the players' Thunder Keg: a GameplayModule named `kegs`, on with the walls.
 * - **Content**: the Thunder Keg, Saltpeter (Bandit and Bandit Archer drops) and Old Fang the Fence (west of town, his
 *   `fence` service) into GameData (packages/shared/src/siege-law.ts) and the editors' base content.
 * - **Craft** (`kegCraft {npc}` at Old Fang): `keg.gold` gold + `keg.saltpeter` Saltpeter; level and played time as the
 *   plant; at most `keg.carry` carried (`keg_limit`).
 * - **Plant** (`itemUse` of the keg): at a segment's outer foot (kegSpot: within `keg.faceM` of the outer face, never at
 *   a gatehouse or a corner, never in a safe area; `wrong_place` / `too_far` / `safe_zone`), not at an open segment,
 *   level ≥ `minLevel`, ≥ `minPlayHours` played, one plant per ACCOUNT per `cooldownMin` (`keg_limit`, law_records);
 *   a `plantSec` cast drawn with the item cast bar (moving, acting, damage, a warp or death interrupts it). The cast's
 *   start is a server-wide notice (`lawNotice plant`, no name; at most one per segment per `noticeMin`). Then the keg
 *   burns `fuseSec`; anyone but the planter's associates may defuse it (`kegDefuse`, routed here by the siege module).
 * - **Blast**: `damagePct` of the segment (wall_log cause `keg` with the planter), the 6 m hurt; the law (law.ts) hears
 *   it: a blast that opens the segment makes the planter Wanted, earlier kegs on it make accomplices.
 */

/** Blast radius, defuse reach (m), share of max HP the blast takes (docs/SIEGE.md §7.1). */
export const KEG_BLAST_M = 6
export const KEG_DEFUSE_M = 3
export const KEG_HURT = 0.25
/** The planter may drift this far before the cast counts as moved (as the return scroll). */
const CAST_MOVE_TOLERANCE_M = 0.3

let kegSeq = 0
/** One id space for every keg on the ground (the client keeps them in one map). */
export const nextKegId = (): number => ++kegSeq

export interface KegDefuse {
  player: number
  characterId: number
  name: string
  endsAt: number
  x: number
  z: number
  hp: number
}

/** A keg on the ground, as the shared rules see it. */
export interface GroundKeg {
  id: number
  seg: string
  at: Vec3
  fuseEndsAt: number
  defuse: KegDefuse | null
}

export function kegMessage(k: GroundKeg, sapper: boolean): Extract<ServerMessage, { t: 'keg' }> {
  const msg: Extract<ServerMessage, { t: 'keg' }> = { t: 'keg', id: k.id, seg: k.seg, x: k.at[0], y: k.at[1], z: k.at[2], fuseEndsAt: k.fuseEndsAt }
  if (sapper) msg.sapper = true
  if (k.defuse) msg.defuse = { by: k.defuse.player, endsAt: k.defuse.endsAt }
  return msg
}

/** `p` starts defusing `k` (a `defuseSec` channel from where it stands). */
export function beginDefuse(g: Gameplay, p: Player, k: GroundKeg, defuseSec: number, now: number): void {
  const q = g.world.positionAt(p, now)
  g.world.halt(p, now)
  k.defuse = { player: p.id, characterId: p.characterId, name: p.name, endsAt: now + defuseSec * 1000, x: q[0], z: q[2], hp: p.hp }
}

/** The defuse channel of `k` now: broken (gone, dead, moved, hurt), done (with the defuser), or still running (null). */
export function defuseStep(g: Gameplay, k: GroundKeg, now: number): { state: 'broken' } | { state: 'done'; p: Player } | null {
  const d = k.defuse
  if (!d) return null
  const p = g.world.players.get(d.player)
  const q = p && g.world.positionAt(p, now)
  if (!p || p.dead || !q || Math.hypot(q[0] - d.x, q[2] - d.z) > 0.75 || p.hp < d.hp) return { state: 'broken' }
  return now >= d.endsAt ? { state: 'done', p } : null
}

/** The blast's hurt: 25 % of max HP to every body within 6 m (non-lethal for players; the Town Bell is spared). */
export function blastHurt(g: Gameplay, at: Vec3, now: number): void {
  for (const p of g.world.playersNear(at[0], at[2], KEG_BLAST_M, now)) {
    if (!p.dead) g.hazardHit(p, Math.round(p.maxHp * KEG_HURT), 'keg', now, undefined, true)
  }
  for (const m of [...g.world.mobs.values()]) {
    if (m.ai === 'dead' || m.siege?.role === 'bell') continue
    const q = g.world.positionAt(m, now)
    if (Math.hypot(q[0] - at[0], q[2] - at[2]) <= KEG_BLAST_M) g.hazardHit(m, Math.round(m.maxHp * KEG_HURT), 'keg', now)
  }
}

// ---- the players' Thunder Keg (layer 5) ------------------------------------------------------------------------------

/** What the keg needs of the walls (WallService; tests pass a stand-in). */
export interface KegWalls {
  readonly on: boolean
  readonly walls: Pick<WallsExport, 'segments' | 'sides'> | null
  readonly settings: { maxIp: number }
  stageOf(id: string): WallStage | null
  change(id: string, delta: number, cause: 'keg', now: number, opts: { characterId?: number | null; at?: Vec3; fx?: 'chip'; data?: Record<string, unknown> }): { stage: WallStage; stageBefore: WallStage } | null
}

export interface Planter {
  characterId: number
  accountId: number
  name: string
}

export interface PlayerKeg extends GroundKeg {
  planter: Planter
  /** The planter's associates at the plant: they may not defuse it. */
  associates: Associates
  /** When it was planted (the blast, not the plant, decides treason). */
  plantedAt: number
}

interface PlantCast {
  seg: string
  bag: number
  startX: number
  startZ: number
  hp: number
  castMs: number
  endsAt: number
}

export class ThunderKegs implements GameplayModule {
  readonly name = 'kegs'
  readonly handles: readonly GameplayRequest[] = LAW_REQUESTS
  walls: KegWalls
  readonly kegs = new Map<number, PlayerKeg>()
  private readonly casts = new Map<number, PlantCast>()
  /** Segment -> the last plant notice (ms). */
  private readonly noticed = new Map<string, number>()

  constructor(
    private readonly g: Gameplay,
    walls: WallService,
  ) {
    this.walls = walls
    // the keg's use is always ours (without walls the plant is refused)
    g.itemUses.hooks.push((p, def, bag, _group, answer, now) => {
      if (!def.use?.thunderKeg) return false
      this.startPlant(p, def, bag, answer, now)
      return true
    })
    if (!walls.on) return
    const d = g.data
    const added = installSiegeLawContent({ items: d.items, drops: d.drops, npcs: d.npcs }, g.config.world)
    const npc = d.npcs.find((n) => n.code === LAW_CODES.fence) ?? fenceNpc(g.config.world)
    if (!d.npcModel.has(npc.code)) d.npcModel.set(npc.code, LAW_CODES.fenceBase)
    addBaseNpc(d, npc, d.npcModel.get(npc.code))
    g.config.log(`walls: Thunder Kegs on (Old Fang${added.npc ? '' : ' (kept)'}, ${added.items} items, Saltpeter drops on ${added.drops} tables)`)
  }

  /** Tests: the walls to use. */
  configure(o: { walls: KegWalls }): void {
    this.walls = o.walls
  }

  get on(): boolean {
    return this.walls.on && this.walls.walls !== null
  }

  get settings(): SiegeEventSettings['keg'] {
    return this.g.siege.settings.keg
  }

  /** Whether NPC `code` offers the `fence` service. */
  offers(code: string): boolean {
    return this.on && code === LAW_CODES.fence
  }

  // ---- rules ------------------------------------------------------------------------------------------------------------

  /** Why `p` may not have or plant a keg at all (level, played time, the law's own bars), or null. */
  private personRefusal(p: Player): Fail | null {
    const s = this.settings
    if (p.level < s.minLevel) return fail('requirements', `Thunder Kegs are for characters of level ${s.minLevel} and up.`)
    const played = this.g.store.characterById(p.characterId)?.played_ms ?? 0
    if (played < s.minPlayHours * 3_600_000) return fail('requirements', `You need ${s.minPlayHours} hours of play on this character before you may handle a Thunder Keg.`)
    return this.g.law.kegRefusal(p)
  }

  /** The account's plant cooldown left (ms; 0 = free). */
  cooldownLeft(p: Player, now: number): number {
    const acc = this.g.law.accountOf(p.characterId)
    const last = acc === null ? null : (this.g.law.store.record(acc)?.lastPlantAt ?? null)
    return last === null ? 0 : Math.max(0, last + this.settings.cooldownMin * 60_000 - now)
  }

  /** Where `p` would plant now: the segment, or why not. */
  plantSpot(p: Player, now: number): { seg: string } | Fail {
    const walls = this.walls.walls
    if (!walls) return fail('not_usable', 'The town walls cannot be blown up on this server.')
    const s = this.settings
    const [x, , z] = this.g.world.positionAt(p, now)
    if (this.g.data.inSafeArea(this.g.config.world, x, z)) return fail('safe_zone', 'A Thunder Keg cannot be planted in a safe area.')
    const spot = kegSpot(walls, x, z, s.faceM)
    if (!spot.ok) {
      if (spot.why === 'gate') return fail('wrong_place', 'The gatehouses and the corner towers cannot be blown up.')
      if (spot.why === 'inside') return fail('wrong_place', 'Plant it at the outer foot of the wall, outside the town.')
      return fail('too_far', `Stand at the outer foot of the town wall (within ${s.faceM} m of it) to plant a Thunder Keg.`)
    }
    const st = this.walls.stageOf(spot.seg.id)
    if (!st || wallOpen(st)) return fail('not_usable', `${cap(wallName(spot.seg.id))} is already breached.`)
    return { seg: spot.seg.id }
  }

  /** Every check of a plant (start and completion). */
  private plantRefusal(p: Player, now: number): Fail | { seg: string } {
    if (!this.on) return fail('not_usable', 'The town walls cannot be blown up on this server.')
    if (p.dead) return fail('dead')
    const who = this.personRefusal(p)
    if (who) return who
    const left = this.cooldownLeft(p, now)
    if (left > 0) return fail('keg_limit', `Your account planted a Thunder Keg not long ago: wait ${Math.ceil(left / 60_000)} min.`)
    return this.plantSpot(p, now)
  }

  // ---- craft (Old Fang) ----------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t !== 'kegCraft') return answer(fail('not_found'))
    if (!this.on) return answer(fail('not_found', 'No one sells Thunder Kegs on this server.'))
    const npc = this.g.npcs.requireService(p, msg.npc, FENCE_SERVICE, now)
    if (!npc.ok) return answer(npc)
    const who = this.personRefusal(p)
    if (who) return answer(who)
    const s = this.settings
    const def = this.g.data.item(LAW_CODES.keg)
    if (!def) return answer(fail('not_found'))
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      if (countIn(d, LAW_CODES.keg) >= s.carry) return fail('keg_limit', `You can carry at most ${s.carry} Thunder Kegs.`)
      if (d.gold < s.gold) return fail('not_enough_gold', `A Thunder Keg costs ${s.gold.toLocaleString('en-US')} gold.`)
      const have = countIn(d, LAW_CODES.saltpeter)
      if (have < s.saltpeter) return fail('invalid_count', `Old Fang needs ${s.saltpeter} Saltpeter for a keg (you have ${have}).`)
      const t = takeCount(d, LAW_CODES.saltpeter, s.saltpeter)
      if (!t.ok) return t
      const g = addGold(d, -s.gold)
      if (!g.ok) return g
      const a = addItem(d, def, 1)
      return a.ok ? g : a
    })
    if (!result.ok) return answer(result)
    answer(true)
    this.g.afterInventory(p, draft)
    p.send({ t: 'chat', channel: 'system', text: `Old Fang packs you a Thunder Keg for ${s.gold.toLocaleString('en-US')} gold and ${s.saltpeter} Saltpeter. "Outer foot of the wall, friend. And run."` })
    this.g.config.log(`kegs: ${p.name} bought a Thunder Keg`)
  }

  // ---- plant ---------------------------------------------------------------------------------------------------------------

  private startPlant(p: Player, def: ItemDef, bag: number, answer: Answer, now: number): void {
    const r = this.plantRefusal(p, now)
    if ('ok' in r) return answer(r)
    if (this.casts.has(p.id) || this.g.itemUses.casting(p) || this.g.itemUses.skillBusy(p, now) || this.g.wallRepair.channelOf(p)) return answer(fail('busy'))
    answer(true)
    p.action = null
    this.g.world.halt(p, now)
    const [x, , z] = this.g.world.positionAt(p, now)
    const castMs = Math.max(1000, Math.round(this.settings.plantSec * 1000))
    this.casts.set(p.id, { seg: r.seg, bag, startX: x, startZ: z, hp: p.hp, castMs, endsAt: now + castMs })
    this.g.world.broadcastAbout(p, { t: 'itemCast', id: p.id, item: def.code, castMs })
    this.plantNotice(r.seg, now)
  }

  /** "Someone is planting a Thunder Keg at …" to every world player (no name), at most once per segment per noticeMin. */
  private plantNotice(seg: string, now: number): void {
    const last = this.noticed.get(seg)
    if (last !== undefined && now - last < this.settings.noticeMin * 60_000) return
    this.noticed.set(seg, now)
    const msg: ServerMessage = { t: 'lawNotice', event: 'plant', wall: seg }
    for (const q of this.g.world.players.values()) q.send(msg)
    this.chat(`[Law] Someone is planting a Thunder Keg at ${wallName(seg)}! Defuse it before it blows.`)
  }

  /** The plant cast of `p` (tests, GM). */
  castOf(p: Player): { seg: string; endsAt: number } | null {
    const c = this.casts.get(p.id)
    return c ? { seg: c.seg, endsAt: c.endsAt } : null
  }

  cancel(p: Player, reason: 'cancelled' | 'interrupted'): void {
    if (!this.casts.delete(p.id)) return
    this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: LAW_CODES.keg, reason })
  }

  private complete(p: Player, c: PlantCast, now: number): void {
    this.casts.delete(p.id)
    const r = this.plantRefusal(p, now)
    const end = (reason: 'done' | 'cancelled') => this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: LAW_CODES.keg, reason })
    if ('ok' in r) {
      end('cancelled')
      if (r.message) p.send({ t: 'chat', channel: 'system', text: r.message })
      return
    }
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const at = d.bag[c.bag]?.code === LAW_CODES.keg ? c.bag : d.bag.findIndex((i) => i?.code === LAW_CODES.keg)
      return at < 0 ? fail('invalid_slot', 'the keg is gone') : takeFromBag(d, at, 1)
    })
    if (!result.ok) return end('cancelled')
    const acc = this.g.law.accountOf(p.characterId) ?? 0
    this.g.law.store.setPlant(acc, now)
    const at = this.g.world.positionAt(p, now)
    const k: PlayerKeg = {
      id: nextKegId(),
      seg: r.seg,
      at: [at[0], at[1], at[2]],
      fuseEndsAt: now + this.settings.fuseSec * 1000,
      defuse: null,
      planter: { characterId: p.characterId, accountId: acc, name: p.name },
      associates: this.g.law.associates(p),
      plantedAt: now,
    }
    this.kegs.set(k.id, k)
    end('done')
    this.g.afterInventory(p, draft)
    this.broadcast(kegMessage(k, false))
    this.g.config.log(`kegs: ${p.name} planted a Thunder Keg at ${r.seg} (keg ${k.id})`)
  }

  // ---- defuse (routed by the siege module, which answers kegDefuse) -------------------------------------------------------

  defuse(p: Player, id: number, answer: Answer, now: number): void {
    const k = this.kegs.get(id)
    if (!k) return answer(fail('not_found', 'That keg is gone.'))
    const q = this.g.world.positionAt(p, now)
    if (Math.hypot(q[0] - k.at[0], q[2] - k.at[2]) > KEG_DEFUSE_M) return answer(fail('too_far', 'Get closer to the keg to defuse it.'))
    if (this.g.law.isAssociate(k.associates, p)) return answer(fail('not_usable', 'You cannot defuse a keg you or your friends planted.'))
    if (k.defuse && k.defuse.player !== p.id) return answer(fail('busy', 'Someone is defusing it already.'))
    beginDefuse(this.g, p, k, this.settings.defuseSec, now)
    this.broadcast(kegMessage(k, false))
    answer(true)
  }

  // ---- the tick ----------------------------------------------------------------------------------------------------------

  tick(now: number): void {
    for (const k of [...this.kegs.values()]) {
      const d = defuseStep(this.g, k, now)
      if (d?.state === 'broken') {
        k.defuse = null
        this.broadcast(kegMessage(k, false))
      } else if (d?.state === 'done') {
        this.kegs.delete(k.id)
        this.broadcast({ t: 'kegEnd', id: k.id, how: 'defused' })
        this.broadcast({ t: 'lawNotice', event: 'defused', wall: k.seg, name: d.p.name })
        this.g.siege.creditDefuse(d.p)
        this.g.config.log(`kegs: ${d.p.name} defused ${k.planter.name}'s Thunder Keg at ${k.seg}`)
        continue
      }
      if (now >= k.fuseEndsAt) {
        this.kegs.delete(k.id)
        this.blast(k, now)
      }
    }
  }

  blast(k: PlayerKeg, now: number): void {
    this.broadcast({ t: 'kegEnd', id: k.id, how: 'blast' })
    const ip = Math.round((this.settings.damagePct / 100) * this.walls.settings.maxIp)
    const c = this.walls.change(k.seg, -ip, 'keg', now, { characterId: k.planter.characterId, at: k.at, fx: 'chip', data: { keg: k.id, by: k.planter.name } })
    blastHurt(this.g, k.at, now)
    const opened = c !== null && !wallOpen(c.stageBefore) && wallOpen(c.stage)
    this.g.config.log(`kegs: ${k.planter.name}'s Thunder Keg blew at ${k.seg}${opened ? ' and breached it' : ''}`)
    this.g.law.kegBlast(k.planter, k.seg, now, opened)
  }

  private broadcast(msg: ServerMessage): void {
    for (const p of this.g.world.players.values()) p.send(msg)
  }

  private chat(text: string): void {
    this.broadcast({ t: 'chat', channel: 'system', text })
  }

  // ---- hooks ---------------------------------------------------------------------------------------------------------------

  enter(p: Player): void {
    for (const k of this.kegs.values()) p.send(kegMessage(k, false))
  }

  tickPlayer(p: Player, now: number): void {
    const c = this.casts.get(p.id)
    if (!c) return
    const [x, , z] = this.g.world.positionAt(p, now)
    const moved = p.move !== null || Math.hypot(x - c.startX, z - c.startZ) > CAST_MOVE_TOLERANCE_M
    const hurt = p.hp < c.hp
    c.hp = p.hp
    if (moved || hurt || p.action !== null || this.g.itemUses.skillBusy(p, now)) return this.cancel(p, 'interrupted')
    if (now >= c.endsAt) this.complete(p, c, now)
  }

  moved(p: Player): void {
    this.cancel(p, 'interrupted')
  }

  stopped(p: Player): void {
    this.cancel(p, 'cancelled')
  }

  playerDied(p: Player): void {
    this.cancel(p, 'interrupted')
  }

  warped(p: Player, _reason: WarpReason): void {
    this.cancel(p, 'interrupted')
  }

  inventoryChanged(p: Player): void {
    if (this.casts.has(p.id) && !this.g.store.loadInventory(p.characterId).bag.some((i) => i?.code === LAW_CODES.keg)) this.cancel(p, 'cancelled')
  }

  forget(p: Player): void {
    this.casts.delete(p.id)
    for (const k of this.kegs.values()) if (k.defuse?.player === p.id) k.defuse = null
  }

  /** GM: the burning player kegs. */
  describe(now: number): string {
    if (!this.kegs.size) return 'No Thunder Kegs burning.'
    return `Thunder Kegs: ${[...this.kegs.values()].map((k) => `#${k.id} ${k.seg} by ${k.planter.name}, ${Math.max(0, Math.round((k.fuseEndsAt - now) / 1000))} s${k.defuse ? `, ${k.defuse.name} defusing` : ''}`).join('; ')}`
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** How many of `code` the bag holds. */
function countIn(d: InvDraft, code: string): number {
  let n = 0
  for (const it of d.bag) if (it?.code === code) n += it.count
  return n
}

/** Takes `count` of `code` from the bag, lowest slots first (all or nothing inside the transaction). */
function takeCount(d: InvDraft, code: string, count: number): ReturnType<typeof takeFromBag> | { ok: true; value: undefined } {
  let left = count
  for (let i = 0; i < d.bagSize && left > 0; i++) {
    const it = d.bag[i]
    if (it?.code !== code) continue
    const n = Math.min(left, it.count)
    const r = takeFromBag(d, i, n)
    if (!r.ok) return r
    left -= n
  }
  return left > 0 ? fail('invalid_count') : { ok: true, value: undefined }
}
