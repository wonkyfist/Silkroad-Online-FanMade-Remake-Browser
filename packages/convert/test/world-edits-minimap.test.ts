/**
 * WE-D (docs/WORLD_EDITOR.md §6.2 step 2, F8): the minimap redraw of a touched region. A dropped object's baked pixels
 * are replaced by the ground (the coast's dropped-footprint rule), an add is drawn (vegetation as a disc), painted
 * ground takes the new tile's colour, pixels outside every change stay bit for bit, and nothing changed gives null.
 */
import { describe, expect, it } from 'vitest'
import { redrawMinimap, VEGETATION_RGB, type MinimapRedrawInput } from '../src/world/edits/minimap.ts'

const S = 256
const RX = 168
const RZ = 97
const GROUND = [90, 126, 63]

/** A grass tile with a dark baked object at region-local metres (40..46 east, 100..106 north). */
function tile() {
  const rgba = new Uint8Array(S * S * 4)
  for (let p = 0; p < S * S; p++) rgba.set([...GROUND, 255], p * 4)
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
    const e = (c + 0.5) * 0.75
    const n = 192 - (r + 0.5) * 0.75
    if (e >= 40 && e <= 46 && n >= 100 && n <= 106) rgba.set([30, 30, 30, 255], (r * S + c) * 4)
  }
  return { width: S, height: S, rgba }
}
const px = (img: { rgba: Uint8Array }, e: number, n: number) => {
  const c = Math.floor(e / 0.75)
  const r = Math.floor((192 - n) / 0.75)
  return [...img.rgba.subarray((r * S + c) * 4, (r * S + c) * 4 + 3)]
}
/** Absolute region units of region-local metres. */
const ru = (e: number, n: number) => [RX + e / 192, RZ + n / 192] as const

function input(over: Partial<MinimapRedrawInput>): MinimapRedrawInput {
  return {
    rx: RX, rz: RZ, current: tile(), heightBefore: () => 10, heightAfter: () => 10, wordBefore: () => 1, wordAfter: () => 1,
    tileColour: id => (id === 1 ? [100, 140, 70] : id === 2 ? [200, 180, 120] : null), dropped: [], added: [], ...over,
  }
}

describe('the minimap redraw', () => {
  it('nothing changed: null', () => {
    expect(redrawMinimap(input({}))).toBeNull()
  })

  it('a dropped object\'s pixels become ground; the rest stays bit for bit', () => {
    const cur = tile()
    const img = redrawMinimap(input({ current: cur, dropped: [{ corners: [ru(38, 98), ru(48, 98), ru(48, 108), ru(38, 108)] }] }))!
    const p = px(img, 43, 103)
    expect(p.every((v, k) => Math.abs(v - GROUND[k]!) <= 3)).toBe(true)
    for (let k = 0; k < S * S * 4; k++) {
      const c = (k >> 2) % S
      const r = Math.floor((k >> 2) / S)
      const e = (c + 0.5) * 0.75
      const n = 192 - (r + 0.5) * 0.75
      if (e < 37 || e > 49 || n < 97 || n > 109) expect(img.rgba[k]).toBe(cur.rgba[k])
    }
  })

  it('draws a planted tree as a disc and painted ground in the new tile\'s colour', () => {
    const painted = (ggx: number, ggz: number) => {
      const e = (ggx - RX * 96) * 2
      const n = (ggz - RZ * 96) * 2
      return e >= 120 && e <= 160 && n >= 20 && n <= 60 ? 2 : 1
    }
    const img = redrawMinimap(input({
      wordAfter: painted,
      added: [{ corners: [ru(78, 78), ru(82, 78), ru(82, 82), ru(78, 82)], centre: ru(80, 80), radiusM: 3, vegetation: true }],
    }))!
    const disc = px(img, 80, 80)
    expect(disc.every((v, k) => Math.abs(v - VEGETATION_RGB[k]!) <= 10)).toBe(true)
    const sand = px(img, 140, 40)
    expect(sand[0]).toBeGreaterThan(GROUND[0]! * 1.5)
    expect(px(img, 20, 180)).toEqual(GROUND)
  })
})
