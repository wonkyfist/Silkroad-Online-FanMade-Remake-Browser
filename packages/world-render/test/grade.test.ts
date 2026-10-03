/**
 * The LUT grade (docs/WAVE_PLAN3.md §6.13, D26; docs/RENDER.md §5.2): identity LUTs blend to identity, the key
 * weights sum to 1 (at most four keys), the time and weather weights follow the sun and the RenderWeather, the
 * texture is re-uploaded only when a weight moved by more than 0.01, and the built-in keys are real grades (warm dusk,
 * blue night, greyer rain) that keep neutral grey near neutral.
 */
import { InternalTexture, InternalTextureSource, NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GRADE_TIME,
  GradeMixer,
  IDENTITY_GRADE,
  LUT_BYTES,
  LUT_KEYS,
  LUT_SIZE,
  blendStrips,
  builtinLutStrip,
  gradeColor,
  gradeWeights,
  makeLutStrip,
  timeWeights,
  weatherWeights,
} from '../src/render/grade.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** NullEngine has no 3D textures (it reaches for a GL context): a CPU-side stand-in that counts uploads. */
function with3dTextures(engine: NullEngine): { uploads: number } {
  const count = { uploads: 0 }
  const e = engine as unknown as Record<string, unknown>
  e['createRawTexture3D'] = (_data: unknown, w: number, h: number, d: number, format: number, _mips: boolean, invertY: boolean, _sampling: number, _c: unknown, type: number) => {
    const t = new InternalTexture(engine, InternalTextureSource.Raw3D)
    t.baseWidth = t.width = w
    t.baseHeight = t.height = h
    t.baseDepth = t.depth = d
    t.format = format
    t.type = type
    t.invertY = invertY
    t.is3D = true
    t.isReady = true
    count.uploads++
    return t
  }
  e['updateRawTexture3D'] = () => {
    count.uploads++
  }
  return count
}

function scene(): Scene {
  const engine = new NullEngine()
  with3dTextures(engine)
  const s = new Scene(engine)
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

/** The LUT entry of lattice colour (r, g, b). */
function at(strip: Uint8Array, r: number, g: number, b: number): [number, number, number] {
  const o = ((b * LUT_SIZE + g) * LUT_SIZE + r) * 4
  return [strip[o]!, strip[o + 1]!, strip[o + 2]!]
}

describe('LUT strips', () => {
  it('the identity strip maps every lattice colour to itself (r fastest, then g, then the b slice)', () => {
    const id = makeLutStrip([])
    expect(id.length).toBe(LUT_BYTES)
    for (const [r, g, b] of [[0, 0, 0], [31, 0, 0], [0, 31, 0], [0, 0, 31], [7, 19, 25], [31, 31, 31]] as const) {
      expect(at(id, r, g, b)).toEqual([r, g, b].map(v => Math.round(v * 255 / 31)))
    }
    expect(makeLutStrip([IDENTITY_GRADE, IDENTITY_GRADE])).toEqual(id)
  })

  it('identity LUTs blend to identity, whatever the weights', () => {
    const id = makeLutStrip([])
    const strips = LUT_KEYS.map(() => id)
    const out = new Uint8Array(LUT_BYTES)
    for (const w of [[1], [0.5, 0.5], [0.1, 0.2, 0.3, 0.4], [0.37, 0.21, 0.29, 0.13]]) {
      const weights = new Float32Array(12)
      w.forEach((v, i) => (weights[i * 3] = v))
      expect(blendStrips(strips, weights, out)).toEqual(id)
    }
  })

  it('blends two different strips linearly', () => {
    const black = new Uint8Array(LUT_BYTES)
    const white = new Uint8Array(LUT_BYTES).fill(200)
    const out = blendStrips([black, white], [0.25, 0.75], new Uint8Array(LUT_BYTES))
    expect(out[0]).toBe(150)
    expect(out[LUT_BYTES - 1]).toBe(150)
  })

  it('the built-in keys grade: dusk warm, night blue, rain greyer, mid grey stays near grey by day', () => {
    const mid = 16
    const dusk = at(builtinLutStrip('dusk_clear'), mid, mid, mid)
    expect(dusk[0]).toBeGreaterThan(dusk[2] + 10)
    const night = at(builtinLutStrip('night_clear'), mid, mid, mid)
    expect(night[2]).toBeGreaterThan(night[0] + 10)
    const day = at(builtinLutStrip('day_clear'), mid, mid, mid)
    expect(Math.max(...day) - Math.min(...day)).toBeLessThan(14)
    // Saturation: a saturated red loses chroma in rain.
    const chroma = (c: number[]) => Math.max(...c) - Math.min(...c)
    expect(chroma(at(builtinLutStrip('day_rain'), 28, 6, 6))).toBeLessThan(chroma(at(builtinLutStrip('day_clear'), 28, 6, 6)))
    for (const k of LUT_KEYS) expect(builtinLutStrip(k)).not.toEqual(makeLutStrip([]))
  })

  it('gradeColor keeps colours in 0..1', () => {
    for (const p of Object.values(GRADE_TIME)) {
      for (const c of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0.2, 0.9, 0.4]]) {
        for (const v of gradeColor([...c], p)) expect(v >= 0 && v <= 1).toBe(true)
      }
    }
  })
})

describe('grade weights', () => {
  const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0)

  it('sum to 1 with at most four keys everywhere', () => {
    for (let e = -40; e <= 80; e += 3) {
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        for (const cloud of [0, 0.3, 0.7, 1]) {
          for (const rain of [0, 0.5, 1]) {
            const w = gradeWeights(e, t, cloud, rain)
            expect(sum(w)).toBeCloseTo(1, 5)
            expect(Array.from(w).filter(v => v > 0).length).toBeLessThanOrEqual(4)
            expect(Array.from(w).every(v => v >= 0)).toBe(true)
          }
        }
      }
    }
  })

  it('follow the sun: noon → day, midnight → night, a low sun → dawn before noon and dusk after', () => {
    expect(Array.from(timeWeights(60, 0.5))).toEqual([0, 1, 0, 0])
    expect(Array.from(timeWeights(-30, 0.0))).toEqual([0, 0, 0, 1])
    const morning = timeWeights(8, 0.27)
    expect(morning[0]).toBeGreaterThan(0.5)
    expect(morning[2]).toBe(0)
    const evening = timeWeights(8, 0.73)
    expect(evening[2]).toBeGreaterThan(0.5)
    expect(evening[0]).toBe(0)
    for (let e = -10; e <= 30; e += 0.5) expect(sum(timeWeights(e, 0.7))).toBeCloseTo(1, 6)
  })

  it('follow the weather (D26: clear = 1 − cloud, overcast = cloud × (1 − rain), rain = rain, normalised)', () => {
    expect(Array.from(weatherWeights(0, 0))).toEqual([1, 0, 0])
    expect(Array.from(weatherWeights(1, 0))).toEqual([0, 1, 0])
    expect(Array.from(weatherWeights(1, 1))).toEqual([0, 0, 1])
    const w = weatherWeights(0.6, 0.5)
    expect(sum(w)).toBeCloseTo(1, 6)
    expect(w[0]! / w[2]!).toBeCloseTo(0.4 / 0.5, 5)
    const all = gradeWeights(60, 0.5, 1, 1)
    expect(all[LUT_KEYS.indexOf('day_rain')]).toBeCloseTo(1, 6)
  })
})

describe('GradeMixer (NullEngine)', () => {
  it('uploads a 32³ texture, and re-uploads only when a weight moved by more than 0.01', () => {
    const s = scene()
    const mix = new GradeMixer(s)
    cleanups.push(() => mix.dispose())
    expect(mix.texture.is3D).toBe(true)
    expect(mix.texture.getSize()).toEqual({ width: 32, height: 32 })
    expect(mix.texture.level).toBe(1)
    const g = { sunElevationDeg: 60, t: 0.5, cloud: 0.1, rain: 0 }
    expect(mix.update(g)).toBe(true)
    expect(mix.uploads).toBe(1)
    expect(mix.update(g)).toBe(false)
    // cloud 0.1 → 0.105: weights move by 0.005.
    expect(mix.update({ ...g, cloud: 0.105 })).toBe(false)
    expect(mix.uploads).toBe(1)
    expect(mix.update({ ...g, cloud: 0.2 })).toBe(true)
    expect(mix.uploads).toBe(2)
    mix.setStrip('day_clear', makeLutStrip([]))
    expect(mix.update({ ...g, cloud: 0.2 })).toBe(true)
    expect(() => mix.setStrip('day_clear', new Uint8Array(4))).toThrow()
  })
})
