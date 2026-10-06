/**
 * Master Mason Ko's donation window (docs/SIEGE.md §2.4, §9.5; layer 3): a kit mframe window like the NPC dialog. A talk
 * box with his terms, a list of the 33 wall segments (stage, integrity bar, work queued, builders at work) under a
 * "Where it is needed" row, then the gold and Stone Block amounts with the work they buy, and Donate / Back.
 * Presentation only: the server takes only what the queue can use and answers with a chat line; the list redraws from
 * `walls` / `wallUpdate`. `masonPreview` is the DOM-free part (the window's preview line).
 */
import { WALL_SIDE_NAMES, planDonation, queueRoom, type QueueSeg, type WallRepairTerms, type WallSide, type WallStage } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { NumberInput } from '../ui/kit/input.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { ensureNpcStyles, NpcWindow } from './npc-ui.ts'

/** A segment as the window shows it. */
export interface MasonSeg {
  id: string
  stage: WallStage
  pct: number
  queued: number
  repairing: boolean
}

/**
 * The preview of a donation: the % of a segment it buys at `terms`, given the queues (`segs`, % values) and the target
 * (null = where it is needed). 'full' when the queue cannot take more, 'none' when nothing was entered.
 */
export function masonPreview(gold: number, blocks: number, target: string | null, segs: readonly MasonSeg[], terms: WallRepairTerms): number | 'none' | 'full' {
  if (!(gold > 0) && !(blocks > 0)) return 'none'
  // on a 100-point scale per segment (1 ip = 0.01 %) the shared rules give the same answer as the server's
  const s = { maxIp: 10_000, goldPerPct: terms.goldPerPct, blocksPerPct: terms.blocksPerPct, queueCapPct: terms.queueCapPct }
  const q: QueueSeg[] = segs.map((x) => ({ id: x.id, ip: Math.round(x.pct * 100), queued: Math.round(x.queued * 100) }))
  const room = queueRoom(q, target, s)
  if (room <= 0) return 'full'
  const plan = planDonation(Math.max(0, gold || 0), Math.max(0, blocks || 0), room, s)
  return plan.ip > 0 ? Math.round(plan.ip) / 100 : 'none'
}

const CSS = `
.mason-text { color: var(--c-text); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); white-space: pre-wrap; }
.mason-list .kit-scroll-view { padding: 2px 4px 4px 2px; box-sizing: border-box; }
.mason-row { display: grid; grid-template-columns: 1fr 96px 54px; align-items: center; gap: 6px; min-height: 22px; padding: 1px 4px; cursor: inherit;
  color: var(--c-label); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); border: 1px solid transparent; }
.mason-row:hover { color: var(--c-highlight); }
.mason-row.sel { border-color: var(--c-level, #e6c35c); color: var(--c-highlight); background: rgba(255, 220, 120, 0.06); }
.mason-row .mason-sub { display: block; font-size: 10px; line-height: 12px; color: #b9ad8f; }
.mason-row.anywhere { margin-bottom: 3px; }
.mason-bar { position: relative; height: 8px; background: rgba(0, 0, 0, 0.55); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.8); }
.mason-bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(#9fd06a, #5b8f30); }
.mason-bar > b { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(45deg, #e6c35c 0 3px, #8a6d22 3px 6px); opacity: 0.85; }
.mason-bar.cracked > i { background: linear-gradient(#e8c460, #a47a20); }
.mason-bar.open > i { background: linear-gradient(#e0705a, #8f2a1c); }
.mason-pct { text-align: right; color: var(--c-text); }
.mason-pct.open { color: var(--c-bad, #ff6a5a); }
.mason-amounts { display: grid; grid-template-columns: 92px 1fr; align-items: center; row-gap: 4px; color: var(--c-label); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); }
.mason-note { color: #b9ad8f; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); }
.mason-preview { color: var(--c-level, #e6c35c); font: 12px/16px var(--font-body); text-shadow: var(--t-outline); }
.mason-preview.bad { color: var(--c-bad, #ff6a5a); }
.mason-buttons { display: flex; justify-content: center; gap: 8px; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'mason'
  s.textContent = CSS
  document.head.append(s)
}

export const MASON_W = 386
export const MASON_H = 520

export class MasonWindow extends NpcWindow {
  private readonly text: HTMLElement
  private readonly list: ScrollArea
  private readonly rows = new Map<string | null, HTMLElement>()
  private readonly gold: NumberInput
  private readonly blocks: NumberInput
  private readonly carry: HTMLElement
  private readonly preview: HTMLElement
  private readonly kitNote: HTMLElement
  private readonly donateBtn: ReturnType<typeof button>
  private selected: string | null = null
  private segs: MasonSeg[] = []
  private terms: WallRepairTerms | null = null
  private have = { gold: 0, blocks: 0 }
  /** The player pressed Donate: (target, gold, blocks). */
  onDonate: ((seg: string | null, gold: number, blocks: number) => void) | null = null
  /** Back to Ko's dialog. */
  onBack: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement) {
    ensureNpcStyles()
    ensureStyles()
    super(art, parent, { id: 'mason', title: t('mason.title'), width: MASON_W, height: MASON_H, at: [0.36, 0.2] })
    const talk = new Frame(art, 'talk', { at: this.r([11, 46, 364, 98]), inset: [8, 10, 8, 10] })
    this.text = el('div', 'mason-text')
    talk.body.append(this.text)
    const box = new Frame(art, 'talk', { at: this.r([11, 148, 364, 222]), inset: [0, 0, 0, 0] })
    this.list = new ScrollArea(art, { w: 344, h: 208, className: 'mason-list' })
    Object.assign(this.list.root.style, { position: 'absolute', left: '10px', top: '7px' })
    box.body.append(this.list.root)
    this.gold = new NumberInput(art, { min: 0, max: 99_999_999_999, step: 2000, w: 150, label: t('mason.gold') })
    this.blocks = new NumberInput(art, { min: 0, max: 99_999, step: 2, w: 150, label: t('mason.blocks') })
    this.gold.onChange = () => this.renderPreview()
    this.blocks.onChange = () => this.renderPreview()
    this.gold.input.addEventListener('input', () => this.renderPreview())
    this.blocks.input.addEventListener('input', () => this.renderPreview())
    const amounts = el('div', 'mason-amounts', el('span', '', t('mason.gold')), this.gold.root, el('span', '', t('mason.blocks')), this.blocks.root)
    this.at(amounts, [20, 376, 346, 52])
    this.carry = this.at(el('div', 'mason-note'), [20, 430, 346, 14])
    this.preview = this.at(el('div', 'mason-preview'), [20, 446, 346, 16])
    this.kitNote = this.at(el('div', 'mason-note'), [20, 462, 346, 14])
    this.donateBtn = button(art, { label: t('mason.donate'), primary: true, minWidth: 90 }, () => this.donate())
    const back = button(art, { label: t('mason.back'), minWidth: 90 }, () => this.onBack?.())
    this.at(el('div', 'mason-buttons', this.donateBtn, back), [11, 482, 364, 28])
    this.body.append(talk.root, box.root, amounts, this.carry, this.preview, this.kitNote, this.donateBtn.parentElement!)
  }

  /** Opens with the current numbers (null terms: the walls are off). */
  show(terms: WallRepairTerms | null, segs: readonly MasonSeg[], have: { gold: number; blocks: number }): void {
    this.update(terms, segs, have)
    this.open()
    this.raise()
  }

  /** Redraws from new numbers (a wallUpdate, the inventory) without touching what the player typed. */
  update(terms: WallRepairTerms | null, segs: readonly MasonSeg[], have: { gold: number; blocks: number }): void {
    this.terms = terms
    this.segs = [...segs]
    this.have = have
    this.gold.max = Math.max(0, have.gold)
    this.blocks.max = Math.max(0, have.blocks)
    if (terms) {
      this.text.textContent = t('mason.text', { gold: terms.goldPerPct.toLocaleString('en-US'), blocks: terms.blocksPerPct, rate: terms.builderPctPerMin, cap: terms.queueCapPct })
      this.kitNote.textContent = t('mason.kitHint', { pct: terms.kitPct, s: terms.kitChannelS, m: terms.kitRangeM })
    } else {
      this.text.textContent = t('mason.noWalls')
      this.kitNote.textContent = ''
    }
    this.carry.textContent = t('mason.carry', { gold: have.gold.toLocaleString('en-US'), blocks: have.blocks })
    this.renderList()
    this.renderPreview()
  }

  private renderList(): void {
    const top = this.list.view.scrollTop
    this.rows.clear()
    const anywhere = this.row(null, t('mason.anywhere'), t('mason.anywhereHint'), null)
    anywhere.classList.add('anywhere')
    const out: HTMLElement[] = [anywhere]
    // the segments that need work first (worst first), then the whole ones by side
    const order: WallSide[] = ['N', 'E', 'S', 'W']
    const bySide = (a: MasonSeg, b: MasonSeg) => order.indexOf(a.id[0] as WallSide) - order.indexOf(b.id[0] as WallSide) || Number(a.id.slice(1)) - Number(b.id.slice(1))
    const sorted = [...this.segs].sort((a, b) => Math.min(a.pct, 100) - Math.min(b.pct, 100) || b.queued - a.queued || bySide(a, b))
    for (const g of sorted) {
      const side = WALL_SIDE_NAMES[g.id[0] as WallSide] ?? g.id[0]!
      const sub = [t(`wall.stage.${g.stage}` as StringKey), g.queued > 0 ? t('mason.queued', { pct: g.queued }) : '', g.repairing ? t('mason.repairing') : ''].filter(Boolean).join(' · ')
      out.push(this.row(g.id, t('mason.segment', { side, id: g.id }), sub, g))
    }
    this.list.view.replaceChildren(...out)
    this.list.view.scrollTop = top
    if (!this.rows.has(this.selected)) this.selected = null
    this.mark()
  }

  private row(id: string | null, name: string, sub: string, g: MasonSeg | null): HTMLElement {
    const label = el('span', '', name, el('span', 'mason-sub', sub))
    const r = el('div', 'mason-row', label)
    if (g) {
      const open = g.stage === 'breached' || g.stage === 'rubble'
      // the bar runs from rubble (-50 %) to whole (100 %); queued work shows hatched after it
      const f = (v: number) => Math.min(100, Math.max(0, ((v + 50) / 150) * 100))
      const fill = el('i')
      fill.style.width = `${f(g.pct)}%`
      const q = el('b')
      q.style.left = `${f(g.pct)}%`
      q.style.width = `${Math.max(0, f(Math.min(100, g.pct + g.queued)) - f(g.pct))}%`
      r.append(el('div', `mason-bar ${open ? 'open' : g.stage === 'cracked' ? 'cracked' : ''}`, fill, q), el('span', `mason-pct ${open ? 'open' : ''}`, g.pct >= 100 ? t('mason.whole') : `${g.pct} %`))
    } else r.append(el('span'), el('span'))
    r.addEventListener('click', () => {
      this.selected = id
      this.mark()
      this.renderPreview()
    })
    this.rows.set(id, r)
    return r
  }

  private mark(): void {
    for (const [id, r] of this.rows) r.classList.toggle('sel', id === this.selected)
  }

  private amounts(): { gold: number; blocks: number } {
    const g = this.gold.value
    const b = this.blocks.value
    return { gold: Number.isFinite(g) ? g : 0, blocks: Number.isFinite(b) ? b : 0 }
  }

  private renderPreview(): void {
    const { gold, blocks } = this.amounts()
    const p = this.terms ? masonPreview(gold, blocks, this.selected, this.segs, this.terms) : 'none'
    this.preview.classList.toggle('bad', p === 'full')
    this.preview.textContent = p === 'none' ? t('mason.previewNone') : p === 'full' ? t('mason.previewFull') : t('mason.preview', { pct: p })
    this.donateBtn.setDisabled(typeof p !== 'number')
  }

  private donate(): void {
    const { gold, blocks } = this.amounts()
    if (!(gold > 0) && !(blocks > 0)) return
    this.onDonate?.(this.selected, gold, blocks)
  }

  /** Clears the amounts (after a donation went out). */
  resetAmounts(): void {
    this.gold.set(0)
    this.blocks.set(0)
    this.renderPreview()
  }

  /** Selects a segment (the debug hook, tests). */
  select(id: string | null): void {
    this.selected = this.rows.has(id) ? id : null
    this.mark()
    this.renderPreview()
  }

  /** Sets the amounts (the debug hook, tests). */
  setAmounts(gold: number, blocks: number): void {
    this.gold.set(gold)
    this.blocks.set(blocks)
    this.renderPreview()
  }

  override dispose(): void {
    this.list.dispose()
    super.dispose()
  }
}
