/**
 * Wave-9 client seams in apps/game (docs/WAVE_PLAN3.md §4.3, D9, D11): the two new world features (no-op stubs for
 * GAME and WX-C), the three i18n files spread into en.ts, and ModelLibrary.addMaterialDecorator.
 */
import { AssetContainer, NullEngine, Scene, StandardMaterial, type Material } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { enRender } from '../src/i18n/en-render.ts'
import { enSky } from '../src/i18n/en-sky.ts'
import { enWeather } from '../src/i18n/en-weather.ts'
import { ModelLibrary } from '../src/three/models.ts'
import { WORLD_FEATURES, type WorldFeatureContext } from '../src/world/features.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

describe('wave-9 features and strings', () => {
  it('appends skyClockFeature and weatherFeature (the sky clock a no-op stub for now; WX-C filled the weather)', () => {
    const names = WORLD_FEATURES.map(f => f.name)
    // Wave 10 appends after them (movementFeature, W10-G).
    const at = names.indexOf('skyClockFeature')
    expect(names.slice(at, at + 2)).toEqual(['skyClockFeature', 'weatherFeature'])
    expect(WORLD_FEATURES[at]!({} as WorldFeatureContext)).toEqual({})
  })

  it('en.ts spreads the three wave-9 string files (empty until GAME and WX-C fill them)', () => {
    for (const part of [enRender, enSky, enWeather]) {
      for (const [k, v] of Object.entries(part)) {
        expect(typeof v).toBe('string')
        expect((en as Record<string, string>)[k], k).toBeDefined()
      }
    }
  })
})

describe('ModelLibrary.addMaterialDecorator (D9)', () => {
  function library() {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const lib = new ModelLibrary(scene)
    cleanups.push(() => {
      lib.dispose()
      scene.dispose()
      engine.dispose()
    })
    /** Stands in for a finished LoadAssetContainerAsync (both load paths call it). */
    const loaded = (glb: string, names: string[]) => {
      const c = new AssetContainer(scene)
      for (const n of names) c.materials.push(new StandardMaterial(n, scene))
      ;(lib as unknown as { noteLoaded(c: AssetContainer, glb: string): void }).noteLoaded(c, glb)
      return c
    }
    return { lib, loaded }
  }

  it('runs on every material of containers loaded before and after, until removed', () => {
    const { lib, loaded } = library()
    loaded('a.glb', ['a1', 'a2'])
    const seen: string[] = []
    const remove = lib.addMaterialDecorator((m: Material, info) => seen.push(`${info.glb}:${m.name}`))
    expect(seen).toEqual(['a.glb:a1', 'a.glb:a2'])
    loaded('pack.glb', ['p1'])
    expect(seen).toEqual(['a.glb:a1', 'a.glb:a2', 'pack.glb:p1'])
    remove()
    loaded('b.glb', ['b1'])
    expect(seen).toHaveLength(3)
  })

  it('a decorator that throws is logged and the others still run', () => {
    const { lib, loaded } = library()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    lib.addMaterialDecorator(() => {
      throw new Error('boom')
    })
    const seen: string[] = []
    lib.addMaterialDecorator(m => seen.push(m.name))
    loaded('c.glb', ['c1'])
    expect(seen).toEqual(['c1'])
    expect(warn).toHaveBeenCalled()
  })
})
