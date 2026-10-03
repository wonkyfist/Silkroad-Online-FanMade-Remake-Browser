/**
 * The runtime map loader (pbr/maps.ts; docs/WAVE_PLAN3.md D35, D39, D40, §6.10): `sro-pbr` index parsing (bad sets
 * skipped), `sro-remaster` parsing with RENDER §3.2's optional fields, D35's precedence (a remaster entry wins over a
 * set), keys normalised from backslash paths, missing maps falling back to class defaults, the preset caps (High picks
 * the 1024 tier), a missing index = no sets and no console noise, the ref-counted texture cache, plane packing, and
 * binding a record on a NullEngine PBRMaterial. D39: Ultra without KTX2 takes High's tiers (an explicit 2048 setting the
 * WebP tiers ≤ 2048), the remaster
 * manifest is read from /out/ first, and a record swaps in once its maps are loaded (applyMapRecord's `ready`).
 */
import { NullEngine, PBRMaterial, RawTexture, Scene, Texture, type BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyPath, type PbrSet } from '../../texpipe/src/format.ts'
import {
  PbrMapIndex,
  PbrTextureCache,
  applyMapRecord,
  keyOf,
  loadPbrMapIndex,
  mapPolicy,
  pageRemasterSets,
  packNormalPlanes,
  packOrmhPlanes,
  parsePbrIndex,
  parseRemasterManifest,
  pickSize,
  pickTier,
  releaseMaps,
  resampleNearest,
  setPageRemasterSets,
  sizedUrl,
  type MapTextureSource,
  type Rgba,
} from '../src/index.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

const ROOT = 'http://mem.test/out-opt/'
const INDEX_URL = `${ROOT}pbr/index.json`
const WALL = 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj'
const ROOF = 'prim/mtrl/bldg/china/jangan03/cj_pal_roof.ddj'

function tier(key: string, edge: number, planes = false): PbrSet['tiers'][string] {
  const p = keyPath(key)
  const t: PbrSet['tiers'][string] = { size: [edge, edge], albedo: `${p}/albedo@${edge}.webp`, bytes: 100 }
  if (planes) {
    t.nx = `${p}/nx@${edge}.webp`
    t.ny = `${p}/ny@${edge}.webp`
    t.ao = `${p}/ao@${edge}.webp`
    t.rough = `${p}/rough@${edge}.webp`
    t.height = `${p}/height@${edge}.webp`
  }
  return t
}

function set(key: string, o: Partial<PbrSet> & { edges?: number[]; planes?: number[] } = {}): PbrSet {
  const edges = o.edges ?? [256, 1024, 2048]
  const tiers: PbrSet['tiers'] = {}
  for (const e of edges) tiers[String(e)] = tier(key, e, (o.planes ?? edges).includes(e))
  const max = Math.max(...edges)
  const { edges: _e, planes: _p, ...rest } = o
  return { key, size: [max, max], class: 'stone', tiers, alpha: 'none', wrap: [true, true], status: 'ok', hero: true, ...rest }
}

function index(sets: PbrSet[], extra: Record<string, unknown> = {}): unknown {
  return {
    format: 'sro-pbr',
    version: 1,
    pipeline: { rev: 'test', upscaler: 'realesrgan-x4plus', createdAt: '2026-09-28T00:00:00Z' },
    sets: Object.fromEntries(sets.map(s => [s.key, s])),
    ...extra,
  }
}

describe('parsePbrIndex (sro-pbr v1)', () => {
  it('keeps valid sets, skips a bad one with a warning, and resolves files against the index folder', () => {
    const bad = { ...set(ROOF), class: 'glass' } as unknown as PbrSet
    const p = parsePbrIndex(index([set(WALL), bad]), INDEX_URL)!
    expect([...p.sets.keys()]).toEqual([WALL])
    expect(p.warnings.some(w => w.includes(ROOF))).toBe(true)
    expect(p.base).toBe(`${ROOT}pbr/`)
  })

  it('is null for anything that is not an sro-pbr v1 index', () => {
    expect(parsePbrIndex(null, INDEX_URL)).toBeNull()
    expect(parsePbrIndex({ format: 'sro-pbr', version: 2, sets: {} }, INDEX_URL)).toBeNull()
    expect(parsePbrIndex({ format: 'sro-remaster', version: 1, textures: {} }, INDEX_URL)).toBeNull()
    expect(parsePbrIndex({ format: 'sro-pbr', version: 1 }, INDEX_URL)).toBeNull()
  })
})

describe('parseRemasterManifest (sro-remaster v1 + RENDER §3.2 fields)', () => {
  it('reads the optional fields and rejects bad ones', () => {
    const m = parseRemasterManifest({
      format: 'sro-remaster',
      version: 1,
      textures: {
        'world/jangan/models/wall#cj_wall01': {
          albedo: 'wall/albedo.png', metallicRoughness: 'wall/orm.png', occlusion: 'wall/orm.png', height: 'wall/h.png',
          class: 'stone', delit: true, uvScale: 2, sizes: [2048, 1024],
        },
        badClass: { albedo: 'a.png', class: 'glass' },
        badSizes: { albedo: 'a.png', sizes: [0] },
      },
    }, '/out/remaster/manifest.json')!
    expect([...m.entries.keys()]).toEqual(['world/jangan/models/wall#cj_wall01'])
    expect(m.warnings).toHaveLength(2)
    expect(m.entries.get('world/jangan/models/wall#cj_wall01')).toEqual({
      albedo: '/out/remaster/wall/albedo.png',
      metallicRoughness: '/out/remaster/wall/orm.png',
      occlusion: '/out/remaster/wall/orm.png',
      height: '/out/remaster/wall/h.png',
      normalGreen: 'gl',
      alpha: 'original',
      class: 'stone',
      delit: true,
      uvScale: 2,
      sizes: [1024, 2048],
    })
  })
})

describe('PbrMapIndex.resolve (D35 precedence, D39 caps)', () => {
  const pbr = () => parsePbrIndex(index([set(WALL), set(ROOF, { hero: false, class: 'roof_tile' })]), INDEX_URL)!
  const remaster = () => parseRemasterManifest({
    format: 'sro-remaster', version: 1,
    textures: { 'world/jangan/models/cj_w#cj_wall01': { albedo: 'meshy/wall.png', normal: 'meshy/n.png', sizes: [1024] } },
  }, `${ROOT}remaster/manifest.json`)!

  it('an sro-remaster entry for the glb image wins over the sro-pbr set of its retail path', () => {
    const idx = new PbrMapIndex({ pbr: pbr(), remaster: remaster() })
    const q = { glb: 'world/jangan/models/cj_w', image: 'cj_wall01', texture: WALL }
    const r = idx.resolve(q, mapPolicy('high'))!
    expect(r.origin).toBe('remaster')
    expect(r.albedo).toBe(`${ROOT}remaster/meshy/wall@1024.png`)
    expect(r.normal).toEqual({ kind: 'file', url: `${ROOT}remaster/meshy/n@1024.png` })
    // Another glb with the same retail texture takes the set.
    expect(idx.resolve({ ...q, glb: 'world/jangan/models/cj_e' }, mapPolicy('high'))!.origin).toBe('pbr')
    // Ultra keeps the full remaster file (RENDER §3.2).
    expect(idx.resolve(q, mapPolicy('ultra'))!.albedo).toBe(`${ROOT}remaster/meshy/wall.png`)
  })

  it('keys normalise backslash retail paths (keyOf)', () => {
    expect(keyOf('PRIM\\MTRL\\BLDG\\china\\jangan_enter\\CJ_WALL01.ddj')).toBe(WALL)
    const idx = new PbrMapIndex({ pbr: pbr() })
    expect(idx.resolve({ texture: 'prim\\mtrl\\bldg\\china\\jangan_enter\\cj_wall01.ddj' }, mapPolicy('high'))!.key).toBe(WALL)
  })

  it("High picks the 1024 tier and half-size maps; Medium the retail tier; Ultra without KTX2 High's tier (D39)", () => {
    const idx = new PbrMapIndex({ pbr: pbr() })
    const high = idx.resolve({ texture: WALL }, mapPolicy('high'))!
    expect(high.tier).toBe(1024)
    expect(high.albedo).toBe(`${ROOT}pbr/${keyPath(WALL)}/albedo@1024.webp`)
    // Maps come from the ≤ 512 tier, falling back to the next smaller one that has planes.
    expect(high.normal).toEqual({ kind: 'planes', nx: `${ROOT}pbr/${keyPath(WALL)}/nx@256.webp`, ny: `${ROOT}pbr/${keyPath(WALL)}/ny@256.webp` })
    expect(idx.resolve({ texture: WALL }, mapPolicy('medium'))!.tier).toBe(256)
    // D39: "Ultra only with KTX2 (else Ultra uses High's textures)".
    expect(idx.resolve({ texture: WALL }, mapPolicy('ultra'))!.tier).toBe(1024)
    expect(mapPolicy('ultra').maps).toBe('all')
    // An explicit 2048 setting still takes the WebP tiers ≤ 2048, maps ≤ 1024.
    const ultra = idx.resolve({ texture: WALL }, mapPolicy('ultra', { textures: 2048 }))!
    expect(ultra.tier).toBe(2048)
    expect(ultra.normal).toEqual({ kind: 'planes', nx: `${ROOT}pbr/${keyPath(WALL)}/nx@1024.webp`, ny: `${ROOT}pbr/${keyPath(WALL)}/ny@1024.webp` })
    expect(pickTier({ '256': tier(WALL, 256), '1024': tier(WALL, 1024), '2048': tier(WALL, 2048) }, 1024)).toBe('1024')
    expect(pickTier({ '2048': tier(WALL, 2048) }, 1024)).toBe('2048')
    expect(pickTier({}, 1024)).toBeNull()
  })

  it('missing maps fall back to class defaults: non-hero sets and albedo-only sets get only the albedo', () => {
    const idx = new PbrMapIndex({ pbr: parsePbrIndex(index([
      set(WALL, { planes: [] }),
      set(ROOF, { hero: false, class: 'roof_tile' }),
      set('prim/mtrl/a.ddj', { status: 'albedo-only' }),
    ]), INDEX_URL)! })
    for (const key of [WALL, ROOF, 'prim/mtrl/a.ddj']) {
      const r = idx.resolve({ texture: key }, mapPolicy('high'))!
      expect(r.albedo).toContain('albedo@1024.webp')
      expect([r.normal, r.orm]).toEqual([null, null])
    }
    // Ultra with KTX2 gives maps to every ok set.
    const u = new PbrMapIndex({ pbr: parsePbrIndex(index([set(ROOF, { hero: false, class: 'roof_tile' })]), INDEX_URL)! })
    expect(u.resolve({ texture: ROOF }, mapPolicy('ultra', { ktx2: true }))!.normal).not.toBeNull()
  })

  it('retail sets keep the retail texture; replaced sets load their gen: replacement; unknown textures get null', () => {
    const gen = set('gen:wall_new', { replaces: WALL, class: 'stone' })
    const idx = new PbrMapIndex({ pbr: parsePbrIndex(index([set(WALL, { status: 'replaced' }), gen, set(ROOF, { status: 'retail' })]), INDEX_URL)! })
    expect(idx.resolve({ texture: WALL }, mapPolicy('high'))!.key).toBe('gen:wall_new')
    expect(idx.resolve({ texture: ROOF }, mapPolicy('high'))).toBeNull()
    expect(idx.resolve({ texture: 'prim/mtrl/none.ddj' }, mapPolicy('high'))).toBeNull()
    expect(PbrMapIndex.EMPTY.empty).toBe(true)
    expect(PbrMapIndex.EMPTY.resolve({ texture: WALL, image: 'cj_wall01' }, mapPolicy('high'))).toBeNull()
  })

  it('classOf: overrides > the set class > classify', () => {
    const idx = new PbrMapIndex({ pbr: parsePbrIndex(index([set(ROOF, { class: 'metal' })]), INDEX_URL)!, overrides: new Map([[WALL, 'wood' as const]]) })
    expect(idx.classOf('prim\\mtrl\\bldg\\china\\jangan_enter\\cj_wall01.ddj')).toBe('wood')
    expect(idx.classOf(ROOF)).toBe('metal')
    expect(idx.classOf('prim/mtrl/bldg/china/jangan_enter/cj_door.ddj')).toBe('wood')
  })

  it('size helpers', () => {
    expect(pickSize([512, 1024, 2048], 1024)).toBe(1024)
    expect(pickSize([2048], 1024)).toBeNull()
    expect(pickSize([512], Infinity)).toBeNull()
    expect(sizedUrl('/out/remaster/a/albedo.png', 1024)).toBe('/out/remaster/a/albedo@1024.png')
    expect(sizedUrl('/x.y/albedo', 512)).toBe('/x.y/albedo@512')
    expect(sizedUrl('/a/b.webp?v=2', 256)).toBe('/a/b@256.webp?v=2')
  })
})

describe('loadPbrMapIndex', () => {
  it('a missing index and manifest are "no sets" without console noise (D40)', async () => {
    const error = vi.spyOn(console, 'error')
    const warn = vi.spyOn(console, 'warn')
    const idx = await loadPbrMapIndex({ bytes: async url => { throw new Error(`404 ${url}`) } }, ROOT)
    expect(idx.empty).toBe(true)
    // A dev server's HTML fallback is also "no sets".
    const html = await loadPbrMapIndex({ bytes: async () => new TextEncoder().encode('<!doctype html>') as Uint8Array<ArrayBuffer> }, ROOT)
    expect(html.empty).toBe(true)
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('loads both files from the asset root', async () => {
    const files: Record<string, unknown> = {
      [INDEX_URL]: index([set(WALL)]),
      [`${ROOT}remaster/manifest.json`]: { format: 'sro-remaster', version: 1, textures: { cj_wall01: { albedo: 'w.png' } } },
    }
    const seen: string[] = []
    const idx = await loadPbrMapIndex({
      bytes: async url => {
        seen.push(url)
        if (!(url in files)) throw new Error('404')
        return new TextEncoder().encode(JSON.stringify(files[url])) as Uint8Array<ArrayBuffer>
      },
    }, ROOT.slice(0, -1))
    // The remaster manifest is looked for under /out/ first (RENDER §3.2: optimize-out copies it into /out-opt/ later).
    expect(seen.sort()).toEqual(['http://mem.test/out/remaster/manifest.json', INDEX_URL, `${ROOT}remaster/manifest.json`].sort())
    expect(idx.pbr!.sets.size).toBe(1)
    expect(idx.remaster!.entries.size).toBe(1)
    expect(idx.resolve({ image: 'cj_wall01', texture: WALL }, mapPolicy('high'))!.origin).toBe('remaster')
  })

  it('with the remaster sets off (a production page, I9A) only the index is fetched: no 404 probes', async () => {
    const seen: string[] = []
    const io = {
      bytes: async (url: string) => {
        seen.push(url)
        if (url !== INDEX_URL) throw new Error('404')
        return new TextEncoder().encode(JSON.stringify(index([set(WALL)]))) as Uint8Array<ArrayBuffer>
      },
    }
    const idx = await loadPbrMapIndex(io, ROOT, { remaster: false })
    expect(seen).toEqual([INDEX_URL])
    expect(idx.remaster).toBeNull()
    expect(idx.pbr!.sets.size).toBe(1)
    // the page switch does the same when the option is absent
    expect(pageRemasterSets()).toBe(true)
    setPageRemasterSets(false)
    cleanups.push(() => setPageRemasterSets(true))
    seen.length = 0
    await loadPbrMapIndex(io, ROOT)
    expect(seen).toEqual([INDEX_URL])
  })
})

describe('plane packing (D37 ORMH, v1 normal planes)', () => {
  const grey = (w: number, h: number, v: number): Rgba => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) as Uint8Array<ArrayBuffer> })

  it('packs ORMH at the first plane size with class defaults for missing planes', () => {
    const o = packOrmhPlanes({ ao: grey(2, 2, 200), height: grey(4, 4, 90) }, { roughness: 0.8, metallic: 0 })
    expect([o.width, o.height]).toEqual([2, 2])
    expect([...o.data.slice(0, 4)]).toEqual([200, 204, 0, 90])
    expect(() => packOrmhPlanes({}, { roughness: 1, metallic: 0 })).toThrow()
  })

  it('rebuilds z from nx, ny (128 = 0)', () => {
    const n = packNormalPlanes(grey(1, 1, 128), grey(1, 1, 128))
    expect([...n.data]).toEqual([128, 128, 255, 255])
    const tilted = packNormalPlanes(grey(1, 1, 255), grey(2, 2, 128))
    expect(tilted.data[2]).toBe(128)
  })

  it('resamples nearest', () => {
    const img: Rgba = { width: 2, height: 1, data: new Uint8Array([1, 1, 1, 1, 9, 9, 9, 9]) as Uint8Array<ArrayBuffer> }
    expect([...resampleNearest(img, 4, 1)].filter((_, i) => i % 4 === 0)).toEqual([1, 1, 9, 9])
  })
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

/** Fake textures: RawTextures named after their URL; plane pixels are uniform greys. */
function fakeSource(scene: Scene, made: string[]): MapTextureSource {
  return {
    texture(url, srgb) {
      made.push(url)
      const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
      t.name = url
      t.gammaSpace = srgb
      return t
    },
    async pixels(url) {
      return { width: 2, height: 2, data: new Uint8Array(16).fill(url.includes('rough') ? 60 : 128) as Uint8Array<ArrayBuffer> }
    },
    raw(img) {
      const t = RawTexture.CreateRGBATexture(img.data, img.width, img.height, scene)
      t.name = `raw${img.width}`
      return t
    },
  }
}

describe('PbrTextureCache', () => {
  it('shares a texture per URL and colour space, and disposes it with its last user', () => {
    const scene = nullScene()
    const made: string[] = []
    const cache = new PbrTextureCache(fakeSource(scene, made))
    const a = cache.acquire('/a.webp', true)
    expect(cache.acquire('/a.webp', true)).toBe(a)
    const lin = cache.acquire('/a.webp', false)
    expect(lin).not.toBe(a)
    expect(made).toEqual(['/a.webp', '/a.webp'])
    const dispose = vi.spyOn(a, 'dispose')
    cache.release(a)
    expect(dispose).not.toHaveBeenCalled()
    cache.release(a)
    expect(dispose).toHaveBeenCalledOnce()
    cache.release(lin)
    expect(cache.size).toBe(0)
  })

  it('builds a packed texture once per key', async () => {
    const scene = nullScene()
    const cache = new PbrTextureCache(fakeSource(scene, []))
    let builds = 0
    const build = async () => {
      builds++
      return { width: 1, height: 1, data: new Uint8Array(4) as Uint8Array<ArrayBuffer> }
    }
    const [t1, t2] = await Promise.all([cache.acquirePacked('k', build), cache.acquirePacked('k', build)])
    expect(t1).toBe(t2)
    expect(builds).toBe(1)
    cache.release(t1)
    cache.release(t2)
    expect(cache.size).toBe(0)
  })
})

describe('applyMapRecord / releaseMaps', () => {
  it('binds the albedo, normal (with specular AA) and ORMH maps, and gives them back', async () => {
    const scene = nullScene()
    const made: string[] = []
    const cache = new PbrTextureCache(fakeSource(scene, made))
    const idx = new PbrMapIndex({ pbr: parsePbrIndex(index([set(WALL)]), INDEX_URL)! })
    const rec = idx.resolve({ texture: WALL }, mapPolicy('high'))!
    const mat = new PBRMaterial('wall', scene)
    const retail = new Texture(null, scene) as BaseTexture
    mat.albedoTexture = retail
    let changes = 0
    const applied = applyMapRecord(mat, rec, cache, 'stone', () => changes++)
    // Progressive swap: the retail texture draws until every map is in, then all are bound at once.
    expect(mat.albedoTexture).toBe(retail)
    expect(await applied.ready).toBe(true)
    expect(changes).toBe(1)
    expect(mat.albedoTexture!.gammaSpace).toBe(true)
    expect(mat.directIntensity).toBe(0.8) // not de-lit
    expect(mat.bumpTexture).not.toBeNull()
    expect(mat.enableSpecularAntiAliasing).toBe(true)
    expect(mat.metallicTexture).not.toBeNull()
    expect([mat.useAmbientOcclusionFromMetallicTextureRed, mat.useRoughnessFromMetallicTextureGreen, mat.useMetallnessFromMetallicTextureBlue]).toEqual([true, true, true])
    expect([applied.normal, applied.roughness]).toEqual([true, true])
    expect(cache.size).toBe(3)
    releaseMaps(mat, applied, cache)
    expect(cache.size).toBe(0)
    expect([mat.albedoTexture, mat.bumpTexture, mat.metallicTexture]).toEqual([null, null, null])
  })

  it('a cutout keeps the retail alpha as its mask when the set says "original"', async () => {
    const scene = nullScene()
    const cache = new PbrTextureCache(fakeSource(scene, []))
    const m = parseRemasterManifest({ format: 'sro-remaster', version: 1, textures: { leaf: { albedo: 'leaf.png' } } }, '/out/remaster/manifest.json')!
    const rec = new PbrMapIndex({ remaster: m }).resolve({ image: 'leaf' }, mapPolicy('medium'))!
    const mat = new PBRMaterial('leaf', scene)
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    const retail = new Texture(null, scene) as BaseTexture
    mat.albedoTexture = retail
    expect(await applyMapRecord(mat, rec, cache, 'foliage').ready).toBe(true)
    expect(mat.opacityTexture).toBe(retail)
    expect(mat.useAlphaFromAlbedoTexture).toBe(false)
  })
})
