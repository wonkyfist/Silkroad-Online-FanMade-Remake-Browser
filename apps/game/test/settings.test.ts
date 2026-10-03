/**
 * Wave-9 settings (docs/WAVE_PLAN3.md §4.3, D5, D6): the Ultra preset, graphics.sky / weather / advanced / firstRun,
 * ui.reduceFlashing / clock, and how old saved settings normalise (a saved preset is never a first run). GAME (§6.15):
 * the first-run preset per adapter fixture (and the preview rollout's record-only mode), the new graphics.modern /
 * recommended fields, and the frame-time watchdog.
 */
import { QUALITY_PRESETS } from '@sro/world-render'
import { describe, expect, it } from 'vitest'
import {
  ADVANCED_CHOICES,
  PRESETS,
  TOWN_LIFE_SETTINGS,
  TREES_SETTINGS,
  WILDLIFE_SETTINGS,
  effectiveGraphics,
  townLifeFor,
  grassQualityFor,
  presetGrassStyle,
  worldQualityFor,
  SKY_SETTINGS,
  SettingsStore,
  TONE_MAPS,
  WEATHER_SETTINGS,
  defaultSettings,
  normalizeSettings,
  qualityFor,
  FrameWatchdog,
  WATCHDOG,
  WATCHDOG_FLOOR,
  isAppleGpu,
  isAppleProGpu,
  isIntegratedGpu,
  lowerPreset,
  recommendGraphics,
  runFirstRun,
  type DeviceHint,
} from '../src/settings.ts'
import { FX_BUDGETS } from '../src/world/fx/quality.ts'
import { optionRows, pageRows, type OptionsHost } from '../src/hud/options.ts'
import { t } from '../src/i18n/index.ts'

/** A settings blob as saved before wave 9 (v: 1, no wave-9 keys). */
const OLD = {
  v: 1,
  graphics: { preset: 'high', resolution: 0.75, sight: 1, scatter: 'auto', remaster: false },
  ui: { scale: 1, scaleMode: 'auto', names: { players: true, npcs: true, items: 'always' }, showFps: false, damageNumbers: true, expInChat: false, minimapZoom: 2, helpHintSessions: 3 },
  controls: { holdToMove: true, cameraSpeed: 1, invertY: false, cameraMode: 'free', nearestTargetKey: true, cameraShake: true },
}

describe('wave-9 graphics settings', () => {
  it('Ultra is a preset with High\'s world settings and effect budget', () => {
    expect(PRESETS).toEqual(['low', 'medium', 'high', 'ultra'])
    expect(normalizeSettings({ graphics: { preset: 'ultra' } }).graphics.preset).toBe('ultra')
    expect(qualityFor(normalizeSettings({ graphics: { preset: 'ultra' } }))).toEqual(QUALITY_PRESETS.high)
    expect(FX_BUDGETS.ultra).toEqual(FX_BUDGETS.high)
  })

  it('defaults: modern sky, weather auto, every Advanced row auto with Neutral tone mapping, a first run', () => {
    const d = defaultSettings()
    expect(d.graphics.sky).toBe('modern')
    expect(d.graphics.weather).toBe('auto')
    // Wave 10 (W10-G): World batching on by default.
    expect(d.graphics.advanced).toEqual({ shadows: 'auto', ao: 'auto', reflections: 'auto', aa: 'auto', toneMap: 'neutral', lightShafts: 'auto', batching: 'on' })
    expect(d.graphics.firstRun).toBe(true)
    expect(d.ui.reduceFlashing).toBe(false)
    expect(d.ui.clock).toBe(true)
    expect(normalizeSettings(undefined)).toEqual(d)
    expect(normalizeSettings({})).toEqual(d)
  })

  it('old saved settings keep their values, gain the defaults, and are not a first run', () => {
    const s = normalizeSettings(OLD)
    expect(s.graphics.preset).toBe('high')
    expect(s.graphics.resolution).toBe(0.75)
    expect(s.ui.helpHintSessions).toBe(3)
    expect(s.graphics.firstRun).toBe(false)
    expect(s.graphics.sky).toBe('modern')
    expect(s.graphics.weather).toBe('auto')
    expect(s.graphics.advanced).toEqual(defaultSettings().graphics.advanced)
    expect([s.ui.reduceFlashing, s.ui.clock]).toEqual([false, true])
  })

  it('accepts every listed value and rejects junk', () => {
    for (const sky of SKY_SETTINGS) expect(normalizeSettings({ graphics: { sky } }).graphics.sky).toBe(sky)
    for (const weather of WEATHER_SETTINGS) expect(normalizeSettings({ graphics: { weather } }).graphics.weather).toBe(weather)
    for (const toneMap of TONE_MAPS) expect(normalizeSettings({ graphics: { advanced: { toneMap } } }).graphics.advanced.toneMap).toBe(toneMap)
    for (const [key, list] of Object.entries(ADVANCED_CHOICES)) {
      for (const v of list) expect(normalizeSettings({ graphics: { advanced: { [key]: v } } }).graphics.advanced[key as keyof typeof ADVANCED_CHOICES]).toBe(v)
    }
    const bad = normalizeSettings({
      graphics: { sky: 'retro', weather: 'monsoon', advanced: { shadows: 'epic', ao: 2, reflections: null, aa: 'ssaa', toneMap: 'aces', lightShafts: 'yes' }, firstRun: 'no' },
      ui: { reduceFlashing: 1, clock: 'off' },
    })
    expect(bad.graphics.sky).toBe('modern')
    expect(bad.graphics.weather).toBe('auto')
    expect(bad.graphics.advanced).toEqual(defaultSettings().graphics.advanced)
    expect(bad.graphics.firstRun).toBe(true)
    expect([bad.ui.reduceFlashing, bad.ui.clock]).toEqual([false, true])
    expect(normalizeSettings({ graphics: { advanced: 'all' } }).graphics.advanced).toEqual(defaultSettings().graphics.advanced)
  })

  it('round-trips through the store', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const a = new SettingsStore(storage)
    a.set({ graphics: { preset: 'ultra', sky: 'classic', weather: 'off', advanced: { aa: 'taa', toneMap: 'filmic' }, firstRun: false }, ui: { reduceFlashing: true, clock: false } })
    const b = new SettingsStore(storage).get()
    expect(b.graphics).toMatchObject({ preset: 'ultra', sky: 'classic', weather: 'off', firstRun: false })
    expect(b.graphics.advanced).toMatchObject({ aa: 'taa', toneMap: 'filmic', shadows: 'auto' })
    expect([b.ui.reduceFlashing, b.ui.clock]).toEqual([true, false])
  })
})

// ---- GAME: the first-run device check and the watchdog (docs/WAVE_PLAN3.md §5.1, §6.15) ----------------------------

/** Adapter fixtures (Chrome's GPUAdapterInfo strings; Babylon reports 'unknown vendor' when the browser gives none). */
const DEVICES = {
  webgl2: { engine: 'WebGL2', vendor: 'Google Inc. (NVIDIA)', architecture: 'ANGLE (NVIDIA GeForce RTX 3060)', maxInterStageShaderVariables: 30 },
  nvidia: { engine: 'WebGPU', vendor: 'nvidia', architecture: 'ampere', maxInterStageShaderVariables: 28 },
  radeon: { engine: 'WebGPU', vendor: 'amd', architecture: 'rdna-4', maxInterStageShaderVariables: 28 },
  laptop4060: { engine: 'WebGPU', vendor: 'nvidia', architecture: 'lovelace', maxInterStageShaderVariables: 28 },
  iris: { engine: 'WebGPU', vendor: 'intel', architecture: 'gen-12lp', maxInterStageShaderVariables: 28 },
  arc: { engine: 'WebGPU', vendor: 'intel', architecture: 'arc-alchemist', maxInterStageShaderVariables: 28 },
  appleChrome: { engine: 'WebGPU', vendor: 'apple', architecture: 'metal-3', maxInterStageShaderVariables: 28, platform: 'macOS' },
  applePro: { engine: 'WebGPU', vendor: 'apple', architecture: 'metal-3', description: 'Apple M2 Pro', maxInterStageShaderVariables: 28, platform: 'macOS' },
  safari: { engine: 'WebGPU', vendor: 'unknown vendor', architecture: 'unknown renderer', maxInterStageShaderVariables: 16, platform: 'MacIntel' },
  windowsHidden: { engine: 'WebGPU', vendor: 'unknown vendor', architecture: 'unknown renderer', maxInterStageShaderVariables: 28, platform: 'Win32' },
  sixteen: { engine: 'WebGPU', vendor: 'nvidia', architecture: 'turing', maxInterStageShaderVariables: 16 },
} satisfies Record<string, DeviceHint>

describe('first-run preset per device (GAME)', () => {
  it('Medium on every adapter class (the release: "Default Medium, High optional"); an integrated GPU at 0.75 with weather low', () => {
    const r = (d: DeviceHint) => recommendGraphics(d)
    // WebGL2 (plain http, or a browser without WebGPU): a discrete, an Apple or an unnamed adapter.
    expect(r(DEVICES.webgl2)).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'webgl' })
    expect(r({ engine: 'WebGL2', vendor: 'Google Inc. (AMD)', architecture: 'ANGLE (AMD, AMD Radeon RX 9060 XT (0x00007590) Direct3D11 vs_5_0 ps_5_0, D3D11)' }).preset).toBe('medium')
    expect(r({ engine: 'WebGL2', vendor: 'Google Inc. (Apple)', architecture: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1)', platform: 'MacIntel', dpr: 2 })).toEqual({ preset: 'medium', resolution: 0.75, weather: 'auto', why: 'webgl' })
    expect(r({ engine: 'WebGL2', vendor: 'unknown vendor', architecture: 'unknown renderer', platform: 'Win32' })).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'webgl' })
    // WebGL2 on an integrated GPU (the N100 class included): Medium at 0.75 with weather low, as on WebGPU.
    expect(r({ engine: 'WebGL2', vendor: 'Google Inc. (Intel)', architecture: 'ANGLE (Intel, Intel(R) UHD Graphics (0x000046D1) Direct3D11 vs_5_0 ps_5_0, D3D11)' })).toEqual({ preset: 'medium', resolution: 0.75, weather: 'low', why: 'integrated' })
    expect(r({ engine: 'WebGL2', vendor: 'Google Inc. (Intel)', architecture: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }).why).toBe('webgl')
    // WebGL1 has no PBR path: Low (Classic).
    expect(r({ ...DEVICES.webgl2, engine: 'WebGL1' })).toEqual({ preset: 'low', resolution: 1, weather: 'auto', why: 'webgl' })
    // WebGPU: discrete desktop and laptop GPUs, Arc, an adapter that hides its strings, a 16-varying adapter.
    expect(r(DEVICES.nvidia)).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'discrete' })
    expect(r(DEVICES.radeon)).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'discrete' })
    expect(r(DEVICES.laptop4060).preset).toBe('medium')
    expect(r(DEVICES.arc).preset).toBe('medium')
    expect(r(DEVICES.windowsHidden).preset).toBe('medium')
    expect(r(DEVICES.sixteen)).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'varyings' })
    expect(r(DEVICES.iris)).toEqual({ preset: 'medium', resolution: 0.75, weather: 'low', why: 'integrated' })
    expect(r({ ...DEVICES.nvidia, isFallbackAdapter: true })).toEqual({ preset: 'medium', resolution: 0.75, weather: 'low', why: 'integrated' })
    // Apple: Medium, the Pro/Max/Ultra chips too (High is the player's pick); the reason still names the chip.
    expect(r(DEVICES.appleChrome)).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'apple' })
    expect(r(DEVICES.applePro)).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'apple-pro' })
    // Safari keeps the adapter strings empty: a Mac is Apple silicon.
    expect(r(DEVICES.safari)).toMatchObject({ preset: 'medium', why: 'apple' })
    expect(isAppleGpu(DEVICES.radeon)).toBe(false)
    expect(isAppleProGpu({ description: 'Apple M3 Max' })).toBe(true)
    expect(isAppleProGpu({ description: 'Apple M3' })).toBe(false)
  })

  it('integrated GPUs: Intel without Arc, the AMD APUs the strings name, software renderers; not a discrete Radeon', () => {
    const igpu = (architecture: string, vendor = 'Google Inc. (AMD)') => isIntegratedGpu({ vendor, architecture })
    expect(igpu('ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true)
    expect(igpu('ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true)
    expect(igpu('ANGLE (AMD, AMD Radeon(TM) 890M Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true)
    expect(igpu('ANGLE (AMD, AMD Radeon Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true)
    expect(igpu('ANGLE (AMD, AMD Radeon RX 7600M XT Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false)
    expect(igpu('ANGLE (AMD, AMD Radeon RX 9060 XT (0x00007590) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false)
    expect(igpu('AMD Radeon Pro 5500M OpenGL Engine', 'ATI Technologies Inc.')).toBe(false)
    expect(igpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'Google Inc. (Google)')).toBe(true)
    expect(igpu('llvmpipe (LLVM 17.0.6, 256 bits)', 'Mesa')).toBe(true)
    expect(isIntegratedGpu({ vendor: 'amd', architecture: 'rdna-3', description: 'AMD Radeon(TM) 780M' })).toBe(true)
    expect(isIntegratedGpu({ vendor: 'amd', architecture: 'rdna-3' })).toBe(false) // a bare WebGPU adapter: not caught
    expect(isIntegratedGpu(DEVICES.iris)).toBe(true)
    expect(isIntegratedGpu(DEVICES.arc)).toBe(false)
    expect(isIntegratedGpu(DEVICES.nvidia)).toBe(false)
  })

  it('an Apple GPU on a Retina screen (dpr ≥ 2) starts at render scale 0.75; PCs keep 1 at any dpr', () => {
    const r = (d: DeviceHint) => recommendGraphics(d)
    expect(r({ ...DEVICES.appleChrome, dpr: 2 })).toEqual({ preset: 'medium', resolution: 0.75, weather: 'auto', why: 'apple' })
    expect(r({ ...DEVICES.applePro, dpr: 2 })).toEqual({ preset: 'medium', resolution: 0.75, weather: 'auto', why: 'apple-pro' })
    expect(r({ ...DEVICES.safari, dpr: 2 })).toMatchObject({ preset: 'medium', resolution: 0.75 })
    expect(r({ ...DEVICES.appleChrome, dpr: 1.5 }).resolution).toBe(1) // an external non-Retina display
    expect(r({ ...DEVICES.appleChrome, dpr: 1 }).resolution).toBe(1)
    expect(r({ ...DEVICES.nvidia, dpr: 2 }).resolution).toBe(1)
    expect(r({ ...DEVICES.webgl2, platform: 'MacIntel', dpr: 2 }).resolution).toBe(1) // an NVIDIA GPU: not Apple, full scale
    const on = new SettingsStore(null)
    runFirstRun(on, { ...DEVICES.appleChrome, dpr: 2 }, 'on')
    expect(on.get().graphics).toMatchObject({ preset: 'medium', resolution: 0.75, firstRun: false })
  })

  it("'on' applies the recommendation on a first run (a fresh profile lands on Medium); 'preview' only records it; a saved preset is never replaced", () => {
    const fresh = new SettingsStore(null)
    expect(fresh.get().graphics.firstRun).toBe(true)
    expect(runFirstRun(fresh, DEVICES.nvidia, 'on')).toEqual({ preset: 'medium', resolution: 1, weather: 'auto', why: 'discrete' })
    expect(fresh.get().graphics).toMatchObject({ preset: 'medium', resolution: 1, weather: 'auto', firstRun: false })
    expect(runFirstRun(fresh, DEVICES.nvidia, 'on')).toBeNull() // once
    const preview = new SettingsStore(null)
    preview.set({ graphics: { preset: 'high' } })
    expect(runFirstRun(preview, DEVICES.iris, 'preview')).toEqual(expect.objectContaining({ preset: 'medium', why: 'integrated' }))
    expect(preview.get().graphics).toMatchObject({ preset: 'high', resolution: 1, weather: 'auto', firstRun: false, recommended: { preset: 'medium', why: 'integrated' } })
    const on = new SettingsStore(null)
    runFirstRun(on, DEVICES.iris, 'on')
    expect(on.get().graphics).toMatchObject({ preset: 'medium', resolution: 0.75, weather: 'low', firstRun: false })
    // An old save (not a first run): 'on' records the hint and keeps the player's preset, High and Ultra included.
    for (const preset of ['low', 'high', 'ultra'] as const) {
      const old = new SettingsStore(null)
      old.set({ graphics: { preset, firstRun: false } })
      runFirstRun(old, DEVICES.nvidia, 'on')
      expect(old.get().graphics).toMatchObject({ preset, recommended: { preset: 'medium' } })
    }
    // A blob the preview already checked (firstRun false, a recommendation of High recorded) keeps its Medium.
    const seen = new SettingsStore(null)
    seen.set({ graphics: { firstRun: false, recommended: { preset: 'high', resolution: 1, weather: 'auto', why: 'discrete' } } })
    expect(runFirstRun(seen, DEVICES.nvidia, 'on')).toBeNull()
    expect(seen.get().graphics.preset).toBe('medium')
  })

  it('normalises the new fields (a broken recommendation is dropped)', () => {
    expect(normalizeSettings({ graphics: { modern: 'yes', recommended: { preset: 'epic' } } }).graphics).toMatchObject({ modern: false, recommended: null })
    const rec = { preset: 'ultra', resolution: 0.75, weather: 'low', why: 'integrated' }
    expect(normalizeSettings({ graphics: { modern: true, recommended: rec } }).graphics).toMatchObject({ modern: true, recommended: rec })
    expect(normalizeSettings(OLD).graphics).toMatchObject({ modern: false, recommended: null })
    // The release's one-time move (runReleaseMigration): due for a blob saved before it, never for a fresh profile.
    expect(normalizeSettings(OLD).graphics.releaseMigrated).toBe(false)
    expect(normalizeSettings(null).graphics.releaseMigrated).toBe(true)
    expect(defaultSettings().graphics.releaseMigrated).toBe(true)
    expect(normalizeSettings({ ...OLD, graphics: { ...OLD.graphics, releaseMigrated: true } }).graphics.releaseMigrated).toBe(true)
    expect(normalizeSettings({ ...OLD, graphics: { ...OLD.graphics, releaseMigrated: 'yes' } }).graphics.releaseMigrated).toBe(false)
  })
})

describe('frame-time watchdog (RENDER §10)', () => {
  it('trips once the p95 over 10 s passes 33 ms, after the grace; stalls and fast frames do not count', () => {
    const w = new FrameWatchdog()
    let now = 0
    w.reset(now)
    let tripped = 0
    for (; now < 60_000; now += 16) if (w.sample(16, now)) tripped++
    expect(tripped).toBe(0)
    for (const start = now; now < start + 20_000; now += 40) if (w.sample(40, now)) tripped++
    expect(tripped).toBe(1) // then it starts over with a new grace
    const g = new FrameWatchdog()
    g.reset(0)
    for (now = 0; now < 14_000; now += 50) expect(g.sample(50, now)).toBe(false) // the grace
    const s = new FrameWatchdog()
    s.reset(-WATCHDOG.graceMs)
    for (now = 0; now < 30_000; now += 20) expect(s.sample(now % 1000 === 0 ? 5000 : 20, now)).toBe(false) // a stall a second
  })

  it('steps one preset down, never below Low, nor below the floor it is given (the watchdog: Medium)', () => {
    expect([lowerPreset('ultra'), lowerPreset('high'), lowerPreset('medium'), lowerPreset('low')]).toEqual(['high', 'medium', 'low', null])
    expect(WATCHDOG_FLOOR).toBe('medium')
    expect([lowerPreset('ultra', WATCHDOG_FLOOR), lowerPreset('high', WATCHDOG_FLOOR), lowerPreset('medium', WATCHDOG_FLOOR)]).toEqual(['high', 'medium', null])
  })

  it('a busy frame (streaming, a compile) forgets the window and waits settleMs; the grace is never shortened', () => {
    const w = new FrameWatchdog()
    let now = 0
    w.reset(-WATCHDOG.graceMs) // past the grace
    let tripped = 0
    // Slow frames with a busy one every 5 s: never a full window.
    for (; now < 60_000; now += 40) if (w.sample(40, now, now % 5000 === 0)) tripped++
    expect(tripped).toBe(0)
    // The last busy frame, then quiet: settleMs, then a (nearly) full window, and it trips once.
    w.sample(40, now, true)
    const start = now
    for (; now < start + WATCHDOG.settleMs + WATCHDOG.windowMs + 2000; now += 40) {
      if (w.sample(40, now)) {
        tripped++
        expect(now - start).toBeGreaterThanOrEqual(WATCHDOG.settleMs + WATCHDOG.windowMs * 0.9)
      }
    }
    expect(tripped).toBe(1)
    // A busy frame inside the grace leaves the (longer) grace alone.
    const g = new FrameWatchdog()
    g.reset(0)
    g.sample(40, 1000, true)
    for (now = 1000; now < WATCHDOG.graceMs; now += 40) expect(g.sample(40, now)).toBe(false)
  })
})

// ---- wave 10 (docs/WAVE_PLAN6.md §4.2, W10-G): World batching, Grass, Wildlife ----------------------------------

describe('wave-10 graphics settings (W10-G)', () => {
  const host: OptionsHost = {
    engine: 'WebGPU',
    keyHelp() {},
    toast() {},
    menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
  }
  const ids = (s: ReturnType<typeof normalizeSettings>) => pageRows(host, 'graphics', s, 'on').map(r => r.id)

  it('defaults: World batching on, Wildlife on, Grass auto', () => {
    const d = defaultSettings()
    expect(d.graphics.advanced.batching).toBe('on')
    expect(d.graphics.wildlife).toBe('on')
    expect(d.graphics.scatter).toBe('auto')
    expect(ADVANCED_CHOICES.batching).toEqual(['on', 'off'])
    expect(WILDLIFE_SETTINGS).toEqual(['on', 'off'])
  })

  it('old saves keep their grass level and gain batching and wildlife on; bad values fall back', () => {
    const old = normalizeSettings(OLD)
    expect(old.graphics.scatter).toBe('auto')
    expect(old.graphics.advanced.batching).toBe('on')
    expect(old.graphics.wildlife).toBe('on')
    for (const level of ['off', 'low', 'medium', 'high'] as const) {
      const s = normalizeSettings({ ...OLD, graphics: { ...OLD.graphics, scatter: level } })
      expect(s.graphics.scatter, level).toBe(level)
      // A picked level is kept on every device (the Mac default only reads 'auto').
      expect(worldQualityFor(s, 'medium', { gpu: DEVICES.appleChrome, rollout: 'on' }).scatter, level).toBe(level)
    }
    const bad = normalizeSettings({ graphics: { wildlife: 'maybe', advanced: { batching: 1 } } })
    expect(bad.graphics.wildlife).toBe('on')
    expect(bad.graphics.advanced.batching).toBe('on')
    const off = normalizeSettings({ graphics: { wildlife: 'off', advanced: { batching: 'off' } } })
    expect(off.graphics.wildlife).toBe('off')
    expect(off.graphics.advanced.batching).toBe('off')
  })

  it('effective graphics per preset: Low (and the Low guard) never batches, keeps the retail grass and has no wildlife', () => {
    const at = (preset: 'low' | 'medium' | 'high' | 'ultra', extra: object = {}) => effectiveGraphics(normalizeSettings({ graphics: { preset, ...extra } }), { rollout: 'on' })
    for (const p of ['low', 'medium', 'high', 'ultra'] as const) {
      const e = at(p)
      expect(e.batching, p).toBe(p !== 'low')
      expect(e.wildlife, p).toBe(p !== 'low')
      expect(e.grassStyle, p).toBe(p === 'low' ? 'retail' : presetGrassStyle(p))
    }
    // The Low guard's combination and the preview off: the look from before, all of it.
    for (const e of [at('low', { sky: 'classic', weather: 'off' }), effectiveGraphics(normalizeSettings({ graphics: { preset: 'high' } }), { rollout: 'preview' })]) {
      expect(e).toMatchObject({ batching: false, wildlife: false, grassStyle: 'retail' })
    }
    expect(at('medium', { advanced: { batching: 'off' } }).batching).toBe(false)
    expect(at('high', { wildlife: 'off' }).wildlife).toBe(false)
    expect(presetGrassStyle('low')).toBe('retail')
  })

  it("Grass: Low is the default on an Apple or integrated GPU with the new look (Auto only; Low keeps the preset's level)", () => {
    const auto = normalizeSettings({ graphics: { preset: 'medium' } })
    const at = (preset: 'low' | 'medium' | 'high', gpu: DeviceHint) => worldQualityFor(auto, preset, { gpu, rollout: 'on' }).scatter
    for (const gpu of [DEVICES.appleChrome, DEVICES.applePro, DEVICES.safari, DEVICES.iris]) {
      expect(at('medium', gpu)).toBe('low')
      expect(at('high', gpu)).toBe('low')
      expect(at('low', gpu)).toBe(QUALITY_PRESETS.low.scatter)
    }
    for (const gpu of [DEVICES.nvidia, DEVICES.radeon, DEVICES.arc, DEVICES.windowsHidden]) {
      expect(at('medium', gpu)).toBe(QUALITY_PRESETS.medium.scatter)
      expect(at('high', gpu)).toBe(QUALITY_PRESETS.high.scatter)
    }
    // No GPU known (lane tests, a page before its device check): the preset's level.
    expect(worldQualityFor(auto, 'medium', { rollout: 'on' }).scatter).toBe(QUALITY_PRESETS.medium.scatter)
    // The style rides along: retail on the Classic path.
    const low = normalizeSettings({ graphics: { preset: 'low' } })
    expect(grassQualityFor(low, effectiveGraphics(low, { rollout: 'on' }), DEVICES.appleChrome)).toEqual({ grassStyle: 'retail' })
    expect(worldQualityFor(low, 'low', { rollout: 'on' })).toMatchObject({ grassStyle: 'retail' })
  })

  it('Options: Grass, Wildlife and Advanced → World batching; Low shows no batching and no wildlife row', () => {
    const low = normalizeSettings({ graphics: { preset: 'low' } })
    expect(ids(low)).not.toContain('graphics.advanced.batching')
    expect(ids(low)).not.toContain('graphics.wildlife')
    expect(ids(low)).toContain('graphics.scatter')
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      const list = ids(normalizeSettings({ graphics: { preset } }))
      expect(list, preset).toContain('graphics.advanced.batching')
      expect(list.indexOf('graphics.wildlife'), preset).toBe(list.indexOf('graphics.scatter') + 1)
    }
    const rows = optionRows(host, defaultSettings(), 'on').graphics
    const grass = rows.find(r => r.id === 'graphics.scatter')
    const wildlife = rows.find(r => r.id === 'graphics.wildlife')
    const batching = rows.find(r => r.id === 'graphics.advanced.batching')
    if (grass?.kind !== 'choice' || wildlife?.kind !== 'choice' || batching?.kind !== 'choice') throw new Error('rows missing')
    expect(t(grass.label)).toBe('Grass')
    expect(grass.choices.map(c => c.value)).toEqual(['auto', 'off', 'low', 'medium', 'high'])
    expect(t(wildlife.label)).toBe('Wildlife')
    expect(wildlife.choices).toEqual([{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }])
    expect(wildlife.patch('off')).toEqual({ graphics: { wildlife: 'off' } })
    expect(t(batching.label)).toBe('World batching')
    expect(batching.choices).toEqual([{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }])
    expect(batching.patch('off')).toEqual({ graphics: { advanced: { batching: 'off' } } })
    const store = new SettingsStore(null)
    store.set(batching.patch('off'))
    store.set(wildlife.patch('off'))
    expect(store.get().graphics.advanced.batching).toBe('off')
    expect(store.get().graphics.wildlife).toBe('off')
  })
})

describe('wave-11 Town life (W11-G; docs/WAVE_PLAN7.md D10, D26)', () => {
  const host: OptionsHost = {
    engine: 'WebGPU',
    keyHelp() {},
    toast() {},
    menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
  }
  const level = (raw: unknown, gpu?: DeviceHint, rollout: 'on' | 'preview' = 'on') => {
    const st = normalizeSettings(raw)
    return townLifeFor(st, effectiveGraphics(st, { rollout, gpu }), gpu)
  }

  it('defaults per preset: Full on Medium and up, Off on Low (Classic) and without the new look', () => {
    expect(defaultSettings().graphics.townLife).toBe('auto')
    expect(TOWN_LIFE_SETTINGS).toEqual(['auto', 'off', 'low', 'full'])
    for (const preset of ['medium', 'high', 'ultra'] as const) expect(level({ graphics: { preset } }), preset).toBe('full')
    expect(level({ graphics: { preset: 'low' } })).toBe('off')
    // The Low guard's combination and the preview off: no town.
    expect(level({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })).toBe('off')
    expect(level({ graphics: { preset: 'high' } }, undefined, 'preview')).toBe('off')
    // A level the player picked is kept on the PBR presets, and still nothing on Low.
    expect(level({ graphics: { preset: 'medium', townLife: 'low' } })).toBe('low')
    expect(level({ graphics: { preset: 'high', townLife: 'off' } })).toBe('off')
    expect(level({ graphics: { preset: 'low', townLife: 'full' } })).toBe('off')
  })

  it('Mac and integrated GPUs default to Low (Auto only); a picked level is kept on every device', () => {
    for (const gpu of [DEVICES.appleChrome, DEVICES.applePro, DEVICES.safari, DEVICES.iris]) {
      expect(level({ graphics: { preset: 'medium' } }, gpu)).toBe('low')
      expect(level({ graphics: { preset: 'high', townLife: 'full' } }, gpu)).toBe('full')
      expect(level({ graphics: { preset: 'low' } }, gpu)).toBe('off')
    }
    for (const gpu of [DEVICES.nvidia, DEVICES.radeon, DEVICES.arc, DEVICES.windowsHidden]) expect(level({ graphics: { preset: 'medium' } }, gpu)).toBe('full')
  })

  it('old saves and bad values normalise to Auto; picked values survive', () => {
    expect(normalizeSettings(OLD).graphics.townLife).toBe('auto')
    expect(normalizeSettings({ graphics: { townLife: 'lots' } }).graphics.townLife).toBe('auto')
    for (const v of TOWN_LIFE_SETTINGS) expect(normalizeSettings({ graphics: { townLife: v } }).graphics.townLife).toBe(v)
    // An old High save on a Mac: Low; on Low: off.
    expect(level(OLD, DEVICES.appleChrome)).toBe('low')
    expect(level({ ...OLD, graphics: { ...OLD.graphics, preset: 'low' } })).toBe('off')
  })

  it('Options: the Town life row follows Wildlife on the PBR presets; none on Low', () => {
    const ids = (raw: unknown) => pageRows(host, 'graphics', normalizeSettings(raw), 'on').map(r => r.id)
    expect(ids({ graphics: { preset: 'low' } })).not.toContain('graphics.townLife')
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      const list = ids({ graphics: { preset } })
      expect(list.indexOf('graphics.townLife'), preset).toBe(list.indexOf('graphics.wildlife') + 1)
    }
    const row = optionRows(host, defaultSettings(), 'on').graphics.find(r => r.id === 'graphics.townLife')
    if (row?.kind !== 'choice') throw new Error('row missing')
    expect(t(row.label)).toBe('Town life')
    expect(row.choices).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'full', label: 'Full' },
    ])
    const store = new SettingsStore(null)
    store.set(row.patch('low'))
    expect(store.get().graphics.townLife).toBe('low')
  })
})

describe('wave-12 Trees (W12-G; docs/WAVE_PLAN8.md D9, §3.4; TREES Part W)', () => {
  const host: OptionsHost = {
    engine: 'WebGPU',
    keyHelp() {},
    toast() {},
    menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
  }
  const trees = (raw: unknown, rollout: 'on' | 'preview' = 'on') => effectiveGraphics(normalizeSettings(raw), { rollout }).trees

  it('defaults per preset: the new trees on Medium and up; retail on Low (Classic), the Low guard and without the new look', () => {
    expect(defaultSettings().graphics.trees).toBe('new')
    expect(TREES_SETTINGS).toEqual(['new', 'retail'])
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      expect(trees({ graphics: { preset } }), preset).toBe('new')
      expect(trees({ graphics: { preset, trees: 'retail' } }), preset).toBe('retail')
    }
    // Low never swaps, whatever is saved.
    expect(trees({ graphics: { preset: 'low' } })).toBe('retail')
    expect(trees({ graphics: { preset: 'low', trees: 'new' } })).toBe('retail')
    expect(trees({ graphics: { preset: 'low', sky: 'classic', weather: 'off', trees: 'new' } })).toBe('retail')
    expect(trees({ graphics: { preset: 'high', trees: 'new' } }, 'preview')).toBe('retail')
  })

  it('old saves and bad values normalise to New; picked values survive', () => {
    expect(normalizeSettings(OLD).graphics.trees).toBe('new')
    expect(trees(OLD)).toBe('new')
    expect(normalizeSettings({ graphics: { trees: 'old' } }).graphics.trees).toBe('new')
    expect(normalizeSettings({ graphics: { trees: true } }).graphics.trees).toBe('new')
    for (const v of TREES_SETTINGS) expect(normalizeSettings({ graphics: { trees: v } }).graphics.trees).toBe(v)
    // A wave-11 save (every wave-11 key, no trees) keeps its own values and gains the new trees.
    const w11 = { ...defaultSettings(), graphics: { ...defaultSettings().graphics, preset: 'high', townLife: 'low', trees: undefined } }
    const n = normalizeSettings(JSON.parse(JSON.stringify(w11)))
    expect(n.graphics).toMatchObject({ preset: 'high', townLife: 'low', trees: 'new' })
  })

  it('Options: the Trees row follows Town life on the PBR presets; none on Low', () => {
    const ids = (raw: unknown) => pageRows(host, 'graphics', normalizeSettings(raw), 'on').map(r => r.id)
    expect(ids({ graphics: { preset: 'low' } })).not.toContain('graphics.trees')
    expect(ids({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })).not.toContain('graphics.trees')
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      const list = ids({ graphics: { preset } })
      expect(list.indexOf('graphics.trees'), preset).toBe(list.indexOf('graphics.townLife') + 1)
    }
    const row = optionRows(host, defaultSettings(), 'on').graphics.find(r => r.id === 'graphics.trees')
    if (row?.kind !== 'choice') throw new Error('row missing')
    expect(t(row.label)).toBe('Trees')
    expect(row.choices).toEqual([
      { value: 'new', label: 'New' },
      { value: 'retail', label: 'Retail' },
    ])
    const store = new SettingsStore(null)
    store.set(row.patch('retail'))
    expect(store.get().graphics.trees).toBe('retail')
    expect(store.get().graphics.townLife).toBe('auto')
  })
})

// ---- mini-wave w12r (GODRAYS): Options → Graphics → Light shafts ------------------------------------------------

describe('light shafts row (w12r GODRAYS)', () => {
  const host: OptionsHost = {
    engine: 'WebGPU',
    keyHelp() {},
    toast() {},
    menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
  }
  const shafts = (raw: unknown) => effectiveGraphics(normalizeSettings(raw), { rollout: 'on' }).renderQuality.lightShafts

  it('Auto follows the preset: Medium low, High and Ultra high; a picked level overrides it', () => {
    expect(ADVANCED_CHOICES.lightShafts).toEqual(['auto', 'off', 'low', 'high'])
    expect(defaultSettings().graphics.advanced.lightShafts).toBe('auto')
    expect(shafts({ graphics: { preset: 'medium' } })).toBe('low')
    expect(shafts({ graphics: { preset: 'high' } })).toBe('high')
    expect(shafts({ graphics: { preset: 'ultra' } })).toBe('high')
    expect(shafts({ graphics: { preset: 'medium', advanced: { lightShafts: 'high' } } })).toBe('high')
    expect(shafts({ graphics: { preset: 'high', advanced: { lightShafts: 'off' } } })).toBe('off')
    expect(shafts({ graphics: { preset: 'ultra', advanced: { lightShafts: 'low' } } })).toBe('low')
  })

  it('Low never draws them, whatever the row says (the Low guard)', () => {
    for (const lightShafts of ['low', 'high'] as const) {
      const e = effectiveGraphics(normalizeSettings({ graphics: { preset: 'low', advanced: { lightShafts } } }), { rollout: 'on' })
      expect(e.renderQuality.lightShafts === 'off' || e.renderQuality.lightShafts === false).toBe(true)
    }
  })

  it('a wave-9 save keeps what it drew: on is High, off stays off, junk is Auto', () => {
    expect(normalizeSettings({ graphics: { advanced: { lightShafts: 'on' } } }).graphics.advanced.lightShafts).toBe('high')
    expect(normalizeSettings({ graphics: { advanced: { lightShafts: 'off' } } }).graphics.advanced.lightShafts).toBe('off')
    expect(normalizeSettings({ graphics: { advanced: { lightShafts: true } } }).graphics.advanced.lightShafts).toBe('auto')
  })

  it('Options: the row is shown on the PBR presets beside World batching, hidden on Low', () => {
    const ids = (raw: unknown) => pageRows(host, 'graphics', normalizeSettings(raw), 'on').map(r => r.id)
    expect(ids({ graphics: { preset: 'low' } })).not.toContain('graphics.advanced.lightShafts')
    expect(ids({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })).not.toContain('graphics.advanced.lightShafts')
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      const list = ids({ graphics: { preset } })
      expect(list.indexOf('graphics.advanced.lightShafts'), preset).toBe(list.indexOf('graphics.advanced.batching') + 1)
    }
    const row = optionRows(host, defaultSettings(), 'on').graphics.find(r => r.id === 'graphics.advanced.lightShafts')
    if (row?.kind !== 'choice') throw new Error('row missing')
    expect(t(row.label)).toBe('Light shafts')
    expect(row.choices.map(c => c.label)).toEqual(['Auto', 'Off', 'Low', 'High'])
    const store = new SettingsStore(null)
    store.set(row.patch('low'))
    expect(store.get().graphics.advanced.lightShafts).toBe('low')
    expect(store.get().graphics.advanced.batching).toBe('on')
  })
})
