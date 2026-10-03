/**
 * The weather seams (docs/WAVE_PLAN3.md §4.1, D13, D25; docs/WEATHER.md §5.3): toSkyWeather / toRenderWeather keep
 * every field in range for the six states, their blends and a lightning peak; a clear frame is the identity on the
 * environment and the fog; World.setWeather feeds all three subsystems.
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { WEATHER_KINDS, blendWeather, fogScale, transitionMs, weatherParams, type WeatherKind, type WeatherParams } from '../../shared/src/weather.ts'
import {
  CLEAR_FRAME,
  CLEAR_RENDER_WEATHER,
  FOG_RANGE_M,
  applyWeatherToEnv,
  loadWorld,
  toRenderWeather,
  toSkyWeather,
  weatherFogScale,
  type RenderPart,
  type RenderWeather,
  type SkyWeather,
  type WeatherFrame,
} from '../src/index.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** A frame as the weather feature builds it (WEATHER §5.4): blended params, a wind direction, gusts, surface state. */
function frameOf(p: WeatherParams, opts: { dir?: number; gust?: number; wet?: number; puddle?: number; flash?: number } = {}): WeatherFrame {
  const dir = opts.dir ?? 0.7
  return {
    cloud: p.cloud, cloudDark: p.cloudDark, cirrus: p.cirrus, rain: p.rain, fog: p.fog, sun: p.sun, desat: p.desat,
    windX: Math.cos(dir), windZ: Math.sin(dir), windMs: p.windMs, gustMs: p.windMs * (1 + p.gust * (opts.gust ?? 1)),
    wet: opts.wet ?? p.rain, puddle: opts.puddle ?? p.rain * 0.8,
    flash: opts.flash ?? 0, flashX: 0, flashZ: 1,
    time: 1234.5,
  }
}

const in01 = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1

function checkSky(s: SkyWeather, label: string): void {
  for (const k of ['cloudCover', 'cloudDarkness', 'cirrus', 'haze', 'precipitation', 'flash'] as const) expect(in01(s[k]), `${label} sky.${k} = ${s[k]}`).toBe(true)
  expect(Number.isFinite(s.wind.x) && Number.isFinite(s.wind.z), label).toBe(true)
  expect(Math.hypot(s.wind.x, s.wind.z), `${label} sky wind`).toBeLessThanOrEqual(30)
}

function checkRender(r: RenderWeather, label: string): void {
  for (const k of ['rain', 'wetness', 'puddles', 'cloud', 'flash'] as const) expect(in01(r[k]), `${label} render.${k} = ${r[k]}`).toBe(true)
  expect(Number.isFinite(r.fogMul) && r.fogMul >= 1, `${label} fogMul ${r.fogMul}`).toBe(true)
  // fogScale >= 0.35 × 0.75: visibility never drops below ~26 % of the clear distance.
  expect(r.fogMul).toBeLessThanOrEqual(1 / (0.35 * 0.75) + 1e-9)
  expect(r.wind >= 0 && r.wind <= 2, `${label} wind ${r.wind}`).toBe(true)
}

describe('toSkyWeather / toRenderWeather', () => {
  it('every field in range for the six states (rain at 0.4 and 1), with a lightning peak', () => {
    for (const kind of WEATHER_KINDS) {
      for (const intensity of kind === 'rain' ? [0.4, 1] : [1]) {
        for (const flash of [0, 1.5, 3, 4]) {
          const f = frameOf(weatherParams(kind, intensity), { flash })
          checkSky(toSkyWeather(f), `${kind}@${intensity} flash ${flash}`)
          checkRender(toRenderWeather(f), `${kind}@${intensity} flash ${flash}`)
        }
      }
    }
  })

  it('every field in range across every blend (30 steps of each transition)', () => {
    for (const from of WEATHER_KINDS) {
      for (const to of WEATHER_KINDS) {
        const dur = transitionMs(from, to)
        const sync = { start: 0, dur, from, to, intensity: to === 'rain' ? 0.6 : 1 }
        for (let i = 0; i <= 30; i++) {
          const f = frameOf(blendWeather(sync, (dur * i) / 30), { gust: (i % 3) / 2 })
          checkSky(toSkyWeather(f), `${from}->${to} ${i}`)
          checkRender(toRenderWeather(f), `${from}->${to} ${i}`)
        }
      }
    }
  })

  it('maps the fields as WEATHER §5.3 says (plus flash, D25)', () => {
    const storm = frameOf(weatherParams('storm'), { flash: 1.5, wet: 0.7, puddle: 0.4 })
    const s = toSkyWeather(storm)
    expect(s.cloudCover).toBe(storm.cloud)
    expect(s.haze).toBeCloseTo(Math.min(1, storm.fog + 0.3 * storm.rain), 12)
    expect(s.wind.x).toBeCloseTo(storm.windX * storm.windMs, 12)
    expect(s.flash).toBeCloseTo(0.5, 12)
    const r = toRenderWeather(storm)
    expect([r.rain, r.wetness, r.puddles, r.cloud]).toEqual([storm.rain, 0.7, 0.4, storm.cloud])
    expect(r.fogMul).toBeCloseTo(1 / fogScale(storm), 12)
    expect(r.wind).toBeCloseTo(Math.min(2, storm.gustMs / 8), 12)
    expect(r.flash).toBeCloseTo(0.5, 12)
    expect(toRenderWeather(frameOf(weatherParams('storm'), { flash: 9 })).flash).toBe(1)
  })

  it('a clear frame is calm: fog × 1, no flash, the environment untouched', () => {
    const r = toRenderWeather(CLEAR_FRAME)
    expect(r.fogMul).toBe(1)
    expect(r.flash).toBe(0)
    expect([r.rain, r.wetness, r.puddles]).toEqual([0, 0, 0])
    expect(r.cloud).toBe(CLEAR_RENDER_WEATHER.cloud)
    expect(weatherFogScale(CLEAR_FRAME)).toEqual({ start: 1, end: 1 })
    const env = { g10: 0.5 } as unknown as Parameters<typeof applyWeatherToEnv>[0]
    expect(applyWeatherToEnv(env, CLEAR_FRAME)).toBe(env)
  })

  it('weatherFogScale shortens the fog in fog and rain, never below ~9 % of the clear distance', () => {
    const kinds: WeatherKind[] = ['fog', 'storm', 'rain']
    for (const k of kinds) {
      const s = weatherFogScale(weatherParams(k))
      expect(s.end).toBeLessThan(1)
      expect(s.end).toBeGreaterThan(0.09)
      expect(s.start).toBeLessThanOrEqual(s.end + 1e-9)
      expect(s.start).toBeGreaterThan(0)
    }
  })
})

describe('World.setWeather (the one public entry, D13)', () => {
  it('feeds the sky, the renderer parts and the weather vectors; the fog follows at the next update', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const fx = makeFixture()
    const world = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'medium' })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    const got: RenderWeather[] = []
    const part: RenderPart = { setWeather: w => got.push(w) }
    world.render.lighting = part
    world.update(null, { x: 96, z: -96 })
    const clearEnd = scene.fogEnd
    const f = frameOf(weatherParams('storm'), { wet: 0.5, puddle: 0.25, flash: 3 })
    world.setWeather(f)
    expect(world.weatherState).toBe(f)
    expect(world.sky.weather).toEqual(toSkyWeather(f))
    expect(got).toEqual([toRenderWeather(f)])
    expect(world.render.weather).toEqual(toRenderWeather(f))
    expect(world.weather.frame).toBe(f)
    expect(world.weather.u.wxA.x).toBe(0.5)
    expect(world.weather.u.wxA.y).toBe(0.25)
    expect(world.weather.u.wxC.w).toBe(3)
    world.update(null, { x: 96, z: -96 })
    expect(scene.fogEnd).toBeCloseTo(clearEnd * fogScale(f), 6)
    expect(world.fogRange.end).toBeCloseTo(world.skyState.env.g11 * FOG_RANGE_M * fogScale(f), 6)
    world.setWeather(CLEAR_FRAME)
    world.update(null, { x: 96, z: -96 })
    expect(scene.fogEnd).toBe(clearEnd)
  })
})
