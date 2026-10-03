/**
 * W9F adversarial hunt, lens "lowguard": with the preview toggle OFF (rollout.ts 'preview', graphics.modern false) the
 * game must render exactly as before wave 9 (dc737cc): Classic path, classic sky, weather off, frozen noon, and nothing
 * of the new look in any pixel, define or draw. NullEngine, the game's real settings / options / remaster switch and
 * world-render's real World, NightLights, TileAtlas and ActorMaps over the synthetic stream fixture. Tests that FAIL
 * here are the findings (each `it` names one).
 */
import { AssetContainer, ArcRotateCamera, DirectionalLight, HemisphericLight, Mesh, NullEngine, PBRMaterial, RawTexture, Scene, Vector3, type BaseTexture } from '@babylonjs/core'
import {
  ActorMaps,
  CLEAR_FRAME,
  PbrMapIndex,
  attachNightLights,
  loadWorld,
  parsePbrIndex,
  policyForTier,
  type MapTextureSource,
  type World,
  type WorldIO,
} from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROOT_URL, WORLD_NAME, makeFixture, settle } from '../../../packages/world-render/test/stream-fixture.ts'
import { pageRows, type OptionsHost } from '../src/hud/options.ts'
import { effectiveGraphics, normalizeSettings, settings, worldQualityFor, type Settings } from '../src/settings.ts'
import { ModelLibrary } from '../src/three/models.ts'
import { KEY_LIGHT_BOOST, RemasterLighting, remasterEnabled, remasterWanted } from '../src/three/remaster.ts'

// This hunt checks the 'preview' rollout's off state (the toggle unticked), which the release keeps one value away
// (rollout.ts); the release's own Low guard (Low + classic sky + weather off) is in rollout.test.ts and world-render's
// seams-classic.test.ts.
vi.mock('../src/rollout.ts', () => ({ RENDER_ROLLOUT: 'preview' }))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c()
    } catch {
      // best effort
    }
  }
  vi.restoreAllMocks()
})

const quiet = () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

function nullScene(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return { engine, scene }
}

const HOST = { engine: 'WebGL2', keyHelp: () => {}, toast: () => {}, menu: {} } as unknown as OptionsHost

/** What world/graphics.ts apply hands the world with the preview off (worldQualityFor → PREVIEW_OFF_RENDER). */
function previewOff(preset: Settings['graphics']['preset'] = 'medium'): Settings {
  return normalizeSettings({ graphics: { preset, modern: false } })
}

// ---- 1. the retired "Remastered textures (test)" switch -------------------------------------------------------------

describe('LG-1: a saved graphics.remaster = true still changes the Classic look with the preview off', () => {
  it('the preview-off settings are the Low guard state (control)', () => {
    const s = normalizeSettings({ graphics: { remaster: true, modern: false } })
    const e = effectiveGraphics(s)
    expect([e.modern, e.render, e.sky, e.weather, e.textureTier]).toEqual([false, 'classic', 'classic', 'off', 'retail'])
  })

  it('the remaster switch stays on without the new look (RemasterLighting + twins run on the Classic path)', () => {
    // A player who used the 3dad3ef-era Options row "Remastered textures (test)" has graphics.remaster = true saved.
    const s = normalizeSettings({ graphics: { remaster: true, modern: false } })
    expect(effectiveGraphics(s).modern).toBe(false)
    // Low guard: nothing of the wave-9 test switch may apply without the new look.
    expect(remasterWanted(s, null), 'remaster switch effective with the preview off').toBe(false)
  })

  it('and no visible Options row can turn it off any more (the Textures row that clears it is modern-only)', () => {
    const s = normalizeSettings({ graphics: { remaster: true, modern: false } })
    const rows = pageRows(HOST, 'graphics', s)
    const clears = rows.filter(r => {
      const row = r as unknown as { kind: string; patch?: (v: unknown) => { graphics?: { remaster?: boolean } }; choices?: Array<{ value: unknown }> }
      if (!row.patch) return false
      const values = row.kind === 'toggle' ? [false, true] : (row.choices ?? []).map(c => c.value)
      return values.some(v => row.patch!(v)?.graphics?.remaster === false)
    })
    // W9F fix-game: the retired setting is now ignored without the new look (remasterWanted), and with it the Textures
    // row clears it; so a clearing row is needed only where the setting still applies (as the TEX-4 test states it).
    expect(!remasterWanted(s, null) || clears.length > 0, 'a saved graphics.remaster that applies with no row to clear it').toBe(true)
  })

  it('in the world: the character key light is x1.25, the fill x0.7 and an environment cube is bound (Classic, preview off)', () => {
    quiet()
    const before = settings.get()
    cleanups.push(() => settings.set({ graphics: { remaster: before.graphics.remaster, modern: before.graphics.modern } }))
    settings.set({ graphics: { remaster: true, modern: false } })
    expect(effectiveGraphics(settings.get()).render).toBe('classic')
    // W9F fix-game: this premise (the switch effective with the preview off) is what LG-1 fixes.
    expect(remasterEnabled()).toBe(false)
    const { scene } = nullScene()
    // screens/world.ts buildWorldScene's character lights, and its `remasterLight` made for the Classic start.
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
    hemi.intensity = 0.7
    const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5).normalize(), scene)
    sun.intensity = 1.2
    const light = new RemasterLighting(scene, { key: sun, fill: hemi, sky: () => [new Mesh('sky', scene)], center: () => Vector3.Zero() })
    cleanups.push(() => light.dispose())
    expect(sun.intensity, `key light (x${KEY_LIGHT_BOOST} while the switch is on)`).toBe(1.2)
    expect(hemi.intensity).toBe(0.7)
    expect(scene.environmentTexture === null, 'no ReflectionProbe cube on the Classic path').toBe(true)
  })
})

// ---- 2. night lights on the Classic path ------------------------------------------------------------------------------

describe('LG-2: the night lights (fx-world attaches them to every world) define SRO_NIGHT_SPLAT / SRO_NIGHT_GRASS with the preview off', () => {
  it('Classic terrain materials carry no define with the preview off (dc737cc: none)', async () => {
    quiet()
    const { scene } = nullScene()
    const fx = makeFixture()
    const s = previewOff('low')
    const e = effectiveGraphics(s)
    const world = await loadWorld(scene, {
      baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'low',
      render: e.render, sky: e.sky, weatherLevel: e.weather,
    })
    cleanups.push(() => world.dispose())
    world.setQuality(worldQualityFor(s, 'low'))
    world.setWeather(CLEAR_FRAME)
    // Control: the world alone is the guard state (seams-classic.test.ts).
    for (const m of world.terrain.materials) expect(m.options.defines ?? []).toEqual([])
    // world/features/fx-world.ts onFrame: attachNightLights(ground.world, …) for every world, whatever the preview.
    const nl = attachNightLights(world, { focus: () => ({ x: 96, z: -96 }) as never })
    cleanups.push(() => nl.dispose())
    const defs = new Set(world.terrain.materials.flatMap(m => m.options.defines ?? []))
    expect([...defs], 'terrain defines with the preview off (SRO_NIGHT_SPLAT samples nightSplat on every terrain pixel)').toEqual([])
  })
})

// ---- 3. terrain atlas after the preview is turned off in the world -----------------------------------------------------

describe('LG-3: turning the preview off in the world keeps the remastered terrain albedo in the Classic tile array', () => {
  it('no Classic terrain layer holds a texture-set albedo after the live switch (Medium PBR → preview off)', async () => {
    quiet()
    const { engine, scene } = nullScene()
    const fx = makeFixture()
    // A sro-pbr index with a set for tile 10 (stem of tiles/10.png), one tier at the retail size.
    const setKey = 'tile2d:10'
    const tierFiles = ['albedo', 'nx', 'ny', 'ao', 'rough', 'height'].map(k => [k, `tile2d/10/${k}@4.webp`] as const)
    const index = {
      format: 'sro-pbr', version: 1, pipeline: { rev: 'test', upscaler: 'x', createdAt: '2026-09-29T00:00:00Z' },
      sets: {
        [setKey]: {
          key: setKey, size: [4, 4], class: 'ground_soil', alpha: 'none', wrap: [true, true], status: 'auto', hero: true,
          tiers: { 4: { size: [4, 4], bytes: 1, ...Object.fromEntries(tierFiles) } },
        },
      },
    }
    fx.files.set(`${ROOT_URL}pbr/index.json`, new TextEncoder().encode(JSON.stringify(index)))
    for (const [, f] of tierFiles) fx.files.set(`${ROOT_URL}pbr/${f}`, new Uint8Array([1]))
    // Retail pixels decode to 128, the set's files to 200.
    const from = new WeakMap<object, string>()
    const io: WorldIO = {
      async bytes(url) {
        const b = await fx.io.bytes(url)
        from.set(b, url)
        return b
      },
      async decodeImage(bytes, mime, size) {
        const img = await fx.io.decodeImage(bytes, mime, size)
        if (/\/pbr\//.test(from.get(bytes) ?? '')) img.data.fill(200)
        return img
      },
    }
    // The player entered with the preview on at Medium (the PBR path).
    const world: World = await loadWorld(scene, {
      baseUrl: ROOT_URL, world: WORLD_NAME, io, minimap: false, objects: false, quality: 'medium', render: 'pbr', sky: 'modern', weatherLevel: 'medium',
    })
    cleanups.push(() => world.dispose())
    type AtlasProbe = { upload: (...a: unknown[]) => boolean; entries: Map<number, { layer: number; refs: number }>; upgrades: number }
    const atlasOf = () => (world.stream as unknown as { atlas: AtlasProbe }).atlas
    /** Records the first byte of every albedo layer upload of one atlas (the streamer replaces it on a path switch). */
    const track = (a: AtlasProbe) => {
      const seen = new Map<number, number>()
      const upload = a.upload.bind(a)
      a.upload = (p: unknown, tex: unknown, layer: unknown, data: unknown, levels: unknown) => {
        if ((p as { kind: string }).kind === 'albedo') seen.set(layer as number, (data as Uint8Array)[0]!)
        return upload(p, tex, layer, data, levels)
      }
      return seen
    }
    let atlas = atlasOf()
    let albedo = track(atlas)
    const cam = new ArcRotateCamera('cam', 0, 1, 10, new Vector3(96, 10, -96), scene)
    scene.activeCamera = cam
    const frames = async (n: number) => {
      for (let i = 0; i < n; i++) {
        world.update(cam)
        engine.beginFrame()
        scene.render()
        engine.endFrame()
        await settle(2)
      }
    }
    for (let i = 0; i < 60 && atlas.upgrades === 0; i++) await frames(5)
    expect(atlas.upgrades, 'the set tile swapped in on the PBR path (control)').toBeGreaterThan(0)
    // Options → "Modern graphics (preview)" off: world/graphics.ts apply → setQuality(low blocks), setRenderMode('classic').
    const off = previewOff('medium')
    world.setWeatherLevel('off')
    world.setQuality(worldQualityFor(off, 'medium'))
    world.setRenderMode('classic')
    // The streamer may hand the Classic terrain a fresh atlas (it does since the fix): follow the one it samples.
    if (atlasOf() !== atlas) {
      atlas = atlasOf()
      albedo = track(atlas)
    }
    world.setSkyStyle('classic')
    world.setWeather(CLEAR_FRAME)
    world.setTimeOfDay(0.5)
    await frames(80)
    expect(atlasOf()).toBe(atlas)
    expect(world.render.mode).toBe('classic')
    const used = [...atlas.entries.values()].filter(e => e.refs > 0).map(e => e.layer)
    expect(used.length).toBeGreaterThan(0)
    const remastered = used.filter(l => albedo.get(l) === 200)
    expect(remastered, 'tile-array layers of the Classic terrain holding the texture set albedo').toEqual([])
  }, 60_000)
})

// ---- 4. actor textures after the preview is turned off ---------------------------------------------------------------

describe('LG-4: turning the preview off keeps the swapped actor textures (ActorMaps has no way back to retail)', () => {
  it('a character material is back on its retail albedo once the tier is retail again', async () => {
    quiet()
    const { scene } = nullScene()
    const BODY = 'prim/mtrl/char/china/man/chinaman_adventurer_body.ddj'
    const p = 'prim/mtrl/char/china/man/chinaman_adventurer_body'
    const raw = {
      format: 'sro-pbr', version: 1, pipeline: { rev: 'test', upscaler: 'x', createdAt: '2026-09-29T00:00:00Z' },
      sets: {
        [BODY]: {
          key: BODY, size: [512, 512], class: 'skin', alpha: 'none', wrap: [true, true], status: 'auto', hero: true,
          tiers: { 512: { size: [512, 512], bytes: 1, albedo: `${p}/albedo@512.webp`, nx: `${p}/nx@512.webp`, ny: `${p}/ny@512.webp`, ao: `${p}/ao@512.webp`, rough: `${p}/rough@512.webp`, height: `${p}/height@512.webp` } },
        },
      },
    }
    const idx = new PbrMapIndex({ pbr: parsePbrIndex(raw, 'http://mem.test/out-opt/pbr/index.json')! })
    const source: MapTextureSource = {
      texture(url, srgb) {
        const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
        t.name = url
        t.gammaSpace = srgb
        return t
      },
      async pixels() {
        return { width: 2, height: 2, data: new Uint8Array(16).fill(128) as Uint8Array<ArrayBuffer> }
      },
      raw(img) {
        return RawTexture.CreateRGBATexture(img.data, img.width, img.height, scene)
      },
    }
    // three/actor-textures.ts: policy = policyForTier(effectiveGraphics(settings.get()).textureTier).
    let s = normalizeSettings({ graphics: { preset: 'medium', modern: true } })
    const actors = new ActorMaps(scene, source, { index: async () => idx, policy: () => policyForTier(effectiveGraphics(s).textureTier) })
    cleanups.push(() => actors.dispose())
    const c = new AssetContainer(scene)
    const mat = new PBRMaterial('chinaman_body', scene)
    const retail: BaseTexture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    retail.getInternalTexture()!.label = 'chinaman_adventurer_body'
    mat.albedoTexture = retail
    c.materials.push(mat)
    c.textures.push(retail)
    expect(await actors.track(c, 'char/china/chinaman_adventurer', { materials: [{ name: 'chinaman_body', texture: BODY }] })).toBe(1)
    expect(await actors.applied(c).get(mat)!.ready).toBe(true)
    expect(mat.albedoTexture === retail, 'swapped on the preview (control)').toBe(false)
    // Options → preview off (the world switches to Classic live; the ModelLibrary keeps its loaded glbs).
    s = normalizeSettings({ graphics: { preset: 'medium', modern: false } })
    expect(effectiveGraphics(s).textureTier).toBe('retail')
    // three/actor-textures.ts calls refresh on every settings change (settings.onChange); the policy here is a closure.
    actors.refresh()
    await settle(5)
    expect(mat.albedoTexture === retail, 'the character albedo on the Classic path after the preview went off is the retail one').toBe(true)
    expect(mat.bumpTexture === null, 'no normal map on the Classic path after the preview went off').toBe(true)
  })
})

// ---- 5. PERF2 animation LOD with the preview off -------------------------------------------------------------------

describe('LG-5: the animation LOD (PERF2) holds far actors\' poses with the preview off (dc737cc posed every actor every frame)', () => {
  it('a ModelLibrary made with the preview off updates every pose every frame', () => {
    const { scene } = nullScene()
    const s = settings.get()
    expect(effectiveGraphics(s).modern && s.graphics.modern).toBe(false)
    // screens/world.ts buildWorldScene: new ModelLibrary(scene) (animLod default true, ANIM_LOD 30/20/10 Hz by screen size).
    const lib = new ModelLibrary(scene)
    cleanups.push(() => lib.dispose())
    expect(lib.animLod, 'animation LOD on without the new look').toBe(false)
  })
})
