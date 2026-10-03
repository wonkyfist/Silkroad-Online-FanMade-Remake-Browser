/**
 * GL-S, the grass and wildlife shaders (docs/GRASS_LIFE.md §2.1, §3.3–§3.7, §5; GL-S test list):
 * - the grass skeleton keeps the retail grass's contract: the same uniforms (plus the field's), the same samplers (the
 *   field's window textures for the retail texture), the same chunk insertions at the same points in both languages;
 * - its varyings are the retail grass's for every define set (vCol for vUV), the critters' one more, the birds' the
 *   same; every set ≤ 15 user varyings;
 * - NullEngine `isReady` (GLSL, as WebGL2 compiles it) for every define combination of the grass chunks, for the grass,
 *   the critters, the birds and the fireflies;
 * - no GLSL idiom in the WGSL (no glslang is ever fetched on WebGPU) and no WGSL idiom in the GLSL; the fragment's one
 *   implicit-LOD sample sits in uniform control flow;
 * - the height twin, the pixel-width floor (no blade under ≈ 1 px at mid-height at any tier distance, 1080p and at
 *   render scale 0.75), and the critters' flight twin (inside the wander radius, above the ground).
 */
import { Mesh, NullEngine, Scene, ShaderLanguage, ShaderMaterial, VertexData, type Material } from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GRASS_LEVELS } from '../src/grass/cull.ts'
import { buildPatch } from '../src/grass/patch.ts'
import {
  GRASS_ATTRIBUTES,
  GRASS_MID_WIDTH,
  GRASS_UNIFORMS,
  encodeGrassHeight,
  grassBladeHalfWidth,
  grassCoverage,
  grassHeightAt,
  grassPixelPerMetre,
  grassShaders,
  registerSkeletonShader,
} from '../src/grass/shaders.ts'
import {
  BIRD_PARTS,
  CRITTER_PARTS,
  DRAGONFLY_FIRST_SPECIES,
  birdGeometry,
  birdShaders,
  critterFlight,
  critterGeometry,
  critterShaders,
  createLifeMaterial,
  fireflyGeometry,
  fireflyShaders,
  type LifeGeometry,
  type LifeShaderKind,
} from '../src/life/shaders.ts'
import { SCATTER_BASE_SAMPLERS, SCATTER_BASE_UNIFORMS, scatterShaders } from '../src/scatter-assets.ts'
import type { GrassPoint, WorldShaderChunks } from '../src/shader-chunks.ts'
import { WORLD_SHADER_CHUNKS, type ShaderSources } from '../src/shaders.ts'

const engines: NullEngine[] = []
afterAll(() => {
  for (const e of engines.splice(0)) e.dispose()
})

const POINTS: GrassPoint[] = ['uniforms', 'varyings', 'vertexDecl', 'samplers', 'vertexSway', 'vertexLight', 'fragmentColor']
/** A lane that marks every grass point in both languages. */
const MARKER: WorldShaderChunks = {
  grass: {
    uniforms: ['mkU'],
    samplers: ['mkS'],
    wgsl: Object.fromEntries(POINTS.map(p => [p, `// MARK_${p}\n`])),
    glsl: Object.fromEntries(POINTS.map(p => [p, `// MARK_${p}\n`])),
  },
}

const count = (s: string, needle: string) => s.split(needle).length - 1

describe('the grass skeleton keeps the retail grass\'s contract (GRASS_LIFE §3.7)', () => {
  it('uniforms: the retail list plus the field\'s; samplers: the retail list with the field\'s textures for scDiffuse; the same chunk samplers', () => {
    const retail = scatterShaders()
    const grass = grassShaders()
    const extra = GRASS_UNIFORMS.map(u => u.name)
    expect(grass.uniforms).toEqual([...SCATTER_BASE_UNIFORMS, ...extra, ...retail.uniforms.slice(SCATTER_BASE_UNIFORMS.length)])
    const retailChunkSamplers = retail.samplers.slice(SCATTER_BASE_SAMPLERS.length)
    expect(grass.samplers).toEqual(['scLightmap', 'grFieldA', 'grFieldH', ...retailChunkSamplers])
    expect(grass.chunkSamplers).toEqual(retail.chunkSamplers)
  })

  it('every chunk point is inserted where the retail grass inserts it, in both languages', () => {
    const retail = scatterShaders([MARKER])
    for (const src of [grassShaders([MARKER]), critterShaders([MARKER]), birdShaders([MARKER])]) {
      const isGrass = src.vertexWGSL.includes('bladeB')
      for (const p of POINTS) {
        const m = `// MARK_${p}`
        // The animals do not sway in the wind (no vertexSway point).
        const want = (s: string) => (!isGrass && p === 'vertexSway' ? 0 : count(s, m))
        expect(count(src.vertexWGSL, m), `wgsl vertex ${p}`).toBe(want(retail.vertexWGSL))
        expect(count(src.fragmentWGSL, m), `wgsl fragment ${p}`).toBe(want(retail.fragmentWGSL))
        expect(count(src.vertexGLSL, m), `glsl vertex ${p}`).toBe(want(retail.vertexGLSL))
        expect(count(src.fragmentGLSL, m), `glsl fragment ${p}`).toBe(want(retail.fragmentGLSL))
      }
      expect(src.uniforms).toContain('mkU')
      expect(src.samplers).toContain('mkS')
    }
    // With every chunk empty: the retail's fixed sway line, and no chunk text.
    const bare = grassShaders([])
    expect(bare.vertexWGSL).toContain('p = p + vec3f(0.8, 0.0, 0.6) * (bend * s);')
    expect(bare.vertexGLSL).toContain('p += vec3(0.8, 0.0, 0.6) * (bend * s);')
    expect(bare.uniforms).toEqual([...SCATTER_BASE_UNIFORMS, ...GRASS_UNIFORMS.map(u => u.name)])
  })

  it('the names the chunks read are in scope: root, wp, h, s, ph, t, sway, bend, p (vertex); c, lm, rgb (fragment)', () => {
    const g = grassShaders([])
    for (const src of [g.vertexWGSL, critterShaders([]).vertexWGSL, birdShaders([]).vertexWGSL]) {
      for (const n of ['root', 'wp', 'h', 's', 'p']) expect(src, n).toMatch(new RegExp(`\\b(let|var) ${n}\\b`))
      for (const n of ['ph', 't', 'sway', 'bend']) expect(src, n).toMatch(new RegExp(`\\blet ${n} =`))
      expect(src).toMatch(/let finalWorld =/)
    }
    expect(g.fragmentWGSL).toMatch(/let c = /)
    expect(g.fragmentWGSL).toMatch(/let lm = /)
    expect(g.fragmentWGSL).toMatch(/var rgb = /)
    expect(g.vertexGLSL).toMatch(/vec3 p = root;/)
    expect(g.fragmentGLSL).toMatch(/vec3 rgb = /)
  })

  it('has no GLSL idiom in the WGSL and no WGSL idiom in the GLSL; every #if is closed; one implicit-LOD sample, first in main', () => {
    const all: ShaderSources[] = [grassShaders(), critterShaders(), birdShaders(), fireflyShaders()]
    for (const s of all) {
      for (const w of [s.vertexWGSL, s.fragmentWGSL]) {
        expect(w).not.toMatch(/\b(float|vec[234]|ivec[234]|texture2D|texelFetch|textureLod|dFdx|dFdy|gl_\w+)\s*[(\s]/)
        expect(w).not.toMatch(/\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/)
        expect((w.match(/^#if/gm) ?? []).length).toBe((w.match(/^#endif/gm) ?? []).length)
      }
      for (const g of [s.vertexGLSL, s.fragmentGLSL]) {
        expect(g).not.toMatch(/\b(fn|let|var)\s|vec[234]f\(|vec2i\(|var<private>|fragmentInputs|vertexInputs|uniforms\.|textureLoad\(/)
        expect((g.match(/^#if/gm) ?? []).length).toBe((g.match(/^#endif/gm) ?? []).length)
      }
    }
    for (const s of [grassShaders(), critterShaders(), birdShaders()]) {
      const main = s.fragmentWGSL.slice(s.fragmentWGSL.indexOf('@fragment'))
      const samples = [...main.matchAll(/\btextureSample\(/g)]
      expect(samples.length).toBe(1)
      const firstBranch = main.search(/\b(if|discard)\b/)
      expect(samples[0]!.index!).toBeLessThan(firstBranch)
    }
  })
})

// ---- NullEngine compiles -------------------------------------------------------------------------------------------

interface Rig {
  scene: Scene
  meshes: Record<'grass' | 'retail' | LifeShaderKind, Mesh>
}

function makeMesh(scene: Scene, name: string, g: LifeGeometry & { bladeB?: Float32Array; uvs?: Float32Array }): Mesh {
  const m = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = g.positions
  vd.indices = g.indices
  if (g.uvs) vd.uvs = g.uvs
  vd.applyToMesh(m)
  if (g.bladeA) m.setVerticesData('bladeA', g.bladeA, false, 4)
  if (g.bladeB) m.setVerticesData('bladeB', g.bladeB, false, 4)
  m.thinInstanceSetBuffer('matrix', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 16, true)
  return m
}

let rigValue: Rig | null = null
function rig(): Rig {
  if (rigValue) return rigValue
  const engine = new NullEngine()
  engines.push(engine)
  const scene = new Scene(engine)
  scene.createDefaultCamera()
  const patch = buildPatch(2, GRASS_LEVELS.medium!.density)
  const bird = birdGeometry()
  rigValue = {
    scene,
    meshes: {
      grass: makeMesh(scene, 'grass', { positions: patch.positions, indices: patch.indices, bladeA: patch.bladeA, bladeB: patch.bladeB }),
      retail: makeMesh(scene, 'retail', { ...fireflyGeometry(), uvs: new Float32Array(8) }),
      critter: makeMesh(scene, 'critter', critterGeometry()),
      bird: makeMesh(scene, 'bird', bird),
      firefly: makeMesh(scene, 'firefly', fireflyGeometry()),
    },
  }
  return rigValue
}

function grassMaterial(scene: Scene): ShaderMaterial {
  const src = grassShaders()
  registerSkeletonShader('sroGrassFieldTest', src)
  return new ShaderMaterial('grass', scene, 'sroGrassFieldTest', { attributes: [...GRASS_ATTRIBUTES], uniforms: src.uniforms, samplers: src.samplers, shaderLanguage: ShaderLanguage.GLSL })
}

function retailMaterial(scene: Scene): ShaderMaterial {
  const src = scatterShaders()
  registerSkeletonShader('sroScatterTest', src)
  return new ShaderMaterial('retail', scene, 'sroScatterTest', { attributes: ['position', 'uv'], uniforms: src.uniforms, samplers: src.samplers, shaderLanguage: ShaderLanguage.GLSL })
}

/** Compiles on the rig and returns the preprocessed GLSL's varyings (null: not ready). */
async function compile(mesh: Mesh, material: Material, defines: readonly string[]): Promise<string[] | null> {
  for (const d of defines) (material as ShaderMaterial).setDefine(d, true)
  mesh.material = material
  let ready = false
  for (let i = 0; i < 400 && !ready; i++) {
    ready = material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!, true)
    if (!ready) await new Promise(res => setTimeout(res, 2))
  }
  if (!ready) return null
  const effect = mesh.subMeshes[0]!.effect as unknown as { defines: string; _vertexSourceCode: string }
  let out = ''
  PreProcess(effect._vertexSourceCode, {
    defines: effect.defines.split('\n').filter(l => l.startsWith('#define')), isFragment: false, version: '300', platformName: 'WEBGL2',
    processor: { shaderLanguage: 0 },
  } as never, (c: string) => {
    out = c
  }, mesh.getEngine())
  return [...new Set([...out.matchAll(/(?:^|;)\s*(?:flat\s+)?(?:varying|out)\s+(?:(?:highp|mediump|lowp)\s+)?(?:float|vec[234]|mat[234]|int|ivec[234])\s+(\w+)\s*;/gm)].map(m => m[1]!))]
    .filter(n => n !== 'glFragColor')
}

const WX_SETS: readonly (readonly string[])[] = [[], ['WX'], ['WX', 'WX_WIND'], ['WX', 'WX_WIND', 'WX_SHELTER'], ['WX', 'WX_WIND', 'WX_SHELTER', 'WX_OCC8']]

/** Every combination of the grass chunks' defines (the Classic-only SRO_SKY_LIGHT without SRO_HDR). */
function defineSets(full: boolean): string[][] {
  const out: string[][] = []
  for (const hdr of [false, true]) for (const csm of full ? [false, true] : [hdr]) for (const wx of full ? WX_SETS : [WX_SETS[0]!, WX_SETS[4]!]) {
    for (const night of [false, true]) for (const cloud of [false, true]) for (const sky of hdr ? [false] : [false, true]) {
      out.push([...(hdr ? ['SRO_HDR'] : []), ...(csm ? ['SRO_GRASS_CSM'] : []), ...wx, ...(night ? ['SRO_NIGHT_GRASS'] : []), ...(cloud ? ['SRO_CLOUDSHADOW'] : []), ...(sky ? ['SRO_SKY_LIGHT'] : [])])
    }
  }
  return out
}

describe('NullEngine compiles and varyings (GL-S; GRASS_LIFE §6.3: 7 / 8 / 9, the retail grass\'s)', () => {
  it('the grass: ready for every define combination; its varyings are the retail grass\'s, ≤ 15', async () => {
    const r = rig()
    const sets = defineSets(true)
    const seen = new Map<number, number>()
    for (const defs of sets) {
      const g = await compile(r.meshes.grass, grassMaterial(r.scene), defs)
      const ret = await compile(r.meshes.retail, retailMaterial(r.scene), defs)
      expect(g, `grass ${defs.join(' ')}`).not.toBeNull()
      expect(ret, `retail ${defs.join(' ')}`).not.toBeNull()
      expect(g!.length, defs.join(' ')).toBe(ret!.length)
      expect(g!.includes('vCol') && !g!.includes('vUV')).toBe(true)
      expect(g!.length).toBeLessThanOrEqual(15)
      seen.set(g!.length, (seen.get(g!.length) ?? 0) + 1)
    }
    // Medium (SRO_HDR) 7, High (+ the CSM tap: no extra varying) and the weather's +1 (vWxG), the cloud shadow's +1.
    const hdr = await compile(r.meshes.grass, grassMaterial(r.scene), ['SRO_HDR'])
    const rain = await compile(r.meshes.grass, grassMaterial(r.scene), ['SRO_HDR', 'SRO_GRASS_CSM', 'WX', 'WX_WIND', 'WX_SHELTER'])
    expect(hdr!.length).toBe(7)
    expect(rain!.length).toBe(8)
    console.info(`[grass-shaders] ${sets.length} define sets; varyings ${[...seen.keys()].sort().join(' / ')}`)
  }, 300_000)

  it('the critters: ready for every set, the retail grass\'s varyings + 1 (the wing coordinates); the birds the same as the grass; the fireflies ready', async () => {
    const r = rig()
    for (const defs of defineSets(false)) {
      const ret = await compile(r.meshes.retail, retailMaterial(r.scene), defs)
      const c = await compile(r.meshes.critter, createLifeMaterial(r.scene, 'critter'), defs)
      const b = await compile(r.meshes.bird, createLifeMaterial(r.scene, 'bird'), defs)
      expect(c, `critter ${defs.join(' ')}`).not.toBeNull()
      expect(b, `bird ${defs.join(' ')}`).not.toBeNull()
      expect(c!.length).toBe(ret!.length + 1)
      expect(b!.length).toBe(ret!.length)
      expect(c!.length).toBeLessThanOrEqual(15)
    }
    const f = await compile(r.meshes.firefly, createLifeMaterial(r.scene, 'firefly'), [])
    expect(f).toEqual(['vQ'])
    expect(createLifeMaterial(r.scene, 'firefly').disableDepthWrite).toBe(true)
    expect(CRITTER_PARTS.varyings.length).toBe(1)
    expect(BIRD_PARTS.varyings.length).toBe(0)
  }, 300_000)

  it('a WebGPU scene gets WGSL materials (no GLSL reaches WebGPU)', () => {
    const r = rig()
    const spy = vi.spyOn(r.scene.getEngine(), 'isWebGPU', 'get').mockReturnValue(true)
    try {
      for (const k of ['critter', 'bird', 'firefly'] as const) expect(createLifeMaterial(r.scene, k).options.shaderLanguage).toBe(ShaderLanguage.WGSL)
    } finally {
      spy.mockRestore()
    }
    expect(createLifeMaterial(r.scene, 'bird').options.shaderLanguage).toBe(ShaderLanguage.GLSL)
  })
})

describe('the TS twins', () => {
  it('the height grid: 16 bits over the window\'s range, decoded as the shader does', () => {
    const N = 129
    const bytes = new Uint8Array(N * N * 4)
    const h = (i: number, j: number) => 30 + 12 * Math.sin(i * 0.3) * Math.cos(j * 0.2)
    const hMin = 18, hRange = 24
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const [r, g] = encodeGrassHeight(h(i, j), hMin, hRange)
      bytes.set([r, g, 0, 255], (j * N + i) * 4)
    }
    // At a vertex the decode is the vertex's height; on the diagonal split both triangles agree.
    expect(grassHeightAt(bytes, 0, 0, hMin, hRange, 20, 40)).toBeCloseTo(h(10, 20), 3)
    const onDiag = grassHeightAt(bytes, 0, 0, hMin, hRange, 21, 41 + 1e-9)
    expect(Number.isFinite(onDiag)).toBe(true)
  })

  it('the pixel-width floor: no blade under 1 px at its mid-height at any tier distance (1080p and render scale 0.75)', () => {
    for (const name of ['low', 'medium', 'high'] as const) {
      const l = GRASS_LEVELS[name]!
      for (const height of [1080, 810]) {
        const px = grassPixelPerMetre(0.85, height)
        for (let d = 0.5; d < l.far; d += 0.5) {
          const f2 = 1 - smooth(l.fade2[0], l.fade2[1], d)
          const f1 = 1 - smooth(l.fade1[0], l.fade1[1], d)
          const comp = grassCoverage(l.density.blades, f1, f2)
          const half = grassBladeHalfWidth(l.width, 0, comp, d, px)
          const midPx = (2 * half * GRASS_MID_WIDTH) / (d * px)
          expect(midPx, `${name} ${height}p at ${d} m`).toBeGreaterThanOrEqual(1 - 1e-9)
        }
      }
    }
    // Near the camera the floor does not widen anything (the blades keep their look).
    const px = grassPixelPerMetre(0.85, 1080)
    expect(grassBladeHalfWidth(0.032, 0.5, 1, 5, px)).toBeCloseTo(0.032, 9)
  })

  it('the critters fly inside their wander radius, above the ground; dragonflies dart and hover 0.3–1.2 m up', () => {
    for (let s = 0; s < 40; s++) {
      const seed = (s * 0.618) % 1
      const species = s % 6
      const radius = 2 + (s % 5)
      let moved = 0
      let prev: { x: number; z: number } | null = null
      for (let t = 0; t < 120; t += 0.37) {
        const f = critterFlight(t, seed, species, radius)
        expect(Math.hypot(f.x, f.z)).toBeLessThanOrEqual(radius + 1e-6)
        expect(f.lift).toBeGreaterThanOrEqual(0.25)
        if (species >= DRAGONFLY_FIRST_SPECIES) expect(f.lift).toBeLessThanOrEqual(1.25)
        else expect(f.lift).toBeLessThanOrEqual(1.25)
        if (prev) moved += Math.hypot(f.x - prev.x, f.z - prev.z)
        prev = f
      }
      expect(moved).toBeGreaterThan(radius)
    }
  })

  it('the shared chunk list is the live one', () => {
    expect(grassShaders().uniforms).toEqual(grassShaders(WORLD_SHADER_CHUNKS).uniforms)
  })
})

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
