/**
 * Adversarial hunt, wave 11 (H-11, docs/WAVE_PLAN7.md §6.6 lens 12 "Water and the pond"). Each `it` is a failing proof
 * of one finding; F-11 fixes the product code, never this file's expectations.
 *
 * - The "local rain" rings (TOWN_LIFE §5.3: the fountain's falls, the fish) cannot be seen. `sroWPoint`
 *   (pbr/water-town-plugin.ts) tilts the water normal by at most 0.12 × max(q·e^(−q²)) × strength ≈ 0.051 at
 *   strength 1 (the fountain passes 0.7: 0.036; the fish 0.55: 0.028), while the water's own two normal-map layers
 *   (pbr/water-plugin.ts: (n0 + 0.7 n1) × 0.35 × the wave amplitude, 1.0 for the town's wave type 2) have an RMS slope
 *   of ≈ 0.245. A ring is ~15 % of the noise it sits on, and only ≈ 0.17 m wide. (The fountain's three points also sit
 *   within 1.7 m of each other under the falls' curtain: fx.ts `at: 'bottom'` of cj_wf_dr_03–05.)
 * - The 'town' profile (TL-B's `pond`: turbidity 0.65) lifts the alpha to the turbidity everywhere the region's water
 *   draws, depth or not: `sroWAlpha = max(sroWAlpha, b × turbidity)`. At the waterline (depth 0, retail alpha 0, High's
 *   shore alpha 0) the pond is already 65 % opaque, so the 1.5 m soft shore (High) and the retail alpha ramp (Medium) are
 *   gone and every pond edge in the four profiled regions is a hard cut line.
 */
import { describe, expect, it } from 'vitest'
import { WATER_NORMAL_LAYERS, waterFragmentCode, waterNormalPixels, waveAmplitude } from '../src/pbr/water-plugin.ts'
import { RIPPLE_PERIOD_S, rippleTilt, waterTownFragmentCode } from '../src/pbr/water-town-plugin.ts'

/** The RMS of the PBR water's own normal slope (the plugin's two layers, the town's wave type 2), sampled on a grid. */
function backgroundSlopeRms(wave = 2): number {
  const n = 128
  const px = waterNormalPixels(n)
  const at = (u: number, v: number): [number, number] => {
    const x = ((Math.floor(u * n) % n) + n) % n
    const y = ((Math.floor(v * n) % n) + n) % n
    const o = (y * n + x) * 4
    return [(px[o]! / 255) * 2 - 1, (px[o + 1]! / 255) * 2 - 1]
  }
  const [l0, l1] = WATER_NORMAL_LAYERS
  // The plugin's own expression; the code is checked to still be that expression below.
  expect(waterFragmentCode('glsl')['CUSTOM_FRAGMENT_MAIN_BEGIN']).toContain('(sroN0 + sroN1 * 0.7) * (0.35 * sroWAmp)')
  const amp = waveAmplitude(wave)
  let s2 = 0
  let k = 0
  for (let i = 0; i < 160; i++) {
    for (let j = 0; j < 160; j++) {
      const x = i * 0.37, z = j * 0.41
      const a = at(x / l0.periodM, z / l0.periodM)
      const b = at(x / l1.periodM, z / l1.periodM)
      const sx = (a[0] + 0.7 * b[0]) * 0.35 * amp
      const sz = (a[1] + 0.7 * b[1]) * 0.35 * amp
      s2 += sx * sx + sz * sz
      k++
    }
  }
  return Math.sqrt(s2 / k)
}

/** The largest normal tilt a ring ever makes (over its life and its radius). */
function ringPeak(radiusM: number, strength: number): number {
  let peak = 0
  for (let r = 0.005; r <= radiusM; r += 0.005) {
    for (let t = 0; t < RIPPLE_PERIOD_S; t += 0.005) peak = Math.max(peak, Math.abs(rippleTilt(r, t, { radiusM, strength })))
  }
  return peak
}

describe('H-11 lens 12: ripples drowned by the water\'s own normal', () => {
  it('a ripple ring at full strength tilts the water at least half as much as the water\'s own waves (it can be seen)', () => {
    const noise = backgroundSlopeRms(2)
    expect(noise).toBeGreaterThan(0.15)
    // Strength 1 is the most any source can pass (WaterTownState.setPoints clamps it); the fountain's radius.
    const ring = ringPeak(1.4, 1)
    expect(ring, `ring peak ${ring.toFixed(3)} vs the water's RMS slope ${noise.toFixed(3)}`).toBeGreaterThanOrEqual(0.5 * noise)
  })
})

describe('H-11 lens 12: the pond profile and the shore', () => {
  /** The profile block's alpha line of one language. */
  const alphaLine = (lang: 'glsl' | 'wgsl') => {
    const code = waterTownFragmentCode(lang)['CUSTOM_FRAGMENT_MAIN_BEGIN']!
    const block = code.slice(code.indexOf('#ifdef SRO_WATER_PROFILE'))
    return { block, line: block.split('\n').find(l => /sroWAlpha\s*=/.test(l)) ?? '' }
  }

  it('the turbid profile does not make the waterline opaque: its alpha lift fades to 0 at depth 0 (both languages)', () => {
    for (const lang of ['glsl', 'wgsl'] as const) {
      const { block, line } = alphaLine(lang)
      expect(line, `${lang}: the profile writes the alpha`).not.toBe('')
      // The lift's weight (sroTW) is the vertex colour b × turbidity only: no depth (vColor.r), no retail alpha
      // (vColor.a), no shore alpha. A fix scales it by something that is 0 at the waterline.
      const weight = block.split('\n').find(l => /sroTW\s*=/.test(l)) ?? ''
      const usesDepth = (s: string) => /vColor\.(r|a)|sroWD|sroWAlpha\s*\*|smoothstep|shore/i.test(s)
      expect(usesDepth(weight) || usesDepth(line), `${lang}: ${weight.trim()} / ${line.trim()}`).toBe(true)
    }
  })
})
