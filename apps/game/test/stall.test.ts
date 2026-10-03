/**
 * Lane ST-C (docs/SYSTEMS_SOCIAL.md §9.3, §10.8; docs/WAVE_PLAN2.md §6.5): the DOM-free stall model (owner vs visitor
 * view, rows, the exact buy request, modify disables Buy, price parsing), the nameplate sign and the vendor pose from
 * EntityState / entityUpdate, and the StallController driven by a fake StallIo (create, list, edit, buy, visit with
 * the walk-up on too_far, the owner's ground clicks, the sale line, the refusal lines, the bag marks, leaving).
 */
import {
  STALL_PRICE_MAX,
  STALL_SLOTS,
  STALL_TITLE_MAX,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type EntityState,
  type ItemDef,
  type ItemStack,
  type ServerMessage,
  type StallListing,
  type StallView,
} from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { rowRect, STALL_H, STALL_W } from '../src/hud/stall.ts'
import {
  clampCodePoints,
  cleanTitle,
  endKey,
  formatPrice,
  formatPriceInput,
  parsePrice,
  signOfState,
  signOfUpdate,
  stallFailKey,
  StallModel,
  stallRows,
} from '../src/hud/stall-state.ts'
import { enStall } from '../src/i18n/en-stall.ts'
import { en } from '../src/i18n/en.ts'
import { t } from '../src/i18n/index.ts'
import { stallMock } from '../src/net/mock/stall.ts'
import { CLOSE_FIRST_TOAST_MS, setVendorPose, STALL_COMMAND, StallController, type StallIo } from '../src/world/features/stall.ts'
import { WORLD_FEATURES } from '../src/world/features.ts'
import { stallFeature } from '../src/world/features/stall.ts'

const SELF = 7
const OWNER = 42

const valid = (m: ClientMessage) => parseClientMessage(JSON.stringify(m)).ok

function listing(code: string, count: number, price: number, bag?: number, plus?: number): StallListing {
  const stack: ItemStack = { code, count }
  if (plus) stack.plus = plus
  return bag === undefined ? { stack, price } : { stack, price, bag }
}

function view(owner: number, over: Partial<StallView> = {}, listings: (StallListing | null)[] = []): StallView {
  return {
    owner,
    name: owner === SELF ? 'Me' : 'Mei',
    title: "Mei's stall.",
    greeting: 'Welcome!',
    state: 'open',
    items: Array.from({ length: STALL_SLOTS }, (_, i) => listings[i] ?? null),
    visitors: 1,
    ...over,
  }
}

const stallMsg = (stall: StallView | null, reason?: 'closed' | 'left' | 'too_far'): Extract<ServerMessage, { t: 'stall' }> =>
  reason ? { t: 'stall', stall, reason } : { t: 'stall', stall }

// ---- the model ------------------------------------------------------------------------------------------------

describe('stall model', () => {
  it('tells the owner view from the visitor view', () => {
    const m = new StallModel()
    m.selfId = SELF
    expect(m.role).toBe(null)
    m.apply(stallMsg(view(SELF, { state: 'modify' })))
    expect(m.role).toBe('owner')
    expect(m.isOwner).toBe(true)
    expect(m.canEdit).toBe(true)
    m.apply(stallMsg(view(OWNER)))
    expect(m.role).toBe('visitor')
    expect(m.canEdit).toBe(false)
  })

  it('reports opening, switching stalls and the end with its reason', () => {
    const m = new StallModel()
    m.selfId = SELF
    expect(m.apply(stallMsg(view(OWNER))).opened).toBe(true)
    expect(m.apply(stallMsg(view(OWNER, { visitors: 2 }))).opened).toBe(false)
    expect(m.apply(stallMsg(view(OWNER + 1))).opened).toBe(true)
    expect(m.apply(stallMsg(null, 'too_far'))).toEqual({ opened: false, ended: 'too_far', was: 'visitor' })
    expect(m.apply(stallMsg(null))).toEqual({ opened: false, ended: null, was: null })
    m.apply(stallMsg(view(SELF)))
    expect(m.apply(stallMsg(null)).ended).toBe('gone')
  })

  it('pads a short items array to STALL_SLOTS', () => {
    const m = new StallModel()
    m.apply(stallMsg({ ...view(OWNER), items: [listing('ITEM_A', 1, 5)] }))
    expect(m.view!.items).toHaveLength(STALL_SLOTS)
    expect(m.listing(0)?.price).toBe(5)
    expect(m.listing(9)).toBe(null)
  })

  it('buys exactly the shown code, count and price (S1), and the request validates', () => {
    const m = new StallModel()
    m.selfId = SELF
    m.apply(stallMsg(view(OWNER, {}, [null, listing('ITEM_ETC_HP_POTION_01', 50, 180)])))
    const req = m.buyRequest(1)!
    expect(req).toEqual({ t: 'stallBuy', owner: OWNER, slot: 1, code: 'ITEM_ETC_HP_POTION_01', count: 50, price: 180 })
    expect(valid(req)).toBe(true)
    expect(m.buyRequest(0)).toBe(null)
    // The owner raised the price: the next request carries the new one (the old one the server refuses).
    m.apply(stallMsg(view(OWNER, {}, [null, listing('ITEM_ETC_HP_POTION_01', 50, 999)])))
    expect(m.buyRequest(1)?.price).toBe(999)
  })

  it('modify state disables Buy for visitors', () => {
    const m = new StallModel()
    m.selfId = SELF
    m.apply(stallMsg(view(OWNER, { state: 'modify' }, [listing('ITEM_A', 1, 10)])))
    expect(m.canBuy(0)).toBe(false)
    expect(m.buyRequest(0)).toBe(null)
    expect(stallRows(m)[0]).toMatchObject({ buyable: false, editable: false, priceText: '10' })
    m.apply(stallMsg(view(OWNER, { state: 'open' }, [listing('ITEM_A', 1, 10)])))
    expect(stallRows(m)[0]!.buyable).toBe(true)
  })

  it('never lets the owner buy from their own stall, and edits only in modify', () => {
    const m = new StallModel()
    m.selfId = SELF
    m.apply(stallMsg(view(SELF, { state: 'open' }, [listing('ITEM_A', 2, 1234567, 3)])))
    expect(m.canBuy(0)).toBe(false)
    const open = stallRows(m)[0]!
    expect(open).toMatchObject({ bag: 3, buyable: false, editable: false, priceText: '1,234,567' })
    m.apply(stallMsg(view(SELF, { state: 'modify' }, [listing('ITEM_A', 2, 1234567, 3)])))
    expect(stallRows(m)[0]!.editable).toBe(true)
    expect(stallRows(m)[1]).toMatchObject({ stack: null, priceText: '', buyable: false, editable: false })
  })

  it('knows the listed bag slots (owner only), the first free slot and why a bag item cannot be listed', () => {
    const m = new StallModel()
    m.selfId = SELF
    m.apply(stallMsg(view(SELF, { state: 'modify' }, [listing('ITEM_A', 1, 1, 4), null, listing('ITEM_B', 1, 1, 9)])))
    expect([...m.listedBags()].sort()).toEqual([4, 9])
    expect(m.slotOfBag(9)).toBe(2)
    expect(m.freeSlot()).toBe(1)
    const def = (over: Partial<ItemDef> = {}) => ({ code: 'X', canTrade: true, ...over }) as ItemDef
    expect(m.listProblem(4, { code: 'ITEM_A', count: 1 }, def())).toBe('stall.alreadyListed')
    expect(m.listProblem(5, { code: 'ITEM_CH_SWORD_01_A_DEF', count: 1 }, def({ canTrade: false }))).toBe('stall.notTradable')
    expect(m.listProblem(5, { code: 'ITEM_C', count: 1 }, def())).toBe(null)
    m.apply(stallMsg(view(SELF, { state: 'open' }, [listing('ITEM_A', 1, 1, 4)])))
    expect(m.listProblem(5, { code: 'ITEM_C', count: 1 }, def())).toBe('stall.modifyFirst')
    m.apply(stallMsg(view(SELF, { state: 'modify' }, Array.from({ length: STALL_SLOTS }, (_, i) => listing('ITEM_A', 1, 1, i + 10)))))
    expect(m.listProblem(5, { code: 'ITEM_C', count: 1 }, def())).toBe('stall.slotsFull')
    // A visitor sees no bag slots.
    m.apply(stallMsg(view(OWNER, {}, [listing('ITEM_A', 1, 1)])))
    expect(m.listedBags().size).toBe(0)
  })
})

describe('prices and texts', () => {
  it('parses prices with separators and suffixes, refusing 0 and more than 1 billion', () => {
    expect(parsePrice('1')).toBe(1)
    expect(parsePrice('1,000,000')).toBe(1_000_000)
    expect(parsePrice(' 12 500 ')).toBe(12_500)
    expect(parsePrice("1'000")).toBe(1000)
    expect(parsePrice('250k')).toBe(250_000)
    expect(parsePrice('1.5M')).toBe(1_500_000)
    expect(parsePrice('1b')).toBe(STALL_PRICE_MAX)
    expect(parsePrice('1,000,000,000')).toBe(STALL_PRICE_MAX)
    expect(parsePrice('0')).toBe(null)
    expect(parsePrice('000')).toBe(null)
    expect(parsePrice('1,000,000,001')).toBe(null)
    expect(parsePrice('2b')).toBe(null)
    expect(parsePrice('')).toBe(null)
    expect(parsePrice('-5')).toBe(null)
    expect(parsePrice('1.5')).toBe(null)
    expect(parsePrice('1.0001k')).toBe(null)
    expect(parsePrice('12abc')).toBe(null)
    expect(parsePrice('9007199254740993')).toBe(null)
  })

  it('formats prices and regroups the field while typing', () => {
    expect(formatPrice(0)).toBe('0')
    expect(formatPrice(999)).toBe('999')
    expect(formatPrice(1000)).toBe('1,000')
    expect(formatPrice(STALL_PRICE_MAX)).toBe('1,000,000,000')
    expect(formatPriceInput('1234567')).toBe('1,234,567')
    expect(formatPriceInput('12,34')).toBe('1,234')
    expect(formatPriceInput('007')).toBe('7')
    expect(formatPriceInput('1.5m')).toBe('1.5m')
    expect(formatPriceInput('')).toBe('')
  })

  it('clamps titles by code points (astral characters count once)', () => {
    const long = '😀'.repeat(STALL_TITLE_MAX + 3)
    expect([...clampCodePoints(long, STALL_TITLE_MAX)]).toHaveLength(STALL_TITLE_MAX)
    expect(cleanTitle('  shop  ')).toBe('shop')
    const msg: ClientMessage = { t: 'stallCreate', title: cleanTitle(long) }
    expect(valid(msg)).toBe(true)
  })

  it('has every stall string, with the retail wording', () => {
    for (const [k, v] of Object.entries(enStall)) expect((en as Record<string, string>)[k], k).toBe(v)
    expect(t('stall.defaultTitle', { name: 'Mei' })).toBe("Mei's stall.")
    expect(t('stall.bought', { buyer: 'Wei', item: 'HP Recovery Herb' })).toBe('Wei bought item HP Recovery Herb.')
  })

  it('picks the stall line for a refusal: request-specific, then general, else none', () => {
    expect(stallFailKey('stallCreate', 'stalling')).toBe('stall.fail.stallCreate.stalling')
    expect(stallFailKey('stallItem', 'stalling')).toBe('stall.fail.stallItem.stalling')
    expect(stallFailKey('stallBuy', 'not_enough_gold')).toBe('stall.fail.not_enough_gold')
    expect(stallFailKey('stallVisit', 'stall_full')).toBe('stall.fail.stall_full')
    expect(stallFailKey('stallCreate', 'wrong_place')).toBe('stall.fail.wrong_place')
    expect(stallFailKey('stallCreate', 'mounted')).toBe(null)
    expect(stallFailKey('stallCreate', undefined)).toBe(null)
    expect(endKey('too_far', false)).toBe('stall.end.too_far')
    expect(endKey('left', false)).toBe('stall.end.left')
    expect(endKey('gone', false)).toBe('stall.closed')
    expect(endKey('closed', true)).toBe('stall.ownClosed')
  })

  it('reads the sign from EntityState and entityUpdate', () => {
    expect(signOfState({ kind: 'player', stall: 'Cheap pots' })).toBe('Cheap pots')
    expect(signOfState({ kind: 'player' })).toBe(null)
    expect(signOfState({ kind: 'player', stall: '' })).toBe(null)
    expect(signOfState({ kind: 'mob', stall: 'x' })).toBe(null)
    expect(signOfUpdate({})).toBe(undefined)
    expect(signOfUpdate({ stall: '' })).toBe(null)
    expect(signOfUpdate({ stall: 'New' })).toBe('New')
    // The server messages that carry it parse with the field kept.
    const upd = parseServerMessage(JSON.stringify({ t: 'entityUpdate', id: 3, stall: '' }))
    expect(upd.ok && upd.msg.t === 'entityUpdate' && upd.msg.stall).toBe('')
  })

  it('lays the ten rows out in two columns inside the 467x490 window', () => {
    expect([STALL_W, STALL_H]).toEqual([467, 490])
    const rects = Array.from({ length: STALL_SLOTS }, (_, i) => rowRect(i))
    for (const [x, y, w, h] of rects) {
      expect(x).toBeGreaterThanOrEqual(22)
      expect(x + w).toBeLessThanOrEqual(22 + 423)
      expect(y).toBeGreaterThanOrEqual(108)
      expect(y + h).toBeLessThanOrEqual(108 + 216)
    }
    expect(rects[0]![1]).toBe(rects[1]![1])
    expect(rects[0]![0]).toBeLessThan(rects[1]![0])
    expect(rects[2]![1]).toBeGreaterThan(rects[0]![1])
  })
})

// ---- the controller --------------------------------------------------------------------------------------------

interface Fake {
  io: StallIo
  sent: ClientMessage[]
  errors: string[]
  infos: string[]
  lines: string[]
  chat: [string, string, boolean][]
  signs: Map<number, string | null>
  vendor: Map<number, boolean>
  marks: number[][]
  windowCalls: string[]
  approaches: { owner: number; run: () => void }[]
  sounds: number
  clock: { now: number }
  answers: { title: (string | null)[]; greeting: (string | null)[]; count: (number | null)[]; price: (number | null)[]; confirm: boolean[] }
  bag: (ItemStack | null)[]
  defs: Map<string, Partial<ItemDef>>
  gold: { value: number }
  winOpen: { value: boolean }
  dead: { value: boolean }
}

function fake(): Fake {
  const f: Fake = {
    sent: [],
    errors: [],
    infos: [],
    lines: [],
    chat: [],
    signs: new Map(),
    vendor: new Map(),
    marks: [],
    windowCalls: [],
    approaches: [],
    sounds: 0,
    clock: { now: 10_000 },
    answers: { title: [], greeting: [], count: [], price: [], confirm: [] },
    bag: Array.from({ length: 20 }, () => null),
    defs: new Map(),
    gold: { value: 1_000_000 },
    winOpen: { value: false },
    dead: { value: false },
  } as unknown as Fake
  f.io = {
    send: msg => {
      f.sent.push(msg)
      return true
    },
    selfId: () => SELF,
    selfName: () => 'Me',
    selfDead: () => f.dead.value,
    gold: () => f.gold.value,
    bagItem: bag => f.bag[bag] ?? null,
    itemDef: code => (f.defs.has(code) ? ({ code, ...f.defs.get(code) } as ItemDef) : undefined),
    itemName: code => (code === 'ITEM_ETC_HP_POTION_01' ? 'HP Recovery Herb' : code),
    error: text => f.errors.push(text),
    info: text => f.infos.push(text),
    systemLine: text => f.lines.push(text),
    chatLine: (name, text, self) => f.chat.push([name, text, self]),
    markBags: slots => f.marks.push([...slots].sort((a, b) => a - b)),
    setSign: (id, title) => f.signs.set(id, title),
    setVendor: (id, on) => f.vendor.set(id, on),
    approach: (owner, run) => f.approaches.push({ owner, run }),
    window: what => {
      f.windowCalls.push(what)
      if (what === 'open') f.winOpen.value = true
      if (what === 'close') f.winOpen.value = false
    },
    windowOpen: () => f.winOpen.value,
    saleSound: () => f.sounds++,
    now: () => f.clock.now,
    askTitle: async () => f.answers.title.shift() ?? null,
    askGreeting: async () => f.answers.greeting.shift() ?? null,
    askCount: async () => f.answers.count.shift() ?? null,
    askPrice: async () => f.answers.price.shift() ?? null,
    confirm: async () => f.answers.confirm.shift() ?? false,
  }
  return f
}

function controller(): { c: StallController; f: Fake } {
  const f = fake()
  const c = new StallController(f.io)
  c.onMessage({ t: 'worldEnter', self: { id: SELF, kind: 'player', name: 'Me', model: 'CHAR_CH_MAN_ADVENTURER', level: 5, pos: [0, 0, 0], yaw: 0 }, world: {} as never, entities: [] })
  f.windowCalls.length = 0
  f.marks.length = 0
  return { c, f }
}

const lastSent = (f: Fake) => f.sent[f.sent.length - 1]

describe('stall controller', () => {
  it('sets and clears the sign and the vendor pose from EntityState and entityUpdate', () => {
    const { c, f } = controller()
    c.entityAdded(OWNER, { kind: 'player', stall: 'Cheap pots' } as EntityState)
    expect(f.signs.get(OWNER)).toBe('Cheap pots')
    expect(f.vendor.get(OWNER)).toBe(true)
    expect(c.hasStall(OWNER)).toBe(true)
    // A title change keeps the pose (no second SIT_DOWN).
    f.vendor.clear()
    c.onMessage({ t: 'entityUpdate', id: OWNER, stall: 'Cheaper pots' })
    expect(f.signs.get(OWNER)).toBe('Cheaper pots')
    expect(f.vendor.has(OWNER)).toBe(false)
    c.onMessage({ t: 'entityUpdate', id: OWNER, stall: '' })
    expect(f.signs.get(OWNER)).toBe(null)
    expect(f.vendor.get(OWNER)).toBe(false)
    expect(c.hasStall(OWNER)).toBe(false)
    // Unrelated updates leave it alone; players without a stall get nothing.
    c.onMessage({ t: 'entityUpdate', id: OWNER, hp: 5 })
    c.entityAdded(8, { kind: 'player' } as EntityState)
    expect(f.signs.has(8)).toBe(false)
    c.entityAdded(9, { kind: 'player', stall: 'x' } as EntityState)
    c.entityRemoved(9)
    expect(c.hasStall(9)).toBe(false)
  })

  it('opens a stall from the MENU row and /stall with the name prompt', async () => {
    const { c, f } = controller()
    f.answers.title.push("Me's stall.")
    c.menu()
    await Promise.resolve()
    await Promise.resolve()
    expect(lastSent(f)).toEqual({ t: 'stallCreate', title: "Me's stall." })
    expect(valid(lastSent(f)!)).toBe(true)
    // `/stall <title>` skips the prompt; a cancelled prompt sends nothing.
    c.command('  Best prices  ')
    await Promise.resolve()
    expect(lastSent(f)).toEqual({ t: 'stallCreate', title: 'Best prices' })
    const n = f.sent.length
    f.answers.title.push(null)
    c.command('')
    await Promise.resolve()
    await Promise.resolve()
    expect(f.sent.length).toBe(n)
    expect(STALL_COMMAND).toBe('/stall')
  })

  it('shows the owner window, marks the listed bag slots, and clears everything on close', () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(SELF, { state: 'modify', title: 'Mine' })))
    expect(f.windowCalls).toEqual(['open'])
    expect(f.signs.get(SELF)).toBe('Mine')
    expect(f.vendor.get(SELF)).toBe(true)
    c.onMessage(stallMsg(view(SELF, { state: 'modify', title: 'Mine' }, [listing('ITEM_A', 1, 5, 3), listing('ITEM_B', 2, 7, 11)])))
    expect(f.windowCalls).toEqual(['open', 'render'])
    expect(f.marks[f.marks.length - 1]).toEqual([3, 11])
    c.onMessage(stallMsg(null, 'closed'))
    expect(f.marks[f.marks.length - 1]).toEqual([])
    expect(f.windowCalls[f.windowCalls.length - 1]).toBe('close')
    expect(f.signs.get(SELF)).toBe(null)
    expect(f.vendor.get(SELF)).toBe(false)
    expect(f.infos).toEqual([t('stall.ownClosed')])
  })

  it("consumes the owner's ground clicks with one toast per burst", () => {
    const { c, f } = controller()
    expect(c.beforeGroundMove()).toBe(false)
    c.onMessage(stallMsg(view(SELF, { state: 'modify' })))
    expect(c.beforeGroundMove()).toBe(true)
    expect(c.beforeGroundMove()).toBe(true)
    expect(f.errors).toEqual([t('stall.closeFirst')])
    f.clock.now += CLOSE_FIRST_TOAST_MS
    expect(c.beforeGroundMove()).toBe(true)
    expect(f.errors).toHaveLength(2)
    expect(c.blockedClick()).toBe(true)
    c.onMessage(stallMsg(null))
    expect(c.beforeGroundMove()).toBe(false)
    expect(c.blockedClick()).toBe(false)
  })

  it('lists a bag stack: count, then price, then stallItem in the first free slot', async () => {
    const { c, f } = controller()
    f.bag[5] = { code: 'ITEM_ETC_HP_POTION_01', count: 40 }
    c.onMessage(stallMsg(view(SELF, { state: 'modify' }, [listing('ITEM_A', 1, 5, 2)])))
    f.answers.count.push(25)
    f.answers.price.push(4500)
    expect(c.bagAction(5)).toBe(true)
    await new Promise(r => setTimeout(r, 0))
    expect(lastSent(f)).toEqual({ t: 'stallItem', slot: 1, bag: 5, count: 25, price: 4500 })
    expect(valid(lastSent(f)!)).toBe(true)
    // Dropped on a taken row: that row is replaced.
    f.bag[6] = { code: 'ITEM_B', count: 1 }
    f.answers.price.push(99)
    await c.listBag(6, 0)
    expect(lastSent(f)).toEqual({ t: 'stallItem', slot: 0, bag: 6, count: 1, price: 99 })
  })

  it('refuses to list starter items, listed slots and anything while open', async () => {
    const { c, f } = controller()
    f.bag[1] = { code: 'ITEM_CH_SWORD_01_A_DEF', count: 1 }
    f.defs.set('ITEM_CH_SWORD_01_A_DEF', { canTrade: false })
    f.bag[2] = { code: 'ITEM_A', count: 1 }
    c.onMessage(stallMsg(view(SELF, { state: 'modify' }, [listing('ITEM_A', 1, 5, 2)])))
    await c.listBag(1, -1)
    await c.listBag(2, -1)
    c.onMessage(stallMsg(view(SELF, { state: 'open' }, [listing('ITEM_A', 1, 5, 2)])))
    f.bag[3] = { code: 'ITEM_C', count: 1 }
    await c.listBag(3, -1)
    expect(f.errors).toEqual([t('stall.notTradable'), t('stall.alreadyListed'), t('stall.modifyFirst')])
    expect(f.sent.filter(m => m.t === 'stallItem')).toEqual([])
    // Not stalling: the bag's right click is not ours.
    c.onMessage(stallMsg(null))
    expect(c.bagAction(3)).toBe(false)
  })

  it('does not list when the bag slot changed during the dialogs', async () => {
    const { c, f } = controller()
    f.bag[4] = { code: 'ITEM_A', count: 1 }
    c.onMessage(stallMsg(view(SELF, { state: 'modify' })))
    f.io.askPrice = async () => {
      f.bag[4] = { code: 'ITEM_Z', count: 1 }
      return 10
    }
    await c.listBag(4, -1)
    expect(f.sent.filter(m => m.t === 'stallItem')).toEqual([])
  })

  it('changes a price with the pencil and takes a listing back, only in modify', async () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(SELF, { state: 'modify' }, [null, listing('ITEM_A', 3, 50, 8)])))
    f.answers.price.push(75)
    await c.editPrice(1)
    expect(lastSent(f)).toEqual({ t: 'stallItem', slot: 1, bag: 8, count: 3, price: 75 })
    c.remove(1)
    expect(lastSent(f)).toEqual({ t: 'stallItemRemove', slot: 1 })
    c.onMessage(stallMsg(view(SELF, { state: 'open' }, [null, listing('ITEM_A', 3, 50, 8)])))
    const n = f.sent.length
    await c.editPrice(1)
    c.remove(1)
    expect(f.sent.length).toBe(n)
    expect(f.errors).toEqual([t('stall.modifyFirst'), t('stall.modifyFirst')])
  })

  it('switches Open / Modify, refusing to open an empty stall', () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(SELF, { state: 'modify' })))
    c.toggleState()
    expect(f.errors).toEqual([t('stall.nothing')])
    c.onMessage(stallMsg(view(SELF, { state: 'modify' }, [listing('ITEM_A', 1, 1, 0)])))
    c.toggleState()
    expect(lastSent(f)).toEqual({ t: 'stallOpen', open: true })
    c.onMessage(stallMsg(view(SELF, { state: 'open' }, [listing('ITEM_A', 1, 1, 0)])))
    c.toggleState()
    expect(lastSent(f)).toEqual({ t: 'stallOpen', open: false })
  })

  it('edits the title and greeting (empty = the retail default)', async () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(SELF, { state: 'modify', title: 'Old', greeting: 'Hi' })))
    f.answers.title.push('New title')
    await c.editTitle()
    expect(lastSent(f)).toEqual({ t: 'stallText', title: 'New title' })
    f.answers.greeting.push('')
    await c.editGreeting()
    expect(lastSent(f)).toEqual({ t: 'stallText', greeting: "Welcome to Me's stall." })
    expect(valid(lastSent(f)!)).toBe(true)
  })

  it('visits a stall on a click, walks up once on too_far, and opens the visitor window', () => {
    const { c, f } = controller()
    expect(c.clickPlayer(OWNER)).toBe(false)
    c.entityAdded(OWNER, { kind: 'player', stall: 'Pots' } as EntityState)
    expect(c.clickPlayer(OWNER)).toBe(true)
    expect(lastSent(f)).toEqual({ t: 'stallVisit', owner: OWNER })
    c.onMessage({ t: 'actionResult', re: 'stallVisit', ok: false, reason: 'too_far' })
    expect(f.approaches.map(a => a.owner)).toEqual([OWNER])
    expect(f.errors).toEqual([])
    f.approaches[0]!.run()
    expect(f.sent.filter(m => m.t === 'stallVisit')).toHaveLength(2)
    // Still too far after the walk: now it is said.
    c.onMessage({ t: 'actionResult', re: 'stallVisit', ok: false, reason: 'too_far' })
    expect(f.approaches).toHaveLength(1)
    expect(f.errors).toHaveLength(1)
    c.onMessage(stallMsg(view(OWNER)))
    expect(f.windowCalls).toEqual(['open'])
    // A second click only brings the window forward.
    const n = f.sent.length
    expect(c.clickPlayer(OWNER)).toBe(true)
    expect(f.sent.length).toBe(n)
  })

  it('buys after a confirmation with the values shown at the click; a listing changed meanwhile is not bought', async () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(OWNER, {}, [listing('ITEM_ETC_HP_POTION_01', 50, 180)])))
    let resolve!: (v: boolean) => void
    f.io.confirm = () => new Promise(r => (resolve = r))
    let done = c.buy(0)
    // The owner changes the price while the buyer reads the box: nothing is sent, the buyer is told (SOC-2).
    c.onMessage(stallMsg(view(OWNER, {}, [listing('ITEM_ETC_HP_POTION_01', 50, 900)])))
    resolve(true)
    await done
    expect(f.sent.filter(m => m.t === 'stallBuy')).toEqual([])
    expect(f.errors).toEqual([t('stall.fail.stall_changed')])
    f.errors.length = 0
    c.onMessage(stallMsg(view(OWNER, {}, [listing('ITEM_ETC_HP_POTION_01', 50, 180)])))
    done = c.buy(0)
    // An unrelated view refresh (a visitor came) with the same listing still buys what was shown.
    c.onMessage(stallMsg(view(OWNER, {}, [listing('ITEM_ETC_HP_POTION_01', 50, 180)])))
    resolve(true)
    await done
    expect(lastSent(f)).toEqual({ t: 'stallBuy', owner: OWNER, slot: 0, code: 'ITEM_ETC_HP_POTION_01', count: 50, price: 180 })
    c.onMessage({ t: 'actionResult', re: 'stallBuy', ok: true })
    expect(f.lines).toEqual(['You bought HP Recovery Herb x50 for 180 gold.'])
    c.onMessage({ t: 'actionResult', re: 'stallBuy', ok: false, reason: 'stall_changed' })
    expect(f.errors).toEqual([t('stall.fail.stall_changed')])
  })

  it('does not buy in modify, when cancelled, or without the gold', async () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(OWNER, { state: 'modify' }, [listing('ITEM_A', 1, 500)])))
    await c.buy(0)
    expect(f.errors).toEqual([t('stall.underConstruction')])
    c.onMessage(stallMsg(view(OWNER, { state: 'open' }, [listing('ITEM_A', 1, 500)])))
    f.answers.confirm.push(false)
    await c.buy(0)
    f.gold.value = 499
    await c.buy(0)
    expect(f.errors[1]).toBe(t('stall.fail.not_enough_gold'))
    expect(f.sent.filter(m => m.t === 'stallBuy')).toEqual([])
  })

  it('shows the sale as a notice with the gold cue (the server writes the chat line)', () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(SELF, { state: 'open' }, [listing('ITEM_ETC_HP_POTION_01', 20, 100, 1)])))
    c.onMessage({ t: 'stallSold', slot: 0, buyer: 'Wei', code: 'ITEM_ETC_HP_POTION_01', count: 20, price: 100 })
    expect(f.infos).toEqual(['Wei bought item HP Recovery Herb x20.'])
    expect(f.lines).toEqual([])
    expect(f.sounds).toBe(1)
  })

  it('closes the visitor window with the reason, and leaves at once on the close button', async () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(OWNER)))
    c.onMessage(stallMsg(null, 'too_far'))
    expect(f.errors).toEqual([t('stall.end.too_far')])
    expect(f.winOpen.value).toBe(false)
    c.onMessage(stallMsg(view(OWNER)))
    await c.requestClose()
    expect(lastSent(f)).toEqual({ t: 'stallLeave' })
    expect(f.winOpen.value).toBe(false)
    expect(c.model.view).toBe(null)
    // A view still in flight does not reopen the window; the server's null afterwards says nothing more.
    c.onMessage(stallMsg(view(OWNER, { visitors: 2 })))
    expect(f.winOpen.value).toBe(false)
    expect(c.model.view).toBe(null)
    c.onMessage(stallMsg(null, 'left'))
    expect(f.errors).toHaveLength(1)
    // Visiting the same stall again works.
    c.visit(OWNER)
    c.onMessage(stallMsg(view(OWNER)))
    expect(f.winOpen.value).toBe(true)
    c.onMessage(stallMsg(null))
    expect(f.errors).toEqual([t('stall.end.too_far'), t('stall.closed')])
  })

  it('asks the owner before closing from the close button or Esc', async () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(SELF, { state: 'modify' })))
    f.answers.confirm.push(false)
    await c.requestClose()
    expect(f.sent.some(m => m.t === 'stallClose')).toBe(false)
    f.answers.confirm.push(true)
    await c.requestClose()
    expect(lastSent(f)).toEqual({ t: 'stallClose' })
    c.closeStall()
    expect(f.sent.filter(m => m.t === 'stallClose')).toHaveLength(2)
  })

  it('shows stall chat lines in the window and sends on the stall channel', () => {
    const { c, f } = controller()
    c.onMessage({ t: 'chat', channel: 'stall', fromId: OWNER, from: 'Mei', text: 'hello' })
    expect(f.chat).toEqual([])
    c.chat('ignored')
    expect(f.sent).toEqual([])
    c.onMessage(stallMsg(view(OWNER)))
    c.onMessage({ t: 'chat', channel: 'stall', fromId: OWNER, from: 'Mei', text: 'hello' })
    c.onMessage({ t: 'chat', channel: 'stall', fromId: SELF, from: 'Me', text: 'hi' })
    c.onMessage({ t: 'chat', channel: 'local', fromId: OWNER, from: 'Mei', text: 'local' })
    expect(f.chat).toEqual([['Mei', 'hello', false], ['Me', 'hi', true]])
    c.chat('how much?')
    expect(lastSent(f)).toEqual({ t: 'chat', text: 'how much?', channel: 'stall' })
    expect(valid(lastSent(f)!)).toBe(true)
  })

  it('words refusals with the stall lines, the server message for places, else the HUD line', () => {
    const { c, f } = controller()
    c.onMessage({ t: 'actionResult', re: 'stallCreate', ok: false, reason: 'wrong_place', message: 'Too close to Guard Kim.' })
    c.onMessage({ t: 'actionResult', re: 'stallCreate', ok: false, reason: 'wrong_place' })
    c.onMessage({ t: 'actionResult', re: 'stallCreate', ok: false, reason: 'in_combat' })
    c.onMessage({ t: 'actionResult', re: 'stallCreate', ok: false, reason: 'mounted' })
    c.onMessage({ t: 'actionResult', re: 'stallBuy', ok: false, reason: 'rate_limited' })
    c.onMessage({ t: 'actionResult', re: 'itemUse', ok: false, reason: 'stalling' })
    expect(f.errors).toEqual(['Too close to Guard Kim.', t('stall.townOnly'), 'You cannot use the stall during the battle.', t('action.fail.mounted')])
  })

  it('forgets the stall on world enter', () => {
    const { c, f } = controller()
    c.onMessage(stallMsg(view(SELF, { state: 'modify' }, [listing('ITEM_A', 1, 1, 2)])))
    c.onMessage({ t: 'worldEnter', self: { id: SELF, kind: 'player', name: 'Me', model: 'M', level: 5, pos: [0, 0, 0], yaw: 0 }, world: {} as never, entities: [] })
    expect(c.model.view).toBe(null)
    expect(f.marks[f.marks.length - 1]).toEqual([])
    expect(c.beforeGroundMove()).toBe(false)
  })

  it('sets the vendor pose on the view when it has no idle driver', () => {
    const calls: [string, string | undefined][] = []
    const v = { setIdle: (k: string, tr?: string) => calls.push([k, tr]) }
    setVendorPose(v as never, true)
    setVendorPose(v as never, false)
    expect(calls).toEqual([
      ['vendor', 'play'],
      ['stand', 'play'],
    ])
  })

  it('is the ST-C line of the feature list and has a mock', () => {
    expect(WORLD_FEATURES).toContain(stallFeature)
    expect(typeof stallMock.handle).toBe('function')
  })
})

// ---- the mock (offline UI work) -----------------------------------------------------------------------------------

describe('stall mock', () => {
  function world() {
    const sent: { to: string; msg: ServerMessage }[] = []
    const results: { re: string; ok: boolean; reason?: string }[] = []
    let now = 1_000
    const inv = { bagSize: 10, bag: [{ code: 'ITEM_ETC_HP_POTION_01', count: 20 }, { code: 'ITEM_CH_SWORD_01_A_DEF', count: 1 }, null, null, null, null, null, null, null, null], equip: {}, gold: 500 }
    const me = { bot: false, nextThink: Infinity, state: { id: SELF, kind: 'player', name: 'Me', model: 'M', level: 5, pos: [0, 0, 0], yaw: 0 }, player: { prog: { dead: false, inventory: inv } } }
    const bot = { bot: true, nextThink: 0, state: { id: OWNER, kind: 'player', name: 'MeiHua', model: 'M', level: 3, pos: [3, 0, 0], yaw: 0 } }
    const items = new Map<string, Partial<ItemDef>>([
      ['ITEM_ETC_HP_POTION_01', { code: 'ITEM_ETC_HP_POTION_01', name: 'HP Recovery Herb', maxStack: 50 }],
      ['ITEM_CH_SWORD_01_A_DEF', { code: 'ITEM_CH_SWORD_01_A_DEF', canTrade: false, maxStack: 1 }],
    ])
    const conn = { deliver: () => {}, entityId: SELF, account: 'a' }
    const ents = new Map<number, unknown>([[SELF, me], [OWNER, bot]])
    const ctx = {
      content: { items },
      now: () => now,
      result: (_c: unknown, re: string, ok: boolean, reason?: string) => results.push(reason ? { re, ok, reason } : { re, ok }),
      send: (_c: unknown, msg: ServerMessage) => sent.push({ to: 'me', msg }),
      broadcast: (msg: ServerMessage) => sent.push({ to: 'all', msg }),
      snapshot: (e: { state: EntityState }) => e.state,
      dist: (a: { state: EntityState }, b: { state: EntityState }) => Math.hypot(a.state.pos[0] - b.state.pos[0], a.state.pos[2] - b.state.pos[2]),
      selfOf: () => me,
      entity: (id: number) => ents.get(id),
      entities: () => ents.values(),
    }
    const handle = (msg: ClientMessage) => stallMock.handle!(ctx as never, conn as never, msg)
    return { sent, results, inv, me, bot, ctx, conn, handle, tick: (ms: number) => ((now += ms), stallMock.tick!(ctx as never, now)) }
  }

  it("runs the bot's stall and sells from it with the S1 guard", () => {
    const w = world()
    stallMock.enter!(w.ctx as never, w.conn as never)
    expect(w.bot.state).toMatchObject({ stall: "MeiHua's stall." })
    expect(w.handle({ t: 'stallVisit', owner: OWNER })).toBe(true)
    const view = w.sent.map(s => s.msg).filter(m => m.t === 'stall').pop() as Extract<ServerMessage, { t: 'stall' }>
    expect(view.stall).toMatchObject({ owner: OWNER, state: 'open', visitors: 1 })
    const potion = view.stall!.items[0]!
    expect(potion.bag).toBe(undefined)
    w.handle({ t: 'stallBuy', owner: OWNER, slot: 0, code: potion.stack.code, count: potion.stack.count, price: potion.price + 1 })
    expect(w.results.pop()).toEqual({ re: 'stallBuy', ok: false, reason: 'stall_changed' })
    w.handle({ t: 'stallBuy', owner: OWNER, slot: 0, code: potion.stack.code, count: potion.stack.count, price: potion.price })
    expect(w.results.pop()).toEqual({ re: 'stallBuy', ok: true })
    expect(w.inv.gold).toBe(500 - potion.price)
  })

  it('opens your own stall, refuses starter items, drops moves, and a bot buys while it is open', () => {
    const w = world()
    w.handle({ t: 'stallCreate', title: '' })
    expect(w.me.state).toMatchObject({ stall: "Me's stall." })
    expect(w.handle({ t: 'moveTo', x: 5, z: 5 })).toBe(true)
    w.handle({ t: 'stallItem', slot: 0, bag: 1, count: 1, price: 10 })
    expect(w.results.pop()).toMatchObject({ ok: false, reason: 'not_usable' })
    w.handle({ t: 'stallOpen', open: true })
    expect(w.results.pop()).toMatchObject({ ok: false, reason: 'not_complete' })
    w.handle({ t: 'stallItem', slot: 0, bag: 0, count: 5, price: 300 })
    w.handle({ t: 'stallItem', slot: 1, bag: 0, count: 5, price: 300 })
    expect(w.results.slice(-2)).toEqual([{ re: 'stallItem', ok: true }, { re: 'stallItem', ok: false, reason: 'invalid_slot' }])
    w.handle({ t: 'stallOpen', open: true })
    w.sent.length = 0
    w.tick(12_000)
    const kinds = w.sent.map(s => s.msg.t)
    expect(kinds).toEqual(['inventoryUpdate', 'statsDelta', 'stallSold', 'chat', 'stall'])
    expect(w.inv.gold).toBe(800)
    expect(w.inv.bag[0]).toEqual({ code: 'ITEM_ETC_HP_POTION_01', count: 15 })
    w.handle({ t: 'stallClose' })
    expect(w.me.state).not.toHaveProperty('stall')
    expect(w.handle({ t: 'moveTo', x: 5, z: 5 })).toBe(false)
  })
})
