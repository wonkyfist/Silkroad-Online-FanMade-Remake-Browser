/**
 * Baked sun shadows for the ground the coast moves (docs/COAST.md §5.4 step 5, refresh R14). Node-free.
 *
 * The PBR terrain reads a region's lightmap as the baked visibility of the key light beyond the shadow-map range
 * (`bakedVis = saturate((lm - 0.61) / 0.39)`, RND-T), and the retail lightmaps are two-level: 255 where lit, about 156
 * in shadow. Where the coast moves the ground, the retail shadows of the old mountains would lie on the new flank, so
 * inside the change mask the lightmap is re-baked: a heightfield ray-march on the coast lattice toward
 * BAKED_LIGHT_DIR (the direction RND-L measured on the retail lightmaps), lit 255, shadowed LIGHTMAP_SHADOW, with a
 * soft edge; outside the mask the retail texels stay bit for bit, and the mask's edge is feathered.
 */
import { CELL_M, CELLS_PER_REGION } from './lattice.ts'
import type { CoastResult } from './pass.ts'

/**
 * packages/world-render/src/sky/types.ts BAKED_LIGHT_DIR (glTF, toward the light; azimuth -14°, elevation 38°), copied
 * because the converter does not load Babylon; coast-lightmap.test.ts keeps the two equal.
 */
export const BAKED_LIGHT_DIR_GLTF: readonly [number, number, number] = [0.7646, 0.6157, -0.1906]
/** The retail lightmap's lit and shadow levels (0..255). */
export const LIGHTMAP_LIT = 255
export const LIGHTMAP_SHADOW = 156
/** A vertex that moved more than this (m) is re-baked; the mask is feathered over FEATHER_VERTICES. */
export const LIGHTMAP_MOVED_M = 0.25
const FEATHER_VERTICES = 3
/** The ray is blocked when the ground stands this far above it (m). */
const BLOCK_M = 0.3

/** Sun visibility (0..1) at every vertex of region (x, z) (97 x 97, gz-major), marched on the coast lattice. */
export function sunVisibility(r: CoastResult, x: number, z: number): Float32Array {
  const { rows, cols, x0, z1 } = r.shape
  const G = CELLS_PER_REGION + 1
  const [lx, ly, lz] = BAKED_LIGHT_DIR_GLTF
  const horiz = Math.hypot(lx, lz)
  // lattice steps per metre toward the light: +col = east = glTF +x; +row = south = glTF +z
  const dc = lx / horiz / CELL_M
  const dr = lz / horiz / CELL_M
  const rise = ly / horiz
  const maxH = r.stats.maxH
  const out = new Float32Array(G * G)
  const row0 = (z1 - z) * CELLS_PER_REGION
  const col0 = (x - x0) * CELLS_PER_REGION
  const hAt = (fr: number, fc: number) => {
    const c = Math.floor(fc)
    const rr = Math.floor(fr)
    if (c < 0 || rr < 0 || c >= cols - 1 || rr >= rows - 1) return NaN
    const tx = fc - c
    const tz = fr - rr
    const k = rr * cols + c
    return (r.h[k]! * (1 - tx) + r.h[k + 1]! * tx) * (1 - tz) + (r.h[k + cols]! * (1 - tx) + r.h[k + cols + 1]! * tx) * tz
  }
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const row = row0 + CELLS_PER_REGION - gz
      const col = col0 + gx
      const h0 = r.h[row * cols + col]!
      let vis = 1
      for (let t = CELL_M; ; t += CELL_M) {
        const y = h0 + t * rise
        if (y > maxH) break
        const h = hAt(row + dr * t, col + dc * t)
        if (!Number.isFinite(h)) break
        if (h > y + BLOCK_M) {
          // a soft edge: nearly grazing rays are partly lit
          vis = Math.max(0, 1 - (h - y - BLOCK_M) / 2)
          if (vis <= 0) break
        }
      }
      out[gz * G + gx] = vis
    }
  }
  return out
}

/**
 * The region's lightmap with the moved ground re-baked (a new RGBA image), or null when nothing moved. `retail`: the
 * retail .t image (512 x 512, row 0 = south), or null for a region without one (a white base). `retailHeights`: the
 * pass input's retail heights on the lattice.
 */
export function bakeRegionLightmap(
  r: CoastResult, retailHeights: Float64Array, x: number, z: number,
  retail: { width: number; height: number; rgba: Uint8Array } | null, size = 512,
): { width: number; height: number; rgba: Uint8Array } | null {
  const { cols, x0, z1 } = r.shape
  const G = CELLS_PER_REGION + 1
  const row0 = (z1 - z) * CELLS_PER_REGION
  const col0 = (x - x0) * CELLS_PER_REGION
  const mask = new Float32Array(G * G)
  let any = false
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const k = (row0 + CELLS_PER_REGION - gz) * cols + col0 + gx
      const H = retailHeights[k]!
      if (Number.isNaN(H) || Math.abs(r.h[k]! - H) > LIGHTMAP_MOVED_M) {
        mask[gz * G + gx] = 1
        any = true
      }
    }
  }
  if (!any) return null
  // feather: the mask grows by FEATHER_VERTICES and fades out over them
  const soft = new Float32Array(G * G)
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      let best = 0
      for (let dz = -FEATHER_VERTICES; dz <= FEATHER_VERTICES && best < 1; dz++) {
        for (let dx = -FEATHER_VERTICES; dx <= FEATHER_VERTICES; dx++) {
          const a = gx + dx
          const b = gz + dz
          if (a < 0 || b < 0 || a >= G || b >= G || !mask[b * G + a]) continue
          best = Math.max(best, 1 - Math.max(Math.abs(dx), Math.abs(dz)) / (FEATHER_VERTICES + 1))
        }
      }
      soft[gz * G + gx] = best
    }
  }
  const vis = sunVisibility(r, x, z)
  const w = retail?.width ?? size
  const h = retail?.height ?? size
  const rgba = retail ? Uint8Array.from(retail.rgba) : new Uint8Array(w * h * 4).fill(255)
  const bil = (a: Float32Array, fx: number, fz: number) => {
    const ix = Math.min(Math.floor(fx), G - 2)
    const iz = Math.min(Math.floor(fz), G - 2)
    const tx = fx - ix
    const tz = fz - iz
    return (a[iz * G + ix]! * (1 - tx) + a[iz * G + ix + 1]! * tx) * (1 - tz) + (a[(iz + 1) * G + ix]! * (1 - tx) + a[(iz + 1) * G + ix + 1]! * tx) * tz
  }
  for (let j = 0; j < h; j++) {
    // texel centres lie on the region border: texel j <-> vertex row (j / (h - 1)) * 96 (row 0 = south)
    const fz = (j / (h - 1)) * CELLS_PER_REGION
    for (let i = 0; i < w; i++) {
      const fx = (i / (w - 1)) * CELLS_PER_REGION
      const m = bil(soft, fx, fz)
      if (m <= 0) continue
      const baked = LIGHTMAP_SHADOW + (LIGHTMAP_LIT - LIGHTMAP_SHADOW) * bil(vis, fx, fz)
      const o = (j * w + i) * 4
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(rgba[o + c]! * (1 - m) + baked * m)
      rgba[o + 3] = 255
    }
  }
  return { width: w, height: h, rgba }
}
