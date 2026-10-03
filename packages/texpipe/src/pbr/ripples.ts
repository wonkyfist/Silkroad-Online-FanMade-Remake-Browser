/**
 * TP-P sand-ripple marks (docs/COAST.md §7.2: the wet-sand remaster of tile 70 has "ripple marks in the height"): a
 * tileable ripple field blended into the derived height before the normal, AO and roughness are computed from it.
 *
 * - Crests run roughly along U: the wave vector is RIPPLE_WAVE cycles per tile (a whole number on both axes, so the
 *   field wraps on both axes; about 22 cm between crests on the 8 m terrain period).
 * - The crests meander: the phase is warped by a sum of whole-number sines (tileable), and their height fades in and
 *   out along the crests, so the marks do not read as a ruled grid from the camera.
 * - The profile is skewed (a gentle stoss side, a steeper lee), as wave ripples are.
 * - Deterministic from the seed (the texture key's hash), with no randomness per run. Pure.
 */

/** Cycles per tile of the ripple wave vector [along U, along V]. */
export const RIPPLE_WAVE = [5, 36] as const
/** Phase warp: [cycles along U, cycles along V, amplitude in ripple periods]. */
const WARP: readonly (readonly [number, number, number])[] = [[1, 2, 0.55], [2, 1, 0.35], [3, 3, 0.2]]
/** Crest-height modulation: [cycles along U, cycles along V, weight]. */
const FADE: readonly (readonly [number, number, number])[] = [[2, 1, 0.5], [1, 3, 0.3], [4, 2, 0.2]]
const TAU = Math.PI * 2

/** Deterministic phases in 0..1 from a 32-bit seed (mulberry32). */
function phases(seed: number, n: number): number[] {
  let a = seed >>> 0
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    out.push(((t ^ (t >>> 14)) >>> 0) / 4294967296)
  }
  return out
}

/** The ripple height field of a w×h tile, 0..1, wrapping on both axes. */
export function rippleField(w: number, h: number, seed = 0): Float32Array {
  const ph = phases(seed, WARP.length + FADE.length + 1)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const v = y / h
    for (let x = 0; x < w; x++) {
      const u = x / w
      let warp = 0
      WARP.forEach(([a, b, amp], i) => { warp += amp * Math.sin(TAU * (a * u + b * v + ph[i]!)) })
      let fade = 0
      FADE.forEach(([a, b, wt], i) => { fade += wt * (0.5 + 0.5 * Math.sin(TAU * (a * u + b * v + ph[WARP.length + i]!))) })
      const phase = RIPPLE_WAVE[0] * u + RIPPLE_WAVE[1] * v + warp + ph[ph.length - 1]!
      // Skewed sine: the crest leans toward +phase (a steeper lee side).
      const t = TAU * phase
      const r = 0.5 + 0.5 * Math.sin(t + 0.6 * Math.sin(t))
      out[y * w + x] = r * (0.45 + 0.55 * fade)
    }
  }
  return out
}

/** Blends the ripple field into a 0..1 height plane in place: H = (1 − a)·H + a·ripple. */
export function addRipples(height: Float32Array, w: number, h: number, amount: number, seed = 0): void {
  if (!(amount > 0)) return
  const r = rippleField(w, h, seed)
  for (let p = 0; p < w * h; p++) height[p] = (1 - amount) * height[p]! + amount * r[p]!
}
