/**
 * The batch's lightmap array (lane BT-A; docs/BATCHING.md §3.2, §3.3, §3.13, F7): every object lightmap a region
 * batch draws, in **one** RGBA8 array of 256² layers (one sampler; the prototype's 450 layers of 128² went past the
 * 256-layer default):
 *
 * - a lightmap larger than half a layer (the 61 at 256²; the nine 512² ones, the dragon fountain and eight Dunhuang
 *   temple maps `w_cd_tem_*`, box-reduced to 256²: an accepted A/B difference) takes a whole layer;
 * - a 128² or 64² one (the 558 + 52 others) takes a 128² quadrant, the 64² ones upsampled;
 * - layer 0's first quadrant is white: the pieces without a bake sample it (sun visibility 1, AO 1);
 * - that is 70 + ⌈(610 + 1) / 4⌉ = 223 layers for the whole of jangan-fields (`lightmapLayers`), ≤ 256 on every
 *   adapter, and the resident set is a fraction of it;
 * - 2 mip levels (the shader clamps the lightmap LOD to ≤ 1: lightmaps are low-frequency).
 *
 * The merge remaps a piece's UV2 into its place (`remapUv2`) before packing the layer into UV2's integer part.
 * Quadrants cannot bleed: the retail lightmap UVs lie in [0.03, 0.97] (all 577 lightmapped primitives), so a
 * bilinear tap stays ≥ 3 texels inside its quadrant at level 0 and ≥ 1 at level 1 (`bilinearTaps`).
 */
import type { BaseTexture, Scene } from '@babylonjs/core'
import { lightmapShape, type CellImage, type CellShape } from '../pbr/decode-core.ts'
import { AtlasArrays, MAX_ARRAY_LAYERS, type Cell, type CellClaim, type CellDecoder } from './atlas.ts'

/** The lightmap layer size. */
export const LIGHTMAP_PAGE = 256
/** A quadrant (a 128² or 64² lightmap's place). */
export const LIGHTMAP_QUADRANT = LIGHTMAP_PAGE / 2
/** Mip levels of the lightmap array. */
export const LIGHTMAP_LEVELS = 2

/** Where a lightmap lies: UV2 → (u0 + u × scale, v0 + v × scale) in layer `layer` of array `array`. */
export interface LightmapPlacement {
  readonly array: number
  readonly layer: number
  readonly u0: number
  readonly v0: number
  readonly scale: number
}

/** The white quadrant (layer 0, first quadrant): pieces without a lightmap point their UV2 into it. */
export const WHITE_LIGHTMAP: LightmapPlacement = Object.freeze({ array: 0, layer: 0, u0: 0, v0: 0, scale: LIGHTMAP_QUADRANT / LIGHTMAP_PAGE })

/** A UV2 for pieces without a lightmap: the middle of the white quadrant. */
export const WHITE_UV2: readonly [number, number] = [0.25, 0.25]

/** The placement of a lightmap cell. */
export function placementOf(cell: Pick<Cell, 'array' | 'layer' | 'x' | 'y' | 'shape'>, page = LIGHTMAP_PAGE): LightmapPlacement {
  return { array: cell.array, layer: cell.layer, u0: cell.x / page, v0: cell.y / page, scale: cell.shape.width / page }
}

/** A piece's UV2 remapped into its lightmap's place (the layer is packed into the integer part by the merge). */
export function remapUv2(uv2: ArrayLike<number>, p: LightmapPlacement, out = new Float32Array(uv2.length)): Float32Array {
  for (let i = 0; i + 1 < uv2.length; i += 2) {
    out[i] = p.u0 + uv2[i]! * p.scale
    out[i + 1] = p.v0 + uv2[i + 1]! * p.scale
  }
  return out
}

/**
 * The layers a set of lightmaps needs (their long edges): a whole layer for each above half a layer, a quadrant for
 * each other, plus the white quadrant. jangan-fields (490 × 128², 51 × 256², 35 × 64², 1 × 512²): 184.
 */
export function lightmapLayers(sizes: readonly number[], page = LIGHTMAP_PAGE): number {
  let full = 0
  let quads = 1
  for (const s of sizes) {
    if (s > page / 2) full++
    else quads++
  }
  return full + Math.ceil(quads / 4)
}

/**
 * The texels a bilinear tap at UV `u` reads along one axis of a placement, at mip `level` (layer texel indices of
 * that level): the two neighbours of `(u0 + u × scale) × size − 0.5`.
 */
export function bilinearTaps(u: number, origin: number, scale: number, level: number, page = LIGHTMAP_PAGE): [number, number] {
  const size = Math.max(1, page >> level)
  const t = (origin + u * scale) * size - 0.5
  const t0 = Math.floor(t)
  return [t0, t0 + 1]
}

export interface LightmapArrayOptions {
  decoder: CellDecoder
  /** Main-thread jobs (uploads) inside the frame budget; default at once. */
  job?: (run: () => void) => void
  /** Most layers per array (≤ 256; a spill opens a second array). */
  maxLayers?: number
  /** Most arrays (1: a lightmap that finds no room fails instead of spilling). Default: unlimited. */
  maxArrays?: number
  /** Layers of the first GPU allocation (grown as it fills). */
  firstLayers?: number
  jobBytes?: number
  graceS?: number
  now?: () => number
}

/** One user's claim on a lightmap's place. */
export interface LightmapClaim {
  readonly key: string
  /** Resolves with the placement once the lightmap has its place (the merge can remap UV2); rejects on a failure. */
  readonly placed: Promise<LightmapPlacement>
  /** Resolves once its pixels are uploaded. */
  readonly ready: Promise<LightmapPlacement>
  /** The placement once placed (at once when the size was given), else null (not yet, or failed). */
  readonly placement: LightmapPlacement | null
  release(): void
}

/** The lightmap array: lightmaps by URI, in quadrants and whole layers, with the white quadrant pinned. */
export class LightmapArray {
  readonly atlas: AtlasArrays
  private white: CellClaim | null = null

  constructor(scene: Scene, opts: LightmapArrayOptions) {
    this.atlas = new AtlasArrays(scene, {
      name: 'batch:lightmaps',
      page: LIGHTMAP_PAGE,
      levels: LIGHTMAP_LEVELS,
      decoder: opts.decoder,
      job: opts.job,
      maxLayers: Math.min(MAX_ARRAY_LAYERS, opts.maxLayers ?? MAX_ARRAY_LAYERS),
      maxArrays: opts.maxArrays,
      firstLayers: opts.firstLayers ?? 8,
      jobBytes: opts.jobBytes,
      graceS: opts.graceS,
      now: opts.now,
    })
  }

  /** Array `i` (bind at draw time: it is replaced when it grows). Array 0 always has the white quadrant. */
  textureOf(i = 0): BaseTexture {
    this.ensureWhite()
    return this.atlas.textureOf(i)
  }

  /** The shape a lightmap of this long edge takes (null: unknown until decoded). */
  shapeFor(size: number | null): CellShape | null {
    return size && size > 0 ? lightmapShape(size, size, LIGHTMAP_PAGE, LIGHTMAP_LEVELS) : null
  }

  /**
   * The place of the lightmap `key` (its URI): `image` makes its source (the lightmap texture's bytes, or its URL)
   * when it is not resident; `size` its long edge when known (the place is then allocated at once).
   */
  acquire(key: string, size: number | null, image: () => CellImage): LightmapClaim {
    this.ensureWhite()
    const claim = this.atlas.acquire({
      key: `lm|${key}`,
      shape: this.shapeFor(size),
      // A lightmap that fails to decode is drawn white (no bake) rather than leaving its quadrant unwritten.
      job: shape => ({ kind: 'cell-lightmap', shape, page: LIGHTMAP_PAGE, levels: LIGHTMAP_LEVELS, image: image(), fallback: [255, 255, 255, 255] }),
    })
    const placed = claim.placed.then(c => placementOf(c))
    const ready = claim.ready.then(c => placementOf(c))
    placed.catch(() => {})
    ready.catch(() => {})
    return {
      key,
      placed,
      ready,
      get placement() {
        const c = claim.cell
        return c && !claim.failed ? placementOf(c) : null
      },
      release: () => claim.release(),
    }
  }

  /** Evicts lightmaps unused past their grace time. */
  update(now?: number): number {
    return this.atlas.update(now)
  }

  /** Drops every lightmap (the white quadrant comes back on the next use). */
  clear(): void {
    this.white = null
    this.atlas.clear()
  }

  dispose(): void {
    this.white = null
    this.atlas.dispose()
  }

  get stats(): Record<string, number> {
    return {
      lightmaps: Math.max(0, this.atlas.cells - (this.white ? 1 : 0)),
      lightmapLayers: this.atlas.pages,
      lightmapArrays: this.atlas.arrayCount,
      lightmapBytes: this.atlas.bytes,
    }
  }

  /** The white quadrant: the very first cell of array 0, so it lands on layer 0 at (0, 0) (WHITE_LIGHTMAP). */
  private ensureWhite(): void {
    if (this.white) return
    this.white = this.atlas.acquire({
      key: 'lm|white',
      shape: lightmapShape(1, 1, LIGHTMAP_PAGE, LIGHTMAP_LEVELS),
      job: shape => ({ kind: 'cell-lightmap', shape, page: LIGHTMAP_PAGE, levels: LIGHTMAP_LEVELS, image: { kind: 'solid', rgba: [255, 255, 255, 255] } }),
    })
  }
}
