/**
 * Item and skill slots (docs/UI.md §4.9): a 36×36 cell with the 32×32 icon at (+2, +2). The view keeps today's
 * `SlotView` API (`set`, `setCooldown`, `stack`, `ghost`) so hud/slots.ts can move onto it, plus the wave-8 mount
 * point `setSigns({plus, magic, rare, durability})` (M9, decision D12): the +N / magic / rare sign at the top-left
 * and the broken / low-durability overlay. Stack counts use the `item_number_{0-9}` digits when exported.
 * No logic here: slots only show what they are given.
 */
import type { ItemStack } from '@sro/shared'
import { cooldownNow } from '../../hud/cooldowns.ts'
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { CONTROLS, DIGIT_KEYS } from './skins.ts'

export const SLOT_SIZE = 36
export const SLOT_ICON = 32

/** What a slot needs to draw an item (ItemCatalog has these). */
export interface SlotIcons {
  icon(code: string): string | null | undefined
  name(code: string): string
  colour(code: string): string
}

export type Durability = 'ok' | 'low' | 'broken'

export interface SlotSigns {
  plus?: number
  magic?: boolean
  rare?: boolean
  durability?: Durability
}

export type SignKind = 'plus' | 'magic' | 'rare' | null

/** Which one sign shows at the top-left: rare over magic over +N (retail draws one sign). */
export function signOf(s: SlotSigns): SignKind {
  if (s.rare) return 'rare'
  if (s.magic) return 'magic'
  if (s.plus && s.plus > 0) return 'plus'
  return null
}

/** Merges sign sets (later wins per field): built-ins first, then each decorator's partial. */
export function mergeSigns(...parts: (Partial<SlotSigns> | null | undefined)[]): SlotSigns {
  const out: Record<string, unknown> = {}
  for (const p of parts) if (p) for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v
  return out as SlotSigns
}

/** The digits of a stack count ('' for a single item). */
export function countDigits(count: number): string {
  return count > 1 && Number.isFinite(count) ? String(Math.floor(count)) : ''
}

/** Up to two initials for an icon-less item ("Hp Potion 01" → "HP"). */
export function initials(name: string): string {
  const s = name
    .split(/\s+/)
    .filter(w => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('')
  return s || '?'
}

export interface SlotOptions {
  className?: string
  /** Draw a lattice cell behind the icon (grids draw their own lattice). */
  cell?: boolean
}

export class Slot {
  readonly root: HTMLElement
  readonly icon: HTMLElement
  private readonly count: HTMLElement
  private readonly sign: HTMLElement
  private readonly dur: HTMLElement
  private cd: HTMLElement | null = null
  stack: ItemStack | null = null
  private signs: SlotSigns = {}

  constructor(private readonly art: Art, private readonly icons: SlotIcons | null, opts: SlotOptions = {}) {
    this.root = el('div', `kit-slot ${opts.cell ? 'cell' : ''} ${opts.className ?? ''}`.trim())
    this.icon = el('div', 'kit-slot-icon')
    this.sign = el('div', 'kit-slot-sign')
    this.dur = el('div', 'kit-slot-dur')
    this.count = el('div', 'kit-slot-count')
    this.sign.hidden = true
    this.dur.hidden = true
    this.root.append(this.icon, this.dur, this.sign, this.count)
    if (art.has(CONTROLS.itemSelect)) this.root.style.setProperty('--select', art.cssUrl(CONTROLS.itemSelect))
    if (art.has(CONTROLS.redTile)) this.root.style.setProperty('--blocked', art.cssUrl(CONTROLS.redTile))
    if (art.has(CONTROLS.disable)) this.root.style.setProperty('--disable', art.cssUrl(CONTROLS.disable))
  }

  /** Shows an item stack (null = empty); `blocked` = the player cannot use it (red wash). */
  set(stack: ItemStack | null, blocked = false): void {
    this.stack = stack
    this.root.classList.toggle('filled', !!stack)
    this.root.classList.toggle('blocked', !!stack && blocked)
    if (!stack) {
      this.setIcon(null)
      this.setCount(0)
      this.setSigns({})
      return
    }
    const icons = this.icons
    const name = icons?.name(stack.code) ?? stack.code
    this.setIcon(icons?.icon(stack.code) ?? null, { text: initials(name), colour: icons?.colour(stack.code) })
    this.setCount(stack.count)
    this.setSigns(mergeSigns({ plus: stack.plus ?? 0 }, this.signs.durability ? { durability: this.signs.durability } : null))
  }

  /** Any icon (skills, actions); `fallback` draws initials on a colour when there is no picture. */
  setIcon(url: string | null, fallback?: { text?: string; colour?: string }): void {
    this.icon.replaceChildren()
    this.icon.style.backgroundImage = url ? `url("${url}")` : ''
    this.icon.style.backgroundColor = !url && fallback?.colour ? fallback.colour : ''
    this.icon.classList.toggle('fallback', !url && !!fallback)
    if (!url && fallback?.text) this.icon.append(el('span', '', fallback.text))
  }

  /** The stack count at the bottom-right (digit art when exported). */
  setCount(n: number): void {
    const digits = countDigits(n)
    this.count.replaceChildren()
    this.count.classList.remove('text')
    if (!digits) return
    if (DIGIT_KEYS.every(k => this.art.has(k))) {
      for (const d of digits) {
        const g = el('span', 'kit-digit')
        g.style.backgroundImage = this.art.cssUrl(DIGIT_KEYS[Number(d)]!)
        this.count.append(g)
      }
    } else {
      this.count.classList.add('text')
      this.count.textContent = digits
    }
  }

  /** M9: the item signs and the durability overlay. A later `set()` keeps the durability until changed. */
  setSigns(s: SlotSigns): void {
    this.signs = { ...s }
    const kind = signOf(s)
    const key = kind === 'plus' ? CONTROLS.signPlus : kind === 'magic' ? CONTROLS.signMagic : kind === 'rare' ? CONTROLS.signRare : null
    const hasKey = !!key && this.art.has(key)
    this.sign.hidden = !kind
    this.sign.className = `kit-slot-sign ${kind ?? ''} ${hasKey ? '' : 'text'}`.trim()
    this.sign.style.backgroundImage = hasKey ? this.art.cssUrl(key) : ''
    this.sign.textContent = kind === 'plus' && !hasKey ? `+${s.plus}` : kind && !hasKey ? '•' : ''
    this.sign.title = kind === 'plus' ? `+${s.plus}` : ''
    const d = s.durability && s.durability !== 'ok' ? s.durability : null
    const dKey = d === 'broken' ? CONTROLS.itemBroken : d === 'low' ? CONTROLS.itemWarning : null
    this.dur.hidden = !d
    this.dur.className = `kit-slot-dur ${d ?? ''}`.trim()
    this.dur.style.backgroundImage = dKey && this.art.has(dKey) ? this.art.cssUrl(dKey) : ''
    this.root.classList.toggle('broken', d === 'broken')
  }

  get currentSigns(): SlotSigns {
    return { ...this.signs }
  }

  /** Visual states the drag controller and windows set. */
  setState(state: 'dragging' | 'drop-ok' | 'drop-bad' | 'selected' | 'new', on: boolean): void {
    this.root.classList.toggle(state, on)
  }

  /** A cooldown sweep ending at `readyAt` (cooldownNow() time) out of `totalMs`; a past time clears it. */
  setCooldown(readyAt: number, totalMs: number): void {
    const left = readyAt - cooldownNow()
    if (!(totalMs > 0) || !(left > 0)) {
      this.cd?.remove()
      this.cd = null
      this.root.classList.remove('cooling')
      return
    }
    const cd = el('div', 'kit-slot-cd')
    const total = Math.max(totalMs, left)
    cd.style.animationDuration = `${total.toFixed(0)}ms`
    cd.style.animationDelay = `${(left - total).toFixed(0)}ms`
    cd.addEventListener('animationend', () => {
      if (this.cd !== cd) return
      cd.remove()
      this.cd = null
      this.root.classList.remove('cooling')
    })
    if (this.cd) this.cd.replaceWith(cd)
    else this.root.insertBefore(cd, this.dur)
    this.cd = cd
    this.root.classList.add('cooling')
  }

  /** A copy of the icon for the drag ghost (32×32, follows the cursor at −16, −16). */
  ghost(): HTMLElement {
    const g = this.icon.cloneNode(true) as HTMLElement
    g.className = 'kit-drag-ghost'
    return g
  }
}

/** A grid of slots at the retail 36-px pitch (bag 4×8, shop 6×5, storage 6×5, trade 6×2). */
export class SlotGrid {
  readonly root: HTMLElement
  readonly slots: Slot[] = []

  constructor(art: Art, icons: SlotIcons | null, readonly cols: number, readonly rows: number, opts: { className?: string; lattice?: boolean } = {}) {
    this.root = el('div', `kit-slot-grid ${opts.lattice === false ? '' : 'lattice'} ${opts.className ?? ''}`.trim())
    this.root.style.width = `${cols * SLOT_SIZE}px`
    this.root.style.height = `${rows * SLOT_SIZE}px`
    this.root.style.gridTemplateColumns = `repeat(${cols}, ${SLOT_SIZE}px)`
    const lattice = ['left_up', 'right_up', 'left_down', 'right_down'].map(p => `ifcommon/lattice_window/com_lattice_${p}`)
    if (lattice.every(k => art.has(k))) {
      // The four quarter cells tile as a 72×72 block (docs/UI.md §2.4).
      const [lu, ru, ld, rd] = lattice.map(k => art.cssUrl(k))
      this.root.style.setProperty('--lattice-lu', lu!)
      this.root.style.setProperty('--lattice-ru', ru!)
      this.root.style.setProperty('--lattice-ld', ld!)
      this.root.style.setProperty('--lattice-rd', rd!)
      this.root.classList.add('has-lattice')
    }
    for (let i = 0; i < cols * rows; i++) {
      const s = new Slot(art, icons)
      s.root.dataset.index = String(i)
      const r = Math.floor(i / cols)
      const c = i % cols
      s.root.classList.add(`q-${r % 2 ? 'd' : 'u'}${c % 2 ? 'r' : 'l'}`)
      this.slots.push(s)
      this.root.append(s.root)
    }
  }

  slot(i: number): Slot | undefined {
    return this.slots[i]
  }

  /** The slot index at (x, y) native px inside a grid, or -1. */
  static indexAt(x: number, y: number, cols: number, rows: number): number {
    const c = Math.floor(x / SLOT_SIZE)
    const r = Math.floor(y / SLOT_SIZE)
    return c >= 0 && r >= 0 && c < cols && r < rows ? r * cols + c : -1
  }
}
