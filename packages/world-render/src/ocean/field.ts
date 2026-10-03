/**
 * The coast field on the client (docs/COAST.md §8.1): `manifest.coast.field` (`coast/field.png`, RGBA8, 4 m per
 * texel, world-aligned) read exactly, kept as a CPU copy (`seaAt`, the samples the shore and the queries use, the CDLOD
 * "water here" pyramid) and re-packed into one RGBA8 texture for the ocean's shaders.
 *
 * The file: R sea mask (255 sea; feathered by one texel); G the distance to the shoreline, 0 … 127.5 m in 0.5 m steps,
 * on the side R says; B on sea texels the bed depth below the sea level, on land texels within 128 m of the shore the
 * height above it, 0 … 51 m in 0.2 m steps; A breaker and foam authoring. PNG column 0 = `x0` (west), row 0 = `z0`
 * (north), +column = +x, +row = +z (manifest.ts `WorldCoast`).
 *
 * **Decoding.** A PNG is inflated and unfiltered here (DecompressionStream), not drawn through a 2D canvas: a canvas
 * stores premultiplied colour, and A = 0 (no authoring, the default) would zero R, G and B. A WebP (out-opt) goes
 * through the world's image decoder; it must be lossless, and an all-zero result is reported (see the file comment
 * of `loadCoastField`).
 *
 * **The GPU texture** (`sroOcFieldMap`, RGBA8, bilinear, clamped: the outermost texels are open sea on sea sides and
 * land on land sides, C16), re-packed so bilinear filtering is meaningful across the shoreline:
 * - R: the sea mask (as the file);
 * - G: the signed shore distance, 128 + 2 d (d in metres, + at sea, − on land; ±63.75 m);
 * - B: the ground's height above the sea level, signed (− at sea = the bed depth, + on land), 128 ± 127 √(|e| / 51 m):
 *   centimetres near the waterline, 0.4 m at 10 m, 51 m at the ends;
 * - A: the retail-water join (§8.1, §8.5): 1 on a retail water block at the sea level (the lake at the bay mouth, the
 *   rivers), falling to 0 over 64 m of sea. There the ocean fades its waves and swash to 0 and takes RND-W's colour, and
 *   it never draws over the retail water itself (no double water layer). Built here from `manifest.regions`' water
 *   blocks, so the converter needs no extra channel.
 */
import { Constants, RawTexture, Texture, Vector4, type Scene } from '@babylonjs/core'
import type { WorldCoast, WorldManifest } from '../../../convert/src/world/manifest.ts'
import { mimeOf, type Assets, type DecodedImage } from '../assets.ts'

/** Metres of signed shore distance per G step, and its range. */
export const FIELD_DIST_STEP_M = 0.5
export const FIELD_DIST_RANGE_M = 63.75
/** The height encoding's end (m) and the join fade (m). */
export const FIELD_HEIGHT_RANGE_M = 51
export const JOIN_FADE_M = 64
/** A retail water block counts as "at the sea level" within this (m). */
export const JOIN_LEVEL_TOLERANCE_M = 0.3
/** The ocean keeps a land fragment (the swash band) within this far inland and this high above the sea level. */
export const SWASH_BAND_M = 40
export const SWASH_HEIGHT_M = 2
/**
 * Land a little below the sea level keeps the water only right at the shore (the filtering across the waterline): the
 * floor is -LOW_LAND_TOLERANCE_M within LOW_LAND_NEAR_M of the shore and rises to 0 by LOW_LAND_FAR_M inland, so a
 * hollow behind a beach (the S1 meadow at +4.74 m) never floods (X2).
 */
export const LOW_LAND_TOLERANCE_M = 0.3
export const LOW_LAND_NEAR_M = 2
export const LOW_LAND_FAR_M = 6

/** The lowest land elevation (m) that keeps the swash band at a signed shore distance (m, − on land). */
export function lowLandFloor(distanceM: number): number {
  return -LOW_LAND_TOLERANCE_M * Math.min(1, Math.max(0, (distanceM + LOW_LAND_FAR_M) / (LOW_LAND_FAR_M - LOW_LAND_NEAR_M)))
}

/** The same floor as shader source (GLSL and WGSL share the expression; `d` is the shore distance expression). */
export function lowLandFloorCode(d: string): string {
  const k = (LOW_LAND_FAR_M - LOW_LAND_NEAR_M).toFixed(1)
  return `(-${LOW_LAND_TOLERANCE_M.toFixed(2)} * clamp((${d} + ${LOW_LAND_FAR_M.toFixed(1)}) / ${k}, 0.0, 1.0))`
}
/** The CDLOD leaf (m) and so the pyramid's finest cell. */
export const LEAF_M = 8

/** A decoded field sample. */
export interface FieldSample {
  /** 0 land … 1 sea (bilinear). */
  sea: number
  /** Distance to the shoreline (m): + at sea, − on land (±127.5). */
  distanceM: number
  /** The ground's height above the sea level (m): − at sea (the bed depth), + on land (±51). */
  elevationM: number
  /** The retail-water join weight 0..1. */
  join: number
}

/** Encodes a signed shore distance (m) as the texture's G byte. */
export function encodeDistance(d: number): number {
  return Math.max(0, Math.min(255, Math.round(128 + d / FIELD_DIST_STEP_M)))
}

/** Decodes the texture's G byte (0..255) to metres. */
export function decodeDistance(g: number): number {
  return (g - 128) * FIELD_DIST_STEP_M
}

/** Encodes a signed elevation (m) as the texture's B byte. */
export function encodeElevation(e: number): number {
  const s = Math.sqrt(Math.min(1, Math.abs(e) / FIELD_HEIGHT_RANGE_M)) * 127
  return Math.max(0, Math.min(255, Math.round(128 + Math.sign(e) * s)))
}

/** Decodes the texture's B byte (0..255, may be fractional after filtering) to metres: the shader's formula. */
export function decodeElevation(b: number): number {
  const s = (b - 128) / 127
  return Math.sign(s) * s * s * FIELD_HEIGHT_RANGE_M
}

/**
 * Whether the ocean draws at a sample (the shaders' discard rule, and the pyramid's): open sea, or the swash band on a
 * beach (land within 40 m of the shore, between the sea level and 2 m above it, away from the retail-water join). Land
 * lower than the sea level (beyond lowLandFloor's few metres at the shore) (the town at −3.26 m, beds, the swamp, the ruins) never gets the sea.
 */
export function drawsWater(s: Readonly<FieldSample>): boolean {
  return s.sea >= 0.5 || (s.join < 0.5 && s.elevationM > lowLandFloor(s.distanceM) && s.elevationM < SWASH_HEIGHT_M && s.distanceM > -SWASH_BAND_M)
}

// ---- PNG ---------------------------------------------------------------------------------------------------------------

/** Inflates zlib data (a PNG's IDAT stream). */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Decodes an 8-bit, non-interlaced PNG (grey, grey + alpha, RGB, RGBA) to RGBA8 exactly: no colour conversion, no
 * premultiplication. Rows in file order.
 */
export async function decodePng(bytes: Uint8Array): Promise<DecodedImage> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0
  const idat: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos)
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!)
    const body = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8)
      height = view.getUint32(pos + 12)
      depth = body[8]!
      colour = body[9]!
      interlace = body[12]!
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour]
  if (depth !== 8 || !channels || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`)
  const total = idat.reduce((n, c) => n + c.length, 0)
  const joined = new Uint8Array(total)
  let o = 0
  for (const c of idat) {
    joined.set(c, o)
    o += c.length
  }
  const raw = await inflate(joined)
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('PNG data too short')
  const cur = new Uint8Array(stride)
  const prev = new Uint8Array(stride)
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0
      const b = prev[i]!
      const c = i >= channels ? prev[i - channels]! : 0
      let v = src[i]!
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4
      const s = x * channels
      if (channels === 4) out.set(cur.subarray(s, s + 4), d)
      else if (channels === 3) {
        out[d] = cur[s]!
        out[d + 1] = cur[s + 1]!
        out[d + 2] = cur[s + 2]!
        out[d + 3] = 255
      } else if (channels === 2) {
        out[d] = out[d + 1] = out[d + 2] = cur[s]!
        out[d + 3] = cur[s + 1]!
      } else {
        out[d] = out[d + 1] = out[d + 2] = cur[s]!
        out[d + 3] = 255
      }
    }
    prev.set(cur)
  }
  return { width, height, data: out as Uint8Array<ArrayBuffer> }
}

// ---- the field -------------------------------------------------------------------------------------------------------

/** The retail water blocks at the sea level: glTF rectangles. */
export function joinBlocks(manifest: WorldManifest, seaLevelM: number): Array<{ x0: number; x1: number; z0: number; z1: number }> {
  const out: Array<{ x0: number; x1: number; z0: number; z1: number }> = []
  for (const r of manifest.regions) {
    for (const b of r.blocks ?? []) {
      const w = b.water
      if (!w || w.kind !== 'water') continue
      if (Math.abs((r.origin[1] ?? 0) + w.heightM - seaLevelM) > JOIN_LEVEL_TOLERANCE_M) continue
      const x0 = r.origin[0] + 32 * b.bx
      const z1 = r.origin[2] - 32 * b.bz
      out.push({ x0, x1: x0 + 32, z0: z1 - 32, z1 })
    }
  }
  return out
}

/** The coast field: the CPU copy, the packed texture's bytes and the CDLOD pyramid. */
export class CoastField {
  /** The packed RGBA8 bytes (the texture's; see the file comment). */
  readonly packed: Uint8Array<ArrayBuffer>
  /** The file's A (authoring), kept for the shore. */
  readonly authoring: Uint8Array
  /** uv = xz × (xy) + (zw) for the shaders. */
  readonly xf: Vector4
  /** "Water drawn here" per LEAF_M cell, level l = cells of LEAF_M · 2^l (OR of the finer level). */
  readonly pyramid: Uint8Array[] = []
  readonly pyramidSize: Array<{ w: number; h: number }> = []
  private textureValue: RawTexture | null = null

  constructor(
    readonly coast: Readonly<WorldCoast>,
    image: DecodedImage,
    joins: ReadonlyArray<{ x0: number; x1: number; z0: number; z1: number }> = [],
    levels = 8,
  ) {
    const f = coast.field
    if (image.width !== f.width || image.height !== f.height) throw new Error(`coast field is ${image.width}×${image.height}, the manifest says ${f.width}×${f.height}`)
    const n = f.width * f.height
    const src = image.data
    this.packed = new Uint8Array(n * 4)
    this.authoring = new Uint8Array(n)
    const mpt = f.metresPerTexel
    this.xf = new Vector4(1 / (f.width * mpt), 1 / (f.height * mpt), -f.x0 / (f.width * mpt), -f.z0 / (f.height * mpt))
    for (let i = 0; i < n; i++) {
      const r = src[i * 4]!, g = src[i * 4 + 1]!, b = src[i * 4 + 2]!
      const sea = r >= 128
      // G 0 off the sea is neither sea nor land: retail water that keeps its own plane (the town's fountain and ponds,
      // the lake, rivers and moat; a land texel is at least one texel from the sea). It reads as far inland, so the
      // swash rule never draws the sea over it (I-10R: a sea-level sheet hung over the plaza on the create screen).
      const d = sea ? g * 0.5 : g === 0 ? -FIELD_DIST_RANGE_M - FIELD_DIST_STEP_M : -g * 0.5
      const e = (sea ? -1 : 1) * b * 0.2
      this.packed[i * 4] = r
      this.packed[i * 4 + 1] = encodeDistance(d)
      this.packed[i * 4 + 2] = encodeElevation(e)
      this.packed[i * 4 + 3] = 0
      this.authoring[i] = src[i * 4 + 3]!
    }
    this.stampJoins(joins)
    this.buildPyramid(levels)
  }

  get width(): number {
    return this.coast.field.width
  }

  get height(): number {
    return this.coast.field.height
  }

  get seaLevelM(): number {
    return this.coast.seaLevelM
  }

  /** Texel coordinates (continuous, texel centres at .5) of glTF (x, z). */
  private texel(x: number, z: number): [number, number] {
    const f = this.coast.field
    return [(x - f.x0) / f.metresPerTexel, (z - f.z0) / f.metresPerTexel]
  }

  /** True where (x, z) is open sea (nearest texel, clamped: C16). */
  seaAt(x: number, z: number): boolean {
    const [u, v] = this.texel(x, z)
    const i = Math.min(this.width - 1, Math.max(0, Math.floor(u)))
    const j = Math.min(this.height - 1, Math.max(0, Math.floor(v)))
    return this.packed[(j * this.width + i) * 4]! >= 128
  }

  /** The decoded field at (x, z), bilinear on the packed bytes (the shaders' sample). */
  sample(x: number, z: number, out: FieldSample = { sea: 0, distanceM: 0, elevationM: 0, join: 0 }): FieldSample {
    const [u, v] = this.texel(x, z)
    const fx = u - 0.5, fz = v - 0.5
    const i0 = Math.floor(fx), j0 = Math.floor(fz)
    const tx = fx - i0, tz = fz - j0
    const w = this.width, h = this.height
    const at = (i: number, j: number, c: number) => this.packed[((Math.min(h - 1, Math.max(0, j)) * w) + Math.min(w - 1, Math.max(0, i))) * 4 + c]!
    const lerp = (c: number) => {
      const a = at(i0, j0, c) + (at(i0 + 1, j0, c) - at(i0, j0, c)) * tx
      const b = at(i0, j0 + 1, c) + (at(i0 + 1, j0 + 1, c) - at(i0, j0 + 1, c)) * tx
      return a + (b - a) * tz
    }
    out.sea = lerp(0) / 255
    out.distanceM = decodeDistance(lerp(1))
    out.elevationM = decodeElevation(lerp(2))
    out.join = lerp(3) / 255
    return out
  }

  /** Whether the ocean draws anything in the square node [x, x + size) × [z, z + size) at CDLOD level `lod`. */
  nodeHasWater(x: number, z: number, size: number): boolean {
    const f = this.coast.field
    const cell = LEAF_M
    // The finest pyramid level whose cell is no larger than the node.
    let l = Math.max(0, Math.min(this.pyramid.length - 1, Math.floor(Math.log2(size / cell + 1e-9))))
    const cs = cell * 2 ** l
    const { w, h } = this.pyramidSize[l]!
    const bits = this.pyramid[l]!
    const i0 = Math.floor((x - f.x0) / cs), i1 = Math.ceil((x + size - f.x0) / cs) - 1
    const j0 = Math.floor((z - f.z0) / cs), j1 = Math.ceil((z + size - f.z0) / cs) - 1
    // Clamped: beyond the field the edge cells repeat (open sea on sea sides).
    const ci0 = Math.min(w - 1, Math.max(0, i0)), ci1 = Math.min(w - 1, Math.max(0, i1))
    const cj0 = Math.min(h - 1, Math.max(0, j0)), cj1 = Math.min(h - 1, Math.max(0, j1))
    for (let j = cj0; j <= cj1; j++) for (let i = ci0; i <= ci1; i++) if (bits[j * w + i]) return true
    return false
  }

  /** The shaders' texture (made once; bilinear, clamped, no mips). */
  texture(scene: Scene): RawTexture {
    if (this.textureValue && this.textureValue.getScene() === scene) return this.textureValue
    const t = new RawTexture(this.packed, this.width, this.height, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
    t.name = 'sroOcFieldMap'
    t.wrapU = Texture.CLAMP_ADDRESSMODE
    t.wrapV = Texture.CLAMP_ADDRESSMODE
    this.textureValue = t
    return t
  }

  dispose(): void {
    this.textureValue?.dispose()
    this.textureValue = null
  }

  /** A: the join weight from the retail water blocks at the sea level (1 on the block, 0 at 64 m of sea). */
  private stampJoins(joins: ReadonlyArray<{ x0: number; x1: number; z0: number; z1: number }>): void {
    const f = this.coast.field
    const mpt = f.metresPerTexel
    const w = this.width, h = this.height
    for (const b of joins) {
      const i0 = Math.max(0, Math.floor((b.x0 - JOIN_FADE_M - f.x0) / mpt)), i1 = Math.min(w - 1, Math.ceil((b.x1 + JOIN_FADE_M - f.x0) / mpt))
      const j0 = Math.max(0, Math.floor((b.z0 - JOIN_FADE_M - f.z0) / mpt)), j1 = Math.min(h - 1, Math.ceil((b.z1 + JOIN_FADE_M - f.z0) / mpt))
      for (let j = j0; j <= j1; j++) {
        const cz = f.z0 + (j + 0.5) * mpt
        const dz = Math.max(0, b.z0 - cz, cz - b.z1)
        for (let i = i0; i <= i1; i++) {
          const cx = f.x0 + (i + 0.5) * mpt
          const d = Math.hypot(Math.max(0, b.x0 - cx, cx - b.x1), dz)
          if (d >= JOIN_FADE_M) continue
          const o = (j * w + i) * 4 + 3
          const t = d / JOIN_FADE_M
          const v = Math.round(255 * (1 - t * t * (3 - 2 * t)))
          if (v > this.packed[o]!) this.packed[o] = v
        }
      }
    }
  }

  /** The "water drawn here" pyramid (per LEAF_M cell, with one texel of margin for the bilinear edge and the waves). */
  private buildPyramid(levels: number): void {
    const f = this.coast.field
    const w = this.width, h = this.height
    const draws = new Uint8Array(w * h)
    const s: FieldSample = { sea: 0, distanceM: 0, elevationM: 0, join: 0 }
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = (j * w + i) * 4
        s.sea = this.packed[o]! / 255
        s.distanceM = decodeDistance(this.packed[o + 1]!)
        s.elevationM = decodeElevation(this.packed[o + 2]!)
        s.join = this.packed[o + 3]! / 255
        draws[j * w + i] = drawsWater(s) ? 1 : 0
      }
    }
    const perCell = LEAF_M / f.metresPerTexel
    let cw = Math.ceil(w / perCell), ch = Math.ceil(h / perCell)
    let level = new Uint8Array(cw * ch)
    for (let cj = 0; cj < ch; cj++) {
      for (let ci = 0; ci < cw; ci++) {
        let any = 0
        const ti0 = Math.max(0, Math.floor(ci * perCell) - 1), ti1 = Math.min(w - 1, Math.ceil((ci + 1) * perCell))
        const tj0 = Math.max(0, Math.floor(cj * perCell) - 1), tj1 = Math.min(h - 1, Math.ceil((cj + 1) * perCell))
        for (let tj = tj0; tj <= tj1 && !any; tj++) for (let ti = ti0; ti <= ti1; ti++) if (draws[tj * w + ti]) {
          any = 1
          break
        }
        level[cj * cw + ci] = any
      }
    }
    this.pyramid.push(level)
    this.pyramidSize.push({ w: cw, h: ch })
    for (let l = 1; l < levels; l++) {
      const nw = Math.ceil(cw / 2), nh = Math.ceil(ch / 2)
      const next = new Uint8Array(nw * nh)
      for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (level[j * cw + i]) next[(j >> 1) * nw + (i >> 1)] = 1
      this.pyramid.push(next)
      this.pyramidSize.push({ w: nw, h: nh })
      level = next
      cw = nw
      ch = nh
    }
  }
}

/**
 * Loads `manifest.coast`'s field (null: no coast). A `.png` is decoded exactly here; a `.webp` (out-opt) through the
 * world's decoder, which only works if the optimiser kept it lossless and the decoder does not premultiply (A = 0
 * would zero the other channels): an all-zero result throws, so the ocean reports it instead of silently drawing no sea.
 */
export async function loadCoastField(manifest: WorldManifest, assets: Assets, levels = 8): Promise<CoastField | null> {
  const coast = manifest.coast
  if (!coast) return null
  const file = coast.field.file
  const image = mimeOf(file) === 'image/png' ? await decodePng(await assets.bytesOf(file)) : await assets.image(file)
  let any = false
  for (let i = 0; i < image.data.length && !any; i += 4) any = image.data[i]! !== 0 || image.data[i + 1]! !== 0 || image.data[i + 2]! !== 0
  if (!any) throw new Error(`${file}: decoded empty (a lossy or premultiplied decode of the data texture?)`)
  return new CoastField(coast, image, joinBlocks(manifest, coast.seaLevelM), levels)
}
