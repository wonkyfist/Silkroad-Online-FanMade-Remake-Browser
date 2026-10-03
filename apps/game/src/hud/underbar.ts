/**
 * The 2009 underbar (docs/UI.md §4.5): one 800×68 `ub_new_mainbar2` bar at the bottom centre with
 *   - the level box and the SP field (skill points, EXP %) with the SP-EXP gauge in the left box,
 *   - the 10-segment EXP band along the bottom (`ub_new_exp_bar`, segment i fills clamp(f·10 − i, 0, 1)),
 *   - the quick slots, page arrows and page digit: the Hotbar mounts into `slots` (hud/hotbar.ts underbar mode),
 *   - the right panel's round Character / Inventory / Skill buttons and the MENU tab + popup (hud/menubar.ts),
 *   - the side decorations `ub_new_deco_left/right` (hidden on narrow screens).
 * Rects: hud/underbar-layout.ts (measured on the art). It replaces the old ExpBar, the hotbar box and the menu row.
 */
import type { PlayerStats } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { placeAt } from './hud-layout.ts'
import { ensureHudStyles } from './hud-style.ts'
import { formatNumber } from './items.ts'
import type { MenuBar } from './menubar.ts'
import { expPercent, spExpFraction, spExpTooltip } from './player.ts'
import { EXP_BAND, expSegmentRect, expSegments, GAINS, LEVEL_BOX, MENU_TAB, SP_GAUGE, SP_TEXT } from './underbar-layout.ts'

/** Fill fraction as a right-hand clip (the art is never stretched). */
function clip(f: number): string {
  return `inset(0 ${((1 - Math.min(1, Math.max(0, f))) * 100).toFixed(2)}% 0 0)`
}

export class Underbar {
  readonly root: HTMLElement
  /** The host of the quick slots (the Hotbar's parent): covers the bar, native px of the bar art. */
  readonly slots: HTMLElement
  private readonly decoLeft: HTMLElement
  private readonly decoRight: HTMLElement
  private readonly band: HTMLElement
  private readonly segs: HTMLElement[] = []
  private readonly bandText: HTMLElement
  private readonly spFill: HTMLElement
  private readonly spWell: HTMLElement
  private readonly levelEl: HTMLElement
  private readonly spValue: HTMLElement
  private readonly expValue: HTMLElement
  private readonly field: HTMLElement
  private readonly gains: HTMLElement

  constructor(art: Art, menubar: MenuBar) {
    ensureHudStyles()
    const bar = art.has('underbar/ub_new_mainbar2') || art.hasCropped('underbar/ub_new_mainbar2') ? 'underbar/ub_new_mainbar2' : null
    this.root = el('div', 'uh-ub hud-block')
    if (bar) this.root.style.backgroundImage = art.cssUrl(bar)
    else this.root.classList.add('no-art')
    this.decoLeft = art.image('underbar/ub_new_deco_left', 'uh-ub-deco left')
    this.decoRight = art.image('underbar/ub_new_deco_right', 'uh-ub-deco right')
    // EXP band.
    this.band = el('div', 'uh-ub-band')
    for (let i = 0; i < EXP_BAND.n; i++) {
      const s = el('div', 'uh-ub-seg')
      const r = expSegmentRect(i)
      placeAt(s, { ...r, x: r.x - EXP_BAND.x0, y: 0 }, true)
      if (art.has('underbar/ub_new_exp_bar')) s.style.backgroundImage = art.cssUrl('underbar/ub_new_exp_bar')
      else s.classList.add('no-art')
      this.segs.push(s)
      this.band.append(s)
    }
    this.bandText = el('div', 'uh-ub-band-text kit-t-gauge')
    this.band.append(this.bandText)
    placeAt(this.band, { x: EXP_BAND.x0, y: EXP_BAND.y, w: EXP_BAND.pitch * (EXP_BAND.n - 1) + EXP_BAND.w, h: EXP_BAND.h }, true)
    // SP-EXP gauge in the left box's thin well.
    this.spFill = el('div', 'uh-ub-sp-fill')
    if (art.has('underbar/ub_new_sp_bar')) this.spFill.style.backgroundImage = art.cssUrl('underbar/ub_new_sp_bar')
    else this.spFill.classList.add('no-art')
    this.spWell = el('div', 'uh-ub-sp', this.spFill)
    placeAt(this.spWell, SP_GAUGE, true)
    // The lower field: "SP 1,234" and "EXP 12.34%".
    this.spValue = el('span', 'uh-ub-spv')
    this.expValue = el('span', 'uh-ub-expv')
    this.field = el('div', 'uh-ub-field', el('span', 'uh-ub-lbl', t('hud.sp')), this.spValue, el('span', 'uh-ub-gap'), el('span', 'uh-ub-lbl', t('hud.exp')), this.expValue)
    placeAt(this.field, SP_TEXT, true)
    this.levelEl = el('div', 'uh-ub-level')
    placeAt(this.levelEl, LEVEL_BOX, true)
    this.gains = el('div', 'uh-ub-gains')
    placeAt(this.gains, GAINS, true)
    // Quick-slot host (the Hotbar places its cells, arrows and page digit at the bar's rects).
    this.slots = el('div', 'uh-ub-slots')
    this.slots.dataset.underbar = '1'
    // Right panel (its round buttons carry bar coordinates, see PANEL_BUTTONS) + MENU tab + popup.
    placeAt(menubar.tab, MENU_TAB)
    this.root.append(this.decoLeft, this.decoRight, this.band, this.spWell, this.field, this.levelEl, this.slots, menubar.panel, menubar.tab, menubar.root, this.gains)
    this.root.addEventListener('contextmenu', ev => ev.preventDefault())
  }

  /** The side decorations need 952 native px (hud-layout DECO_MIN_W). */
  setDecorations(on: boolean): void {
    this.decoLeft.hidden = this.decoRight.hidden = !on
  }

  setStats(s: PlayerStats, spExpPerSp: number): void {
    this.levelEl.textContent = String(s.level)
    const pct = expPercent(s.exp, s.expToNext)
    const fills = expSegments(pct ?? 100)
    this.segs.forEach((e, i) => (e.style.clipPath = clip(fills[i]!)))
    const pctText = pct === null ? t('hud.expMax') : `${pct.toFixed(2)}%`
    this.bandText.textContent = pct === null ? t('hud.expMax') : t('hud.expValue', { pct: pct.toFixed(2), exp: formatNumber(s.exp), next: formatNumber(s.expToNext) })
    this.expValue.textContent = pctText
    this.spValue.textContent = formatNumber(s.sp)
    this.spFill.style.clipPath = clip(spExpFraction(s.spExp, spExpPerSp))
    const spTip = spExpTooltip(s.spExp, spExpPerSp, s.sp)
    this.spWell.title = this.field.title = spTip
    const lvTip = `${t('hud.level', { level: s.level })}\n${t('hud.exp')} ${pct === null ? t('hud.expMax') : t('hud.expValue', { pct: pct.toFixed(2), exp: formatNumber(s.exp), next: formatNumber(s.expToNext) })}`
    this.levelEl.title = this.band.title = lvTip
  }

  /** "+120 EXP" rising from the left box after a kill. */
  gain(exp: number, sp: number): void {
    const parts = [exp > 0 ? t('hud.gainExp', { exp: formatNumber(exp) }) : '', sp > 0 ? t('hud.gainSp', { sp: formatNumber(sp) }) : ''].filter(Boolean)
    if (!parts.length) return
    const g = el('div', 'uh-ub-gain', parts.join('   '))
    this.gains.append(g)
    setTimeout(() => g.remove(), 2200)
  }

  /** "+1 SP" when SP-EXP rolled over into skill points (or a GM/quest granted some); the SP number flashes. */
  spGain(sp: number): void {
    if (!(sp > 0)) return
    const g = el('div', 'uh-ub-gain sp', t('hud.gainSpPoints', { sp: formatNumber(sp) }))
    this.gains.append(g)
    this.spValue.classList.remove('flash')
    void this.spValue.offsetWidth
    this.spValue.classList.add('flash')
    setTimeout(() => g.remove(), 2600)
  }

  dispose(): void {
    this.root.remove()
  }
}
