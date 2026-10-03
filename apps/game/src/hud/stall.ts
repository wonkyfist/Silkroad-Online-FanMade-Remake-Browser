/**
 * The stall window (docs/SYSTEMS_SOCIAL.md §9.3, docs/UI.md §4.6; lane ST-C): one kit window of 467×490 (retail
 * `ginterface.txt GDR_STALL`, `ifstall.txt`, `ifstallslot.txt`) with an owner view and a visitor view.
 *  - Title row: `stl_titlebutton` (22,51) and the title on `stl_slot_01` (48,50); the state button Open / Modify
 *    (`com_button` at (369,51), owner only); the "Operating" / "Modifying" label on `stl_slot_04` (350,85) with the
 *    state icon (354,88); visitors (and, for a visitor, the owner's name) left of it; Close stall (owner).
 *  - Goods: `GDR_STALL_DISPLAY` (22,108,423,216) in `equip_window_`, two columns of five `stl_slot_02` rows
 *    (`stl_slot_05` when empty) split by the `com_bg_tile_e` divider; each row: icon (3,3), name (46,6), amount
 *    (42,26), price (86,26), and at (183,0) the pencil `stl_edit_button` (owner) or the coin (visitor, buy).
 *  - Greeting: `stl_wordbutton` (22,328) and `stl_slot_03` (48,327). Stall chat: `GDR_STALL_CHAT` (22,357,423,110).
 * It draws only what the server's `stall` said (StallModel); every change is an intent through the host. The owner
 * lists by dropping a bag item on a row or right clicking it in the bag; a visitor buys with the coin or a right
 * click, after a confirmation. PriceBox is the price entry (retail sale message box with `sell_masgbox_iteminfo`).
 */
import type { ItemStack } from '@sro/shared'
import { STALL_PRICE_MAX, STALL_SLOTS } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place, type Rect } from '../ui/dom.ts'
import { button, iconButton, type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { kitArt } from '../ui/kit/host.ts'
import { TextInput } from '../ui/kit/input.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { CONTROLS } from '../ui/kit/skins.ts'
import type { ItemCatalog, TooltipLine } from './items.ts'
import { hudBagDrag, NpcWindow } from './npc-ui.ts'
import { SlotView, type Tooltip } from './slots.ts'
import { formatPrice, formatPriceInput, parsePrice, stallRows, visitorsText, type StallModel, type StallRow } from './stall-state.ts'

export const STALL_W = 467
export const STALL_H = 490
/** Stall chat lines kept in the window. */
export const STALL_CHAT_LINES = 60

/** What the window needs from the feature. */
export interface StallHost {
  readonly items: ItemCatalog
  readonly tooltip: Tooltip
  readonly model: StallModel
  level(): number | null
  /** Open <-> Modify (owner). */
  toggleState(): void
  editTitle(): void
  editGreeting(): void
  /** The Close stall button (owner). */
  closeStall(): void
  /** The close button or Esc: the owner is asked to close the stall, a visitor leaves. */
  requestClose(): void
  /** Bag slot `bag` dropped on stall row `slot` (-1 = the first free one). */
  listBag(bag: number, slot: number): void
  editPrice(slot: number): void
  remove(slot: number): void
  buy(slot: number): void
  /** A line typed in the stall chat. */
  chat(text: string): void
}

/** Row geometry (retail 208×44 rows, fitted two by five into the 423×216 list). */
const ROW_W = 204
const ROW_H = 42
const ROW_GAP = 1
const COL_X = [25, 238] as const
const LIST_Y = 109

const CSS = `
.kit-window-stall .st-tile { position: absolute; background-repeat: repeat; pointer-events: none; }
.kit-window-stall .st-strip { position: absolute; box-sizing: border-box; background: no-repeat 0 0 / 100% 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-stall .st-strip.no-art { background: rgba(0, 0, 0, 0.55); box-shadow: inset 0 0 0 1px var(--c-rim); }
.kit-window-stall .st-title { padding: 0 29px 0 8px; font: 13px/28px var(--font-title); color: var(--c-heading); text-shadow: var(--t-outline); }
.kit-window-stall .st-greeting { padding: 0 8px; font: 12px/28px var(--font-body); color: var(--c-text); text-shadow: var(--t-shadow); }
.kit-window-stall .st-greeting.placeholder, .kit-window-stall .st-title.placeholder { color: var(--c-hint); }
.kit-window-stall .st-state { padding-left: 27px; font: 12px/24px var(--font-body); color: var(--c-good); text-shadow: var(--t-outline); }
.kit-window-stall .st-state.modify { color: var(--c-warn); }
.kit-window-stall .st-state-icon { position: absolute; width: 20px; height: 20px; background: no-repeat 0 0 / 100% 100%; pointer-events: none; }
.kit-window-stall .st-info { position: absolute; display: flex; gap: 14px; align-items: center; font: 12px/20px var(--font-body); color: var(--c-label); text-shadow: var(--t-shadow); white-space: nowrap; }
.kit-window-stall .st-info b { font-weight: normal; color: var(--c-text); }
.kit-window-stall .st-row { position: absolute; box-sizing: border-box; background: no-repeat 0 0 / 100% 100%; }
.kit-window-stall .st-row.no-art { background: rgba(0, 0, 0, 0.45); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.5); }
.kit-window-stall .st-row .kit-slot { position: absolute; left: 1px; top: 0; }
.kit-window-stall .st-row-name { position: absolute; left: 46px; top: 5px; width: 128px; height: 14px; font: 12px/14px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-stall .st-row-name.plus { color: var(--c-magic); }
.kit-window-stall .st-row-amount { position: absolute; left: 42px; top: 25px; width: 39px; height: 12px; text-align: center; font: 11px/12px var(--font-body); color: var(--c-label); text-shadow: var(--t-outline); font-variant-numeric: tabular-nums; }
.kit-window-stall .st-row-price { position: absolute; left: 86px; top: 25px; width: 88px; height: 12px; padding-right: 3px; box-sizing: border-box; text-align: right; font: 11px/12px var(--font-body); color: var(--c-level); text-shadow: var(--t-outline); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.kit-window-stall .st-row-act { position: absolute; }
.kit-window-stall .st-row-act[hidden] { display: none; }
.kit-window-stall .st-row.drop-hover { box-shadow: inset 0 0 0 1px var(--c-level); }
.kit-window-stall .st-row.buyable { cursor: pointer; }
.kit-window-stall .st-row.buyable:hover .st-row-name { color: var(--c-highlight); }
.kit-window-stall.st-closed .st-row { filter: grayscale(0.6) brightness(0.7); }
.kit-window-stall .st-overlay { position: absolute; display: grid; place-items: center; text-align: center; padding: 0 30px; box-sizing: border-box; pointer-events: none; font: 13px/18px var(--font-title); color: var(--c-warn); text-shadow: var(--t-outline); }
.kit-window-stall .st-overlay.soft { font: 12px/16px var(--font-body); color: var(--c-label); }
.kit-window-stall .st-overlay[hidden] { display: none; }
.kit-window-stall .st-chat-log { position: absolute; }
.kit-window-stall .st-chat-log .kit-scroll-view { padding: 2px 4px; box-sizing: border-box; }
.kit-window-stall .st-chat-line { font: 12px/15px var(--font-chat); color: var(--c-chat-stall); text-shadow: var(--t-shadow); overflow-wrap: anywhere; user-select: text; }
.kit-window-stall .st-chat-line .who { color: var(--c-label); }
.kit-window-stall .st-chat-line.self .who { color: var(--c-highlight); }
.kit-window-stall .st-chat-input { position: absolute; }
.kit-window-stall .st-chat-input input { width: 100%; }
.stall-price-box .st-price-item { position: relative; width: 268px; height: 44px; flex: none; background: no-repeat 0 0 / 100% 100%; }
.stall-price-box .st-price-item.no-art { background: rgba(0, 0, 0, 0.5); box-shadow: inset 0 0 0 1px var(--c-rim); }
.stall-price-box .st-price-item .kit-slot { position: absolute; left: 5px; top: 4px; }
.stall-price-box .st-price-name { position: absolute; left: 48px; top: 6px; right: 8px; font: 12px/16px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stall-price-box .st-price-count { position: absolute; left: 48px; top: 23px; right: 8px; font: 11px/14px var(--font-body); color: var(--c-label); text-shadow: var(--t-outline); }
.stall-price-box .st-price-row { display: flex; align-items: center; gap: 6px; }
.stall-price-box .st-price-row .kit-input { text-align: right; font-variant-numeric: tabular-nums; }
.stall-price-box .kit-field.invalid { box-shadow: 0 0 0 1px var(--c-bad); }
`

let injected = false
export function ensureStallStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'hud-stall'
  s.textContent = CSS
  document.head.append(s)
}

/** The rect (window px) of stall row `slot`: column-major pairs (0 | 1 on the first line, 2 | 3 on the next …). */
export function rowRect(slot: number): Rect {
  const col = slot % 2
  const line = Math.floor(slot / 2)
  return [COL_X[col]!, LIST_Y + line * (ROW_H + ROW_GAP), ROW_W, ROW_H]
}

/** "Short Sword +3" (the plus is part of the name line). */
export function stackLabel(items: ItemCatalog, stack: ItemStack): string {
  const name = items.name(stack.code)
  return stack.plus ? `${name} +${stack.plus}` : name
}

interface RowView {
  root: HTMLElement
  slot: SlotView
  name: HTMLElement
  amount: HTMLElement
  price: HTMLElement
  edit: KitButton
  coin: KitButton
  row: StallRow | null
}

export class StallWindow extends NpcWindow {
  private readonly titleText: HTMLElement
  private readonly titleButton: KitButton
  private readonly stateButton: KitButton
  private readonly stateLabel: HTMLElement
  private readonly stateIcon: HTMLElement
  private readonly info: HTMLElement
  private readonly closeStallButton: KitButton
  private readonly greetingText: HTMLElement
  private readonly greetingButton: KitButton
  private readonly overlay: HTMLElement
  private readonly rows: RowView[] = []
  private readonly chatLog: ScrollArea
  private readonly chatInput: TextInput
  private forcing = false

  constructor(art: Art, parent: HTMLElement, private readonly host: StallHost) {
    ensureStallStyles()
    super(art, parent, { id: 'stall', title: t('stall.title'), width: STALL_W, height: STALL_H, at: [0.3, 0.35] })
    const b = this.body
    b.append(new Frame(art, 'inner', { at: this.r([11, 39, 447, 440]), className: 'st-inner' }).root)
    b.append(this.tile(art, 'ifcommon/bg_tile/com_bg_tile_b', [27, 55, 415, 53]), this.tile(art, 'ifcommon/bg_tile/com_bg_tile_b', [27, 324, 415, 34]))

    // Title row.
    this.titleButton = this.at(iconButton(art, 'stall/stl_titlebutton', { title: t('stall.changeTitle'), fallbackText: 'T', w: 28, h: 28 }, () => this.host.editTitle()), [22, 51, 28, 28])
    this.titleText = this.at(this.strip(art, 'stall/stl_slot_01', 'st-title'), [48, 50, 308, 28])
    this.stateButton = this.at(button(art, { label: t('stall.open'), width: 76, primary: true }, () => this.host.toggleState()), [369, 51, 76, 24])
    // State line.
    this.stateLabel = this.at(this.strip(art, 'stall/stl_slot_04', 'st-state'), [350, 85, 96, 24])
    this.stateIcon = this.at(el('div', 'st-state-icon'), [354, 87, 20, 20])
    this.info = this.at(el('div', 'st-info'), [30, 87, 230, 20])
    this.closeStallButton = this.at(button(art, { label: t('stall.close'), width: 84 }, () => this.host.closeStall()), [262, 85, 84, 24])
    b.append(this.titleButton, this.titleText, this.stateButton, this.stateLabel, this.stateIcon, this.info, this.closeStallButton)

    // Goods.
    b.append(new Frame(art, 'panel', { at: this.r([22, 108, 423, 216]), className: 'st-list' }).root)
    b.append(this.tile(art, 'ifcommon/bg_tile/com_bg_tile_e', [229, 112, 9, 208]))
    for (let slot = 0; slot < STALL_SLOTS; slot++) {
      const v = this.makeRow(art, slot)
      this.rows.push(v)
      b.append(v.root)
    }
    this.overlay = this.at(el('div', 'st-overlay'), [22, 108, 423, 216])
    b.append(this.overlay)

    // Greeting.
    this.greetingButton = this.at(iconButton(art, 'stall/stl_wordbutton', { title: t('stall.changeGreeting'), fallbackText: 'G', w: 28, h: 28 }, () => this.host.editGreeting()), [22, 328, 28, 28])
    this.greetingText = this.at(this.strip(art, 'stall/stl_slot_03', 'st-greeting'), [48, 327, 400, 28])
    b.append(this.greetingButton, this.greetingText)

    // Stall chat.
    b.append(new Frame(art, 'panel', { at: this.r([22, 358, 423, 110]), className: 'st-chat' }).root)
    this.chatLog = new ScrollArea(art, { className: 'st-chat-log' })
    this.at(this.chatLog.root, [28, 363, 411, 72])
    this.chatInput = new TextInput(art, { maxLength: 100, placeholder: t('stall.chatPlaceholder'), label: t('stall.chatPlaceholder'), className: 'st-chat-input' })
    this.at(this.chatInput.root, [28, 440, 411, 22])
    b.append(this.chatLog.root, this.chatInput.root)
    this.ls.on(this.chatInput.input, 'keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        ev.stopPropagation()
        const text = this.chatInput.value.trim()
        if (text) this.host.chat(text)
        this.chatInput.value = ''
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        this.chatInput.input.blur()
      }
    })

    // A bag item dragged by the HUD and released over the stall: list it (in the row under the pointer).
    this.ls.on(this.root, 'pointerup', ev => {
      const bag = hudBagDrag()
      if (bag === null || !this.host.model.isOwner) return
      const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const row = hit?.closest<HTMLElement>('[data-stall]')
      this.host.listBag(bag, row ? Number(row.dataset.stall) : -1)
    })
    this.onClose = () => this.host.tooltip.hide()
    this.render()
  }

  /** Every stall row element (for tests of the layout and the browser check). */
  rowElement(slot: number): HTMLElement | undefined {
    return this.rows[slot]?.root
  }

  /** The close button and Esc ask the host (owner: close the stall?; visitor: leave). */
  override close(): void {
    if (!this.isOpen) return
    if (this.forcing || !this.host.model.view) {
      super.close()
      return
    }
    this.host.requestClose()
  }

  /** Closes without asking (the stall ended). */
  hide(): void {
    this.forcing = true
    try {
      super.close()
    } finally {
      this.forcing = false
    }
  }

  show(): void {
    this.render()
    this.open()
    this.raise()
  }

  /** Redraws everything from the model. */
  render(): void {
    const m = this.host.model
    const v = m.view
    const owner = m.isOwner
    this.root.classList.toggle('st-owner', owner)
    this.root.classList.toggle('st-visitor', m.isVisitor)
    this.root.classList.toggle('st-closed', m.isVisitor && !m.isOpen)
    this.setTitle(t('stall.title'))
    setStrip(this.titleText, v?.title ?? '', t('stall.enterName'))
    setStrip(this.greetingText, v?.greeting ?? '', owner ? t('stall.enterGreeting') : '')
    this.titleButton.setDisabled(!owner)
    this.greetingButton.setDisabled(!owner)
    this.titleButton.hidden = !owner
    this.greetingButton.hidden = !owner
    this.stateButton.hidden = !owner
    this.stateButton.setLabel(m.isOpen ? t('stall.modify') : t('stall.open'))
    this.stateButton.setDisabled(!v || (!m.isOpen && m.listedCount === 0))
    this.stateButton.title = !m.isOpen && m.listedCount === 0 ? t('stall.nothing') : ''
    this.closeStallButton.hidden = !owner
    this.stateLabel.textContent = m.isOpen ? t('stall.operating') : t('stall.modifying')
    this.stateLabel.classList.toggle('modify', !m.isOpen)
    const icon = m.isOpen ? 'stall/stl_condition_icon_01' : 'stall/stl_condition_icon_02'
    this.stateIcon.style.backgroundImage = this.art.has(icon) ? this.art.cssUrl(icon) : ''
    this.renderInfo()
    const rows = stallRows(m)
    rows.forEach((r, i) => this.renderRow(this.rows[i]!, r))
    // Overlay: the visitor's "under construction", or an empty stall's hint.
    if (v && m.isVisitor && !m.isOpen) {
      this.overlay.textContent = t('stall.underConstruction')
      this.overlay.className = 'st-overlay'
      this.overlay.hidden = false
    } else if (v && m.listedCount === 0) {
      this.overlay.textContent = owner ? (m.isOpen ? t('stall.modifyFirst') : t('stall.emptyOwner')) : t('stall.emptyVisitor')
      this.overlay.className = 'st-overlay soft'
      this.overlay.hidden = false
    } else this.overlay.hidden = true
  }

  /** The visitor count (and the owner's name for a visitor). */
  renderInfo(): void {
    const m = this.host.model
    const { count, max } = visitorsText(m.view)
    this.info.replaceChildren()
    if (m.isVisitor && m.view) this.info.append(el('span', '', t('stall.owner', { name: '' }), el('b', '', m.view.name)))
    this.info.append(el('span', '', t('stall.visitors', { count, max })))
  }

  /** A stall chat line (`self` = your own). */
  addChat(name: string, text: string, self = false): void {
    const line = el('div', `st-chat-line${self ? ' self' : ''}`, el('span', 'who', `${name}: `), document.createTextNode(text))
    const view = this.chatLog.view
    const stick = view.scrollTop + view.clientHeight >= view.scrollHeight - 4
    view.append(line)
    while (view.childElementCount > STALL_CHAT_LINES) view.firstElementChild?.remove()
    if (stick) this.chatLog.toBottom()
  }

  clearChat(): void {
    this.chatLog.view.replaceChildren()
  }

  override dispose(): void {
    this.chatLog.dispose()
    super.dispose()
  }

  // ---- pieces ---------------------------------------------------------------------------------------------

  private tile(art: Art, key: string, rect: Rect): HTMLElement {
    const d = this.at(el('div', 'st-tile'), rect)
    if (art.has(key)) d.style.backgroundImage = art.cssUrl(key)
    return d
  }

  private strip(art: Art, key: string, cls: string): HTMLElement {
    const d = el('div', `st-strip ${cls}`)
    if (art.has(key)) d.style.backgroundImage = art.cssUrl(key)
    else d.classList.add('no-art')
    return d
  }

  private makeRow(art: Art, slot: number): RowView {
    const root = this.at(el('div', 'st-row'), rowRect(slot))
    root.dataset.stall = String(slot)
    const view = new SlotView(this.host.items, { kind: 'bag', slot }, 'st-slot', art)
    delete view.root.dataset.bag
    const name = el('div', 'st-row-name')
    const amount = el('div', 'st-row-amount')
    const price = el('div', 'st-row-price')
    const edit = iconButton(art, 'stall/stl_edit_button', { title: t('stall.edit'), fallbackText: '✎', w: 24, h: 24, className: 'st-row-act' }, () => this.host.editPrice(slot))
    place(edit, [178, 0, 24, 24])
    const coin = iconButton(art, CONTROLS.money, { title: t('stall.buy'), fallbackText: 'G', w: 20, h: 20, className: 'st-row-act' }, () => this.host.buy(slot))
    place(coin, [180, 2, 20, 20])
    root.append(view.root, name, amount, price, edit, coin)
    const rv: RowView = { root, slot: view, name, amount, price, edit, coin, row: null }
    this.ls.on(root, 'contextmenu', ev => {
      ev.preventDefault()
      this.host.tooltip.hide()
      const m = this.host.model
      if (!rv.row?.stack) return
      if (m.isOwner) this.host.remove(slot)
      else if (m.isVisitor) this.host.buy(slot)
    })
    this.ls.on(root, 'dblclick', () => {
      if (rv.row?.stack && this.host.model.isVisitor) this.host.buy(slot)
    })
    const hover = (ev: PointerEvent | null) => {
      const dragging = document.body.classList.contains('hud-dragging')
      root.classList.toggle('drop-hover', !!ev && dragging && this.host.model.canEdit)
      const stack = rv.row?.stack
      if (!ev || !stack || dragging) return this.host.tooltip.hide()
      this.host.tooltip.show(this.tooltip(rv.row!), ev.clientX, ev.clientY)
    }
    this.ls.on(root, 'pointerenter', ev => hover(ev))
    this.ls.on(root, 'pointermove', ev => hover(ev))
    this.ls.on(root, 'pointerleave', () => hover(null))
    return rv
  }

  private renderRow(v: RowView, r: StallRow): void {
    v.row = r
    const m = this.host.model
    const bg = r.stack ? 'stall/stl_slot_02' : 'stall/stl_slot_05'
    if (this.art.has(bg)) {
      v.root.style.backgroundImage = this.art.cssUrl(bg)
      v.root.classList.remove('no-art')
    } else v.root.classList.add('no-art')
    v.slot.set(r.stack)
    v.name.textContent = r.stack ? stackLabel(this.host.items, r.stack) : ''
    v.name.classList.toggle('plus', !!r.stack?.plus)
    v.amount.textContent = r.stack ? t('stall.amount', { count: r.stack.count }) : ''
    v.price.textContent = r.stack ? r.priceText : ''
    v.edit.hidden = !m.isOwner || !r.stack
    v.edit.setDisabled(!r.editable)
    v.coin.hidden = !m.isVisitor || !r.stack
    v.coin.setDisabled(!r.buyable)
    v.root.classList.toggle('buyable', r.buyable)
  }

  private tooltip(r: StallRow): TooltipLine[] {
    const level = this.host.level()
    const lines = this.host.items.tooltip(r.stack!, { player: level === null ? null : { level } }).filter(l => l.cls !== 'hint')
    lines.push({ text: t('stall.tipPrice', { price: r.priceText }), cls: 'title' })
    const m = this.host.model
    if (r.buyable) lines.push({ text: t('stall.tipBuy'), cls: 'hint' })
    else if (m.isOwner && r.editable) lines.push({ text: t('stall.tipRemove'), cls: 'hint' })
    else if (m.isOwner) lines.push({ text: t('stall.modifyFirst'), cls: 'hint' })
    return lines
  }
}

function setStrip(e: HTMLElement, text: string, placeholder: string): void {
  e.textContent = text || placeholder
  e.classList.toggle('placeholder', !text)
  e.title = text
}

// ---- price entry ---------------------------------------------------------------------------------------------

export interface PriceRequest {
  items: ItemCatalog
  stack: ItemStack
  initial?: number
  art?: Art
}

/**
 * The price box (retail stall sale message box: the `sell_masgbox_iteminfo` strip with the item, then the price
 * field). The field regroups digits with commas as you type and accepts k / m / b; OK stays off until the price is
 * 1..1,000,000,000. Enter confirms, Esc or a press on the shade cancels. Resolves the price or null.
 */
export function askPrice(req: PriceRequest): Promise<number | null> {
  ensureStallStyles()
  const art = req.art ?? kitArt()
  return new Promise(resolve => {
    const shade = el('div', 'kit-modal')
    const frame = new Frame(art, 'dialog', { w: 300, h: 226, className: 'kit-msgbox stall-price-box' })
    const caption = el('div', 'kit-msgbox-title kit-t-title', t('stall.priceTitle'))
    caption.style.height = '30px'
    caption.style.lineHeight = '30px'
    frame.root.append(caption)
    frame.root.setAttribute('role', 'dialog')
    frame.root.setAttribute('aria-modal', 'true')
    frame.root.setAttribute('aria-label', t('stall.priceTitle'))
    const label = stackLabel(req.items, req.stack)
    const item = el('div', 'st-price-item')
    if (art.has('stall/sell_masgbox_iteminfo')) item.style.backgroundImage = art.cssUrl('stall/sell_masgbox_iteminfo')
    else item.classList.add('no-art')
    const slot = new SlotView(req.items, { kind: 'bag', slot: 0 }, 'st-price-slot', art)
    delete slot.root.dataset.bag
    slot.set(req.stack)
    item.append(slot.root, el('div', 'st-price-name', label), el('div', 'st-price-count', t('stall.amount', { count: req.stack.count })))
    const body = req.stack.count > 1 ? t('stall.priceBody', { item: label, count: req.stack.count }) : t('stall.priceBodyOne', { item: label })
    const field = new TextInput(art, { value: req.initial ? formatPrice(req.initial) : '', maxLength: 16, w: 170, label: t('stall.priceLabel') })
    field.input.inputMode = 'numeric'
    const row = el('div', 'st-price-row', el('span', 'kit-t-label', t('stall.priceLabel')), field.root, el('span', 'kit-t-label', t('stall.priceUnit')))
    const err = el('div', 'kit-msgbox-error kit-t-small')
    let closed = false
    const done = (v: number | null) => {
      if (closed) return
      closed = true
      shade.remove()
      resolve(v)
    }
    const check = (): number | null => {
      const n = parsePrice(field.value)
      const bad = n === null && field.value.trim() !== ''
      field.root.classList.toggle('invalid', bad)
      err.textContent = bad ? t('stall.priceRange') : ''
      ok.setDisabled(n === null)
      return n
    }
    const submit = () => {
      const n = check()
      if (n === null) {
        err.textContent = t('stall.priceRange')
        return
      }
      done(n)
    }
    const ok = button(art, { label: t('kit.ok'), primary: true }, submit)
    const cancel = button(art, { label: t('kit.cancel') }, () => done(null))
    frame.body.append(item, el('div', 'kit-msgbox-text kit-t-body', body), row, err, el('div', 'kit-msgbox-buttons', ok, cancel))
    field.input.addEventListener('input', () => {
      const atEnd = field.input.selectionStart === field.input.value.length
      const next = formatPriceInput(field.value)
      if (next !== field.value && atEnd) field.value = next
      check()
    })
    shade.append(frame.root)
    shade.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') {
        ev.preventDefault()
        submit()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        done(null)
      }
    })
    shade.addEventListener('keyup', ev => ev.stopPropagation())
    shade.addEventListener('pointerdown', ev => {
      if (ev.target === shade) done(null)
      ev.stopPropagation()
    })
    shade.addEventListener('contextmenu', ev => ev.preventDefault())
    document.body.append(shade)
    check()
    field.focus(true)
  })
}

/** The price a new listing starts at: the item's NPC price, clamped into the stall range (0 = none). */
export function suggestedPrice(items: ItemCatalog, stack: ItemStack): number {
  const def = items.def(stack.code)
  const each = def ? Math.max(def.price ?? 0, def.sellPrice ?? 0) : 0
  const n = Math.round(each * stack.count)
  return n >= 1 ? Math.min(STALL_PRICE_MAX, n) : 0
}
