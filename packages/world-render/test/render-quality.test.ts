/**
 * The wave-9 preset tables (docs/WAVE_PLAN3.md §5.1, D5): RENDER_PRESETS, SKY_PRESETS and WEATHER_PRESETS hold the
 * merged table as data, every preset has every key, Low (the Classic path) has every render feature off, and Ultra
 * keeps High's world and streaming settings.
 */
import { describe, expect, it } from 'vitest'
import {
  QUALITY_PRESETS,
  RENDER_PRESETS,
  SKY_PRESETS,
  STREAM_DEFAULTS,
  WEATHER_LEVELS,
  WEATHER_PRESETS,
  type RenderPreset,
} from '../src/index.ts'

const PRESETS: readonly RenderPreset[] = ['low', 'medium', 'high', 'ultra']

/** Every key path of an object, with null leaves counted as leaves (a null block is still "the key is there"). */
function keyPaths(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [prefix]
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k)).sort()
}

/** Top-level keys plus the keys of every non-null block. */
function shape(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort()
}

describe('RENDER_PRESETS (the §5.1 render rows)', () => {
  it('has the four presets, each with every key', () => {
    expect(Object.keys(RENDER_PRESETS).sort()).toEqual([...PRESETS].sort())
    const keys = shape(RENDER_PRESETS.ultra as unknown as Record<string, unknown>)
    for (const p of PRESETS) {
      expect(shape(RENDER_PRESETS[p] as unknown as Record<string, unknown>), p).toEqual(keys)
      expect(keyPaths(RENDER_PRESETS[p].terrain), p).toEqual(keyPaths(RENDER_PRESETS.ultra.terrain))
      expect(keyPaths(RENDER_PRESETS[p].nightLights), p).toEqual(keyPaths(RENDER_PRESETS.ultra.nightLights))
      expect(keyPaths(RENDER_PRESETS[p].foliage), p).toEqual(keyPaths(RENDER_PRESETS.ultra.foliage))
      for (const block of ['shadows', 'ibl', 'ssao'] as const) {
        const v = RENDER_PRESETS[p][block]
        if (v) expect(keyPaths(v), `${p}.${block}`).toEqual(keyPaths(RENDER_PRESETS.ultra[block]))
      }
    }
  })

  it('Low is the Classic path with every render feature off', () => {
    const l = RENDER_PRESETS.low
    expect(l.path).toBe('classic')
    expect(Object.values(l.terrain).every(v => v === false)).toBe(true)
    expect([l.hdr, l.toneMap, l.lutGrade, l.bloom]).toEqual([false, 'none', false, 0])
    expect([l.shadows, l.ibl, l.ssao, l.ssr]).toEqual([null, null, null, 'off'])
    // Night: the splat and emissive only, no point lights (D12), so Classic light counts stay as today.
    expect([l.nightLights.cluster, l.nightLights.poolFallback]).toEqual([0, 0])
    expect([l.aa, l.lightShafts, l.fog, l.horizonRingFog]).toEqual(['msaa', 'off', 'linear', false])
    expect([l.water, l.waterDepthShore, l.waterMirror]).toEqual(['classic', false, false])
    expect(Object.values(l.foliage).every(v => v === false)).toBe(true)
    expect(l.renderScale).toBe(1)
  })

  it('Medium, High and Ultra follow the §5.1 table', () => {
    const { medium: m, high: h, ultra: u } = RENDER_PRESETS
    for (const p of [m, h, u]) expect([p.path, p.hdr, p.toneMap, p.lutGrade, p.water, p.fog]).toEqual(['pbr', true, 'neutral', true, 'pbr', 'height'])
    // Bloom is off on every preset (Options → Bloom brings it back, BLOOM_LOOKS; the release shipped 0.5 / 1 / 1).
    for (const p of [m, h, u]) expect([p.bloom, p.bloomThreshold, p.bloomWeight]).toEqual([0, undefined, undefined])
    expect(m.shadows).toMatchObject({ cascades: 2, mapSize: 1024, distanceM: 60, foliageM: 0, terrain: false })
    expect(h.shadows).toMatchObject({ cascades: 3, mapSize: 2048, distanceM: 150, foliageM: 60, terrain: true, props: false })
    expect(u.shadows).toMatchObject({ cascades: 4, mapSize: 2048, distanceM: 250, props: true })
    expect([m.ibl, h.ibl, u.ibl]).toEqual([{ cubeSize: 32, refreshS: 10 }, { cubeSize: 64, refreshS: 5 }, { cubeSize: 64, refreshS: 2 }])
    expect([m.nightLights.cluster, h.nightLights.cluster, u.nightLights.cluster]).toEqual([8, 32, 64])
    expect(m.nightLights.poolFallback).toBe(2)
    // D29: the terrain splat only on the Classic Low; on every PBR preset (Medium included since it went PBR, W9F D3)
    // the cluster/pool lights the terrain. The grass always.
    expect(PRESETS.map(p => RENDER_PRESETS[p].nightLights.terrainSplat)).toEqual([true, false, false, false])
    expect(PRESETS.every(p => RENDER_PRESETS[p].nightLights.grassSplat)).toBe(true)
    expect([m.ssao, h.ssao, u.ssao]).toEqual([null, { halfRes: true, samples: 8 }, { halfRes: false, samples: 16 }])
    expect([m.ssr, h.ssr, u.ssr]).toEqual(['off', 'off', 'always']) // §6.20 cut 4 (wave-9 final gate)
    expect([m.aa, h.aa, u.aa]).toEqual(['fxaa', 'taa', 'taa'])
    // Wave 12 (GODRAYS): the sun shafts, light on Medium and full on High and Ultra.
    expect([m.lightShafts, h.lightShafts, u.lightShafts]).toEqual(['low', 'high', 'high'])
    expect([m.horizonRingFog, h.horizonRingFog, u.horizonRingFog]).toEqual([false, true, true])
    expect([m.waterDepthShore, h.waterDepthShore, u.waterDepthShore, u.waterMirror]).toEqual([false, true, true, true])
    expect(u.terrain.parallax && u.terrain.antiTiling && !h.terrain.parallax && h.terrain.triplanar).toBe(true)
  })
})

describe('SKY_PRESETS (the §5.1 sky rows)', () => {
  it('has every key on every preset', () => {
    const keys = keyPaths(SKY_PRESETS.ultra)
    for (const p of PRESETS) expect(keyPaths(SKY_PRESETS[p]), p).toEqual(keys)
  })

  it('LUTs, clouds, shadows, stars and the sun path per preset', () => {
    expect(PRESETS.map(p => SKY_PRESETS[p].lut)).toEqual([
      { width: 48, height: 24, steps: 12, refreshS: 4, worker: false },
      { width: 96, height: 48, steps: 16, refreshS: 2, worker: false },
      { width: 96, height: 48, steps: 24, refreshS: 1, worker: false },
      { width: 128, height: 64, steps: 32, refreshS: 0.5, worker: true },
    ])
    expect(PRESETS.map(p => SKY_PRESETS[p].clouds.kind)).toEqual(['retail', 'cumulus', 'cumulus', 'cumulus'])
    expect(PRESETS.map(p => SKY_PRESETS[p].cloudShadows)).toEqual(['off', 'off', 'ground', 'all'])
    expect(PRESETS.map(p => SKY_PRESETS[p].stars.perFace)).toEqual([128, 256, 256, 256])
    expect(PRESETS.map(p => SKY_PRESETS[p].flares)).toEqual([0, 0, 4, 8])
    expect(PRESETS.map(p => SKY_PRESETS[p].sunPath)).toEqual(['baked', 'dynamic', 'dynamic', 'dynamic'])
  })
})

describe('WEATHER_PRESETS (WEATHER §9.1)', () => {
  it('has every level with every key; off draws nothing but keeps the wind', () => {
    expect(Object.keys(WEATHER_PRESETS)).toEqual([...WEATHER_LEVELS])
    const keys = keyPaths(WEATHER_PRESETS.ultra)
    for (const l of WEATHER_LEVELS) expect(keyPaths(WEATHER_PRESETS[l]), l).toEqual(keys)
    const off = WEATHER_PRESETS.off
    expect([off.wet, off.puddles, off.streaks, off.splashes, off.shelter, off.bolt, off.rippleSize]).toEqual([false, false, 0, 0, false, false, 0])
    expect([off.windGrass, off.windSkinned]).toEqual([true, true])
  })

  it('streaks, ripples, splashes, shelter and bolt per level', () => {
    expect(WEATHER_LEVELS.map(l => WEATHER_PRESETS[l].streaks)).toEqual([0, 3000, 10000, 20000, 40000])
    expect(WEATHER_LEVELS.map(l => WEATHER_PRESETS[l].rippleSize)).toEqual([0, 0, 128, 256, 256])
    expect(WEATHER_LEVELS.map(l => WEATHER_PRESETS[l].splashes)).toEqual([0, 0, 256, 512, 1024])
    expect(WEATHER_LEVELS.map(l => WEATHER_PRESETS[l].shelter)).toEqual([false, false, true, true, true])
    expect(WEATHER_LEVELS.map(l => WEATHER_PRESETS[l].bolt)).toEqual([false, false, false, true, true])
    expect(WEATHER_LEVELS.map(l => WEATHER_PRESETS[l].lensDrops)).toEqual([false, false, false, false, true])
  })
})

describe('Ultra (D5)', () => {
  it("keeps High's world and streaming settings", () => {
    expect(QUALITY_PRESETS.ultra).toEqual(QUALITY_PRESETS.high)
    expect(STREAM_DEFAULTS.ultra).toEqual(STREAM_DEFAULTS.high)
    expect(STREAM_DEFAULTS.ultra).not.toBe(STREAM_DEFAULTS.high)
  })
})
