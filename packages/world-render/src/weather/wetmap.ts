/**
 * Per-region wet map (docs/WEATHER.md §6.2, docs/WAVE_PLAN3.md D22): where puddles form, built on the CPU from the
 * region's terrain bin when the region commits (its own commit job after the terrain, `World.addCommitStep`), bound as
 * the region's `wetMap` (TerrainRenderer.setRegionTexture) for the Classic terrain chunk and the PBR terrain plugin.
 *
 * RGBA8, 97 × 97, texel (gx, gz) = terrain vertex (gx, gz) (row gz, the layer-map convention; sample at
 * `(lp / 20 + 0.5) / 97` with `lp` in region file units):
 *   R  puddle potential = flat × eligible(class) × max(basin × edge, 0.3), basin = smoothstep(0, 0.2, mean(h, 5 × 5)
 *      − h) (metres below the 8 m neighbourhood), flat = smoothstep(0.965, 0.995, normal.y), edge = min(1, d / 3) with
 *      d the vertex distance to the region's nearest edge. A region only has its own heights, so the window is clamped
 *      at its edges and two neighbours would give their shared vertices different basins (a puddle line along the 192 m
 *      grid, W9F S3); the basin fades out toward the edge instead, so both sides agree exactly on the shared vertices
 *      (flat, class and the 0.3 floor are the same there).
 *   G  128 + 127 × normal.x (glTF)   } the smooth vertex normal for the wet sheen (the terrain mesh has none); WEATHER
 *   A  128 + 127 × normal.z (glTF)   } §6.2 kept a debug class copy in G and 255 in A, which no reader uses
 *   B  flatness × 255
 * A texel whose (G, A) decode to |n.xz| > 1 is not a normal: the chunk's 1 × 1 black fallback (0, 0, 0, 255) reads as
 * "no wet map" (no puddles, an up normal).
 *
 * Pure and environment-neutral. Measured by the WEATHER prototype at 0.66–1.1 ms per region with a 5 × 5 loop; the
 * summed-area table here makes the window mean O(1) per vertex.
 */
import { GRID } from '../../../convert/src/world/format.ts'
import { TERRAIN_SURFACE_PARAMS, terrainSurfaceClass } from '../pbr/classes.ts'

export const WET_MAP_SIZE = GRID
/** Half-width of the basin window in vertices (5 × 5 = the 8 m neighbourhood). */
const R = 2

/** The terrain bin fields the wet map reads. */
export interface WetMapTerrain {
  /** GRID² heights (m). */
  heights: Float32Array
  /** GRID² × 4 glTF normals × 127. */
  normals: Int8Array
  /** GRID² raw texture words (tile id = low 10 bits). */
  textures: Uint16Array
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Tile id → surface class (pbr/classes.ts terrainSurfaceClass) from a manifest's tile list; unknown ids: generic. */
export function surfaceLookup(tiles: readonly { id: number; typeName?: string | null; file?: string; source?: string }[]): (tileId: number) => number {
  const m = new Map<number, number>()
  for (const t of tiles) m.set(t.id, terrainSurfaceClass({ typeName: t.typeName ?? undefined, file: t.file, source: t.source }))
  return id => m.get(id) ?? 0
}

let sat: Float64Array | null = null

/** Builds one region's wet map (RGBA8, WET_MAP_SIZE²) into `out` (or a new array). */
export function buildWetMap(t: WetMapTerrain, surfaceOf: (tileId: number) => number, out?: Uint8Array): Uint8Array {
  const n = GRID
  const data = out ?? new Uint8Array(n * n * 4)
  // Summed-area table of the heights, (n + 1)² with a zero border.
  const s = (sat ??= new Float64Array((n + 1) * (n + 1)))
  const w = n + 1
  for (let z = 0; z < n; z++) {
    let row = 0
    for (let x = 0; x < n; x++) {
      row += t.heights[z * n + x]!
      s[(z + 1) * w + x + 1] = s[z * w + x + 1]! + row
    }
  }
  const eligible = TERRAIN_SURFACE_PARAMS.map(p => p.puddle)
  for (let gz = 0; gz < n; gz++) {
    const z0 = Math.max(0, gz - R), z1 = Math.min(n - 1, gz + R)
    for (let gx = 0; gx < n; gx++) {
      const x0 = Math.max(0, gx - R), x1 = Math.min(n - 1, gx + R)
      const sum = s[(z1 + 1) * w + x1 + 1]! - s[z0 * w + x1 + 1]! - s[(z1 + 1) * w + x0]! + s[z0 * w + x0]!
      const count = (z1 - z0 + 1) * (x1 - x0 + 1)
      const i = gz * n + gx
      const depth = sum / count - t.heights[i]!
      const nx = t.normals[i * 4]! / 127
      const ny = t.normals[i * 4 + 1]! / 127
      const nz = t.normals[i * 4 + 2]! / 127
      const flat = smooth(0.965, 0.995, ny)
      const cls = surfaceOf(t.textures[i]! & 0x3ff)
      const basin = smooth(0, 0.2, depth)
      const edge = Math.min(1, Math.min(gx, gz, n - 1 - gx, n - 1 - gz) / (R + 1))
      const p = flat * (eligible[cls] ?? 0) * Math.max(basin * edge, 0.3)
      const o = i * 4
      data[o] = Math.round(p * 255)
      data[o + 1] = Math.round(128 + 127 * Math.max(-1, Math.min(1, nx)))
      data[o + 2] = Math.round(flat * 255)
      data[o + 3] = Math.round(128 + 127 * Math.max(-1, Math.min(1, nz)))
    }
  }
  return data
}

/** The share of texels whose puddle potential is at least `min` (0..1). */
export function wetMapCoverage(map: Uint8Array, min: number): number {
  let hit = 0
  const cut = Math.round(min * 255)
  for (let i = 0; i < map.length; i += 4) if (map[i]! >= cut) hit++
  return hit / (map.length / 4)
}

/** The normal a texel decodes to (the chunk's rule), or null for "no wet map" (|n.xz| > 1). */
export function wetMapNormal(map: Uint8Array, gx: number, gz: number): [number, number, number] | null {
  const o = (gz * GRID + gx) * 4
  const x = (map[o + 1]! / 255) * 2 - 1
  const z = (map[o + 3]! / 255) * 2 - 1
  const q = x * x + z * z
  if (q > 1.02) return null
  return [x, Math.max(0.2, Math.sqrt(Math.max(0, 1 - q))), z]
}
