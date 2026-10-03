/**
 * The shop window (docs/SHOPS.md §3.2, §8.3; docs/UI.md §4.6, retail `ifstore.txt` `CIFStoreForPackage` 254×370): the
 * NPC's ShopDef tabs (armour tabs for the player's gender, with a Male/Female switch; goods above the level cap
 * hidden) at y 36, the goods lattice (`int_window_` (9,60,236,219), outline (18,68,218,182), 6 × 5 slots at
 * (21,71)) with its page spin at (102,254), the re-buy row (`com_redeem_window` (57,285,188,40), the 5 buy-back slots
 * at (61..201, 289) and its label at (7,300)), and the footer at y 332 (your gold, and the buttons other lanes
 * mount: M6 `addFooterButton`, Repair / Repair all in wave 8, decision D13). Browsing needs no round trip
 * (PROTOCOL §8); buying and selling only send intents, and the bag and gold change when the server's updates arrive.
 *
 * Buy: right click or double click a good (stackables ask how many) or drag it onto the inventory. Sell: drag a bag
 * item onto this window, or right click it in the bag while the shop is open (the feature routes that through
 * `hud.routeBagAction`). Buy back: right click or drag a re-buy slot.
 */
import { BUYBACK_SLOTS, type BuybackEntry, type ItemStack, type ShopDef } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button, type KitButton } from '../ui/kit/button.ts'
import { TabBar } from '../ui/kit/tabs.ts'
import { parseCount } from './intents.ts'
import { formatNumber, type ItemCatalog, type TooltipLine } from './items.ts'
import { npcTalkServices } from './npc-dialog.ts'
import { ensureNpcStyles, goldRow, hudBagDrag, itemSlot, ItemDrag, latticeBox, latticeClass, NpcWindow, pageSpin, slotGrid, type AmountRequest } from './npc-ui.ts'
import { buyLimit, hasGenderTabs, visibleTabs, type BagView, type Gender, type ShopTabView } from './shop-logic.ts'
import type { SlotView, Tooltip } from './slots.ts'

/** What the shop window needs from the feature. */
export interface ShopHost {
  readonly items: ItemCatalog
  readonly tooltip: Tooltip
  readonly bag: BagView
  gold(): number
  /** Own level (tooltip requirement colours); null before the first stats. */
  level(): number | null
  /** Sends shopBuy for `count` (already checked against gold and bag room). */
  buy(code: string, count: number): void
  buyback(index: number): void
  /** Sells bag slot `bag` (asks for a count or a confirmation as needed). */
  sell(bag: number): void
  ask(req: AmountRequest): void
  toast(text: string, kind?: 'info' | 'error' | 'loot'): void
}

/** M6: a button of the shop footer (wave 8 DR: Repair, Repair all). */
export interface ShopFooterButton {
  id: string
  label: string
  /** Shown for an NPC offering these services (the dialog's `npcDialog.services`). */
  when(services: readonly string[]): boolean
  onClick(): void
}

export const SHOP_W = 254
export const SHOP_H = 370
const COLS = 6
const ROWS = 5
const PAGE = COLS * ROWS

/** M6: whether a footer button shows for an NPC offering `services` (a throwing `when` hides it). */
export function footerButtonShown(spec: Pick<ShopFooterButton, 'when'>, services: readonly string[]): boolean {
  try {
    return !!spec.when(services)
  } catch (err) {
    console.error('[shop] footer button', err)
    return false
  }
}

/** Goods pages of a tab with `n` goods (at least 1). */
export function shopPages(n: number): number {
  return Math.max(1, Math.ceil(n / PAGE))
}

export class ShopWindow extends NpcWindow {
  private readonly tabHost: HTMLElement
  private tabBar: TabBar<string> | null = null
  private readonly grid: HTMLElement
  private readonly empty: HTMLElement
  private readonly spin: ReturnType<typeof pageSpin>
  private readonly redeem: SlotView[] = []
  private readonly genderButton: KitButton
  private readonly goldText: HTMLElement
  private readonly footer: HTMLElement
  private readonly footerButtons = new Map<string, { spec: ShopFooterButton; el: KitButton }>()
  private readonly drag: ItemDrag<{ kind: 'goods'; tab: ShopTabView; index: number } | { kind: 'buyback'; index: number }>
  private slots: SlotView[] = []
  private shop: ShopDef | null = null
  private views: ShopTabView[] = []
  private tab = 0
  private page = 0
  private selected = -1
  private gender: Gender = 'male'
  private cap = 20
  private services: readonly string[] = []
  private buybackEntries: BuybackEntry[] = []
  /** true while the feature hides the window (not the player closing it). */
  private quiet = false
  /** The player closed the shop (close button): the conversation ends. */
  onEnd: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement, private readonly host: ShopHost) {
    ensureNpcStyles()
    super(art, parent, { id: 'npc-shop', title: t('shop.title'), width: SHOP_W, height: SHOP_H, at: [0.22, 0.35] })
    this.tabHost = this.at(el('div', 'npc-tabs shop-tabs'), [9, 36, 236, 24])
    this.body.append(...latticeBox(art, this.r([9, 60, 236, 219]), this.r([18, 68, 218, 182])))
    this.grid = this.at(slotGrid(art, COLS), [21, 71, COLS * 36, ROWS * 36])
    this.empty = this.at(el('div', 'npc-empty'), [21, 140, 216, 40])
    this.spin = pageSpin(art, d => this.setPage(this.page + d))
    this.at(this.spin.root, [102, 254, 50, 16])
    // Re-buy row.
    const redeem = this.at(el('div', 'npc-redeem'), [57, 285, 188, 40])
    if (art.has('ifcommon/com_redeem_window')) redeem.style.backgroundImage = art.cssUrl('ifcommon/com_redeem_window')
    const redeemLabel = this.at(el('div', 'npc-redeem-label', t('shop.rebuy')), [5, 297, 50, 16])
    redeemLabel.title = t('shop.buybackEmpty')
    for (let i = 0; i < BUYBACK_SLOTS; i++) {
      const v = itemSlot(this.host.items, 'shop', 100 + i)
      v.root.classList.add('shop-rebuy-slot')
      Object.assign(v.root.style, { position: 'absolute', left: `${61 + 35 * i - 57 - 2}px`, top: `${289 - 285 - 2}px` })
      this.hookBuyback(v, i)
      this.redeem.push(v)
      redeem.append(v.root)
    }
    // Footer: gold on the left, M6 buttons on the right.
    const gold = goldRow(art, t('hud.inv.gold'), 'none')
    gold.root.classList.add('shop-gold')
    this.goldText = gold.amount
    this.footer = el('div', 'npc-footer shop-footer')
    this.genderButton = button(art, { label: '', skin: 'small', title: t('shop.genderHint') }, () => {
      this.gender = this.gender === 'male' ? 'female' : 'male'
      this.rebuild(true)
    })
    this.at(this.genderButton, [190, 38, 0, 20])
    this.body.append(this.tabHost, this.grid, this.empty, this.spin.root, redeem, redeemLabel, this.at(gold.root, [9, 334, 110, 22]), this.at(this.footer, [120, 332, 126, 24]), this.genderButton)

    this.drag = new ItemDrag((p, target) => {
      if (target.kind !== 'bag' && target.kind !== 'inventory') return
      if (p.kind === 'goods') this.quickBuy(p.tab.items[p.index]!)
      else this.host.buyback(p.index)
    })
    this.drag.onStart = () => this.host.tooltip.hide()
    // A bag item dragged by the HUD and released over the shop: sell it.
    this.ls.on(this.root, 'pointerup', () => {
      const bag = hudBagDrag()
      if (bag !== null) this.host.sell(bag)
    })
    this.ls.on(this.grid, 'wheel', ev => {
      if (shopPages(this.current()?.items.length ?? 0) < 2) return
      ev.preventDefault()
      this.setPage(this.page + Math.sign(ev.deltaY))
    }, { passive: false })
    this.onClose = () => {
      this.host.tooltip.hide()
      this.drag.cancel()
      if (!this.quiet) this.onEnd?.()
    }
  }

  /** The shop shown (null when hidden). */
  get def(): ShopDef | null {
    return this.isOpen ? this.shop : null
  }

  /** Opens the shop of one NPC for a player of `gender`, hiding goods above `cap`. */
  show(npcName: string, shop: ShopDef, gender: Gender, cap: number): void {
    const same = this.shop?.id === shop.id && this.isOpen
    this.shop = shop
    this.gender = gender
    this.cap = cap
    this.services = npcTalkServices()
    this.setTitle(t('shop.titleNpc', { name: npcName }))
    if (!same) {
      this.tab = 0
      this.page = 0
      this.selected = -1
    }
    this.rebuild(same)
    this.renderFooter()
    this.open()
    this.raise()
  }

  /** Hides without ending the conversation. */
  hide(): void {
    this.quiet = true
    try {
      this.close()
    } finally {
      this.quiet = false
    }
  }

  /**
   * M6: adds a footer button (shown while `when(services)` holds for the NPC of the open shop). Returns an
   * unregister function.
   */
  addFooterButton(spec: ShopFooterButton): () => void {
    this.footerButtons.get(spec.id)?.el.remove()
    const b = button(this.art, { label: spec.label }, () => spec.onClick())
    b.dataset.footer = spec.id
    const entry = { spec, el: b }
    this.footerButtons.set(spec.id, entry)
    this.footer.append(b)
    this.renderFooter()
    return () => {
      if (this.footerButtons.get(spec.id) !== entry) return
      this.footerButtons.delete(spec.id)
      b.remove()
    }
  }

  setBuyback(entries: readonly BuybackEntry[]): void {
    this.buybackEntries = entries.map(e => ({ item: { ...e.item }, price: e.price }))
    this.renderBuyback()
  }

  /** Gold or bag changed: prices turn red or back, the footer updates. */
  refresh(): void {
    this.goldText.textContent = formatNumber(this.host.gold())
  }

  override dispose(): void {
    this.drag.dispose()
    super.dispose()
  }

  // ---- rendering --------------------------------------------------------------------------------

  private current(): ShopTabView | undefined {
    return this.views[this.tab]
  }

  private renderFooter(): void {
    for (const { spec, el: b } of this.footerButtons.values()) b.hidden = !footerButtonShown(spec, this.services)
  }

  private rebuild(keepTab: boolean): void {
    const shop = this.shop
    if (!shop) return
    const prevName = keepTab ? this.current()?.name ?? null : null
    this.views = visibleTabs(shop, this.gender, this.cap, code => this.host.items.def(code))
    const again = prevName === null ? -1 : this.views.findIndex(v => v.name === prevName)
    this.tab = again >= 0 ? again : Math.max(0, Math.min(this.tab, this.views.length - 1))
    if (!keepTab || again < 0) {
      this.selected = -1
      this.page = 0
    }
    const gendered = hasGenderTabs(shop)
    this.genderButton.hidden = !gendered
    this.genderButton.setLabel(t(this.gender === 'male' ? 'shop.gender.male' : 'shop.gender.female'))
    this.renderTabs()
    this.renderGoods()
    this.renderBuyback()
  }

  private renderTabs(): void {
    const specs = this.views.map((v, i) => ({ id: String(i), label: v.name, title: v.name }))
    this.tabBar = specs.length ? new TabBar(this.art, 'short', specs) : null
    this.tabHost.replaceChildren(...(this.tabBar ? [this.tabBar.root] : []))
    this.tabHost.classList.toggle('gendered', !this.genderButton.hidden)
    if (!this.tabBar) return
    this.tabBar.value = String(this.tab)
    this.tabBar.onChange = id => {
      this.tab = Number(id)
      this.page = 0
      this.selected = -1
      this.host.tooltip.hide()
      this.renderGoods()
    }
  }

  private setPage(p: number): void {
    const pages = shopPages(this.current()?.items.length ?? 0)
    const next = Math.max(0, Math.min(pages - 1, p))
    if (next === this.page) return
    this.page = next
    this.selected = -1
    this.renderGoods()
  }

  private renderGoods(): void {
    const tb = this.current()
    const codes = tb?.items ?? []
    if (this.slots.length !== PAGE) {
      this.grid.replaceChildren()
      this.slots = []
      for (let i = 0; i < PAGE; i++) {
        const v = itemSlot(this.host.items, 'shop', i)
        v.root.classList.add(latticeClass(i, COLS))
        this.hook(v, i)
        this.slots.push(v)
        this.grid.append(v.root)
      }
    }
    const pages = shopPages(codes.length)
    if (this.page >= pages) this.page = pages - 1
    const from = this.page * PAGE
    this.slots.forEach((v, i) => {
      const code = codes[from + i]
      v.set(code ? { code, count: 1 } : null, !!code && this.blocked(code))
      v.root.classList.toggle('npc-selected', from + i === this.selected && !!code)
    })
    this.spin.root.hidden = pages < 2
    this.spin.set(this.page, pages)
    this.empty.hidden = codes.length > 0
    this.empty.textContent = t('shop.empty')
    this.refresh()
  }

  private renderBuyback(): void {
    this.redeem.forEach((v, i) => v.set(this.buybackEntries[i]?.item ?? null))
  }

  /** Goods the player could not wear (level, gender): tinted, like the retail shop. */
  private blocked(code: string): boolean {
    const d = this.host.items.def(code)
    if (!d) return false
    const level = this.host.level()
    if (level !== null && d.reqLevel > level) return true
    return d.reqGender !== undefined && d.reqGender !== 'any' && d.reqGender !== this.gender
  }

  private hook(v: SlotView, i: number): void {
    const index = () => this.page * PAGE + i
    this.ls.on(v.root, 'pointerdown', ev => {
      const tb = this.current()
      if (ev.button !== 0 || !v.stack || !tb) return
      this.select(index())
      this.drag.begin(v, ev, { kind: 'goods', tab: tb, index: index() })
    })
    this.ls.on(v.root, 'dblclick', () => {
      const code = this.current()?.items[index()]
      if (v.stack && code) this.quickBuy(code)
    })
    this.ls.on(v.root, 'contextmenu', ev => {
      ev.preventDefault()
      const code = this.current()?.items[index()]
      if (!v.stack || !code) return
      this.select(index())
      this.quickBuy(code)
    })
    const hover = (ev: PointerEvent | null) => {
      if (!ev || !v.stack || this.drag.dragging) return this.host.tooltip.hide()
      this.host.tooltip.show(this.goodsTooltip(v.stack), ev.clientX, ev.clientY)
    }
    this.ls.on(v.root, 'pointerenter', ev => hover(ev))
    this.ls.on(v.root, 'pointermove', ev => hover(ev))
    this.ls.on(v.root, 'pointerleave', () => hover(null))
  }

  private hookBuyback(v: SlotView, i: number): void {
    this.ls.on(v.root, 'pointerdown', ev => {
      if (ev.button === 0 && v.stack) this.drag.begin(v, ev, { kind: 'buyback', index: i })
    })
    this.ls.on(v.root, 'dblclick', () => {
      if (v.stack) this.host.buyback(i)
    })
    this.ls.on(v.root, 'contextmenu', ev => {
      ev.preventDefault()
      if (v.stack) this.host.buyback(i)
    })
    const hover = (ev: PointerEvent | null) => {
      const e = this.buybackEntries[i]
      if (!ev || !v.stack || !e || this.drag.dragging) return this.host.tooltip.hide()
      const lines = this.host.items.tooltip(e.item, { player: this.playerLevel() }).filter(l => l.cls !== 'hint' && l.cls !== 'price')
      lines.push({ text: '', cls: 'sep' }, { text: t('shop.buybackPrice', { gold: formatNumber(e.price) }), cls: e.price > this.host.gold() ? 'bad' : 'price' }, { text: t('shop.hintBuyback'), cls: 'hint' })
      this.host.tooltip.show(lines, ev.clientX, ev.clientY)
    }
    this.ls.on(v.root, 'pointerenter', ev => hover(ev))
    this.ls.on(v.root, 'pointermove', ev => hover(ev))
    this.ls.on(v.root, 'pointerleave', () => hover(null))
  }

  private select(i: number): void {
    if (this.selected === i) return
    this.selected = i
    const from = this.page * PAGE
    this.slots.forEach((s, j) => s.root.classList.toggle('npc-selected', from + j === i && !!s.stack))
  }

  /** The good's item tooltip with the shop price in place of the sell price. */
  private goodsTooltip(stack: ItemStack): TooltipLine[] {
    const gold = this.host.gold()
    const lines = this.host.items.tooltip(stack, { player: this.playerLevel() }).filter(l => l.cls !== 'hint' && l.cls !== 'price')
    while (lines.length && lines[lines.length - 1]!.cls === 'sep') lines.pop()
    const d = this.host.items.def(stack.code)
    if (d) lines.push({ text: '', cls: 'sep' }, { text: t('shop.price', { gold: formatNumber(d.price) }), cls: d.price > gold ? 'bad' : 'price' })
    lines.push({ text: t((d?.maxStack ?? 1) > 1 ? 'shop.hintBuyMany' : 'shop.hintBuy'), cls: 'hint' })
    return lines
  }

  private playerLevel(): { level: number } | null {
    const level = this.host.level()
    return level === null ? null : { level }
  }

  // ---- buying -------------------------------------------------------------------------------------

  /** Right click / double click / drag to the bag: stackables ask how many, the rest buy one. */
  private quickBuy(code: string): void {
    const d = this.host.items.def(code)
    if (!d) return this.host.buy(code, 1)
    const lim = buyLimit(d, this.host.gold(), this.host.bag)
    if (!lim.ok) return this.host.toast(t(`action.fail.${lim.reason}` as StringKey), 'error')
    if (d.maxStack <= 1 || lim.max <= 1) return this.host.buy(code, 1)
    const name = this.host.items.name(code)
    this.host.ask({
      title: t('shop.buyTitle'),
      body: t('shop.buyBody', { name, gold: formatNumber(d.price), max: lim.max }),
      ok: t('shop.buy'),
      max: lim.max,
      initial: 1,
      parse: parseCount,
      onOk: n => this.host.buy(code, n),
    })
  }
}

