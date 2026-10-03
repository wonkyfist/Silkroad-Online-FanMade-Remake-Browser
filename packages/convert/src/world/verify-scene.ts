/**
 * Loads a converted world directory (work/out/world/<name>) the way a renderer would (manifest transforms, terrain
 * bins, tile PNGs, glbs) and draws it top-down with ./verify.ts, for comparison against the client's own minimap
 * tiles (packages/convert/test/verify-world.test.ts).
 *
 * The render uses only the output and its documented rules:
 * - terrain: vertex (gx, gz) of region r at glTF [r.origin.x + 2 gx, h, r.origin.z - 2 gz] (manifest localToWorldRule),
 *   surface = format.ts terrainHeightAt, colour = the TerrainBin layer planes (TERRAIN.md 2.3) over the tile PNGs at
 *   u = localX / period, v = localZ / period (box-filtered to the render resolution); no lightmap (the client's minimap
 *   has no .t shadows);
 * - objects: every glb triangle at placement.position + placement.rotation (glTF), textured with its baseColor.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO, type Document } from '@gltf-transform/core'
import { CELLS, CELL_UNITS, decodeNavmeshBin, decodeTerrainBin, TILING_PERIODS, terrainHeightAt, type NavmeshBin, type TerrainBin } from './format.ts'
import type { WorldManifest, WorldPlacement, WorldRegion } from './manifest.ts'
import { composeTR, decodePng, TopDown, transformPoint, type Rgba, type Vec3 } from './verify.ts'

export interface LoadedRegion {
  region: WorldRegion
  terrain: TerrainBin
  navmesh: NavmeshBin | null
}

export interface LoadedWorld {
  dir: string
  manifest: WorldManifest
  regions: LoadedRegion[]
  /** glTF (x, z) -> region and region-local file units, by the manifest rule. */
  locate(x: number, z: number): { data: LoadedRegion; lx: number; lz: number } | null
}

export function loadWorld(dir: string): LoadedWorld {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as WorldManifest
  const regions = manifest.regions.map(region => ({
    region,
    terrain: decodeTerrainBin(readFileSync(join(dir, region.terrain.file))),
    navmesh: region.navmesh ? decodeNavmeshBin(readFileSync(join(dir, region.navmesh.file))) : null,
  }))
  const size = manifest.space.regionSizeM
  const mpu = manifest.space.metresPerUnit
  return {
    dir,
    manifest,
    regions,
    locate(x, z) {
      for (const data of regions) {
        const [ox, , oz] = data.region.origin
        if (x >= ox && x <= ox + size && z <= oz && z >= oz - size) return { data, lx: (x - ox) / mpu, lz: (oz - z) / mpu }
      }
      return null
    },
  }
}

/** A tile texture box-filtered to `n` x `n` texels (RGB floats), for sampling at minimap resolution. */
interface TileMip {
  n: number
  rgb: Float32Array
}

function tileMip(img: Rgba, n: number): TileMip {
  const rgb = new Float32Array(n * n * 3)
  const f = img.width / n
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let yy = 0; yy < f; yy++) {
        for (let xx = 0; xx < f; xx++) {
          const o = ((y * f + yy) * img.width + x * f + xx) * 4
          r += img.rgba[o]!
          g += img.rgba[o + 1]!
          b += img.rgba[o + 2]!
        }
      }
      const k = (y * n + x) * 3
      rgb[k] = r / (f * f)
      rgb[k + 1] = g / (f * f)
      rgb[k + 2] = b / (f * f)
    }
  }
  return { n, rgb }
}

/** Bilinear, wrapping; (u, v) in texture repeats, texel row 0 at v = 0. */
function sampleMip(m: TileMip, u: number, v: number, out: number[]): void {
  const x = (u - Math.floor(u)) * m.n - 0.5
  const y = (v - Math.floor(v)) * m.n - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const w = (xx: number, yy: number) => (((yy % m.n) + m.n) % m.n) * m.n + (((xx % m.n) + m.n) % m.n)
  const i00 = w(x0, y0) * 3
  const i10 = w(x0 + 1, y0) * 3
  const i01 = w(x0, y0 + 1) * 3
  const i11 = w(x0 + 1, y0 + 1) * 3
  for (let k = 0; k < 3; k++) {
    out[k] = (m.rgb[i00 + k]! * (1 - fx) + m.rgb[i10 + k]! * fx) * (1 - fy) + (m.rgb[i01 + k]! * (1 - fx) + m.rgb[i11 + k]! * fx) * fy
  }
}

/** Tile texture coordinate (in file units, before dividing by the period) of a region-local point. */
export type TileUv = (lx: number, lz: number) => [u: number, v: number]

/** TERRAIN.md 2.2: u along +X, v along +Z, texel row 0 at v = 0. */
export const DOCUMENTED_TILE_UV: TileUv = (lx, lz) => [lx, lz]

/**
 * Terrain colour at region-local (lx, lz) from the native layer planes: layer 0 opaque, later layers blended with the
 * bilinear corner mask (bit 0 (cx, cz), 1 (cx+1, cz), 2 (cx, cz+1), 3 (cx+1, cz+1)).
 */
export function terrainColour(t: TerrainBin, tiles: Map<number, TileMip>, lx: number, lz: number, out: number[],
  tileUv: TileUv = DOCUMENTED_TILE_UV): void {
  const cx = Math.min(CELLS - 1, Math.max(0, Math.floor(lx / CELL_UNITS)))
  const cz = Math.min(CELLS - 1, Math.max(0, Math.floor(lz / CELL_UNITS)))
  const fx = Math.min(1, Math.max(0, lx / CELL_UNITS - cx))
  const fz = Math.min(1, Math.max(0, lz / CELL_UNITS - cz))
  const tmp = [0, 0, 0]
  out[0] = out[1] = out[2] = 0
  for (let k = 0; k < t.layerCount; k++) {
    const o = ((k * CELLS + cz) * CELLS + cx) * 4
    if (!t.layers[o + 3]) break
    const id = t.layers[o]! | ((t.layers[o + 1]! & 3) << 8)
    const code = t.layers[o + 1]! >> 2
    const m = t.layers[o + 2]!
    const alpha = k === 0 ? 1
      : ((m & 1) * (1 - fx) * (1 - fz) + ((m >> 1) & 1) * fx * (1 - fz) + ((m >> 2) & 1) * (1 - fx) * fz + ((m >> 3) & 1) * fx * fz)
    const mip = tiles.get(id)
    if (!mip || alpha <= 0) continue
    const period = TILING_PERIODS[code] ?? 80
    const [u, v] = tileUv(lx, lz)
    sampleMip(mip, u / period, v / period, tmp)
    for (let c = 0; c < 3; c++) out[c] = out[c]! * (1 - alpha) + tmp[c]! * alpha
  }
}

export function loadTileMips(world: LoadedWorld, n = 16): Map<number, TileMip> {
  const out = new Map<number, TileMip>()
  for (const t of world.manifest.tiles) out.set(t.id, tileMip(decodePng(readFileSync(join(world.dir, t.file))), n))
  return out
}

/** Terrain of every loaded region into `view` (colour + height as depth). */
export function drawTerrain(view: TopDown, world: LoadedWorld, tiles: Map<number, TileMip>, tileUv: TileUv = DOCUMENTED_TILE_UV): void {
  const rgb = [0, 0, 0]
  for (let r = 0; r < view.height; r++) {
    for (let c = 0; c < view.width; c++) {
      const [x, z] = view.centre(c, r)
      const hit = world.locate(x, z)
      if (!hit) continue
      terrainColour(hit.data.terrain, tiles, hit.lx, hit.lz, rgb, tileUv)
      view.set(r * view.width + c, rgb, terrainHeightAt(hit.data.terrain.heights, hit.lx, hit.lz))
    }
  }
}

// --- models ---------------------------------------------------------------------------------------------------------

export interface ModelPrimitive {
  /** Model-space glTF positions (node transforms applied; skinned meshes in bind pose). */
  positions: Float32Array
  uvs: Float32Array | null
  indices: Uint32Array
  texture: Rgba | null
  factor: [number, number, number, number]
  /** Texels with alpha below this are transparent (MASK / BLEND materials), else -1. */
  cutoff: number
}

export interface ModelGeometry {
  primitives: ModelPrimitive[]
}

const imageCache = new Map<string, Rgba | null>()

/** Reads a glb into flat triangle lists (TRIANGLES primitives only). */
export async function loadModelGeometry(glbFile: string): Promise<ModelGeometry> {
  const doc: Document = await new NodeIO().readBinary(readFileSync(glbFile))
  const primitives: ModelPrimitive[] = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    // glTF: a skinned mesh ignores its node transform; the joints' bind pose reproduces the stored positions.
    const m = node.getSkin() ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : node.getWorldMatrix()
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue
      const pos = prim.getAttribute('POSITION')?.getArray()
      if (!pos) continue
      const positions = new Float32Array(pos.length)
      for (let i = 0; i < pos.length; i += 3) positions.set(transformPoint(m, pos[i]!, pos[i + 1]!, pos[i + 2]!), i)
      const uv = prim.getAttribute('TEXCOORD_0')?.getArray()
      const idx = prim.getIndices()?.getArray()
      const indices = idx ? Uint32Array.from(idx) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
      const mat = prim.getMaterial()
      let texture: Rgba | null = null
      const tex = mat?.getBaseColorTexture()
      if (tex) {
        const key = `${glbFile}#${tex.getName()}#${tex.getURI()}#${doc.getRoot().listTextures().indexOf(tex)}`
        if (!imageCache.has(key)) {
          const img = tex.getImage()
          let decoded: Rgba | null = null
          try {
            if (img && tex.getMimeType() === 'image/png') decoded = decodePng(img)
          } catch {
            decoded = null
          }
          imageCache.set(key, decoded)
        }
        texture = imageCache.get(key)!
      }
      const mode = mat?.getAlphaMode() ?? 'OPAQUE'
      primitives.push({
        positions,
        uvs: uv ? Float32Array.from(uv) : null,
        indices,
        texture,
        factor: (mat?.getBaseColorFactor() ?? [1, 1, 1, 1]) as [number, number, number, number],
        cutoff: mode === 'MASK' ? mat!.getAlphaCutoff() * 255 : mode === 'BLEND' ? 128 : -1,
      })
    }
  }
  return { primitives }
}

export interface PlacementVariant {
  name: string
  /** Model-space point -> glTF world, for a placement. */
  matrix: (p: WorldPlacement) => number[]
  /** Mirrors the mesh (reverses nothing else; the rasterizer is winding-agnostic). */
  mirror?: [number, number, number]
}

/** The converter's placement transform (what the viewer draws): T(position) R(rotation). */
export const placementMatrix = (p: WorldPlacement) => composeTR(p.position, p.rotation)

/**
 * The converter's transform first, then deliberately wrong alternatives (to show the checks can tell them apart):
 * the yaw sign flipped, the mesh mirrored before placement (a wrong handedness conversion of the model), and yaw + pi.
 */
export const PLACEMENT_VARIANTS: readonly PlacementVariant[] = [
  { name: 'converted', matrix: placementMatrix },
  { name: 'yawNegated', matrix: p => composeTR(p.position, [0, -p.rotation[1], 0, p.rotation[3]]) },
  { name: 'meshMirrorX', matrix: placementMatrix, mirror: [-1, 1, 1] },
  { name: 'meshMirrorZ', matrix: placementMatrix, mirror: [1, 1, -1] },
  { name: 'yawPlusPi', matrix: p => composeTR(p.position, [0, p.rotation[3], 0, -p.rotation[1]]) },
]

/** Lambert shading of object triangles: colour *= ambient + diffuse * max(0, n . dir), n facing up (glTF). */
export interface Shading {
  dir: Vec3
  ambient: number
  diffuse: number
}

/** Draws a model instance; returns the number of triangles drawn. */
export function drawModel(view: TopDown, geom: ModelGeometry, matrix: readonly number[], owner: number,
  mirror: readonly number[] = [1, 1, 1], shading?: Shading): number {
  let n = 0
  const rgb = [0, 0, 0]
  for (const prim of geom.primitives) {
    const world = new Float32Array(prim.positions.length)
    for (let i = 0; i < prim.positions.length; i += 3) {
      world.set(transformPoint(matrix, prim.positions[i]! * mirror[0]!, prim.positions[i + 1]! * mirror[1]!, prim.positions[i + 2]! * mirror[2]!), i)
    }
    const tex = prim.texture
    const [fr, fg, fb] = prim.factor
    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      const ia = prim.indices[t]!
      const ib = prim.indices[t + 1]!
      const ic = prim.indices[t + 2]!
      const a: Vec3 = [world[ia * 3]!, world[ia * 3 + 1]!, world[ia * 3 + 2]!]
      const b: Vec3 = [world[ib * 3]!, world[ib * 3 + 1]!, world[ib * 3 + 2]!]
      const c: Vec3 = [world[ic * 3]!, world[ic * 3 + 1]!, world[ic * 3 + 2]!]
      let k = 1
      if (shading) {
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const
        const nx = u[1] * v[2] - u[2] * v[1]
        const ny = u[2] * v[0] - u[0] * v[2]
        const nz = u[0] * v[1] - u[1] * v[0]
        // the side facing up (the rasterizer draws both sides)
        const len = (ny < 0 ? -1 : 1) * (Math.hypot(nx, ny, nz) || 1)
        const d = shading.dir
        k = shading.ambient + shading.diffuse * Math.max(0, (nx * d[0] + ny * d[1] + nz * d[2]) / len / Math.hypot(d[0], d[1], d[2]))
      }
      view.triangle(a, b, c, (w0, w1, w2) => {
        if (!tex || !prim.uvs) {
          rgb[0] = 255 * fr * k
          rgb[1] = 255 * fg * k
          rgb[2] = 255 * fb * k
          return rgb
        }
        const u = w0 * prim.uvs[ia * 2]! + w1 * prim.uvs[ib * 2]! + w2 * prim.uvs[ic * 2]!
        const v = w0 * prim.uvs[ia * 2 + 1]! + w1 * prim.uvs[ib * 2 + 1]! + w2 * prim.uvs[ic * 2 + 1]!
        const x = Math.min(tex.width - 1, Math.floor((u - Math.floor(u)) * tex.width))
        const y = Math.min(tex.height - 1, Math.floor((v - Math.floor(v)) * tex.height))
        const o = (y * tex.width + x) * 4
        if (prim.cutoff >= 0 && tex.rgba[o + 3]! < prim.cutoff) return null
        rgb[0] = tex.rgba[o]! * fr * k
        rgb[1] = tex.rgba[o + 1]! * fg * k
        rgb[2] = tex.rgba[o + 2]! * fb * k
        return rgb
      }, owner)
      n++
    }
  }
  return n
}

/**
 * Draws every placement accepted by `filter` with `variant` (default: the converter's transform). `transform` may
 * post-multiply the placement matrix (e.g. a scale about the model origin).
 */
export function drawPlacements(view: TopDown, world: LoadedWorld, models: Map<number, ModelGeometry>,
  opts: { variant?: PlacementVariant; filter?: (p: WorldPlacement) => boolean; shading?: Shading;
    matrix?: (p: WorldPlacement) => number[] } = {}): number {
  const variant = opts.variant ?? PLACEMENT_VARIANTS[0]!
  let n = 0
  world.manifest.placements.forEach((p, i) => {
    if (opts.filter && !opts.filter(p)) return
    const m = opts.matrix ? opts.matrix(p) : variant.matrix(p)
    for (const index of p.models) {
      const geom = models.get(index)
      if (geom) n += drawModel(view, geom, m, i, variant.mirror, opts.shading)
    }
  })
  return n
}

/** Loads the geometry of every converted model the placements use (index = WorldModel.index). */
export async function loadAllModels(world: LoadedWorld): Promise<Map<number, ModelGeometry>> {
  const out = new Map<number, ModelGeometry>()
  for (const m of world.manifest.models) {
    if (!m.glb) continue
    out.set(m.index, await loadModelGeometry(join(world.dir, m.glb)))
  }
  return out
}

/** A north-up view covering all regions of the world at `px` metres per pixel. */
export function worldView(world: LoadedWorld, px: number): TopDown {
  const size = world.manifest.space.regionSizeM
  const xs = world.manifest.regions.map(r => r.origin[0])
  const zs = world.manifest.regions.map(r => r.origin[2])
  const x0 = Math.min(...xs)
  const z0 = Math.min(...zs) - size
  const w = Math.round((Math.max(...xs) + size - x0) / px)
  const h = Math.round((Math.max(...zs) - z0) / px)
  return new TopDown(w, h, x0, z0, px)
}

/** Pixel rectangle of a region inside a worldView. */
export function regionRect(view: TopDown, region: WorldRegion, size: number): { c0: number; r0: number; n: number } {
  return {
    c0: Math.round((region.origin[0] - view.x0) / view.px),
    r0: Math.round((region.origin[2] - size - view.z0) / view.px),
    n: Math.round(size / view.px),
  }
}
