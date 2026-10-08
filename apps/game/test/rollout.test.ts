/**
 * GAME (docs/WAVE_PLAN3.md §6.15) and the user's preview rollout (rollout.ts): the effective graphics in both rollout
 * modes (an old save on Medium renders Classic in 'preview' until the player opts in, and moves to the PBR path in
 * 'on'), the weather and clock gates, the Options rows (the preview toggle, Ultra, Advanced, the rebuild question), the
 * graphics link on a fake world (world/graphics.ts: path switches, character lights, the watchdog's preset drop),
 * the weather feature's clear frame without the new look, and the hit flashes joining the night cluster.
 */
import { DirectionalLight, HemisphericLight, Mesh, NullEngine, PBRMaterial, PointLight, Scene, TransformNode, Vector3, type Light } from '@babylonjs/core'
import { QUALITY_PRESETS, RENDER_PRESETS, SKY_PRESETS, CLEAR_FRAME, WEATHER_PRESETS } from '@sro/world-render'
import { WEATHER_PARAMS, type ServerMessage, type WeatherSync } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTownLifeOff } from '../src/settings.ts'
import { MODERN_ONLY_ROWS, optionRows, pageRows, presetLabel, rebuildQuestion, registerOptionRow, type OptionsHost } from '../src/hud/options.ts'
import { perfText } from '../src/hud/perf-overlay.ts'
import { RENDER_ROLLOUT } from '../src/rollout.ts'
import {
  PRESETS,
  PREVIEW_OFF_RENDER,
  SETTINGS_KEY,
  SettingsStore,
  defaultSettings,
  effectiveGraphics,
  normalizeSettings,
  qualityFor,
  runReleaseMigration,
  weatherLevelFor,
  weatherShown,
  worldQualityFor,
  type Settings,
} from '../src/settings.ts'
import { FramePace } from '../src/world/frame-pace.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { weatherFeature } from '../src/world/features/weather.ts'
import { HitLights, setHitLightCluster } from '../src/world/fx/hit-light.ts'
import { PBR_CHARACTER_LIGHTS, WorldGraphics } from '../src/world/graphics.ts'

// Town life is switched off in the game (settings.ts TOWN_LIFE_OFF); these tests cover the system itself.
setTownLifeOff(false)

/** A settings blob saved before wave 9 on Medium (v: 1, no wave-9 keys). */
const OLD_MEDIUM = {
  v: 1,
  graphics: { preset: 'medium', resolution: 1, sight: 2, scatter: 'auto', remaster: false },
  ui: { scale: 1, scaleMode: 'auto', showFps: false },
  controls: { holdToMove: true },
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  setHitLightCluster(null)
  vi.restoreAllMocks()
})

describe('the rollout gate', () => {
  it("ships on (the release, 2026-09-29: \"Default Medium, High optional\")", () => {
    expect(RENDER_ROLLOUT).toBe('on')
    // The preview toggle's setting stays in the blob (ignored in 'on'; the preview is one value away).
    expect(defaultSettings().graphics.modern).toBe(false)
    expect(defaultSettings().graphics.preset).toBe('medium')
  })

  it("on: saved presets keep their preset: Medium (the old default) renders the new look, Low stays Classic, High and Ultra stay", () => {
    const saved = (preset: Settings['graphics']['preset']) => normalizeSettings({ ...OLD_MEDIUM, graphics: { ...OLD_MEDIUM.graphics, preset } })
    const medium = effectiveGraphics(saved('medium'), { rollout: 'on' })
    expect(medium).toMatchObject({ preset: 'medium', renderPreset: 'medium', modern: true, render: 'pbr', sky: 'modern', textureTier: 'remaster' })
    expect(medium.renderQuality).toBe(RENDER_PRESETS.medium)
    const low = effectiveGraphics(saved('low'), { rollout: 'on' })
    expect(low).toMatchObject({ preset: 'low', renderPreset: 'low', render: 'classic', textureTier: 'retail' })
    expect(low.renderQuality).toBe(RENDER_PRESETS.low)
    expect(effectiveGraphics(saved('high'), { rollout: 'on' })).toMatchObject({ preset: 'high', renderPreset: 'high', render: 'pbr', textureTier: '2x' })
    expect(effectiveGraphics(saved('ultra'), { rollout: 'on' })).toMatchObject({ preset: 'ultra', renderPreset: 'ultra', render: 'pbr' })
    // Nothing rewrites a saved preset (the first run is over for every blob saved before).
    for (const preset of PRESETS) expect(saved(preset).graphics).toMatchObject({ preset, firstRun: false })
  })

  it('on: the Low guard state is Low + classic sky + weather off: all of the pre-wave look (W9 release verify 2, b)', () => {
    const s = normalizeSettings({ ...OLD_MEDIUM, graphics: { ...OLD_MEDIUM.graphics, preset: 'low', sky: 'classic', weather: 'off' } })
    const e = effectiveGraphics(s, { rollout: 'on' })
    // The Classic path, the classic sky, retail textures, and also the frozen noon, a clear weather frame and no night
    // splats: the running clock tinted the classic sky and the server's rain greyed it (the verify's pixel diff).
    expect(e).toMatchObject({ render: 'classic', sky: 'classic', weather: 'off', textureTier: 'retail', renderPreset: 'low', modern: false, weatherShown: false, clock: false })
    expect(e.renderQuality).toBe(PREVIEW_OFF_RENDER)
    expect(e.skyQuality).toBe(SKY_PRESETS.low)
    expect(worldQualityFor(s, 'low', { rollout: 'on' })).toMatchObject({ ...QUALITY_PRESETS.low, render: PREVIEW_OFF_RENDER, sky: SKY_PRESETS.low })
    expect(weatherShown(s, 'on')).toBe(false)
    // Exactly what the same save rendered before the release (the preview off), whatever its preset field says.
    expect(e).toEqual(effectiveGraphics(s, { rollout: 'preview' }))
    // Each part of the combination matters: the modern sky or any weather level is §5.1's Low (the clock runs).
    for (const g of [{ sky: 'modern' }, { weather: 'low' }, { weather: 'auto' }] as const) {
      const other = normalizeSettings({ graphics: { preset: 'low', sky: 'classic', weather: 'off', ...g } })
      expect(effectiveGraphics(other, { rollout: 'on' }), JSON.stringify(g)).toMatchObject({ modern: true, render: 'classic', weatherShown: true, clock: true })
      expect(effectiveGraphics(other, { rollout: 'on' }).renderQuality).toBe(RENDER_PRESETS.low)
    }
    // Medium, High and Ultra with the classic sky and weather off stay the new look (PBR, the clock runs).
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      expect(effectiveGraphics(normalizeSettings({ graphics: { preset, sky: 'classic', weather: 'off' } }), { rollout: 'on' })).toMatchObject({ modern: true, render: 'pbr', clock: true, weatherShown: true })
    }
    // `?quality=low` over a saved Medium: the preset the world runs decides.
    expect(effectiveGraphics(normalizeSettings({ graphics: { preset: 'medium', sky: 'classic', weather: 'off' } }), { rollout: 'on', preset: 'low' })).toMatchObject({ modern: false, clock: false })
  })

  it('on: a pre-release Low save with the preview off keeps its look once (classic sky, weather off); nothing else moves', () => {
    const mapStorage = (blob: unknown) => {
      const m = new Map<string, string>([[SETTINGS_KEY, JSON.stringify(blob)]])
      return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), saved: () => JSON.parse(m.get(SETTINGS_KEY)!) }
    }
    const rec = { preset: 'medium', resolution: 1, weather: 'auto', why: 'discrete' }
    // A preview-era blob: the first run recorded its hint, the toggle stayed off, the sky and weather at their defaults.
    const previewLow = { ...OLD_MEDIUM, graphics: { ...OLD_MEDIUM.graphics, preset: 'low', firstRun: false, modern: false, recommended: rec, sky: 'modern', weather: 'auto' } }
    const storage = mapStorage(previewLow)
    const store = new SettingsStore(storage)
    expect(store.get().graphics.releaseMigrated).toBe(false)
    // Before the move, 'on' would give it §5.1's Low: the modern sky and weather low (the verify's finding).
    expect(effectiveGraphics(store.get(), { rollout: 'on' })).toMatchObject({ render: 'classic', sky: 'modern', weather: 'low' })
    // 'preview' moves nothing (and leaves the move for the release).
    expect(runReleaseMigration(store, 'preview')).toBe(false)
    expect(store.get().graphics).toMatchObject({ sky: 'modern', weather: 'auto', releaseMigrated: false })
    expect(runReleaseMigration(store, 'on')).toBe(true)
    expect(store.get().graphics).toMatchObject({ preset: 'low', sky: 'classic', weather: 'off', releaseMigrated: true, firstRun: false, modern: false })
    expect(storage.saved().graphics).toMatchObject({ sky: 'classic', weather: 'off', releaseMigrated: true })
    // It renders the Low guard state, exactly the pre-release image: the Classic path, the classic sky at a frozen noon,
    // a clear weather frame, retail textures, Low's blocks without the night splats.
    const e = effectiveGraphics(store.get(), { rollout: 'on' })
    expect(e).toMatchObject({ render: 'classic', sky: 'classic', weather: 'off', textureTier: 'retail', renderPreset: 'low', modern: false, weatherShown: false, clock: false })
    expect(e.renderQuality).toBe(PREVIEW_OFF_RENDER)
    expect(e.skyQuality).toBe(SKY_PRESETS.low)
    expect(e).toEqual(effectiveGraphics(normalizeSettings(previewLow), { rollout: 'preview' }))
    // Once: the player's own later choice stays, on this page and the next.
    store.set({ graphics: { sky: 'modern' } })
    expect(runReleaseMigration(store, 'on')).toBe(false)
    expect(runReleaseMigration(new SettingsStore(storage), 'on')).toBe(false)
    expect(new SettingsStore(storage).get().graphics).toMatchObject({ sky: 'modern', weather: 'off', releaseMigrated: true })

    // A save from before wave 9 on Low (no wave-9 keys at all) had the pre-wave look too.
    const preWave = new SettingsStore(mapStorage({ ...OLD_MEDIUM, graphics: { ...OLD_MEDIUM.graphics, preset: 'low' } }))
    expect(runReleaseMigration(preWave, 'on')).toBe(true)
    expect(preWave.get().graphics).toMatchObject({ sky: 'classic', weather: 'off' })
    // A Low player who had the preview on already saw §5.1's Low (the modern sky, weather low): kept.
    const optedIn = new SettingsStore(mapStorage({ ...previewLow, graphics: { ...previewLow.graphics, modern: true } }))
    expect(runReleaseMigration(optedIn, 'on')).toBe(false)
    expect(optedIn.get().graphics).toMatchObject({ sky: 'modern', weather: 'auto', releaseMigrated: true })
    expect(effectiveGraphics(optedIn.get(), { rollout: 'on' })).toMatchObject({ sky: 'modern', weather: 'low' })
    // Medium (the user's decision: it moves to PBR), High and Ultra: only the flag.
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      const other = new SettingsStore(mapStorage({ ...previewLow, graphics: { ...previewLow.graphics, preset } }))
      expect(runReleaseMigration(other, 'on')).toBe(false)
      expect(other.get().graphics).toMatchObject({ preset, sky: 'modern', weather: 'auto', releaseMigrated: true })
    }
    expect(effectiveGraphics(normalizeSettings({ ...previewLow, graphics: { ...previewLow.graphics, preset: 'medium', releaseMigrated: true } }), { rollout: 'on' })).toMatchObject({ render: 'pbr', sky: 'modern' })
    // A fresh profile has nothing to keep, even when its first run lands on Low (WebGL1): §5.1's Low.
    const fresh = new SettingsStore(null)
    expect(fresh.get().graphics.releaseMigrated).toBe(true)
    fresh.set({ graphics: { preset: 'low', firstRun: false } })
    expect(runReleaseMigration(fresh, 'on')).toBe(false)
    expect(fresh.get().graphics).toMatchObject({ preset: 'low', sky: 'modern', weather: 'auto' })
  })

  it("preview: an old save on Medium renders exactly the Low guard state until the player opts in", () => {
    const s = normalizeSettings(OLD_MEDIUM)
    const e = effectiveGraphics(s, { rollout: 'preview' })
    expect(e).toMatchObject({ preset: 'medium', renderPreset: 'low', modern: false, render: 'classic', sky: 'classic', weather: 'off', weatherShown: false, clock: false })
    // W9F LG-2: Low's block without the night splats (dc737cc had none).
    expect(e.renderQuality).toBe(PREVIEW_OFF_RENDER)
    expect(e.renderQuality).toEqual({ ...RENDER_PRESETS.low, nightLights: { ...RENDER_PRESETS.low.nightLights, terrainSplat: false, grassSplat: false } })
    expect(e.skyQuality).toBe(SKY_PRESETS.low)
    // The preset's non-render effects stay Medium's (sight range, grass, animated objects); streaming follows world.quality.
    const q = worldQualityFor(s, 'medium', { rollout: 'preview' })
    // Wave 10: the Classic path always draws the retail ground cover, whatever the preset row names.
    expect(q).toMatchObject({ ...QUALITY_PRESETS.medium, grassStyle: 'retail', render: PREVIEW_OFF_RENDER, sky: SKY_PRESETS.low })
    expect(weatherLevelFor(s, null, undefined, 'preview')).toBe('off')
    expect(weatherShown(s, 'preview')).toBe(false)
    // Every preset is Classic without the toggle, High and Ultra too.
    for (const preset of ['low', 'medium', 'high', 'ultra'] as const) expect(effectiveGraphics(normalizeSettings({ ...OLD_MEDIUM, graphics: { preset } }), { rollout: 'preview' }).render).toBe('classic')
  })

  it('preview: the toggle turns the whole new look on, per the preset', () => {
    const s = normalizeSettings({ ...OLD_MEDIUM, graphics: { ...OLD_MEDIUM.graphics, modern: true } })
    const e = effectiveGraphics(s, { rollout: 'preview' })
    expect(e).toMatchObject({ renderPreset: 'medium', modern: true, render: 'pbr', sky: 'modern', weather: 'medium', weatherShown: true, clock: true })
    expect(e.renderQuality).toBe(RENDER_PRESETS.medium)
    expect(e.skyQuality).toBe(SKY_PRESETS.medium)
    // Low with the new look: the Classic material path with the modern sky, the weather and the clock (§5.1).
    const low = effectiveGraphics(normalizeSettings({ graphics: { preset: 'low', modern: true } }), { rollout: 'preview' })
    expect(low).toMatchObject({ render: 'classic', sky: 'modern', weather: 'low', clock: true })
  })

  it("on: the same old save moves to the PBR path, the toggle ignored", () => {
    const s = normalizeSettings(OLD_MEDIUM)
    expect(s.graphics.modern).toBe(false)
    const e = effectiveGraphics(s, { rollout: 'on' })
    expect(e).toMatchObject({ preset: 'medium', modern: true, render: 'pbr', sky: 'modern', weather: 'medium', weatherShown: true, clock: true })
    expect(worldQualityFor(s, 'medium', { rollout: 'on' }).render).toBe(RENDER_PRESETS.medium)
    expect(effectiveGraphics(normalizeSettings({ graphics: { preset: 'high', sky: 'classic' } }), { rollout: 'on' }).sky).toBe('classic')
  })

  it('caps the renderer at Medium on a 16-varying adapter (the preset itself stays)', () => {
    const s = normalizeSettings({ graphics: { preset: 'ultra' } })
    const e = effectiveGraphics(s, { rollout: 'on', gpu: { maxInterStageShaderVariables: 16 } })
    expect(e).toMatchObject({ preset: 'ultra', renderPreset: 'medium', render: 'pbr', weather: 'medium' })
    expect(e.renderQuality).toBe(RENDER_PRESETS.medium)
    expect(effectiveGraphics(s, { rollout: 'on', gpu: { maxInterStageShaderVariables: 28 } }).renderPreset).toBe('ultra')
  })

  it('folds the Advanced rows into the PBR presets only', () => {
    const adv = { shadows: 'off', ao: 'full', reflections: 'always', aa: 'fxaa', lightShafts: 'low', toneMap: 'filmic' } as const
    const high = effectiveGraphics(normalizeSettings({ graphics: { preset: 'high', advanced: adv } }), { rollout: 'on' })
    expect(high.renderQuality).toMatchObject({ shadows: null, ssao: { halfRes: false, samples: 16 }, ssr: 'always', aa: 'fxaa', lightShafts: 'low' })
    expect(high.toneMap).toBe('filmic')
    expect(RENDER_PRESETS.high.shadows).not.toBeNull() // the table itself is untouched
    const medium = effectiveGraphics(normalizeSettings({ graphics: { preset: 'medium', advanced: { shadows: 'ultra' } } }), { rollout: 'on' })
    expect(medium.renderQuality.shadows).toEqual(RENDER_PRESETS.ultra.shadows)
    // Low (Classic) and the preview without the toggle ignore them.
    expect(effectiveGraphics(normalizeSettings({ graphics: { preset: 'low', advanced: adv } }), { rollout: 'on' }).renderQuality).toBe(RENDER_PRESETS.low)
    expect(effectiveGraphics(normalizeSettings({ graphics: { preset: 'high', advanced: adv } }), { rollout: 'preview' }).renderQuality).toBe(PREVIEW_OFF_RENDER)
  })

  it('qualityFor keeps only the non-render part (the render blocks come from worldQualityFor)', () => {
    const s = normalizeSettings({ graphics: { preset: 'high', sight: 0 } })
    expect(qualityFor(s)).not.toHaveProperty('render')
    expect(worldQualityFor(s, 'high', { rollout: 'on' })).toMatchObject({ drawDistance: qualityFor(s).drawDistance, render: RENDER_PRESETS.high, sky: SKY_PRESETS.high })
  })
})

describe('Options rows for the new look', () => {
  const host: OptionsHost = {
    engine: 'WebGPU',
    keyHelp() {},
    toast() {},
    menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
  }
  const ids = (s: Settings, rollout: 'preview' | 'on', tab: 'graphics' | 'interface' = 'graphics') => pageRows(host, tab, s, rollout).map(r => r.id)

  it('preview: the toggle is there; the sky, Advanced and clock rows come with it', () => {
    const off = normalizeSettings(OLD_MEDIUM)
    // TX-R: the Textures row (which replaced the remaster test switch) comes with the new look.
    expect(ids(off, 'preview')).toEqual(['graphics.modern', 'graphics.preset', 'graphics.resolution', 'graphics.sight', 'graphics.scatter', 'fullscreen', 'engine'])
    expect(ids(off, 'preview', 'interface')).not.toContain('ui.clock')
    const on = normalizeSettings({ ...OLD_MEDIUM, graphics: { ...OLD_MEDIUM.graphics, modern: true, recommended: { preset: 'high', resolution: 1, weather: 'auto', why: 'discrete' } } })
    expect(ids(on, 'preview')).toEqual([
      'graphics.modern', 'graphics.recommended', 'graphics.preset', 'graphics.resolution', 'graphics.sight', 'graphics.scatter', 'graphics.wildlife', 'graphics.townLife', 'graphics.trees', 'graphics.hairCloth', 'graphics.bodyPhysics', 'graphics.textures', 'graphics.sky',
      'graphics.advanced', 'graphics.advanced.shadows', 'graphics.advanced.reflections', 'graphics.advanced.aa', 'graphics.advanced.toneMap',
      'graphics.bloom', 'graphics.advanced.batching', 'graphics.advanced.lightShafts', 'fullscreen', 'engine',
    ])
    expect(ids(on, 'preview', 'interface')).toContain('ui.clock')
    const hint = pageRows(host, 'graphics', on, 'preview').find(r => r.id === 'graphics.recommended')
    expect(hint?.kind === 'info' ? hint.text() : '').toBe('Recommended for this computer: High (a dedicated graphics card)')
    // Low with the new look: the sky row stays, Advanced goes (nothing PBR to tune).
    const low = normalizeSettings({ graphics: { preset: 'low', modern: true } })
    expect(ids(low, 'preview')).toContain('graphics.sky')
    expect(ids(low, 'preview')).not.toContain('graphics.advanced.shadows')
    expect(ids(low, 'preview')).not.toContain('graphics.bloom') // Low / Classic has no bloom
  })

  it("on: no toggle; the preset row lists Low (Classic) to Ultra", () => {
    const s = normalizeSettings(OLD_MEDIUM)
    expect(ids(s, 'on')[0]).toBe('graphics.preset')
    expect(ids(s, 'on')).toContain('graphics.advanced.aa')
    const preset = optionRows(host, s, 'on').graphics.find(r => r.id === 'graphics.preset')
    expect(preset?.kind === 'choice' ? preset.choices.map(c => [c.value, c.label]) : []).toEqual([['low', 'Low (Classic)'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']])
    expect(presetLabel('low', s, 'preview')).toBe('Low')
  })

  it("on: the Low guard's combination says what it is, keeps the rows that leave it, and hides those that do nothing in it", () => {
    const guard = normalizeSettings({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })
    const offs = [
      registerOptionRow('graphics', { id: 'graphics.weather', kind: 'toggle', label: 'options.weather', get: () => true, patch: () => ({}) }),
    ]
    cleanups.push(() => offs.forEach(o => o()))
    const rows = ids(guard, 'on')
    expect(rows).toEqual(['graphics.preset', 'graphics.resolution', 'graphics.sight', 'graphics.scatter', 'graphics.sky', 'graphics.classicLook', 'fullscreen', 'engine', 'graphics.weather'])
    const info = pageRows(host, 'graphics', guard, 'on').find(r => r.id === 'graphics.classicLook')
    expect(info?.kind === 'info' ? info.text() : '').toMatch(/original look: always noon, always clear/)
    // The Textures row (retail only) and the game clock (a frozen noon) mean nothing there.
    expect(rows).not.toContain('graphics.textures')
    expect(ids(guard, 'on', 'interface')).not.toContain('ui.clock')
    // §5.1's Low (the modern sky, or any weather level): no note, and the rows are back.
    for (const g of [{ sky: 'modern' }, { weather: 'low' }] as const) {
      const low = normalizeSettings({ graphics: { preset: 'low', sky: 'classic', weather: 'off', ...g } })
      expect(ids(low, 'on')).not.toContain('graphics.classicLook')
      expect(ids(low, 'on')).toContain('graphics.textures')
      expect(ids(low, 'on', 'interface')).toContain('ui.clock')
    }
    // 'preview' with the toggle off shows neither the note nor the sky row (the whole page is the old one).
    expect(ids(guard, 'preview')).not.toContain('graphics.classicLook')
    // Leaving it with the sky or the weather keeps the Classic path: no rebuild question.
    expect(rebuildQuestion(guard, { graphics: { sky: 'modern' } }, 'on')).toBeNull()
    expect(rebuildQuestion(guard, { graphics: { weather: 'low' } }, 'on')).toBeNull()
  })

  it("the weather feature's rows show only with the new look", () => {
    const offs = [
      registerOptionRow('graphics', { id: 'graphics.weather', kind: 'toggle', label: 'options.weather', get: () => true, patch: () => ({}) }),
      registerOptionRow('interface', { id: 'ui.reduceFlashing', kind: 'toggle', label: 'options.reduceFlashing', get: () => true, patch: () => ({}) }),
    ]
    cleanups.push(() => offs.forEach(o => o()))
    expect([...MODERN_ONLY_ROWS]).toEqual(['graphics.weather', 'ui.reduceFlashing'])
    expect(ids(normalizeSettings(OLD_MEDIUM), 'preview')).not.toContain('graphics.weather')
    expect(ids(normalizeSettings(OLD_MEDIUM), 'on')).toContain('graphics.weather')
    expect(ids(normalizeSettings(OLD_MEDIUM), 'on', 'interface')).toContain('ui.reduceFlashing')
  })

  it('asks before a change that switches the material path, and only then', () => {
    const s = normalizeSettings(OLD_MEDIUM)
    expect(rebuildQuestion(s, { graphics: { modern: true } }, 'preview')).toBe('options.rebuild.confirm')
    expect(rebuildQuestion(s, { graphics: { preset: 'high' } }, 'preview')).toBeNull() // Classic either way
    expect(rebuildQuestion(normalizeSettings({ graphics: { preset: 'low' } }), { graphics: { modern: true } }, 'preview')).toBeNull()
    expect(rebuildQuestion(s, { graphics: { preset: 'low' } }, 'on')).toBe('options.rebuild.confirm')
    expect(rebuildQuestion(s, { graphics: { preset: 'ultra' } }, 'on')).toBeNull()
    const preset = optionRows(host, s, 'on').graphics.find(r => r.id === 'graphics.preset')
    expect(preset?.kind === 'choice' ? preset.confirm?.(s, preset.patch('low')) : 'missing').toBe('options.rebuild.confirm')
  })
})

// ---- the graphics link on a fake world --------------------------------------------------------------------

function fakeSky() {
  return {
    keyLight: { dir: new Vector3(0.3, 0.8, 0.2).normalize(), color: [0.3, 0.29, 0.28] as [number, number, number], intensity: 1 },
    ambient: { sky: [0.5, 0.5, 0.55] as [number, number, number], horizon: [0.6, 0.6, 0.6] as [number, number, number], ground: [0.1, 0.1, 0.1] as [number, number, number] },
    sh: null,
  }
}

function fakeWorld(mode: 'classic' | 'pbr', streamed = true, quality: 'low' | 'medium' | 'high' | 'ultra' = 'medium') {
  const calls: string[] = []
  const characters = new Set<unknown>()
  const w = {
    quality, // the preset the world loaded with (the settings' own, or `?quality=`)
    calls,
    characters,
    render: {
      mode,
      post: null,
      activeCamera: null,
      gpu: { features: [] as string[], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false, maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16 },
      attachCamera: vi.fn(),
      addCharacter: (m: unknown) => characters.add(m),
      removeCharacter: (m: unknown) => characters.delete(m),
    },
    stream: streamed ? { setSettings: vi.fn() } : null,
    materials: { pbr: { decorateCharacterMaterial: vi.fn() } },
    skyStyle: 'classic' as 'classic' | 'modern',
    skyState: fakeSky(),
    weatherState: CLEAR_FRAME,
    weather: { stats: () => ({ level: 'off', rain: 0, wet: 0, puddle: 0, streaks: 0, shelter: false, shelterRenders: 0, wetMaps: 0, wetMapMs: 0 }) },
    objects: { setRangeScale: vi.fn(), setAnimatedVisible: vi.fn() },
    water: { setVisible: vi.fn() },
    scatter: { setLevel: vi.fn() },
    setQuality: vi.fn((q: { render?: unknown }) => calls.push(`quality:${q.render === RENDER_PRESETS.low || q.render === PREVIEW_OFF_RENDER ? 'low' : 'other'}`)),
    setRenderMode: vi.fn((m: 'classic' | 'pbr') => {
      calls.push(`path:${m}`)
      w.render.mode = m
    }),
    setSkyStyle: vi.fn((s: 'classic' | 'modern') => {
      w.skyStyle = s
    }),
    isolateLights: vi.fn(),
  }
  return w
}

function graphicsOn(world: ReturnType<typeof fakeWorld>, store: SettingsStore, rollout: 'preview' | 'on', extra: { remaster?: boolean; now?: () => number; say?: (t: string) => void; engine?: boolean; pace?: FramePace } = {}) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  hemi.intensity = 0.7
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5).normalize(), scene)
  sun.intensity = 1.2
  const paths: string[] = []
  const g = new WorldGraphics({
    world: world as never,
    camera: {} as never,
    lights: { hemi, sun },
    store,
    rollout,
    onPath: p => paths.push(p),
    remasterBoost: () => (extra.remaster ? { key: 1.25, fill: 0.7 } : null),
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.say ? { say: extra.say } : {}),
    ...(extra.engine ? { engine } : {}),
    ...(extra.pace ? { pace: extra.pace } : {}),
  })
  cleanups.push(() => {
    g.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { g, hemi, sun, paths, scene, engine }
}

describe('WorldGraphics (world/graphics.ts)', () => {
  it('preview: an old Medium save stays Classic with HEAD\'s character lights until the toggle, then rebuilds as PBR', () => {
    const store = new SettingsStore(null)
    store.set(OLD_MEDIUM as never)
    store.set({ graphics: { modern: false } })
    const world = fakeWorld('classic')
    const { g, hemi, sun, paths } = graphicsOn(world, store, 'preview')
    expect(world.setRenderMode).not.toHaveBeenCalled()
    expect(world.calls).toEqual(['quality:low'])
    expect(world.setSkyStyle).toHaveBeenLastCalledWith('classic')
    expect(paths).toEqual(['classic'])
    expect([hemi.isEnabled(), sun.isEnabled()]).toEqual([true, true])
    const dir = sun.direction.clone()
    g.frame(16, true)
    expect([sun.intensity, hemi.intensity]).toEqual([1.2, 0.7])
    expect(sun.direction.equals(dir)).toBe(true)
    // A sight change touches only the non-render part (no post rebuild).
    world.calls.length = 0
    store.set({ graphics: { sight: 3 } })
    expect(world.calls).toEqual([])
    expect(world.objects.setRangeScale).toHaveBeenLastCalledWith(QUALITY_PRESETS.medium.drawDistance * 1.4)
    // The toggle: the preset's blocks first, then the path (the parts are built with them), the modern sky.
    store.set({ graphics: { modern: true } })
    expect(world.calls).toEqual(['quality:other', 'path:pbr'])
    expect(world.setSkyStyle).toHaveBeenLastCalledWith('modern')
    expect(paths).toEqual(['classic', 'pbr'])
    expect([hemi.isEnabled(), sun.isEnabled()]).toEqual([false, false])
    expect(g.effective.modern).toBe(true)
    // And back: the path first, then Low's blocks; the lights come back.
    world.calls.length = 0
    store.set({ graphics: { modern: false } })
    expect(world.calls).toEqual(['path:classic', 'quality:low'])
    expect([hemi.isEnabled(), sun.isEnabled()]).toEqual([true, true])
    expect(paths).toEqual(['classic', 'pbr', 'classic'])
  })

  it("on: an old Medium save loaded Classic moves to the PBR path", () => {
    const store = new SettingsStore(null)
    store.set(OLD_MEDIUM as never)
    const world = fakeWorld('classic')
    const { g } = graphicsOn(world, store, 'on')
    expect(world.calls).toEqual(['quality:other', 'path:pbr'])
    expect(g.path).toBe('pbr')
  })

  it('Medium -> Low hides the animated objects before the Classic rebuild (the regions then load the blocking trees as static variants)', () => {
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'medium', firstRun: false } })
    const world = fakeWorld('pbr')
    world.objects.setAnimatedVisible = vi.fn((on: boolean) => world.calls.push(`animated:${on}`))
    graphicsOn(world, store, 'on')
    world.calls.length = 0
    store.set({ graphics: { preset: 'low' } })
    expect(world.calls.slice(0, 2)).toEqual(['animated:false', 'path:classic'])
  })

  it('a whole-world load keeps its path and tells the player once', () => {
    const store = new SettingsStore(null)
    const said: string[] = []
    const world = fakeWorld('classic', false)
    graphicsOn(world, store, 'preview', { say: t => said.push(t) })
    store.set({ graphics: { modern: true } })
    store.set({ graphics: { preset: 'high' } })
    expect(world.setRenderMode).not.toHaveBeenCalled()
    expect(said).toEqual(['The new graphics apply the next time you enter the world.'])
  })

  it('Classic with the new look: the character lights follow the sky; without it they are restored', () => {
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'low', modern: true } })
    const world = fakeWorld('classic', true, 'low')
    const { g, sun, hemi } = graphicsOn(world, store, 'preview')
    const dir = sun.direction.clone()
    g.frame(16, true)
    expect(sun.direction.equals(dir)).toBe(false) // turned with the key light
    expect(sun.intensity).not.toBe(1.2)
    store.set({ graphics: { modern: false } })
    g.frame(16, true)
    expect(sun.direction.equals(dir)).toBe(true)
    expect([sun.intensity, hemi.intensity]).toEqual([1.2, 0.7])
    // The remaster test boost is kept (HEAD: key × 1.25, fill × 0.7).
    const r = graphicsOn(fakeWorld('classic'), new SettingsStore(null), 'preview', { remaster: true })
    r.g.frame(16, true)
    expect(r.sun.intensity).toBeCloseTo(1.5, 9)
    expect(r.hemi.intensity).toBeCloseTo(0.49, 9)
  })

  it("on: the Low guard's combination gives HEAD's character lights and Low's blocks without the night splats", () => {
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'low', sky: 'classic', weather: 'off', firstRun: false } })
    const world = fakeWorld('classic', true, 'low')
    // A storm frame in the world state (the server's weather): the combination must not dim the characters with it.
    world.weatherState = { ...CLEAR_FRAME, sun: WEATHER_PARAMS.storm.sun, cloudDark: WEATHER_PARAMS.storm.cloudDark }
    const { g, hemi, sun } = graphicsOn(world, store, 'on')
    expect(world.setRenderMode).not.toHaveBeenCalled()
    expect(world.setQuality.mock.calls.at(-1)![0].render).toBe(PREVIEW_OFF_RENDER)
    expect(g.effective).toMatchObject({ modern: false, clock: false, weatherShown: false })
    const dir = sun.direction.clone()
    g.frame(16, true)
    expect([sun.intensity, hemi.intensity]).toEqual([1.2, 0.7])
    expect(sun.direction.equals(dir)).toBe(true)
    // The Weather row: §5.1's Low (Low's block with its splats, the lights through the sky state); no path switch.
    store.set({ graphics: { weather: 'low' } })
    expect(world.setQuality.mock.calls.at(-1)![0].render).toBe(RENDER_PRESETS.low)
    g.frame(16, true)
    expect(sun.direction.equals(dir)).toBe(false)
    // And back: HEAD's lights again.
    store.set({ graphics: { weather: 'off' } })
    expect(world.setQuality.mock.calls.at(-1)![0].render).toBe(PREVIEW_OFF_RENDER)
    g.frame(16, true)
    expect(sun.direction.equals(dir)).toBe(true)
    expect([sun.intensity, hemi.intensity]).toEqual([1.2, 0.7])
    expect(world.setRenderMode).not.toHaveBeenCalled()
  })

  it('the classic sky with the new look scales the Classic characters by the weather', () => {
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'low', modern: true, sky: 'classic' } })
    const world = fakeWorld('classic', true, 'low')
    world.weatherState = { ...CLEAR_FRAME, sun: WEATHER_PARAMS.storm.sun, cloudDark: WEATHER_PARAMS.storm.cloudDark }
    const { g, sun } = graphicsOn(world, store, 'preview')
    g.frame(16, true)
    const clear = graphicsOn(fakeWorld('classic', true, 'low'), store, 'preview')
    clear.g.frame(16, true)
    expect(sun.intensity).toBeLessThan(clear.sun.intensity * 0.5)
  })

  it('character materials: decorated on every path, 6 lights on PBR and their own count back on Classic', () => {
    const store = new SettingsStore(null)
    const world = fakeWorld('classic')
    const { g, scene } = graphicsOn(world, store, 'preview')
    const mat = new PBRMaterial('body', scene)
    const before = mat.maxSimultaneousLights
    g.decorate(mat)
    expect(world.materials.pbr.decorateCharacterMaterial).toHaveBeenCalledWith(mat)
    expect(mat.maxSimultaneousLights).toBe(before)
    store.set({ graphics: { modern: true } })
    expect(mat.maxSimultaneousLights).toBe(PBR_CHARACTER_LIGHTS)
    store.set({ graphics: { modern: false } })
    expect(mat.maxSimultaneousLights).toBe(before)
  })

  it('hands character meshes to the renderer and takes them back', () => {
    const store = new SettingsStore(null)
    const world = fakeWorld('pbr')
    const { g, scene } = graphicsOn(world, store, 'on')
    expect(g.attachment({ kind: 'item' } as never)).toBeNull()
    const root = new TransformNode('actor', scene)
    const body = new Mesh('__root__', scene)
    body.parent = root
    new Mesh('body_leaf', scene).parent = body
    const view = { kind: 'player', actor: { root } }
    const a = g.attachment(view as never)!
    a.loaded!()
    expect([...world.characters]).toEqual([body]) // the part's root: the renderer walks its children
    const helmet = new Mesh('__root__', scene) // an equipment change adds a part
    helmet.parent = root
    a.update!(0, 0)
    expect([...world.characters]).toEqual([body, helmet])
    a.dispose()
    expect(world.characters.size).toBe(0)
  })

  it('the watchdog: one preset down when frames are slow with the new look, never without it', () => {
    let now = 0
    const said: string[] = []
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'high' } })
    const world = fakeWorld('classic', true, 'high')
    const { g } = graphicsOn(world, store, 'preview', { now: () => now, say: t => said.push(t) })
    for (; now < 40_000; now += 50) g.frame(50, true) // 20 fps, Classic look: nothing
    expect(store.get().graphics.preset).toBe('high')
    store.set({ graphics: { modern: true } })
    for (const start = now; now < start + 40_000; now += 50) g.frame(50, true)
    expect(store.get().graphics.preset).toBe('medium')
    expect(said.at(-1)).toMatch(/went down to Medium/)
  })

  it('the watchdog (V-12): a display capped at 30 Hz never drops High; a really slow game on it still does', () => {
    let now = 0
    const said: string[] = []
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'high', modern: true } })
    const world = fakeWorld('pbr', true, 'high')
    // the page's pace: the login and character screens ran at the display's 30 Hz
    const pace = new FramePace()
    for (let t = 0; t < 20_000; t += 1000 / 30) {
      pace.begin(t)
      pace.end(t + 5)
    }
    const { g } = graphicsOn(world, store, 'preview', { now: () => now, say: t => said.push(t), pace })
    // steady 31–35 ms frames (vsync), for two minutes
    for (let i = 0; now < 120_000; i++) {
      const f = 33 + (i % 5) - 2
      now += f
      g.frame(f, true)
    }
    expect(store.get().graphics.preset).toBe('high')
    expect(said).toEqual([])
    expect(g.watchdog.hold).toBe('pace')
    // 20 fps on that screen is slowness
    for (const start = now; now < start + 40_000; now += 50) g.frame(50, true)
    expect(store.get().graphics.preset).toBe('medium')
  })

  it('the watchdog (W9A perf): never drops to Low (Classic) on its own, and waits while the world streams or compiles', () => {
    let now = 0
    const said: string[] = []
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'medium', modern: true } })
    const world = fakeWorld('pbr', true, 'medium')
    const stream = world.stream as { busy?: boolean }
    const { g, engine } = graphicsOn(world, store, 'preview', { now: () => now, say: t => said.push(t), engine: true })
    for (; now < 60_000; now += 50) g.frame(50, true) // 20 fps on Medium: the floor
    expect(store.get().graphics.preset).toBe('medium')
    expect(said).toEqual([])
    // High while the world streams, then while shaders compile: no judgement.
    store.set({ graphics: { preset: 'high' } })
    stream.busy = true
    for (const start = now; now < start + 40_000; now += 50) g.frame(50, true)
    stream.busy = false
    for (const start = now; now < start + 40_000; now += 50) {
      engine.onAfterShaderCompilationObservable.notifyObservers(engine)
      g.frame(50, true)
    }
    expect(store.get().graphics.preset).toBe('high')
    // Settled: 3 s, then a (nearly) full 10 s window of slow frames.
    for (const start = now; now < start + 11_000; now += 50) g.frame(50, true)
    expect(store.get().graphics.preset).toBe('high')
    for (const start = now; now < start + 4_000; now += 50) g.frame(50, true)
    expect(store.get().graphics.preset).toBe('medium')
    expect(said).toHaveLength(1)
  })
})

// ---- the weather feature without the new look ---------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 28, 12)
const storm: WeatherSync = { start: T0, dur: 0, from: 'storm', to: 'storm', intensity: 1, until: T0 + 900_000, windDir: 0.35, windMs: WEATHER_PARAMS.storm.windMs, wet: 0, puddle: 0, at: T0, seed: 7 }

describe('weather through the rollout gate', () => {
  it('without the new look the world gets a clear frame, level off, and no sound', () => {
    const world = { render: { mode: 'classic', gpu: {} }, skyStyle: 'classic', weather: { shelter: null }, setWeather: vi.fn(), setWeatherLevel: vi.fn() }
    const audio = { update: vi.fn(), thunder: vi.fn(), prepareThunder: vi.fn(), stop: vi.fn() }
    const ctx = {
      app: { audio: { weather: audio } },
      scene: { getLightByName: () => null },
      camera: { target: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 5, z: -10 } },
      serverNow: () => T0 + 2000,
      selfId: () => null,
      view: () => undefined,
      world: () => ({ world }),
    } as unknown as WorldFeatureContext
    const store = new SettingsStore(null)
    const f = weatherFeature(ctx, { store, search: '', zoneAt: () => null })
    f.onMessage!({ t: 'worldEnter', world: { weather: storm } } as unknown as ServerMessage)
    f.onMessage!({ t: 'lightning', at: T0, distM: 343, bearing: 0 } as ServerMessage)
    f.onFrame!(T0 + 2000, 0.016)
    if (RENDER_ROLLOUT === 'preview') {
      expect(world.setWeatherLevel).toHaveBeenLastCalledWith('off')
      expect(world.setWeather).toHaveBeenLastCalledWith(CLEAR_FRAME)
      expect(audio.update).toHaveBeenLastCalledWith(CLEAR_FRAME, false)
      expect(audio.thunder).not.toHaveBeenCalled()
    }
    // Opting in shows the storm the server has been running all along.
    store.set({ graphics: { modern: true } })
    f.onFrame!(T0 + 2100, 0.016)
    expect(world.setWeatherLevel).toHaveBeenLastCalledWith('medium')
    expect(world.setWeather.mock.calls.at(-1)![0].rain).toBe(1)
    expect(WEATHER_PRESETS.medium.wet).toBe(true)
    f.dispose!()
  })
})

describe("weather in the release's Low guard combination", () => {
  it('on: Low + classic sky + weather off gets a clear frame and no sound; a weather level brings the storm back', () => {
    const world = { render: { mode: 'classic', gpu: {} }, skyStyle: 'classic', weather: { shelter: null }, setWeather: vi.fn(), setWeatherLevel: vi.fn() }
    const audio = { update: vi.fn(), thunder: vi.fn(), prepareThunder: vi.fn(), stop: vi.fn() }
    const ctx = {
      app: { audio: { weather: audio } },
      scene: { getLightByName: () => null },
      camera: { target: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 5, z: -10 } },
      serverNow: () => T0 + 2000,
      selfId: () => null,
      view: () => undefined,
      world: () => ({ world }),
    } as unknown as WorldFeatureContext
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })
    expect(RENDER_ROLLOUT).toBe('on')
    const f = weatherFeature(ctx, { store, search: '', zoneAt: () => null })
    f.onMessage!({ t: 'worldEnter', world: { weather: storm } } as unknown as ServerMessage)
    f.onMessage!({ t: 'lightning', at: T0, distM: 343, bearing: 0 } as ServerMessage)
    f.onFrame!(T0 + 2000, 0.016)
    expect(world.setWeatherLevel).toHaveBeenLastCalledWith('off')
    expect(world.setWeather).toHaveBeenLastCalledWith(CLEAR_FRAME)
    expect(audio.update).toHaveBeenLastCalledWith(CLEAR_FRAME, false)
    expect(audio.thunder).not.toHaveBeenCalled()
    expect(audio.prepareThunder).not.toHaveBeenCalled()
    store.set({ graphics: { weather: 'low' } })
    f.onFrame!(T0 + 2100, 0.016)
    expect(world.setWeatherLevel).toHaveBeenLastCalledWith('low')
    expect(world.setWeather.mock.calls.at(-1)![0].rain).toBe(1)
    f.dispose!()
  })
})

// ---- hit flashes and the night cluster -----------------------------------------------------------------------

describe('hit flashes join the night cluster (D12)', () => {
  it('joins through NightLights.addDynamicLight when there is a cluster, and stays a scene light otherwise', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    let now = 0
    const lights = new HitLights(scene, () => now)
    const joined: Light[] = []
    let hasCluster = false
    setHitLightCluster({
      host: { scene },
      addDynamicLight: l => {
        if (!hasCluster) return false
        scene.removeLight(l) // what ClusteredLightContainer.addLight does
        joined.push(l)
        return true
      },
    })
    lights.update()
    expect(lights.clustered).toBe(0)
    hasCluster = true
    now += 500
    lights.update() // rate-limited: a second has not passed
    expect(lights.clustered).toBe(0)
    now += 600
    lights.update()
    expect(lights.clustered).toBe(2)
    expect(joined.every(l => l instanceof PointLight)).toBe(true)
    // Another scene's cluster is not ours.
    const other = new Scene(engine)
    const theirs = new HitLights(other, () => now)
    theirs.update()
    expect(theirs.clustered).toBe(0)
    theirs.dispose()
    lights.dispose()
  })
})

// ---- the perf line ---------------------------------------------------------------------------------------------

describe('perf overlay (wave 9 line)', () => {
  it('adds the path, the preset, the GPU time and the weather under the stats line', () => {
    const text = perfText({ engine: 'WebGPU', fps: 60, ping: 20, players: 2, draws: 300, mock: false, render: { mode: 'pbr', preset: 'High' }, gpuMs: 3.456, weather: { level: 'high', rain: 1, wet: 0.5 } })
    const [first, second] = text.split('\n')
    expect(first).toContain('300 draws')
    expect(second).toBe('PBR High  |  GPU 3.46 ms  |  weather high: rain 1.00, wet 0.50')
    expect(perfText({ engine: 'WebGL2', fps: 30, ping: null, players: 1, draws: 1, mock: false, render: { mode: 'classic', preset: 'Low' }, gpuMs: null, weather: { level: 'off', rain: 0, wet: 0 } }).split('\n')[1]).toBe('Classic Low')
  })
})
