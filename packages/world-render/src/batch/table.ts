/**
 * The batch material table (lane BT-A; docs/BATCHING.md §3.2, §3.4, §3.10, §3.13, F6, F8, F9, F23; docs/WAVE_PLAN6.md
 * §2.2, D5): every converted material a region batch merges becomes a **slot**, one row of one RGBA16F texture, and
 * its textures become cells of the atlases (atlas.ts) and the lightmap array (lightmaps.ts). One group material then
 * draws every class (BT-P's `SRO_TABLE` reads the row; BT-M packs (lightmap layer, slot) into each vertex's UV2).
 *
 * A slot's six texels (the layout BT-P's shader reads: surface-plugin.ts TABLE_TEXEL, checked by batch-textures.test):
 *
 * | Texel | Content |
 * |---|---|
 * | 0 albedo | albedo cell: layer, u offset, v offset, u scale (its v scale is texel 4.w) |
 * | 1 nrao | NRAO cell: layer (< 0 = none), u offset, v offset, u scale (v scale = u scale × albedo v / albedo u) |
 * | 2 surf | the surface plugin's `sroSurf`: luma-roughness k (0 with a roughness map), porosity, wet roughness, puddle |
 * | 3 params | metallic (an ORM's mean metal, F23), roughness, normal strength, flags (TABLE_FLAG: the NRAO's real planes) |
 * | 4 misc | direct intensity (0.8 for map sets that are not de-lit), SSR mask, alpha cut-off, albedo v scale |
 * | 5 emissive | NL's night lamp colour × level (written through `setEmissive`), a = 1 self-lit |
 *
 * Offsets are k / 1024 and scales 2⁻ⁿ (less a gutter of side / 64), which half floats hold exactly.
 *
 * `MaterialTable` is the batcher's `BatchTables` (region-batch.ts): `acquire(record)` answers at once with the slot and
 * the lightmap's place (the merge remaps UV2 with it); the cells decode in the workers and upload in stream jobs, and
 * `ready(entries)` resolves when a region's slots can draw. Slots are reference counted (every region holding a
 * material holds one reference); the row and its cells go with the last. A TX-R map set that lands later
 * (`ObjectMaterials.onMapsChanged`, D5) rewrites the slot's cells and texels only: no geometry rebuild. Converted
 * materials are only read, never changed (§4.5 finding 3).
 */
import { Observable, PBRMaterial, StandardMaterial, type BaseTexture, type Material, type Nullable, type Observer, type RawTexture, type Scene } from '@babylonjs/core'
import { keyOf } from '../../../texpipe/src/format.ts'
import type { MaterialBatchRecord, ObjectMaterials } from '../materials.ts'
import { classParams } from '../pbr/classes.ts'
import type { AlphaUse, CellImage, CellShape } from '../pbr/decode-core.ts'
import type { PbrTextureCache } from '../pbr/maps.ts'
import { createHalfTexture, uploadHalfRows } from '../textures.ts'
import {
  ATLAS_LEVELS,
  ATLAS_PAGE,
  AtlasArrays,
  cellShape,
  cellTexel,
  encodedBytesOf,
  encodedSize,
  encodedView,
  hashBytes,
  mapJobOf,
  mapKeyOf,
  nraoShape,
  parseMapKey,
  sharedCellWorkers,
  type Cell,
  type CellClaim,
  type CellDecoder,
} from './atlas.ts'
import { LIGHTMAP_QUADRANT, LightmapArray, WHITE_LIGHTMAP, type LightmapClaim, type LightmapPlacement } from './lightmaps.ts'
import type { BatchTableEntry, BatchTables, GroupMaterialKey } from './region-batch.ts'
import type { BatchHost } from './types.ts'

// ---- the layout ---------------------------------------------------------------------------------------------------

/** Texels per slot (one row each). */
export const TABLE_TEXELS = 6
/** What each texel of a slot holds (the order SRO_TABLE reads). */
export const TABLE_TEXEL = { albedo: 0, nrao: 1, surf: 2, params: 3, misc: 4, emissive: 5 } as const
/** Which planes of the slot's NRAO cell are real (texel 3.w is their sum); a missing one takes the table's value. */
export const TABLE_FLAG = { normal: 1, roughness: 2, ao: 4 } as const
/** Slots at most: the UV2 packing keeps ≤ 0.25 lightmap texel of precision while 2 × id < 8192 (BATCHING §3.3). */
export const TABLE_MAX_SLOTS = 4096

type Vec4 = readonly [number, number, number, number]

/** One slot's row, texel by texel. */
export interface SlotRow {
  albedo: Vec4
  nrao: Vec4
  surf: Vec4
  params: Vec4
  misc: Vec4
  emissive: Vec4
}

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** A number as an IEEE half float (round to nearest; NaN, ± infinity and overflow kept as such). */
export function toHalf(v: number): number {
  f32[0] = v
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  const mant = x & 0x7fffff
  if (exp === 0xff) return sign | (mant ? 0x7e00 : 0x7c00)
  const e = exp - 127 + 15
  if (e >= 31) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    const m = (mant | 0x800000) >> (1 - e)
    return sign | ((m + 0x1000) >> 13)
  }
  const h = sign | (e << 10) | (mant >> 13)
  return mant & 0x1000 ? h + 1 : h
}

/** A half float's value. */
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

const TEXELS: ReadonlyArray<keyof SlotRow> = ['albedo', 'nrao', 'surf', 'params', 'misc', 'emissive']

/** Writes a row's texels as half floats at `row` of `data` (TABLE_TEXELS × 4 halves per row). */
export function encodeRow(row: SlotRow, data: Uint16Array, index: number): void {
  const o = index * TABLE_TEXELS * 4
  TEXELS.forEach((k, t) => {
    const v = row[k]
    for (let c = 0; c < 4; c++) data[o + t * 4 + c] = toHalf(v[c]!)
  })
}

/** Reads a row back (the values the shader sees). */
export function decodeRow(data: Uint16Array, index: number): SlotRow {
  const o = index * TABLE_TEXELS * 4
  const texel = (t: number): Vec4 => [fromHalf(data[o + t * 4]!), fromHalf(data[o + t * 4 + 1]!), fromHalf(data[o + t * 4 + 2]!), fromHalf(data[o + t * 4 + 3]!)]
  return { albedo: texel(0), nrao: texel(1), surf: texel(2), params: texel(3), misc: texel(4), emissive: texel(5) }
}

// ---- the GPU table ------------------------------------------------------------------------------------------------

/**
 * The RGBA16F table texture: TABLE_TEXELS × rows, one slot per row, rows handed out from a free list and grown by
 * doubling (the texture is made again with every row). Writes go to the CPU copy; `flush` uploads the rows written
 * since (one sub-rectangle upload, ≤ 0.05 ms) before the frame renders.
 */
export class TableTexture {
  private data: Uint16Array
  private cap: number
  private tex: RawTexture | null = null
  private readonly freeRows: number[] = []
  private high = 0
  private live = 0
  private dirtyLo = Infinity
  private dirtyHi = -1
  private remake = true
  /** Fired with the new texture after a growth. */
  readonly onChanged = new Observable<BaseTexture>()
  /** Uploads, and the longest (ms). */
  readonly stats = { uploads: 0, uploadMaxMs: 0, grows: 0 }
  /** The last 256 upload times (ms). */
  readonly uploadTimes: number[] = []

  constructor(private readonly scene: Scene, capacity = 256) {
    this.cap = Math.max(1, Math.min(TABLE_MAX_SLOTS, capacity))
    this.data = new Uint16Array(this.cap * TABLE_TEXELS * 4)
  }

  /** The table (read at bind time: a growth replaces it). */
  get texture(): BaseTexture {
    if (!this.tex || this.remake) this.flush()
    return this.tex!
  }

  get capacity(): number {
    return this.cap
  }

  /** Rows in use. */
  get rows(): number {
    return this.live
  }

  /** A free row (zeroed), or -1 when TABLE_MAX_SLOTS are in use. */
  allocate(): number {
    let row = this.freeRows.pop()
    if (row === undefined) {
      if (this.high >= TABLE_MAX_SLOTS) return -1
      row = this.high++
      if (row >= this.cap) this.grow(row + 1)
    }
    this.live++
    return row
  }

  /** Gives a row back (zeroed). */
  free(row: number): void {
    if (row < 0 || row >= this.high || this.freeRows.includes(row)) return
    this.data.fill(0, row * TABLE_TEXELS * 4, (row + 1) * TABLE_TEXELS * 4)
    this.mark(row)
    this.freeRows.push(row)
    this.live--
  }

  writeRow(row: number, r: SlotRow): void {
    encodeRow(r, this.data, row)
    this.mark(row)
  }

  /** Writes one texel. */
  setTexel(row: number, texel: number, x: number, y: number, z: number, w: number): void {
    const o = (row * TABLE_TEXELS + texel) * 4
    this.data[o] = toHalf(x)
    this.data[o + 1] = toHalf(y)
    this.data[o + 2] = toHalf(z)
    this.data[o + 3] = toHalf(w)
    this.mark(row)
  }

  /** One texel's current value (the CPU copy). */
  texel(row: number, texel: number): [number, number, number, number] {
    const o = (row * TABLE_TEXELS + texel) * 4
    return [fromHalf(this.data[o]!), fromHalf(this.data[o + 1]!), fromHalf(this.data[o + 2]!), fromHalf(this.data[o + 3]!)]
  }

  readRow(row: number): SlotRow {
    return decodeRow(this.data, row)
  }

  /** The rows' half floats (tests). */
  get halves(): Uint16Array {
    return this.data
  }

  /** Uploads what changed (or makes the texture after a growth). Cheap when nothing did. */
  flush(): void {
    if (this.remake || !this.tex) {
      const old = this.tex
      this.tex = createHalfTexture(this.scene, this.data, TABLE_TEXELS, this.cap, 'batch:materialTable')
      this.remake = false
      this.dirtyLo = Infinity
      this.dirtyHi = -1
      if (old) {
        old.dispose()
        this.onChanged.notifyObservers(this.tex)
      }
      return
    }
    if (this.dirtyHi < 0) return
    const t0 = performance.now()
    if (!uploadHalfRows(this.scene, this.tex, this.data, TABLE_TEXELS, this.dirtyLo, this.dirtyHi - this.dirtyLo + 1)) this.remake = true
    const ms = performance.now() - t0
    this.stats.uploads++
    if (ms > this.stats.uploadMaxMs) this.stats.uploadMaxMs = ms
    if (this.uploadTimes.push(ms) > 256) this.uploadTimes.shift()
    this.dirtyLo = Infinity
    this.dirtyHi = -1
    if (this.remake) this.flush()
  }

  dispose(): void {
    this.tex?.dispose()
    this.tex = null
    this.remake = true
    this.onChanged.clear()
  }

  private mark(row: number): void {
    if (row < this.dirtyLo) this.dirtyLo = row
    if (row > this.dirtyHi) this.dirtyHi = row
  }

  private grow(rows: number): void {
    let cap = this.cap
    while (cap < rows) cap *= 2
    cap = Math.min(TABLE_MAX_SLOTS, cap)
    const next = new Uint16Array(cap * TABLE_TEXELS * 4)
    next.set(this.data)
    this.data = next
    this.cap = cap
    this.remake = true
    this.stats.grows++
  }
}

// ---- where a slot's pixels and values come from -----------------------------------------------------------------

/** One source image of a slot: its content key (dedupe), its size when known, and how to make it (lazy: it may copy). */
export interface ImageSource {
  key: string
  size: { width: number; height: number } | null
  image(): CellImage
}

/** Everything a slot is made from (read from its converted material by `slotSources`). */
export interface SlotSources {
  albedo: ImageSource
  /** TX-R's retail cut-out mask when a map set's albedo has no alpha (its alpha, or its luminance). */
  mask: (ImageSource & { fromRgb: boolean }) | null
  alpha: AlphaUse
  cutoff: number
  normal: ImageSource | null
  orm: (ImageSource & { ao: boolean }) | null
  invertX: boolean
  invertY: boolean
  lightmap: ImageSource | null
  /** Texel 2. */
  surf: Vec4
  metallic: number
  roughness: number
  normalStrength: number
  directIntensity: number
  ssr: number
  /** Texel 5.w: the lamp group multiplies the emissive by the albedo (SRO_SELFLIT). */
  selfLit: boolean
}

/** Retail albedo without a texture, and the fallback of a cell that failed: Jangan's BMT grey 150/255 (TERRAIN 3.2). */
const GREY: Vec4 = [150, 150, 150, 255]

interface SurfaceLike {
  surf: { x: number; y: number; z: number; w: number }
  ssr: number
  selfLit: boolean
  lamp: boolean
  roughnessMap: boolean
  setTable?(table: unknown): void
}

function surfaceOf(m: Material): SurfaceLike | null {
  return (m.pluginManager?.getPlugin('SroSurfacePlugin') as unknown as SurfaceLike | null) ?? null
}

/** TX-R's stand-ins (pbr/maps.ts holdPlaceholders) until a map set swaps in: not real maps. */
function isPlaceholder(tex: BaseTexture | null | undefined): boolean {
  return !!tex && tex.name.startsWith('sroPlaceholder:')
}

function sizeOf(tex: BaseTexture): { width: number; height: number } | null {
  const s = tex.getSize()
  if (s.width > 1 || s.height > 1) return { width: s.width, height: s.height }
  const view = encodedView(tex)
  return view ? encodedSize(view) : null
}

const toSrgbByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) ** (1 / 2.2) * 255)

/** A texture's source: TX-R's map job when it is a map set's, else the glb image's bytes (keyed by `retailKey`). */
function textureSource(tex: BaseTexture, retailKey: string | null, maps: PbrTextureCache | null | undefined): ImageSource | null {
  const mapKey = mapKeyOf(maps, tex)
  const job = mapJobOf(maps, tex)
  if (mapKey && job) return { key: `map|${mapKey}`, size: sizeOf(tex), image: () => ({ kind: 'map', job }) }
  const view = encodedView(tex)
  if (!view) return null
  return {
    key: retailKey ? `tex|${retailKey}` : `img|${hashBytes(view)}`,
    size: sizeOf(tex),
    image: () => {
      const bytes = encodedBytesOf(tex)
      if (!bytes) throw new Error(`${tex.name}: its image bytes are gone`)
      return { kind: 'bytes', bytes }
    },
  }
}

/** A record's albedo texture: its material's, else its fallback (a species LOD0's far sprite, TRL-1). */
function albedoTextureOf(record: MaterialBatchRecord): BaseTexture | null {
  const m = record.material
  const own = m instanceof PBRMaterial ? m.albedoTexture : m instanceof StandardMaterial ? m.diffuseTexture : null
  return own ?? record.albedoFallback?.() ?? null
}

/**
 * H-12 TRL-3: a crown tint's albedo at the tier its species draws. When TX-R swapped a map set into the base record
 * (its albedo is a map texture of the cache), the tint takes its own set's map of the same tier: the same map key with
 * the base set's folder replaced by the tint's (texpipe encodes every tint key with the base's tiers). null: the base
 * draws its embedded sprite (the tint keeps its 1x PNG).
 */
function tintMapSource(record: MaterialBatchRecord, maps: PbrTextureCache | null | undefined): ImageSource | null {
  const base = record.tintOf
  if (!base?.texture || !record.texture) return null
  const baseTex = albedoTextureOf(base)
  const baseKey = mapKeyOf(maps, baseTex)
  if (!baseKey || !baseTex) return null
  const stem = (k: string) => keyOf(k).replace(/\.[a-z0-9]+$/, '')
  const from = `/${stem(base.texture)}/`
  const at = baseKey.indexOf(from)
  if (at < 0) return null
  const key = `${baseKey.slice(0, at)}/${stem(record.texture)}/${baseKey.slice(at + from.length)}`
  const job = parseMapKey(key)
  if (!job) return null
  return { key: `map|${key}`, size: sizeOf(baseTex), image: () => ({ kind: 'map', job }) }
}

export interface SourceContext {
  /** TX-R's texture cache (a map set's textures → their decode jobs). */
  maps?: PbrTextureCache | null
  /** A lightmap URI → a URL the decoder can fetch (the world's Assets.url). */
  lightmapUrl?: (uri: string) => string
}

/**
 * What a converted PBR material's slot is made from (read only; the material is never changed): the albedo (a map
 * set's once swapped in, else the retail texture; a solid colour without one), TX-R's retail cut-out mask
 * (`opacityTexture`), the normal map and the ORM once the set's are bound (TX-R's stand-ins count as absent, their
 * roughness and metallic as the table's), the object lightmap, and the surface plugin's values.
 */
export function slotSources(record: MaterialBatchRecord, ctx: SourceContext = {}): SlotSources {
  const m = record.material
  const pbr = m instanceof PBRMaterial ? m : null
  const std = m instanceof StandardMaterial ? m : null
  const plugin = surfaceOf(m)
  const retailKey = record.texture ? keyOf(record.texture) : null
  const albedoTex = albedoTextureOf(record)
  let albedo = (record.tintOf ? tintMapSource(record, ctx.maps) : null) ?? (albedoTex ? textureSource(albedoTex, retailKey, ctx.maps) : null)
  if (!albedo) {
    const c = pbr?.albedoColor ?? std?.diffuseColor
    const rgba: Vec4 = albedoTex || !c ? GREY : [toSrgbByte(c.r), toSrgbByte(c.g), toSrgbByte(c.b), 255]
    albedo = { key: `solid|${rgba.join(',')}`, size: { width: 1, height: 1 }, image: () => ({ kind: 'solid', rgba }) }
  }
  const alpha: AlphaUse = record.alpha === 'mask' ? 'cutout' : record.alpha === 'blend' ? 'blend' : 'none'
  let mask: SlotSources['mask'] = null
  const op = pbr?.opacityTexture ?? null
  if (alpha !== 'none' && op && op !== albedoTex && pbr && !pbr.useAlphaFromAlbedoTexture) {
    const src = textureSource(op, retailKey, ctx.maps)
    if (src) mask = { ...src, fromRgb: !!(op as { getAlphaFromRGB?: boolean }).getAlphaFromRGB }
  }
  const bump = pbr?.bumpTexture ?? null
  const normal = bump && !isPlaceholder(bump) ? textureSource(bump, null, ctx.maps) : null
  const metal = pbr?.metallicTexture ?? null
  const ormSrc = metal && !isPlaceholder(metal) ? textureSource(metal, null, ctx.maps) : null
  const orm = ormSrc && pbr ? { ...ormSrc, ao: pbr.useAmbientOcclusionFromMetallicTextureRed } : null
  // The metallic and roughness the material draws with where no real ORM is bound: TX-R's stand-in ORMH carries the
  // set's defaults in its name (`sroPlaceholder:ormh:<r>:<m>`, bytes), multiplied by the material's (then 1).
  const cls = record.cls ? classParams(record.cls) : null
  let metallic = pbr?.metallic ?? cls?.metallic ?? 0
  let roughness = pbr?.roughness ?? cls?.roughness ?? 0.8
  const held = metal && isPlaceholder(metal) ? /ormh:(\d+):(\d+)/.exec(metal.name) : null
  if (held) {
    roughness *= Number(held[1]) / 255
    metallic *= Number(held[2]) / 255
  }
  let lightmap: ImageSource | null = null
  if (record.lightmap) {
    const uri = record.lightmap
    const lmTex = pbr?.lightmapTexture ?? std?.lightmapTexture ?? null
    lightmap = {
      key: uri,
      size: lmTex ? sizeOf(lmTex) : null,
      image: () => {
        const bytes = encodedBytesOf(lmTex)
        return bytes ? { kind: 'bytes', bytes } : { kind: 'url', url: ctx.lightmapUrl ? ctx.lightmapUrl(uri) : uri }
      },
    }
  }
  const s = plugin?.surf
  return {
    albedo,
    mask,
    alpha,
    cutoff: alpha === 'none' ? 0 : pbr?.alphaCutOff ?? 0.5,
    normal,
    orm,
    invertX: !!pbr?.invertNormalMapX,
    invertY: !!pbr?.invertNormalMapY,
    lightmap,
    surf: s ? [plugin!.roughnessMap ? 0 : s.x, s.y, s.z, s.w] : [0, 0, 0.5, 0],
    metallic,
    roughness,
    normalStrength: normal && bump ? bump.level : 1,
    directIntensity: pbr?.directIntensity ?? 1,
    ssr: plugin?.ssr ?? 0,
    selfLit: !!(plugin?.selfLit || plugin?.lamp),
  }
}

// ---- the material table ---------------------------------------------------------------------------------------------

export interface MaterialTableOptions {
  /** Main-thread jobs (the cell uploads) inside the frame budget: the streamer's queue. Default: at once. */
  job?: (run: () => void) => void
  /** Cell decodes (default: the page's cell workers; the main thread where workers cannot run). */
  decoder?: CellDecoder
  /** The converted materials: a TX-R map set that lands later rewrites its slot (`onMapsChanged`). */
  materials?: ObjectMaterials | null
  /** TX-R's texture cache (default: `materials.pbr.cache`). */
  maps?: PbrTextureCache | null
  /** A lightmap URI → a URL (default: `materials.assets.url`). */
  lightmapUrl?: (uri: string) => string
  /** A record's sources (tests); default `slotSources`. */
  sources?: (record: MaterialBatchRecord) => SlotSources
  /** Atlas page size (ATLAS_PAGE) and levels (ATLAS_LEVELS). */
  page?: number
  levels?: number
  /** Most layers per array (≤ 256; the table never spills: a cell that finds no room refuses its slot). */
  maxLayers?: number
  /** First GPU layers of the atlases and the lightmap array (grown as they fill). */
  firstLayers?: number
  firstLightmapLayers?: number
  /** First table rows (doubled as needed, ≤ TABLE_MAX_SLOTS). */
  rows?: number
  /** Bytes per upload job. */
  jobBytes?: number
  /** Seconds an unused cell stays resident. */
  graceS?: number
  now?: () => number
  /** Flush the table and evict before every render (default true; tests call `flush` themselves). */
  autoFlush?: boolean
}

/** What BT-P's SRO_TABLE binds (surface-plugin.ts `SurfaceTable`): the current textures, read at every bind. */
export interface TableTextures {
  readonly albedo: BaseTexture | null
  readonly nrao: BaseTexture | null
  readonly lightmap: BaseTexture | null
  readonly table: BaseTexture | null
}

interface Slot {
  record: MaterialBatchRecord
  row: number
  refs: number
  gen: number
  src: SlotSources
  albedo: CellClaim
  nrao: CellClaim | null
  lightmap: LightmapClaim | null
  place: LightmapPlacement
  /** Texel 5 as NL last wrote it. */
  emissive: [number, number, number]
  placed: Promise<void>
  ready: Promise<void>
  released: boolean
}

/** One region's reference on a slot (BatchTableEntry: the slot and its lightmap's place). */
class TableEntry implements BatchTableEntry {
  released = false
  constructor(readonly owner: Slot) {}
  get slot(): number {
    return this.owner.row
  }
  get layer(): number {
    return this.owner.place.layer
  }
  get scale(): number {
    return this.owner.place.scale
  }
  get offsetU(): number {
    return this.owner.place.u0
  }
  get offsetV(): number {
    return this.owner.place.v0
  }
}

/**
 * The material table and its atlases (the batcher's `BatchTables`). Make one per batching part (`createMaterialTable`);
 * `dispose` frees every slot, cell and texture (the path switch, the Advanced toggle).
 */
export class MaterialTable implements BatchTables {
  readonly lamps = true
  readonly table: TableTexture
  readonly albedo: AtlasArrays
  readonly nrao: AtlasArrays
  readonly lightmaps: LightmapArray
  private readonly slots = new Map<MaterialBatchRecord, Slot>()
  private readonly byRow = new Map<number, Slot>()
  private readonly page: number
  private readonly levels: number
  private readonly sourcesOf: (record: MaterialBatchRecord) => SlotSources
  private readonly mapsObserver: Nullable<Observer<MaterialBatchRecord>> = null
  private readonly renderObserver: Nullable<Observer<Scene>> = null
  private disposed = false
  /** Counters for the lab panel (BT-L) and the budgets. */
  readonly counts = { refused: 0, refreshed: 0, lightmapGuessed: 0, fallbackCells: 0 }
  /** The textures SRO_TABLE binds (getters: a grown array is picked up at the next bind). */
  readonly textures: TableTextures

  constructor(readonly scene: Scene, readonly opts: MaterialTableOptions = {}) {
    this.page = opts.page ?? ATLAS_PAGE
    this.levels = opts.levels ?? ATLAS_LEVELS
    const decoder = opts.decoder ?? sharedCellWorkers()
    const common = {
      page: this.page, levels: this.levels, decoder, job: opts.job, maxLayers: opts.maxLayers, maxArrays: 1,
      firstLayers: opts.firstLayers ?? 4, jobBytes: opts.jobBytes, graceS: opts.graceS, now: opts.now,
    }
    this.table = new TableTexture(scene, opts.rows ?? 256)
    this.albedo = new AtlasArrays(scene, { ...common, name: 'batch:albedo' })
    this.nrao = new AtlasArrays(scene, { ...common, name: 'batch:nrao' })
    this.lightmaps = new LightmapArray(scene, {
      decoder, job: opts.job, maxLayers: opts.maxLayers, maxArrays: 1, firstLayers: opts.firstLightmapLayers, jobBytes: opts.jobBytes,
      graceS: opts.graceS, now: opts.now,
    })
    const maps = opts.maps !== undefined ? opts.maps : opts.materials?.pbr?.cache ?? null
    const lightmapUrl = opts.lightmapUrl ?? (opts.materials ? (uri: string) => opts.materials!.assets.url(uri) : undefined)
    this.sourcesOf = opts.sources ?? (record => slotSources(record, { maps, lightmapUrl }))
    if (opts.materials) {
      this.mapsObserver = opts.materials.onMapsChanged.add(rec => {
        this.refresh(rec)
        // the records that read this one's albedo: its crown tints (TRL-3) and a LOD0's far-sprite fallback (TRL-1)
        for (const r of [...this.slots.keys()]) if (r !== rec && r.tintOf === rec) this.refresh(r)
      })
    }
    if (opts.autoFlush ?? true) this.renderObserver = scene.onBeforeRenderObservable.add(() => this.flush())
    const self = this
    this.textures = {
      get albedo() {
        return self.disposed ? null : self.albedo.textureOf(0)
      },
      get nrao() {
        return self.disposed ? null : self.nrao.textureOf(0)
      },
      get lightmap() {
        return self.disposed ? null : self.lightmaps.textureOf(0)
      },
      get table() {
        return self.disposed ? null : self.table.texture
      },
    }
  }

  /** Slots in use. */
  get size(): number {
    return this.slots.size
  }

  /**
   * A reference on the record's slot, made on first use (its row, its cells, its lightmap's place). null: the table
   * cannot hold it (not a PBR material, the table full, no room for its albedo cell): the batcher then keeps the
   * material in a material group.
   */
  acquire(record: MaterialBatchRecord): TableEntry | null {
    if (this.disposed || record.path !== 'pbr' || !(record.material instanceof PBRMaterial)) return null
    let s = this.slots.get(record)
    if (!s) {
      const made = this.make(record)
      if (!made) {
        this.counts.refused++
        return null
      }
      s = made
      this.slots.set(record, s)
      this.byRow.set(s.row, s)
    }
    s.refs++
    return new TableEntry(s)
  }

  /** Drops a reference; the slot's row and cells go with the last (cells wait out their grace time). */
  release(entry: BatchTableEntry): void {
    if (!(entry instanceof TableEntry) || entry.released) return
    entry.released = true
    const s = entry.owner
    if (s.released || --s.refs > 0) return
    this.free(s)
  }

  /** Resolves once every entry's slot has its row written and its cells uploaded (never rejects). */
  ready(entries: readonly BatchTableEntry[]): Promise<void> {
    const waits = entries.map(e => (e instanceof TableEntry ? e.owner.ready : Promise.resolve()))
    return Promise.all(waits).then(() => undefined)
  }

  /** Resolves once every entry's slot has its row written (its cells placed; pixels may still be uploading). */
  placed(entries: readonly BatchTableEntry[]): Promise<void> {
    return Promise.all(entries.map(e => (e instanceof TableEntry ? e.owner.placed : Promise.resolve()))).then(() => undefined)
  }

  /** Texel 5: NL's night lamp colour × level (display-referred, like `emissiveColor`). Unknown slots are ignored. */
  setEmissive(slot: number, r: number, g: number, b: number): void {
    const s = this.byRow.get(slot)
    if (!s) return
    s.emissive = [r, g, b]
    this.table.setTexel(slot, TABLE_TEXEL.emissive, r, g, b, s.src.selfLit ? 1 : 0)
  }

  /** Switches a group material to the table (BT-P's SroSurfacePlugin `setTable` with this table's textures). */
  bindMaterial(material: PBRMaterial, _key: Readonly<GroupMaterialKey>): void {
    const plugin = surfaceOf(material)
    if (!plugin?.setTable) throw new Error(`${material.name}: no SroSurfacePlugin with a table mode`)
    plugin.setTable(this.textures)
  }

  /** The row a slot holds now (tests, the console). */
  row(slot: number): SlotRow {
    return this.table.readRow(slot)
  }

  /** Uploads the rows written since the last frame and evicts cells unused past their grace time. */
  flush(): void {
    if (this.disposed) return
    this.table.flush()
    this.albedo.update()
    this.nrao.update()
    this.lightmaps.update()
  }

  /**
   * A TX-R map set swapped in on a record's material after its slot was made (D5): its cells are made again from the
   * new sources and the row rewritten once they are uploaded (the old cells draw until then). No geometry changes.
   */
  refresh(record: MaterialBatchRecord): void {
    const s = this.slots.get(record)
    if (!s || s.released) return
    const src = this.sourcesOf(record)
    const gen = ++s.gen
    this.counts.refreshed++
    const albedo = this.albedoClaim(src)
    if (albedo.failed) {
      albedo.release()
      return
    }
    const nraoOf = (cell: Cell) => this.nraoClaim(src, cell)
    const nraoP: Promise<CellClaim | null> = albedo.cell
      ? Promise.resolve(nraoOf(albedo.cell))
      : albedo.placed.then(c => nraoOf(c), () => null)
    void nraoP.then(async nrao => {
      await Promise.all([albedo.ready.catch(() => null), nrao?.ready.catch(() => null)])
      if (s.released || s.gen !== gen || this.disposed) {
        albedo.release()
        nrao?.release()
        return
      }
      const oldA = s.albedo
      const oldN = s.nrao
      s.albedo = albedo.failed ? oldA : albedo
      s.nrao = nrao && !nrao.failed ? nrao : null
      s.src = src
      this.writeRow(s)
      if (s.albedo !== oldA) oldA.release()
      else albedo.release()
      oldN?.release()
      if (nrao && s.nrao !== nrao) nrao.release()
    })
  }

  /** Counters: slots, rows, cells, pages, fill, VRAM, uploads (BT-L's panel). */
  get stats(): Record<string, number> {
    return {
      slots: this.slots.size,
      tableRows: this.table.capacity,
      albedoCells: this.albedo.cells,
      albedoPages: this.albedo.pages,
      albedoFill: +this.albedo.fill.toFixed(3),
      albedoBytes: this.albedo.bytes,
      nraoCells: this.nrao.cells,
      nraoPages: this.nrao.pages,
      nraoBytes: this.nrao.bytes,
      unusedCells: this.albedo.unusedCells + this.nrao.unusedCells,
      ...this.lightmaps.stats,
      cellUploads: this.albedo.stats.uploads + this.nrao.stats.uploads + this.lightmaps.atlas.stats.uploads,
      cellUploadMaxMs: +Math.max(this.albedo.stats.uploadMaxMs, this.nrao.stats.uploadMaxMs, this.lightmaps.atlas.stats.uploadMaxMs).toFixed(3),
      cellFailures: this.albedo.stats.failures + this.nrao.stats.failures + this.lightmaps.atlas.stats.failures,
      tableUploadMaxMs: +this.table.stats.uploadMaxMs.toFixed(3),
      ...this.counts,
    }
  }

  /** Frees every slot and cell (the batch part released every region). */
  clear(): void {
    for (const s of [...this.slots.values()]) this.free(s)
    this.albedo.clear()
    this.nrao.clear()
    this.lightmaps.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    if (this.mapsObserver) this.opts.materials?.onMapsChanged.remove(this.mapsObserver)
    if (this.renderObserver) this.scene.onBeforeRenderObservable.remove(this.renderObserver)
    this.albedo.dispose()
    this.nrao.dispose()
    this.lightmaps.dispose()
    this.table.dispose()
  }

  // ---- internals ----

  private albedoClaim(src: SlotSources): CellClaim {
    const a = src.albedo
    const shape = a.size ? cellShape(a.size.width, a.size.height, this.page, this.levels) : null
    const cutout = src.alpha !== 'none'
    const key = `a|${a.key}|${src.mask ? `${src.mask.key}|${src.mask.fromRgb ? 'rgb' : 'a'}` : '-'}|${cutout ? `cut${src.cutoff}` : 'opaque'}`
    return this.albedo.acquire({
      key,
      shape,
      job: sh => ({
        kind: 'cell-albedo', shape: sh, page: this.page, levels: this.levels, image: a.image(),
        mask: src.mask ? src.mask.image() : null, maskFromRgb: src.mask?.fromRgb ?? false,
        alpha: cutout ? 'cutout' : 'none', cutoff: src.cutoff, fallback: GREY,
      }),
    })
  }

  /** The NRAO cell of a slot (null: no real normal map or ORM), shaped after its albedo cell. */
  private nraoClaim(src: SlotSources, albedo: Cell): CellClaim | null {
    const n = src.normal
    const o = src.orm
    if (!n && !o) return null
    const size = n?.size ?? o?.size ?? null
    const shape = nraoShape(albedo.shape, size?.width ?? albedo.shape.width, size?.height ?? albedo.shape.height, this.page)
    const rough = o ? 0 : src.roughness
    const key = `n|${n?.key ?? '-'}|${o ? `${o.key}|${o.ao ? 'ao' : '-'}` : `-|${rough.toFixed(3)}`}|${src.invertX ? 1 : 0}${src.invertY ? 1 : 0}|${shape.width}x${shape.height}`
    const claim = this.nrao.acquire({
      key,
      shape,
      job: sh => ({
        kind: 'cell-nrao', shape: sh!, normal: n ? n.image() : null, orm: o ? o.image() : null,
        invertX: src.invertX, invertY: src.invertY, aoFromRed: !!o?.ao, roughness: rough, tolerant: true,
      }),
    })
    if (claim.failed) {
      claim.release()
      return null
    }
    return claim
  }

  private make(record: MaterialBatchRecord): Slot | null {
    const row = this.table.allocate()
    if (row < 0) return null
    let src: SlotSources
    try {
      src = this.sourcesOf(record)
    } catch (err) {
      console.warn('[batch] slot sources failed', record.name, err)
      this.table.free(row)
      return null
    }
    const albedo = this.albedoClaim(src)
    if (albedo.failed) {
      albedo.release()
      this.table.free(row)
      return null
    }
    // The lightmap's place is needed now (the merge remaps UV2 with it): an unknown size is taken as a quadrant.
    let lightmap: LightmapClaim | null = null
    let place = WHITE_LIGHTMAP
    if (src.lightmap) {
      const lm = src.lightmap
      const size = lm.size ? Math.max(lm.size.width, lm.size.height) : null
      if (size === null) this.counts.lightmapGuessed++
      lightmap = this.lightmaps.acquire(lm.key, size ?? LIGHTMAP_QUADRANT, () => lm.image())
      if (lightmap.placement) place = lightmap.placement
      else {
        console.warn('[batch] no room for lightmap', lm.key, '(drawn without its bake)')
        lightmap.release()
        lightmap = null
      }
    }
    const s: Slot = {
      record, row, refs: 0, gen: 0, src, albedo, nrao: null, lightmap, place, emissive: [0, 0, 0],
      placed: Promise.resolve(), ready: Promise.resolve(), released: false,
    }
    const nraoP: Promise<CellClaim | null> = albedo.cell
      ? Promise.resolve(this.nraoClaim(src, albedo.cell))
      : albedo.placed.then(c => (s.released ? null : this.nraoClaim(src, c)), () => null)
    s.placed = nraoP.then(async nrao => {
      // A late map set may have refreshed the slot first (its own cells then stand).
      if (s.released || s.gen !== 0) {
        nrao?.release()
        return
      }
      s.nrao = nrao
      await Promise.all([albedo.placed.catch(() => null), nrao?.placed.catch(() => null)])
      if (!s.released) this.writeRow(s)
    })
    s.ready = s.placed.then(async () => {
      const [a, n, l] = await Promise.all([
        s.albedo.ready.catch(() => null),
        s.nrao?.ready.catch(() => null) ?? null,
        s.lightmap?.ready.catch(() => null) ?? null,
      ])
      if (s.released) return
      if (!a || (s.nrao && !n) || (s.lightmap && !l)) this.counts.fallbackCells++
      // The NRAO cell's decode measured the ORM's mean metal (F23): the row takes it once known.
      this.writeRow(s)
    })
    return s
  }

  /** The slot's row from its sources and its cells (a cell not placed yet, or failed: a neutral value). */
  private writeRow(s: Slot): void {
    const src = s.src
    const a = s.albedo.cell
    const n = s.nrao?.cell ?? null
    const at = a ? cellTexel(a, this.page) : { layer: 0, u0: 0, v0: 0, uScale: 0, vScale: 0 }
    const nt = n ? cellTexel(n, this.page) : null
    let metallic = src.metallic
    let roughness = src.roughness
    if (src.orm && n && (n.mean[2] || n.mean[1])) {
      metallic = src.metallic * (n.mean[2] / 255)
      roughness = src.roughness * (n.mean[1] / 255)
    }
    const flags = (src.normal && n ? TABLE_FLAG.normal : 0) + (src.orm && n ? TABLE_FLAG.roughness + (src.orm.ao ? TABLE_FLAG.ao : 0) : 0)
    this.table.writeRow(s.row, {
      albedo: [at.layer, at.u0, at.v0, at.uScale],
      nrao: nt ? [nt.layer, nt.u0, nt.v0, nt.uScale] : [-1, 0, 0, 0],
      surf: src.surf,
      params: [metallic, roughness, src.normalStrength, flags],
      misc: [src.directIntensity, src.ssr, src.alpha === 'none' ? 0 : src.cutoff, at.vScale],
      emissive: [s.emissive[0], s.emissive[1], s.emissive[2], src.selfLit ? 1 : 0],
    })
  }

  private free(s: Slot): void {
    if (s.released) return
    s.released = true
    this.slots.delete(s.record)
    if (this.byRow.get(s.row) === s) this.byRow.delete(s.row)
    this.table.free(s.row)
    s.albedo.release()
    s.nrao?.release()
    s.lightmap?.release()
  }
}

/** The table's shape of a slot's albedo (tests): the cell a w × h texture takes on the table's pages. */
export function albedoShape(w: number, h: number, page = ATLAS_PAGE, levels = ATLAS_LEVELS): CellShape {
  return cellShape(w, h, page, levels)
}

/**
 * The material table of a streamed world (batch/index.ts `setBatchTables(createMaterialTable)`, I-10R): uploads in the
 * streamer's map-priority job queue (after every region job, inside the frame budget), the world's TX-R cache and
 * lightmap URLs, late map sets followed.
 */
export function createMaterialTable(host: BatchHost, opts: MaterialTableOptions = {}): MaterialTable {
  const job = host.world.stream?.mapScheduler.job
  return new MaterialTable(host.scene, {
    job: job ? run => job(run) : undefined,
    materials: host.materials,
    ...opts,
  })
}
