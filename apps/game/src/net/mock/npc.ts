/**
 * Mock support of lane NPC-C (NPC dialog, shops, storage, item casts) for ?mock=1 (docs/WAVE_PLAN.md §3.3). Optional and first to cut: the
 * real-server e2e tests are the truth. Only that lane edits this file. Import MockServer types with `import type`.
 *
 * Mirrors docs/SHOPS.md loosely: npcTalk opens the dialog when within NPC_INTERACT_RANGE (the mock does not walk
 * the player there), walking away / dying closes it, sales feed a 5-entry buyback list, the mock merchant also keeps
 * an account storage (in memory until the page reloads, no fee), return scrolls cast with itemCast/itemCastEnd and
 * are consumed at the end, and potions report their cooldown with itemCooldown. Shop buy/sell stay the MockServer's.
 */
import {
  BUYBACK_SLOTS,
  DEFAULT_LEVEL_CAP,
  GUILD_MANAGER_NPCS,
  MAX_GOLD,
  NPC_INTERACT_RANGE,
  STORAGE_SIZE_DEFAULT,
  type ItemDef,
  type ItemStack,
  type NpcService,
  type ServerMessage,
  type StorageSlotUpdate,
} from '@sro/shared'
import { shopFor } from '../../hud/shop-logic.ts'
import type { MockConn, MockContext, MockEntity, MockExtension } from '../mock.ts'
import { addToBag } from '../mock-rules.ts'

interface StoredChest {
  size: number
  slots: (ItemStack | null)[]
  gold: number
}

interface ConnState {
  /** NPC entity of the open dialog. */
  talk: number | null
  cast: { item: string; bag: number; endsAt: number; x: number; z: number } | null
  buyback: { item: ItemStack; price: number }[]
}

const states = new WeakMap<MockConn, ConnState>()
const active = new Set<MockConn>()
/** Account storage by account name (page lifetime). */
const chests = new Map<string, StoredChest>()

function stateOf(conn: MockConn): ConnState {
  let s = states.get(conn)
  if (!s) {
    s = { talk: null, cast: null, buyback: [] }
    states.set(conn, s)
  }
  active.add(conn)
  return s
}

function chestOf(conn: MockConn): StoredChest {
  const key = conn.account ?? '?'
  let c = chests.get(key)
  if (!c) {
    c = { size: STORAGE_SIZE_DEFAULT, slots: Array.from({ length: STORAGE_SIZE_DEFAULT }, () => null), gold: 0 }
    chests.set(key, c)
  }
  return c
}

const copy = (s: ItemStack | null): ItemStack | null => (s ? { ...s } : null)

/** The services the mock offers at `npc`: a shop from the content tables; storage at storage keepers and at the mock merchant. */
function servicesOf(ctx: MockContext, npc: MockEntity): NpcService[] {
  const code = npc.npc!.code
  const out: NpcService[] = []
  const shop = shopFor(code, ctx.content.npcs, ctx.content.shops)
  if (shop?.tabs.some(tab => tab.items.some(i => (ctx.content.items.get(i)?.reqLevel ?? 0) <= DEFAULT_LEVEL_CAP))) out.push('shop')
  const def = ctx.content.npcs.get(code)
  if (def?.roles?.includes('storage') || code === MOCK_STORAGE_NPC) out.push('storage')
  // Wave 8 (as the server's npc.ts): the Guild Manager runs guilds (I8, GU-C's request; net/mock/guild.ts answers).
  // 'repair' stays server-only: the mock has no repair handler.
  if (GUILD_MANAGER_NPCS.includes(code)) out.push('guild')
  return out
}

/** The mock world's one merchant also keeps the storage, so the storage window can be tried offline. */
const MOCK_STORAGE_NPC = 'NPC_CH_POTION'

function position(ctx: MockContext, e: MockEntity): [number, number] {
  const p = ctx.snapshot(e).pos
  return [p[0], p[2]]
}

function mergeable(a: ItemStack, code: string, def: ItemDef | undefined): boolean {
  return (def?.maxStack ?? 1) > 1 && a.code === code && !a.plus && a.durability === undefined
}

export const npcMock: MockExtension = {
  handle(ctx, conn, msg): boolean {
    const self = ctx.selfOf(conn)
    const ps = self?.player
    if (!self || !ps) return false
    const st = stateOf(conn)
    const inv = ps.prog.inventory
    const no = (re: Parameters<MockContext['result']>[1], reason: Parameters<MockContext['result']>[3], message?: string) => {
      ctx.result(conn, re, false, reason, message)
      return true
    }
    const npcIn = (id: number, service?: NpcService): MockEntity | 'not_found' | 'too_far' => {
      const n = ctx.entity(id)
      if (!n?.npc) return 'not_found'
      if (service && !servicesOf(ctx, n).includes(service)) return 'not_found'
      if (ctx.dist(self, n) > NPC_INTERACT_RANGE) return 'too_far'
      return n
    }
    const invUpdate = (slots: number[], withGold = false) => {
      const m: Extract<ServerMessage, { t: 'inventoryUpdate' }> = { t: 'inventoryUpdate', bag: slots.map(slot => ({ slot, item: copy(inv.bag[slot] ?? null) })) }
      if (withGold) m.gold = inv.gold
      ctx.send(conn, m)
      if (withGold) ctx.send(conn, { t: 'statsDelta', stats: { gold: inv.gold } })
    }
    const sendBuyback = () => ctx.send(conn, { t: 'buyback', entries: st.buyback.map(e => ({ item: { ...e.item }, price: e.price })) })

    // Anything that starts another action interrupts a return cast (docs/WAVE_PLAN.md decision 9).
    if (st.cast && (msg.t === 'moveTo' || msg.t === 'attack' || msg.t === 'pickup' || msg.t === 'npcTalk' || msg.t === 'useSkill')) endCast(ctx, conn, st, 'interrupted')
    if (st.cast && msg.t === 'stopAction') endCast(ctx, conn, st, 'cancelled')

    switch (msg.t) {
      case 'npcTalk': {
        if (ps.prog.dead) return no('npcTalk', 'dead')
        const n = npcIn(msg.npc)
        if (typeof n === 'string') return no('npcTalk', n, n === 'too_far' ? 'Walk closer: the mock does not walk you there.' : undefined)
        ctx.result(conn, 'npcTalk', true)
        if (st.talk !== null && st.talk !== msg.npc) ctx.send(conn, { t: 'npcDialogClose', npc: st.talk, reason: 'closed' })
        st.talk = msg.npc
        const services = servicesOf(ctx, n)
        ctx.send(conn, { t: 'npcDialog', npc: msg.npc, code: n.npc!.code, services })
        if (services.includes('shop')) sendBuyback()
        return true
      }
      case 'npcClose':
        st.talk = null
        ctx.result(conn, 'npcClose', true)
        return true
      case 'shopSell': {
        // The MockServer sells; this only records the sale for buyback (same checks, so it matches its answer).
        const n = npcIn(msg.npc)
        const stack = inv.bag[msg.bag]
        const def = stack ? ctx.content.items.get(stack.code) : undefined
        const count = msg.count ?? stack?.count ?? 0
        if (typeof n === 'string' || !stack || def?.canSell === false || count > stack.count) return false
        st.buyback.push({ item: { ...stack, count }, price: (def?.sellPrice ?? 0) * count })
        while (st.buyback.length > BUYBACK_SLOTS) st.buyback.shift()
        queueMicrotask(sendBuyback)
        return false
      }
      case 'shopBuyback': {
        const n = npcIn(msg.npc, 'shop')
        if (typeof n === 'string') return no('shopBuyback', n)
        const e = st.buyback[msg.index]
        if (!e || (msg.code !== undefined && e.item.code !== msg.code)) return no('shopBuyback', 'not_found')
        if (inv.gold < e.price) return no('shopBuyback', 'not_enough_gold')
        const bag = addToBag(inv, ctx.content.items.get(e.item.code), e.item.code, e.item.count, e.item.plus)
        if (!bag) return no('shopBuyback', 'inventory_full')
        st.buyback.splice(msg.index, 1)
        inv.gold -= e.price
        ctx.result(conn, 'shopBuyback', true)
        ctx.send(conn, { t: 'inventoryUpdate', bag, gold: inv.gold })
        ctx.send(conn, { t: 'statsDelta', stats: { gold: inv.gold } })
        sendBuyback()
        return true
      }
      case 'storageOpen': {
        const n = npcIn(msg.npc, 'storage')
        if (typeof n === 'string') return no('storageOpen', n)
        const c = chestOf(conn)
        ctx.result(conn, 'storageOpen', true)
        ctx.send(conn, { t: 'storage', storage: { size: c.size, slots: c.slots.map(copy), gold: c.gold } })
        return true
      }
      case 'storageDeposit': {
        const n = npcIn(msg.npc, 'storage')
        if (typeof n === 'string') return no('storageDeposit', n)
        if (ps.prog.dead) return no('storageDeposit', 'dead')
        const c = chestOf(conn)
        const stack = inv.bag[msg.bag]
        if (!stack) return no('storageDeposit', 'invalid_slot')
        const count = msg.count ?? stack.count
        if (count > stack.count) return no('storageDeposit', 'invalid_count')
        const def = ctx.content.items.get(stack.code)
        if (def?.canStore === false || def?.category === 'quest') return no('storageDeposit', 'not_usable')
        const max = def?.maxStack ?? 1
        let left = count
        const touched: number[] = []
        const put = (i: number) => {
          const there = c.slots[i]
          if (!there) {
            const n2 = Math.min(left, max)
            c.slots[i] = { ...stack, count: n2 }
            left -= n2
            touched.push(i)
          } else if (mergeable(there, stack.code, def) && there.count < max) {
            const n2 = Math.min(left, max - there.count)
            there.count += n2
            left -= n2
            touched.push(i)
          }
        }
        if (msg.to !== undefined) {
          if (msg.to >= c.size) return no('storageDeposit', 'invalid_slot')
          put(msg.to)
          if (left > 0) return no('storageDeposit', 'invalid_slot')
        } else {
          for (let i = 0; i < c.size && left > 0; i++) if (c.slots[i]) put(i)
          for (let i = 0; i < c.size && left > 0; i++) if (!c.slots[i]) put(i)
          if (left > 0) return no('storageDeposit', 'storage_full')
        }
        stack.count -= count
        if (stack.count <= 0) inv.bag[msg.bag] = null
        ctx.result(conn, 'storageDeposit', true)
        invUpdate([msg.bag])
        ctx.send(conn, { t: 'storageUpdate', slots: touched.map(slot => ({ slot, item: copy(c.slots[slot] ?? null) })) })
        return true
      }
      case 'storageWithdraw': {
        const n = npcIn(msg.npc, 'storage')
        if (typeof n === 'string') return no('storageWithdraw', n)
        const c = chestOf(conn)
        const stack = msg.slot < c.size ? c.slots[msg.slot] : null
        if (!stack) return no('storageWithdraw', 'invalid_slot')
        const count = msg.count ?? stack.count
        if (count > stack.count) return no('storageWithdraw', 'invalid_count')
        const def = ctx.content.items.get(stack.code)
        let bag: number[] | null
        if (msg.bag !== undefined) {
          const there = inv.bag[msg.bag]
          if (msg.bag >= inv.bagSize) return no('storageWithdraw', 'invalid_slot')
          if (!there) inv.bag[msg.bag] = { ...stack, count }
          else if (mergeable(there, stack.code, def) && there.count + count <= (def?.maxStack ?? 1)) there.count += count
          else return no('storageWithdraw', 'invalid_slot')
          bag = [msg.bag]
        } else {
          const added = addToBag(inv, def, stack.code, count, stack.plus)
          if (!added) return no('storageWithdraw', 'inventory_full')
          bag = added.map(u => u.slot)
        }
        stack.count -= count
        if (stack.count <= 0) c.slots[msg.slot] = null
        ctx.result(conn, 'storageWithdraw', true)
        invUpdate(bag)
        ctx.send(conn, { t: 'storageUpdate', slots: [{ slot: msg.slot, item: copy(c.slots[msg.slot] ?? null) }] })
        return true
      }
      case 'storageMove': {
        const n = npcIn(msg.npc, 'storage')
        if (typeof n === 'string') return no('storageMove', n)
        const c = chestOf(conn)
        const from = msg.from < c.size ? c.slots[msg.from] : null
        if (!from || msg.to >= c.size) return no('storageMove', 'invalid_slot')
        const to = c.slots[msg.to] ?? null
        const def = ctx.content.items.get(from.code)
        if (to && mergeable(to, from.code, def) && to.count < (def?.maxStack ?? 1)) {
          const k = Math.min(from.count, (def?.maxStack ?? 1) - to.count)
          to.count += k
          from.count -= k
          if (from.count <= 0) c.slots[msg.from] = null
        } else {
          c.slots[msg.to] = from
          c.slots[msg.from] = to
        }
        ctx.result(conn, 'storageMove', true)
        const slots: StorageSlotUpdate[] = [msg.from, msg.to].map(slot => ({ slot, item: copy(c.slots[slot] ?? null) }))
        ctx.send(conn, { t: 'storageUpdate', slots })
        return true
      }
      case 'storageGold': {
        const n = npcIn(msg.npc, 'storage')
        if (typeof n === 'string') return no('storageGold', n)
        const c = chestOf(conn)
        if (msg.dir === 'deposit') {
          if (msg.amount > inv.gold) return no('storageGold', 'not_enough_gold')
          if (c.gold + msg.amount > MAX_GOLD) return no('storageGold', 'gold_limit')
          inv.gold -= msg.amount
          c.gold += msg.amount
        } else {
          if (msg.amount > c.gold) return no('storageGold', 'not_enough_gold')
          if (inv.gold + msg.amount > MAX_GOLD) return no('storageGold', 'gold_limit')
          inv.gold += msg.amount
          c.gold -= msg.amount
        }
        ctx.result(conn, 'storageGold', true)
        ctx.send(conn, { t: 'inventoryUpdate', gold: inv.gold })
        ctx.send(conn, { t: 'statsDelta', stats: { gold: inv.gold } })
        ctx.send(conn, { t: 'storageUpdate', gold: c.gold })
        return true
      }
      case 'itemUse': {
        const stack = inv.bag[msg.bag]
        const def = stack ? ctx.content.items.get(stack.code) : undefined
        if (!stack || !def?.use) return false
        if (def.use.returnToTown) {
          if (ps.prog.dead) return no('itemUse', 'dead')
          if (st.cast || ps.casting) return no('itemUse', 'busy')
          const castMs = Math.max(0, Math.min(def.use.castMs ?? 0, 600_000))
          const [x, z] = position(ctx, self)
          st.cast = { item: stack.code, bag: msg.bag, endsAt: ctx.now() + castMs, x, z }
          ctx.result(conn, 'itemUse', true)
          ctx.broadcast({ t: 'itemCast', id: self.state.id, item: stack.code, castMs })
          return true
        }
        // Potions: the MockServer applies them; report the cooldown it armed.
        const group = def.use.cooldownGroup ?? stack.code
        const before = ps.cooldowns.get(group) ?? 0
        const now = ctx.now()
        queueMicrotask(() => {
          const after = ps.cooldowns.get(group) ?? 0
          if (after !== before && after > now) ctx.send(conn, { t: 'itemCooldown', group, readyInMs: Math.round(after - now), totalMs: Math.round(after - now) })
        })
        return false
      }
    }
    return false
  },

  tick(ctx, now) {
    for (const conn of [...active]) {
      const st = states.get(conn)
      const self = ctx.selfOf(conn)
      if (!st || !self?.player) {
        active.delete(conn)
        continue
      }
      const dead = self.player.prog.dead
      if (st.talk !== null) {
        const n = ctx.entity(st.talk)
        const reason = !n?.npc ? 'gone' : dead ? 'dead' : ctx.dist(self, n) > NPC_INTERACT_RANGE ? 'too_far' : null
        if (reason) {
          ctx.send(conn, { t: 'npcDialogClose', npc: st.talk, reason })
          st.talk = null
        }
      }
      const c = st.cast
      if (!c) continue
      const [x, z] = position(ctx, self)
      if (dead || self.state.move || Math.hypot(x - c.x, z - c.z) > 0.3) {
        endCast(ctx, conn, st, 'interrupted')
        continue
      }
      if (now < c.endsAt) continue
      // Consume at completion: the cast slot if it still holds the scroll, else the lowest slot that does.
      const inv = self.player.prog.inventory
      const bag = inv.bag[c.bag]?.code === c.item ? c.bag : inv.bag.findIndex(s => s?.code === c.item)
      if (bag < 0 || bag >= inv.bagSize) {
        endCast(ctx, conn, st, 'cancelled')
        continue
      }
      const stack = inv.bag[bag]!
      stack.count--
      if (stack.count <= 0) inv.bag[bag] = null
      ctx.send(conn, { t: 'inventoryUpdate', bag: [{ slot: bag, item: copy(inv.bag[bag] ?? null) }] })
      st.cast = null
      ctx.broadcast({ t: 'itemCastEnd', id: self.state.id, item: c.item, reason: 'done' })
      if (st.talk !== null) {
        ctx.send(conn, { t: 'npcDialogClose', npc: st.talk, reason: 'warp' })
        st.talk = null
      }
      // The MockServer's own return (warp to its spawn) runs on its next tick.
      self.player.casting = { until: now }
    }
  },

  enter(_ctx, conn) {
    const st = stateOf(conn)
    st.talk = null
    st.cast = null
    st.buyback = []
  },
}

function endCast(ctx: MockContext, conn: MockConn, st: ConnState, reason: 'cancelled' | 'interrupted'): void {
  const c = st.cast
  const self = ctx.selfOf(conn)
  st.cast = null
  if (c && self) ctx.broadcast({ t: 'itemCastEnd', id: self.state.id, item: c.item, reason })
}
