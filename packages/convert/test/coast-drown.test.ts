/**
 * The drowned area (coast/drown.ts, coast.json `drown`; docs/COAST.md §4.1): on a synthetic three-region lattice, the
 * drowned region goes under the sea while the kept ones stay bit for bit, a soft region keeps the big landmass's ground
 * and loses its water and cut-off islets, a dry sliver the cut leaves drowns, and the world map's rectangle is the
 * island's. Pure (no client data).
 */
import { describe, expect, it } from 'vitest'
import type { CoastConfig } from '../src/world/coast/config.ts'
import { configDrowns, drownArea, drownedRegions, drownMask, islandRect } from '../src/world/coast/drown.ts'
import { CELLS_PER_REGION, latticeShape } from '../src/world/coast/lattice.ts'
import { COAST_CLASS, type CoastResult } from '../src/world/coast/pass.ts'

const SL = 5
const shape = latticeShape({ x: [0, 2], z: [0, 0] })
const { rows, cols } = shape
const N = rows * cols
/** Region-unit x of a lattice column. */
const xOf = (c: number) => c / CELLS_PER_REGION

function cfgOf(drown: Partial<NonNullable<CoastConfig['drown']>>): CoastConfig {
  return {
    seaLevelM: SL, seed: 1188, corridor: null,
    drown: { regions: [], areas: [], islandMaxKm2: 0.01, depthM: [2, 30], shelfM: 400, rampDeg: 24, rampMinM: 24, ...drown },
  } as unknown as CoastConfig
}

/** Land at 20 m everywhere except `water` columns (a strait at -3 m under retail water), all of it in play. */
function resultOf(water: (x: number, row: number) => boolean, islet?: (x: number, row: number) => boolean): CoastResult {
  const h = new Float64Array(N)
  const cls = new Uint8Array(N)
  const ws = new Uint8Array(N)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const wet = water(xOf(c), r) && !islet?.(xOf(c), r)
      h[i] = wet ? -3 : 20
      cls[i] = wet ? COAST_CLASS.sea : COAST_CLASS.land
      ws[i] = wet ? 1 : 0
    }
  }
  const ones = () => new Uint8Array(N).fill(1)
  const zeros = () => new Uint8Array(N)
  return {
    shape, h, cls, u: new Float32Array(N), s: new Float32Array(N).fill(-100), landFade: new Float32Array(N),
    patchWeight: new Float32Array(N), slope: new Float32Array(N), joinSoft: new Float32Array(N), tombKeepRow: new Int32Array(cols).fill(-1),
    playable: { x0: 0, x1: 2, z0: 0, z1: 0 },
    masks: {
      have: ones(), wetR: Uint8Array.from(ws), kept: ones(), patch: zeros(), inPlay: ones(), inExp: ones(), inCorr: zeros(),
      tombKeep: zeros(), bandFill: zeros(), waterSurface: ws, waterLow: Uint8Array.from(ws),
    },
    stats: {} as CoastResult['stats'],
  }
}

describe('coast drown (COAST §4.1)', () => {
  it('drowns whole regions; the vertices a kept region shares stay, bit for bit', () => {
    const r = resultOf(() => false)
    const before = Float64Array.from(r.h)
    const cfg = cfgOf({ regions: [{ x: [2, 2], z: [0, 0] }] })
    const stats = drownArea(r, cfg)!
    expect(stats.vertices).toBe(rows * CELLS_PER_REGION)
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c <= 2 * CELLS_PER_REGION; c++) expect(r.h[row * cols + c]).toBe(before[row * cols + c])
      // the far edge of the drowned region is open sea, in the ocean's masks and out of play
      const far = row * cols + cols - 1
      expect(r.h[far]).toBeLessThan(SL - 2)
      expect(r.cls[far]).toBe(COAST_CLASS.sea)
      expect([r.masks.inPlay[far], r.masks.kept[far], r.masks.wetR[far], r.masks.waterSurface[far], r.masks.drowned![far]]).toEqual([0, 0, 0, 1, 1])
    }
    // the ground falls from the kept edge without a step, and keeps falling
    const mid = Math.floor(rows / 2) * cols
    expect(Math.abs(r.h[mid + 2 * CELLS_PER_REGION + 1]! - 20)).toBeLessThan(1)
    for (let c = 2 * CELLS_PER_REGION + 1; c < cols - 1; c++) expect(r.h[mid + c + 1]!).toBeLessThanOrEqual(r.h[mid + c]! + 0.2)
    expect([...drownedRegions(r)]).toEqual([2])
    // the map covers the dry regions and one more round them, inside the domain
    expect(islandRect(r, { x0: 0, x1: 2, z0: 0, z1: 0 }, 0)).toEqual({ x0: 0, x1: 1, z0: 0, z1: 0 })
  })

  it('a soft region keeps the big landmass running into it and drowns its water and a cut-off islet', () => {
    // a strait in region 1 from x 1.5 east; an islet in it at x 1.7-1.8; region 2 drowned
    const r = resultOf((x) => x > 1.5, (x, row) => x > 1.7 && x < 1.8 && row > 40 && row < 56)
    const cfg = cfgOf({ regions: [{ x: [2, 2], z: [0, 0] }], soft: [{ x: [1, 1], z: [0, 0] }], islandMaxKm2: 0.05 })
    const stats = drownArea(r, cfg)!
    const at = (x: number, row = 48) => row * cols + Math.round(x * CELLS_PER_REGION)
    expect(r.masks.drowned![at(1.2)]).toBe(0) // the landmass's ground in the soft region stays
    expect(r.h[at(1.2)]).toBe(20)
    expect(r.masks.drowned![at(1.6)]).toBe(1) // its water drowns
    expect(r.masks.drowned![at(1.75)]).toBe(1) // and the islet
    expect(r.h[at(1.75)]).toBeLessThan(SL)
    expect(stats.islands).toBe(1)
  })

  it('drowns a sliver of land the cut leaves, however it stood', () => {
    // land only in a thin strip of region 1 next to drowned region 2, the rest of region 1 a strait
    const r = resultOf((x) => x > 0.9 && x < 1.95)
    const cfg = cfgOf({ regions: [{ x: [2, 2], z: [0, 0] }] })
    drownArea(r, cfg)
    const row = 48 * cols
    expect(r.masks.drowned![row + Math.round(1.97 * CELLS_PER_REGION)]).toBe(1)
    expect(r.masks.drowned![row + Math.round(0.5 * CELLS_PER_REGION)]).toBe(0)
  })

  it('reads the config by region: whole-region rectangles and the centres of continuous areas', () => {
    const cfg = cfgOf({ regions: [{ x: [150, 152], z: [99, 105] }], areas: [{ x: [153, 153.6], z: [96, 97] }] })
    expect(configDrowns(cfg, 151, 100)).toBe(true)
    expect(configDrowns(cfg, 153, 96)).toBe(true) // centre 153.5, 96.5
    expect(configDrowns(cfg, 153, 99)).toBe(false)
    expect(configDrowns(cfgOf({}), 151, 100)).toBe(false)
    const mask = drownMask({ shape }, cfgOf({ regions: [{ x: [1, 2], z: [0, 0] }] }))
    expect(mask[CELLS_PER_REGION - 1]).toBe(0)
    expect(mask[CELLS_PER_REGION]).toBe(0) // shared with kept region 0
    expect(mask[CELLS_PER_REGION + 1]).toBe(1)
  })
})
