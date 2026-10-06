import {
  SIEGE_CODES,
  WALL_SEGMENT_ID,
  allocateDonation,
  builderStepIp,
  goldForIp,
  installSiegeContent,
  kitIp,
  masonNpc,
  nearestSegment,
  planDonation,
  queueRoom,
  segmentDistance,
  wallName,
  wallPct,
  type GameplayRequest,
  type ItemDef,
} from '@sro/shared'
import { addBaseNpc } from '../editors/overrides.ts'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, fail, takeFromBag, type InvDraft } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from '../modules.ts'
import type { Player } from '../world.ts'
import type { WallService } from './walls.ts'

/**
 * Siege of Jangan, layer 3: repair (docs/SIEGE.md §2.4, §7). A GameplayModule named `wallRepair`, on with the walls.
 *
 * - **Content**: installs Master Mason Ko (by the south gate, the Blacksmith's model), his shop (Mason's Kit, Stone
 *   Block), the two items and the Stone Ghost's Stone Block drop (packages/shared/src/siege-repair.ts) into GameData, and
 *   into the editors' base content so a GM NPC edit keeps him.
 * - **Donations** (`wallDonate`, at Ko within 8 m, his `mason` service): gold and/or Stone Blocks toward one segment or
 *   "where it is needed" (the worst segments first). Only what the queues can take is charged, blocks first; the queued
 *   work is saved at once with the segment (wall_segments.queued, migration 17) and logged (`wall_log` cause `donation`).
 *   Refused: `not_enough_gold` (asked for more gold than carried), `invalid_count` (more blocks than carried, or the
 *   queue is full), `not_found` (unknown segment or NPC), `too_far`.
 * - **Builders**: every BUILDER_STEP_MS each damaged segment with queued work gains up to builderPctPerMin (cause
 *   `builders`); work beyond a full repair stays queued for the next damage. A siege does not stop them.
 * - **Mason's Kit** (`itemUse` of the kit, or `wallRepair {seg}`): a channel of kitChannelS within kitRangeM of the segment
 *   (either side), drawn with the item cast bar (`itemCast` / `itemCastEnd`); at its end one kit is taken and the
 *   segment gains kitPct (cause `kit`), then it goes on while kits last and the segment is damaged. Moving, acting, a
 *   skill, a warp, death or taking damage interrupts it; a kit leaving the bag cancels it.
 * - **`repairing`**: WallService.repairingOf is true while the builders worked on a segment in their last step or a kit
 *   channel runs on it (WallSegView.repairing: the client's scaffolding and hammers).
 * - GM `mason` (MASON_USAGE).
 */

/** How often the builders work (ms): 1 %/min arrives as 0.25 % every 15 s. */
export const BUILDER_STEP_MS = 15_000
/** The kit caster may drift this far before the channel counts as moved (as the return scroll). */
const CAST_MOVE_TOLERANCE_M = 0.3

export const MASON_USAGE = 'mason [status] | mason queue <seg|any> <pct> | mason clear <seg|all> | mason build [steps] | mason looters [spawn|clear]'

interface Channel {
  seg: string
  /** The bag slot the kit came from (completion prefers it). */
  bag: number
  startX: number
  startZ: number
  /** HP when last seen (a drop = damage). */
  hp: number
  castMs: number
  endsAt: number
}

const ok = (message: string, data?: unknown): GmResult => (data === undefined ? { ok: true, message } : { ok: true, message, data })
const gmFail = (message: string): GmResult => ({ ok: false, message })

export class WallRepair implements GameplayModule {
  readonly name = 'wallRepair'
  readonly handles: readonly GameplayRequest[] = ['wallDonate', 'wallRepair']
  private readonly channels = new Map<number, Channel>()
  /** Segments the builders worked on in their last step. */
  private building = new Set<string>()
  private nextBuild = 0
  /** Looters (siege/looters.ts) for the GM command; set by Gameplay. */
  looters: { gm(args: string[], now: number): GmResult; describe(): string } | null = null

  constructor(
    private readonly g: Gameplay,
    private readonly walls: WallService,
  ) {
    if (!walls.on) return
    const d = g.data
    const added = installSiegeContent({ items: d.items, shops: d.shops, drops: d.drops, npcs: d.npcs }, g.config.world, walls.live().kitPrice)
    const npc = d.npcs.find((n) => n.code === SIEGE_CODES.mason) ?? masonNpc(g.config.world)
    if (d.shops.has(SIEGE_CODES.shop)) d.npcShop.set(npc.code, SIEGE_CODES.shop)
    if (!d.npcModel.has(npc.code)) d.npcModel.set(npc.code, SIEGE_CODES.masonBase)
    addBaseNpc(d, npc, d.npcModel.get(npc.code))
    walls.repairingOf = (id) => this.repairing(id)
    g.itemUses.hooks.push((p, def, bag, _group, answer, now) => {
      if (!def.use?.masonKit) return false
      this.startKit(p, def, bag, null, answer, now)
      return true
    })
    this.refresh()
    g.config.log(`walls: repair on (Master Mason Ko${added.npc ? '' : ' (kept)'}, ${added.items} items, Stone Block drops ${added.drops ? 'added' : d.drops.has(SIEGE_CODES.blockMob) ? 'kept' : 'off (no Stone Ghost table)'})`)
  }

  get on(): boolean {
    return this.walls.on
  }

  /** Whether NPC `code` offers the `mason` service. */
  offers(code: string): boolean {
    return this.walls.on && code === SIEGE_CODES.mason
  }

  /** The admin panel changed a number: the kit's price follows; every client hears the new numbers. */
  refresh(): void {
    if (!this.walls.on) return
    const price = this.walls.live().kitPrice
    const kit = this.g.data.items.get(SIEGE_CODES.kit)
    if (kit && kit.price !== price) {
      kit.price = price
      kit.sellPrice = Math.floor(price / 4)
      this.g.shops.forgetGoods(SIEGE_CODES.mason)
    }
    this.walls.resend()
  }

  /** Work going on at a segment now (the builders' last step, or a kit channel). */
  repairing(id: string): boolean {
    if (this.building.has(id)) return true
    for (const c of this.channels.values()) if (c.seg === id) return true
    return false
  }

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (!this.walls.on) return answer(fail('not_found', 'The walls cannot be repaired on this server.'))
    if (msg.t === 'wallDonate') return this.donate(p, msg, answer, now)
    if (msg.t === 'wallRepair') return this.kitAt(p, msg.seg, answer, now)
    answer(fail('not_found'))
  }

  // ---- donations ---------------------------------------------------------------------------------------------------

  donate(p: Player, msg: Extract<GameplayMessage, { t: 'wallDonate' }>, answer: Answer, now: number): void {
    const npc = this.g.npcs.requireService(p, msg.npc, 'mason', now)
    if (!npc.ok) return answer(npc)
    const seg = msg.seg ?? null
    if (seg !== null && this.walls.stageOf(seg) === null) return answer(fail('not_found', 'There is no such wall segment.'))
    const gold = msg.gold ?? 0
    const blocks = msg.blocks ?? 0
    if (!(Number.isSafeInteger(gold) && gold >= 0 && Number.isSafeInteger(blocks) && blocks >= 0) || gold + blocks <= 0) return answer(fail('invalid_count'))
    const s = this.walls.live()
    const room = queueRoom(this.walls.queues(), seg, s)
    if (room <= 0) return answer(fail('invalid_count', seg ? `The builders have all the work ${wallName(seg)} can take for now.` : 'The builders have all the work they can take for now.'))
    const out: { plan?: ReturnType<typeof planDonation> } = {}
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      if (gold > d.gold) return fail('not_enough_gold')
      const have = countIn(d, SIEGE_CODES.block)
      if (blocks > have) return fail('invalid_count', have ? `You have only ${have} Stone Blocks.` : 'You have no Stone Blocks.')
      const plan = planDonation(gold, blocks, room, s)
      if (plan.ip <= 0) return fail('invalid_count', `The smallest donation is ${goldForIp(1, s)} gold.`)
      const taken = takeCount(d, SIEGE_CODES.block, plan.blocks)
      if (!taken.ok) return taken
      const g = addGold(d, -plan.gold)
      if (!g.ok) return g
      out.plan = plan
      return g
    })
    if (!result.ok || !out.plan) return answer(result.ok ? fail('invalid_count') : result)
    const plan = out.plan
    answer(true)
    this.g.afterInventory(p, draft)
    const shares = allocateDonation(this.walls.queues(), plan.ip, seg, s)
    for (const [id, ip] of shares) {
      this.walls.addQueued(id, ip, now, true)
      this.walls.note(id, 'donation', now, p.characterId, { queued: ip, gold: plan.gold, blocks: plan.blocks, by: p.name, anywhere: seg === null })
    }
    const paid = [plan.gold ? `${plan.gold.toLocaleString('en-US')} gold` : '', plan.blocks ? `${plan.blocks} Stone Block${plan.blocks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')
    const where = seg ? wallName(seg) : [...shares.keys()].join(', ')
    const short = plan.gold < gold || plan.blocks < blocks ? ' (only what the builders can use now was taken)' : ''
    p.send({ t: 'chat', channel: 'system', text: `Master Mason Ko takes your ${paid}: ${wallPct(plan.ip, s)} % of repair work for ${where}${short}.` })
    this.g.config.log(`walls: ${p.name} donated ${paid} -> ${[...shares].map(([id, ip]) => `${id} +${wallPct(ip, s)}%`).join(', ')}`)
  }

  /** GM: queues `ip` of free work on a segment or where it is needed. Returns the shares. */
  give(seg: string | null, ip: number, now: number): Map<string, number> {
    const s = this.walls.live()
    const shares = allocateDonation(this.walls.queues(), Math.min(ip, queueRoom(this.walls.queues(), seg, s)), seg, s)
    for (const [id, n] of shares) {
      this.walls.addQueued(id, n, now, true)
      this.walls.note(id, 'donation', now, null, { queued: n, gm: true })
    }
    return shares
  }

  // ---- builders ----------------------------------------------------------------------------------------------------

  /** One builders' step: every damaged segment with queued work gains up to the step's share. Returns the work done. */
  build(now: number): number {
    const s = this.walls.live()
    const step = builderStepIp(BUILDER_STEP_MS, s)
    const worked = new Set<string>()
    let total = 0
    if (step > 0) {
      for (const q of this.walls.queues()) {
        if (q.queued <= 0 || q.ip >= s.maxIp) continue
        const n = Math.min(q.queued, step, s.maxIp - q.ip)
        const c = this.walls.change(q.id, n, 'builders', now)
        if (!c) continue
        const done = c.after - c.before
        this.walls.addQueued(q.id, -done, now)
        total += done
        // still damaged with work left: the scaffolding stays up until the next step finds nothing to do
        worked.add(q.id)
      }
    }
    const before = this.building
    this.building = worked
    for (const id of new Set([...before, ...worked])) if (before.has(id) !== worked.has(id)) this.walls.touch(id)
    return total
  }

  // ---- the Mason's Kit -------------------------------------------------------------------------------------------

  /** `wallRepair {seg}`: the kit from the bag (the lowest slot holding one), at `seg`. */
  private kitAt(p: Player, seg: string, answer: Answer, now: number): void {
    if (!WALL_SEGMENT_ID.test(seg) || this.walls.stageOf(seg) === null) return answer(fail('not_found', 'There is no such wall segment.'))
    const bag = this.g.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === SIEGE_CODES.kit)
    const def = this.g.data.item(SIEGE_CODES.kit)
    if (bag < 0 || !def) return answer(fail('not_found', "You need a Mason's Kit."))
    this.startKit(p, def, bag, seg, answer, now)
  }

  /** Starts a kit channel at `seg` (null: the segment nearest the player within reach). */
  private startKit(p: Player, def: ItemDef, bag: number, seg: string | null, answer: Answer, now: number): void {
    const walls = this.walls.walls
    if (!walls) return answer(fail('not_usable'))
    if (p.dead) return answer(fail('dead'))
    const s = this.walls.live()
    const [x, , z] = this.g.world.positionAt(p, now)
    let id = seg
    if (id === null) {
      const near = nearestSegment(walls, x, z, s.kitRangeM)
      if (!near) return answer(fail('too_far', `Stand within ${s.kitRangeM} m of a damaged stretch of the town wall to use a Mason's Kit.`))
      id = near.seg.id
    } else {
      const g = walls.segments.find((x) => x.id === id)
      const side = g && walls.sides.find((x) => x.side === g.side)
      if (!g || !side) return answer(fail('not_found'))
      if (segmentDistance(side, g, x, z) > s.kitRangeM) return answer(fail('too_far', `Stand within ${s.kitRangeM} m of ${wallName(id)}.`))
    }
    if ((this.walls.ipOf(id) ?? s.maxIp) >= s.maxIp) return answer(fail('nothing_to_repair', `${wallName(id)} needs no repair.`))
    if (this.channels.has(p.id) || this.g.itemUses.casting(p) || this.g.itemUses.skillBusy(p, now)) return answer(fail('busy'))
    answer(true)
    p.action = null
    this.g.world.halt(p, now)
    this.begin(p, def, bag, id, now)
  }

  private begin(p: Player, def: ItemDef, bag: number, seg: string, now: number): void {
    const [x, , z] = this.g.world.positionAt(p, now)
    const castMs = Math.max(1000, Math.round(this.walls.live().kitChannelS * 1000))
    this.channels.set(p.id, { seg, bag, startX: x, startZ: z, hp: p.hp, castMs, endsAt: now + castMs })
    this.g.world.broadcastAbout(p, { t: 'itemCast', id: p.id, item: def.code, castMs })
    this.walls.touch(seg)
  }

  /** The kit channel of `p` (tests, GM). */
  channelOf(p: Player): { seg: string; endsAt: number } | null {
    const c = this.channels.get(p.id)
    return c ? { seg: c.seg, endsAt: c.endsAt } : null
  }

  /** Ends the channel of `p`, telling every viewer why. */
  cancel(p: Player, reason: 'cancelled' | 'interrupted'): void {
    const c = this.channels.get(p.id)
    if (!c) return
    this.channels.delete(p.id)
    this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: SIEGE_CODES.kit, reason })
    this.walls.touch(c.seg)
  }

  private complete(p: Player, c: Channel, now: number): void {
    this.channels.delete(p.id)
    const s = this.walls.live()
    if ((this.walls.ipOf(c.seg) ?? s.maxIp) >= s.maxIp) {
      // the builders (or someone else) finished it first: the kit is kept
      this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: SIEGE_CODES.kit, reason: 'cancelled' })
      this.walls.touch(c.seg)
      return
    }
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const at = d.bag[c.bag]?.code === SIEGE_CODES.kit ? c.bag : d.bag.findIndex((i) => i?.code === SIEGE_CODES.kit)
      return at < 0 ? fail('invalid_slot', 'the kit is gone') : takeFromBag(d, at, 1)
    })
    if (!result.ok) {
      this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: SIEGE_CODES.kit, reason: 'cancelled' })
      this.walls.touch(c.seg)
      return
    }
    this.walls.change(c.seg, kitIp(s), 'kit', now, { characterId: p.characterId, fx: 'repair' })
    this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: SIEGE_CODES.kit, reason: 'done' })
    this.g.afterInventory(p, draft)
    // on with the next kit while the wall needs it
    const def = this.g.data.item(SIEGE_CODES.kit)
    const next = this.g.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === SIEGE_CODES.kit)
    if (def && next >= 0 && !p.dead && (this.walls.ipOf(c.seg) ?? s.maxIp) < s.maxIp) this.begin(p, def, next, c.seg, now)
    else this.walls.touch(c.seg)
  }

  // ---- hooks ---------------------------------------------------------------------------------------------------------

  tick(now: number): void {
    if (!this.walls.on) return
    if (this.nextBuild === 0) this.nextBuild = now + BUILDER_STEP_MS
    if (now >= this.nextBuild) {
      this.nextBuild = now + BUILDER_STEP_MS
      this.build(now)
    }
  }

  tickPlayer(p: Player, now: number): void {
    const c = this.channels.get(p.id)
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
    const c = this.channels.get(p.id)
    if (c && !this.g.store.loadInventory(p.characterId).bag.some((i) => i?.code === SIEGE_CODES.kit)) this.cancel(p, 'cancelled')
  }

  forget(p: Player): void {
    const c = this.channels.get(p.id)
    this.channels.delete(p.id)
    if (c) this.walls.touch(c.seg)
  }

  // ---- GM `mason` --------------------------------------------------------------------------------------------------

  gm(args: string[], now: number): GmResult {
    if (!this.walls.on) return gmFail(`The walls are off on this server (${this.walls.problem || 'no walls.json'}).`)
    const a = args.map((x) => x.trim()).filter(Boolean)
    const verb = (a[0] ?? 'status').toLowerCase()
    const s = this.walls.live()
    const seg = (raw: string | undefined): string | null => {
      const id = (raw ?? '').toUpperCase()
      return WALL_SEGMENT_ID.test(id) && this.walls.stageOf(id) !== null ? id : null
    }
    if (verb === 'status') {
      const q = this.walls.queues().filter((x) => x.queued > 0 || this.repairing(x.id))
      const lines = q.map((x) => `${x.id} ${wallPct(x.ip, s)}%: queued ${wallPct(x.queued, s)}%${this.repairing(x.id) ? ', repairing' : ''}`)
      const kits = [...this.channels.entries()].map(([pid, c]) => `${this.g.world.players.get(pid)?.name ?? pid} at ${c.seg}`)
      return ok(
        `Repair: ${s.goldPerPct} gold or ${s.blocksPerPct} Stone Blocks per 1 %, builders ${s.builderPctPerMin} %/min, queue cap ${s.queueCapPct} %.\n` +
          `${lines.length ? lines.join('\n') : 'No queued work.'}${kits.length ? `\nKits: ${kits.join(', ')}` : ''}${this.looters ? `\n${this.looters.describe()}` : ''}`,
        { queues: this.walls.queues(), kits: kits.length },
      )
    }
    if (verb === 'queue') {
      const target = a[1]?.toLowerCase() === 'any' ? null : seg(a[1])
      const pct = Number(a[2])
      if ((target === null && a[1]?.toLowerCase() !== 'any') || !Number.isFinite(pct) || pct <= 0 || pct > 150) return gmFail('Usage: mason queue <seg|any> <pct> (1-150)')
      const shares = this.give(target, Math.round((pct / 100) * s.maxIp), now)
      if (shares.size === 0) return gmFail('The queue is full there.')
      return ok(`Queued (free): ${[...shares].map(([id, n]) => `${id} +${wallPct(n, s)}%`).join(', ')}.`)
    }
    if (verb === 'clear') {
      const ids = a[1]?.toLowerCase() === 'all' ? this.walls.queues().map((x) => x.id) : [seg(a[1])].filter((x): x is string => x !== null)
      if (!ids.length) return gmFail('Usage: mason clear <seg|all>')
      for (const id of ids) this.walls.addQueued(id, -this.walls.queuedOf(id), now, true)
      return ok(`Cleared the queued work of ${ids.length === 1 ? ids[0] : `${ids.length} segments`}.`)
    }
    if (verb === 'build') {
      const n = a[1] === undefined ? 1 : Number(a[1])
      if (!Number.isInteger(n) || n < 1 || n > 1000) return gmFail('Usage: mason build [steps 1-1000] (each step = 15 s of the builders)')
      let total = 0
      for (let i = 0; i < n; i++) total += this.build(now)
      return ok(`The builders worked ${n} step${n === 1 ? '' : 's'}: ${wallPct(total, s)} % of wall repaired.`)
    }
    if (verb === 'looters') return this.looters ? this.looters.gm(a.slice(1), now) : gmFail('No looters on this server.')
    return gmFail(`Usage: ${MASON_USAGE}`)
  }
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
