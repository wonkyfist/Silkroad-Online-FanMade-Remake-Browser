/**
 * RND-L's sky cube (docs/WAVE_PLAN3.md D14, docs/RENDER.md §4.2): half-float packing, the refresh in slices (one face
 * per frame, then the prefiltered mips one face per frame, then one upload), prefiltered mips that keep a constant sky
 * constant and blur a bright zenith, the refresh policy (0.5° of sun, 0.05 of weather, new sky LUTs, rate-limited,
 * a jump at once) and WorldLighting driving it with a fake clock. Headless: the data stays on the CPU.
 */
import { InternalTexture, InternalTextureSource, NullEngine, Scene, TextureTools } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { RGB } from '../src/environment.ts'
import {
  SkyEnvironment,
  WORLD_SKY_CUBE_DECODE,
  WorldLighting,
  cubeRefreshDue,
  cubeTexelDir,
  fromHalf,
  prefilteredRadiance,
  retailRadiance,
  toHalf,
  type CubeRefreshKey,
  type SkyRadiance,
} from '../src/render/lighting.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { CLEAR_RENDER_WEATHER } from '../src/render/weather.ts'
import { SkySystem } from '../src/sky/sky-system.ts'
import { SKY_PRESETS, type SkyState } from '../src/sky/types.ts'
import type { EnvValues } from '../src/environment.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(): Scene {
  const engine = new NullEngine()
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

/**
 * A scene whose engine makes the raw cube (the NullEngine says it is WebGPU and hands out a bare InternalTexture), so
 * SkyEnvironment builds its RawCubeTexture and the texture's flags can be read; the uploads are the NullEngine's no-ops.
 */
function uploadingScene(): Scene {
  const s = scene()
  const engine = s.getEngine() as NullEngine
  Object.defineProperty(engine, 'isWebGPU', { value: true, configurable: true })
  engine.createRawCubeTexture = (_data, size, format, type, generateMipMaps) => {
    const t = new InternalTexture(engine, InternalTextureSource.CubeRaw)
    t.isCube = true
    t.width = t.height = t.baseWidth = t.baseHeight = size
    t.format = format
    t.type = type
    t.generateMipMaps = generateMipMaps
    t.isReady = true
    return t
  }
  cleanups.unshift(() => {
    delete (engine as { isWebGPU?: boolean }).isWebGPU
  })
  return s
}

const NOON: EnvValues = {
  sun: [1, 1, 1], skyTop: [0.169, 0.572, 0.943], skyBottom: [0.768, 0.969, 0.993], diffuse: [0.776, 0.772, 0.767],
  objectAmbient: [0.792, 0.791, 0.783], scatter: [1, 1, 1], terrainShadow: [0.07, 0.07, 0.071], fogColor: [0.357, 0.58, 0.677],
  water: [0.36, 0.69, 0.62], g7: -0.76, g8: -1, g10: 0.76, g11: 1,
}

describe('half floats', () => {
  it('match Babylon\'s ToHalfFloat within 1 ulp and round-trip; negatives, NaN → 0; huge → the largest finite half', () => {
    for (const v of [0, 1e-7, 6.1e-5, 1e-3, 0.0147, 0.25, 0.5, 0.99, 1, 1.5, 3.14159, 100, 2049, 65504]) {
      expect(Math.abs(toHalf(v) - TextureTools.ToHalfFloat(v))).toBeLessThanOrEqual(1) // within 1 ulp (we round subnormals to nearest)
      if (v > 6.2e-5) expect(Math.abs(fromHalf(toHalf(v)) - v) / v).toBeLessThan(1e-3)
    }
    expect(toHalf(-1)).toBe(0)
    expect(toHalf(NaN)).toBe(0)
    expect(fromHalf(toHalf(1e9))).toBe(65504)
    expect(fromHalf(0x3c00)).toBe(1)
  })
})

describe('SkyEnvironment', () => {
  const constant = (L: RGB): SkyRadiance => (_x, _y, _z, out) => {
    out[0] = L[0]
    out[1] = L[1]
    out[2] = L[2]
  }

  it('refreshes in 13 slices: six faces, six faces of mips, one upload; a constant sky stays constant in every mip', () => {
    const env = new SkyEnvironment(scene(), 16, true)
    expect(env.texture).toBeNull() // headless: CPU only
    expect(env.levels).toBe(5)
    env.begin(constant([0.25, 0.5, 1]))
    let slices = 0
    let done = false
    while (!done) {
      expect(env.busy).toBe(true)
      done = env.step()
      slices++
    }
    expect(slices).toBe(13)
    expect(env.busy).toBe(false)
    expect(env.refreshes).toBe(1)
    for (let l = 0; l < env.levels; l++) {
      for (let f = 0; f < 6; f++) {
        const px = env.packed[l]![f]!
        for (let o = 0; o < px.length; o += 4) {
          expect(fromHalf(px[o]!)).toBeCloseTo(0.25, 3)
          expect(fromHalf(px[o + 1]!)).toBeCloseTo(0.5, 3)
          expect(fromHalf(px[o + 2]!)).toBeCloseTo(1, 3)
          expect(px[o + 3]).toBe(0x3c00)
        }
      }
    }
  })

  it('blurs with roughness: a bright zenith spreads over the lower mips, and the 1×1 mips of the side faces agree', () => {
    const size = 32
    const zenith: SkyRadiance = (_x, y, _z, out) => {
      const v = Math.pow(Math.max(0, y), 64) * 10
      out[0] = out[1] = out[2] = v
    }
    const top: number[] = []
    for (let l = 0; l <= 5; l++) top.push(prefilteredRadiance(zenith, l, size, 0, 1, 0, [0, 0, 0])[0])
    for (let l = 1; l < top.length; l++) expect(top[l]!).toBeLessThan(top[l - 1]!)
    // A texel 45° away brightens as the lobe widens.
    const s = Math.SQRT1_2
    expect(prefilteredRadiance(zenith, 5, size, s, s, 0, [0, 0, 0])[0]).toBeGreaterThan(prefilteredRadiance(zenith, 1, size, s, s, 0, [0, 0, 0])[0])
    const env = new SkyEnvironment(scene(), size, true)
    env.begin(retailRadiance(NOON))
    env.finish()
    const last = env.levels - 1
    const sides = [0, 1, 4, 5].map(f => fromHalf(env.packed[last]![f]![2]!))
    for (const v of sides) expect(Math.abs(v - sides[0]!) / sides[0]!).toBeLessThan(0.02)
    // The up face is the blue zenith, the down face the dim ground.
    expect(fromHalf(env.packed[0]![2]![((size / 2) * size + size / 2) * 4 + 2]!)).toBeGreaterThan(fromHalf(env.packed[0]![3]![((size / 2) * size + size / 2) * 4 + 2]!))
  })

  it('texels point where Babylon\'s cube lookup expects them (right-handed: z flipped)', () => {
    // Babylon's +Z face centre shows world −Z in a right-handed scene; +Y shows up either way.
    expect(cubeTexelDir(4, 7.5, 7.5, 16, true).map(v => Math.round(v) + 0)).toEqual([0, 0, -1])
    expect(cubeTexelDir(4, 7.5, 7.5, 16, false).map(v => Math.round(v) + 0)).toEqual([0, 0, 1])
    expect(cubeTexelDir(2, 7.5, 7.5, 16, true).map(v => Math.round(v) + 0)).toEqual([0, 1, 0])
    // +X face, first column: fileX = −z, so u = −1 looks toward +z (−z after the flip).
    const d = cubeTexelDir(0, 0, 7.5, 16, false)
    expect(d[2]).toBeGreaterThan(0.6)
  })
})

describe('how the shader reads the cube (SkyCubeDecode)', () => {
  it('reads the half-float radiance linear by default; sRGB only when asked (Babylon would decode it as gamma)', () => {
    const s = uploadingScene()
    const linear = new SkyEnvironment(s, 8, true)
    expect(linear.texture).not.toBeNull()
    expect(linear.decode).toBe('linear')
    // No GAMMAREFLECTION: a radiance of 0.35 stays 0.35 (as sRGB it came back as 0.35^2.2 = 0.10).
    expect(linear.texture!.gammaSpace).toBe(false)
    const srgb = new SkyEnvironment(s, 8, true, { decode: 'srgb' })
    expect(srgb.texture!.gammaSpace).toBe(true)
    // A refresh uploads into the same texture and keeps the flag.
    linear.begin((_x, _y, _z, out) => {
      out[0] = out[1] = out[2] = 0.35
      return out
    })
    linear.finish()
    expect(linear.refreshes).toBe(1)
    expect(linear.texture!.gammaSpace).toBe(false)
    linear.dispose()
    srgb.dispose()
  })

  it("the world's sky cube keeps the shipped wave-9 read (sRGB) until its look pass", () => {
    expect(WORLD_SKY_CUBE_DECODE).toBe('srgb')
    const s = uploadingScene()
    const l = new WorldLighting(s, { quality: RENDER_PRESETS.medium, now: () => 0 })
    cleanups.unshift(() => l.dispose())
    expect(l.env?.decode).toBe(WORLD_SKY_CUBE_DECODE)
    expect(s.environmentTexture).toBe(l.env!.texture)
    expect(s.environmentTexture!.gammaSpace).toBe(true)
  })
})

describe('cube refresh policy (D14)', () => {
  const key = (deg: number, extra: Partial<CubeRefreshKey> = {}): CubeRefreshKey => {
    const a = (deg * Math.PI) / 180
    return { dir: [Math.cos(a), Math.sin(a), 0], cloud: 0.1, rain: 0, sky: 0.8, lut: 0, ...extra }
  }

  it('refreshes at once the first time and after a jump; otherwise on 0.5° of sun, weather or new LUTs, rate-limited', () => {
    expect(cubeRefreshDue(null, null, key(30), 0, 5)).toBe('jump')
    const prev = key(30)
    expect(cubeRefreshDue(prev, key(30.1), key(30.3), 10, 5)).toBeNull() // 0.3°
    expect(cubeRefreshDue(prev, key(30.5), key(30.6), 10, 5)).toBe('due')
    expect(cubeRefreshDue(prev, key(30.5), key(30.6), 2, 5)).toBeNull() // rate limit
    expect(cubeRefreshDue(prev, key(30), key(42), 0.1, 5)).toBe('jump') // a GM time jump
    expect(cubeRefreshDue(prev, prev, key(30, { cloud: 0.2 }), 6, 5)).toBe('due')
    expect(cubeRefreshDue(prev, prev, key(30, { rain: 0.03 }), 6, 5)).toBeNull()
    expect(cubeRefreshDue(prev, prev, key(30, { lut: 1 }), 6, 5)).toBe('due')
    expect(cubeRefreshDue(prev, prev, key(30, { sky: 0.9 }), 6, 5)).toBe('due')
  })

  it('WorldLighting refreshes whole at start, then one slice per frame at most once per preset interval; a jump at once', () => {
    const s = scene()
    let now = 0
    const l = new WorldLighting(s, { quality: RENDER_PRESETS.high, now: () => now })
    cleanups.unshift(() => l.dispose())
    const sky = new SkySystem(s, NOON, { style: 'classic', quality: SKY_PRESETS.high })
    cleanups.unshift(() => sky.dispose())
    const state = (t: number): SkyState => {
      sky.setRetail({ env: NOON, t, days: null, declination: 12, profile: null })
      sky.update(0.016, null)
      return sky.state as SkyState
    }
    l.setWeather(CLEAR_RENDER_WEATHER)
    l.update(null, state(0.5))
    const env = l.env!
    expect(env.refreshes).toBe(1) // the first refresh runs whole
    expect(env.busy).toBe(false)
    // One game minute later (0.25° of sun): nothing to do.
    now += 1000
    l.update(null, state(0.5 + 1 / 1440))
    expect(env.busy).toBe(false)
    // 1° later but inside High's 5 s: still nothing; after 5 s: a sliced refresh, one slice per update.
    now += 1000
    l.update(null, state(0.5 + 4 / 1440))
    expect(env.busy).toBe(false)
    now += 5000
    l.update(null, state(0.5 + 5 / 1440))
    expect(env.busy).toBe(true)
    let frames = 1
    while (env.busy) {
      now += 16
      l.update(null, state(0.5 + 5 / 1440))
      frames++
    }
    expect(frames).toBe(13)
    expect(env.refreshes).toBe(2)
    // A GM time jump (to the evening), 0.1 s after the last refresh: it restarts at once (no rate limit), still sliced.
    now += 100
    l.update(null, state(0.7))
    expect(env.busy).toBe(true)
    for (let i = 0; i < 12; i++) l.update(null, state(0.7))
    expect(env.busy).toBe(false)
    expect(env.refreshes).toBe(3)
  })
})
