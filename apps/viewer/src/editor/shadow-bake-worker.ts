/**
 * The editor's lightmap re-bake worker (H-12 GH-2; docs/WORLD_EDITOR.md §4.6 "Baked shadows follow": "the editor in a
 * worker, the converter at Publish"). It runs the converter's own node-free bake (packages/convert/src/world/edits/
 * shadows.ts `bakeEditedLightmap`) on the region's exported lightmap, so a moved or deleted object leaves no ghost
 * shadow in the editor and a planted tree shades the ground before Publish. ./shadow-bake.ts sends the jobs.
 *
 * Images: the region's lightmap PNG and the glbs' alpha textures (leaf cards) are decoded with createImageBitmap +
 * OffscreenCanvas (raw bytes: no colour-space conversion, no premultiplication); the glb reader's synchronous decoder
 * then reads them from a map filled before the parse.
 */
import { bakeEditedLightmap, type CasterInstance, type CasterPart } from '../../../../packages/convert/src/world/edits/shadows.ts'
import { readShadowCaster, type ShadowCaster } from '../../../../packages/convert/src/world/edits/glb.ts'

/** One region's bake (see ./shadow-bake.ts `BakeJob`). */
export interface BakeRequest {
  id: number
  rx: number
  rz: number
  origin: [number, number, number]
  /** The exported lightmap (the editor's base export). */
  imageUrl: string
  /** Heights (97 x 97, row z) of the region and its resident neighbours: the export's and the edited ones. */
  heights: Array<{ rx: number; rz: number; before: Float32Array; after: Float32Array }>
  gone: CasterInstance[]
  come: CasterInstance[]
  scene: CasterInstance[]
  /** Model index -> its glb URL. */
  glbs: Record<number, string>
}

export interface BakeResponse {
  id: number
  width: number
  height: number
  /** The region's lightmap with the edits baked in (or the export's when nothing of it changed). */
  rgba: Uint8Array | null
  error?: string
  ms: number
}

const CELLS = 96
const GRID = CELLS + 1

const images = new Map<string, Promise<{ width: number; height: number; rgba: Uint8Array }>>()
const glbBytes = new Map<string, Promise<Uint8Array>>()
const casters = new Map<string, ShadowCaster | null>()
const MAX_IMAGES = 24

async function decode(blob: Blob): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2D context in the worker')
  ctx.drawImage(bmp, 0, 0)
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  bmp.close()
  return { width: canvas.width, height: canvas.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

function baseImage(url: string): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  let p = images.get(url)
  if (!p) {
    p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`)
      return r.blob()
    }).then(decode)
    images.set(url, p)
    if (images.size > MAX_IMAGES) images.delete(images.keys().next().value!)
    p.catch(() => images.delete(url))
  }
  return p
}

function bytesOf(url: string): Promise<Uint8Array> {
  let p = glbBytes.get(url)
  if (!p) {
    p = fetch(url).then(async r => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`)
      return new Uint8Array(await r.arrayBuffer())
    })
    glbBytes.set(url, p)
    p.catch(() => glbBytes.delete(url))
  }
  return p
}

/** A model part's shadow geometry: the glb read twice, the second time with its alpha textures decoded. */
async function casterFor(url: string, tier: number | undefined): Promise<ShadowCaster | null> {
  const key = `${url}#${tier ?? ''}`
  if (casters.has(key)) return casters.get(key)!
  let out: ShadowCaster | null = null
  try {
    const bytes = await bytesOf(url)
    const wanted: Array<{ mime: string; bytes: Uint8Array }> = []
    readShadowCaster(bytes, { tier, decodeImage: (mime, b) => (wanted.push({ mime, bytes: b }), null) })
    const decoded = new Map<string, { width: number; height: number; rgba: Uint8Array }>()
    for (const w of wanted) {
      const k = `${w.bytes.byteOffset}:${w.bytes.byteLength}`
      if (decoded.has(k)) continue
      try {
        decoded.set(k, await decode(new Blob([w.bytes.slice()], { type: w.mime })))
      } catch {
        // an image the browser cannot decode: that part casts as opaque
      }
    }
    out = readShadowCaster(bytes, { tier, decodeImage: (_mime, b) => decoded.get(`${b.byteOffset}:${b.byteLength}`) ?? null })
  } catch (err) {
    console.warn('[editor] shadow caster', url, err)
    out = null
  }
  casters.set(key, out)
  return out
}

async function bake(req: BakeRequest): Promise<BakeResponse> {
  const t0 = performance.now()
  const base = await baseImage(req.imageUrl)
  const byRegion = new Map<string, { before: Float32Array; after: Float32Array }>()
  let maxH = -Infinity
  let changed = false
  for (const h of req.heights) {
    byRegion.set(`${h.rx}_${h.rz}`, h)
    for (let i = 0; i < h.after.length; i++) {
      const a = h.after[i]!, b = h.before[i]!
      if (a > maxH) maxH = a
      if (b > maxH) maxH = b
      if (!changed && a !== b) changed = true
    }
  }
  /** The global lattice (a vertex on a region border is in both regions: either one answers). */
  const lattice = (which: 'before' | 'after') => (ggx: number, ggz: number): number | undefined => {
    const rx = Math.floor(ggx / CELLS), rz = Math.floor(ggz / CELLS)
    const gx = ggx - rx * CELLS, gz = ggz - rz * CELLS
    const at = (x: number, z: number, ix: number, iz: number) => byRegion.get(`${x}_${z}`)?.[which][iz * GRID + ix]
    return at(rx, rz, gx, gz)
      ?? (gx === 0 ? at(rx - 1, rz, CELLS, gz) : undefined)
      ?? (gz === 0 ? at(rx, rz - 1, gx, CELLS) : undefined)
      ?? (gx === 0 && gz === 0 ? at(rx - 1, rz - 1, CELLS, CELLS) : undefined)
  }
  // every caster's geometry first (async fetches), then the synchronous bake
  const parts = new Map<string, ShadowCaster | null>()
  const partKey = (p: CasterPart) => `${p.model}#${p.tier ?? ''}`
  for (const c of [...req.gone, ...req.come, ...req.scene]) {
    for (const p of c.parts) {
      const k = partKey(p)
      if (parts.has(k)) continue
      const url = req.glbs[p.model]
      parts.set(k, url ? await casterFor(url, p.tier) : null)
    }
  }
  const result = bakeEditedLightmap({
    rx: req.rx, rz: req.rz, origin: req.origin,
    image: { width: base.width, height: base.height, rgba: base.rgba.slice() },
    heightBefore: lattice('before'), heightAfter: lattice('after'), terrainChanged: changed,
    maxHeightM: Number.isFinite(maxH) ? maxH : 0,
    gone: req.gone, come: req.come, scene: req.scene,
    load: p => parts.get(partKey(p)) ?? null,
  })
  const img = result?.image ?? base
  return { id: req.id, width: img.width, height: img.height, rgba: result ? img.rgba : base.rgba.slice(), ms: performance.now() - t0 }
}

self.onmessage = (ev: MessageEvent<BakeRequest>) => {
  const req = ev.data
  bake(req).then(
    res => (self as unknown as Worker).postMessage(res, res.rgba ? [res.rgba.buffer] : []),
    err => (self as unknown as Worker).postMessage({ id: req.id, width: 0, height: 0, rgba: null, error: String((err as Error)?.message ?? err), ms: 0 } satisfies BakeResponse),
  )
}
