/**
 * Retail damage numbers: the `Media interface/hitcount/*` digit and tag sprites (UI-X exports them to
 * /out/ui/hitcount/*.png), laid out for the Floaters in hud/effects.ts (docs/EFFECTS.md §3.1, docs/WAVE_PLAN2.md D2).
 *
 * Rules [our rule, retail-shaped]:
 * - digits at half size (36x60 art -> 18x30 px), set on their ink with a slight overlap (the art is italic);
 * - palettes: `dealt` (your hits on others) = the white `hitcount_N` over its `hitcount_N_shadow`; `taken` (hits on
 *   you) = the red `hitcount_enemy_N` (outline baked in); `other` (another player's hits) = `hitcount_player_N`;
 * - tags: "Critical" above the digits (`critical` + `critical_shadow` / `critical_enemy` / `critical_player`),
 *   "miss" alone (`miss_player` white for your misses, `miss_enemy` red for misses on you), "Block" alone
 *   (`blocking` + `blocking_shadow` / `blocking_enemy` / `blocking_player`);
 * - heals have no retail sprite: they stay green DOM text (hitSprites returns null).
 */
import type { DamageKind } from './effects.ts'

export type HitPalette = 'dealt' | 'taken' | 'other'

/** One sprite of a number, in display px from the number's top-left corner; `key` is an Art key ('hitcount/...'). */
export interface HitSprite {
  key: string
  x: number
  y: number
  w: number
  h: number
}

export interface HitLayout {
  sprites: HitSprite[]
  width: number
  height: number
  palette: HitPalette
}

/** Display scale of the art (36x60 digits -> 18x30 px). */
export const HITCOUNT_SCALE = 0.5
/** Space between two digits' ink in art px (negative: the italic digits overlap a little). */
export const DIGIT_TRACK = -5
/** Largest number drawn as sprites (longer ones would not fit a screen anyway). */
const MAX_DIGITS = 9
/** The largest number shown (MAX_DIGITS nines); larger hits show as this. */
const MAX_SHOWN = 10 ** MAX_DIGITS - 1

const DIGIT_W = 36
const DIGIT_H = 60
/** Ink [x, width] of each digit in its 36x60 cell (the export manifest's content rects). */
const INK_PLAIN: readonly (readonly [number, number])[] = [
  [2, 30], [3, 28], [4, 28], [1, 32], [1, 34], [2, 30], [2, 32], [1, 31], [2, 31], [1, 32],
]
/** The shadowed digits (`_enemy`, `_player`, `_shadow`) are one or two px wider. */
const INK_SHADOWED: readonly (readonly [number, number])[] = [
  [1, 35], [2, 33], [3, 32], [0, 36], [0, 36], [1, 34], [1, 35], [0, 35], [1, 35], [0, 36],
]
/** Top of the digits' ink in the cell: 6 and 8 rise to the top, the others start at about 13. */
const inkTop = (text: string): number => (/[68]/.test(text) ? 1 : 12)

interface TagArt {
  key: string
  shadow?: string
  w: number
  h: number
  /** Ink box [x, y, w, h] in the art. */
  ink: readonly [number, number, number, number]
}

const tag = (key: string, w: number, h: number, ink: TagArt['ink'], shadow?: string): TagArt => ({ key, w, h, ink, shadow })

const CRITICAL: Record<HitPalette, TagArt> = {
  dealt: tag('critical', 96, 24, [0, 0, 95, 23], 'critical_shadow'),
  taken: tag('critical_enemy', 96, 24, [0, 0, 95, 23]),
  other: tag('critical_player', 96, 24, [0, 0, 95, 23]),
}
const MISS: Record<HitPalette, TagArt> = {
  dealt: tag('miss_player', 60, 28, [2, 0, 57, 28]),
  taken: tag('miss_enemy', 60, 28, [2, 0, 57, 28]),
  other: tag('miss_player', 60, 28, [2, 0, 57, 28]),
}
const BLOCK: Record<HitPalette, TagArt> = {
  dealt: tag('blocking', 104, 40, [1, 1, 100, 36], 'blocking_shadow'),
  taken: tag('blocking_enemy', 104, 40, [1, 1, 100, 36]),
  other: tag('blocking_player', 104, 40, [1, 1, 100, 36]),
}

/** Palette of a damage kind: the `*Taken` kinds and `taken` are hits on you. */
export function hitPalette(kind: DamageKind): HitPalette {
  return kind === 'taken' || kind === 'critTaken' || kind === 'missTaken' || kind === 'blockTaken' ? 'taken' : 'dealt'
}

function digitKey(palette: HitPalette, d: number): string {
  return palette === 'dealt' ? `hitcount_${d}` : palette === 'taken' ? `hitcount_enemy_${d}` : `hitcount_player_${d}`
}

/** Every Art key a palette can draw (preloading, the export check). */
export function hitcountKeys(): string[] {
  const keys = new Set<string>()
  for (let d = 0; d <= 9; d++) {
    for (const p of ['dealt', 'taken', 'other'] as const) keys.add(`hitcount/${digitKey(p, d)}`)
    keys.add(`hitcount/hitcount_${d}_shadow`)
  }
  for (const set of [CRITICAL, MISS, BLOCK]) {
    for (const a of Object.values(set)) {
      keys.add(`hitcount/${a.key}`)
      if (a.shadow) keys.add(`hitcount/${a.shadow}`)
    }
  }
  return [...keys]
}

/**
 * The sprites of one floating number (pure; tested), in draw order (shadows first), or null when the kind has no
 * retail art (heals). `palette` overrides the kind's (another player's hits).
 */
export function hitSprites(amount: number, kind: DamageKind, palette: HitPalette = hitPalette(kind)): HitLayout | null {
  if (kind === 'heal') return null
  const s = HITCOUNT_SCALE
  const back: HitSprite[] = []
  const front: HitSprite[] = []
  const put = (a: TagArt, x: number, y: number) => {
    if (a.shadow) back.push({ key: `hitcount/${a.shadow}`, x, y, w: a.w, h: a.h })
    front.push({ key: `hitcount/${a.key}`, x, y, w: a.w, h: a.h })
  }

  if (kind === 'miss' || kind === 'missTaken' || kind === 'block' || kind === 'blockTaken') {
    put((kind === 'miss' || kind === 'missTaken' ? MISS : BLOCK)[palette], 0, 0)
  } else {
    // Clamp first: String(1e21) is "1e+21" and NaN / Infinity have no digits (the validator lets any integer through).
    const n = Number.isFinite(amount) ? Math.min(MAX_SHOWN, Math.max(0, Math.round(amount))) : 0
    const text = String(n)
    const ink = palette === 'dealt' ? INK_PLAIN : INK_SHADOWED
    let cursor = 0
    let first = true
    for (const ch of text) {
      const d = ch.charCodeAt(0) - 48
      const row = ink[d]
      if (!row) continue
      const [ix, iw] = row
      const x = first ? -ix : cursor - ix
      if (palette === 'dealt') back.push({ key: `hitcount/hitcount_${d}_shadow`, x, y: 0, w: DIGIT_W, h: DIGIT_H })
      front.push({ key: `hitcount/${digitKey(palette, d)}`, x, y: 0, w: DIGIT_W, h: DIGIT_H })
      cursor = x + ix + iw + DIGIT_TRACK
      first = false
    }
    if (kind === 'crit' || kind === 'critTaken') {
      // "Critical" sits on the digits' ink, centred over them.
      const a = CRITICAL[palette]
      const digitsInk = cursor - DIGIT_TRACK
      const x = digitsInk / 2 - (a.ink[0] + a.ink[2] / 2)
      put(a, x, inkTop(text) - (a.ink[1] + a.ink[3]) + 2)
    }
  }

  // Normalise to the box of all sprites, then scale to display px.
  const all = [...back, ...front]
  const minX = Math.min(...all.map(p => p.x))
  const minY = Math.min(...all.map(p => p.y))
  const maxX = Math.max(...all.map(p => p.x + p.w))
  const maxY = Math.max(...all.map(p => p.y + p.h))
  const sprites = all.map(p => ({ key: p.key, x: (p.x - minX) * s, y: (p.y - minY) * s, w: p.w * s, h: p.h * s }))
  return { sprites, width: (maxX - minX) * s, height: (maxY - minY) * s, palette }
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

const CSS = `
.hud-float.hc { display: block; font: 0/0 a; text-shadow: none; }
.hud-float.hc > i { position: absolute; display: block; background-repeat: no-repeat; background-size: 100% 100%; }
`

let injected = false

function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.id = 'hud-hitcount-style'
  style.textContent = CSS
  document.head.append(style)
}

/** URL of an Art key (the art's own resolver, so /out-opt and manifests stay in one place). */
export type HitArtUrl = (key: string) => string

/**
 * Fills `node` with the sprites of `layout` (absolutely placed <i> elements). The caller keeps the node's
 * `hud-float` class and its transform; the node gets the `hc` class and the layout's size.
 */
export function drawHitSprites(node: HTMLElement, layout: HitLayout, url: HitArtUrl): void {
  ensureStyles()
  node.classList.add('hc', `hc-${layout.palette}`)
  node.style.width = `${layout.width}px`
  node.style.height = `${layout.height}px`
  for (const p of layout.sprites) {
    const i = document.createElement('i')
    i.style.left = `${p.x}px`
    i.style.top = `${p.y}px`
    i.style.width = `${p.w}px`
    i.style.height = `${p.h}px`
    i.style.backgroundImage = `url("${url(p.key)}")`
    node.append(i)
  }
}

/** Starts loading every sprite once, so the first hit does not flash empty. */
export function preloadHitcount(url: HitArtUrl): void {
  if (typeof Image === 'undefined') return
  for (const key of hitcountKeys()) {
    const img = new Image()
    img.src = url(key)
  }
}
