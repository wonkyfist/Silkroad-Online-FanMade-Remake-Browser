/**
 * The weather's shader code in both languages (docs/WAVE_PLAN3.md §6.17: every plugin ships WGSL and GLSL with the same
 * injection-point keys; no GLSL may reach WebGPU): the chunks, the rain shaders, the shelter height shader and the
 * WetnessPlugin declare the same `wx*` uniforms in WGSL and GLSL, fill the same points, use only the weather defines,
 * and keep to the WGSL rules (no implicit-derivative taps, no swizzle assignment); the plugin is compatible with both
 * languages and returns WGSL for WGSL, GLSL otherwise.
 */
import { NullEngine, PBRMaterial, Scene, ShaderLanguage, StandardMaterial } from '@babylonjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import {
  TERRAIN_SURFACE_PARAMS,
  WEATHER_CHUNKS,
  WX_DEFINES,
  scatterShaders,
  terrainShaders,
  waterShaders,
  type ShaderSources,
  type WorldShaderChunks,
} from '../src/index.ts'
import { WX_SHELTER_GLSL, WX_SHELTER_WGSL, WX_SWAY_GLSL, WX_SWAY_WGSL } from '../src/weather/chunks.ts'
import { RAIN_SHADERS } from '../src/weather/rain.ts'
import { SHELTER_SHADERS } from '../src/weather/shelter.ts'
import { WetnessPlugin, wetnessCode } from '../src/weather/wet-plugin.ts'

const lanes: WorldShaderChunks[] = [WEATHER_CHUNKS]
const built: Record<string, ShaderSources> = {
  terrain: terrainShaders(lanes),
  water: waterShaders(lanes),
  grass: scatterShaders(lanes),
}

/** `uniform wxX: vec4f;` (WGSL) / `uniform vec4 wxX;` (GLSL) names. */
const declared = (src: string, lang: 'wgsl' | 'glsl') =>
  lang === 'wgsl'
    ? new Set([...src.matchAll(/uniform\s+(\w+)\s*:/g)].map(m => m[1]!))
    : new Set([...src.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)\s*;/g)].filter(m => !m[1]!.startsWith('sampler')).map(m => m[2]!))
/** Textures: `var x: texture_2d<f32>;` (WGSL) / `uniform sampler2D x;` (GLSL). */
const textures = (src: string, lang: 'wgsl' | 'glsl') => [...src.matchAll(lang === 'wgsl'
  ? /var\s+(\w+)\s*:\s*texture_/g
  : /uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?sampler\w*\s+(\w+)\s*;/g)].map(m => m[1]!).sort()
const wx =(s: Set<string>) => [...s].filter(n => /^(wx|rain|spl|cur|bolt|sh)[A-Z]/.test(n)).sort()
/** Uniform names a WGSL body reads through `uniforms.` / a GLSL body by name. */
const usedWGSL = (src: string) => new Set([...src.matchAll(/uniforms\.(wx\w+)/g)].map(m => m[1]!))

const allWGSL: string[] = []
const allGLSL: string[] = []
for (const s of Object.values(built)) {
  allWGSL.push(s.vertexWGSL, s.fragmentWGSL)
  allGLSL.push(s.vertexGLSL, s.fragmentGLSL)
}
for (const s of [...Object.values(RAIN_SHADERS), SHELTER_SHADERS]) {
  allWGSL.push(s.vertexWGSL, s.fragmentWGSL)
  allGLSL.push(s.vertexGLSL, s.fragmentGLSL)
}
for (const family of ['standard', 'pbr'] as const) {
  for (const stage of ['vertex', 'fragment'] as const) {
    allWGSL.push(...Object.values(wetnessCode(family, stage, 'wgsl') ?? {}))
    allGLSL.push(...Object.values(wetnessCode(family, stage, 'glsl') ?? {}))
  }
}
allWGSL.push(WX_SHELTER_WGSL, WX_SWAY_WGSL)
allGLSL.push(WX_SHELTER_GLSL, WX_SWAY_GLSL)

/** The weather's own code (the chunk snippets, not the HEAD shaders around them). */
const own = (lang: 'wgsl' | 'glsl') => [
  ...(['terrain', 'water', 'grass'] as const).flatMap(s => Object.values(WEATHER_CHUNKS[s]![lang]!)),
  ...Object.values(RAIN_SHADERS).flatMap(s => (lang === 'wgsl' ? [s.vertexWGSL, s.fragmentWGSL] : [s.vertexGLSL, s.fragmentGLSL])),
  ...(lang === 'wgsl' ? [SHELTER_SHADERS.vertexWGSL, SHELTER_SHADERS.fragmentWGSL] : [SHELTER_SHADERS.vertexGLSL, SHELTER_SHADERS.fragmentGLSL]),
  ...(['standard', 'pbr'] as const).flatMap(f => (['vertex', 'fragment'] as const).flatMap(st => Object.values(wetnessCode(f, st, lang) ?? {}))),
]
const ownWGSL = own('wgsl')
const ownGLSL = own('glsl')

describe('WGSL / GLSL parity', () => {
  it.each(Object.entries(built))('%s: the same wx* uniforms declared in both languages, per stage', (_name, s) => {
    expect(wx(declared(s.vertexWGSL, 'wgsl'))).toEqual(wx(declared(s.vertexGLSL, 'glsl')))
    expect(wx(declared(s.fragmentWGSL, 'wgsl'))).toEqual(wx(declared(s.fragmentGLSL, 'glsl')))
    expect(textures(s.vertexWGSL, 'wgsl')).toEqual(textures(s.vertexGLSL, 'glsl'))
    expect(textures(s.fragmentWGSL, 'wgsl')).toEqual(textures(s.fragmentGLSL, 'glsl'))
    expect(wx(declared(s.fragmentWGSL, 'wgsl')).length).toBeGreaterThan(3)
    // Every name the WGSL reads is declared, and every chunk uniform is in the ShaderMaterial list.
    for (const n of usedWGSL(s.fragmentWGSL + s.vertexWGSL)) expect(declared(s.fragmentWGSL + s.vertexWGSL, 'wgsl').has(n), n).toBe(true)
    for (const n of wx(declared(s.fragmentWGSL, 'wgsl'))) expect(s.uniforms).toContain(n)
  })

  it.each(Object.entries({ ...RAIN_SHADERS, sroShelterHeight: SHELTER_SHADERS }))('%s: the same uniforms and varyings in both languages', (_name, s) => {
    expect(wx(declared(s.vertexWGSL, 'wgsl'))).toEqual(wx(declared(s.vertexGLSL, 'glsl')))
    expect(wx(declared(s.fragmentWGSL, 'wgsl'))).toEqual(wx(declared(s.fragmentGLSL, 'glsl')))
    expect(textures(s.vertexWGSL, 'wgsl')).toEqual(textures(s.vertexGLSL, 'glsl'))
    expect(textures(s.fragmentWGSL, 'wgsl')).toEqual(textures(s.fragmentGLSL, 'glsl'))
    const vary = (src: string, lang: 'wgsl' | 'glsl') =>
      [...src.matchAll(lang === 'wgsl' ? /varying\s+(\w+)\s*:/g : /varying\s+\w+\s+(\w+)\s*;/g)].map(m => m[1]).sort()
    expect(vary(s.vertexWGSL, 'wgsl')).toEqual(vary(s.vertexGLSL, 'glsl'))
    expect(vary(s.fragmentWGSL, 'wgsl')).toEqual(vary(s.fragmentGLSL, 'glsl'))
    for (const n of usedWGSL(s.vertexWGSL)) expect(declared(s.vertexWGSL, 'wgsl').has(n), n).toBe(true)
  })

  it('every chunk fills the same points in both languages', () => {
    for (const shader of ['terrain', 'water', 'grass'] as const) {
      const c = WEATHER_CHUNKS[shader]!
      expect(Object.keys(c.wgsl ?? {}).sort(), shader).toEqual(Object.keys(c.glsl ?? {}).sort())
      expect(Object.keys(c.wgsl ?? {}).length).toBeGreaterThan(3)
    }
  })

  it('the WetnessPlugin has the same injection points in both languages, for both material families', () => {
    for (const family of ['standard', 'pbr'] as const) {
      for (const stage of ['vertex', 'fragment'] as const) {
        const w = wetnessCode(family, stage, 'wgsl')
        const g = wetnessCode(family, stage, 'glsl')
        expect(Object.keys(w ?? {}).sort(), `${family} ${stage}`).toEqual(Object.keys(g ?? {}).sort())
      }
    }
  })
})

describe('the WGSL rules and no GLSL on WebGPU', () => {
  it('no GLSL constructs in any WGSL string, no WGSL constructs in any GLSL string', () => {
    for (const s of allWGSL) {
      expect(s).not.toMatch(/\b(vec[234]|mat[34]|float|int)\s*\(/)
      expect(s).not.toMatch(/\b(textureLod|texture2D|textureGrad|gl_FragColor|gl_Position)\b/)
      expect(s).not.toMatch(/^\s*(float|vec[234]|bool|int)\s+\w+\s*=/m)
      expect(s).not.toMatch(/\?[^:\n]*:/)
    }
    for (const s of allGLSL) {
      expect(s).not.toMatch(/\b(vec[234]f|mat4x4f|f32|i32)\b/)
      expect(s).not.toMatch(/^\s*(let|var|fn)\s/m)
      expect(s).not.toMatch(/\b(textureSampleLevel|textureSampleGrad|fragmentInputs|vertexOutputs|uniforms\.)/)
    }
  })

  it('no implicit-derivative tap and no swizzle assignment in the weather WGSL', () => {
    for (const s of ownWGSL) {
      expect(s).not.toMatch(/\btextureSample(Bias|Compare)?\s*\(/)
      expect(s).not.toMatch(/\b\w+\.[xyzwrgba]{2,4}\s*[-+*/]?=(?!=)/)
    }
    // The only derivatives are the water's, taken first thing in its (uniform) fragment flow.
    const terrain = Object.values(WEATHER_CHUNKS.terrain!.wgsl!).join('')
    expect(terrain).not.toMatch(/\b(dpdx|dpdy|fwidth)\b/)
    expect(WEATHER_CHUNKS.water!.wgsl!.normal!.indexOf('dpdx')).toBeLessThan(WEATHER_CHUNKS.water!.wgsl!.normal!.indexOf('if ('))
  })

  it('every #ifdef in the chunks is a weather define (or Babylon\'s own)', () => {
    const src = [...ownWGSL, ...ownGLSL].join('\n')
    // SH_BAND: the shelter height pass's band collapse of the tree groups (PLAZA-RAIN).
    // SRO_HDR: RND-W's HDR grass (render/grass-chunks.ts GRASS_HDR_DEFINE) compiles the Classic flash multiply out (W9F D5).
    const known = new Set<string>([...WX_DEFINES, 'WX_FOLIAGE', 'DRIPS', 'LIGHTMAP', 'SRO_HDR', 'SH_BAND'])
    for (const m of src.matchAll(/#ifn?def\s+(\w+)/g)) expect(known.has(m[1]!), m[1]).toBe(true)
  })

  it('the terrain surface table in the shader is pbr/classes.ts TERRAIN_SURFACE_PARAMS', () => {
    const fnSrc = WEATHER_CHUNKS.terrain!.wgsl!.samplers!
    for (let c = 1; c < TERRAIN_SURFACE_PARAMS.length; c++) {
      const p = TERRAIN_SURFACE_PARAMS[c]!
      expect(fnSrc).toContain(`if (c == ${c}) { return vec4f(${p.porosity.toFixed(3)}, ${p.gloss.toFixed(3)}, ${p.puddle.toFixed(3)}, 0.0); }`)
    }
    const p0 = TERRAIN_SURFACE_PARAMS[0]!
    expect(fnSrc).toContain(`return vec4f(${p0.porosity.toFixed(3)}, ${p0.gloss.toFixed(3)}, ${p0.puddle.toFixed(3)}, 0.0);`)
  })
})

describe('WetnessPlugin languages', () => {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  afterAll(() => {
    scene.dispose()
    engine.dispose()
  })

  it('isCompatible for GLSL and WGSL (the base class is GLSL only, and the manager throws on WGSL)', () => {
    const p = new WetnessPlugin(new StandardMaterial('s', scene), 'static', { porosity: 0.5, gloss: 0.5 })
    expect(p.isCompatible(ShaderLanguage.GLSL)).toBe(true)
    expect(p.isCompatible(ShaderLanguage.WGSL)).toBe(true)
  })

  it('returns WGSL for WGSL and GLSL otherwise, for Standard and PBR materials', () => {
    for (const mat of [new StandardMaterial('std', scene), new PBRMaterial('pbr', scene)]) {
      const p = new WetnessPlugin(mat, mat instanceof PBRMaterial ? 'actor' : 'static', { porosity: 0.4, gloss: 0.5 })
      const w = p.getCustomCode('fragment', ShaderLanguage.WGSL)!
      const g = p.getCustomCode('fragment', ShaderLanguage.GLSL)!
      expect(Object.keys(w).sort()).toEqual(Object.keys(g).sort())
      expect(Object.values(w).join('')).toContain('uniforms.wxA')
      expect(Object.values(g).join('')).not.toContain('uniforms.')
      expect(p.getUniforms(ShaderLanguage.WGSL).ubo!.map(u => u.name)).toContain('wxMat')
      expect((p.getUniforms(ShaderLanguage.WGSL) as { fragment?: string }).fragment).toBeUndefined()
    }
  })
})
