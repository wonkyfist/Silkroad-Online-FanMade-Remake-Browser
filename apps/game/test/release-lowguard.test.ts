/**
 * The release's Low guard (rollout 'on'; the W9 release verify 2, check b): Low (Classic) + the classic sky + weather
 * off is the look from before wave 9, all of it, and the settings of a pre-release Low save (runReleaseMigration writes
 * that combination) render exactly what the same save rendered with the preview off: the frozen noon, a clear weather
 * frame, Low's blocks without the night splats, retail textures, every pose every frame. The verify measured the old
 * gap on the production bundle at a GM-frozen noon: the characters' sun 1.20 → 1.03 and turned, the fog and clear
 * colour greyer, 17.5 % of pixels off by more than 8 levels, and night splats the pre-release Low never had.
 * NullEngine, the game's real settings and world-render's real World and NightLights over the synthetic stream fixture.
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { attachNightLights, loadWorld } from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROOT_URL, WORLD_NAME, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'
import { RENDER_ROLLOUT } from '../src/rollout.ts'
import {
  PREVIEW_OFF_RENDER,
  SETTINGS_KEY,
  SettingsStore,
  classicLook,
  effectiveGraphics,
  newLook,
  normalizeSettings,
  runReleaseMigration,
  settings,
  weatherShown,
  worldQualityFor,
  type Settings,
} from '../src/settings.ts'
import { ModelLibrary } from '../src/three/models.ts'
import { remasterWanted } from '../src/three/remaster-switch.ts'

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

/** The verify's blob: saved before the release on Low, the preview never turned on, sky and weather at their defaults. */
const PRE_RELEASE_LOW = {
  v: 1,
  graphics: { preset: 'low', resolution: 1, sight: 2, scatter: 'auto', remaster: false, firstRun: false, modern: false, sky: 'modern', weather: 'auto' },
  ui: { scale: 1, scaleMode: 'auto', showFps: false },
  controls: { holdToMove: true },
}

function migrated(): SettingsStore {
  const m = new Map<string, string>([[SETTINGS_KEY, JSON.stringify(PRE_RELEASE_LOW)]])
  const store = new SettingsStore({ getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) })
  expect(runReleaseMigration(store, 'on')).toBe(true)
  return store
}

describe('the release keeps a pre-release Low save exactly as it looked', () => {
  it('ships on, and the migrated save renders what the preview-off state rendered, field for field', () => {
    expect(RENDER_ROLLOUT).toBe('on')
    const s = migrated().get()
    expect(s.graphics).toMatchObject({ preset: 'low', sky: 'classic', weather: 'off', releaseMigrated: true })
    expect(classicLook(s)).toBe(true)
    expect(newLook(s, 'on')).toBe(false)
    const release = effectiveGraphics(s, { rollout: 'on' })
    const before = effectiveGraphics(normalizeSettings(PRE_RELEASE_LOW), { rollout: 'preview' })
    expect(release).toEqual(before)
    expect(release).toMatchObject({ modern: false, render: 'classic', sky: 'classic', weather: 'off', weatherShown: false, clock: false, textureTier: 'retail' })
    expect(release.renderQuality).toBe(PREVIEW_OFF_RENDER)
    expect(weatherShown(s, 'on')).toBe(false)
    // The Weather row leaves it: §5.1's Low (the clock and the weather run, the night splats come with Low's block).
    const left = normalizeSettings({ ...s, graphics: { ...s.graphics, weather: 'low' } })
    expect(effectiveGraphics(left, { rollout: 'on' })).toMatchObject({ modern: true, render: 'classic', sky: 'classic', weather: 'low', weatherShown: true, clock: true })
  })

  it('the night lights define no splat in the combination, and the Sky / Weather rows switch them live', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scene = nullScene()
    const fx = makeFixture()
    const guard = migrated().get()
    const e = effectiveGraphics(guard, { rollout: 'on' })
    const world = await loadWorld(scene, {
      baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'low',
      render: e.render, sky: e.sky, weatherLevel: e.weather,
    })
    cleanups.push(() => world.dispose())
    world.setQuality(worldQualityFor(guard, 'low', { rollout: 'on' }))
    // world/features/fx-world.ts attaches the night lights to every world.
    const nl = attachNightLights(world, { focus: () => ({ x: 96, z: -96 }) as never })
    cleanups.push(() => nl.dispose())
    // The night lights take a preset change on their next frame (NightLights.update → applyQuality).
    const defines = () => {
      nl.update()
      return [...new Set(world.terrain.materials.flatMap(m => m.options.defines ?? []))]
    }
    expect(defines(), 'the pre-release Low had no night splat').toEqual([])
    // The player picks a weather level: §5.1's Low, with the night splat on the terrain.
    const low = (g: Partial<Settings['graphics']>) => normalizeSettings({ ...guard, graphics: { ...guard.graphics, ...g } })
    world.setQuality(worldQualityFor(low({ weather: 'low' }), 'low', { rollout: 'on' }))
    expect(defines()).toContain('SRO_NIGHT_SPLAT true')
    // Back to weather off (still the classic sky): the combination again, and the define goes.
    world.setQuality(worldQualityFor(low({ weather: 'off' }), 'low', { rollout: 'on' }))
    expect(defines()).toEqual([])
    // The modern sky alone leaves it too.
    world.setQuality(worldQualityFor(low({ sky: 'modern' }), 'low', { rollout: 'on' }))
    expect(defines()).toContain('SRO_NIGHT_SPLAT true')
  })

  it('every pose every frame and no remaster test switch in the combination; §5.1 Low keeps the animation LOD', () => {
    const scene = nullScene()
    const before = settings.get().graphics
    cleanups.push(() => settings.set({ graphics: { preset: before.preset, sky: before.sky, weather: before.weather } }))
    settings.set({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })
    const lib = new ModelLibrary(scene)
    cleanups.push(() => lib.dispose())
    expect(lib.animLod, 'animation LOD in the Low guard combination').toBe(false)
    expect(remasterWanted(settings.get(), true, 'on', true)).toBe(false)
    settings.set({ graphics: { weather: 'low' } })
    expect(lib.animLod).toBe(true)
    expect(remasterWanted(settings.get(), true, 'on', true)).toBe(true)
  })
})
