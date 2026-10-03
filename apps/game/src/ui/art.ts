/**
 * Original UI art exported by packages/convert/src/tools/export-ui.ts to /out/ui/ (manifest: /out/ui/index.json).
 * Keys are paths under Media/interface without extension, e.g. 'outer/login_window'.
 * When the manifest or an image is missing, elements get the `no-art` class and plain CSS styling instead.
 *
 * Text policy: all UI text is live English text. Images listed in the manifest's `bakedText` (captions,
 * logos, the copyright line... baked into the Vietnamese client's art) report has() = false, so they can
 * never reach a screen; screens use the textless variants (e.g. outer/blackbar_down_notext) and live text.
 * hasCropped() is for the one deliberate exception: a picture shown with its text area cropped away.
 */
import { OUT } from '../content/catalog.ts'
import { el } from './dom.ts'

export interface UiImage {
  file: string
  width: number
  height: number
  content: [number, number, number, number]
  derived?: { from: string; note: string }
  /** Nine-slice sheets (`<prefix>9`, export-ui.ts): the slice insets in px (docs/UI.md §5.4). */
  nine?: NineInsets
}

export interface NineInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface UiFont {
  file: string
  src: string
  family: string
  role: string
}

export interface UiManifest {
  version: number
  images: Record<string, UiImage>
  music: Record<string, string>
  layouts?: Record<string, string>
  fonts?: Record<string, UiFont>
  /** Image key -> what text is baked into it (see packages/convert/src/tools/export-ui.ts BAKED_TEXT). */
  bakedText?: Record<string, string>
  /** Image key -> the English text baked into it (MENU tab, ADD, UP...): allowed art, listed for the audit (UI.md §5.4). */
  englishText?: Record<string, string>
}

/** index.json wins on key collisions; hud.json adds its images and baked-text entries. */
export function mergeManifests(main: UiManifest | null, extra: Partial<UiManifest> | null): UiManifest | null {
  if (!extra?.images) return main
  const base: UiManifest = main ?? { version: 1, images: {}, music: {} }
  return {
    ...base,
    images: { ...extra.images, ...base.images },
    bakedText: { ...(extra.bakedText ?? {}), ...(base.bakedText ?? {}) },
    englishText: { ...(extra.englishText ?? {}), ...(base.englishText ?? {}) },
  }
}

export class Art {
  constructor(readonly manifest: UiManifest | null) {}

  /**
   * Loads /out/ui/index.json (export-ui.ts) and merges /out/ui/hud.json (the in-game HUD textures written by
   * export-icons.ts) into it. Either may be missing: the HUD then draws with plain CSS.
   */
  static async load(): Promise<Art> {
    const fetchJson = async (file: string): Promise<UiManifest> => {
      const res = await fetch(`${OUT}ui/${file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as UiManifest
    }
    const [main, hud] = await Promise.all([
      fetchJson('index.json').catch(err => {
        console.warn('[ui] /out/ui/index.json unavailable; run pnpm tsx packages/convert/src/tools/export-ui.ts', err)
        return null
      }),
      fetchJson('hud.json').catch(err => {
        console.warn('[ui] /out/ui/hud.json unavailable; run pnpm tsx packages/convert/src/tools/export-icons.ts', err)
        return null
      }),
    ])
    return new Art(mergeManifests(main, hud))
  }

  /** True when the image exported and carries no baked-in text. */
  has(key: string): boolean {
    return !!this.manifest?.images[key] && !this.manifest.bakedText?.[key]
  }

  /** True when at least one of the keys is available (has()). */
  hasAny(...keys: string[]): boolean {
    return keys.some(k => this.has(k))
  }

  /** The slice insets of a nine-slice sheet, when the manifest has them. */
  nine(key: string): NineInsets | undefined {
    return this.manifest?.images[key]?.nine
  }

  /** True when the image exported, text or not: only for callers that crop the text area away. */
  hasCropped(key: string): boolean {
    return !!this.manifest?.images[key]
  }

  url(key: string): string {
    const img = this.manifest?.images[key]
    return img ? OUT + img.file : `${OUT}ui/${key}.png`
  }

  cssUrl(key: string): string {
    return `url("${this.url(key)}")`
  }

  size(key: string): [number, number] | undefined {
    const img = this.manifest?.images[key]
    return img ? [img.width, img.height] : undefined
  }

  musicUrl(name: string): string | undefined {
    const file = this.manifest?.music[name]
    return file ? OUT + file : this.manifest && Object.keys(this.manifest.music).length ? undefined : `${OUT}music/${name}.ogg`
  }

  /** A block showing one texture at its native size (or w x h). */
  image(key: string, className = '', w?: number, h?: number): HTMLDivElement {
    const d = el('div', `art ${className}`)
    const size = this.size(key)
    const width = w ?? size?.[0]
    const height = h ?? size?.[1]
    if (width) d.style.width = `${width}px`
    if (height) d.style.height = `${height}px`
    if (this.has(key)) d.style.backgroundImage = this.cssUrl(key)
    else d.classList.add('no-art')
    return d
  }

  /** A window: the texture as background, children placed with native-pixel rects. */
  window(key: string, className = '', w?: number, h?: number): HTMLDivElement {
    return this.image(key, `art-window ${className}`, w, h)
  }

  /**
   * A button drawn with a texture and its `_focus` / `_press` variants (hover / active).
   * `key` defaults to the outer screens' 91x40 button.
   */
  button(label: string, opts: { key?: string; w?: number; h?: number; className?: string } = {}): HTMLButtonElement {
    const key = opts.key ?? 'outer/button'
    const b = el('button', `art-button ${opts.className ?? ''}`)
    b.type = 'button'
    const size = this.size(key)
    const w = opts.w ?? size?.[0]
    const h = opts.h ?? size?.[1]
    if (w) b.style.width = `${w}px`
    if (h) b.style.height = `${h}px`
    if (this.has(key)) {
      b.style.setProperty('--img', this.cssUrl(key))
      b.style.setProperty('--img-focus', this.cssUrl(this.has(`${key}_focus`) ? `${key}_focus` : key))
      b.style.setProperty('--img-press', this.cssUrl(this.has(`${key}_press`) ? `${key}_press` : key))
    } else {
      b.classList.add('no-art')
    }
    if (label) b.append(el('span', 'label', label))
    return b
  }
}
