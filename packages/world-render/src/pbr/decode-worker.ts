/**
 * The texture decode worker (lane TX-R; docs/WAVE_PLAN3.md §7.1, D42; docs/TEXPIPE.md §6.3): fetches a map set's
 * files, decodes them with `createImageBitmap` (premultiplyAlpha 'none', colorSpaceConversion 'none', so the linear
 * planes are not altered), packs the v1 planes (normal RGBA8, ORMH) and computes the mip levels (coverage-preserving
 * for cutouts), all off the main thread. The main thread then only uploads the levels, one job per map inside the
 * frame budget (pbr/maps.ts `MapDecoder`, tile-atlas.ts).
 *
 * Messages: in `{ id, job: MapJob }` (decode-core.ts; absolute URLs), out `{ id, result: MapResult }` with the level
 * buffers transferred, or `{ id, error }`. The first message out is `{ ready: true }` (the client's start-up check).
 * BT-A (docs/BATCHING.md §3.2): the same worker runs the batch atlas's cell jobs (`{ id, job: CellJob }`, out
 * `{ id, result: CellResult }`): a glb's embedded image (its bytes), a lightmap file or a TX-R map job, resampled into
 * an atlas cell with its gutter and mips (decode-core.ts `runCellJob`; the client is batch/atlas.ts `CellWorkers`).
 * No DOM beyond `fetch`, `createImageBitmap` and `OffscreenCanvas`; nothing from Babylon (the worker bundle stays
 * small).
 */
import { runDecodeJob, transferables, type DecodeJob, type Level } from './decode-core.ts'

interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

/** Fetch + createImageBitmap + a 2D OffscreenCanvas read-back (rows in file order). */
async function decodeUrl(url: string, size?: number): Promise<Level> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return decodeBlob(await res.blob(), size)
}

/** An encoded image's bytes (BT-A: a glb's embedded texture; the format is sniffed from the bytes). */
function decodeBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Level> {
  return decodeBlob(new Blob([bytes]))
}

async function decodeBlob(blob: Blob, size?: number): Promise<Level> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    ...(size ? { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' as const } : {}),
  })
  const { width, height } = bitmap
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable in the worker')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const px = ctx.getImageData(0, 0, width, height).data
  return { width, height, data: new Uint8Array(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength) }
}

const scope = globalThis as unknown as WorkerScope
// Only when loaded as a worker (a plain import, e.g. a test, has no onmessage to take).
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  scope.onmessage = e => {
    const msg = e.data as { id: number; job: DecodeJob }
    runDecodeJob(msg.job, { url: decodeUrl, bytes: decodeBytes }).then(
      result => scope.postMessage({ id: msg.id, result }, transferables(result)),
      (err: unknown) => scope.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
    )
  }
  scope.postMessage({ ready: true })
}
