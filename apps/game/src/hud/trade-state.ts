/**
 * The exchange model of lane TR-C (docs/SYSTEMS_SOCIAL.md §3, §9.2), DOM-free so tests drive it directly. The server
 * is the authority: `TradeBook` only mirrors the last `trade` state, remembers what changed between two states (the
 * partner's offer, a lock the partner's change dropped) and keeps the window's status lines.
 *
 * The Confirm button runs through four steps (§9.2): Confirm (lock your offer) → Waiting… (you locked, the partner has
 * not) → Exchange (both locked) → Waiting… (you pressed Exchange; the text box says "Waiting for other player's
 * approval."). Any change of either offer unlocks the other side on the server, so the steps can also go back.
 */
import { TRADE_SLOTS, type ActionFailReason, type ClientMessage, type ItemStack, type ServerMessage, type TradeEndReason, type TradeSide, type TradeState } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'

export type TradeRequestedMessage = Extract<ServerMessage, { t: 'tradeRequested' }>
export type TradeEndMessage = Extract<ServerMessage, { t: 'tradeEnd' }>

// ---- the incoming request ---------------------------------------------------------------------------------------

export interface PendingTrade {
  /** The requester's entity id (answer with tradeRespond {from}). */
  from: number
  name: string
  level: number
  /** Local ms (the caller's performance.now clock) when the server drops it. */
  expiresAt: number
}

export function pendingTrade(msg: TradeRequestedMessage, now: number): PendingTrade {
  return { from: msg.from, name: msg.name, level: msg.level, expiresAt: now + Math.max(0, msg.expiresInMs) }
}

/** Whole seconds left (rounded up), never below 0. */
export function tradeSecondsLeft(req: PendingTrade, now: number): number {
  return Math.max(0, Math.ceil((req.expiresAt - now) / 1000))
}

export function requestLine(req: Pick<PendingTrade, 'name' | 'level'>): string {
  return t('trade.request', { name: req.name, level: req.level })
}

// ---- requests (every builder returns a frame the shared validator accepts, or null) -----------------------------

const entityId = (n: number) => Number.isSafeInteger(n) && n > 0
const index = (n: number, size: number) => Number.isInteger(n) && n >= 0 && n < size

export const tradeIntent = {
  request(target: number): ClientMessage | null {
    return entityId(target) ? { t: 'tradeRequest', target } : null
  },
  respond(from: number, accept: boolean): ClientMessage | null {
    return entityId(from) ? { t: 'tradeRespond', from, accept } : null
  },
  /** `count` omitted = the whole stack. */
  offer(bag: number, count?: number): ClientMessage | null {
    if (!index(bag, 1 << 16)) return null
    if (count === undefined) return { t: 'tradeOffer', bag }
    return Number.isSafeInteger(count) && count >= 1 ? { t: 'tradeOffer', bag, count } : null
  },
  take(slot: number): ClientMessage | null {
    return index(slot, TRADE_SLOTS) ? { t: 'tradeTake', slot } : null
  },
  gold(amount: number): ClientMessage | null {
    return Number.isSafeInteger(amount) && amount >= 0 ? { t: 'tradeGold', amount } : null
  },
  lock(): ClientMessage {
    return { t: 'tradeLock' }
  },
  accept(): ClientMessage {
    return { t: 'tradeAccept' }
  },
  cancel(): ClientMessage {
    return { t: 'tradeCancel' }
  },
}

// ---- the Confirm button ------------------------------------------------------------------------------------------

/** lock: Confirm locks; waitLock: you locked, the partner has not; accept: Exchange; waitAccept: you accepted. */
export type ConfirmStep = 'lock' | 'waitLock' | 'accept' | 'waitAccept'

export function confirmStep(s: Pick<TradeState, 'mine' | 'theirs'>): ConfirmStep {
  if (!s.mine.locked) return 'lock'
  if (!s.theirs.locked) return 'waitLock'
  return s.mine.accepted ? 'waitAccept' : 'accept'
}

export interface ConfirmButton {
  step: ConfirmStep
  label: string
  enabled: boolean
}

const STEP_LABEL: Record<ConfirmStep, StringKey> = { lock: 'trade.confirm', waitLock: 'trade.waitingShort', accept: 'trade.exchange', waitAccept: 'trade.waitingShort' }

export function confirmButton(s: Pick<TradeState, 'mine' | 'theirs'>): ConfirmButton {
  const step = confirmStep(s)
  return { step, label: t(STEP_LABEL[step]), enabled: step === 'lock' || step === 'accept' }
}

/** The request the Confirm button sends at this step (null while waiting). */
export function confirmIntent(s: Pick<TradeState, 'mine' | 'theirs'>): ClientMessage | null {
  const step = confirmStep(s)
  if (step === 'lock') return tradeIntent.lock()
  if (step === 'accept') return tradeIntent.accept()
  return null
}

// ---- comparing states ------------------------------------------------------------------------------------------

/** The own bag slots in the offer (the M8 lock marks): `mine.items[].bag`. */
export function offeredBags(s: TradeState | null): Set<number> {
  const out = new Set<number>()
  if (!s) return out
  for (const it of s.mine.items) if (it && typeof it.bag === 'number') out.add(it.bag)
  return out
}

function sameStack(a: ItemStack, b: ItemStack): boolean {
  return a.code === b.code && a.count === b.count && (a.plus ?? 0) === (b.plus ?? 0) && (a.durability ?? null) === (b.durability ?? null)
}

/** True when two sides offer different items (code, count, +N, durability, slot) or gold. Locks are not compared. */
export function offerChanged(a: TradeSide, b: TradeSide): boolean {
  if (a.gold !== b.gold) return true
  const n = Math.max(a.items.length, b.items.length)
  for (let i = 0; i < n; i++) {
    const x = a.items[i] ?? null
    const y = b.items[i] ?? null
    if (!x !== !y) return true
    if (x && y && !sameStack(x.stack, y.stack)) return true
  }
  return false
}

/** Offered item count and whether a side offers anything at all. */
export function sideEmpty(s: TradeSide): boolean {
  return s.gold <= 0 && s.items.every(i => !i)
}

// ---- lines --------------------------------------------------------------------------------------------------------

/** The line for a refused trade request: the server's own sentence, else the trade wording, else the generic line. */
export function tradeFailText(reason: ActionFailReason | undefined, message?: string): string {
  if (message) return message
  if (reason) {
    const own = t(`trade.fail.${reason}` as StringKey)
    if (own !== `trade.fail.${reason}`) return own
    const generic = t(`action.fail.${reason}` as StringKey)
    if (generic !== `action.fail.${reason}`) return generic
  }
  return t('action.fail.generic')
}

/**
 * The line for a `tradeEnd`. `partner` is the name the window showed (the message's `name` wins); `self` is the own
 * name, so a cancel names the other side only when it was theirs.
 */
export function tradeEndText(msg: Pick<TradeEndMessage, 'reason' | 'name' | 'message'>, partner: string | null, self: string | null): string {
  const name = msg.name ?? partner ?? ''
  switch (msg.reason) {
    case 'done':
      return name ? t('trade.end.done', { name }) : t('trade.end.doneAnon')
    case 'cancelled':
      return msg.name && msg.name !== self ? t('trade.end.cancelledBy', { name: msg.name }) : t('trade.end.cancelled')
    case 'declined':
      return name ? t('trade.end.declined', { name }) : t('trade.end.cancelled')
    case 'failed':
      return msg.message ? `${t('trade.end.failed')} ${msg.message}` : t('trade.end.failed')
    default:
      return t(`trade.end.${msg.reason}` as StringKey)
  }
}

// ---- the book ---------------------------------------------------------------------------------------------------

export type TradeEvent =
  | { kind: 'opened'; state: TradeState }
  | {
      kind: 'updated'
      state: TradeState
      /** The partner's items or gold changed. */
      partnerChanged: boolean
      /** The partner's change dropped our lock (the anti-bait rule): show "The other player changed the offer." */
      lockDropped: boolean
    }
  | { kind: 'ended'; reason: TradeEndReason; text: string; partner: string | null }

/** Most status lines the text box keeps. */
export const TRADE_LOG_MAX = 4

export class TradeBook {
  state: TradeState | null = null
  /** The partner changed the offer after we locked, and we have not locked again since. */
  changed = false
  /** The window's text box, oldest first. */
  readonly log: string[] = []
  /** The partner of the current (or last) exchange. */
  partnerName: string | null = null

  get open(): boolean {
    return this.state !== null
  }

  get step(): ConfirmStep | null {
    return this.state ? confirmStep(this.state) : null
  }

  clear(): void {
    this.state = null
    this.changed = false
    this.log.length = 0
  }

  /** `trade` / `tradeEnd` (other messages: null). `self` is the own name (for the cancel line). */
  apply(msg: ServerMessage, self: string | null = null): TradeEvent | null {
    if (msg.t === 'trade') return this.set(msg.trade)
    if (msg.t === 'tradeEnd') {
      const partner = this.state?.name ?? this.partnerName
      const text = tradeEndText(msg, partner, self)
      this.clear()
      return { kind: 'ended', reason: msg.reason, text, partner }
    }
    return null
  }

  private set(next: TradeState): TradeEvent {
    const prev = this.state
    this.state = next
    this.partnerName = next.name
    if (!prev || prev.partner !== next.partner) {
      this.changed = false
      this.log.length = 0
      this.note(t('trade.started', { name: next.name }))
      this.status()
      return { kind: 'opened', state: next }
    }
    const partnerChanged = offerChanged(prev.theirs, next.theirs)
    const lockDropped = partnerChanged && prev.mine.locked && !next.mine.locked
    if (lockDropped) {
      this.changed = true
      this.note(t('trade.changed'))
    }
    if (next.mine.locked) this.changed = false
    this.status()
    return { kind: 'updated', state: next, partnerChanged, lockDropped }
  }

  /** The line that says what to do now. */
  statusLine(): string | null {
    const s = this.state
    if (!s) return null
    switch (confirmStep(s)) {
      case 'lock':
        return s.theirs.locked ? t('trade.status.partnerLocked', { name: s.name }) : t('trade.status.offer')
      case 'waitLock':
        return t('trade.status.waitLock', { name: s.name })
      case 'accept':
        return s.theirs.accepted ? t('trade.status.partnerAccepted', { name: s.name }) : t('trade.status.bothLocked')
      case 'waitAccept':
        return t('trade.waiting')
    }
  }

  private status(): void {
    const line = this.statusLine()
    if (line) this.note(line)
  }

  /** Adds a line unless it repeats the last one. */
  private note(line: string): void {
    if (this.log[this.log.length - 1] === line) return
    this.log.push(line)
    if (this.log.length > TRADE_LOG_MAX) this.log.splice(0, this.log.length - TRADE_LOG_MAX)
  }
}
