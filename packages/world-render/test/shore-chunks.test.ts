/**
 * CST-S, shore v1's code and part (docs/COAST.md §8.6, §8.8, §12.5; shore/chunks.ts, shore/index.ts, coast/chunks.ts):
 * - the seam code: both languages in both stages, no GLSL in the WGSL and no WGSL in the GLSL, explicit-level taps in
 *   the vertex stage, implicit taps only of the lace in the fragment's main (uniform control flow, F14), no varying and
 *   no attribute, every name `sroSh…`;
 * - the PBR ocean compiles on NullEngine with the shore live (SRO_OCEAN_SHORE) and adds no varying, and its samplers
 *   carry the lace;
 * - the terrain extern `sroCoastWet`: one sampler (the coast field), two vec4 uniforms, the world position as its
 *   argument, no varying, both languages; Low's Classic chunk stays empty;
 * - the part: the lace is generated in slices, then `ready`; the cycle counter advances by dt / T across the ocean
 *   clock's wrap; it binds its uniforms and the lace; on the PBR path it installs the terrain's wet band (the define
 *   and the shared field, transform and swash state), and removes them on the Classic path and on dispose.
 */
import { MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, Vector4, type Mesh } from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { afterAll, describe, expect, it } from 'vitest'
import { COAST_CHUNKS, COAST_WET_DEFINE, COAST_WET_FIELD, COAST_WET_GLSL, COAST_WET_SHORE, COAST_WET_WGSL, COAST_WET_XF } from '../src/coast/chunks.ts'
import { CDLOD_MAX_NODES } from '../src/ocean/cdlod.ts'
import { CDLOD_ATTRIBUTE, OceanPbrState, createOceanMaterial } from '../src/ocean/ocean-plugin.ts'
import { SHORE_DEFINE, shoreHasCode, type ShoreBinder, type ShoreFrame, type ShorePart } from '../src/ocean/shore-seam.ts'
import { defaultTerrainExterns, terrainPluginCode } from '../src/pbr/terrain-plugin.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { SharedUniforms } from '../src/shader-chunks.ts'
import { SHORE_FRAGMENT, SHORE_SAMPLERS, SHORE_UNIFORMS, SHORE_VERTEX } from '../src/shore/chunks.ts'
import { Shore, shorePeriod } from '../src/shore/index.ts'
import { PHASE_WRAP } from '../src/shore/swash.ts'

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

const NO_GLSL_IN_WGSL = /\bvec[234] |\bfloat |\btexture\(|\btextureLod\(|\buniform sampler/
const NO_WGSL_IN_GLSL = /\bvec[234]f\b|\bfn |\blet |\bvar\b|textureSample|\bselect\(|\buniforms\./

describe('the shore seam code (shore/chunks.ts)', () => {
  it('fills both stages in both languages; uniforms and samplers are the shore\'s own', () => {
    expect(shoreHasCode(SHORE_VERTEX)).toBe(true)
    expect(shoreHasCode(SHORE_FRAGMENT)).toBe(true)
    for (const code of [SHORE_VERTEX, SHORE_FRAGMENT]) for (const lang of ['wgsl', 'glsl'] as const) {
      expect(code[lang].definitions.length).toBeGreaterThan(0)
      expect(code[lang].main.length).toBeGreaterThan(0)
    }
    expect(SHORE_UNIFORMS).toEqual(['sroShoreA', 'sroShoreB'])
    expect(SHORE_SAMPLERS).toEqual(['sroShoreLace'])
  })

  it('no GLSL in the WGSL, no WGSL in the GLSL; no varying, no attribute; every function is sroSh…', () => {
    for (const code of [SHORE_VERTEX, SHORE_FRAGMENT]) {
      const w = code.wgsl.definitions + code.wgsl.main
      const g = code.glsl.definitions + code.glsl.main
      expect(w).not.toMatch(NO_GLSL_IN_WGSL)
      expect(g).not.toMatch(NO_WGSL_IN_GLSL)
      for (const src of [w, g]) {
        expect(src).not.toMatch(/\bvarying\b|\battribute\b/)
        for (const m of src.matchAll(/\bfn (\w+)|^(?:float|vec[234]) (\w+)\(/gm)) expect(m[1] ?? m[2]).toMatch(/^sroSh/)
      }
    }
  })

  it('the vertex stage taps at an explicit level; the fragment\'s implicit taps are the lace\'s, in main', () => {
    const v = SHORE_VERTEX.wgsl.definitions + SHORE_VERTEX.wgsl.main
    expect(v).not.toMatch(/textureSample\(/)
    expect(v).toMatch(/textureSampleLevel\(sroOcFieldMap/)
    expect(SHORE_VERTEX.glsl.definitions + SHORE_VERTEX.glsl.main).not.toMatch(/\btexture\(/)
    expect(SHORE_FRAGMENT.wgsl.definitions).not.toMatch(/textureSample\(/)
    const implicit = [...SHORE_FRAGMENT.wgsl.main.matchAll(/textureSample\((\w+)/g)].map(m => m[1])
    expect(implicit.length).toBe(2)
    expect(new Set(implicit)).toEqual(new Set(['sroShoreLace']))
    expect([...SHORE_FRAGMENT.glsl.main.matchAll(/\btexture\((\w+)/g)].map(m => m[1])).toEqual(['sroShoreLace', 'sroShoreLace'])
    // The fragment declares its sampler; the vertex stage none.
    expect(SHORE_FRAGMENT.wgsl.definitions).toContain('var sroShoreLace: texture_2d<f32>;')
    expect(SHORE_FRAGMENT.glsl.definitions).toContain('uniform sampler2D sroShoreLace;')
  })

  it('reads and writes only the seam\'s variables (the sheet, the position, the foam)', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      expect(SHORE_VERTEX[lang].main).toContain('sroOcSwash = shSheet')
      expect(SHORE_VERTEX[lang].main).toMatch(/sroOcPos\.y = max\(sroOcPos\.y/)
      expect(SHORE_FRAGMENT[lang].main).toContain('sroOcFoam = max(sroOcFoam')
      expect(SHORE_FRAGMENT[lang].main).toContain('sroOcSwash - shE')
    }
  })
})

/** A thin-instanced grid like the ocean's. */
function probe(s: Scene): Mesh {
  const mesh = MeshBuilder.CreateGround('probe', { width: 1, height: 1, subdivisions: 4 }, s)
  const m = new Float32Array(CDLOD_MAX_NODES * 16)
  for (let i = 0; i < CDLOD_MAX_NODES; i++) m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16)
  mesh.thinInstanceSetBuffer('matrix', m, 16, true)
  mesh.thinInstanceSetBuffer(CDLOD_ATTRIBUTE, new Float32Array(CDLOD_MAX_NODES * 4), 4, false)
  mesh.thinInstanceCount = 3
  return mesh
}

function stubShore(tex: RawTexture): ShorePart {
  const v = new Vector4(0, 9, 0.4, 0.5)
  return {
    ready: true,
    update() {},
    bind(b: ShoreBinder) {
      b.vec4('sroShoreA', v)
      b.vec4('sroShoreB', v)
      b.texture('sroShoreLace', tex)
    },
    dispose() {},
  }
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

describe('the PBR ocean with the shore live (NullEngine)', () => {
  it('compiles with SRO_OCEAN_SHORE, adds no varying, and samples the lace', async () => {
    const s = scene()
    const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, s)
    const mk = (shore: boolean) => {
      const st = new OceanPbrState()
      st.waves = st.field = st.normal = st.frames = tex
      if (shore) st.shore = stubShore(tex)
      st.setSwitches({ lerp: true, cascades4: false, ripple: null })
      return createOceanMaterial(s, st).material
    }
    const off = await compile(s, probe(s), mk(false))
    const on = await compile(s, probe(s), mk(true))
    expect(off.defines).not.toContain(`#define ${SHORE_DEFINE}`)
    expect(on.defines).toContain(`#define ${SHORE_DEFINE}`)
    expect(varyings(on.vertex).sort()).toEqual(varyings(off.vertex).sort())
    expect(on.fragment).toContain('sroShoreLace')
    expect(on.vertex).toContain('sroShCycle')
    expect(on.fragment).toMatch(/uniform\s+(?:\w+\s+)?sampler2D\s+sroShoreLace;/)
  })
})

describe('the terrain wet band extern (coast/chunks.ts)', () => {
  it('Low\'s Classic chunk stays empty; the PBR extern is filled in both languages', () => {
    expect(COAST_CHUNKS).toEqual({})
    const x = defaultTerrainExterns().coastWet
    expect(x).not.toBeNull()
    expect(x!.arg).toBe('vec3')
    expect(x!.samplers).toEqual([COAST_WET_FIELD])
    expect(x!.uniforms.map(u => u.name).sort()).toEqual([COAST_WET_SHORE, COAST_WET_XF].sort())
    expect(x!.uniforms.every(u => u.type === 'vec4')).toBe(true)
    expect(COAST_WET_WGSL).not.toMatch(NO_GLSL_IN_WGSL)
    expect(COAST_WET_GLSL).not.toMatch(/\bvec[234]f\b|\bfn |\blet |\bvar\b|textureSample|\bselect\(|\buniforms\./)
    for (const src of [COAST_WET_WGSL, COAST_WET_GLSL]) {
      expect(src).not.toMatch(/\bvarying\b|\battribute\b|vPositionW/)
      expect(src).toContain('sroCoastWet(')
    }
    // Explicit-level taps only (the call sits after the splat loop: non-uniform control flow).
    expect(COAST_WET_WGSL).not.toMatch(/textureSample\(/)
    expect(COAST_WET_GLSL).not.toMatch(/\btexture\(/)
  })

  it('lands under SRO_COAST_WET in the plugin code of both languages, with the same keys', () => {
    const w = terrainPluginCode('wgsl')
    const g = terrainPluginCode('glsl')
    expect(Object.keys(w).sort()).toEqual(Object.keys(g).sort())
    for (const src of [Object.values(w).join('\n'), Object.values(g).join('\n')]) {
      expect(src).toContain(`#ifdef ${COAST_WET_DEFINE}\n  sroCw = clamp(sroCoastWet(wp), 0.0, 1.0);\n#endif`)
      expect(src).toContain('sroCwNoise')
    }
  })
})

// ---- the part --------------------------------------------------------------------------------------------------

function host(s: Scene) {
  const defines = new Set<string>()
  const shared = new SharedUniforms()
  const fieldTex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, s)
  const xf = new Vector4(1 / 5376, 1 / 3840, 0.643, 0.45)
  const terrain = {
    sharedUniforms: shared,
    setDefine(name: string, on: boolean) {
      if (on) defines.add(name)
      else defines.delete(name)
    },
  }
  return {
    h: { scene: s, world: { terrain } as never, field: { xf, texture: () => fieldTex } as never },
    defines,
    shared,
    fieldTex,
    xf,
  }
}

function frame(o: Partial<ShoreFrame> = {}): ShoreFrame {
  return { time: 0, seaLevelM: 5, hs: 0.5, periodS: 9, swellDir: [0, -1], storm: 0, rain: 0, quality: RENDER_PRESETS.medium.ocean, path: 'pbr', ...o }
}

describe('the shore part (shore/index.ts)', () => {
  it('is ready once the lace is generated (in slices), binds its uniforms and the lace', () => {
    const s = scene()
    const { h } = host(s)
    const queue: Array<() => void> = []
    const shore = new Shore(h, { laceSize: 32, schedule: fn => void queue.push(fn) })
    expect(shore.ready).toBe(false)
    return (async () => {
      while (queue.length) queue.shift()!()
      await new Promise(r => setTimeout(r, 0))
      expect(shore.ready).toBe(true)
      const bound: Record<string, unknown> = {}
      shore.bind({ vec4: (n, v) => void (bound[n] = v), texture: (n, t) => void (bound[n] = t) })
      expect(Object.keys(bound).sort()).toEqual([...SHORE_UNIFORMS, ...SHORE_SAMPLERS].sort())
      expect(bound.sroShoreLace).toBe(shore.laceTexture)
      shore.dispose()
      expect(shore.laceTexture).toBeNull()
    })()
  })

  it('advances the cycle counter by dt / T, across the ocean clock\'s wrap, and wraps it at PHASE_WRAP', () => {
    const s = scene()
    const shore = new Shore(host(s).h, { laceSize: 8, schedule: () => {} })
    shore.update(frame({ time: 3599.9 }))
    expect(shore.a.x).toBe(0)
    shore.update(frame({ time: 3599.99 }))
    expect(shore.a.x).toBeCloseTo(0.09 / 9, 6)
    // The clock wraps 3,600 → 0: the counter keeps advancing.
    shore.update(frame({ time: 0.01 }))
    expect(shore.a.x).toBeCloseTo(0.11 / 9, 6)
    // A long stall advances at most 0.25 s.
    shore.update(frame({ time: 100 }))
    expect(shore.a.x).toBeCloseTo((0.11 + 0.25) / 9, 6)
    // The period never drops to the wind sea's chop: a swell's 8.5 s calm, 11 s in a storm, the sea's own if longer.
    expect(shorePeriod(3.2, 0)).toBe(8.5)
    expect(shorePeriod(3.2, 1)).toBe(11)
    expect(shorePeriod(12, 0)).toBe(12)
    expect(shorePeriod(30, 0)).toBe(14)
    shore.a.x = PHASE_WRAP - 0.001
    shore.update(frame({ time: 100.09 }))
    expect(shore.a.x).toBeGreaterThanOrEqual(0)
    expect(shore.a.x).toBeLessThan(0.02)
    // The run-up and the swell height follow Hs; the preset row picks the lace and the bead.
    expect(shore.a.z).toBeGreaterThan(0.2)
    shore.update(frame({ time: 100.1, quality: RENDER_PRESETS.low.ocean }))
    expect([shore.b.z, shore.b.w]).toEqual([0, 0])
    shore.update(frame({ time: 100.2 }))
    expect([shore.b.z, shore.b.w]).toEqual([1, 1])
    shore.dispose()
  })

  it('installs the terrain wet band on the PBR path, removes it on the Classic path and on dispose', () => {
    const s = scene()
    const { h, defines, shared, fieldTex, xf } = host(s)
    const shore = new Shore(h, { laceSize: 8, schedule: () => {} })
    expect(defines.has(COAST_WET_DEFINE)).toBe(false)
    shore.update(frame({ path: 'pbr', time: 1 }))
    expect(defines.has(COAST_WET_DEFINE)).toBe(true)
    expect(shared.get(COAST_WET_FIELD)).toBe(fieldTex)
    expect((shared.get(COAST_WET_XF) as Vector4).equals(xf)).toBe(true)
    const st = shared.get(COAST_WET_SHORE) as Vector4
    expect(st.w).toBe(5)
    expect(st.z).toBe(shore.a.z)
    shore.update(frame({ path: 'classic', time: 1.1 }))
    expect(defines.has(COAST_WET_DEFINE)).toBe(false)
    expect([shared.has(COAST_WET_FIELD), shared.has(COAST_WET_XF), shared.has(COAST_WET_SHORE)]).toEqual([false, false, false])
    shore.update(frame({ path: 'pbr', time: 1.2 }))
    expect(defines.has(COAST_WET_DEFINE)).toBe(true)
    shore.dispose()
    expect(defines.has(COAST_WET_DEFINE)).toBe(false)
    expect(shared.size).toBe(0)
  })
})
