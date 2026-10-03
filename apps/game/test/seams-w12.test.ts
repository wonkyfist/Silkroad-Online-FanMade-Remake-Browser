/**
 * Wave-12 client seams in apps/game (docs/WAVE_PLAN8.md §4.5, D9, W12-G): the registered sound-zone feature stub (WE-R
 * fills it) and the graphics link's Trees pass-through (`worldTreesOption` at load, `World.setTreeMode` on a change) on
 * a world with and without W12-SA's seam. The settings half is in settings.test.ts.
 */
import { DirectionalLight, HemisphericLight, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore, effectiveGraphics, normalizeSettings } from '../src/settings.ts'
import { WORLD_FEATURES, type WorldFeatureContext } from '../src/world/features.ts'
import { soundZonesFeature } from '../src/world/features/sound-zones.ts'
import { WorldGraphics, worldTreesOption } from '../src/world/graphics.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

describe('the sound-zone feature stub (WE-R fills it)', () => {
  it('is registered after the sound, coast and town-sound features, before the town feature and the jump', () => {
    const names = WORLD_FEATURES.map(f => f.name)
    expect(WORLD_FEATURES).toContain(soundZonesFeature)
    const at = names.indexOf('soundZonesFeature')
    for (const before of ['soundFeature', 'coastFeature', 'townSoundFeature']) expect(names.indexOf(before), before).toBeLessThan(at)
    expect(names.slice(at)).toEqual(['soundZonesFeature', 'townFeature', 'movementFeature'])
  })

  it('does nothing yet', () => {
    expect(soundZonesFeature({} as WorldFeatureContext)).toEqual({})
  })
})

// ---- the graphics link (world/graphics.ts) --------------------------------------------------------------------------

/** A world as World.setQuality & co. see it (seams-w10.test.ts' fake), with W12-SA's `setTreeMode` when `seam`. */
function fakeWorld(mode: 'classic' | 'pbr', seam: boolean, preset: 'low' | 'medium' = mode === 'pbr' ? 'medium' : 'low') {
  const w: Record<string, unknown> & { render: { mode: 'classic' | 'pbr' } } = {
    quality: preset,
    render: {
      mode,
      post: null,
      activeCamera: {},
      gpu: { features: [] as string[] },
      attachCamera: vi.fn(),
      addCharacter: vi.fn(),
      removeCharacter: vi.fn(),
    },
    stream: { setSettings: vi.fn() },
    materials: { pbr: { decorateCharacterMaterial: vi.fn() } },
    skyStyle: 'modern',
    objects: { setRangeScale: vi.fn(), setAnimatedVisible: vi.fn() },
    water: { setVisible: vi.fn() },
    scatter: { setLevel: vi.fn() },
    setQuality: vi.fn(),
    setRenderMode: vi.fn((m: 'classic' | 'pbr') => {
      w.render.mode = m
    }),
    setSkyStyle: vi.fn(),
    isolateLights: vi.fn(),
  }
  if (seam) w.setTreeMode = vi.fn()
  return w
}

function link(w: Record<string, unknown>, store: SettingsStore, extra: { trees?: 'new' | 'retail'; say?: (text: string) => void } = {}) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  const sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene)
  const g = new WorldGraphics({ world: w as never, camera: {} as never, lights: { hemi, sun }, store, rollout: 'on', ...extra })
  cleanups.push(() => {
    g.dispose()
    scene.dispose()
    engine.dispose()
  })
  return g
}

const storeWith = (graphics: object) => {
  const s = new SettingsStore(null)
  s.set({ graphics: { firstRun: false, ...graphics } })
  return s
}

describe('graphics link: Trees (W12-G)', () => {
  it('the load option: the setting on the PBR presets, retail on Low, the Low guard and without the new look', () => {
    const opt = (raw: unknown, rollout: 'on' | 'preview' = 'on') => worldTreesOption(effectiveGraphics(normalizeSettings(raw), { rollout }))
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      expect(opt({ graphics: { preset } }), preset).toBe('new')
      expect(opt({ graphics: { preset, trees: 'retail' } }), preset).toBe('retail')
    }
    expect(opt({ graphics: { preset: 'low', trees: 'new' } })).toBe('retail')
    expect(opt({ graphics: { preset: 'low', sky: 'classic', weather: 'off', trees: 'new' } })).toBe('retail')
    expect(opt({ graphics: { preset: 'high', trees: 'new' } }, 'preview')).toBe('retail')
  })

  it('nothing at load, then World.setTreeMode on each change of the row', () => {
    const w = fakeWorld('pbr', true)
    const store = storeWith({ preset: 'medium' })
    link(w, store, { trees: 'new' })
    const setTreeMode = w.setTreeMode as ReturnType<typeof vi.fn>
    expect(setTreeMode).not.toHaveBeenCalled()
    store.set({ graphics: { trees: 'retail' } })
    expect(setTreeMode.mock.calls).toEqual([['retail']])
    store.set({ graphics: { sight: 1 } }) // another change: no second call
    store.set({ graphics: { trees: 'new' } })
    expect(setTreeMode.mock.calls).toEqual([['retail'], ['new']])
  })

  it('Low (Classic) never calls World.setTreeMode (the Low guard); the choice reaches the world just before a switch to PBR', () => {
    const w = fakeWorld('classic', true)
    const store = storeWith({ preset: 'low' })
    // The world loaded on Classic with the load option: retail.
    link(w, store, { trees: worldTreesOption(effectiveGraphics(store.get(), { rollout: 'on' })) })
    const setTreeMode = w.setTreeMode as ReturnType<typeof vi.fn>
    const setRenderMode = w.setRenderMode as ReturnType<typeof vi.fn>
    store.set({ graphics: { trees: 'retail' } })
    store.set({ graphics: { trees: 'new' } })
    expect(setTreeMode).not.toHaveBeenCalled()
    store.set({ graphics: { preset: 'medium' } })
    expect(setTreeMode.mock.calls).toEqual([['new']])
    expect(setRenderMode).toHaveBeenLastCalledWith('pbr')
    expect(setTreeMode.mock.invocationCallOrder[0]!).toBeLessThan(setRenderMode.mock.invocationCallOrder.at(-1)!)
    // Back to Low: the switch to Classic drops the swap itself (the claim keys on the path); no call.
    store.set({ graphics: { preset: 'low' } })
    expect(setTreeMode.mock.calls).toEqual([['new']])
  })

  it('without the seam: the change waits for the next entry, said once', () => {
    const w = fakeWorld('pbr', false)
    const store = storeWith({ preset: 'medium' })
    const said: string[] = []
    link(w, store, { say: text => said.push(text) })
    store.set({ graphics: { trees: 'retail' } })
    store.set({ graphics: { trees: 'new' } })
    expect(said).toEqual(['The new graphics apply the next time you enter the world.'])
  })
})
