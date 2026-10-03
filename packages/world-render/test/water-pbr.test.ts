/**
 * RND-W's PBR water (pbr/water-plugin.ts, water.ts PBR branch; docs/RENDER.md §7, docs/WAVE_PLAN3.md §6.14, D21, D24):
 * the wave type → amplitude table, the shore alpha and foam from the depth, the depth encoding the shader decodes, the
 * water hue; SroWaterPlugin ships WGSL and GLSL with the same points, at points of Babylon 9.28's PBR fragment,
 * without the other language's idioms; the normal map is tileable; and a NullEngine WaterRenderer keeps its Classic
 * branch without a renderer, and on the PBR path builds up-normal meshes with the depth and wave type in their colour,
 * one PBRMaterial + plugin, and follows the preset's depth shore and the weather's ripples and rain.
 */
import { NullEngine, PBRMaterial, RawTexture, Scene, ShaderMaterial, ShaderStore, type BaseTexture, type Mesh } from '@babylonjs/core'
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import { afterEach, describe, expect, it } from 'vitest'
import { GRID } from '../../convert/src/world/format.ts'
import {
  CLEAR_RENDER_WEATHER,
  RENDER_PRESETS,
  SRO_WATER_PLUGIN,
  SroWaterPlugin,
  WaterRenderer,
  encodeWaterDepth,
  shoreAlpha,
  waterFragmentCode,
  waterHue,
  waveAmplitude,
  type RenderPath,
  type RenderQuality,
  type RegionData,
  type WaterRenderSource,
  type WorldRegions,
} from '../src/index.ts'
import { Assets } from '../src/assets.ts'
import { WATER_ROUGHNESS, foamAmount, waterNormalPixels } from '../src/pbr/water-plugin.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
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

function pbrFragment(lang: 'wgsl' | 'glsl'): string {
  const main = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL.pbrPixelShader : ShaderStore.ShadersStore.pbrPixelShader
  const includes = lang === 'wgsl' ? ShaderStore.IncludesShadersStoreWGSL : ShaderStore.IncludesShadersStore
  expect(main).toBeTruthy()
  return [main, ...Object.values(includes)].join('\n')
}

describe('water numbers', () => {
  it('wave type → amplitude (RENDER §7: 0.5 / 0.8 / 1.0 / 1.3)', () => {
    expect([0, 1, 2, 3].map(waveAmplitude)).toEqual([0.5, 0.8, 1, 1.3])
    expect(waveAmplitude(7)).toBe(1)
    expect(waveAmplitude(-1)).toBe(1)
  })

  it('shore alpha from depth: saturate(depth / 1.5 m); foam only at the water line', () => {
    expect(shoreAlpha(-0.5)).toBe(0)
    expect(shoreAlpha(0)).toBe(0)
    expect(shoreAlpha(0.75)).toBeCloseTo(0.5, 9)
    expect(shoreAlpha(1.5)).toBe(1)
    expect(shoreAlpha(6)).toBe(1)
    expect(foamAmount(-0.5)).toBe(0) // dry ground under the block's grid: no foam painted on land
    expect(foamAmount(0.02)).toBeCloseTo(1, 1)
    expect(foamAmount(0.3)).toBe(0)
    expect(foamAmount(2)).toBe(0)
  })

  it('the depth rides in the vertex colour and decodes as r × 9 − 1', () => {
    for (const d of [-1, -0.2, 0, 0.3, 1.5, 4, 8]) expect(encodeWaterDepth(d) * 9 - 1).toBeCloseTo(d, 9)
    expect(encodeWaterDepth(-3)).toBe(0)
    expect(encodeWaterDepth(20)).toBe(1)
  })

  it('the water colour keeps its hue at the noon level (the PBR light carries the time of day)', () => {
    const noon = waterHue([0.36, 0.69, 0.62])
    expect(noon[1]).toBeCloseTo(0.69, 9)
    expect(noon[0] / noon[1]).toBeCloseTo(0.36 / 0.69, 9)
    const night = waterHue([0.09, 0.17, 0.2])
    expect(Math.max(...night)).toBeCloseTo(0.69, 9)
    expect(waterHue([0, 0, 0]).every(v => Number.isFinite(v) && v > 0)).toBe(true)
  })

  it('the normal map is deterministic, tileable and points up', () => {
    const size = 32
    const a = waterNormalPixels(size, 7, 12)
    expect(waterNormalPixels(size, 7, 12)).toEqual(a)
    for (let i = 0; i < a.length; i += 4) expect(a[i + 2]!).toBeGreaterThan(128)
    // Integer wave vectors: the last column continues into the first (a small step, like any neighbour step).
    const at = (x: number, y: number) => [a[(y * size + x) * 4]!, a[(y * size + x) * 4 + 1]!]
    let wrap = 0, inner = 0
    for (let y = 0; y < size; y++) {
      wrap = Math.max(wrap, Math.abs(at(size - 1, y)[0]! - at(0, y)[0]!))
      inner = Math.max(inner, Math.abs(at(1, y)[0]! - at(0, y)[0]!))
    }
    expect(wrap).toBeLessThanOrEqual(inner + 8)
  })
})

describe('SroWaterPlugin code', () => {
  it('ships the same points in WGSL and GLSL, each a PBR fragment point in both languages', () => {
    const wgsl = waterFragmentCode('wgsl')
    const glsl = waterFragmentCode('glsl')
    expect(Object.keys(wgsl).sort()).toEqual(Object.keys(glsl).sort())
    expect(Object.keys(wgsl).sort()).toEqual([
      'CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION',
      'CUSTOM_FRAGMENT_DEFINITIONS',
      'CUSTOM_FRAGMENT_MAIN_BEGIN',
      'CUSTOM_FRAGMENT_UPDATE_ALBEDO',
      'CUSTOM_FRAGMENT_UPDATE_ALPHA',
      'CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS',
    ])
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = pbrFragment(lang)
      for (const point of Object.keys(wgsl)) expect(src.includes(`#define ${point}`), `${lang} ${point}`).toBe(true)
      for (const n of ['surfaceAlbedo', 'alpha', 'normalW', 'metallicRoughness', 'vPositionW', 'vColor']) expect(src.includes(n), `${lang} ${n}`).toBe(true)
    }
  })

  it('keeps each language to itself, closes every #if, and samples only at the top of main (uniform control flow)', () => {
    for (const [point, code] of Object.entries(waterFragmentCode('wgsl'))) {
      expect(code, point).not.toMatch(/\b(float|vec[234]|texture2D|textureLod|dFdx|dFdy|gl_\w+)\s*[(\s]/)
      expect(code, point).not.toMatch(/\?[^:]*:/)
      expect(code, point).not.toMatch(/\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/)
      expect(code, point).not.toMatch(/\bdpdx|dpdy|fwidth/)
      if (point !== 'CUSTOM_FRAGMENT_MAIN_BEGIN') expect(code, point).not.toMatch(/\btextureSample(Bias|Compare)?\s*\(/)
      else expect(code, point).not.toMatch(/\bif\s*\(/) // no runtime branch around the taps
    }
    for (const [point, code] of Object.entries(waterFragmentCode('glsl'))) {
      expect(code, point).not.toMatch(/\b(fn|let)\s|vec[234]f\(|var<private>|fragmentInputs|uniforms\./)
    }
    for (const lang of ['wgsl', 'glsl'] as const) {
      for (const [point, code] of Object.entries(waterFragmentCode(lang))) {
        expect((code.match(/^#if/gm) ?? []).length, `${lang} ${point}`).toBe((code.match(/^#endif/gm) ?? []).length)
        expect(code.startsWith('#ifdef SRO_WATER\n'), `${lang} ${point}`).toBe(true)
      }
    }
  })
})

// ---- WaterRenderer on a NullEngine -----------------------------------------------------------------------------------

/** One region with a 2 × 1 block pond: block 0 is 2 m deep (wave type 3), block 1 is dry (skipped). */
function pondRegion(): RegionData {
  const heights = new Float32Array(GRID * GRID).fill(-2)
  for (let gz = 0; gz <= 16; gz++) for (let gx = 16; gx <= 32; gx++) heights[gz * GRID + gx] = 1 // block (1, 0) above the water
  const region = {
    id: 5, x: 5, z: 0, origin: [0, 0, 0],
    blocks: [
      { bx: 0, bz: 0, water: { kind: 'water', type: 0, wave: 3, heightM: 0 } },
      { bx: 1, bz: 0, water: { kind: 'water', type: 0, wave: 1, heightM: 0 } },
    ],
  }
  return { region, terrain: { heights }, navmesh: null } as unknown as RegionData
}

function makeWater(render: { mode: RenderPath; quality: Readonly<RenderQuality>; weather: typeof CLEAR_RENDER_WEATHER } | null) {
  const scene = nullScene()
  const world = { manifest: { water: { frames: [], frameMs: 100, ice: null } }, regions: [] } as unknown as WorldRegions
  const water = new WaterRenderer(scene, world)
  cleanups.push(() => water.dispose())
  const assets = new Assets('http://mem.test/', { bytes: async () => { throw new Error('no assets') }, decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) })
  const ripple = RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 128, 0]), 1, 1, scene)
  const weather = { rippleTexture: null as BaseTexture | null, u: { wxA: { w: 12 } } }
  if (render) water.follow({ render, weather } satisfies WaterRenderSource)
  return { scene, water, assets, weather, ripple }
}

const PARAMS = { color: [0.36, 0.69, 0.62] as [number, number, number], fog: true, fogStartM: 50, fogEndM: 250, fogColor: [0.5, 0.6, 0.7] as [number, number, number] }

describe('WaterRenderer', () => {
  it('without a renderer (or on the Classic path) builds HEAD\'s water: the ShaderMaterial, white vertex colour', async () => {
    for (const render of [null, { mode: 'classic' as const, quality: RENDER_PRESETS.low, weather: CLEAR_RENDER_WEATHER }]) {
      const { water, assets } = makeWater(render)
      await water.init(assets)
      const meshes = water.addRegion(pondRegion())
      expect(meshes).toHaveLength(1)
      expect(water.blocks).toBe(1)
      expect(water.skippedBlocks).toBe(1)
      expect(meshes[0]!.material).toBeInstanceOf(ShaderMaterial)
      expect(water.pbrMaterial).toBeNull()
      const col = meshes[0]!.getVerticesData('color')!
      for (let i = 0; i < col.length; i += 4) expect([col[i], col[i + 1], col[i + 2]]).toEqual([1, 1, 1])
      expect(meshes[0]!.getVerticesData('normal')).toBeNull()
    }
  })

  it('on the PBR path builds up-normal meshes with the depth and wave type in the colour and one PBR material', async () => {
    const render = { mode: 'pbr' as RenderPath, quality: RENDER_PRESETS.medium, weather: CLEAR_RENDER_WEATHER }
    const { water, assets, weather, ripple } = makeWater(render)
    await water.init(assets)
    const [mesh] = water.addRegion(pondRegion()) as [Mesh]
    const mat = mesh.material as PBRMaterial
    expect(mat).toBeInstanceOf(PBRMaterial)
    expect(mat).toBe(water.pbrMaterial)
    expect(mat.pluginManager!.getPlugin(SRO_WATER_PLUGIN)).toBeInstanceOf(SroWaterPlugin)
    expect([mat.metallic, mat.roughness, mat.disableDepthWrite, mat.transparencyMode]).toEqual([0, WATER_ROUGHNESS[0], true, PBRMaterial.PBRMATERIAL_ALPHABLEND])
    const col = mesh.getVerticesData('color')!
    // Block 0 is 2 m deep everywhere: depth 2 → r = 3 / 9; wave type 3 → g = 1.3 / 2; the retail alpha stays in a.
    expect(col[0]! * 9 - 1).toBeCloseTo(2, 5)
    expect(col[1]!).toBeCloseTo(1.3 / 2, 6)
    expect(col[3]!).toBeCloseTo(Math.trunc(2 * 10 * 0.5) / 15, 6)
    const n = mesh.getVerticesData('normal')!
    for (let i = 0; i < n.length; i += 3) expect([n[i], n[i + 1], n[i + 2]]).toEqual([0, 1, 0])
    // A second region shares the material.
    const second = { ...pondRegion(), region: { ...pondRegion().region, id: 6, x: 6 } } as RegionData
    expect(water.addRegion(second)[0]!.material).toBe(mat)

    // Per frame: frame, rain, ripple clock, roughness; the switches follow the preset and the weather level.
    const s = water.pbrState
    water.update(1000, PARAMS)
    expect([s.shore, s.ripple]).toEqual([false, null])
    expect(s.a.w).toBe(12)
    expect(s.b.w).toBeCloseTo(WATER_ROUGHNESS[0], 9)
    expect(s.b.y).toBeCloseTo(0.69, 6)
    render.quality = RENDER_PRESETS.high
    render.weather = { ...CLEAR_RENDER_WEATHER, rain: 1 }
    weather.rippleTexture = ripple
    water.update(2000, PARAMS)
    expect([s.shore, s.ripple]).toEqual([true, ripple])
    expect(s.a.z).toBe(1)
    expect(s.b.w).toBeCloseTo(WATER_ROUGHNESS[1], 9)
  })

  it('the preset\'s water row decides the branch (quality.water)', async () => {
    const render = { mode: 'pbr' as RenderPath, quality: { ...RENDER_PRESETS.medium, water: 'classic' as RenderPath }, weather: CLEAR_RENDER_WEATHER }
    const { water, assets } = makeWater(render)
    await water.init(assets)
    expect(water.pbr).toBe(false)
    expect(water.addRegion(pondRegion())[0]!.material).toBeInstanceOf(ShaderMaterial)
  })
})
