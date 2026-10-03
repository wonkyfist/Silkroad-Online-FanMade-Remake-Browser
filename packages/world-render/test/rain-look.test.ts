/**
 * Wave 12 RAIN-P (the rain look): the one rain-ring function (weather/ripples.ts) and its consumers — the PBR terrain's
 * rain film and puddles, the PBR water, the ocean, the Classic chunks — and the splash crowns. Shader strings only (the
 * NullEngine compiles nothing): language parity, the define gates, the uniform-control-flow rules, the numbers the look
 * depends on, and the TS mirror of the ring.
 */
import { describe, expect, it } from 'vitest'
import {
  FILM_CLASS_GAIN,
  PUDDLE_THRESHOLD,
  TERRAIN_FEATURE_DEFINES,
  terrainClassTable,
  terrainPluginCode,
} from '../src/pbr/terrain-plugin.ts'
import { WATER_ROUGHNESS, waterFragmentCode } from '../src/pbr/water-plugin.ts'
import { waterTownFragmentCode } from '../src/pbr/water-town-plugin.ts'
import { oceanCode } from '../src/ocean/ocean-plugin.ts'
import { TERRAIN_SURFACE } from '../src/pbr/classes.ts'
import { WEATHER_CHUNKS } from '../src/weather/chunks.ts'
import { RAIN_SHADERS } from '../src/weather/rain.ts'
import {
  RAIN_RING_DENSE,
  rainRing,
  rainRingCode,
  ringDensity,
  ringSize,
  ringTaps,
  ripplePixels,
  rippleDrops,
} from '../src/weather/ripples.ts'

const LANGS = ['wgsl', 'glsl'] as const

describe('the rain ring (weather/ripples.ts)', () => {
  it('drop density and ring size grow with the rain rate: a drizzle sparse and small, a downpour dense and full', () => {
    expect(ringDensity(0.22)).toBeLessThan(0.3)
    expect(ringDensity(0.55)).toBeGreaterThan(0.55)
    expect(ringDensity(0.55)).toBeLessThan(0.8)
    expect(ringDensity(1)).toBe(1)
    expect(ringSize(0.22)).toBeLessThan(0.6)
    expect(ringSize(1)).toBe(1)
    for (let r = 0; r < 1; r += 0.05) {
      expect(ringDensity(r + 0.05)).toBeGreaterThanOrEqual(ringDensity(r))
      expect(ringSize(r + 0.05)).toBeGreaterThanOrEqual(ringSize(r))
    }
  })

  it('the mirror: the live share of the texture\'s drops follows ringDensity; rings tilt along the radius, crowns sit at the centre', () => {
    const size = 128
    const px = ripplePixels(size, rippleDrops(size))
    const phases = new Set<number>()
    for (let i = 0; i < px.length; i += 4) if (px[i]! > 200) phases.add(px[i + 3]!)
    const fr = (v: number) => v - Math.floor(v)
    // a drop is live when the hash of its phase byte is under the density (the shader's `on`)
    const share = (rain: number) => [...phases].filter(a => fr((a / 255) * 158.13) <= ringDensity(rain)).length / phases.size
    expect(phases.size).toBeGreaterThan(40)
    expect(share(1)).toBe(1)
    expect(Math.abs(share(0.55) - ringDensity(0.55))).toBeLessThan(0.2)
    expect(share(0.22)).toBeLessThan(0.45)
    // a live drop half way through its cycle: the ring front at d = ph × s, tilt along the drop's radial direction
    const a = [...phases].find(p => fr((p / 255) * 158.13) <= 0.1)!
    const t = a / 255
    const time = (0.5 - t) / 1.3 + 10
    const ph = fr(t + time * 1.3)
    expect(ph).toBeCloseTo(0.5, 5)
    const at = (d: number) => rainRing([1 - d / 2, 1, 0.5, t], 0, time, 1)
    expect(Math.abs(at(0.45)[0])).toBeGreaterThan(0.05)
    expect(at(0.45)[1]).toBeCloseTo(0, 5)
    expect(at(0.9)[3]).toBe(0) // outside the front
    // the crown: only in the first instant, only near the centre
    const born = (0.02 - t) / 1.3 + 10
    expect(rainRing([1, 0.5, 0.5, t], 0, born, 1)[2]).toBeGreaterThan(0.5)
    expect(rainRing([0.5, 0.5, 0.5, t], 0, born, 1)[2]).toBe(0)
    expect(rainRing([1, 0.5, 0.5, t], 0, time, 1)[2]).toBe(0)
  })

  it('one source, both languages: the same function with the same numbers, each language to itself', () => {
    const w = rainRingCode('wgsl', 'fooRing')
    const g = rainRingCode('glsl', 'fooRing')
    expect(w).toMatch(/^fn fooRing\(t: vec4f, off: f32, tm: f32, rain: f32\) -> vec4f \{/)
    expect(g).toMatch(/^vec4 fooRing\(vec4 t, float off, float tm, float rain\) \{/)
    const nums = (s: string) => (s.match(/\d+\.\d+/g) ?? []).join(' ')
    expect(nums(w)).toBe(nums(g))
    expect(w).not.toMatch(/\bvec[234]\(|\bfloat\s|textureLod|\?/)
    expect(g).not.toMatch(/vec[234]f|\blet\s|f32/)
  })

  it('the taps: gradient taps may branch on the rain rate for the third layer; implicit taps never branch', () => {
    for (const lang of LANGS) {
      const grad = ringTaps(lang, 'r', 'tex', 'uv', 'dx', 'dy', 'tm', 'rain', 'o')
      expect(grad).toContain(`if (rain > ${RAIN_RING_DENSE.toFixed(3)})`)
      expect(grad).not.toMatch(lang === 'wgsl' ? /textureSample\(/ : /texture\(/)
      const imp = ringTaps(lang, 'r', 'tex', 'uv', null, null, 'tm', 'rain', 'o')
      expect(imp).not.toMatch(/\bif\s*\(/)
      expect((imp.match(lang === 'wgsl' ? /textureSampleBias\(/g : /texture\(/g) ?? []).length).toBe(3)
    }
  })
})

describe('the PBR terrain: rain film on every wet flat surface, faster puddles', () => {
  it('both languages carry the film, its rings and the crowns under SRO_T_RIPPLES only, in a uniform branch on the rain', () => {
    for (const lang of LANGS) {
      const def = terrainPluginCode(lang).CUSTOM_FRAGMENT_DEFINITIONS!
      const rip = `#ifdef ${TERRAIN_FEATURE_DEFINES.ripples}\n`
      const i = def.indexOf(rip, def.indexOf(lang === 'wgsl' ? 'fn sroTerrainEval' : 'void sroTerrainEval'))
      expect(i).toBeGreaterThan(0)
      const block = def.slice(i, def.indexOf('#endif', i))
      expect(block).toContain('film = smoothstep(0.02, 0.3, rr) * smoothstep(')
      expect(block).toContain(lang === 'wgsl' ? 'textureSampleGrad(sroRipple' : 'textureGrad(sroRipple')
      expect(block).toMatch(/if \(rr > 0\.001\)/)
      expect(block).toContain('sroTRing(')
      expect(def).toContain(lang === 'wgsl' ? 'fn sroTRing(' : 'vec4 sroTRing(')
      // the film glosses and flattens the ground, and the SSR mask follows it
      expect(def).toContain('rough = mix(rough, min(rough, 0.08), film);')
      expect(def).toMatch(/sroR0 = max\(sroR0, 0\.04 \+ 0\.06 \* max\(pm, film \* 0\.6\)\);/)
    }
  })

  it('the film follows the class\'s puddle weight: stone and soil full, grass soft, sand faint, water none', () => {
    const t = terrainClassTable()
    const film = (c: number) => Math.min(1, t[c]![3] * FILM_CLASS_GAIN)
    expect(film(TERRAIN_SURFACE.stone)).toBe(1)
    expect(film(TERRAIN_SURFACE.dirt)).toBe(1)
    expect(film(TERRAIN_SURFACE.grass)).toBeGreaterThan(0.3)
    expect(film(TERRAIN_SURFACE.grass)).toBeLessThan(0.5)
    expect(film(TERRAIN_SURFACE.sand)).toBeLessThan(0.25)
    expect(film(TERRAIN_SURFACE.water)).toBe(0)
  })

  it('the deepest basins show at a puddle level of 0.17 (the first minute of rain), every real basin at a full level', () => {
    const pth = (level: number) => PUDDLE_THRESHOLD[0] - level * PUDDLE_THRESHOLD[1]
    // the shader: smoothstep(pth − 0.05, pth + 0.05, potential); a basin centre's potential is 0.75..1 × the wet map's R
    expect(pth(0.17) + 0.05).toBeLessThan(0.95)
    expect(pth(0) - 0.05).toBeGreaterThan(0.85)
    expect(pth(1) + 0.05).toBeLessThan(0.5)
    // flat ground away from basins (wet map R = 0.3 × 0.75..1) never floods
    expect(pth(1) - 0.05).toBeGreaterThan(0.3)
  })
})

describe('water, sea and Classic: one ring function each, by its own name', () => {
  it('the PBR water and the ocean declare their own copy; the town plugin on the same material declares none', () => {
    for (const lang of LANGS) {
      const water = Object.values(waterFragmentCode(lang)).join('\n')
      const town = Object.values(waterTownFragmentCode(lang)).join('\n')
      const ocean = Object.values(oceanCode('fragment', lang)).join('\n')
      expect(water.match(lang === 'wgsl' ? /fn sroWRing\(/g : /vec4 sroWRing\(/g)!.length).toBe(1)
      expect(town).not.toContain('Ring(')
      expect(ocean.match(lang === 'wgsl' ? /fn sroOcRing\(/g : /vec4 sroOcRing\(/g)!.length).toBe(1)
      expect(water).toContain('sroWCrown')
      expect(ocean).toContain('sroOcFoam = max(max(sroFoamF,')
    }
    expect(WATER_ROUGHNESS[1]).toBeLessThanOrEqual(0.08)
  })

  it('the Classic chunks (graphics Low with weather Medium+) carry the film rings too; weather Low adds nothing', () => {
    const t = WEATHER_CHUNKS.terrain!
    for (const [lang, c] of [['wgsl', t.wgsl!], ['glsl', t.glsl!]] as const) {
      expect(c.samplers).toContain(lang === 'wgsl' ? 'fn wxRing(' : 'vec4 wxRing(')
      expect(c.preLight).toContain('#ifdef WX_RIPPLE\n')
      expect(c.preLight).toContain('wxFilm = clamp(')
      expect(c.postLight).toContain('max(wxPud')
      // the ripple texture is only declared under WX_RIPPLE (Medium+), so weather Low compiles what it did
      const s = c.samplers!
      expect(s.indexOf('wxRing(')).toBeGreaterThan(s.indexOf('#ifdef WX_RIPPLE'))
    }
  })
})

describe('splash crowns', () => {
  it('the same uniforms and varyings in both languages; a crown of six droplets and three flung ones', () => {
    const s = RAIN_SHADERS.sroSplash
    const names = (src: string, re: RegExp) => [...src.matchAll(re)].map(m => m[1]).sort()
    const wU = names(s.vertexWGSL + s.fragmentWGSL, /uniform (\w+):/g)
    const gU = names(s.vertexGLSL + s.fragmentGLSL, /uniform (?:highp )?\w+ (\w+);/g)
    expect([...new Set(wU)]).toEqual([...new Set(gU.filter(n => n !== 'wxOccMap'))])
    expect(names(s.vertexWGSL, /varying (\w+):/g)).toEqual(['vSp', 'vUV'])
    expect(names(s.vertexGLSL, /varying \w+ (\w+);/g)).toEqual(['vSp', 'vUV'])
    for (const f of [s.fragmentWGSL, s.fragmentGLSL]) {
      expect(f).toMatch(/i < 6/)
      expect(f).toMatch(/j < 3/)
    }
  })
})
