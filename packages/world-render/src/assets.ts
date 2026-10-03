// Fetching and decoding of the world output (<out>/world/<name>/, where <out> is /out or the slimmed /out-opt,
// docs/ASSETS.md). Every download goes through Assets so HUDs can report bytes; nothing is fetched from outside
// the asset base. The transport and the image decoder are pluggable (WorldIO) so the loader also runs headless.

export interface DecodedImage {
  width: number
  height: number
  /** RGBA8, row 0 = the image's first (top) row as stored in the file. */
  data: Uint8Array<ArrayBuffer>
}

/** How bytes are fetched and images decoded. The default uses fetch + createImageBitmap (browser). */
export interface WorldIO {
  /** `signal` (optional, region streaming) aborts a request that is no longer wanted. */
  bytes(url: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
  /** RGBA8 decode, optionally resampled to size x size; rows in file order, no premultiplication. */
  decodeImage(bytes: Uint8Array<ArrayBuffer>, mimeType: string, size?: number): Promise<DecodedImage>
}

export const browserIO: WorldIO = {
  async bytes(url, signal) {
    const res = await fetch(url, signal ? { signal } : undefined)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  },
  decodeImage: (bytes, mimeType, size) => decodeImage(new Blob([bytes], { type: mimeType }), size),
}

const MIME: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ktx2: 'image/ktx2',
}

/** Image MIME type from a path's extension (out-opt renames world PNGs to .webp; docs/ASSETS.md 5.2). */
export function mimeOf(path: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  return MIME[ext] ?? 'image/png'
}

export class Assets {
  bytes = 0
  files = 0
  failures = 0
  readonly base: URL

  /** `base` is the folder every relative path resolves against (for a world: the folder of manifest.json). */
  constructor(base: URL | string, readonly io: WorldIO = browserIO) {
    this.base = typeof base === 'string' ? new URL(base, typeof document !== 'undefined' ? document.baseURI : undefined) : base
  }

  /** A child Assets rooted at `rel` (sharing this one's byte counters is not needed: the HUD sums both). */
  sub(rel: string): Assets {
    return new Assets(new URL(rel.endsWith('/') ? rel : `${rel}/`, this.base), this.io)
  }

  url(rel: string): string {
    return new URL(rel.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), this.base).href
  }

  async bytesOf(rel: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    let buf: Uint8Array<ArrayBuffer>
    try {
      if (signal?.aborted) throw abortError()
      buf = await (signal ? this.io.bytes(this.url(rel), signal) : this.io.bytes(this.url(rel)))
      if (signal?.aborted) throw abortError()
    } catch (err) {
      if (isAbort(err)) throw err
      this.failures++
      throw new Error(`${rel}: ${errorText(err)}`)
    }
    this.bytes += buf.byteLength
    this.files++
    return buf
  }

  async json<T>(rel: string): Promise<T> {
    const text = new TextDecoder().decode(await this.bytesOf(rel))
    try {
      return JSON.parse(text) as T
    } catch {
      // A dev server's SPA fallback answers unknown paths with index.html.
      throw new Error(`${rel}: not JSON${text.trimStart().startsWith('<') ? ' (got HTML: the path is not served)' : ''}`)
    }
  }

  async blob(rel: string): Promise<Blob> {
    return new Blob([await this.bytesOf(rel)], { type: mimeOf(rel) })
  }

  /**
   * Decodes an image to RGBA8 without colour-space conversion or premultiplication, optionally resampled to
   * `size` x `size`. Rows stay in file order (row 0 first), which is what the texture uploads expect (invertY false).
   */
  async image(rel: string, size?: number): Promise<DecodedImage> {
    return this.io.decodeImage(await this.bytesOf(rel), mimeOf(rel), size)
  }
}

export async function decodeImage(blob: Blob, size?: number): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    ...(size ? { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' as const } : {}),
  })
  const { width, height } = bitmap
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, width, height).data
  return { width, height, data: new Uint8Array(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength) }
}

/** Runs `fn` over `items` with at most `limit` promises in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** The error an aborted request rejects with (name 'AbortError', like fetch's). */
export function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/** A rejection caused by an AbortSignal (fetch's DOMException or abortError()). */
export function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
