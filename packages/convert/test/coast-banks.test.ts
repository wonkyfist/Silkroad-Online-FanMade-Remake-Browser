/**
 * The banks of the in-bounds sea-level water (W10R CST-H1 / CST-H2, ./coast/banks.ts, checks.waterWalls). A hand-made
 * coast result on a 3 x 3 region lattice, the playable region in the middle: retail water at the sea level along the
 * playable's east edge, kept ring ground at 0 m right past the line (dry: landward of the waterline), and beyond it
 * either the sea (the trench joins it: it becomes water) or a dune (an enclosed pocket: it is shaped into a bank that
 * rises from the water at SL + BANK_FILL_M, or from a dry in-bounds floor at the floor's height, up the dune; P-DATA).
 * A height patch's dry ground beside the water joins the water too; the frozen playable set never changes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BANK_FILL_M, settleBanks } from '../src/world/coast/banks.ts'
import { waterWalls } from '../src/world/coast/checks.ts'
import { seaMasks } from '../src/world/coast/field.ts'
import { colX, latticeShape, rowZ } from '../src/world/coast/lattice.ts'
import { COAST_CLASS, type CoastResult } from '../src/world/coast/pass.ts'
import { placementEdits } from '../src/world/coast/placements.ts'
import { parseCoastConfig } from '../src/world/coast/config.ts'
import type { WorldModel, WorldPlacement } from '../src/world/manifest.ts'
import { REPO_ROOT } from '../src/node-io.ts'

const SL = 5

function world(opts: { dune: boolean; patch?: boolean; riverBelowZ?: number }): CoastResult {
  const shape = latticeShape({ x: [10, 12], z: [10, 12] })
  const n = shape.rows * shape.cols
  const h = new Float64Array(n).fill(10)
  const cls = new Uint8Array(n)
  const u8 = () => new Uint8Array(n)
  const masks = { have: u8().fill(1), wetR: u8(), kept: u8().fill(1), patch: u8(), inPlay: u8(), inExp: u8().fill(1), inCorr: u8(),
    tombKeep: u8(), bandFill: u8(), waterSurface: u8(), waterLow: u8() }
  for (let r = 0; r < shape.rows; r++) {
    for (let c = 0; c < shape.cols; c++) {
      const i = r * shape.cols + c
      const x = colX(shape, c)
      const z = rowZ(shape, r)
      const play = x >= 11 && x <= 12 && z >= 11 && z <= 12
      masks.inPlay[i] = play ? 1 : 0
      if (play && x >= 11.9 && z < (opts.riverBelowZ ?? Infinity)) {
        // the in-bounds river at the sea level: bed 0 m, water +5 m
        h[i] = 0
        masks.wetR[i] = masks.waterLow[i] = masks.waterSurface[i] = 1
        cls[i] = COAST_CLASS.sea
      } else if (play && x >= 11.8 && opts.patch && z < 11.5) {
        h[i] = 1 // patch ground below SL beside the river (S1's first columns)
        masks.patch[i] = 1
      } else if (play && x >= 11.85) h[i] = 0 // frozen dry ground below SL inside the bounds: never touched
      else if (!play && x > 12 && x < 12.2 && z >= 11 && z <= 12) h[i] = 0 // the trench past the line
      else if (!play && x >= 12.2 && x < 12.4 && opts.dune) h[i] = 8 // the dune
      else if (!play && x >= 12.2) {
        h[i] = -5
        masks.waterSurface[i] = 1
        cls[i] = COAST_CLASS.sea
      }
    }
  }
  return {
    shape, h, cls, masks, landFade: new Float32Array(n), u: new Float32Array(n), s: new Float32Array(n), slope: new Float32Array(n),
    patchWeight: new Float32Array(n), joinSoft: new Float32Array(n), tombKeepRow: new Int32Array(shape.cols).fill(-1),
    playable: { x0: 11, x1: 11, z0: 11, z1: 11 }, stats: {} as CoastResult['stats'],
  }
}

const at = (r: CoastResult, x: number, z: number) => {
  const c = Math.round((x - r.shape.x0) * 96)
  const row = Math.round((r.shape.z1 + 1 - z) * 96)
  return row * r.shape.cols + c
}

describe('coast banks (W10R CST-H1/H2)', () => {
  it('a dry trench past the line that joins the sea becomes water: no water wall, the ocean continues the plane', () => {
    const r = world({ dune: false })
    expect(waterWalls(r, { seaLevelM: SL }, seaMasks(r)).walls.length).toBeGreaterThan(0)
    const frozen = r.h[at(r, 11.86, 11.5)]
    const { stats } = settleBanks(r, { seaLevelM: SL })
    expect(stats.watered).toBeGreaterThan(0)
    expect(stats.filled).toBe(0)
    const masks = seaMasks(r)
    expect(waterWalls(r, { seaLevelM: SL }, masks).walls).toEqual([])
    const k = at(r, 12.1, 11.5)
    expect([r.masks.waterSurface[k], r.cls[k], masks.ocean[k], r.h[k]]).toEqual([1, COAST_CLASS.sea, 1, 0])
    expect(r.h[at(r, 11.86, 11.5)]).toBe(frozen)
    expect(r.masks.waterSurface[at(r, 11.86, 11.5)]).toBe(0)
  })

  /** Heights along z from x0 to x1 (region units), every lattice cell. */
  const profile = (r: CoastResult, z: number, x0: number, x1: number) => {
    const out: number[] = []
    for (let x = x0; x <= x1 + 1e-9; x += 1 / 96) out.push(r.h[at(r, x, z)]!)
    return out
  }

  it('an enclosed trench (a dune between it and the sea) becomes a bank rising out of the water up the dune', () => {
    const r = world({ dune: true })
    const { stats } = settleBanks(r, { seaLevelM: SL })
    expect(stats.watered).toBe(0)
    expect(stats.filled).toBeGreaterThan(0)
    const k = at(r, 12.1, 11.5)
    expect(r.masks.waterSurface[k]).toBe(0)
    // beside the in-bounds water the bank stands at least BANK_FILL_M above it (that plane ends buried) ...
    expect(r.h[at(r, 12 + 1 / 96, 11.5)]).toBeGreaterThanOrEqual(SL + BANK_FILL_M - 1e-9)
    expect(stats.heldAboveSea).toBeGreaterThan(0)
    // ... and it rises all the way to the dune: no flat shelf at the fill height, no step
    const p = profile(r, 11.5, 12 + 1 / 96, 12.19)
    for (let i = 1; i < p.length; i++) expect(p[i]! - p[i - 1]!).toBeGreaterThan(0.01)
    expect(Math.max(...p.slice(1).map((v, i) => v - p[i]!))).toBeLessThan(0.5)
    expect(waterWalls(r, { seaLevelM: SL }, seaMasks(r)).walls).toEqual([])
  })

  it('beside a dry in-bounds floor the bank starts at the floor (no wall at the line) and the frozen set is untouched', () => {
    const r = world({ dune: true, riverBelowZ: 11.5 })
    const frozen = Float64Array.from(r.h)
    const { stats } = settleBanks(r, { seaLevelM: SL })
    expect(stats.filled).toBeGreaterThan(0)
    for (let i = 0; i < r.h.length; i++) if (r.masks.inPlay[i]) expect(r.h[i]).toBe(frozen[i])
    // the floor (0 m) at the line, then a ramp up to the dune (8 m), never steeper than a 2 m rise per 2 m cell
    const p = profile(r, 11.8, 11.95, 12.2)
    expect(p[0]).toBe(0)
    for (let i = 1; i < p.length; i++) {
      expect(p[i]! - p[i - 1]!).toBeGreaterThanOrEqual(-1e-6)
      expect(p[i]! - p[i - 1]!).toBeLessThan(2)
    }
    expect(r.h[at(r, 12 + 1 / 96, 11.8)]).toBeLessThan(SL)
    // the river's stretch still holds its bank above the water
    expect(r.h[at(r, 12 + 1 / 96, 11.2)]).toBeGreaterThanOrEqual(SL + BANK_FILL_M - 1e-9)
    expect(waterWalls(r, { seaLevelM: SL }, seaMasks(r)).walls).toEqual([])
  })

  it('a height patch beside the river joins the water; the trench past the line too', () => {
    const r = world({ dune: false, patch: true })
    const { stats } = settleBanks(r, { seaLevelM: SL })
    expect(stats.wateredInPatch).toBeGreaterThan(0)
    const k = at(r, 11.82, 11.2)
    expect([r.masks.waterSurface[k], seaMasks(r).ocean[k]]).toEqual([1, 1])
    // above the patch (z >= 11.5) the same ground is frozen and stays dry
    expect(r.masks.waterSurface[at(r, 11.86, 11.7)]).toBe(0)
  })
})

describe('C9 on the coast sea (W10R PL-1 / PL-2)', () => {
  const cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
  const model = { index: 0, source: 'res/nature/tree01.bsr', kind: 'static', boundsMin: [-2, 0, -2], boundsMax: [2, 9, 2] } as unknown as WorldModel
  /** A placement at region coordinates (x, z), origin region (11, 11). */
  const tree = (uid: number, x: number, z: number, inConvertedRegion = true) => ({
    objId: 1, source: model.source, models: [0], compound: false, position: [(x - 11) * 192, 0, -(z - 11) * 192], rotation: [0, 0, 0, 1],
    yaw: 0, flags: { static: true, big: false, struct: false }, staticFlag: 0, uid, region: (11 << 8) | 11, group: 3, inConvertedRegion,
  }) as unknown as WorldPlacement

  it('a tree in the sea is dropped however little the ground moved (none, or no retail ground at all)', () => {
    const r = world({ dune: false })
    const retail = Float64Array.from(r.h)
    const nan = at(r, 12.5, 11.25)
    retail[nan] = NaN
    const c9 = placementEdits(r, cfg, retail, { x: 11, z: 11 }, [tree(1, 12.5, 11.5), tree(2, 12.5, 11.25), tree(3, 11.5, 11.5)], [model])
    expect(c9.edits.drop.map(d => d.uid).sort()).toEqual([1, 2])
    expect(c9.edits.resnap).toEqual([])
    expect(c9.dropFootprints.length).toBe(2)
  })

  it('coast.json placements.drop drops by hand; placements.accept moves a checked footprint finding out of the list (P-DATA)', () => {
    const r = world({ dune: false })
    const retail = Float64Array.from(r.h)
    // the ground 30 m east of (11.3, 11.5) rose by 3 m: a 40 m wide model there overhangs it, its origin does not
    for (let i = 0; i < retail.length; i++) {
      const c = i % r.shape.cols
      if (colX(r.shape, c) > 11.4 && colX(r.shape, c) < 11.6) retail[i] = r.h[i]! - 3
    }
    const big = { index: 1, source: 'res/bldg/wall01.bsr', kind: 'static', boundsMin: [-20, 0, -5], boundsMax: [20, 9, 5] } as unknown as WorldModel
    const wall = (uid: number) => ({ ...tree(uid, 11.3, 11.5), source: big.source, models: [1] }) as WorldPlacement
    const region = (11 << 8) | 11
    const own = {
      ...cfg,
      placements: {
        ...cfg.placements,
        drop: [{ region, uid: 1, note: 'test' }, { region, uid: 99, note: 'stale' }],
        accept: [{ region, uid: 3, note: 'test' }],
      },
    }
    const c9 = placementEdits(r, own, retail, { x: 11, z: 11 }, [tree(1, 11.2, 11.5), wall(2), wall(3)], [model, big])
    expect(c9.edits.drop.map(d => d.uid)).toEqual([1])
    expect(c9.listed).toEqual([]) // vegetation is never listed for hand placement
    expect(c9.dropFootprints.length).toBe(1)
    expect(c9.footprints.map(f => f.uid)).toEqual([2])
    expect(c9.accepted.map(f => f.uid)).toEqual([3])
    expect(c9.unmatched).toEqual([`${region}:99`])
  })

  it('a tree whose owner region is not exported is dropped, not re-snapped, where its ground moved', () => {
    const r = world({ dune: false })
    const retail = Float64Array.from(r.h)
    for (let i = 0; i < retail.length; i++) retail[i] = r.h[i]! - 2 // the ground rose by 2 m everywhere (to >= 8 m on land)
    const c9 = placementEdits(r, cfg, retail, { x: 11, z: 11 }, [tree(1, 11.5, 11.5), tree(2, 11.5, 11.6, false)], [model])
    expect(c9.edits.resnap.map(d => d.uid)).toEqual([1])
    expect(c9.edits.drop.map(d => d.uid)).toEqual([2])
  })
})
