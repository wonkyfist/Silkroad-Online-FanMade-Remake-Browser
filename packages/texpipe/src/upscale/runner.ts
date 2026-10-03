/**
 * TP-U, the upscale runner (docs/TEXPIPE.md §3.4, §10 TP-U; docs/WAVE_PLAN3.md §7.1).
 *
 * Per texture: the lossless retail decode (work/out, never work/out-opt) → alpha bleed (cutout, blend) → per-axis
 * wrap padding → ×4 with Real-ESRGAN ncnn-vulkan on the RGB (one directory run per model and batch, so the model
 * loads once) and Lanczos3 on the same padded RGB → crop → AI/Lanczos mix → alpha by Lanczos3 (+ cutout re-threshold
 * and coverage-preserving mip scales) → cap at 2048 on the long side → `work/texpipe/up/<keyPath>.png` and
 * `work/texpipe/up/index.json` (format `sro-texpipe-up`), the input of TP-P.
 *
 * Everything is local: the exe runs on this PC's GPU (Vulkan). No retail file is sent anywhere (D43).
 * Results are cached by content in `work/texpipe/cache/up/` (cache.ts).
 *
 * The exe path is `texpipe.realesrgan` in sro.config.json (relative to the repo root), default
 * `<workDir>/tools/realesrgan/realesrgan-ncnn-vulkan.exe`. Without it the runner falls back to Lanczos only and says so.
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { MaterialClass } from '../../../world-render/src/pbr/classes.ts'
import { keyPath, type AlphaKind, type PbrStatus, type TexpipeOverrides, type UpscaleModel, type UpscaleOverride } from '../format.ts'
import { glbImage, parseGlb, REPO_ROOT, type InventoryEntry } from '../inventory.ts'
import { alphaPlane, bleedAlpha, bleedThreshold, coverageMips, needsBleed, rethreshold, CUTOUT_RAMP_PX } from './alpha.ts'
import { AI_CACHE_VERSION, decodeImage, encodePng, imageHash, sha1, UpscaleCache, UPSCALE_CACHE_VERSION, writeAtomic } from './cache.ts'
import { mixImages, planFor, resizeLanczos, toneMatch, TONE_SIGMA } from './mix.ts'
import { cropUpscaled, joinAlpha, padImage, padPlan, seamRatio, takeChannels, type PadPlan, type RawImage } from './pad.ts'

/** Every model here is ×4 (Real-ESRGAN x4plus and x4plus-anime only come in ×4). */
export const UPSCALE_SCALE = 4
/** The master's long edge cap (TEXPIPE §3.4 rule 1): ×4, capped at 2048; lower tiers are downsampled from it. */
export const MASTER_CAP = 2048
/** Textures per exe call: the model loads once per call (~2 s), and a batch bounds the memory held. */
export const DEFAULT_BATCH = 32
export const UP_INDEX_FORMAT = 'sro-texpipe-up'
export const UP_INDEX_VERSION = 1

// ---- the upscaler ---------------------------------------------------------------------------------------------------

export interface UpscaleBackend {
  /** Shown in reports and the index (`realesrgan-ncnn-vulkan`, `lanczos`, a test stub). */
  readonly name: string
  /** Changes when the upscaler would give different pixels (exe size and date): part of the cache key. */
  readonly identity: string
  /** Upscales every RGB image ×4 with `model`; returns them in the same order, each exactly 4× the input. */
  run(model: UpscaleModel, images: RawImage[]): Promise<RawImage[]>
}

interface TexpipeConfig {
  workDir: string
  realesrgan?: string
}

/** The texpipe keys of sro.config.json (absent file or keys → the defaults). */
export function readTexpipeConfig(): TexpipeConfig {
  const path = join(REPO_ROOT, 'sro.config.json')
  let cfg: { workDir?: string; texpipe?: { realesrgan?: string } } = {}
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8')) as typeof cfg
    } catch {
      // The converter reports a broken config; texpipe falls back to the defaults.
    }
  }
  return { workDir: resolve(REPO_ROOT, cfg.workDir ?? 'work'), realesrgan: cfg.texpipe?.realesrgan }
}

/** The configured (or default) Real-ESRGAN exe path, whether or not it exists. */
export function realesrganPath(cfg = readTexpipeConfig()): string {
  if (cfg.realesrgan) return resolve(REPO_ROOT, cfg.realesrgan)
  return join(cfg.workDir, 'tools', 'realesrgan', process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan')
}

/** The exe path when it and its models folder exist, else null. */
export function findRealesrgan(cfg = readTexpipeConfig()): string | null {
  const exe = realesrganPath(cfg)
  return existsSync(exe) && existsSync(join(dirname(exe), 'models')) ? exe : null
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise(res => {
    execFile(file, args, { windowsHide: true, maxBuffer: 64 << 20, timeout: timeoutMs }, (err, _stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      res({ code, stderr: String(stderr ?? '') + (err && code === -1 ? `\n${err.message}` : '') })
    })
  })
}

/**
 * Real-ESRGAN ncnn-vulkan in directory mode: writes the batch as PNGs to a temp folder, runs the exe once, reads the
 * results back. If a run fails or drops files (out of GPU memory while something else holds the GPU), it retries
 * once with 64 px tiles.
 */
export function realesrganBackend(exe: string, opts: { tmpDir: string; tile?: number; log?: (s: string) => void }): UpscaleBackend {
  const st = statSync(exe)
  const models = join(dirname(exe), 'models')
  let seq = 0
  return {
    name: 'realesrgan-ncnn-vulkan',
    identity: `${basename(exe)}:${st.size}:${Math.round(st.mtimeMs)}`,
    async run(model, images) {
      if (model === 'lanczos') throw new Error('realesrganBackend: lanczos is not a Real-ESRGAN model')
      if (!images.length) return []
      const dir = join(opts.tmpDir, `up-${process.pid}-${seq++}`)
      const inDir = join(dir, 'in')
      const outDir = join(dir, 'out')
      mkdirSync(inDir, { recursive: true })
      try {
        for (const [i, img] of images.entries()) writeAtomic(join(inDir, `${i}.png`), await encodePng(img))
        let tile = opts.tile ?? 0
        for (let attempt = 0; ; attempt++) {
          rmSync(outDir, { recursive: true, force: true })
          mkdirSync(outDir, { recursive: true })
          const args = ['-i', inDir, '-o', outDir, '-n', model, '-s', String(UPSCALE_SCALE), '-f', 'png', '-m', models, '-t', String(tile)]
          const r = await run(exe, args, 60 * 60_000)
          const missing = images.map((_, i) => i).filter(i => !existsSync(join(outDir, `${i}.png`)))
          if (r.code === 0 && !missing.length) break
          const why = `exit ${r.code}, ${missing.length}/${images.length} missing: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`
          if (attempt >= 1) throw new Error(`realesrgan ${model}: ${why}`)
          opts.log?.(`  realesrgan ${model}: ${why}; retrying with 64 px tiles`)
          tile = 64
        }
        const out: RawImage[] = []
        for (const [i, img] of images.entries()) {
          const up = await decodeImage(join(outDir, `${i}.png`), 3)
          if (up.width !== img.width * UPSCALE_SCALE || up.height !== img.height * UPSCALE_SCALE) {
            throw new Error(`realesrgan ${model}: ${img.width}x${img.height} came back ${up.width}x${up.height}`)
          }
          out.push(up)
        }
        return out
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

// ---- one texture ------------------------------------------------------------------------------------------------------

export interface UpscaleJob {
  key: string
  class: MaterialClass
  alpha: AlphaKind
  /** Axes the mesh UVs repeat along [U, V]. */
  wrap: [boolean, boolean]
  /** The lossless source as RGBA, loaded when the job's batch runs. */
  source: () => Promise<RawImage>
  override?: UpscaleOverride
  status?: PbrStatus
}

export interface SeamPair {
  /** The source's own seam ratio on this axis. */
  source: number
  /** The upscaled result's. */
  out: number
}

export interface UpscaleReport {
  key: string
  /** Source size [w, h]. */
  source: [number, number]
  /** Result size [w, h] (×4, capped at MASTER_CAP). */
  size: [number, number]
  model: UpscaleModel
  aiMix: number
  reason: string
  alpha: AlphaKind
  wrap: [boolean, boolean]
  pad: PadPlan
  /** Seam ratios (pad.ts seamRatio). Only a quality measure on wrap axes; on clamped axes they show the edges kept. */
  seams: { u: SeamPair; v: SeamPair }
  /** cutout only: the coverage at the cutoff and the alpha scale of every mip below the top (coverage-preserving). */
  cutout?: { coverage: number; mipScales: number[] }
  /** Cache ids: the final result and the AI output (null for Lanczos-only). */
  hash: string
  aiHash: string | null
  /** This texture's share of its batch's AI time (0 when cached). */
  aiMs: number
  cached: boolean
}

export interface UpscaleStats {
  jobs: number
  cached: number
  /** One entry per model that ran: files, source megapixels (unpadded), wall time, ms per source Mpx. */
  ai: Array<{ model: UpscaleModel; files: number; sourceMpx: number; ms: number; msPerMpx: number }>
  totalMs: number
}

export interface UpscaleOptions {
  /** null = Lanczos3 only (no exe, or `--upscaler lanczos`). */
  backend: UpscaleBackend | null
  cache: UpscaleCache
  cap?: number
  batch?: number
  /** Ignore cached results (the AI output is recomputed too). */
  force?: boolean
  log?: (s: string) => void
  /** Called with each finished result (cached ones too), in job order. */
  onResult?: (report: UpscaleReport, file: string) => Promise<void> | void
}

interface Prepared {
  job: UpscaleJob
  src: RawImage
  plan: PadPlan
  model: UpscaleModel
  aiMix: number
  reason: string
  padded: RawImage
  rgbPadded: RawImage
  aiHash: string | null
  hash: string
}

function prepare(job: UpscaleJob, src: RawImage, backend: UpscaleBackend | null, cap: number): Prepared {
  if (src.channels !== 4) throw new Error(`${job.key}: source must be RGBA`)
  let { model, aiMix, reason } = planFor(job.key, job.class, job.override, job.status)
  if (!backend && model !== 'lanczos') {
    model = 'lanczos'
    aiMix = 0
    reason = 'no upscaler'
  }
  const bled = needsBleed(job.alpha) ? bleedAlpha(src, { threshold: bleedThreshold(job.alpha), wrap: job.wrap }) : src
  const plan = padPlan(src.width, src.height, job.wrap)
  const padded = padImage(bled, plan)
  const rgbPadded = takeChannels(padded, 3)
  const aiHash = model === 'lanczos' ? null
    : sha1('tp-u-ai', AI_CACHE_VERSION, imageHash(rgbPadded), model, plan.pad, plan.u, plan.v, backend!.identity)
  const hash = sha1('tp-u-up', UPSCALE_CACHE_VERSION, aiHash ?? 'lanczos', imageHash(padded), plan.pad, plan.u, plan.v,
    aiMix, job.alpha, cap, CUTOUT_RAMP_PX, UPSCALE_SCALE)
  return { job, src, plan, model, aiMix, reason, padded, rgbPadded, aiHash, hash }
}

/**
 * Resizes an upscaled texture to (W, H) with Lanczos3, wrap-aware: when the axes wrap and the pad scales to whole
 * pixels, it pads per axis, resizes and crops, so a tileable master stays tileable.
 */
async function resizeWrapped(img: RawImage, plan: PadPlan, padPx: number, W: number, H: number): Promise<RawImage> {
  const f = W / img.width
  const pf = padPx * f
  if (!plan.pad || !Number.isInteger(pf) || Math.abs(H / img.height - f) > 1e-9) return resizeLanczos(img, W, H)
  const p = padImage(img, { pad: padPx, u: plan.u, v: plan.v })
  const r = await resizeLanczos(p, W + 2 * pf, H + 2 * pf)
  return cropUpscaled(r, { pad: pf, u: plan.u, v: plan.v }, 1, W, H)
}

/** The Lanczos3 ×4 reference of a prepared texture (the same padded RGB as the model gets), cropped. */
export async function lanczosReference(rgbPadded: RawImage, plan: PadPlan, w: number, h: number): Promise<RawImage> {
  const up = await resizeLanczos(rgbPadded, rgbPadded.width * UPSCALE_SCALE, rgbPadded.height * UPSCALE_SCALE)
  return cropUpscaled(up, plan, UPSCALE_SCALE, w, h)
}

async function finish(p: Prepared, ai: RawImage | null, cap: number): Promise<{ image: RawImage; report: Omit<UpscaleReport, 'aiMs' | 'cached'> }> {
  const { job, src, plan } = p
  const w = src.width
  const h = src.height
  const lanczos = await lanczosReference(p.rgbPadded, plan, w, h)
  let rgb = ai ? mixImages(toneMatch(ai, lanczos, TONE_SIGMA * UPSCALE_SCALE, job.wrap), lanczos, p.aiMix) : lanczos
  let alpha: RawImage | null = null
  if (job.alpha !== 'none') {
    const a = alphaPlane(p.padded)
    alpha = cropUpscaled(await resizeLanczos(a, a.width * UPSCALE_SCALE, a.height * UPSCALE_SCALE), plan, UPSCALE_SCALE, w, h)
  }
  const long = Math.max(w, h) * UPSCALE_SCALE
  if (long > cap) {
    const f = cap / long
    const W = Math.max(1, Math.round(w * UPSCALE_SCALE * f))
    const H = Math.max(1, Math.round(h * UPSCALE_SCALE * f))
    rgb = await resizeWrapped(rgb, plan, plan.pad * UPSCALE_SCALE, W, H)
    if (alpha) alpha = await resizeWrapped(alpha, plan, plan.pad * UPSCALE_SCALE, W, H)
  }
  let cutout: UpscaleReport['cutout']
  if (alpha && job.alpha === 'cutout') {
    rethreshold(alpha.data, rgb.width / w)
    const mips = coverageMips(alpha.data, alpha.width, alpha.height)
    cutout = { coverage: +mips[0]!.coverage.toFixed(4), mipScales: mips.slice(1).map(m => +m.scale.toFixed(4)) }
  }
  const image = alpha ? joinAlpha(rgb, alpha) : rgb
  const srcRgb = takeChannels(src, 3)
  const r2 = (n: number) => (Number.isFinite(n) ? +n.toFixed(2) : n)
  return {
    image,
    report: {
      key: job.key,
      source: [w, h],
      size: [rgb.width, rgb.height],
      model: p.model,
      aiMix: p.aiMix,
      reason: p.reason,
      alpha: job.alpha,
      wrap: job.wrap,
      pad: plan,
      seams: {
        u: { source: r2(seamRatio(srcRgb, 'u')), out: r2(seamRatio(rgb, 'u', phase(rgb.width, w))) },
        v: { source: r2(seamRatio(srcRgb, 'v')), out: r2(seamRatio(rgb, 'v', phase(rgb.height, h))) },
      },
      cutout,
      hash: p.hash,
      aiHash: p.aiHash,
    },
  }
}

/** The seam-ratio period of an upscaled axis: the whole upscale factor, or 1 when it is not whole. */
function phase(out: number, src: number): number {
  return out % src === 0 ? out / src : 1
}

/** Upscales every job (batches of `batch`, one exe call per model per batch). */
export async function upscaleJobs(jobs: UpscaleJob[], opts: UpscaleOptions): Promise<{ reports: UpscaleReport[]; stats: UpscaleStats }> {
  const t0 = performance.now()
  const cap = opts.cap ?? MASTER_CAP
  const batch = Math.max(1, opts.batch ?? DEFAULT_BATCH)
  const log = opts.log ?? (() => {})
  const reports: UpscaleReport[] = []
  const aiStats = new Map<UpscaleModel, { files: number; px: number; ms: number }>()
  let cached = 0
  for (let b = 0; b < jobs.length; b += batch) {
    const chunk = jobs.slice(b, b + batch)
    const prepared: Prepared[] = []
    for (const job of chunk) prepared.push(prepare(job, await job.source(), opts.backend, cap))
    const done = new Map<Prepared, UpscaleReport>()
    const todo: Prepared[] = []
    for (const p of prepared) {
      const meta = opts.force ? null : opts.cache.getMeta<UpscaleReport>(p.hash)
      if (meta) {
        done.set(p, { ...meta, aiMs: 0, cached: true })
        cached++
      } else todo.push(p)
    }
    // AI outputs: from the cache, else one directory run per model.
    const ai = new Map<Prepared, RawImage>()
    const aiMs = new Map<Prepared, number>()
    const byModel = new Map<UpscaleModel, Prepared[]>()
    for (const p of todo) {
      if (!p.aiHash) continue
      const hit = opts.force ? null : await opts.cache.getAi(p.aiHash)
      if (hit) ai.set(p, hit)
      else byModel.set(p.model, [...(byModel.get(p.model) ?? []), p])
    }
    for (const [model, ps] of byModel) {
      const px = ps.reduce((n, p) => n + p.src.width * p.src.height, 0)
      log(`  ${model}: ${ps.length} texture(s), ${(px / 1e6).toFixed(2)} source Mpx`)
      const t = performance.now()
      const outs = await opts.backend!.run(model, ps.map(p => p.rgbPadded))
      const ms = performance.now() - t
      const s = aiStats.get(model) ?? { files: 0, px: 0, ms: 0 }
      aiStats.set(model, { files: s.files + ps.length, px: s.px + px, ms: s.ms + ms })
      for (const [i, p] of ps.entries()) {
        const img = cropUpscaled(outs[i]!, p.plan, UPSCALE_SCALE, p.src.width, p.src.height)
        await opts.cache.putAi(p.aiHash!, img)
        ai.set(p, img)
        aiMs.set(p, (ms * p.src.width * p.src.height) / px)
      }
    }
    for (const p of todo) {
      const { image, report } = await finish(p, ai.get(p) ?? null, cap)
      const full: UpscaleReport = { ...report, aiMs: Math.round(aiMs.get(p) ?? 0), cached: false }
      await opts.cache.putUp(p.hash, image, { ...full, cached: undefined, aiMs: undefined })
      done.set(p, full)
    }
    for (const p of prepared) {
      const r = done.get(p)!
      reports.push(r)
      await opts.onResult?.(r, opts.cache.upFile(r.hash))
    }
  }
  const stats: UpscaleStats = {
    jobs: jobs.length,
    cached,
    ai: [...aiStats].map(([model, s]) => ({
      model, files: s.files, sourceMpx: +(s.px / 1e6).toFixed(3), ms: Math.round(s.ms), msPerMpx: Math.round(s.ms / (s.px / 1e6)),
    })),
    totalMs: Math.round(performance.now() - t0),
  }
  return { reports, stats }
}

// ---- the inventory side -----------------------------------------------------------------------------------------------

/** The lossless RGBA decode of an inventory entry: a tile PNG, or the image embedded in a glb (TEXPIPE §3.1). */
export async function loadSource(outDir: string, entry: Pick<InventoryEntry, 'key' | 'source'>): Promise<RawImage> {
  const file = join(outDir, entry.source.file)
  if (entry.source.image === undefined) return decodeImage(file, 4)
  const bytes = glbImage(parseGlb(new Uint8Array(readFileSync(file))), entry.source.image)
  if (!bytes) throw new Error(`${entry.key}: image ${entry.source.image} of ${entry.source.file} is not embedded`)
  return decodeImage(bytes, 4)
}

/** Where TP-U's outputs live under the texpipe work folder (`work/texpipe`). */
export function upscalePaths(texpipeDir: string) {
  return {
    cache: join(texpipeDir, 'cache', 'up'),
    up: join(texpipeDir, 'up'),
    index: join(texpipeDir, 'up', 'index.json'),
    tmp: join(texpipeDir, 'tmp'),
  }
}

/** `work/texpipe/up/index.json`: key → the upscaled master (relative file) and its report. Read by TP-P. */
export interface UpIndex {
  format: typeof UP_INDEX_FORMAT
  version: typeof UP_INDEX_VERSION
  updatedAt: string
  sets: Record<string, UpscaleReport & { file: string }>
}

export function readUpIndex(path: string): UpIndex {
  if (existsSync(path)) {
    try {
      const j = JSON.parse(readFileSync(path, 'utf8')) as UpIndex
      if (j.format === UP_INDEX_FORMAT && j.version === UP_INDEX_VERSION && j.sets) return j
    } catch {
      // rebuilt below
    }
  }
  return { format: UP_INDEX_FORMAT, version: UP_INDEX_VERSION, updatedAt: '', sets: {} }
}

export interface RunUpscaleOptions {
  outDir: string
  texpipeDir: string
  /** 'ai' (default: Real-ESRGAN when found, else Lanczos with a warning) or 'lanczos'. */
  upscaler?: 'ai' | 'lanczos'
  overrides?: TexpipeOverrides | null
  force?: boolean
  batch?: number
  log?: (s: string) => void
}

/** Upscales inventory entries into `work/texpipe/up/` and merges them into its index. */
export async function runUpscale(entries: InventoryEntry[], opts: RunUpscaleOptions): Promise<{ reports: UpscaleReport[]; stats: UpscaleStats; backend: string; index: UpIndex }> {
  const log = opts.log ?? (() => {})
  const paths = upscalePaths(opts.texpipeDir)
  let backend: UpscaleBackend | null = null
  if (opts.upscaler !== 'lanczos') {
    const exe = findRealesrgan()
    if (exe) backend = realesrganBackend(exe, { tmpDir: paths.tmp, log })
    else log(`Real-ESRGAN not found at ${realesrganPath()} (sro.config.json texpipe.realesrgan): Lanczos3 only`)
  }
  const jobs: UpscaleJob[] = entries.map(e => {
    const o = opts.overrides?.sets[e.key]
    return {
      key: e.key, class: e.class, alpha: e.alpha, wrap: e.wrap, override: o?.upscale, status: o?.status,
      source: async () => {
        const img = await loadSource(opts.outDir, e)
        if (img.width !== e.size[0] || img.height !== e.size[1]) log(`  ${e.key}: decoded ${img.width}x${img.height}, inventory says ${e.size.join('x')}`)
        return img
      },
    }
  })
  const index = readUpIndex(paths.index)
  mkdirSync(paths.up, { recursive: true })
  const { reports, stats } = await upscaleJobs(jobs, {
    backend, cache: new UpscaleCache(paths.cache), force: opts.force, batch: opts.batch, log,
    onResult: (r, file) => {
      const rel = `${keyPath(r.key)}.png`
      const dst = join(paths.up, rel)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(file, dst)
      index.sets[r.key] = { ...r, file: rel }
    },
  })
  index.updatedAt = new Date().toISOString()
  writeAtomic(paths.index, JSON.stringify(index, null, 1))
  rmSync(paths.tmp, { recursive: true, force: true })
  return { reports, stats, backend: backend?.name ?? 'lanczos', index }
}

/** One line per texture and one per model for the CLI. */
export function formatUpscale(reports: UpscaleReport[], stats: UpscaleStats): string {
  const lines: string[] = []
  const seam = (s: SeamPair, wraps: boolean) => `${wraps ? '' : '('}${s.source}→${s.out}${wraps ? '' : ')'}`
  lines.push(`${'key'.padEnd(58)} ${'src'.padEnd(8)} ${'out'.padEnd(10)} ${'model'.padEnd(24)} mix  pad        seam U      seam V      notes`)
  for (const r of reports) {
    const pad = r.pad.pad ? `${r.pad.pad}px ${r.pad.u[0]}${r.pad.v[0]}` : '-'
    const notes = [r.cached ? 'cached' : r.aiHash && !r.aiMs ? 'AI cached' : r.aiHash ? `AI ${r.aiMs} ms` : '', r.alpha !== 'none' ? r.alpha : '', r.cutout ? `cov ${(r.cutout.coverage * 100).toFixed(1)}%` : '']
    lines.push(`${r.key.slice(-58).padEnd(58)} ${r.source.join('x').padEnd(8)} ${r.size.join('x').padEnd(10)} ${r.model.padEnd(24)} ${r.aiMix.toFixed(1)}  ${pad.padEnd(10)} ${seam(r.seams.u, r.wrap[0]).padEnd(11)} ${seam(r.seams.v, r.wrap[1]).padEnd(11)} ${notes.filter(Boolean).join(', ')}`)
  }
  lines.push('')
  lines.push(`${stats.jobs} texture(s), ${stats.cached} from the cache, ${(stats.totalMs / 1000).toFixed(1)} s total. Seams: source→result; (clamped axis).`)
  for (const a of stats.ai) lines.push(`  ${a.model}: ${a.files} file(s), ${a.sourceMpx} source Mpx in ${(a.ms / 1000).toFixed(1)} s = ${(a.msPerMpx / 1000).toFixed(1)} s/Mpx`)
  return lines.join('\n')
}
