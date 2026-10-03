/**
 * Own-character HUD: the 2009 player frame GDR_PLAYER_MINI_INFO drawn from the `window_all` atlas (`ifcommon/wa_pmi`,
 * 212×70) with the ifplayerminiinfo.txt rects: portrait (15,7,48,48), name (71,4,93,15), level (168,7,37,15) in
 * #FFD953, HP (79,25,124,12) and MP (79,41,124,12) gauges with their numbers, the stat-point + (150,3,16,16), the
 * character-info button (41,56,20,20) and the race mark (53,41,24,24). The EXP / SP part lives in hud/underbar.ts.
 * Wave-8 mount points (decision D17, M1): `berserkHost` (the five orbs, button and glows, filled by hud/berserk.ts)
 * and `petHost` at (53,55,154,40) (the horse frame, hud/mount-frame.ts). Both are empty and invisible until used.
 * Low HP (docs/UX_GAPS.md H7): below 25% the HP gauge pulses and a red vignette pulses at the screen edges.
 */
import { PLAYER_MODELS_CH, type PlayerStats } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place } from '../ui/dom.ts'
import { iconButton, type KitButton } from '../ui/kit/button.ts'
import { BERSERK_HOST, PET_HOST, PLAYER_FRAME } from './hud-layout.ts'
import { ensureHudStyles } from './hud-style.ts'
import { formatNumber } from './items.ts'
import { ensureUxStyles } from './ux-style.ts'

/** HP fraction below which the low-HP warning shows (H7). */
export const LOW_HP = 0.25

/** Low-HP warning: alive and below LOW_HP of max HP. */
export function lowHp(hp: number, maxHp: number): boolean {
  return maxHp > 0 && hp > 0 && hp / maxHp < LOW_HP
}

/**
 * The client's character portraits are interface/character/char_ch_{man|woman}<n>, numbered in characterdata
 * order within each gender, which is the order of PLAYER_MODELS_CH (checked: man6 is the monkey mask).
 */
export function portraitKey(model: string): string | null {
  const male = PLAYER_MODELS_CH.filter(c => c.startsWith('CHAR_CH_MAN_'))
  const female = PLAYER_MODELS_CH.filter(c => c.startsWith('CHAR_CH_WOMAN_'))
  const m = male.indexOf(model)
  if (m >= 0) return `character/char_ch_man${m + 1}`
  const f = female.indexOf(model)
  if (f >= 0) return `character/char_ch_woman${f + 1}`
  return null
}

/** EXP percentage with two decimals, as the client shows it; null at the level cap. */
export function expPercent(exp: number, expToNext: number): number | null {
  if (!(expToNext > 0)) return null
  return Math.max(0, Math.min(100, Math.floor((10000 * exp) / expToNext) / 100))
}

/** SP-EXP gauge fill, 0..1 (SP-EXP towards the next skill point out of `spExpPerSp`, 400 in SRO). */
export function spExpFraction(spExp: number, spExpPerSp: number): number {
  return spExpPerSp > 0 ? Math.max(0, Math.min(1, spExp / spExpPerSp)) : 0
}

/** Tooltip of the SP-EXP gauge, as SRO: "SP EXP 192 / 400" and, on a second line, the skill points owned. */
export function spExpTooltip(spExp: number, spExpPerSp: number, sp: number): string {
  return `${t('hud.spExp', { value: formatNumber(spExp), max: formatNumber(spExpPerSp) })}\n${t('hud.spOwned', { sp: formatNumber(sp) })}`
}

/**
 * Skill points gained between two stat snapshots (0 on the first snapshot, or when SP went down: a skill was learned).
 * Kills and quests raise SP through statsDelta, GM setlevel through stats.
 */
export function spGained(before: number | undefined, after: number): number {
  return before === undefined ? 0 : Math.max(0, after - before)
}

/** The chat/system line for skill points gained (`total` = skill points owned now). */
export function spGainedText(sp: number, total: number): string {
  return sp === 1 ? t('hud.spGainedChatOne', { total: formatNumber(total) }) : t('hud.spGainedChat', { sp: formatNumber(sp), total: formatNumber(total) })
}

/** A gauge drawn with the retail fill art at native size, clipped (never stretched) by the value. */
class Bar {
  readonly root: HTMLElement
  private readonly fill: HTMLElement
  readonly text: HTMLElement

  constructor(art: Art, key: string, className: string) {
    this.fill = el('div', 'uh-bar-fill')
    if (art.has(key)) this.fill.style.backgroundImage = art.cssUrl(key)
    else this.fill.classList.add('no-art')
    this.text = el('span', 'uh-bar-text')
    this.root = el('div', `uh-bar ${className}`, this.fill, this.text)
  }

  set(value: number, max: number, label?: string): void {
    const f = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
    this.fill.style.clipPath = `inset(0 ${((1 - f) * 100).toFixed(2)}% 0 0)`
    this.text.textContent = label ?? t('hud.gauge', { value: formatNumber(value), max: formatNumber(max) })
  }
}

export class PlayerFrame {
  readonly root: HTMLElement
  private readonly face: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly levelEl: HTMLElement
  private readonly hp: Bar
  private readonly mp: Bar
  readonly plus: KitButton
  /** M1: the Berserk orbs, button and glows (hud-layout BERSERK_HOST / BERSERK_ORBS, frame-relative). */
  readonly berserkHost: HTMLElement
  /** M1: the horse / pet mini frame at (53,55,154,40); hidden while empty. */
  readonly petHost: HTMLElement
  /** Full-screen red edge pulse (H7), placed beside the frame in the HUD root the first time it is needed. */
  private readonly vignette: HTMLElement

  constructor(private readonly art: Art, onPlus: () => void) {
    ensureUxStyles()
    ensureHudStyles()
    this.vignette = el('div', 'hud-lowhp-vignette')
    this.root = el('div', 'uh-pf hud-block')
    Object.assign(this.root.style, { width: `${PLAYER_FRAME.w}px`, height: `${PLAYER_FRAME.h}px` })
    if (art.has('ifcommon/wa_pmi')) this.root.style.backgroundImage = art.cssUrl('ifcommon/wa_pmi')
    else if (art.has('playerminiinfo/pmi_window')) this.root.style.backgroundImage = art.cssUrl('playerminiinfo/pmi_window')
    else this.root.classList.add('no-art')
    this.face = place(el('div', 'uh-pf-face'), [15, 7, 48, 48])
    this.nameEl = place(el('div', 'uh-pf-name kit-t-value'), [71, 4, 93, 15])
    this.levelEl = place(el('div', 'uh-pf-level'), [168, 7, 37, 15])
    this.hp = new Bar(art, 'playerminiinfo/pmi_hp', 'uh-pf-hp')
    this.mp = new Bar(art, 'playerminiinfo/pmi_mp', 'uh-pf-mp')
    place(this.hp.root, [79, 25, 124, 12])
    place(this.mp.root, [79, 41, 124, 12])
    // GDR_PMI_EFFECT_HP: the retail low-HP glow sweeping over the HP gauge (8 frames of 128×32, additive).
    const caution = place(el('div', 'uh-pf-caution'), [75, 25, 128, 32])
    if (art.has('playerminiinfo/pmi_hp_cha_effect_caution')) caution.style.backgroundImage = art.cssUrl('playerminiinfo/pmi_hp_cha_effect_caution')
    const race = place(el('div', 'uh-pf-race'), [53, 41, 24, 24])
    if (art.has('ifcommon/com_kindred_china')) race.style.backgroundImage = art.cssUrl('ifcommon/com_kindred_china')
    race.title = t('uh.race.china')
    const plusKey = art.has('ifcommon/com_plus_smallbutton') ? 'ifcommon/com_plus_smallbutton' : 'ifcommon/com_plus_button'
    this.plus = iconButton(art, plusKey, { w: 16, h: 16, fallbackText: '+', className: 'uh-pf-plus' }, onPlus)
    place(this.plus, [150, 3, 16, 16])
    this.plus.hidden = true
    const info = iconButton(art, 'playerminiinfo/pmi_button', { title: t('keys.window.character'), fallbackText: 'i', className: 'uh-pf-info' }, onPlus)
    place(info, [41, 56, 20, 20])
    this.berserkHost = el('div', 'uh-pf-berserk')
    place(this.berserkHost, [BERSERK_HOST.x, BERSERK_HOST.y, BERSERK_HOST.w, BERSERK_HOST.h])
    this.petHost = el('div', 'uh-pf-pet')
    place(this.petHost, [PET_HOST.x, PET_HOST.y, PET_HOST.w, PET_HOST.h])
    this.root.append(this.face, race, this.nameEl, this.levelEl, this.hp.root, this.mp.root, caution, this.petHost, this.berserkHost, info, this.plus)
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
  }

  setIdentity(name: string, model: string | null): void {
    this.nameEl.textContent = name
    this.nameEl.title = name
    const key = model ? portraitKey(model) : null
    if (key && this.art.has(key)) {
      this.face.style.backgroundImage = this.art.cssUrl(key)
      this.face.classList.add('portrait')
    } else if (this.art.has('playerminiinfo/pmi_face')) {
      this.face.style.backgroundImage = this.art.cssUrl('playerminiinfo/pmi_face')
    }
  }

  setStats(s: PlayerStats): void {
    this.levelEl.textContent = t('hud.level', { level: s.level })
    this.hp.set(s.hp, s.maxHp)
    this.mp.set(s.mp, s.maxMp)
    this.plus.hidden = s.statPoints <= 0
    this.plus.title = t('hud.statPoints', { points: s.statPoints })
    this.root.classList.toggle('has-plus', s.statPoints > 0)
    const low = lowHp(s.hp, s.maxHp)
    this.root.classList.toggle('low-hp', low)
    this.root.classList.toggle('dead', s.hp <= 0)
    // The vignette covers the whole screen, so it lives in the HUD root, not in the frame.
    if (low && !this.vignette.isConnected && this.root.parentElement) this.root.parentElement.prepend(this.vignette)
    this.vignette.classList.toggle('on', low)
  }
}
