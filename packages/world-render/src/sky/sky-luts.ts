/**
 * Sliced sky-view LUTs (docs/SKY.md §3.2, §3.5): a rebuild runs a few rows per frame into a staging buffer, each row
 * packed to half floats as it finishes (not all at once on the last frame), and the GPU texture is updated once when
 * the last row is done, so a half-built LUT is never visible. The finished LUT also stays on the CPU (`rgb`) for the
 * irradiance, the fog colour, the SH and the IBL cube.
 *
 * The texture is RGBA16F (filterable on WebGL2 and WebGPU), linear, clamped; alpha is 1.
 */
import { Constants, RawTexture, type Scene } from '@babylonjs/core'
import type { Atmosphere } from './atmosphere.ts'

// ---- half floats ------------------------------------------------------------------------------------------------

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/** float → IEEE half bits (round to nearest even; overflow → ±inf, NaN kept, subnormals kept). */
export function toHalf(v: number): number {
  F32[0] = v
  const x = U32[0]!
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0)
  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    mant |= 0x800000
    const shift = 14 - e
    const half = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const mid = 1 << (shift - 1)
    return sign | (half + (rem > mid || (rem === mid && (half & 1)) ? 1 : 0))
  }
  const half = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  return sign | (half + (rem > 0x1000 || (rem === 0x1000 && (half & 1)) ? 1 : 0))
}

/** IEEE half bits → float. */
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 0x1f) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

/** Packs RGB f32 rows [from, to) of a W-wide image into RGBA half floats (alpha 1). */
export function packRowsHalf(rgb: Float32Array, out: Uint16Array, W: number, from: number, to: number): void {
  const one = 0x3c00
  for (let i = from * W, end = to * W; i < end; i++) {
    out[i * 4] = toHalf(rgb[i * 3]!)
    out[i * 4 + 1] = toHalf(rgb[i * 3 + 1]!)
    out[i * 4 + 2] = toHalf(rgb[i * 3 + 2]!)
    out[i * 4 + 3] = one
  }
}

// ---- one sky-view LUT (sun or moon) -------------------------------------------------------------------------------

interface LutJob {
  atm: Atmosphere
  el: number
  steps: number
  row: number
}

export class SkyViewLut {
  /** The finished LUT (RGB f32, W × H), what the texture shows. */
  rgb: Float32Array
  /** Light elevation (rad) and atmosphere the finished LUT was built for (NaN / null before the first build). */
  builtEl = NaN
  builtAtm: Atmosphere | null = null
  /** The GPU copy (null headless before `ensureTexture`, or after dispose). */
  texture: RawTexture | null = null
  /** Finished rebuilds (tests, the perf overlay). */
  builds = 0
  private staging: Float32Array
  /** Half floats of the finished LUT (what the texture holds) and of the running job. */
  private half: Uint16Array
  private halfStaging: Uint16Array
  private job: LutJob | null = null

  constructor(readonly W: number, readonly H: number, readonly name: string) {
    this.rgb = new Float32Array(W * H * 3)
    this.staging = new Float32Array(W * H * 3)
    this.half = new Uint16Array(W * H * 4)
    this.halfStaging = new Uint16Array(W * H * 4)
    packRowsHalf(this.rgb, this.half, W, 0, H)
  }

  /** The texture (made on first use; updated with every finished build). */
  ensureTexture(scene: Scene): RawTexture {
    if (this.texture) return this.texture
    const tex = new RawTexture(this.half, this.W, this.H, Constants.TEXTUREFORMAT_RGBA, scene, false, false,
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT)
    tex.name = this.name
    tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE
    tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE
    tex.gammaSpace = false
    this.texture = tex
    return tex
  }

  get busy(): boolean {
    return this.job !== null
  }

  /** Starts (or restarts) a sliced rebuild for a light at `el` (rad). */
  start(atm: Atmosphere, el: number, steps: number): void {
    this.job = { atm, el, steps, row: 0 }
  }

  /** Builds up to `rows` rows of the running job; true when this call finished it (texture updated). */
  step(rows: number): boolean {
    const j = this.job
    if (!j) return false
    const to = Math.min(this.H, j.row + Math.max(1, rows))
    j.atm.skyViewRows(this.staging, this.W, this.H, j.el, j.steps, j.row, to)
    packRowsHalf(this.staging, this.halfStaging, this.W, j.row, to)
    j.row = to
    if (to < this.H) return false
    this.finish(j)
    return true
  }

  /** The whole LUT now (a time jump, the first frame): one frame of ~3–7 ms instead of a sliced refresh. */
  buildNow(atm: Atmosphere, el: number, steps: number): void {
    const j: LutJob = { atm, el, steps, row: 0 }
    atm.skyViewRows(this.staging, this.W, this.H, el, steps, 0, this.H)
    packRowsHalf(this.staging, this.halfStaging, this.W, 0, this.H)
    this.finish(j)
  }

  private finish(j: LutJob): void {
    const done = this.staging
    this.staging = this.rgb
    this.rgb = done
    const half = this.halfStaging
    this.halfStaging = this.half
    this.half = half
    this.builtEl = j.el
    this.builtAtm = j.atm
    this.builds++
    this.job = null
    this.texture?.update(this.half)
  }

  dispose(): void {
    this.texture?.dispose()
    this.texture = null
    this.job = null
  }
}
