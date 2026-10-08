/**
 * Target window (top centre, docs/UI.md §2.5, §2.7): the 2009 (`UI_UPDATE_2009_FIRST`) 236-px windows of the
 * `window_all` atlas, with the iftw_*.txt rects:
 *   - monster: the 236×51 plate with the HP groove (atlas 741,321; GDR_TW_COMMONENEMY's rect is 236×51 and its gauge
 *     sits at (14,37), i.e. in this plate's groove), gem (8,5,20,20), name (34,10,170,12) centred, HP `tw_hp` in the
 *     groove;
 *   - special monster (champion, giant, titan, elite, unique): `wa_tw_special` 236×78 with the level box
 *     (10,56,30,16), the variant icon `tw_icon_*` (65,54,16,16) and its name (85,56,168,12);
 *   - player / NPC: `wa_tw_player` 236×35, gem and name only (retail shows no HP for them).
 * Name colours: monsters by level band (docs/UX_GAPS.md H4), uniques pink, players light blue, NPCs green.
 * M3 (decision D15): actions (Invite, Exchange, Guild invite) are small kit buttons INSIDE the name strip, from a
 * registry (`addAction`); `setActions` stays as a deprecated alias that replaces only its own list.
 */
import type { MobVariant } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place } from '../ui/dom.ts'
import { button, type KitButton } from '../ui/kit/button.ts'
import type { CursorKind } from '../ui/kit/cursor.ts'
import { LEVEL_BAND_COLOR, LEVEL_BAND_GEM, type LevelBand } from '../world/level-band.ts'
import { ensureHudStyles } from './hud-style.ts'
import { formatNumber } from './items.ts'

export interface TargetInfo {
  id: number
  name: string
  level: number
  hp: number
  maxHp: number
  kind: 'mob' | 'player' | 'npc'
  /** Mobs: level difference to us, for the gem and the name colour (docs/UX_GAPS.md H4, §4.2). */
  band?: LevelBand
  /** Mobs: champion, giant, titan, elite, unique show their tw_icon_* ('normal' and 'party' show none). */
  variant?: MobVariant
  /** Players in the Hunter / Wanted fight (docs/SIEGE.md §8.3: Wanted, or a Hunter on duty): the enemy window with HP. */
  hostile?: boolean
}

/**
 * A button in the target window (PT-C: Invite on player targets; TR-C / GU-C: Exchange, Guild invite). `show` decides
 * per target whether it appears; `run` gets the target it was pressed for.
 */
export interface TargetAction {
  id: string
  label: string
  title?: string
  show(target: TargetInfo): boolean
  run(target: TargetInfo): void
}

/** One effect icon of the target window (SK-C). */
export interface TargetEffectIcon {
  icon: string | null
  /** Text badge when there is no icon. */
  short: string
  title: string
  bad?: boolean
}

export type TargetVariant = 'enemy' | 'special' | 'player'

const SPECIAL: ReadonlySet<MobVariant> = new Set(['champion', 'giant', 'titan', 'elite', 'unique'])

/** Which 2009 window a target uses (pure, for tests). */
export function targetVariant(tgt: Pick<TargetInfo, 'kind' | 'variant' | 'hostile'>): TargetVariant {
  if (tgt.kind !== 'mob') return tgt.kind === 'player' && tgt.hostile ? 'enemy' : 'player'
  return tgt.variant && SPECIAL.has(tgt.variant) ? 'special' : 'enemy'
}

/** Window sizes and the HP groove per variant (native px, measured on the atlas). */
export const TARGET_SIZES: Record<TargetVariant, { w: number; h: number; hp: [number, number, number, number] | null }> = {
  enemy: { w: 236, h: 51, hp: [13, 37, 196, 4] },
  special: { w: 236, h: 78, hp: [13, 37, 208, 4] },
  player: { w: 236, h: 35, hp: null },
}

/** The atlas rect of the monster plate (not one of UI-X's crops: drawn from `ifcommon/window_all`). */
const ENEMY_ATLAS = { x: 741, y: 321 }

/** The small `com_s_button` for the in-strip actions, grown to fit its label (min 32 px). */
const ACTION_SKIN = { key: 'ifcommon/com_s_button', w: 32, h: 20, slice: 5 }

const GEMS: Record<TargetInfo['kind'], string> = {
  mob: 'targetwindow/tw_gem_normal',
  player: 'targetwindow/tw_gem_player',
  npc: 'targetwindow/tw_gem_npc',
}

/** The registry behind M3: several features' actions side by side; `legacy` is the setActions list. */
export class TargetActions {
  private readonly list: { a: TargetAction; key: string }[] = []

  add(a: TargetAction, key = a.id): () => void {
    const item = { a, key }
    this.list.push(item)
    return () => {
      const i = this.list.indexOf(item)
      if (i >= 0) this.list.splice(i, 1)
    }
  }

  /** Replaces every action registered under `key` (the deprecated setActions path). */
  replace(key: string, actions: readonly TargetAction[]): void {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.key === key) this.list.splice(i, 1)
    for (const a of actions) this.list.push({ a, key })
  }

  get all(): TargetAction[] {
    return this.list.map(x => x.a)
  }

  /** The actions to show for a target (a throwing `show` hides only that action). */
  visible(tgt: TargetInfo | null): TargetAction[] {
    if (!tgt) return []
    return this.all.filter(a => {
      try {
        return a.show(tgt)
      } catch (err) {
        console.error(`[hud] target action ${a.id} failed`, err)
        return false
      }
    })
  }
}

export class TargetFrame {
  readonly root: HTMLElement
  private readonly gem: HTMLElement
  private readonly strip: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly levelEl: HTMLElement
  private readonly bar: HTMLElement
  private readonly fill: HTMLElement
  private readonly specialLevel: HTMLElement
  private readonly specialIcon: HTMLElement
  private readonly specialText: HTMLElement
  private readonly effects: HTMLElement
  private readonly actionsEl: HTMLElement
  readonly actions = new TargetActions()
  private buttons = new Map<TargetAction, KitButton>()
  private shown = ''
  private current: TargetInfo | null = null
  private variant: TargetVariant | null = null

  constructor(private readonly art: Art) {
    ensureHudStyles()
    this.root = el('div', 'uh-tw hud-block')
    this.root.hidden = true
    this.gem = place(el('div', 'uh-tw-gem'), [8, 5, 20, 20])
    this.nameEl = el('div', 'uh-tw-name')
    this.levelEl = el('div', 'uh-tw-level')
    this.actionsEl = el('div', 'uh-tw-actions')
    this.actionsEl.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.strip = place(el('div', 'uh-tw-strip', this.nameEl, this.levelEl, this.actionsEl), [34, 5, 176, 22])
    this.fill = el('div', 'uh-tw-fill')
    if (art.has('targetwindow/tw_hp')) this.fill.style.backgroundImage = art.cssUrl('targetwindow/tw_hp')
    else this.fill.classList.add('no-art')
    this.bar = el('div', 'uh-tw-bar', this.fill)
    this.specialLevel = place(el('div', 'uh-tw-slevel'), [10, 56, 30, 16])
    this.specialIcon = place(el('div', 'uh-tw-sicon'), [65, 54, 16, 16])
    this.specialText = place(el('div', 'uh-tw-stext'), [85, 56, 140, 12])
    // SK-C: the target's buffs and statuses under the window (setEffects; GDR_TW_BUFF).
    this.effects = el('div', 'hud-target-effects uh-tw-effects')
    this.root.append(this.gem, this.strip, this.bar, this.specialLevel, this.specialIcon, this.specialText, this.effects)
  }

  /** M3: adds an action beside the others; returns its remove function. */
  addAction(a: TargetAction): () => void {
    const off = this.actions.add(a)
    this.syncActions()
    return () => {
      off()
      this.syncActions()
    }
  }

  /** Deprecated (one wave): replaces the actions set through this call only; addAction's stay. */
  setActions(list: readonly TargetAction[]): void {
    this.actions.replace('legacy:setActions', list)
    this.syncActions()
  }

  /** Re-asks every action's `show` for the current target (a feature's condition changed). */
  refreshActions(): void {
    this.shown = ''
    this.syncActions()
  }

  private syncActions(): void {
    const vis = this.actions.visible(this.current)
    const key = vis.map(a => `${a.id}:${a.label}`).join('|')
    if (key === this.shown && vis.every(a => this.buttons.has(a))) return
    this.shown = key
    const keep = new Map<TargetAction, KitButton>()
    const buttons = vis.map(a => {
      let b = this.buttons.get(a)
      if (!b) {
        b = button(this.art, { label: a.label, skin: ACTION_SKIN, title: a.title, className: 'uh-tw-action' }, ev => {
          ev.stopPropagation()
          if (this.current) a.run(this.current)
        })
        b.dataset.action = a.id
      } else if (b.textContent !== a.label) b.setLabel(a.label)
      keep.set(a, b)
      return b
    })
    this.buttons = keep
    this.actionsEl.replaceChildren(...buttons)
  }

  /** SK-C (docs/SKILLS.md §10.3): the target's effects as small icons (an icon URL, or a short text badge). */
  setEffects(list: readonly TargetEffectIcon[]): void {
    this.effects.replaceChildren(
      ...list.map(e => {
        const d = el('div', `fx${e.bad ? ' bad' : ''}${e.icon ? '' : ' fallback'}`, e.icon ? '' : e.short)
        if (e.icon) d.style.backgroundImage = `url("${e.icon}")`
        d.title = e.title
        return d
      }),
    )
  }

  private setVariant(v: TargetVariant): void {
    if (this.variant === v) return
    this.variant = v
    const size = TARGET_SIZES[v]
    this.root.dataset.variant = v
    Object.assign(this.root.style, { width: `${size.w}px`, height: `${size.h}px` })
    const s = this.root.style
    if (v === 'enemy' && this.art.has('ifcommon/window_all')) {
      s.backgroundImage = this.art.cssUrl('ifcommon/window_all')
      s.backgroundPosition = `-${ENEMY_ATLAS.x}px -${ENEMY_ATLAS.y}px`
      s.backgroundSize = '1024px 512px'
    } else {
      const key = v === 'special' ? 'ifcommon/wa_tw_special' : v === 'enemy' ? 'ifcommon/wa_tw_special' : 'ifcommon/wa_tw_player'
      s.backgroundPosition = '0 0'
      s.backgroundSize = '100% auto'
      s.backgroundImage = this.art.has(key) ? this.art.cssUrl(key) : ''
      this.root.classList.toggle('no-art', !this.art.has(key))
    }
    if (size.hp) place(this.bar, size.hp)
    this.bar.hidden = !size.hp
    this.specialLevel.hidden = this.specialIcon.hidden = this.specialText.hidden = v !== 'special'
    this.effects.style.top = `${size.h + 2}px`
  }

  set(target: TargetInfo | null): void {
    this.current = target
    this.syncActions()
    if (!target) {
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    this.root.dataset.kind = target.kind
    const v = targetVariant(target)
    this.setVariant(v)
    const gem = target.kind === 'mob' && target.band ? LEVEL_BAND_GEM[target.band] : GEMS[target.kind]
    this.gem.style.backgroundImage = this.art.has(gem) ? this.art.cssUrl(gem) : ''
    if (this.nameEl.textContent !== target.name) this.nameEl.textContent = target.name
    this.nameEl.title = target.kind === 'player' && target.level > 0 ? `${target.name}  ${t('hud.target.level', { level: target.level })}` : target.name
    // Retail shows the level only for monsters (the special window has its own level box); players show just the name.
    const lv = target.kind !== 'mob' || target.level <= 0 ? '' : t('hud.target.level', { level: target.level })
    this.levelEl.textContent = v === 'special' ? '' : lv
    const dead = target.kind !== 'npc' && target.maxHp > 0 && target.hp <= 0
    this.root.classList.toggle('dead', dead)
    this.nameEl.style.color = dead || target.kind !== 'mob' ? '' : target.variant === 'unique' ? 'var(--c-unique, #ff9cf0)' : target.band ? LEVEL_BAND_COLOR[target.band] : ''
    if (v === 'special') {
      this.specialLevel.textContent = target.level > 0 ? String(target.level) : ''
      const iconKey = `targetwindow/tw_icon_${target.variant}`
      this.specialIcon.style.backgroundImage = this.art.has(iconKey) ? this.art.cssUrl(iconKey) : ''
      this.specialText.textContent = t(`world.variant.${target.variant}` as StringKey)
    }
    const f = target.maxHp > 0 ? Math.max(0, Math.min(1, target.hp / target.maxHp)) : 0
    this.fill.style.clipPath = `inset(0 ${((1 - f) * 100).toFixed(2)}% 0 0)`
    this.root.title = dead ? t('hud.target.dead') : target.maxHp > 0 && target.kind === 'mob' ? t('hud.target.hp', { hp: formatNumber(target.hp), max: formatNumber(target.maxHp) }) : ''
  }

  get target(): TargetInfo | null {
    return this.current
  }
}

/**
 * The kit cursor for what is under the pointer (docs/UI.md §4.10): a living monster → attack, an NPC → talk, a
 * ground item → pick-up, anything else (players, corpses, the ground) → the normal flame hand.
 */
export function cursorFor(v: { kind: string; dead?: boolean; own?: boolean } | null): CursorKind {
  if (!v) return 'normal'
  if (v.kind === 'mob') return v.dead ? 'normal' : 'attack'
  if (v.kind === 'npc') return 'talk'
  // Wave 8 (MR-C, I8): your own live parked horse takes the talk hand (a click rides it; HorseView.own).
  if (v.kind === 'cos') return v.own && !v.dead ? 'talk' : 'normal'
  if (v.kind === 'item') return 'pickup'
  return 'normal'
}
