/**
 * TP-U comparison sheets (the user check of docs/WAVE_PLAN3.md §7.1 TP-U: "`pnpm texpipe run --set test` rebuilds the
 * comparison sheets"): `work/texpipe/sheets/compare_world.png` (terrain tiles and world textures) and
 * `compare_actor.png` (characters, equipment), in the style of the prototype's `work/tmp/texpipe/compare_*.png`.
 *
 * One row per texture, 1:1 crops (192 px) of the master:
 *   retail (nearest ×4) | Lanczos3 ×4 | AI (the model alone) | result (the AI/Lanczos mix) | seam check or alpha
 * The seam check tiles the result along its wrap axes and crops around the tile corner, so a seam would show as a
 * line through the middle of the panel. Atlases show the alpha instead (cutout, blend, specmask), or nothing.
 * Transparent texels are shown over mid grey.
 *
 * Later stages add their panels through `extraColumns` (TP-P: the lit and wet previews). Local files only; the sheets
 * contain retail art and are never published or committed (work/ is git-ignored).
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import type { InventoryEntry } from '../inventory.ts'
import type { RawImage } from './pad.ts'
import type { UpIndex, UpscaleReport } from './runner.ts'

export const SHEET_CROP = 192
const GAP = 4
const CAPTION = 20
const HEADER = 24
const BG = '#101010'
const GREY = { r: 128, g: 128, b: 128 }

/** Where each sheet's crop is centred, as a fraction of the texture (the prototype's picks), by key suffix. */
const FOCUS: ReadonlyArray<[string, [number, number]]> = [
  ['/cj_pal_roof.ddj', [0.5, 0.2]],
  ['/chinaman_adventurer_body.ddj', [0.3, 0.3]],
  ['/sword1_2_3.ddj', [0.3, 0.5]],
]

export interface SheetColumn {
  title: string
  /** A SHEET_CROP² PNG for this texture (the crop rectangle of the master is given), or null for an empty panel. */
  panel: (entry: UpscaleReport, crop: { left: number; top: number; width: number; height: number }) => Promise<Buffer | null>
}

const esc = (s: string) => s.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`)

function label(text: string, width: number, height: number, size = 13, fill = '#e0e0e0'): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${BG}"/>`
    + `<text x="6" y="${Math.round(height * 0.72)}" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" fill="${fill}">${esc(text)}</text></svg>`)
}

/** Transparency is shown over grey; a specmask's alpha (a metal mask, not transparency) is dropped. */
const isTransparency = (r: UpscaleReport) => r.alpha === 'cutout' || r.alpha === 'blend'

/** A master (RGBA or RGB) cropped as a PNG panel, flattened over grey when its alpha is transparency. */
async function panelOf(input: string | Buffer, r: UpscaleReport, crop: { left: number; top: number; width: number; height: number }, resize?: [number, number], kernel: 'nearest' | 'lanczos3' = 'lanczos3'): Promise<Buffer> {
  let s = sharp(input)
  if (resize) s = sharp(await s.resize(resize[0], resize[1], { kernel, fit: 'fill' }).png().toBuffer())
  s = s.extract(crop)
  return (isTransparency(r) ? s.flatten({ background: GREY }) : s.removeAlpha()).png().toBuffer()
}

/** The result tiled along its wrap axes, cropped around the tile corner (or its alpha, for atlases). */
async function seamPanel(file: string, r: UpscaleReport): Promise<Buffer | null> {
  const [W, H] = r.size
  const S = SHEET_CROP
  if (r.wrap[0] || r.wrap[1]) {
    const tile = await (isTransparency(r) ? sharp(file).flatten({ background: GREY }) : sharp(file).removeAlpha()).png().toBuffer()
    const nx = r.wrap[0] ? 2 : 1
    const ny = r.wrap[1] ? 2 : 1
    const canvas = await sharp({ create: { width: W * nx, height: H * ny, channels: 3, background: GREY } })
      .composite(Array.from({ length: nx * ny }, (_, i) => ({ input: tile, left: (i % nx) * W, top: Math.floor(i / nx) * H })))
      .png().toBuffer()
    const cx = r.wrap[0] ? W : W / 2
    const cy = r.wrap[1] ? H : H / 2
    const cw = Math.min(S, W * nx)
    const ch = Math.min(S, H * ny)
    const left = Math.round(Math.min(W * nx - cw, Math.max(0, cx - cw / 2)))
    const top = Math.round(Math.min(H * ny - ch, Math.max(0, cy - ch / 2)))
    return sharp(canvas).extract({ left, top, width: cw, height: ch }).png().toBuffer()
  }
  if (r.alpha === 'none') return null
  const crop = cropOf(r)
  return sharp(file).extractChannel(3).extract(crop).toColourspace('b-w').png().toBuffer()
}

function cropOf(r: UpscaleReport): { left: number; top: number; width: number; height: number } {
  const [W, H] = r.size
  const [fx, fy] = FOCUS.find(([s]) => r.key.endsWith(s))?.[1] ?? [0.5, 0.5]
  const width = Math.min(SHEET_CROP, W)
  const height = Math.min(SHEET_CROP, H)
  return {
    left: Math.round(Math.min(W - width, Math.max(0, fx * W - width / 2))),
    top: Math.round(Math.min(H - height, Math.max(0, fy * H - height / 2))),
    width,
    height,
  }
}

export interface SheetOptions {
  outDir: string
  /** work/texpipe/up (the index's `file`s are relative to it). */
  upDir: string
  /** The AI outputs (cache.aiFile). */
  aiFile: (hash: string) => string
  /** The lossless source of an entry as PNG bytes. */
  source: (key: string) => Promise<Buffer>
  extraColumns?: SheetColumn[]
}

/** Builds one sheet from index entries (in the given order) and writes it to `file`. */
export async function buildSheet(title: string, reports: UpscaleReport[], file: string, opts: SheetOptions & { index: UpIndex }): Promise<void> {
  const S = SHEET_CROP
  const cols = 5 + (opts.extraColumns?.length ?? 0)
  const width = cols * (S + GAP) - GAP
  const titles = ['retail (nearest ×4)', 'Lanczos3 ×4', 'AI (model only)', 'result (AI/Lanczos mix)', 'tiled seam / alpha', ...(opts.extraColumns ?? []).map(c => c.title)]
  const parts: OverlayOptions[] = [{ input: label(title, width, HEADER, 15, '#ffffff'), left: 0, top: 0 }]
  titles.forEach((t, i) => parts.push({ input: label(t, S, HEADER, 12, '#a0a0a0'), left: i * (S + GAP), top: HEADER }))
  let y = HEADER * 2 + GAP
  for (const r of reports) {
    const set = opts.index.sets[r.key]
    if (!set) continue
    const master = join(opts.upDir, set.file)
    const [W, H] = r.size
    const crop = cropOf(r)
    const seams = [r.wrap[0] ? `U ${r.seams.u.source}→${r.seams.u.out}` : '', r.wrap[1] ? `V ${r.seams.v.source}→${r.seams.v.out}` : ''].filter(Boolean).join(', ')
    const caption = `${r.key}  ${r.source.join('x')}→${r.size.join('x')}  ${r.model} mix ${r.aiMix}  ${r.alpha}${seams ? `  seams ${seams}` : ''}${r.cutout ? `  coverage ${(r.cutout.coverage * 100).toFixed(1)}%` : ''}`
    parts.push({ input: label(caption, width, CAPTION, 12), left: 0, top: y })
    y += CAPTION
    const src = await opts.source(r.key)
    const panels: Array<Buffer | null> = [
      await panelOf(src, r, crop, [W, H], 'nearest'),
      await panelOf(src, r, crop, [W, H], 'lanczos3'),
      r.aiHash ? await panelOf(await sharp(opts.aiFile(r.aiHash)).png().toBuffer(), r, crop, [W, H]) : null,
      await panelOf(master, r, crop),
      await seamPanel(master, r),
    ]
    for (const c of opts.extraColumns ?? []) panels.push(await c.panel(r, crop))
    panels.forEach((p, i) => {
      if (p) parts.push({ input: p, left: i * (S + GAP), top: y })
      else parts.push({ input: label(i === 2 ? 'no AI (Lanczos only)' : '—', S, S, 12, '#606060'), left: i * (S + GAP), top: y })
    })
    y += S + GAP
  }
  mkdirSync(dirname(file), { recursive: true })
  await sharp({ create: { width, height: y, channels: 3, background: BG } }).composite(parts).png().toFile(file)
}

/** Writes compare_world.png (tiles, world) and compare_actor.png (the rest) for these entries; returns the files. */
export async function buildSheets(entries: InventoryEntry[], opts: SheetOptions & { index: UpIndex }): Promise<string[]> {
  const byKey = (list: InventoryEntry[]) => list.map(e => opts.index.sets[e.key]).filter((r): r is UpIndex['sets'][string] => !!r)
  const world = byKey(entries.filter(e => e.group === 'tile' || e.group === 'world'))
  const actor = byKey(entries.filter(e => e.group !== 'tile' && e.group !== 'world'))
  const files: string[] = []
  if (world.length) {
    const f = join(opts.outDir, 'compare_world.png')
    await buildSheet('TP-U upscale: terrain tiles and world textures', world, f, opts)
    files.push(f)
  }
  if (actor.length) {
    const f = join(opts.outDir, 'compare_actor.png')
    await buildSheet('TP-U upscale: characters and equipment', actor, f, opts)
    files.push(f)
  }
  return files
}

/** PNG bytes of a raw image (helper for `source`). */
export async function pngOf(img: RawImage): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels as 1 | 2 | 3 | 4 } }).png().toBuffer()
}
