/**
 * Region numbers of a coast result (docs/COAST.md §2.2, §9.4; the prototype's census.py): which synthetic regions
 * are emitted (land, or water shallower than emit.depthM), and which exported regions change height (their terrain,
 * nav, lightmap and minimap are rewritten). They go into manifest.report.coast (CST-C phase 1).
 */
import type { CoastConfig } from './config.ts'
import { CELLS_PER_REGION, type RegionRect } from './lattice.ts'
import type { CoastResult } from './pass.ts'

export interface EmittedRegion {
  x: number
  z: number
  kind: 'land' | 'shallow'
}

export interface EmitCensus {
  emitted: EmittedRegion[]
  land: number
  shallow: number
  deepOnly: number
  /** Regions left out because they lie wholly on a land edge (the phase split: nothing is synthesised there). */
  landEdge: number
}

/** The lattice indices of region (x, z)'s 97 x 97 vertices, row by row from the north edge; null outside the domain. */
export function regionWindow(r: CoastResult, x: number, z: number): { row0: number; col0: number } | null {
  const l = r.shape
  if (x < l.x0 || x > l.x1 || z < l.z0 || z > l.z1) return null
  return { row0: (l.z1 - z) * CELLS_PER_REGION, col0: (x - l.x0) * CELLS_PER_REGION }
}

/**
 * Synthetic regions to emit: every region of the emit rectangle that is not an active exported region, with any dry
 * vertex (land) or any water shallower than emit.depthM (shallow). A region whose every vertex is a land edge is not
 * synthesised (the fade lies on the sea side).
 */
export function emitCensus(r: CoastResult, cfg: CoastConfig, exportRect: RegionRect, active: (x: number, z: number) => boolean): EmitCensus {
  const out: EmitCensus = { emitted: [], land: 0, shallow: 0, deepOnly: 0, landEdge: 0 }
  const { cols } = r.shape
  const SL = cfg.seaLevelM
  for (let z = cfg.emit.z[0]; z <= cfg.emit.z[1]; z++) {
    for (let x = cfg.emit.x[0]; x <= cfg.emit.x[1]; x++) {
      const inExport = x >= exportRect.x0 && x <= exportRect.x1 && z >= exportRect.z0 && z <= exportRect.z1
      if (inExport && active(x, z)) continue
      const win = regionWindow(r, x, z)
      if (!win) continue
      let dry = false
      let minDepth = Infinity
      let edge = true
      for (let i = 0; i <= CELLS_PER_REGION; i++) {
        for (let j = 0; j <= CELLS_PER_REGION; j++) {
          const k = (win.row0 + i) * cols + win.col0 + j
          if (!r.masks.waterSurface[k]) dry = true
          minDepth = Math.min(minDepth, SL - r.h[k]!)
          if (r.landFade[k]! < 0.999) edge = false
        }
      }
      if (edge) out.landEdge++
      else if (dry) {
        out.land++
        out.emitted.push({ x, z, kind: 'land' })
      } else if (minDepth < cfg.emit.depthM) {
        out.shallow++
        out.emitted.push({ x, z, kind: 'shallow' })
      } else out.deepOnly++
    }
  }
  return out
}

/** Exported regions whose heights change by more than `tolM` anywhere (retail heights in `retail`, NaN = none). */
export function changedRegions(r: CoastResult, retail: Float64Array, regions: ReadonlyArray<{ x: number; z: number }>, tolM = 0.01): Array<{ x: number; z: number; maxDeltaM: number }> {
  const out: Array<{ x: number; z: number; maxDeltaM: number }> = []
  const { cols } = r.shape
  for (const { x, z } of regions) {
    const win = regionWindow(r, x, z)
    if (!win) continue
    let max = 0
    for (let i = 0; i <= CELLS_PER_REGION; i++) {
      for (let j = 0; j <= CELLS_PER_REGION; j++) {
        const k = (win.row0 + i) * cols + win.col0 + j
        const b = retail[k]!
        if (!Number.isNaN(b)) max = Math.max(max, Math.abs(r.h[k]! - b))
      }
    }
    if (max > tolM) out.push({ x, z, maxDeltaM: max })
  }
  return out
}
