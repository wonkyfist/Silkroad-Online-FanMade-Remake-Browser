// Outfits from gear (docs/CHARACTERS.md §16.9): the cloth dye maps the game recolours the Waterbender clothes with.
// Read from the licensed pack (never in git); written next to the bodies under work/out(-opt)/char/licensed/waterbender/.
// - clothes_shade.jpg (2048, the cloth pieces' albedo in game): R the undyed BaseColor_05's brightness over its region's
//   mean, the mean at linear DYE_SHADE_MID (the shader and the bake multiply it by a region colour / DYE_SHADE_MID); G the
//   LEATHER weight (sRGB-encoded so the decoded albedo reads it linear); B 0;
// - clothes_dye.png (1024, RGB): the weights of MAIN, SECOND, TRIM (LIGHT = the rest), area-averaged from the MatID map,
//   so linear filtering and mips blend regions correctly (no alpha: browsers drop the colour of transparent texels);
// - clothes_lo_<g>.png (256, RGBA): R the shade, G the region × 32, B the owning piece + 1 (the body's piece list), for
//   the CPU colour bake of the far bodies and the crowd (apps/game/src/three/licensed-outfit.ts bakeOutfit).
// - clothes_wear.jpg (1024, RGB, linear): the pack's wear masks for the dirt and blood on the cloth (§16.9): R the
//   Clothes_DirtMask's R (large dirt, brightest where it gathers first: the hems), G its G and B (grime), B the
//   Clothes_BloodMask's spatter (max of its channels, R / G specks first); the shader reveals each by a threshold.
// The region order and DYE_SHADE_MID are the game's (licensed-outfit.ts DYE_REGIONS; a test checks they agree).
import type { Sharp, SharpOptions } from 'sharp'

export const DYE_REGIONS = ['main', 'second', 'trim', 'leather', 'light'] as const
export const DYE_SHADE_MID = 0.25
export const CLOTH_DYE_FILES = { shade: 'clothes_shade.jpg', dye: 'clothes_dye.png', lo: 'clothes_lo_{g}.png', wear: 'clothes_wear.jpg' } as const

/**
 * The pack's MatID colours (T_RiverSpirit_Clothes_MatID) → region (index in DYE_REGIONS). Measured against
 * BaseColor_01, the metal map and the pieces owning them: blue-grey cloth on skirt / top → main; navy pants, corset,
 * gloves, the sash → second; borders, embroidery, thread, flowers, gold and iron fittings → trim; brown leather → leather;
 * the white shirt and linen panels → light. Other colours (anti-aliased edges) take the nearest.
 */
export const MATID_REGIONS: readonly (readonly [number, number, number, number])[] = [
  [161, 94, 123, 0], [255, 0, 255, 0],
  [255, 128, 255, 1], [255, 0, 0, 1], [0, 255, 0, 1],
  [255, 128, 0, 2], [188, 188, 188, 2], [70, 27, 9, 2], [255, 255, 0, 2], [114, 142, 71, 2], [66, 39, 121, 2], [126, 126, 126, 2],
  [0, 255, 255, 3], [75, 59, 44, 3],
  [0, 128, 255, 4], [93, 94, 63, 4], [255, 255, 255, 4],
]

export function regionOfMatId(r: number, g: number, b: number): number {
  let best = 4
  let bd = Infinity
  for (const [cr, cg, cb, reg] of MATID_REGIONS) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (d < bd) {
      bd = d
      best = reg
    }
  }
  return best
}

type SharpFn = (input?: string | Buffer, options?: SharpOptions) => Sharp

/** Builds the three maps: [file name, bytes][]. `owners`: per gender the piece list and its owner map (waterbender-export.py). */
export async function clothDyeMaps(sharp: SharpFn, T: (p: string) => string, owners: { g: 'f' | 'm'; pieces: string[]; ownerSize: number; owner: string }[]): Promise<[string, Buffer][]> {
  const N = 2048
  const id = await sharp(T('T_RiverSpirit_Clothes_MatID.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = id.info.width
  // region per MatID texel (exact colours cached)
  const reg = new Uint8Array(W * W)
  const memo = new Map<number, number>()
  for (let i = 0; i < W * W; i++) {
    const k = (id.data[i * 3]! << 16) | (id.data[i * 3 + 1]! << 8) | id.data[i * 3 + 2]!
    let r = memo.get(k)
    if (r === undefined) memo.set(k, (r = regionOfMatId(id.data[i * 3]!, id.data[i * 3 + 1]!, id.data[i * 3 + 2]!)))
    reg[i] = r
  }
  const regionAt = (x: number, y: number, size: number) => reg[Math.floor(((y + 0.5) * W) / size) * W + Math.floor(((x + 0.5) * W) / size)]!
  // shade: BaseColor_05's linear luminance over its region's mean, at DYE_SHADE_MID
  const b5 = await sharp(T('T_RiverSpirit_Clothes_BaseColor_05.png')).removeAlpha().resize(N, N).raw().toBuffer()
  const lum = new Float32Array(N * N)
  const sum = new Float64Array(5)
  const cnt = new Float64Array(5)
  for (let i = 0; i < N * N; i++) {
    const l = 0.2126 * (b5[i * 3]! / 255) ** 2.2 + 0.7152 * (b5[i * 3 + 1]! / 255) ** 2.2 + 0.0722 * (b5[i * 3 + 2]! / 255) ** 2.2
    lum[i] = l
    const r = regionAt(i % N, Math.floor(i / N), N)
    sum[r] += l
    cnt[r]++
  }
  const mean = Array.from(sum, (s, r) => s / Math.max(1, cnt[r]!))
  const shadeOf = (i: number, r: number) => Math.min(1, (lum[i]! / Math.max(1e-4, mean[r]!)) * DYE_SHADE_MID)
  // the leather weight at the shade's size (area share of the MatID texels under each texel)
  const fs = W / N
  const shade = Buffer.alloc(N * N * 3)
  for (let i = 0; i < N * N; i++) {
    const x = i % N, y = Math.floor(i / N)
    shade[i * 3] = Math.round(255 * Math.pow(shadeOf(i, regionAt(x, y, N)), 1 / 2.2))
    let lea = 0
    for (let yy = 0; yy < fs; yy++) for (let xx = 0; xx < fs; xx++) if (reg[(y * fs + yy) * W + x * fs + xx] === 3) lea++
    shade[i * 3 + 1] = Math.round(255 * Math.pow(lea / (fs * fs), 1 / 2.2))
  }
  const out: [string, Buffer][] = []
  out.push([CLOTH_DYE_FILES.shade, await sharp(shade, { raw: { width: N, height: N, channels: 3 } }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()])
  // dye weights at 1024: the regions' area share of each texel (MatID 4096 → 4 × 4 per texel)
  const D = 1024
  const f = W / D
  const dye = Buffer.alloc(D * D * 3)
  for (let y = 0; y < D; y++)
    for (let x = 0; x < D; x++) {
      const c = [0, 0, 0, 0, 0]
      for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) c[reg[(y * f + yy) * W + x * f + xx]!]!++
      const o = (y * D + x) * 3
      for (let k = 0; k < 3; k++) dye[o + k] = Math.round((255 * c[k]!) / (f * f))
    }
  out.push([CLOTH_DYE_FILES.dye, await sharp(dye, { raw: { width: D, height: D, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer()])
  // the small map per gender: shade, region, owner
  for (const o of owners) {
    const S = o.ownerSize
    const own = Buffer.from(o.owner, 'base64')
    const lo = Buffer.alloc(S * S * 4)
    const k = N / S
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        // the shade: the block's mean; the region: the centre texel's
        let a = 0
        for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) {
          const i = (y * k + yy) * N + x * k + xx
          a += Math.pow(shadeOf(i, regionAt(x * k + xx, y * k + yy, N)), 1 / 2.2)
        }
        const i = (y * S + x) * 4
        lo[i] = Math.round((255 * a) / (k * k))
        lo[i + 1] = regionAt(x, y, S) * 32
        lo[i + 2] = own[y * S + x]!
        lo[i + 3] = 255
      }
    out.push([CLOTH_DYE_FILES.lo.replace('{g}', o.g), await sharp(lo, { raw: { width: S, height: S, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()])
  }
  return out
}

/** The wear map (dirt and blood masks, see the header): [file name, bytes]. */
export async function clothWearMap(sharp: SharpFn, T: (p: string) => string, size = 1024): Promise<[string, Buffer]> {
  const load = async (n: string) => sharp(T(n)).removeAlpha().resize(size, size).raw().toBuffer()
  const dirt = await load('T_RiverSpirit_Clothes_DirtMask.png')
  const blood = await load('T_RiverSpirit_Clothes_BloodMask.png')
  const out = Buffer.alloc(size * size * 3)
  for (let i = 0; i < size * size; i++) {
    const o = i * 3
    out[o] = dirt[o]!
    out[o + 1] = Math.max(dirt[o + 1]!, Math.round(dirt[o + 2]! * 0.8))
    out[o + 2] = Math.max(blood[o]!, blood[o + 1]!, Math.round(blood[o + 2]! * 0.9))
  }
  return [CLOTH_DYE_FILES.wear, await sharp(out, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()]
}
