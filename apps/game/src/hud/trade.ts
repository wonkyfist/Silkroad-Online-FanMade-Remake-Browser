/**
 * The exchange window of lane TR-C (docs/SYSTEMS_SOCIAL.md §9.2; docs/UI.md §4.6; decision D39): the retail
 * `mframe` 365×500 of `ifexchange.txt` with both defines on (`APPLY_EXCHANGE_UPDATE_1TH` + `UI_UPDATE_2009_FIRST`).
 * - Partner on top, you below: two `sframe_wnd_` halves (9,38,346,141) / (9,182,346,141), each with a 6 × 2 lattice
 *   (21,72) / (21,216), a separator `exc_sub_window_line` (14,146) / (14,290), the gold box `exc_box` (71,152) /
 *   (71,296) with the money button (40,152, disabled) / (40,296), and the gold label at x 181.
 * - The character views (`com_blacksquare_` 100×104 at (247,70) / (247,214), `ch_line` beside them) carry a name plate
 *   and the Locked / Accepted badge; a locked partner gets the red rim (the retail `ch_red` glow, decision §9.2).
 * - The text box `frame_msg_` (10,339,345,95) shows the status lines; Confirm (96,450) and Cancel (193,450).
 *
 * It draws only what the last `trade` state said; every action is an intent through the host. Items go in by dragging
 * a bag slot onto the window or right-clicking it in the bag (the feature routes that; Shift asks for an amount), and
 * come back by right-clicking (or dragging out) your own exchange slot.
 */
import { TRADE_SLOTS, type ItemStack, type TradeSide, type TradeState } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button, iconButton, type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Section } from '../ui/kit/section.ts'
import { CONTROLS } from '../ui/kit/skins.ts'
import { formatNumber, type ItemCatalog, type TooltipLine } from './items.ts'
import { ensureNpcStyles, hudBagDrag, ItemDrag, latticeClass, NpcWindow, slotGrid } from './npc-ui.ts'
import { SlotView, type Tooltip } from './slots.ts'
import { confirmButton } from './trade-state.ts'

export const TRADE_W = 365
export const TRADE_H = 500
const COLS = 6

/** What the window needs from the feature. */
export interface TradeHost {
  readonly items: ItemCatalog
  readonly tooltip: Tooltip
  /** Own level (tooltip requirement colours); null before the first stats. */
  level(): number | null
  /** A bag item released over the window; `ask`: Shift was held (ask for an amount). */
  offer(bag: number, ask: boolean): void
  /** Takes own exchange slot `slot` back. */
  take(slot: number): void
  /** The own money button: ask for the gold to offer. */
  gold(): void
  /** The Confirm / Exchange button. */
  confirm(): void
  /** Cancel, the close button or Esc (the feature sends tradeCancel). */
  cancel(): void
}

const CSS = `
.hud-window-trade .trade-half.flash { animation: trade-flash 0.35s ease-in-out 3; }
@keyframes trade-flash { 50% { filter: brightness(1.7) saturate(1.3); } }
.hud-window-trade .trade-sep { background-repeat: repeat-x; }
.hud-window-trade .trade-sep.no-art { background: linear-gradient(transparent 1px, rgba(214, 190, 128, 0.45) 1px, rgba(214, 190, 128, 0.45) 2px, transparent 2px); }
.hud-window-trade .trade-goldbox {
  display: flex; align-items: center; justify-content: flex-end; padding: 0 8px; box-sizing: border-box;
  color: var(--c-text); font: 12px/20px var(--font-body); text-shadow: var(--t-outline); font-variant-numeric: tabular-nums;
  background: no-repeat 0 0 / 100% 100%;
}
.hud-window-trade .trade-goldbox.no-art { background: rgba(0, 0, 0, 0.55); box-shadow: inset 0 0 0 1px var(--c-rim); }
.hud-window-trade .trade-goldbox.set { color: var(--c-level); }
.hud-window-trade .trade-goldlabel { color: var(--c-label); font: 11px/12px var(--font-body); text-shadow: var(--t-shadow); }
.hud-window-trade .trade-vline { background: no-repeat 0 0 / 100% 100%; }
.hud-window-trade .trade-view .kit-box-body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; text-align: center; }
.hud-window-trade .trade-view-name { color: var(--c-text); font: 12px/15px var(--font-body); text-shadow: var(--t-outline); max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-window-trade .trade-view-level { color: var(--c-label); font: 11px/13px var(--font-body); text-shadow: var(--t-shadow); }
.hud-window-trade .trade-view-badge {
  min-width: 64px; padding: 1px 6px; box-sizing: border-box; border-radius: 2px;
  font: bold 11px/15px var(--font-body); text-shadow: var(--t-outline); color: #fff;
}
.hud-window-trade .trade-view-badge:empty { display: none; }
.hud-window-trade .trade-view-badge.locked { background: rgba(150, 24, 16, 0.85); box-shadow: 0 0 0 1px #ff6a4a; }
.hud-window-trade .trade-view-badge.accepted { background: rgba(28, 110, 30, 0.85); box-shadow: 0 0 0 1px #8ef27a; }
.hud-window-trade .trade-view.locked { box-shadow: 0 0 0 2px #d22b1c, 0 0 10px 2px rgba(255, 60, 30, 0.55); }
.hud-window-trade .trade-view.accepted { box-shadow: 0 0 0 2px #3aa634, 0 0 10px 2px rgba(90, 230, 70, 0.5); }
.hud-window-trade .trade-half.locked .kit-slot-grid { filter: saturate(0.75) brightness(0.9); }
.hud-window-trade .trade-log .kit-box-body { display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; padding: 2px 4px; box-sizing: border-box; }
.hud-window-trade .trade-log-line { color: #c9bfa4; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); flex: none; }
.hud-window-trade .trade-log-line.last { color: var(--c-level); }
.hud-window-trade .trade-log-line.warn { color: var(--c-bad); }
.hud-window-trade .trade-empty { text-align: center; color: #a89d82; font: 10px/12px var(--font-body); text-shadow: var(--t-shadow); pointer-events: none; }
.hud-window-trade .trade-empty[hidden] { display: none; }
`

let injected = false
function ensureStyles(): void {
  ensureNpcStyles()
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-trade'
  style.textContent = CSS
  document.head.append(style)
}

/** One half of the window (partner or own). */
interface Half {
  section: Section
  slots: SlotView[]
  gold: HTMLElement
  view: Frame
  name: HTMLElement
  level: HTMLElement
  badge: HTMLElement
  empty: HTMLElement
}

/** A trade slot: the SlotView drawing without `data-bag` (the HUD's drag never mistakes it for one). */
function tradeSlot(items: ItemCatalog, side: 'mine' | 'theirs', i: number): SlotView {
  const v = new SlotView(items, { kind: 'bag', slot: i }, `npc-slot trade-slot trade-slot-${side}`)
  delete v.root.dataset.bag
  v.root.dataset.trade = `${side}:${i}`
  v.root.classList.add(latticeClass(i, COLS))
  return v
}

export class TradeWindow extends NpcWindow {
  private readonly partner: Half
  private readonly own: Half
  private readonly log: Frame
  private readonly confirmButton: KitButton
  private readonly cancelButton: KitButton
  private readonly money: KitButton
  private readonly drag: ItemDrag<number>
  private state: TradeState | null = null
  private quiet = false

  constructor(art: Art, parent: HTMLElement, private readonly host: TradeHost) {
    ensureStyles()
    super(art, parent, { id: 'trade', title: t('trade.title'), width: TRADE_W, height: TRADE_H, at: [0.3, 0.3] })
    this.partner = this.half(art, 'theirs', 38)
    this.own = this.half(art, 'mine', 182)
    this.own.section.root.title = t('trade.hintOffer')
    this.own.empty.textContent = t('trade.hintOffer')

    const partnerMoney = iconButton(art, art.has('ifcommon/com_moneybutton_disable') ? 'ifcommon/com_moneybutton_disable' : CONTROLS.money, { fallbackText: 'G', w: 20, h: 20, sfx: 'none' })
    partnerMoney.setDisabled(true)
    this.body.append(this.at(partnerMoney, [40, 152, 20, 20]))
    this.money = iconButton(art, CONTROLS.money, { title: t('trade.moneyHint'), fallbackText: 'G', w: 20, h: 20 }, () => this.host.gold())
    this.body.append(this.at(this.money, [40, 296, 20, 20]))

    this.log = new Frame(art, 'field', { at: this.r([10, 339, 345, 95]), className: 'trade-log' })
    this.confirmButton = button(art, { label: t('trade.confirm'), minWidth: 76, primary: true }, () => this.host.confirm())
    this.cancelButton = button(art, { label: t('trade.cancel'), minWidth: 76 }, () => this.host.cancel())
    this.body.append(this.log.root, this.at(this.confirmButton, [96, 450, 76, 24]), this.at(this.cancelButton, [193, 450, 76, 24]))

    this.drag = new ItemDrag((slot, target) => {
      if (target.kind === 'bag' || target.kind === 'inventory' || target.kind === 'outside') this.host.take(slot)
    })
    this.drag.onStart = () => this.host.tooltip.hide()
    // A bag item dragged by the HUD and released over the window: offer it.
    this.ls.on(this.root, 'pointerup', ev => {
      const bag = hudBagDrag()
      if (bag !== null) this.host.offer(bag, ev.shiftKey)
    })
    this.onClose = () => {
      this.host.tooltip.hide()
      this.drag.cancel()
      if (!this.quiet) this.host.cancel()
    }
  }

  /** Opens (or redraws) for a trade state. */
  show(state: TradeState, log: readonly string[], selfName: string): void {
    this.render(state, log, selfName)
    if (!this.isOpen) this.open()
    this.raise()
  }

  /** Closes without sending a cancel (the exchange ended on the server). */
  hide(): void {
    this.quiet = true
    try {
      this.close()
    } finally {
      this.quiet = false
    }
    this.state = null
  }

  render(state: TradeState, log: readonly string[], selfName: string): void {
    this.state = state
    this.partner.section.setCaption(t('trade.partnerOffer', { name: state.name }))
    this.own.section.setCaption(t('trade.yourOffer'))
    this.fill(this.partner, state.theirs, state.name, t('trade.level', { level: state.level }))
    this.fill(this.own, state.mine, selfName || t('trade.you'), t('trade.you'))
    this.own.empty.hidden = !state.mine.items.every(i => !i) || state.mine.locked
    const b = confirmButton(state)
    this.confirmButton.setLabel(b.label)
    this.confirmButton.setDisabled(!b.enabled)
    this.money.setDisabled(state.mine.locked)
    this.renderLog(log)
  }

  /** Flashes the partner half (their offer changed). */
  flashPartner(): void {
    const e = this.partner.section.root
    e.classList.remove('flash')
    void e.offsetWidth
    e.classList.add('flash')
  }

  override dispose(): void {
    this.drag.dispose()
    super.dispose()
  }

  // ---- building ----

  private half(art: Art, side: 'mine' | 'theirs', y: number): Half {
    const d = y - 38
    const section = new Section(art, { at: this.r([9, y, 346, 141]), caption: '', className: `trade-half trade-half-${side}` })
    const outline = new Frame(art, 'lattice', { at: this.r([18, 69 + d, 218, 74]) })
    const grid = this.at(slotGrid(art, COLS), [21, 72 + d, COLS * 36, 72])
    const slots: SlotView[] = []
    for (let i = 0; i < TRADE_SLOTS; i++) {
      const v = tradeSlot(this.host.items, side, i)
      this.hook(v, side, i)
      slots.push(v)
      grid.append(v.root)
    }
    const empty = this.at(el('div', 'trade-empty'), [24, 96 + d, 210, 26])
    const sep = this.at(el('div', 'trade-sep'), [14, 146 + d, 226, 4])
    if (art.has('exchange/exc_sub_window_line')) sep.style.backgroundImage = art.cssUrl('exchange/exc_sub_window_line')
    else sep.classList.add('no-art')
    const gold = this.at(el('div', 'trade-goldbox kit-num'), [71, 152 + d, 108, 20])
    if (art.has('exchange/exc_box')) gold.style.backgroundImage = art.cssUrl('exchange/exc_box')
    else gold.classList.add('no-art')
    const goldLabel = this.at(el('div', 'trade-goldlabel', t('trade.gold')), [181, 156 + d, 50, 12])
    const vline = this.at(el('div', 'trade-vline'), [238, 61 + d, 8, 116])
    if (art.has('exchange/ch_line')) vline.style.backgroundImage = art.cssUrl('exchange/ch_line')
    const view = new Frame(art, 'black', { at: this.r([247, 70 + d, 100, 104]), className: `trade-view trade-view-${side}` })
    const name = el('div', 'trade-view-name')
    const level = el('div', 'trade-view-level')
    const badge = el('div', 'trade-view-badge')
    view.body.append(name, level, badge)
    this.body.append(section.root, outline.root, grid, empty, sep, gold, goldLabel, vline, view.root)
    return { section, slots, gold, view, name, level, badge, empty }
  }

  private hook(v: SlotView, side: 'mine' | 'theirs', i: number): void {
    if (side === 'mine') {
      this.ls.on(v.root, 'pointerdown', ev => {
        if (ev.button === 0 && v.stack && !this.state?.mine.locked) this.drag.begin(v, ev, i)
      })
      this.ls.on(v.root, 'contextmenu', ev => {
        ev.preventDefault()
        this.host.tooltip.hide()
        if (v.stack) this.host.take(i)
      })
    }
    const hover = (ev: PointerEvent | null) => {
      if (!ev || !v.stack || this.drag.dragging) return this.host.tooltip.hide()
      this.host.tooltip.show(this.tooltip(v.stack, side), ev.clientX, ev.clientY)
    }
    this.ls.on(v.root, 'pointerenter', ev => hover(ev))
    this.ls.on(v.root, 'pointermove', ev => hover(ev))
    this.ls.on(v.root, 'pointerleave', () => hover(null))
  }

  // ---- drawing ----

  private fill(h: Half, side: TradeSide, name: string, sub: string): void {
    h.slots.forEach((v, i) => v.set(side.items[i]?.stack ?? null))
    h.gold.textContent = formatNumber(side.gold)
    h.gold.classList.toggle('set', side.gold > 0)
    h.name.textContent = name
    h.level.textContent = sub
    const mark = side.accepted ? 'accepted' : side.locked ? 'locked' : ''
    h.badge.textContent = side.accepted ? t('trade.accepted') : side.locked ? t('trade.locked') : ''
    h.badge.className = `trade-view-badge ${mark}`.trim()
    h.view.root.classList.toggle('locked', side.locked && !side.accepted)
    h.view.root.classList.toggle('accepted', side.accepted)
    h.section.root.classList.toggle('locked', side.locked)
  }

  private renderLog(log: readonly string[]): void {
    const changed = t('trade.changed')
    const lines = log.map((text, i) => el('div', `trade-log-line${i === log.length - 1 ? ' last' : ''}${text === changed ? ' warn' : ''}`, text))
    this.log.body.replaceChildren(...lines)
  }

  private tooltip(stack: ItemStack, side: 'mine' | 'theirs'): TooltipLine[] {
    const level = this.host.level()
    const lines = this.host.items.tooltip(stack, { player: level === null ? null : { level } }).filter(l => l.cls !== 'hint' && l.cls !== 'price')
    if (side === 'mine' && !this.state?.mine.locked) lines.push({ text: t('trade.hintTake'), cls: 'hint' })
    return lines
  }
}
