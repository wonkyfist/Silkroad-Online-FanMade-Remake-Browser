import { describe, expect, it } from 'vitest'
import { STRIKE_TELEGRAPH_MS, parseServerMessage, strikeFlashPeak, strikeStrokes, strokeBrightness, telegraphMs, type LightningStrike } from '../src/index.ts'

const parse = (m: unknown) => parseServerMessage(JSON.stringify(m))

describe('lightning strike strokes (docs/WEATHER.md §2.7)', () => {
  it('2-4 return strokes, the first at 0, the last 0.3-0.5 s later, 40 ms apart; deterministic per seed', () => {
    const counts = new Set<number>()
    for (let seed = 1; seed < 2000; seed += 7) {
      const s = strikeStrokes(seed)
      counts.add(s.length)
      expect(s.length).toBeGreaterThanOrEqual(2)
      expect(s.length).toBeLessThanOrEqual(4)
      expect(s[0]).toEqual({ t: 0, peak: 1 })
      const last = s[s.length - 1]!.t
      expect(last).toBeGreaterThanOrEqual(0.3)
      expect(last).toBeLessThanOrEqual(0.5)
      for (let i = 1; i < s.length; i++) expect(s[i]!.t - s[i - 1]!.t).toBeGreaterThanOrEqual(0.04 - 1e-9)
      expect(strikeStrokes(seed)).toEqual(s)
    }
    expect([...counts].sort()).toEqual([2, 3, 4])
  })

  it('the channel flickers: bright at each stroke, dim between, dark after', () => {
    const s = strikeStrokes(12345)
    expect(strokeBrightness(s, -0.01)).toBe(0)
    for (const k of s) expect(strokeBrightness(s, k.t)).toBeGreaterThanOrEqual(k.peak)
    const gap = (s[0]!.t + s[1]!.t) / 2
    if (s[1]!.t - s[0]!.t > 0.15) expect(strokeBrightness(s, gap)).toBeLessThan(0.4)
    expect(strokeBrightness(s, s[s.length - 1]!.t + 0.3)).toBe(0)
  })

  it('telegraph 1.2-1.8 s by seed; the sky flash is brighter near', () => {
    for (let seed = 0; seed < 500; seed++) {
      const ms = telegraphMs(seed)
      expect(ms).toBeGreaterThanOrEqual(STRIKE_TELEGRAPH_MS[0])
      expect(ms).toBeLessThanOrEqual(STRIKE_TELEGRAPH_MS[1])
    }
    expect(strikeFlashPeak(50)).toBe(3)
    expect(strikeFlashPeak(2500)).toBeLessThan(1.5)
    expect(strikeFlashPeak(10_000)).toBeCloseTo(0.9)
  })
})

describe('lightning on the wire', () => {
  const strike: LightningStrike = { id: 3, at: 2000, warnAt: 500, kind: 'tree', pos: [10.5, 40, -3], groundY: 1.2, radiusM: 3.5, seed: 4294967295, target: 9 }

  it('`strike` round-trips; unknown keys are dropped', () => {
    const r = parse({ t: 'strike', strike: { ...strike, extra: 1 }, junk: true })
    expect(r).toEqual({ ok: true, msg: { t: 'strike', strike } })
    const sky = parse({ t: 'strike', strike: { id: 1, at: 10, kind: 'sky', pos: [0, 400, 0], radiusM: 0, seed: 0 } })
    expect(sky.ok).toBe(true)
  })

  it('rejects a bad strike: unknown kind, telegraph after the landing, a huge radius, a bad id or seed, a bad pos', () => {
    for (const bad of [
      { ...strike, kind: 'meteor' },
      { ...strike, warnAt: 3000 },
      { ...strike, radiusM: 50 },
      { ...strike, id: 0 },
      { ...strike, seed: 2 ** 32 },
      { ...strike, pos: [0, 0] },
      { ...strike, pos: [1e9, 0, 0] },
    ]) {
      expect(parse({ t: 'strike', strike: bad }).ok).toBe(false)
    }
  })

  it('`combat` from lightning: attacker 0, cause and strike id; the old `lightning` carries the strike id', () => {
    const c = parse({ t: 'combat', attacker: 0, target: 5, hits: [{ outcome: 'hit', damage: 120, hp: 80 }], cause: 'lightning', strike: 3 })
    expect(c).toMatchObject({ ok: true, msg: { attacker: 0, cause: 'lightning', strike: 3 } })
    expect(parse({ t: 'combat', attacker: 0, target: 5, hits: [{ outcome: 'hit', damage: 1, hp: 1 }], cause: 'meteor' }).ok).toBe(false)
    expect(parse({ t: 'lightning', at: 5, distM: 300, bearing: 1, strike: 3 })).toEqual({ ok: true, msg: { t: 'lightning', at: 5, distM: 300, bearing: 1, strike: 3 } })
    // an old server's lightning still parses
    expect(parse({ t: 'lightning', at: 5, distM: 300, bearing: 1 }).ok).toBe(true)
  })
})
