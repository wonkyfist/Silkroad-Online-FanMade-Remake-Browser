/**
 * W9 finish, adversarial hunt, lens "textures" (TX-R): each `it` below is a problem found in the runtime texture tiers
 * and swaps (packages/world-render/src/pbr/maps.ts, apps/game/src/three/actor-textures.ts, the retired remaster
 * switch). They fail on HEAD 1af27df and describe the behaviour the specs ask for.
 *
 *   1. A set whose albedo carries no alpha (`alpha: 'specmask'` or 'none') bound on an alpha-tested material drops the
 *      retail cutout: pbrRecord always says `alpha: 'albedo'`, so the swap reads the mask from an opaque WebP. Real
 *      data: equipment/china/weapon/bow_03 and spear_03 are MASK (the converter: the alpha test "cuts 49% of the
 *      surface"), their sets bow_1_5 / spear_1_5 are 'specmask' with 3-channel albedo files.
 *   2. D39 [decision]: "Ultra only with KTX2 (else Ultra uses High's textures)". Without the transcoder (the deploy
 *      leaves it out) Ultra takes the RGBA8 2048 tier: 788 MB albedo + 455 MB maps for the 145 sets vs High's 197 + 246.
 *   3. The actors' tier ignores the preset the world actually runs (`?quality=`, and the 16-varying GPU cap): a world
 *      on Low (Classic) gets remastered characters.
 *   4. The retired `graphics.remaster` switch: a save with it on keeps RemasterLighting (key light x1.25, fill x0.7, an
 *      environment probe) on the preview-off Classic path, and no Options row shown there can clear it.
 */
import { NullEngine, PBRMaterial, RawTexture, Scene, Texture, type BaseTexture } from '@babylonjs/core'
import {
  PbrMapIndex,
  PbrTextureCache,
  applyMapRecord,
  mapPolicy,
  parsePbrIndex,
  type MapTextureSource,
} from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyPath, type PbrSet } from '../../../packages/texpipe/src/format.ts'
import { pageRows, type OptionsHost } from '../src/hud/options.ts'
import { effectiveGraphics, normalizeSettings, settings } from '../src/settings.ts'
import { ActorTextures } from '../src/three/actor-textures.ts'
import { remasterWanted } from '../src/three/remaster-switch.ts'
import { urlQuality } from '../src/world/jangan/ground.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ROOT = 'http://mem.test/out-opt/'
const INDEX_URL = `${ROOT}pbr/index.json`
const BOW = 'prim/mtrl/item/china/weapon/bow_1_5.ddj'
const WALL = 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj'

function tier(key: string, edge: number): PbrSet['tiers'][string] {
  const p = keyPath(key)
  return {
    size: [edge, edge],
    albedo: `${p}/albedo@${edge}.webp`,
    bytes: 100,
    nx: `${p}/nx@${edge}.webp`,
    ny: `${p}/ny@${edge}.webp`,
    ao: `${p}/ao@${edge}.webp`,
    rough: `${p}/rough@${edge}.webp`,
    height: `${p}/height@${edge}.webp`,
  }
}

function set(key: string, o: Partial<PbrSet> = {}): PbrSet {
  const tiers: PbrSet['tiers'] = { '512': tier(key, 512), '1024': tier(key, 1024), '2048': tier(key, 2048) }
  return { key, size: [2048, 2048], class: 'default', tiers, alpha: 'none', wrap: [true, true], status: 'auto', hero: true, tier2x: '1024', ...o }
}

function index(sets: PbrSet[]): unknown {
  return {
    format: 'sro-pbr',
    version: 1,
    pipeline: { rev: 'test', upscaler: 'realesrgan-x4plus', createdAt: '2026-09-29T00:00:00Z' },
    sets: Object.fromEntries(sets.map(s => [s.key, s])),
  }
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

/** Decoded files as the worker returns them: a WebP without an alpha channel decodes to alpha 255 everywhere. */
function opaqueSource(scene: Scene): MapTextureSource {
  return {
    texture(url, srgb) {
      const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
      t.name = url
      t.gammaSpace = srgb
      return t
    },
    async pixels() {
      return { width: 2, height: 2, data: new Uint8Array(16).fill(255) as Uint8Array<ArrayBuffer> }
    },
    raw(img) {
      return RawTexture.CreateRGBATexture(img.data, img.width, img.height, scene)
    },
  }
}

const host: OptionsHost = {
  engine: 'WebGL2',
  keyHelp() {},
  toast() {},
  menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
}

describe('abuse w9f textures: the swap keeps the retail look where the set has nothing to replace it with', () => {
  it('a specmask set on an alpha-tested material keeps the retail alpha as the cutout (bow_03 / spear_03)', async () => {
    const scene = nullScene()
    const cache = new PbrTextureCache(opaqueSource(scene))
    const pbr = parsePbrIndex(index([set(BOW, { alpha: 'specmask' })]), INDEX_URL)!
    const rec = new PbrMapIndex({ pbr }).resolve({ texture: BOW }, mapPolicy('high'))!
    expect(rec).not.toBeNull()
    // equipment/china/weapon/bow_03.glb: material bow_1_5, alphaMode MASK, cutoff 0.5 (the retail PNG's alpha).
    const mat = new PBRMaterial('bow_1_5', scene)
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    mat.alphaCutOff = 0.5
    const retail = new Texture(null, scene) as BaseTexture
    retail.hasAlpha = true
    mat.albedoTexture = retail
    mat.useAlphaFromAlbedoTexture = true
    expect(await applyMapRecord(mat, rec, cache, 'default').ready).toBe(true)
    // The set's albedo has no alpha (TEXPIPE §6.2: alpha only for cutout/blend sets): the mask must stay the retail one.
    const maskFromRetail = mat.opacityTexture === retail && !mat.useAlphaFromAlbedoTexture
    expect(maskFromRetail, 'the swap reads the alpha test from an opaque albedo: the cut-away parts of the bow render solid').toBe(true)
  })
})

describe('abuse w9f textures: tier choice per preset', () => {
  it("D39: without the KTX2 transcoder Ultra loads High's textures, not the RGBA8 2048 tier", () => {
    const high = mapPolicy('high')
    const ultra = mapPolicy('ultra', { ktx2: false })
    expect({ albedoCap: ultra.albedoCap, tier2x: ultra.tier2x, mapCap: ultra.mapCap }).toEqual({ albedoCap: high.albedoCap, tier2x: high.tier2x, mapCap: high.mapCap })
    const idx = new PbrMapIndex({ pbr: parsePbrIndex(index([set(WALL)]), INDEX_URL)! })
    expect(idx.resolve({ texture: WALL }, ultra)!.tier).toBe(idx.resolve({ texture: WALL }, high)!.tier)
  })

  it('the actors load the tier of the preset the world runs (?quality=low: Classic, retail textures)', () => {
    const before = settings.get()
    cleanups.push(() => settings.set({ graphics: { modern: before.graphics.modern, preset: before.graphics.preset, textures: before.graphics.textures } }))
    settings.set({ graphics: { modern: true, preset: 'high', textures: 'auto' } })
    vi.stubGlobal('location', { search: '?quality=low', href: 'http://localhost:5180/?quality=low' })
    // screens/world.ts: the world starts with effectiveGraphics(settings, { gpu, preset: urlQuality() ?? preset }).
    const world = effectiveGraphics(settings.get(), { preset: urlQuality() ?? settings.get().graphics.preset })
    expect(world.render).toBe('classic')
    expect(world.textureTier).toBe('retail')
    const scene = nullScene()
    const actors = new ActorTextures(scene)
    cleanups.push(() => actors.dispose())
    const policy = (actors.maps as unknown as { o: { policy(): { tier: unknown } } }).o.policy()
    expect(policy.tier, 'characters swap to the remastered High tier on a Low (Classic) world').toBe(world.textureTier)
  })
})

describe('abuse w9f textures: the retired remaster switch', () => {
  it('a save with graphics.remaster on is either ignored without the new look or can be cleared from a visible row', () => {
    const s = normalizeSettings({ graphics: { remaster: true } })
    const e = effectiveGraphics(s, { rollout: 'preview' })
    expect(e.modern).toBe(false)
    expect(e.render).toBe('classic')
    for (const rollout of ['preview', 'on'] as const) {
      const stillOn = remasterWanted(s, null, rollout)
      const rows = pageRows(host, 'graphics', s, rollout)
      const clears = rows.some(r => {
        if (r.kind === 'toggle') return r.patch(false).graphics?.remaster === false || r.patch(true).graphics?.remaster === false
        if (r.kind === 'choice') return r.choices.some(c => r.patch(c.value).graphics?.remaster === false)
        return false
      })
      // With it on, screens/world.ts builds RemasterLighting on the Classic path (key x1.25, fill x0.7, an env probe)
      // and RemasterScene builds twins from the remaster manifest (dev server or ?remaster=1 only).
      expect(!stillOn || clears, `${rollout}: the retired switch stays on with no Options row to turn it off`).toBe(true)
    }
  })
})
