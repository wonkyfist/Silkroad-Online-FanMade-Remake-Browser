/**
 * TP-E encode (docs/WAVE_PLAN3.md §7.1 TP-E, docs/TEXPIPE.md §6.1–6.2 and §7.4): one TP-P master folder
 * (`work/texpipe/master/<keyPath>/`, pbr/job.ts) → the v1 WebP tiers of one `sro-pbr` set under
 * `work/out/pbr/<keyPath>/`, and the set's record for `pbr/index.json` (format.ts; index-writer.ts writes the index).
 *
 * Tiers (TEXPIPE §6.1): the long edges retail size, 1024 and 2048, only those ≤ the master's long edge, plus the '2x'
 * tier, min(2 × the retail long edge, 1024) (TIER_2X_CAP): High's albedo tier (§6.4), named by the set's `tier2x`.
 * The retail tier is the source size exactly (Medium's "remastered albedo at retail size"); the others keep the
 * master's aspect.
 *
 * v1 files per tier (`<map>@<tier>.webp`, TEXPIPE §7.4's measured settings):
 *   albedo      sRGB RGB(A), lossy q90; alpha lossless (alphaQuality 100) for cutout and blend, none otherwise (a
 *               specmask's alpha became the metal plane). Downsampled with Lanczos3 from the 8-bit master, wrap-padded
 *               along the wrap axes; a cutout's alpha is rescaled so its coverage at the cutoff matches the master's
 *               (the coverage-preserving rule TP-U uses for mips).
 *   nx, ny      the tangent-space normal as two linear grey planes (byte = 128 + 127·v, format.ts), full tier size,
 *               q90 (sources ≤ 64 px: near-lossless 60, TEXPIPE §7.4's roof row). Area-averaged from the 16-bit
 *               master, then renormalised, so the rebuilt z = sqrt(1 − x² − y²) is a unit normal.
 *   ao, rough   linear grey planes at half the tier size, q90 (ORMH R and G, D37).
 *   metal       the same, only when some texel is metallic (the runtime treats a missing plane as 0).
 *   height      a linear grey plane at the full tier size, q90 (ORMH A).
 * `albedo-only` (the review status, or TP-P's own verdict) keeps only the albedo; `retail` and `replaced` ship no
 * files (the set stays in the index with no tiers, so the runtime keeps the retail texture).
 *
 * Optional KTX2 (v2, `--ktx2`, TP-K's encoder, ktx2.ts): one file per map at the set size, next to the WebP tiers:
 * `albedo@<size>.ktx2` (UASTC sRGB; a cutout carries its coverage-preserving mip chain as explicit levels),
 * `normal@<size>.ktx2` (packed RGB, UASTC normal-map mode) and `ormh@<size>.ktx2` (UASTC linear RGBA). Kept across
 * runs while the master is unchanged, whether or not `--ktx2` is given again.
 *
 * Cache: `work/texpipe/cache/encode/<keyPath>.json` holds the content hash of the WebP and KTX2 outputs (the master's
 * own hash, the mode, the settings); a set whose files all exist with the same hash is not re-encoded. The review
 * metadata (status, hero, class, params) is not part of the hash: changing a status re-encodes only when it changes
 * the files (albedo-only, retail).
 *
 * Node only; everything stays on this PC (D43).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp, { type WebpOptions as SharpWebpOptions } from 'sharp'
import type { MaterialClass } from '../../world-render/src/pbr/classes.ts'
import {
  encodeNormalComponent, keyPath, normalZ, ORMH, pbrFile, NORMAL_PLANE_SCALE, NORMAL_PLANE_ZERO,
  TIER_2X_CAP, type AlphaKind, type DetailRoute, type PbrSet, type PbrStatus, type PbrTier, type TexpipeOverrides,
} from './format.ts'
import { img, type Img } from './pbr/image.ts'
import { readImage } from './pbr/io.ts'
import { coverage, coverageScale } from './upscale/alpha.ts'
import { sha1, writeAtomic } from './upscale/cache.ts'

/** Bump when the encoder's output changes for the same master (re-encodes every set). */
export const ENCODE_VERSION = 3
/** The fixed tier long edges above the retail size (TEXPIPE §6.1). */
export const TIER_EDGES = [1024, 2048] as const
/** WebP settings (TEXPIPE §7.4: albedo q90, planes q90, tiny normals near-lossless 60). */
export const WEBP_QUALITY = 90
export const TINY_NORMAL_NEAR_LOSSLESS = 60
/** Sources whose short edge is at most this are "tiny" (TEXPIPE §7.3: the 64-px roof). */
export const TINY_SOURCE = 64
/** Texels padded around a wrap axis before the albedo's Lanczos3 downsample, in tier texels. */
const WRAP_PAD = 8
/** The metal plane is written only when some texel reaches this (0..1). */
const METAL_MIN = 1 / 255

// ---- tiers --------------------------------------------------------------------------------------------------------

export interface TierPlan {
  /** The tier name: its long edge ('512', '1024', '2048'). */
  name: string
  size: [number, number]
  /** The size of the ao/rough/metal planes (half the tier, at least 1). */
  half: [number, number]
  /** This tier is the retail source size. */
  retail: boolean
  /** This tier is the '2x' tier (min(2 × retail, 1024)): High's albedo tier. */
  x2: boolean
}

const halfOf = (s: readonly [number, number]): [number, number] => [Math.max(1, Math.round(s[0] / 2)), Math.max(1, Math.round(s[1] / 2))]

/** The long edge of the '2x' tier: min(2 × the retail long edge, TIER_2X_CAP), never above the master's. */
export function tier2xEdge(source: readonly [number, number], master: readonly [number, number]): number {
  return Math.min(2 * Math.max(source[0], source[1]), TIER_2X_CAP, Math.max(master[0], master[1]))
}

/**
 * The tiers of a set: retail size, the '2x' tier (min(2 × retail, 1024), High's albedo tier), 1024, 2048, each ≤ the
 * master's long edge, plus the master's own size (which only adds a tier when the master is under 2048 and not 1024:
 * a 128-px source gets 128, 256 and 512), smallest first.
 */
export function tierPlan(source: readonly [number, number], master: readonly [number, number]): TierPlan[] {
  const mLong = Math.max(master[0], master[1])
  const sLong = Math.max(source[0], source[1])
  const x2 = tier2xEdge(source, master)
  const edges = new Set<number>()
  if (sLong <= mLong) edges.add(sLong)
  edges.add(x2)
  for (const e of TIER_EDGES) if (e <= mLong) edges.add(e)
  // A master below 1024 (a source under 256 px) ships at its own size too, or its upscale would never be used.
  edges.add(mLong)
  return [...edges].sort((a, b) => a - b).map(edge => {
    const size: [number, number] = edge === sLong
      ? [source[0], source[1]]
      : edge === mLong ? [master[0], master[1]] : [Math.max(1, Math.round((master[0] * edge) / mLong)), Math.max(1, Math.round((master[1] * edge) / mLong))]
    return { name: String(edge), size, half: halfOf(size), retail: edge === sLong, x2: edge === x2 }
  })
}

// ---- resampling -----------------------------------------------------------------------------------------------------

/** Per-output-texel source ranges and weights of a 1-D area (box) resample from n to m texels. */
function axisWeights(n: number, m: number): { start: Int32Array; idx: Int32Array; w: Float32Array } {
  const start = new Int32Array(m + 1)
  const idx: number[] = []
  const ws: number[] = []
  const f = n / m
  for (let i = 0; i < m; i++) {
    start[i] = idx.length
    const a = i * f, b = (i + 1) * f
    for (let j = Math.floor(a); j < Math.min(n, Math.ceil(b)); j++) {
      const o = Math.min(b, j + 1) - Math.max(a, j)
      if (o > 1e-9) {
        idx.push(j)
        ws.push(o / f)
      }
    }
  }
  start[m] = idx.length
  return { start, idx: Int32Array.from(idx), w: Float32Array.from(ws) }
}

/**
 * Area-weighted resample to w×h (each output texel the exact mean of the source area it covers). For a whole-number
 * ratio it is the box mip filter; it never reads across an edge, so a tileable input stays tileable.
 */
export function areaResize(im: Img, w: number, h: number): Img {
  if (w === im.w && h === im.h) return im
  const c = im.c
  const ax = axisWeights(im.w, w), ay = axisWeights(im.h, h)
  const t = img(w, im.h, c)
  for (let y = 0; y < im.h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * c
      for (let q = ax.start[x]!; q < ax.start[x + 1]!; q++) {
        const s = (y * im.w + ax.idx[q]!) * c, wt = ax.w[q]!
        for (let k = 0; k < c; k++) t.d[o + k]! += im.d[s + k]! * wt
      }
    }
  }
  const out = img(w, h, c)
  for (let y = 0; y < h; y++) {
    for (let q = ay.start[y]!; q < ay.start[y + 1]!; q++) {
      const row = ay.idx[q]!, wt = ay.w[q]!
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * c, s = (row * w + x) * c
        for (let k = 0; k < c; k++) out.d[o + k]! += t.d[s + k]! * wt
      }
    }
  }
  return out
}

// ---- normals ------------------------------------------------------------------------------------------------------

/** The master's normal.png (n · 0.5 + 0.5, any channel count ≥ 3) as unit normals in −1..1 (3 channels). */
export function normalsFromRgb(rgb: Img): Img {
  const n = img(rgb.w, rgb.h, 3)
  for (let p = 0; p < rgb.w * rgb.h; p++) for (let k = 0; k < 3; k++) n.d[p * 3 + k] = rgb.d[p * rgb.c + k]! * 2 - 1
  return renormalize(n)
}

/** Every texel scaled to unit length (a zero vector becomes +Z). In place; returns `n`. */
export function renormalize(n: Img): Img {
  for (let p = 0; p < n.w * n.h; p++) {
    const x = n.d[p * 3]!, y = n.d[p * 3 + 1]!, z = n.d[p * 3 + 2]!
    const l = Math.hypot(x, y, z)
    if (l < 1e-8) {
      n.d[p * 3] = 0
      n.d[p * 3 + 1] = 0
      n.d[p * 3 + 2] = 1
    } else {
      n.d[p * 3] = x / l
      n.d[p * 3 + 1] = y / l
      n.d[p * 3 + 2] = z / l
    }
  }
  return n
}

/** Unit normals at w×h: area-averaged, then renormalised (a mip of a normal map is shorter than 1). */
export function normalsAt(n: Img, w: number, h: number): Img {
  return w === n.w && h === n.h ? n : renormalize(areaResize(n, w, h))
}

/**
 * The longest (x, y) the planes carry. A normal steeper than asin(0.97) ≈ 76° is pulled up to it, so the few levels
 * of lossy error cannot push x² + y² past 1, where the rebuilt z would be 0 and the vector longer than unit (the
 * "unit within 0.02" check). Almost no texel is that steep; the cost is counted in the angular error.
 */
export const NORMAL_XY_MAX = 0.97

/** The two v1 normal planes (nx, ny) of unit normals. */
export function normalPlanes(n: Img): { nx: Uint8Array; ny: Uint8Array } {
  const px = n.w * n.h
  const nx = new Uint8Array(px), ny = new Uint8Array(px)
  for (let p = 0; p < px; p++) {
    let x = n.d[p * 3]!, y = n.d[p * 3 + 1]!
    const l = Math.hypot(x, y)
    if (l > NORMAL_XY_MAX) {
      x *= NORMAL_XY_MAX / l
      y *= NORMAL_XY_MAX / l
    }
    nx[p] = encodeNormalComponent(x)
    ny[p] = encodeNormalComponent(y)
  }
  return { nx, ny }
}

/**
 * What the runtime rebuilds from the planes (TEXPIPE §6.3): x and y from the bytes, z = sqrt(1 − x² − y²), no
 * renormalisation. Where lossy coding pushed x² + y² past 1, z is 0 and the vector is longer than 1.
 */
export function rebuildNormals(nx: Uint8Array, ny: Uint8Array, w: number, h: number): Img {
  const o = img(w, h, 3)
  for (let p = 0; p < w * h; p++) {
    const x = (nx[p]! - NORMAL_PLANE_ZERO) / NORMAL_PLANE_SCALE
    const y = (ny[p]! - NORMAL_PLANE_ZERO) / NORMAL_PLANE_SCALE
    o.d[p * 3] = x
    o.d[p * 3 + 1] = y
    o.d[p * 3 + 2] = normalZ(x, y)
  }
  return o
}

export interface NormalError {
  /** Mean and 99th-percentile angle (degrees) between the reference and the rebuilt normal. */
  meanDeg: number
  p99Deg: number
  /** The largest |length − 1| of a rebuilt normal (the "unit within 0.02" check). */
  maxLenErr: number
}

/** Angular error of rebuilt normals against unit reference normals (both 3 channels, same size). */
export function normalError(ref: Img, got: Img): NormalError {
  const BINS = 9000 // 0.01° bins up to 90°, then one overflow bin
  const hist = new Uint32Array(BINS + 1)
  let sum = 0, maxLen = 0
  const px = ref.w * ref.h
  for (let p = 0; p < px; p++) {
    const gx = got.d[p * 3]!, gy = got.d[p * 3 + 1]!, gz = got.d[p * 3 + 2]!
    const l = Math.hypot(gx, gy, gz)
    maxLen = Math.max(maxLen, Math.abs(l - 1))
    const d = l > 0 ? (ref.d[p * 3]! * gx + ref.d[p * 3 + 1]! * gy + ref.d[p * 3 + 2]! * gz) / l : 0
    const a = (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
    sum += a
    hist[Math.min(BINS, Math.floor(a * 100))]!++
  }
  let acc = 0, p99 = 90
  for (let b = 0; b <= BINS; b++) {
    acc += hist[b]!
    if (acc >= px * 0.99) {
      p99 = (b + 1) / 100
      break
    }
  }
  const r = (v: number) => +v.toFixed(3)
  return { meanDeg: r(px ? sum / px : 0), p99Deg: r(p99), maxLenErr: r(maxLen) }
}

// ---- byte images ------------------------------------------------------------------------------------------------------

export interface Bytes {
  w: number
  h: number
  c: number
  data: Uint8Array
}

const toBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)

/** Channel k of a float image (0..1) as bytes. */
export function planeBytes(im: Img, k = 0): Uint8Array {
  const px = im.w * im.h
  const o = new Uint8Array(px)
  for (let p = 0; p < px; p++) o[p] = Math.round(Math.max(0, Math.min(1, im.d[p * im.c + k]!)) * 255)
  return o
}

async function decodeBytes(input: string | Buffer, channels: 1 | 3 | 4): Promise<Bytes> {
  // Files are read into memory first: sharp's cache keeps a file it opened by path open on Windows, and a later write
  // of that path in the same process then fails.
  let s = sharp(typeof input === 'string' ? readFileSync(input) : input)
  if (channels === 4) s = s.ensureAlpha()
  else s = s.removeAlpha()
  if (channels === 1) s = s.extractChannel(0)
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, c: info.channels, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }
}

/** Decodes a WebP (or any image) plane to one byte channel (R of the decoded RGB). */
export async function decodePlane(file: string | Buffer): Promise<Bytes> {
  return decodeBytes(file, 1)
}

export type WebpOptions = SharpWebpOptions

/** WebP bytes of a raw 1, 3 or 4 channel image. */
export async function webp(b: Bytes, opts: WebpOptions): Promise<Buffer> {
  return sharp(toBuffer(b.data), { raw: { width: b.w, height: b.h, channels: b.c as 1 | 3 | 4 } }).webp(opts).toBuffer()
}

export const ALBEDO_WEBP: WebpOptions = { quality: WEBP_QUALITY, alphaQuality: 100, smartSubsample: true, effort: 4 }
export const PLANE_WEBP: WebpOptions = { quality: WEBP_QUALITY, effort: 4 }
export const TINY_NORMAL_WEBP: WebpOptions = { nearLossless: true, quality: TINY_NORMAL_NEAR_LOSSLESS, effort: 4 }

/**
 * The albedo at w×h: Lanczos3 (sharp premultiplies alpha), with the texture wrapped around its repeat axes first
 * (`repeat` padding, clamped `copy` on the other axis) when the ratio is a whole number, so a tile's edges are
 * filtered with the opposite edge instead of a clamp.
 */
export async function resizeAlbedo(src: Bytes, w: number, h: number, wrap: readonly [boolean, boolean]): Promise<Bytes> {
  if (w === src.w && h === src.h) return src
  const rx = src.w / w, ry = src.h / h
  const pad = (wrap[0] || wrap[1]) && Number.isInteger(rx) && Number.isInteger(ry) && rx === ry
  const raw = { width: src.w, height: src.h, channels: src.c as 3 | 4 }
  let input: Buffer = toBuffer(src.data)
  let info = raw
  let p = 0
  if (pad) {
    p = WRAP_PAD * rx
    const a = await sharp(input, { raw: info }).extend({ left: p, right: p, extendWith: wrap[0] ? 'repeat' : 'copy' }).raw().toBuffer({ resolveWithObject: true })
    const b = await sharp(a.data, { raw: { width: a.info.width, height: a.info.height, channels: src.c as 3 | 4 } })
      .extend({ top: p, bottom: p, extendWith: wrap[1] ? 'repeat' : 'copy' }).raw().toBuffer({ resolveWithObject: true })
    input = b.data
    info = { width: b.info.width, height: b.info.height, channels: src.c as 3 | 4 }
  }
  const tw = w + 2 * (p / rx), th = h + 2 * (p / ry)
  let s = sharp(input, { raw: info }).resize(tw, th, { kernel: 'lanczos3', fit: 'fill' })
  if (pad) s = sharp(await s.raw().toBuffer(), { raw: { width: tw, height: th, channels: src.c as 3 | 4 } }).extract({ left: p / rx, top: p / ry, width: w, height: h })
  const { data, info: oi } = await s.raw().toBuffer({ resolveWithObject: true })
  if (oi.width !== w || oi.height !== h || oi.channels !== src.c) throw new Error(`resizeAlbedo: got ${oi.width}x${oi.height}x${oi.channels}, wanted ${w}x${h}x${src.c}`)
  return { w, h, c: src.c, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }
}

/** The alpha channel of RGBA bytes. */
function alphaOf(b: Bytes): Uint8Array {
  const a = new Uint8Array(b.w * b.h)
  for (let p = 0; p < a.length; p++) a[p] = b.data[p * 4 + 3]!
  return a
}

/** Scales a cutout's alpha (in place) so its coverage at the cutoff is `target`; returns the scale. */
export function keepCoverage(b: Bytes, target: number): number {
  if (b.c !== 4) return 1
  const s = coverageScale(alphaOf(b), target)
  if (s !== 1) for (let p = 0; p < b.w * b.h; p++) b.data[p * 4 + 3] = Math.min(255, Math.round(b.data[p * 4 + 3]! * s))
  return s
}

/**
 * A coverage-preserving mip chain of RGBA bytes down to 1×1 (each level max(1, ⌊w/2⌋) × max(1, ⌊h/2⌋), the KTX2
 * rule): colour box-filtered with premultiplied alpha, alpha rescaled to level 0's coverage at the cutoff.
 */
export function cutoutMips(level0: Bytes): Bytes[] {
  const target = coverage(alphaOf(level0))
  const out: Bytes[] = [level0]
  let cur = level0
  while (cur.w > 1 || cur.h > 1) {
    const w = Math.max(1, cur.w >> 1), h = Math.max(1, cur.h >> 1)
    const f = img(cur.w, cur.h, 4)
    for (let p = 0; p < cur.w * cur.h; p++) {
      const a = cur.data[p * 4 + 3]! / 255
      for (let k = 0; k < 3; k++) f.d[p * 4 + k] = (cur.data[p * 4 + k]! / 255) * a
      f.d[p * 4 + 3] = a
    }
    const r = areaResize(f, w, h)
    const data = new Uint8Array(w * h * 4)
    for (let p = 0; p < w * h; p++) {
      const a = r.d[p * 4 + 3]!
      for (let k = 0; k < 3; k++) data[p * 4 + k] = a > 1e-6 ? Math.round(Math.min(1, r.d[p * 4 + k]! / a) * 255) : 0
      data[p * 4 + 3] = Math.round(a * 255)
    }
    const lvl = { w, h, c: 4, data }
    keepCoverage(lvl, target)
    out.push(lvl)
    cur = lvl
  }
  return out
}

// ---- one set ---------------------------------------------------------------------------------------------------------

/** What the encoder needs of an inventory entry. */
export interface EncodeEntry {
  key: string
  group?: string
  /** The retail source size [w, h]. */
  size: [number, number]
  class: MaterialClass
  alpha: AlphaKind
  wrap: [boolean, boolean]
  hero: boolean
}

/** The master folder's pbr.json (pbr/job.ts), the fields TP-E reads. */
export interface MasterInfo {
  key: string
  size: [number, number]
  hash: string
  delit?: boolean
  albedoOnly?: boolean
  tiny?: boolean
  inputKind?: string
  profile?: string
  delight?: number
  normalStrength?: number
  detail?: number
  maskShare?: Record<string, number> | null
  files?: Record<string, number>
}

export type EncodeMode = 'full' | 'albedo-only' | 'none'

export interface TierReport {
  name: string
  size: [number, number]
  bytes: number
  files: number
  /** The rebuilt-normal error of this tier's planes against the float normals at the tier size. */
  normal?: NormalError
}

export interface Ktx2Report {
  size: [number, number]
  files: Record<string, { bytes: number; levels: number; ms: number }>
}

export interface EncodeReport {
  key: string
  mode: EncodeMode
  masterHash: string | null
  tiers: TierReport[]
  ktx2?: Ktx2Report
  ms: number
}

/** The file part of a set (tiers and KTX2 files); the review metadata is added by `setRecord`. */
export interface EncodedFiles {
  size: [number, number]
  tiers: Record<string, PbrTier>
  albedo?: string
  normal?: string
  ormh?: string
}

interface CacheRecord {
  version: number
  webpHash: string
  ktx2Hash?: string
  files: EncodedFiles
  report: EncodeReport
}

export interface EncodeOptions {
  /** work/texpipe (masters in master/, the cache in cache/encode/, temp files in tmp/encode/). */
  texpipeDir: string
  /** work/out/pbr. */
  pbrDir: string
  overrides?: TexpipeOverrides | null
  force?: boolean
  /** Also write the KTX2 files (needs basisu, ktx2.ts). */
  ktx2?: boolean
  /** Sets encoded at once (default 3; sharp's own work runs off-thread). */
  concurrency?: number
  log?: (s: string) => void
}

export interface EncodeResult {
  key: string
  /** The index record, or null (no master, or an error). */
  set: PbrSet | null
  report: EncodeReport | null
  skipped: boolean
  error?: string
}

export function encodePaths(texpipeDir: string) {
  return { master: join(texpipeDir, 'master'), cache: join(texpipeDir, 'cache', 'encode'), tmp: join(texpipeDir, 'tmp', 'encode') }
}

export function readMasterInfo(masterDir: string): MasterInfo | null {
  try {
    return JSON.parse(readFileSync(join(masterDir, 'pbr.json'), 'utf8')) as MasterInfo
  } catch {
    return null
  }
}

/** The file mode of a set: none for retail/replaced, albedo-only for that status or TP-P's verdict, else full. */
export function encodeMode(status: PbrStatus, info: Pick<MasterInfo, 'albedoOnly'> | null): EncodeMode {
  if (status === 'retail' || status === 'replaced') return 'none'
  if (status === 'albedo-only' || info?.albedoOnly) return 'albedo-only'
  return 'full'
}

/** The DT-2 albedo route a master was derived from (TP-P's input kind; undefined = the GAN master). */
export function detailOfInput(inputKind: string | undefined): DetailRoute | undefined {
  if (inputKind?.startsWith('detail:sdxl')) return 'sdxl'
  if (inputKind === 'retail') return 'retail'
  return undefined
}

/** The `sro-pbr` record of a set: its encoded files plus the review metadata (status, hero, class, params). */
export function setRecord(e: EncodeEntry, files: EncodedFiles, status: PbrStatus, info: Pick<MasterInfo, 'delit' | 'inputKind' | 'size'> | null, params?: PbrSet['params']): PbrSet {
  const set: PbrSet = {
    key: e.key, size: files.size, class: e.class, tiers: files.tiers, alpha: e.alpha, wrap: [e.wrap[0], e.wrap[1]], status, hero: e.hero, source: 'local',
  }
  const detail = detailOfInput(info?.inputKind)
  if (detail) set.detail = detail
  if (info?.size) {
    const x2 = String(tier2xEdge(e.size, info.size))
    if (x2 in files.tiers) set.tier2x = x2
  }
  if (files.albedo) set.albedo = files.albedo
  if (files.normal) set.normal = files.normal
  if (files.ormh) set.ormh = files.ormh
  if (info?.delit !== undefined) set.delit = info.delit
  if (params && Object.keys(params).length) set.params = { ...params }
  return set
}

const MAP_FILE = /^(albedo|nx|ny|ao|rough|metal|height|normal|ormh|emissive)@\d+\.(webp|ktx2)$/

/** Every file of a set's encoded part, relative to pbr/. */
export function encodedFileList(f: EncodedFiles): string[] {
  const out: string[] = []
  for (const t of Object.values(f.tiers)) for (const k of ['albedo', 'nx', 'ny', 'ao', 'rough', 'metal', 'height'] as const) if (t[k]) out.push(t[k]!)
  for (const k of ['albedo', 'normal', 'ormh'] as const) if (f[k]) out.push(f[k]!)
  return out
}

/** Removes the map files of a key's folder that the set no longer lists (never subfolders: keys can nest). */
function cleanFolder(pbrDir: string, key: string, keep: readonly string[]): void {
  const dir = join(pbrDir, keyPath(key))
  if (!existsSync(dir)) return
  const kept = new Set(keep.map(f => f.split('/').pop()!))
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile() && MAP_FILE.test(ent.name) && !kept.has(ent.name)) unlinkSync(join(dir, ent.name))
  }
}

/** Writes a file and returns its size. */
function put(pbrDir: string, rel: string, bytes: Uint8Array): number {
  const p = join(pbrDir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, bytes)
  return bytes.byteLength
}

/** The master's inputs, decoded once per set. */
interface MasterImages {
  albedo: Bytes
  /** Unit normals (3 channels, −1..1), full mode only. */
  normal: Img | null
  /** ORMH (4 channels, 0..1), full mode only. */
  ormh: Img | null
}

async function loadMaster(dir: string, e: EncodeEntry, mode: EncodeMode): Promise<MasterImages> {
  const transparent = e.alpha === 'cutout' || e.alpha === 'blend'
  const albedo = await decodeBytes(join(dir, 'albedo.png'), transparent ? 4 : 3)
  if (mode !== 'full') return { albedo, normal: null, ormh: null }
  const normal = normalsFromRgb(await readImage(readFileSync(join(dir, 'normal.png'))))
  const ormh = await readImage(readFileSync(join(dir, 'ormh.png')))
  if (normal.w !== albedo.w || normal.h !== albedo.h || ormh.w !== albedo.w || ormh.h !== albedo.h) {
    throw new Error(`master maps differ in size: albedo ${albedo.w}x${albedo.h}, normal ${normal.w}x${normal.h}, ormh ${ormh.w}x${ormh.h}`)
  }
  return { albedo, normal, ormh }
}

/** Encodes the v1 WebP tiers of one set; returns the tier records and their reports. */
export async function encodeTiers(
  key: string, m: MasterImages, plans: readonly TierPlan[], opts: { pbrDir: string; alpha: AlphaKind; wrap: readonly [boolean, boolean]; tiny: boolean },
): Promise<{ tiers: Record<string, PbrTier>; reports: TierReport[] }> {
  const tiers: Record<string, PbrTier> = {}
  const reports: TierReport[] = []
  const target = opts.alpha === 'cutout' ? coverage(alphaOf(m.albedo)) : null
  const hasMetal = !!m.ormh && (() => {
    for (let p = 0; p < m.ormh!.w * m.ormh!.h; p++) if (m.ormh!.d[p * 4 + ORMH.metal]! >= METAL_MIN) return true
    return false
  })()
  for (const t of plans) {
    const [w, h] = t.size
    let bytes = 0, files = 0
    const add = (map: 'albedo' | 'nx' | 'ny' | 'ao' | 'rough' | 'metal' | 'height', data: Buffer): string => {
      const rel = pbrFile(key, map, t.name)
      bytes += put(opts.pbrDir, rel, data)
      files++
      return rel
    }
    const alb = await resizeAlbedo(m.albedo, w, h, opts.wrap)
    if (target !== null && alb !== m.albedo) keepCoverage(alb, target)
    const tier: PbrTier = { size: [w, h], albedo: add('albedo', await webp(alb, ALBEDO_WEBP)), bytes: 0 }
    const report: TierReport = { name: t.name, size: [w, h], bytes: 0, files: 0 }
    if (m.normal && m.ormh) {
      const n = normalsAt(m.normal, w, h)
      const { nx, ny } = normalPlanes(n)
      const nopts = opts.tiny ? TINY_NORMAL_WEBP : PLANE_WEBP
      const [bx, by] = await Promise.all([webp({ w, h, c: 1, data: nx }, nopts), webp({ w, h, c: 1, data: ny }, nopts)])
      tier.nx = add('nx', bx)
      tier.ny = add('ny', by)
      const [dx, dy] = await Promise.all([decodePlane(bx), decodePlane(by)])
      report.normal = normalError(n, rebuildNormals(dx.data, dy.data, w, h))
      const half = areaResize(m.ormh, t.half[0], t.half[1])
      const plane = (im: Img, k: number) => ({ w: im.w, h: im.h, c: 1, data: planeBytes(im, k) })
      tier.ao = add('ao', await webp(plane(half, ORMH.ao), PLANE_WEBP))
      tier.rough = add('rough', await webp(plane(half, ORMH.rough), PLANE_WEBP))
      if (hasMetal) tier.metal = add('metal', await webp(plane(half, ORMH.metal), PLANE_WEBP))
      tier.height = add('height', await webp(plane(areaResize(m.ormh, w, h), ORMH.height), PLANE_WEBP))
    }
    tier.bytes = bytes
    report.bytes = bytes
    report.files = files
    tiers[t.name] = tier
    reports.push(report)
  }
  return { tiers, reports }
}

/** PNG bytes of raw bytes (lossless, for the KTX2 encoder's input). */
async function png(b: Bytes): Promise<Buffer> {
  return sharp(toBuffer(b.data), { raw: { width: b.w, height: b.h, channels: b.c as 1 | 3 | 4 } }).png({ compressionLevel: 3 }).toBuffer()
}

/** The KTX2 files of one set at `size` (TP-K's encoder). */
async function encodeKtx2Files(key: string, m: MasterImages, size: [number, number], opts: { pbrDir: string; tmpDir: string; alpha: AlphaKind; wrap: readonly [boolean, boolean] }): Promise<{ files: Pick<EncodedFiles, 'albedo' | 'normal' | 'ormh'>; report: Ktx2Report }> {
  const k = await import('./ktx2.ts')
  const [w, h] = size
  const tmp = join(opts.tmpDir, keyPath(key))
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const report: Ktx2Report = { size: [w, h], files: {} }
  const files: Pick<EncodedFiles, 'albedo' | 'normal' | 'ormh'> = {}
  try {
    const alb = await resizeAlbedo(m.albedo, w, h, opts.wrap)
    if (opts.alpha === 'cutout' && alb !== m.albedo) keepCoverage(alb, coverage(alphaOf(m.albedo)))
    const jobs: Array<{ map: 'albedo' | 'normal' | 'ormh'; input: string; levels?: string[] }> = []
    const albPng = join(tmp, 'albedo.png')
    writeFileSync(albPng, await png(alb))
    if (opts.alpha === 'cutout') {
      const levels = cutoutMips(alb)
      const paths: string[] = []
      for (let i = 0; i < levels.length; i++) {
        const p = join(tmp, `albedo_l${i}.png`)
        writeFileSync(p, await png(levels[i]!))
        paths.push(p)
      }
      jobs.push({ map: 'albedo', input: albPng, levels: paths })
    } else jobs.push({ map: 'albedo', input: albPng })
    if (m.normal && m.ormh) {
      const n = normalsAt(m.normal, w, h)
      const rgb = new Uint8Array(w * h * 3)
      for (let p = 0; p < w * h * 3; p++) rgb[p] = Math.round(Math.max(0, Math.min(1, n.d[p]! * 0.5 + 0.5)) * 255)
      const nPng = join(tmp, 'normal.png')
      writeFileSync(nPng, await png({ w, h, c: 3, data: rgb }))
      jobs.push({ map: 'normal', input: nPng })
      const o = areaResize(m.ormh, w, h)
      const rgba = new Uint8Array(w * h * 4)
      for (let p = 0; p < w * h * 4; p++) rgba[p] = Math.round(Math.max(0, Math.min(1, o.d[p]!)) * 255)
      const oPng = join(tmp, 'ormh.png')
      writeFileSync(oPng, await png({ w, h, c: 4, data: rgba }))
      jobs.push({ map: 'ormh', input: oPng })
    }
    const tier = String(Math.max(w, h))
    const results = await k.encodeKtx2Batch(jobs.map(j => ({
      role: j.map, input: j.input, output: join(opts.pbrDir, pbrFile(key, j.map, tier, 'ktx2')), levels: j.levels,
    })), 1)
    jobs.forEach((j, i) => {
      const r = results[i]!
      files[j.map] = pbrFile(key, j.map, tier, 'ktx2')
      report.files[j.map] = { bytes: r.bytes, levels: r.levels, ms: Math.round(r.ms) }
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { files, report }
}

function readRecord(file: string): CacheRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as CacheRecord
    return r.version === ENCODE_VERSION ? r : null
  } catch {
    return null
  }
}

const allExist = (pbrDir: string, rels: readonly string[]) => rels.every(f => existsSync(join(pbrDir, f)))

/** Encodes one set (or reuses the cached result); returns its index record. */
export async function encodeSet(e: EncodeEntry, opts: EncodeOptions): Promise<EncodeResult> {
  const t0 = performance.now()
  const paths = encodePaths(opts.texpipeDir)
  const ov = opts.overrides?.sets[e.key]
  const status: PbrStatus = ov?.status ?? 'auto'
  const masterDir = join(paths.master, keyPath(e.key))
  const info = readMasterInfo(masterDir)
  const mode = encodeMode(status, info)
  const cacheFile = join(paths.cache, `${keyPath(e.key)}.json`)
  if (mode === 'none') {
    cleanFolder(opts.pbrDir, e.key, [])
    rmSync(cacheFile, { force: true })
    const files: EncodedFiles = { size: [e.size[0], e.size[1]], tiers: {} }
    const report: EncodeReport = { key: e.key, mode, masterHash: info?.hash ?? null, tiers: [], ms: 0 }
    return { key: e.key, set: setRecord(e, files, status, null, ov?.params), report, skipped: false }
  }
  if (!info || !existsSync(join(masterDir, 'albedo.png'))) {
    return { key: e.key, set: null, report: null, skipped: false, error: `no TP-P master in ${masterDir} (run pnpm texpipe pbr)` }
  }
  const tiny = Math.min(e.size[0], e.size[1]) <= TINY_SOURCE
  const plans = tierPlan(e.size, info.size)
  const webpHash = sha1(`encode v${ENCODE_VERSION}`, info.hash, mode, e.alpha, JSON.stringify(e.wrap), JSON.stringify(plans), String(tiny), JSON.stringify([ALBEDO_WEBP, PLANE_WEBP, TINY_NORMAL_WEBP]))
  const top = plans[plans.length - 1]!
  const ktx2Hash = sha1(webpHash, 'ktx2', JSON.stringify(top.size))
  const prev = opts.force ? null : readRecord(cacheFile)
  const webpFresh = !!prev && prev.webpHash === webpHash && allExist(opts.pbrDir, encodedFileList({ size: prev.files.size, tiers: prev.files.tiers }))
  const ktx2Files = prev && prev.ktx2Hash === ktx2Hash ? { albedo: prev.files.albedo, normal: prev.files.normal, ormh: prev.files.ormh } : {}
  const ktx2Fresh = !!prev && prev.ktx2Hash === ktx2Hash && !!ktx2Files.albedo
    && allExist(opts.pbrDir, [ktx2Files.albedo, ktx2Files.normal, ktx2Files.ormh].filter((f): f is string => !!f))
  const wantKtx2 = !!opts.ktx2 && !ktx2Fresh
  if (webpFresh && !wantKtx2) {
    const files: EncodedFiles = { size: prev!.files.size, tiers: prev!.files.tiers, ...(ktx2Fresh ? ktx2Files : {}) }
    cleanFolder(opts.pbrDir, e.key, encodedFileList(files))
    const report: EncodeReport = { ...prev!.report, ktx2: ktx2Fresh ? prev!.report.ktx2 : undefined }
    if (!ktx2Fresh && prev!.ktx2Hash) writeAtomic(cacheFile, JSON.stringify({ ...prev!, ktx2Hash: undefined, files, report } satisfies CacheRecord, null, 1))
    return { key: e.key, set: setRecord(e, files, status, info, ov?.params), report, skipped: true }
  }
  const m = await loadMaster(masterDir, e, mode)
  if (m.albedo.w !== info.size[0] || m.albedo.h !== info.size[1]) throw new Error(`${e.key}: albedo.png is ${m.albedo.w}x${m.albedo.h}, pbr.json says ${info.size.join('x')}`)
  let tiers: Record<string, PbrTier>, reports: TierReport[]
  if (webpFresh) {
    tiers = prev!.files.tiers
    reports = prev!.report.tiers
  } else {
    ({ tiers, reports } = await encodeTiers(e.key, m, plans, { pbrDir: opts.pbrDir, alpha: e.alpha, wrap: e.wrap, tiny }))
  }
  const files: EncodedFiles = { size: [top.size[0], top.size[1]], tiers }
  let ktx2: Ktx2Report | undefined
  if (wantKtx2) {
    const k = await encodeKtx2Files(e.key, m, top.size, { pbrDir: opts.pbrDir, tmpDir: paths.tmp, alpha: e.alpha, wrap: e.wrap })
    Object.assign(files, k.files)
    ktx2 = k.report
  } else if (ktx2Fresh) {
    Object.assign(files, ktx2Files)
    ktx2 = prev!.report.ktx2
  }
  cleanFolder(opts.pbrDir, e.key, encodedFileList(files))
  const report: EncodeReport = { key: e.key, mode, masterHash: info.hash, tiers: reports, ktx2, ms: Math.round(performance.now() - t0) }
  const hasKtx2 = !!files.albedo
  writeAtomic(cacheFile, JSON.stringify({ version: ENCODE_VERSION, webpHash, ktx2Hash: hasKtx2 ? ktx2Hash : undefined, files, report } satisfies CacheRecord, null, 1))
  return { key: e.key, set: setRecord(e, files, status, info, ov?.params), report, skipped: false }
}

/** Encodes a batch, `concurrency` sets at a time, in entry order. */
export async function runEncode(entries: readonly EncodeEntry[], opts: EncodeOptions): Promise<EncodeResult[]> {
  const log = opts.log ?? (() => {})
  if (opts.ktx2) {
    const { hasBasisu, basisuPath } = await import('./ktx2.ts')
    if (!hasBasisu()) {
      log(`! --ktx2: basisu not found at ${basisuPath()} (texpipe.basisu in sro.config.json); WebP only`)
      opts = { ...opts, ktx2: false }
    }
  }
  const results: EncodeResult[] = new Array(entries.length)
  let next = 0, done = 0
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const i = next++
      const e = entries[i]!
      try {
        results[i] = await encodeSet(e, opts)
      } catch (err) {
        results[i] = { key: e.key, set: null, report: null, skipped: false, error: (err as Error).stack ?? String(err) }
      }
      done++
      log(`  [${done}/${entries.length}] ${formatResult(results[i]!)}`)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, entries.length)) }, worker))
  return results
}

const mb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.round(n / 1e3)} KB`)

/** One log line per set. */
export function formatResult(r: EncodeResult): string {
  if (r.error) return `${r.key}: ERROR ${r.error.split('\n')[0]}`
  const rep = r.report!
  if (rep.mode === 'none') return `${r.key}: status ${r.set!.status}, no files (retail texture kept)`
  const tiers = rep.tiers.map(t => `${t.name} ${mb(t.bytes)}`).join(', ')
  const top = rep.tiers[rep.tiers.length - 1]
  const n = top?.normal ? `, normal ${top.normal.meanDeg.toFixed(2)}° (p99 ${top.normal.p99Deg.toFixed(1)}°)` : ''
  const k = rep.ktx2 ? `, ktx2 ${mb(Object.values(rep.ktx2.files).reduce((s, f) => s + f.bytes, 0))}` : ''
  return `${r.key}: ${rep.mode}${r.set!.hero ? ' hero' : ''}, tiers ${tiers}${n}${k}${r.skipped ? ' (cached)' : ` (${(rep.ms / 1000).toFixed(1)} s)`}`
}

/** The cached encode report of a key (the review page reads it), or null. */
export function readEncodeReport(texpipeDir: string, key: string): EncodeReport | null {
  return readRecord(join(encodePaths(texpipeDir).cache, `${keyPath(key)}.json`))?.report ?? null
}
