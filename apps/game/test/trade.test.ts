/**
 * Lane TR-C, the exchange client (docs/SYSTEMS_SOCIAL.md §9.2, §10.8): the state model applies `trade` / `tradeEnd`,
 * the Confirm button cycles, the M8 lock marks follow `mine.items[].bag`, a partner change after our lock flags
 * "changed", `/trade` without a player target toasts, and a `too_far` request walks up once. DOM-free: TradeController
 * is driven through a fake TradeIo, and every frame it sends must pass the shared validator.
 */
import { parseClientMessage, TRADE_END_REASONS, TRADE_SLOTS, type ClientMessage, type ItemStack, type ServerMessage, type TradeItem, type TradeSide, type TradeState } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { enTrade } from '../src/i18n/en-trade.ts'
import { t } from '../src/i18n/index.ts'
import {
  confirmButton,
  confirmIntent,
  offerChanged,
  offeredBags,
  pendingTrade,
  requestLine,
  TradeBook,
  tradeEndText,
  tradeFailText,
  tradeIntent,
  tradeSecondsLeft,
  TRADE_LOG_MAX,
} from '../src/hud/trade-state.ts'
import { matchPrefix } from '../src/world/chat.ts'
import { TradeController, type TradeIo, type TradeTarget } from '../src/world/features/trade.ts'

// ---- fixtures -------------------------------------------------------------------------------------------------------

const stack = (code: string, count = 1, extra: Partial<ItemStack> = {}): ItemStack => ({ code, count, ...extra })

function side(items: (TradeItem | null)[] = [], extra: Partial<TradeSide> = {}): TradeSide {
  const full = Array.from({ length: TRADE_SLOTS }, (_, i) => items[i] ?? null)
  return { items: full, gold: 0, locked: false, accepted: false, ...extra }
}

function trade(mine: TradeSide = side(), theirs: TradeSide = side(), extra: Partial<TradeState> = {}): Extract<ServerMessage, { t: 'trade' }> {
  return { t: 'trade', trade: { partner: 202, name: 'MeiHua', level: 12, mine, theirs, ...extra } }
}

const end = (reason: (typeof TRADE_END_REASONS)[number], extra: { name?: string; message?: string } = {}): ServerMessage => ({ t: 'tradeEnd', reason, ...extra })
const result = (re: 'tradeRequest' | 'tradeRespond' | 'tradeOffer' | 'tradeLock', ok: boolean, reason?: string, message?: string): ServerMessage =>
  ({ t: 'actionResult', re, ok, ...(reason ? { reason } : {}), ...(message ? { message } : {}) }) as ServerMessage

function fakeIo(opts: { target?: TradeTarget | null; bag?: (ItemStack | null)[]; gold?: number; answer?: number | null } = {}) {
  const sent: ClientMessage[] = []
  const lines: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  const asks: { title: string; text: string; min: number; max: number; initial: number }[] = []
  const approaches: { id: number; run: () => void }[] = []
  const bag = opts.bag ?? [stack('ITEM_ETC_HP_POTION_01', 50), stack('ITEM_CH_SWORD_01_A', 1, { plus: 3, durability: 10 }), null]
  let now = 1000
  let changes = 0
  let target = opts.target === undefined ? null : opts.target
  const io: TradeIo = {
    send: msg => {
      if (!msg) return false
      sent.push(msg)
      return true
    },
    selfId: () => 101,
    selfName: () => 'Hero',
    target: () => target,
    line: text => lines.push(text),
    error: text => errors.push(text),
    info: text => infos.push(text),
    bagItem: i => bag[i] ?? null,
    itemName: s => (s.plus ? `${s.code} (+${s.plus})` : s.code),
    bagGold: () => opts.gold ?? 5000,
    askAmount: o => {
      asks.push(o)
      return Promise.resolve(opts.answer === undefined ? o.initial : opts.answer)
    },
    approach: (id, run) => approaches.push({ id, run }),
    now: () => now,
    changed: () => {
      changes++
    },
  }
  return {
    io,
    sent,
    lines,
    errors,
    infos,
    asks,
    approaches,
    bag,
    setTarget: (v: TradeTarget | null) => (target = v),
    advance: (ms: number) => (now += ms),
    get now() {
      return now
    },
    get changes() {
      return changes
    },
  }
}

const flush = () => new Promise(r => setTimeout(r, 0))

/** Every frame the controller sent passes the shared validator unchanged. */
function expectValid(sent: ClientMessage[]): void {
  for (const m of sent) expect(parseClientMessage(JSON.stringify(m)), JSON.stringify(m)).toEqual({ ok: true, msg: m })
}

// ---- the model ------------------------------------------------------------------------------------------------------

describe('TradeBook applies trade / tradeEnd', () => {
  it('opens on the first trade state with the retail start line and a status line', () => {
    const book = new TradeBook()
    expect(book.open).toBe(false)
    const ev = book.apply(trade())
    expect(ev?.kind).toBe('opened')
    expect(book.open).toBe(true)
    expect(book.partnerName).toBe('MeiHua')
    expect(book.log).toEqual([t('trade.started', { name: 'MeiHua' }), t('trade.status.offer')])
  })

  it('ends on tradeEnd with the reason line and forgets the state', () => {
    const book = new TradeBook()
    book.apply(trade())
    const ev = book.apply(end('done', { name: 'MeiHua' }))
    expect(ev).toEqual({ kind: 'ended', reason: 'done', text: 'Exchanging with MeiHua is completed.', partner: 'MeiHua' })
    expect(book.open).toBe(false)
    expect(book.log).toEqual([])
    expect(book.apply({ t: 'pong' } as unknown as ServerMessage)).toBeNull()
  })

  it('a partner change after our lock drops the lock and flags "changed" until we lock again', () => {
    const book = new TradeBook()
    book.apply(trade())
    book.apply(trade(side([], { locked: true })))
    const ev = book.apply(trade(side(), side([{ stack: stack('ITEM_CH_SWORD_01_A') }])))
    expect(ev).toMatchObject({ kind: 'updated', partnerChanged: true, lockDropped: true })
    expect(book.changed).toBe(true)
    expect(book.log).toContain('The other player changed the offer.')
    book.apply(trade(side([], { locked: true }), side([{ stack: stack('ITEM_CH_SWORD_01_A') }])))
    expect(book.changed).toBe(false)
  })

  it('a partner change while we are unlocked flashes but does not flag "changed"', () => {
    const book = new TradeBook()
    book.apply(trade())
    const ev = book.apply(trade(side(), side([], { gold: 500 })))
    expect(ev).toMatchObject({ kind: 'updated', partnerChanged: true, lockDropped: false })
    expect(book.changed).toBe(false)
  })

  it('compares +N and durability, not only the code (a +5 swapped for a +0 is a change, T1)', () => {
    const a = side([{ stack: stack('ITEM_CH_SWORD_01_A', 1, { plus: 5 }) }])
    expect(offerChanged(a, side([{ stack: stack('ITEM_CH_SWORD_01_A', 1, { plus: 0 }) }]))).toBe(true)
    expect(offerChanged(a, side([{ stack: stack('ITEM_CH_SWORD_01_A', 1, { plus: 5, durability: 3 }) }]))).toBe(true)
    expect(offerChanged(a, side([{ stack: stack('ITEM_CH_SWORD_01_A', 1, { plus: 5 }) }], { locked: true }))).toBe(false)
  })

  it('keeps at most TRADE_LOG_MAX lines and never repeats the last one', () => {
    const book = new TradeBook()
    book.apply(trade())
    for (let g = 1; g <= 10; g++) {
      book.apply(trade(side([], { locked: true }), side([], { gold: g })))
      book.apply(trade(side([], { locked: true }), side([], { gold: g })))
    }
    expect(book.log.length).toBeLessThanOrEqual(TRADE_LOG_MAX)
    for (let i = 1; i < book.log.length; i++) expect(book.log[i]).not.toBe(book.log[i - 1])
  })

  it('a new partner (another exchange) starts a fresh log', () => {
    const book = new TradeBook()
    book.apply(trade())
    const ev = book.apply(trade(side(), side(), { partner: 303, name: 'BoLin' }))
    expect(ev?.kind).toBe('opened')
    expect(book.log[0]).toBe(t('trade.started', { name: 'BoLin' }))
  })
})

describe('the Confirm button cycles (§9.2)', () => {
  it('Confirm → Waiting… → Exchange → Waiting…', () => {
    const steps = [
      [side(), side(), 'lock', 'Confirm', true, 'tradeLock'],
      [side([], { locked: true }), side(), 'waitLock', 'Waiting…', false, null],
      [side([], { locked: true }), side([], { locked: true }), 'accept', 'Exchange', true, 'tradeAccept'],
      [side([], { locked: true, accepted: true }), side([], { locked: true }), 'waitAccept', 'Waiting…', false, null],
    ] as const
    for (const [mine, theirs, step, label, enabled, sends] of steps) {
      expect(confirmButton({ mine, theirs })).toEqual({ step, label, enabled })
      expect(confirmIntent({ mine, theirs })?.t ?? null).toBe(sends)
    }
  })

  it('the text box says "Waiting for other player\'s approval." after our Exchange', () => {
    const book = new TradeBook()
    book.apply(trade())
    book.apply(trade(side([], { locked: true, accepted: true }), side([], { locked: true })))
    expect(book.statusLine()).toBe("Waiting for other player's approval.")
    book.apply(trade(side([], { locked: true }), side([], { locked: true, accepted: true })))
    expect(book.statusLine()).toBe(t('trade.status.partnerAccepted', { name: 'MeiHua' }))
  })
})

describe('M8 marks follow mine.items[].bag', () => {
  it('offeredBags lists the own bag slots only', () => {
    expect(offeredBags(null).size).toBe(0)
    const s = trade(side([{ stack: stack('A'), bag: 4 }, null, { stack: stack('B', 3), bag: 0 }]), side([{ stack: stack('C') }])).trade
    expect([...offeredBags(s)].sort()).toEqual([0, 4])
  })
})

// ---- the controller -------------------------------------------------------------------------------------------------

describe('TradeController', () => {
  const player = (extra: Partial<TradeTarget> = {}): TradeTarget => ({ id: 202, name: 'MeiHua', kind: 'player', hp: 100, ...extra })

  it('the Exchange button shows for other live players while no exchange is open', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    expect(ctl.canExchange(player())).toBe(true)
    expect(ctl.canExchange(player({ id: 101 }))).toBe(false)
    expect(ctl.canExchange(player({ kind: 'mob' }))).toBe(false)
    expect(ctl.canExchange(player({ kind: 'npc' }))).toBe(false)
    expect(ctl.canExchange(player({ hp: 0 }))).toBe(false)
    ctl.handle(trade())
    expect(ctl.canExchange(player())).toBe(false)
  })

  it('/trade with no player target toasts and sends nothing', () => {
    const f = fakeIo({ target: null })
    const ctl = new TradeController(f.io)
    ctl.command()
    expect(f.errors).toEqual([t('trade.noTarget')])
    f.setTarget({ id: 7, name: 'Mangyang', kind: 'mob', hp: 50 })
    ctl.command()
    expect(f.errors).toHaveLength(2)
    expect(f.sent).toEqual([])
    f.setTarget(player())
    ctl.command()
    expect(f.sent).toEqual([{ t: 'tradeRequest', target: 202 }])
    expectValid(f.sent)
  })

  it('/trade and /exchange are client prefixes (never GM commands), case-insensitive', () => {
    const prefixes = ['/trade', '/exchange', '/w']
    expect(matchPrefix(prefixes, '/trade')?.prefix).toBe('/trade')
    expect(matchPrefix(prefixes, '/Exchange')?.prefix).toBe('/exchange')
    expect(matchPrefix(prefixes, '/traders')).toBeNull()
  })

  it('a sent request prints the retail "Applying" line on ok', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    ctl.requestTrade(player())
    ctl.handle(result('tradeRequest', true))
    expect(f.lines).toEqual(['Applying for a trade to MeiHua.'])
  })

  it('too_far walks up once and asks again; a second too_far toasts', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    ctl.requestTrade(player())
    ctl.handle(result('tradeRequest', false, 'too_far'))
    expect(f.errors).toEqual([])
    expect(f.approaches.map(a => a.id)).toEqual([202])
    f.approaches[0]!.run()
    expect(f.sent).toEqual([{ t: 'tradeRequest', target: 202 }, { t: 'tradeRequest', target: 202 }])
    ctl.handle(result('tradeRequest', false, 'too_far'))
    expect(f.approaches).toHaveLength(1)
    expect(f.errors).toEqual([t('trade.fail.too_far')])
  })

  it('a refusal prefers the server sentence, then the trade wording', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    ctl.handle(result('tradeOffer', false, 'not_usable'))
    ctl.handle(result('tradeLock', false, 'trading', 'Already locked.'))
    expect(f.errors).toEqual(['The selected item cannot be traded.', 'Already locked.'])
    expect(tradeFailText(undefined)).toBe(t('action.fail.generic'))
  })

  it('the request popup: shown on tradeRequested, answered once, dropped on expiry', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    ctl.handle({ t: 'tradeRequested', from: 202, name: 'MeiHua', level: 12, expiresInMs: 30_000 })
    expect(ctl.request).toMatchObject({ from: 202, name: 'MeiHua', level: 12, expiresAt: f.now + 30_000 })
    expect(requestLine(ctl.request!)).toBe('MeiHua (Lv 12) applied for an exchange. Will you accept it?')
    expect(tradeSecondsLeft(ctl.request!, f.now + 29_001)).toBe(1)
    ctl.respond(false)
    ctl.respond(true)
    expect(f.sent).toEqual([{ t: 'tradeRespond', from: 202, accept: false }])
    expect(f.lines).toEqual([t('trade.declinedSelf', { name: 'MeiHua' })])
    ctl.handle({ t: 'tradeRequested', from: 202, name: 'MeiHua', level: 12, expiresInMs: 30_000 })
    ctl.tick(f.now + 30_000)
    expect(ctl.request).toBeNull()
    expect(pendingTrade({ t: 'tradeRequested', from: 1, name: 'x', level: 1, expiresInMs: -5 }, 10).expiresAt).toBe(10)
    expectValid(f.sent)
  })

  it('the exchange opening closes the popup and prints the start line; a lock drop prints the change line', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    ctl.handle({ t: 'tradeRequested', from: 202, name: 'MeiHua', level: 12, expiresInMs: 30_000 })
    ctl.handle(trade())
    expect(ctl.request).toBeNull()
    expect(f.lines).toEqual(['You started to exchange with MeiHua.'])
    ctl.handle(trade(side([], { locked: true })))
    ctl.handle(trade(side(), side([], { gold: 10 })))
    expect(ctl.flash).toBe(true)
    expect(f.lines).toContain('The other player changed the offer.')
  })

  it('offers: whole stack by default, Shift asks for the amount, an offered slot or empty slot sends nothing', async () => {
    const f = fakeIo({ answer: 20 })
    const ctl = new TradeController(f.io)
    expect(ctl.offer(0)).toBe(false) // no exchange: the right click falls through to use
    ctl.handle(trade())
    expect(ctl.offer(1)).toBe(true)
    expect(ctl.offer(2)).toBe(true) // empty slot
    expect(ctl.offer(0, true)).toBe(true)
    await flush()
    expect(f.asks).toEqual([{ title: t('trade.countTitle'), text: t('trade.countBody', { name: 'ITEM_ETC_HP_POTION_01', max: 50 }), min: 1, max: 50, initial: 50 }])
    expect(f.sent).toEqual([{ t: 'tradeOffer', bag: 1 }, { t: 'tradeOffer', bag: 0, count: 20 }])
    ctl.handle(trade(side([{ stack: stack('ITEM_CH_SWORD_01_A', 1, { plus: 3 }), bag: 1 }])))
    ctl.offer(1)
    expect(f.sent).toHaveLength(2)
    expectValid(f.sent)
  })

  it('the whole stack typed in the amount box sends no count', async () => {
    const f = fakeIo({ answer: 50 })
    const ctl = new TradeController(f.io)
    ctl.handle(trade())
    ctl.offer(0, true)
    await flush()
    expect(f.sent).toEqual([{ t: 'tradeOffer', bag: 0 }])
  })

  it('take, gold, confirm and cancel send valid frames', async () => {
    const f = fakeIo({ answer: 1234, gold: 5000 })
    const ctl = new TradeController(f.io)
    ctl.take(0)
    ctl.cancel()
    expect(f.sent).toEqual([])
    ctl.handle(trade(side([{ stack: stack('A'), bag: 3 }])))
    ctl.take(1) // empty trade slot
    ctl.take(0)
    ctl.gold()
    await flush()
    expect(f.asks[0]).toMatchObject({ min: 0, max: 5000, initial: 0 })
    ctl.confirm()
    ctl.cancel()
    expect(f.sent).toEqual([{ t: 'tradeTake', slot: 0 }, { t: 'tradeGold', amount: 1234 }, { t: 'tradeLock' }, { t: 'tradeCancel' }])
    expectValid(f.sent)
    ctl.handle(trade(side([], { locked: true })))
    ctl.gold()
    ctl.confirm() // waiting for the partner: nothing
    expect(f.sent).toHaveLength(4)
  })

  it('tradeEnd prints the reason line, toasts a cancel, and clears everything', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    ctl.handle(trade())
    ctl.handle(end('cancelled', { name: 'MeiHua' }))
    expect(ctl.book.open).toBe(false)
    expect(f.lines.at(-1)).toBe('MeiHua canceled the exchange.')
    expect(f.infos).toEqual(['MeiHua canceled the exchange.'])
    ctl.handle(trade())
    ctl.handle(end('done', { name: 'MeiHua' }))
    expect(f.lines.at(-1)).toBe('Exchanging with MeiHua is completed.')
    expect(f.infos).toHaveLength(1)
  })

  it('a new world visit forgets the exchange and the request', () => {
    const f = fakeIo()
    const ctl = new TradeController(f.io)
    ctl.handle(trade())
    ctl.handle({ t: 'tradeRequested', from: 202, name: 'MeiHua', level: 12, expiresInMs: 30_000 })
    ctl.handle({ t: 'worldEnter' } as unknown as ServerMessage)
    expect(ctl.book.open).toBe(false)
    expect(ctl.request).toBeNull()
  })
})

// ---- lines and strings ----------------------------------------------------------------------------------------------

describe('trade strings', () => {
  it('every TradeEndReason has a line, and the cancel names the other side only', () => {
    for (const reason of TRADE_END_REASONS) {
      const text = tradeEndText({ reason, name: 'MeiHua' }, 'MeiHua', 'Hero')
      expect(text, reason).not.toMatch(/trade\.end|\{/)
    }
    expect(tradeEndText({ reason: 'cancelled', name: 'Hero' }, 'MeiHua', 'Hero')).toBe('The exchange has been canceled.')
    expect(tradeEndText({ reason: 'done' }, null, null)).toBe(t('trade.end.doneAnon'))
    expect(tradeEndText({ reason: 'failed', message: "MeiHua's inventory is full." }, 'MeiHua', 'Hero')).toBe("The exchange failed. Nothing was traded. MeiHua's inventory is full.")
  })

  it('the lane file is spread into en', () => {
    for (const [k, v] of Object.entries(enTrade)) expect(en[k as keyof typeof en], k).toBe(v)
  })

  it('the intent builders refuse bad input', () => {
    expect(tradeIntent.request(0)).toBeNull()
    expect(tradeIntent.respond(-1, true)).toBeNull()
    expect(tradeIntent.offer(-1)).toBeNull()
    expect(tradeIntent.offer(0, 0)).toBeNull()
    expect(tradeIntent.take(TRADE_SLOTS)).toBeNull()
    expect(tradeIntent.gold(-5)).toBeNull()
    expect(tradeIntent.gold(1.5)).toBeNull()
  })
})
