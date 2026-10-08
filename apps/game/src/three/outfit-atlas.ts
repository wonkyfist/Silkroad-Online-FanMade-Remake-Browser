/**
 * The outfit atlas (docs/CHARACTERS.md §3.3, P0 "one draw per far character"): the pure part. A far character's
 * skinned parts (body, hair, every worn armour piece) are drawn as ONE mesh with ONE material whose albedo is an atlas
 * of the parts' own textures. This file packs the parts' textures into the atlas and maps their UVs into it; the GPU
 * copy and the merged mesh are three/outfit-merge.ts.
 *
 * - Every part keeps its texture's aspect; all parts are scaled by one power-of-two factor (1, 1/2, 1/4, ...) so the
 *   set fits the atlas (a far character is at most ≈ 150 px tall: a 512² atlas is ≈ 3 texels per pixel).
 * - Rects are packed on shelves (tallest first) with PAD texels around each one; the copy repeats the edge texels into
 *   the padding, so the mip levels the far character is drawn with do not bleed the neighbour's colours in.
 * - UVs are mapped into the rect's inner area. A part whose UVs leave [0, 1] (a tiling texture) cannot live in an
 *   atlas: `uvFits` says so and the part stays out of the merge.
 */

/**
 * The size a texture counts as when packed (§16.9: a licensed outfit's 256² colour bake stands for the 2048² clothes map
 * and says so in `metadata.sroAtlasSize`, so it gets the share of the atlas the other parts' maps get).
 */
export function atlasSizeOf(t: { getSize(): { width: number; height: number }; metadata?: unknown }): { w: number; h: number } {
  const n = (t.metadata as { sroAtlasSize?: number } | null | undefined)?.sroAtlasSize
  if (typeof n === 'number' && n > 0) return { w: n, h: n }
  const s = t.getSize()
  return { w: s.width, h: s.height }
}

/** Texels of padding around each rect. */
export const ATLAS_PAD = 4
/** UVs this far outside [0, 1] still count as inside (glTF exporters write 1.0004 and −0.0002). */
export const UV_SLACK = 0.002

export interface AtlasInput {
  /** The part texture's size in texels. */
  w: number
  h: number
}

export interface AtlasRect {
  /** The inner rect (where the texture lands) in atlas texels, top-left origin (UV space: v down, as glTF). */
  x: number
  y: number
  w: number
  h: number
}

export interface AtlasPlan {
  size: number
  /** The power-of-two factor every part was scaled by (1, 0.5, ...). */
  scale: number
  rects: AtlasRect[]
}

/**
 * Packs `inputs` into a `size`² atlas at the largest power-of-two scale (≤ 1, ≥ `minScale`) at which every rect fits;
 * null when they do not fit even at `minScale`. `rects[i]` is for `inputs[i]`.
 */
export function packAtlas(inputs: readonly AtlasInput[], size = 512, minScale = 1 / 16): AtlasPlan | null {
  if (!inputs.length) return null
  for (let scale = 1; scale >= minScale; scale /= 2) {
    const rects = shelfPack(inputs, size, scale)
    if (rects) return { size, scale, rects }
  }
  return null
}

function shelfPack(inputs: readonly AtlasInput[], size: number, scale: number): AtlasRect[] | null {
  const dims = inputs.map(i => ({ w: Math.max(1, Math.round(i.w * scale)), h: Math.max(1, Math.round(i.h * scale)) }))
  const order = dims.map((_, i) => i).sort((a, b) => dims[b]!.h - dims[a]!.h || dims[b]!.w - dims[a]!.w || a - b)
  const out: AtlasRect[] = new Array(inputs.length)
  let x = 0
  let y = 0
  let shelf = 0
  for (const i of order) {
    const d = dims[i]!
    const w = d.w + 2 * ATLAS_PAD
    const h = d.h + 2 * ATLAS_PAD
    if (w > size || h > size) return null
    if (x + w > size) {
      y += shelf
      x = 0
      shelf = 0
    }
    if (y + h > size) return null
    out[i] = { x: x + ATLAS_PAD, y: y + ATLAS_PAD, w: d.w, h: d.h }
    x += w
    shelf = Math.max(shelf, h)
  }
  return out
}

/** True when every UV pair lies in [0, 1] (± UV_SLACK): the part can be drawn from an atlas rect. */
export function uvFits(uv: ArrayLike<number>): boolean {
  for (let i = 0; i < uv.length; i++) {
    const v = uv[i]!
    if (!(v >= -UV_SLACK && v <= 1 + UV_SLACK)) return false
  }
  return true
}

/** `uv` (u, v pairs in the part's own [0, 1] space) mapped into `rect` of a `size`² atlas, into `out` (or a new array). */
export function remapUV(uv: ArrayLike<number>, rect: AtlasRect, size: number, out = new Float32Array(uv.length)): Float32Array {
  const su = rect.w / size
  const sv = rect.h / size
  const ou = rect.x / size
  const ov = rect.y / size
  for (let i = 0; i + 1 < uv.length; i += 2) {
    const u = Math.min(1, Math.max(0, uv[i]!))
    const v = Math.min(1, Math.max(0, uv[i + 1]!))
    out[i] = ou + u * su
    out[i + 1] = ov + v * sv
  }
  return out
}

/**
 * The key an atlas is shared by: the parts' texture ids in draw order plus whether each is cut out (alpha kept) or
 * opaque (alpha forced to 1). Two characters with the same body, hair and worn pieces share one atlas and material.
 */
export function atlasKey(parts: readonly { texture: number | string; cutout: boolean }[]): string {
  return parts.map(p => `${p.texture}${p.cutout ? 'c' : 'o'}`).join('|')
}
