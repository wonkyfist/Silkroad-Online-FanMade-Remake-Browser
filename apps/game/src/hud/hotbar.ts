/**
 * The hotbar (docs/SKILLS.md §10.3, SRO's quick slots): 10 visible slots on keys 1-0 and 4 pages (F1-F4, or the
 * arrows) = the 40 server-side slots. Skills are dragged in from the skill window, potions from the inventory; a
 * hotbar slot dragged onto another swaps them, dragged off the bar or right-clicked it is cleared. Every change
 * only sends `hotbarSet`; the server's `skills` / `skillsUpdate` redraws. Slots show the CooldownClock sweep and grey
 * out when the skill is not usable now (MP, weapon, not learned) or the item is gone. The rules are in
 * hotbar-model.ts; this is the DOM.
 */
import type { ClientMessage, HotbarEntry } from '@sro/shared'
import type { SkillCatalog, SkillState } from '../content/skills.ts'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, Listeners } from '../ui/dom.ts'
import { iconButton } from '../ui/kit/button.ts'
import type { CooldownClock } from './cooldowns.ts'
import { placeAt } from './hud-layout.ts'
import { PAGE_DOWN, PAGE_TEXT, PAGE_UP, slotRect } from './underbar-layout.ts'
import { HOTBAR_KEYS, HOTBAR_PAGE_SIZE, HOTBAR_PAGES, hotbarDrop, hotbarItemAllowed, hotbarSlot, resolveSlot, type HotbarContext, type ResolvedSlot } from './hotbar-model.ts'
import { intent, type SlotRef } from './intents.ts'
import type { ItemCatalog, TooltipLine } from './items.ts'
import { ensureSkillStyles } from './skills-style.ts'
import { addSlotDropTarget, CooldownSweep, type Tooltip } from './slots.ts'

const PAGE_KEY = 'sro.hotbar.page'
const DRAG_START_PX = 4

/** Something dragged towards the hotbar: a skill from the window, or a hotbar slot. */
export interface HotbarPayload {
  entry: HotbarEntry
  /** The hotbar slot it came from (null: from the skill window). */
  from: number | null
  icon: string | null
}

/** The hotbar slot under a point (absolute 0..39), or null. */
function hotbarSlotAt(x: number, y: number): number | null {
  const hit = document.elementFromPoint(x, y) as HTMLElement | null
  const s = hit?.closest<HTMLElement>('[data-hotbar]')
  if (!s) return null
  const n = Number(s.dataset.hotbar)
  return Number.isInteger(n) ? n : null
}

/** A small icon drag with a ghost (skill window icons, hotbar slots). */
export class IconDrag {
  private active: { payload: HotbarPayload; sx: number; sy: number; id: number; ghost: HTMLElement | null; source: HTMLElement } | null = null
  private readonly ls = new Listeners()
  onStart: (() => void) | null = null

  constructor(private readonly onDrop: (p: HotbarPayload, to: number | null, overUi: boolean) => void) {
    this.ls.on(window, 'pointermove', ev => this.move(ev))
    this.ls.on(window, 'pointerup', ev => this.up(ev))
    this.ls.on(window, 'blur', () => this.cancel())
  }

  /** A drag just ended (the click after its pointerup is ignored). */
  justDropped = false

  get dragging(): boolean {
    return !!this.active?.ghost
  }

  begin(ev: PointerEvent, payload: HotbarPayload, source: HTMLElement): void {
    if (ev.button !== 0) return
    ev.preventDefault()
    this.cancel()
    this.active = { payload, sx: ev.clientX, sy: ev.clientY, id: ev.pointerId, ghost: null, source }
  }

  cancel(): void {
    const a = this.active
    this.active = null
    if (!a) return
    a.ghost?.remove()
    a.source.classList.remove('dragging')
    document.body.classList.remove('hud-dragging')
  }

  dispose(): void {
    this.cancel()
    this.ls.clear()
  }

  private move(ev: PointerEvent): void {
    const a = this.active
    if (!a || ev.pointerId !== a.id) return
    if (!a.ghost) {
      if (Math.hypot(ev.clientX - a.sx, ev.clientY - a.sy) < DRAG_START_PX) return
      a.ghost = el('div', 'kit-drag-ghost hud-drag-ghost')
      if (a.payload.icon) Object.assign(a.ghost.style, { backgroundImage: `url("${a.payload.icon}")`, backgroundSize: '100% 100%' })
      else a.ghost.style.background = '#5a4a2c'
      document.body.append(a.ghost)
      a.source.classList.add('dragging')
      document.body.classList.add('hud-dragging')
      this.onStart?.()
    }
    a.ghost.style.left = `${ev.clientX}px`
    a.ghost.style.top = `${ev.clientY}px`
  }

  private up(ev: PointerEvent): void {
    const a = this.active
    if (!a || ev.pointerId !== a.id) return
    const started = !!a.ghost
    this.cancel()
    if (!started) return
    // The click that follows this pointerup is not a press.
    this.justDropped = true
    setTimeout(() => (this.justDropped = false), 0)
    const to = hotbarSlotAt(ev.clientX, ev.clientY)
    const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
    this.onDrop(a.payload, to, !!hit?.closest('.hud-window, .hud-block, .hud-hotbar'))
  }
}

export interface HotbarDeps {
  art: Art
  parent: HTMLElement
  catalog: SkillCatalog
  state: SkillState
  items: ItemCatalog
  cooldowns: CooldownClock
  tooltip: Tooltip
  /** The world's view of the character (bag, gear, MP). */
  context: () => HotbarContext
  send: (msg: ClientMessage | null) => void
  /** A slot was pressed (key or click): the feature sends the fitting message. */
  use: (r: ResolvedSlot) => void
  toast: (text: string) => void
  /** Item tooltip lines (the HUD's ItemCatalog). */
  itemTooltip: (code: string) => TooltipLine[]
}

interface SlotEl {
  root: HTMLElement
  icon: HTMLElement
  key: HTMLElement
  count: HTMLElement
  sweep: CooldownSweep
}

export class Hotbar {
  readonly root: HTMLElement
  readonly drag: IconDrag
  private readonly slots: SlotEl[] = []
  private readonly pageText: HTMLElement
  private readonly ls = new Listeners()
  private readonly offs: (() => void)[] = []
  private pageIndex = 0
  private resolved: (ResolvedSlot | null)[] = []
  private hover: { i: number; ev: PointerEvent } | null = null

  constructor(private readonly d: HotbarDeps) {
    ensureSkillStyles()
    // UI-H: inside the 2009 underbar (hud.underbar.slots, or found under the given parent) the slots, arrows and page
    // digit sit at the bar art's own rects (hud/underbar-layout.ts); elsewhere the old free-standing box.
    const ub = d.parent.dataset?.underbar === '1' ? d.parent : (d.parent.querySelector?.<HTMLElement>('[data-underbar="1"]') ?? null)
    const host = ub ?? d.parent
    this.root = el('div', ub ? 'hud-hotbar uh-hotbar' : 'hud-hotbar hud-block')
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    const up = ub ? iconButton(d.art, 'underbar/ub_up_arrow', { fallbackText: '▲', sfx: 'none', className: 'uh-page-up' }) : el('button', '', '▲')
    const down = ub ? iconButton(d.art, 'underbar/ub_down_arrow', { fallbackText: '▼', sfx: 'none', className: 'uh-page-down' }) : el('button', '', '▼')
    up.type = down.type = 'button'
    up.title = down.title = t('skills.hotbar.pageHint')
    this.pageText = el('div', 'hud-hotbar-page')
    this.ls.on(up, 'click', () => this.setPage((this.pageIndex + HOTBAR_PAGES - 1) % HOTBAR_PAGES))
    this.ls.on(down, 'click', () => this.setPage((this.pageIndex + 1) % HOTBAR_PAGES))
    const pages = el('div', 'hud-hotbar-pages', up, this.pageText, down)
    const row = el('div', 'hud-hotbar-slots')
    if (ub) {
      placeAt(up, PAGE_UP)
      placeAt(down, PAGE_DOWN)
      placeAt(this.pageText, PAGE_TEXT, true)
    }
    const cell = !ub && d.art.has('ifcommon/lattice_window/com_lattice_left_up') ? d.art.cssUrl('ifcommon/lattice_window/com_lattice_left_up') : null
    for (let i = 0; i < HOTBAR_PAGE_SIZE; i++) {
      const root = el('div', `hud-hotbar-slot${cell || ub ? '' : ' no-art'}`)
      if (cell) root.style.setProperty('--cell', cell)
      if (ub) placeAt(root, slotRect(i), true)
      const icon = el('div', 'ico')
      const key = el('span', 'key', HOTBAR_KEYS[i])
      const count = el('span', 'cnt')
      root.append(icon, key, count)
      const s: SlotEl = { root, icon, key, count, sweep: new CooldownSweep(root, key) }
      this.slots.push(s)
      row.append(root)
      this.ls.on(root, 'pointerdown', ev => this.down(i, ev))
      this.ls.on(root, 'click', () => {
        if (!this.drag.dragging && !this.drag.justDropped) this.press(i)
      })
      this.ls.on(root, 'contextmenu', ev => {
        ev.preventDefault()
        this.clear(hotbarSlot(this.pageIndex, i))
      })
      this.ls.on(root, 'pointerenter', ev => this.showTip(i, ev))
      this.ls.on(root, 'pointermove', ev => this.showTip(i, ev))
      this.ls.on(root, 'pointerleave', () => {
        this.hover = null
        d.tooltip.hide()
      })
    }
    this.root.append(pages, row)
    host.append(this.root)
    this.drag = new IconDrag((p, to, overUi) => this.dropped(p, to, overUi))
    this.drag.onStart = () => d.tooltip.hide()
    // Potions from the inventory (the HUD's item drag asks the drop targets first).
    this.offs.push(addSlotDropTarget((from, x, y) => this.itemDropped(from, x, y)))
    this.offs.push(d.cooldowns.onChange(key => this.onCooldown(key)))
    let saved = 0
    try {
      saved = Number(localStorage.getItem(PAGE_KEY)) || 0
    } catch {
      saved = 0
    }
    this.setPage(Math.max(0, Math.min(HOTBAR_PAGES - 1, saved)))
  }

  get page(): number {
    return this.pageIndex
  }

  setPage(page: number): void {
    this.pageIndex = page
    this.pageText.textContent = String(page + 1)
    this.pageText.title = t('skills.hotbar.page', { page: page + 1 })
    try {
      localStorage.setItem(PAGE_KEY, String(page))
    } catch {
      // not remembered
    }
    this.render()
  }

  /** Visible slot `i` (0..9) pressed: key or click. */
  press(i: number): void {
    const r = this.resolved[i]
    const s = this.slots[i]
    if (!r || !s) return
    s.root.classList.add('pressed')
    setTimeout(() => s.root.classList.remove('pressed'), 120)
    this.d.use(r)
  }

  /** Redraws the visible page from the state and the character. */
  render(): void {
    const ctx = this.d.context()
    this.resolved = []
    for (let i = 0; i < HOTBAR_PAGE_SIZE; i++) {
      const s = this.slots[i]!
      const abs = hotbarSlot(this.pageIndex, i)
      s.root.dataset.hotbar = String(abs)
      const entry = this.d.state.hotbar[abs] ?? null
      const r = entry ? resolveSlot(entry, ctx) : null
      this.resolved.push(r)
      s.root.classList.toggle('filled', !!r)
      s.root.classList.toggle('blocked', !!r?.block)
      s.root.classList.toggle('mp', r?.block === 'mp')
      s.icon.classList.remove('fallback')
      s.icon.textContent = ''
      s.icon.style.backgroundImage = ''
      if (r) {
        if (r.icon) s.icon.style.backgroundImage = `url("${r.icon}")`
        else {
          s.icon.classList.add('fallback')
          const name = r.entry.kind === 'skill' ? this.d.catalog.name(r.code) : this.d.items.name(r.code)
          s.icon.textContent = name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'
        }
      }
      s.count.textContent = r?.entry.kind === 'item' ? String(r.count ?? 0) : ''
      const cd = r?.cooldownKey ? this.d.cooldowns.get(r.cooldownKey) : null
      s.sweep.set(cd?.readyAt ?? 0, cd?.totalMs ?? 0)
    }
    if (this.hover) this.showTip(this.hover.i, this.hover.ev)
  }

  dispose(): void {
    this.ls.clear()
    for (const off of this.offs.splice(0)) off()
    this.drag.dispose()
    this.root.remove()
  }

  private onCooldown(key: string): void {
    this.resolved.forEach((r, i) => {
      if (!r || r.cooldownKey !== key) return
      const cd = this.d.cooldowns.get(key)
      this.slots[i]!.sweep.set(cd?.readyAt ?? 0, cd?.totalMs ?? 0)
    })
  }

  private down(i: number, ev: PointerEvent): void {
    const r = this.resolved[i]
    if (!r || ev.button !== 0) return
    this.drag.begin(ev, { entry: r.entry, from: hotbarSlot(this.pageIndex, i), icon: r.icon }, this.slots[i]!.root)
  }

  private clear(abs: number): void {
    if (!this.d.state.hotbar[abs]) return
    this.d.tooltip.hide()
    this.d.send(intent.hotbarSet(abs, null))
  }

  private dropped(p: HotbarPayload, to: number | null, overUi: boolean): void {
    if (to !== null) {
      for (const m of hotbarDrop(this.d.state.hotbar, p.entry, p.from, to)) this.d.send(m)
      return
    }
    // A hotbar slot dragged off the bar (not onto another window) is cleared, as in SRO.
    if (p.from !== null && !overUi) this.clear(p.from)
  }

  private itemDropped(from: SlotRef, x: number, y: number): boolean {
    const to = hotbarSlotAt(x, y)
    if (to === null) return false
    if (from.kind !== 'bag') return true
    const ctx = this.d.context()
    const stack = ctx.bag(from.slot)
    if (!stack) return true
    if (!hotbarItemAllowed(ctx.item(stack.code))) {
      this.d.toast(t('skills.hotbar.notUsable'))
      return true
    }
    for (const m of hotbarDrop(this.d.state.hotbar, { kind: 'item', code: stack.code }, null, to)) this.d.send(m)
    return true
  }

  private showTip(i: number, ev: PointerEvent): void {
    if (this.drag.dragging) return
    this.hover = { i, ev }
    const r = this.resolved[i]
    if (!r) return this.d.tooltip.hide()
    let lines: TooltipLine[]
    if (r.entry.kind === 'item') {
      lines = this.d.itemTooltip(r.code)
      if (r.block === 'no_item') lines.push({ text: t('skills.hotbar.noItem'), cls: 'bad' })
    } else {
      const block = r.block ? t(`skills.block.${r.block}` as StringKey) : null
      lines = this.d.catalog.tooltip(r.code, { learned: this.d.state.isLearned(r.code), block })
    }
    lines.push({ text: t('skills.hotbar.hint', { key: HOTBAR_KEYS[i]! }), cls: 'hint' })
    this.d.tooltip.show(lines, ev.clientX, ev.clientY)
  }
}
