/**
 * TP-E review page (docs/TEXPIPE.md §3.8, docs/WAVE_PLAN3.md §7.1 TP-E): `work/texpipe/review/index.html`, a local
 * page with one card per texture of a batch:
 *
 *   - a before/after slider: the retail texture (nearest, as the game shows it today) against the remaster's lit or
 *     wet preview, its albedo or the upscale, with 1×/2×/4× zoom;
 *   - the stages side by side: retail | upscaled | albedo | normal | AO/rough/metal | height | lit | wet (| material
 *     mask | clusters). The normal, ORM and height panels are rebuilt from the WebP planes that ship, so codec damage
 *     shows here;
 *   - the facts: class, alpha, wrap axes, hero, the upscale model and mix, seams, the TP-P profile, the tiers with
 *     their bytes and the rebuilt-normal error;
 *   - a status marker (auto, ok, albedo-only, retail) with buttons.
 *
 * Marking a status writes `content/texpipe/overrides.json` when the page is served by `pnpm texpipe review --serve`
 * (a small HTTP server on 127.0.0.1 only, which accepts only same-origin status edits for the batch's keys). Opened
 * as a file, the page keeps the marks in the browser and exports the whole overrides file for the reviewer to save.
 * A status reaches the index on the next `pnpm texpipe encode` (or `run`).
 *
 * The page and its images (`review/img/<keyPath>/`) hold retail art: they stay on this PC, under git-ignored work/,
 * and are never published (D43). Node only.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'
import sharp, { type OverlayOptions, type Sharp } from 'sharp'
import { readEncodeReport, type EncodeReport } from './encode.ts'
import {
  keyPath, NORMAL_PLANE_SCALE, NORMAL_PLANE_ZERO, normalZ, OVERRIDES_FORMAT, OVERRIDES_VERSION, PBR_STATUSES, validateOverrides,
  type PbrIndex, type PbrSet, type PbrStatus, type TexpipeOverrides,
} from './format.ts'
import type { InventoryEntry } from './inventory.ts'
import { writeAtomic } from './upscale/cache.ts'
import type { RawImage } from './upscale/pad.ts'
import { loadSource } from './upscale/runner.ts'

/** The statuses a reviewer can set on the page (`replaced` needs a gen: set, which the review cannot make). */
export const REVIEW_STATUSES: readonly PbrStatus[] = ['auto', 'ok', 'albedo-only', 'retail']
/** Longest edge of the page's preview images. */
export const PREVIEW_EDGE = 1024
export const DEFAULT_REVIEW_PORT = 5190
const NOTE_MAX = 500

export function reviewPaths(texpipeDir: string) {
  const dir = join(texpipeDir, 'review')
  return { dir, page: join(dir, 'index.html'), img: join(dir, 'img') }
}

// ---- overrides edits (pure) -------------------------------------------------------------------------------------------

export interface ReviewEdit {
  status?: PbrStatus
  /** '' removes the note. */
  note?: string
}

/**
 * The overrides with one texture's review edit applied: `auto` removes the status (auto is the default), an empty
 * note removes the note, and an entry left empty is removed. Throws when the result would not validate.
 */
export function applyReviewEdit(o: TexpipeOverrides | null, key: string, edit: ReviewEdit): TexpipeOverrides {
  const out: TexpipeOverrides = o ? structuredClone(o) : { format: OVERRIDES_FORMAT, version: OVERRIDES_VERSION, sets: {} }
  const cur = { ...(out.sets[key] ?? {}) }
  if (edit.status !== undefined) {
    if (!REVIEW_STATUSES.includes(edit.status)) throw new Error(`status must be one of ${REVIEW_STATUSES.join(', ')}`)
    if (edit.status === 'auto') delete cur.status
    else cur.status = edit.status
  }
  if (edit.note !== undefined) {
    const note = edit.note.trim().slice(0, NOTE_MAX)
    if (note) cur.note = note
    else delete cur.note
  }
  if (Object.keys(cur).length) out.sets[key] = cur
  else delete out.sets[key]
  const errors = validateOverrides(out)
  if (errors.length) throw new Error(errors.join('; '))
  return out
}

/** One line: `{ "k": v, ... }` / `[a, b]` / a JSON scalar. */
function oneLine(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`
  if (v !== null && typeof v === 'object') {
    const e = Object.entries(v)
    return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(', ')} }` : '{}'
  }
  return JSON.stringify(v)
}

/** Nesting height: 0 for a scalar, 1 + the deepest child for a container. */
function nestHeight(v: unknown): number {
  return v !== null && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v).map(nestHeight)) : 0
}

function houseStyle(v: unknown, indent: number, depth: number): string {
  // A row's fields (depth 3+) stay on one line unless they nest deeper than an object of lists (a maskPaint list).
  if (v === null || typeof v !== 'object' || (depth >= 3 && nestHeight(v) <= 2)) return oneLine(v)
  const pad = ' '.repeat(indent)
  if (Array.isArray(v)) return `[\n${v.map(x => `${pad}  ${houseStyle(x, indent + 2, depth + 1)}`).join(',\n')}\n${pad}]`
  const e = Object.entries(v)
  if (!e.length) return '{}'
  return `{\n${e.map(([k, x]) => `${pad}  ${JSON.stringify(k)}: ${houseStyle(x, indent + 2, depth + 1)}`).join(',\n')}\n${pad}}`
}

/**
 * The overrides file as the repo keeps it: 2-space JSON with one row per set, each field on its own line and a field's
 * small object or list on one line (`"pbr": { "normalScale": 0.35, "aoScale": 0.4 }`), a trailing newline. Every
 * writer (the review server, `texpipe hero`, `merge-rows`) uses it, so an edit diffs as the rows it touched.
 */
export function formatOverrides(o: TexpipeOverrides): string {
  return `${houseStyle(o, 0, 0)}\n`
}

// ---- terrain gates (TERRAIN_TEX §3.2, WAVE_PLAN8 §2.5) ------------------------------------------------------------

/**
 * The painterly ground rule's three gates for a terrain tile, compared against retail (the only reference of what
 * "painterly SRO" means):
 *
 *   1. grain retention ≥ 60 %: the fine-detail energy `mean |L − G(L)|` of the 512 tier's albedo over the retail
 *      tile's, where L is the Rec. 601 luma of the sRGB bytes at 512² (retail resized with Lanczos3 when it is not
 *      512² already) and G an exact separable Gaussian of σ 1.5 px that wraps on both axes (tiles are seamless). This
 *      is the one pinned implementation (TERRAIN_TEX F11: the prototype's blur and PIL's moved the numbers by up to
 *      10 points); `terrain-gates.test.ts` pins it on synthetic tiles.
 *   2. colour lock: the albedo's mean luma within ±3 levels of retail and each channel mean within ±4.
 *   3. in game: the mean luma of the tile's spot crop at Medium noon at most 3 levels darker than today's shot (the AO
 *      check), measured from the review shots (`terrain/ingame.json`).
 *
 * A tile that fails stays `auto` and keeps a note; the fallback steps are `nextGrainStep` (aiMix 0.5 → 0.3 → the
 * `retail` route) and `nextAoStep` (aoScale − 0.1).
 */
export const TERRAIN_GATES = {
  /** The tier the grain and colour gates read (Medium's albedo tier). */
  size: 512,
  sigma: 1.5,
  grainMin: 0.6,
  lumMax: 3,
  channelMax: 4,
  /** In game: the remaster may be at most this many levels darker than today (brighter is not gated). */
  inGameMin: -3,
} as const

/** Tiles exempt from the colour lock, with the reason (TERRAIN_TEX §3.2: P-LOOK's intended golden sand tint). */
export const COLOUR_EXEMPT: Readonly<Record<string, string>> = {
  'tile2d:asiaminor_sand_01': "P-LOOK's golden sand grade (albedoTint)",
  'tile2d:asiaminor_sand_02': "P-LOOK's golden sand grade (albedoTint)",
  'tile2d:oaho_dust_earth01': "COAST §7.2's wet sand (albedoGain 0.65)",
}

/** Rec. 601 luma (the weights PIL's `convert('L')` uses) of RGB(A) bytes, as floats 0..255. */
export function lumaOf(img: RawImage): Float32Array {
  const n = img.width * img.height
  const out = new Float32Array(n)
  const c = img.channels
  for (let p = 0; p < n; p++) {
    const i = p * c
    out[p] = c >= 3 ? 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]! : img.data[i]!
  }
  return out
}

/** The normalised Gaussian kernel of σ (radius ⌈3σ⌉). */
export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i]! /= sum
  return k
}

/** A separable Gaussian blur of a w×h plane that wraps on both axes. */
export function gaussianWrap(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const k = gaussianKernel(sigma)
  const r = (k.length - 1) / 2
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let i = -r; i <= r; i++) v += k[i + r]! * src[row + (((x + i) % w) + w) % w]!
      tmp[row + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let i = -r; i <= r; i++) v += k[i + r]! * tmp[((((y + i) % h) + h) % h) * w + x]!
      out[y * w + x] = v
    }
  }
  return out
}

/** The fine-detail energy `mean |L − G_σ(L)|` of an image's luma (levels). */
export function fineEnergy(img: RawImage, sigma: number = TERRAIN_GATES.sigma): number {
  const l = lumaOf(img)
  const b = gaussianWrap(l, img.width, img.height, sigma)
  let sum = 0
  for (let p = 0; p < l.length; p++) sum += Math.abs(l[p]! - b[p]!)
  return sum / (l.length || 1)
}

export interface ColourStats {
  /** Mean Rec. 601 luma, 0..255. */
  lum: number
  /** Mean of each channel, 0..255. */
  rgb: [number, number, number]
}

export function colourStats(img: RawImage): ColourStats {
  const n = img.width * img.height
  const c = img.channels
  const acc = [0, 0, 0]
  for (let p = 0; p < n; p++) for (let k = 0; k < 3; k++) acc[k]! += img.data[p * c + Math.min(k, c - 1)]!
  const rgb = acc.map(v => v / (n || 1)) as [number, number, number]
  return { lum: 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2], rgb }
}

export interface InGameGate {
  /** Where the crop was taken (the spot name or `/tp x z`). */
  spot: string
  today: number
  remaster: number
  delta: number
  pass: boolean
}

export interface TerrainGates {
  /** Grain retention, remaster ÷ retail (1 = all of retail's fine-detail energy). */
  grain: number
  grainPass: boolean
  /** Albedo mean luma and channel deltas, remaster − retail (levels). */
  dLum: number
  dRgb: [number, number, number]
  colourPass: boolean
  /** Why the colour lock does not apply (it then passes). */
  colourExempt?: string
  inGame?: InGameGate
  /** Every gate that ran passed. */
  pass: boolean
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

/** The in-game gate on two crop means (levels): the remaster may be at most 3 levels darker than today. */
export function inGameGate(spot: string, today: number, remaster: number): InGameGate {
  const delta = round(remaster - today)
  return { spot, today: round(today), remaster: round(remaster), delta, pass: delta >= TERRAIN_GATES.inGameMin }
}

/** Gates 1 and 2 (and 3 when given) on the retail tile and the 512 tier's albedo, both at TERRAIN_GATES.size². */
export function terrainGatesOf(key: string, retail: RawImage, tier: RawImage, inGame?: InGameGate): TerrainGates {
  if (retail.width !== tier.width || retail.height !== tier.height) {
    throw new Error(`terrain gates: retail ${retail.width}x${retail.height} vs tier ${tier.width}x${tier.height}`)
  }
  const er = fineEnergy(retail)
  const grain = round(er > 0 ? fineEnergy(tier) / er : 1, 3)
  const a = colourStats(retail), b = colourStats(tier)
  const dLum = round(b.lum - a.lum)
  const dRgb = b.rgb.map((v, k) => round(v - a.rgb[k]!)) as [number, number, number]
  const colourExempt = COLOUR_EXEMPT[key]
  const colourPass = colourExempt !== undefined || (Math.abs(dLum) <= TERRAIN_GATES.lumMax && dRgb.every(d => Math.abs(d) <= TERRAIN_GATES.channelMax))
  const grainPass = grain >= TERRAIN_GATES.grainMin
  const g: TerrainGates = { grain, grainPass, dLum, dRgb, colourPass, pass: grainPass && colourPass && (inGame?.pass ?? true) }
  if (colourExempt) g.colourExempt = colourExempt
  if (inGame) g.inGame = inGame
  return g
}

/** An image file as RGB bytes at size² (Lanczos3 when it is another size). */
export async function rgbAt(file: string, size: number): Promise<RawImage> {
  const bytes = readFileSync(file)
  const meta = await sharp(bytes).metadata()
  let s = sharp(bytes).removeAlpha()
  if (meta.width !== size || meta.height !== size) s = s.resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
  const { data, info } = await s.toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, channels: info.channels }
}

/** The file of a set's albedo at the gate tier (`tiers['512']`), or null. */
export function gateTierFile(set: PbrSet | undefined, pbrDir: string): string | null {
  const t = set?.tiers[String(TERRAIN_GATES.size)]
  return t ? join(pbrDir, t.albedo) : null
}

/** Gates 1 and 2 of a tile set from its files (retail decode + the 512 tier), with gate 3 when its shot means exist. */
export async function terrainGates(key: string, retailFile: string, tierFile: string, inGame?: InGameGate): Promise<TerrainGates> {
  const [retail, tier] = await Promise.all([rgbAt(retailFile, TERRAIN_GATES.size), rgbAt(tierFile, TERRAIN_GATES.size)])
  return terrainGatesOf(key, retail, tier, inGame)
}

/** The route of a tile through the grain gate's fallback steps. */
export interface GrainRoute {
  detail: 'gan' | 'sdxl' | 'retail'
  /** The TP-U AI share (unused on the retail route). */
  aiMix: number
}

/**
 * The grain gate's next step after a fail (TERRAIN_TEX §3.2): an SDXL route falls back to the GAN route with the
 * painterly mix 0.5; on the GAN route aiMix steps down the ladder 0.5 → 0.3; then the `retail` route (Lanczos3 ×4, no
 * AI). null: no step left (the tile ships on the retail route, which is a pass at its gate's fallback).
 */
export function nextGrainStep(cur: GrainRoute): GrainRoute | null {
  if (cur.detail === 'retail') return null
  if (cur.detail === 'sdxl') return { detail: 'gan', aiMix: Math.min(cur.aiMix, 0.5) }
  if (cur.aiMix > 0.5 + 1e-9) return { detail: 'gan', aiMix: 0.5 }
  if (cur.aiMix > 0.3 + 1e-9) return { detail: 'gan', aiMix: 0.3 }
  return { detail: 'retail', aiMix: 0 }
}

/** The in-game gate's next step after a fail: aoScale − 0.1, then 0; null once it is 0 (nothing left to take out). */
export function nextAoStep(aoScale: number): number | null {
  if (aoScale <= 1e-9) return null
  const next = Math.round((aoScale - 0.1) * 100) / 100
  return next < 0.05 ? 0 : next
}

/** One line per tile for the CLI and the notes: `grain 64% ok, Δlum +1.2 (+0.9/+1.4/+0.6) ok, in game −1.0 ok`. */
export function formatGates(g: TerrainGates): string {
  const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`
  const parts = [
    `grain ${Math.round(g.grain * 100)}% ${g.grainPass ? 'ok' : 'FAIL'}`,
    `Δlum ${sg(g.dLum)} (${g.dRgb.map(sg).join('/')}) ${g.colourExempt ? 'exempt' : g.colourPass ? 'ok' : 'FAIL'}`,
  ]
  if (g.inGame) parts.push(`in game ${sg(g.inGame.delta)} ${g.inGame.pass ? 'ok' : 'FAIL'}`)
  return parts.join(', ')
}

/** `work/texpipe/review/terrain/`: the tile sheets, `gates.json` and the in-game crop means (`ingame.json`). */
export function terrainReviewPaths(texpipeDir: string) {
  const dir = join(reviewPaths(texpipeDir).dir, 'terrain')
  return { dir, gates: join(dir, 'gates.json'), inGame: join(dir, 'ingame.json'), sheet: (stem: string) => join(dir, `${stem}.png`) }
}

/** `ingame.json`: key → the spot and its two crop means (written from the in-game review shots). */
export type InGameFile = Record<string, { spot: string; today: number; remaster: number }>

export function readInGame(texpipeDir: string): InGameFile {
  return readJson<InGameFile>(terrainReviewPaths(texpipeDir).inGame) ?? {}
}

// ---- the terrain sheet (TERRAIN_TEX §2.4) -----------------------------------------------------------------------------

/** Panel edge of the terrain sheet (px). */
export const SHEET_PANEL = 384
/** The sheet's crop: the tile's top-left quarter on each axis (2 m × 2 m of an 8 m repeat). */
const SHEET_CROP = 0.25

async function sheetPanel(file: string, nearest: boolean): Promise<Buffer | null> {
  if (!existsSync(file)) return null
  const bytes = readFileSync(file)
  const meta = await sharp(bytes).metadata()
  const cw = Math.max(1, Math.round(meta.width! * SHEET_CROP)), ch = Math.max(1, Math.round(meta.height! * SHEET_CROP))
  return sharp(bytes).removeAlpha().extract({ left: 0, top: 0, width: cw, height: ch })
    .resize(SHEET_PANEL, SHEET_PANEL, { fit: 'fill', kernel: nearest ? 'nearest' : 'lanczos3' }).png().toBuffer()
}

/** The 3×3 repeat (24 m) of a tile image, fitted into one panel: motifs that repeat every 8 m show here. */
async function repeatPanel(file: string): Promise<Buffer | null> {
  if (!existsSync(file)) return null
  const { data, info } = await sharp(readFileSync(file)).removeAlpha()
    .resize(SHEET_PANEL, SHEET_PANEL, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true })
  const n = info.width
  const out = Buffer.alloc(n * 3 * n * 3 * 3)
  for (let ty = 0; ty < 3; ty++) for (let y = 0; y < n; y++) for (let tx = 0; tx < 3; tx++) {
    data.copy(out, ((ty * n + y) * n * 3 + tx * n) * 3, y * n * 3, (y + 1) * n * 3)
  }
  return sharp(out, { raw: { width: n * 3, height: n * 3, channels: 3 } }).resize(SHEET_PANEL, SHEET_PANEL, { kernel: 'lanczos3' }).png().toBuffer()
}

const svgEsc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export interface TerrainSheetInput {
  key: string
  /** The retail decode (512²). */
  retail: string
  /** TP-U's master (the mixed upscale) and the TP-P albedo master (de-lit, the rule applied). */
  up?: string | null
  albedo?: string | null
  /** The shipped tiers: Medium's 512, High's 1024. */
  tier512?: string | null
  tier1024?: string | null
  gates?: TerrainGates | null
  /** One line under the title (route, mix, maps). */
  caption?: string
}

/**
 * The terrain sheet of one tile (TERRAIN_TEX §2.4): retail | upscale | albedo master | 512 tier (Medium) | 1024 tier
 * (High), each the same 2 m × 2 m corner (retail and the 512 tier nearest, as the GPU magnifies them up close), then
 * the 512 tier's 3×3 repeat (24 m) and the retail's, with the gates in the title. Returns the PNG.
 */
export async function terrainSheet(inp: TerrainSheetInput): Promise<Buffer> {
  const cols: Array<[string, Buffer | null]> = [
    ['retail', await sheetPanel(inp.retail, true)],
    ['upscale (TP-U)', inp.up ? await sheetPanel(inp.up, false) : null],
    ['albedo master', inp.albedo ? await sheetPanel(inp.albedo, false) : null],
    ['512 tier (Medium)', inp.tier512 ? await sheetPanel(inp.tier512, true) : null],
    ['1024 tier (High)', inp.tier1024 ? await sheetPanel(inp.tier1024, false) : null],
    ['512 tier 3×3 (24 m)', inp.tier512 ? await repeatPanel(inp.tier512) : null],
    ['retail 3×3', await repeatPanel(inp.retail)],
  ]
  const pad = 8, head = 46, label = 20
  const W = pad + cols.length * (SHEET_PANEL + pad), H = head + label + SHEET_PANEL + pad
  const title = `${inp.key}${inp.gates ? `   ${formatGates(inp.gates)}` : ''}`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<style>text{font-family:Segoe UI,Arial,sans-serif;fill:#e8e6e3}</style>
<text x="${pad}" y="20" font-size="16" font-weight="600">${svgEsc(title)}</text>
<text x="${pad}" y="39" font-size="13" style="fill:#9a9894">${svgEsc(inp.caption ?? '')}</text>
${cols.map(([name], i) => `<text x="${pad + i * (SHEET_PANEL + pad)}" y="${head + 14}" font-size="13">${svgEsc(name)}</text>`).join('\n')}
</svg>`
  const layers: OverlayOptions[] = [{ input: Buffer.from(svg), left: 0, top: 0 }]
  cols.forEach(([, buf], i) => {
    if (buf) layers.push({ input: buf, left: pad + i * (SHEET_PANEL + pad), top: head + label })
  })
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 24, g: 24, b: 24 } } }).composite(layers).png().toBuffer()
}

// ---- preview images ---------------------------------------------------------------------------------------------------

/** True when `dst` exists and is at least as new as every source. */
function fresh(dst: string, sources: readonly string[]): boolean {
  if (!existsSync(dst)) return false
  const t = statSync(dst).mtimeMs
  return sources.every(s => existsSync(s) && statSync(s).mtimeMs <= t)
}

const fit = (s: Sharp) => s.resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })

async function previewOf(src: string, dst: string, opts: { alpha?: boolean; nearest?: boolean } = {}): Promise<boolean> {
  if (!existsSync(src)) return false
  if (fresh(dst, [src])) return true
  let s = sharp(readFileSync(src))
  s = opts.alpha ? s.ensureAlpha() : s.removeAlpha()
  s = opts.nearest ? s.resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: 'inside', withoutEnlargement: true, kernel: 'nearest' }) : fit(s)
  await s.toColourspace('srgb').webp({ quality: 85, alphaQuality: 90 }).toFile(dst)
  return true
}

async function greyPlane(file: string): Promise<{ w: number; h: number; data: Uint8Array }> {
  const { data, info } = await sharp(readFileSync(file)).removeAlpha().extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }
}

/** The shipped normal planes of a tier rebuilt as an RGB normal map (n · 0.5 + 0.5). */
async function normalPreview(nx: string, ny: string, dst: string): Promise<boolean> {
  if (!existsSync(nx) || !existsSync(ny)) return false
  if (fresh(dst, [nx, ny])) return true
  const [x, y] = await Promise.all([greyPlane(nx), greyPlane(ny)])
  const rgb = new Uint8Array(x.w * x.h * 3)
  for (let p = 0; p < x.w * x.h; p++) {
    const vx = (x.data[p]! - NORMAL_PLANE_ZERO) / NORMAL_PLANE_SCALE, vy = (y.data[p]! - NORMAL_PLANE_ZERO) / NORMAL_PLANE_SCALE
    rgb[p * 3] = x.data[p]!
    rgb[p * 3 + 1] = y.data[p]!
    rgb[p * 3 + 2] = Math.round((normalZ(vx, vy) * 0.5 + 0.5) * 255)
  }
  await fit(sharp(Buffer.from(rgb.buffer), { raw: { width: x.w, height: x.h, channels: 3 } })).webp({ quality: 90 }).toFile(dst)
  return true
}

/** The shipped ao/rough/metal planes as one RGB image (a missing metal plane is 0). */
async function ormPreview(ao: string, rough: string, metal: string | null, dst: string): Promise<boolean> {
  if (!existsSync(ao) || !existsSync(rough)) return false
  const srcs = metal ? [ao, rough, metal] : [ao, rough]
  if (fresh(dst, srcs)) return true
  const planes = await Promise.all(srcs.map(greyPlane))
  const { w, h } = planes[0]!
  const rgb = new Uint8Array(w * h * 3)
  for (let p = 0; p < w * h; p++) for (let k = 0; k < 3; k++) rgb[p * 3 + k] = planes[k]?.data[p] ?? 0
  await fit(sharp(Buffer.from(rgb.buffer), { raw: { width: w, height: h, channels: 3 } })).webp({ quality: 90 }).toFile(dst)
  return true
}

// ---- cards ------------------------------------------------------------------------------------------------------------

export const PANELS = ['retail', 'up', 'albedo', 'normal', 'orm', 'height', 'lit', 'wet', 'mask', 'clusters'] as const
export type Panel = (typeof PANELS)[number]
const PANEL_TITLES: Record<Panel, string> = {
  retail: 'retail', up: 'upscaled', albedo: 'albedo (de-lit)', normal: 'normal', orm: 'AO / rough / metal', height: 'height',
  lit: 'lit', wet: 'wet', mask: 'material mask', clusters: 'clusters',
}

export interface ReviewCard {
  key: string
  path: string
  group: string
  class: string
  alpha: string
  wrap: [boolean, boolean]
  hero: boolean
  source: [number, number]
  master: [number, number] | null
  /** The status in overrides.json (what the reviewer set). */
  status: PbrStatus
  /** The status in the index (what the game gets), null when the set is not in the index. */
  indexStatus: PbrStatus | null
  note: string
  up: { model: string; aiMix: number; seams: string } | null
  pbr: { profile?: string; delight?: number; normalStrength?: number; detail?: number; tiny?: boolean; albedoOnly?: boolean; masks?: string; input?: string } | null
  tiers: Array<{ name: string; size: [number, number]; bytes: number; files: number; normal?: { meanDeg: number; p99Deg: number; maxLenErr: number } }>
  ktx2Bytes: number | null
  /** Panel → image URL relative to the page. */
  images: Partial<Record<Panel, string>>
  problems: string[]
  /** Terrain tiles with a 512 tier: the three gates (TERRAIN_TEX §3.2). */
  gates?: TerrainGates | null
  /** Terrain tiles: the tile sheet relative to the page (`terrain/<stem>.png`). */
  sheet?: string | null
}

interface MasterJson {
  size?: [number, number]
  profile?: string
  delight?: number
  normalStrength?: number
  detail?: number
  tiny?: boolean
  albedoOnly?: boolean
  maskShare?: Record<string, number> | null
  inputKind?: string
}

interface UpJson {
  sets?: Record<string, { model?: string; aiMix?: number; wrap?: [boolean, boolean]; seams?: { u: { source: number; out: number }; v: { source: number; out: number } }; file?: string }>
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export interface ReviewOptions {
  /** work/out (retail sources). */
  outDir: string
  /** work/texpipe. */
  texpipeDir: string
  /** work/out/pbr. */
  pbrDir: string
  index: PbrIndex | null
  overrides: TexpipeOverrides | null
  /** The batch name (page title and the export hint). */
  title: string
  /** Terrain: the in-game crop means per tile (default: `review/terrain/ingame.json`). */
  inGame?: InGameFile
  log?: (s: string) => void
}

/** One card's data and its preview images (made when missing or older than their sources). */
async function buildCard(e: InventoryEntry, opts: ReviewOptions, up: UpJson | null): Promise<ReviewCard> {
  const kp = keyPath(e.key)
  const { img } = reviewPaths(opts.texpipeDir)
  const dir = join(img, kp)
  mkdirSync(dir, { recursive: true })
  const masterDir = join(opts.texpipeDir, 'master', kp)
  const info = readJson<MasterJson>(join(masterDir, 'pbr.json'))
  const set: PbrSet | undefined = opts.index?.sets[e.key]
  const ov = opts.overrides?.sets[e.key]
  const report: EncodeReport | null = readEncodeReport(opts.texpipeDir, e.key)
  const problems: string[] = []
  const images: Partial<Record<Panel, string>> = {}
  const url = (name: string) => `img/${kp}/${name}`

  // retail: the lossless decode at its own size (the page scales it up with nearest filtering)
  const retail = join(dir, 'retail.png')
  try {
    const srcFile = join(opts.outDir, e.source.file)
    if (!fresh(retail, [srcFile])) {
      const r = await loadSource(opts.outDir, e)
      await sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.width, height: r.height, channels: r.channels as 1 | 2 | 3 | 4 } }).png().toFile(retail)
    }
    images.retail = url('retail.png')
  } catch (err) {
    problems.push(`retail source: ${(err as Error).message}`)
  }
  const transparent = e.alpha === 'cutout' || e.alpha === 'blend'
  const upRec = up?.sets?.[e.key]
  if (upRec?.file && (await previewOf(join(opts.texpipeDir, 'up', upRec.file), join(dir, 'up.webp'), { alpha: transparent }))) images.up = url('up.webp')
  if (await previewOf(join(masterDir, 'albedo.png'), join(dir, 'albedo.webp'), { alpha: transparent })) images.albedo = url('albedo.webp')
  // the shipped planes of the largest tier
  const topName = set ? Object.keys(set.tiers).sort((a, b) => Number(b) - Number(a))[0] : undefined
  const top = topName ? set!.tiers[topName] : undefined
  const at = (rel: string | undefined) => (rel ? join(opts.pbrDir, rel) : '')
  if (top?.nx && top.ny && (await normalPreview(at(top.nx), at(top.ny), join(dir, 'normal.webp')))) images.normal = url('normal.webp')
  if (top?.ao && top.rough && (await ormPreview(at(top.ao), at(top.rough), top.metal ? at(top.metal) : null, join(dir, 'orm.webp')))) images.orm = url('orm.webp')
  if (top?.height && (await previewOf(at(top.height), join(dir, 'height.webp')))) images.height = url('height.webp')
  if (await previewOf(join(masterDir, 'lit.png'), join(dir, 'lit.webp'))) images.lit = url('lit.webp')
  if (await previewOf(join(masterDir, 'wet.png'), join(dir, 'wet.webp'))) images.wet = url('wet.webp')
  if (await previewOf(join(masterDir, 'mask_view.png'), join(dir, 'mask.webp'))) images.mask = url('mask.webp')
  if (await previewOf(join(masterDir, 'clusters.png'), join(dir, 'clusters.webp'), { nearest: true })) images.clusters = url('clusters.webp')

  const status: PbrStatus = ov?.status ?? 'auto'
  const indexStatus = set?.status ?? null
  if (!info) problems.push(status === 'retail' ? 'no master (status retail: TP-P skips it)' : 'no TP-P master yet (pnpm texpipe pbr)')
  if (!set) problems.push('not in pbr/index.json (pnpm texpipe encode)')
  else if (indexStatus !== status && !(status === 'replaced' && indexStatus === 'retail')) problems.push(`index says ${indexStatus}: run pnpm texpipe encode to apply ${status}`)
  if (info?.tiny) problems.push(`tiny source (${e.size.join('×')}): normals are soft; consider albedo-only`)
  const tiers = report?.tiers.length
    ? report.tiers.map(t => ({ name: t.name, size: t.size, bytes: t.bytes, files: t.files, normal: t.normal }))
    : Object.entries(set?.tiers ?? {}).map(([name, t]) => ({ name, size: t.size, bytes: t.bytes, files: [t.albedo, t.nx, t.ny, t.ao, t.rough, t.metal, t.height].filter(Boolean).length }))
  tiers.sort((a, b) => Number(a.name) - Number(b.name))
  const r2 = (n: number) => n.toFixed(2)
  const seams = upRec?.seams && upRec.wrap
    ? [upRec.wrap[0] ? `U ${r2(upRec.seams.u.source)}→${r2(upRec.seams.u.out)}` : '', upRec.wrap[1] ? `V ${r2(upRec.seams.v.source)}→${r2(upRec.seams.v.out)}` : ''].filter(Boolean).join(', ')
    : ''
  // Terrain tiles: the three gates on the card, and the tile sheet (TERRAIN_TEX §2.4, §3.2).
  let gates: TerrainGates | null = null
  let sheet: string | null = null
  const tier512 = e.group === 'tile' ? gateTierFile(set, opts.pbrDir) : null
  if (tier512 && existsSync(tier512)) {
    const tp = terrainReviewPaths(opts.texpipeDir)
    const g = opts.inGame?.[e.key]
    try {
      gates = await terrainGates(e.key, join(opts.outDir, e.source.file), tier512, g ? inGameGate(g.spot, g.today, g.remaster) : undefined)
      if (!gates.grainPass) problems.push(`grain gate: ${Math.round(gates.grain * 100)}% < ${TERRAIN_GATES.grainMin * 100}% (next step: aiMix 0.3, then the retail route)`)
      if (!gates.colourPass) problems.push(`colour lock: Δlum ${gates.dLum}, channels ${gates.dRgb.join('/')} (±${TERRAIN_GATES.lumMax} / ±${TERRAIN_GATES.channelMax})`)
      if (gates.inGame && !gates.inGame.pass) problems.push(`in-game gate: ${gates.inGame.delta} levels at ${gates.inGame.spot} (next step: aoScale − 0.1)`)
      const t1024 = set?.tiers['1024']
      const png = await terrainSheet({
        // The retail route derives from the Lanczos3 ×4 of retail: TP-U's master is not its input, so no panel.
        key: e.key, retail: join(opts.outDir, e.source.file), up: upRec?.file && info?.inputKind !== 'retail' ? join(opts.texpipeDir, 'up', upRec.file) : null,
        albedo: join(masterDir, 'albedo.png'), tier512, tier1024: t1024 ? join(opts.pbrDir, t1024.albedo) : null, gates,
        caption: `${e.class}; ${info?.inputKind === 'retail' ? 'the retail route (Lanczos3 ×4)' : upRec ? `${upRec.model ?? '?'} mix ${upRec.aiMix ?? 0}` : 'no TP-U'}; de-light ${info?.delight ?? '?'}, normal ${info?.normalStrength !== undefined ? +info.normalStrength.toFixed(2) : '?'}${ov?.pbr?.aoScale !== undefined ? `, aoScale ${ov.pbr.aoScale}` : ''}${e.hero ? '; hero' : ''}`,
      })
      mkdirSync(tp.dir, { recursive: true })
      writeAtomic(tp.sheet(kp.split('/').pop()!), png)
      sheet = `terrain/${kp.split('/').pop()!}.png`
    } catch (err) {
      problems.push(`terrain gates: ${(err as Error).message}`)
    }
  }
  return {
    key: e.key, path: kp, group: e.group, class: e.class, alpha: e.alpha, wrap: [e.wrap[0], e.wrap[1]], hero: e.hero,
    source: [e.size[0], e.size[1]], master: info?.size ?? null, status, indexStatus, note: ov?.note ?? '',
    up: upRec ? { model: upRec.model ?? '?', aiMix: upRec.aiMix ?? 0, seams } : null,
    pbr: info ? {
      profile: info.profile, delight: info.delight, normalStrength: info.normalStrength, detail: info.detail, tiny: info.tiny, albedoOnly: info.albedoOnly,
      masks: info.maskShare ? Object.entries(info.maskShare).filter(([, v]) => v >= 0.005).map(([c, v]) => `${c} ${Math.round(v * 100)}%`).join(', ') : undefined,
      input: info.inputKind,
    } : null,
    tiers,
    ktx2Bytes: report?.ktx2 ? Object.values(report.ktx2.files).reduce((s, f) => s + f.bytes, 0) : null,
    images, problems, gates, sheet,
  }
}

/** Builds the page for a batch; returns the page path and its cards. */
export async function buildReview(entries: readonly InventoryEntry[], opts: ReviewOptions): Promise<{ file: string; cards: ReviewCard[] }> {
  const paths = reviewPaths(opts.texpipeDir)
  mkdirSync(paths.img, { recursive: true })
  const up = readJson<UpJson>(join(opts.texpipeDir, 'up', 'index.json'))
  const cards: ReviewCard[] = []
  const withShots = { ...opts, inGame: opts.inGame ?? readInGame(opts.texpipeDir) }
  for (const e of entries) {
    cards.push(await buildCard(e, withShots, up))
    opts.log?.(`  review: ${e.key}`)
  }
  // Terrain: the batch's gates as one JSON beside the tile sheets (merged with earlier batches).
  const gated = cards.filter(c => c.gates)
  if (gated.length) {
    const tp = terrainReviewPaths(opts.texpipeDir)
    const prev = readJson<Record<string, TerrainGates>>(tp.gates) ?? {}
    for (const c of gated) prev[c.key] = c.gates!
    const sorted = Object.fromEntries(Object.keys(prev).sort().map(k => [k, prev[k]!]))
    writeAtomic(tp.gates, JSON.stringify(sorted, null, 1))
  }
  const sheets = [
    ['TP-U world sheet', '../sheets/compare_world.png'], ['TP-U actor sheet', '../sheets/compare_actor.png'],
    [`TP-P sheet (${opts.title})`, `../master/_sheets/pbr-${opts.title}.png`],
  ].filter(([, rel]) => existsSync(join(paths.dir, rel!)))
  writeFileSync(paths.page, renderPage(cards, { title: opts.title, overrides: opts.overrides, sheets: sheets as Array<[string, string]>, createdAt: new Date().toISOString() }))
  return { file: paths.page, cards }
}

// ---- the page ---------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** JSON safe inside a <script> element. */
const UNSAFE_IN_SCRIPT = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g')
const scriptJson = (v: unknown) => JSON.stringify(v).replace(UNSAFE_IN_SCRIPT, c => `${String.fromCharCode(92)}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const kb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)

function renderCard(c: ReviewCard, i: number): string {
  const after: Panel[] = (['lit', 'wet', 'albedo', 'up'] as const).filter(p => c.images[p])
  const first = after[0]
  const tags = [
    c.group, c.class, `alpha ${c.alpha}`, `wrap ${c.wrap[0] ? 'U' : '–'}${c.wrap[1] ? 'V' : '–'}`, `${c.source.join('×')} → ${c.master ? c.master.join('×') : '?'}`,
    ...(c.hero ? ['hero'] : []), ...(c.pbr?.tiny ? ['tiny'] : []),
  ].map(t => `<span class="tag${t === 'hero' ? ' hero' : ''}">${esc(t)}</span>`).join('')
  const facts: Array<[string, string]> = []
  if (c.up) facts.push(['upscale', `${c.up.model}, AI mix ${c.up.aiMix}${c.up.seams ? `; seams ${c.up.seams}` : ''}`])
  if (c.pbr) {
    facts.push(['PBR', [c.pbr.profile && `profile ${c.pbr.profile}`, c.pbr.delight !== undefined && `de-light k ${c.pbr.delight}`, c.pbr.normalStrength !== undefined && `normal ${c.pbr.normalStrength}`, c.pbr.detail ? `detail ${c.pbr.detail}` : '', c.pbr.albedoOnly && 'albedo only'].filter(Boolean).join(', ')])
    if (c.pbr.masks) facts.push(['masks', c.pbr.masks])
    if (c.pbr.input) facts.push(['input', c.pbr.input])
  }
  if (c.ktx2Bytes !== null) facts.push(['KTX2', kb(c.ktx2Bytes)])
  if (c.gates) facts.push(['terrain gates', formatGates(c.gates)])
  const tierRows = c.tiers.map(t => `<tr><td>${esc(t.name)}</td><td>${t.size.join('×')}</td><td>${t.files}</td><td>${kb(t.bytes)}</td><td>${t.normal ? `${t.normal.meanDeg.toFixed(2)}° / ${t.normal.p99Deg.toFixed(1)}°` : '–'}</td></tr>`).join('')
  const thumbs = PANELS.filter(p => c.images[p]).map(p => {
    const selectable = after.includes(p)
    return `<figure class="thumb${p === 'retail' || p === 'clusters' ? ' pixel' : ''}"><button type="button" class="thumb-btn" data-panel="${p}" data-src="${esc(c.images[p]!)}"${selectable ? '' : ' data-open="1"'} aria-label="${esc(PANEL_TITLES[p])}"><img loading="lazy" src="${esc(c.images[p]!)}" alt=""></button><figcaption>${esc(PANEL_TITLES[p])}</figcaption></figure>`
  }).join('')
  const compare = c.images.retail && first
    ? `<div class="compare-scroll"><div class="compare" style="aspect-ratio:${c.source[0]} / ${c.source[1]}">
        <img class="before" src="${esc(c.images.retail)}" alt="retail">
        <img class="after" src="${esc(c.images[first]!)}" alt="remaster">
        <div class="divider" aria-hidden="true"></div>
      </div></div>
      <div class="compare-controls">
        <input type="range" class="split" min="0" max="100" value="50" aria-label="Before/after split">
        <label>after <select class="after-pick">${after.map(p => `<option value="${esc(c.images[p]!)}">${esc(PANEL_TITLES[p])}</option>`).join('')}</select></label>
        <label>zoom <select class="zoom"><option value="1">fit</option><option value="2">2×</option><option value="4">4×</option></select></label>
      </div>
      <div class="legend"><span>◀ retail</span><span>remaster ▶</span></div>`
    : `<div class="empty">Nothing to compare yet (${esc(c.images.retail ? 'no remaster previews' : 'no retail image')}).</div>`
  const buttons = REVIEW_STATUSES.map(s => `<button type="button" class="st" data-set-status="${s}" aria-pressed="${s === c.status}">${esc(s)}</button>`).join('')
  return `<article class="card" id="t${i}" data-key="${esc(c.key)}" data-group="${esc(c.group)}" data-status="${esc(c.status)}">
  <header class="card-head">
    <span class="pill" data-pill>${esc(c.status)}</span>
    <h2><code>${esc(c.key)}</code></h2>
    <div class="tags">${tags}</div>
  </header>
  <div class="card-body">
    <div class="compare-col">${compare}</div>
    <div class="side">
      <div class="thumbs">${thumbs}</div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${c.sheet ? `<p class="muted"><a class="sheet-link" href="${esc(c.sheet)}" target="_blank" rel="noopener">terrain sheet: retail, masters, 512 / 1024 tiers, 3×3 repeat</a></p>` : ''}
      ${c.tiers.length ? `<table class="tiers"><thead><tr><th>tier</th><th>size</th><th>files</th><th>bytes</th><th>normal mean / p99</th></tr></thead><tbody>${tierRows}</tbody></table>` : '<p class="muted">No tiers: the game keeps the retail texture.</p>'}
      <div class="status-row" role="group" aria-label="Review status">${buttons}</div>
      <label class="note-row">note <input type="text" class="note" maxlength="${NOTE_MAX}" value="${esc(c.note)}" placeholder="optional, saved with the status"></label>
      <p class="index-state" data-index-state>${c.indexStatus ? `index: ${esc(c.indexStatus)}` : 'index: not written'}</p>
      ${c.problems.length ? `<ul class="problems">${c.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    </div>
  </div>
</article>`
}

export function renderPage(cards: readonly ReviewCard[], opts: { title: string; overrides: TexpipeOverrides | null; sheets: ReadonlyArray<[string, string]>; createdAt: string }): string {
  const groups = [...new Set(cards.map(c => c.group))].sort()
  const data = {
    title: opts.title, createdAt: opts.createdAt,
    overrides: opts.overrides ?? { format: OVERRIDES_FORMAT, version: OVERRIDES_VERSION, sets: {} },
    cards: cards.map(c => ({ key: c.key, status: c.status, note: c.note, indexStatus: c.indexStatus })),
    statuses: REVIEW_STATUSES, allStatuses: PBR_STATUSES,
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Texture review</title>
<style>
:root {
  --bg: #161616; --panel: #202020; --panel-2: #2a2a2a; --line: #3a3a3a; --text: #e8e6e3; --muted: #9a9894;
  --accent: #d9a441; --ok: #4caf7a; --warn: #d9a441; --bad: #d06050; --auto: #7d8590; --replaced: #9a7bd0;
  --check-a: #3a3a3a; --check-b: #2c2c2c;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header.top { position: sticky; top: 0; z-index: 5; background: rgba(22,22,22,.96); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
header.top h1 { font-size: 17px; margin: 0; font-weight: 600; }
.counts { display: flex; gap: 6px; flex-wrap: wrap; }
.counts .pill { cursor: default; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto; }
select, input[type=text], button { font: inherit; color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
button { cursor: pointer; }
button:hover { border-color: #5a5a5a; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mode { color: var(--muted); font-size: 12px; }
.mode.server { color: var(--ok); }
main { padding: 16px; display: grid; gap: 16px; max-width: 1500px; margin: 0 auto; }
.sheets { color: var(--muted); font-size: 13px; }
.sheets a { color: var(--accent); margin-right: 12px; }
.sheet-link { color: var(--accent); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.card[hidden] { display: none; }
.card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.card-head h2 { margin: 0; font-size: 14px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { font-size: 12px; color: var(--muted); background: var(--panel-2); border-radius: 4px; padding: 1px 6px; }
.tag.hero { color: #1a1a1a; background: var(--accent); }
.pill { display: inline-block; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 2px 10px; color: #111; background: var(--auto); white-space: nowrap; }
.pill[data-s=ok] { background: var(--ok); }
.pill[data-s=albedo-only] { background: var(--warn); }
.pill[data-s=retail] { background: var(--bad); }
.pill[data-s=replaced] { background: var(--replaced); }
.pill.dirty::after { content: " •"; }
.card-body { display: grid; grid-template-columns: minmax(0, 520px) minmax(0, 1fr); gap: 14px; padding: 14px; }
@media (max-width: 900px) { .card-body { grid-template-columns: minmax(0, 1fr); } }
.compare-col { position: sticky; top: 64px; align-self: start; }
@media (max-width: 900px) { .compare-col { position: static; } }
.compare-scroll { overflow: auto; max-height: 560px; border-radius: 6px; background: repeating-conic-gradient(var(--check-a) 0 25%, var(--check-b) 0 50%) 0 0 / 16px 16px; }
.compare { position: relative; width: 100%; }
.compare img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; display: block; }
.compare img.before { image-rendering: pixelated; }
.compare img.after { clip-path: inset(0 0 0 50%); }
.compare .divider { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: var(--accent); transform: translateX(-1px); pointer-events: none; }
.compare-controls { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 8px; }
.compare-controls .split { flex: 1 1 200px; accent-color: var(--accent); }
.compare-controls label { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 2px; }
.empty { color: var(--muted); padding: 40px 12px; text-align: center; border: 1px dashed var(--line); border-radius: 6px; }
.side { min-width: 0; display: grid; gap: 10px; align-content: start; }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
.thumb { margin: 0; }
.thumb-btn { padding: 0; width: 100%; aspect-ratio: 1; display: block; overflow: hidden; border-radius: 6px; background: repeating-conic-gradient(var(--check-a) 0 25%, var(--check-b) 0 50%) 0 0 / 12px 12px; }
.thumb-btn img { width: 100%; height: 100%; object-fit: contain; display: block; }
.thumb.pixel img { image-rendering: pixelated; }
.thumb-btn[aria-current=true] { border-color: var(--accent); }
.thumb figcaption { font-size: 11px; color: var(--muted); text-align: center; margin-top: 2px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.tiers { border-collapse: collapse; font-size: 13px; width: 100%; font-variant-numeric: tabular-nums; }
.tiers th, .tiers td { text-align: left; padding: 3px 8px 3px 0; border-bottom: 1px solid var(--line); }
.tiers th { color: var(--muted); font-weight: 500; }
.status-row { display: flex; gap: 6px; flex-wrap: wrap; }
.st[aria-pressed=true] { background: var(--text); color: #111; border-color: var(--text); font-weight: 600; }
.note-row { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
.note-row input { flex: 1; min-width: 0; }
.index-state { margin: 0; color: var(--muted); font-size: 12px; }
.problems { margin: 0; padding-left: 18px; color: var(--warn); font-size: 12px; }
.muted { color: var(--muted); margin: 0; }
dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 10px; max-width: min(92vw, 820px); }
dialog pre { max-height: 50vh; overflow: auto; background: var(--bg); padding: 8px; border-radius: 6px; font-size: 12px; }
dialog img { max-width: 100%; max-height: 80vh; display: block; margin: 0 auto; }
dialog.viewer { padding: 8px; }
.toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: 1; }
</style>
</head>
<body>
<header class="top">
  <h1>Texture review · ${esc(opts.title)}</h1>
  <div class="counts" id="counts"></div>
  <div class="toolbar">
    <label class="mode" for="f-group">group</label>
    <select id="f-group"><option value="">all</option>${groups.map(g => `<option>${esc(g)}</option>`).join('')}</select>
    <label class="mode" for="f-status">status</label>
    <select id="f-status"><option value="">all</option>${PBR_STATUSES.map(s => `<option>${esc(s)}</option>`).join('')}</select>
    <button type="button" id="export">Export overrides.json</button>
    <span class="mode" id="mode">opened as a file: marks stay in this browser until exported</span>
  </div>
</header>
<main>
  <p class="sheets">${cards.length} texture(s), built ${esc(opts.createdAt.replace('T', ' ').slice(0, 16))} UTC. ${opts.sheets.map(([t, h]) => `<a href="${esc(h)}" target="_blank" rel="noopener">${esc(t)}</a>`).join('')}</p>
${cards.map(renderCard).join('\n')}
</main>
<dialog id="export-dlg">
  <p>Save this as <code>content/texpipe/overrides.json</code>, then run <code>pnpm texpipe encode --set ${esc(opts.title)}</code> so the index picks up the statuses.</p>
  <pre id="export-json"></pre>
  <form method="dialog" style="display:flex;gap:8px;justify-content:flex-end"><button type="button" id="dl">Download</button><button type="button" id="copy">Copy</button><button>Close</button></form>
</dialog>
<dialog id="viewer" class="viewer"><form method="dialog"><img id="viewer-img" alt=""><div style="text-align:right;margin-top:6px"><button>Close</button></div></form></dialog>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="data">${scriptJson(data)}</script>
<script>
(() => {
  const DATA = JSON.parse(document.getElementById('data').textContent)
  const STORE = 'sro-texpipe-review:' + DATA.title
  const cards = [...document.querySelectorAll('.card')]
  const byKey = new Map(DATA.cards.map(c => [c.key, c]))
  let server = false
  let overrides = structuredClone(DATA.overrides)
  let local = {}
  try { local = JSON.parse(localStorage.getItem(STORE) || '{}') } catch {}

  const toast = msg => {
    const t = document.getElementById('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.h)
    toast.h = setTimeout(() => t.classList.remove('show'), 2200)
  }
  const statusOf = key => (!server && local[key]?.status) || overrides.sets[key]?.status || 'auto'
  const noteOf = key => (!server && local[key]?.note !== undefined ? local[key].note : overrides.sets[key]?.note) || ''

  function paint() {
    const counts = {}
    for (const card of cards) {
      const key = card.dataset.key, s = statusOf(key)
      counts[s] = (counts[s] || 0) + 1
      card.dataset.status = s
      const pill = card.querySelector('[data-pill]')
      pill.textContent = s
      pill.dataset.s = s
      const idx = byKey.get(key).indexStatus
      pill.classList.toggle('dirty', idx !== s && !(s === 'auto' && idx === null))
      pill.title = idx === s ? 'the index has this status' : 'not in the index yet: run pnpm texpipe encode'
      for (const b of card.querySelectorAll('[data-set-status]')) b.setAttribute('aria-pressed', String(b.dataset.setStatus === s))
      const note = card.querySelector('.note')
      if (note && document.activeElement !== note) note.value = noteOf(key)
    }
    document.getElementById('counts').innerHTML = DATA.allStatuses.filter(s => counts[s]).map(s => '<span class="pill" data-s="' + s + '">' + s + ' ' + counts[s] + '</span>').join('')
    filter()
  }

  function filter() {
    const g = document.getElementById('f-group').value, s = document.getElementById('f-status').value
    for (const card of cards) card.hidden = (g && card.dataset.group !== g) || (s && card.dataset.status !== s)
  }

  function merged() {
    const o = structuredClone(overrides)
    for (const [key, edit] of Object.entries(local)) {
      const cur = { ...(o.sets[key] || {}) }
      if (edit.status !== undefined) { if (edit.status === 'auto') delete cur.status; else cur.status = edit.status }
      if (edit.note !== undefined) { const n = edit.note.trim(); if (n) cur.note = n; else delete cur.note }
      if (Object.keys(cur).length) o.sets[key] = cur; else delete o.sets[key]
    }
    return o
  }

  async function save(key, edit) {
    if (server) {
      try {
        const r = await fetch('/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, ...edit }) })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || r.statusText)
        overrides = j.overrides
        toast('Saved to content/texpipe/overrides.json')
      } catch (e) { toast('Not saved: ' + e.message) }
    } else {
      local[key] = { ...(local[key] || {}), ...edit }
      try { localStorage.setItem(STORE, JSON.stringify(local)) } catch {}
      toast('Marked here; use Export to save it')
    }
    paint()
  }

  for (const card of cards) {
    const key = card.dataset.key
    const after = card.querySelector('img.after'), divider = card.querySelector('.divider'), split = card.querySelector('.split')
    const compare = card.querySelector('.compare')
    if (split) split.addEventListener('input', () => {
      after.style.clipPath = 'inset(0 0 0 ' + split.value + '%)'
      divider.style.left = split.value + '%'
    })
    const pick = card.querySelector('.after-pick')
    if (pick) pick.addEventListener('change', () => { after.src = pick.value })
    const zoom = card.querySelector('.zoom')
    if (zoom) zoom.addEventListener('change', () => { compare.style.width = (Number(zoom.value) * 100) + '%' })
    for (const b of card.querySelectorAll('.thumb-btn')) b.addEventListener('click', () => {
      if (!b.dataset.open && pick) {
        pick.value = b.dataset.src
        after.src = b.dataset.src
        return
      }
      const img = document.getElementById('viewer-img')
      img.src = b.dataset.src
      img.style.imageRendering = b.dataset.panel === 'retail' || b.dataset.panel === 'clusters' ? 'pixelated' : ''
      img.style.minWidth = b.dataset.panel === 'retail' ? 'min(80vw, 768px)' : ''
      document.getElementById('viewer').showModal()
    })
    for (const b of card.querySelectorAll('[data-set-status]')) b.addEventListener('click', () => save(key, { status: b.dataset.setStatus }))
    const note = card.querySelector('.note')
    if (note) note.addEventListener('change', () => save(key, { note: note.value }))
  }
  document.getElementById('f-group').addEventListener('change', filter)
  document.getElementById('f-status').addEventListener('change', filter)
  const json = () => JSON.stringify(server ? overrides : merged(), null, 2) + '\\n'
  document.getElementById('export').addEventListener('click', () => {
    document.getElementById('export-json').textContent = json()
    document.getElementById('export-dlg').showModal()
  })
  document.getElementById('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(json()); toast('Copied') } catch { toast('Copy failed: select the text instead') }
  })
  document.getElementById('dl').addEventListener('click', () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }))
    a.download = 'overrides.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  })

  if (location.protocol.startsWith('http')) {
    fetch('/api/overrides').then(r => (r.ok ? r.json() : Promise.reject())).then(o => {
      server = true
      overrides = o
      const m = document.getElementById('mode')
      m.textContent = 'served: marks save to content/texpipe/overrides.json'
      m.classList.add('server')
      paint()
    }, () => paint())
  } else paint()
})()
</script>
</body>
</html>
`
}

// ---- the local server ---------------------------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.jpg': 'image/jpeg',
}

export interface ReviewServerOptions {
  /** work/texpipe: the server's root (the page is review/index.html, the sheets are ../sheets/). */
  texpipeDir: string
  /** content/texpipe/overrides.json. */
  overridesFile: string
  /** The keys the page may edit. */
  keys: readonly string[]
  /** 0 = any free port. */
  port?: number
  log?: (s: string) => void
}

function readOverridesFile(file: string): TexpipeOverrides {
  if (!existsSync(file)) return { format: OVERRIDES_FORMAT, version: OVERRIDES_VERSION, sets: {} }
  const o = JSON.parse(readFileSync(file, 'utf8')) as TexpipeOverrides
  const errors = validateOverrides(o)
  if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`)
  return o
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, max = 16_384): Promise<string> {
  return new Promise((ok, fail) => {
    let s = ''
    req.setEncoding('utf8')
    req.on('data', (d: string) => {
      s += d
      if (s.length > max) {
        fail(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => ok(s))
    req.on('error', fail)
  })
}

/**
 * Serves the review folder on 127.0.0.1 and saves status edits into overrides.json. Only same-origin JSON POSTs for
 * the batch's keys are accepted (a web page elsewhere cannot write the file). Resolves once listening.
 */
export function serveReview(opts: ReviewServerOptions): Promise<{ server: Server; url: string }> {
  const root = resolve(opts.texpipeDir)
  const keys = new Set(opts.keys)
  let origin = ''
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname === '/api/overrides' && req.method === 'GET') return send(res, 200, readOverridesFile(opts.overridesFile))
      if (u.pathname === '/api/status') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        const o = req.headers.origin
        if (o !== origin && o !== origin.replace('127.0.0.1', 'localhost')) return send(res, 403, { error: 'cross-origin edit refused' })
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
        const body = JSON.parse(await readBody(req)) as { key?: unknown; status?: unknown; note?: unknown }
        if (typeof body.key !== 'string' || !keys.has(body.key)) return send(res, 400, { error: 'unknown key' })
        const edit: ReviewEdit = {}
        if (body.status !== undefined) {
          if (!(REVIEW_STATUSES as readonly unknown[]).includes(body.status)) return send(res, 400, { error: 'bad status' })
          edit.status = body.status as PbrStatus
        }
        if (body.note !== undefined) {
          if (typeof body.note !== 'string') return send(res, 400, { error: 'bad note' })
          edit.note = body.note
        }
        const next = applyReviewEdit(readOverridesFile(opts.overridesFile), body.key, edit)
        writeAtomic(opts.overridesFile, formatOverrides(next))
        opts.log?.(`  ${body.key}: ${edit.status ?? ''}${edit.note !== undefined ? ` note ${JSON.stringify(edit.note)}` : ''}`)
        return send(res, 200, { ok: true, overrides: next })
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' })
      if (u.pathname === '/') {
        res.writeHead(302, { location: '/review/index.html' })
        return res.end()
      }
      const file = normalize(join(root, decodeURIComponent(u.pathname)))
      const rel = relative(root, file)
      const type = TYPES[extname(file).toLowerCase()]
      if (!rel || rel.startsWith('..') || rel.split(sep).includes('..') || !type || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' })
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
      if (req.method === 'HEAD') return res.end()
      createReadStream(file).pipe(res)
    } catch (err) {
      send(res, 500, { error: (err as Error).message })
    }
  })
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(opts.port ?? DEFAULT_REVIEW_PORT, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : opts.port
      origin = `http://127.0.0.1:${port}`
      ok({ server, url: `${origin}/review/index.html` })
    })
  })
}
