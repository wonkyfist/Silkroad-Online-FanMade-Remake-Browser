/**
 * Tiger Girl's moves (world/tiger-moves.ts, skills-view.ts shapePilotPlans, audio/synth.ts): the cast-id mapping, the
 * pounce arc (crouch, parabola, touchdown exactly at the server's landing), the clip rate that puts the strike on the
 * touchdown, the gait (WALK at the matched rate while stalking, no skating), the shake fall-off, the roar's full clip,
 * and the synthesized roar / thud.
 */
import { describe, expect, it } from 'vitest'
import { SYNTH_RATE, TIGER_SYNTH, tigerRoarPcm, tigerThudPcm } from '../src/audio/synth.ts'
import { LEAP_TAIL_MS, shapePilotPlans, type PhasePlan } from '../src/world/skills-view.ts'
import { gaitFor, LAND_S, leapApex, leapAt, pilotMoveOf, pounceClipRate, shakeAmp, WINDUP_MAX_S, WINDUP_PROGRESS } from '../src/world/tiger-moves.ts'

describe('pilotMoveOf', () => {
  it('maps the kit casts and nothing else', () => {
    expect(pilotMoveOf('PILOT_TIGERWOMAN_POUNCE')).toBe('pounce')
    expect(pilotMoveOf('PILOT_TIGERWOMAN_ROAR')).toBe('roar')
    expect(pilotMoveOf('PILOT_TIGERWOMAN_PACK')).toBeNull()
    expect(pilotMoveOf('PILOT_TIGERWOMAN_STALK')).toBeNull()
    expect(pilotMoveOf('MSKILL_CH_TIGERWOMAN_ATTACK02')).toBeNull()
    expect(pilotMoveOf('SKILL_CH_SWORD_ROAR')).toBeNull()
  })
})

describe('the pounce arc', () => {
  const dur = 0.5
  it('apex grows with distance, 1..2 m', () => {
    expect(leapApex(1)).toBe(1)
    expect(leapApex(12)).toBeCloseTo(2, 5)
    expect(leapApex(40)).toBe(2)
    expect(leapApex(6)).toBeGreaterThan(1)
    expect(leapApex(6)).toBeLessThan(2)
  })
  it('crouches first, hardly moving', () => {
    const s = leapAt(0.08, dur, 2)
    expect(s.phase).toBe('windup')
    expect(s.lift).toBe(0)
    expect(s.squash).toBeLessThan(1)
    expect(s.progress).toBeLessThanOrEqual(WINDUP_PROGRESS)
  })
  it('a parabola: highest at mid flight, the apex height there', () => {
    const w = Math.min(WINDUP_MAX_S, dur * 0.24)
    const mid = leapAt(w + (dur - w) / 2, dur, 1.8)
    expect(mid.phase).toBe('air')
    expect(mid.lift).toBeCloseTo(1.8, 5)
    let prev = -1
    let peaked = false
    for (let t = w; t < dur; t += 0.01) {
      const s = leapAt(t, dur, 1.8)
      expect(s.lift).toBeGreaterThanOrEqual(0)
      expect(s.lift).toBeLessThanOrEqual(1.8 + 1e-9)
      if (s.lift < prev) peaked = true
      else if (peaked) expect(s.lift).toBeLessThanOrEqual(prev + 1e-9)
      prev = s.lift
    }
  })
  it('progress is monotonic and touches down at the server landing time', () => {
    let prev = 0
    for (let t = 0; t <= dur + LAND_S + 0.1; t += 0.005) {
      const s = leapAt(t, dur, 2)
      expect(s.progress).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = s.progress
    }
    const land = leapAt(dur, dur, 2)
    expect(land.phase).toBe('land')
    expect(land.progress).toBe(1)
    expect(land.lift).toBe(0)
    expect(leapAt(dur - 1e-6, dur, 2).lift).toBeLessThan(0.01)
    expect(leapAt(dur + LAND_S + 0.01, dur, 2).phase).toBe('done')
  })
  it('the landing squashes, then the body is back to 1', () => {
    expect(leapAt(dur + LAND_S * 0.4, dur, 2).squash).toBeLessThan(0.9)
    expect(leapAt(dur + LAND_S * 2, dur, 2).squash).toBe(1)
  })
  it('a zero-length leap is just a landing', () => {
    expect(leapAt(0, 0, 2)).toMatchObject({ phase: 'land', progress: 1, lift: 0 })
  })
})

describe('pounceClipRate', () => {
  it('puts the clip strike on the touchdown (clamped 1..2.5)', () => {
    expect(pounceClipRate(1109, 0.5)).toBeCloseTo(2.218, 3)
    expect(pounceClipRate(1109, 2)).toBe(1)
    expect(pounceClipRate(1109, 0.1)).toBe(2.5)
    expect(pounceClipRate(0, 0.5)).toBe(1)
    expect(pounceClipRate(1109, 0)).toBe(1)
  })
})

describe('gaitFor (her walk 2 m/s, run 9 m/s)', () => {
  it('her retail walk and run play at 1x, no prowl', () => {
    expect(gaitFor(2, 2, 9)).toEqual({ clip: 'WALK', rate: 1, prowl: 0 })
    expect(gaitFor(9, 2, 9)).toEqual({ clip: 'RUN', rate: 1, prowl: 0 })
  })
  it('Stalk (0.4 x run = 3.6 m/s) walks at the matched rate, fully prowling', () => {
    const g = gaitFor(3.6, 2, 9)
    expect(g.clip).toBe('WALK')
    expect(g.rate).toBeCloseTo(1.8, 5)
    expect(g.prowl).toBe(1)
  })
  it('the split is the geometric mean; rates are clamped 0.5..2', () => {
    expect(gaitFor(4.2, 2, 9).clip).toBe('WALK')
    expect(gaitFor(4.3, 2, 9).clip).toBe('RUN')
    expect(gaitFor(0.2, 2, 9).rate).toBe(0.5)
    expect(gaitFor(30, 2, 9).rate).toBe(2)
  })
  it('the feet keep pace: rate x clip speed = ground speed inside the clamp', () => {
    for (const v of [1.2, 2.5, 3.1, 3.9, 5, 7, 12]) {
      const g = gaitFor(v, 2, 9)
      expect(g.rate * (g.clip === 'WALK' ? 2 : 9)).toBeCloseTo(v, 5)
    }
  })
})

describe('shakeAmp', () => {
  it('falls off with distance and time', () => {
    expect(shakeAmp(0, 30, 0.16, 0.9, 0.9)).toBeCloseTo(0.16, 6)
    expect(shakeAmp(15, 30, 0.16, 0.9, 0.9)).toBeCloseTo(0.04, 6)
    expect(shakeAmp(30, 30, 0.16, 0.9, 0.9)).toBe(0)
    expect(shakeAmp(0, 30, 0.16, 0.45, 0.9)).toBeCloseTo(0.08, 6)
    expect(shakeAmp(0, 30, 0.16, 0, 0.9)).toBe(0)
  })
})

describe('shapePilotPlans', () => {
  const shot: PhasePlan = { phase: 'SHOT', type: 'FIND', ms: 1200, loop: false }
  const clip = (durationMs: number, hits: number[] = []) => () => ({ durationMs, hits })
  it('the roar plays its FIND clip whole', () => {
    const [p] = shapePilotPlans({ skill: 'PILOT_TIGERWOMAN_ROAR', actionMs: 1200 }, [shot], clip(3333))
    expect(p!.ms).toBe(3333)
    expect(p!.speed).toBeUndefined()
  })
  it('the pounce clip runs fast enough that its strike meets the touchdown', () => {
    const [p] = shapePilotPlans({ skill: 'PILOT_TIGERWOMAN_POUNCE', actionMs: 500 + LEAP_TAIL_MS }, [{ ...shot, type: 'ATTACK1', ms: 900 }], clip(2500, [1109, 1379]))
    expect(p!.speed).toBeCloseTo(2.218, 3)
    expect(p!.ms).toBe(900)
  })
  it('other casts are untouched', () => {
    const plans = [shot]
    expect(shapePilotPlans({ skill: 'MSKILL_CH_TIGERWOMAN_ATTACK01', actionMs: 1200 }, plans, clip(3333))).toBe(plans)
  })
})

describe('the synthesized roar and thud', () => {
  it('are deterministic, finite, normalized and the right length', () => {
    const r = tigerRoarPcm()
    expect(r.rate).toBe(SYNTH_RATE)
    expect(r.samples.length).toBe(Math.floor(SYNTH_RATE * 2))
    let peak = 0
    for (const v of r.samples) {
      expect(Number.isFinite(v)).toBe(true)
      peak = Math.max(peak, Math.abs(v))
    }
    expect(peak).toBeCloseTo(0.95, 3)
    expect(tigerRoarPcm().samples).toEqual(r.samples)
    const t = tigerThudPcm()
    expect(t.samples.length).toBe(Math.floor(SYNTH_RATE * 0.7))
    expect(Object.keys(TIGER_SYNTH).sort()).toEqual(['synth/tg_roar', 'synth/tg_thud'])
  })
  it('the roar is deep: most of its energy below 1 kHz, loudest in its first second', () => {
    const s = tigerRoarPcm().samples
    // A one-pole split at ~1 kHz: the low band carries most of the energy.
    let y = 0
    let low = 0
    let all = 0
    const a = 1 - Math.exp((-2 * Math.PI * 1000) / SYNTH_RATE)
    for (const v of s) {
      y += a * (v - y)
      low += y * y
      all += v * v
    }
    expect(low / all).toBeGreaterThan(0.6)
    const half = Math.floor(SYNTH_RATE)
    let first = 0
    let second = 0
    for (let i = 0; i < s.length; i++) (i < half ? (first += s[i]! ** 2) : (second += s[i]! ** 2))
    expect(first).toBeGreaterThan(second)
  })
})
