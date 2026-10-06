/**
 * The lightning tornado's protocol (docs/WEATHER.md §13, docs/PROTOCOL.md "Weather"): `tornado`, `tornadoEnd`,
 * `displace`, the strike's `source` and the `tornado` hazard cause are all additive and validated field by field.
 */
import { describe, expect, it } from 'vitest'
import { STORM_TABLE, TORNADO_LIMITS, parseServerMessage, type TornadoState } from '../src/index.ts'

const parse = (m: unknown) => parseServerMessage(JSON.stringify(m))

const TORNADO: TornadoState = {
  id: 3,
  seed: 77,
  warnAt: 1000,
  touchAt: 21_000,
  endAt: 200_000,
  path: [
    [10, 2, -40],
    [40, 2.5, -60],
  ],
  speedMs: 3,
  pullM: 30,
  coreM: 5,
  strength: 1,
  area: 'Jangan field',
}

describe('tornado protocol', () => {
  it('takes a tornado (with or without the lift, the GM flag), its end, a pull and a throw', () => {
    expect(parse({ t: 'tornado', tornado: TORNADO })).toEqual({ ok: true, msg: { t: 'tornado', tornado: TORNADO } })
    const lifted = { ...TORNADO, liftAt: 50_000, gm: true }
    expect(parse({ t: 'tornado', tornado: lifted })).toEqual({ ok: true, msg: { t: 'tornado', tornado: lifted } })
    expect(parse({ t: 'tornadoEnd', id: 3, at: 9 })).toEqual({ ok: true, msg: { t: 'tornadoEnd', id: 3, at: 9 } })
    const pull = { t: 'displace', id: 12, kind: 'pull', from: [1, 0, 1], to: [2, 0, 2], at: 5, ms: 600, tornado: 3 }
    expect(parse(pull)).toEqual({ ok: true, msg: pull })
    const thr = { t: 'displace', id: 12, kind: 'throw', from: [1, 0, 1], to: [20, 0, 2], at: 5, ms: 1300, peakM: 7 }
    expect(parse(thr)).toEqual({ ok: true, msg: thr })
    const strike = { id: 4, at: 10, warnAt: 5, kind: 'ground', pos: [1, 2, 3], radiusM: 4, seed: 9, source: 'tornado' }
    expect(parse({ t: 'strike', strike })).toEqual({ ok: true, msg: { t: 'strike', strike } })
    const hit = { t: 'combat', attacker: 0, target: 5, hits: [{ outcome: 'hit', damage: 3, hp: 7 }], cause: 'tornado' }
    expect(parse(hit)).toEqual({ ok: true, msg: hit })
  })

  it('refuses times out of order, an empty or too long path, bad numbers, an unknown kind or source', () => {
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, touchAt: 500 } }).ok).toBe(false)
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, endAt: 20_000 } }).ok).toBe(false)
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, path: [] } }).ok).toBe(false)
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, path: Array.from({ length: TORNADO_LIMITS.path + 1 }, () => [0, 0, 0]) } }).ok).toBe(false)
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, path: [[0, 0]] } }).ok).toBe(false)
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, path: [[2e6, 0, 0]] } }).ok).toBe(false)
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, strength: 3 } }).ok).toBe(false)
    expect(parse({ t: 'tornado', tornado: { ...TORNADO, id: 0 } }).ok).toBe(false)
    expect(parse({ t: 'tornadoEnd', id: 0, at: 9 }).ok).toBe(false)
    expect(parse({ t: 'displace', id: 12, kind: 'fling', from: [1, 0, 1], to: [2, 0, 2], at: 5, ms: 600 }).ok).toBe(false)
    expect(parse({ t: 'displace', id: 12, kind: 'throw', from: [1, 0, 1], to: [2, 0, 2], at: 5, ms: 60_000 }).ok).toBe(false)
    expect(parse({ t: 'displace', id: 12, kind: 'throw', from: [1, 0, 1], to: [2, 0, 2], at: 5, ms: 600, peakM: 100 }).ok).toBe(false)
    expect(parse({ t: 'strike', strike: { id: 4, at: 10, kind: 'ground', pos: [1, 2, 3], radiusM: 4, seed: 9, source: 'volcano' } }).ok).toBe(false)
  })

  it('the storm table carries the tornado knobs', () => {
    expect(STORM_TABLE.tornadoChance).toBeGreaterThan(0)
    expect(STORM_TABLE.tornadoChance).toBeLessThan(1)
    expect(STORM_TABLE.tornadoStrength).toBe(1)
    expect(STORM_TABLE.tornadoLethal).toBe(true) // its throws can kill a body already low on HP
  })
})
