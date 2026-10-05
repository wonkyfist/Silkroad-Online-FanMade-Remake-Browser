/**
 * Play the Boss HUD pieces (docs/PLAY_THE_BOSS.md §4.3–§4.5; mockup play-the-boss-preview.png): the pilot's boss frame,
 * the top strip, the kit bar with cooldown sweeps and charges, the steering line, the taunt wheel, a dialog panel (the
 * result window and the offer), the hunters' banner and the call banner (layer 4). DOM only: the state comes from world/features/pilot.ts, the
 * maths from world/pilot-model.ts. Native px inside the zoomed `.hud-root`.
 */
import type { PilotKitView } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import type { KitSlotState } from '../world/pilot-model.ts'
import { tauntSector, tauntSectorDir } from '../world/pilot-model.ts'
import { cooldownNow } from './cooldowns.ts'
import { formatNumber } from './items.ts'
import { ensurePilotStyles } from './pilot-style.ts'
import { CooldownSweep } from './slots.ts'

/** A glyph per kit ability (no retail icons exist for her rows or the new abilities). */
export const KIT_GLYPHS: Readonly<Record<string, string>> = {
  claw: '///',
  sweep: '(',
  curse: '@',
  pounce: '↗',
  roar: ')))',
  pack: '∴',
  stalk: 'ΛΛΛ',
}

/** The i18n name of an ability (pilot.ability.<id>.name), or "Ability <id>" for one the client has no line for. */
export function abilityName(id: string): string {
  const key = `pilot.ability.${id}.name` as StringKey
  const s = t(key)
  return s === key ? t('pilot.ability.unknown', { id }) : s
}

export function abilityDesc(id: string): string {
  const key = `pilot.ability.${id}.desc` as StringKey
  const s = t(key)
  return s === key ? '' : s
}

/** "Tiger Girl" with `name` drawn in the unique pink inside a line built from `text` (text nodes only). */
function pinkName(text: string, name: string): HTMLElement {
  const at = name ? text.indexOf(name) : -1
  if (at < 0) return el('span', '', text)
  return el('span', '', text.slice(0, at), el('span', 'pl-pink', name), text.slice(at + name.length))
}

// ---- the boss frame ----------------------------------------------------------------------------------------------

export class BossFrame {
  readonly root: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly fill: HTMLElement
  private readonly hpText: HTMLElement
  private hpKey = ''
  private namesKey = ''

  constructor(art: Art) {
    ensurePilotStyles()
    const face = el('div', 'pl-boss-face')
    if (art.has('minimap/mm_sign_unique')) {
      const i = el('i')
      i.style.backgroundImage = art.cssUrl('minimap/mm_sign_unique')
      face.append(i)
    } else face.append(el('b', '', '虎'))
    this.nameEl = el('div', 'pl-boss-name')
    this.fill = el('i')
    this.hpText = el('span')
    const hp = el('div', 'pl-boss-hp', this.fill, this.hpText)
    const stats = el('div', 'pl-boss-stats', t('pilot.hud.fixed'), el('span', 'pl-boss-rage', t('pilot.hud.enraged')))
    this.root = el('div', 'pl-boss pl-panel', face, this.nameEl, hp, stats)
    this.root.hidden = true
  }

  setNames(boss: string, pilot: string): void {
    const key = `${boss}|${pilot}`
    if (key === this.namesKey) return
    this.namesKey = key
    this.nameEl.replaceChildren(el('span', 'pl-pink', boss), pilot ? el('small', '', t('pilot.hud.you', { name: pilot })) : '')
  }

  setHp(hp: number, maxHp: number): void {
    const key = `${hp}/${maxHp}`
    if (key === this.hpKey) return
    this.hpKey = key
    const f = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0
    this.fill.style.transform = `scaleX(${f.toFixed(4)})`
    this.hpText.textContent = maxHp > 0 ? `${formatNumber(hp)} / ${formatNumber(maxHp)}` : ''
  }

  setEnraged(on: boolean): void {
    this.root.classList.toggle('enraged', on)
  }
}

// ---- the strip ---------------------------------------------------------------------------------------------------

export class HuntStrip {
  readonly root: HTMLElement
  private readonly survive: HTMLElement
  private readonly downs: HTMLElement
  private readonly hunting: HTMLElement
  private last = ['', '', '']

  constructor() {
    ensurePilotStyles()
    const cell = (cap: StringKey, val: HTMLElement) => el('div', 'pl-strip-cell', el('div', 'pl-strip-cap', t(cap)), val)
    this.survive = el('div', 'pl-strip-val')
    this.downs = el('div', 'pl-strip-val')
    this.hunting = el('div', 'pl-strip-val hot')
    this.root = el('div', 'pl-strip pl-panel', cell('pilot.hud.survive', this.survive), cell('pilot.hud.downed', this.downs), cell('pilot.hud.hunting', this.hunting))
    this.root.hidden = true
  }

  /** `survive`: "11:42" or null (no timer: an attach session); `low` pulses it (the last minute). */
  set(survive: string | null, low: boolean, downs: number, target: number, hunting: number): void {
    const s = survive ?? t('pilot.hud.none')
    if (s !== this.last[0]) {
      this.last[0] = s
      this.survive.textContent = s
    }
    this.survive.classList.toggle('low', low)
    const d = `${downs}/${target}`
    if (d !== this.last[1]) {
      this.last[1] = d
      this.downs.replaceChildren(String(downs), el('small', '', ` / ${target > 0 ? target : t('pilot.hud.none')}`))
    }
    const h = String(hunting)
    if (h !== this.last[2]) {
      this.last[2] = h
      this.hunting.textContent = h
    }
  }
}

// ---- the kit bar -------------------------------------------------------------------------------------------------

interface SlotEls {
  root: HTMLElement
  /** The line under the name: the range and the charges left ("12 m", "2 left"). */
  sub: HTMLElement
  range: string
  sweep: CooldownSweep
  readyAt: number
}

export class KitBar {
  readonly root: HTMLElement
  private readonly slots = new Map<string, SlotEls>()

  constructor(private readonly onUse: (id: string) => void) {
    ensurePilotStyles()
    this.root = el('div', 'pl-kit pl-panel')
    this.root.hidden = true
    // A click on the bar never reaches the world (click-to-move).
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
  }

  /** Builds the slots of `kit` (pilotStart). */
  build(kit: readonly PilotKitView[]): void {
    this.root.replaceChildren()
    this.slots.clear()
    for (const k of [...kit].sort((a, b) => a.slot - b.slot)) {
      const box = el('div', 'pl-slot-box', el('div', 'pl-slot-glyph', KIT_GLYPHS[k.id] ?? k.id.slice(0, 2).toUpperCase()), el('div', 'pl-slot-key', String(k.slot)))
      const range = k.rangeM > 0 ? t('pilot.hud.range', { m: k.rangeM }) : ''
      const sub = el('div', 'pl-slot-sub', range)
      const root = el('div', 'pl-slot', box, el('div', 'pl-slot-name', abilityName(k.id)), sub)
      root.dataset.id = k.id
      const desc = abilityDesc(k.id)
      root.title = desc ? `${abilityName(k.id)} (${k.slot})\n${desc}` : `${abilityName(k.id)} (${k.slot})`
      root.addEventListener('click', ev => {
        ev.stopPropagation()
        this.onUse(k.id)
      })
      this.slots.set(k.id, { root, sub, range, sweep: new CooldownSweep(box), readyAt: 0 })
      this.root.append(root)
    }
  }

  /** The slots' states at server time `serverNow` (pilot-model kitSlots). */
  update(states: readonly KitSlotState[], serverNow: number): void {
    for (const s of states) {
      const e = this.slots.get(s.id)
      if (!e) continue
      e.root.classList.toggle('disabled', s.disabled)
      e.root.classList.toggle('empty', s.why === 'charges')
      const sub = [e.range, s.charges !== undefined ? t('pilot.hud.charges', { count: s.charges }) : ''].filter(Boolean).join(' · ')
      if (e.sub.textContent !== sub) e.sub.textContent = sub
      if (s.readyAt !== e.readyAt) {
        e.readyAt = s.readyAt
        // The sweep runs on the local clock (CooldownClock's): the server's ready time shifted to it.
        e.sweep.set(s.readyAt > 0 ? cooldownNow() + (s.readyAt - serverNow) : 0, s.cooldownMs)
      }
    }
  }
}

// ---- steering line -----------------------------------------------------------------------------------------------

export class SteeringLine {
  readonly root: HTMLElement
  readonly stalk: HTMLElement

  constructor() {
    ensurePilotStyles()
    this.root = el('div', 'pl-steer')
    this.root.hidden = true
    this.stalk = el('div', 'pl-stalk', t('pilot.hud.stalking'))
    this.stalk.hidden = true
  }

  set(text: string | null, ai: boolean): void {
    this.root.hidden = !text
    if (text && this.root.textContent !== text) this.root.textContent = text
    this.root.classList.toggle('ai', ai)
  }
}

// ---- taunt wheel -------------------------------------------------------------------------------------------------

export class TauntWheel {
  readonly root: HTMLElement
  private readonly lines: HTMLElement[] = []
  private cx = 0
  private cy = 0
  private pick: number | null = null
  /** Radius of the line labels from the centre (wheel px). */
  private static readonly R = 84

  constructor(count: number, private readonly onPick: (line: number) => void) {
    ensurePilotStyles()
    const hub = el('div', 'pl-wheel-hub', 'Q', el('small', '', t('pilot.hud.tauntHint')))
    this.root = el('div', 'pl-wheel', el('div', 'pl-wheel-disc'), hub)
    for (let i = 0; i < count; i++) {
      const d = tauntSectorDir(i, count)
      const line = el('div', 'pl-wheel-line', `“${t(`pilot.taunt.${i}` as StringKey)}”`)
      line.style.left = `${118 + d.x * TauntWheel.R}px`
      line.style.top = `${118 + d.y * TauntWheel.R}px`
      line.addEventListener('pointerdown', ev => {
        ev.stopPropagation()
        ev.preventDefault()
        this.pick = i
        this.close()
      })
      this.lines.push(line)
      this.root.append(line)
    }
    this.root.hidden = true
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** Opens centred on the viewport point (x, y) (CSS px), kept on screen. */
  open(x: number, y: number): void {
    const zoom = uiZoom()
    const half = 118 * zoom
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024
    const h = typeof window !== 'undefined' ? window.innerHeight : 768
    this.cx = Math.max(half, Math.min(w - half, x))
    this.cy = Math.max(half, Math.min(h - half, y))
    // The wheel sits in the zoomed HUD layer: its left/top are in native px.
    this.root.style.left = `${this.cx / zoom}px`
    this.root.style.top = `${this.cy / zoom}px`
    this.pick = null
    this.highlight(null)
    this.root.hidden = false
  }

  /** The pointer moved to viewport (x, y): highlights the line under it. */
  move(x: number, y: number): void {
    if (!this.isOpen) return
    const zoom = uiZoom()
    this.pick = tauntSector((x - this.cx) / zoom, (y - this.cy) / zoom, this.lines.length)
    this.highlight(this.pick)
  }

  /** Q released (or a line clicked): sends the line under the pointer, if any, and hides. */
  close(): void {
    if (!this.isOpen) return
    this.root.hidden = true
    const p = this.pick
    this.pick = null
    if (p !== null) this.onPick(p)
  }

  /** Hides without sending. */
  cancel(): void {
    this.pick = null
    this.root.hidden = true
  }

  private highlight(i: number | null): void {
    this.lines.forEach((l, j) => l.classList.toggle('on', j === i))
  }
}

function uiZoom(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return 1
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui'))
  return v > 0 ? v : 1
}

// ---- dialog panel (result window, offer) --------------------------------------------------------------------------

export interface DialogButton {
  label: string
  primary?: boolean
  run(): void
}

export interface DialogContent {
  cap: string
  /** The heading, with `name` drawn in the unique pink. */
  head: string
  name?: string
  lines: readonly (string | HTMLElement)[]
  /** Lines without bullets, centred. */
  plain?: boolean
  buttons: readonly DialogButton[]
  foot?: HTMLElement | string | null
}

export class PilotDialog {
  readonly root: HTMLElement
  private readonly footEl: HTMLElement

  constructor(private readonly art: Art, className = '') {
    ensurePilotStyles()
    this.footEl = el('div', 'pl-dialog-foot')
    this.root = el('div', `pl-dialog pl-panel ${className}`.trim())
    this.root.hidden = true
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  show(c: DialogContent): void {
    const list = el('ul', `pl-dialog-lines${c.plain ? ' plain' : ''}`)
    for (const l of c.lines) list.append(el('li', '', l))
    const buttons = el('div', 'pl-dialog-buttons')
    for (const b of c.buttons) buttons.append(button(this.art, { label: b.label, primary: b.primary, minWidth: 84 }, () => b.run()))
    this.setFoot(c.foot ?? null)
    this.root.replaceChildren(el('div', 'pl-dialog-cap', c.cap), el('div', 'pl-dialog-head', pinkName(c.head, c.name ?? '')), list, buttons, this.footEl)
    this.root.hidden = false
  }

  setFoot(foot: HTMLElement | string | null): void {
    this.footEl.replaceChildren(foot ?? '')
    this.footEl.hidden = !foot
  }

  hide(): void {
    this.root.hidden = true
  }
}

/** "Accept within <b>0:27</b>" as nodes: `text` with `{time}` replaced by a bold `time`. */
export function boldTime(text: string, time: string): HTMLElement {
  const [a = '', b = ''] = text.split('{time}')
  return el('span', '', a, el('b', '', time), b)
}

// ---- the call banner (§4.5, layer 4) ---------------------------------------------------------------------------

export interface CallBannerContent {
  /** The question, with `name` drawn in pink. */
  question: string
  name: string
  meta: string
  mode: 'open' | 'volunteered' | 'ineligible'
  why: string | null
}

/**
 * The call for volunteers (mockup section 1, left): "Unique Event", the question, "Draw in 9:41 · 37 volunteers · level
 * 20 only", then **Volunteer** / **Not this time**, a "you volunteered" line with Not this time (withdraw), or the
 * reason this character cannot volunteer. Sits where the hunters' banner sits; its buttons take the pointer.
 */
export class CallBanner {
  readonly root: HTMLElement
  private readonly text: HTMLElement
  private readonly meta: HTMLElement
  private readonly line: HTMLElement
  private readonly actions: HTMLElement
  private readonly yes: HTMLElement
  private readonly no: HTMLElement
  private key = ''

  constructor(art: Art, onVolunteer: () => void, onDecline: () => void) {
    ensurePilotStyles()
    this.text = el('div', 'pl-hunt-text')
    this.meta = el('div', 'pl-hunt-meta')
    this.line = el('div', 'pl-call-line')
    this.yes = button(art, { label: t('pilot.call.volunteer'), primary: true, minWidth: 96 }, onVolunteer)
    this.no = button(art, { label: t('pilot.call.withdraw'), minWidth: 96 }, onDecline)
    this.actions = el('div', 'pl-call-actions', this.yes, this.no)
    this.root = el('div', 'pl-hunt pl-call', el('div', 'pl-hunt-cap', t('pilot.call.title')), this.text, this.meta, this.line, this.actions)
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.root.hidden = true
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** Shows `c` (null hides the banner). */
  set(c: CallBannerContent | null): void {
    if (!c) {
      this.root.hidden = true
      this.key = ''
      return
    }
    this.root.hidden = false
    const key = `${c.question}|${c.name}|${c.mode}|${c.why ?? ''}`
    if (key !== this.key) {
      this.key = key
      this.text.replaceChildren(pinkName(c.question, c.name))
      this.line.className = c.mode === 'ineligible' ? 'pl-call-line why' : 'pl-call-line on'
      this.line.textContent = c.mode === 'volunteered' ? t('pilot.call.volunteered') : (c.why ?? '')
      this.line.hidden = c.mode === 'open'
      this.yes.hidden = c.mode !== 'open'
      this.no.hidden = c.mode === 'ineligible'
      this.actions.hidden = c.mode === 'ineligible'
    }
    if (this.meta.textContent !== c.meta) this.meta.textContent = c.meta
  }

  /** A notice banner is up: step below it. */
  setBelow(on: boolean): void {
    this.root.classList.toggle('below', on)
  }
}

// ---- the hunters' banner -----------------------------------------------------------------------------------------

export class HuntBanner {
  readonly root: HTMLElement
  private readonly text: HTMLElement
  private readonly meta: HTMLElement
  private key = ''
  private metaKey = ''

  constructor() {
    ensurePilotStyles()
    this.text = el('div', 'pl-hunt-text')
    this.meta = el('div', 'pl-hunt-meta')
    this.root = el('div', 'pl-hunt', el('div', 'pl-hunt-cap', t('hunt.title')), this.text, this.meta)
    this.root.hidden = true
  }

  /** Shows `text` (with `name` in pink) and the meta line (null hides the banner). */
  set(text: string | null, name = '', meta = ''): void {
    if (text === null) {
      this.root.hidden = true
      this.key = ''
      return
    }
    this.root.hidden = false
    const key = `${text}|${name}`
    if (key !== this.key) {
      this.key = key
      this.text.replaceChildren(pinkName(text, name))
    }
    if (meta !== this.metaKey) {
      this.metaKey = meta
      this.meta.textContent = meta
    }
  }

  /** A notice banner is up: step below it. */
  setBelow(on: boolean): void {
    this.root.classList.toggle('below', on)
  }
}
