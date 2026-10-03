/**
 * CST-O, the ocean's materials (docs/COAST.md §8.6, §12.4): both shader languages return the same injection-point keys;
 * no GLSL in the WGSL (no GLSL reaches the WebGPU engine) and the reverse; every vertex tap is explicit-level and every
 * implicit-derivative fragment tap sits at CUSTOM_FRAGMENT_MAIN_BEGIN (F14); the material compiles on NullEngine with
 * the INSTANCES define (thin instances, F1) and declares exactly one user varying beyond Babylon's own for an uv-less,
 * colour-less mesh (§8.6's one-vec4 rule), and no CSM on a 16-varying limit; the height fog attaches itself on the
 * PBR path; the join zone reproduces RND-W's albedo formula; the Classic ocean's four sources are the same program.
 */
import { MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, type Mesh } from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { afterAll, describe, expect, it } from 'vitest'
import { HeightFog, FOG_PLUGIN_NAME } from '../src/pbr/fog-plugin.ts'
import { WATER_ALBEDO_WEIGHT, WATER_DEEP, WATER_FRAME_REPEAT_M, WATER_NORMAL_LAYERS, WATER_SHORE_M, waterFragmentCode } from '../src/pbr/water-plugin.ts'
import { classicOceanShaders } from '../src/ocean/ocean-classic.ts'
import {
  CDLOD_ATTRIBUTE,
  OCEAN_VARYING,
  OceanPbrState,
  createOceanMaterial,
  deepAlbedo,
  joinAlbedo,
  oceanCode,
  waterColour,
} from '../src/ocean/ocean-plugin.ts'
import { CDLOD_MAX_NODES } from '../src/ocean/cdlod.ts'

const engines: NullEngine[] = []
afterAll(() => {
  for (const e of engines.splice(0)) e.dispose()
})

function scene(): Scene {
  const engine = new NullEngine()
  engine.getCaps().textureLOD = true
  engines.push(engine)
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  s.createDefaultCamera()
  return s
}

/** A thin-instanced grid like the ocean's (identity matrices + cdlodNode). */
export function oceanProbe(s: Scene): Mesh {
  const mesh = MeshBuilder.CreateGround('probe', { width: 1, height: 1, subdivisions: 4 }, s)
  const m = new Float32Array(CDLOD_MAX_NODES * 16)
  for (let i = 0; i < CDLOD_MAX_NODES; i++) m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16)
  mesh.thinInstanceSetBuffer('matrix', m, 16, true)
  mesh.thinInstanceSetBuffer(CDLOD_ATTRIBUTE, new Float32Array(CDLOD_MAX_NODES * 4), 4, false)
  mesh.thinInstanceCount = 3
  return mesh
}

export function readyState(s: Scene, o: { lerp?: boolean; c4?: boolean; ripple?: boolean } = {}): OceanPbrState {
  const st = new OceanPbrState()
  const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, s)
  // NullEngine has no 2D arrays: plain textures keep the material valid (the budget counts samplers, not kinds).
  st.waves = st.field = st.normal = st.frames = tex
  st.setSwitches({ lerp: o.lerp ?? true, cascades4: o.c4 ?? false, ripple: o.ripple ? tex : null })
  return st
}

async function compile(s: Scene, mesh: Mesh, mat: PBRMaterial): Promise<{ defines: string[]; vertex: string; fragment: string }> {
  mesh.material = mat
  let ready = false
  for (let i = 0; i < 400 && !ready; i++) {
    ready = mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!, true)
    if (!ready) await new Promise(r => setTimeout(r, 5))
  }
  expect(ready).toBe(true)
  const effect = mesh.subMeshes[0]!.effect as unknown as { defines: string; _fragmentSourceCode: string; _vertexSourceCode: string }
  const defines = effect.defines.split('\n').filter(l => l.startsWith('#define'))
  const pre = (code: string, isFragment: boolean) => {
    let out = ''
    PreProcess(code, { defines, isFragment, version: '300', platformName: 'WEBGL2', processor: { shaderLanguage: 0 } } as never, (c: string) => { out = c }, s.getEngine())
    return out
  }
  return { defines, vertex: pre(effect._vertexSourceCode, false), fragment: pre(effect._fragmentSourceCode, true) }
}

const varyings = (glsl: string) => [...new Set([...glsl.matchAll(/(?:^|;)\s*(?:flat\s+)?(?:varying|out)\s+(?:(?:highp|mediump|lowp)\s+)?(?:float|vec[234]|mat[234]|int|ivec[234])\s+(\w+)\s*;/gm)].map(m => m[1]!))].filter(n => n !== 'glFragColor')

describe('SroOceanPlugin code', () => {
  it('both languages have the same injection points, per stage', () => {
    for (const stage of ['vertex', 'fragment'] as const) expect(Object.keys(oceanCode(stage, 'wgsl')).sort()).toEqual(Object.keys(oceanCode(stage, 'glsl')).sort())
  })

  it('no GLSL in the WGSL and no WGSL in the GLSL (no GLSL reaches the WebGPU engine)', () => {
    for (const stage of ['vertex', 'fragment'] as const) {
      const w = Object.values(oceanCode(stage, 'wgsl')).join('\n')
      const g = Object.values(oceanCode(stage, 'glsl')).join('\n')
      expect(w).not.toMatch(/\bvec[234]\(|\bfloat\s+\w+\s*=|uniform\s+sampler|\btexture\(|textureLod\(/)
      expect(g).not.toMatch(/\bvec[234]f\b|\blet\s|var<private>|uniforms\.|textureSample/)
    }
  })

  it('vertex taps are explicit-level; implicit-derivative taps only at CUSTOM_FRAGMENT_MAIN_BEGIN (F14)', () => {
    const v = Object.values(oceanCode('vertex', 'wgsl')).join('\n')
    expect(v).toMatch(/textureSampleLevel\(/)
    expect(v.replace(/textureSampleLevel\(/g, '')).not.toMatch(/textureSample\w*\(/)
    for (const [key, code] of Object.entries(oceanCode('fragment', 'wgsl'))) {
      if (key === 'CUSTOM_FRAGMENT_MAIN_BEGIN' || key === 'CUSTOM_FRAGMENT_DEFINITIONS') continue
      expect(code, key).not.toMatch(/textureSample|fwidth|dpdx|dpdy/)
    }
    // Every tap and derivative in MAIN_BEGIN comes before the discard (uniform control flow).
    const main = oceanCode('fragment', 'wgsl').CUSTOM_FRAGMENT_MAIN_BEGIN!
    const cut = main.indexOf('discard;')
    expect(cut).toBeGreaterThan(0)
    expect(main.slice(cut)).not.toMatch(/textureSample|fwidth/)
  })

  it('embeds RND-W\'s constants for the join (frames repeat, the normal layers, the albedo weight, the shore depth)', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = oceanCode('fragment', lang).CUSTOM_FRAGMENT_MAIN_BEGIN!
      expect(code).toContain(`/ ${WATER_FRAME_REPEAT_M.toFixed(1)}`)
      expect(code).toContain(`* ${WATER_ALBEDO_WEIGHT}`)
      expect(code).toContain(`/ ${WATER_SHORE_M}`)
      for (const l of WATER_NORMAL_LAYERS) expect(code).toContain(`/ ${Number.isInteger(l.periodM) ? l.periodM.toFixed(1) : l.periodM}`)
    }
    // …and RND-W's own shader has the same formula shape.
    const rw = waterFragmentCode('glsl').CUSTOM_FRAGMENT_MAIN_BEGIN!
    expect(rw).toContain(`pow(clamp(sroWF * sroWaterB.rgb, 0.0, 1.0), vec3(2.2)) * ${WATER_ALBEDO_WEIGHT.toFixed(2)}`)
    expect(rw).toContain('mix(sroShallow, sroShallow * sroWaterC.rgb, sroDeep)')
  })
})

describe('the ocean material (NullEngine)', () => {
  it('compiles with INSTANCES and the node attribute; one user varying more than the bare PBR mesh; no CSM define', async () => {
    const s = scene()
    const mesh = oceanProbe(s)
    const st = readyState(s)
    const { material } = createOceanMaterial(s, st)
    const on = await compile(s, mesh, material)
    expect(on.defines).toContain('#define INSTANCES')
    expect(on.defines).toContain('#define THIN_INSTANCES')
    expect(on.defines).toContain('#define SRO_OCEAN')
    expect(on.defines).toContain('#define SRO_OCEAN_LERP')
    expect(on.vertex).toContain(`${CDLOD_ATTRIBUTE}`)
    expect(on.defines.some(d => /SHADOWCSM/.test(d))).toBe(false)
    // The same material with the plugin off (no textures): the ocean adds exactly its packed varying.
    const off = new OceanPbrState()
    const bare = createOceanMaterial(s, off).material
    const base = await compile(s, oceanProbe(s), bare)
    const added = varyings(on.vertex).filter(n => !varyings(base.vertex).includes(n))
    expect(added).toEqual([OCEAN_VARYING])
    expect(varyings(on.vertex).length).toBeLessThanOrEqual(15)
    material.dispose()
    bare.dispose()
  })

  it('four cascades and ripples compile too; the shore define stays off with an empty seam', async () => {
    const s = scene()
    const st = readyState(s, { lerp: false, c4: true, ripple: true })
    const { material } = createOceanMaterial(s, st)
    const r = await compile(s, oceanProbe(s), material)
    expect(r.defines).toContain('#define SRO_OCEAN_C4')
    expect(r.defines).toContain('#define SRO_OCEAN_RIPPLE')
    expect(r.defines).not.toContain('#define SRO_OCEAN_LERP')
    expect(r.defines).not.toContain('#define SRO_OCEAN_SHORE')
    material.dispose()
  })

  it('the height fog attaches itself to the ocean on the PBR path (the global registration), and not without it', () => {
    const s = scene()
    const fog = new HeightFog(s)
    fog.setActive(true)
    const { material } = createOceanMaterial(s, readyState(s))
    expect(material.pluginManager?.getPlugin(FOG_PLUGIN_NAME)).toBeTruthy()
    fog.dispose()
    const s2 = scene()
    const other = createOceanMaterial(s2, readyState(s2)).material
    expect(other.pluginManager?.getPlugin(FOG_PLUGIN_NAME) ?? null).toBeNull()
  })
})

describe('the water colour (COAST §8.6)', () => {
  it('alpha = 1 − mean transmittance: clear in the shallows, opaque in deep water; the deep albedo is blue-green', () => {
    expect(waterColour(0).alpha).toBe(0)
    expect(waterColour(1).alpha).toBeLessThan(0.3)
    expect(waterColour(60).alpha).toBeGreaterThan(0.95)
    const d = deepAlbedo()
    expect(d[2]).toBeGreaterThan(d[1])
    expect(d[1]).toBeGreaterThan(d[0])
    // In shallow water the albedo leans to the red less than in deep water (the per-channel tint).
    const s = waterColour(2).albedo, deep = waterColour(40).albedo
    expect(s[0] / s[2]).toBeGreaterThan(deep[0] / deep[2])
  })

  it('the join zone gives RND-W\'s albedo and alpha (both shore modes)', () => {
    const frame = [0.8, 0.9, 0.7], hue = [0.25, 0.69, 0.62], deep = WATER_DEEP
    const lin = frame.map((v, i) => Math.pow(Math.min(1, v * hue[i]!), 2.2) * WATER_ALBEDO_WEIGHT)
    const hi = joinAlbedo(frame, hue, deep, 2, true)
    expect(hi.alpha).toBeCloseTo(Math.min(1, 2 / WATER_SHORE_M), 10)
    for (let c = 0; c < 3; c++) expect(hi.albedo[c]).toBeCloseTo(lin[c]! + (lin[c]! * deep[c]! - lin[c]!) * 0.5, 10)
    const med = joinAlbedo(frame, hue, deep, 1.5, false)
    // The retail per-vertex alpha: trunc(depth × 10 × 0.5) / 15.
    expect(med.alpha).toBeCloseTo(7 / 15, 10)
  })
})

describe('the Classic ocean (Low)', () => {
  it('WGSL and GLSL declare the same attributes, varyings and samplers, and insert the shore seam only under its define', () => {
    const src = classicOceanShaders()
    for (const n of ['position', CDLOD_ATTRIBUTE]) {
      expect(src.vertexWGSL).toContain(`attribute ${n}:`)
      expect(src.vertexGLSL).toMatch(new RegExp(`attribute vec[34] ${n};`))
    }
    for (const v of [OCEAN_VARYING, 'vDepth']) {
      expect(src.vertexWGSL).toContain(`varying ${v}:`)
      expect(src.fragmentGLSL).toContain(` ${v};`)
    }
    expect(src.vertexWGSL).not.toMatch(/textureSample\(/)
    // CST-S filled the seam: its code sits only inside `#ifdef SRO_OCEAN_SHORE` (off on Low: ocean.ts makes the
    // Classic material without the define).
    for (const code of [src.vertexWGSL, src.fragmentWGSL, src.vertexGLSL, src.fragmentGLSL]) {
      expect(code).toContain('#ifdef SRO_OCEAN_SHORE')
      expect(code.replace(/#ifdef SRO_OCEAN_SHORE\n[\s\S]*?\n#endif\n/g, '')).not.toMatch(/\bsroSh[A-Z]|\bsroShoreLace\b/)
    }
    expect(src.vertexGLSL).not.toMatch(/\bvec[234]f\b|\blet\s/)
  })
})

