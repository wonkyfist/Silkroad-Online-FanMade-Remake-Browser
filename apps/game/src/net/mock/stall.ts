/**
 * Mock support of lane ST-C (stalls) for ?mock=1 (docs/SYSTEMS_SOCIAL.md §4). Optional and first to cut
 * (docs/WAVE_PLAN2.md §6.9): the real-server e2e tests are the truth. Only that lane edits this file. Import
 * MockServer types with `import type`.
 *
 * Enough of apps/server/src/social/stall.ts to try both sides offline:
 * - your own stall: stallCreate / stallItem / stallItemRemove / stallText / stallOpen / stallClose on your bag, with
 *   the sign for everyone (`entityUpdate {stall}`); while it is open a bot buys your first listing about every 12 s
 *   (the owner's `inventoryUpdate`, `statsDelta {gold}`, `stallSold`, new `stall`); moves are dropped while stalling;
 * - a bot's stall ("MeiHua" stops wandering and sells potions and a +3 weapon from endless stock): stallVisit (10 m),
 *   stallLeave, stallBuy (the S1 guard: code, count, plus, durability and price must match), leaving at 15 m;
 * - stall chat to the owner and the visitors.
 * No town / NPC-clearance checks (the mock world is a plane) and no persistence: entering the world starts clean.
 */
import {
  MAX_GOLD,
  STALL_BREAK_RANGE,
  STALL_PRICE_MAX,
  STALL_RANGE,
  STALL_SLOTS,
  STALL_VISITORS_MAX,
  type ClientMessage,
  type GameplayRequest,
  type Inventory,
  type ItemStack,
  type StallListing,
  type StallView,
} from '@sro/shared'
import { t } from '../../i18n/index.ts'
import type { MockConn, MockContext, MockEntity, MockExtension } from '../mock.ts'
import { addToBag } from '../mock-rules.ts'

interface Listing {
  stack: ItemStack
  price: number
  /** The owner's bag slot (player stalls); undefined for a bot's endless stock. */
  bag?: number
}

interface MockStall {
  owner: number
  name: string
  title: string
  greeting: string
  state: 'modify' | 'open'
  items: (Listing | null)[]
  visitors: Set<MockConn>
  /** The owner's connection (null for a bot). */
  conn: MockConn | null
  /** Mock ms of the next bot purchase (player stalls, while open). */
  nextSale: number
}

interface World {
  stalls: Map<number, MockStall>
  /** Visitor connection -> owner entity id. */
  visiting: Map<MockConn, number>
}

/** A bot buys from an open player stall this often (ms). */
export const MOCK_SALE_EVERY_MS = 12_000
/** The bot that runs the demo stall. */
const BOT_OWNER = 'MeiHua'

const worlds = new WeakMap<MockContext, World>()
function worldOf(ctx: MockContext): World {
  let w = worlds.get(ctx)
  if (!w) worlds.set(ctx, (w = { stalls: new Map(), visiting: new Map() }))
  return w
}

const inventoryOf = (e: MockEntity): Inventory | null => e.player?.prog.inventory ?? null

function viewFor(s: MockStall, forOwner: boolean): StallView {
  return {
    owner: s.owner,
    name: s.name,
    title: s.title,
    greeting: s.greeting,
    state: s.state,
    items: s.items.map(l => {
      if (!l) return null
      const out: StallListing = { stack: { ...l.stack }, price: l.price }
      if (forOwner && l.bag !== undefined) out.bag = l.bag
      return out
    }),
    visitors: s.visitors.size,
  }
}

/** The stall to its owner and every visitor. */
function publish(ctx: MockContext, s: MockStall): void {
  if (s.conn) ctx.send(s.conn, { t: 'stall', stall: viewFor(s, true) })
  for (const c of s.visitors) ctx.send(c, { t: 'stall', stall: viewFor(s, false) })
}

function close(ctx: MockContext, w: World, s: MockStall, reason: 'closed' | 'left'): void {
  w.stalls.delete(s.owner)
  for (const c of s.visitors) {
    w.visiting.delete(c)
    ctx.send(c, { t: 'stall', stall: null, reason })
  }
  s.visitors.clear()
  if (s.conn) ctx.send(s.conn, { t: 'stall', stall: null, reason })
  const e = ctx.entity(s.owner)
  if (e) delete e.state.stall
  ctx.broadcast({ t: 'entityUpdate', id: s.owner, stall: '' })
}

function leave(ctx: MockContext, w: World, conn: MockConn, reason?: 'too_far' | 'left'): void {
  const owner = w.visiting.get(conn)
  if (owner === undefined) return
  w.visiting.delete(conn)
  const s = w.stalls.get(owner)
  if (s) {
    s.visitors.delete(conn)
    publish(ctx, s)
  }
  ctx.send(conn, reason ? { t: 'stall', stall: null, reason } : { t: 'stall', stall: null })
}

/** Starts the bot's demo stall once per mock world. */
function ensureBotStall(ctx: MockContext, w: World): void {
  if ([...w.stalls.values()].some(s => !s.conn)) return
  const bot = [...ctx.entities()].find(e => e.bot && e.state.name === BOT_OWNER) ?? [...ctx.entities()].find(e => e.bot)
  if (!bot) return
  bot.nextThink = Infinity
  const items = ctx.content.items
  const weapon = [...items.values()].find(d => /^ITEM_CH_(SWORD|BLADE|SPEAR)_0[12]_A$/.test(d.code) && d.canTrade !== false)
  const stock: Listing[] = []
  if (items.has('ITEM_ETC_HP_POTION_01')) stock.push({ stack: { code: 'ITEM_ETC_HP_POTION_01', count: 50 }, price: 180 })
  if (items.has('ITEM_ETC_MP_POTION_01')) stock.push({ stack: { code: 'ITEM_ETC_MP_POTION_01', count: 30 }, price: 120 })
  if (weapon) stock.push({ stack: { code: weapon.code, count: 1, plus: 3 }, price: 25_000 })
  if (items.has('ITEM_ETC_SCROLL_RETURN_01')) stock.push({ stack: { code: 'ITEM_ETC_SCROLL_RETURN_01', count: 5 }, price: 1_500 })
  const name = bot.state.name
  const s: MockStall = {
    owner: bot.state.id,
    name,
    title: t('stall.defaultTitle', { name }),
    greeting: t('stall.defaultGreeting', { name }),
    state: 'open',
    items: Array.from({ length: STALL_SLOTS }, (_, i) => stock[i] ?? null),
    visitors: new Set(),
    conn: null,
    nextSale: Infinity,
  }
  w.stalls.set(s.owner, s)
  bot.state.stall = s.title
  ctx.broadcast({ t: 'entityUpdate', id: s.owner, stall: s.title })
}

function sendBag(ctx: MockContext, conn: MockConn, inv: Inventory, slots: Iterable<number>): void {
  ctx.send(conn, { t: 'inventoryUpdate', bag: [...slots].map(slot => ({ slot, item: inv.bag[slot] ? { ...inv.bag[slot]! } : null })), gold: inv.gold })
  ctx.send(conn, { t: 'statsDelta', stats: { gold: inv.gold } })
}

const STALL_TYPES: ReadonlySet<ClientMessage['t']> = new Set(['stallCreate', 'stallItem', 'stallItemRemove', 'stallText', 'stallOpen', 'stallClose', 'stallVisit', 'stallLeave', 'stallBuy'])

export const stallMock: MockExtension = {
  enter(ctx, conn) {
    const w = worldOf(ctx)
    // A new visit of the world starts without a stall or a visit of this connection.
    const self = ctx.selfOf(conn)
    for (const s of [...w.stalls.values()]) if (s.conn === conn || (self && s.owner === self.state.id)) close(ctx, w, s, 'left')
    w.visiting.delete(conn)
    ensureBotStall(ctx, w)
  },

  handle(ctx, conn, msg) {
    const w = worldOf(ctx)
    const self = ctx.selfOf(conn)
    if (!self) return false
    const id = self.state.id
    const own = w.stalls.get(id)
    if (msg.t === 'moveTo' && own) return true
    if (msg.t === 'chat' && msg.channel === 'stall') {
      const s = own ?? w.stalls.get(w.visiting.get(conn) ?? -1)
      if (!s) return false
      const line = { t: 'chat' as const, channel: 'stall' as const, fromId: id, from: self.state.name, text: msg.text.trim() }
      if (s.conn) ctx.send(s.conn, line)
      for (const c of s.visitors) ctx.send(c, line)
      return true
    }
    if (!STALL_TYPES.has(msg.t)) return false
    const re = msg.t as GameplayRequest
    const ok = () => ctx.result(conn, re, true)
    const no = (reason: Parameters<MockContext['result']>[3], message?: string) => {
      ctx.result(conn, re, false, reason, message)
      return true
    }
    const inv = inventoryOf(self)
    switch (msg.t) {
      case 'stallCreate': {
        if (self.player?.prog.dead) return no('dead')
        if (own) return no('stalling')
        if (w.visiting.has(conn)) leave(ctx, w, conn)
        const name = self.state.name
        const s: MockStall = {
          owner: id,
          name,
          title: msg.title.trim() || t('stall.defaultTitle', { name }),
          greeting: t('stall.defaultGreeting', { name }),
          state: 'modify',
          items: Array.from({ length: STALL_SLOTS }, () => null),
          visitors: new Set(),
          conn,
          nextSale: Infinity,
        }
        w.stalls.set(id, s)
        self.state.stall = s.title
        ok()
        publish(ctx, s)
        ctx.broadcast({ t: 'entityUpdate', id, stall: s.title })
        return true
      }
      case 'stallItem': {
        if (!own || !inv) return no('not_found')
        if (own.state !== 'modify') return no('stalling', t('stall.modifyFirst'))
        const stack = inv.bag[msg.bag]
        if (!stack) return no('invalid_slot')
        if (own.items.some((l, i) => l && i !== msg.slot && l.bag === msg.bag)) return no('invalid_slot')
        if (msg.count > stack.count) return no('invalid_count')
        if (ctx.content.items.get(stack.code)?.canTrade === false) return no('not_usable')
        if (msg.price < 1 || msg.price > STALL_PRICE_MAX) return no('invalid_count', t('stall.priceRange'))
        own.items[msg.slot] = { stack: { ...stack, count: msg.count }, price: msg.price, bag: msg.bag }
        ok()
        publish(ctx, own)
        return true
      }
      case 'stallItemRemove':
        if (!own) return no('not_found')
        if (own.state !== 'modify') return no('stalling', t('stall.modifyFirst'))
        own.items[msg.slot] = null
        ok()
        publish(ctx, own)
        return true
      case 'stallText':
        if (!own) return no('not_found')
        if (msg.title !== undefined) own.title = msg.title.trim() || t('stall.defaultTitle', { name: own.name })
        if (msg.greeting !== undefined) own.greeting = msg.greeting.trim()
        ok()
        publish(ctx, own)
        if (msg.title !== undefined) {
          self.state.stall = own.title
          ctx.broadcast({ t: 'entityUpdate', id, stall: own.title })
        }
        return true
      case 'stallOpen':
        if (!own) return no('not_found')
        if (msg.open && !own.items.some(Boolean)) return no('not_complete', t('stall.nothing'))
        own.state = msg.open ? 'open' : 'modify'
        own.nextSale = msg.open ? ctx.now() + MOCK_SALE_EVERY_MS : Infinity
        ok()
        publish(ctx, own)
        return true
      case 'stallClose':
        if (!own) return no('not_found')
        ok()
        close(ctx, w, own, 'closed')
        return true
      case 'stallVisit': {
        const s = w.stalls.get(msg.owner)
        const target = ctx.entity(msg.owner)
        if (!s || !target) return no('not_found')
        if (msg.owner === id) return no('invalid_target')
        if (ctx.dist(self, target) > STALL_RANGE) return no('too_far')
        if (w.visiting.get(conn) === msg.owner) {
          ok()
          ctx.send(conn, { t: 'stall', stall: viewFor(s, false) })
          return true
        }
        if (s.visitors.size >= STALL_VISITORS_MAX) return no('stall_full')
        if (w.visiting.has(conn)) leave(ctx, w, conn)
        s.visitors.add(conn)
        w.visiting.set(conn, msg.owner)
        ok()
        publish(ctx, s)
        return true
      }
      case 'stallLeave':
        ok()
        leave(ctx, w, conn)
        return true
      case 'stallBuy': {
        const s = w.stalls.get(msg.owner)
        const target = ctx.entity(msg.owner)
        if (!s || !target) return no('not_found')
        if (msg.owner === id) return no('invalid_target')
        if (s.state !== 'open') return no('stall_closed')
        const l = s.items[msg.slot]
        if (!l) return no('stall_changed')
        const st = l.stack
        const same = st.code === msg.code && st.count === msg.count && (st.plus ?? 0) === (msg.plus ?? 0) && st.durability === msg.durability
        if (!same || l.price !== msg.price) return no('stall_changed')
        if (ctx.dist(self, target) > STALL_RANGE) return no('too_far')
        if (!inv) return no('not_found')
        if (inv.gold < l.price) return no('not_enough_gold')
        const added = addToBag(inv, ctx.content.items.get(l.stack.code), l.stack.code, l.stack.count, l.stack.plus)
        if (!added) return no('inventory_full')
        inv.gold -= l.price
        ok()
        sendBag(ctx, conn, inv, added.map(u => u.slot))
        // The bot's stock is endless; a player stall would lose the listing here.
        if (s.conn) s.items[msg.slot] = null
        publish(ctx, s)
        return true
      }
    }
    return false
  },

  tick(ctx, now) {
    const w = worlds.get(ctx)
    if (!w) return
    // Visitors who walked away leave (STALL_BREAK_RANGE); gone owners close.
    for (const [conn, owner] of [...w.visiting]) {
      const me = ctx.selfOf(conn)
      const o = ctx.entity(owner)
      if (!me || !o) leave(ctx, w, conn, 'left')
      else if (ctx.dist(me, o) > STALL_BREAK_RANGE) leave(ctx, w, conn, 'too_far')
    }
    for (const s of [...w.stalls.values()]) {
      if (!s.conn) continue
      const e = ctx.entity(s.owner)
      if (!e) {
        close(ctx, w, s, 'left')
        continue
      }
      if (e.player?.prog.dead) {
        close(ctx, w, s, 'closed')
        continue
      }
      // A bot buys the first listing of an open player stall now and then (the owner's side of a sale).
      if (s.state === 'open' && now >= s.nextSale) {
        s.nextSale = now + MOCK_SALE_EVERY_MS
        const slot = s.items.findIndex(Boolean)
        const l = slot >= 0 ? s.items[slot]! : null
        const inv = inventoryOf(e)
        if (!l || !inv || l.bag === undefined) continue
        const have = inv.bag[l.bag]
        if (!have || have.code !== l.stack.code || have.count < l.stack.count || inv.gold + l.price > MAX_GOLD) continue
        have.count -= l.stack.count
        if (have.count <= 0) inv.bag[l.bag] = null
        inv.gold += l.price
        s.items[slot] = null
        const buyer = [...ctx.entities()].find(b => b.bot)?.state.name ?? 'WeiChen'
        sendBag(ctx, s.conn, inv, [l.bag])
        ctx.send(s.conn, { t: 'stallSold', slot, buyer, code: l.stack.code, count: l.stack.count, price: l.price })
        const name = ctx.content.items.get(l.stack.code)?.name ?? l.stack.code
        ctx.send(s.conn, { t: 'chat', channel: 'system', text: `${buyer} bought item ${l.stack.count > 1 ? `${name} x${l.stack.count}` : name}.` })
        publish(ctx, s)
      }
    }
  },
}
