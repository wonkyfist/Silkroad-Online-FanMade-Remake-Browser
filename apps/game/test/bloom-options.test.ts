/**
 * Options → Graphics → Bloom (render/quality.ts BLOOM_LOOKS): off by default for new and old saves, folded into the
 * effective render block on the PBR presets only (Low / Classic untouched), the Options row, and its live apply through
 * WorldGraphics. Also the "Weather effects" row on the first Options open: the world features register their rows
 * after the Options window laid its page out, so a registration has to reach the window.
 */
import { DirectionalLight, HemisphericLight, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { BLOOM_LOOKS, RENDER_PRESETS, type RenderQuality } from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onOptionRowsChange, optionRows, pageLayoutKey, pageRows, registerOptionRow, type OptionsHost, type OptionsTab } from '../src/hud/options.ts'
import { t } from '../src/i18n/index.ts'
import {
  BLOOM_SETTINGS,
  PREVIEW_OFF_RENDER,
  SettingsStore,
  defaultSettings,
  effectiveGraphics,
  normalizeSettings,
  type Settings,
} from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { weatherFeature } from '../src/world/features/weather.ts'
import { WorldGraphics } from '../src/world/graphics.ts'

const host: OptionsHost = { engine: 'WebGPU', keyHelp() {}, toast() {}, menu: { app: {} as never, close() {}, characterSelect() {}, logout() {} } }
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

const settingsWith = (graphics: Partial<Settings['graphics']>): Settings => normalizeSettings({ ...defaultSettings(), graphics: { ...defaultSettings().graphics, ...graphics } })

describe('the bloom setting', () => {
  it('is off for a new profile and for every save from before it existed; unknown values fall back to off', () => {
    expect(defaultSettings().graphics.bloom).toBe('off')
    expect(BLOOM_SETTINGS).toEqual(['off', 'subtle', 'strong'])
    // A wave-9 release save (High, modern, no bloom key) and a pre-wave-9 one.
    expect(normalizeSettings({ v: 1, graphics: { preset: 'high', modern: true, releaseMigrated: true } }).graphics.bloom).toBe('off')
    expect(normalizeSettings({ v: 1, graphics: { preset: 'medium' } }).graphics.bloom).toBe('off')
    expect(normalizeSettings({ v: 1, graphics: { bloom: 'blinding' } }).graphics.bloom).toBe('off')
    for (const b of BLOOM_SETTINGS) expect(normalizeSettings({ v: 1, graphics: { bloom: b } }).graphics.bloom).toBe(b)
  })

  it('off leaves every PBR preset block as the table has it (bloom 0 on every preset)', () => {
    for (const p of ['medium', 'high', 'ultra'] as const) {
      const e = effectiveGraphics(settingsWith({ preset: p }), { rollout: 'on' })
      expect(e.renderQuality, p).toBe(RENDER_PRESETS[p])
      expect(e.renderQuality.bloom, p).toBe(0)
    }
  })

  it('subtle and strong replace the preset\'s bloom on the PBR presets; strong is the High look the release shipped', () => {
    for (const p of ['medium', 'high', 'ultra'] as const) {
      const subtle = effectiveGraphics(settingsWith({ preset: p, bloom: 'subtle' }), { rollout: 'on' }).renderQuality
      expect([subtle.bloom, subtle.bloomThreshold, subtle.bloomWeight], p).toEqual([0.5, BLOOM_LOOKS.subtle.bloomThreshold, BLOOM_LOOKS.subtle.bloomWeight])
      const strong = effectiveGraphics(settingsWith({ preset: p, bloom: 'strong' }), { rollout: 'on' }).renderQuality
      expect([strong.bloom, strong.bloomThreshold, strong.bloomWeight], p).toEqual([1, undefined, undefined])
      // Nothing else of the block moves.
      const rest = (q: Readonly<RenderQuality>) => ({ ...q, bloom: 0, bloomThreshold: undefined, bloomWeight: undefined })
      expect(rest(subtle)).toEqual(rest(RENDER_PRESETS[p]))
      expect(rest(strong)).toEqual(rest(RENDER_PRESETS[p]))
    }
    // Subtle: past the top of the tone curve (above the brightest sunlit surface measured at the plaza, 2.7), and softer.
    expect(BLOOM_LOOKS.subtle.bloomThreshold!).toBeGreaterThan(2.7)
    expect(BLOOM_LOOKS.subtle.bloomWeight!).toBeLessThan(0.15)
  })

  it('never touches Low (the Classic path) or the Low guard: no bloom there, whatever the choice', () => {
    for (const b of BLOOM_SETTINGS) {
      expect(effectiveGraphics(settingsWith({ preset: 'low', bloom: b }), { rollout: 'on' }).renderQuality, b).toBe(RENDER_PRESETS.low)
      expect(effectiveGraphics(settingsWith({ preset: 'low', sky: 'classic', weather: 'off', bloom: b }), { rollout: 'on' }).renderQuality, b).toBe(PREVIEW_OFF_RENDER)
      expect(effectiveGraphics(settingsWith({ preset: 'high', modern: false, bloom: b }), { rollout: 'preview' }).renderQuality, b).toBe(PREVIEW_OFF_RENDER)
    }
  })

  it('has an Options row with Off / Subtle / Strong on the PBR presets only', () => {
    const ids = (s: Settings) => pageRows(host, 'graphics', s, 'on').map(r => r.id)
    expect(ids(settingsWith({ preset: 'medium' }))).toContain('graphics.bloom')
    expect(ids(settingsWith({ preset: 'high' }))).toContain('graphics.bloom')
    expect(ids(settingsWith({ preset: 'low' }))).not.toContain('graphics.bloom')
    // The row follows the tone map row, in the Advanced block.
    const med = ids(settingsWith({ preset: 'medium' }))
    expect(med.indexOf('graphics.bloom')).toBe(med.indexOf('graphics.advanced.toneMap') + 1)
    const row = optionRows(host, defaultSettings(), 'on').graphics.find(r => r.id === 'graphics.bloom')
    if (row?.kind !== 'choice') throw new Error('no bloom row')
    expect(t(row.label)).toBe('Bloom')
    expect(row.choices).toEqual([{ value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' }, { value: 'strong', label: 'Strong' }])
    expect(row.get(settingsWith({ bloom: 'subtle' }))).toBe('subtle')
    expect(row.patch('strong')).toEqual({ graphics: { bloom: 'strong' } })
    // A live change: never the "the world rebuilds" question.
    expect(row.confirm).toBeUndefined()
  })
})

// ---- live, through the world screen's graphics link ------------------------------------------------------------

function fakePbrWorld() {
  const renders: Array<Readonly<RenderQuality>> = []
  const w = {
    quality: 'medium' as const,
    render: {
      mode: 'pbr' as 'classic' | 'pbr',
      post: null,
      activeCamera: {},
      gpu: { features: [] as string[], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false, maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16 },
      attachCamera: vi.fn(),
      addCharacter: vi.fn(),
      removeCharacter: vi.fn(),
    },
    stream: { setSettings: vi.fn() },
    materials: { pbr: { decorateCharacterMaterial: vi.fn() } },
    skyStyle: 'modern' as 'classic' | 'modern',
    objects: { setRangeScale: vi.fn(), setAnimatedVisible: vi.fn() },
    water: { setVisible: vi.fn() },
    scatter: { setLevel: vi.fn() },
    setQuality: vi.fn((q: { render: Readonly<RenderQuality> }) => void renders.push(q.render)),
    setRenderMode: vi.fn(),
    setSkyStyle: vi.fn(),
    isolateLights: vi.fn(),
  }
  return { w, renders }
}

describe('bloom applies live', () => {
  it('a bloom change hands World.setQuality the new block (the post stack rebuilds), with no path switch or reload', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
    const sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene)
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'medium', firstRun: false } })
    const { w, renders } = fakePbrWorld()
    const say = vi.fn()
    const g = new WorldGraphics({ world: w as never, camera: {} as never, lights: { hemi, sun }, store, rollout: 'on', say })
    cleanups.push(() => {
      g.dispose()
      scene.dispose()
      engine.dispose()
    })
    expect(renders.at(-1)).toBe(RENDER_PRESETS.medium)
    store.set({ graphics: { bloom: 'subtle' } })
    expect(renders.at(-1)).toMatchObject({ bloom: 0.5, bloomThreshold: BLOOM_LOOKS.subtle.bloomThreshold })
    store.set({ graphics: { bloom: 'strong' } })
    expect(renders.at(-1)).toMatchObject({ bloom: 1 })
    store.set({ graphics: { bloom: 'off' } })
    expect(renders.at(-1)).toBe(RENDER_PRESETS.medium)
    expect(renders).toHaveLength(4)
    expect(w.setRenderMode).not.toHaveBeenCalled()
    expect(say).not.toHaveBeenCalled() // no "applies the next time you enter the world"
  })
})

// ---- the "Weather effects" row on the first Options open --------------------------------------------------------

describe('rows registered after the Options window was built', () => {
  it('a registration or removal tells the open windows, so the page is laid out with the row (menu bar first open)', () => {
    const s = settingsWith({ preset: 'medium' })
    const seen: OptionsTab[] = []
    cleanups.push(onOptionRowsChange(page => seen.push(page)))
    // The window lays its page out at boot (hud/ux-shell.ts), before the world screen starts its features.
    const atBoot = pageLayoutKey(host, 'graphics', s, 'on')
    expect(atBoot).not.toContain('graphics.weather')
    const world = { render: { mode: 'pbr', gpu: {} }, skyStyle: 'modern', weather: { shelter: null }, setWeather: vi.fn(), setWeatherLevel: vi.fn() }
    const ctx = {
      app: { audio: { weather: { update: vi.fn(), thunder: vi.fn(), prepareThunder: vi.fn(), stop: vi.fn() } } },
      scene: { getLightByName: () => null },
      camera: { target: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 5, z: -10 } },
      serverNow: () => 0,
      selfId: () => null,
      view: () => undefined,
      world: () => ({ world }),
    } as unknown as WorldFeatureContext
    const f = weatherFeature(ctx, { store: new SettingsStore(null), search: '', zoneAt: () => null })
    // The weather feature's rows reached the listeners, and the page's layout key changed: OptionsWindow's listener
    // (and its onOpen) re-lay the page out from that key.
    expect(seen).toEqual(expect.arrayContaining(['graphics', 'interface']))
    const now = pageLayoutKey(host, 'graphics', s, 'on')
    expect(now).not.toBe(atBoot)
    expect(pageRows(host, 'graphics', s, 'on').map(r => r.id)).toContain('graphics.weather')
    seen.length = 0
    f.dispose!()
    expect(seen).toEqual(expect.arrayContaining(['graphics', 'interface']))
    expect(pageLayoutKey(host, 'graphics', s, 'on')).toBe(atBoot)
  })

  it('re-registering a row id replaces it; an unregister of a replaced row is silent', () => {
    const seen: OptionsTab[] = []
    cleanups.push(onOptionRowsChange(page => seen.push(page)))
    const a = registerOptionRow('controls', { id: 'test.row', kind: 'info', text: () => 'a' })
    const b = registerOptionRow('controls', { id: 'test.row', kind: 'info', text: () => 'b' })
    expect(seen).toEqual(['controls', 'controls'])
    a()
    expect(seen).toHaveLength(2)
    b()
    expect(seen).toEqual(['controls', 'controls', 'controls'])
    const off = onOptionRowsChange(() => seen.push('audio'))
    off()
    registerOptionRow('controls', { id: 'test.row2', kind: 'info', text: () => '' })()
    expect(seen).not.toContain('audio')
  })
})
