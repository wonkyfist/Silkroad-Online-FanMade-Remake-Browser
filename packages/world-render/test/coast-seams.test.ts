/**
 * W10-S, coast seams (docs/COAST.md §8.6, §8.10, S-MOVE, F5; docs/WAVE_PLAN6.md §4.1 step 3, D2, D11, D12, D22, D27):
 * the chunk list sky → weather → night → coast → grass tint → render with both new lanes empty builds today's Classic
 * strings in both languages; the PBR terrain's `sroCoastWet` / `sroGrassTint` externs are off (today's plugin code)
 * while their sources are empty, and land under their defines in both languages when a lane fills them; World.ocean
 * is made on every path, updated after the objects, drawn in World.meshes, told the preset's ocean row and disposed;
 * World.coast is its field; World.waterLevelAt gives +5 m over the sea mask, the block plane in the moat and null on
 * dry ground; WaterRenderer.ensurePbrState fills the PBR state without a material; RENDER_PRESETS.ocean holds §8.10.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COAST_CHUNKS,
  COAST_WET_DEFINE,
  COAST_WET_GLSL,
  COAST_WET_WGSL,
  GRASS_TINT_CHUNKS,
  GRASS_TINT_DEFINE,
  GRASS_TINT_GLSL,
  GRASS_TINT_WGSL,
  NIGHT_CHUNKS,
  QUALITY_PRESETS,
  RENDER_GRASS_CHUNKS,
  RENDER_PRESETS,
  SKY_CHUNKS,
  WEATHER_CHUNKS,
  WORLD_SHADER_CHUNKS,
  resolveTerrainFeatures,
  scatterShaders,
  terrainPluginCode,
  terrainShaders,
  waterShaders,
  type OceanFactory,
} from '../src/index.ts'
import { defaultTerrainExterns, parseExtern, type TerrainExterns } from '../src/pbr/terrain-plugin.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { CX, CZ } from './stream-fixture.ts'
import { FakeOcean, w10World, type W10Setup } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

async function world(o: Parameters<typeof w10World>[0] = {}): Promise<W10Setup> {
  const s = await w10World(o)
  cleanups.push(s.dispose)
  return s
}

describe('the shader chunk list (D11)', () => {
  it('is sky → weather → night → coast → grass tint → render, with the two new lanes empty', () => {
    expect(WORLD_SHADER_CHUNKS).toEqual([SKY_CHUNKS, WEATHER_CHUNKS, NIGHT_CHUNKS, COAST_CHUNKS, GRASS_TINT_CHUNKS, RENDER_GRASS_CHUNKS])
    expect(WORLD_SHADER_CHUNKS.indexOf(COAST_CHUNKS)).toBe(3)
    expect(WORLD_SHADER_CHUNKS.indexOf(GRASS_TINT_CHUNKS)).toBe(4)
    expect(COAST_CHUNKS).toEqual({})
    expect(GRASS_TINT_CHUNKS).toEqual({})
    // CST-S fills only the PBR extern (shore-wet.test.ts); its Classic chunk stays empty (Low keeps today's strings).
    expect([COAST_WET_WGSL, COAST_WET_GLSL].every(s => s.includes('sroCoastWet('))).toBe(true)
    // GL-T fills only the PBR extern (grass-chunks.test.ts); its Classic chunk stays empty (Classic never draws the field).
    expect([GRASS_TINT_WGSL, GRASS_TINT_GLSL].every(s => s.includes('sroGrassTint('))).toBe(true)
  })

  it('with both empty, every Classic string (both languages) and name list equals the wave-9 lane list\'s', () => {
    const wave9 = [SKY_CHUNKS, WEATHER_CHUNKS, NIGHT_CHUNKS, RENDER_GRASS_CHUNKS]
    for (const build of [terrainShaders, waterShaders, scatterShaders]) {
      const a = build(WORLD_SHADER_CHUNKS)
      const b = build(wave9)
      expect([a.vertexWGSL, a.fragmentWGSL, a.vertexGLSL, a.fragmentGLSL]).toEqual([b.vertexWGSL, b.fragmentWGSL, b.vertexGLSL, b.fragmentGLSL])
      expect([a.uniforms, a.samplers, a.chunkSamplers]).toEqual([b.uniforms, b.samplers, b.chunkSamplers])
    }
  })
})

/** Lane-shaped externs: the coast field (one texture) and the tint table (uniforms only, no sampler, X6). */
const COAST_FAKE = parseExtern('sroCoastWet',
  'uniform coastField: vec4f;\nvar coastWet: texture_2d<f32>;\nvar coastWetSampler: sampler;\nfn sroCoastWet(p: vec3f) -> f32 {\n  return textureSampleLevel(coastWet, coastWetSampler, p.xz * uniforms.coastField.x + uniforms.coastField.yz, 0.0).r;\n}\n',
  'uniform vec4 coastField;\nuniform sampler2D coastWet;\nfloat sroCoastWet(vec3 p) {\n  return textureLod(coastWet, p.xz * coastField.x + coastField.yz, 0.0).r;\n}\n')
const TINT_FAKE = parseExtern('sroGrassTint',
  'uniform grassTint: vec4f;\nfn sroGrassTint(alb: vec3f, lp: vec2f, wp: vec3f) -> vec3f {\n  return mix(alb, uniforms.grassTint.rgb, uniforms.grassTint.a * step(0.0, lp.x + wp.y));\n}\n',
  'uniform vec4 grassTint;\nvec3 sroGrassTint(vec3 alb, vec2 lp, vec3 wp) {\n  return mix(alb, grassTint.rgb, grassTint.a * step(0.0, lp.x + wp.y));\n}\n')

describe('the PBR terrain externs (sroCoastWet, sroGrassTint)', () => {
  it('are off while their sources are empty: the plugin code equals the code without them, both languages', () => {
    // Both lanes have filled theirs (grass-chunks.test.ts, shore-wet.test.ts): an empty source is a null extern.
    expect(defaultTerrainExterns().coastWet).not.toBeNull()
    const x: TerrainExterns = { ...defaultTerrainExterns(), coastWet: null }
    const head: TerrainExterns = { shelter: x.shelter, cloudShadow: x.cloudShadow, nightSplat: x.nightSplat, grassTint: x.grassTint }
    for (const lang of ['wgsl', 'glsl'] as const) {
      expect(terrainPluginCode(lang, x)).toEqual(terrainPluginCode(lang, head))
      const src = Object.values(terrainPluginCode(lang, x)).join('\n')
      expect(src).not.toContain('sroCoastWet')
      expect(src).not.toContain('sroCw')
    }
  })

  it('filled: both languages call them under their defines with the same keys; the coast raises the wetness to max(weather, coast)', () => {
    const x: TerrainExterns = { ...defaultTerrainExterns(), coastWet: COAST_FAKE, grassTint: TINT_FAKE }
    const w = terrainPluginCode('wgsl', x)
    const g = terrainPluginCode('glsl', x)
    expect(Object.keys(w).sort()).toEqual(Object.keys(g).sort())
    const ws = Object.values(w).join('\n')
    const gs = Object.values(g).join('\n')
    for (const [src, max] of [[ws, 'let wW = max('], [gs, 'float wW = max(']] as const) {
      expect(src).toContain(`#ifdef ${COAST_WET_DEFINE}\n  sroCw = clamp(sroCoastWet(wp), 0.0, 1.0);\n#endif`)
      expect(src).toContain(`#ifdef ${GRASS_TINT_DEFINE}\n  alb = sroGrassTint(alb, lp, wp);\n#endif`)
      expect(src).toContain(max)
      expect(src).toContain('#ifndef SRO_T_WET')
      // The tint comes before the wetness, the coast term before the weather's wet block.
      expect(src.indexOf('sroGrassTint(alb')).toBeLessThan(src.indexOf('sroCw = clamp'))
      expect(src.indexOf('sroCw = clamp')).toBeLessThan(src.indexOf('wW = max('))
    }
    expect(ws).not.toMatch(/\bvec3 |\bfloat |texture\(|textureLod\(/)
    expect(gs).not.toMatch(/\bvec3f\b|\bfn |textureSampleLevel/)
  })

  it('resolve: each needs its source and its terrain define (set by its lane), never on its own', () => {
    const base = { quality: RENDER_PRESETS.medium, sky: SKY_PRESETS.medium }
    const f = (externs: { coastWet?: boolean; grassTint?: boolean }, defs: string[]) =>
      resolveTerrainFeatures({ ...base, externs: { shelter: false, cloudShadow: false, nightSplat: false, ...externs }, defines: { has: n => defs.includes(n) } })
    expect([f({}, []).coastWet, f({}, []).grassTint]).toEqual([false, false])
    expect(f({ coastWet: true }, []).coastWet).toBe(false)
    expect(f({}, [COAST_WET_DEFINE]).coastWet).toBe(false)
    expect(f({ coastWet: true }, [COAST_WET_DEFINE]).coastWet).toBe(true)
    expect(f({ grassTint: true }, [GRASS_TINT_DEFINE]).grassTint).toBe(true)
    expect(f({ grassTint: true }, [COAST_WET_DEFINE]).grassTint).toBe(false)
  })
})

describe('World.ocean, World.coast, World.waterLevelAt (D2, D22)', () => {
  it('the ocean is made on every path, updated after the objects, drawn in World.meshes, told the preset row, disposed', async () => {
    const order: string[] = []
    const made: FakeOcean[] = []
    const ocean = vi.fn<OceanFactory>(host => {
      const o = new FakeOcean(host.scene, 1e9, 5, order)
      made.push(o)
      return o
    })
    const low = await world({ render: 'classic', quality: 'low', parts: { ocean } })
    expect(low.world.ocean).toBe(made[0])
    expect(made[0]!.quality).toEqual(RENDER_PRESETS.low.ocean)
    const s = await world({ render: 'pbr', quality: 'medium', parts: { ocean } })
    const o = made[1]!
    expect(s.world.ocean).toBe(o)
    expect(s.world.meshes()).toContain(o.mesh)
    const objUpdate = s.world.objects.update.bind(s.world.objects)
    vi.spyOn(s.world.objects, 'update').mockImplementation((cam, force) => {
      order.push('objects')
      objUpdate(cam, force)
    })
    s.scene.createDefaultCamera()
    order.length = 0
    s.world.update()
    expect(order).toEqual(['objects', 'ocean'])
    s.world.setQuality({ ...QUALITY_PRESETS.high, render: RENDER_PRESETS.high })
    expect(o.quality).toEqual(RENDER_PRESETS.high.ocean)
    s.dispose()
    expect(o.disposed).toBe(true)
  })

  it('without an ocean: coast null, the retail water plane in its block, null on dry ground', async () => {
    const s = await world({
      render: 'pbr',
      edit: fx => {
        const r = fx.manifest.regions.find(x => x.id === ((CZ << 8) | CX))!
        r.blocks[0]!.water = { kind: 'water', type: 1, wave: 0, heightM: 3 }
        r.blocks[1]!.water = { kind: 'ice', type: 2, wave: 0, heightM: 3 }
      },
    })
    await s.run()
    expect(s.world.ocean).toBeNull()
    expect(s.world.coast).toBeNull()
    const r = s.fx.manifest.regions.find(x => x.id === ((CZ << 8) | CX))!
    const [x0, y0, z0] = r.origin
    expect(s.world.waterLevelAt(x0 + 5, z0 - 5)).toBe(y0 + 3) // block (0, 0): the moat's plane
    expect(s.world.waterLevelAt(x0 + 37, z0 - 5)).toBeNull() // block (1, 0): ice is ground
    expect(s.world.waterLevelAt(x0 + 100, z0 - 100)).toBeNull() // dry ground
    expect(s.world.waterLevelAt(1e6, 1e6)).toBeNull() // outside the world
  })

  it('with the coast field: the sea level over the sea mask, the retail water elsewhere', async () => {
    let seaX = 0
    const s = await world({
      render: 'pbr',
      parts: { ocean: host => new FakeOcean(host.scene, seaX, 5) },
      edit: fx => {
        const r = fx.manifest.regions.find(x => x.id === ((CZ << 8) | CX))!
        seaX = r.origin[0] + 150
        r.blocks[0]!.water = { kind: 'water', type: 1, wave: 0, heightM: 3 }
      },
    })
    await s.run()
    expect(s.world.coast).toBe(s.world.ocean!.coast)
    const r = s.fx.manifest.regions.find(x => x.id === ((CZ << 8) | CX))!
    const [x0, y0, z0] = r.origin
    expect(s.world.waterLevelAt(x0 + 160, z0 - 100)).toBe(5)
    expect(s.world.waterLevelAt(x0 + 5, z0 - 5)).toBe(y0 + 3)
    expect(s.world.waterLevelAt(x0 + 100, z0 - 100)).toBeNull()
  })
})

describe('WaterRenderer seams (F5, D12)', () => {
  it('ensurePbrState fills the frames and the normal once and makes no material; classicFrames gives Low\'s frames', async () => {
    const s = await world({ render: 'classic' })
    const w = s.world.water
    const st = w.ensurePbrState()
    expect(st).toBe(w.pbrState)
    expect(st.normal).not.toBeNull()
    const normal = st.normal
    expect(w.ensurePbrState().normal).toBe(normal)
    expect(w.pbrMaterial).toBeNull()
    const f = w.classicFrames
    expect(f.texture).toBe(st.frames)
    expect(f.count).toBeGreaterThanOrEqual(1)
    expect(f.frameMs).toBeGreaterThan(0)
  })
})

describe('RENDER_PRESETS.ocean (COAST §8.10)', () => {
  it('Low 3 Gerstner waves; Medium the worker FFT 2 × 64² at 20 Hz; High the GPU FFT 4 × 128²; Ultra 4 × 256²', () => {
    const { low, medium, high, ultra } = RENDER_PRESETS
    expect([low.ocean.waves, low.ocean.cascades, low.ocean.grid, low.ocean.levels, low.ocean.reflection, low.ocean.shore]).toEqual(['gerstner', 3, 16, 6, null, 'vertex'])
    expect([medium.ocean.waves, medium.ocean.cascades, medium.ocean.fftSize, medium.ocean.tickHz, medium.ocean.grid, medium.ocean.levels]).toEqual(['worker-fft', 2, 64, 20, 16, 8])
    expect(medium.ocean.reflection).toEqual({ cubeSize: 32, refreshS: 10 })
    expect([high.ocean.waves, high.ocean.cascades, high.ocean.fftSize, high.ocean.grid, high.ocean.shadows, high.ocean.cloudShadows]).toEqual(['gpu-fft', 4, 128, 32, true, 'ground'])
    expect(high.ocean.reflection).toEqual({ cubeSize: 64, refreshS: 5 })
    expect([ultra.ocean.fftSize, ultra.ocean.grid, ultra.ocean.cloudShadows]).toEqual([256, 64, 'all'])
    expect(ultra.ocean.reflection).toEqual({ cubeSize: 64, refreshS: 2 })
    for (const p of [low, medium, high, ultra]) expect(p.ocean.fogCut).toBe(true) // D27
    expect([medium.ocean.foam, high.ocean.foam, low.ocean.foam]).toEqual(['v1', 'whitecaps', 'band'])
  })
})
