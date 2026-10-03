/**
 * Mock support of lane TR-C (player trade) for ?mock=1 (docs/SYSTEMS_SOCIAL.md §3, §9.1). Optional and first to cut
 * (docs/WAVE_PLAN2.md §6.9): the real-server e2e tests are the truth. Only that lane edits this file. Import
 * MockServer types with `import type`.
 *
 * Exchanges with the mock world's bots, loosely after §3: a request to a bot within TRADE_RANGE is accepted after a
 * moment; the bot offers a little gold and a potion, locks a moment after you lock and presses Exchange a moment after
 * you do; then your offer leaves the bag and the bot's arrives. The rules the window shows are the server's: one
 * offer per bag slot, the anti-bait unlock, `not_complete`, empty trades refused, moving or fighting cancels, and bag
 * requests are refused with `trading` while the window is open. Other players are not simulated (the real server
 * is the truth for player-to-player trades).
 */
import {
  TRADE_BREAK_RANGE,
  TRADE_RANGE,
  TRADE_REQUESTS,
  TRADE_SLOTS,
  type ClientMessage,
  type GameplayRequest,
  type ItemStack,
  type TradeEndReason,
  type TradeSide,
  type TradeState,
} from '@sro/shared'
import type { MockConn, MockContext, MockEntity, MockExtension } from '../mock.ts'
import { addToBag } from '../mock-rules.ts'

/** How long the bot "thinks" before each step (mock ms). */
const BOT_DELAY_MS = 900
const BOT_GOLD = 250
const BOT_ITEM: ItemStack = { code: 'ITEM_ETC_HP_POTION_01', count: 5 }

interface Offer {
  bag: number
  stack: ItemStack
}

interface Session {
  conn: MockConn
  bot: number
  /** Before the bot accepts the request: the time it answers. */
  pendingUntil: number | null
  mine: (Offer | null)[]
  gold: number
  locked: boolean
  accepted: boolean
  botItems: (ItemStack | null)[]
  botGold: number
  botLocked: boolean
  botAccepted: boolean
  /** The bot's next step (lock / accept) is due at this mock time. */
  botStepAt: number | null
}

const sessions = new Map<MockConn, Session>()

/** Requests that change the bag or gold: refused while an exchange is open (the gate of §2.3, loosely). */
const GATED: ReadonlySet<ClientMessage['t']> = new Set(['itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemUse', 'itemDrop', 'shopBuy', 'shopSell', 'pickup'])
/** Requests that cancel the exchange and then run as usual. */
const CANCELS: ReadonlySet<ClientMessage['t']> = new Set(['moveTo', 'attack', 'useSkill', 'npcTalk'])
const OWN: ReadonlySet<string> = new Set(TRADE_REQUESTS)

const emptySlots = <T>(): (T | null)[] => Array.from({ length: TRADE_SLOTS }, () => null)

function view(ctx: MockContext, s: Session): TradeState {
  const bot = ctx.entity(s.bot)
  const mine: TradeSide = { items: s.mine.map(o => (o ? { stack: { ...o.stack }, bag: o.bag } : null)), gold: s.gold, locked: s.locked, accepted: s.accepted }
  const theirs: TradeSide = { items: s.botItems.map(i => (i ? { stack: { ...i } } : null)), gold: s.botGold, locked: s.botLocked, accepted: s.botAccepted }
  return { partner: s.bot, name: bot?.state.name ?? '?', level: bot?.state.level ?? 1, mine, theirs }
}

function push(ctx: MockContext, s: Session): void {
  ctx.send(s.conn, { t: 'trade', trade: view(ctx, s) })
}

function finish(ctx: MockContext, s: Session, reason: TradeEndReason, name?: string, message?: string): void {
  sessions.delete(s.conn)
  ctx.send(s.conn, { t: 'tradeEnd', reason, ...(name ? { name } : {}), ...(message ? { message } : {}) })
}

/** Your change unlocks the bot's side (the anti-bait rule); the bot locks again a moment later if you are locked. */
function changed(ctx: MockContext, s: Session): void {
  s.botLocked = false
  s.botAccepted = false
  s.botStepAt = null
  push(ctx, s)
}

function commit(ctx: MockContext, s: Session, self: MockEntity): void {
  const inv = self.player!.prog.inventory
  const botName = ctx.entity(s.bot)?.state.name
  // Snapshot check: every offered stack must still be there as offered.
  for (const o of s.mine) {
    if (!o) continue
    const now = inv.bag[o.bag]
    if (!now || now.code !== o.stack.code || now.count < o.stack.count || (now.plus ?? 0) !== (o.stack.plus ?? 0)) return finish(ctx, s, 'failed', undefined, 'An item in the exchange changed.')
  }
  if (inv.gold < s.gold) return finish(ctx, s, 'failed', undefined, 'Not enough gold.')
  const before = inv.bag.map(x => (x ? { ...x } : null))
  const touched = new Set<number>()
  for (const o of s.mine) {
    if (!o) continue
    const slot = inv.bag[o.bag]!
    slot.count -= o.stack.count
    if (slot.count <= 0) inv.bag[o.bag] = null
    touched.add(o.bag)
  }
  for (const item of s.botItems) {
    if (!item) continue
    const got = addToBag(inv, ctx.content.items.get(item.code), item.code, item.count, item.plus)
    if (!got) {
      inv.bag = before
      return finish(ctx, s, 'failed', undefined, 'Your inventory is full.')
    }
    for (const u of got) touched.add(u.slot)
  }
  inv.gold = inv.gold - s.gold + s.botGold
  const slots = [...touched].sort((a, b) => a - b)
  ctx.send(s.conn, { t: 'inventoryUpdate', bag: slots.map(slot => ({ slot, item: inv.bag[slot] ? { ...inv.bag[slot]! } : null })), gold: inv.gold })
  ctx.send(s.conn, { t: 'statsDelta', stats: { gold: inv.gold } })
  finish(ctx, s, 'done', botName)
}

export const tradeMock: MockExtension = {
  handle(ctx, conn, msg): boolean {
    const self = ctx.selfOf(conn)
    const inv = self?.player?.prog.inventory
    if (!self || !inv) return false
    const s = sessions.get(conn)
    const open = s && s.pendingUntil === null ? s : null
    if (open && GATED.has(msg.t)) {
      ctx.result(conn, msg.t as GameplayRequest, false, 'trading', 'Cannot do that during an exchange.')
      return true
    }
    if (s && CANCELS.has(msg.t)) {
      finish(ctx, s, s.pendingUntil === null ? 'moved' : 'cancelled')
      return false
    }
    if (!OWN.has(msg.t)) return false
    const re = msg.t as GameplayRequest
    const no = (reason: Parameters<MockContext['result']>[3], message?: string) => {
      ctx.result(conn, re, false, reason, message)
      return true
    }
    const ok = () => ctx.result(conn, re, true)

    switch (msg.t) {
      case 'tradeRequest': {
        if (s) return no('trading', 'You are already exchanging.')
        const bot = ctx.entity(msg.target)
        if (!bot || bot === self) return no(bot ? 'invalid_target' : 'not_found')
        if (bot.state.kind !== 'player') return no('invalid_target')
        if (!bot.bot) return no('not_implemented', 'The mock trades with its bots only.')
        if (bot.state.state === 'dead') return no('invalid_target', `${bot.state.name} is dead.`)
        if (ctx.dist(self, bot) > TRADE_RANGE) return no('too_far')
        sessions.set(conn, {
          conn, bot: bot.state.id, pendingUntil: ctx.now() + BOT_DELAY_MS * 1.5, mine: emptySlots(), gold: 0, locked: false, accepted: false,
          botItems: emptySlots(), botGold: 0, botLocked: false, botAccepted: false, botStepAt: null,
        })
        ok()
        return true
      }
      case 'tradeRespond':
        return no('no_invite')
      case 'tradeCancel':
        if (!s) return no('not_found')
        ok()
        finish(ctx, s, 'cancelled', self.state.name)
        return true
    }
    if (!open) return no('not_found', 'You are not exchanging.')
    switch (msg.t) {
      case 'tradeOffer': {
        if (open.locked) return no('trading', 'Your offer is locked.')
        const stack = inv.bag[msg.bag]
        if (!stack || open.mine.some(o => o?.bag === msg.bag)) return no('invalid_slot')
        const count = msg.count ?? stack.count
        if (count < 1 || count > stack.count) return no('invalid_count')
        if (ctx.content.items.get(stack.code)?.canTrade === false) return no('not_usable', 'The selected item cannot be traded.')
        const free = open.mine.indexOf(null)
        if (free < 0) return no('inventory_full', 'Cannot add the selected item because the exchange window is full.')
        open.mine[free] = { bag: msg.bag, stack: { ...stack, count } }
        ok()
        changed(ctx, open)
        return true
      }
      case 'tradeTake':
        if (open.locked) return no('trading', 'Your offer is locked.')
        if (!open.mine[msg.slot]) return no('invalid_slot')
        open.mine[msg.slot] = null
        ok()
        changed(ctx, open)
        return true
      case 'tradeGold':
        if (open.locked) return no('trading', 'Your offer is locked.')
        if (msg.amount > inv.gold) return no('not_enough_gold')
        open.gold = msg.amount
        ok()
        changed(ctx, open)
        return true
      case 'tradeLock':
        if (open.locked) return no('trading', 'Already locked.')
        open.locked = true
        open.botStepAt = open.botLocked ? null : ctx.now() + BOT_DELAY_MS
        ok()
        push(ctx, open)
        return true
      case 'tradeAccept': {
        if (!open.locked || !open.botLocked) return no('not_complete', 'Both sides must confirm first.')
        const empty = open.gold === 0 && open.botGold === 0 && open.mine.every(o => !o) && open.botItems.every(i => !i)
        if (empty) return no('not_usable', 'There is nothing to trade.')
        open.accepted = true
        open.botStepAt = ctx.now() + BOT_DELAY_MS
        ok()
        push(ctx, open)
        return true
      }
    }
    return false
  },

  tick(ctx, now) {
    for (const s of [...sessions.values()]) {
      const self = ctx.selfOf(s.conn)
      const bot = ctx.entity(s.bot)
      if (!self || !bot) {
        finish(ctx, s, 'left')
        continue
      }
      if (s.pendingUntil !== null) {
        if (now < s.pendingUntil) continue
        s.pendingUntil = null
        s.botItems[0] = { ...BOT_ITEM }
        s.botGold = BOT_GOLD
        push(ctx, s)
        continue
      }
      if (ctx.dist(self, bot) > TRADE_BREAK_RANGE) {
        finish(ctx, s, 'too_far')
        continue
      }
      if (s.botStepAt === null || now < s.botStepAt) continue
      s.botStepAt = null
      if (s.locked && !s.botLocked) {
        s.botLocked = true
        push(ctx, s)
      } else if (s.accepted && s.botLocked && !s.botAccepted) {
        s.botAccepted = true
        commit(ctx, s, self)
      }
    }
  },

  enter(_ctx, conn) {
    sessions.delete(conn)
  },
}
