/**
 * `optimize-out run --files` (wave 12, lane WE-I; docs/WORLD_EDITOR.md §6.2 step 4, D37): only the files a World Editor
 * Publish changed go through the optimizer, and slim.json is merged, never rebuilt. The full run (./run.ts) takes
 * 15 minutes for every file; a publish changes a dozen.
 *
 * Each listed file goes through exactly the full run's per-file step (./run.ts: a world PNG becomes WebP at the same
 * path, a JSON that names a renamed PNG is rewritten, any other glb is quantized + meshopt + WebP, everything else is
 * copied), so its out-opt bytes equal what the full run writes for it (../../test/optimize-files.test.ts compares the
 * two). The rename table that JSON rewrites read is the full run's: the merged slim.json's, with the listed files'
 * entries updated (a new PNG added, a removed one dropped) before any file is processed. Actor glbs (char/, mob/, npc/)
 * are refused: their animation packs are shared across files, a full run's job.
 *
 * slim.json is merged: the entries of every untouched file stay byte-identical, a removed file's entry goes, a new PNG's
 * entry comes, the table stays sorted as the full run writes it; generatedAt changes only when the table does.
 *
 * Writes are temp + rename. A listed file missing from the input is removed from the output (with its WebP and .br).
 * With precompress, every written compressible file gets its .br by the full run's rule (q11, kept when under 95 %), and
 * a .br that no longer applies is removed; a file over BIG_BR_BYTES (nav.bin, 22 MiB, which the streaming client never
 * fetches: it reads nav-objects.bin and the chunks) is compressed at q5 instead, 0.4 s instead of 40 s for about 9 %
 * more bytes, until the next full run. The result lists what was written and removed (out-relative), for a caller that swaps a staging
 * out-opt into the live one (WE-A's Publish).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, posix } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { CHARACTER_GEOMETRY, WORLD_GEOMETRY } from './geometry.ts'
import { gltfIO } from './io.ts'
import { COMPRESSIBLE } from './measure.ts'
import {
  ACTOR_ROOTS, NOT_SHIPPED, optimizeGlbDoc, posesOf, pushTexture, reportGlb, rewriteRefs, webpLadder, webpRename, type Report, type SlimManifest,
} from './run.ts'
import { toWebp } from './texture.ts'
import { recordOf } from './textures-doc.ts'

export interface FilesRunOptions {
  /** Where the files are read: a folder laid out like work/out, or one export folder with `prefix`. */
  inDir: string
  /** The out-opt folder written (work/out-opt, or a staging copy that the caller swaps in). */
  outDir: string
  /** The changed files, relative to inDir. One that inDir no longer has is removed from outDir. */
  files: readonly string[]
  /**
   * Prepended to every file's path for its out-opt path, the rename rules and slim.json, e.g. 'world/jangan-fields/'
   * when inDir is a (staging) export folder. Default ''.
   */
  prefix?: string
  /** The slim.json merged (default <outDir>/slim.json); the merged one is written to <outDir>/slim.json. */
  slimFrom?: string
  /** Also write .br (brotli q11) for the written compressible files, as the full run's --precompress. */
  precompress?: boolean
  log?: (msg: string) => void
}

export interface FilesReport extends Pick<Report, 'glbs' | 'textures' | 'texturesForReview' | 'renamed' | 'rewrittenReferences'> {
  generatedAt: string
  /** Out-relative files written (slim.json and .br files included), sorted. */
  written: string[]
  /** Out-relative files removed (a removed input, its WebP, a .br that no longer applies), sorted. */
  removed: string[]
  /** slim.json's rename table changed. */
  slimChanged: boolean
}

/** Above this size the files run compresses at BIG_BR_QUALITY (see the header). */
export const BIG_BR_BYTES = 8 * 2 ** 20
export const BIG_BR_QUALITY = 5

/** The full run's rename table order (walkFiles sorts with the default string order). */
const sortedEntries = (m: Map<string, string>) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

export async function optimizeFiles(opts: FilesRunOptions): Promise<FilesReport> {
  const log = opts.log ?? (() => {})
  const prefix = opts.prefix ?? ''
  if (prefix && !prefix.endsWith('/')) throw new Error(`optimize --files: --prefix must end with '/' (${prefix})`)
  const slimFile = opts.slimFrom ?? join(opts.outDir, 'slim.json')
  if (!existsSync(slimFile)) throw new Error(`optimize --files: no slim.json at ${slimFile} (run the full optimize first)`)
  const base = JSON.parse(readFileSync(slimFile, 'utf8')) as SlimManifest
  if (base.format !== 'sro-slim' || base.version !== 1) throw new Error(`optimize --files: ${slimFile} is not an sro-slim v1 manifest`)

  // the rename table: the merged slim.json's, with the listed files' entries updated first (a JSON rewritten below must
  // see a new PNG's WebP name whatever the order)
  const list = [...new Set(opts.files.map(f => f.split('\\').join('/')))].sort()
  const renamed = new Map<string, string>(Object.entries(base.renamed))
  for (const f of list) {
    const rel = prefix + f
    const to = webpRename(rel)
    if (!to || NOT_SHIPPED.test(rel)) continue
    if (existsSync(join(opts.inDir, ...f.split('/')))) renamed.set(rel, to)
    else renamed.delete(rel)
  }
  const report: FilesReport = {
    generatedAt: new Date().toISOString(), written: [], removed: [], slimChanged: false,
    glbs: [], textures: [], texturesForReview: [], renamed: 0, rewrittenReferences: 0,
  }
  const asReport = report as unknown as Report
  const rewrite = (value: unknown, fileRel: string) => {
    const r = rewriteRefs(value, fileRel, renamed)
    report.rewrittenReferences += r.count
    return r.value
  }
  const written = new Set<string>()
  const removed = new Set<string>()
  const put = (rel: string, bytes: Uint8Array | string) => {
    const p = join(opts.outDir, ...rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, p)
    written.add(rel)
    removed.delete(rel)
  }
  const drop = (rel: string) => {
    rmSync(join(opts.outDir, ...rel.split('/')), { force: true })
    removed.add(rel)
    written.delete(rel)
  }

  const io = await gltfIO()
  for (const f of list) {
    const rel = prefix + f
    if (NOT_SHIPPED.test(rel)) continue
    const src = join(opts.inDir, ...f.split('/'))
    const outRel = webpRename(rel) ?? rel
    if (!existsSync(src)) {
      log(`  removed ${rel}`)
      drop(outRel)
      drop(`${outRel}.br`)
      continue
    }
    const ext = extname(rel).toLowerCase()
    if (ext === '.glb' && ACTOR_ROOTS.some(r => rel.startsWith(`${r}/`))) {
      throw new Error(`optimize --files: ${rel} is an actor glb (shared animation packs); run the full optimize`)
    }
    log(`  ${rel}`)
    const inBytes = readFileSync(src)
    if (ext === '.glb') {
      const doc = await io.readBinary(inBytes)
      const original = await io.readBinary(inBytes)
      const out = await optimizeGlbDoc(doc, rel, rel.startsWith('world/') ? WORLD_GEOMETRY : CHARACTER_GEOMETRY, asReport, rewrite)
      put(rel, out.bytes)
      await reportGlb(rel, inBytes.byteLength, original, out, asReport, posesOf(original))
    } else if (renamed.has(rel)) {
      const r = await toWebp(inBytes, { ladder: webpLadder(rel) })
      put(renamed.get(rel)!, r.webp)
      pushTexture(asReport, rel, recordOf(posix.basename(rel), r))
      report.renamed++
    } else if (ext === '.json' && renamed.size) {
      const text = inBytes.toString('utf8')
      if (text.includes('.png')) {
        const before = report.rewrittenReferences
        const value = rewrite(JSON.parse(text), rel)
        if (report.rewrittenReferences !== before) put(rel, JSON.stringify(value, null, rel.endsWith('manifest.json') ? undefined : 2))
        else put(rel, inBytes)
      } else put(rel, inBytes)
    } else put(rel, inBytes)
  }

  // slim.json, merged
  const table = Object.fromEntries(sortedEntries(renamed))
  report.slimChanged = JSON.stringify(table) !== JSON.stringify(base.renamed)
  const slim: SlimManifest = { ...base, generatedAt: report.slimChanged ? report.generatedAt : base.generatedAt, renamed: table }
  const slimText = JSON.stringify(slim, null, 2)
  if (!existsSync(join(opts.outDir, 'slim.json')) || readFileSync(join(opts.outDir, 'slim.json'), 'utf8') !== slimText) put('slim.json', slimText)

  if (opts.precompress) {
    for (const rel of [...written]) {
      if (!COMPRESSIBLE.has(extname(rel).toLowerCase())) continue
      const buf = readFileSync(join(opts.outDir, ...rel.split('/')))
      const br = buf.byteLength < 1024 ? null : brotliCompressSync(buf, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: buf.byteLength > BIG_BR_BYTES ? BIG_BR_QUALITY : 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
        },
      })
      if (br && br.byteLength < buf.byteLength * 0.95) put(`${rel}.br`, br)
      else drop(`${rel}.br`)
    }
  }
  report.written = [...written].sort()
  report.removed = [...removed].sort()
  log(`optimize --files: ${report.written.length} written, ${report.removed.length} removed${report.slimChanged ? ', slim.json renames changed' : ''}`)
  return report
}
