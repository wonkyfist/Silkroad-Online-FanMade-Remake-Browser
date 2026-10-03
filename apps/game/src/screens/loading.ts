/**
 * Loading screen: a full-screen original loading picture with the loading_form frame and gauge_loading bar
 * (layout from Media/resinfo/pscharacterselect.txt: GDR_LOADINGFRAME 1121x64, GDR_LOADINGG, GDR_LOADING_STA).
 * The "Now Loading" caption is live text (the nowloading art reads "Dang tai..." in the Vietnamese client).
 * Under the bar a tip rotates every few seconds (docs/UX_GAPS.md L5).
 */
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, type Rect } from '../ui/dom.ts'
import { ensureUxStyles } from '../hud/ux-style.ts'

/** A loading picture; `crop` (x, y, w, h in texels) shows only that part, e.g. to leave out a baked-in logo. */
export interface LoadingPicture {
  key: string
  crop?: Rect
}

export const LOADING_PICTURES = {
  /** Dragon medallion and silhouettes; no text. */
  characters: { key: 'loading/loading_charactercustom' },
  /**
   * The Jangan palace band (1024x768 picture, band at y 183-505). The Vietnamese logo sits at the band's
   * bottom right (x 770-993, y 420-482), so only x < 752 is shown: a wide strip with its right edge faded.
   */
  jangan: { key: 'loading/loading_zangan', crop: [0, 176, 752, 336] },
} satisfies Record<string, LoadingPicture>

function showPicture(art: Art, pic: HTMLElement, picture: LoadingPicture): void {
  if (!picture.crop) {
    if (art.has(picture.key)) pic.style.backgroundImage = art.cssUrl(picture.key)
    return
  }
  const size = art.size(picture.key)
  if (!size || !art.hasCropped(picture.key)) return
  const [x, y, w, h] = picture.crop
  const [iw, ih] = size
  pic.classList.add('cropped')
  pic.style.backgroundImage = art.cssUrl(picture.key)
  pic.style.setProperty('--aspect', `${w} / ${h}`)
  pic.style.setProperty('--ratio', String(w / h))
  pic.style.backgroundSize = `${(iw / w) * 100}% ${(ih / h) * 100}%`
  pic.style.backgroundPosition = `${iw === w ? 0 : (x / (iw - w)) * 100}% ${ih === h ? 0 : (y / (ih - h)) * 100}%`
}

/** Loading-screen tips (L5), i18n keys in en-ux.ts. */
export const LOADING_TIPS: readonly StringKey[] = [
  'loading.tip.keys',
  'loading.tip.stats',
  'loading.tip.potions',
  'loading.tip.loot',
  'loading.tip.whisper',
  'loading.tip.storage',
  'loading.tip.camera',
  'loading.tip.target',
  'loading.tip.options',
]
export const TIP_EVERY_MS = 6000

/** The tip after `prev` (index), picked by `rand` (0..1) among the others, so the same tip never shows twice in a row. */
export function nextTip(prev: number, rand: number, count = LOADING_TIPS.length): number {
  if (count <= 1) return 0
  const pick = Math.min(count - 2, Math.floor(Math.max(0, rand) * (count - 1)))
  return prev >= 0 && pick >= prev ? pick + 1 : pick
}

export class LoadingOverlay {
  readonly root: HTMLElement
  private readonly fill: HTMLElement
  private readonly text: HTMLElement
  private readonly tip: HTMLElement
  private tipIndex = -1
  private tipTimer: ReturnType<typeof setInterval> | null = null
  private shown = 0

  constructor(art: Art, picture: LoadingPicture, host: HTMLElement) {
    ensureUxStyles()
    this.root = el('div', 'loading-screen')
    const pic = el('div', 'loading-picture')
    showPicture(art, pic, picture)
    const frame = art.image('loading/loading_form', 'loading-frame', 720, 40)
    this.fill = el('div', 'loading-fill')
    if (art.has('loading/gauge_loading')) this.fill.style.backgroundImage = art.cssUrl('loading/gauge_loading')
    frame.append(el('div', 'loading-track', this.fill))
    const now = el('div', 'loading-now', t('loading.now'))
    this.text = el('div', 'loading-text')
    this.tip = el('div', 'loading-tip')
    this.showTip()
    this.tipTimer = setInterval(() => this.showTip(), TIP_EVERY_MS)
    this.root.append(pic, el('div', 'loading-bottom', now, frame, this.text, this.tip))
    host.append(this.root)
  }

  private showTip(): void {
    this.tipIndex = nextTip(this.tipIndex, Math.random())
    const key = LOADING_TIPS[this.tipIndex]
    this.tip.textContent = key ? t('loading.tip', { tip: t(key) }) : ''
  }

  private stopTips(): void {
    if (this.tipTimer !== null) clearInterval(this.tipTimer)
    this.tipTimer = null
  }

  /** 0..1; never moves backwards. */
  progress(fraction: number, text?: string): void {
    const f = Math.max(this.shown, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
    this.shown = f
    this.fill.style.width = `${(f * 100).toFixed(1)}%`
    if (text !== undefined) this.text.textContent = text
  }

  async finish(): Promise<void> {
    this.progress(1)
    await new Promise(r => setTimeout(r, 250))
    this.root.classList.add('out')
    await new Promise(r => setTimeout(r, 400))
    this.stopTips()
    this.root.remove()
  }

  remove(): void {
    this.stopTips()
    this.root.remove()
  }
}

/** Combines several 0..1 progress sources into one. */
export class ProgressSet {
  private readonly parts: number[] = []

  constructor(private readonly onChange: (fraction: number) => void) {}

  add(): (fraction: number) => void {
    const i = this.parts.push(0) - 1
    return f => {
      this.parts[i] = Math.max(this.parts[i]!, Math.min(1, f))
      this.onChange(this.parts.reduce((a, b) => a + b, 0) / this.parts.length)
    }
  }
}
