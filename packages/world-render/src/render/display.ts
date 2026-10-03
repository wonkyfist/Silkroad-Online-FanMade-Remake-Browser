/**
 * The PBR post stack's display transform and its inverse (W9 finish D2/D4: display colours drawn twice through a tone
 * curve). The post stack (render/post.ts) shows a scene-linear colour c as
 *   display = saturate(toGamma(tone(c × exposure)))       toGamma: pow 1/2.2 (Babylon's toGammaSpace)
 * with `tone` Babylon's KHR PBR Neutral (the default), its ACES fit ("filmic") or nothing. A display-referred colour
 * that must SHOW as designed on that stack (the retail classic dome, the fog / horizon colour the sky designed) is
 * therefore written as displayToExposed(colour) / exposure, which inverts the curve exactly (up to a clamp just below
 * white, where Neutral and ACES never arrive). The LUT grade and the contrast after the curve are the frame's look and
 * stay out of it, as they do for every other pixel.
 *
 * Pure math plus a tiny per-scene registry: RenderPost registers its live tone map and applied exposure, so the sky
 * (which updates before the post each frame) reads the same numbers without importing the post stack.
 */
import type { Scene } from '@babylonjs/core'
import type { ToneMap } from './quality.ts'

/**
 * The render-side exposure trim (RENDER §5.2). W9 LOOK (target g, noon within ±10 % of Classic at the plaza): the RND-L
 * calibration put the PBR plaza on the Classic one (0.54 sRGB) at trim 1, but the PBR terrain has darkened since
 * (the derived ORMH relief and AO): at a clear noon the dragon-gate plaza measured 0.427 against Classic's 0.544
 * (−21 %). At 1.4 it is 0.521 (−4 %), the frame 0.463 against 0.454, the sky 0.371 against 0.383 (WebGPU, High;
 * work/tmp/w9-finish/look). One trim for sky and ground keeps the sky lane's balance; the night, dusk and storm levels
 * were tuned with it (test/look-calibration.test.ts).
 */
export const EXPOSURE_TRIM = 1.4

type RGBLike = ArrayLike<number>
type RGBOut = [number, number, number] | Float32Array | number[]

/** The largest display value inverted (Neutral and ACES reach 1 only at infinity). */
const DISPLAY_MAX = 0.995
const NEUTRAL_START = 0.8 - 0.04
const NEUTRAL_DESAT = 0.15

/** Babylon's KHR PBR Neutral (imageProcessingFunctions TONEMAPPING 3), one colour. */
export function neutralToneMap(c: RGBLike, out: RGBOut = [0, 0, 0]): RGBOut {
  const x = Math.min(c[0]!, c[1]!, c[2]!)
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  let r = c[0]! - offset, g = c[1]! - offset, b = c[2]! - offset
  const peak = Math.max(r, g, b)
  if (peak >= NEUTRAL_START) {
    const d = 1 - NEUTRAL_START
    const newPeak = 1 - (d * d) / (peak + d - NEUTRAL_START)
    const k = newPeak / peak
    r *= k; g *= k; b *= k
    const w = 1 - 1 / (NEUTRAL_DESAT * (peak - newPeak) + 1)
    r += (newPeak - r) * w; g += (newPeak - g) * w; b += (newPeak - b) * w
  }
  out[0] = r; out[1] = g; out[2] = b
  return out
}

/** The exact inverse of neutralToneMap for 0 ≤ y < 1. */
function neutralInverse(y: RGBLike, out: RGBOut): RGBOut {
  let r = y[0]!, g = y[1]!, b = y[2]!
  const newPeak = Math.max(r, g, b)
  if (newPeak >= NEUTRAL_START) {
    const d = 1 - NEUTRAL_START
    const peak = NEUTRAL_START - d + (d * d) / (1 - newPeak)
    const w = 1 - 1 / (NEUTRAL_DESAT * (peak - newPeak) + 1)
    const k = peak / newPeak
    r = ((r - w * newPeak) / (1 - w)) * k
    g = ((g - w * newPeak) / (1 - w)) * k
    b = ((b - w * newPeak) / (1 - w)) * k
  }
  // Undo the toe: min(c) − offset(min(c)) = m.
  const m = Math.min(r, g, b)
  // m < 0: not reachable (a channel below what the toe leaves); stays negative for displayToExposed to see.
  const offset = m >= 0.04 ? 0.04 : m >= 0 ? Math.sqrt(m / 6.25) - m : 0
  out[0] = r + offset; out[1] = g + offset; out[2] = b + offset
  return out
}

// Babylon's ACES fit (TONEMAPPING 2): out = saturate(OUT × rrt(IN × c)); column-major as in the shader.
const ACES_IN = [0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777]
const ACES_OUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602]

function mul3(m: readonly number[], v: RGBLike, out: RGBOut): RGBOut {
  const x = v[0]!, y = v[1]!, z = v[2]!
  out[0] = m[0]! * x + m[3]! * y + m[6]! * z
  out[1] = m[1]! * x + m[4]! * y + m[7]! * z
  out[2] = m[2]! * x + m[5]! * y + m[8]! * z
  return out
}

function inverse3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}
const ACES_IN_INV = inverse3(ACES_IN)
const ACES_OUT_INV = inverse3(ACES_OUT)

const rrt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081)
/** v ≥ 0 with rrt(v) = w (the positive root of the fit's quadratic). */
function rrtInverse(w: number): number {
  const A = 0.983729 * w - 1
  const B = 0.432951 * w - 0.0245786
  const C = 0.238081 * w + 0.000090537
  if (Math.abs(A) < 1e-9) return Math.max(0, -C / B)
  const disc = Math.max(0, B * B - 4 * A * C)
  return Math.max(0, (-B - Math.sqrt(disc)) / (2 * A))
}

/** Babylon's ACES fit, one colour (saturated like the shader). */
export function acesToneMap(c: RGBLike, out: RGBOut = [0, 0, 0]): RGBOut {
  const t: RGBOut = [0, 0, 0]
  mul3(ACES_IN, c, t)
  t[0] = rrt(t[0]!); t[1] = rrt(t[1]!); t[2] = rrt(t[2]!)
  mul3(ACES_OUT, t, out)
  for (let k = 0; k < 3; k++) out[k] = Math.min(1, Math.max(0, out[k]!))
  return out
}

function acesInverse(y: RGBLike, out: RGBOut): RGBOut {
  const t: RGBOut = [0, 0, 0]
  mul3(ACES_OUT_INV, y, t)
  // A negative value before the output matrix is out of reach: flagged negative for displayToExposed.
  if (Math.min(t[0]!, t[1]!, t[2]!) < -1e-6) {
    out[0] = -1; out[1] = -1; out[2] = -1
    return out
  }
  // The fit's range tops out at 1 / 0.983729: keep each channel just below it.
  for (let k = 0; k < 3; k++) t[k] = rrtInverse(Math.min(1.0, Math.max(0, t[k]!)))
  // Negative here is out of reach too (left for displayToExposed to see).
  return mul3(ACES_IN_INV, t, out)
}

/** What the post stack shows for an exposed colour (after × exposure): tone map, gamma, saturate. */
export function exposedToDisplay(c: RGBLike, toneMap: ToneMap, out: RGBOut = [0, 0, 0]): RGBOut {
  if (toneMap === 'filmic') acesToneMap(c, out)
  else if (toneMap === 'neutral') neutralToneMap(c, out)
  else { out[0] = c[0]!; out[1] = c[1]!; out[2] = c[2]! }
  for (let k = 0; k < 3; k++) out[k] = Math.min(1, Math.pow(Math.max(0, out[k]!), 1 / 2.2))
  return out
}

/**
 * The exposed colour (the value after the post's × exposure) that shows `display` on the post stack: the exact inverse
 * of exposedToDisplay for display values in [0, 0.995]. Divide it by the applied exposure for a scene-linear colour.
 */
export function displayToExposed(display: RGBLike, toneMap: ToneMap, out: RGBOut = [0, 0, 0]): RGBOut {
  const lin: RGBOut = [0, 0, 0]
  for (let k = 0; k < 3; k++) lin[k] = Math.pow(Math.min(DISPLAY_MAX, Math.max(0, display[k]!)), 2.2)
  if (toneMap === 'none') {
    out[0] = lin[0]!; out[1] = lin[1]!; out[2] = lin[2]!
    return out
  }
  const inv = toneMap === 'filmic' ? acesInverse : neutralInverse
  inv(lin, out)
  if (Math.min(out[0]!, out[1]!, out[2]!) >= -1e-6) return clampPositive(out)
  // A bright saturated colour both curves desaturate on the way up cannot be reached: aim at the most saturated
  // reachable colour of the same luminance instead (a few bisection steps; the retail palettes never get here).
  const y = 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
  const t: RGBOut = [0, 0, 0]
  let lo = 0, hi = 1
  for (let i = 0; i < 12; i++) {
    const s = (lo + hi) / 2
    for (let k = 0; k < 3; k++) t[k] = y + (lin[k]! - y) * s
    inv(t, out)
    if (Math.min(out[0]!, out[1]!, out[2]!) >= -1e-6) lo = s
    else hi = s
  }
  for (let k = 0; k < 3; k++) t[k] = y + (lin[k]! - y) * lo
  return clampPositive(inv(t, out))
}

function clampPositive(out: RGBOut): RGBOut {
  for (let k = 0; k < 3; k++) out[k] = Math.max(0, out[k]!)
  return out
}

/** A scene's post display transform now: its tone map and the exposure it multiplies the scene by. */
export interface SceneDisplay {
  readonly toneMap: ToneMap
  readonly exposure: number
}

const DISPLAYS = new WeakMap<Scene, () => SceneDisplay>()

/** RenderPost registers its live transform (null: unregister). */
export function setSceneDisplay(scene: Scene, source: (() => SceneDisplay) | null): void {
  if (source) DISPLAYS.set(scene, source)
  else DISPLAYS.delete(scene)
}

/**
 * The scene's display transform. Without a registered post stack (headless tests, the moment before the post builds):
 * Neutral at `skyExposure` × EXPOSURE_TRIM, what the PBR presets' post stack applies (a registered, unbuilt post: its
 * tone map at that exposure).
 */
export function sceneDisplay(scene: Scene, skyExposure: number): SceneDisplay {
  const d = DISPLAYS.get(scene)?.()
  if (d && d.exposure > 0) return d
  // Not built yet (exposure 0): the post's tone map at the exposure it will apply.
  return { toneMap: d?.toneMap ?? 'neutral', exposure: Math.max(1e-3, skyExposure * EXPOSURE_TRIM) }
}

/** The scene-linear colour that shows `display` on the scene's PBR post stack. */
export function displayToScene(display: RGBLike, d: SceneDisplay, out: RGBOut = [0, 0, 0]): RGBOut {
  displayToExposed(display, d.toneMap, out)
  const inv = 1 / Math.max(1e-3, d.exposure)
  out[0] = out[0]! * inv; out[1] = out[1]! * inv; out[2] = out[2]! * inv
  return out
}
