/**
 * Packs the rare weapons' generated effect art (docs/RARITY.md §5.2) into the client's textures:
 *   pnpm tsx packages/texpipe/src/rarity-atlas.ts <sources dir> [out dir = apps/game/public/rarity]
 *
 * Sources (image generation, emissive on black, 1024²; named tex-<name>.png, see SOURCES): sprites are cropped to
 * their content, fitted into their atlas cell (apps/game/src/world/rarity/atlas.ts) with a soft edge so nothing bleeds
 * into a neighbour at any mip; strips keep their bright band (leading edge at the top); the black level is lifted out.
 * The blade textures (the Star nebula, the masks) are made seamless (a half-offset copy cross-faded over the seams).
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { ATLAS_H, ATLAS_W, SPRITES, overlaps, type AtlasRect, type SpriteName } from '../../../apps/game/src/world/rarity/atlas.ts'


interface Img {
  w: number
  h: number
  c: 3
  d: Float32Array
}

async function load(file: string): Promise<Img> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const d = new Float32Array(info.width * info.height * 3)
  for (let i = 0; i < d.length; i++) d[i] = data[i]! / 255
  return { w: info.width, h: info.height, c: 3, d }
}

function blank(w: number, h: number): Img {
  return { w, h, c: 3, d: new Float32Array(w * h * 3) }
}

async function resize(img: Img, w: number, h: number): Promise<Img> {
  const buf = Buffer.alloc(img.w * img.h * 3)
  for (let i = 0; i < buf.length; i++) buf[i] = Math.round(Math.max(0, Math.min(1, img.d[i]!)) * 255)
  const out = await sharp(buf, { raw: { width: img.w, height: img.h, channels: 3 } }).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer()
  const d = new Float32Array(w * h * 3)
  for (let i = 0; i < d.length; i++) d[i] = out[i]! / 255
  return { w, h, c: 3, d }
}

function crop(img: Img, x: number, y: number, w: number, h: number): Img {
  const o = blank(w, h)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) for (let k = 0; k < 3; k++) o.d[(j * w + i) * 3 + k] = img.d[((y + j) * img.w + (x + i)) * 3 + k] ?? 0
  return o
}

function rotate(img: Img): Img {
  // a quarter turn: the source's up (−y) runs along +x of the result
  const o = blank(img.h, img.w)
  for (let j = 0; j < img.h; j++) for (let i = 0; i < img.w; i++) for (let k = 0; k < 3; k++) o.d[(i * o.w + (img.h - 1 - j)) * 3 + k] = img.d[(j * img.w + i) * 3 + k]!
  return o
}

/** Lifts the black level out (generated "black" is a few percent grey) and keeps the rest. */
function deblack(img: Img, floor = 0.035): Img {
  for (let i = 0; i < img.d.length; i += 3) {
    const m = Math.max(img.d[i]!, img.d[i + 1]!, img.d[i + 2]!)
    const k = m <= floor ? 0 : (m - floor) / (1 - floor) / Math.max(m, 1e-6)
    img.d[i] = img.d[i]! * k
    img.d[i + 1] = img.d[i + 1]! * k
    img.d[i + 2] = img.d[i + 2]! * k
  }
  return img
}

/** The content's bounding box (pixels brighter than `t`). */
function bbox(img: Img, t = 0.06): { x: number; y: number; w: number; h: number } {
  let x0 = img.w
  let y0 = img.h
  let x1 = -1
  let y1 = -1
  for (let j = 0; j < img.h; j++) {
    for (let i = 0; i < img.w; i++) {
      const p = (j * img.w + i) * 3
      if (Math.max(img.d[p]!, img.d[p + 1]!, img.d[p + 2]!) > t) {
        x0 = Math.min(x0, i)
        y0 = Math.min(y0, j)
        x1 = Math.max(x1, i)
        y1 = Math.max(y1, j)
      }
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w: img.w, h: img.h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** Fades the outer `px` pixels to black (no bleed between cells). */
function edgeFade(img: Img, px: number): Img {
  for (let j = 0; j < img.h; j++) {
    for (let i = 0; i < img.w; i++) {
      const e = Math.min(i, j, img.w - 1 - i, img.h - 1 - j)
      if (e >= px) continue
      const k = Math.max(0, e / px) ** 1.5
      for (let c = 0; c < 3; c++) img.d[(j * img.w + i) * 3 + c] *= k
    }
  }
  return img
}

/** The content cropped (square around its centre when `square`), fitted into w × h with a margin. */
async function fit(img: Img, w: number, h: number, opts: { square?: boolean; margin?: number; center?: boolean } = {}): Promise<Img> {
  const b = bbox(img)
  let { x, y, w: bw, h: bh } = b
  if (opts.center) {
    // keep the image centre as the sprite centre (radial art: discs, bursts, rings)
    const cx = img.w / 2
    const cy = img.h / 2
    const rx = Math.max(cx - x, x + bw - cx)
    const ry = Math.max(cy - y, y + bh - cy)
    const rr = Math.max(rx, ry)
    x = Math.round(cx - rr)
    y = Math.round(cy - rr)
    bw = bh = Math.round(rr * 2)
  } else if (opts.square) {
    const s = Math.max(bw, bh)
    x = Math.round(x + bw / 2 - s / 2)
    y = Math.round(y + bh / 2 - s / 2)
    bw = bh = s
  }
  const m = opts.margin ?? 0.06
  const pad = Math.round(Math.max(bw, bh) * m)
  const src = crop(img, x - pad, y - pad, bw + 2 * pad, bh + 2 * pad)
  return edgeFade(await resize(src, w, h), Math.max(4, Math.round(Math.min(w, h) * 0.04)))
}

/** The bright band of a strip: the rows with content, the leading edge `top` pixels down from the top. */
async function strip(img: Img, w: number, h: number): Promise<Img> {
  const b = bbox(img, 0.08)
  const top = Math.max(0, b.y - 6)
  const band = Math.min(img.h - top, Math.max(b.h + 12, 64))
  const out = await resize(crop(img, 0, top, img.w, band), w, h)
  // fade only the bottom and the very top rows (u wraps freely: the ribbon fades its ends itself)
  for (let j = 0; j < h; j++) {
    const k = Math.min(1, j / 3) * Math.min(1, (h - 1 - j) / (h * 0.12))
    for (let i = 0; i < w; i++) for (let c = 0; c < 3; c++) out.d[(j * w + i) * 3 + c] *= k
  }
  return out
}

/** Seamless: a half-offset copy (its borders wrap) cross-faded under the original's middle. */
function seamless(img: Img): Img {
  const o = blank(img.w, img.h)
  for (let j = 0; j < img.h; j++) {
    for (let i = 0; i < img.w; i++) {
      const u = i / (img.w - 1)
      const v = j / (img.h - 1)
      // 1 in the middle, 0 at the borders
      const m = Math.min(1, Math.max(0, (Math.min(u, 1 - u) * 2 - 0.05) / 0.55)) * Math.min(1, Math.max(0, (Math.min(v, 1 - v) * 2 - 0.05) / 0.55))
      const k = m * m * (3 - 2 * m)
      const ri = (i + img.w / 2) % img.w
      const rj = (j + img.h / 2) % img.h
      for (let c = 0; c < 3; c++) o.d[(j * img.w + i) * 3 + c] = img.d[(j * img.w + i) * 3 + c]! * k + img.d[(rj * img.w + ri) * 3 + c]! * (1 - k)
    }
  }
  return o
}

function blit(dst: Img, src: Img, x: number, y: number): void {
  for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) for (let c = 0; c < 3; c++) dst.d[((y + j) * dst.w + x + i) * 3 + c] = src.d[(j * src.w + i) * 3 + c]!
}

async function save(img: Img, file: string, fmt: 'jpg' | 'png', alpha?: Float32Array): Promise<void> {
  const ch = alpha ? 4 : 3
  const buf = Buffer.alloc(img.w * img.h * ch)
  for (let p = 0; p < img.w * img.h; p++) {
    for (let c = 0; c < 3; c++) buf[p * ch + c] = Math.round(Math.max(0, Math.min(1, img.d[p * 3 + c]!)) * 255)
    if (alpha) buf[p * ch + 3] = Math.round(Math.max(0, Math.min(1, alpha[p]!)) * 255)
  }
  const s = sharp(buf, { raw: { width: img.w, height: img.h, channels: ch } })
  await (fmt === 'jpg' ? s.jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true }) : s.png({ compressionLevel: 9 })).toFile(file)
  console.log('wrote', file)
}

type Kind = 'sprite' | 'radial' | 'strip' | 'pillar' | 'quad' | 'band'
/** atlas sprite <- source file, how it is cut; quads pick one quadrant (0 TL, 1 TR, 2 BL, 3 BR) of a 2×2 sheet. */
const SOURCES: Record<SpriteName, { file: string; kind: Kind; quad?: number; margin?: number }> = {
  mandala: { file: 'tex-sun-mandala.png', kind: 'radial', margin: 0.02 },
  stripMoon: { file: 'tex-moon-strip.png', kind: 'strip' },
  stripFire: { file: 'tex-fire-strip.png', kind: 'strip' },
  stripStar: { file: 'tex-stardust-strip.png', kind: 'strip' },
  pillar: { file: 'tex-light-pillar.png', kind: 'pillar' },
  flame: { file: 'tex-flame-wisp.png', kind: 'sprite' },
  starburst: { file: 'tex-starburst.png', kind: 'radial', margin: 0.02 },
  solarBurst: { file: 'tex-solar-burst.png', kind: 'radial', margin: 0.02 },
  godrays: { file: 'tex-godrays.png', kind: 'sprite', margin: 0.02 },
  halo: { file: 'tex-crescent-halo.png', kind: 'sprite' },
  shockwave: { file: 'tex-crescent-shockwave.png', kind: 'radial', margin: 0.03 },
  ripples: { file: 'tex-moon-ripples.png', kind: 'radial', margin: 0.03 },
  scorch: { file: 'tex-scorch.png', kind: 'radial', margin: 0.03 },
  mist: { file: 'tex-mist-wisp.png', kind: 'sprite' },
  shooting: { file: 'tex-shooting-star.png', kind: 'sprite', margin: 0.03 },
  flare: { file: 'tex-sprites4.png', kind: 'quad', quad: 0 },
  orb: { file: 'tex-sprites4.png', kind: 'quad', quad: 1 },
  ember: { file: 'tex-sprites4.png', kind: 'quad', quad: 2 },
  smoke: { file: 'tex-sprites4.png', kind: 'quad', quad: 3 },
  flareRing: { file: 'tex-solar-burst.png', kind: 'radial', margin: 0.1 },
  nebulaStrip: { file: 'tex-nebula.png', kind: 'band' },
  conStrip: { file: 'tex-constellation.png', kind: 'band' },
}

let src0 = ''

async function main(): Promise<void> {
  const [srcArg, outArg] = process.argv.slice(2)
  if (!srcArg) throw new Error('usage: rarity-atlas.ts <sources dir> [out dir]')
  const src = resolve(srcArg)
  src0 = src
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const out = resolve(outArg ?? join(repo, 'apps/game/public/rarity'))
  mkdirSync(out, { recursive: true })
  const rects = Object.entries(SPRITES) as [SpriteName, AtlasRect][]
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) if (overlaps(rects[a]![1], rects[b]![1])) throw new Error(`atlas cells overlap: ${rects[a]![0]} ${rects[b]![0]}`)

  const atlas = blank(ATLAS_W, ATLAS_H)
  for (const [name, rect] of rects) {
    const s = SOURCES[name]
    let img = deblack(await load(join(src, s.file)))
    let cell: Img
    if (s.kind === 'quad') {
      const q = s.quad ?? 0
      img = crop(img, (q % 2) * (img.w / 2), Math.floor(q / 2) * (img.h / 2), img.w / 2, img.h / 2)
      cell = await fit(img, rect.w, rect.h, { square: true, margin: 0.12 })
    } else if (s.kind === 'band') {
      // a band through the middle of a seamless texture, soft at the top and bottom (a shell along a blade)
      const src = s.file === 'tex-nebula.png' ? await load(join(src0, s.file)) : img
      cell = await resize(crop(src, 0, Math.round(src.h * 0.375), src.w, Math.round(src.h * 0.25)), rect.w, rect.h)
      for (let j = 0; j < cell.h; j++) {
        const v = Math.abs(j / (cell.h - 1) - 0.5) * 2
        const k = (1 - v * v) ** 1.5
        for (let i = 0; i < cell.w; i++) for (let c = 0; c < 3; c++) cell.d[(j * cell.w + i) * 3 + c] *= k
      }
    } else if (s.kind === 'strip') cell = await strip(img, rect.w, rect.h)
    else if (s.kind === 'pillar') {
      const b = bbox(img, 0.05)
      const cx = b.x + b.w / 2
      const half = Math.max(b.w / 2 + 20, 60)
      const col = edgeFade(await resize(crop(img, Math.round(cx - half), 0, Math.round(half * 2), img.h), rect.h, rect.w), 6)
      // the beam fades out at both ends (it is stretched to any length)
      for (let j = 0; j < col.h; j++) {
        const e = Math.min(j, col.h - 1 - j) / (col.h * 0.22)
        const k = Math.min(1, e) ** 1.5
        for (let i = 0; i < col.w; i++) for (let c = 0; c < 3; c++) col.d[(j * col.w + i) * 3 + c] *= k
      }
      cell = rotate(col)
    } else cell = await fit(img, rect.w, rect.h, { center: s.kind === 'radial', square: s.kind === 'sprite', ...(s.margin !== undefined ? { margin: s.margin } : {}) })
    blit(atlas, cell, rect.x, rect.y)
  }
  await save(atlas, join(out, 'fx-atlas.jpg'), 'jpg')

  // the Star blade's inside: the nebula, seamless, 1024²
  await save(seamless(await load(join(src, 'tex-nebula.png'))), join(out, 'blade-nebula.jpg'), 'jpg')

  // masks, 512²: R constellation lines, G fire cracks, B moonstone, A moonstone's blue sheen
  const size = 512
  const lum = (img: Img) => {
    const l = new Float32Array(img.w * img.h)
    for (let p = 0; p < l.length; p++) l[p] = 0.2126 * img.d[p * 3]! + 0.7152 * img.d[p * 3 + 1]! + 0.0722 * img.d[p * 3 + 2]!
    return l
  }
  const con = lum(await resize(seamless(deblack(await load(join(src, 'tex-constellation.png')))), size, size))
  const fire = lum(await resize(seamless(deblack(await load(join(src, 'tex-firecracks.png')))), size, size))
  const stone = await resize(seamless(await load(join(src, 'tex-moonstone.png'))), size, size)
  const stoneL = lum(stone)
  const masks = blank(size, size)
  const sheen = new Float32Array(size * size)
  let lo = 1
  let hi = 0
  for (const v of stoneL) {
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  for (let p = 0; p < size * size; p++) {
    masks.d[p * 3] = Math.min(1, con[p]! * 1.6)
    masks.d[p * 3 + 1] = Math.min(1, fire[p]! * 1.3)
    masks.d[p * 3 + 2] = (stoneL[p]! - lo) / Math.max(1e-3, hi - lo)
    sheen[p] = Math.max(0, Math.min(1, (stone.d[p * 3 + 2]! - stone.d[p * 3]!) * 4))
  }
  await save(masks, join(out, 'blade-masks.png'), 'png', sheen)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
