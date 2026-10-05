/**
 * The Alchemy window (docs/SYSTEMS_COMBAT.md §4.7, docs/UI.md §4.6 "Alchemy", docs/WAVE_PLAN2.md D40; lane AL).
 *
 * Layout after the retail GDR_ALCHEMYBOX (`ifnewalchemybox.txt` / `ifnewalchemyreinforce.txt`) inside a kit window:
 *  - the description scroll (the parchment of `alcm_window_1`): "Equip Enhance", the item `+N → +N+1`, the success
 *    rate (the server's formula with `worldEnter.world.alchemyRate`) or what is missing, and the warning line;
 *  - the reinforce panel `alcm_window_reinforcement` (376×192): the equipment in the rune circle, the Elixir in the
 *    first material frame (x 164) and the Lucky Powder in the second (x 212); the frames at 260 / 308 are closed
 *    (`alcm_slot_closed`, D40); the Fuse / Cancel button (`alcm_button`) in the panel's bottom slot;
 *  - the effect sheets `alcm_effect_prepare` (looped for the fuse), `alcm_effect_success` / `alcm_effect_fail_1`
 *    (once) over the circle: 4×4 frames of 64 px, drawn at 128 px.
 *
 * `AlchemyModel` is the window's logic without a DOM (tests): which bag slot sits in which alchemy slot, what the
 * server would refuse, the preview chance and the request. The server stays authoritative (apps/server/src/alchemy.ts
 * holds the same rules).
 */
import type { ClientMessage, ItemDef, ItemStack } from '@sro/shared'
import { gameAudio } from '../audio/index.ts'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button, type KitButton } from '../ui/kit/button.ts'
import { Slot, type SlotIcons } from '../ui/kit/slot.ts'
import { Tooltip, type KitTooltipLine } from '../ui/kit/tooltip.ts'
import { Window } from '../ui/kit/window.ts'

// ---- rules (the server's, docs/SYSTEMS_COMBAT.md §4.3–4.4) ----------------------------------------------------

export type AlchemySlotKind = 'item' | 'elixir' | 'powder'
export const ALCHEMY_SLOTS: readonly AlchemySlotKind[] = ['item', 'elixir', 'powder']

/** Server defaults until `worldEnter` says otherwise (ALCHEMY_RATE, ALCHEMY_MAX_PLUS). */
export const DEFAULT_ALCHEMY_RATE = 1.5
export const DEFAULT_ALCHEMY_MAX_PLUS = 10

const REINFORCEABLE = new Set<ItemDef['category']>(['weapon', 'shield', 'armor', 'accessory'])

export function isReinforceable(def: ItemDef | undefined): def is ItemDef {
  return !!def && !!def.slot && REINFORCEABLE.has(def.category)
}
export function isElixir(def: ItemDef | undefined): def is ItemDef {
  return !!def && def.category === 'alchemy' && def.reinforce?.kind === 'elixir'
}
export function isPowder(def: ItemDef | undefined): def is ItemDef {
  return !!def && def.category === 'alchemy' && def.reinforce?.kind === 'powder'
}
/** An elixir fits equipment whose TypeID3 is one of its targets. */
export function elixirFits(elixir: ItemDef, item: ItemDef): boolean {
  return isElixir(elixir) && (elixir.reinforce!.targets ?? []).includes(item.typeId[2])
}
/** A Lucky Powder matches the equipment's degree (its own Param1 degree, never ItemDef.degree). */
export function powderFits(powder: ItemDef, item: ItemDef): boolean {
  return isPowder(powder) && powder.reinforce!.degree === item.degree
}
/** Percent chance of `plus` → `plus + 1`: min(100, (elixir[N] + matching powder[N]) × rate). */
export function successChance(item: ItemDef, plus: number, elixir: ItemDef, powder: ItemDef | null | undefined, rate: number): number {
  const i = Math.max(0, Math.floor(plus))
  const e = isElixir(elixir) ? (elixir.reinforce!.rates[i] ?? 0) : 0
  const p = powder && powderFits(powder, item) ? (powder.reinforce!.rates[i] ?? 0) : 0
  const r = Number.isFinite(rate) ? Math.max(0, rate) : 1
  return Math.min(100, Math.max(0, (e + p) * r))
}
/** Which alchemy slot a bag item goes into, or null (not equipment, not a material). */
export function slotFor(def: ItemDef | undefined): AlchemySlotKind | null {
  if (isElixir(def)) return 'elixir'
  if (isPowder(def)) return 'powder'
  if (isReinforceable(def)) return 'item'
  return null
}
/** "50" / "27" / "7.5": a chance without trailing zeros. */
export function formatChance(pct: number): string {
  return String(Math.round(pct * 10) / 10)
}

export type AlchemyProblem = 'noItem' | 'notEquipment' | 'broken' | 'noElixir' | 'elixirMismatch' | 'powderMismatch' | 'maxPlus'
/** 'sent': the Fuse is on the wire; 'fusing': the server started it; 'cancelling': a cancel is on the wire. */
export type AlchemyPhase = 'idle' | 'sent' | 'fusing' | 'cancelling'
export type AlchemyOutcomeView = 'success' | 'fail' | 'destroyed' | 'cancelled'

/** What the model needs of the item catalogue and the bag. */
export interface AlchemySource {
  def(code: string): ItemDef | undefined
  /** The bag stack at `slot` (null when empty). */
  item(slot: number): ItemStack | null
}

interface Held {
  bag: number
  code: string
}

/** The window's state without a DOM. */
export class AlchemyModel {
  private readonly held: Record<AlchemySlotKind, Held | null> = { item: null, elixir: null, powder: null }
  phase: AlchemyPhase = 'idle'
  rate = DEFAULT_ALCHEMY_RATE
  maxPlus = DEFAULT_ALCHEMY_MAX_PLUS

  constructor(private readonly src: AlchemySource) {}

  /** The bag slot in alchemy slot `k`, or null. */
  bagOf(k: AlchemySlotKind): number | null {
    return this.held[k]?.bag ?? null
  }

  /** The stack in alchemy slot `k` (from the bag), or null. */
  stack(k: AlchemySlotKind): ItemStack | null {
    const h = this.held[k]
    const s = h ? this.src.item(h.bag) : null
    return s && s.code === h!.code ? s : null
  }

  private defOf(k: AlchemySlotKind): ItemDef | undefined {
    const s = this.stack(k)
    return s ? this.src.def(s.code) : undefined
  }

  /**
   * Puts bag slot `bag` into the alchemy slot its item belongs to (replacing what was there). Returns the slot, or
   * 'notMaterial' for anything else. Nothing changes while a fuse runs (returns null).
   */
  place(bag: number): AlchemySlotKind | 'notMaterial' | null {
    if (this.phase !== 'idle') return null
    const s = this.src.item(bag)
    if (!s) return null
    const k = slotFor(this.src.def(s.code))
    if (!k) return 'notMaterial'
    for (const other of ALCHEMY_SLOTS) if (this.held[other]?.bag === bag) this.held[other] = null
    this.held[k] = { bag, code: s.code }
    return k
  }

  /** Takes alchemy slot `k` out (not while a fuse runs). */
  remove(k: AlchemySlotKind): boolean {
    if (this.phase !== 'idle' || !this.held[k]) return false
    this.held[k] = null
    return true
  }

  clear(): void {
    for (const k of ALCHEMY_SLOTS) this.held[k] = null
  }

  /** After an inventory change: slots whose bag item left or changed are emptied. Returns whether anything changed. */
  sync(): boolean {
    let changed = false
    for (const k of ALCHEMY_SLOTS) {
      const h = this.held[k]
      if (h && this.src.item(h.bag)?.code !== h.code) {
        this.held[k] = null
        changed = true
      }
    }
    return changed
  }

  /** The bag slots the window holds (drawn locked in the inventory). */
  lockedBags(): Set<number> {
    const out = new Set<number>()
    for (const k of ALCHEMY_SLOTS) {
      const b = this.held[k]?.bag
      if (b !== undefined) out.add(b)
    }
    return out
  }

  /** The first reason the server would refuse the current slots, or null. */
  problem(): AlchemyProblem | null {
    const item = this.stack('item')
    const def = this.defOf('item')
    if (!item) return 'noItem'
    if (!isReinforceable(def)) return 'notEquipment'
    if (item.durability === 0) return 'broken'
    const elixir = this.defOf('elixir')
    if (!isElixir(elixir)) return 'noElixir'
    if (!elixirFits(elixir, def)) return 'elixirMismatch'
    const powder = this.defOf('powder')
    if (this.stack('powder') && !(powder && powderFits(powder, def))) return 'powderMismatch'
    if ((item.plus ?? 0) >= this.maxPlus) return 'maxPlus'
    return null
  }

  /** The preview chance in percent (null while something is missing or wrong). */
  chance(): number | null {
    if (this.problem()) return null
    return successChance(this.defOf('item')!, this.stack('item')!.plus ?? 0, this.defOf('elixir')!, this.defOf('powder') ?? null, this.rate)
  }

  canFuse(): boolean {
    return this.phase === 'idle' && this.problem() === null
  }

  /** The `alchemyReinforce` for the current slots (and the phase moves to 'sent'), or null when it cannot fuse. */
  fuse(): Extract<ClientMessage, { t: 'alchemyReinforce' }> | null {
    if (!this.canFuse()) return null
    const msg: Extract<ClientMessage, { t: 'alchemyReinforce' }> = { t: 'alchemyReinforce', item: this.held.item!.bag, elixir: this.held.elixir!.bag }
    if (this.stack('powder')) msg.powder = this.held.powder!.bag
    this.phase = 'sent'
    return msg
  }

  /** The server refused the request (no fuse runs, so a cancel on the wire has nothing to end either). */
  refused(): void {
    if (this.phase === 'sent' || this.phase === 'cancelling') this.phase = 'idle'
  }

  /** `alchemyStart` (a cancel already on the wire stays pending: its `alchemyResult` follows). */
  started(): void {
    if (this.phase !== 'cancelling') this.phase = 'fusing'
  }

  /**
   * Cancel pressed, or the window closed, while a Fuse is pending: true when one `alchemyCancel` should go out. Further
   * presses send nothing until the result arrives (each would cost the request budget).
   */
  cancel(): boolean {
    if (this.phase !== 'sent' && this.phase !== 'fusing') return false
    this.phase = 'cancelling'
    return true
  }

  /**
   * `alchemyResult` (after its `inventoryUpdate`): back to idle; after a success or a failure the Elixir and Lucky
   * Powder slots are emptied and the equipment stays (retail); a destroyed item leaves its slot too.
   */
  result(outcome: 'success' | 'fail' | 'cancelled'): AlchemyOutcomeView {
    this.phase = 'idle'
    if (outcome === 'cancelled') return 'cancelled'
    this.held.elixir = null
    this.held.powder = null
    const destroyed = outcome === 'fail' && !this.stack('item')
    this.sync()
    return destroyed ? 'destroyed' : outcome
  }
}

// ---- the window --------------------------------------------------------------------------------------------

/** Body size: the description scroll (82) + 2 + the reinforce panel (376×192). */
export const PANEL_W = 376
export const PANEL_H = 192
export const INFO_H = 82
/** The parchment of alcm_window_1 starts at y 86 of the texture. */
const INFO_ART_Y = 86
export const ALCHEMY_W = PANEL_W + 32
export const ALCHEMY_H = 44 + INFO_H + 2 + PANEL_H + 16

/** Slot positions in the reinforce panel (36-px kit slots, icon at +2; measured on the art, UI.md §4.6). */
export const SLOT_AT: Readonly<Record<AlchemySlotKind, readonly [number, number]>> = {
  item: [57, 55],
  elixir: [162, 54],
  powder: [210, 54],
}
/** The two spare frames, closed (D40). */
export const CLOSED_AT: readonly (readonly [number, number])[] = [[264, 58], [312, 58]]
/** The rune circle's centre and the effect size (4×4 sheets of 64-px frames drawn at 128). */
export const FX_CENTER: readonly [number, number] = [75, 71]
export const FX_SIZE = 128
const FX_FRAMES = 16
const FX_FRAME_MS = 55
/** The Fuse button's slot in the panel (alcm_button 112×28). */
export const FUSE_AT: readonly [number, number] = [132, 143]

const ART = {
  info: 'alchemy/alcm_window_1',
  panel: 'alchemy/alcm_window_reinforcement',
  closed: 'alchemy/alcm_slot_closed',
  button: 'alchemy/alcm_button',
  prepare: 'alchemy/alcm_effect_prepare',
  success: 'alchemy/alcm_effect_success',
  fail: 'alchemy/alcm_effect_fail_1',
} as const

const CSS = `
.kit-window-alchemy .al-info { position: relative; width: ${PANEL_W}px; height: ${INFO_H}px; background-repeat: no-repeat; background-position: 0 -${INFO_ART_Y}px; }
.kit-window-alchemy .al-info.no-art { background: rgba(236, 222, 190, 0.9); box-shadow: inset 0 0 0 1px var(--c-rim); }
.kit-window-alchemy .al-lines { position: absolute; left: 26px; right: 26px; top: 8px; bottom: 8px; display: flex; flex-direction: column; justify-content: center; gap: 1px; text-align: center; overflow: hidden; }
.kit-window-alchemy .al-lines > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-alchemy .al-heading { font-weight: bold; }
.kit-window-alchemy .al-target.plus { color: #7a3d00; font-weight: bold; }
.kit-window-alchemy .al-lines > .al-state { white-space: normal; }
.kit-window-alchemy .al-state.bad { color: #9e1a10; }
.kit-window-alchemy .al-state.good { color: #1f5c10; font-weight: bold; }
.kit-window-alchemy .al-warn { font-size: 11px; line-height: 14px; color: #6b3a14; }
.kit-window-alchemy .al-panel { position: relative; width: ${PANEL_W}px; height: ${PANEL_H}px; margin-top: 2px; background-repeat: no-repeat; }
.kit-window-alchemy .al-panel.no-art { background: rgba(40, 30, 18, 0.9); box-shadow: inset 0 0 0 1px var(--c-rim); }
.kit-window-alchemy .al-slot { position: absolute; cursor: pointer; }
.kit-window-alchemy .al-slot.empty .kit-slot-icon { opacity: 0; }
.kit-window-alchemy .al-panel.no-art .al-slot { background: rgba(0, 0, 0, 0.45); box-shadow: inset 0 0 0 1px var(--c-rim); }
.kit-window-alchemy .al-closed { position: absolute; width: 32px; height: 32px; background-repeat: no-repeat; pointer-events: none; }
.kit-window-alchemy .al-fx { position: absolute; width: ${FX_SIZE}px; height: ${FX_SIZE}px; pointer-events: none; background-repeat: no-repeat;
  background-size: ${FX_SIZE * 4}px ${FX_SIZE * 4}px; mix-blend-mode: screen; }
.kit-window-alchemy .al-fx[hidden] { display: none; }
.kit-window-alchemy .al-fuse { position: absolute; }
.kit-window-alchemy.fusing .al-slot { cursor: default; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'alchemy'
  s.textContent = CSS
  document.head.append(s)
}

export interface AlchemyHandlers {
  /** Fuse pressed with a valid set (send it). */
  fuse(msg: Extract<ClientMessage, { t: 'alchemyReinforce' }>): void
  /** Cancel pressed, or the window closed, while a fuse runs. */
  cancel(): void
  /** The slots changed (the feature re-marks the bag). */
  changed(): void
  /** Tooltip lines of an item stack in a slot. */
  tooltip(stack: ItemStack): KitTooltipLine[]
}

/** The Alchemy window (a kit window). */
export class AlchemyWindow extends Window {
  readonly model: AlchemyModel
  private readonly slots: Record<AlchemySlotKind, Slot>
  private readonly lines: { heading: HTMLElement; target: HTMLElement; state: HTMLElement; warn: HTMLElement }
  private readonly fx: HTMLElement
  private readonly fuseButton: KitButton
  private readonly panel: HTMLElement
  private readonly tip: Tooltip
  private fxTimer: ReturnType<typeof setInterval> | null = null

  constructor(art: Art, parent: HTMLElement, private readonly icons: SlotIcons, src: AlchemySource, private readonly handlers: AlchemyHandlers) {
    super(art, parent, { id: 'alchemy', title: t('alchemy.title'), width: ALCHEMY_W, height: ALCHEMY_H, at: [0.3, 0.4] })
    ensureStyles()
    this.model = new AlchemyModel(src)
    this.tip = new Tooltip(art)

    const info = el('div', 'al-info')
    if (art.has(ART.info)) info.style.backgroundImage = art.cssUrl(ART.info)
    else info.classList.add('no-art')
    const box = el('div', 'al-lines')
    this.lines = {
      heading: el('div', 'al-heading kit-t-paper', t('alchemy.heading')),
      target: el('div', 'al-target kit-t-paper'),
      state: el('div', 'al-state kit-t-paper'),
      warn: el('div', 'al-warn kit-t-paper', t('alchemy.warning')),
    }
    box.append(this.lines.heading, this.lines.target, this.lines.state, this.lines.warn)
    info.append(box)

    this.panel = el('div', 'al-panel')
    if (art.has(ART.panel)) this.panel.style.backgroundImage = art.cssUrl(ART.panel)
    else this.panel.classList.add('no-art')
    for (const [x, y] of CLOSED_AT) {
      if (!art.has(ART.closed)) continue
      const c = el('div', 'al-closed')
      c.style.left = `${x}px`
      c.style.top = `${y}px`
      c.style.backgroundImage = art.cssUrl(ART.closed)
      this.panel.append(c)
    }
    this.fx = el('div', 'al-fx')
    this.fx.hidden = true
    this.fx.style.left = `${FX_CENTER[0] - FX_SIZE / 2}px`
    this.fx.style.top = `${FX_CENTER[1] - FX_SIZE / 2}px`
    this.slots = { item: this.makeSlot('item'), elixir: this.makeSlot('elixir'), powder: this.makeSlot('powder') }
    // The effect plays over the circle, under the equipment slot's icon.
    this.panel.insertBefore(this.fx, this.slots.item.root)
    // The retail alchemy button (112×28, focus / press / disable art); the kit's std button when it is missing.
    const skin = art.has(ART.button) ? { key: ART.button, w: 112, h: 28, slice: 8 } : 'std'
    this.fuseButton = button(art, { label: t('alchemy.fuse'), skin, width: 112, className: 'al-fuse' }, () => this.pressed())
    this.fuseButton.style.left = `${FUSE_AT[0]}px`
    this.fuseButton.style.top = `${FUSE_AT[1]}px`
    this.panel.append(this.fuseButton)
    this.body.append(info, this.panel)
    this.render()
  }

  private makeSlot(k: AlchemySlotKind): Slot {
    const s = new Slot(this.art, this.icons, { className: `al-slot al-slot-${k}` })
    s.root.dataset.alchemy = k
    const [x, y] = SLOT_AT[k]
    s.root.style.left = `${x}px`
    s.root.style.top = `${y}px`
    this.panel.append(s.root)
    this.ls.on(s.root, 'contextmenu', ev => {
      ev.preventDefault()
      this.tip.hide()
      if (this.model.remove(k)) this.refresh()
    })
    this.ls.on(s.root, 'pointerenter', ev => this.hover(k, ev))
    this.ls.on(s.root, 'pointermove', ev => this.tip.move(ev.clientX, ev.clientY))
    this.ls.on(s.root, 'pointerleave', () => this.tip.hide())
    return s
  }

  private hover(k: AlchemySlotKind, ev: PointerEvent): void {
    const stack = this.model.stack(k)
    const lines: KitTooltipLine[] = stack
      ? [...this.handlers.tooltip(stack), { text: '', cls: 'sep' }, { text: t('alchemy.slot.remove'), cls: 'hint' }]
      : [{ text: t(`alchemy.slot.${k}` as StringKey), cls: 'title' }, { text: t('alchemy.slot.empty'), cls: 'desc' }]
    this.tip.show(lines, ev.clientX, ev.clientY)
  }

  private pressed(): void {
    if (this.model.phase === 'fusing' || this.model.phase === 'cancelling') {
      if (this.model.cancel()) this.handlers.cancel()
      this.render()
      return
    }
    const msg = this.model.fuse()
    if (!msg) return
    this.handlers.fuse(msg)
    this.render()
  }

  /** Puts a bag item in (right-click or drag from the inventory). Opens the window when closed. */
  put(bag: number): AlchemySlotKind | 'notMaterial' | null {
    const r = this.model.place(bag)
    if (!this.isOpen && r && r !== 'notMaterial') this.open()
    if (r && r !== 'notMaterial') this.refresh()
    return r
  }

  /** Whether (x, y) (client px) is over this window. */
  contains(x: number, y: number): boolean {
    if (!this.isOpen) return false
    const r = this.root.getBoundingClientRect()
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom
  }

  /** Re-draws after a model change and tells the feature. */
  refresh(): void {
    this.render()
    this.handlers.changed()
  }

  /** Draws the slots, the description lines and the button from the model. */
  render(): void {
    const m = this.model
    for (const k of ALCHEMY_SLOTS) {
      const stack = m.stack(k)
      this.slots[k].set(stack)
      this.slots[k].root.classList.toggle('empty', !stack)
    }
    const item = m.stack('item')
    const name = item ? this.icons.name(item.code) : ''
    const plus = item?.plus ?? 0
    this.lines.target.textContent = item ? (plus < m.maxPlus ? t('alchemy.target', { name, from: plus, to: plus + 1 }) : `${name} +${plus}`) : ''
    this.lines.target.classList.toggle('plus', plus > 0)
    const problem = m.problem()
    const chance = m.chance()
    const fusing = m.phase === 'fusing' || m.phase === 'cancelling'
    this.lines.state.textContent = fusing ? t('alchemy.fusing') : chance !== null ? t('alchemy.chance', { pct: formatChance(chance) }) : item || m.stack('elixir') || m.stack('powder') ? t(`alchemy.problem.${problem}` as StringKey) : t('alchemy.hint')
    this.lines.state.classList.toggle('bad', !fusing && problem !== null && !!(item || m.stack('elixir') || m.stack('powder')))
    this.lines.state.classList.toggle('good', !fusing && chance !== null)
    this.root.classList.toggle('fusing', fusing)
    this.fuseButton.setLabel(fusing ? t('alchemy.cancel') : t('alchemy.fuse'))
    this.fuseButton.setDisabled(!(m.phase === 'fusing' || m.canFuse()))
  }

  // ---- effects -------------------------------------------------------------------------------------

  /** `alchemyStart`: the prepare sheet loops for `ms`, with the elixir cue. */
  started(ms: number): void {
    this.model.started()
    this.render()
    gameAudio()?.ui('ui.elixir_use')
    this.playFx(ART.prepare, true, ms)
  }

  /** `alchemyResult`: the success or fail sheet once, with its cue. Returns what the chat line should say. */
  finished(outcome: 'success' | 'fail' | 'cancelled'): AlchemyOutcomeView {
    const view = this.model.result(outcome)
    if (!this.isOpen) this.model.clear()
    if (view === 'cancelled') this.stopFx()
    else {
      gameAudio()?.ui(view === 'success' ? 'ui.elixir_success' : 'ui.elixir_failure')
      this.playFx(view === 'success' ? ART.success : ART.fail, false, FX_FRAMES * FX_FRAME_MS)
    }
    this.refresh()
    return view
  }

  /** The server refused the Fuse. */
  refused(): void {
    this.model.refused()
    this.render()
  }

  private playFx(key: string, loop: boolean, ms: number): void {
    this.stopFx()
    if (!this.art.has(key) || typeof setInterval === 'undefined') return
    this.fx.style.backgroundImage = this.art.cssUrl(key)
    this.fx.hidden = false
    let frame = 0
    const end = performance.now() + ms
    const show = () => {
      const f = frame % FX_FRAMES
      this.fx.style.backgroundPosition = `${-(f % 4) * FX_SIZE}px ${-Math.floor(f / 4) * FX_SIZE}px`
    }
    show()
    this.fxTimer = setInterval(() => {
      frame++
      if ((!loop && frame >= FX_FRAMES) || (loop && performance.now() >= end)) return this.stopFx()
      show()
    }, FX_FRAME_MS)
  }

  private stopFx(): void {
    if (this.fxTimer !== null) clearInterval(this.fxTimer)
    this.fxTimer = null
    this.fx.hidden = true
  }

  // ---- window ---------------------------------------------------------------------------------------

  /** Closing cancels a running fuse and empties the slots (retail). */
  override close(): void {
    if (!this.isOpen) return
    this.tip.hide()
    // A Fuse on the wire is cancelled too: the server handles the two requests in order.
    if (this.model.cancel()) this.handlers.cancel()
    super.close()
    if (this.model.phase === 'idle') {
      this.model.clear()
      this.stopFx()
      this.refresh()
    }
  }

  override dispose(): void {
    this.stopFx()
    this.tip.dispose()
    super.dispose()
  }
}
