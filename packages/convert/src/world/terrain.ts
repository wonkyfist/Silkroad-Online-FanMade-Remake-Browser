/**
 * Region terrain -> TerrainBin data (./format.ts) per docs/TERRAIN.md.
 *
 * - heights: the stitched .m grid (mapm.ts assembleRegionGrid), scaled to metres with space.ts UNIT_SCALE;
 * - normals: central differences in file space (across region seams when the neighbour exists), mirrored with
 *   space.ts toGltfDirection;
 * - layers: the native per-cell layering of TERRAIN.md 2.3 (OpenSRO's RE of sub_8b3aa0, restated there in our own
 *   words; status "likely"), run per block on the block's own 17 x 17 texture words;
 * - water and environment ids per block.
 */
import {
  MAPM_BLOCK_TILES,
  MAPM_BLOCK_VERTICES,
  MAPM_BLOCKS,
  MAPM_TEXTURE_ID_MASK,
  MAPM_WATER,
  MAPM_WATER_ICE,
  type MapMBlock,
  type MapMFile,
} from '@sro/formats'
import { toGltfDirection, UNIT_SCALE } from '../gltf/space.ts'
import { CELLS, GRID, MAX_TERRAIN_LAYERS, roundM } from './format.ts'
import type { TerrainBlock } from './manifest.ts'

/** Tiling code of a raw texture word (bits 13..15). */
export const tilingCode = (word: number) => word >>> 13

/** Heights (file units) of any grid vertex by global grid coordinates, or undefined outside loaded terrain. */
export type GlobalHeight = (globalGx: number, globalGz: number) => number | undefined

export interface LayerResult {
  /** layerCount x 96 x 96 x 4 bytes (see format.ts). */
  layers: Uint8Array
  layerCount: number
  /** Histogram: cells with n layers at index n. */
  layersPerCell: number[]
  /** Cells that needed more than MAX_TERRAIN_LAYERS layers (the oldest were dropped). */
  overflowCells: number
}

/**
 * Native per-cell layering of one block (TERRAIN.md 2.3). Returns, per cell (index cz * 16 + cx), the layers to draw
 * in order as [key, mask4], key = (tileId << 3) | code; the first layer has mask 15.
 */
export function blockLayers(textures: ArrayLike<number>): Array<Array<[key: number, mask: number]>> {
  const V = MAPM_BLOCK_VERTICES
  const T = MAPM_BLOCK_TILES
  const keys = new Int32Array(V * V)
  for (let i = 0; i < V * V; i++) {
    const w = textures[i]!
    keys[i] = ((w & MAPM_TEXTURE_ID_MASK) << 3) | tilingCode(w)
  }
  const distinct = [...new Set(keys)].sort((a, b) => a - b)
  const claimed = new Uint8Array(T * T)
  const out: Array<Array<[number, number]>> = Array.from({ length: T * T }, () => [])
  const corners = (cx: number, cz: number) => [cz * V + cx, cz * V + cx + 1, (cz + 1) * V + cx, (cz + 1) * V + cx + 1]
  for (const key of distinct) {
    const mask = new Uint8Array(V * V)
    for (let i = 0; i < V * V; i++) if (keys[i] === key) mask[i] = 1
    const touched = new Uint8Array(T * T)
    for (let cz = 0; cz < T; cz++) {
      for (let cx = 0; cx < T; cx++) if (corners(cx, cz).some(v => keys[v] === key)) touched[cz * T + cx] = 1
    }
    const near = new Uint8Array(T * T)
    for (let cz = 0; cz < T; cz++) {
      for (let cx = 0; cx < T; cx++) {
        const c = cz * T + cx
        if (!touched[c] || claimed[c]) continue
        claimed[c] = 1
        for (const v of corners(cx, cz)) mask[v] = 1
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const nz = cz + dz
            if ((dx || dz) && nx >= 0 && nx < T && nz >= 0 && nz < T) near[nz * T + nx] = 1
          }
        }
      }
    }
    for (let cz = 0; cz < T; cz++) {
      for (let cx = 0; cx < T; cx++) {
        const c = cz * T + cx
        if (!touched[c] && !near[c]) continue
        const m = corners(cx, cz).reduce((bits, v, bit) => bits | (mask[v]! << bit), 0)
        if (m) out[c]!.push([key, m])
      }
    }
  }
  for (let c = 0; c < T * T; c++) {
    const list = out[c]!
    let last = -1
    for (let k = 0; k < list.length; k++) if (list[k]![1] === 15) last = k
    if (last > 0) out[c] = list.slice(last)
  }
  return out
}

/** Runs blockLayers over the 36 blocks and packs the result into the TerrainBin layer planes. */
export function buildLayers(mapm: MapMFile): LayerResult {
  const perCell: Array<Array<[number, number]>> = new Array(CELLS * CELLS)
  for (const block of mapm.blocks) {
    const cells = blockLayers(block.textures)
    for (let z = 0; z < MAPM_BLOCK_TILES; z++) {
      for (let x = 0; x < MAPM_BLOCK_TILES; x++) {
        perCell[(block.bz * MAPM_BLOCK_TILES + z) * CELLS + block.bx * MAPM_BLOCK_TILES + x] = cells[z * MAPM_BLOCK_TILES + x]!
      }
    }
  }
  let layerCount = 1
  let overflowCells = 0
  const layersPerCell: number[] = []
  for (const list of perCell) {
    layersPerCell[list.length] = (layersPerCell[list.length] ?? 0) + 1
    if (list.length > MAX_TERRAIN_LAYERS) overflowCells++
    layerCount = Math.max(layerCount, Math.min(list.length, MAX_TERRAIN_LAYERS))
  }
  const layers = new Uint8Array(layerCount * CELLS * CELLS * 4)
  perCell.forEach((list0, c) => {
    // Keep the top layers when over budget (the first kept one becomes the opaque base).
    const list = list0.length > MAX_TERRAIN_LAYERS ? list0.slice(list0.length - MAX_TERRAIN_LAYERS) : list0
    list.forEach(([key, mask], k) => {
      const id = key >>> 3
      const code = key & 7
      const o = (k * CELLS * CELLS + c) * 4
      layers[o] = id & 0xff
      layers[o + 1] = (id >>> 8) | (code << 2)
      layers[o + 2] = k === 0 ? 15 : mask
      layers[o + 3] = 255
    })
  })
  for (let n = 0; n < layersPerCell.length; n++) layersPerCell[n] ??= 0
  return { layers, layerCount, layersPerCell, overflowCells }
}

/** Heights in metres (glTF y): the file-space heights times space.ts UNIT_SCALE. */
export function heightsToMetres(heights: Float32Array): Float32Array {
  const out = new Float32Array(heights.length)
  for (let i = 0; i < heights.length; i++) out[i] = heights[i]! * UNIT_SCALE
  return out
}

/**
 * Unit normals in glTF space (x, y, z, 0) * 127. File-space normal (-dh/dx, 1, -dh/dz) from central differences
 * (one-sided where no neighbour region is loaded), converted with space.ts toGltfDirection.
 */
export function buildNormals(regionX: number, regionZ: number, heightAt: GlobalHeight): Int8Array {
  const out = new Int8Array(GRID * GRID * 4)
  const bx = regionX * CELLS
  const bz = regionZ * CELLS
  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) {
      const h = heightAt(bx + gx, bz + gz)!
      const hl = heightAt(bx + gx - 1, bz + gz)
      const hr = heightAt(bx + gx + 1, bz + gz)
      const hd = heightAt(bx + gx, bz + gz - 1)
      const hu = heightAt(bx + gx, bz + gz + 1)
      const dx = hl !== undefined && hr !== undefined ? (hr - hl) / 40 : hr !== undefined ? (hr - h) / 20 : hl !== undefined ? (h - hl) / 20 : 0
      const dz = hd !== undefined && hu !== undefined ? (hu - hd) / 40 : hu !== undefined ? (hu - h) / 20 : hd !== undefined ? (h - hd) / 20 : 0
      const len = Math.hypot(dx, 1, dz)
      const n = toGltfDirection([-dx / len, 1 / len, -dz / len])
      const o = (gz * GRID + gx) * 4
      out[o] = Math.round(n[0] * 127)
      out[o + 1] = Math.round(n[1] * 127)
      out[o + 2] = Math.round(n[2] * 127)
    }
  }
  return out
}

export function blockEntry(block: MapMBlock): TerrainBlock {
  let water: TerrainBlock['water'] = null
  if (block.waterType === MAPM_WATER || block.waterType === MAPM_WATER_ICE) {
    water = {
      kind: block.waterType === MAPM_WATER ? 'water' : 'ice',
      type: block.waterType,
      wave: block.waterWaveType,
      heightM: roundM(block.waterHeight * UNIT_SCALE),
    }
  }
  return { bx: block.bx, bz: block.bz, flag: block.flag, environmentId: block.environmentId, water }
}

export const BLOCKS_PER_REGION = MAPM_BLOCKS * MAPM_BLOCKS
