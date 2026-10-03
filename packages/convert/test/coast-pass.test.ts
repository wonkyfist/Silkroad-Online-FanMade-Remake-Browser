/**
 * The procedural coast pass on a synthetic world (docs/COAST.md §3B, §5.3, §12.1, §12.13; WAVE_PLAN6 CST-C port).
 * A 9 x 9 region domain around a 3 x 3 playable square: a mountain cut by the south line (the Tiger case), a hill
 * north of the line (the tomb keep), a flat 0 m strip inside the south-east (S1's walkable patch), a west side that
 * is a land edge in phase 1, and a retail hole. Checks the frozen set, the inward patch, the tomb keep, the land edge,
 * sand in front of every sea shore, the lowered mountain, determinism, the hole rule and the region census.
 *
 * The port reproduced the prototype on the retail heights (work/tmp/coast-port/parity.ts, by hand); CST-C phase 1 then
 * fixed the prototype's line artefacts (./pass.ts header), and coast-geometry.test.ts checks the real coast.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { emitCensus, changedRegions } from '../src/world/coast/census.ts'
import { parseCoastConfig, type CoastConfig } from '../src/world/coast/config.ts'
import { CELL_M, CELLS_PER_REGION, colX, latticeShape, rowZ } from '../src/world/coast/lattice.ts'
import { COAST_CLASS, runCoastPass, type CoastPassInput, type CoastResult } from '../src/world/coast/pass.ts'

const PLAY = { x0: 13, x1: 15, z0: 13, z1: 15 }
const EXPORT = { x0: 12, x1: 16, z0: 12, z1: 16 }
const HOLE: [number, number] = [11.5, 11.5]

function synthConfig(): CoastConfig {
  const cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
  return {
    ...cfg,
    option: 'B',
    phase: 1,
    domain: { x: [10, 18], z: [10, 18] },
    emit: { x: [10, 18], z: [10, 18], depthM: 8 },
    corridor: null,
    cornerBelowZ: 12,
    sections: [
      { code: 'N', side: 'north', from: 13, to: 15, corners: [[16, 16]], kind: 'wide', c0: 150, amp: 30, phase: 1 },
      { code: 'E', side: 'east', from: 13, to: 15, corners: [[16, 13]], kind: 'bay', c0: 95, amp: 30, phase: 1 },
      { code: 'SW', side: 'south', from: 13, to: 13, corners: [[13, 13]], kind: 'mountain', c0: 120, amp: 30, phase: 1 },
      { code: 'SB', side: 'south', from: 14, to: 15, kind: 'walk', c0: -62, amp: 22, phase: 1 },
      { code: 'W', side: 'west', from: 13, to: 15, kind: 'strait', c0: 90, amp: 20, phase: 2 },
    ],
    tombKeep: { ...cfg.tombKeep, x: [14, 15] },
    allowHeightPatches: [{ name: 'SB', x: [14.3, 16], z: [13, 13.5], maxHeightM: 6, feather: 'inward' }],
    places: [],
  }
}

/** Retail heights: flat 10 m inside (0 m in the south-east strip), a mountain across the south line, a tomb hill
 *  north of the north line, the export ring gently falling outward, nothing beyond the export but one hole. */
function synthInput(cfg: CoastConfig): CoastPassInput {
  const l = latticeShape(cfg.domain)
  const n = l.rows * l.cols
  const heights = new Float64Array(n).fill(NaN)
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      const x = colX(l, c)
      const z = rowZ(l, r)
      const inExport = x >= EXPORT.x0 && x <= EXPORT.x1 + 1 && z >= EXPORT.z0 && z <= EXPORT.z1 + 1
      if (!inExport) continue
      let h = 10 + 2 * Math.sin(x * 7.1) * Math.cos(z * 5.3)
      if (x > 14.3 && z < 13.5 && z >= 13) h = Math.min(h, Math.max(0, (z - 13.35) * 192 * 0.35)) // S1's flat strip and wall foot
      // the "Tiger" mountain: 150 m on the south line at x 13-14, rising to 210 m 50 m out, falling outward
      if (x < 14 && z < 13.4) {
        const d = (13 - z) * 192
        const across = Math.min(1, (14 - x) * 2.5)
        const m = d < 0 ? 150 + 0.2 * d : d < 50 ? 150 + 1.2 * d : Math.max(0, 210 - 0.9 * (d - 50))
        h = Math.max(h, m * across)
      }
      // the tomb hill: crest 80 m about 30 m past the north line, then a steep face north
      if (x > 13.9 && x < 15.1 && z > 15.8) {
        const d = (z - 16) * 192
        const t = d < 30 ? 50 + d : Math.max(-2, 80 - 1.4 * (d - 30))
        h = Math.max(h, t)
      }
      heights[r * l.cols + c] = h
    }
  }
  const hr = Math.round((l.z1 + 1 - HOLE[1]) * CELLS_PER_REGION)
  const hc = Math.round((HOLE[0] - l.x0) * CELLS_PER_REGION)
  heights[hr * l.cols + hc] = -2159
  return { heights, water: new Float64Array(n).fill(NaN), active: () => true, playable: PLAY, exportRect: EXPORT }
}

let cfg: CoastConfig
let input: CoastPassInput
let res: CoastResult

beforeAll(() => {
  cfg = synthConfig()
  input = synthInput(cfg)
  res = runCoastPass(input, cfg)
})

const at = (r: CoastResult, x: number, z: number) => {
  const l = r.shape
  return Math.round((l.z1 + 1 - z) * CELLS_PER_REGION) * l.cols + Math.round((x - l.x0) * CELLS_PER_REGION)
}

describe('coast pass on a synthetic world', () => {
  it('is deterministic', () => {
    const again = runCoastPass(input, cfg)
    expect(Buffer.from(again.h.buffer).equals(Buffer.from(res.h.buffer))).toBe(true)
    expect(Buffer.from(again.cls).equals(Buffer.from(res.cls))).toBe(true)
  })

  it('keeps every playable vertex outside the patch bit-identical (G2: the feather is inward only)', () => {
    const m = res.masks
    let frozen = 0
    let patched = 0
    for (let i = 0; i < res.h.length; i++) {
      if (!m.inPlay[i]) continue
      if (m.patch[i]) {
        if (res.h[i] !== input.heights[i]) patched++
        continue
      }
      expect(res.h[i]).toBe(input.heights[i])
      frozen++
    }
    expect(frozen).toBeGreaterThan(75000)
    expect(patched).toBeGreaterThan(1000)
    expect(res.stats.playChangedOutsidePatch).toBe(0)
    // the patch keeps its full weight on the bounds line (no groove) and meets the ring without a step
    const onLine = at(res, 15.6, 13)
    expect(res.patchWeight[onLine]).toBe(1)
    expect(Math.abs(res.h[onLine]! - res.h[at(res, 15.6, 13 - 1 / 96)]!)).toBeLessThan(0.5)
  })

  it('raises the patched strip to a walkable beach at the sea (S1)', () => {
    const h = res.h[at(res, 15.6, 13.3)]!
    expect(h).toBeGreaterThan(cfg.seaLevelM)
    expect(h).toBeLessThan(cfg.allowHeightPatches[0]!.maxHeightM + cfg.beachKinds.walk!.dune)
    let sand = 0
    for (let i = 0; i < res.h.length; i++) {
      if (res.masks.patch[i] && (res.cls[i] === COAST_CLASS.sand || res.cls[i] === COAST_CLASS.wetSand)) sand++
    }
    expect(sand).toBeGreaterThan(1000)
  })

  it('keeps the tomb crest bit for bit and regrades beyond it', () => {
    expect(res.stats.tombKeepVertices).toBeGreaterThan(500)
    expect(res.stats.tombKeepBitIdentical).toBe(true)
    let kept = 0
    for (let i = 0; i < res.h.length; i++) if (res.masks.tombKeep[i]) { expect(res.h[i]).toBe(input.heights[i]); kept++ }
    expect(kept).toBe(res.stats.tombKeepVertices)
  })

  it('leaves the phase-2 west side a land edge: retail where it is fully land, nothing synthesised there', () => {
    let full = 0
    for (let i = 0; i < res.h.length; i++) {
      if (res.landFade[i] === 1 && res.masks.have[i]) {
        expect(res.h[i]).toBe(input.heights[i])
        full++
      }
      if (res.masks.inPlay[i]) expect(res.landFade[i]).toBe(0)
    }
    expect(full).toBeGreaterThan(10000)
    const census = emitCensus(res, cfg, EXPORT, input.active)
    expect(census.landEdge).toBeGreaterThan(0)
    for (const r of census.emitted) expect(r.x >= EXPORT.x0 && r.x <= EXPORT.x1 && r.z >= EXPORT.z0 && r.z <= EXPORT.z1).toBe(false)
    expect(census.emitted.length).toBe(census.land + census.shallow)
    expect(census.land).toBeGreaterThan(0)
  })

  it('puts sand within 12 m of the sea along every sea side', () => {
    const rays: Array<[number, number, number, number]> = [
      [14.5, 16, 0, 1], [16, 14.5, 1, 0], [13.3, 13, 0, -1], [15, 13.5, 0, -1], [16, 15.5, 1, 0], [13.6, 16, 0, 1],
    ]
    for (const [x0, z0, dx, dz] of rays) {
      let first = -1
      for (let t = 0; t < 900; t += CELL_M) {
        const i = at(res, x0 + (dx * t) / 192, z0 + (dz * t) / 192)
        if (res.cls[i] === COAST_CLASS.sea) { first = t; break }
      }
      expect(first, `ray ${x0},${z0}`).toBeGreaterThan(0)
      let sand = false
      for (let t = first - 12; t < first; t += CELL_M) {
        const c = res.cls[at(res, x0 + (dx * t) / 192, z0 + (dz * t) / 192)]
        if (c === COAST_CLASS.sand || c === COAST_CLASS.wetSand) sand = true
      }
      expect(sand, `ray ${x0},${z0}`).toBe(true)
    }
  })

  it('lowers the mountain at the edge to a flank of at most the grade plus gullies, down to a beach', () => {
    const x = 13.5
    const retailCrest = input.heights[at(res, x, 13 - 50 / 192)]!
    expect(res.h[at(res, x, 13 - 50 / 192)]!).toBeLessThan(retailCrest)
    const steep: number[] = []
    for (let t = 100; t < 600; t += CELL_M) {
      const i = at(res, x, 13 - t / 192)
      if (res.cls[i] === COAST_CLASS.sea) break
      steep.push(res.slope[i]!)
    }
    expect(steep.length).toBeGreaterThan(20)
    steep.sort((a, b) => a - b)
    expect(steep[Math.floor(steep.length * 0.95)]!).toBeLessThan(45)
    // the line itself is frozen: the final surface equals retail on it
    expect(res.h[at(res, x, 13)]).toBe(input.heights[at(res, x, 13)])
  })

  it('treats heights below holeBelowM as missing', () => {
    const i = at(res, HOLE[0], HOLE[1])
    expect(res.masks.have[i]).toBe(0)
    expect(res.h[i]!).toBeGreaterThan(-100)
    expect(res.stats.minH).toBeGreaterThan(-100)
  })

  it('reports the changed exported regions', () => {
    const regions: Array<{ x: number; z: number }> = []
    for (let z = EXPORT.z0; z <= EXPORT.z1; z++) for (let x = EXPORT.x0; x <= EXPORT.x1; x++) regions.push({ x, z })
    const changed = changedRegions(res, input.heights, regions)
    const key = (r: { x: number; z: number }) => `${r.x},${r.z}`
    const set = new Set(changed.map(key))
    expect(set.has('13,12')).toBe(true)
    expect(set.has('15,13')).toBe(true)
    expect(set.has('14,14')).toBe(false)
  })

  it('refuses arrays of the wrong size', () => {
    expect(() => runCoastPass({ ...input, heights: new Float64Array(4) }, cfg)).toThrow(/lattice arrays/)
  })
})
