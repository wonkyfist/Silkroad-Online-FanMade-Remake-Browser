/**
 * TP-P stage runner (`pnpm texpipe pbr`, and step 2 of `pnpm texpipe run`): inventory entries → PBR masters.
 *
 *   input     TP-U's upscaled master, `work/texpipe/up/<keyPath>.png` from `work/texpipe/up/index.json` (format
 *             `sro-texpipe-up`), which also gives the retail source size (the scale unit). A texture TP-U has not
 *             done yet falls back to a Lanczos3 ×4 of the retail decode (cap 2048), reported as `lanczos`, so the
 *             stage never blocks on the GPU (`pnpm texpipe upscale` first for the real input).
 *             DT-2 (detail/profiles.ts `detailRoute`): route `sdxl` reads the detail stage's albedo instead
 *             (`work/texpipe/detail/index.json`, only when it passed its gate and was made from the current GAN
 *             master; otherwise the GAN master, with a note), reported as `detail:sdxl`; route `retail` reads the
 *             Lanczos3 ×4 of the retail pixels, reported as `retail`.
 *   islands   the UV triangles of every glb that uses an atlas (uv.ts), collected here, rasterised in the worker
 *   params    the review's `pbr` block and `status` from content/texpipe/overrides.json (status `retail`: skipped)
 *   run       the worker pool (pool.ts), largest first; each job writes `work/texpipe/master/<keyPath>/` (job.ts)
 *   sheet     `work/texpipe/master/_sheets/pbr-<name>.png`: per texture retail | upscaled | albedo | normal | ORM |
 *             height | class mask | lit | wet, so the batch can be judged at a glance before TP-E's review page
 *
 * Everything reads and writes the local disk only (D43). Node only.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { detailRoute } from '../detail/profiles.ts'
import { keyPath, type TexpipeOverrides } from '../format.ts'
import { glbImage, parseGlb, type InventoryEntry } from '../inventory.ts'
import type { PbrJob, PbrJobResult } from './job.ts'
import { classParams } from '../../../world-render/src/pbr/classes.ts'
import { PBR_PIPELINE_VERSION, type DeriveOptions } from './params.ts'
import { defaultWorkers, runPool } from './pool.ts'
import { findUvSources, uvTriangles, type UvSource } from './uv.ts'

// The ComfyUI/SDXL detail stage (DT-2, detail/run.ts) is not part of the public release. These stand-ins report no
// detail albedos, so route `sdxl` textures read the GAN master (the stage's own fallback when no detail set exists).
const detailPaths = (texpipeDir: string) => ({ out: join(texpipeDir, 'detail'), index: join(texpipeDir, 'detail', 'index.json') })
const readDetailIndex = (_index: string): { sets: Record<string, { file: string; source: [number, number]; hash: string; upHash: string; pass: boolean }> } => ({ sets: {} })

export interface RunPbrOptions {
  /** work/out. */
  outDir: string
  /** work/texpipe. */
  texpipeDir: string
  world: string
  overrides?: TexpipeOverrides | null
  workers?: number
  force?: boolean
  options?: DeriveOptions
  previewEdge?: number
  /** Contact sheet name (null = none). */
  sheet?: string | null
  log?: (s: string) => void
}

export interface RunPbrResult {
  results: PbrJobResult[]
  sheet: string | null
  ms: number
}

interface UpIndexLite {
  format?: string
  sets?: Record<string, { file: string; source?: [number, number]; size?: [number, number]; hash?: string; model?: string }>
}

export function pbrPaths(texpipeDir: string) {
  return { up: join(texpipeDir, 'up'), upIndex: join(texpipeDir, 'up', 'index.json'), master: join(texpipeDir, 'master'), fallback: join(texpipeDir, 'cache', 'pbr-in') }
}

const sha1 = (...parts: Array<string | Uint8Array>) => {
  const h = createHash('sha1')
  for (const p of parts) h.update(p)
  return h.digest('hex')
}

/** Lanczos3 ×4 (cap 2048) of the retail decode, when TP-U has not run on a texture. Returns [path, sourceSize]. */
async function lanczosInput(outDir: string, e: InventoryEntry, dir: string): Promise<[string, [number, number]]> {
  const dst = join(dir, `${keyPath(e.key)}.png`)
  const src = join(outDir, e.source.file)
  let bytes: Uint8Array
  if (e.source.image === undefined) bytes = readFileSync(src)
  else {
    const img = glbImage(parseGlb(new Uint8Array(readFileSync(src))), e.source.image)
    if (!img) throw new Error(`${e.key}: image ${e.source.image} of ${e.source.file} is not embedded`)
    bytes = img
  }
  const meta = await sharp(bytes).metadata()
  const w = meta.width!, h = meta.height!
  if (!existsSync(dst)) {
    const scale = Math.min(4, 2048 / Math.max(w, h))
    mkdirSync(join(dst, '..'), { recursive: true })
    const pad = e.wrap[0] || e.wrap[1] ? Math.min(8, Math.floor(w / 4), Math.floor(h / 4)) : 0
    let s = sharp(bytes).ensureAlpha()
    if (pad) s = sharp(await s.extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'repeat' }).png().toBuffer())
    const up = await s.resize(Math.round((w + 2 * pad) * scale), Math.round((h + 2 * pad) * scale), { kernel: 'lanczos3' }).png().toBuffer()
    const out = pad ? sharp(up).extract({ left: Math.round(pad * scale), top: Math.round(pad * scale), width: Math.round(w * scale), height: Math.round(h * scale) }) : sharp(up)
    await out.png().toFile(dst)
  }
  return [dst, [w, h]]
}

export async function runPbr(entries: readonly InventoryEntry[], opts: RunPbrOptions): Promise<RunPbrResult> {
  const t0 = performance.now()
  const log = opts.log ?? (() => {})
  const paths = pbrPaths(opts.texpipeDir)
  let up: UpIndexLite = {}
  if (existsSync(paths.upIndex)) {
    try {
      up = JSON.parse(readFileSync(paths.upIndex, 'utf8')) as UpIndexLite
    } catch {
      log(`! ${paths.upIndex} is not readable: every input falls back to Lanczos3`)
    }
  }
  const detail = readDetailIndex(detailPaths(opts.texpipeDir).index)
  const todo = entries.filter(e => opts.overrides?.sets[e.key]?.status !== 'retail')
  if (todo.length < entries.length) log(`${entries.length - todo.length} texture(s) with status retail skipped`)
  const atlasKeys = new Set(todo.filter(e => !e.wrap[0] && !e.wrap[1] && e.group !== 'tile').map(e => e.key))
  const uvSources = atlasKeys.size ? findUvSources(opts.outDir, opts.world, atlasKeys) : new Map<string, UvSource[]>()
  const jobs: Array<PbrJob & { area: number }> = []
  for (const e of todo) {
    const rec = up.sets?.[e.key]
    const route = detailRoute(e.key, e.class, opts.overrides)
    const det = route === 'sdxl' ? detail.sets[e.key] : undefined
    const detFile = det ? join(detailPaths(opts.texpipeDir).out, det.file) : ''
    let input: string, inputKind: string, sourceSize: [number, number] = [e.size[0], e.size[1]], inputHash: string | undefined = rec?.hash
    if (det?.pass && existsSync(detFile) && (!rec?.hash || det.upHash === rec.hash)) {
      input = detFile
      inputKind = 'detail:sdxl'
      sourceSize = det.source
      inputHash = det.hash
    } else if (route === 'retail') {
      const fb = await lanczosInput(opts.outDir, e, paths.fallback)
      input = fb[0]
      sourceSize = fb[1]
      inputKind = 'retail'
      inputHash = undefined
    } else if (rec && existsSync(join(paths.up, rec.file))) {
      if (route === 'sdxl') log(`  ${e.key}: route sdxl but ${!det ? 'no detail result' : !det.pass ? 'its detail result failed the gate' : 'its detail result is stale (new GAN master)'}: using the GAN master (pnpm texpipe detail)`)
      input = join(paths.up, rec.file)
      inputKind = `up:${rec.model ?? '?'}`
      if (rec.source) sourceSize = rec.source
    } else {
      const fb = await lanczosInput(opts.outDir, e, paths.fallback)
      input = fb[0]
      sourceSize = fb[1]
      inputKind = 'lanczos'
      log(`  ${e.key}: not upscaled by TP-U yet, using Lanczos3 x4 (run pnpm texpipe upscale for the AI master)`)
    }
    const ov = opts.overrides?.sets[e.key]
    const uv = atlasKeys.has(e.key) ? uvTriangles(uvSources.get(e.key) ?? []) : null
    if (atlasKeys.has(e.key) && !uv?.length) log(`  ${e.key}: no UV triangles found, processed as one region`)
    const meta = { key: e.key, group: e.group, class: e.class, alpha: e.alpha, wrap: [e.wrap[0], e.wrap[1]] as [boolean, boolean], sourceSize, status: ov?.status }
    const hash = sha1(
      // The class's base roughness/metallic and rain response (world-render classes.ts, owned by the engine lane) feed
      // ORMH and the previews: a change there re-derives the class's sets instead of leaving stale masters.
      `v${PBR_PIPELINE_VERSION}`, inputHash ?? sha1(readFileSync(input)), JSON.stringify(meta), JSON.stringify(classParams(e.class)), JSON.stringify(ov?.pbr ?? {}),
      JSON.stringify(opts.options ?? {}), String(opts.previewEdge ?? ''), uv ? sha1(new Uint8Array(uv.buffer)) : '-',
    )
    jobs.push({
      key: e.key, meta, input, inputKind, uv, override: ov?.pbr, options: opts.options, outDir: join(paths.master, keyPath(e.key)),
      hash, previewEdge: opts.previewEdge, force: opts.force, area: sourceSize[0] * sourceSize[1],
    })
  }
  jobs.sort((a, b) => b.area - a.area)
  const workers = Math.min(opts.workers ?? defaultWorkers(), jobs.length)
  log(`pbr (TP-P): ${jobs.length} texture(s) on ${workers} worker(s)`)
  const results = await runPool(jobs.map(({ area: _area, ...j }) => j), workers, (r, done, total) => {
    if (r.error) log(`  [${done}/${total}] ${r.key}: ERROR ${r.error.split('\n')[0]}`)
    else if (r.skipped) log(`  [${done}/${total}] ${r.key}: up to date`)
    else {
      const i = r.info!
      const masks = i.maskShare ? ` masks ${Object.entries(i.maskShare).map(([c, v]) => `${c} ${Math.round(v * 100)}%`).join(', ')}` : ''
      log(`  [${done}/${total}] ${r.key}: ${i.size.join('x')} ${i.profile} k=${i.delight} n=${i.normalStrength}${i.islands ? ` islands ${i.islands}` : ''}${masks}${i.detail ? ` detail ${i.detail}` : ''}${i.tiny ? ' TINY' : ''} (${r.inputKind}, ${(r.ms / 1000).toFixed(1)} s)`)
    }
  })
  let sheet: string | null = null
  if (opts.sheet !== null && results.some(r => !r.error)) {
    const byKey = new Map(entries.map(e => [e.key, e]))
    sheet = await contactSheet(results.filter(r => !r.error), byKey, opts, join(paths.master, '_sheets', `pbr-${opts.sheet ?? 'batch'}.png`))
    log(`Wrote ${sheet}`)
  }
  return { results, sheet, ms: Math.round(performance.now() - t0) }
}

// ---- contact sheet ------------------------------------------------------------------------------------------------------

const PANEL = 220
const GAP = 4
const COLUMNS = ['retail', 'upscaled', 'albedo', 'normal', 'AO/rough/metal', 'height', 'class mask', 'lit', 'wet'] as const

/** One panel: the image cropped (tileables: the centre half; atlases: whole) and fitted into PANEL², nearest for retail. */
async function panel(src: string | Uint8Array | null, crop: 'centre' | 'whole', nearest = false, channels?: 'rgb' | 'alpha'): Promise<Buffer> {
  const blank = () => sharp({ create: { width: PANEL, height: PANEL, channels: 3, background: '#181818' } }).png().toBuffer()
  if (!src || (typeof src === 'string' && !existsSync(src))) return blank()
  let s = sharp(typeof src === 'string' ? src : Buffer.from(src))
  if (channels === 'alpha') s = s.extractChannel(3)
  else s = s.removeAlpha()
  const buf = await s.toColourspace('srgb').png().toBuffer()
  const meta = await sharp(buf).metadata()
  const w = meta.width!, h = meta.height!
  let t = sharp(buf)
  if (crop === 'centre') {
    const c = Math.max(1, Math.floor(Math.min(w, h) / 2))
    t = t.extract({ left: Math.floor((w - c) / 2), top: Math.floor((h - c) / 2), width: c, height: c })
  }
  return t.resize(PANEL, PANEL, { fit: 'contain', background: '#181818', kernel: nearest ? 'nearest' : 'lanczos3' }).png().toBuffer()
}

async function contactSheet(results: PbrJobResult[], byKey: Map<string, InventoryEntry>, opts: RunPbrOptions, file: string): Promise<string> {
  const header = 28, label = 20
  const rows: Buffer[] = []
  for (const r of results) {
    const e = byKey.get(r.key)!
    const crop = e.wrap[0] || e.wrap[1] ? 'centre' : 'whole'
    let retail: Uint8Array | null = null
    try {
      retail = e.source.image === undefined ? readFileSync(join(opts.outDir, e.source.file)) : glbImage(parseGlb(new Uint8Array(readFileSync(join(opts.outDir, e.source.file)))), e.source.image) ?? null
    } catch {
      retail = null
    }
    const d = r.outDir
    const info = JSON.parse(readFileSync(join(d, 'pbr.json'), 'utf8')) as { input: string }
    const panels = await Promise.all([
      panel(retail, crop, true), panel(info.input, crop), panel(join(d, 'albedo.png'), crop), panel(join(d, 'normal.png'), crop),
      panel(join(d, 'ormh.png'), crop), panel(join(d, 'ormh.png'), crop, false, 'alpha'), panel(join(d, 'mask_view.png'), crop),
      panel(join(d, 'lit.png'), crop), panel(join(d, 'wet.png'), crop),
    ])
    const text = `${r.key}  (${e.class}, ${e.alpha}, wrap ${e.wrap[0] ? 'U' : '-'}${e.wrap[1] ? 'V' : '-'}, ${r.inputKind})`
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${COLUMNS.length * (PANEL + GAP)}" height="${label}"><text x="4" y="15" font-family="Arial" font-size="13" fill="#e0e0e0">${escapeXml(text)}</text></svg>`)
    rows.push(await sharp({ create: { width: COLUMNS.length * (PANEL + GAP), height: PANEL + label, channels: 3, background: '#000000' } })
      .composite([{ input: svg, left: 0, top: 0 }, ...panels.map((b, i) => ({ input: b, left: i * (PANEL + GAP), top: label }))]).png().toBuffer())
  }
  const W = COLUMNS.length * (PANEL + GAP)
  const head = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${header}">${COLUMNS.map((c, i) => `<text x="${i * (PANEL + GAP) + 6}" y="19" font-family="Arial" font-size="15" font-weight="bold" fill="#ffffff">${c}</text>`).join('')}</svg>`)
  const H = header + rows.length * (PANEL + label + GAP)
  mkdirSync(join(file, '..'), { recursive: true })
  await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: head, left: 0, top: 0 }, ...rows.map((b, i) => ({ input: b, left: 0, top: header + i * (PANEL + label + GAP) }))])
    .png().toFile(file)
  return file
}

const escapeXml = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

/** Writes the batch report next to the sheets (key → profile, timings, masks, input). */
export function writeReport(res: RunPbrResult, texpipeDir: string, name: string): string {
  const file = join(pbrPaths(texpipeDir).master, '_sheets', `pbr-${name}.json`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(res.results.map(r => ({ key: r.key, input: r.inputKind, skipped: r.skipped, error: r.error, ms: r.ms, info: r.info })), null, 1))
  return file
}
