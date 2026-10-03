/**
 * GL-F, the field window (docs/GRASS_LIFE.md §3.1): re-centred when the focus leaves the inner 32 m, its corner on the
 * 8 m cell grid; the row copies equal the region bakes texel for texel; a region arriving late fills in; the height
 * grid decodes (grass/shaders.ts `grassHeightAt`, the shader's twin) to format.ts `terrainHeightAt` on the rendered
 * triangulation; the cell table; the fill is cheap (≤ 0.5 ms re-centre budget on a quiet machine).
 */
import { describe, expect, it } from 'vitest'
import { GRID, terrainHeightAt } from '../../convert/src/world/format.ts'
import { bakeRegionGrass, grassBakeSource, grassTileTable } from '../src/grass/bake.ts'
import { GRASS_CELL_M, GRASS_WINDOW_M, grassHeightAt } from '../src/grass/shaders.ts'
import { GRASS_RECENTER_M, GRASS_WINDOW_CELLS, GrassWindow, type GrassWindowRegion } from '../src/grass/window.ts'
import { T, TILES, region } from './grass-fixture.ts'

const table = grassTileTable(TILES)

/** 3 × 3 regions around the origin, with bumpy heights and a road grid, baked. */
function regions(): Array<GrassWindowRegion & { id: number }> {
  const out: Array<GrassWindowRegion & { id: number }> = []
  for (let rz = -1; rz <= 1; rz++) {
    for (let rx = -1; rx <= 1; rx++) {
      const ox = rx * 192, oz = rz * 192
      const d = region({
        id: 5000 + (rz + 1) * 3 + rx + 1, ox, oz,
        height: (gx, gz) => 20 + 6 * Math.sin((ox + gx * 2) * 0.031) + 4 * Math.cos((oz - gz * 2) * 0.047),
        layers: [(cx, cz) => ((cx + rx * 7) % 13 === 0 || (cz + rz * 5) % 17 === 0 ? [T.road, 15] : null)],
      })
      out.push({ id: d.region.id, ox, oz, heights: d.terrain.heights, grass: bakeRegionGrass(grassBakeSource(d), table) })
    }
  }
  return out
}

describe('the grass field window (GRASS_LIFE §3.1)', () => {
  it('re-centres only past 32 m, on the 8 m cell grid', () => {
    const w = new GrassWindow()
    expect(w.needsCentre(0, 0)).toBe(true)
    w.centre(13.7, -41.2)
    expect(Math.abs(w.x0 % GRASS_CELL_M)).toBe(0)
    expect(Math.abs(w.z0 % GRASS_CELL_M)).toBe(0)
    expect(Math.abs(w.x0 + GRASS_WINDOW_M / 2 - 13.7)).toBeLessThanOrEqual(GRASS_CELL_M / 2)
    expect(w.needsCentre(13.7 + GRASS_RECENTER_M - 0.5, -41.2)).toBe(false)
    expect(w.needsCentre(13.7, -41.2 - GRASS_RECENTER_M - 0.5)).toBe(true)
  })

  it('the row copies equal the region bakes texel for texel (x east, z = glTF z; region rows run north = −z)', () => {
    const rs = regions()
    const w = new GrassWindow()
    w.centre(-40, -70)
    w.fill(rs)
    let checked = 0
    for (let j = 0; j < GRASS_WINDOW_M; j += 3) {
      for (let i = 0; i < GRASS_WINDOW_M; i += 3) {
        const x = w.x0 + i + 0.5, z = w.z0 + j + 0.5
        const r = rs.find(q => x >= q.ox && x < q.ox + 192 && z > q.oz - 192 && z <= q.oz)
        const o = (j * GRASS_WINDOW_M + i) * 4
        if (!r) {
          expect([w.field[o], w.field[o + 3]]).toEqual([0, 255])
          continue
        }
        const ri = Math.floor(x - r.ox), rj = Math.floor(r.oz - z)
        const s = (rj * 192 + ri) * 4
        expect([...w.field.subarray(o, o + 4)]).toEqual([...r.grass!.subarray(s, s + 4)])
        checked++
      }
    }
    expect(checked).toBeGreaterThan(5000)
    expect(w.densityAt(w.x0 + 5, w.z0 + 5)).toBe(w.field[(5 * GRASS_WINDOW_M + 5) * 4]! / 255)
  })

  it('a region arriving late fills in; one that goes empties', () => {
    const rs = regions()
    const w = new GrassWindow()
    w.centre(0, 0)
    const centre = rs.find(r => r.ox === 0 && r.oz === 0)!
    w.fill(rs.filter(r => r !== centre))
    expect(w.densityAt(96, -96)).toBe(0)
    const v = w.version
    w.fill(rs)
    expect(w.version).toBe(v + 1)
    expect(w.densityAt(96.5, -95.5)).toBeGreaterThan(0)
    w.fill(rs.filter(r => r !== centre))
    expect(w.densityAt(96.5, -95.5)).toBe(0)
  })

  it('the height grid decodes to the terrain\'s own triangulation (format.ts terrainHeightAt) within 16-bit steps', () => {
    const rs = regions()
    const w = new GrassWindow()
    w.centre(30, -20)
    w.fill(rs)
    const step = w.hRange / 65535
    let n = 0
    for (let k = 0; k < 2000; k++) {
      const x = w.x0 + 1 + ((k * 37.13) % (GRASS_WINDOW_M - 2)), z = w.z0 + 1 + ((k * 91.7) % (GRASS_WINDOW_M - 2))
      const r = rs.find(q => x >= q.ox && x < q.ox + 192 && z > q.oz - 192 && z <= q.oz)
      if (!r) continue
      const want = terrainHeightAt(r.heights, (x - r.ox) * 10, (r.oz - z) * 10)
      expect(grassHeightAt(w.heightBytes, w.x0, w.z0, w.hMin, w.hRange, x, z)).toBeCloseTo(want, 2)
      expect(Math.abs(grassHeightAt(w.heightBytes, w.x0, w.z0, w.hMin, w.hRange, x, z) - want)).toBeLessThanOrEqual(step * 2 + 1e-6)
      expect(w.heightAt(x, z)).toBeCloseTo(want, 2)
      n++
    }
    expect(n).toBeGreaterThan(1500)
    // The vertices on region seams are shared: no step between neighbours.
    const seam = 0
    const a = grassHeightAt(w.heightBytes, w.x0, w.z0, w.hMin, w.hRange, seam - 1e-4, -50)
    const b = grassHeightAt(w.heightBytes, w.x0, w.z0, w.hMin, w.hRange, seam + 1e-4, -50)
    expect(Math.abs(a - b)).toBeLessThan(0.01)
    expect(GRID).toBe(97)
  })

  it('the cell table: each cell\'s maximum density and its ground range; empty cells are 0', () => {
    const rs = regions()
    const w = new GrassWindow()
    w.centre(0, 0)
    w.fill(rs)
    let grassy = 0
    for (let cz = 0; cz < GRASS_WINDOW_CELLS; cz += 5) {
      for (let cx = 0; cx < GRASS_WINDOW_CELLS; cx += 5) {
        let max = 0
        for (let j = cz * 8; j < cz * 8 + 8; j++) for (let i = cx * 8; i < cx * 8 + 8; i++) max = Math.max(max, w.field[(j * GRASS_WINDOW_M + i) * 4]!)
        const k = cz * GRASS_WINDOW_CELLS + cx
        expect(w.cellMax[k]).toBeCloseTo(max / 255, 6)
        const lo = w.cellY[k * 2]!, hi = w.cellY[k * 2 + 1]!
        expect(lo).toBeLessThanOrEqual(hi)
        for (const [x, z] of [[1, 1], [7, 7], [4, 2]] as const) {
          const h = w.heightAt(w.x0 + cx * 8 + x, w.z0 + cz * 8 + z)!
          expect(h).toBeGreaterThanOrEqual(lo - 0.01)
          expect(h).toBeLessThanOrEqual(hi + 0.01)
        }
        if (max) grassy++
      }
    }
    expect(grassy).toBeGreaterThan(20)
    expect(w.grassCells).toBeGreaterThan(0)
  })

  it('a fill (the re-centre) is cheap', () => {
    const rs = regions()
    const w = new GrassWindow()
    const ms: number[] = []
    for (let k = 0; k < 30; k++) {
      w.centre((k % 5) * 40 - 80, Math.floor(k / 5) * 30 - 90)
      const t0 = performance.now()
      w.fill(rs)
      ms.push(performance.now() - t0)
    }
    ms.sort((a, b) => a - b)
    console.info(`[grass-window] fill median ${ms[15]!.toFixed(3)} ms, worst ${ms[29]!.toFixed(3)} ms`)
    // ≤ 0.5 ms on a quiet dev PC (GRASS_LIFE §7.2); the bound here leaves room for a loaded test machine.
    expect(ms[15]).toBeLessThan(3)
  })
})
