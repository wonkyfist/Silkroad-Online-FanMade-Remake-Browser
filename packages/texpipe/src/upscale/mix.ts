/**
 * TP-U model choice and the AI/Lanczos mix (docs/TEXPIPE.md §3.3, §3.4 "Model per class", §7.3).
 *
 * - `realesrgan-x4plus` for natural and photographic surfaces (terrain, stone, walls, roofs, bark, cloth, metal,
 *   skin): 10.1 s per source Mpx on the RX 9060 XT.
 * - `realesrgan-x4plus-anime` only for hair and flat paint (3.4 s/Mpx). It flattens grass to one green and invents
 *   panel lines on walls [TEXPIPE §7.3], so it is never picked for a natural class; flat paint is chosen per texture
 *   in the review (`overrides.json` `upscale.model`).
 * - `lanczos`: no AI (a texture the review rejects, status `retail`, or a run without the exe).
 *
 * The result is `mix × AI + (1 − mix) × Lanczos` per texel: the Lanczos share tames the DXT block noise the model
 * reads as detail (the "embossed" plaza marble). Stone 0.6 until a 1× de-blocking pass exists (§3.3), metal 0.7, skin
 * 0.5, everything else 0.8; `upscale.aiMix` overrides it per texture.
 *
 * **Tone match** (B0 tuning): before the mix, the AI output's local tone is matched to the Lanczos reference, so the
 * model adds detail but does not change the brightness the retail art was painted at:
 *
 *   gain = blur(Y_lanczos, σ) / blur(Y_ai, σ)      Y = linear luminance, σ = TONE_SIGMA source texels, wrap-aware
 *   ai_lin ×= clamp(gain, ½, 2)                     one factor for R, G and B (hue kept)
 *
 * Measured on B0: x4plus darkened the field grass by 42–45 % and the tree bark by 24 % in mean linear luminance (it
 * deepens every gap between blades and bark ridges); the plaza, walls and actors by 0–13 %. Detail finer than σ is
 * the model's; everything coarser is the source's.
 */
import sharp from 'sharp'
import { blurBuffer, linToSrgb, srgbToLin } from '../pbr/image.ts'
import type { MaterialClass } from '../../../world-render/src/pbr/classes.ts'
import type { PbrStatus, UpscaleModel, UpscaleOverride } from '../format.ts'
import { rawImage, type RawImage } from './pad.ts'

export { UPSCALE_MODELS, type UpscaleModel } from '../format.ts'
/** The models that run through Real-ESRGAN (the rest are resampling only). */
export const AI_MODELS: readonly UpscaleModel[] = ['realesrgan-x4plus', 'realesrgan-x4plus-anime']

/** The AI share of the mix per class (TEXPIPE §3.4). */
export const AI_MIX: Readonly<Record<MaterialClass, number>> = {
  water: 0.8,
  metal: 0.7,
  roof_tile: 0.8,
  stone: 0.6,
  wood: 0.8,
  cloth: 0.8,
  foliage: 0.8,
  ground_soil: 0.8,
  ground_grass: 0.8,
  skin: 0.5,
  default: 0.8,
}

/** Hair atlases, by file name (the classes have no hair class; RENDER §3.3 files hair under `default`). */
const HAIR = /(^|[/_])hair([_.\d]|$)/

export interface UpscalePlan {
  model: UpscaleModel
  /** AI share 0..1 (0 for `lanczos`). */
  aiMix: number
  /** Why this model (for the report). */
  reason: string
}

/** The file name of a key (`prim/.../chinaman_adventurer_hair.ddj` → `chinaman_adventurer_hair.ddj`). */
function fileOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1).replace(/^tile2d:/, '')
}

/** Model and mix for one texture: the override, else the status, else hair → anime, else x4plus with the class mix. */
export function planFor(key: string, cls: MaterialClass, override?: UpscaleOverride, status?: PbrStatus): UpscalePlan {
  const hair = HAIR.test(fileOf(key))
  let model: UpscaleModel = hair ? 'realesrgan-x4plus-anime' : 'realesrgan-x4plus'
  let reason = hair ? 'hair' : `class ${cls}`
  if (status === 'retail') {
    model = 'lanczos'
    reason = 'status retail'
  }
  if (override?.model) {
    model = override.model
    reason = 'override'
  }
  let aiMix = model === 'lanczos' ? 0 : AI_MIX[cls] ?? AI_MIX.default
  if (override?.aiMix !== undefined && model !== 'lanczos') aiMix = Math.min(1, Math.max(0, override.aiMix))
  return { model, aiMix, reason }
}

/** `t × ai + (1 − t) × lanczos` per byte (same size and channels). */
export function mixImages(ai: RawImage, lanczos: RawImage, t: number): RawImage {
  if (ai.width !== lanczos.width || ai.height !== lanczos.height || ai.channels !== lanczos.channels) {
    throw new Error(`mix: ${ai.width}x${ai.height}x${ai.channels} vs ${lanczos.width}x${lanczos.height}x${lanczos.channels}`)
  }
  if (t >= 1) return ai
  if (t <= 0) return lanczos
  const out = rawImage(ai.width, ai.height, ai.channels)
  const a = ai.data
  const l = lanczos.data
  for (let i = 0; i < a.length; i++) out.data[i] = Math.round(l[i]! + (a[i]! - l[i]!) * t)
  return out
}

/** σ of the tone match in source texels (× the upscale factor in master pixels). */
export const TONE_SIGMA = 2
export const TONE_GAIN_MIN = 0.5
export const TONE_GAIN_MAX = 2

const LIN8 = Float32Array.from({ length: 256 }, (_, i) => srgbToLin(i / 255))

function lumaLinear(im: RawImage): Float32Array {
  const n = im.width * im.height, c = im.channels, d = im.data
  const y = new Float32Array(n)
  for (let p = 0; p < n; p++) y[p] = 0.2126 * LIN8[d[p * c]!]! + 0.7152 * LIN8[d[p * c + 1]!]! + 0.0722 * LIN8[d[p * c + 2]!]!
  return y
}

/**
 * The AI output with its local tone matched to `ref` (see the header). Same size and channels (3 or 4; alpha is
 * copied). `sigma` in pixels of these images; `wrap` = the axes that repeat.
 */
export function toneMatch(ai: RawImage, ref: RawImage, sigma: number, wrap: readonly [boolean, boolean]): RawImage {
  if (ai.width !== ref.width || ai.height !== ref.height || ai.channels < 3 || ref.channels < 3) {
    throw new Error(`toneMatch: ${ai.width}x${ai.height}x${ai.channels} vs ${ref.width}x${ref.height}x${ref.channels}`)
  }
  const { width: w, height: h, channels: c } = ai
  const edges = [wrap[0] ? 'wrap' : 'clamp', wrap[1] ? 'wrap' : 'clamp'] as const
  const ya = blurBuffer(lumaLinear(ai), w, h, sigma, edges)
  const yr = blurBuffer(lumaLinear(ref), w, h, sigma, edges)
  const out = rawImage(w, h, c)
  const a = ai.data, o = out.data
  for (let p = 0; p < w * h; p++) {
    const g = ya[p]! > 1e-5 ? Math.min(TONE_GAIN_MAX, Math.max(TONE_GAIN_MIN, yr[p]! / ya[p]!)) : 1
    for (let k = 0; k < 3; k++) o[p * c + k] = Math.round(255 * linToSrgb(Math.min(1, LIN8[a[p * c + k]!]! * g)))
    if (c === 4) o[p * c + 3] = a[p * c + 3]!
  }
  return out
}

/** Lanczos3 resize through sharp (1, 3 or 4 channels, no premultiplication: alpha is resized on its own). */
export async function resizeLanczos(img: RawImage, width: number, height: number): Promise<RawImage> {
  if (img.width === width && img.height === height) return img
  if (img.channels === 4) throw new Error('resizeLanczos: resize RGB and alpha separately')
  let s = sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels as 1 | 3 } })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
  // sharp widens a 1-channel raw input to sRGB on output unless told to keep it grey.
  if (img.channels === 1) s = s.toColourspace('b-w')
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== img.channels) throw new Error(`resizeLanczos: sharp returned ${info.channels} channels for ${img.channels}`)
  return rawImage(info.width, info.height, info.channels, new Uint8Array(data.buffer, data.byteOffset, data.length))
}

/** Nearest-neighbour integer upscale (the "retail" column of the sheets, and the tests' stub upscaler). */
export function upscaleNearest(img: RawImage, scale: number): RawImage {
  const W = img.width * scale
  const H = img.height * scale
  const c = img.channels
  const out = rawImage(W, H, c)
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / scale)
    for (let x = 0; x < W; x++) {
      const s = (sy * img.width + Math.floor(x / scale)) * c
      const d = (y * W + x) * c
      for (let k = 0; k < c; k++) out.data[d + k] = img.data[s + k]!
    }
  }
  return out
}
