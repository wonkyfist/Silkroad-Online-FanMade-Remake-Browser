/**
 * World feature of lane TR-C, player trade (docs/SYSTEMS_SOCIAL.md §3, §9.2; docs/WAVE_PLAN2.md §6.5). Only that lane
 * edits this file; see world/features.ts for the context and hooks. It wires:
 * - the Exchange button of the target window on other live players (Hud.addTargetAction, M3), and the chat commands
 *   `/trade` and `/exchange` on the current player target (ChatBox.registerPrefix); a `too_far` refusal walks up to
 *   the player once (world/approach.ts) and asks again;
 * - the request popup (`tradeRequested`) and the exchange window (`trade`, `tradeEnd`);
 * - offering: a bag item dragged onto the window, or right-clicked in the bag while the window is open
 *   (Hud.routeBagAction); Shift asks for an amount. The offered bag slots are drawn locked (Hud.markBagSlots, M8);
 * - the event lines in the system chat, and the refusals of every trade request as error toasts.
 *
 * TradeController is the DOM-free part (tests drive it with a fake TradeIo); the factory binds it to the HUD.
 */
import { TRADE_RANGE, TRADE_REQUESTS, type ClientMessage, type GameplayRequest, type ItemStack, type ServerMessage } from '@sro/shared'
import { t } from '../../i18n/index.ts'
import type { TargetAction, TargetInfo } from '../../hud/target.ts'
import { Tooltip } from '../../hud/slots.ts'
import { TradeWindow } from '../../hud/trade.ts'
import { TradeRequestPopup } from '../../hud/trade-request.ts'
import { confirmIntent, offeredBags, pendingTrade, TradeBook, tradeFailText, tradeIntent, type PendingTrade } from '../../hud/trade-state.ts'
import { MessageBox } from '../../ui/kit/dialog.ts'
import { approachThen } from '../approach.ts'
import type { WorldFeatureFactory } from '../features.ts'

/** A player the Exchange button or `/trade` may ask. */
export type TradeTarget = Pick<TargetInfo, 'id' | 'name' | 'kind'> & { hp?: number }

/** What the controller needs from the world (tests pass a fake). */
export interface TradeIo {
  /** Sends a built intent; false (and nothing sent) for null or when offline. */
  send(msg: ClientMessage | null): boolean
  /** Own entity id (null before worldEnter). */
  selfId(): number | null
  /** Own character name (null before worldEnter). */
  selfName(): string | null
  /** The current target (for `/trade`), or null. */
  target(): TradeTarget | null
  /** A line in the system chat. */
  line(text: string): void
  /** A refusal: centre-screen error toast. */
  error(text: string): void
  /** A notice: centre-screen info toast. */
  info(text: string): void
  /** Own bag slot `bag` as the server last described it. */
  bagItem(bag: number): ItemStack | null
  /** The display name of a stack (with +N). */
  itemName(stack: ItemStack): string
  /** Own gold in the bag. */
  bagGold(): number
  /** Asks for an amount in min..max (the kit count box); null = cancelled. */
  askAmount(opts: { title: string; text: string; min: number; max: number; initial: number }): Promise<number | null>
  /** Walks up to entity `id`, then runs `run` once (world/approach.ts). */
  approach(id: number, run: () => void): void
  /** Local clock in ms. */
  now(): number
  /** The exchange or the request changed: redraw. */
  changed(): void
}

/** Trade requests the controller reports itself (every one: `tradeRequest` walks on `too_far` instead of a toast). */
const OWN: ReadonlySet<GameplayRequest> = new Set(TRADE_REQUESTS)

export class TradeController {
  readonly book = new TradeBook()
  /** The incoming request waiting for an answer. */
  request: PendingTrade | null = null
  /** The partner's offer changed since the window last drew (the window flashes once). */
  flash = false
  /** Our outstanding `tradeRequest`s, oldest first (answered in order by actionResult). */
  private readonly sent: { id: number; name: string; retried: boolean }[] = []

  constructor(private readonly io: TradeIo) {}

  /** Every server message. */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'worldEnter':
        // A new visit: trades and requests are runtime only and ended with the old one.
        this.book.clear()
        this.book.partnerName = null
        this.request = null
        this.sent.length = 0
        this.flash = false
        this.io.changed()
        break
      case 'tradeRequested':
        this.request = pendingTrade(msg, this.io.now())
        this.io.changed()
        break
      case 'trade': {
        const ev = this.book.apply(msg, this.io.selfName())
        this.request = null
        if (ev?.kind === 'opened') this.io.line(t('trade.started', { name: ev.state.name }))
        else if (ev?.kind === 'updated') {
          if (ev.lockDropped) this.io.line(t('trade.changed'))
          if (ev.partnerChanged) this.flash = true
        }
        this.io.changed()
        break
      }
      case 'tradeEnd': {
        const wasOpen = this.book.open
        const ev = this.book.apply(msg, this.io.selfName())
        this.request = null
        if (ev?.kind === 'ended') {
          this.io.line(ev.text)
          if (ev.reason !== 'done' && (wasOpen || ev.reason === 'declined')) this.io.info(ev.text)
        }
        this.flash = false
        this.io.changed()
        break
      }
      case 'actionResult':
        if (!OWN.has(msg.re)) break
        if (msg.re === 'tradeRequest') {
          const s = this.sent.shift()
          if (msg.ok) {
            if (s) this.io.line(t('trade.asking', { name: s.name }))
          } else if (msg.reason === 'too_far' && s && !s.retried) {
            this.io.approach(s.id, () => this.ask(s.id, s.name, true))
          } else this.io.error(tradeFailText(msg.reason, msg.message))
        } else if (!msg.ok) this.io.error(tradeFailText(msg.reason, msg.message))
        break
    }
  }

  /** Drops the request once its time is up (the server ends it too). */
  tick(now: number): void {
    if (this.request && now >= this.request.expiresAt) {
      this.request = null
      this.io.changed()
    }
  }

  /** The Exchange button shows for other live players while no exchange is open. */
  canExchange(target: TradeTarget): boolean {
    if (target.kind !== 'player' || this.book.open) return false
    const self = this.io.selfId()
    if (self === null || target.id === self) return false
    return target.hp === undefined || target.hp > 0
  }

  /** The Exchange button / `/trade` on this player. */
  requestTrade(target: Pick<TradeTarget, 'id' | 'name'>): void {
    this.ask(target.id, target.name, false)
  }

  /** `/trade` and `/exchange`: the current target, or a toast when it is not another live player. */
  command(): void {
    const target = this.io.target()
    if (!target || !this.canExchange(target)) {
      this.io.error(this.book.open ? t('trade.fail.trading') : t('trade.noTarget'))
      return
    }
    this.requestTrade(target)
  }

  respond(accept: boolean): void {
    const req = this.request
    if (!req) return
    this.request = null
    this.io.send(tradeIntent.respond(req.from, accept))
    if (!accept) this.io.line(t('trade.declinedSelf', { name: req.name }))
    this.io.changed()
  }

  /**
   * Offers bag slot `bag` (the whole stack; `ask` with a stack of more than one asks for the amount first).
   * False when no exchange is open (the right click then falls through to the default use).
   */
  offer(bag: number, ask = false): boolean {
    const s = this.book.state
    if (!s) return false
    const stack = this.io.bagItem(bag)
    if (!stack || offeredBags(s).has(bag)) return true
    if (!ask || stack.count < 2) {
      this.io.send(tradeIntent.offer(bag))
      return true
    }
    const item = stack
    void this.io.askAmount({ title: t('trade.countTitle'), text: t('trade.countBody', { name: this.io.itemName(item), max: item.count }), min: 1, max: item.count, initial: item.count }).then(n => {
      const now = this.io.bagItem(bag)
      if (n === null || !this.book.open || !now || now.code !== item.code) return
      this.io.send(n >= now.count ? tradeIntent.offer(bag) : tradeIntent.offer(bag, n))
    })
    return true
  }

  /** Takes own exchange slot `slot` back. */
  take(slot: number): void {
    if (!this.book.state?.mine.items[slot]) return
    this.io.send(tradeIntent.take(slot))
  }

  /** The money button: asks for the gold to offer (0 clears it). */
  gold(): void {
    const s = this.book.state
    if (!s || s.mine.locked) return
    const have = this.io.bagGold()
    void this.io.askAmount({ title: t('trade.goldTitle'), text: t('trade.goldBody', { gold: have }), min: 0, max: have, initial: Math.min(s.mine.gold, have) }).then(n => {
      if (n === null || !this.book.state || n === this.book.state.mine.gold) return
      this.io.send(tradeIntent.gold(n))
    })
  }

  /** Confirm (lock) or Exchange (accept), by step; nothing while waiting. */
  confirm(): void {
    const s = this.book.state
    if (s) this.io.send(confirmIntent(s))
  }

  cancel(): void {
    if (this.book.open) this.io.send(tradeIntent.cancel())
  }

  private ask(id: number, name: string, retried: boolean): void {
    if (this.io.send(tradeIntent.request(id))) this.sent.push({ id, name, retried })
  }
}

/** A player target as TradeTarget (null for anything else). */
function playerTarget(v: { id: number; kind: string; state: { name: string; hp?: number; state?: string } } | null | undefined): TradeTarget | null {
  if (!v || v.kind !== 'player') return null
  return { id: v.id, name: v.state.name, kind: 'player', hp: v.state.state === 'dead' ? 0 : v.state.hp }
}

export const tradeFeature: WorldFeatureFactory = ctx => {
  const { hud, app, chat } = ctx
  let selfName: string | null = null
  let dirty = true
  let shownRequest: PendingTrade | null = null
  let marksKey = ''
  let wasOpen = false
  let cancelApproach: (() => void) | null = null
  /** Shift held on the last right click (the bag route gets only the slot). */
  let shiftClick = false

  const ownName = () => {
    const id = ctx.selfId()
    return (id !== null ? ctx.view(id)?.state.name : undefined) ?? selfName ?? ''
  }

  const tooltip = new Tooltip(app.art)
  const ctl = new TradeController({
    send: msg => !!msg && ctx.send(msg),
    selfId: () => ctx.selfId(),
    selfName: () => ownName() || null,
    target: () => playerTarget(ctx.target()),
    line: text => chat.add('system', text),
    error: text => hud.toast(text, 'error'),
    info: text => hud.toast(text, 'info'),
    bagItem: bag => hud.inventory.item(bag),
    itemName: stack => hud.items.stackName(stack),
    bagGold: () => hud.inventory.gold,
    askAmount: o => (MessageBox.isOpen() ? Promise.resolve(null) : MessageBox.count({ title: o.title, text: o.text, min: o.min, max: o.max, initial: o.initial, ok: t('trade.ok'), art: app.art })),
    approach: (id, run) => {
      cancelApproach?.()
      cancelApproach = approachThen(ctx, id, TRADE_RANGE, run)
    },
    now: () => performance.now(),
    changed: () => {
      dirty = true
    },
  })

  const win = new TradeWindow(app.art, hud.layer, {
    items: hud.items,
    tooltip,
    level: () => hud.stats?.level ?? null,
    offer: (bag, ask) => void ctl.offer(bag, ask),
    take: slot => ctl.take(slot),
    gold: () => ctl.gold(),
    confirm: () => ctl.confirm(),
    cancel: () => ctl.cancel(),
  })
  const popup = new TradeRequestPopup(app.art, hud.layer, accept => ctl.respond(accept))

  const render = () => {
    dirty = false
    const s = ctl.book.state
    if (s) {
      if (!win.isOpen) {
        win.show(s, ctl.book.log, ownName())
        hud.openInventory?.()
      } else win.render(s, ctl.book.log, ownName())
      if (ctl.flash) win.flashPartner()
    } else if (win.isOpen) {
      tooltip.hide()
      win.hide()
    }
    ctl.flash = false
    // M8: the offered bag slots are drawn locked on every inventory render.
    const marks = offeredBags(s)
    const key = [...marks].sort((a, b) => a - b).join(',')
    if (key !== marksKey) {
      marksKey = key
      hud.markBagSlots('trade', marks)
    }
    if (ctl.request !== shownRequest) {
      shownRequest = ctl.request
      if (shownRequest) popup.show(shownRequest, performance.now())
      else popup.hide()
    }
    if (ctl.book.open !== wasOpen) {
      wasOpen = ctl.book.open
      hud.refreshTargetActions()
    }
  }

  const exchange: TargetAction = { id: 'tradeRequest', label: t('trade.title'), title: t('trade.actionHint'), show: tgt => ctl.canExchange(tgt), run: tgt => ctl.requestTrade(tgt) }
  const onContext = (ev: MouseEvent) => {
    shiftClick = ev.shiftKey
  }
  window.addEventListener('contextmenu', onContext, true)

  const offs = [
    hud.addTargetAction(exchange),
    chat.registerPrefix('/trade', () => ctl.command()),
    chat.registerPrefix('/exchange', () => ctl.command()),
    hud.routeBagAction(bag => ctl.offer(bag, shiftClick)),
    () => window.removeEventListener('contextmenu', onContext, true),
  ]

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') selfName = msg.self.name
      ctl.handle(msg)
      if (dirty) render()
    },
    onFrame() {
      const now = performance.now()
      ctl.tick(now)
      popup.tick(now)
      if (dirty) render()
    },
    escape() {
      if (win.isOpen) {
        win.close()
        return true
      }
      return false
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      cancelApproach?.()
      cancelApproach = null
      hud.markBagSlots('trade', new Set())
      popup.dispose()
      win.dispose()
      tooltip.dispose()
    },
  }
}
