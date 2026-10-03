/**
 * The rain box (docs/WEATHER.md §6.8): the TS mirror of the vertex shader's wrap keeps every drop inside the box around
 * the camera while the camera travels 1000 m and the fall offset grows, a drop is world-anchored (it does not move
 * with the camera inside the box), the mirror's hash is the shaders' hash, and a storm slants the rain about 35°.
 */
import { describe, expect, it } from 'vitest'
import { weatherParams } from '../../shared/src/weather.ts'
import { RAIN_SHADERS, hash3, rainDropPosition, rainMotion } from '../src/weather/rain.ts'

const SIZE = [40, 24, 40] as const

describe('rain box wrap (a mirror of the vertex shader)', () => {
  it('every drop stays inside the box as the camera moves 1000 m and the rain falls', () => {
    const offset = [0, 0, 0]
    const vel = rainMotion({ rain: 1, windX: 0.8, windZ: -0.6, gustMs: 20 }).vel
    for (let step = 0; step <= 200; step++) {
      const cam = [step * 5, 30 + Math.sin(step) * 4, -step * 2.5]
      for (let i = 0; i < 3; i++) offset[i] = offset[i]! + vel[i]! * 0.05
      for (let id = 0; id < 400; id += 7) {
        const p = rainDropPosition(id, cam, SIZE, offset)
        for (let i = 0; i < 3; i++) {
          expect(p[i]).toBeGreaterThanOrEqual(cam[i]! - SIZE[i]! / 2 - 1e-6)
          expect(p[i]).toBeLessThan(cam[i]! + SIZE[i]! / 2 + 1e-6)
        }
      }
    }
  })

  it('a drop is world-anchored: a small camera move leaves it where it was', () => {
    const offset = [3.2, -7.5, 1.1]
    const a = rainDropPosition(42, [0, 0, 0], SIZE, offset)
    // Move the camera toward the drop by less than the distance to the box edge: the drop has not wrapped.
    const cam = [a[0] * 0.5, a[1] * 0.5, a[2] * 0.5]
    const b = rainDropPosition(42, cam, SIZE, offset)
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i]!, 9)
  })

  it('an offset that wrapped by a whole box leaves every drop in place (the CPU wraps it)', () => {
    const cam = [100, 20, -50]
    for (let id = 0; id < 50; id++) {
      const a = rainDropPosition(id, cam, SIZE, [1, 2, 3])
      const b = rainDropPosition(id, cam, SIZE, [1 + SIZE[0], 2 - 3 * SIZE[1], 3 + 2 * SIZE[2]])
      for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i]!, 6)
    }
  })

  it('the mirror uses the shaders\' hash', () => {
    for (const s of Object.values(RAIN_SHADERS)) {
      if (!s.vertexWGSL.includes('wxHash3')) continue
      expect(s.vertexWGSL).toContain('fract(sin(vec3f(n, n + 1.0, n + 2.0)) * vec3f(43758.5453, 22578.1459, 19642.349))')
      expect(s.vertexGLSL).toContain('fract(sin(vec3(n, n + 1.0, n + 2.0)) * vec3(43758.5453, 22578.1459, 19642.349))')
    }
    const h = hash3(3.2)
    for (const v of h) expect(v >= 0 && v < 1).toBe(true)
    expect(RAIN_SHADERS.sroRain.vertexWGSL).toContain('let q = seed * size + uniforms.rainP0.xyz - lo;')
    expect(RAIN_SHADERS.sroRain.vertexWGSL).toContain('let p = lo + q - size * floor(q / size);')
    expect(RAIN_SHADERS.sroRain.vertexGLSL).toContain('vec3 p = lo + q - size * floor(q / size);')
  })
})

describe('rain motion', () => {
  it('falls 9 m/s in rain and 11 m/s in a storm; a storm at its mean wind slants about 35°', () => {
    const rain = weatherParams('rain')
    const storm = weatherParams('storm')
    const r = rainMotion({ rain: rain.rain, windX: 1, windZ: 0, gustMs: rain.windMs })
    const s = rainMotion({ rain: storm.rain, windX: 1, windZ: 0, gustMs: storm.windMs })
    expect(-r.vel[1]).toBeCloseTo(9, 1)
    expect(-s.vel[1]).toBeCloseTo(11, 6)
    expect(s.length).toBeCloseTo(0.8, 6)
    const deg = (Math.atan2(Math.hypot(s.vel[0], s.vel[2]), -s.vel[1]) * 180) / Math.PI
    expect(deg).toBeGreaterThan(30)
    expect(deg).toBeLessThan(40)
    // No wind, no slant.
    expect(rainMotion({ rain: 1, windX: 1, windZ: 0, gustMs: 0 }).vel[0]).toBe(0)
  })
})
