/**
 * The colour grade of the PBR presets (docs/RENDER.md §5.2, docs/WAVE_PLAN3.md D26): twelve 32³ LUT keys (dawn, day,
 * dusk, night × clear, overcast, rain), blended on the CPU into one RawTexture3D that the post stack's image
 * processing samples after tone mapping, gamma and contrast (display-referred sRGB).
 *
 * The keys are our own art, made from colour-balance parameters (GRADE_TIME, GRADE_WEATHER below). The same
 * functions write the PNG strips (32 × 1024, slice b stacked vertically: pixel (r, b·32 + g)) to
 * apps/game/public/render/luts/ (tools/make-render-textures.ts), so a hand-edited strip can replace a key
 * (`GradeMixer.setStrip`, `loadLutStrips`) and the built-in keys equal the shipped files.
 *
 * Weights: time from the sun elevation (night = smoothstep(+2°, −6°), a golden-hour key below ~20°, dawn before noon
 * and dusk after), weather from the RenderWeather (clear = 1 − cloud, overcast = cloud × (1 − rain), rain = rain,
 * normalised). Only the four largest products are blended (renormalised), and the texture is re-uploaded only when a
 * weight moved by more than 0.01. White balance stays off (6,500 K; RENDER verify): the warm evening and blue night
 * come from the key light colour and these keys. Lane RND-P.
 */
import { Constants, RawTexture3D, Texture, type Scene } from '@babylonjs/core'
import type { RGB } from '../environment.ts'

export const LUT_SIZE = 32
/** Bytes of one RGBA8 LUT (32³ × 4). */
export const LUT_BYTES = LUT_SIZE * LUT_SIZE * LUT_SIZE * 4

export type LutTime = 'dawn' | 'day' | 'dusk' | 'night'
export type LutWeather = 'clear' | 'overcast' | 'rain'
export type LutKey = `${LutTime}_${LutWeather}`

export const LUT_TIMES: readonly LutTime[] = ['dawn', 'day', 'dusk', 'night']
export const LUT_WEATHERS: readonly LutWeather[] = ['clear', 'overcast', 'rain']
/** The twelve keys, time-major (the order of every weight array here). */
export const LUT_KEYS: readonly LutKey[] = LUT_TIMES.flatMap(t => LUT_WEATHERS.map(w => `${t}_${w}` as LutKey))

/** Colour balance of one grade step, in display space. Identity: gain 1, lift 0, gamma 1, saturation 1, contrast 1. */
export interface GradeParams {
  /** Per-channel multiply (a creative white balance: > 1 on red warms). */
  gain: RGB
  /** Per-channel shadow lift: c + lift × (1 − c). */
  lift: RGB
  /** Midtone gamma: c^(1/gamma) (> 1 brightens the mids). */
  gamma: number
  saturation: number
  /** Contrast around the 0.45 pivot. */
  contrast: number
  /**
   * Lighting pass 2 (docs/LIGHTING.md §5): a filmic S-curve blended in by this share (0 = none; toe down, shoulder
   * up, steeper mids), the split tone (shadows × `shadowTint`, highlights × `highlightTint` by luma, at `split`),
   * the skin line (`skin`: orange-red, mid-saturation colours turn towards a yellower hue and keep their saturation,
   * so skin stops reading pink under a warm, saturated grade) and `demagenta` (low-saturation magenta and lavender
   * hues turn towards blue: no lavender faces and walls under the twilight sky).
   */
  curve?: number
  split?: number
  shadowTint?: RGB
  highlightTint?: RGB
  skin?: number
  demagenta?: number
}

export const IDENTITY_GRADE: Readonly<GradeParams> = Object.freeze<GradeParams>({ gain: [1, 1, 1], lift: [0, 0, 0], gamma: 1, saturation: 1, contrast: 1 })

/**
 * The time-of-day grades (our art; tuned in the lab, then in the W9 LOOK calibration: work/tmp/w9-finish/look).
 * W9 LOOK: dusk lost its blue shadow lift (with the red key it read magenta) and some saturation; the night went
 * bluer and deeper (gamma 1.06 → 1, more contrast) now that NIGHT_AMBIENT lights the shadowed sides.
 */
export const GRADE_TIME: Readonly<Record<LutTime, Readonly<GradeParams>>> = {
  // Lighting pass 2 (docs/LIGHTING.md §5): a filmic S-curve, warm sun / cool shadow split tones, the skin line.
  // Dawn: rose-gold highlights over cool shadows.
  dawn: { gain: [1.05, 0.99, 0.94], lift: [0.004, 0.004, 0.014], gamma: 1.02, saturation: 1.08, contrast: 1.02,
    curve: 0.3, split: 1, shadowTint: [0.94, 0.99, 1.08], highlightTint: [1.05, 1.0, 0.93], skin: 0.8, demagenta: 0.4 },
  // Day: warm sun, cool shade, a filmic curve (richer contrast without crushing), colour from separation rather than a
  // global boost; the skin line keeps faces from going pink (G/R towards 0.8).
  day: { gain: [1.02, 1.0, 0.97], lift: [0, 0, 0.004], gamma: 0.98, saturation: 1.06, contrast: 1.0,
    curve: 0.38, split: 1, shadowTint: [0.93, 0.98, 1.09], highlightTint: [1.05, 1.0, 0.93], skin: 1 },
  // Golden hour: amber highlights, deep teal-blue shadows, a strong curve, no magenta.
  dusk: { gain: [1.08, 1.0, 0.86], lift: [0.004, 0.004, 0.008], gamma: 1.0, saturation: 1.08, contrast: 1.0,
    curve: 0.4, split: 1, shadowTint: [0.92, 0.98, 1.1], highlightTint: [1.1, 1.0, 0.84], skin: 0.9, demagenta: 0.8 },
  // Moonlit: dark but readable, silver-blue highlights, deep navy shadows, no lavender.
  night: { gain: [0.82, 0.94, 1.1], lift: [0.003, 0.007, 0.02], gamma: 0.94, saturation: 0.85, contrast: 1.0,
    curve: 0.25, split: 1, shadowTint: [0.9, 0.97, 1.12], highlightTint: [0.98, 1.0, 1.04], skin: 0.5, demagenta: 1 },
}

/** The time grades before lighting pass 2 (the A/B's "before": LIGHT_LOOK.cinematicGrade off). */
export const GRADE_TIME_V1: Readonly<Record<LutTime, Readonly<GradeParams>>> = {
  dawn: { gain: [1.05, 0.99, 0.94], lift: [0.004, 0.004, 0.014], gamma: 1.02, saturation: 1.08, contrast: 1.02 },
  day: { gain: [1.02, 1.0, 0.97], lift: [0, 0, 0.004], gamma: 0.96, saturation: 1.1, contrast: 1.06 },
  dusk: { gain: [1.08, 1.0, 0.86], lift: [0.008, 0.005, 0.002], gamma: 1.02, saturation: 1.06, contrast: 1.03 },
  night: { gain: [0.8, 0.92, 1.12], lift: [0.004, 0.008, 0.024], gamma: 0.9, saturation: 0.9, contrast: 1.03 },
}

/**
 * The weather grades, applied after the time grade (WEATHER §7.4: desaturation under cloud and rain). W9 LOOK: rain
 * and overcast keep their contrast (0.95 and 0.97 with a grey lift washed a storm out) and only desaturate.
 */
export const GRADE_WEATHER: Readonly<Record<LutWeather, Readonly<GradeParams>>> = {
  clear: IDENTITY_GRADE,
  overcast: { gain: [0.98, 1.0, 1.02], lift: [0.002, 0.002, 0.003], gamma: 1, saturation: 0.84, contrast: 1.0 },
  rain: { gain: [0.95, 0.98, 1.03], lift: [0.002, 0.003, 0.005], gamma: 1, saturation: 0.75, contrast: 1.04 },
}

/**
 * The winter grades (docs/WINTER.md §7.6), applied over the blended LUT by the winter weight (frost and snow cover). By
 * day a cold, slightly desaturated balance with a little more contrast (the snow keeps its shape under a flat sky); by
 * night the opposite white balance to the night key's blue (snow under a blue grade read as blue paint), blended by the
 * night weight. Overcast adds contrast.
 */
export const GRADE_WINTER: Readonly<{ day: Readonly<GradeParams>; night: Readonly<GradeParams>; overcastContrast: number }> = {
  day: { gain: [1.0, 1.0, 1.01], lift: [0, 0, 0.002], gamma: 1, saturation: 0.92, contrast: 1.06 },
  night: { gain: [1.03, 1.01, 0.95], lift: [0, 0, 0], gamma: 1, saturation: 0.62, contrast: 1.02 },
  overcastContrast: 0.05,
}

/** The winter step for a night weight (0..1) and an overcast weight (0..1). */
export function winterGrade(night: number, overcast: number, out: GradeParams = { gain: [1, 1, 1], lift: [0, 0, 0], gamma: 1, saturation: 1, contrast: 1 }): GradeParams {
  const n = clamp01(night)
  const d = GRADE_WINTER.day, ni = GRADE_WINTER.night
  for (let i = 0; i < 3; i++) {
    out.gain[i] = d.gain[i]! + (ni.gain[i]! - d.gain[i]!) * n
    out.lift[i] = d.lift[i]! + (ni.lift[i]! - d.lift[i]!) * n
  }
  out.gamma = 1
  out.saturation = d.saturation + (ni.saturation - d.saturation) * n
  out.contrast = d.contrast + (ni.contrast - d.contrast) * n + GRADE_WINTER.overcastContrast * clamp01(overcast) * (1 - n)
  return out
}

/** Mixes the winter step into a LUT in place by `k` (0..1). */
export function applyWinterToLut(data: Uint8Array, p: Readonly<GradeParams>, k: number): void {
  const w = clamp01(k)
  if (w <= 0) return
  const c = [0, 0, 0]
  for (let o = 0; o < data.length; o += 4) {
    c[0] = data[o]! / 255
    c[1] = data[o + 1]! / 255
    c[2] = data[o + 2]! / 255
    const r0 = c[0], g0 = c[1], b0 = c[2]
    gradeColor(c, p)
    data[o] = Math.round((r0 + (c[0]! - r0) * w) * 255)
    data[o + 1] = Math.round((g0 + (c[1]! - g0) * w) * 255)
    data[o + 2] = Math.round((b0 + (c[2]! - b0) * w) * 255)
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** One grade step on a display-space colour (in place). */
export function gradeColor(c: number[], p: Readonly<GradeParams>): number[] {
  for (let i = 0; i < 3; i++) {
    let v = clamp01(c[i]! * p.gain[i]!)
    v = v + p.lift[i]! * (1 - v)
    if (p.gamma !== 1) v = Math.pow(v, 1 / p.gamma)
    c[i] = v
  }
  if (p.split) splitTone(c, p.split, p.shadowTint ?? ONE, p.highlightTint ?? ONE)
  const luma = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
  // The skin line's protection: skin hues get at most half the saturation boost.
  const sat = p.skin && p.saturation > 1 ? 1 + (p.saturation - 1) * (1 - 0.5 * skinWeight(c) * Math.min(1, p.skin)) : p.saturation
  for (let i = 0; i < 3; i++) c[i] = clamp01((luma + (c[i]! - luma) * sat - 0.45) * p.contrast + 0.45)
  if (p.curve) for (let i = 0; i < 3; i++) c[i] = filmicS(c[i]!, p.curve)
  // The skin line and the de-magenta last, so the warm split and the curve cannot push skin back to pink.
  if (p.skin || p.demagenta) hueCorrect(c, p.skin ?? 0, p.demagenta ?? 0)
  return c
}

const ONE: RGB = [1, 1, 1]

/** The filmic S in display space: a smoothstep (slope 0 at black and white) blended in by k. */
export function filmicS(v: number, k: number): number {
  const x = clamp01(v)
  const s = x * x * (3 - 2 * x)
  return x + (s - x) * k
}

/** Split tone: shadows × sTint, highlights × hTint, weighted by luma (luma-preserving). */
function splitTone(c: number[], amount: number, sTint: Readonly<RGB>, hTint: Readonly<RGB>): void {
  const l = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
  const w = smoothstep(0.08, 0.75, l)
  const t0 = 1 + (sTint[0] + (hTint[0] - sTint[0]) * w - 1) * amount
  const t1 = 1 + (sTint[1] + (hTint[1] - sTint[1]) * w - 1) * amount
  const t2 = 1 + (sTint[2] + (hTint[2] - sTint[2]) * w - 1) * amount
  const r = c[0]! * t0, g = c[1]! * t1, b = c[2]! * t2
  const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const k = l2 > 1e-5 ? l / l2 : 1
  c[0] = clamp01(r * k)
  c[1] = clamp01(g * k)
  c[2] = clamp01(b * k)
}

/** Hue (degrees 0..360), saturation (max − min) / max and value of a colour. */
function hueSat(c: readonly number[]): [number, number, number] {
  const r = c[0]!, g = c[1]!, b = c[2]!
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  if (d < 1e-6) return [0, 0, mx]
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, d / Math.max(1e-6, mx), mx]
}

function fromHsv(h: number, s: number, v: number, out: number[]): void {
  const hh = (((h % 360) + 360) % 360) / 60
  const i = Math.floor(hh), f = hh - i
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f))
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]!
  out[0] = rgb[0]!
  out[1] = rgb[1]!
  out[2] = rgb[2]!
}

/** How much a colour is skin: hue −12…45° (full 8–30°), saturation 0.12…0.8 (the red lacquer and roofs are above). */
export function skinWeight(c: readonly number[]): number {
  const [h, s] = hueSat(c)
  const hh = h > 300 ? h - 360 : h
  const wh = smoothstep(-12, 8, hh) * (1 - smoothstep(30, 45, hh))
  const ws = smoothstep(0.12, 0.2, s) * (1 - smoothstep(0.68, 0.8, s))
  return wh * ws
}

/** The skin line (hue towards 34°) and the de-magenta (hues 250–356° at low saturation towards 225°). */
function hueCorrect(c: number[], skin: number, demagenta: number): void {
  const [h, s, v] = hueSat(c)
  if (s < 1e-4) return
  let nh = h
  if (skin > 0) {
    const w = skinWeight(c) * Math.min(1, skin)
    if (w > 0) {
      const hh = h > 300 ? h - 360 : h
      nh = hh + (34 - hh) * 0.75 * w
    }
  }
  if (demagenta > 0 && h >= 250 && h <= 356) {
    const wm = smoothstep(250, 275, h) * (1 - smoothstep(342, 356, h)) * (1 - smoothstep(0.25, 0.45, s)) * Math.min(1, demagenta)
    nh = h + (225 - h) * 0.8 * wm
  }
  if (nh !== h) fromHsv(nh, s, v, c)
}

/**
 * One LUT as a 32 × 1024 RGBA8 strip (= the RawTexture3D byte order: r fastest, then g, then the b slice), built by
 * applying `steps` in order to every lattice colour. No steps = the identity LUT.
 */
export function makeLutStrip(steps: ReadonlyArray<Readonly<GradeParams>>, out = new Uint8Array(LUT_BYTES)): Uint8Array {
  const n = LUT_SIZE
  const c = [0, 0, 0]
  let o = 0
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        c[0] = r / (n - 1)
        c[1] = g / (n - 1)
        c[2] = b / (n - 1)
        for (const s of steps) gradeColor(c, s)
        out[o++] = Math.round(c[0]! * 255)
        out[o++] = Math.round(c[1]! * 255)
        out[o++] = Math.round(c[2]! * 255)
        out[o++] = 255
      }
    }
  }
  return out
}

/** The built-in strip of a key (time grade, then weather grade). */
export function builtinLutStrip(key: LutKey, legacy = false): Uint8Array {
  const [t, w] = key.split('_') as [LutTime, LutWeather]
  return makeLutStrip([(legacy ? GRADE_TIME_V1 : GRADE_TIME)[t], GRADE_WEATHER[w]])
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/**
 * Time weights (dawn, day, dusk, night; sum 1) from the sun elevation and the solar time t (0 = midnight): night =
 * smoothstep(+2°, −6°) (SKY §7, D12), the golden key rises below 20° of elevation and is dawn before noon, dusk after.
 */
export function timeWeights(sunElevationDeg: number, t: number, out = new Float32Array(4)): Float32Array {
  const night = smoothstep(2, -6, sunElevationDeg)
  const golden = (1 - night) * (1 - smoothstep(4, 20, sunElevationDeg))
  const morning = (t - Math.floor(t)) < 0.5
  out[0] = morning ? golden : 0
  out[1] = Math.max(0, 1 - night - golden)
  out[2] = morning ? 0 : golden
  out[3] = night
  return out
}

/** Weather weights (clear, overcast, rain; D26), normalised to sum 1. */
export function weatherWeights(cloud: number, rain: number, out = new Float32Array(3)): Float32Array {
  const c = clamp01(cloud), r = clamp01(rain)
  out[0] = 1 - c
  out[1] = c * (1 - r)
  out[2] = r
  const s = out[0]! + out[1]! + out[2]!
  for (let i = 0; i < 3; i++) out[i] = out[i]! / s
  return out
}

/**
 * The 12 key weights (LUT_KEYS order): time × weather, only the `keep` largest kept and renormalised to sum 1.
 */
export function gradeWeights(
  sunElevationDeg: number, t: number, cloud: number, rain: number, out = new Float32Array(12), keep = 4,
): Float32Array {
  const tw = timeWeights(sunElevationDeg, t, scratchT)
  const ww = weatherWeights(cloud, rain, scratchW)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = tw[i]! * ww[j]!
  // Zero all but the `keep` largest (12 entries: a few passes of a max search, no allocation).
  if (keep < 12) {
    const taken = scratchTaken
    taken.fill(0)
    for (let k = 0; k < keep; k++) {
      let best = -1
      for (let i = 0; i < 12; i++) if (!taken[i] && (best < 0 || out[i]! > out[best]!)) best = i
      taken[best] = 1
    }
    for (let i = 0; i < 12; i++) if (!taken[i]) out[i] = 0
  }
  let s = 0
  for (let i = 0; i < 12; i++) s += out[i]!
  if (s > 0) for (let i = 0; i < 12; i++) out[i] = out[i]! / s
  else out[3] = 1 // day_clear
  return out
}

const scratchT = new Float32Array(4)
const scratchW = new Float32Array(3)
const scratchTaken = new Uint8Array(12)

/** Blends the strips with the weights into `out` (zero weights are skipped). */
export function blendStrips(strips: ReadonlyArray<Uint8Array>, weights: ArrayLike<number>, out: Uint8Array): Uint8Array {
  const used: number[] = []
  for (let k = 0; k < strips.length; k++) if (weights[k]! > 0) used.push(k)
  if (used.length === 1) {
    out.set(strips[used[0]!]!)
    return out
  }
  const acc = blendAcc.length === out.length ? blendAcc : (blendAcc = new Float32Array(out.length))
  acc.fill(0)
  for (const k of used) {
    const s = strips[k]!, w = weights[k]!
    for (let i = 0; i < s.length; i++) acc[i] += s[i]! * w
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.round(acc[i]!))
  return out
}
let blendAcc = new Float32Array(0)

/** The grade inputs of a frame (SkyState and RenderWeather fields). */
export interface GradeInput {
  sunElevationDeg: number
  t: number
  cloud: number
  rain: number
  /** Winter addition (docs/WINTER.md §7.6): 0..1 the winter look; absent = 0 (the keys alone, as before). */
  winter?: number
}

/**
 * The blended LUT: one 32³ RGBA8 RawTexture3D (`texture`, for `imageProcessing.colorGradingTexture`, level 1) fed
 * from the twelve key strips. `update` re-blends and re-uploads only when a weight moved by more than 0.01.
 */
export class GradeMixer {
  static readonly THRESHOLD = 0.01
  readonly texture: RawTexture3D
  /** The weights of the last upload (LUT_KEYS order). */
  readonly uploaded = new Float32Array(12)
  /** Uploads so far (tests, the perf overlay). */
  uploads = 0
  private readonly strips: Uint8Array[]
  private readonly data = new Uint8Array(LUT_BYTES)
  private readonly next = new Float32Array(12)
  private dirty = true
  /** The winter weight of the last upload (docs/WINTER.md §7.6). */
  private winterUploaded = 0
  private readonly winterStep: GradeParams = { gain: [1, 1, 1], lift: [0, 0, 0], gamma: 1, saturation: 1, contrast: 1 }

  constructor(scene: Scene, strips: Partial<Record<LutKey, Uint8Array>> = {}) {
    this.strips = LUT_KEYS.map(k => strips[k] ?? builtinLutStrip(k))
    this.data.set(this.strips[LUT_KEYS.indexOf('day_clear')]!)
    this.texture = new RawTexture3D(
      this.data, LUT_SIZE, LUT_SIZE, LUT_SIZE, Constants.TEXTUREFORMAT_RGBA, scene, false, false,
      Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
    )
    this.texture.name = 'sroGradeLut'
    this.texture.wrapU = this.texture.wrapV = this.texture.wrapR = Texture.CLAMP_ADDRESSMODE
    this.texture.level = 1
  }

  /** The lab's A/B: the built-in keys of before lighting pass 2 (true) or today's (false); the next update re-uploads. */
  setLegacy(legacy: boolean): void {
    if (legacy === this.legacy) return
    this.legacy = legacy
    for (let i = 0; i < LUT_KEYS.length; i++) this.strips[i] = builtinLutStrip(LUT_KEYS[i]!, legacy)
    this.dirty = true
  }

  private legacy = false

  /** Replaces one key's strip (a loaded PNG); the next update re-uploads. */
  setStrip(key: LutKey, strip: Uint8Array): void {
    if (strip.length !== LUT_BYTES) throw new Error(`[grade] ${key}: ${strip.length} bytes, want ${LUT_BYTES}`)
    this.strips[LUT_KEYS.indexOf(key)] = strip
    this.dirty = true
  }

  /** Per frame; true when the LUT was re-uploaded. */
  update(g: Readonly<GradeInput>): boolean {
    const w = gradeWeights(g.sunElevationDeg, g.t, g.cloud, g.rain, this.next)
    const winter = clamp01(g.winter ?? 0)
    if (!this.dirty) {
      let moved = Math.abs(winter - this.winterUploaded)
      for (let i = 0; i < 12; i++) moved = Math.max(moved, Math.abs(w[i]! - this.uploaded[i]!))
      if (moved <= GradeMixer.THRESHOLD && !(winter === 0 && this.winterUploaded !== 0)) return false
    }
    this.uploaded.set(w)
    this.winterUploaded = winter
    this.dirty = false
    blendStrips(this.strips, w, this.data)
    if (winter > 0) {
      // night = the night keys' weight; overcast = the overcast and rain keys' (LUT_KEYS: time-major, 3 weathers each)
      let night = 0
      let overcast = 0
      for (let i = 0; i < 12; i++) {
        if (i >= 9) night += w[i]!
        if (i % 3 !== 0) overcast += w[i]!
      }
      applyWinterToLut(this.data, winterGrade(night, overcast, this.winterStep), winter)
    }
    this.texture.update(this.data)
    this.uploads++
    return true
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/**
 * Loads edited strips (32 × 1024 PNGs named `<key>.png`) from `baseUrl` in the browser. Missing or malformed files
 * are skipped (the built-in key stays), so a partial set is fine.
 */
export async function loadLutStrips(baseUrl: string, keys: readonly LutKey[] = LUT_KEYS): Promise<Partial<Record<LutKey, Uint8Array>>> {
  const out: Partial<Record<LutKey, Uint8Array>> = {}
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return out
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  await Promise.all(keys.map(async key => {
    try {
      const res = await fetch(`${base}${key}.png`)
      if (!res.ok) return
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      if (bmp.width !== LUT_SIZE || bmp.height !== LUT_SIZE * LUT_SIZE) return
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')
      if (!ctx) return
      ctx.drawImage(bmp, 0, 0)
      out[key] = new Uint8Array(ctx.getImageData(0, 0, bmp.width, bmp.height).data.buffer)
    } catch {
      // Keep the built-in key.
    }
  }))
  return out
}
