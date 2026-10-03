/**
 * TP-U content cache (docs/TEXPIPE.md §2 "Cache", §10 TP-U): `work/texpipe/cache/up/`.
 *
 * Every entry is keyed by the SHA-1 of its inputs and parameters, so a parameter change for one texture re-runs only
 * that texture, and an unchanged batch costs nothing:
 *
 *   ai/<sha1>.png   the model output, cropped to the 4× size (RGB). Key: the bled source RGB, the pad plan, the model,
 *                   the upscaler identity (exe size and date) and `AI_CACHE_VERSION`. A mix change reuses it.
 *   <sha1>.png      the final upscale (RGB or RGBA) and <sha1>.json its report. Key: the AI key plus the mix, the alpha
 *                   kind, the scale cap, the alpha parameters and `UPSCALE_CACHE_VERSION`.
 *
 * Writes are atomic (a temp file, then rename), so a killed run never leaves a half-written PNG that a later run
 * would trust.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { rawImage, type RawImage } from './pad.ts'

/** Bump when the model step changes its output for the same inputs (drops the cached AI outputs). */
export const AI_CACHE_VERSION = 1
/** Bump when the steps after the model (mix, alpha, cap, the report) change (drops the final results only). */
export const UPSCALE_CACHE_VERSION = 3

/** SHA-1 (hex) of strings, numbers and byte arrays, each length-prefixed so `['ab','c']` ≠ `['a','bc']`. */
export function sha1(...parts: Array<string | number | Uint8Array>): string {
  const h = createHash('sha1')
  for (const p of parts) {
    const bytes = typeof p === 'string' || typeof p === 'number' ? Buffer.from(String(p), 'utf8') : p
    h.update(`${typeof p === 'object' ? 'b' : 's'}${bytes.length}:`)
    h.update(bytes)
  }
  return h.digest('hex')
}

/** SHA-1 of an image's size, channels and pixels. */
export function imageHash(img: RawImage): string {
  return sha1(img.width, img.height, img.channels, img.data)
}

/** Encodes a raw image as a lossless PNG. */
export async function encodePng(img: RawImage): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels as 1 | 2 | 3 | 4 } })
    .png({ compressionLevel: 6 })
    .toBuffer()
}

/** Decodes any image sharp reads into raw bytes; `channels` forces 3 (RGB) or 4 (RGBA). */
export async function decodeImage(input: Uint8Array | string, channels?: 3 | 4): Promise<RawImage> {
  let s = sharp(input)
  if (channels === 4) s = s.ensureAlpha()
  else if (channels === 3) s = s.removeAlpha()
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true })
  return rawImage(info.width, info.height, info.channels, new Uint8Array(data.buffer, data.byteOffset, data.length))
}

/** Rename retries on Windows when a reader holds the target open (EPERM / EBUSY / EACCES), and their waits (ms). */
const RENAME_RETRY_MS = [50, 100, 200, 400, 800, 1600]

/**
 * Writes a file atomically (temp file + rename). On Windows a rename over a file another process holds open without
 * delete sharing (a dev server's handle on `work/out/pbr/index.json`) fails with EPERM: the rename is retried a few
 * times, then the temp file is copied over the target in place (CopyFile only needs write sharing), which is not
 * atomic but never leaves a half-written file behind a failed rename.
 */
export function writeAtomic(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const locked = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (locked && attempt < RENAME_RETRY_MS.length) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS[attempt]!)
        continue
      }
      try {
        if (!locked || !existsSync(path)) throw e
        copyFileSync(tmp, path)
        return
      } finally {
        rmSync(tmp, { force: true })
      }
    }
  }
}

export class UpscaleCache {
  constructor(readonly dir: string) {}

  aiFile(hash: string): string {
    return join(this.dir, 'ai', `${hash}.png`)
  }

  upFile(hash: string): string {
    return join(this.dir, `${hash}.png`)
  }

  metaFile(hash: string): string {
    return join(this.dir, `${hash}.json`)
  }

  async getAi(hash: string): Promise<RawImage | null> {
    const f = this.aiFile(hash)
    return existsSync(f) ? decodeImage(f, 3) : null
  }

  async putAi(hash: string, img: RawImage): Promise<void> {
    writeAtomic(this.aiFile(hash), await encodePng(img))
  }

  /** The final result's report, when both it and its PNG exist. */
  getMeta<T>(hash: string): T | null {
    const m = this.metaFile(hash)
    if (!existsSync(m) || !existsSync(this.upFile(hash))) return null
    try {
      return JSON.parse(readFileSync(m, 'utf8')) as T
    } catch {
      return null
    }
  }

  /** Stores the final PNG first and its report last (the report marks the entry complete). */
  async putUp(hash: string, img: RawImage, meta: unknown): Promise<void> {
    writeAtomic(this.upFile(hash), await encodePng(img))
    writeAtomic(this.metaFile(hash), JSON.stringify(meta, null, 1))
  }
}
