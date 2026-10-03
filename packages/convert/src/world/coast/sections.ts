/**
 * The section table along the coast (docs/COAST.md §3B.1): each section puts control points on its line (the
 * playable rectangle's edges or the corridor's faces), and every lattice vertex takes the Gaussian-weighted blend of
 * the control points' parameters around its nearest line point. The blend runs along the line (sigma
 * `sectionBlendM`), so a kind changes over about 110 m instead of at a hard boundary. As in the prototype it is
 * evaluated on a 4x coarser grid, repeated back up and smoothed (sigma 3 cells).
 */
import type { CoastConfig, CoastSection } from './config.ts'
import { gblur } from './grid.ts'
import { REGION_M, type LatticeShape, type RegionRect } from './lattice.ts'

/**
 * The land-edge channel blends over a much shorter distance than the beach parameters, so a land edge (a section
 * above the config's phase) ends within about LAND_BLEND_M of its last control point instead of leaking a partial
 * retail restore 150-200 m into the neighbouring sea side (the south flank next to a west land edge, for example).
 */
export const LAND_BLEND_M = 30

/** Blended channels, in this order. `land` is 1 at control points of sections above the config's phase. */
export const SECTION_CHANNELS = ['c0', 'amp', 'width', 'dune', 'dry', 'grade', 'd1', 'd2', 'd3', 'land'] as const
export type SectionChannel = (typeof SECTION_CHANNELS)[number]
/** Float32 per channel: the parameters need no more, and the field is ten lattice-sized arrays. */
export type SectionField = Record<SectionChannel, Float32Array>

export interface ControlPoint {
  x: number
  z: number
  code: string
  values: number[]
}

/** The line coordinate of a section's side (z for north/south/corridor sides, x for east/west). */
export function sideLine(side: CoastSection['side'], play: RegionRect, cfg: Pick<CoastConfig, 'corridor'>): number {
  switch (side) {
    case 'north': return play.z1 + 1
    case 'south': return play.z0
    case 'east': return play.x1 + 1
    case 'west': return play.x0
    case 'corridor-south': return cfg.corridor!.z[0]
    case 'corridor-north': return cfg.corridor!.z[1]
  }
}

/** Control points of every section, in table order (the blend's summation order). */
export function controlPoints(cfg: CoastConfig, play: RegionRect): ControlPoint[] {
  const out: ControlPoint[] = []
  for (const s of cfg.sections) {
    const k = cfg.beachKinds[s.kind]!
    const values = [s.c0, s.amp, k.width, k.dune, k.dry, k.grade, k.depth[0], k.depth[1], k.depth[2], s.phase > cfg.phase ? 1 : 0]
    const line = sideLine(s.side, play, cfg)
    const alongX = s.side !== 'east' && s.side !== 'west'
    for (let t = s.from; t <= s.to; t++) {
      out.push(alongX ? { x: t + 0.5, z: line, code: s.code, values } : { x: line, z: t + 0.5, code: s.code, values })
    }
    for (const [x, z] of s.corners ?? []) out.push({ x, z, code: s.code, values })
  }
  return out
}

/**
 * The blended section field at every lattice vertex, from the nearest line point (nx, nz) of each vertex (region
 * units). `step` is the coarse sampling (the prototype's 4).
 */
export function sectionField(
  l: LatticeShape, nx: ArrayLike<number>, nz: ArrayLike<number>, points: ControlPoint[], sigmaM: number, landSigmaM = LAND_BLEND_M, step = 4,
): SectionField {
  const cr = Math.ceil(l.rows / step)
  const cc = Math.ceil(l.cols / step)
  const nch = SECTION_CHANNELS.length
  const acc = new Float64Array(cr * cc * nch)
  const wsum = new Float64Array(cr * cc)
  const sig = sigmaM / REGION_M
  const lsig = landSigmaM / REGION_M
  const lacc = new Float64Array(cr * cc)
  const lsum = new Float64Array(cr * cc)
  const LAND = SECTION_CHANNELS.indexOf('land')
  for (const p of points) {
    for (let i = 0; i < cr; i++) {
      for (let j = 0; j < cc; j++) {
        const f = i * step * l.cols + j * step
        const c = i * cc + j
        const d2 = (nx[f]! - p.x) ** 2 + (nz[f]! - p.z) ** 2
        const w = Math.exp(-d2 / (2 * sig * sig)) + 1e-12
        const base = c * nch
        for (let k = 0; k < nch; k++) acc[base + k] = acc[base + k]! + w * p.values[k]!
        wsum[c] = wsum[c]! + w
        const lw = Math.exp(-d2 / (2 * lsig * lsig)) + 1e-300
        lacc[c] = lacc[c]! + lw * p.values[LAND]!
        lsum[c] = lsum[c]! + lw
      }
    }
  }
  const out = {} as SectionField
  SECTION_CHANNELS.forEach((name, k) => {
    const full = new Float64Array(l.rows * l.cols)
    for (let i = 0; i < l.rows; i++) {
      const ci = Math.floor(i / step) * cc
      for (let j = 0; j < l.cols; j++) {
        const c = ci + Math.floor(j / step)
        full[i * l.cols + j] = k === LAND ? lacc[c]! / lsum[c]! : acc[c * nch + k]! / wsum[c]!
      }
    }
    out[name] = Float32Array.from(gblur(full, l.rows, l.cols, 3))
  })
  return out
}
