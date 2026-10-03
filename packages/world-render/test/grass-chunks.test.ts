/**
 * GL-T, the terrain grass tint (docs/GRASS_LIFE.md §3.3 "beyond the far tier", X6; docs/WAVE_PLAN6.md D11, D13, the
 * GL-T row): with `SRO_GRASS_TINT` off the PBR terrain's code is today's (the extern and its call sit behind the
 * define) and the Classic strings are HEAD's (the Classic chunk is empty: Classic never draws the field); on, both
 * languages declare and call the same function; the extern reads a per-tile uniform table and **no sampler**, so the
 * texture units do not change (D32); the table packs one byte per layer exactly; the runtime switches the define with
 * the field and follows the atlas' layers and the field's level; a World turns it on on the PBR path with the field
 * only.
 */
import { Matrix, NullEngine, Scene, Vector4 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GRASS_TINT_CHUNKS,
  GRASS_TINT_DEFINE,
  GRASS_TINT_GLSL,
  GRASS_TINT_WGSL,
  NIGHT_CHUNKS,
  RENDER_GRASS_CHUNKS,
  RENDER_PRESETS,
  SKY_CHUNKS,
  TerrainPbr,
  WEATHER_CHUNKS,
  WORLD_SHADER_CHUNKS,
  resolveTerrainFeatures,
  terrainPluginCode,
  terrainShaders,
} from '../src/index.ts'
import { COAST_CHUNKS } from '../src/coast/chunks.ts'
import {
  GRASS_TINT_FADE_UNIFORM,
  GRASS_TINT_LAYERS,
  GRASS_TINT_LOOK_UNIFORM,
  GRASS_TINT_PALETTE_UNIFORM,
  GRASS_TINT_SLOTS,
  GRASS_TINT_TABLE_UNIFORMS,
  GRASS_TINT_WIND_UNIFORM,
} from '../src/grass/chunks.ts'
import { GRASS_LEVELS } from '../src/grass/cull.ts'
import { GRASS_PALETTE_SLOTS } from '../src/grass/shaders.ts'
import {
  GRASS_TINT_FAR,
  GRASS_TINT_NEAR,
  GrassTerrainTint,
  grassTintByte,
  grassTintFade,
  grassTintMid,
  grassTintPalette,
  packGrassTintTable,
  readGrassTintTable,
  type GrassTintSource,
} from '../src/grass/tint.ts'
import { TERRAIN_PLUGIN_SAMPLERS, TERRAIN_PLUGIN_UNIFORMS, defaultTerrainExterns, type TerrainExterns } from '../src/pbr/terrain-plugin.ts'
import { SharedUniforms } from '../src/shader-chunks.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { WEATHER_PRESETS } from '../src/weather/presets.ts'
import { FakeField, w10World, type W10Setup } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

/** The preprocessor with `define` off: drops every `#ifdef define … #endif` block (none of ours nests another). */
function defineOff(src: string, define: string): string {
  return src.replace(new RegExp(`#ifdef ${define}\\n[\\s\\S]*?#endif\\n`, 'g'), '')
}

describe('define off = today (the Low guard)', () => {
  it('the PBR terrain code with SRO_GRASS_TINT off equals the code without the extern, both languages', () => {
    const x = defaultTerrainExterns()
    expect(x.grassTint).not.toBeNull()
    const without: TerrainExterns = { ...x, grassTint: null }
    for (const lang of ['wgsl', 'glsl'] as const) {
      const on = terrainPluginCode(lang, x)
      const off = terrainPluginCode(lang, without)
      expect(Object.keys(on)).toEqual(Object.keys(off))
      for (const k of Object.keys(off)) expect(defineOff(on[k]!, GRASS_TINT_DEFINE), `${lang} ${k}`).toBe(off[k])
    }
  })

  it('the Classic chunk is empty: the Classic terrain strings are the other lanes\' (Classic never draws the field)', () => {
    expect(GRASS_TINT_CHUNKS).toEqual({})
    const a = terrainShaders(WORLD_SHADER_CHUNKS)
    const b = terrainShaders([SKY_CHUNKS, WEATHER_CHUNKS, NIGHT_CHUNKS, COAST_CHUNKS, RENDER_GRASS_CHUNKS])
    expect([a.vertexWGSL, a.fragmentWGSL, a.vertexGLSL, a.fragmentGLSL]).toEqual([b.vertexWGSL, b.fragmentWGSL, b.vertexGLSL, b.fragmentGLSL])
    expect([a.uniforms, a.samplers]).toEqual([b.uniforms, b.samplers])
  })

  it('the define follows only the tint\'s own terrain define (never on by itself)', () => {
    const base = { quality: RENDER_PRESETS.medium, sky: SKY_PRESETS.medium, externs: { shelter: true, cloudShadow: true, nightSplat: true, grassTint: true } }
    expect(resolveTerrainFeatures({ ...base, defines: { has: () => false } }).grassTint).toBe(false)
    expect(resolveTerrainFeatures({ ...base, defines: { has: n => n === GRASS_TINT_DEFINE } }).grassTint).toBe(true)
  })
})

describe('define on: both languages', () => {
  const x = defaultTerrainExterns().grassTint!

  it('declare the same function, the same uniforms (a per-tile table, the palette, the fade) and no sampler', () => {
    expect(x.fn).toBe('sroGrassTint')
    expect(x.samplers).toEqual([])
    expect(x.arg).toBe('vec3')
    const own = x.uniforms.filter(u => !TERRAIN_PLUGIN_UNIFORMS.includes(u.name))
    expect(own).toEqual([
      ...GRASS_TINT_TABLE_UNIFORMS.map(name => ({ name, type: 'mat4' })),
      { name: GRASS_TINT_PALETTE_UNIFORM, type: 'mat4' },
      { name: GRASS_TINT_FADE_UNIFORM, type: 'vec4' },
      { name: GRASS_TINT_LOOK_UNIFORM, type: 'vec4' },
      { name: GRASS_TINT_WIND_UNIFORM, type: 'vec4' },
    ])
    // The uniform lines moved into the UBO; the rest is code in its own language.
    expect(x.wgsl).not.toMatch(/^\s*uniform /m)
    expect(x.glsl).not.toMatch(/^\s*uniform /m)
    expect(x.wgsl).toContain('fn sroGrassTint(alb: vec3f, lp: vec2f, wp: vec3f) -> vec3f {')
    expect(x.glsl).toContain('vec3 sroGrassTint(vec3 alb, vec2 lp, vec3 wp) {')
    expect(x.wgsl).not.toMatch(/\bvec3 |\bfloat |texelFetch|texture\(|textureLod\(/)
    expect(x.glsl).not.toMatch(/\bvec3f\b|\bfn |textureLoad|textureSample/)
    // Unfiltered loads only: no sampler state, no derivative, nothing WGSL uniformity could object to.
    expect(`${x.wgsl}${x.glsl}`).not.toMatch(/textureSample|dpdx|dpdy|fwidth|dFdx|dFdy|texture\(|textureLod/)
    expect(x.wgsl).toContain('textureLoad(sroLayerMap')
    expect(x.glsl).toContain('texelFetch(sroLayerMap')
    // No other extern or plugin name is taken.
    const others = [...TERRAIN_PLUGIN_SAMPLERS, 'sroCloudShadow', 'sroShelter', 'sroNightSplat', 'sroCoastWet', 'sroHash', 'sroNoise']
    for (const name of own.map(u => u.name)) expect(others).not.toContain(name)
    expect(`${GRASS_TINT_WGSL}${GRASS_TINT_GLSL}`).not.toMatch(/\bfn sroHash\b|\bfn sroNoise\b|float sroNoise\(|float sroHash\(/)
    // WGSL reserved words the helper must not use as names.
    expect(x.wgsl).not.toMatch(/\blet (target|filter|set|meta|mod)\b/)
  })

  it('the plugin calls it under the define, before the wetness, in both languages', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = Object.values(terrainPluginCode(lang)).join('\n')
      expect(src).toContain(`#ifdef ${GRASS_TINT_DEFINE}\n  alb = sroGrassTint(alb, lp, wp);\n#endif`)
      expect(src.indexOf('alb = sroGrassTint(')).toBeGreaterThan(0)
      expect(src.indexOf('alb = sroGrassTint(')).toBeLessThan(src.indexOf('wW = '))
    }
  })

  it('the texture units are unchanged by the define (no sampler; D32): the plugin samplers are the same set', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const samplers = (externs: TerrainExterns, tint: boolean) => {
      const pbr = new TerrainPbr(scene, new Map(), externs)
      pbr.setFeatures(resolveTerrainFeatures({
        quality: RENDER_PRESETS.high, sky: SKY_PRESETS.high, weather: WEATHER_PRESETS.ultra, arrays: { normal: true, ormh: true, tier: true },
        externs: { ...pbr.externsAvailable }, defines: { has: n => tint && n === GRASS_TINT_DEFINE },
      }))
      const tex = { getInternalTexture: () => null } as never
      const { material, plugin } = pbr.createMaterial('t', { originX: 0, originZ: 0, layerCount: 1, layerMap: tex, lightmap: null, textures: {} })
      const out: string[] = []
      plugin.getSamplers(out)
      material.dispose()
      pbr.dispose()
      return out.sort()
    }
    const x = defaultTerrainExterns()
    expect(samplers(x, true)).toEqual(samplers({ ...x, grassTint: null }, false))
    expect(samplers(x, true)).toEqual(samplers(x, false))
  })
})

describe('the per-tile table and the palette', () => {
  it('one byte per layer, three per float, exact for every layer the arrays can hold', () => {
    expect(GRASS_TINT_LAYERS).toBeGreaterThanOrEqual(256)
    expect(GRASS_TINT_SLOTS).toBe(GRASS_PALETTE_SLOTS)
    const bytes = new Uint8Array(GRASS_TINT_LAYERS)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 97 + 13) & 255
    bytes[255] = 255
    bytes[GRASS_TINT_LAYERS - 1] = 255
    const f = packGrassTintTable(bytes)
    for (const v of f) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeLessThan(2 ** 24)
      expect(Math.fround(v)).toBe(v)
    }
    for (let i = 0; i < bytes.length; i++) expect(readGrassTintTable(f, i)).toBe(bytes[i])
  })

  it('a tile\'s byte: weight in 15 steps (0 = no grass), the slot in the low nibble', () => {
    expect(grassTintByte(0, 5)).toBe(0)
    expect(grassTintByte(0.01, 5)).toBe(0)
    expect(grassTintByte(1, 0)).toBe(0xf0)
    expect(grassTintByte(1, 15)).toBe(0xff)
    expect(grassTintByte(0.45, 3) >> 4).toBe(7)
    expect(grassTintByte(2, 99)).toBe(0xff)
  })

  it('the palette: each slot\'s seen blade colour as sRGB 8:8:8, the fade from the level\'s far tier', () => {
    const pal: number[] = []
    for (let s = 0; s < GRASS_TINT_SLOTS; s++) pal.push(0.1, 0.2 + s / 100, 0.05, 1, 0.5, 0.6, 0.2, 1)
    const out = grassTintPalette(pal)
    for (let s = 0; s < GRASS_TINT_SLOTS; s++) {
      const mid = grassTintMid([0.1, 0.2 + s / 100, 0.05], [0.5, 0.6, 0.2])
      const v = out[s]!
      expect([v & 255, (v >> 8) & 255, (v >> 16) & 255]).toEqual(mid.map(c => Math.round(c * 255)))
    }
    const mid = grassTintMid([0.1, 0.2, 0.05], [0.5, 0.6, 0.2])
    // Between the base and the tip, a little darker than the tip (the blades' shade).
    expect(mid[1]).toBeGreaterThan(0.2)
    expect(mid[1]).toBeLessThan(0.6)
    const high = grassTintFade(GRASS_LEVELS.high!)
    expect([high.x, high.y, high.z, high.w]).toEqual([GRASS_LEVELS.high!.cut0[0] - 6, GRASS_LEVELS.high!.cut0[1], GRASS_TINT_NEAR, GRASS_TINT_FAR])
    const low = grassTintFade(GRASS_LEVELS.low!)
    expect(low.y).toBeLessThan(high.y)
    expect(GRASS_TINT_NEAR).toBeLessThan(GRASS_TINT_FAR)
  })
})

/** A fake terrain renderer: its shared values and defines. */
function fakeTerrain() {
  const sharedUniforms = new SharedUniforms()
  const defines = new Set<string>()
  const calls: Array<[string, boolean]> = []
  return {
    sharedUniforms,
    defines,
    calls,
    setDefine(name: string, on: boolean) {
      calls.push([name, on])
      if (on) defines.add(name)
      else defines.delete(name)
    },
  }
}

const TILES = [
  { id: 1, typeName: 'Grass', source: 'c_grass_fld_03.ddj', grass: undefined },
  { id: 2, typeName: 'Dirt', source: 'c_dirt_road_01.ddj', grass: undefined },
  { id: 3, typeName: 'Dirt', source: 'c_dirt_weed_02.ddj', grass: undefined },
  { id: 4, typeName: 'Grass', source: 'c_grass_hmfld_01.ddj', grass: { weight: 1, base: [0.08, 0.14, 0.03] as [number, number, number], tip: [0.35, 0.43, 0.14] as [number, number, number] } },
]

describe('GrassTerrainTint (grass/tint.ts)', () => {
  function setup() {
    const terrain = fakeTerrain()
    const layers = new Map<number, number>([[1, 5], [2, 6], [3, 7]])
    let level: 'off' | 'low' | 'medium' | 'high' | null = null
    const src: GrassTintSource = { terrain, tiles: TILES, layerOf: id => layers.get(id), level: () => level }
    const tint = new GrassTerrainTint(src)
    return { terrain, layers, tint, setLevel: (l: typeof level) => (level = l) }
  }

  it('off until the field draws; on: the define once and every value bound by reference', () => {
    const s = setup()
    s.tint.update()
    expect(s.tint.active).toBe(false)
    expect(s.terrain.calls).toEqual([])
    expect(s.terrain.sharedUniforms.size).toBe(0)
    s.setLevel('high')
    s.tint.update()
    s.tint.update()
    expect(s.tint.active).toBe(true)
    expect(s.terrain.calls).toEqual([[GRASS_TINT_DEFINE, true]])
    GRASS_TINT_TABLE_UNIFORMS.forEach((n, q) => expect(s.terrain.sharedUniforms.get(n)).toBe(s.tint.table[q]))
    expect(s.terrain.sharedUniforms.get(GRASS_TINT_PALETTE_UNIFORM)).toBe(s.tint.palette)
    expect(s.terrain.sharedUniforms.get(GRASS_TINT_FADE_UNIFORM)).toBe(s.tint.fade)
    expect(s.tint.fade.y).toBe(GRASS_LEVELS.high!.cut0[1])
    // Grass tiles 1, 3 (grassy dirt) and 4; tile 4 holds no layer yet.
    expect(s.tint.stats).toMatchObject({ grassTiles: 3, resident: 2, repacks: 1 })
  })

  it('the table holds each grass tile at its atlas layer (road: none), and follows the atlas', () => {
    const s = setup()
    s.setLevel('medium')
    s.tint.update()
    const floats = () => s.tint.table.flatMap(m => Array.from(m.m))
    const byte = (layer: number) => readGrassTintTable(floats(), layer)
    expect(byte(5) >> 4).toBe(15)
    expect(byte(6)).toBe(0)
    expect(byte(7) >> 4).toBe(Math.round(0.45 * 15))
    expect(byte(8)).toBe(0)
    // The two grass tiles have different palettes: different slots.
    expect(s.tint.tiles.slot.get(4)).not.toBe(s.tint.tiles.slot.get(1))
    expect(byte(5) & 15).toBe(s.tint.tiles.slot.get(1))
    // Nothing moved: no repack.
    s.tint.update()
    expect(s.tint.stats.repacks).toBe(1)
    // The atlas evicts tile 1 and puts tile 4 on its layer; tile 3 goes to layer 200.
    s.layers.delete(1)
    s.layers.set(4, 5)
    s.layers.set(3, 200)
    s.tint.update()
    expect(s.tint.stats.repacks).toBe(2)
    expect(byte(5) & 15).toBe(s.tint.tiles.slot.get(4))
    expect(byte(7)).toBe(0)
    expect(byte(200) >> 4).toBe(7)
    expect(s.tint.stats.resident).toBe(2)
  })

  it('the level sets the fade; Grass: Off or no field switches it off and unbinds; dispose leaves nothing', () => {
    const s = setup()
    s.setLevel('low')
    s.tint.update()
    expect(s.tint.fade.y).toBe(GRASS_LEVELS.low!.cut0[1])
    s.setLevel('high')
    s.tint.update()
    expect(s.tint.fade.y).toBe(GRASS_LEVELS.high!.cut0[1])
    expect(s.terrain.calls.length).toBe(1)
    s.setLevel('off')
    s.tint.update()
    expect(s.tint.active).toBe(false)
    expect(s.terrain.defines.has(GRASS_TINT_DEFINE)).toBe(false)
    expect(s.terrain.sharedUniforms.size).toBe(0)
    s.setLevel('medium')
    s.tint.update()
    expect(s.tint.fade.y).toBe(GRASS_LEVELS.medium!.cut0[1])
    s.tint.dispose()
    expect(s.terrain.defines.size).toBe(0)
    expect(s.terrain.sharedUniforms.size).toBe(0)
    s.tint.update()
    expect(s.tint.active).toBe(false)
  })

  it('an export without grass tiles never switches it on', () => {
    const terrain = fakeTerrain()
    const t = new GrassTerrainTint({ terrain, tiles: [TILES[1]!], layerOf: () => 0, level: () => 'high' })
    t.update()
    expect(t.active).toBe(false)
    expect(terrain.calls).toEqual([])
  })

  it('the values are Babylon types the plugin binds (mat4 by `m`, vec4)', () => {
    const s = setup()
    s.setLevel('high')
    s.tint.update()
    expect(s.tint.table.every(m => m instanceof Matrix)).toBe(true)
    expect(s.tint.fade).toBeInstanceOf(Vector4)
  })
})

describe('World (the one additive wiring in world.ts)', () => {
  async function world(o: Parameters<typeof w10World>[0]): Promise<W10Setup> {
    const s = await w10World(o)
    cleanups.push(s.dispose)
    return s
  }
  // The fixture's tiles are untyped (no grass): make tile 10 a grass tile.
  const edit = (fx: { manifest: { tiles: Array<{ id: number; typeName: string | null }> } }) => {
    for (const t of fx.manifest.tiles) if (t.id === 10) t.typeName = 'Grass'
  }
  const hasDefine = (s: W10Setup) => (s.world.terrain as unknown as { defines: { has(n: string): boolean } }).defines.has(GRASS_TINT_DEFINE)

  it('on the PBR path with the field: on, with the grass tile at its atlas layer; the retail style switches it off', async () => {
    const s = await world({ render: 'pbr', grassStyle: 'field', parts: { grass: () => new FakeField() }, edit: edit as never })
    await s.run()
    s.world.grassTint.update()
    expect(s.world.grassTint.active).toBe(true)
    expect(hasDefine(s)).toBe(true)
    expect(s.world.terrain.sharedUniforms.get(GRASS_TINT_FADE_UNIFORM)).toBe(s.world.grassTint.fade)
    expect(s.world.grassTint.stats.resident).toBe(1)
    const layer = s.stream.atlas.layerOf(10)!
    const floats = s.world.grassTint.table.flatMap(m => Array.from(m.m))
    expect(readGrassTintTable(floats, layer) >> 4).toBe(15)
    s.world.setGrassStyle('retail')
    s.world.grassTint.update()
    expect(s.world.grassTint.active).toBe(false)
    expect(hasDefine(s)).toBe(false)
    expect(s.world.terrain.sharedUniforms.has(GRASS_TINT_FADE_UNIFORM)).toBe(false)
  })

  it('Low (Classic) never switches it on, even when the field is asked for; disposing the world switches it off', async () => {
    const s = await world({ render: 'classic', grassStyle: 'field', parts: { grass: () => new FakeField() }, edit: edit as never })
    await s.run()
    s.world.grassTint.update()
    expect(s.world.grassTint.active).toBe(false)
    expect(hasDefine(s)).toBe(false)
    expect([...s.world.terrain.sharedUniforms.keys()].some(k => k.startsWith('sroGt'))).toBe(false)
    const p = await world({ render: 'pbr', grassStyle: 'field', parts: { grass: () => new FakeField() }, edit: edit as never })
    await p.run()
    p.world.grassTint.update()
    expect(p.world.grassTint.active).toBe(true)
    p.dispose()
    expect(p.world.grassTint.active).toBe(false)
  })
})
