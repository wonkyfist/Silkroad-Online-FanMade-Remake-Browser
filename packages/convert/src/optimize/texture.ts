/**
 * PNG -> WebP with a numeric quality gate. Each image climbs a quality ladder until it passes the gate
 * (RGB PSNR, luma SSIM over 8x8 blocks, alpha PSNR); the last rung is lossless WebP, so every output passes.
 * Lossy WebP is always 4:2:0, which caps small saturated textures near 32-34 dB whatever the quality; those move
 * on to near-lossless WebP (full-resolution chroma, 40+ dB at about half the PNG size).
 * Alpha is always coded losslessly (alphaQuality 100) and colour under transparent texels is kept (`exact`),
 * so alpha-tested edges filter exactly as before.
 */
import sharp from 'sharp'
import { sha1 } from './io.ts'

export interface ImageQuality {
  /** PSNR of R, G, B over every texel, dB (Infinity when identical). */
  psnr: number
  /** Mean SSIM of luma over 8x8 blocks (1 = identical). */
  ssim: number
  /** PSNR of the alpha channel, dB (Infinity when identical or absent). */
  alphaPsnr: number
}

export interface WebpResult extends ImageQuality {
  webp: Uint8Array
  /** Rung that passed: 'q90' (lossy quality 90), 'nl40' (near-lossless level 40) or 'lossless'. */
  quality: Rung
  width: number
  height: number
  inBytes: number
  outBytes: number
  /** True when even the output is below the gate (never happens with the lossless rung; kept for reporting). */
  flagged: boolean
}

export interface QualityGate {
  minPsnr: number
  minSsim: number
  minAlphaPsnr: number
}

/** 'q<n>' lossy WebP at quality n; 'nl<n>' near-lossless at preprocessing level n (lower = stronger); 'lossless'. */
export type Rung = `q${number}` | `nl${number}` | 'lossless'

/**
 * Encode gate: RGB PSNR >= 35 dB and luma SSIM >= 0.98 over every texel (transparent ones included), alpha >= 60 dB
 * (alpha is coded losslessly, so it is Infinity in practice). Anything under REVIEW_PSNR would be listed for a look;
 * with the lossless last rung nothing can be.
 */
export const DEFAULT_GATE: QualityGate = { minPsnr: 35, minSsim: 0.98, minAlphaPsnr: 60 }
export const REVIEW_PSNR = 35
export const DEFAULT_LADDER: readonly Rung[] = ['q90', 'q95', 'nl40', 'nl60']

export interface RawImage {
  data: Uint8Array
  width: number
  height: number
}

export async function decodeRgba(bytes: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height }
}

function psnrFromMse(mse: number): number {
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}

/** Compares two RGBA8 images of the same size. */
export function compareImages(a: RawImage, b: RawImage): ImageQuality {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  const { width: w, height: h } = a
  const n = w * h
  let se = 0
  let seA = 0
  const la = new Float64Array(n)
  const lb = new Float64Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const dr = a.data[p]! - b.data[p]!
    const dg = a.data[p + 1]! - b.data[p + 1]!
    const db = a.data[p + 2]! - b.data[p + 2]!
    const da = a.data[p + 3]! - b.data[p + 3]!
    se += dr * dr + dg * dg + db * db
    seA += da * da
    la[i] = 0.299 * a.data[p]! + 0.587 * a.data[p + 1]! + 0.114 * a.data[p + 2]!
    lb[i] = 0.299 * b.data[p]! + 0.587 * b.data[p + 1]! + 0.114 * b.data[p + 2]!
  }
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  let ssimSum = 0
  let blocks = 0
  const B = 8
  for (let by = 0; by < h; by += B) {
    for (let bx = 0; bx < w; bx += B) {
      const bw = Math.min(B, w - bx)
      const bh = Math.min(B, h - by)
      const m = bw * bh
      let ma = 0
      let mb = 0
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
        ma += la[y * w + x]!
        mb += lb[y * w + x]!
      }
      ma /= m
      mb /= m
      let va = 0
      let vb = 0
      let cov = 0
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
        const da = la[y * w + x]! - ma
        const db = lb[y * w + x]! - mb
        va += da * da
        vb += db * db
        cov += da * db
      }
      va /= m
      vb /= m
      cov /= m
      ssimSum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      blocks++
    }
  }
  return { psnr: psnrFromMse(se / (3 * n)), ssim: blocks ? ssimSum / blocks : 1, alphaPsnr: psnrFromMse(seA / n) }
}

function passes(q: ImageQuality, gate: QualityGate): boolean {
  return q.psnr >= gate.minPsnr && q.ssim >= gate.minSsim && q.alphaPsnr >= gate.minAlphaPsnr
}

const cache = new Map<string, Promise<WebpResult>>()

/** Encodes an image (PNG or anything sharp reads) to WebP through the quality ladder. Results are cached by content. */
export function toWebp(bytes: Uint8Array, opts: { gate?: QualityGate; ladder?: readonly Rung[] } = {}): Promise<WebpResult> {
  const gate = opts.gate ?? DEFAULT_GATE
  const ladder = opts.ladder ?? DEFAULT_LADDER
  const key = sha1(bytes, JSON.stringify([gate, ladder]))
  let p = cache.get(key)
  if (!p) {
    p = encodeLadder(bytes, gate, ladder)
    cache.set(key, p)
  }
  return p
}

async function encodeLadder(bytes: Uint8Array, gate: QualityGate, ladder: readonly Rung[]): Promise<WebpResult> {
  const src = await decodeRgba(bytes)
  const input = () => sharp(Buffer.from(src.data.buffer, src.data.byteOffset, src.data.byteLength), { raw: { width: src.width, height: src.height, channels: 4 } })
  let last: WebpResult | null = null
  for (const rung of [...ladder, 'lossless' as const]) {
    const level = Number(rung.replace(/^\D+/, ''))
    const out = rung === 'lossless'
      ? await input().webp({ lossless: true, exact: true, effort: 6 }).toBuffer()
      : rung.startsWith('nl')
        ? await input().webp({ nearLossless: true, quality: level, exact: true, effort: 6 }).toBuffer()
        : await input().webp({ quality: level, alphaQuality: 100, smartSubsample: true, exact: true, effort: 6 }).toBuffer()
    const webp = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    const q = compareImages(src, await decodeRgba(webp))
    last = { ...q, webp, quality: rung, width: src.width, height: src.height, inBytes: bytes.byteLength, outBytes: webp.byteLength, flagged: !passes(q, gate) }
    if (!last.flagged) break
  }
  return last!
}
