/**
 * The pure core of the texture decode worker (lane TX-R; docs/WAVE_PLAN3.md §7.1, D37, D42; docs/TEXPIPE.md §6.3):
 * everything between "an image's RGBA8 pixels" and "the levels a texture upload takes", shared by the worker
 * (decode-worker.ts, off the main thread) and the main-thread fallback (pbr/maps.ts, when no worker can run), and
 * tested in Node. No DOM, no Babylon.
 *
 * - `downsample`: the box filter every mip level is made with (odd edges clamp). textures.ts re-exports it, so the
 *   worker's mips are the CPU chain the WebGPU array path always built, byte for byte.
 * - `mipChain`: the full chain. Opaque textures: plain `downsample`. Cutout textures (alpha test): the colour of a
 *   2×2 block with transparent texels is weighted by alpha (transparent texels do not darken it), and each level's
 *   alpha is scaled so the share of texels passing the alpha test stays the level-0 share ("coverage-preserving mips",
 *   the index does not carry the scales: they are computed here). Blend textures: the alpha-weighted colour only.
 * - `fillTransparent`: the colour under fully transparent texels comes from the next coarser level (push-pull), so a
 *   bilinear tap at a cutout edge never pulls in black (a 2D canvas zeroes the colour under alpha 0 on read-back).
 * - The v1 plane packing (D37): the normal planes to one RGBA8 normal map (z rebuilt), the grey planes to ORMH
 *   (R AO, G roughness, B metallic, A height).
 * - `runMapJob`: one decode job end to end over an injected image decoder (the worker's fetch + createImageBitmap, or
 *   the world's Assets decoder on the main thread).
 * - BT-A (docs/BATCHING.md §3.2, docs/WAVE_PLAN6.md D5): the batch atlas's cell job (`runCellJob`): the cell shapes
 *   (rectangular pow2 cells with a wrap gutter, the NRAO cell's aspect, the lightmap quadrants), the resample into a
 *   cell and its mips, the cut-out mask and the NRAO packing. `runDecodeJob` runs either kind.
 */

/** An RGBA8 image or mip level, rows in file order (row 0 = the image's top row). */
export interface Level {
  width: number
  height: number
  data: Uint8Array<ArrayBuffer>
}

/** How a texture's alpha is used (the pbr set's `alpha`, or the material's transparency mode). */
export type AlphaUse = 'none' | 'cutout' | 'blend'

/** Halves an RGBA8 image (box filter; odd edges clamp). */
export function downsample(src: Uint8Array, w: number, h: number): { data: Uint8Array<ArrayBuffer>; w: number; h: number } {
  const nw = Math.max(1, w >> 1)
  const nh = Math.max(1, h >> 1)
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(2 * y, h - 1)
    const y1 = Math.min(2 * y + 1, h - 1)
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(2 * x, w - 1)
      const x1 = Math.min(2 * x + 1, w - 1)
      const a = (y0 * w + x0) * 4
      const b = (y0 * w + x1) * 4
      const c = (y1 * w + x0) * 4
      const d = (y1 * w + x1) * 4
      const o = (y * nw + x) * 4
      for (let k = 0; k < 4; k++) out[o + k] = (src[a + k]! + src[b + k]! + src[c + k]! + src[d + k]! + 2) >> 2
    }
  }
  return { data: out, w: nw, h: nh }
}

/** Levels of a full chain for w × h (w, w / 2, …, 1 on the long edge). */
export function levelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1
}

/** Bytes of a full RGBA8 chain from w × h (the resident size of a mipmapped RGBA8 texture). */
export function chainBytes(width: number, height: number): number {
  let total = 0
  let w = width
  let h = height
  for (let i = levelCount(width, height); i > 0; i--) {
    total += w * h * 4
    w = Math.max(1, w >> 1)
    h = Math.max(1, h >> 1)
  }
  return total
}

/** The byte alpha a texel needs to pass an alpha test at `cutoff` (Babylon discards alpha < cutoff). */
export function alphaThreshold(cutoff: number): number {
  return Math.min(255, Math.max(1, Math.ceil(cutoff * 255 - 1e-6)))
}

/** Share of texels whose alpha passes the test at `cutoff` (0..1). */
export function coverage(level: Level, cutoff: number): number {
  const thr = alphaThreshold(cutoff)
  const d = level.data
  const n = level.width * level.height
  if (!n) return 0
  let pass = 0
  for (let i = 3; i < n * 4; i += 4) if (d[i]! >= thr) pass++
  return pass / n
}

/**
 * Scales a level's alpha in place so `target` of its texels pass the test at `cutoff` (Castaño's coverage-preserving
 * alpha, solved on a histogram): the scale maps the alpha of the k-th most opaque texel (k = target × texels) onto the
 * threshold. Returns the scale (1 when nothing needs to change).
 */
export function scaleAlphaToCoverage(level: Level, cutoff: number, target: number): number {
  const n = level.width * level.height
  const k = Math.round(target * n)
  if (n === 0 || k <= 0 || k >= n) return 1
  const d = level.data
  const hist = new Uint32Array(256)
  for (let i = 3; i < n * 4; i += 4) hist[d[i]!]!++
  // The k-th most opaque alpha; texels sharing it pass or fail together, so take it or the next higher value present,
  // whichever count lands nearer k (a mip of binary alpha has few distinct values).
  let seen = 0
  let ak = 0
  let prev = -1
  for (let a = 255; a >= 0; a--) {
    const h = hist[a]!
    if (!h) continue
    if (seen + h >= k) {
      // Taking `a` passes seen + h texels, taking the value above passes `seen`.
      ak = prev > 0 && k - seen < seen + h - k ? prev : a
      break
    }
    seen += h
    prev = a
  }
  if (ak <= 0) return 1
  const thr = alphaThreshold(cutoff)
  const s = thr / ak
  if (Math.abs(s - 1) < 1e-3) return 1
  for (let i = 3; i < n * 4; i += 4) d[i] = Math.min(255, Math.round(d[i]! * s))
  return s
}

/**
 * The next level of a texture whose alpha matters: colour averaged with the alpha as weight wherever a block has a
 * texel below 255 (a fully opaque block is the plain box filter, so opaque regions equal `downsample`), alpha the box
 * average. A block with no alpha at all keeps the plain average colour (fillTransparent replaces it later).
 */
export function downsampleWeighted(src: Uint8Array, w: number, h: number): { data: Uint8Array<ArrayBuffer>; w: number; h: number } {
  const nw = Math.max(1, w >> 1)
  const nh = Math.max(1, h >> 1)
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(2 * y, h - 1)
    const y1 = Math.min(2 * y + 1, h - 1)
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(2 * x, w - 1)
      const x1 = Math.min(2 * x + 1, w - 1)
      const a = (y0 * w + x0) * 4
      const b = (y0 * w + x1) * 4
      const c = (y1 * w + x0) * 4
      const d = (y1 * w + x1) * 4
      const o = (y * nw + x) * 4
      const aa = src[a + 3]!
      const ab = src[b + 3]!
      const ac = src[c + 3]!
      const ad = src[d + 3]!
      const sum = aa + ab + ac + ad
      out[o + 3] = (sum + 2) >> 2
      if (sum === 1020 || sum === 0) {
        for (let k = 0; k < 3; k++) out[o + k] = (src[a + k]! + src[b + k]! + src[c + k]! + src[d + k]! + 2) >> 2
      } else {
        for (let k = 0; k < 3; k++) {
          out[o + k] = Math.min(255, Math.round((src[a + k]! * aa + src[b + k]! * ab + src[c + k]! * ac + src[d + k]! * ad) / sum))
        }
      }
    }
  }
  return { data: out, w: nw, h: nh }
}

/**
 * The colour under fully transparent texels, from the next coarser level (coarsest first, so every parent is already
 * meaningful): a bilinear tap across a cutout edge then blends towards the texture's own colours, never towards the
 * black a canvas read-back leaves there. Only texels with alpha 0 change; levels[i + 1] must be the half of levels[i].
 */
export function fillTransparent(levels: readonly Level[]): void {
  for (let i = levels.length - 2; i >= 0; i--) {
    const l = levels[i]!
    const p = levels[i + 1]!
    const d = l.data
    const pd = p.data
    for (let y = 0; y < l.height; y++) {
      const py = Math.min(p.height - 1, y >> 1)
      for (let x = 0; x < l.width; x++) {
        const o = (y * l.width + x) * 4
        if (d[o + 3] !== 0) continue
        const q = (py * p.width + Math.min(p.width - 1, x >> 1)) * 4
        d[o] = pd[q]!
        d[o + 1] = pd[q + 1]!
        d[o + 2] = pd[q + 2]!
      }
    }
  }
}

export interface MipOptions {
  /** How the alpha is used (default 'none': the plain box chain). */
  alpha?: AlphaUse
  /** Alpha-test cutoff (0..1) for 'cutout' (default 0.5, the glTF MASK default). */
  cutoff?: number
  /** BT-A: at most this many levels (an atlas cell's chain stops at the page array's last level; default: all). */
  count?: number
}

/**
 * The full mip chain of an RGBA8 image, level 0 first (level 0 is `img` itself, possibly with its transparent colour
 * filled). 'none': `downsample` repeatedly (equal to textures.ts' CPU chain). 'cutout': alpha-weighted colour, alpha
 * scaled per level to keep the level-0 coverage at `cutoff`, colour under alpha 0 filled. 'blend': alpha-weighted
 * colour, filled.
 */
export function mipChain(img: Level, opts: MipOptions = {}): Level[] {
  const alpha = opts.alpha ?? 'none'
  const out: Level[] = [img]
  const n = Math.min(levelCount(img.width, img.height), Math.max(1, opts.count ?? Infinity))
  if (alpha === 'none') {
    let cur = img
    for (let i = 1; i < n; i++) {
      const next = downsample(cur.data, cur.width, cur.height)
      cur = { data: next.data, width: next.w, height: next.h }
      out.push(cur)
    }
    return out
  }
  const cutoff = opts.cutoff ?? 0.5
  const target = alpha === 'cutout' ? coverage(img, cutoff) : 0
  // The raw (unscaled) chain feeds the next level; the scale is applied to a copy, so errors never accumulate.
  let raw = img
  for (let i = 1; i < n; i++) {
    const next = downsampleWeighted(raw.data, raw.width, raw.height)
    raw = { data: next.data, width: next.w, height: next.h }
    const level = alpha === 'cutout' ? { ...raw, data: raw.data.slice() } : raw
    if (alpha === 'cutout') scaleAlphaToCoverage(level, cutoff, target)
    out.push(level)
  }
  fillTransparent(out)
  return out
}

/** Nearest-neighbour resample of an RGBA8 image (a half-size v1 plane onto a common size). */
export function resampleNearest(img: Level, width: number, height: number): Uint8Array<ArrayBuffer> {
  if (img.width === width && img.height === height) return img.data
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width))
      const s = (sy * img.width + sx) * 4
      const d = (y * width + x) * 4
      out[d] = img.data[s]!
      out[d + 1] = img.data[s + 1]!
      out[d + 2] = img.data[s + 2]!
      out[d + 3] = img.data[s + 3]!
    }
  }
  return out
}

/** v1 normal planes (R of each, 128 = 0) → one RGBA8 tangent-space normal map (z rebuilt, alpha 255). */
export function packNormalPlanes(nx: Level, ny: Level): Level {
  const { width, height } = nx
  const ys = resampleNearest(ny, width, height)
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const x = (nx.data[i * 4]! - 128) / 127
    const y = (ys[i * 4]! - 128) / 127
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
    out[i * 4] = nx.data[i * 4]!
    out[i * 4 + 1] = ys[i * 4]!
    out[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(128 + 127 * z)))
    out[i * 4 + 3] = 255
  }
  return { width, height, data: out }
}

/** ORMH defaults for planes a set does not have (AO 1, the class roughness and metallic, height 0.5). */
export interface OrmhDefaults {
  roughness: number
  metallic: number
}

/**
 * Separate greyscale planes (R of each) → one ORMH RGBA8 (D37: R AO, G roughness, B metallic, A height) at the size of
 * the first plane given in AO, rough, metal, height order (or `size`). A missing plane takes the default.
 */
export function packOrmhPlanes(
  planes: { ao?: Level | null; rough?: Level | null; metal?: Level | null; height?: Level | null },
  defaults: OrmhDefaults,
  size?: { width: number; height: number },
): Level {
  const first = planes.ao ?? planes.rough ?? planes.metal ?? planes.height
  if (!first) throw new Error('no plane to pack')
  const width = size?.width ?? first.width
  const height = size?.height ?? first.height
  const at = (p: Level | null | undefined) => (p ? resampleNearest(p, width, height) : null)
  const ao = at(planes.ao)
  const rough = at(planes.rough)
  const metal = at(planes.metal)
  const h = at(planes.height)
  const r0 = Math.round(defaults.roughness * 255)
  const m0 = Math.round(defaults.metallic * 255)
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = ao ? ao[i * 4]! : 255
    out[i * 4 + 1] = rough ? rough[i * 4]! : r0
    out[i * 4 + 2] = metal ? metal[i * 4]! : m0
    out[i * 4 + 3] = h ? h[i * 4]! : 128
  }
  return { width, height, data: out }
}

// ---- jobs ------------------------------------------------------------------------------------------------------

/**
 * One decode job (absolute URLs). `size`: decode at this square size (tile layers; the decoder resizes). `levels`:
 * compute the full chain (texture-array layers always; 2D cutout albedo always), else level 0 only (the GPU makes
 * the mips of a plain 2D texture).
 */
export type MapJob =
  | { kind: 'image'; url: string; alpha?: AlphaUse; cutoff?: number; size?: number; levels?: boolean }
  | { kind: 'normal'; nx: string; ny: string; size?: number; levels?: boolean }
  | { kind: 'ormh'; ao?: string; rough?: string; metal?: string; height?: string; defaults: OrmhDefaults; size?: number; levels?: boolean }

export interface MapResult {
  width: number
  height: number
  /** Level 0 first; one entry unless the job asked for levels (or the albedo is a cutout). */
  levels: Level[]
}

/** Decodes one image to RGBA8 (no colour conversion, no premultiplication), optionally at size × size. */
export type ImageDecoder = (url: string, size?: number) => Promise<Level>

/** Runs a job with `decode` for the images (the worker and the main-thread fallback both call this). */
export async function runMapJob(job: MapJob, decode: ImageDecoder): Promise<MapResult> {
  let img: Level
  let alpha: AlphaUse = 'none'
  let cutoff = 0.5
  if (job.kind === 'image') {
    img = await decode(job.url, job.size)
    alpha = job.alpha ?? 'none'
    cutoff = job.cutoff ?? 0.5
  } else if (job.kind === 'normal') {
    const [nx, ny] = await Promise.all([decode(job.nx, job.size), decode(job.ny, job.size)])
    img = packNormalPlanes(nx, ny)
  } else {
    const get = (u: string | undefined) => (u ? decode(u, job.size) : Promise.resolve(null))
    const [ao, rough, metal, height] = await Promise.all([get(job.ao), get(job.rough), get(job.metal), get(job.height)])
    img = packOrmhPlanes({ ao, rough, metal, height }, job.defaults, job.size ? { width: job.size, height: job.size } : undefined)
  }
  if (alpha === 'cutout' || job.levels) {
    const levels = mipChain(img, { alpha, cutoff })
    return { width: img.width, height: img.height, levels }
  }
  if (alpha === 'blend') {
    // Level 0 only (the GPU makes the mips), with the colour under alpha 0 filled from an alpha-weighted chain.
    const levels = mipChain(img, { alpha })
    return { width: img.width, height: img.height, levels: [levels[0]!] }
  }
  return { width: img.width, height: img.height, levels: [img] }
}

/** The buffers of a result (a map's or a cell's), for a worker's transfer list. */
export function transferables(r: { levels: readonly Level[] }): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>()
  for (const l of r.levels) seen.add(l.data.buffer)
  return [...seen]
}

// ---- batch cells (lane BT-A; docs/BATCHING.md §3.2, F6, F7, F15; docs/WAVE_PLAN6.md D5) -----------------------------

/** The smallest atlas cell side (texels): at the page array's last level a cell is still one texel. */
export const CELL_MIN = 32

/**
 * One atlas cell (BATCHING §3.2): a rectangular pow2 block of `width` × `height` texels, gutters included. Its inner
 * area, (width − 2 gutterX) × (height − 2 gutterY), holds the texture; the gutters hold the texture's own wrapped
 * continuation, so REPEAT UVs work through `fract()` and bilinear taps at the inner edge see the right neighbours.
 * `levels`: the mip levels written (the array's chain). A lightmap cell has no gutter (its UVs keep a margin, F7).
 */
export interface CellShape {
  width: number
  height: number
  gutterX: number
  gutterY: number
  levels: number
}

function nextPow2(v: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, v)))
}

/** The wrap gutter of a cell side: `max(2, side / 64)` texels (F15: 3.1 % of a side ≥ 128). */
export function gutterOf(side: number): number {
  return Math.max(2, side / 64)
}

/**
 * The highest mip level a cell's wrap gutter covers (the gutter there is >= 0.5 texel: a bilinear tap at the inner
 * edge never reads the neighbouring cell): log2(2 × gutter) of the smaller side, i.e. 2 below 128², log2(side) − 5
 * from 128² on. The table shader clamps its gradients to it (surface-plugin.ts sroGradK, from the inner uv scale).
 */
export function atlasMaxLod(shape: Pick<CellShape, 'width' | 'height'>): number {
  return Math.log2(2 * gutterOf(Math.min(shape.width, shape.height)))
}

/**
 * The cell of a w × h texture on `page`² pages (BATCHING §3.2, §3.13, Q5): each side rounded up to a power of two;
 * a side of ≤ 64 texels kept at 2× (so no small texture loses resolution to its gutter); at least CELL_MIN; a texture
 * larger than the page halved until it fits (1024 × 2048 → 512 × 1024).
 */
export function cellShape(w: number, h: number, page: number, levels: number): CellShape {
  const side = (s: number) => Math.max(CELL_MIN, nextPow2(s) * (s <= 64 ? 2 : 1))
  let cw = Math.min(side(w), page * 64)
  let ch = Math.min(side(h), page * 64)
  while (cw > page || ch > page) {
    cw = Math.max(CELL_MIN, cw / 2)
    ch = Math.max(CELL_MIN, ch / 2)
  }
  return { width: cw, height: ch, gutterX: gutterOf(cw), gutterY: gutterOf(ch), levels }
}

/**
 * The NRAO cell of a slot (BATCHING §3.2 texel 1: its v scale follows the albedo's aspect, so the shader derives it
 * as `u scale × albedo v / albedo u`). The cell keeps the albedo cell's aspect and inner-area ratio exactly: with both
 * sides ≥ 128 the gutters are proportional (side / 64) and any power-of-two scale keeps the ratio, so the cell is
 * scaled towards the maps' long edge (`w`, `h`); a smaller albedo cell is copied as it is.
 */
export function nraoShape(albedo: CellShape, w: number, h: number, page: number): CellShape {
  if (albedo.width < 128 || albedo.height < 128) return { ...albedo }
  const want = Math.max(128, Math.min(page, nextPow2(Math.max(w, h, 1))))
  let s = want / Math.max(albedo.width, albedo.height)
  let cw = albedo.width * s
  let ch = albedo.height * s
  while ((cw < 128 || ch < 128) && Math.max(cw, ch) < page) {
    s *= 2
    cw = albedo.width * s
    ch = albedo.height * s
  }
  if (cw < 128 || ch < 128 || cw > page || ch > page) return { ...albedo }
  return { width: cw, height: ch, gutterX: gutterOf(cw), gutterY: gutterOf(ch), levels: albedo.levels }
}

/**
 * A lightmap's cell in the 256²-layer lightmap array (BATCHING §3.2, F7): a lightmap of more than half a layer takes a
 * whole layer (a 512² one box-reduced to 256²), a 128² or 64² one a quadrant (the 64² ones upsampled). No gutter.
 */
export function lightmapShape(w: number, h: number, layer: number, levels: number): CellShape {
  const s = Math.max(w, h) > layer / 2 ? layer : layer / 2
  return { width: s, height: s, gutterX: 0, gutterY: 0, levels }
}

/** A texture a cell job reads (each kind decodes in the worker and on the main-thread fallback). */
export type CellImage =
  /** An encoded image (a glb's embedded retail texture, copied out of the glb). */
  | { kind: 'bytes'; bytes: Uint8Array<ArrayBuffer> }
  /** An image file (a lightmap); absolute in the worker. */
  | { kind: 'url'; url: string }
  /** A TX-R map job (a map set's albedo, normal or ORMH): level 0 of its result. */
  | { kind: 'map'; job: MapJob }
  /** Decoded already (tests; the main thread). */
  | { kind: 'pixels'; level: Level }
  /** One colour (a material without a texture). */
  | { kind: 'solid'; rgba: readonly [number, number, number, number] }

/**
 * An atlas cell to build (BT-A): decode the sources, resample into the cell (wrap addressing, the gutter filled with
 * the texture's own continuation), and compute the cell's mips. `shape` null: the worker picks it from the decoded
 * size (`cellShape` on `page`² pages, `lightmapShape` on `page`² layers; `levels` levels).
 * - albedo: RGB + the cut-out alpha, from the albedo's alpha or from `mask` (TX-R's retail mask when a map set's albedo
 *   has no alpha, BATCHING §4.5 finding 4): its alpha, or its luminance (`maskFromRgb`). Opaque cells get alpha 255.
 *   Cutouts get coverage-preserving mips at `cutoff`, and the colour under transparent texels filled (no black
 *   fringe from a canvas read-back).
 * - nrao: normal x, y (the material's X/Y inversion baked), roughness from ORM.G (else `roughness`), AO from ORM.R
 *   when `aoFromRed` (else 1).
 * - lightmap: RGB, clamped, alpha 255.
 */
export type CellJob =
  | {
    kind: 'cell-albedo'
    shape: CellShape | null
    page: number
    levels: number
    image: CellImage
    mask?: CellImage | null
    maskFromRgb?: boolean
    alpha: AlphaUse
    cutoff?: number
    /** A colour to fill the cell with when a source fails to decode (the cell then never fails; `fallback` is set). */
    fallback?: readonly [number, number, number, number]
  }
  | {
    kind: 'cell-nrao'
    shape: CellShape
    normal?: CellImage | null
    orm?: CellImage | null
    invertX?: boolean
    invertY?: boolean
    aoFromRed?: boolean
    /** The table roughness (0..1) written where there is no ORM. */
    roughness: number
    /** A failed source counts as absent (a flat normal, the table roughness) instead of failing the cell. */
    tolerant?: boolean
  }
  | {
    kind: 'cell-lightmap'
    shape: CellShape | null
    page: number
    levels: number
    image: CellImage
    fallback?: readonly [number, number, number, number]
  }

export interface CellResult {
  shape: CellShape
  /** The cell's levels, level 0 first (`shape.levels` of them, each the half of the previous). */
  levels: Level[]
  /** The main source as decoded (the albedo; an NRAO cell's ORM, else its normal; the lightmap). */
  source: { width: number; height: number }
  /** Mean RGBA (0..255) of the main source: an NRAO cell's is its ORM's (B = the metal the table keeps, F23). */
  mean: [number, number, number, number]
  /** A source failed and the job's fallback filled the cell. */
  fallback?: boolean
}

/** How the cell job decodes (the worker: fetch + createImageBitmap; the main thread: the world's decoder). */
export interface CellDecoders {
  url: ImageDecoder
  bytes(bytes: Uint8Array<ArrayBuffer>): Promise<Level>
}

export function isCellJob(job: { kind: string }): job is CellJob {
  return job.kind === 'cell-albedo' || job.kind === 'cell-nrao' || job.kind === 'cell-lightmap'
}

async function decodeCellImage(img: CellImage, dec: CellDecoders): Promise<Level> {
  switch (img.kind) {
    case 'bytes':
      return dec.bytes(img.bytes)
    case 'url':
      return dec.url(img.url)
    case 'map':
      return (await runMapJob(img.job, dec.url)).levels[0]!
    case 'pixels':
      return img.level
    case 'solid': {
      const data = new Uint8Array(4)
      data.set(img.rgba)
      return { width: 1, height: 1, data }
    }
  }
}

/**
 * Box-halves each axis on which the source is at least twice the target (a mip-like reduction before the bilinear,
 * so a minification never skips texels). `weighted`: the colour weighted by alpha (cutouts).
 */
export function reduceTo(img: Level, tw: number, th: number, weighted = false): Level {
  let cur = img
  for (;;) {
    const hx = cur.width >= tw * 2 && cur.width > 1
    const hy = cur.height >= th * 2 && cur.height > 1
    if (!hx && !hy) return cur
    if (hx && hy) {
      const n = weighted ? downsampleWeighted(cur.data, cur.width, cur.height) : downsample(cur.data, cur.width, cur.height)
      cur = { data: n.data, width: n.w, height: n.h }
      continue
    }
    // One axis only: average the pairs along it.
    const nw = hx ? cur.width >> 1 : cur.width
    const nh = hy ? cur.height >> 1 : cur.height
    const out = new Uint8Array(nw * nh * 4)
    const d = cur.data
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const a = ((hy ? 2 * y : y) * cur.width + (hx ? 2 * x : x)) * 4
        const b = hx ? a + 4 : a + cur.width * 4
        const o = (y * nw + x) * 4
        const wa = d[a + 3]!
        const wb = d[b + 3]!
        const mixed = weighted && wa + wb > 0 && wa + wb < 510
        for (let k = 0; k < 3; k++) out[o + k] = mixed ? Math.round((d[a + k]! * wa + d[b + k]! * wb) / (wa + wb)) : (d[a + k]! + d[b + k]! + 1) >> 1
        out[o + 3] = (wa + wb + 1) >> 1
      }
    }
    cur = { data: out, width: nw, height: nh }
  }
}

/**
 * Resamples `src` into a cell (bilinear, after a box reduction to less than 2× the inner size). `wrap`: the inner area
 * (the shape minus its gutters) maps the texture's [0, 1] and the gutters continue it wrapped (the atlas); otherwise
 * the whole shape maps it with clamped edges (the lightmaps, the masks).
 */
export function resampleCell(src: Level, shape: CellShape, wrap: boolean, weighted = false): Level {
  const w = shape.width
  const h = shape.height
  const iw = w - 2 * shape.gutterX
  const ih = h - 2 * shape.gutterY
  const img = reduceTo(src, iw, ih, weighted)
  const sw = img.width
  const sh = img.height
  const d = img.data
  const out = new Uint8Array(w * h * 4)
  const xs = new Int32Array(w * 2)
  const xt = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const fx = ((x - shape.gutterX + 0.5) / iw) * sw - 0.5
    const f = Math.floor(fx)
    xt[x] = fx - f
    if (wrap) {
      xs[x * 2] = ((f % sw) + sw) % sw
      xs[x * 2 + 1] = (((f + 1) % sw) + sw) % sw
    } else {
      xs[x * 2] = Math.min(sw - 1, Math.max(0, f))
      xs[x * 2 + 1] = Math.min(sw - 1, Math.max(0, f + 1))
    }
  }
  for (let y = 0; y < h; y++) {
    const fy = ((y - shape.gutterY + 0.5) / ih) * sh - 0.5
    const f = Math.floor(fy)
    const ty = fy - f
    const y0 = wrap ? ((f % sh) + sh) % sh : Math.min(sh - 1, Math.max(0, f))
    const y1 = wrap ? (((f + 1) % sh) + sh) % sh : Math.min(sh - 1, Math.max(0, f + 1))
    for (let x = 0; x < w; x++) {
      const tx = xt[x]!
      const a = (y0 * sw + xs[x * 2]!) * 4
      const b = (y0 * sw + xs[x * 2 + 1]!) * 4
      const c = (y1 * sw + xs[x * 2]!) * 4
      const e = (y1 * sw + xs[x * 2 + 1]!) * 4
      const o = (y * w + x) * 4
      for (let k = 0; k < 4; k++) {
        const top = d[a + k]! + (d[b + k]! - d[a + k]!) * tx
        const bot = d[c + k]! + (d[e + k]! - d[c + k]!) * tx
        out[o + k] = Math.round(top + (bot - top) * ty)
      }
    }
  }
  return { width: w, height: h, data: out }
}

/** The colour under a cutout's transparent texels, filled from its own coarser levels (level 0 changes only there). */
function filledCutout(img: Level): Level {
  let transparent = false
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] === 0) {
      transparent = true
      break
    }
  }
  if (!transparent) return img
  return mipChain({ ...img, data: img.data.slice() }, { alpha: 'blend' })[0]!
}

function meanOf(img: Level): [number, number, number, number] {
  const n = img.width * img.height
  let r = 0, g = 0, b = 0, a = 0
  for (let i = 0; i < n * 4; i += 4) {
    r += img.data[i]!
    g += img.data[i + 1]!
    b += img.data[i + 2]!
    a += img.data[i + 3]!
  }
  return n ? [r / n, g / n, b / n, a / n] : [0, 0, 0, 0]
}

/** `img` with its alpha taken from `mask` (its alpha, or its luminance), the mask resampled to img's size. */
function applyMask(img: Level, mask: Level, fromRgb: boolean): Level {
  const m = mask.width === img.width && mask.height === img.height
    ? mask
    : resampleCell(mask, { width: img.width, height: img.height, gutterX: 0, gutterY: 0, levels: 1 }, true)
  const out = img.data.slice()
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4
    out[o + 3] = fromRgb ? Math.round(0.2126 * m.data[o]! + 0.7152 * m.data[o + 1]! + 0.0722 * m.data[o + 2]!) : m.data[o + 3]!
  }
  return { ...img, data: out }
}

/** Decodes with the job's fallback: a failed source becomes a solid `fallback` (null: rethrow). */
async function decodeOr(img: CellImage, dec: CellDecoders, fallback: readonly [number, number, number, number] | null | undefined, failed: { any: boolean }): Promise<Level> {
  try {
    return await decodeCellImage(img, dec)
  } catch (err) {
    if (!fallback) throw err
    failed.any = true
    return decodeCellImage({ kind: 'solid', rgba: fallback }, dec)
  }
}

/** Runs one cell job (the worker and the main-thread fallback). */
export async function runCellJob(job: CellJob, dec: CellDecoders): Promise<CellResult> {
  const failed = { any: false }
  if (job.kind === 'cell-albedo') {
    const [src0, mask0] = await Promise.all([
      decodeOr(job.image, dec, job.fallback, failed),
      job.mask ? decodeOr(job.mask, dec, job.fallback ? [255, 255, 255, 255] : null, failed) : Promise.resolve(null),
    ])
    const mask = failed.any ? null : mask0
    let src = mask ? applyMask(src0, mask, !!job.maskFromRgb) : src0
    // A blended piece is never merged (BATCHING §3.7); should one reach a cell, its alpha is treated as a cutout's.
    const alpha: AlphaUse = job.alpha === 'blend' ? 'cutout' : job.alpha
    if (alpha === 'none') {
      const d = src === src0 ? src.data.slice() : src.data
      for (let i = 3; i < d.length; i += 4) d[i] = 255
      src = { ...src, data: d }
    } else src = filledCutout(src)
    const shape = job.shape ?? cellShape(src0.width, src0.height, job.page, job.levels)
    const cell = resampleCell(src, shape, true, alpha !== 'none')
    const levels = mipChain(cell, { alpha, cutoff: job.cutoff ?? 0.5, count: shape.levels })
    const r: CellResult = { shape, levels, source: { width: src0.width, height: src0.height }, mean: meanOf(src) }
    if (failed.any) r.fallback = true
    return r
  }
  if (job.kind === 'cell-lightmap') {
    const src = await decodeOr(job.image, dec, job.fallback, failed)
    const shape = job.shape ?? lightmapShape(src.width, src.height, job.page, job.levels)
    const cell = resampleCell(src, shape, false)
    for (let i = 3; i < cell.data.length; i += 4) cell.data[i] = 255
    const r: CellResult = { shape, levels: mipChain(cell, { count: shape.levels }), source: { width: src.width, height: src.height }, mean: meanOf(src) }
    if (failed.any) r.fallback = true
    return r
  }
  const shape = job.shape
  const absent = async (img: CellImage | null | undefined): Promise<Level | null> => {
    if (!img) return null
    try {
      return await decodeCellImage(img, dec)
    } catch (err) {
      if (!job.tolerant) throw err
      failed.any = true
      return null
    }
  }
  const [normal, orm] = await Promise.all([absent(job.normal), absent(job.orm)])
  const n = normal ? resampleCell(normal, shape, true) : null
  const o = orm ? resampleCell(orm, shape, true) : null
  const out = new Uint8Array(shape.width * shape.height * 4)
  const r0 = Math.round(Math.min(1, Math.max(0, job.roughness)) * 255)
  for (let i = 0; i < shape.width * shape.height; i++) {
    const k = i * 4
    const nx = n ? n.data[k]! : 128
    const ny = n ? n.data[k + 1]! : 128
    out[k] = job.invertX ? 255 - nx : nx
    out[k + 1] = job.invertY ? 255 - ny : ny
    out[k + 2] = o ? o.data[k + 1]! : r0
    out[k + 3] = o && job.aoFromRed ? o.data[k]! : 255
  }
  const main = orm ?? normal
  const r: CellResult = {
    shape,
    levels: mipChain({ width: shape.width, height: shape.height, data: out }, { count: shape.levels }),
    source: { width: main?.width ?? shape.width, height: main?.height ?? shape.height },
    mean: orm ? meanOf(orm) : [255, r0, 0, 255],
  }
  if (failed.any) r.fallback = true
  return r
}

/** A decode worker job: a TX-R map job or a BT-A cell job. */
export type DecodeJob = MapJob | CellJob

/** Runs either kind (decode-worker.ts; the cell pool's main-thread fallback). */
export function runDecodeJob(job: DecodeJob, dec: CellDecoders): Promise<MapResult | CellResult> {
  return isCellJob(job) ? runCellJob(job, dec) : runMapJob(job, dec.url)
}
