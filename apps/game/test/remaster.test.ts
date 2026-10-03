/**
 * Remastered textures test switch (three/remaster.ts): the manifest (parsing, key lookup), which materials get a
 * twin, the twin's colour spaces / normal convention / alpha, the swap on the switch and the lighting it adds.
 * NullEngine; map textures come from a fake source (no fetch), the manifest from a stub.
 */
import { AssetContainer, DirectionalLight, HemisphericLight, Mesh, NullEngine, PBRMaterial, RawTexture, Scene, Texture, Vector3, type BaseTexture } from '@babylonjs/core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RENDER_ROLLOUT } from '../src/rollout.ts'
import { REMASTER_TEST_SETS, defaultSettings, normalizeSettings, settings } from '../src/settings.ts'
import { endRemasterOverride, remasterShown } from '../src/three/remaster-switch.ts'
import {
  buildRemasterMaterial,
  findRemaster,
  glbKeyPath,
  isRemastered,
  KEY_LIGHT_BOOST,
  MAP_SRGB,
  normalInversions,
  packMetallicRoughness,
  parseRemasterManifest,
  planSwaps,
  remasterEnabled,
  remasterFromSearch,
  RemasterLighting,
  RemasterScene,
  remasterWanted,
  type RemasterManifest,
  type RemasterMaps,
  type RemasterTextureSource,
} from '../src/three/remaster.ts'

const URL0 = '/out/remaster/manifest.json'

describe('manifest', () => {
  it('reads entries, resolves map paths against the manifest and fills the defaults', () => {
    const m = parseRemasterManifest({
      format: 'sro-remaster',
      version: 1,
      textures: {
        'char/china/chinaman_adventurer#chinaman_adventurer_body': {
          albedo: 'char/body/albedo.png',
          normal: 'char/body/normal.png',
          metallicRoughness: '/elsewhere/mr.png',
          emissive: 'char/body/emission.png',
        },
        hwan_hair: { albedo: 'hair.png', metallic: 'm.png', roughness: 'r.png', normalGreen: 'dx', alpha: 'albedo' },
      },
    }, URL0)!
    expect(m.warnings).toEqual([])
    const body = m.entries.get('char/china/chinaman_adventurer#chinaman_adventurer_body')!
    expect(body).toEqual({
      albedo: '/out/remaster/char/body/albedo.png',
      normal: '/out/remaster/char/body/normal.png',
      metallicRoughness: '/elsewhere/mr.png',
      emissive: '/out/remaster/char/body/emission.png',
      normalGreen: 'gl',
      alpha: 'original',
    })
    expect(m.entries.get('hwan_hair')).toMatchObject({ metallic: '/out/remaster/m.png', roughness: '/out/remaster/r.png', normalGreen: 'dx', alpha: 'albedo' })
  })

  it('is null for anything that is not a v1 remaster manifest; malformed entries are skipped with a warning', () => {
    expect(parseRemasterManifest(null, URL0)).toBeNull()
    expect(parseRemasterManifest([], URL0)).toBeNull()
    expect(parseRemasterManifest({ format: 'sro-remaster', version: 2, textures: {} }, URL0)).toBeNull()
    expect(parseRemasterManifest({ format: 'other', version: 1 }, URL0)).toBeNull()
    expect(parseRemasterManifest({ format: 'sro-remaster', version: 1 }, URL0)!.entries.size).toBe(0)
    const m = parseRemasterManifest({
      format: 'sro-remaster',
      version: 1,
      textures: {
        $comment: 'ignored',
        noAlbedo: { normal: 'n.png' },
        both: { albedo: 'a.png', metallicRoughness: 'mr.png', roughness: 'r.png' },
        green: { albedo: 'a.png', normalGreen: 'up' },
        alpha: { albedo: 'a.png', alpha: 'blend' },
        number: { albedo: 7 },
        notObject: 'a.png',
        ok: { albedo: 'a.png' },
      },
    }, URL0)!
    expect([...m.entries.keys()]).toEqual(['ok'])
    expect(m.warnings).toHaveLength(6)
  })

  it('keys are the glb path under the asset root (same for /out/ and /out-opt/) plus the image name', () => {
    expect(glbKeyPath('/out/char/china/chinaman_adventurer.glb')).toBe('char/china/chinaman_adventurer')
    expect(glbKeyPath('/out-opt/equipment/china/man_item/clothes_01_aa.glb?x=1')).toBe('equipment/china/man_item/clothes_01_aa')
    const m = parseRemasterManifest({
      format: 'sro-remaster',
      version: 1,
      textures: { 'equipment/china/man_item/clothes_01_aa#clothes_01_aa': { albedo: 'man.png' }, clothes_01_aa: { albedo: 'any.png' } },
    }, URL0)!
    // Exact glb#image first; the bare image name covers every other glb (woman_item shares the image name).
    expect(findRemaster(m, 'equipment/china/man_item/clothes_01_aa', 'clothes_01_aa')?.maps.albedo).toBe('/out/remaster/man.png')
    expect(findRemaster(m, 'equipment/china/woman_item/clothes_01_aa', 'clothes_01_aa')?.maps.albedo).toBe('/out/remaster/any.png')
    expect(findRemaster(m, 'equipment/china/woman_item/clothes_01_aa', 'clothes_02_aa')).toBeNull()
    expect(findRemaster(null, 'x', 'y')).toBeNull()
  })
})

describe('material selection', () => {
  it('only materials whose base texture image has an entry get a twin', () => {
    const m = parseRemasterManifest({
      format: 'sro-remaster',
      version: 1,
      textures: { 'char/china/chinaman_adventurer#chinaman_adventurer_body': { albedo: 'b.png' }, hwan_hair: { albedo: 'h.png' } },
    }, URL0)!
    const plan = planSwaps([
      { material: 'body', image: 'chinaman_adventurer_body' },
      { material: 'hair', image: 'chinaman_adventurer_hair' },
      { material: 'untextured', image: null },
      { material: 'hwan', image: 'hwan_hair' },
    ], 'char/china/chinaman_adventurer', m)
    expect(plan.map(p => [p.material, p.key])).toEqual([
      ['body', 'char/china/chinaman_adventurer#chinaman_adventurer_body'],
      ['hwan', 'hwan_hair'],
    ])
    expect(planSwaps([{ material: 'body', image: 'chinaman_adventurer_body' }], 'char/china/chinaman_bogy', m)).toEqual([])
    expect(planSwaps([{ material: 'body', image: 'x' }], 'a', null)).toEqual([])
  })
})

describe('the switch', () => {
  it('?remaster=1 / 0 overrides the setting for the page load; absent = the setting', () => {
    expect(remasterFromSearch('?remaster=1')).toBe(true)
    expect(remasterFromSearch('?mock=1&remaster=true')).toBe(true)
    expect(remasterFromSearch('?remaster=0')).toBe(false)
    expect(remasterFromSearch('?remaster=false')).toBe(false)
    expect(remasterFromSearch('?mock=1')).toBeNull()
    const off = defaultSettings()
    expect(off.graphics.remaster).toBe(false)
    expect(remasterWanted(off, null, 'preview')).toBe(false)
    // W9F LG-1: the switch belongs to the new look; without it (the Low guard) neither the setting nor the URL applies.
    expect(remasterWanted(off, true, 'preview')).toBe(false)
    expect(remasterWanted(normalizeSettings({ graphics: { remaster: true } }), null, 'preview')).toBe(false)
    const modern = normalizeSettings({ graphics: { modern: true } })
    expect(remasterWanted(modern, true, 'preview')).toBe(true)
    expect(remasterWanted(normalizeSettings({ graphics: { remaster: true, modern: true } }), false, 'preview')).toBe(false)
    // 'on': the new look is always on, so the setting (or the URL) decides, where the test sets are looked for.
    expect(remasterWanted(off, null, 'on')).toBe(false)
    expect(remasterWanted(normalizeSettings({ graphics: { remaster: true } }), null, 'on')).toBe(true)
    expect(remasterWanted(normalizeSettings({ graphics: { remaster: true } }), null, 'on', false)).toBe(false) // production
    expect(normalizeSettings({ graphics: { remaster: 'yes' } }).graphics.remaster).toBe(false)
  })

  it('the Options row shows the effective state and follows the setting (no URL override in node)', () => {
    expect(remasterShown(defaultSettings(), 'preview')).toBe(false)
    expect(remasterShown(normalizeSettings({ graphics: { remaster: true } }), 'preview')).toBe(false)
    expect(remasterShown(normalizeSettings({ graphics: { remaster: true, modern: true } }), 'preview')).toBe(true)
    expect(remasterShown(normalizeSettings({ graphics: { remaster: true } }), 'on')).toBe(true)
    endRemasterOverride()
    // The page's own rollout (rollout.ts, 'on'): the setting alone decides (the dev server looks for the test sets).
    const before = settings.get().graphics
    expect(remasterEnabled()).toBe(false)
    settings.set({ graphics: { remaster: true } })
    expect(remasterEnabled()).toBe(RENDER_ROLLOUT === 'on' ? REMASTER_TEST_SETS : false)
    settings.set({ graphics: { modern: true } })
    expect(remasterEnabled()).toBe(REMASTER_TEST_SETS)
    settings.set({ graphics: { remaster: false, modern: false } })
    expect(remasterEnabled()).toBe(false)
    settings.set({ graphics: { remaster: before.remaster, modern: before.modern } })
  })
})

describe('pixels', () => {
  it('packs separate greyscale maps the glTF way: G roughness, B metallic', () => {
    const metal = [10, 0, 0, 255, 200, 0, 0, 255]
    const rough = [30, 0, 0, 255, 40, 0, 0, 255]
    expect([...packMetallicRoughness(metal, rough, 2)]).toEqual([255, 30, 10, 255, 255, 40, 200, 255])
    // Missing maps: metallic 0, roughness 1.
    expect([...packMetallicRoughness(null, null, 1)]).toEqual([255, 255, 0, 255])
  })

  it('normal maps: the glTF (+Y up) convention for the scene handedness, DirectX flips green', () => {
    expect(normalInversions(true, 'gl')).toEqual({ x: false, y: true })
    expect(normalInversions(true, 'dx')).toEqual({ x: false, y: false })
    expect(normalInversions(false, 'gl')).toEqual({ x: true, y: false })
  })
})

// ---- Babylon ------------------------------------------------------------------------------------------------------

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
  vi.restoreAllMocks()
})

afterEach(() => {
  settings.set({ graphics: { remaster: false, modern: false } })
})

/** Fake map source: 1x1 textures remembering their URL and requested colour space. */
function fakeSource(s: Scene): RemasterTextureSource & { made: { url: string; srgb: boolean; tex: BaseTexture }[] } {
  const made: { url: string; srgb: boolean; tex: BaseTexture }[] = []
  return {
    made,
    texture(url, srgb) {
      const tex = new Texture(null, s)
      tex.name = url
      made.push({ url, srgb, tex })
      return tex
    },
    async packed(metal, rough) {
      const tex = RawTexture.CreateRGBATexture(packMetallicRoughness(null, null, 1), 1, 1, s)
      tex.name = `${metal}+${rough}`
      return tex
    },
  }
}

/** A glTF-like MASK material whose base texture carries the image name label, as the glTF loader leaves it. */
function retailMaterial(s: Scene, image: string): { mat: PBRMaterial; base: BaseTexture } {
  const mat = new PBRMaterial(`retail_${image}`, s)
  const base = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, s)
  base.getInternalTexture()!.label = image
  base.hasAlpha = true
  mat.albedoTexture = base
  mat.useAlphaFromAlbedoTexture = true
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
  mat.alphaCutOff = 0.5
  mat.backFaceCulling = false
  mat.metallic = 0
  return { mat, base }
}

const maps = (extra: Partial<RemasterMaps> = {}): RemasterMaps => ({ albedo: '/r/albedo.png', normalGreen: 'gl', alpha: 'original', ...extra })

describe('the remastered material', () => {
  it('albedo and emissive are sRGB, normal and metallic/roughness linear', () => {
    expect(MAP_SRGB).toEqual({ albedo: true, emissive: true, normal: false, metallicRoughness: false, metallic: false, roughness: false })
    const src = fakeSource(scene)
    const { mat } = retailMaterial(scene, 'img_a')
    const pbr = buildRemasterMaterial(mat, maps({ normal: '/r/n.png', metallicRoughness: '/r/mr.png', emissive: '/r/e.png' }), scene, src, 'k')
    expect(src.made.map(m => [m.url, m.srgb])).toEqual([
      ['/r/albedo.png', true],
      ['/r/n.png', false],
      ['/r/mr.png', false],
      ['/r/e.png', true],
    ])
    expect(pbr.albedoTexture!.gammaSpace).toBe(true)
    expect(pbr.bumpTexture!.gammaSpace).toBe(false)
    expect(pbr.metallicTexture!.gammaSpace).toBe(false)
    expect(pbr.emissiveTexture!.gammaSpace).toBe(true)
    // glTF packing and full-range factors when a metallic/roughness map is present.
    expect(pbr.useRoughnessFromMetallicTextureGreen).toBe(true)
    expect(pbr.useMetallnessFromMetallicTextureBlue).toBe(true)
    expect([pbr.metallic, pbr.roughness]).toEqual([1, 1])
    // Right-handed scene, OpenGL-style normal map: the glTF loader's inversions.
    expect([pbr.invertNormalMapX, pbr.invertNormalMapY]).toEqual([false, true])
    expect(pbr.metadata).toEqual({ remaster: 'k' })
  })

  it('keeps the retail cutout: alpha test, cutoff, culling, and the retail texture as the opacity mask', () => {
    const { mat, base } = retailMaterial(scene, 'img_b')
    const pbr = buildRemasterMaterial(mat, maps(), scene, fakeSource(scene))
    expect(pbr.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHATEST)
    expect(pbr.alphaCutOff).toBe(0.5)
    expect(pbr.backFaceCulling).toBe(false)
    expect(pbr.opacityTexture).toBe(base)
    expect(pbr.useAlphaFromAlbedoTexture).toBe(false)
    // No metallic/roughness map: the original factors.
    expect([pbr.metallic, pbr.roughness]).toEqual([0, 1])
    // The albedo may carry its own alpha instead; a DirectX normal map flips green.
    const own = buildRemasterMaterial(mat, maps({ alpha: 'albedo', normal: '/r/n.png', normalGreen: 'dx' }), scene, fakeSource(scene))
    expect(own.opacityTexture).toBeNull()
    expect(own.useAlphaFromAlbedoTexture).toBe(true)
    expect(own.albedoTexture!.hasAlpha).toBe(true)
    expect(own.invertNormalMapY).toBe(false)
  })

  it('an opaque original stays opaque (no opacity mask)', () => {
    const { mat } = retailMaterial(scene, 'img_c')
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE
    const pbr = buildRemasterMaterial(mat, maps(), scene, fakeSource(scene))
    expect(pbr.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_OPAQUE)
    expect(pbr.opacityTexture).toBeNull()
  })

  it('separate metallic and roughness maps become one packed texture', async () => {
    const { mat } = retailMaterial(scene, 'img_d')
    const pbr = buildRemasterMaterial(mat, maps({ metallic: '/r/m.png', roughness: '/r/r.png' }), scene, fakeSource(scene))
    await vi.waitFor(() => expect(pbr.metallicTexture?.name).toBe('/r/m.png+/r/r.png'))
    expect(pbr.metallicTexture!.gammaSpace).toBe(false)
    expect(pbr.useMetallnessFromMetallicTextureBlue).toBe(true)
  })
})

describe('the swap', () => {
  const manifest: RemasterManifest = {
    entries: new Map([['char/test/hero#hero_body', maps()]]),
    warnings: [],
  }

  it('swaps matching materials on the container and its instances while on, and back when off', async () => {
    const s = new Scene(engine)
    const container = new AssetContainer(s)
    const body = retailMaterial(s, 'hero_body')
    const hair = retailMaterial(s, 'hero_hair')
    const mk = (name: string, mat: PBRMaterial) => {
      const m = new Mesh(name, s)
      s.removeMesh(m)
      m.material = mat
      container.meshes.push(m)
      return m
    }
    const bodyMesh = mk('body', body.mat)
    const hairMesh = mk('hair', hair.mat)
    container.materials.push(body.mat, hair.mat)
    const load = vi.fn(async () => manifest)
    const r = new RemasterScene(s, fakeSource(s), load)
    r.track(container, '/out-opt/char/test/hero.glb')
    // An instance in the scene sharing the container's material (instantiateModelsToScene without material clones).
    const inst = new Mesh('inst', s)
    inst.material = body.mat
    expect(isRemastered(bodyMesh)).toBe(false)

    settings.set({ graphics: { remaster: true, modern: true } })
    expect(remasterEnabled()).toBe(true)
    await vi.waitFor(() => expect(isRemastered(inst)).toBe(true))
    expect(isRemastered(bodyMesh)).toBe(true)
    expect(isRemastered(hairMesh)).toBe(false)
    expect(inst.material).toBe(bodyMesh.material)
    expect(load).toHaveBeenLastCalledWith(true)
    expect(r.twinCount).toBe(1)

    // A glb loaded while on is swapped at once.
    const later = new AssetContainer(s)
    const lb = retailMaterial(s, 'hero_body')
    const lm = new Mesh('later', s)
    lm.material = lb.mat
    later.materials.push(lb.mat)
    r.track(later, '/out/char/test/hero.glb')
    await vi.waitFor(() => expect(isRemastered(lm)).toBe(true))

    settings.set({ graphics: { remaster: false } })
    expect(inst.material).toBe(body.mat)
    expect(bodyMesh.material).toBe(body.mat)
    expect(lm.material).toBe(lb.mat)
    expect(hairMesh.material).toBe(hair.mat)
    r.dispose()
    s.dispose()
  })
})

describe('lighting', () => {
  it('adds the sky environment and a stronger key light only while on', () => {
    const s = new Scene(engine)
    const key = new DirectionalLight('sun', new Vector3(0, -1, 0), s)
    key.intensity = 1.2
    const fill = new HemisphericLight('hemi', new Vector3(0, 1, 0), s)
    fill.intensity = 0.7
    const sky = new Mesh('sky', s)
    const light = new RemasterLighting(s, { key, fill, sky: () => [sky], center: () => Vector3.Zero() })
    expect(s.environmentTexture).toBeNull()
    settings.set({ graphics: { remaster: true, modern: true } })
    expect(light.active).toBe(true)
    expect(s.environmentTexture).not.toBeNull()
    expect(key.intensity).toBeCloseTo(1.2 * KEY_LIGHT_BOOST)
    expect(fill.intensity).toBeLessThan(0.7)
    settings.set({ graphics: { remaster: false } })
    expect(light.active).toBe(false)
    expect(s.environmentTexture).toBeNull()
    expect(key.intensity).toBe(1.2)
    expect(fill.intensity).toBe(0.7)
    light.dispose()
    s.dispose()
  })
})
