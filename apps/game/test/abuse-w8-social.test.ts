/**
 * H8 adversarial hunt, lens "social economy" (docs/WAVE_PLAN2.md §6.8), client half. The abuse-party.test.ts
 * convention: a "BUG:" test reproduces a real defect and fails until it is fixed.
 *
 * The stall purchase (world/features/stall.ts StallController.buy): the buyer clicks Buy, the controller freezes
 * {code, count, price} of the shown listing and asks "Buy <item> for <price> gold?". The server only compares code,
 * count and price (apps/server/test/abuse-w8-social.test.ts shows the server half), so the +N and the durability the
 * buyer saw are protected by nothing: not by the question (it never names them) and not by the controller (it sends
 * the frozen request even when the listing's stack changed while the box was open).
 */
import { STALL_SLOTS, type ClientMessage, type ItemDef, type ItemStack, type ServerMessage, type StallListing, type StallView } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { StallController, type StallIo } from '../src/world/features/stall.ts'

const SELF = 7
const OWNER = 42
const BLADE = 'ITEM_CH_BLADE_02_A'

function view(listings: (StallListing | null)[], state: 'open' | 'modify' = 'open'): StallView {
  return {
    owner: OWNER,
    name: 'Mei',
    title: "Mei's stall.",
    greeting: 'Welcome!',
    state,
    items: Array.from({ length: STALL_SLOTS }, (_, i) => listings[i] ?? null),
    visitors: 1,
  }
}

const listing = (stack: ItemStack, price: number): StallListing => ({ stack, price })

function controller() {
  const sent: ClientMessage[] = []
  const asked: string[] = []
  let answer!: (v: boolean) => void
  const io: StallIo = {
    send: (msg) => {
      sent.push(msg)
      return true
    },
    selfId: () => SELF,
    selfName: () => 'Me',
    selfDead: () => false,
    gold: () => 1_000_000,
    bagItem: () => null,
    itemDef: (code) => ({ code }) as ItemDef,
    itemName: (code) => (code === BLADE ? 'Iron Blade' : code),
    error: () => {},
    info: () => {},
    systemLine: () => {},
    chatLine: () => {},
    markBags: () => {},
    setSign: () => {},
    setVendor: () => {},
    approach: () => {},
    window: () => {},
    windowOpen: () => true,
    saleSound: () => {},
    now: () => 10_000,
    askTitle: async () => null,
    askGreeting: async () => null,
    askCount: async () => null,
    askPrice: async () => null,
    confirm: (_title, text) => {
      asked.push(text)
      return new Promise<boolean>((r) => (answer = r))
    },
  }
  const c = new StallController(io)
  c.onMessage({ t: 'worldEnter', self: { id: SELF, kind: 'player', name: 'Me', model: 'CHAR_CH_MAN_ADVENTURER', level: 5, pos: [0, 0, 0], yaw: 0 }, world: {} as never, entities: [] })
  const stall = (v: StallView): void => c.onMessage({ t: 'stall', stall: v } as ServerMessage)
  return { c, sent, asked, stall, answer: (v: boolean) => answer(v) }
}

describe('stall purchase confirmation (client)', () => {
  it('BUG: the question does not name the +N of the listing the buyer is about to pay for', async () => {
    const f = controller()
    f.stall(view([listing({ code: BLADE, count: 1, plus: 5 }, 5000)]))
    const done = f.c.buy(0)
    f.answer(false)
    await done
    expect(f.asked).toHaveLength(1)
    expect(f.asked[0], 'the buyer must see which blade (+5) the 5,000 gold buys').toMatch(/\+5/)
  })

  it('BUG: a listing whose item changed (+5 to +0, same code, count and price) while the box was open is still bought', async () => {
    const f = controller()
    f.stall(view([listing({ code: BLADE, count: 1, plus: 5 }, 5000)]))
    const done = f.c.buy(0)
    // the owner switches to Modify, swaps in a +0 blade at the same price and reopens, while the box is up
    f.stall(view([listing({ code: BLADE, count: 1, plus: 5 }, 5000)], 'modify'))
    f.stall(view([listing({ code: BLADE, count: 1 }, 5000)], 'modify'))
    f.stall(view([listing({ code: BLADE, count: 1 }, 5000)]))
    f.answer(true)
    await done
    // the server accepts this request and hands over the +0 blade (the server test proves it)
    expect(
      f.sent.filter((m) => m.t === 'stallBuy'),
      'the controller must not send a purchase for a listing that is no longer the one the buyer confirmed',
    ).toEqual([])
  })

  it('guard: a broken listing says so in the question, and the request names the +N and durability shown (SOC-1)', async () => {
    const f = controller()
    f.stall(view([listing({ code: BLADE, count: 1, plus: 3, durability: 0 }, 700)]))
    const done = f.c.buy(0)
    f.answer(true)
    await done
    expect(f.asked).toEqual(['Buy Iron Blade +3 (broken) for 700 gold?'])
    expect(f.sent.filter((m) => m.t === 'stallBuy')).toEqual([{ t: 'stallBuy', owner: OWNER, slot: 0, code: BLADE, count: 1, plus: 3, durability: 0, price: 700 }])
  })
})
