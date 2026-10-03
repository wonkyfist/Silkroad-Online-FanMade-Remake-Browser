/**
 * H8 adversarial hunt, lens "social economy" (docs/WAVE_PLAN2.md §6.8; docs/SYSTEMS_SOCIAL.md §3.6, §4.6, §5.6, §10.9).
 * The abuse-party.test.ts convention: a test named "BUG:" reproduces a real defect and fails until it is fixed; the
 * others pin interleavings the hunt checked and found safe (party gold share, a pickup walk and a return-scroll cast
 * finishing mid-trade, a return scroll and a GM tp against a stall, a seeded random trade/stall interleaving that must
 * conserve every item and every gold coin).
 */
import type { ClientMessage, ServerMessage, StallView, Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { GameContext } from '../src/game.ts'
import { COMMANDS } from '../src/gm.ts'
import type { GameplayMessage } from '../src/gameplay.ts'
import type { InvItem } from '../src/inventory.ts'
import type { Player } from '../src/world.ts'
import { seeded } from './fixtures.ts'
import { RETURN_03, npcHarness, type Msg, type NpcHarness } from './npc-harness.ts'

const BLADE = 'ITEM_CH_BLADE_02_A'
const POTION = 'ITEM_ETC_HP_POTION_01'

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})

interface P {
  p: Player
  inbox: ServerMessage[]
}

/** npcHarness with stalls allowed anywhere (it has no towns); every player knows every other one. */
function setup() {
  const h = npcHarness({ config: { stallTownOnly: 0 } })
  harnesses.push(h)
  const players: P[] = []
  const enter = (pos: Vec3, gold = 0): P => {
    const x = h.enter(pos, gold)
    for (const q of players) {
      q.p.known.add(x.p.id)
      x.p.known.add(q.p.id)
    }
    players.push(x)
    return x
  }
  /** One request at the harness clock; exactly one actionResult for it. */
  const req = (x: P, msg: ClientMessage) => {
    const before = x.inbox.length
    h.gameplay.request(x.p, msg as GameplayMessage, h.now())
    const res = x.inbox.slice(before).filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
    expect(res.length, msg.t).toBe(1)
    return res[0]!
  }
  const last = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t).at(-1)
  const inv = (x: P) => h.store.loadInventory(x.p.characterId)
  /** Opens an exchange: a asks, b accepts. */
  const openTrade = (a: P, b: P) => {
    expect(req(a, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: true })
    expect(req(b, { t: 'tradeRespond', from: a.p.id, accept: true })).toMatchObject({ ok: true })
    expect(h.gameplay.trade.isTrading(a.p) && h.gameplay.trade.isTrading(b.p)).toBe(true)
  }
  return { h, players, enter, req, last, inv, openTrade }
}

/** Positions clear of every NPC of the harness (the nearest is at 20, 0). */
const AT = (x: number, z = -30): Vec3 => [x, 0, z]

// ---- stalls ---------------------------------------------------------------------------------------------------------

describe('stall: a buyer\'s in-flight purchase after Modify (S1, D47)', () => {
  /**
   * The owner lists a +5 blade and opens; the buyer clicks Buy (the client builds stallBuy {code, count, price} from
   * the view and asks "Buy Blade for 5,000 gold?"). While the box is up, the owner switches to Modify, puts a +0 blade
   * of the same code in the same stall slot at the same price and reopens. The buyer's request still matches code,
   * count and price, so the server sells the +0 blade for the +5 price. S1 promises `stall_changed` for a listing that
   * differs from what the buyer saw; D47 says +N and durability are part of the listing.
   */
  it('BUG: a listing swapped in Modify for a lower +N with the same code, count and price is sold to the stale request', () => {
    const { h, enter, req, last, inv } = setup()
    const owner = enter(AT(0))
    const buyer = enter(AT(3), 100_000)
    const plus5 = h.give(owner.p, BLADE, 1, { plus: 5 })
    const plus0 = h.give(owner.p, BLADE, 1)
    expect(req(owner, { t: 'stallCreate', title: 'Blades' })).toMatchObject({ ok: true })
    expect(req(owner, { t: 'stallItem', slot: 0, bag: plus5, count: 1, price: 5000 })).toMatchObject({ ok: true })
    expect(req(owner, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    expect(req(buyer, { t: 'stallVisit', owner: owner.p.id })).toMatchObject({ ok: true })
    const seen = last(buyer, 'stall')!.stall as StallView
    expect(seen.items[0]!.stack).toMatchObject({ code: BLADE, count: 1, plus: 5 })
    // exactly what the client sends for the listing it shows (hud/stall-state.ts buyRequest: the +N it saw, SOC-1)
    const click = { t: 'stallBuy', owner: owner.p.id, slot: 0, code: BLADE, count: 1, plus: 5, price: seen.items[0]!.price } as const

    // the swap, while the buyer's confirmation box is open
    expect(req(owner, { t: 'stallOpen', open: false })).toMatchObject({ ok: true })
    expect(req(owner, { t: 'stallItem', slot: 0, bag: plus0, count: 1, price: 5000 })).toMatchObject({ ok: true })
    expect(req(owner, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })

    const r = req(buyer, click)
    const got = inv(buyer).bag.find((it) => it?.code === BLADE) ?? null
    expect(
      { ok: r.ok, reason: r.ok ? undefined : r.reason, buyerGotPlus: got?.plus ?? null, buyerGold: inv(buyer).gold },
      'the buyer saw +5 and must not be sold the +0 blade for 5,000 gold',
    ).toEqual({ ok: false, reason: 'stall_changed', buyerGotPlus: null, buyerGold: 100_000 })
  })

  it('BUG: the same swap with a broken copy (durability 0) of the listed item sells the broken one', () => {
    const { h, enter, req, last, inv } = setup()
    const owner = enter(AT(0))
    const buyer = enter(AT(3), 100_000)
    const whole = h.give(owner.p, BLADE, 1)
    const broken = h.give(owner.p, BLADE, 1, { durability: 0 })
    expect(req(owner, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(req(owner, { t: 'stallItem', slot: 0, bag: whole, count: 1, price: 800 })).toMatchObject({ ok: true })
    expect(req(owner, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    expect(req(buyer, { t: 'stallVisit', owner: owner.p.id })).toMatchObject({ ok: true })
    const seen = last(buyer, 'stall')!.stall as StallView
    expect(seen.items[0]!.stack.durability ?? null).toBeNull()
    const click = { t: 'stallBuy', owner: owner.p.id, slot: 0, code: BLADE, count: 1, price: 800 } as const
    req(owner, { t: 'stallOpen', open: false })
    req(owner, { t: 'stallItem', slot: 0, bag: broken, count: 1, price: 800 })
    req(owner, { t: 'stallOpen', open: true })
    const r = req(buyer, click)
    const got = inv(buyer).bag.find((it) => it?.code === BLADE) ?? null
    expect({ ok: r.ok, reason: r.ok ? undefined : r.reason, buyerGotDurability: got ? got.durability : 'nothing' }).toEqual({
      ok: false,
      reason: 'stall_changed',
      buyerGotDurability: 'nothing',
    })
  })

  it('a stale price or count after Modify is still refused stall_changed (the part of S1 that holds)', () => {
    const { h, enter, req, inv } = setup()
    const owner = enter(AT(0))
    const buyer = enter(AT(3), 100_000)
    const pots = h.give(owner.p, POTION, 20)
    req(owner, { t: 'stallCreate', title: '' })
    req(owner, { t: 'stallItem', slot: 0, bag: pots, count: 20, price: 100 })
    req(owner, { t: 'stallOpen', open: true })
    const click = { t: 'stallBuy', owner: owner.p.id, slot: 0, code: POTION, count: 20, price: 100 } as const
    req(owner, { t: 'stallOpen', open: false })
    req(owner, { t: 'stallItem', slot: 0, bag: pots, count: 20, price: 90_000 })
    req(owner, { t: 'stallOpen', open: true })
    expect(req(buyer, click)).toMatchObject({ ok: false, reason: 'stall_changed' })
    req(owner, { t: 'stallOpen', open: false })
    req(owner, { t: 'stallItem', slot: 0, bag: pots, count: 1, price: 100 })
    req(owner, { t: 'stallOpen', open: true })
    expect(req(buyer, click)).toMatchObject({ ok: false, reason: 'stall_changed' })
    expect(inv(buyer).gold).toBe(100_000)
  })

  it('a return-scroll cast running at stallCreate is interrupted (no warp later); itemUse of a scroll while stalling is refused', () => {
    const { h, enter, req, last } = setup()
    const owner = enter(AT(0))
    const visitor = enter(AT(3))
    const scroll = h.give(owner.p, RETURN_03.code, 3)
    expect(req(owner, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    expect(h.gameplay.itemUses.casting(owner.p)).not.toBeNull()
    expect(req(owner, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.gameplay.itemUses.casting(owner.p)).toBeNull()
    expect(h.of(owner.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    expect(req(owner, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: false, reason: 'stalling' })
    expect(req(visitor, { t: 'stallVisit', owner: owner.p.id })).toMatchObject({ ok: true })
    h.advance(6000)
    expect(h.countOf(owner.p, RETURN_03.code)).toBe(3)
    expect(owner.p.pos[0]).toBeCloseTo(0)
    expect(owner.p.pos[2]).toBeCloseTo(-30)
    expect(h.gameplay.stalls.stallOf(owner.p)).toBeDefined()
    expect(last(visitor, 'stall')!.stall).not.toBeNull()
  })

  it('GM tp of a stall owner (the real COMMANDS.tp) closes the stall for its visitors and viewers', () => {
    const { h, enter, req, last } = setup()
    const owner = enter(AT(0))
    const visitor = enter(AT(3))
    expect(req(owner, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(req(visitor, { t: 'stallVisit', owner: owner.p.id })).toMatchObject({ ok: true })
    const ctx = { world: h.world, gameplay: h.gameplay, data: h.data, setup: { spawn: { x: 0, y: 0, z: 0 } }, config: h.config } as unknown as GameContext
    const conn = { player: owner.p, role: 'gm', account: 'gm', send: () => {} } as never
    expect(COMMANDS.tp.run({ ctx, conn, role: 'gm', args: ['100', '100'], self: owner.p }).ok).toBe(true)
    expect(h.gameplay.stalls.stallOf(owner.p)).toBeUndefined()
    expect(last(visitor, 'stall')).toEqual({ t: 'stall', stall: null, reason: 'closed' })
    // a short hop keeps the owner in the visitor's view: its sign comes down
    expect(req(owner, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(COMMANDS.tp.run({ ctx, conn, role: 'gm', args: ['8', '-30'], self: owner.p }).ok).toBe(true)
    expect(h.gameplay.stalls.stallOf(owner.p)).toBeUndefined()
    expect(last(visitor, 'entityUpdate')).toMatchObject({ id: owner.p.id, stall: '' })
  })

  it('S13: a visitor with an exchange open cannot visit or buy (trading); nothing moves', () => {
    const { h, enter, req, inv, openTrade } = setup()
    const owner = enter(AT(0))
    const buyer = enter(AT(3), 10_000)
    const friend = enter(AT(-3))
    const pots = h.give(owner.p, POTION, 5)
    req(owner, { t: 'stallCreate', title: '' })
    req(owner, { t: 'stallItem', slot: 0, bag: pots, count: 5, price: 50 })
    req(owner, { t: 'stallOpen', open: true })
    expect(req(buyer, { t: 'stallVisit', owner: owner.p.id })).toMatchObject({ ok: true })
    openTrade(friend, buyer)
    expect(req(buyer, { t: 'stallBuy', owner: owner.p.id, slot: 0, code: POTION, count: 5, price: 50 })).toMatchObject({ ok: false, reason: 'trading' })
    expect(req(buyer, { t: 'stallVisit', owner: owner.p.id })).toMatchObject({ ok: false, reason: 'trading' })
    expect(inv(buyer).gold).toBe(10_000)
    expect(h.countOf(owner.p, POTION)).toBe(5)
  })
})

// ---- trade ----------------------------------------------------------------------------------------------------------

describe('trade: bag changes that do not come from requests (§2.3, §3.5, T8)', () => {
  it('party gold share (a real share-mode pickup) landing mid-trade: the commit swaps exactly the offers, gold is conserved', () => {
    const { h, enter, req, inv, openTrade } = setup()
    const a = enter(AT(0), 1000)
    const b = enter(AT(3), 0)
    const picker = enter(AT(-3), 0)
    // a and picker in a share-mode party
    expect(req(picker, { t: 'partyInvite', target: a.p.id, items: 'share' } as ClientMessage)).toMatchObject({ ok: true })
    const blade = h.give(b.p, BLADE, 1, { plus: 2 })
    openTrade(a, b)
    expect(req(a, { t: 'tradeGold', amount: 1000 })).toMatchObject({ ok: true })
    expect(req(b, { t: 'tradeOffer', bag: blade })).toMatchObject({ ok: true })
    // the party invite is on the trade allowlist: a joins while trading
    expect(req(a, { t: 'partyRespond', inviter: picker.p.id, accept: true } as ClientMessage)).toMatchObject({ ok: true })
    const party = h.gameplay.party.partyOf(picker.p)!
    const gold = h.gameplay.spawnGroundItem('ITEM_ETC_GOLD_01', 301, 0, AT(-3), picker.p, h.now(), null, party.id)
    picker.p.known.add(gold.id)
    expect(req(picker, { t: 'pickup', id: gold.id })).toMatchObject({ ok: true })
    expect(inv(a).gold).toBe(1150) // 1000 + floor(301 / 2)
    expect(req(a, { t: 'tradeLock' })).toMatchObject({ ok: true })
    expect(req(b, { t: 'tradeLock' })).toMatchObject({ ok: true })
    expect(req(a, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    expect(req(b, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    expect(h.gameplay.trade.isTrading(a.p)).toBe(false)
    expect(inv(a).gold).toBe(150)
    expect(inv(b).gold).toBe(1000)
    expect(inv(a).bag.filter((it) => it?.code === BLADE)).toEqual([{ code: BLADE, count: 1, plus: 2, durability: null }])
    expect(inv(a).gold + inv(b).gold + inv(picker).gold).toBe(1000 + 301)
    const rows = h.store.db.prepare('SELECT a_gold, b_gold FROM social_log').all()
    expect(rows).toEqual([{ a_gold: 1000, b_gold: 0 }])
  })

  it('a pickup walk started before the exchange completes during it and grows the offered stack: exactly the offered count moves (no dupe)', () => {
    // §10.9 phrases this as "the commit fails"; the code (TR-S unknowns) trades the offered count instead. Either way
    // nothing is duplicated: the extra potions stay with a.
    const { h, enter, req, inv, openTrade } = setup()
    const a = enter(AT(0))
    const b = enter(AT(3))
    const pots = h.give(a.p, POTION, 10)
    const ground = h.gameplay.spawnGroundItem(POTION, 5, 0, AT(0, -36), a.p, h.now())
    a.p.known.add(ground.id)
    expect(req(a, { t: 'pickup', id: ground.id })).toMatchObject({ ok: true })
    expect(a.p.action?.kind).toBe('pickup')
    openTrade(b, a)
    expect(req(a, { t: 'tradeOffer', bag: pots, count: 10 })).toMatchObject({ ok: true })
    h.advance(3000)
    expect(h.world.items.has(ground.id)).toBe(false)
    expect(inv(a).bag[pots]).toMatchObject({ code: POTION, count: 15 })
    expect(h.gameplay.trade.isTrading(a.p)).toBe(true)
    req(a, { t: 'tradeLock' })
    req(b, { t: 'tradeLock' })
    req(a, { t: 'tradeAccept' })
    req(b, { t: 'tradeAccept' })
    expect(h.gameplay.trade.isTrading(a.p)).toBe(false)
    expect(h.countOf(a.p, POTION)).toBe(5)
    expect(h.countOf(b.p, POTION)).toBe(10)
  })

  it('a return-scroll cast started before the exchange finishes during it: the warp ends the trade (moved) and nothing is swapped', () => {
    const { h, enter, req, inv, last, openTrade } = setup()
    const a = enter(AT(0))
    const b = enter(AT(3))
    const scroll = h.give(a.p, RETURN_03.code, 2)
    const blade = h.give(a.p, BLADE, 1, { plus: 4 })
    expect(req(a, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    openTrade(b, a)
    expect(req(a, { t: 'tradeOffer', bag: blade })).toMatchObject({ ok: true })
    expect(req(a, { t: 'tradeOffer', bag: scroll, count: 2 })).toMatchObject({ ok: true })
    req(a, { t: 'tradeLock' })
    req(b, { t: 'tradeLock' })
    req(b, { t: 'tradeAccept' })
    h.advance(5100)
    expect(last(b, 'tradeEnd')).toMatchObject({ reason: 'moved' })
    expect(h.gameplay.trade.isTrading(a.p)).toBe(false)
    expect(h.countOf(a.p, RETURN_03.code)).toBe(1)
    expect(inv(a).bag[blade]).toMatchObject({ code: BLADE, plus: 4 })
    expect(h.countOf(b.p, BLADE)).toBe(0)
    // the late accept of a finds no exchange
    expect(req(a, { t: 'tradeAccept' })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('a partner turning GM-invisible: the 1 Hz check closes the window for both before anything more can happen', () => {
    const { h, enter, req, last, openTrade } = setup()
    const a = enter(AT(0))
    const gm = enter(AT(3))
    gm.p.staff = true
    openTrade(a, gm)
    h.world.setInvisible(gm.p, true, h.now())
    h.advance(1100)
    expect(last(a, 'tradeEnd')).toMatchObject({ reason: 'too_far' })
    expect(req(a, { t: 'tradeRequest', target: gm.p.id })).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

// ---- conservation: a seeded random interleaving of trades and stall sales -----------------------------------------

describe('conservation under a seeded random interleaving (trade + stall + moves)', () => {
  it('no item or gold is created or destroyed; social_log gold equals the gold that moved through it', () => {
    const { h, enter, req, players, last } = setup()
    const rng = seeded(8)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!
    const int = (n: number) => Math.floor(rng() * n)
    const ps = [enter(AT(0), 5000), enter(AT(3), 5000), enter(AT(-3), 5000), enter(AT(0, -33), 5000)]
    for (const x of ps) {
      h.give(x.p, POTION, 1 + int(40))
      h.give(x.p, BLADE, 1, { plus: int(4) })
      h.give(x.p, BLADE, 1, { durability: int(2) === 0 ? 0 : null })
      h.give(x.p, POTION, 1 + int(20))
    }
    const key = (it: InvItem) => `${it.code}+${it.plus}@${it.durability}`
    const census = () => {
      const items = new Map<string, number>()
      let gold = 0
      for (const x of players) {
        const s = h.store.loadInventory(x.p.characterId)
        gold += s.gold
        for (const it of [...s.bag, ...Object.values(s.equip)]) if (it) items.set(key(it), (items.get(key(it)) ?? 0) + it.count)
      }
      return { gold, items: Object.fromEntries([...items].sort(([x], [y]) => x.localeCompare(y))) }
    }
    const start = census()
    const send = (x: P, msg: ClientMessage) => {
      h.gameplay.request(x.p, msg as GameplayMessage, h.now())
    }
    let trades = 0
    let sales = 0
    const trade = h.gameplay.trade
    for (let step = 0; step < 20000; step++) {
      const x = pick(ps)
      const other = pick(ps.filter((q) => q !== x))
      const bag = int(12)
      const view = last(x, 'stall')?.stall ?? null
      const pending = trade.pendingFor(x.p.characterId)
      const requester = pending ? ps.find((q) => q.p.characterId === pending.from) : undefined
      if (requester && rng() < 0.7) {
        send(x, { t: 'tradeRespond', from: requester.p.id, accept: rng() < 0.9 })
        continue
      }
      const own = h.gameplay.stalls.stallOf(x.p)
      if (own && rng() < 0.6) {
        pick<() => void>([
          () => send(x, { t: 'stallItem', slot: int(4), bag, count: 1 + int(3), price: 1 + int(3) * 900 }),
          () => send(x, { t: 'stallItem', slot: int(4), bag, count: 1, price: 1 + int(3) * 900 }),
          () => send(x, { t: 'stallOpen', open: true }),
          () => send(x, { t: 'stallOpen', open: rng() < 0.3 }),
          () => send(x, { t: 'stallClose' }),
        ])()
        continue
      }
      if (!own && view && view.owner !== x.p.id && rng() < 0.6) {
        const slot = int(4)
        const l = view.items[slot]
        if (l) {
          const before = x.inbox.length
          send(x, { t: 'stallBuy', owner: view.owner, slot, ...l.stack, price: l.price })
          if (x.inbox.slice(before).some((m) => m.t === 'actionResult' && m.re === 'stallBuy' && m.ok)) sales++
        } else send(x, { t: 'stallVisit', owner: view.owner })
        continue
      }
      if (trade.isTrading(x.p) && rng() < 0.75) {
        const before = x.inbox.length
        pick<() => void>([
          () => send(x, { t: 'tradeOffer', bag, count: rng() < 0.5 ? undefined : 1 + int(15) } as ClientMessage),
          () => send(x, { t: 'tradeGold', amount: int(3) * 700 }),
          () => send(x, { t: 'tradeTake', slot: int(3) }),
          () => send(x, { t: 'tradeLock' }),
          () => send(x, { t: 'tradeLock' }),
          () => send(x, { t: 'tradeAccept' }),
          () => send(x, { t: 'tradeAccept' }),
          () => send(x, { t: 'tradeAccept' }),
        ])()
        for (const m of x.inbox.slice(before)) if (m.t === 'tradeEnd' && m.reason === 'done') trades++
        if (step % 50 === 0) expect(census(), `after step ${step}`).toEqual(start)
        continue
      }
      const ops: (() => void)[] = [
        () => send(x, { t: 'tradeRequest', target: other.p.id }),
        () => send(x, { t: 'tradeRequest', target: other.p.id }),
        () => send(x, { t: 'tradeOffer', bag, count: rng() < 0.5 ? undefined : 1 + int(15) } as ClientMessage),
        () => send(x, { t: 'tradeTake', slot: int(3) }),
        () => send(x, { t: 'tradeGold', amount: int(3) * 700 }),
        () => send(x, { t: 'tradeLock' }),
        () => send(x, { t: 'tradeAccept' }),
        () => send(x, { t: 'tradeAccept' }),
        () => send(x, { t: 'tradeCancel' }),
        () => send(x, { t: 'itemMove', from: bag, to: int(12) }),
        () => send(x, { t: 'itemSplit', from: bag, to: int(12), count: 1 + int(5) }),
        () => send(x, { t: 'stallCreate', title: '' }),
        () => send(x, { t: 'stallItem', slot: int(4), bag, count: 1 + int(10), price: 1 + int(3) * 900 }),
        () => send(x, { t: 'stallItemRemove', slot: int(4) }),
        () => send(x, { t: 'stallOpen', open: rng() < 0.7 }),
        () => send(x, { t: 'stallClose' }),
        () => send(x, { t: 'stallVisit', owner: pick([...h.gameplay.stalls.stalls.keys(), other.p.id]) }),
        () => send(x, { t: 'stallVisit', owner: pick([...h.gameplay.stalls.stalls.keys(), other.p.id]) }),
        () => {
          // a buy from the view the buyer holds (possibly stale), or a guessed one
          const slot = int(4)
          const l = view && view.owner !== x.p.id ? view.items[slot] : null
          if (l) send(x, { t: 'stallBuy', owner: view!.owner, slot, ...l.stack, price: l.price })
          else send(x, { t: 'stallBuy', owner: other.p.id, slot, code: POTION, count: 1 + int(5), price: 1 + int(3) * 900 })
        },
        () => send(x, { t: 'stallLeave' }),
        () => h.advance(250),
      ]
      const before = x.inbox.length
      pick(ops)()
      for (const m of x.inbox.slice(before)) if (m.t === 'tradeEnd' && m.reason === 'done') trades++
      if (x.inbox.slice(before).some((m) => m.t === 'actionResult' && m.re === 'stallBuy' && m.ok)) sales++
      if (step % 50 === 0) expect(census(), `after step ${step}`).toEqual(start)
    }
    expect(census()).toEqual(start)
    // it actually exercised both paths
    expect(trades).toBeGreaterThan(0)
    expect(sales).toBeGreaterThan(0)
    const rows = h.store.db.prepare('SELECT kind, a_gold, b_gold FROM social_log').all() as { kind: string; a_gold: number; b_gold: number }[]
    expect(rows.filter((r) => r.kind === 'stall').length).toBe(sales)
    expect(rows.every((r) => r.a_gold >= 0 && r.b_gold >= 0)).toBe(true)
  })
})

