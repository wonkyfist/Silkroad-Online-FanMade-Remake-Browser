/**
 * CST-O, the wave sources and the sea state (docs/COAST.md §8.3, §8.4, §8.7, §8.13 S-CLOCK, §12.4; D27): the worker
 * tile asks one tick ahead, interpolates between two ticks, holds the last one when the worker is late and asks for
 * nothing while idle; the weather filter builds a storm over minutes (τ 120 s), rebuilds at most once a second and only
 * past its thresholds, snaps on the first frame, damps each consumer's finest cascade in rain, and follows the frame's
 * wind direction (the clouds' `windX/Z`) within 3 τ; Low's Gerstner set comes from the same spectrum (same Hs, the
 * steepness rule, the 3,600 s wrap); the GPU FFT is only offered on WebGPU with compute (never on NullEngine / WebGL2);
 * the shore seam (filled by CST-S) lands only under its define.
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { gpuFftSupported } from '../src/ocean/fft-gpu.ts'
import { gerstnerAt, gerstnerHs, gerstnerSet } from '../src/ocean/gerstner.ts'
import { oceanCode } from '../src/ocean/ocean-plugin.ts'
import { SHORE_DEFINE, shoreHasCode } from '../src/ocean/shore-seam.ts'
import { HS_MAX_M, WORKER_TILES_M, cascadesFor, significantHeight } from '../src/ocean/spectrum.ts'
import { WorkerTile } from '../src/ocean/tile.ts'
import { STORM_TAU_S, SeaWeather, WIND_TAU_S, seaParams, swellTravelRad } from '../src/ocean/weather.ts'
import { SHORE_FRAGMENT, SHORE_SAMPLERS, SHORE_UNIFORMS, SHORE_VERTEX } from '../src/shore/chunks.ts'
import { createShorePart } from '../src/shore/index.ts'
import { CLEAR_FRAME, type WeatherFrame } from '../src/weather/frame.ts'

const engines: NullEngine[] = []
afterAll(() => {
  for (const e of engines.splice(0)) e.dispose()
})

function scene(): Scene {
  const e = new NullEngine()
  engines.push(e)
  return new Scene(e)
}

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const frame = (o: Partial<WeatherFrame>): WeatherFrame => ({ ...CLEAR_FRAME, ...o })

describe('the worker tile (COAST §8.4)', () => {
  it('asks one tick ahead, interpolates between two ticks, uploads once per tick', async () => {
    const tile = new WorkerTile(scene(), cascadesFor(WORKER_TILES_M, 16), 20, { worker: false })
    tile.setParams(seaParams({ windMs: 6, windDirRad: 0, storm: 0.3, swellFromDeg: 150 }))
    tile.update(0, true)
    await settle()
    tile.update(0.01, true)
    expect(tile.ready).toBe(true)
    expect(tile.lerp).toBeCloseTo(0.2, 6)
    expect([tile.prevBase, tile.nextBase]).toEqual([0, tile.layersPerSet])
    const uploads = tile.stats.uploads
    tile.update(0.03, true)
    expect(tile.stats.uploads).toBe(uploads)
    await settle()
    tile.update(0.06, true)
    expect(tile.stats.uploads).toBe(uploads + 1)
    expect(tile.lerp).toBeCloseTo(0.2, 6)
    tile.dispose()
  })

  it('holds the last tick when the worker is late (no jump), and asks nothing while idle (D27)', async () => {
    const tile = new WorkerTile(scene(), cascadesFor(WORKER_TILES_M, 16), 20, { worker: false })
    tile.setParams(seaParams({ windMs: 2, windDirRad: 0, storm: 0, swellFromDeg: 150 }))
    tile.update(0, true)
    await settle()
    tile.update(0.01, true)
    // Jump far ahead without letting the "worker" answer: the render holds.
    tile.update(5, true)
    expect(tile.stats.held).toBeGreaterThan(0)
    expect(tile.lerp).toBe(1)
    await settle()
    // Idle: no node selected, nothing asked.
    const ticks = tile.stats.ticks
    tile.update(100, false)
    await settle()
    tile.update(100.5, false)
    await settle()
    expect(tile.stats.ticks).toBe(ticks)
    tile.dispose()
  })
})

describe('the sea state from the weather (COAST §8.7)', () => {
  it('snaps on the first frame, then a storm builds over minutes (τ 120 s)', () => {
    const w = new SeaWeather()
    w.update(frame({ windMs: 2, gustMs: 2, cloudDark: 0 }), 0)
    expect(w.state.storm).toBe(0)
    const storm = frame({ windMs: 13, gustMs: 16, cloudDark: 0.8, rain: 1 })
    let t = 0
    for (; t < 60; t += 0.5) w.update(storm, 0.5)
    const after1 = w.frameKnobs.storm
    expect(after1).toBeGreaterThan(0.25)
    expect(after1).toBeLessThan(0.6)
    for (; t < 600; t += 0.5) w.update(storm, 0.5)
    expect(w.frameKnobs.storm).toBeGreaterThan(0.95)
    expect(STORM_TAU_S).toBe(120)
    // A storm's sea is clamped at 2.5 m.
    expect(significantHeight(cascadesFor(WORKER_TILES_M, 64), w.params)).toBeGreaterThan(HS_MAX_M)
  })

  it('rebuilds at most once a second, and only past the thresholds (0.25 m/s, 3°, 0.02 storm)', () => {
    const w = new SeaWeather()
    w.update(frame({ windMs: 6, gustMs: 6, windX: 1, windZ: 0 }), 0)
    const r0 = w.revision
    let rebuilds = 0
    for (let i = 0; i < 100; i++) if (w.update(frame({ windMs: 6.1, gustMs: 6.1, windX: 1, windZ: 0 }), 0.05)) rebuilds++
    expect(rebuilds).toBe(0)
    let last = -1
    let t = 0
    for (let i = 0; i < 600; i++, t += 0.05) {
      if (w.update(frame({ windMs: 12, gustMs: 12, windX: 0, windZ: 1 }), 0.05)) {
        if (last >= 0) expect(t - last).toBeGreaterThanOrEqual(0.999)
        last = t
        rebuilds++
      }
    }
    expect(rebuilds).toBeGreaterThan(3)
    expect(w.revision - r0).toBe(rebuilds)
  })

  it('S-CLOCK: the sea follows the frame\'s wind direction (the clouds\') within 3 τ', () => {
    const w = new SeaWeather()
    w.update(frame({ windMs: 8, gustMs: 8, windX: 1, windZ: 0 }), 0)
    const target = Math.atan2(0.6, 0.8)
    for (let t = 0; t < 3 * WIND_TAU_S; t += 0.1) w.update(frame({ windMs: 8, gustMs: 8, windX: 0.8, windZ: 0.6 }), 0.1)
    // The last rebuild is at most a second and 3° behind.
    expect(Math.abs(w.state.windDirRad - target)).toBeLessThan((4 * Math.PI) / 180)
  })

  it('rain damps each consumer\'s own finest cascade; the whitecap threshold rises with the storm and the gusts', () => {
    const w = new SeaWeather()
    w.update(frame({ windMs: 13, gustMs: 18, rain: 1, cloudDark: 0.85 }), 0)
    expect(w.tileFor(2).gains).toEqual([1, 0.7])
    expect(w.tileFor(4).gains).toEqual([1, 1, 1, 0.7])
    expect(w.tileFor(2).foamBias).toBeGreaterThan(0.85)
    const calm = new SeaWeather()
    calm.update(frame({ windMs: 2, gustMs: 2 }), 0)
    expect(calm.tileFor(2).foamBias).toBeCloseTo(0.8, 6)
    expect(calm.tileFor(2).choppiness).toBeCloseTo(0.9, 6)
  })

  it('the swell comes from the open sea: from the SSE (150°) it travels NNW (glTF: north = −z)', () => {
    const a = swellTravelRad(150)
    expect(Math.sin(a)).toBeLessThan(0)
    expect(Math.cos(a)).toBeLessThan(0)
    const n = swellTravelRad(180)
    expect(Math.cos(n)).toBeCloseTo(0, 9)
    expect(Math.sin(n)).toBeCloseTo(-1, 9)
  })
})

describe('Low\'s Gerstner set (COAST §8.4)', () => {
  it('three waves from the same spectrum: the same sea state, Q k A ≤ 0.2, seamless at 3,600 s, the clamp', () => {
    for (const [windMs, storm] of [[2, 0], [6, 0.36], [13, 1]] as const) {
      const p = seaParams({ windMs, windDirRad: 0.4, storm, swellFromDeg: 150 })
      const set = gerstnerSet(p)
      expect(set.length).toBe(3)
      const hs = gerstnerHs(set)
      expect(hs).toBeLessThanOrEqual(HS_MAX_M + 1e-9)
      expect(hs).toBeGreaterThan(0.2)
      for (const w of set) expect(w.q * w.k * w.amp).toBeLessThanOrEqual(0.2 + 1e-9)
      const a = gerstnerAt(set, 12.3, -45.6, 0), b = gerstnerAt(set, 12.3, -45.6, 3600)
      expect(Math.abs(a.dy - b.dy)).toBeLessThan(1e-6)
    }
    // Shallow water flattens the longest wave first.
    const set = gerstnerSet(seaParams({ windMs: 6, windDirRad: 0, storm: 0.5, swellFromDeg: 150 }))
    const deep = gerstnerAt(set, 3, 4, 17, 60), shallow = gerstnerAt(set, 3, 4, 17, 0)
    expect(Math.abs(shallow.dy)).toBeLessThanOrEqual(Math.abs(deep.dy) + 1e-9)
  })
})

describe('the GPU FFT gate (COAST §8.3)', () => {
  it('is offered only on WebGPU with compute: never on NullEngine (so never on WebGL2 or in Node)', () => {
    const s = scene()
    expect(gpuFftSupported(s.getEngine())).toBe(false)
  })
})

describe('the shore seam (COAST §12.4 "first commit", §12.5)', () => {
  it('is filled by CST-S (shore-chunks.test.ts): code, uniforms, a sampler and a part; the ocean inserts it under the shore define only', () => {
    expect(shoreHasCode(SHORE_VERTEX)).toBe(true)
    expect(shoreHasCode(SHORE_FRAGMENT)).toBe(true)
    expect([SHORE_UNIFORMS.length, SHORE_SAMPLERS.length]).toEqual([2, 1])
    expect(typeof createShorePart).toBe('function')
    for (const stage of ['vertex', 'fragment'] as const) for (const lang of ['wgsl', 'glsl'] as const) {
      const code = Object.values(oceanCode(stage, lang)).join('\n')
      const at = code.indexOf(`#ifdef ${SHORE_DEFINE}`)
      expect(at).toBeGreaterThan(0)
      // Every inserted block is guarded: the code with the guarded blocks removed carries no shore name.
      const stripped = code.replace(new RegExp(`#ifdef ${SHORE_DEFINE}\\n[\\s\\S]*?\\n#endif\\n`, 'g'), '')
      expect(stripped).not.toMatch(/\bsroSh[A-Z]|\bsroShore/)
    }
  })

  it('the variables the seam documents exist in both languages of both stages', () => {
    const need = { vertex: ['sroOcRest', 'sroOcField', 'sroOcPos', 'sroOcFoam', 'sroOcSwash'], fragment: ['sroOcRest', 'sroOcField', 'sroOcFoam', 'sroOcSwash', 'sroOcAlpha'] }
    for (const stage of ['vertex', 'fragment'] as const) for (const lang of ['wgsl', 'glsl'] as const) {
      const code = Object.values(oceanCode(stage, lang)).join('\n')
      for (const v of need[stage]) expect(code, `${stage}/${lang}: ${v}`).toMatch(new RegExp(lang === 'wgsl' ? `var<private> ${v}:` : `\\b(?:vec[234]|float) ${v};`))
    }
  })
})
