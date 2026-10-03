/**
 * The Walkable brush's layer and hard limits (docs/WORLD_EDITOR.md §4.7, D29; src/world-edits/walk.ts): the walk
 * layer's codec round trip, the validator, the tiles that may never be forced open (outside the playable bounds, in the
 * sea mask, under a collision footprint), the converter's guard and the plain-English refusal.
 */
import { describe, expect, it } from 'vitest'
import {
  WALK_REFUSAL, WE_TILES, WE_WALK, decodeWalkLayer, emptyWalkLayer, encodeWalkLayer, guardWalkCodes, seaTestOfField,
  validateWalkLayer, walkRefusalSentence, walkRefusals, walkTileCentre,
} from '../src/index.ts'

const T = (tx: number, tz: number) => tz * WE_TILES + tx
const ORIGIN = { x: 168, z: 97 }

describe('the walk layer', () => {
  it('round-trips every code through the R8 pixels, rows north first', () => {
    const walk = emptyWalkLayer()
    for (let t = 0; t < walk.codes.length; t++) walk.codes[t] = (t * 7 + (t >> 5)) % 3
    const px = encodeWalkLayer(walk)
    expect(px).toHaveLength(WE_TILES * WE_TILES)
    // tile (tx, tz) is pixel row 95 - tz
    expect(px[(95 - 40) * WE_TILES + 3]).toBe(walk.codes[T(3, 40)])
    expect(Array.from(decodeWalkLayer(px).codes)).toEqual(Array.from(walk.codes))
    expect(validateWalkLayer(171, 97, decodeWalkLayer(px)).ok).toBe(true)
    px[17] = 3
    expect(validateWalkLayer(171, 97, decodeWalkLayer(px)).ok).toBe(false)
  })
})

describe('the hard limits (walkRefusals)', () => {
  it('a region outside the playable rectangle refuses every tile', () => {
    const playable = { x0: 156, x1: 174, z0: 90, z1: 102 }
    expect(walkRefusals(175, 97, { playable }, []).every(v => v === WALK_REFUSAL.bounds)).toBe(true)
    expect(walkRefusals(174, 102, { playable }, []).every(v => v === WALK_REFUSAL.none)).toBe(true)
  })

  it('a collision box refuses every tile it overlaps or touches, clipped to the region', () => {
    const rx = 170, rz = 97, X0 = 1920 * rx, Z0 = 1920 * rz
    // 10 m x 4 m box from tile (10, 20)'s corner; a second box spilling in from the west neighbour
    const r = walkRefusals(rx, rz, {}, [
      { minX: X0 + 200, minZ: Z0 + 400, maxX: X0 + 300, maxZ: Z0 + 435 },
      { minX: X0 - 50, minZ: Z0 + 1000, maxX: X0 + 5, maxZ: Z0 + 1010 },
      { minX: X0 - 500, minZ: Z0, maxX: X0 - 100, maxZ: Z0 + 1920 },
    ])
    const hit: number[] = []
    for (let t = 0; t < r.length; t++) if (r[t]) hit.push(t)
    const want: number[] = []
    for (let tz = 20; tz <= 21; tz++) for (let tx = 10; tx <= 15; tx++) want.push(T(tx, tz))
    want.push(T(0, 50))
    expect(hit.sort((a, b) => a - b)).toEqual(want.sort((a, b) => a - b))
    expect(r[T(10, 20)]).toBe(WALK_REFUSAL.object)
  })

  it('the sea mask refuses a tile whose centre is in it (the glTF frame of the export)', () => {
    expect(walkTileCentre(168, 97, 0, 0, ORIGIN)).toEqual([1, -1])
    expect(walkTileCentre(169, 98, 95, 95, ORIGIN)).toEqual([192 + 191, -(192 + 191)])
    // the sea: everything west of x = 20 in region 168, 97
    const r = walkRefusals(168, 97, { seaAt: (x, _z) => x < 20, origin: ORIGIN }, [{ minX: 1920 * 168, minZ: 1920 * 97, maxX: 1920 * 168 + 5, maxZ: 1920 * 97 + 5 }])
    expect(r[T(9, 50)]).toBe(WALK_REFUSAL.sea)
    expect(r[T(10, 50)]).toBe(WALK_REFUSAL.none)
    // a footprint wins over the sea
    expect(r[T(0, 0)]).toBe(WALK_REFUSAL.object)
  })

  it('the client field test: R >= 128 at the nearest texel, clamped', () => {
    const field = { x0: -8, z0: -8, metresPerTexel: 4, width: 4, height: 4 }
    const rgba = new Uint8Array(4 * 4 * 4)
    rgba[(1 * 4 + 2) * 4] = 255 // texel (2, 1): x 0..4, z -4..0
    rgba[(3 * 4 + 3) * 4] = 128 // the south-east corner texel
    const sea = seaTestOfField(field, rgba)
    expect(sea(1, -1)).toBe(true)
    expect(sea(-1, -1)).toBe(false)
    expect(sea(500, 500)).toBe(true)
    expect(() => seaTestOfField(field, new Uint8Array(3))).toThrow(/expected 4 x 4/)
  })
})

describe('the guard and the message', () => {
  it('turns refused force-opens back to auto, keeps force closed, and does not copy when nothing is refused', () => {
    const codes = new Uint8Array(WE_TILES * WE_TILES)
    codes[T(1, 1)] = WE_WALK.open
    codes[T(2, 2)] = WE_WALK.open
    codes[T(3, 3)] = WE_WALK.closed
    codes[T(4, 4)] = WE_WALK.open
    const refusals = new Uint8Array(WE_TILES * WE_TILES)
    refusals[T(1, 1)] = WALK_REFUSAL.object
    refusals[T(3, 3)] = WALK_REFUSAL.bounds
    refusals[T(4, 4)] = WALK_REFUSAL.sea
    const g = guardWalkCodes(codes, refusals)
    expect(g.refused).toEqual({ bounds: 0, sea: 1, object: 1 })
    expect([g.codes[T(1, 1)], g.codes[T(2, 2)], g.codes[T(3, 3)], g.codes[T(4, 4)]]).toEqual([0, 1, 2, 0])
    expect(codes[T(1, 1)]).toBe(WE_WALK.open)
    expect(guardWalkCodes(codes, new Uint8Array(WE_TILES * WE_TILES)).codes).toBe(codes)
  })

  it('says what was refused in plain English', () => {
    expect(walkRefusalSentence({ bounds: 0, sea: 0, object: 0 })).toBe('')
    expect(walkRefusalSentence({ bounds: 1, sea: 0, object: 0 })).toBe("1 tile can't be opened: 1 outside the playable area (nobody walks there).")
    expect(walkRefusalSentence({ bounds: 0, sea: 2, object: 3 })).toBe(
      "5 tiles can't be opened: 2 in the sea, 3 under a building or object (its own floor decides walking there).")
  })
})
