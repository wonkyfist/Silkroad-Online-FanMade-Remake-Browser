/**
 * The UI scale (docs/UI.md §4.1). The in-game UI is laid out in retail pixels inside layers with CSS
 * `zoom: var(--ui)` (`.hud-root`, `.world-ui`); `--ui` is one of a few steps and never drops below 1 on a
 * desktop-sized viewport, so 12-px text stays 12 px and the art is drawn whole. `app.ts updateScale()` sets
 * `--ui` and `--art-rendering` from `uiScale()` and `artRendering()`.
 * Pure functions first (unit-tested, no DOM); the DOM helpers at the end read the effective zoom of a layer so
 * pointer maths (clientX / clientY are viewport px) can be turned into native px.
 */

export const UI_STEPS = [1, 1.25, 1.5, 2, 2.5, 3] as const
export type UiStep = (typeof UI_STEPS)[number]
export type UiScaleMode = 'auto' | UiStep
export const UI_SCALE_MODES: readonly UiScaleMode[] = ['auto', ...UI_STEPS]

/** Native px of room Auto keeps: the largest step with this much room wins. */
export const AUTO_ROOM: readonly [number, number] = [1280, 800]
/** Below this viewport Auto may go under 1 (small windows, phones). */
export const DESKTOP_MIN: readonly [number, number] = [1024, 700]
/** A fixed step is lowered until the UI has at least this much native room (a 3x UI on a laptop would not fit). */
export const FIXED_ROOM: readonly [number, number] = [800, 560]

export function isUiScaleMode(v: unknown): v is UiScaleMode {
  return v === 'auto' || (typeof v === 'number' && (UI_STEPS as readonly number[]).includes(v))
}

/** Auto: the largest step with 1280×800 native px of room; never below 1 unless the viewport is smaller than 1024×700. */
export function autoScale(vw: number, vh: number): number {
  if (!(vw > 0) || !(vh > 0)) return 1
  const fit = Math.min(vw / AUTO_ROOM[0], vh / AUTO_ROOM[1])
  if (vw < DESKTOP_MIN[0] || vh < DESKTOP_MIN[1]) return Math.max(0.75, Math.min(1, Math.floor(Math.min(vw / DESKTOP_MIN[0], vh / DESKTOP_MIN[1]) * 8) / 8))
  let s = 1
  for (const step of UI_STEPS) if (step <= fit + 1e-6) s = step
  return s
}

/**
 * The scale for a mode: Auto as above; a fixed step as chosen, lowered step by step (never below 1) while the
 * native room would be smaller than 800×560, and 'auto' below 1 on a small viewport.
 */
export function uiScale(mode: UiScaleMode | undefined, vw: number, vh: number): number {
  if (mode === undefined || mode === 'auto' || !isUiScaleMode(mode)) return autoScale(vw, vh)
  if (vw < DESKTOP_MIN[0] || vh < DESKTOP_MIN[1]) return Math.min(mode, autoScale(vw, vh))
  let i = (UI_STEPS as readonly number[]).indexOf(mode)
  while (i > 0 && (vw / UI_STEPS[i]! < FIXED_ROOM[0] || vh / UI_STEPS[i]! < FIXED_ROOM[1])) i--
  return UI_STEPS[Math.max(0, i)]!
}

/** `pixelated` when scale × devicePixelRatio is a whole number (each art pixel is whole device pixels), else `auto`. */
export function artRendering(scale: number, dpr: number): 'pixelated' | 'auto' {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const f = scale * d
  return f >= 1 && Math.abs(f - Math.round(f)) < 1e-3 ? 'pixelated' : 'auto'
}

/** Keeps a window of w×h (native px) reachable in a vw×vh (native px) layer: 60 px of it on screen, its top on screen. */
export function clampWindow(x: number, y: number, w: number, vw: number, vh: number): [number, number] {
  const cx = Math.min(Math.max(x, 60 - w), vw - 60)
  const cy = Math.min(Math.max(y, 0), Math.max(0, vh - 30))
  return [Math.round(cx), Math.round(cy)]
}

/** Where a window without a remembered position opens (native px). */
export function openPosition(
  size: [number, number],
  layer: [number, number],
  opts: { prev?: [number, number] | null; at?: [number, number]; step?: number } = {},
): [number, number] {
  const [w, h] = size
  const [vw, vh] = layer
  const step = opts.step ?? CASCADE_STEP
  let x: number
  let y: number
  if (opts.prev) {
    x = opts.prev[0] + step
    y = opts.prev[1] + step
    // Wrapped past the bottom-right: start a new cascade from the top-left of the free space.
    if (x + w > vw - 4 || y + h > vh - 4) {
      x = Math.max(4, Math.round((vw - w) * 0.1))
      y = Math.max(4, Math.round((vh - h) * 0.1))
    }
  } else {
    const [fx, fy] = opts.at ?? [0.5, 0.4]
    x = Math.round((vw - w) * fx)
    y = Math.round((vh - h) * fy)
  }
  return clampWindow(Math.max(0, x), Math.max(0, y), w, vw, vh)
}

export const CASCADE_STEP = 24

// ---- DOM helpers ------------------------------------------------------------------------------------

/** The root --ui (1 without a DOM). */
export function rootScale(): number {
  if (typeof document === 'undefined') return 1
  return Number(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1
}

/**
 * The effective CSS zoom of an element (the product of its ancestors' zoom), i.e. viewport px per native px
 * inside it. Uses `Element.currentCSSZoom` (Chrome 128+, Firefox 126+); otherwise it is measured.
 */
export function layerScale(e: Element | null | undefined): number {
  if (!e) return rootScale()
  const z = (e as Element & { currentCSSZoom?: number }).currentCSSZoom
  if (typeof z === 'number' && z > 0) return z
  const h = e as HTMLElement
  if (h.offsetWidth > 0) {
    const r = h.getBoundingClientRect().width / h.offsetWidth
    if (r > 0) return r
  }
  return rootScale()
}

/** The native-px size of the viewport as seen from inside a layer. */
export function layerViewport(e: Element | null | undefined): [number, number] {
  const s = layerScale(e)
  return [window.innerWidth / s, window.innerHeight / s]
}
