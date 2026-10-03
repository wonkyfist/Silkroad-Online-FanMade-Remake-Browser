/**
 * The PBR height fog (docs/WAVE_PLAN3.md §6.13, D18; docs/RENDER.md §5.5): the integral at h → 0 is the uniform
 * exponential fog, 95% at the fog end the world applies (the retail end × the weather's fog scale), denser below the
 * eye and never thinner above it; the plugin ships WGSL and GLSL at the same PBR injection points (which exist in both
 * PBR fragments), obeys the WGSL rules, attaches only to PBR materials of an active scene and switches the material's
 * own fog off while it is on.
 */
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import { NullEngine, PBRMaterial, Scene, ShaderLanguage, ShaderStore, StandardMaterial, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { FOG_RANGE_M } from '../src/index.ts'
import {
  FOG_95,
  FOG_PLUGIN_NAME,
  HEIGHT_FOG_GLSL,
  HEIGHT_FOG_WGSL,
  HeightFog,
  SroFogPlugin,
  fogDensity,
  fogPluginCode,
  fogRingU,
  heightFactor,
  heightFogAmount,
} from '../src/pbr/fog-plugin.ts'
import { displayToExposed, exposedToDisplay } from '../src/render/display.ts'
import type { SkyState } from '../src/sky/types.ts'
import { weatherFogScale } from '../src/weather/env.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(): Scene {
  const engine = new NullEngine()
  const s = new Scene(engine)
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

describe('height-fog maths', () => {
  const start = 190, end = 250
  const p = { density: fogDensity(start, end), startM: start, falloffM: 80 }

  it('reaches 95% at the fog end on a level ray', () => {
    expect(heightFogAmount(end, 20, 20, p)).toBeCloseTo(0.95, 6)
    expect(fogDensity(start, end) * (end - start)).toBeCloseTo(FOG_95, 9)
  })

  it('is the uniform exponential fog at h → 0 (and clear before the start)', () => {
    for (const d of [0, 100, 190, 200, 230, 260, 400]) {
      const uniform = 1 - Math.exp(-p.density * Math.max(0, d - start))
      expect(heightFogAmount(d, 10, 10, p)).toBeCloseTo(uniform, 9)
      expect(heightFogAmount(d, 10, 10 - 1e-6, p)).toBeCloseTo(uniform, 6)
    }
    expect(heightFogAmount(150, 5, 5, p)).toBe(0)
    expect(heightFactor(0, 1 / 80)).toBe(1)
    expect(heightFactor(1e-5, 1 / 80)).toBeCloseTo(1, 6)
  })

  it('is denser below the eye, uniform above it, and saturates in deep valleys', () => {
    const level = heightFogAmount(220, 30, 30, p)
    expect(heightFogAmount(220, 30, -10, p)).toBeGreaterThan(level)
    expect(heightFogAmount(220, 30, 80, p)).toBe(level)
    const f = heightFactor(40, 1 / 80)
    expect(f).toBeCloseTo((Math.exp(0.5) - 1) / 0.5, 9)
    expect(Number.isFinite(heightFactor(1e6, 1 / 80))).toBe(true)
  })

  it('95% lands at the retail fog end × the weather fog scale', () => {
    const retailEnd = 1 * FOG_RANGE_M, retailStart = 0.76 * FOG_RANGE_M
    for (const w of [{ fog: 0, rain: 0 }, { fog: 0, rain: 1 }, { fog: 1, rain: 0 }, { fog: 0.4, rain: 0.8 }]) {
      const s = weatherFogScale(w)
      const e = retailEnd * s.end, st = retailStart * s.start
      const q = { density: fogDensity(st, e), startM: st, falloffM: 80 }
      expect(heightFogAmount(e, 12, 12, q), JSON.stringify(w)).toBeCloseTo(0.95, 6)
    }
  })

  it('maps the view azimuth to the ring u in 0..1', () => {
    expect(fogRingU({ x: 0, z: 1 })).toBeCloseTo(0.5, 9)
    expect(fogRingU({ x: 1, z: 0 })).toBeCloseTo(0.75, 9)
    expect(fogRingU({ x: -1, z: 0 })).toBeCloseTo(0.25, 9)
  })
})

describe('SroFogPlugin shader code', () => {
  const wgsl = fogPluginCode(ShaderLanguage.WGSL)
  const glsl = fogPluginCode(ShaderLanguage.GLSL)

  it('ships WGSL and GLSL with the same injection-point keys', () => {
    expect(Object.keys(wgsl).sort()).toEqual(Object.keys(glsl).sort())
    expect(Object.keys(wgsl).sort()).toEqual(['CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR', 'CUSTOM_FRAGMENT_DEFINITIONS'])
  })

  it('injects at points that exist in both PBR fragments, after image processing (D18)', () => {
    const w = ShaderStore.ShadersStoreWGSL['pbrPixelShader']!
    const g = ShaderStore.ShadersStore['pbrPixelShader']!
    for (const src of [w, g]) {
      for (const key of Object.keys(wgsl)) expect(src).toContain(`#define ${key}`)
      expect(src.indexOf('#define CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR')).toBeGreaterThan(src.indexOf('#include<pbrBlockImageProcessing>'))
      expect(src.indexOf('#define CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR')).toBeLessThan(src.indexOf('#include<pbrBlockPrePass>'))
    }
  })

  it('WGSL follows the chunk rules and carries no GLSL', () => {
    const all = Object.values(wgsl).join('\n') + HEIGHT_FOG_WGSL
    expect(all).not.toMatch(/\btextureSample(Bias|Compare)?\s*\(/)
    expect(all).not.toMatch(/\b(dpdx|dpdy|fwidth)\b/)
    expect(all).not.toMatch(/\?/)
    expect(all).not.toMatch(/\b(vec3|vec4|float|uniform|sampler2D|texture2D|textureLod)\b/)
    expect(all).toContain('fragmentInputs.vPositionW')
    expect(all).toContain('uniforms.sroFogA')
    const g = Object.values(glsl).join('\n') + HEIGHT_FOG_GLSL
    expect(g).not.toMatch(/\b(vec3f|vec4f|fn |let |var<)\b/)
  })
})

describe('SroFogPlugin on materials (NullEngine)', () => {
  it('attaches only to PBR materials of an active scene and replaces their own fog', () => {
    const s = scene()
    const other = scene()
    const fog = new HeightFog(s)
    cleanups.push(() => fog.dispose())
    const before = new PBRMaterial('before', s)
    expect(before.pluginManager?.getPlugin(FOG_PLUGIN_NAME) ?? null).toBeNull()
    fog.setActive(true)
    const early = before.pluginManager?.getPlugin<SroFogPlugin>(FOG_PLUGIN_NAME)
    expect(early).toBeInstanceOf(SroFogPlugin)
    expect(before.fogEnabled).toBe(false)
    const pbr = new PBRMaterial('pbr', s)
    expect(pbr.pluginManager?.getPlugin(FOG_PLUGIN_NAME)).toBeInstanceOf(SroFogPlugin)
    const std = new StandardMaterial('std', s)
    expect(std.pluginManager?.getPlugin(FOG_PLUGIN_NAME) ?? null).toBeNull()
    const elsewhere = new PBRMaterial('elsewhere', other)
    expect(elsewhere.pluginManager?.getPlugin(FOG_PLUGIN_NAME) ?? null).toBeNull()
    expect(elsewhere.fogEnabled).toBe(true)

    const plugin = pbr.pluginManager!.getPlugin<SroFogPlugin>(FOG_PLUGIN_NAME)!
    const defines: Record<string, unknown> = {}
    plugin.prepareDefines(defines as never)
    expect(defines).toEqual({ SRO_HEIGHTFOG: true, SRO_FOG_RING: false })
    expect(plugin.isCompatible(ShaderLanguage.WGSL) && plugin.isCompatible(ShaderLanguage.GLSL)).toBe(true)
    expect(Object.keys(plugin.getCustomCode('fragment', ShaderLanguage.WGSL)!)).toEqual(Object.keys(plugin.getCustomCode('fragment', ShaderLanguage.GLSL)!))
    expect(plugin.getCustomCode('vertex', ShaderLanguage.WGSL)).toBeNull()

    fog.setActive(false)
    expect(pbr.fogEnabled).toBe(true)
    plugin.prepareDefines(defines as never)
    expect(defines['SRO_HEIGHTFOG']).toBe(false)
    const late = new PBRMaterial('late', s)
    expect(late.pluginManager?.getPlugin(FOG_PLUGIN_NAME) ?? null).toBeNull()
  })

  it('takes the fog range from the scene fog and the colour from the SkyState', () => {
    const s = scene()
    const fog = new HeightFog(s)
    cleanups.push(() => fog.dispose())
    const state = {
      fogColor: [1, 0.5, 0], exposure: 4, sunDir: new Vector3(0, 1, 0), sunElevationDeg: 60,
      keyLight: { dir: new Vector3(0, 1, 0), color: [1, 1, 1], intensity: 1 }, horizonRing: null,
    } as unknown as SkyState
    s.fogMode = Scene.FOGMODE_LINEAR
    s.fogStart = 190
    s.fogEnd = 250
    fog.update(state, 4)
    expect(fog.a.x).toBeCloseTo(FOG_95 / 60, 9)
    expect(fog.a.z).toBe(190)
    expect(fog.a.w).toBe(1)
    // The display colour through the exact inverse of the post's gamma and Neutral curve (W9F D4), ÷ exposure: the
    // post stack then shows (1, 0.5, 0) again (up to the 0.995 clamp just below white).
    const lin = displayToExposed([1, 0.5, 0], 'neutral')
    expect(fog.color.x).toBeCloseTo(lin[0]! / 4, 6)
    expect(fog.color.y).toBeCloseTo(lin[1]! / 4, 6)
    expect(fog.color.z).toBeCloseTo(lin[2]! / 4, 6)
    const shown = exposedToDisplay([fog.color.x * 4, fog.color.y * 4, fog.color.z * 4], 'neutral')
    // (1, 0.5, 0) is out of the curve's reach (a saturated colour at white): the nearest reachable one shows.
    expect(shown[1]).toBeCloseTo(0.5, 1)
    expect(fog.color.w).toBeCloseTo(0.25, 9)
    s.fogMode = Scene.FOGMODE_NONE
    fog.update(state, 4)
    expect(fog.a.w).toBe(0)
  })
})
