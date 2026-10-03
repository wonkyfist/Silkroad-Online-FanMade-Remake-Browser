/**
 * BT-A, the material table on a NullEngine scene (docs/BATCHING.md §3.2, §3.10, §6.2 BT-A; docs/WAVE_PLAN6.md D5):
 * - `acquire` answers at once with a slot and its lightmap's place; `ready` resolves once the cells are uploaded
 *   through the caller's job queue; the row holds the cells' texels and the material's values (BT-P's layout);
 * - one albedo cell for two glbs' identical texture; references, release, the grace time and a re-acquire that
 *   decodes nothing; the table grows; clear / dispose leave no slot, cell or texture (a PBR → Classic switch);
 * - lightmaps: a quadrant or a layer by size, the white quadrant without one, a guessed quadrant when the size is
 *   unknown;
 * - TX-R: the stand-ins before a swap are not maps; after it the map set's own decode jobs (read from the cache),
 *   the retail cut-out mask from `opacityTexture`, the NRAO planes and flags; a late swap (`onMapsChanged`) rewrites
 *   the slot's cells and row only;
 * - NL's texel 5, BT-P's `setTable` binding, and the layout constants shared with the SRO_TABLE reader.
 */
import {
  Color3,
  MaterialPluginBase,
  NullEngine,
  Observable,
  PBRMaterial,
  RawTexture,
  Scene,
  Vector4,
  type BaseTexture,
  type Material,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { keyPath, type PbrSet } from '../../texpipe/src/format.ts'
import { ATLAS_PAGE, inlineCellDecoder, mapJobOf, type CellDecoder } from '../src/batch/atlas.ts'
import { LIGHTMAP_PAGE, WHITE_LIGHTMAP } from '../src/batch/lightmaps.ts'
import type { BatchTables } from '../src/batch/region-batch.ts'
import {
  MaterialTable,
  TABLE_FLAG,
  TABLE_MAX_SLOTS,
  TABLE_TEXEL,
  TABLE_TEXELS,
  TableTexture,
  slotSources,
  type MaterialTableOptions,
} from '../src/batch/table.ts'
import type { MaterialBatchRecord, ObjectMaterials } from '../src/materials.ts'
import { type CellDecoders, type Level } from '../src/pbr/decode-core.ts'
import { PbrMapIndex, PbrTextureCache, applyMapRecord, mapPolicy, parsePbrIndex, type MapScheduler, type MapTextureSource } from '../src/pbr/maps.ts'
import * as surface from '../src/pbr/surface-plugin.ts'
import { planArrayRect } from '../src/textures.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

function image(w: number, h: number, rgba: [number, number, number, number]): Level {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4)
  return { width: w, height: h, data }
}

/** A texture "loaded from a glb": `w` × `h`, its encoded bytes the one byte `id` (the test decoder's key). */
function glbTexture(scene: Scene, w: number, h: number, id: number, name = `img${id}`): RawTexture {
  const t = RawTexture.CreateRGBATexture(new Uint8Array(w * h * 4), w, h, scene)
  t.name = name
  ;(t.getInternalTexture() as unknown as { _buffer: Uint8Array })._buffer = new Uint8Array([id, 0, 0, 0])
  return t
}

/** Decoders: `bytes` by their first byte, URLs from a map; logs every decode. */
function decoders(bytes: Record<number, Level>, urls: Record<string, Level> = {}, log: string[] = []): CellDecoders {
  return {
    url: async url => {
      log.push(url)
      const hit = urls[url] ?? Object.entries(urls).find(([k]) => url.endsWith(k))?.[1]
      if (!hit) throw new Error(`404 ${url}`)
      return hit
    },
    bytes: async b => {
      log.push(`bytes:${b[0]}`)
      const img = bytes[b[0]!]
      if (!img) throw new Error(`bytes ${b[0]}: undecodable`)
      return img
    },
  }
}

function record(mat: PBRMaterial, over: Partial<MaterialBatchRecord> = {}): MaterialBatchRecord {
  return {
    material: mat, path: 'pbr', model: { model: 'models/cj_wall.glb', source: 'res/bldg/cj_wall.bsr', kind: 'static' }, name: mat.name,
    texture: 'prim\\mtrl\\bldg\\china\\jangan_enter\\cj_wall01.ddj', cls: 'stone', unlit: false, alpha: 'opaque', twoSided: false,
    lightmap: null, lampModel: false, emissive: false, maps: null, ...over,
  }
}

/** A held job queue (the streamer's per-frame queue). */
function heldJobs(): { job: (run: () => void) => void; flush(): number; readonly size: number } {
  const jobs: Array<() => void> = []
  return {
    job: run => {
      jobs.push(run)
    },
    flush() {
      let n = 0
      while (jobs.length) {
        jobs.shift()!()
        n++
      }
      return n
    },
    get size() {
      return jobs.length
    },
  }
}

async function settle(jobs?: { flush(): number }): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 0))
    jobs?.flush()
  }
}

function makeTable(scene: Scene, dec: CellDecoders, opts: MaterialTableOptions = {}): MaterialTable {
  const decoder: CellDecoder = inlineCellDecoder(dec)
  const t = new MaterialTable(scene, { decoder, autoFlush: false, ...opts })
  cleanups.unshift(() => t.dispose())
  return t
}

/** The surface plugin as the table reads it (the real one needs PbrSurfaces; the table only reads these fields). */
class FakeSurface extends MaterialPluginBase {
  readonly surf = new Vector4(0.1, 0.4, 0.3, 1)
  ssr = 1
  selfLit = false
  lamp = false
  roughnessMap = false
  bound: unknown = null
  constructor(m: Material) {
    super(m, 'SroSurfacePlugin', 250, {}, true, false)
  }
  override getClassName(): string {
    return 'SroSurfacePlugin'
  }
  setTable(t: unknown): void {
    this.bound = t
  }
}

// ---- the table ------------------------------------------------------------------------------------------------------

describe('the material table (BatchTables)', () => {
  it('acquire answers at once; ready resolves after the upload jobs; the row holds the cell and the values', async () => {
    const scene = nullScene()
    const jobs = heldJobs()
    const t = makeTable(scene, decoders({ 1: image(128, 512, [200, 100, 50, 255]) }), { job: jobs.job })
    const mat = new PBRMaterial('wall', scene)
    mat.albedoTexture = glbTexture(scene, 128, 512, 1)
    mat.metallic = 0.25
    mat.roughness = 0.75
    const plugin = new FakeSurface(mat)
    const e = t.acquire(record(mat))!
    expect(e.slot).toBe(0)
    expect([e.layer, e.scale, e.offsetU, e.offsetV]).toEqual([WHITE_LIGHTMAP.layer, WHITE_LIGHTMAP.scale, 0, 0])
    let ready = false
    void t.ready([e]).then(() => (ready = true))
    await settle()
    expect(ready).toBe(false)
    expect(jobs.size).toBeGreaterThan(0)
    await settle(jobs)
    expect(ready).toBe(true)
    t.flush()
    const row = t.row(e.slot)
    const cell = { x: row.albedo[1] * ATLAS_PAGE - 2, y: row.albedo[2] * ATLAS_PAGE - 8 }
    expect(row.albedo[0]).toBe(0)
    expect(cell.x % 128).toBe(0)
    expect(cell.y % 512).toBe(0)
    expect(row.albedo[3]).toBe(124 / 1024)
    expect(row.misc[3]).toBe(496 / 1024)
    expect(row.nrao[0]).toBe(-1)
    expect(row.params).toEqual([0.25, 0.75, 1, 0])
    expect(row.surf[0]).toBeCloseTo(0.1, 3)
    expect(row.surf[1]).toBeCloseTo(0.4, 3)
    expect(row.misc.slice(0, 3)).toEqual([1, 1, 0])
    expect(row.emissive).toEqual([0, 0, 0, 0])
    // NL's night glow goes to texel 5; a lamp model's slot is self-lit.
    plugin.selfLit = true
    const lamp = new PBRMaterial('lamp', scene)
    lamp.albedoTexture = glbTexture(scene, 64, 64, 1)
    new FakeSurface(lamp).selfLit = true
    const le = t.acquire(record(lamp, { texture: 'prim/lamp.ddj', lampModel: true }))!
    await settle(jobs)
    await t.ready([le])
    t.setEmissive(le.slot, 1.5, 0.75, 0.25)
    t.setEmissive(999, 1, 1, 1)
    expect(t.row(le.slot).emissive).toEqual([1.5, 0.75, 0.25, 1])
  })

  it("one albedo cell for two glbs' identical texture; references; release frees the row; a re-acquire in the grace time decodes nothing", async () => {
    const scene = nullScene()
    const log: string[] = []
    let now = 0
    const t = makeTable(scene, decoders({ 1: image(256, 256, [9, 9, 9, 255]) }, {}, log), { now: () => now, graceS: 10 })
    const a = new PBRMaterial('wall (glb A)', scene)
    a.albedoTexture = glbTexture(scene, 256, 256, 1)
    const b = new PBRMaterial('wall (glb B)', scene)
    b.albedoTexture = glbTexture(scene, 256, 256, 1)
    const ra = record(a)
    const rb = record(b, { model: { model: 'models/other.glb', source: 'res/other.bsr', kind: 'static' } })
    const ea1 = t.acquire(ra)!
    const ea2 = t.acquire(ra)!
    const eb = t.acquire(rb)!
    await t.ready([ea1, ea2, eb])
    expect(ea1.slot).toBe(ea2.slot)
    expect(eb.slot).not.toBe(ea1.slot)
    expect(t.size).toBe(2)
    expect(t.albedo.cells).toBe(1)
    expect(log).toEqual(['bytes:1'])
    t.flush()
    expect(t.row(ea1.slot).albedo).toEqual(t.row(eb.slot).albedo)
    t.release(ea1)
    t.release(ea1)
    expect(t.size).toBe(2)
    t.release(ea2)
    t.release(eb)
    expect(t.size).toBe(0)
    expect(t.table.rows).toBe(0)
    expect(t.albedo.unusedCells).toBe(1)
    t.flush()
    expect(t.row(ea1.slot).albedo).toEqual([0, 0, 0, 0])
    now = 5000
    const again = t.acquire(ra)!
    await t.ready([again])
    expect(log).toEqual(['bytes:1'])
    t.release(again)
    now = 60000
    t.flush()
    expect(t.albedo.cells).toBe(0)
  })

  it('refuses what it cannot hold: a Classic record, and anything once disposed', () => {
    const scene = nullScene()
    const t = makeTable(scene, decoders({}))
    const mat = new PBRMaterial('m', scene)
    expect(t.acquire(record(mat, { path: 'classic' }))).toBeNull()
    t.dispose()
    expect(t.acquire(record(mat))).toBeNull()
    expect(t.textures.albedo).toBeNull()
  })

  it('a material without a texture draws its colour; a texture whose bytes are gone draws grey; a cell that fails falls back', async () => {
    const scene = nullScene()
    const t = makeTable(scene, decoders({}))
    const plain = new PBRMaterial('plain', scene)
    plain.albedoColor = new Color3(1, 0.2140, 0)
    expect(slotSources(record(plain)).albedo.key).toBe('solid|255,127,0,255')
    const lost = new PBRMaterial('lost', scene)
    lost.albedoTexture = RawTexture.CreateRGBATexture(new Uint8Array(16), 2, 2, scene)
    expect(slotSources(record(lost)).albedo.key).toBe('solid|150,150,150,255')
    const broken = new PBRMaterial('broken', scene)
    broken.albedoTexture = glbTexture(scene, 64, 64, 42)
    const e = t.acquire(record(broken, { texture: 'prim/broken.ddj' }))!
    await t.ready([e])
    expect(t.counts.fallbackCells).toBe(0)
    expect(t.albedo.cells).toBe(1)
  })

  it("copies a retail texture's bytes at acquire (TX-R may dispose the texture right after)", async () => {
    const scene = nullScene()
    const t = makeTable(scene, decoders({ 3: image(64, 64, [1, 2, 3, 255]) }))
    const mat = new PBRMaterial('m', scene)
    const tex = glbTexture(scene, 64, 64, 3)
    mat.albedoTexture = tex
    const e = t.acquire(record(mat))!
    tex.dispose()
    await t.ready([e])
    expect(t.albedo.stats.decoded).toBe(1)
    expect(t.albedo.stats.failures).toBe(0)
  })

  it('grows its rows and keeps them; clear and dispose leave no slot, cell or texture', async () => {
    const scene = nullScene()
    const t = makeTable(scene, decoders({ 1: image(64, 64, [5, 5, 5, 255]) }), { rows: 2, firstLayers: 1 })
    const changed: BaseTexture[] = []
    t.table.onChanged.add(tx => changed.push(tx))
    const before = t.textures.table
    const entries = Array.from({ length: 5 }, (_, i) => {
      const m = new PBRMaterial(`m${i}`, scene)
      m.albedoTexture = glbTexture(scene, 64, 64, 1)
      m.metallic = i / 8
      return t.acquire(record(m, { texture: `prim/t${i}.ddj` }))!
    })
    await t.ready(entries)
    t.flush()
    expect(t.table.capacity).toBe(8)
    expect(changed.length).toBe(1)
    expect(t.textures.table).not.toBe(before)
    expect(entries.map(e => t.row(e.slot).params[0])).toEqual([0, 0.125, 0.25, 0.375, 0.5])
    // Five 128² cells on one 1024² page: the array grew from its first layer only if it had to.
    expect(t.albedo.pages).toBe(1)
    t.clear()
    expect([t.size, t.albedo.cells, t.nrao.cells, t.table.rows]).toEqual([0, 0, 0, 0])
    for (const e of entries) t.release(e)
    expect(t.table.rows).toBe(0)
  })

  it('the table allocates at most TABLE_MAX_SLOTS rows (the UV2 packing bound)', () => {
    const scene = nullScene()
    const table = new TableTexture(scene, 16)
    cleanups.unshift(() => table.dispose())
    for (let i = 0; i < TABLE_MAX_SLOTS; i++) expect(table.allocate()).toBe(i)
    expect(table.allocate()).toBe(-1)
    table.free(7)
    expect(table.allocate()).toBe(7)
    expect(table.capacity).toBe(TABLE_MAX_SLOTS)
  })
})

// ---- lightmaps ------------------------------------------------------------------------------------------------------

describe('lightmaps in the table', () => {
  it('a 128² lightmap takes a quadrant, a 256² one a layer; an unknown size is taken as a quadrant; none: the white one', async () => {
    const scene = nullScene()
    const log: string[] = []
    const t = makeTable(scene, decoders({ 1: image(64, 64, [1, 1, 1, 255]), 5: image(128, 128, [90, 90, 90, 255]), 6: image(256, 256, [80, 80, 80, 255]) },
      { 'lightmaps/c.webp': image(128, 128, [70, 70, 70, 255]) }, log), { lightmapUrl: uri => `http://world/${uri}` })
    const lit = (name: string, lm: string, tex: RawTexture | null) => {
      const m = new PBRMaterial(name, scene)
      m.albedoTexture = glbTexture(scene, 64, 64, 1)
      m.lightmapTexture = tex
      return record(m, { lightmap: lm, texture: `prim/${name}.ddj` })
    }
    const q = t.acquire(lit('a', 'lightmaps/a.webp', glbTexture(scene, 128, 128, 5)))!
    const full = t.acquire(lit('b', 'lightmaps/b.webp', glbTexture(scene, 256, 256, 6)))!
    const guess = t.acquire(lit('c', 'lightmaps/c.webp', null))!
    const none = t.acquire(record(new PBRMaterial('d', scene), { texture: 'prim/d.ddj' }))!
    await t.ready([q, full, guess, none])
    expect([q.layer, q.scale]).toEqual([0, 0.5])
    expect([q.offsetU, q.offsetV]).not.toEqual([0, 0])
    expect([full.layer, full.scale, full.offsetU, full.offsetV]).toEqual([1, 1, 0, 0])
    expect(guess.scale).toBe(0.5)
    expect(t.counts.lightmapGuessed).toBe(1)
    expect(log).toContain('http://world/lightmaps/c.webp')
    expect([none.layer, none.scale, none.offsetU, none.offsetV]).toEqual([0, 0.5, 0, 0])
    expect(t.lightmaps.atlas.pages).toBe(2)
    expect(LIGHTMAP_PAGE).toBe(surface.TABLE_LIGHTMAP_SIZE)
  })
})

// ---- TX-R ---------------------------------------------------------------------------------------------------------

const ROOT = 'http://mem.test/out-opt/'
const INDEX_URL = `${ROOT}pbr/index.json`
const WALL = 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj'

function mapSet(key: string, edge: number): PbrSet {
  const p = keyPath(key)
  const tier: PbrSet['tiers'][string] = {
    size: [edge, edge], albedo: `${p}/albedo@${edge}.webp`, bytes: 100,
    nx: `${p}/nx@${edge}.webp`, ny: `${p}/ny@${edge}.webp`, ao: `${p}/ao@${edge}.webp`, rough: `${p}/rough@${edge}.webp`,
  }
  return { key, size: [edge, edge], class: 'stone', tiers: { [String(edge)]: tier }, alpha: 'none', wrap: [true, true], status: 'auto', hero: true } as PbrSet
}

function mapIndex(sets: PbrSet[]): PbrMapIndex {
  const raw = {
    format: 'sro-pbr', version: 1, pipeline: { rev: 'test', upscaler: 'x', createdAt: '2026-09-29T00:00:00Z' },
    sets: Object.fromEntries(sets.map(s => [s.key, s])),
  }
  return new PbrMapIndex({ pbr: parsePbrIndex(raw, INDEX_URL)! })
}

/** TX-R's source for the tests: every map file decodes to a 2 × 2 grey. */
function mapSource(scene: Scene): MapTextureSource {
  return {
    texture: url => {
      const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
      t.name = url
      return t
    },
    pixels: async () => ({ width: 2, height: 2, data: new Uint8Array(16).fill(128) as Uint8Array<ArrayBuffer> }),
    raw: img => RawTexture.CreateRGBATexture(img.data, img.width, img.height, scene),
  }
}

function heldScheduler(): MapScheduler & { flush(): number } {
  const jobs: Array<() => void> = []
  return {
    request: fn => fn(),
    job: run => {
      jobs.push(run)
    },
    flush() {
      let n = 0
      while (jobs.length) {
        jobs.shift()!()
        n++
      }
      return n
    },
  }
}

describe('TX-R map sets in the table (D5)', () => {
  async function swapped(scene: Scene, cutout: boolean) {
    const cache = new PbrTextureCache(mapSource(scene))
    const sched = heldScheduler()
    cache.setScheduler(sched)
    const rec = mapIndex([mapSet(WALL, 256)]).resolve({ texture: WALL }, mapPolicy('high'))!
    const mat = new PBRMaterial('wall', scene)
    const retail = glbTexture(scene, 128, 256, 7, 'retail')
    mat.albedoTexture = retail
    if (cutout) {
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      mat.alphaCutOff = 0.4
    }
    const applied = applyMapRecord(mat, rec, cache, 'stone', { onRetailFree: () => {} })
    return { cache, sched, mat, retail, applied, rec: record(mat, { alpha: cutout ? 'mask' : 'opaque', maps: applied }) }
  }

  it("before the swap TX-R's stand-ins are not maps (their roughness is the table's); after it the set's own jobs, the retail mask, the NRAO planes", async () => {
    const scene = nullScene()
    const s = await swapped(scene, true)
    const before = slotSources(s.rec, { maps: s.cache })
    expect(s.mat.bumpTexture?.name).toBe('sroPlaceholder:normal')
    expect(before.normal).toBeNull()
    expect(before.orm).toBeNull()
    expect(before.mask).toBeNull()
    expect(before.albedo.key).toBe(`tex|${WALL}`)
    expect(before.roughness).toBeGreaterThan(0.3)
    expect(before.roughness).toBeLessThan(1)
    for (let i = 0; i < 10; i++) {
      s.sched.flush()
      await new Promise(r => setTimeout(r, 0))
    }
    expect(await s.applied.ready).toBe(true)
    const after = slotSources(s.rec, { maps: s.cache })
    // The set's albedo is opaque ('original' alpha): its job keeps no alpha, and the retail texture is the mask.
    expect(after.albedo.key).toMatch(/^map\|m\|s\|i\|.*albedo@256\.webp\|none\|$/)
    expect(after.albedo.image()).toEqual({ kind: 'map', job: mapJobOf(s.cache, s.mat.albedoTexture) })
    expect(after.mask?.key).toBe(`tex|${WALL}`)
    expect(after.mask?.image()).toMatchObject({ kind: 'bytes' })
    expect(after.normal?.image()).toMatchObject({ kind: 'map', job: { kind: 'normal' } })
    expect(after.orm?.image()).toMatchObject({ kind: 'map', job: { kind: 'ormh', ao: expect.stringContaining('ao@256') } })
    expect(after.orm?.ao).toBe(true)
    expect(after.directIntensity).toBeCloseTo(0.8, 6)
    expect(after.cutoff).toBeCloseTo(0.4, 6)
  })

  it("a late swap (onMapsChanged) rewrites the slot's cells and row, not its slot; the retail-only cell goes unused", async () => {
    const scene = nullScene()
    const s = await swapped(scene, false)
    const onMapsChanged = new Observable<MaterialBatchRecord>()
    const materials = { onMapsChanged, pbr: { cache: s.cache }, assets: { url: (u: string) => u } } as unknown as ObjectMaterials
    const grey = image(2, 2, [128, 128, 128, 255])
    const t = makeTable(scene, decoders({ 7: image(128, 256, [30, 60, 90, 255]) }, { 'albedo@256.webp': grey, 'nx@256.webp': grey, 'ny@256.webp': grey, 'ao@256.webp': grey, 'rough@256.webp': grey }), { materials })
    const e = t.acquire(s.rec)!
    await t.ready([e])
    t.flush()
    const first = t.row(e.slot)
    expect(first.nrao[0]).toBe(-1)
    expect(first.params[3]).toBe(0)
    for (let i = 0; i < 10; i++) {
      s.sched.flush()
      await new Promise(r => setTimeout(r, 0))
    }
    expect(await s.applied.ready).toBe(true)
    onMapsChanged.notifyObservers(s.rec)
    await settle()
    t.flush()
    const second = t.row(e.slot)
    expect(e.slot).toBe(0)
    expect(second.albedo).not.toEqual(first.albedo)
    expect(second.nrao[0]).toBeGreaterThanOrEqual(0)
    expect(second.params[3]).toBe(TABLE_FLAG.normal + TABLE_FLAG.roughness + TABLE_FLAG.ao)
    expect(second.misc[0]).toBeCloseTo(0.8, 3)
    // The NRAO cell keeps the albedo cell's inner ratio: v scale = u scale × albedo v / albedo u.
    expect(t.nrao.cells).toBe(1)
    expect(t.albedo.unusedCells).toBe(1)
    expect(t.counts.refreshed).toBe(1)
  })
})

// ---- the seams with BT-M and BT-P -----------------------------------------------------------------------------------

describe('seams: BT-M (BatchTables) and BT-P (SRO_TABLE)', () => {
  it("writes BT-P's layout: the texel order, the NRAO flags, six texels a slot, 4096 slots", () => {
    expect(TABLE_TEXEL).toEqual(surface.TABLE_TEXEL)
    expect(TABLE_FLAG).toEqual(surface.TABLE_FLAG)
    expect(TABLE_TEXELS).toBe(surface.TABLE_TEXELS_PER_SLOT)
    expect(TABLE_MAX_SLOTS).toBe(surface.TABLE_MAX_ID + 1)
  })

  it("is BT-M's BatchTables, and binds a group material through the surface plugin's setTable (the textures read at bind time)", async () => {
    const scene = nullScene()
    const t = makeTable(scene, decoders({ 1: image(64, 64, [1, 1, 1, 255]) }), { firstLayers: 1 })
    const tables: BatchTables = t
    expect(tables.lamps).toBe(true)
    const group = new PBRMaterial('batch:group', scene)
    const plugin = new FakeSurface(group)
    t.bindMaterial(group, { cutout: false, sheen: false, lamp: false })
    const bound = plugin.bound as { albedo: BaseTexture | null; nrao: BaseTexture | null; lightmap: BaseTexture | null; table: BaseTexture | null }
    expect(bound).toBe(t.textures)
    const first = bound.albedo
    expect([bound.albedo, bound.nrao, bound.lightmap, bound.table].every(x => !!x && x.isReady())).toBe(true)
    // Fill the first layer so the array grows: the binding then gives the new texture.
    const entries = Array.from({ length: 70 }, (_, i) => {
      const m = new PBRMaterial(`m${i}`, scene)
      m.albedoTexture = glbTexture(scene, 128, 128, 1)
      return t.acquire(record(m, { texture: `prim/g${i}.ddj` }))!
    })
    await t.ready(entries)
    expect(t.albedo.pages).toBe(2)
    expect(bound.albedo).not.toBe(first)
    expect(() => t.bindMaterial(new PBRMaterial('bare', scene), { cutout: true, sheen: false, lamp: false })).toThrow(/SroSurfacePlugin/)
  })

  it('plans a cell upload at the cell position of every level, in jobs of at most jobBytes', () => {
    const levels = [image(256, 128, [0, 0, 0, 255]), image(128, 64, [0, 0, 0, 255]), image(64, 32, [0, 0, 0, 255])]
    const jobs = planArrayRect(levels, 512, 256, 64 * 1024)
    const steps = jobs.flat()
    expect(steps.filter(s => s.level === 0).map(s => [s.x, s.y])).toEqual([[512, 256], [512, 320]])
    expect(steps.filter(s => s.level === 1).map(s => [s.x, s.y, s.width, s.height])).toEqual([[256, 128, 128, 64]])
    expect(steps.filter(s => s.level === 2).map(s => [s.x, s.y])).toEqual([[128, 64]])
    for (const j of jobs) expect(j.reduce((n, s) => n + s.data.byteLength, 0)).toBeLessThanOrEqual(64 * 1024)
  })
})
