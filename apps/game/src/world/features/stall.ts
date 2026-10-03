/**
 * World feature of lane ST-C, stalls (docs/SYSTEMS_SOCIAL.md §4, §9.3; docs/WAVE_PLAN2.md §6.5, D7, D9, D20, D28).
 * Only that lane edits this file; see world/features.ts for the context and hooks. It wires:
 *  - opening a stall: the MENU row "Stall" (D20) and `/stall [title]` (D9) -> the name prompt -> `stallCreate`;
 *  - the stall window (hud/stall.ts) for the owner and for visitors, from the server's `stall` / `stallSold`;
 *  - listing: a bag item dropped on the window or right clicked in the bag -> count -> price -> `stallItem`; the
 *    listed bag slots are drawn locked (`hud.markBagSlots('stall', …)`, M8);
 *  - visiting: a click on a player (or on the sign over them) whose nameplate carries a stall sign -> `stallVisit`,
 *    walking up first on `too_far` (approachThen); buying after a confirmation, with exactly the shown code, count and
 *    price;
 *  - the sign over every stall owner (`setBadge('stall', title, 'stall-sign')`) and the vendor pose
 *    (`idleOf(v).setReason('vendor', …)`, D7 / D28) from `EntityState.stall` and `entityUpdate.stall`;
 *  - the owner's ground clicks are consumed (`beforeGroundMove`) with "Close your stall first.";
 *  - the stall chat (`chat {channel: 'stall'}`) in the window's chat module; the sale line and the gold cue.
 * StallController is the DOM-free part (tests drive it with a fake StallIo); the factory binds it to the HUD.
 */
import {
  STALL_GREETING_MAX,
  STALL_RANGE,
  STALL_REQUESTS,
  STALL_TITLE_MAX,
  type ClientMessage,
  type EntityState,
  type GameplayRequest,
  type ItemDef,
  type ItemStack,
  type ServerMessage,
} from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { actionFailText } from '../../hud/index.ts'
import type { MenuBarEntry } from '../../hud/menubar.ts'
import { Tooltip } from '../../hud/slots.ts'
import { askPrice, StallWindow, suggestedPrice } from '../../hud/stall.ts'
import { buyItemLabel, cleanGreeting, cleanTitle, endKey, formatPrice, PREFER_SERVER_MESSAGE, sameListing, signOfState, signOfUpdate, stallFailKey, StallModel } from '../../hud/stall-state.ts'
import { t } from '../../i18n/index.ts'
import { MessageBox } from '../../ui/kit/dialog.ts'
import { approachThen } from '../approach.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { idleOf } from '../idle.ts'

/** Chat command (D9). */
export const STALL_COMMAND = '/stall'
/** The owner's repeated ground clicks toast at most this often (ms). */
export const CLOSE_FIRST_TOAST_MS = 1500
const STALL_REQUEST_SET: ReadonlySet<GameplayRequest> = new Set(STALL_REQUESTS)

/** What the controller needs from the world (tests pass a fake). */
export interface StallIo {
  /** Sends a request; false when offline (nothing sent). */
  send(msg: ClientMessage): boolean
  selfId(): number | null
  selfName(): string | null
  selfDead(): boolean
  gold(): number
  bagItem(bag: number): ItemStack | null
  itemDef(code: string): ItemDef | undefined
  itemName(code: string): string
  /** A refusal or a warning (centre toast). */
  error(text: string): void
  /** A neutral notice (centre toast). */
  info(text: string): void
  /** A line in the chat log's system colour. */
  systemLine(text: string): void
  /** The stall window's chat module. */
  chatLine(name: string, text: string, self: boolean): void
  /** M8: the listed bag slots (an empty set clears). */
  markBags(slots: ReadonlySet<number>): void
  /** The nameplate sign of entity `id` (null removes it). */
  setSign(id: number, title: string | null): void
  /** The vendor pose of entity `id`. */
  setVendor(id: number, on: boolean): void
  /** Walks up to `owner`'s stall, then runs `run` (approachThen). */
  approach(owner: number, run: () => void): void
  /** The window: 'open' shows it, 'close' hides it, 'render' redraws it. */
  window(what: 'open' | 'close' | 'render'): void
  windowOpen(): boolean
  saleSound(): void
  /** Local clock (ms). */
  now(): number
  // dialogs
  askTitle(initial: string): Promise<string | null>
  askGreeting(initial: string): Promise<string | null>
  askCount(stack: ItemStack): Promise<number | null>
  askPrice(stack: ItemStack, initial: number): Promise<number | null>
  confirm(title: string, text: string): Promise<boolean>
}

export class StallController {
  readonly model = new StallModel()
  /** Stall titles of the players in view (entity id -> title), from spawns and entityUpdates. */
  readonly signs = new Map<number, string>()
  /** The owner a `stallVisit` went to (for the walk-up on `too_far`). */
  private pendingVisit: number | null = null
  private approached = false
  private creating = false
  private lastCloseFirst = -Infinity
  /** The purchase in flight (its success line). */
  private lastBuy: Extract<ClientMessage, { t: 'stallBuy' }> | null = null
  /** The owner you just left: its views still in flight are ignored until the server's null arrives. */
  private leaving: number | null = null
  /** A dialog of the owner or the buyer is open (one at a time). */
  private busy = false

  constructor(private readonly io: StallIo) {}

  // ---- server messages -------------------------------------------------------------------------------------

  onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'worldEnter':
        this.model.reset()
        this.model.selfId = msg.self.id
        this.signs.clear()
        this.pendingVisit = null
        this.leaving = null
        this.io.markBags(new Set())
        this.io.window('close')
        break
      case 'stall':
        this.applyStall(msg)
        break
      case 'stallSold': {
        // The server's own system chat line says it in the log (docs/WAVE_PLAN2.md §3.2); here the notice and the cue.
        const name = this.io.itemName(msg.code)
        const item = msg.count > 1 ? `${name} x${msg.count}` : name
        this.io.info(t('stall.bought', { buyer: msg.buyer, item }))
        this.io.saleSound()
        break
      }
      case 'entityUpdate': {
        const sign = signOfUpdate(msg)
        if (sign !== undefined) this.sign(msg.id, sign)
        break
      }
      case 'despawn':
        this.signs.delete(msg.id)
        break
      case 'chat':
        if (msg.channel === 'stall' && this.model.view) {
          const self = msg.fromId !== undefined && msg.fromId === this.model.selfId
          this.io.chatLine(msg.from ?? t('world.unknownSpeaker'), msg.text, self)
        }
        break
      case 'actionResult':
        if (!msg.ok && STALL_REQUEST_SET.has(msg.re)) this.refused(msg.re, msg.reason, msg.message)
        if (msg.ok && msg.re === 'stallVisit') this.pendingVisit = null
        if (msg.re === 'stallBuy') this.bought(msg.ok)
        break
    }
  }

  private applyStall(msg: Extract<ServerMessage, { t: 'stall' }>): void {
    if (this.model.selfId === null) this.model.selfId = this.io.selfId()
    if (this.leaving !== null) {
      if (msg.stall?.owner === this.leaving) return
      if (!msg.stall) {
        this.leaving = null
        if (!this.model.view) return
      }
    }
    const change = this.model.apply(msg)
    const self = this.model.selfId
    if (change.ended) {
      if (change.was === 'owner') {
        this.io.markBags(new Set())
        if (self !== null && this.signs.has(self)) this.sign(self, null)
        this.io.info(t(endKey(change.ended, true)))
      } else this.io.error(t(endKey(change.ended, false)))
      this.io.window('close')
      return
    }
    if (this.model.isOwner) {
      this.io.markBags(this.model.listedBags())
      // The owner's own sign and pose follow the stall even before the entityUpdate echo.
      if (self !== null) this.sign(self, this.model.view!.title)
    } else if (change.was === 'owner') this.io.markBags(new Set())
    if (this.model.isVisitor) this.pendingVisit = null
    if (change.opened || !this.io.windowOpen()) this.io.window('open')
    else this.io.window('render')
  }

  /** The answer to your purchase: a line naming what you bought (a refusal is worded by `refused`). */
  private bought(ok: boolean): void {
    const req = this.lastBuy
    this.lastBuy = null
    if (!ok || !req) return
    // The +N and broken marker of what was bought (the request carries the stack the buyer confirmed).
    const name = buyItemLabel(this.io.itemName(req.code), req, t('dur.broken'))
    const item = req.count > 1 ? `${name} x${req.count}` : name
    this.io.systemLine(t('stall.youBought', { item, price: formatPrice(req.price) }))
  }

  private refused(re: GameplayRequest, reason: Parameters<typeof actionFailText>[0], message?: string): void {
    if (re === 'stallVisit' && reason === 'too_far' && this.pendingVisit !== null && !this.approached) {
      const owner = this.pendingVisit
      this.approached = true
      this.io.approach(owner, () => this.visit(owner, true))
      return
    }
    if (reason === 'rate_limited') return
    this.io.error(this.failText(re, reason, message))
  }

  /** The line for a refused stall request. */
  failText(re: GameplayRequest, reason: Parameters<typeof actionFailText>[0], message?: string): string {
    if (reason && PREFER_SERVER_MESSAGE.has(reason) && message) return message
    const key = stallFailKey(re, reason)
    return key ? t(key) : actionFailText(reason, message)
  }

  // ---- entities ------------------------------------------------------------------------------------------

  entityAdded(id: number, state: Pick<EntityState, 'kind' | 'stall'>): void {
    const title = signOfState(state)
    if (title !== null) this.sign(id, title)
  }

  entityRemoved(id: number): void {
    this.signs.delete(id)
  }

  /** Sets (title) or clears (null) the sign and the vendor pose of `id`. */
  private sign(id: number, title: string | null): void {
    const had = this.signs.has(id)
    if (title === null) {
      this.signs.delete(id)
      this.io.setSign(id, null)
      if (had) this.io.setVendor(id, false)
      return
    }
    this.signs.set(id, title)
    this.io.setSign(id, title)
    if (!had) this.io.setVendor(id, true)
  }

  hasStall(id: number): boolean {
    return this.signs.has(id)
  }

  // ---- world input ------------------------------------------------------------------------------------------

  /** A click on player `id`: true = consumed (it runs a stall, or you run one). */
  clickPlayer(id: number): boolean {
    const self = this.model.selfId ?? this.io.selfId()
    if (id === self) {
      if (!this.model.isOwner) return false
      this.io.window('open')
      return true
    }
    if (!this.signs.has(id)) return false
    this.visit(id)
    return true
  }

  /** Opens `owner`'s stall (or brings the window forward when already there). */
  visit(owner: number, afterApproach = false): void {
    if (this.io.selfDead()) return
    if (this.model.view?.owner === owner) {
      this.io.window('open')
      return
    }
    if (!afterApproach) this.approached = false
    this.leaving = null
    this.pendingVisit = owner
    this.io.send({ t: 'stallVisit', owner })
  }

  /** The owner's ground click or hold-to-move step: consumed while running a stall. */
  beforeGroundMove(): boolean {
    if (!this.model.isOwner) return false
    const now = this.io.now()
    if (now - this.lastCloseFirst >= CLOSE_FIRST_TOAST_MS) {
      this.lastCloseFirst = now
      this.io.error(t('stall.closeFirst'))
    }
    return true
  }

  /** A click on a mob, NPC or ground item while running a stall: refused here with the same line. */
  blockedClick(): boolean {
    if (!this.model.isOwner) return false
    this.io.error(t('stall.closeFirst'))
    return true
  }

  /** Right click on bag slot `bag`: true = consumed (you run a stall). */
  bagAction(bag: number): boolean {
    if (!this.model.isOwner) return false
    void this.listBag(bag, -1)
    return true
  }

  // ---- menu and command -------------------------------------------------------------------------------------

  /** The MENU row: the window of your stall or visit, else a new stall. */
  menu(): void {
    if (this.model.view) {
      if (this.io.windowOpen()) void this.requestClose()
      else this.io.window('open')
      return
    }
    void this.create()
  }

  /** `/stall [title]`. */
  command(rest: string): void {
    if (this.model.view) {
      this.io.window('open')
      return
    }
    void this.create(rest.trim() || undefined)
  }

  /** Asks for the name (unless given) and sends `stallCreate`. */
  async create(title?: string): Promise<void> {
    if (this.creating || this.model.view) return
    if (this.io.selfDead()) {
      this.io.error(t('action.fail.dead'))
      return
    }
    this.creating = true
    try {
      const name = this.io.selfName() ?? ''
      const typed = title ?? (await this.io.askTitle(t('stall.defaultTitle', { name })))
      if (typed === null || this.model.view) return
      this.io.send({ t: 'stallCreate', title: cleanTitle(typed) })
    } finally {
      this.creating = false
    }
  }

  // ---- the window's actions ---------------------------------------------------------------------------------

  toggleState(): void {
    const m = this.model
    if (!m.isOwner) return
    if (!m.isOpen && m.listedCount === 0) {
      this.io.error(t('stall.nothing'))
      return
    }
    this.io.send({ t: 'stallOpen', open: !m.isOpen })
  }

  async editTitle(): Promise<void> {
    const v = this.model.view
    if (!v || !this.model.isOwner || this.busy) return
    this.busy = true
    try {
      const typed = await this.io.askTitle(v.title)
      if (typed === null || !this.model.isOwner) return
      const title = cleanTitle(typed) || t('stall.defaultTitle', { name: this.io.selfName() ?? v.name })
      if (title !== this.model.view!.title) this.io.send({ t: 'stallText', title: cleanTitle(title) })
    } finally {
      this.busy = false
    }
  }

  async editGreeting(): Promise<void> {
    const v = this.model.view
    if (!v || !this.model.isOwner || this.busy) return
    this.busy = true
    try {
      const typed = await this.io.askGreeting(v.greeting)
      if (typed === null || !this.model.isOwner) return
      const greeting = cleanGreeting(typed) || t('stall.defaultGreeting', { name: this.io.selfName() ?? v.name })
      if (greeting !== this.model.view!.greeting) this.io.send({ t: 'stallText', greeting: cleanGreeting(greeting) })
    } finally {
      this.busy = false
    }
  }

  closeStall(): void {
    if (this.model.isOwner) this.io.send({ t: 'stallClose' })
  }

  /** The window's close button, Esc or the MENU row: the owner confirms closing, a visitor leaves at once. */
  async requestClose(): Promise<void> {
    const m = this.model
    if (m.isVisitor) {
      this.leave()
      return
    }
    if (!m.isOwner || this.busy) return
    this.busy = true
    try {
      if (await this.io.confirm(t('stall.title'), t('stall.closeConfirm'))) {
        if (this.model.isOwner) this.io.send({ t: 'stallClose' })
      }
    } finally {
      this.busy = false
    }
  }

  /** A visitor leaves: the window closes now (the server's answer needs no line). */
  leave(): void {
    if (!this.model.isVisitor) return
    this.leaving = this.model.view!.owner
    this.io.send({ t: 'stallLeave' })
    this.model.reset()
    this.io.window('close')
  }

  /**
   * Lists bag slot `bag` in stall slot `slot` (-1 = the first free one): the amount (for a stack), then the price.
   * Everything is re-checked after the dialogs, since the stall may have changed meanwhile.
   */
  async listBag(bag: number, slot: number): Promise<void> {
    const m = this.model
    if (!m.isOwner || this.busy) return
    const stack = this.io.bagItem(bag)
    if (!stack) return
    const def = this.io.itemDef(stack.code)
    const problem = this.listProblem(bag, slot, stack, def)
    if (problem) {
      this.io.error(t(problem))
      return
    }
    this.busy = true
    try {
      const count = stack.count > 1 ? await this.io.askCount(stack) : 1
      if (count === null) return
      const offered: ItemStack = { ...stack, count }
      const price = await this.io.askPrice(offered, 0)
      if (price === null) return
      const now = this.io.bagItem(bag)
      if (!now || now.code !== stack.code || now.count < count) return
      const again = this.listProblem(bag, slot, now, def)
      if (again) {
        this.io.error(t(again))
        return
      }
      const target = slot >= 0 && slot < m.view!.items.length ? slot : m.freeSlot()
      this.io.send({ t: 'stallItem', slot: target, bag, count, price })
    } finally {
      this.busy = false
    }
  }

  private listProblem(bag: number, slot: number, stack: ItemStack, def: ItemDef | undefined) {
    const m = this.model
    const problem = m.listProblem(bag, stack, def)
    // Dropped on a taken row: that listing is replaced, so a full stall is no obstacle.
    if (problem === 'stall.slotsFull' && slot >= 0) return null
    return problem
  }

  /** The pencil: a new price for listing `slot` (same bag slot and amount). */
  async editPrice(slot: number): Promise<void> {
    const m = this.model
    const l = m.listing(slot)
    if (!m.isOwner || !l || this.busy) return
    if (!m.canEdit) {
      this.io.error(t('stall.modifyFirst'))
      return
    }
    if (typeof l.bag !== 'number') return
    this.busy = true
    try {
      const price = await this.io.askPrice(l.stack, l.price)
      if (price === null || price === l.price) return
      const now = this.model.listing(slot)
      if (!now || now.bag !== l.bag || !this.model.canEdit) return
      this.io.send({ t: 'stallItem', slot, bag: l.bag, count: now.stack.count, price })
    } finally {
      this.busy = false
    }
  }

  /** Takes listing `slot` back (right click on it). */
  remove(slot: number): void {
    const m = this.model
    if (!m.isOwner || !m.listing(slot)) return
    if (!m.canEdit) {
      this.io.error(t('stall.modifyFirst'))
      return
    }
    this.io.send({ t: 'stallItemRemove', slot })
  }

  /**
   * Buys listing `slot` after a confirmation naming the exact item (+N, broken); sends what was shown when the buyer
   * clicked, and nothing when the listing changed while the box was open (the server refuses a stale one too).
   */
  async buy(slot: number): Promise<void> {
    const m = this.model
    if (!m.isVisitor || this.busy) return
    if (!m.isOpen) {
      this.io.error(t('stall.underConstruction'))
      return
    }
    const req = m.buyRequest(slot)
    const shown = m.listing(slot)
    if (!req || !shown) return
    if (req.price > this.io.gold()) {
      this.io.error(t('stall.fail.not_enough_gold'))
      return
    }
    const name = buyItemLabel(this.io.itemName(req.code), shown.stack, t('dur.broken'))
    const price = formatPrice(req.price)
    const text = req.count > 1 ? t('stall.buyConfirm', { item: name, count: req.count, price }) : t('stall.buyConfirmOne', { item: name, price })
    this.busy = true
    try {
      if (!(await this.io.confirm(t('stall.buyTitle'), text))) return
      // The buyer may have left meanwhile.
      if (this.model.view?.owner !== req.owner) return
      // S1 / D47: the listing changed while the box was open (Modify, another +N or a broken copy at the same price).
      if (!this.model.isOpen || !sameListing(this.model.listing(slot), shown)) {
        this.io.error(t('stall.fail.stall_changed'))
        return
      }
      if (this.io.send(req)) this.lastBuy = req
    } finally {
      this.busy = false
    }
  }

  /** A line typed in the stall chat. */
  chat(text: string): void {
    if (!this.model.view) return
    this.io.send({ t: 'chat', text, channel: 'stall' })
  }
}

// ---- the world binding ---------------------------------------------------------------------------------------

const CSS = `
.entity-label .badge-stall.stall-sign {
  position: absolute; left: 50%; bottom: calc(100% + 4px); transform: translateX(-50%);
  width: max-content; max-width: 220px; padding: 2px 10px 3px; box-sizing: border-box;
  font: 12px/16px var(--font-title, var(--font-body)); color: var(--c-heading, #ffe27b); text-shadow: var(--t-outline);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: linear-gradient(rgba(58, 40, 18, 0.94), rgba(24, 16, 8, 0.94)); border: 1px solid var(--c-rim, #9c8350);
  border-radius: 2px; box-shadow: 0 0 0 1px #000, 0 2px 4px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 226, 123, 0.18);
  pointer-events: auto; cursor: pointer;
}
.entity-label .badge-stall.stall-sign::before {
  content: ''; display: inline-block; width: 12px; height: 12px; margin: 0 5px -2px 0; vertical-align: baseline;
  background: var(--stall-sign-icon, none) no-repeat 0 0 / 100% 100%;
}
.entity-label .badge-stall.stall-sign:hover { color: var(--c-highlight, #ffef99); border-color: var(--c-level, #ffd953); }
.entity-label:has(> .badge-stall) > .badge-bubble.chat-bubble { bottom: calc(100% + 30px); }
`
let injected = false
function ensureSignStyles(iconUrl: string | null): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'stall-sign'
  s.textContent = CSS + (iconUrl ? `.entity-label .badge-stall.stall-sign { --stall-sign-icon: ${iconUrl}; }\n` : '')
  document.head.append(s)
}

/** The vendor pose through the view's idle driver (D7), or straight on the view when it has none. */
export function setVendorPose(v: Pick<EntityView, 'setIdle'>, on: boolean): void {
  const driver = idleOf(v as EntityView)
  if (driver) driver.setReason('vendor', on, 'play')
  else v.setIdle(on ? 'vendor' : 'stand', 'play')
}

export function stallFeature(ctx: WorldFeatureContext): WorldFeature {
  const { hud, app, chat } = ctx
  const art = app.art
  const offs: (() => void)[] = []
  const tooltip = new Tooltip(art)
  const signClicks = new WeakSet<HTMLElement>()
  ensureSignStyles(art.has('underbar/ub_new_icon_stall') ? art.cssUrl('underbar/ub_new_icon_stall') : null)

  const selfView = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }

  let win: StallWindow | null = null
  const io: StallIo = {
    send: msg => ctx.send(msg),
    selfId: () => ctx.selfId(),
    selfName: () => selfView()?.state.name ?? null,
    selfDead: () => !!selfView()?.dead,
    gold: () => hud.inventory.gold,
    bagItem: bag => hud.inventory.item(bag),
    itemDef: code => hud.items.def(code),
    itemName: code => hud.items.name(code),
    error: text => hud.toast(text, 'error'),
    info: text => hud.toast(text, 'info'),
    systemLine: text => chat.add('system', text),
    chatLine: (name, text, self) => win?.addChat(name, text, self),
    markBags: slots => hud.markBagSlots('stall', slots),
    setSign: (id, title) => {
      const v = ctx.view(id)
      if (!v) return
      if (v.state.kind === 'player') v.state.stall = title ?? undefined
      v.setBadge('stall', title, 'stall-sign')
      const badge = title === null ? null : v.label.querySelector<HTMLElement>('.badge-stall')
      if (badge && !signClicks.has(badge)) {
        signClicks.add(badge)
        badge.addEventListener('pointerdown', ev => ev.stopPropagation())
        badge.addEventListener('click', ev => {
          ev.stopPropagation()
          const target = ctx.view(id)
          if (target) ctx.setTarget(target)
          ctrl.clickPlayer(id)
        })
      }
    },
    setVendor: (id, on) => {
      const v = ctx.view(id)
      if (v) setVendorPose(v, on)
    },
    approach: (owner, run) => {
      approachThen(ctx, owner, STALL_RANGE, run)
    },
    window: what => {
      if (!win) return
      if (what === 'close') {
        win.hide()
        win.clearChat()
        tooltip.hide()
      } else if (what === 'open') {
        win.show()
        // Retail puts the inventory beside the stall for the owner, who lists from it.
        if (ctrl.model.isOwner) hud.openInventory?.()
      } else win.render()
    },
    windowOpen: () => !!win?.isOpen,
    saleSound: () => gameAudio()?.ui('item.dropGold'),
    now: () => performance.now(),
    askTitle: initial => MessageBox.prompt({ title: t('stall.title'), text: t('stall.enterName'), maxLength: STALL_TITLE_MAX, initial, allowEmpty: true, art }),
    askGreeting: initial => MessageBox.prompt({ title: t('stall.title'), text: t('stall.enterGreeting'), maxLength: STALL_GREETING_MAX, initial, allowEmpty: true, art }),
    askCount: stack => MessageBox.count({ title: t('stall.countTitle'), text: t('stall.countBody', { item: hud.items.name(stack.code) }), max: stack.count, initial: stack.count, art }),
    askPrice: (stack, initial) => askPrice({ items: hud.items, stack, initial: initial || suggestedPrice(hud.items, stack) || undefined, art }),
    confirm: (title, text) => MessageBox.confirm({ title, text, art }),
  }
  const ctrl = new StallController(io)
  ctrl.model.selfId = ctx.selfId()

  win = new StallWindow(art, hud.layer, {
    items: hud.items,
    tooltip,
    model: ctrl.model,
    level: () => hud.stats?.level ?? null,
    toggleState: () => ctrl.toggleState(),
    editTitle: () => void ctrl.editTitle(),
    editGreeting: () => void ctrl.editGreeting(),
    closeStall: () => ctrl.closeStall(),
    requestClose: () => void ctrl.requestClose(),
    listBag: (bag, slot) => void ctrl.listBag(bag, slot),
    editPrice: slot => void ctrl.editPrice(slot),
    remove: slot => ctrl.remove(slot),
    buy: slot => void ctrl.buy(slot),
    chat: text => ctrl.chat(text),
  })

  // D20: the MENU popup row.
  const entry: MenuBarEntry = {
    id: 'stall',
    art: 'underbar/ub_new_icon_stall',
    icon: 'underbar/ub_new_icon_stall',
    label: 'stall.menu',
    order: 70,
    toggle: () => ctrl.menu(),
    isOpen: () => !!win?.isOpen,
  }
  offs.push(hud.menubar.register(entry))
  // D9: `/stall` and `/stall <title>`.
  offs.push(chat.registerPrefix(STALL_COMMAND, rest => ctrl.command(rest)))
  // The owner's right click in the bag lists the item (every other bag request is refused while stalling).
  offs.push(hud.routeBagAction(bag => ctrl.bagAction(bag)))

  return {
    onMessage(msg: ServerMessage) {
      ctrl.onMessage(msg)
    },
    onEntityAdded(v) {
      ctrl.entityAdded(v.id, v.state)
    },
    onEntityRemoved(v) {
      ctrl.entityRemoved(v.id)
    },
    clickEntity(v) {
      if (v.kind === 'player') return ctrl.clickPlayer(v.id)
      if (v.kind === 'mob' || v.kind === 'npc' || v.kind === 'item') return ctrl.blockedClick()
      return false
    },
    beforeGroundMove() {
      return ctrl.beforeGroundMove()
    },
    dispose() {
      for (const off of offs) off()
      hud.markBagSlots('stall', new Set())
      tooltip.dispose()
      win?.dispose()
      win = null
    },
  }
}
