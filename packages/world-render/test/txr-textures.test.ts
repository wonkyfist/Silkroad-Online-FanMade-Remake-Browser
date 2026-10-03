/**
 * TX-R, the texture runtime (docs/WAVE_PLAN3.md §7.1 row TX-R, D39, D41, D42; docs/TEXPIPE.md §6.3–6.4):
 * - the tier per preset and per Options setting ('auto' | 'retail' | 'remaster' | 1024 | 2048), the '2x' tier on High
 *   (with its own maps) and the 1024 cap without it, Ultra on 2048 WebP or KTX2 with the WebP fallback;
 * - a missing set keeps retail (an unknown texture, a set whose albedo fails, the 'retail' setting);
 * - the progressive swap: nothing is bound until every map is in; the swap disposes the embedded retail texture, but
 *   never one another material still draws with; a material released before its maps arrive cancels their upload;
 * - the decode worker's core: its mips equal the CPU `downsample` chain; cutout mips keep the level-0 alpha coverage;
 *   the colour under transparent texels is filled; the planes pack to a normal map and ORMH;
 * - uploads: a 1024² map is one job, a 2048² one is split into jobs of at most 6 MiB (the per-frame budget);
 * - actors join a set by the sidecar texture, else by stem with the glb path deciding between man_item and woman_item;
 * - the terrain atlas: the tier plane (48-layer cap, set tiles first, overflow to the base array), levels passed to the
 *   upload, and the set layers swapped in place after the first (retail) commit.
 */
import { AssetContainer, NullEngine, PBRMaterial, RawTexture, Scene, Texture, type BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyPath, type PbrSet } from '../../texpipe/src/format.ts'
import {
  ActorMaps,
  MapCancelled,
  PbrMapIndex,
  PbrTextureCache,
  TEXTURE_SETTINGS,
  applyMapRecord,
  frameScheduler,
  mapPolicy,
  parsePbrIndex,
  policyForTier,
  releaseMaps,
  textureTierFor,
  type MapScheduler,
  type MapTextureSource,
  type Rgba,
} from '../src/pbr/maps.ts'
import {
  alphaThreshold,
  chainBytes,
  coverage,
  downsample,
  fillTransparent,
  levelCount,
  mipChain,
  packNormalPlanes,
  packOrmhPlanes,
  runMapJob,
  type Level,
} from '../src/pbr/decode-core.ts'
import { downsample as texturesDownsample, planLevelUpload } from '../src/textures.ts'
import { TILE_TIER_LAYERS, TileAtlas, type TileAtlasSetup, type TilePlane } from '../src/tile-atlas.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

const ROOT = 'http://mem.test/out-opt/'
const INDEX_URL = `${ROOT}pbr/index.json`
const WALL = 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj'
const ROOF = 'prim/mtrl/bldg/china/jangan03/cj_pal_roof.ddj'

function tier(key: string, w: number, h = w, planes = true): PbrSet['tiers'][string] {
  const p = keyPath(key)
  const edge = Math.max(w, h)
  const t: PbrSet['tiers'][string] = { size: [w, h], albedo: `${p}/albedo@${edge}.webp`, bytes: 100 }
  if (planes) {
    t.nx = `${p}/nx@${edge}.webp`
    t.ny = `${p}/ny@${edge}.webp`
    t.ao = `${p}/ao@${edge}.webp`
    t.rough = `${p}/rough@${edge}.webp`
    t.height = `${p}/height@${edge}.webp`
  }
  return t
}

/** A set with tiers of these long edges (square); `t2x` names the '2x' tier. */
function set(key: string, edges: number[], o: Partial<PbrSet> & { t2x?: string } = {}): PbrSet {
  const tiers: PbrSet['tiers'] = {}
  for (const e of edges) tiers[String(e)] = tier(key, e)
  const max = Math.max(...edges)
  const { t2x, ...rest } = o
  const s = { key, size: [max, max], class: 'stone', tiers, alpha: 'none', wrap: [true, true], status: 'auto', hero: true, ...rest } as PbrSet
  if (t2x) (s as PbrSet & { tier2x?: string }).tier2x = t2x
  return s
}

function indexOf(sets: PbrSet[]): PbrMapIndex {
  const raw = {
    format: 'sro-pbr', version: 1,
    pipeline: { rev: 'test', upscaler: 'x', createdAt: '2026-09-29T00:00:00Z' },
    sets: Object.fromEntries(sets.map(s => [s.key, s])),
  }
  return new PbrMapIndex({ pbr: parsePbrIndex(raw, INDEX_URL)! })
}

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

/** A fake source: pixels are 2×2 greys; a URL containing "missing" fails. */
function fakeSource(scene: Scene, log: string[] = []): MapTextureSource {
  return {
    texture(url, srgb) {
      const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
      t.name = url
      t.gammaSpace = srgb
      return t
    },
    async pixels(url) {
      log.push(url)
      if (url.includes('missing')) throw new Error(`404 ${url}`)
      return { width: 2, height: 2, data: new Uint8Array(16).fill(128) as Uint8Array<ArrayBuffer> }
    },
    raw(img) {
      const t = RawTexture.CreateRGBATexture(img.data, img.width, img.height, scene)
      t.name = `raw${img.width}`
      return t
    },
  }
}

/** A scheduler that holds its jobs until `flush` (the per-frame queue of the streamer). */
function heldScheduler(): MapScheduler & { flush(): number; readonly jobs: number } {
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
    get jobs() {
      return jobs.length
    },
  }
}

// ---- tiers --------------------------------------------------------------------------------------------------------

describe('texture tiers per preset and setting', () => {
  it("'auto' follows the preset: Low retail, Medium the retail-size remaster, High the '2x' tier, Ultra 2048", () => {
    expect(TEXTURE_SETTINGS).toEqual(['auto', 'retail', 'remaster', 1024, 2048])
    expect(textureTierFor('classic')).toBe('retail')
    expect(textureTierFor('medium')).toBe('remaster')
    expect(textureTierFor('high')).toBe('2x')
    expect(textureTierFor('ultra')).toBe(2048)
    // A pinned setting wins on every preset; Low only loads sets when a tier is pinned.
    for (const p of ['classic', 'medium', 'high', 'ultra'] as const) {
      expect(textureTierFor(p, 'retail')).toBe('retail')
      expect(textureTierFor(p, 'remaster')).toBe('remaster')
      expect(textureTierFor(p, 1024)).toBe('2x')
      expect(textureTierFor(p, 2048)).toBe(2048)
    }
    expect(mapPolicy('high', { textures: 'retail' }).tier).toBe('retail')
    expect(mapPolicy('medium', { textures: 2048, ktx2: true }).ktx2).toBe(true)
    expect(policyForTier('2x', true).ktx2).toBe(false) // KTX2 only on the 2048 tier
  })

  it("High takes the '2x' tier and that tier's maps; without tier2x it caps the albedo at 1024 and the maps at 512", () => {
    // A 256-px wall: tiers 256 (retail), 512 ('2x'), 1024, 2048.
    const idx = indexOf([set(WALL, [256, 512, 1024, 2048], { t2x: '512' }), set(ROOF, [256, 512, 1024, 2048])])
    const high = idx.resolve({ texture: WALL }, mapPolicy('high'))!
    expect(high.tier).toBe(512)
    expect(high.albedo).toBe(`${ROOT}pbr/${keyPath(WALL)}/albedo@512.webp`)
    expect(high.normal).toEqual({ kind: 'planes', nx: `${ROOT}pbr/${keyPath(WALL)}/nx@512.webp`, ny: `${ROOT}pbr/${keyPath(WALL)}/ny@512.webp` })
    expect(high.orm).toMatchObject({ kind: 'planes', ao: `${ROOT}pbr/${keyPath(WALL)}/ao@512.webp` })
    const noT2x = idx.resolve({ texture: ROOF }, mapPolicy('high'))!
    expect(noT2x.tier).toBe(1024)
    expect(noT2x.normal).toMatchObject({ nx: `${ROOT}pbr/${keyPath(ROOF)}/nx@512.webp` })
    // Medium: the retail-size tier; Ultra without KTX2: High's tier (D39); an explicit 2048 setting: 2048 (maps ≤ 1024);
    // the 1024 setting = High's tier on Medium.
    expect(idx.resolve({ texture: WALL }, mapPolicy('medium'))!.tier).toBe(256)
    expect(idx.resolve({ texture: WALL }, mapPolicy('ultra'))!.tier).toBe(512)
    expect(idx.resolve({ texture: WALL }, mapPolicy('ultra', { textures: 2048 }))!.tier).toBe(2048)
    expect(idx.resolve({ texture: WALL }, mapPolicy('medium', { textures: 1024 }))!.tier).toBe(512)
  })

  it('Ultra with KTX2 takes the v2 files and keeps the WebP tiers as the fallback', () => {
    const k = set(WALL, [256, 1024, 2048])
    k.albedo = `${keyPath(WALL)}/albedo@2048.ktx2`
    k.normal = `${keyPath(WALL)}/normal@2048.ktx2`
    k.ormh = `${keyPath(WALL)}/ormh@2048.ktx2`
    const r = indexOf([k]).resolve({ texture: WALL }, mapPolicy('ultra', { ktx2: true }))!
    expect(r.ktx2).toBe(true)
    expect(r.albedo).toBe(`${ROOT}pbr/${keyPath(WALL)}/albedo@2048.ktx2`)
    expect(r.orm).toEqual({ kind: 'ormh', url: `${ROOT}pbr/${keyPath(WALL)}/ormh@2048.ktx2` })
    expect(r.fallback!.albedo).toBe(`${ROOT}pbr/${keyPath(WALL)}/albedo@2048.webp`)
    expect(r.fallback!.ktx2).toBeUndefined()
  })

  it("a missing set keeps retail: unknown textures, 'retail' status, and the 'retail' setting give no record", () => {
    const idx = indexOf([set(WALL, [256, 1024]), set(ROOF, [256], { status: 'retail' })])
    expect(idx.resolve({ texture: 'prim/mtrl/none.ddj' }, mapPolicy('high'))).toBeNull()
    expect(idx.resolve({ texture: ROOF }, mapPolicy('high'))).toBeNull()
    expect(idx.resolve({ texture: WALL }, mapPolicy('high', { textures: 'retail' }))).toBeNull()
    expect(idx.tile('c_grass_fld_03', mapPolicy('high'))).toBeNull()
  })
})

// ---- the progressive swap -----------------------------------------------------------------------------------------

describe('the progressive swap', () => {
  it('binds nothing until every map is uploaded, then swaps and disposes the retail texture', async () => {
    const scene = nullScene()
    const cache = new PbrTextureCache(fakeSource(scene))
    const sched = heldScheduler()
    cache.setScheduler(sched)
    const rec = indexOf([set(WALL, [256, 512], { t2x: '512' })]).resolve({ texture: WALL }, mapPolicy('high'))!
    const mat = new PBRMaterial('wall', scene)
    const retail = new Texture(null, scene) as BaseTexture
    mat.albedoTexture = retail
    const disposed = vi.spyOn(retail, 'dispose')
    const applied = applyMapRecord(mat, rec, cache, 'stone')
    await vi.waitFor(() => expect(sched.jobs).toBe(3)) // albedo, normal, ORMH: one upload job each
    expect(mat.albedoTexture).toBe(retail)
    // Until then a flat stand-in holds the normal slot, so the define set is final from the start (W9F R3).
    expect(mat.bumpTexture?.name).toBe('sroPlaceholder:normal')
    expect(sched.flush()).toBe(3)
    expect(await applied.ready).toBe(true)
    expect(mat.albedoTexture).not.toBe(retail)
    expect(mat.bumpTexture).not.toBeNull()
    expect(mat.metallicTexture).not.toBeNull()
    expect(disposed).toHaveBeenCalledOnce()
    expect(cache.stats.uploads).toBe(3)
    releaseMaps(mat, applied, cache)
    expect(cache.size).toBe(0)
  })

  it('never disposes a retail texture another material still draws with', async () => {
    const scene = nullScene()
    const cache = new PbrTextureCache(fakeSource(scene))
    const rec = indexOf([set(WALL, [256])]).resolve({ texture: WALL }, mapPolicy('medium'))!
    const retail = new Texture(null, scene) as BaseTexture
    const a = new PBRMaterial('a', scene)
    const b = new PBRMaterial('b', scene)
    a.albedoTexture = retail
    b.albedoTexture = retail
    const disposed = vi.spyOn(retail, 'dispose')
    expect(await applyMapRecord(a, rec, cache, 'stone').ready).toBe(true)
    expect(disposed).not.toHaveBeenCalled()
    expect(await applyMapRecord(b, rec, cache, 'stone').ready).toBe(true)
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('a set whose albedo fails keeps the retail look; a failed map alone leaves that map to the class defaults', async () => {
    const scene = nullScene()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = new PbrTextureCache(fakeSource(scene))
    const broken = set(WALL, [256])
    broken.tiers['256']!.albedo = 'missing/albedo@256.webp'
    const mat = new PBRMaterial('wall', scene)
    const retail = new Texture(null, scene) as BaseTexture
    mat.albedoTexture = retail
    const rec = indexOf([broken]).resolve({ texture: WALL }, mapPolicy('medium'))!
    expect(await applyMapRecord(mat, rec, cache, 'stone').ready).toBe(false)
    expect([mat.albedoTexture, mat.bumpTexture, mat.metallicTexture]).toEqual([retail, null, null])
    expect(retail.getScene()!.textures).toContain(retail) // not disposed
    expect(cache.size).toBe(0)
    const partial = set(ROOF, [256])
    partial.tiers['256']!.nx = 'missing/nx@256.webp'
    const mat2 = new PBRMaterial('roof', scene)
    mat2.albedoTexture = new Texture(null, scene)
    const rec2 = indexOf([partial]).resolve({ texture: ROOF }, mapPolicy('medium'))!
    expect(await applyMapRecord(mat2, rec2, cache, 'stone').ready).toBe(true)
    // The failed normal map stays the flat stand-in (the class default: the geometry normal).
    expect(mat2.bumpTexture?.name).toBe('sroPlaceholder:normal')
    expect(mat2.metallicTexture).not.toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('a KTX2 set that fails falls back to its WebP tiers', async () => {
    const scene = nullScene()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = fakeSource(scene)
    src.loaded = tex => (tex.name.endsWith('.ktx2') ? Promise.reject(new Error('404')) : Promise.resolve())
    const cache = new PbrTextureCache(src)
    const k = set(WALL, [256, 2048])
    k.albedo = `${keyPath(WALL)}/albedo@2048.ktx2`
    const rec = indexOf([k]).resolve({ texture: WALL }, mapPolicy('ultra', { ktx2: true }))!
    const mat = new PBRMaterial('wall', scene)
    mat.albedoTexture = new Texture(null, scene)
    expect(await applyMapRecord(mat, rec, cache, 'stone').ready).toBe(true)
    expect(mat.albedoTexture!.name).toBe('raw2') // the WebP 2048 tier, decoded and uploaded
  })

  it('a material released before its maps arrive cancels their uploads', async () => {
    const scene = nullScene()
    const cache = new PbrTextureCache(fakeSource(scene))
    const sched = heldScheduler()
    cache.setScheduler(sched)
    const rec = indexOf([set(WALL, [256])]).resolve({ texture: WALL }, mapPolicy('medium'))!
    const mat = new PBRMaterial('wall', scene)
    const retail = new Texture(null, scene) as BaseTexture
    mat.albedoTexture = retail
    const applied = applyMapRecord(mat, rec, cache, 'stone')
    await vi.waitFor(() => expect(sched.jobs).toBe(3))
    releaseMaps(mat, applied, cache)
    sched.flush()
    expect(await applied.ready).toBe(false)
    expect(cache.stats.uploads).toBe(0)
    expect(cache.stats.cancelled).toBe(3)
    expect(cache.size).toBe(0)
    expect(mat.albedoTexture).toBe(retail)
    expect(new MapCancelled().name).toBe('MapCancelled')
  })

  it('frameScheduler: decodes are limited, uploads run before renders within the budget (at least one a frame)', async () => {
    const scene = nullScene()
    const s = frameScheduler(scene, { budgetMs: 0, concurrency: 1 })
    cleanups.push(() => s.dispose())
    const ran: number[] = []
    s.job(() => ran.push(1))
    s.job(() => ran.push(2))
    scene.onBeforeRenderObservable.notifyObservers(scene)
    expect(ran).toEqual([1]) // a 0 ms budget still runs one job
    scene.onBeforeRenderObservable.notifyObservers(scene)
    expect(ran).toEqual([1, 2])
    let release!: () => void
    const first = s.request(() => new Promise<void>(r => { release = r }))
    let second = false
    const next = s.request(async () => { second = true })
    await Promise.resolve()
    expect(second).toBe(false)
    release()
    await first
    await next
    expect(second).toBe(true)
  })
})

// ---- the decode worker's core -------------------------------------------------------------------------------------

function noise(w: number, h: number, seed = 1, alpha?: (x: number, y: number) => number): Level {
  const data = new Uint8Array(w * h * 4)
  let s = seed
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    data[i] = s >>> 24
  }
  if (alpha) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = alpha(x, y)
  else for (let i = 3; i < data.length; i += 4) data[i] = 255
  return { width: w, height: h, data: data as Uint8Array<ArrayBuffer> }
}

describe('decode worker core', () => {
  it('opaque mips equal the CPU downsample chain (textures.ts) byte for byte', () => {
    expect(texturesDownsample).toBe(downsample)
    const img = noise(64, 32)
    const chain = mipChain(img)
    expect(chain).toHaveLength(levelCount(64, 32))
    let cur = { data: img.data, w: 64, h: 32 }
    for (let i = 1; i < chain.length; i++) {
      cur = downsample(cur.data, cur.w, cur.h)
      expect([chain[i]!.width, chain[i]!.height]).toEqual([cur.w, cur.h])
      expect(Buffer.from(chain[i]!.data).equals(Buffer.from(cur.data))).toBe(true)
    }
    expect(chainBytes(64, 32)).toBe(chain.reduce((a, l) => a + l.data.length, 0))
  })

  it('cutout mips keep the level-0 alpha-test coverage (thin leaves do not vanish at distance)', () => {
    // A leaf card: scattered discs of 1..6 px radius (plain box mips thin the small ones out below the cutoff).
    const discs: Array<[number, number, number]> = []
    let seed = 11
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 16777216
    for (let i = 0; i < 90; i++) discs.push([rnd() * 128, rnd() * 128, 1 + rnd() * 5])
    const leaves = noise(128, 128, 7, (x, y) => (discs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r) ? 255 : 0))
    const cutoff = 0.5
    const c0 = coverage(leaves, cutoff)
    const box = mipChain({ ...leaves, data: leaves.data.slice() })
    const kept = mipChain({ ...leaves, data: leaves.data.slice() }, { alpha: 'cutout', cutoff })
    // The scaled alpha of a level is quantised (a 2×2 block of 0/255 texels averages to 5 values), so a level can only
    // come close; plain box mips lose the strokes level after level.
    for (let i = 1; i < 5; i++) {
      const err = Math.abs(coverage(kept[i]!, cutoff) - c0)
      expect(err, `level ${i}`).toBeLessThan(0.05)
      expect(err, `level ${i} vs box`).toBeLessThanOrEqual(Math.abs(coverage(box[i]!, cutoff) - c0))
    }
    expect(coverage(box[4]!, cutoff)).toBeLessThan(c0 - 0.05)
    expect(alphaThreshold(0.5)).toBe(128)
  })

  it('the colour under transparent texels comes from the coarser levels (no black fringe)', () => {
    const img: Level = { width: 2, height: 2, data: new Uint8Array([200, 100, 50, 255, 0, 0, 0, 0, 0, 0, 0, 0, 200, 100, 50, 255]) as Uint8Array<ArrayBuffer> }
    const chain = mipChain(img, { alpha: 'cutout' })
    expect([...chain[0]!.data.slice(4, 8)]).toEqual([200, 100, 50, 0])
    expect([...chain[1]!.data.slice(0, 3)]).toEqual([200, 100, 50])
    // fillTransparent only touches alpha 0.
    const lv: Level[] = [{ width: 2, height: 1, data: new Uint8Array([9, 9, 9, 1, 0, 0, 0, 0]) as Uint8Array<ArrayBuffer> }, { width: 1, height: 1, data: new Uint8Array([7, 7, 7, 1]) as Uint8Array<ArrayBuffer> }]
    fillTransparent(lv)
    expect([...lv[0]!.data]).toEqual([9, 9, 9, 1, 7, 7, 7, 0])
  })

  it('jobs: normal planes pack with z rebuilt, ORMH takes the class defaults, levels only when asked', async () => {
    const grey = (v: number, s = 4): Level => ({ width: s, height: s, data: new Uint8Array(s * s * 4).fill(v) as Uint8Array<ArrayBuffer> })
    const decode = async (url: string) => (url.includes('nx') || url.includes('ny') ? grey(128) : url.includes('ao') ? grey(200, 2) : grey(90))
    const n = await runMapJob({ kind: 'normal', nx: 'nx', ny: 'ny', levels: true }, decode)
    expect([...n.levels[0]!.data.slice(0, 4)]).toEqual([128, 128, 255, 255])
    expect(n.levels).toHaveLength(3)
    const o = await runMapJob({ kind: 'ormh', ao: 'ao', height: 'h', defaults: { roughness: 0.8, metallic: 0 }, size: 4 }, decode)
    expect([o.width, o.levels.length]).toEqual([4, 1])
    expect([...o.levels[0]!.data.slice(0, 4)]).toEqual([200, 204, 0, 90])
    expect(packNormalPlanes(grey(128), grey(128)).data[2]).toBe(255)
    expect(() => packOrmhPlanes({}, { roughness: 1, metallic: 0 })).toThrow()
    // A cutout albedo always gets its levels (coverage); an opaque one only level 0 (the GPU makes the mips).
    const a = await runMapJob({ kind: 'image', url: 'a', alpha: 'cutout' }, async () => noise(8, 8, 3, x => (x < 4 ? 255 : 0)))
    expect(a.levels).toHaveLength(4)
    const b = await runMapJob({ kind: 'image', url: 'b' }, async () => noise(8, 8))
    expect(b.levels).toHaveLength(1)
  })
})

// ---- uploads ------------------------------------------------------------------------------------------------------

describe('upload jobs within the frame budget', () => {
  const levelsOf = (s: number, n = levelCount(s, s)) => Array.from({ length: n }, (_, i) => {
    const e = Math.max(1, s >> i)
    return { width: e, height: e, data: new Uint8Array(e * e * 4) as Uint8Array<ArrayBuffer> }
  })

  it('a 1024² map is one job (level 0 + GPU mips, or its full chain); a 2048² one is split, each ≤ 6 MiB', () => {
    const one = planLevelUpload(levelsOf(1024, 1))
    expect(one).toHaveLength(1)
    expect(one[0]!.map(s => s.kind)).toEqual(['rows', 'mips'])
    expect(planLevelUpload(levelsOf(1024))).toHaveLength(1)
    const big = planLevelUpload(levelsOf(2048))
    expect(big.length).toBeGreaterThan(2)
    for (const job of big) {
      const bytes = job.reduce((a, s) => a + (s.kind === 'rows' ? s.data.byteLength : 0), 0)
      expect(bytes).toBeLessThanOrEqual(6 * 1048576)
    }
    // Every row of every level is uploaded exactly once.
    const rows = new Map<number, number>()
    for (const job of big) for (const s of job) if (s.kind === 'rows') rows.set(s.level, (rows.get(s.level) ?? 0) + s.height)
    expect(rows.get(0)).toBe(2048)
    expect(rows.get(11)).toBe(1)
  })
})

// ---- actors -------------------------------------------------------------------------------------------------------

describe('actor maps', () => {
  const MAN = 'prim/mtrl/item/china/man_item/clothes_01_aa.ddj'
  const WOMAN = 'prim/mtrl/item/china/woman_item/clothes_01_aa.ddj'
  const BODY = 'prim/mtrl/char/china/man/chinaman_adventurer_body.ddj'

  it('join by the sidecar texture, else by stem with the glb path choosing between man_item and woman_item', () => {
    const idx = indexOf([set(MAN, [128, 256]), set(WOMAN, [128, 256]), set(BODY, [512, 1024], { class: 'skin' })])
    const p = mapPolicy('medium')
    expect(idx.resolve({ glb: 'equipment/china/man_item/clothes_01_aa', image: 'clothes_01_aa', byStem: true }, p)!.key).toBe(MAN)
    expect(idx.resolve({ glb: 'equipment/china/woman_item/clothes_01_aa', image: 'clothes_01_aa', byStem: true }, p)!.key).toBe(WOMAN)
    expect(idx.resolve({ glb: 'x/y', image: 'clothes_01_aa', byStem: true }, p)).toBeNull() // a tie joins nothing
    expect(idx.resolve({ glb: 'char/china/chinaman_adventurer', image: 'chinaman_adventurer_body', byStem: true }, p)!.key).toBe(BODY)
    expect(idx.resolve({ image: 'chinaman_adventurer_body' }, p)).toBeNull() // no stem join unless asked
    expect(idx.resolve({ image: 'whatever', texture: 'PRIM\\MTRL\\CHAR\\CHINA\\MAN\\chinaman_adventurer_body.ddj' }, p)!.key).toBe(BODY)
  })

  it('swaps a container material in place, removes the retail texture from the container, and releases on untrack', async () => {
    const scene = nullScene()
    const idx = indexOf([set(BODY, [512, 1024], { class: 'skin' })])
    let tier: 'medium' | 'high' = 'high'
    const actors = new ActorMaps(scene, fakeSource(scene), { index: async () => idx, policy: () => mapPolicy(tier) })
    cleanups.push(() => actors.dispose())
    const c = new AssetContainer(scene)
    const mat = new PBRMaterial('chinaman_body', scene)
    const retail = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    retail.getInternalTexture()!.label = 'chinaman_adventurer_body'
    mat.albedoTexture = retail
    c.materials.push(mat)
    c.textures.push(retail)
    expect(await actors.track(c, 'char/china/chinaman_adventurer', { materials: [{ name: 'chinaman_body', texture: 'prim\\mtrl\\char\\china\\man\\chinaman_adventurer_body.ddj' }] })).toBe(1)
    expect(await actors.applied(c).get(mat)!.ready).toBe(true)
    expect(mat.albedoTexture).not.toBe(retail)
    expect(c.textures).not.toContain(retail)
    expect(actors.cache.size).toBe(3)
    actors.untrack(c)
    expect(actors.cache.size).toBe(0)
    // The 'retail' tier tracks nothing.
    tier = 'medium'
    const c2 = new AssetContainer(scene)
    expect(await new ActorMaps(scene, fakeSource(scene), { index: async () => idx, policy: () => mapPolicy('high', { textures: 'retail' }) }).track(c2, 'a')).toBe(0)
  })
})

// ---- the terrain atlas --------------------------------------------------------------------------------------------

let serial = 0
function fakeTexture(): BaseTexture {
  const t = { id: ++serial, disposed: false, dispose() { t.disposed = true } }
  return t as unknown as BaseTexture
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}

describe('terrain atlas tiers (TileAtlas prepare, tier plane, upgrade)', () => {
  function rig(opts: { layers: number; setTiles: number[]; tierLayers?: number }) {
    const uploads: Array<{ plane: TilePlane; layer: number; first: number; levels: number }> = []
    const created: Array<{ plane: TilePlane; size: number; layers: number }> = []
    const tierTex: Array<[BaseTexture | null, number]> = []
    const has = (id: number) => opts.setTiles.includes(id)
    const setup: TileAtlasSetup = {
      maps: { ormh: { size: 2, decode: async () => null } },
      tier: { size: 8, layers: opts.tierLayers ?? 2, has, decode: async id => ({ data: new Uint8Array(8 * 8 * 4).fill(50 + id), levels: [new Uint8Array(64), new Uint8Array(16), new Uint8Array(4)] }) },
      upgrade: {
        has,
        decode: async (id, plane, size) => (plane === 'ormh' ? null : { data: new Uint8Array(size * size * 4).fill(150 + id), levels: [] }),
      },
    }
    const a = new TileAtlas({
      scene: null as never,
      size: 4,
      layers: opts.layers,
      growBy: 2,
      decode: async id => new Uint8Array(4 * 4 * 4).fill(id),
      prepare: async () => setup,
      onTierTexture: (tex, layers) => tierTex.push([tex, layers]),
      create: (size, layers, plane = 'albedo') => {
        created.push({ plane, size, layers })
        return fakeTexture()
      },
      upload: (_tex, layer, rgba, _size, plane = 'albedo', levels) => {
        uploads.push({ plane, layer, first: rgba[0]!, levels: levels?.length ?? -1 })
        return true
      },
      rebuild: () => fakeTexture(),
    })
    return { a, uploads, created, tierTex }
  }

  it('allocates the planes after prepare; set tiles take the capped tier layers, the rest the base layers', async () => {
    const { a, created, uploads, tierTex } = rig({ layers: 6, setTiles: [1, 2, 3] })
    await a.acquire([1, 2, 3, 4], () => 0)
    expect(created.map(c => [c.plane, c.size, c.layers])).toEqual([['albedo', 4, 6], ['ormh', 2, 2], ['tier', 8, 2]])
    expect(tierTex.map(t => t[1])).toEqual([2])
    expect(a.tierLayers).toBe(2)
    // Two set tiles fit under the cap; the third overflows to a base layer (its base layer is the 512 overflow).
    const under = [1, 2, 3].filter(id => a.layerOf(id)! < 2)
    expect(under).toHaveLength(2)
    expect(a.layerOf(4)!).toBeGreaterThanOrEqual(2)
    // The tier plane is written only for layers under the cap, with the worker's levels; ORMH starts neutral.
    for (const u of uploads.filter(u => u.plane === 'tier' && u.first < 150)) {
      expect(u.layer).toBeLessThan(2)
      expect(u.levels).toBe(3)
    }
    expect(uploads.filter(u => u.plane === 'ormh').every(u => u.first === 255)).toBe(true)
  })

  it('swaps each set tile in place after its first commit, one upload per plane, never for other tiles', async () => {
    const { a, uploads } = rig({ layers: 6, setTiles: [1] })
    await a.acquire([1, 4], () => 0)
    await settle()
    const layer = a.layerOf(1)!
    const swapped = (u: { first: number }) => u.first >= 150 && u.first < 200
    const after = uploads.filter(u => u.layer === layer && swapped(u))
    expect(after.map(u => u.plane).sort()).toEqual(['albedo', 'tier'])
    expect(a.upgrades).toBe(2)
    expect(uploads.filter(u => u.layer === a.layerOf(4)! && swapped(u))).toEqual([])
  })

  it('no tier plane when the capacity cannot hold the cap (the map planes then span every layer); the cap is 48', async () => {
    const { a, created } = rig({ layers: 1, setTiles: [1], tierLayers: 2 })
    await a.acquire([1], () => 0)
    expect(created.map(c => [c.plane, c.layers])).toEqual([['albedo', 1], ['ormh', 1]])
    expect(a.tierTexture).toBeNull()
    expect(TILE_TIER_LAYERS).toBe(48)
  })

  it('without a tier plane (a 16-unit device) the set range still caps the map planes; set tiles sit below it', async () => {
    const created: Array<[TilePlane, number]> = []
    const tierCalls: Array<[BaseTexture | null, number]> = []
    const a = new TileAtlas({
      scene: null as never,
      size: 4,
      layers: 6,
      decode: async id => new Uint8Array(64).fill(id),
      prepare: async () => ({ maps: { normal: { decode: async () => null } }, sets: { layers: 2, has: id => id === 5 } }),
      onTierTexture: (tex, layers) => tierCalls.push([tex, layers]),
      create: (_size, layers, plane = 'albedo') => {
        created.push([plane, layers])
        return fakeTexture()
      },
      upload: () => true,
      rebuild: () => fakeTexture(),
    })
    await a.acquire([1, 2, 5], () => 0)
    expect(created).toEqual([['albedo', 6], ['normal', 2]])
    expect(tierCalls).toEqual([[null, 2]])
    expect(a.layerOf(5)!).toBeLessThan(2)
    expect(a.layerOf(1)!).toBeGreaterThanOrEqual(2)
    expect(a.setLayers).toBe(2)
  })

  it('with a tier plane the map planes are as deep as the cap and only its layers get maps', async () => {
    const { a, created, uploads } = rig({ layers: 6, setTiles: [1, 2, 3] })
    await a.acquire([1, 2, 3, 4], () => 0)
    expect(created.find(c => c.plane === 'ormh')!.layers).toBe(2)
    expect(uploads.filter(u => u.plane === 'ormh').every(u => u.layer < 2)).toBe(true)
  })
})

// ---- terrain shader ----------------------------------------------------------------------------------------------

describe('terrain plugin tier define', () => {
  it('SRO_T_TIER declares sroTilesHi in both languages, only behind its define', async () => {
    const { TERRAIN_FEATURE_DEFINES, resolveTerrainFeatures, TerrainPbr } = await import('../src/pbr/terrain-plugin.ts')
    const { RENDER_PRESETS } = await import('../src/render/quality.ts')
    expect(TERRAIN_FEATURE_DEFINES.tier).toBe('SRO_T_TIER')
    expect(resolveTerrainFeatures({ quality: RENDER_PRESETS.high, arrays: { normal: true, ormh: true, tier: true } }).tier).toBe(true)
    expect(resolveTerrainFeatures({ quality: RENDER_PRESETS.high, arrays: { normal: true, ormh: true } }).tier).toBe(false)
    const scene = nullScene()
    const pbr = new TerrainPbr(scene, new Map())
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = Object.values(pbr.codeFor(lang)).join('\n')
      expect(code).toContain('#ifdef SRO_T_TIER')
      expect(code).toContain('sroTilesHi')
      expect(code).toContain('sroTier')
      expect(code).toContain('SRO_NEUTRAL_ORMH')
    }
    pbr.dispose()
  })
})

// Keep the Rgba type referenced (the fake source's pixels).
export type { Rgba }
