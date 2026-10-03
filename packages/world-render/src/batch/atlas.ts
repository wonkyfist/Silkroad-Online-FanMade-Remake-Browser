/**
 * The batch atlases (lane BT-A; docs/BATCHING.md §3.2, §3.13, F6, F7, F15, Q5, Q6, Q11; docs/WAVE_PLAN6.md §6.1, D5):
 * where a region batch's textures live. Every converted material the batcher merges draws from cells of a few
 * RGBA8 2D texture arrays instead of its own textures:
 *
 * - **Pages and cells.** An array holds square pages (1024² for the albedo and NRAO atlases on every preset, 256² for
 *   the lightmaps). A texture gets a **rectangular** power-of-two cell (`cellShape`: 53 % of the object textures are
 *   not square, F6), allocated by a buddy allocator that splits blocks into 2:1 strips and keeps every remainder on a
 *   per-shape free list (`CellAllocator`), so 1:2 and 1:4 cells pack without waste.
 * - **Dedupe.** A cell is keyed by content (the TX-R texture key, the map job, the lightmap URI), not by the Babylon
 *   texture (one per glb): the 1,348 embedded images of jangan-fields are 713 unique ones.
 * - **Reference counts and a grace time.** Cells are shared by every slot that uses them; a cell nobody uses is kept
 *   `graceS` seconds (walking back and forth over an area border decodes nothing again), and evicted earlier when an
 *   allocation would otherwise add a page.
 * - **≤ 256 layers per array** (F7: WebGPU's default `maxTextureArrayLayers`, GLES 3.0's minimum). An array grows its
 *   layer count with 25 % headroom (the old layers copied on the GPU, `copyArrayLayers`) up to 256; past that, cells spill
 *   into a second array, which the batcher binds as another group (one more draw).
 * - **Where the pixels come from** (Q6): never a GPU read-back. A cell job (pbr/decode-core.ts `runCellJob`) runs in
 *   the decode worker (pbr/decode-worker.ts, `CellWorkers` here): it decodes the glb's embedded image (the bytes the
 *   loader keeps for context loss, `encodedBytesOf`), a TX-R map set's files (the map job TX-R used, `mapJobOf`) or a
 *   lightmap file, resamples into the cell with its wrap gutter, and computes the cell's mips. The main thread only
 *   writes the levels with sub-rectangle uploads (textures.ts `uploadArrayRect`), each a job of ≤ `jobBytes` through
 *   the caller's frame-budget queue.
 *
 * The material table (table.ts) ties cells to slots; lightmaps.ts places the lightmaps. Headless (NullEngine) the
 * arrays are placeholders and nothing is uploaded; the allocation, the dedupe and the jobs run as in the browser.
 */
import { Observable, type BaseTexture, type Scene } from '@babylonjs/core'
import { browserIO, mimeOf, type WorldIO } from '../assets.ts'
import { runCellJob, type CellDecoders, type CellImage, type CellJob, type CellResult, type CellShape, type Level, type MapJob } from '../pbr/decode-core.ts'
import type { PbrTextureCache } from '../pbr/maps.ts'
import { copyArrayLayers, createArrayTexture, mipLevels, planArrayRect, uploadArrayRect } from '../textures.ts'

export { cellShape, gutterOf, lightmapShape, nraoShape, CELL_MIN } from '../pbr/decode-core.ts'
export type { CellImage, CellJob, CellResult, CellShape } from '../pbr/decode-core.ts'

/** The albedo and NRAO atlas page size on every PBR preset (the prototype's 512² pages on Medium took 269 layers, F7). */
export const ATLAS_PAGE = 1024
/** Mip levels of an atlas page: down to the smallest cell's single texel (1024 → 32: 6 levels). */
export const ATLAS_LEVELS = mipLevels(ATLAS_PAGE) - mipLevels(32) + 1
/** The most layers any array may have (F7). */
export const MAX_ARRAY_LAYERS = 256

// ---- the allocator (pure) ------------------------------------------------------------------------------------------

/** A block of a page: texel rectangle (x, y, w, h) of layer `page`. */
export interface CellBlock {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface Node {
  page: number
  x: number
  y: number
  w: number
  h: number
  parent: Node | null
  kids: [Node, Node] | null
  used: boolean
}

const shapeKey = (w: number, h: number) => `${w}x${h}`

/**
 * A buddy allocator of rectangular power-of-two blocks on square pages (BATCHING §3.2): a block is split in two along
 * the axis that is further from the request (the longer one on a tie), one half kept and the other put on the free
 * list of its shape; a request takes the smallest free block that fits (the lowest page on a tie) and adds a page only
 * when none does. Freed buddies merge back up to the whole page.
 */
export class CellAllocator {
  private readonly roots: Node[] = []
  private readonly freeLists = new Map<string, Set<Node>>()
  private readonly live = new Set<Node>()
  /** Texels of the blocks handed out. */
  usedTexels = 0

  constructor(readonly size: number, readonly maxPages = MAX_ARRAY_LAYERS) {}

  get pages(): number {
    return this.roots.length
  }

  /** Blocks handed out and not released. */
  get blocks(): number {
    return this.live.size
  }

  /** Share of the pages' texels in use. */
  get fill(): number {
    return this.roots.length ? this.usedTexels / (this.roots.length * this.size * this.size) : 0
  }

  /**
   * A w × h block (powers of two, ≤ the page), or null when no free block fits and no page may be added (`grow`
   * false, or `maxPages` reached).
   */
  alloc(w: number, h: number, grow = true): CellBlock | null {
    if (!(w >= 1 && h >= 1 && w <= this.size && h <= this.size) || (w & (w - 1)) !== 0 || (h & (h - 1)) !== 0) {
      throw new Error(`cell ${w}x${h}: not a power of two within ${this.size}²`)
    }
    let node = this.findFree(w, h)
    if (!node) {
      if (!grow || this.roots.length >= this.maxPages) return null
      node = { page: this.roots.length, x: 0, y: 0, w: this.size, h: this.size, parent: null, kids: null, used: false }
      this.roots.push(node)
      this.addFree(node)
    }
    const leaf = this.split(node, w, h)
    leaf.used = true
    this.live.add(leaf)
    this.usedTexels += w * h
    return leaf
  }

  /** Gives a block back (merging free buddies); unknown or already released blocks are ignored. */
  release(block: CellBlock): void {
    let node = block as Node
    if (!this.live.delete(node)) return
    node.used = false
    this.usedTexels -= node.w * node.h
    this.addFree(node)
    for (let p = node.parent; p; p = p.parent) {
      const [a, b] = p.kids!
      if (a.used || b.used || a.kids || b.kids) break
      this.removeFree(a)
      this.removeFree(b)
      p.kids = null
      this.addFree(p)
      node = p
    }
  }

  /** Forgets every page and block. */
  reset(): void {
    this.roots.length = 0
    this.freeLists.clear()
    this.live.clear()
    this.usedTexels = 0
  }

  private findFree(w: number, h: number): Node | null {
    let best: Node | null = null
    let bestArea = Infinity
    for (const set of this.freeLists.values()) {
      const first = set.values().next().value as Node | undefined
      if (!first || first.w < w || first.h < h) continue
      const area = first.w * first.h
      if (area > bestArea) continue
      for (const n of set) {
        if (area < bestArea || n.page < best!.page) {
          best = n
          bestArea = area
        }
      }
    }
    return best
  }

  private split(node: Node, w: number, h: number): Node {
    this.removeFree(node)
    while (node.w > w || node.h > h) {
      const rx = node.w / w
      const ry = node.h / h
      const alongX = rx > ry || (rx === ry && node.w >= node.h)
      const a: Node = alongX
        ? { page: node.page, x: node.x, y: node.y, w: node.w / 2, h: node.h, parent: node, kids: null, used: false }
        : { page: node.page, x: node.x, y: node.y, w: node.w, h: node.h / 2, parent: node, kids: null, used: false }
      const b: Node = alongX
        ? { ...a, x: node.x + node.w / 2 }
        : { ...a, y: node.y + node.h / 2 }
      node.kids = [a, b]
      this.addFree(b)
      node = a
    }
    return node
  }

  private addFree(n: Node): void {
    const k = shapeKey(n.w, n.h)
    let set = this.freeLists.get(k)
    if (!set) this.freeLists.set(k, (set = new Set()))
    set.add(n)
  }

  private removeFree(n: Node): void {
    const k = shapeKey(n.w, n.h)
    const set = this.freeLists.get(k)
    if (!set) return
    set.delete(n)
    if (!set.size) this.freeLists.delete(k)
  }
}

// ---- one growable GPU array ------------------------------------------------------------------------------------------

/**
 * A 2D texture array of square RGBA8 layers that grows its layer count (25 % headroom), up to `maxLayers`: the new array
 * takes the old one's layers by a GPU copy, and `onChanged` tells whoever binds it (read `texture` at bind time).
 */
export class ArrayTexture {
  private tex: BaseTexture | null = null
  private cap = 0
  /** Fired with the new texture after a growth (the old one is disposed). */
  readonly onChanged = new Observable<BaseTexture>()
  /** Growths, and growths whose GPU copy failed (the owner re-uploaded its cells). */
  grows = 0
  copyFailures = 0

  constructor(private readonly scene: Scene, readonly size: number, readonly levels: number, readonly name: string,
    private readonly first = 4, readonly maxLayers = MAX_ARRAY_LAYERS) {}

  /** Layers allocated on the GPU (0 until the texture is first made). */
  get capacity(): number {
    return this.cap
  }

  /** The array (made at its first capacity on first use). */
  get texture(): BaseTexture {
    if (!this.tex) this.ensure(1)
    return this.tex!
  }

  get created(): boolean {
    return this.tex !== null
  }

  /**
   * Makes room for `layers` layers (≤ maxLayers). Returns false when a growth's GPU copy failed: the new array's old
   * layers are then empty and the owner must upload them again.
   */
  ensure(layers: number): boolean {
    if (layers > this.maxLayers) throw new Error(`${this.name}: ${layers} layers > ${this.maxLayers}`)
    if (this.tex && layers <= this.cap) return true
    // At least the first capacity, then 25 % headroom rounded up to 4 layers (doubling left a third of a 1024² atlas
    // empty: ≈ 5.6 MB a layer).
    const first = Math.max(1, Math.min(this.maxLayers, this.first))
    const cap = !this.cap && layers <= first ? first : Math.min(this.maxLayers, Math.max(layers, first, Math.ceil((layers * 1.25) / 4) * 4))
    const next = createArrayTexture(this.scene, this.size, cap, this.levels, this.name)
    let ok = true
    const old = this.tex
    if (old) {
      ok = copyArrayLayers(this.scene, old, next, this.cap, this.levels)
      this.grows++
      if (!ok) this.copyFailures++
      old.dispose()
    }
    this.tex = next
    this.cap = cap
    if (old) this.onChanged.notifyObservers(next)
    return ok
  }

  /** Resident bytes (every allocated layer with its levels). */
  get bytes(): number {
    let per = 0
    for (let l = 0; l < this.levels; l++) per += Math.max(1, this.size >> l) ** 2 * 4
    return this.cap * per
  }

  dispose(): void {
    this.tex?.dispose()
    this.tex = null
    this.cap = 0
    this.onChanged.clear()
  }
}

// ---- the cell decoder: a worker pool, or the main thread ------------------------------------------------------------

/** Runs cell jobs (the worker pool; tests pass an in-process one). */
export interface CellDecoder {
  run(job: CellJob): Promise<CellResult>
  dispose?(): void
}

/** The image format of encoded bytes (WebP, PNG, JPEG; PNG when unknown). */
export function sniffMime(bytes: Uint8Array): string {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return 'image/png'
}

/** Main-thread decoders over a WorldIO (the world's Assets.io; default the browser's). */
export function mainCellDecoders(io: WorldIO = browserIO): CellDecoders {
  return {
    url: async (url, size) => io.decodeImage(await io.bytes(url), mimeOf(url), size),
    bytes: bytes => io.decodeImage(bytes, sniffMime(bytes)),
  }
}

/** Runs cell jobs on the calling thread (tests; the pool's fallback). */
export function inlineCellDecoder(dec: CellDecoders): CellDecoder {
  return { run: job => runCellJob(job, dec) }
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, (globalThis as { location?: { href?: string } }).location?.href ?? 'http://localhost/').href
  } catch {
    return url
  }
}

function absoluteMapJob(job: MapJob): MapJob {
  if (job.kind === 'image') return { ...job, url: absoluteUrl(job.url) }
  if (job.kind === 'normal') return { ...job, nx: absoluteUrl(job.nx), ny: absoluteUrl(job.ny) }
  const out: MapJob = { ...job }
  if (job.ao) out.ao = absoluteUrl(job.ao)
  if (job.rough) out.rough = absoluteUrl(job.rough)
  if (job.metal) out.metal = absoluteUrl(job.metal)
  if (job.height) out.height = absoluteUrl(job.height)
  return out
}

function absoluteImage(img: CellImage | null | undefined): CellImage | null {
  if (!img) return null
  if (img.kind === 'url') return { kind: 'url', url: absoluteUrl(img.url) }
  if (img.kind === 'map') return { kind: 'map', job: absoluteMapJob(img.job) }
  return img
}

/** The job with absolute URLs (a worker resolves relative URLs against its own script). */
export function absoluteCellJob(job: CellJob): CellJob {
  if (job.kind === 'cell-nrao') return { ...job, normal: absoluteImage(job.normal), orm: absoluteImage(job.orm) }
  if (job.kind === 'cell-albedo') return { ...job, image: absoluteImage(job.image)!, mask: absoluteImage(job.mask) }
  return { ...job, image: absoluteImage(job.image)! }
}

interface WorkerSlot {
  worker: Worker
  busy: number
}

interface PendingCell {
  job: CellJob
  slot: WorkerSlot
  resolve: (r: CellResult) => void
  reject: (e: Error) => void
}

/**
 * The page's cell workers (the TX-R decode worker script, pbr/decode-worker.ts; at most `max`, started on demand):
 * `run` posts a job to the least busy one, or runs it on the main thread when workers cannot run (no Worker /
 * OffscreenCanvas; a worker that failed to start: every pending job is re-run on the main thread and no worker is
 * tried again).
 */
export class CellWorkers implements CellDecoder {
  private readonly slots: WorkerSlot[] = []
  private readonly pending = new Map<number, PendingCell>()
  private seq = 0
  private broken = false
  /** Jobs decoded by a worker / on the main thread. */
  readonly counts = { worker: 0, main: 0 }

  constructor(private readonly max = 2, private readonly fallback: CellDecoders = mainCellDecoders()) {}

  run(job: CellJob): Promise<CellResult> {
    const slot = this.slot()
    if (!slot) {
      this.counts.main++
      return runCellJob(job, this.fallback)
    }
    return new Promise<CellResult>((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { job, slot, resolve, reject })
      slot.busy++
      slot.worker.postMessage({ id, job: absoluteCellJob(job) })
    })
  }

  private slot(): WorkerSlot | null {
    if (this.broken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null
    if (this.slots.length < this.max && this.slots.every(s => s.busy > 0)) this.spawn()
    let best: WorkerSlot | null = null
    for (const s of this.slots) if (!best || s.busy < best.busy) best = s
    return best
  }

  private spawn(): void {
    let worker: Worker
    try {
      worker = new Worker(new URL('../pbr/decode-worker.ts', import.meta.url), { type: 'module', name: 'sro-cell-decode' })
    } catch (err) {
      this.fail(`${err}`)
      return
    }
    const slot: WorkerSlot = { worker, busy: 0 }
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { ready?: boolean; id?: number; result?: CellResult; error?: string }
      if (m.ready || m.id === undefined) return
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      slot.busy--
      if (m.error !== undefined) p.reject(new Error(m.error))
      else {
        this.counts.worker++
        p.resolve(m.result!)
      }
    }
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault?.()
      this.fail(e.message || 'worker error')
    }
    this.slots.push(slot)
  }

  private fail(why: string): void {
    if (!this.broken) console.warn('[batch] cell decode worker unavailable; decoding on the main thread:', why)
    this.broken = true
    for (const s of this.slots.splice(0)) s.worker.terminate()
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) {
      this.counts.main++
      runCellJob(p.job, this.fallback).then(p.resolve, p.reject)
    }
  }

  dispose(): void {
    for (const s of this.slots.splice(0)) s.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('cell decoder disposed'))
    this.pending.clear()
  }
}

let pageCells: CellWorkers | null = null

/** Cell workers for this machine: 2, up to 4 where there are the cores (the map decoder and the merge worker run too). */
export function cellWorkerCount(cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4): number {
  return Math.max(2, Math.min(4, Math.floor(cores / 3)))
}

/** The page's shared cell workers. */
export function sharedCellWorkers(): CellWorkers {
  return (pageCells ??= new CellWorkers(cellWorkerCount()))
}

// ---- where a cell's pixels come from ------------------------------------------------------------------------------

/**
 * The encoded image bytes of a texture the glTF loader made (a glb's embedded image: the InternalTexture keeps the
 * bytes for context loss, which neither engine turns off here), copied out of the glb's buffer; null when the texture
 * has none (a raw texture, a disposed one, NullEngine).
 */
export function encodedBytesOf(tex: BaseTexture | null | undefined): Uint8Array<ArrayBuffer> | null {
  const view = encodedView(tex)
  return view ? (view.slice() as Uint8Array<ArrayBuffer>) : null
}

/** The encoded bytes of a glTF-loaded texture as a view (no copy; see `encodedBytesOf`). */
export function encodedView(tex: BaseTexture | null | undefined): Uint8Array | null {
  const buf = (tex?.getInternalTexture() as { _buffer?: unknown } | null | undefined)?._buffer
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf)
  return null
}

/** The pixel size an encoded WebP, PNG or JPEG declares in its header (null: unknown), without decoding it. */
export function encodedSize(b: Uint8Array): { width: number; height: number } | null {
  const u16 = (o: number) => b[o]! | (b[o + 1]! << 8)
  const u24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)
  const be16 = (o: number) => (b[o]! << 8) | b[o + 1]!
  const be32 = (o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
  if (b.length >= 30 && sniffMime(b) === 'image/webp') {
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (fourcc === 'VP8 ') return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff }
    if (fourcc === 'VP8L') {
      const x = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0
      return { width: (x & 0x3fff) + 1, height: ((x >>> 14) & 0x3fff) + 1 }
    }
    if (fourcc === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 }
    return null
  }
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: be32(16), height: be32(20) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null
      const m = b[o + 1]!
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: be16(o + 7), height: be16(o + 5) }
      o += 2 + be16(o + 2)
    }
  }
  return null
}

/**
 * Rebuilds TX-R's decode job from a map cache key (pbr/maps.ts `applyMapRecord` + `PbrTextureCache.mapKey`:
 * `m|<s|l>|i|<url>[|<alpha>|<cutoff>]`, `m|l|n|<nx>|<ny>`, `m|l|o|<ao>|<rough>|<metal>|<height>|<rough>|<metal>`).
 * URL textures (KTX2 on Ultra) and packed ones have no CPU job: null.
 */
export function parseMapKey(key: string): MapJob | null {
  const p = key.split('|')
  if (p[0] !== 'm') return null
  if (p[2] === 'i') {
    const url = p[3]
    if (!url || /\.ktx2(?:[?#]|$)/i.test(url)) return null
    const alpha = p[4]
    if (alpha === 'cutout' || alpha === 'blend' || alpha === 'none') {
      const job: MapJob = { kind: 'image', url, alpha }
      if (alpha === 'cutout' && p[5]) job.cutoff = Number(p[5])
      return job
    }
    return { kind: 'image', url }
  }
  if (p[2] === 'n' && p[3] && p[4]) return { kind: 'normal', nx: p[3], ny: p[4] }
  if (p[2] === 'o') {
    const job: MapJob = { kind: 'ormh', defaults: { roughness: Number(p[7] ?? 0.8), metallic: Number(p[8] ?? 0) } }
    if (p[3]) job.ao = p[3]
    if (p[4]) job.rough = p[4]
    if (p[5]) job.metal = p[5]
    if (p[6]) job.height = p[6]
    return job.ao || job.rough || job.metal || job.height ? job : null
  }
  return null
}

/**
 * The decode job TX-R made a map texture with (a map set's albedo, normal map or ORMH; read from the cache's key of
 * the texture), so a cell can decode the same files again in the worker; null for anything else.
 */
export function mapJobOf(cache: PbrTextureCache | null | undefined, tex: BaseTexture | null | undefined): MapJob | null {
  const key = mapKeyOf(cache, tex)
  return key ? parseMapKey(key) : null
}

/** TX-R's cache key of a map texture (null: not one of the cache's); the content key of its cells. */
export function mapKeyOf(cache: PbrTextureCache | null | undefined, tex: BaseTexture | null | undefined): string | null {
  if (!cache || !tex) return null
  return (cache as unknown as { keyOfTex?: Map<BaseTexture, string> }).keyOfTex?.get(tex) ?? null
}

/** A short content hash (FNV-1a, 32 bit) of bytes: the dedupe key of an image without a texture path. */
export function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0') + bytes.length.toString(16)
}

// ---- the atlas: content-keyed cells in arrays of pages ---------------------------------------------------------------

/** A placed cell: its array, layer and texel rectangle (gutters included), and what its job measured. */
export interface Cell {
  readonly array: number
  readonly layer: number
  readonly x: number
  readonly y: number
  readonly shape: CellShape
  /** The main source's size and mean RGBA (0..255), as decoded. */
  readonly source: { width: number; height: number }
  readonly mean: readonly [number, number, number, number]
}

/** What a cell's inner area is in the table's terms (BATCHING §3.2 texel 0 / 1, and texel 4.w): offsets and scales. */
export interface CellTexel {
  layer: number
  u0: number
  v0: number
  uScale: number
  vScale: number
}

/** A cell's texel (its inner area, the gutter excluded) on `page`² pages. */
export function cellTexel(cell: Pick<Cell, 'layer' | 'x' | 'y' | 'shape'>, page: number): CellTexel {
  const s = cell.shape
  return {
    layer: cell.layer,
    u0: (cell.x + s.gutterX) / page,
    v0: (cell.y + s.gutterY) / page,
    uScale: (s.width - 2 * s.gutterX) / page,
    vScale: (s.height - 2 * s.gutterY) / page,
  }
}

/** What a caller asks the atlas for. */
export interface CellRequest {
  /** The content key (dedupe): equal keys share one cell. */
  key: string
  /** The cell's shape when the source size is known (the cell is placed at once); null: after the decode. */
  shape: CellShape | null
  /** Makes the job (called once, only when the cell is not resident; it may copy bytes, so it is lazy). */
  job(shape: CellShape | null): CellJob
}

/** One user's claim on a cell (release it once). */
export interface CellClaim {
  readonly key: string
  /** Resolves once the cell has its place (its table texel is known); rejects when its job or allocation failed. */
  readonly placed: Promise<Cell>
  /** Resolves once its pixels are uploaded (the batch may draw it). */
  readonly ready: Promise<Cell>
  /** The cell once placed (at once when the request gave its shape), else null. */
  readonly cell: Cell | null
  /** The job or the allocation failed (the claim holds nothing). */
  readonly failed: boolean
  release(): void
}

interface Entry {
  key: string
  refs: number
  gen: number
  job: CellJob | null
  cell: Cell | null
  block: CellBlock | null
  array: number
  state: 'decoding' | 'uploading' | 'ready' | 'failed'
  placed: Promise<Cell>
  ready: Promise<Cell>
  place: (c: Cell) => void
  done: (c: Cell) => void
  fail: (e: Error) => void
  releasedAt: number
}

export interface AtlasOptions {
  /** Array name (and the texture's label): 'batch:albedo', 'batch:nrao', 'batch:lightmaps'. */
  name: string
  /** Page (layer) size: ATLAS_PAGE, or LIGHTMAP_PAGE. */
  page: number
  /** Mip levels of each page (ATLAS_LEVELS; the lightmaps 2). */
  levels: number
  decoder: CellDecoder
  /** Main-thread jobs (the uploads) inside the frame budget: the streamer's queue. Default: at once. */
  job?: (run: () => void) => void
  /** Most layers per array before a spill (≤ MAX_ARRAY_LAYERS). */
  maxLayers?: number
  /** Most arrays (1: never spill; a cell that finds no room fails instead). Default: unlimited. */
  maxArrays?: number
  /** Layers of a new array on the GPU (grown as it fills). */
  firstLayers?: number
  /** Bytes per upload job (≈ 0.1–0.3 ms on WebGL2 at 256 KiB). */
  jobBytes?: number
  /** Seconds an unused cell is kept. */
  graceS?: number
  now?: () => number
}

interface ArraySlot {
  alloc: CellAllocator
  gpu: ArrayTexture
}

/**
 * One atlas (the albedo, the NRAO or the lightmaps): content-keyed cells in arrays of pages, reference counted, decoded
 * by the cell workers and written by sub-rectangle upload jobs. `textureOf(i)` is array i (bind it at draw time: it is
 * replaced when the array grows).
 */
export class AtlasArrays {
  private readonly arrays: ArraySlot[] = []
  private readonly entries = new Map<string, Entry>()
  private readonly unused = new Set<Entry>()
  private gen = 0
  private readonly runJob: (run: () => void) => void
  private readonly now: () => number
  readonly maxLayers: number
  /** Fired with (array index, texture) when an array's texture is replaced (growth) or first made. */
  readonly onTexture = new Observable<{ array: number; texture: BaseTexture }>()
  readonly stats = { decoded: 0, failures: 0, uploads: 0, uploadMs: 0, uploadMaxMs: 0, evicted: 0, reuploads: 0 }
  /** The last 256 upload job times (ms; the lab panel and the "≤ 0.5 ms a job" budget). */
  readonly uploadTimes: number[] = []

  constructor(private readonly scene: Scene, readonly opts: AtlasOptions) {
    this.runJob = opts.job ?? (run => run())
    this.now = opts.now ?? (() => performance.now())
    this.maxLayers = Math.min(MAX_ARRAY_LAYERS, Math.max(1, opts.maxLayers ?? MAX_ARRAY_LAYERS))
  }

  get page(): number {
    return this.opts.page
  }

  /** Arrays in use (1 until a spill). */
  get arrayCount(): number {
    return Math.max(1, this.arrays.length)
  }

  /** Array `i`'s texture (array 0 exists from the first call; a placeholder layer until cells arrive). */
  textureOf(i = 0): BaseTexture {
    return this.arraySlot(i).gpu.texture
  }

  /** Resident cells (used or waiting out their grace time). */
  get cells(): number {
    return this.entries.size
  }

  /** Cells nobody uses (kept for `graceS`). */
  get unusedCells(): number {
    return this.unused.size
  }

  /** Pages allocated, over every array. */
  get pages(): number {
    return this.arrays.reduce((n, a) => n + a.alloc.pages, 0)
  }

  /** Layers per array (the allocator's pages; never above maxLayers). */
  get layersPerArray(): number[] {
    return this.arrays.map(a => a.alloc.pages)
  }

  /** GPU bytes of every array (allocated layers × levels). */
  get bytes(): number {
    return this.arrays.reduce((n, a) => n + a.gpu.bytes, 0)
  }

  /** Share of the allocated pages' texels in cells. */
  get fill(): number {
    const pages = this.pages
    return pages ? this.arrays.reduce((n, a) => n + a.alloc.usedTexels, 0) / (pages * this.page * this.page) : 0
  }

  /** The cell for `req.key`, shared with every other claim on it. */
  acquire(req: CellRequest): CellClaim {
    let e = this.entries.get(req.key)
    if (!e) e = this.create(req)
    e.refs++
    this.unused.delete(e)
    let released = false
    const entry = e
    return {
      key: req.key,
      placed: e.placed,
      ready: e.ready,
      get cell() {
        return entry.cell
      },
      get failed() {
        return entry.state === 'failed'
      },
      release: () => {
        if (released) return
        released = true
        this.releaseEntry(e!)
      },
    }
  }

  /** The claim count of a key (tests, the console). */
  refs(key: string): number {
    return this.entries.get(key)?.refs ?? 0
  }

  /** Evicts unused cells older than the grace time (call once a frame; cheap when none wait). */
  update(now = this.now()): number {
    if (!this.unused.size) return 0
    const grace = (this.opts.graceS ?? 30) * 1000
    let n = 0
    for (const e of [...this.unused]) {
      if (now - e.releasedAt >= grace) {
        this.evict(e)
        n++
      }
    }
    return n
  }

  /** Drops every cell (the path switch, the Advanced toggle): claims still decoding reject; the arrays are freed. */
  clear(): void {
    this.gen++
    const pending = [...this.entries.values()]
    this.entries.clear()
    this.unused.clear()
    for (const e of pending) if (e.state === 'decoding' || e.state === 'uploading') e.fail(new Error('atlas cleared'))
    for (const a of this.arrays) a.gpu.dispose()
    this.arrays.length = 0
  }

  dispose(): void {
    this.clear()
    this.onTexture.clear()
  }

  // ---- internals ----

  private arraySlot(i: number): ArraySlot {
    while (this.arrays.length <= i) {
      const index = this.arrays.length
      const gpu = new ArrayTexture(this.scene, this.page, this.opts.levels, index ? `${this.opts.name}#${index}` : this.opts.name,
        Math.min(this.maxLayers, this.opts.firstLayers ?? 4), this.maxLayers)
      gpu.onChanged.add(texture => this.onTexture.notifyObservers({ array: index, texture }))
      this.arrays.push({ alloc: new CellAllocator(this.page, this.maxLayers), gpu })
    }
    return this.arrays[i]!
  }

  private create(req: CellRequest): Entry {
    let place!: (c: Cell) => void
    let done!: (c: Cell) => void
    let failPlaced!: (e: Error) => void
    let failReady!: (e: Error) => void
    const placed = new Promise<Cell>((res, rej) => {
      place = res
      failPlaced = rej
    })
    const ready = new Promise<Cell>((res, rej) => {
      done = res
      failReady = rej
    })
    placed.catch(() => {})
    ready.catch(() => {})
    const e: Entry = {
      key: req.key, refs: 0, gen: this.gen, job: null, cell: null, block: null, array: 0, state: 'decoding',
      placed, ready, place, done, releasedAt: 0,
      fail: err => {
        if (e.state === 'failed') return
        e.state = 'failed'
        failPlaced(err)
        failReady(err)
      },
    }
    this.entries.set(req.key, e)
    if (req.shape) {
      if (!this.placeEntry(e, req.shape, null)) return e
    }
    let job: CellJob
    try {
      job = req.job(req.shape)
    } catch (err) {
      this.failEntry(e, err)
      return e
    }
    e.job = job
    this.opts.decoder.run(job).then(r => this.decoded(e, r), err => this.failEntry(e, err))
    return e
  }

  /** Allocates the entry's block for `shape` and resolves `placed` (false when the atlas is full). */
  private placeEntry(e: Entry, shape: CellShape, result: CellResult | null): boolean {
    let got: { array: number; block: CellBlock } | null
    try {
      got = this.allocate(shape.width, shape.height)
    } catch (err) {
      this.failEntry(e, err)
      return false
    }
    if (!got) {
      this.failEntry(e, new Error(`${this.opts.name}: no room for a ${shape.width}x${shape.height} cell`))
      return false
    }
    e.block = got.block
    e.array = got.array
    e.cell = {
      array: got.array, layer: got.block.page, x: got.block.x, y: got.block.y, shape,
      source: result?.source ?? { width: 0, height: 0 }, mean: result?.mean ?? [0, 0, 0, 0],
    }
    e.place(e.cell)
    return true
  }

  private decoded(e: Entry, r: CellResult): void {
    if (e.gen !== this.gen || this.entries.get(e.key) !== e) return
    this.stats.decoded++
    if (!e.block) {
      if (!this.placeEntry(e, r.shape, r)) return
    } else {
      if (r.shape.width !== e.cell!.shape.width || r.shape.height !== e.cell!.shape.height) {
        this.failEntry(e, new Error(`${this.opts.name}: ${e.key} decoded to ${r.shape.width}x${r.shape.height}, placed ${e.cell!.shape.width}x${e.cell!.shape.height}`))
        return
      }
      e.cell = { ...e.cell!, source: r.source, mean: r.mean }
    }
    this.upload(e, r.levels, () => {
      e.state = 'ready'
      e.done(e.cell!)
      if (e.refs <= 0) this.markUnused(e)
    })
  }

  /** Queues a cell's upload jobs; `then` runs after the last. A cleared or evicted entry drops the rest. */
  private upload(e: Entry, levels: readonly Level[], then: () => void): void {
    e.state = 'uploading'
    const block = e.block!
    const jobs = planArrayRect(levels.slice(0, this.opts.levels), block.x, block.y, this.opts.jobBytes ?? 256 * 1024)
    let i = 0
    const step = () => {
      if (e.gen !== this.gen || e.block !== block || e.state === 'failed') return
      const t0 = performance.now()
      const slot = this.arrays[e.array]
      const ok = !!slot && (i >= jobs.length || uploadArrayRect(this.scene, slot.gpu.texture, block.page, jobs[i]!))
      const ms = performance.now() - t0
      this.stats.uploads++
      this.stats.uploadMs += ms
      if (ms > this.stats.uploadMaxMs) this.stats.uploadMaxMs = ms
      if (this.uploadTimes.push(ms) > 256) this.uploadTimes.shift()
      i++
      if (!ok) {
        this.failEntry(e, new Error(`${this.opts.name}: upload failed`))
        return
      }
      if (i < jobs.length) this.runJob(step)
      else then()
    }
    this.runJob(step)
  }

  private failEntry(e: Entry, err: unknown): void {
    this.stats.failures++
    if (e.block) {
      this.arrays[e.array]?.alloc.release(e.block)
      e.block = null
    }
    e.cell = null
    e.fail(err instanceof Error ? err : new Error(String(err)))
    // A failed key stays known (no retry storm); its claims hold nothing.
    this.unused.delete(e)
    e.job = null
  }

  private releaseEntry(e: Entry): void {
    if (this.entries.get(e.key) !== e) return
    if (--e.refs > 0) return
    e.refs = 0
    if (e.state === 'failed') {
      this.entries.delete(e.key)
      return
    }
    if (e.state === 'ready') this.markUnused(e)
    // Still decoding or uploading: it becomes unused when it is ready (decoded / upload's `then`).
  }

  private markUnused(e: Entry): void {
    e.releasedAt = this.now()
    this.unused.add(e)
  }

  private evict(e: Entry): void {
    this.unused.delete(e)
    if (this.entries.get(e.key) === e) this.entries.delete(e.key)
    if (e.block) this.arrays[e.array]?.alloc.release(e.block)
    e.block = null
    this.stats.evicted++
  }

  /** The oldest unused cell. */
  private oldestUnused(): Entry | null {
    let best: Entry | null = null
    for (const e of this.unused) if (!best || e.releasedAt < best.releasedAt) best = e
    return best
  }

  /**
   * A block for a w × h cell: a free block in any array without adding a page; else the unused cells are evicted
   * (oldest first) until one frees; else a page is added to the first array with room (the GPU array grows); else a
   * new array (the spill).
   */
  private allocate(w: number, h: number): { array: number; block: CellBlock } | null {
    const tryAll = (grow: boolean) => {
      for (let i = 0; i < this.arrays.length; i++) {
        const block = this.arrays[i]!.alloc.alloc(w, h, grow)
        if (block) return { array: i, block }
      }
      return null
    }
    let got = tryAll(false)
    while (!got && this.unused.size) {
      this.evict(this.oldestUnused()!)
      got = tryAll(false)
    }
    if (!got) got = tryAll(true)
    if (!got && this.arrays.length < (this.opts.maxArrays ?? Infinity)) {
      const i = this.arrays.length
      const block = this.arraySlot(i).alloc.alloc(w, h, true)
      got = block ? { array: i, block } : null
    }
    if (!got) return null
    const slot = this.arraySlot(got.array)
    const created = slot.gpu.created
    if (!slot.gpu.ensure(slot.alloc.pages)) this.reupload(got.array)
    if (!created) this.onTexture.notifyObservers({ array: got.array, texture: slot.gpu.texture })
    return got
  }

  /** After a growth whose GPU copy failed: every resident cell of that array decodes and uploads again. */
  private reupload(array: number): void {
    for (const e of this.entries.values()) {
      if (e.array !== array || !e.block || !e.job || (e.state !== 'ready' && e.state !== 'uploading')) continue
      const block = e.block
      const gen = this.gen
      this.stats.reuploads++
      this.opts.decoder.run(e.job).then(r => {
        if (gen !== this.gen || e.block !== block) return
        const wasReady = e.state === 'ready'
        this.upload(e, r.levels, () => {
          e.state = 'ready'
          if (!wasReady) e.done(e.cell!)
          // Released while it re-uploaded (releaseEntry leaves an uploading entry to its `then`): unused now.
          if (e.refs <= 0 && !this.unused.has(e)) this.markUnused(e)
        })
      }, err => console.warn('[batch] cell re-upload failed', e.key, err))
    }
  }
}
