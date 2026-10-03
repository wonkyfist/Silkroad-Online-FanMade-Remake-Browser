/**
 * TP-P: one texture as a file job (Node only), run in a worker (worker.ts) or in-process. Reads the upscaled albedo,
 * rasterises the UV islands from the triangles the main thread collected (uv.ts), runs `derive`, and writes the master
 * folder:
 *
 *   work/texpipe/master/<keyPath>/
 *     albedo.png     8-bit RGBA sRGB, de-lit (+ detail tone); alpha only for cutout/blend
 *     normal.png     16-bit RGB, n · 0.5 + 0.5, tangent space, +Y up (glTF)
 *     ormh.png       16-bit RGBA: R AO, G roughness, B metallic, A height (D37)
 *     mask.png       8-bit grey class mask (format.ts MASK_CLASSES index, 255 = none), actor atlases only
 *     mask_view.png  the class mask in colour (review)
 *     clusters.png   the k-means clusters at the source size in colour, index order = the relabel ids (review)
 *     lit.png        lit preview (≤ 1024 px), 8-bit RGB
 *     wet.png        wet preview (≤ 1024 px), 8-bit RGB
 *     pbr.json       DeriveInfo + the job hash + file sizes; written last
 *
 * TP-E encodes the tiers from albedo/normal/ormh and shows lit/wet/mask_view/clusters on the review page. A job whose
 * pbr.json has the same hash and whose files all exist is skipped (the SHA-1 cache of TEXPIPE §2).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MASK_CLASSES, type PbrDeriveOverride } from '../format.ts'
import { derive, normalToRgb, type DeriveInfo } from './derive.ts'
import { img, type Img } from './image.ts'
import { encodePng, readImage, writeBytesPng } from './io.ts'
import { rasterIslands } from './islands.ts'
import type { DeriveMeta, DeriveOptions } from './params.ts'

export interface PbrJob {
  key: string
  meta: DeriveMeta
  /** Absolute path of the upscaled albedo (PNG). */
  input: string
  /** Where the input came from (reported): 'up' (TP-U), 'proto-ai' (the prototype's x4plus run), 'lanczos'. */
  inputKind: string
  /**
   * Atlases: the UV triangles of every primitive that uses the texture (u0 v0 u1 v1 u2 v2 …, uv.ts `uvTriangles`),
   * collected on the main thread so the worker never loads the glb reader.
   */
  uv?: Float64Array | null
  override?: PbrDeriveOverride
  options?: DeriveOptions
  /** work/texpipe/master/<keyPath> (absolute). */
  outDir: string
  hash: string
  previewEdge?: number
  force?: boolean
}

export interface PbrJobResult {
  key: string
  outDir: string
  inputKind: string
  skipped: boolean
  info?: DeriveInfo
  files?: Record<string, number>
  ms: number
  error?: string
}

export const MASTER_FILES = ['albedo.png', 'normal.png', 'ormh.png', 'pbr.json'] as const

/** Colours of the class mask view (DETAIL's CLS_COL, wood and jade added); none = black. */
export const MASK_COLOURS: Readonly<Record<string, [number, number, number]>> = {
  cloth: [230, 230, 210], leather: [150, 80, 30], metal: [120, 160, 220], gold: [250, 200, 40], skin: [240, 150, 140],
  hair: [60, 30, 90], wood: [120, 85, 45], jade: [60, 200, 150],
}

function readInfo(dir: string): { hash?: string; files?: Record<string, number> } | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'pbr.json'), 'utf8')) as { hash?: string; files?: Record<string, number> }
  } catch {
    return null
  }
}

/** True when the master folder is complete (every file its pbr.json lists) and was made from the same inputs. */
export function isFresh(job: Pick<PbrJob, 'outDir' | 'hash'>): boolean {
  const info = readInfo(job.outDir)
  return !!info && info.hash === job.hash && !!info.files && Object.keys(info.files).every(f => existsSync(join(job.outDir, f)))
}

function colourIndex(index: Uint8Array | Int32Array, w: number, h: number, palette: (i: number) => [number, number, number] | null): Img {
  const o = img(w, h, 3)
  for (let p = 0; p < w * h; p++) {
    const c = palette(index[p]!)
    if (!c) continue
    o.d[p * 3] = c[0] / 255
    o.d[p * 3 + 1] = c[1] / 255
    o.d[p * 3 + 2] = c[2] / 255
  }
  return o
}

/** A fixed, distinct colour per cluster index (HSV around the wheel, as DETAIL's cluster view). */
export function clusterColour(i: number): [number, number, number] {
  const hue = ((i * 0.618034) % 1) * 6
  const f = hue - Math.floor(hue), v = 242, s = 0.7
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f))
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][Math.floor(hue) % 6]!
  return rgb.map(Math.round) as [number, number, number]
}

export async function runJob(job: PbrJob): Promise<PbrJobResult> {
  const t0 = performance.now()
  const base = { key: job.key, outDir: job.outDir, inputKind: job.inputKind }
  if (!job.force && isFresh(job)) return { ...base, skipped: true, ms: 0 }
  const albedo = await readImage(job.input)
  const islands = job.uv && job.uv.length >= 6 ? rasterIslands(job.uv, albedo.w, albedo.h) : null
  const r = derive({ meta: job.meta, albedo, islands, override: job.override, options: job.options, previewEdge: job.previewEdge })
  mkdirSync(job.outDir, { recursive: true })
  const files: Record<string, number> = {}
  const { w, h } = r.albedo
  const put = (name: string, bytes: Uint8Array) => {
    writeFileSync(join(job.outDir, name), bytes)
    files[name] = bytes.length
  }
  const alphaOut = job.meta.alpha === 'cutout' || job.meta.alpha === 'blend'
  put('albedo.png', encodePng(r.albedo, 8, alphaOut ? [0, 1, 2, 3] : [0, 1, 2]))
  put('normal.png', encodePng(normalToRgb(r.normal), 16))
  put('ormh.png', encodePng(r.ormh, 16))
  if (r.classMask) {
    files['mask.png'] = writeBytesPng(join(job.outDir, 'mask.png'), r.classMask, w, h)
    put('mask_view.png', encodePng(colourIndex(r.classMask, w, h, i => (i < MASK_CLASSES.length ? MASK_COLOURS[MASK_CLASSES[i]!]! : null)), 8))
  }
  if (r.clusters) {
    const [cw, ch] = r.clusters.size
    put('clusters.png', encodePng(colourIndex(r.clusters.ids, cw, ch, i => (i >= 0 ? clusterColour(i) : null)), 8))
  }
  if (r.lit) put('lit.png', encodePng(r.lit, 8, [0, 1, 2]))
  if (r.wet) put('wet.png', encodePng(r.wet, 8, [0, 1, 2]))
  const ms = Math.round(performance.now() - t0)
  const info = { ...r.info, hash: job.hash, input: job.input, inputKind: job.inputKind, files, totalMs: ms, createdAt: new Date().toISOString() }
  const tmp = join(job.outDir, 'pbr.json.tmp')
  writeFileSync(tmp, JSON.stringify(info, null, 1))
  renameSync(tmp, join(job.outDir, 'pbr.json'))
  return { ...base, skipped: false, info: r.info, files, ms }
}


