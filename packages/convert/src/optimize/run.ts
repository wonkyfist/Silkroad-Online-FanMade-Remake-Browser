/**
 * work/out -> work/out-opt: the same tree, smaller.
 *
 *   char/<c>/<name>.glb     mesh + skin + materials only (animations moved to packs), quantized, WebP textures
 *   char/<c>/<name>.json    the original sidecar plus `animationPacks` (AnimationPackIndex, see anim.ts)
 *   <root>/_anims/<skel>/<group>.glb   animation-only packs shared by every actor on that skeleton
 *                           (root = char, mob, npc: every skinned, animated glb with a sidecar is split this way)
 *   <root>/_anims/<skel>/movement.glb  the movement pack (tools/export-moves.ts, docs/MOVEMENT.md §2.2): already in
 *                           pack format in work/out, so only finished like every pack (lossless meshopt) and checked;
 *                           its index movement.json is copied unchanged
 *   other *.glb             quantized + meshopt (animations kept, lossless) + WebP textures
 *   world/**.png            -> .webp (same path, new extension); JSON and glb extras that name them are rewritten
 *                           (except world/<name>/coast/field.png, a data image copied as PNG)
 *   sky/**.png              -> .webp the same way (export-sky.ts); sky/cloud-noise.png is data: lossless WebP only
 *   everything else         copied unchanged
 *   _decoders/meshopt_decoder.js   the meshopt decoder from node_modules/meshoptimizer (MIT), for Babylon
 *   slim.json               manifest of the pass (renames, packs, loader requirements); slim-report.json: numbers
 *
 * Every written glb is validated (Khronos glTF-Validator) and re-read through the meshopt decoder for the checks:
 * geometry error, texture PSNR/SSIM, and sampled animation equality between each original clip and its pack clip.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, posix } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import type { Document } from '@gltf-transform/core'
import { validateGlb, summarizeIssues } from '../gltf/validate.ts'
import { CONVERT_LOCK_DIR, withConvertLock } from '../world/convert-lock.ts'
import { buildPacks, compareClips, finishPack, sampleChannel, stripAnimations, type AnimationPackIndex, type CharacterSource, type SidecarAnimation } from './anim.ts'
import { CHARACTER_GEOMETRY, WORLD_GEOMETRY, geometryError, optimizeGeometry, type GeometryError, type GeometryOptions, type Pose } from './geometry.ts'
import { gltfIO, fmtMB } from './io.ts'
import { census, COMPRESSIBLE, walkFiles, type Census } from './measure.ts'
import { REVIEW_PSNR, toWebp, type Rung } from './texture.ts'
import { recordOf, texturesToWebp, type TextureRecord } from './textures-doc.ts'

export interface RunOptions {
  inDir: string
  outDir: string
  /** Only process paths starting with one of these prefixes (e.g. ['char/', 'world/']). Default: everything. */
  only?: string[]
  /** Also write .br (brotli q11) next to compressible files. */
  precompress?: boolean
  /** Skip the before/after census (faster re-runs). */
  noCensus?: boolean
  log?: (msg: string) => void
  /** How long to wait for the export's convert lock (default 0: fail at once, naming its owner). */
  lockWaitMs?: number
}

export interface GlbReport {
  rel: string
  inBytes: number
  outBytes: number
  geometry?: GeometryError
  /** False when POSITION stayed float32 (skinned, or mesh nodes with children/animation; see geometry.ts). */
  positionsQuantized: boolean
  validator: { errors: number; warnings: number; issues: string[] }
}

export interface Report {
  generatedAt: string
  inDir: string
  outDir: string
  before?: Census
  after?: Census
  glbs: GlbReport[]
  packs: { rel: string; bytes: number; clips: number; validator: { errors: number; warnings: number; issues: string[] } }[]
  /** Per actor root ('char', 'mob', 'npc'). */
  packStats: Record<string, ReturnType<typeof buildPacks>['stats']>
  animationCheck: { clips: number; channels: number; samples: number; maxDiff: number; failures: string[] }
  textures: (TextureRecord & { file: string })[]
  texturesForReview: (TextureRecord & { file: string })[]
  renamed: number
  rewrittenReferences: number
  summary: Record<string, string | number>
}

/** What the next wave's loaders read from out-opt/slim.json. */
export interface SlimManifest {
  format: 'sro-slim'
  version: 1
  generatedAt: string
  /** Babylon needs these glTF extensions: KHR_mesh_quantization, EXT_meshopt_compression, EXT_texture_webp. */
  extensionsRequired: string[]
  meshoptDecoder: string
  /** Old out-relative path -> new out-relative path (only PNG -> WebP renames under world/ and sky/). */
  renamed: Record<string, string>
  /** Animation packs, out-relative. */
  animationPacks: string[]
}

/** Top-level folders whose skinned, animated glbs (with a sidecar) get animation packs under <root>/_anims/. */
export const ACTOR_ROOTS = ['char', 'mob', 'npc'] as const

/** The movement packs `pnpm sro moves` writes into work/out (docs/MOVEMENT.md §2.2, docs/ASSETS.md §5.3). */
export const MOVEMENT_PACK = /^(?:char|mob|npc)\/_anims\/[^/]+\/movement\.glb$/
/**
 * Never shipped: the movement keyer's working files (work/out/moves/<skel>/: moves.blend and moves_blender.glb hold the
 * retail mesh, plus its measurements). Only the pack and index under char/_anims/ are output. Nor the convert lock's folder
 * (../world/convert-lock.ts), which a run itself holds.
 */
export const NOT_SHIPPED = /^(?:moves\/|\.convert\.lock\/)/

const WORLD_PNG =/^world\/.+\.png$/i
/** Sky images (export-sky.ts, docs/SKY.md §10) become WebP like the world's. */
const SKY_PNG = /^sky\/.+\.png$/i
/**
 * Images that are data, not pictures: the cloud noise's four channels are independent fields (shape, erosion,
 * cirrus, coverage variation). Lossy WebP q90 moved them by up to 23/255 and its 4:2:0 coding mixes them, which
 * breaks the coverage remap (docs/SKY.md §5.2), so they skip the ladder and go straight to lossless WebP.
 */
const LOSSLESS_PNG = /^sky\/cloud-noise\.png$/i

/**
 * World images that stay PNG: the coast field (docs/COAST.md §8.1) is four independent data channels, and its A = 0
 * would zero R, G and B through the browser's premultiplied WebP decode. The ocean decodes the PNG exactly
 * (ocean/field.ts loadCoastField), so it is copied unchanged.
 */
const KEEP_PNG = /^world\/[^/]+\/coast\/field\.png$/i

/** The out-opt path of an image that becomes WebP, or null when the file is copied as it is. */
export function webpRename(rel: string): string | null {
  if (KEEP_PNG.test(rel)) return null
  return WORLD_PNG.test(rel) || SKY_PNG.test(rel) ? rel.replace(/\.png$/i, '.webp') : null
}

/** The quality ladder for a renamed image: empty (lossless only) for data images, else the default. */
export function webpLadder(rel: string): readonly Rung[] | undefined {
  return LOSSLESS_PNG.test(rel) ? [] : undefined
}

export async function optimizeOut(opts: RunOptions): Promise<Report> {
  // the export's convert lock (<in>/.convert.lock) for the whole run: Deploy refuses while it is held, so it never
  // ships a half-written out-opt; a convert or a Publish never writes work/out under a running optimize (H12-DP-2)
  return withConvertLock(join(opts.inDir, CONVERT_LOCK_DIR), 'optimize-out run', () => optimizeOutLocked(opts),
    { waitMs: opts.lockWaitMs ?? 0, ...(opts.log ? { log: opts.log } : {}) })
}

async function optimizeOutLocked(opts: RunOptions): Promise<Report> {
  const log = opts.log ?? (() => {})
  const io = await gltfIO()
  const { inDir, outDir } = opts
  const selected = (rel: string) => !NOT_SHIPPED.test(rel) && (!opts.only?.length || opts.only.some(p => rel.startsWith(p)))
  const files = walkFiles(inDir).filter(selected)
  const report: Report = {
    generatedAt: new Date().toISOString(),
    inDir,
    outDir,
    glbs: [],
    packs: [],
    packStats: {},
    animationCheck: { clips: 0, channels: 0, samples: 0, maxDiff: 0, failures: [] },
    textures: [],
    texturesForReview: [],
    renamed: 0,
    rewrittenReferences: 0,
    summary: {},
  }
  if (!opts.noCensus) {
    log('census (before)…')
    report.before = await census(inDir, { wire: true, filter: selected })
  }
  const renamed = new Map<string, string>()
  for (const rel of files) {
    const to = webpRename(rel)
    if (to) renamed.set(rel, to)
  }
  const rewrite = (value: unknown, fileRel: string) => {
    const r = rewriteRefs(value, fileRel, renamed)
    report.rewrittenReferences += r.count
    return r.value
  }
  const write = (rel: string, bytes: Uint8Array | string) => {
    const p = join(outDir, ...rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, bytes)
  }

  // ---- actors (players, monsters, NPCs): split into mesh glb + shared animation packs ----
  const done = new Set<string>()
  for (const root of ACTOR_ROOTS) {
    const chars: CharacterSource[] = []
    for (const rel of files) {
      if (!rel.startsWith(`${root}/`) || rel.startsWith(`${root}/_anims/`) || !/\.glb$/i.test(rel)) continue
      const sideRel = rel.replace(/\.glb$/i, '.json')
      if (!files.includes(sideRel)) continue
      const doc = await io.readBinary(readFileSync(join(inDir, rel)))
      if (!doc.getRoot().listSkins().length || !doc.getRoot().listAnimations().length) continue
      const side = JSON.parse(readFileSync(join(inDir, sideRel), 'utf8')) as { animations?: SidecarAnimation[]; skeleton?: { bsk?: string } }
      chars.push({ rel, doc, animations: side.animations ?? [], bsk: side.skeleton?.bsk })
    }
    if (chars.length) await splitActors(root, chars)
  }

  async function splitActors(root: string, chars: CharacterSource[]): Promise<void> {
    log(`animation packs for ${chars.length} ${root} glbs…`)
    const build = buildPacks(chars, `${root}/_anims`)
    report.packStats[root] = build.stats
    const packBytes = new Map<string, Uint8Array>()
    for (const [rel, doc] of build.packs) {
      await finishPack(doc)
      const glb = await io.writeBinary(doc)
      write(rel, glb)
      packBytes.set(rel, glb)
      const v = await validateGlb(glb, rel)
      report.packs.push({ rel, bytes: glb.byteLength, clips: doc.getRoot().listAnimations().length, validator: { errors: v.errors, warnings: v.warnings, issues: summarizeIssues(v.messages, 1) } })
    }
    const packDocs = new Map<string, Document>()
    for (const [rel, glb] of packBytes) packDocs.set(rel, await io.readBinary(glb))
    for (const c of chars) {
      log(`  ${c.rel}`)
      const idx = build.index.get(c.rel)!
      const original = await io.readBinary(readFileSync(join(inDir, c.rel)))
      checkAnimations(original, idx, packDocs, report)
      await stripAnimations(c.doc)
      const mesh = await optimizeGlbDoc(c.doc, c.rel, CHARACTER_GEOMETRY, report, rewrite)
      write(c.rel, mesh.bytes)
      await reportGlb(c.rel, readFileSync(join(inDir, c.rel)).byteLength, original, mesh, report, posesOf(original))
      const sideRel = c.rel.replace(/\.glb$/i, '.json')
      const side = JSON.parse(readFileSync(join(inDir, sideRel), 'utf8')) as Record<string, unknown>
      side.animationPacks = idx satisfies AnimationPackIndex
      write(sideRel, JSON.stringify(rewrite(side, sideRel), null, 2))
      done.add(c.rel).add(sideRel)
    }
  }

  // ---- movement packs: finished like every pack, and checked clip for clip against their input ----
  for (const rel of files) {
    if (!MOVEMENT_PACK.test(rel)) continue
    log(`  ${rel}`)
    const inBytes = readFileSync(join(inDir, rel))
    const doc = await io.readBinary(inBytes)
    await finishPack(doc)
    const glb = await io.writeBinary(doc)
    write(rel, glb)
    const v = await validateGlb(glb, rel)
    report.packs.push({ rel, bytes: glb.byteLength, clips: doc.getRoot().listAnimations().length, validator: { errors: v.errors, warnings: v.warnings, issues: summarizeIssues(v.messages, 1) } })
    const original = await io.readBinary(inBytes)
    const back = await io.readBinary(glb)
    const c = report.animationCheck
    for (const anim of original.getRoot().listAnimations()) {
      c.clips++
      const target = back.getRoot().listAnimations().find(a => a.getName() === anim.getName())
      if (!target) {
        c.failures.push(`${rel}: ${anim.getName()} is missing`)
        continue
      }
      const r = compareClips(anim, target)
      c.channels += r.channels
      c.samples += r.samples
      c.maxDiff = Math.max(c.maxDiff, r.maxDiff)
      if (r.maxDiff !== 0 || r.missing.length || r.extra.length) {
        c.failures.push(`${rel} ${anim.getName()}: maxDiff ${r.maxDiff}, missing ${r.missing.length}, extra ${r.extra.length}`)
      }
    }
    done.add(rel)
  }

  // ---- every other glb ----
  for (const rel of files) {
    if (done.has(rel) || extname(rel).toLowerCase() !== '.glb') continue
    log(`  ${rel}`)
    const inBytes = readFileSync(join(inDir, rel))
    const doc = await io.readBinary(inBytes)
    const original = await io.readBinary(inBytes)
    const bits = rel.startsWith('world/') ? WORLD_GEOMETRY : CHARACTER_GEOMETRY
    const out = await optimizeGlbDoc(doc, rel, bits, report, rewrite)
    write(rel, out.bytes)
    await reportGlb(rel, inBytes.byteLength, original, out, report, posesOf(original))
    done.add(rel)
  }

  // ---- world images, JSON rewrites, plain copies ----
  for (const rel of files) {
    if (done.has(rel)) continue
    const src = join(inDir, rel)
    const newRel = renamed.get(rel)
    if (newRel) {
      const r = await toWebp(readFileSync(src), { ladder: webpLadder(rel) })
      write(newRel, r.webp)
      pushTexture(report, rel, recordOf(posix.basename(rel), r))
      report.renamed++
    } else if (extname(rel).toLowerCase() === '.json' && renamed.size) {
      const text = readFileSync(src, 'utf8')
      if (text.includes('.png')) {
        const before = report.rewrittenReferences
        const value = rewrite(JSON.parse(text), rel)
        if (report.rewrittenReferences !== before) write(rel, JSON.stringify(value, null, rel.endsWith('manifest.json') ? undefined : 2))
        else copy(src, join(outDir, rel))
      } else {
        copy(src, join(outDir, rel))
      }
    } else {
      copy(src, join(outDir, rel))
    }
  }

  // ---- decoder, manifest, precompression, census ----
  const decoderRel = '_decoders/meshopt_decoder.js'
  write(decoderRel, readFileSync(createRequire(import.meta.url).resolve('meshoptimizer/decoder.cjs')))
  const slim: SlimManifest = {
    format: 'sro-slim',
    version: 1,
    generatedAt: report.generatedAt,
    extensionsRequired: ['KHR_mesh_quantization', 'EXT_meshopt_compression', 'EXT_texture_webp'],
    meshoptDecoder: decoderRel,
    renamed: Object.fromEntries(renamed),
    animationPacks: report.packs.map(p => p.rel),
  }
  write('slim.json', JSON.stringify(slim, null, 2))
  if (opts.precompress) {
    log('precompressing (brotli q11)…')
    for (const rel of walkFiles(outDir)) {
      if (!COMPRESSIBLE.has(extname(rel).toLowerCase())) continue
      const buf = readFileSync(join(outDir, rel))
      if (buf.byteLength < 1024) continue
      const br = brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength } })
      if (br.byteLength < buf.byteLength * 0.95) writeFileSync(join(outDir, rel) + '.br', br)
      else rmSync(join(outDir, rel) + '.br', { force: true })
    }
  }
  if (!opts.noCensus) {
    log('census (after)…')
    report.after = await census(outDir, { wire: true, filter: rel => selected(rel) || rel.startsWith('_decoders/') || rel === 'slim.json' })
  }
  report.summary = summarize(report)
  writeFileSync(join(outDir, 'slim-report.json'), JSON.stringify(report, (_k, v) => (v === Infinity ? 'Infinity' : v), 2))
  return report
}

function copy(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}

export function pushTexture(report: Report, file: string, rec: TextureRecord): void {
  const r = { ...rec, file }
  report.textures.push(r)
  if (r.psnr < REVIEW_PSNR) report.texturesForReview.push(r)
}

export async function optimizeGlbDoc(
  doc: Document,
  rel: string,
  bits: GeometryOptions,
  report: Report,
  rewrite: (v: unknown, fileRel: string) => unknown,
): Promise<{ bytes: Uint8Array; positionsQuantized: boolean }> {
  for (const rec of await texturesToWebp(doc)) pushTexture(report, rel, rec)
  for (const p of [...doc.getRoot().listMaterials(), ...doc.getRoot().listNodes(), ...doc.getRoot().listMeshes()]) {
    const extras = p.getExtras()
    if (extras && Object.keys(extras).length) p.setExtras(rewrite(extras, rel) as Record<string, unknown>)
  }
  const { positionsQuantized } = await optimizeGeometry(doc, bits)
  const io = await gltfIO()
  return { bytes: await io.writeBinary(doc), positionsQuantized }
}

export async function reportGlb(rel: string, inBytes: number, original: Document, out: { bytes: Uint8Array; positionsQuantized: boolean }, report: Report, poses: Pose[]): Promise<void> {
  const io = await gltfIO()
  const v = await validateGlb(out.bytes, rel)
  const back = await io.readBinary(out.bytes)
  report.glbs.push({
    rel,
    inBytes,
    outBytes: out.bytes.byteLength,
    positionsQuantized: out.positionsQuantized,
    geometry: original.getRoot().listMeshes().length ? geometryError(original, back, poses) : undefined,
    validator: { errors: v.errors, warnings: v.warnings, issues: summarizeIssues(v.messages, 1) },
  })
}

/** A few animation poses (the first three clips, at 3 times each) to measure skinning error under motion. */
export function posesOf(doc: Document): Pose[] {
  const poses: Pose[] = []
  for (const anim of doc.getRoot().listAnimations().slice(0, 3)) {
    const end = Math.max(0, ...anim.listSamplers().map(s => s.getInput()!.getMax([])[0] ?? 0))
    for (const f of [0, 0.37, 0.71]) {
      const pose: Pose = new Map()
      for (const ch of anim.listChannels()) {
        const name = ch.getTargetNode()?.getName()
        const path = ch.getTargetPath()
        if (!name || (path !== 'translation' && path !== 'rotation' && path !== 'scale')) continue
        const e = pose.get(name) ?? {}
        e[path === 'translation' ? 't' : path === 'rotation' ? 'r' : 's'] = sampleChannel(ch.getSampler()!, end * f, [])
        pose.set(name, e)
      }
      poses.push(pose)
    }
  }
  return poses
}

function checkAnimations(original: Document, idx: AnimationPackIndex, packs: Map<string, Document>, report: Report): void {
  const c = report.animationCheck
  for (const anim of original.getRoot().listAnimations()) {
    const ref = idx.clips[anim.getName()]
    const pack = ref && packs.get(idx.packs[ref[0]]!)
    const target = pack?.getRoot().listAnimations().find(a => a.getName() === ref![1])
    c.clips++
    if (!target) {
      c.failures.push(`${idx.skeleton}: ${anim.getName()} has no pack clip`)
      continue
    }
    const r = compareClips(anim, target)
    c.channels += r.channels
    c.samples += r.samples
    c.maxDiff = Math.max(c.maxDiff, r.maxDiff)
    if (r.maxDiff !== 0 || r.missing.length || r.extra.length) {
      c.failures.push(`${anim.getName()} -> ${ref![0]}/${ref![1]}: maxDiff ${r.maxDiff}, missing ${r.missing.length}, extra ${r.extra.length}`)
    }
  }
}

/** Rewrites string values naming a renamed file (relative to the file, its world folder, or the out root). */
export function rewriteRefs(value: unknown, fileRel: string, renamed: Map<string, string>): { value: unknown; count: number } {
  let count = 0
  const bases = [posix.dirname(fileRel)]
  const m = /^(world\/[^/]+)\//.exec(fileRel)
  if (m) bases.push(m[1]!)
  bases.push('')
  const fix = (s: string): string => {
    if (!/\.png$/i.test(s)) return s
    const norm = s.replace(/\\/g, '/')
    for (const b of bases) {
      const full = posix.normalize(b ? `${b}/${norm}` : norm)
      if (renamed.has(full)) {
        count++
        return s.replace(/\.png$/i, '.webp')
      }
    }
    return s
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fix(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return { value: walk(value), count }
}

function summarize(r: Report): Record<string, string | number> {
  const s: Record<string, string | number> = {}
  if (r.before && r.after) {
    s.totalBefore = fmtMB(r.before.totalBytes)
    s.totalAfter = fmtMB(r.after.totalBytes)
    s.wireBefore = fmtMB(r.before.wireBytes)
    s.wireAfter = fmtMB(r.after.wireBytes)
  }
  const geo = r.glbs.filter(g => g.geometry)
  s.maxPositionErrorMm = Math.max(0, ...geo.map(g => g.geometry!.maxPositionMm))
  s.maxNormalErrorDeg = Math.max(0, ...geo.map(g => g.geometry!.maxNormalDeg))
  s.maxTexcoordError = Math.max(0, ...geo.map(g => g.geometry!.maxTexcoord))
  s.validatorErrors = r.glbs.reduce((a, g) => a + g.validator.errors, 0) + r.packs.reduce((a, p) => a + p.validator.errors, 0)
  s.validatorWarnings = r.glbs.reduce((a, g) => a + g.validator.warnings, 0) + r.packs.reduce((a, p) => a + p.validator.warnings, 0)
  s.textures = r.textures.length
  s.texturesForReview = r.texturesForReview.length
  s.minTexturePsnr = Math.min(Infinity, ...r.textures.map(t => t.psnr))
  s.minTextureSsim = Math.min(1, ...r.textures.map(t => t.ssim))
  s.animationClipsChecked = r.animationCheck.clips
  s.animationMaxDiff = r.animationCheck.maxDiff
  s.animationFailures = r.animationCheck.failures.length
  return s
}

export function outOptExists(dir: string): boolean {
  return existsSync(join(dir, 'slim.json'))
}
