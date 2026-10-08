/**
 * The crowd tier's baked animation rows (docs/CHARACTERS.md §3.5, P1a): the pure part. A crowd character is drawn by a
 * thin instance of its outfit batch, skinned from a bone-matrix texture (the VAT, Babylon's
 * `BakedVertexAnimationManager` layout: one row per frame, 4 RGBA texels per bone). This file plans the rows of a clip,
 * turns a clip's state into the instance's `bakedVertexAnimationSettingsInstanced` vec4, packs the far look of a
 * weapon (its + level and seal) into a code, and converts floats to halves. three/crowd-tier.ts is the runtime.
 *
 * Babylon's shader (ShadersInclude/bakedVertexAnimation, 9.28) reads, with settings (start, end, offset, speed) and the
 * manager's time T:
 *   n = end − start + 1, x = T·speed / n, c = x < 1 ? 0 : 1, m = n − c,
 *   row = start + c + floor(mod(fract(x)·m + offset, m)).
 * - **Loops** (rows start..end sampled over the whole clip, the last row = the first pose) advance on the GPU: with
 *   T ≥ CLOCK_BASE_S every x ≥ 1, so c = 1 and rows start+1..end cover one cycle; `speed` = n·rate/duration makes
 *   fract(x)·(n − 1) run at the clip's rows per second, and `offset` puts the clip's phase at the instance's time. No
 *   write per frame while the clip plays.
 * - **One-shots** hold their last row and must not wrap, so the CPU picks the row (speed 0: x = 0, c = 0, row = start +
 *   floor(offset)); one write per frame while one plays.
 */

/** Rows per second of a baked clip (the townsfolk's rate: a step of 33 ms at most, under the far tiers' 10–20 Hz poses). */
export const CROWD_ROWS_PER_S = 30
/** The VAT clock starts here (s) and is rebased past CLOCK_REBASE_S, so float32 keeps sub-row precision on the GPU. */
export const CLOCK_BASE_S = 1000
export const CLOCK_REBASE_S = 4000
/** A clip played slower than this ratio is stepped by the CPU (a loop on the GPU needs T·speed/n ≥ 1 from the base). */
export const MIN_GPU_SPEED = 0.05

/** One baked clip of a VAT: rows start..start+frames−1. */
export interface VatRows {
  start: number
  /** Rows (≥ 2): frames − 1 intervals over the clip's duration. */
  frames: number
  durationS: number
  loop: boolean
}

/** Rows a clip of `durationS` takes at `rps` (≥ 2; the last row is the clip's end, a loop's seam = its first pose). */
export function rowsFor(durationS: number, rps = CROWD_ROWS_PER_S): number {
  if (!(durationS > 0)) return 2
  return Math.max(2, Math.round(durationS * rps) + 1)
}

/** The clip time (s) of row `j` of a clip baked with `frames` rows over `durationS`. */
export function rowTime(j: number, frames: number, durationS: number): number {
  return frames > 1 ? (j * durationS) / (frames - 1) : 0
}

/** Where a crowd instance's clip is: the baked rows, the clip time `clipS` at clock `atS`, the playback rate. */
export interface ClipClock {
  rows: VatRows
  /** Clip time (s, 0..duration) at `atS`. */
  clipS: number
  /** The VAT clock (s) the clip time was read at. */
  atS: number
  /** Playback speed ratio (1 = the clip's own length). */
  speed: number
}

/** The clip time (s) at clock `t`: a loop wraps, a one-shot holds its end (and its start before it began). */
export function clipTimeAt(c: ClipClock, t: number): number {
  const d = c.rows.durationS
  const s = c.clipS + (t - c.atS) * c.speed
  if (!(d > 0)) return 0
  if (c.rows.loop) return ((s % d) + d) % d
  return Math.min(d, Math.max(0, s))
}

/** Whether the GPU advances this clip (a loop at a sane speed) or the CPU writes its row every frame. */
export function gpuAdvances(c: ClipClock): boolean {
  return c.rows.loop && c.rows.durationS > 0 && c.speed >= MIN_GPU_SPEED && c.rows.frames > 2
}

/**
 * The instance settings (start, end, offset, speed) for clip clock `c` at VAT clock `t` (into `out`). A GPU loop's
 * settings do not change while the clip plays on; a CPU clip's offset is the row at `t` (nearest).
 */
export function vatSettings(c: ClipClock, t: number, out: Float32Array | number[] = new Float32Array(4), at = 0): Float32Array | number[] {
  const r = c.rows
  const n = r.frames
  const d = r.durationS
  out[at] = r.start
  out[at + 1] = r.start + n - 1
  if (gpuAdvances(c)) {
    const cyc = n - 1
    const rate = (cyc * c.speed) / d
    // shader: row = start + 1 + floor(mod(T·rate + offset, n − 1)); wanted: start + j for the nearest row j of the clip
    // time at T, i.e. row index j − 1 (mod n − 1) after the seam row (start + n − 1 is the pose of start)
    const j = (c.clipS * cyc) / d - c.atS * rate
    out[at + 2] = (((j - 1 + 0.5) % cyc) + cyc) % cyc
    out[at + 3] = (n * c.speed) / d
  } else {
    const s = clipTimeAt(c, t)
    out[at + 2] = d > 0 ? Math.min(n - 1, Math.max(0, Math.round((s * (n - 1)) / d))) : 0
    out[at + 3] = 0
  }
  return out
}

/** Babylon's shader row for settings `s` at clock `t` (bakedVertexAnimation.fx, in doubles; the tests use it). */
export function shaderRow(s: ArrayLike<number>, t: number): number {
  const start = s[0]!
  const end = s[1]!
  const offset = s[2]!
  const speed = s[3]!
  const n = end - start + 1
  const x = (t * speed) / n
  const c = x < 1 ? 0 : 1
  const m = n - c
  const f = x - Math.floor(x)
  const v = (((f * m + offset) % m) + m) % m
  return Math.floor(v) + start + c
}

/** The nearest baked row of clip clock `c` at clock `t` (what the instance should show; the tests compare). */
export function wantedRow(c: ClipClock, t: number): number {
  const r = c.rows
  const s = clipTimeAt(c, t)
  const j = r.durationS > 0 ? Math.round((s * (r.frames - 1)) / r.durationS) : 0
  // a loop's seam row (the last) is its first pose
  return r.start + (r.loop && j >= r.frames - 1 ? 0 : j)
}

// ---- the far look of a weapon (the crowd material's item code) ----------------------------------------------------

/** Item kinds in the crowd mesh (the integer part of u / 2 of a rigid part's vertices). */
export const ITEM_BODY = 0
export const ITEM_WEAPON = 1
export const ITEM_SHIELD = 2

/** Seal tiers in the code (docs/RARITY.md): none, Star, Moon, Sun. */
export const RARE_TIERS = ['star', 'moon', 'sun'] as const

/**
 * The far look of a weapon or shield as one small integer (0 = plain): the glow row (its + level clamped to 0..7) and
 * the seal tier (0 none, 1 Star, 2 Moon, 3 Sun) × 8. The crowd vertex shader moves the item's atlas u by 2 × code
 * (the atlas wraps, so the texel is the same) and the fragment reads it back as floor(u / 2).
 */
export function itemCode(plus: number | undefined, rare: (typeof RARE_TIERS)[number] | null | undefined): number {
  const p = plus && Number.isFinite(plus) ? Math.max(0, Math.min(7, Math.floor(plus))) : 0
  const r = rare ? RARE_TIERS.indexOf(rare) + 1 : 0
  return p + 8 * r
}

/** The inverse of itemCode. */
export function decodeItemCode(code: number): { plus: number; rare: number } {
  const c = Math.max(0, Math.floor(code))
  return { plus: c % 8, rare: Math.floor(c / 8) }
}

// ---- the meshes the crowd draws ------------------------------------------------------------------------------------

/** Meshes the crowd tier draws in their place (hidden, but shown: the rare weapons' effects and glints still pick them). */
export const crowdDrawn = new WeakSet<object>()

/** Whether `mesh` is hidden because the crowd tier draws it (its world matrix follows the instance when it glows). */
export function isCrowdDrawn(mesh: object): boolean {
  return crowdDrawn.has(mesh)
}

// ---- half floats ----------------------------------------------------------------------------------------------------

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** IEEE half of `v` (round to nearest even), as the VAT texture stores it. */
export function toHalf(v: number): number {
  f32[0] = v
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  const e = (x >>> 23) & 0xff
  let m = x & 0x7fffff
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0)
  const he = e - 127 + 15
  if (he >= 0x1f) return sign | 0x7c00
  if (he <= 0) {
    if (he < -10) return sign
    m |= 0x800000
    const shift = 14 - he
    const half = 1 << (shift - 1)
    let r = m >>> shift
    const rest = m & ((1 << shift) - 1)
    if (rest > half || (rest === half && r & 1)) r++
    return sign | r
  }
  let r = (he << 10) | (m >>> 13)
  const rest = m & 0x1fff
  if (rest > 0x1000 || (rest === 0x1000 && r & 1)) r++
  return sign | r
}

/** The float of half `h` (tests). */
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 0x1f) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

/** `src` as halves into `dst` (same length). */
export function halves(src: Float32Array, dst: Uint16Array, from = 0, to = src.length): void {
  for (let i = from; i < to; i++) dst[i] = toHalf(src[i]!)
}
