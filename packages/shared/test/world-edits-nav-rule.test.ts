/**
 * The nav rule (docs/WORLD_EDITOR.md §6.3, D40; docs/WAVE_PLAN8.md §4.1) on fixtures: a cliff closes, nothing opens by
 * itself, water > 1.2 m closes, the Walkable overrides apply last; pure and deterministic.
 */
import { describe, expect, it } from 'vitest'
import {
  NAV_RULE_MAX_SLOPE, NAV_TILE_ACTION, WE_BLOCKS, WE_GRID, WE_TILES, WE_WALK, emptyHeightLayer, emptyWalkLayer,
  navHeightsAfter, navRuleRegion, tileSlope,
} from '../src/index.ts'

const flat = (h = 10) => new Float32Array(WE_GRID * WE_GRID).fill(h)
const allOpen = () => new Uint8Array(WE_TILES * WE_TILES).fill(1)
const T = (tx: number, tz: number) => tz * WE_TILES + tx
const V = (gx: number, gz: number) => gz * WE_GRID + gx

/** A cone-shaped mound of `height` m and `radius` m at vertex (cx, cz) on `base`. */
function mound(base: Float32Array, cx: number, cz: number, height: number, radius: number): Float32Array {
  const out = Float32Array.from(base)
  for (let gz = 0; gz < WE_GRID; gz++) {
    for (let gx = 0; gx < WE_GRID; gx++) {
      const d = Math.hypot(gx - cx, gz - cz) * 2
      if (d < radius) out[V(gx, gz)] = Math.fround(out[V(gx, gz)]! + height * (1 - d / radius))
    }
  }
  return out
}

describe('navRuleRegion', () => {
  it('a cliff closes: a steep mound closes its flanks, a gentle one closes nothing', () => {
    const before = flat()
    const steep = navRuleRegion({ before, after: mound(before, 48, 48, 14, 16), open: allOpen() })
    expect(steep.closedSlope).toBeGreaterThan(0)
    expect(steep.closed).toBe(steep.closedSlope)
    for (let t = 0; t < steep.actions.length; t++) {
      if (steep.actions[t] !== NAV_TILE_ACTION.close) continue
      expect(tileSlope(mound(before, 48, 48, 14, 16), t % WE_TILES, Math.floor(t / WE_TILES))).toBeGreaterThan(NAV_RULE_MAX_SLOPE)
    }
    expect(steep.actions[T(10, 10)]).toBe(NAV_TILE_ACTION.keep)
    const gentle = navRuleRegion({ before, after: mound(before, 48, 48, 4, 30), open: allOpen() })
    expect(gentle.touched).toBeGreaterThan(0)
    expect(gentle.closed).toBe(0)
  })

  it('only tiles the edit made steeper by more than 0.05 close; retail steep tiles and small moves stay', () => {
    // A retail slope of 1.0 (2 m per 2 m tile) along x, lifted 1 m uniformly: moved, same slope: stays open.
    const before = new Float32Array(WE_GRID * WE_GRID)
    for (let gz = 0; gz < WE_GRID; gz++) for (let gx = 0; gx < WE_GRID; gx++) before[V(gx, gz)] = gx * 2
    const lifted = before.map(h => h + 1)
    const r = navRuleRegion({ before, after: lifted, open: allOpen() })
    expect(r.touched).toBe(WE_TILES * WE_TILES)
    expect(r.closed).toBe(0)
    // Moves of at most 5 cm touch nothing (12/256 m); 13/256 m touches the vertex's four tiles.
    const tiny = Float32Array.from(flat())
    tiny[V(5, 5)] = tiny[V(5, 5)]! + 12 / 256
    expect(navRuleRegion({ before: flat(), after: tiny, open: allOpen() }).touched).toBe(0)
    tiny[V(5, 5)] = tiny[V(5, 5)]! + 1 / 256
    expect(navRuleRegion({ before: flat(), after: tiny, open: allOpen() }).touched).toBe(4)
    // Steeper by exactly 0.7 -> 0.72 (+0.02) on a retail 0.7 slope: stays; one vertex raised 2 m: closes.
    const s07 = new Float32Array(WE_GRID * WE_GRID)
    for (let gz = 0; gz < WE_GRID; gz++) for (let gx = 0; gx < WE_GRID; gx++) s07[V(gx, gz)] = gx * 1.4
    const a = Float32Array.from(s07)
    a[V(11, 3)] = a[V(11, 3)]! + 0.06
    const small = navRuleRegion({ before: s07, after: a, open: allOpen() })
    expect(small.touched).toBe(4)
    expect(small.closed).toBe(0)
    a[V(11, 3)] = a[V(11, 3)]! + 2
    expect(navRuleRegion({ before: s07, after: a, open: allOpen() }).closed).toBe(4)
  })

  it('nothing opens by itself: a flattened closed tile stays closed', () => {
    const before = mound(flat(), 20, 20, 14, 10)
    const open = allOpen()
    open[T(20, 20)] = 0
    const r = navRuleRegion({ before, after: flat(), open })
    expect(r.touched).toBeGreaterThan(0)
    expect(r.actions[T(20, 20)]).toBe(NAV_TILE_ACTION.keep)
    expect(r.opened).toBe(0)
  })

  it('new water deeper than 1.2 m closes; 1.0 m and unset blocks do not', () => {
    const before = flat(10)
    const water = new Float32Array(WE_BLOCKS * WE_BLOCKS).fill(NaN)
    water[0] = 11.21 // block (0, 0): tiles 0..15 x 0..15
    water[1] = 11.0 // block (1, 0)
    const r = navRuleRegion({ before, after: before, open: allOpen(), water })
    expect(r.closedWater).toBe(16 * 16)
    expect(r.actions[T(0, 0)]).toBe(NAV_TILE_ACTION.close)
    expect(r.actions[T(15, 15)]).toBe(NAV_TILE_ACTION.close)
    expect(r.actions[T(16, 0)]).toBe(NAV_TILE_ACTION.keep)
    expect(r.actions[T(40, 40)]).toBe(NAV_TILE_ACTION.keep)
  })

  it('the Walkable overrides apply last: force open beats the rule, force closed closes', () => {
    const before = flat()
    const after = mound(before, 48, 48, 14, 16)
    const auto = navRuleRegion({ before, after, open: allOpen() })
    const closedByRule = Array.from(auto.actions).findIndex(a => a === NAV_TILE_ACTION.close)
    const open = allOpen()
    open[T(2, 2)] = 0
    const walk = emptyWalkLayer().codes
    walk[closedByRule] = WE_WALK.open
    walk[T(2, 2)] = WE_WALK.open
    walk[T(5, 90)] = WE_WALK.closed
    const r = navRuleRegion({ before, after, open, walk })
    expect(r.actions[closedByRule]).toBe(NAV_TILE_ACTION.keep)
    expect(r.actions[T(2, 2)]).toBe(NAV_TILE_ACTION.open)
    expect(r.actions[T(5, 90)]).toBe(NAV_TILE_ACTION.close)
    expect(r.forcedOpen).toBe(2)
    expect(r.forcedClosed).toBe(1)
    expect(r.closed).toBe(auto.closed)
    expect(r.opened).toBe(1)
  })

  it('is pure and deterministic', () => {
    const before = flat()
    const after = mound(before, 30, 60, 20, 24)
    const open = allOpen()
    const copies = [Float32Array.from(before), Float32Array.from(after), Uint8Array.from(open)]
    const a = navRuleRegion({ before, after, open })
    const b = navRuleRegion({ before, after, open })
    expect(Array.from(a.actions)).toEqual(Array.from(b.actions))
    expect({ ...a, actions: 0 }).toEqual({ ...b, actions: 0 })
    expect([before, after, open].map(x => Array.from(x))).toEqual(copies.map(x => Array.from(x)))
    expect(() => navRuleRegion({ before: new Float32Array(3), after, open })).toThrow(/97 x 97/)
  })

  it('navHeightsAfter: retail nav heights + delta x 10 where touched, exact elsewhere', () => {
    const nav = Float32Array.from({ length: WE_GRID * WE_GRID }, (_, i) => 100.3 + i * 0.1)
    const l = emptyHeightLayer()
    l.mask[7] = 1
    l.delta[7] = 1.5
    const out = navHeightsAfter(nav, l)
    expect(out[7]).toBe(Math.fround(nav[7]! + 15))
    expect(out[8]).toBe(nav[8])
    expect(Array.from(navHeightsAfter(nav, null))).toEqual(Array.from(nav))
  })
})
