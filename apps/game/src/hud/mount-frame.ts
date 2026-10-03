/**
 * The horse frame (lane MR-C; docs/SYSTEMS_COMBAT.md §1.5; docs/UI.md §4.6 "Horse/pet frame"): the retail pet mini
 * info GDR_PMI_PET_MINI_INFO in the player frame's pet area (`PlayerFrame.petHost`, M1, 154×40 at (53,55)), drawn
 * from the `window_all` atlas (`ifcommon/wa_pet`) with the ifpetminiinfo.txt rects: picture (4,4,32,32), name
 * (44,7,73,13), level (118,7,34,13) in #FFD953 and the HP gauge `pmi_pet_hp` at (41,23), 112×8 (a horse has no
 * hunger gauge). Under it, two small kit buttons: Ride / Dismount and Dismiss (which asks first; retail has them on
 * the COS command bar, whose icons are not exported). Shown only while you own a horse; the host's `:empty` rule hides
 * the area otherwise.
 */
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place } from '../ui/dom.ts'
import { button, type KitButton } from '../ui/kit/button.ts'
import { fraction, Gauge } from '../ui/kit/gauge.ts'
import { Icon } from '../ui/kit/icon.ts'
import { formatNumber } from './items.ts'

/** What the frame shows. */
export interface MountFrameInfo {
  name: string
  level: number
  hp: number
  maxHp: number
  /** The horse face (`cos.json` icon, 32×32). */
  icon: string | null
  /** You sit on it (the toggle offers Dismount), else it is parked (Ride). */
  mounted: boolean
  dead: boolean
}

export interface MountFrameActions {
  ride(): void
  dismount(): void
  dismiss(): void
}

type Rect = [number, number, number, number]
/** ifpetminiinfo.txt rects, relative to the 154×40 frame. */
export const PET_FRAME = {
  size: [154, 40] as const,
  picture: [4, 4, 32, 32] as Rect,
  name: [44, 7, 73, 13] as Rect,
  level: [118, 7, 34, 13] as Rect,
  hp: [41, 23, 112, 8] as Rect,
  /** The button row under the frame (x of the first button, y). */
  buttons: [41, 42] as const,
}

/** The frame's texts (pure, for tests). */
export function mountFrameText(info: MountFrameInfo): { level: string; hp: string; toggle: string; toggleTip: string } {
  return {
    level: t('mount.frame.level', { level: info.level }),
    hp: info.dead ? t('mount.frame.dead') : t('mount.frame.hp', { hp: formatNumber(Math.max(0, Math.round(info.hp))), max: formatNumber(Math.round(info.maxHp)) }),
    toggle: info.mounted ? t('mount.frame.dismount') : t('mount.frame.ride'),
    toggleTip: info.mounted ? t('mount.frame.dismountTip') : t('mount.frame.rideTip'),
  }
}

const CSS = `
.mr-pet { position: absolute; left: 0; top: 0; width: 154px; height: 40px; background-repeat: no-repeat; }
.mr-pet.no-art { background: rgba(12, 10, 8, 0.8); border: 1px solid var(--c-rim); border-radius: 20px 4px 4px 20px; box-sizing: border-box; }
.mr-pet .mr-pet-face { border-radius: 50%; background-size: 100% 100%; }
.mr-pet .mr-pet-name { font: 11px/13px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mr-pet .mr-pet-level { font: 11px/13px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); white-space: nowrap; }
.mr-pet.dead .mr-pet-face { filter: grayscale(1) brightness(0.6); }
.mr-pet.dead .mr-pet-name { color: var(--c-hint); }
.mr-pet .mr-pet-buttons { position: absolute; display: flex; gap: 2px; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'mount-frame'
  s.textContent = CSS
  document.head.append(s)
}

export class MountFrame {
  readonly root: HTMLElement
  private readonly face: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly levelEl: HTMLElement
  private readonly hp: Gauge
  readonly toggle: KitButton
  readonly dismiss: KitButton
  private info: MountFrameInfo | null = null
  private host: HTMLElement | null = null
  private icon: string | null | undefined

  constructor(art: Art, private readonly actions: MountFrameActions) {
    ensureStyles()
    this.root = el('div', 'mr-pet')
    if (art.has('ifcommon/wa_pet')) this.root.style.backgroundImage = art.cssUrl('ifcommon/wa_pet')
    else this.root.classList.add('no-art')
    this.face = place(el('div', 'mr-pet-face'), PET_FRAME.picture)
    this.nameEl = place(el('div', 'mr-pet-name'), PET_FRAME.name)
    this.levelEl = place(el('div', 'mr-pet-level'), PET_FRAME.level)
    this.hp = new Gauge(art, 'petHp', { w: PET_FRAME.hp[2], h: PET_FRAME.hp[3], color: 'var(--c-hp)', className: 'mr-pet-hp' })
    place(this.hp.root, PET_FRAME.hp)
    this.toggle = button(art, { label: t('mount.frame.ride'), skin: 'tiny' }, () => (this.info?.mounted ? this.actions.dismount() : this.actions.ride()))
    this.dismiss = button(art, { label: t('mount.frame.dismiss'), skin: 'tiny', title: t('mount.frame.dismissTip') }, () => this.actions.dismiss())
    const row = el('div', 'mr-pet-buttons', this.toggle, this.dismiss)
    Object.assign(row.style, { left: `${PET_FRAME.buttons[0]}px`, top: `${PET_FRAME.buttons[1]}px` })
    this.root.append(this.face, this.nameEl, this.levelEl, this.hp.root, row)
    // The player frame already keeps presses away from the world; the frame can also live elsewhere (the gallery).
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
  }

  /** Where the frame shows (PlayerFrame.petHost); null takes it out. */
  attach(host: HTMLElement | null): void {
    this.host = host
    this.place()
  }

  get visible(): boolean {
    return this.info !== null && this.root.parentElement !== null
  }

  /** The horse to show, or null (no horse: the frame leaves the host). */
  set(info: MountFrameInfo | null): void {
    this.info = info
    if (info) {
      const text = mountFrameText(info)
      if (this.icon !== info.icon) {
        this.icon = info.icon
        this.face.replaceChildren(Icon(info.icon, { size: PET_FRAME.picture[2], name: info.name, className: 'mr-pet-icon' }))
      }
      this.nameEl.textContent = info.name
      this.nameEl.title = info.name
      this.levelEl.textContent = text.level
      this.hp.set(info.dead ? 0 : info.hp, info.maxHp)
      this.hp.root.title = text.hp
      this.face.title = `${info.name}\n${text.hp}`
      this.toggle.setLabel(text.toggle)
      this.toggle.title = text.toggleTip
      this.toggle.setDisabled(info.dead)
      this.dismiss.setDisabled(false)
      this.root.classList.toggle('dead', info.dead)
      this.root.classList.toggle('low-hp', !info.dead && fraction(info.hp, info.maxHp) < 0.25)
    }
    this.place()
  }

  private place(): void {
    const want = this.info ? this.host : null
    if (want && this.root.parentElement !== want) want.append(this.root)
    else if (!want && this.root.parentElement) this.root.remove()
  }

  dispose(): void {
    this.info = null
    this.root.remove()
  }
}
