/**
 * GRASS_LIFE's grass field (docs/GRASS_LIFE.md §3; lanes GL-S, GL-F): the 'field' ground cover WorldScatter makes on
 * the PBR path (scatter.ts DEFAULT_GROUND_COVER), and how the wildlife finds it.
 */
import type { GroundCover, GroundCoverFactory } from '../scatter.ts'
import { GrassField, type GrassFieldAccess } from './field.ts'

export { GrassField, regionGrassMask } from './field.ts'
export type { GrassFieldAccess, GrassFieldOptions, GrassFieldStats, GrassRect } from './field.ts'
export { GRASS_BAND_NOISE_M, GRASS_LEVELS, RING_OUT_NOISE_M, cellTier, cullGrass, grassCullOut, ringReach, scaleGrassLevel } from './cull.ts'
export type { GrassCullOut, GrassCullWindow, GrassLevel, GrassRingLevel } from './cull.ts'
export { GRASS_RING_LODS, RING_DOT_SHARE, buildRingPatch, cullGrassRing, grassRingCullOut, ringShare } from './ring.ts'
export type { GrassRingCullOut, GrassRingCullWindow, GrassRingLod, GrassRingPatch } from './ring.ts'
export {
  GRASS_COARSE, GRASS_RING_CELLS, GRASS_RING_CELL_M, GRASS_RING_HEIGHT_GRID, GRASS_RING_RECENTER_M, GRASS_RING_TEXELS, GRASS_RING_TEXEL_M,
  GRASS_RING_WINDOW_M, GrassRingBuffers, GrassRingWindow, coarseGrass,
} from './ring-window.ts'
export type { GrassRingRegion } from './ring-window.ts'
export { GRASS_RING_PARTS, GRASS_RING_SHADER, GRASS_RING_UNIFORMS, grassNoise, grassRingShaders, ringTuftVisible } from './ring-shaders.ts'
export { GRASS_LODS, bladesPerM2, buildPatch } from './patch.ts'
export type { GrassDensity, GrassLod, GrassPatch } from './patch.ts'
export { BUILTIN_GRASS_PALETTES, GRASS_MASK_ONE, GRASS_REGION_M, RegionGrassBake, bakeRegionGrass, grassBakeSource, grassNeighbourBit, grassTileTable, meadowAt, tileGrassWeight } from './bake.ts'
export type { GrassBakeOptions, GrassBakeSource, GrassOccupied, GrassSea, GrassTileTable } from './bake.ts'
export { GRASS_RECENTER_M, GRASS_WINDOW_CELLS, GrassWindow } from './window.ts'
export type { GrassWindowRegion } from './window.ts'

/** Makes the grass field for a WorldScatter (its default 'field' ground cover). */
export const createGrassField: GroundCoverFactory = (scatter, host) => new GrassField(scatter, host)

/** The grass field drawing for a scatter (world.scatter), or null (Low, the retail style, Grass: Off before it). */
export function grassFieldOf(scatter: { readonly groundCover: GroundCover | null }): GrassFieldAccess | null {
  const g = scatter.groundCover
  return g instanceof GrassField ? g : null
}
