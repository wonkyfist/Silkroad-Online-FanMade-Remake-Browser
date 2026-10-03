/**
 * Buffs and statuses (docs/SKILLS.md §10.2-§10.3): EffectBook keeps every visible entity's effects from
 * `EntityState.effects` / `effectAdd` / `effectRemove` with their local end times; BuffBar draws your own on the retail
 * board beside the player frame (GDR_MAGICSTATEBOARD at (220,10): blessings on the top row, harmful effects on the
 * second, 20-px icons with the `s_stateodd_time_gauge` time bar under each; tooltip with the time left; right-click
 * on a buff sends `buffCancel`), and `targetIcons` gives the
 * target window's row. The server removes effects itself (`effectRemove expired`); the local end time only drives
 * the countdown.
 */
import type { EffectState, SkillStatusKind } from '@sro/shared'
import type { SkillCatalog } from '../content/skills.ts'
import { formatDuration, formatShort } from '../content/skills.ts'
import { t, type StringKey } from '../i18n/index.ts'
import { el, Listeners } from '../ui/dom.ts'
import { kitArt } from '../ui/kit/host.ts'
import type { TooltipLine } from './items.ts'
import { BUFF_MAX, BUFF_PITCH, BUFF_ROW } from './hud-layout.ts'
import { ensureHudStyles } from './hud-style.ts'
import { ensureSkillStyles } from './skills-style.ts'
import type { Tooltip } from './slots.ts'
import type { TargetEffectIcon } from './target.ts'

export interface EffectEntry {
  effect: EffectState
  /** Local ms when it runs out (Infinity: until cancelled). */
  endsAt: number
  /** The whole duration as first seen (ms; Infinity for toggles): the time gauge's full length. */
  total: number
}

/** Effects per entity id, in the order they arrived. */
export class EffectBook {
  private readonly by = new Map<number, Map<number, EffectEntry>>()

  /** Replaces an entity's effects (worldEnter, spawn). */
  set(id: number, effects: readonly EffectState[] | undefined, now: number): void {
    this.by.delete(id)
    for (const e of effects ?? []) this.add(id, e, now)
  }

  add(id: number, effect: EffectState, now: number): EffectEntry {
    let m = this.by.get(id)
    if (!m) this.by.set(id, (m = new Map()))
    const prev = m.get(effect.instance)
    const endsAt = effect.remainingMs > 0 ? now + effect.remainingMs : Infinity
    const total = Math.max(effect.remainingMs > 0 ? effect.remainingMs : Infinity, prev && Number.isFinite(prev.total) ? prev.total : 0)
    const entry = { effect, endsAt, total }
    m.delete(effect.instance)
    m.set(effect.instance, entry)
    return entry
  }

  remove(id: number, instance: number): EffectEntry | undefined {
    const m = this.by.get(id)
    const e = m?.get(instance)
    if (!m || !e) return undefined
    m.delete(instance)
    if (!m.size) this.by.delete(id)
    return e
  }

  list(id: number): EffectEntry[] {
    return [...(this.by.get(id)?.values() ?? [])]
  }

  has(id: number, status: SkillStatusKind): boolean {
    return this.list(id).some(e => e.effect.status === status)
  }

  ids(): number[] {
    return [...this.by.keys()]
  }

  drop(id: number): EffectEntry[] {
    const list = this.list(id)
    this.by.delete(id)
    return list
  }

  clear(): void {
    this.by.clear()
  }
}

/** A harmful effect: a status, or a debuff skill. */
export function isHarmful(e: EffectState, catalog: SkillCatalog): boolean {
  if (e.status) return true
  const kind = e.skill ? catalog.get(e.skill)?.kind : undefined
  return kind === 'debuff' || kind === 'attack'
}

/** Name of an effect: its skill's name, else its status. */
export function effectName(e: EffectState, catalog: SkillCatalog): string {
  if (e.skill && catalog.get(e.skill)) return catalog.name(e.skill)
  if (e.status) return t(`skills.status.${e.status}` as StringKey)
  return e.skill ?? t('skills.buff.unknown')
}

/** Three-letter badge when there is no icon. */
function badge(e: EffectState, catalog: SkillCatalog): string {
  return effectName(e, catalog).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || '?'
}

/** The target window's icons for an entity's effects. */
export function targetIcons(list: readonly EffectEntry[], catalog: SkillCatalog, now: number): TargetEffectIcon[] {
  return list.map(({ effect: e, endsAt }) => {
    const name = effectName(e, catalog)
    const left = Number.isFinite(endsAt) ? `  ${formatShort(endsAt - now)}` : ''
    return { icon: e.skill ? catalog.icon(e.skill) : null, short: badge(e, catalog), title: `${name}${left}`, bad: isHarmful(e, catalog) }
  })
}

export interface BuffBarDeps {
  parent: HTMLElement
  catalog: SkillCatalog
  tooltip: Tooltip
  /** Right-click on an own buff: the feature sends buffCancel. */
  cancel: (skill: string) => void
}

/** The retail time gauge under each buff icon (GDR_MSB_*_GAUGE, 20×4). */
const GAUGE_ART = 'icon/stateodd/s_stateodd_time_gauge'

/** Seconds under which a running-out buff blinks. */
const ENDING_MS = 10_000

/**
 * Where each own effect goes on the retail board (GDR_MAGICSTATEBOARD): blessings on row 0, harmful ones on row 1,
 * 21 px apart, at most 10 per row (the rest wait off the board). Pure, for tests.
 */
export function buffSlots(bad: readonly boolean[]): ({ x: number; y: number } | null)[] {
  let good = 0
  let harm = 0
  return bad.map(b => {
    const i = b ? harm++ : good++
    return i < BUFF_MAX ? { x: i * BUFF_PITCH, y: b ? BUFF_ROW : 0 } : null
  })
}

/** The time gauge fill, 1 (full) .. 0 (ran out); toggles stay full. */
export function buffGauge(entry: Pick<EffectEntry, 'endsAt' | 'total'>, now: number): number {
  if (!Number.isFinite(entry.endsAt) || !(entry.total > 0) || !Number.isFinite(entry.total)) return 1
  return Math.max(0, Math.min(1, (entry.endsAt - now) / entry.total))
}

export class BuffBar {
  readonly root: HTMLElement
  private items: { entry: EffectEntry; root: HTMLElement; time: HTMLElement; gauge: HTMLElement }[] = []
  private gaugeUrl: string | null = null
  private readonly ls = new Listeners()
  private hover: EffectEntry | null = null

  constructor(private readonly d: BuffBarDeps) {
    ensureSkillStyles()
    ensureHudStyles()
    this.root = el('div', 'hud-buffs uh-buffs')
    const art = kitArt()
    this.gaugeUrl = art.has(GAUGE_ART) ? art.cssUrl(GAUGE_ART) : null
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    d.parent.append(this.root)
  }

  render(list: readonly EffectEntry[], now: number): void {
    this.ls.clear()
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    const slots = buffSlots(list.map(entry => isHarmful(entry.effect, this.d.catalog)))
    this.items = list.map((entry, n) => {
      const e = entry.effect
      const bad = isHarmful(e, this.d.catalog)
      const cancellable = !bad && !!e.skill
      const ico = el('div', 'ico')
      const url = e.skill ? this.d.catalog.icon(e.skill) : null
      if (url) ico.style.backgroundImage = `url("${url}")`
      else {
        ico.classList.add('fallback')
        ico.textContent = badge(e, this.d.catalog)
      }
      const time = el('div', 'time')
      const gauge = el('div', 'uh-buff-gauge')
      if (this.gaugeUrl) gauge.style.backgroundImage = this.gaugeUrl
      else gauge.classList.add('no-art')
      const root = el('div', `hud-buff${bad ? ' bad' : ''}${cancellable ? ' cancel' : ''}`, ico, gauge, time)
      const at = slots[n]
      if (at) Object.assign(root.style, { left: `${at.x}px`, top: `${at.y}px` })
      else root.hidden = true
      this.ls.on(root, 'pointerenter', ev => this.tip(entry, ev))
      this.ls.on(root, 'pointermove', ev => this.tip(entry, ev))
      this.ls.on(root, 'pointerleave', () => {
        this.hover = null
        this.d.tooltip.hide()
      })
      this.ls.on(root, 'contextmenu', ev => {
        ev.preventDefault()
        if (cancellable) this.d.cancel(e.skill!)
      })
      return { entry, root, time, gauge }
    })
    this.root.replaceChildren(...this.items.map(i => i.root))
    if (this.hover && !list.includes(this.hover)) {
      this.hover = null
      this.d.tooltip.hide()
    }
    this.tick(now)
  }

  /** Updates the countdowns (a few times a second). */
  tick(now: number): void {
    for (const i of this.items) {
      const left = i.entry.endsAt - now
      i.time.textContent = Number.isFinite(left) ? formatShort(left) : ''
      i.gauge.style.clipPath = `inset(0 ${((1 - buffGauge(i.entry, now)) * 100).toFixed(1)}% 0 0)`
      i.root.classList.toggle('ending', Number.isFinite(left) && left < ENDING_MS)
    }
  }

  dispose(): void {
    this.ls.clear()
    this.root.remove()
  }

  private tip(entry: EffectEntry, ev: PointerEvent): void {
    this.hover = entry
    const e = entry.effect
    const { catalog } = this.d
    const lines: TooltipLine[] = [{ text: e.level ? t('skills.tt.title', { name: effectName(e, catalog), level: e.level }) : effectName(e, catalog), cls: 'title' }]
    const left = entry.endsAt - performance.now()
    lines.push({ text: Number.isFinite(left) ? t('skills.buff.left', { time: formatDuration(Math.max(0, left)) }) : t('skills.buff.toggle'), cls: 'stat' })
    const def = e.skill ? catalog.get(e.skill) : undefined
    if (def?.description) lines.push({ text: def.description, cls: 'desc' })
    if (!isHarmful(e, catalog) && e.skill) lines.push({ text: t('skills.buff.cancelHint'), cls: 'hint' })
    this.d.tooltip.show(lines, ev.clientX, ev.clientY)
  }
}
