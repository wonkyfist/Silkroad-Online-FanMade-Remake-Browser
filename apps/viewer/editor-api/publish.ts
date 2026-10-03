/**
 * Publish (docs/WORLD_EDITOR.md §6.1-§6.4, D35-D39, §F14-F16; docs/WAVE_PLAN8.md §6.2 lane WE-A, D7, D19, D37): the
 * steps between "Save" and "Deploy", run in their own process (./publish-cli.ts under tsx; the editor's Vite starts it
 * through ./runner.ts, `pnpm sro world-edit publish` imports it), never inside the Vite server.
 *
 * prepare   1 validate the layers (the shared validators; any problem stops here, nothing is converted)
 *           2 under the convert lock: WE-I's incremental convert into the staging export `<world>-edit` (hard links of
 *             the live export, new files by temp + rename: the live export is never written), and a second run of the
 *             same regions without the layers (the editor's base, below)
 *           3 WE-I's `optimize-out --files` of the changed files into publish-<n>/out-opt (slim.json merged), and the
 *             staging out-opt export work/out-opt/world/<world>-edit (links + those files) that Test in game plays
 *           4 the terrain tiles painted past 0.1 % cover that are not hero yet (D19: `texpipe hero` at Keep)
 *           5 WE-N's checks (before = the live nav.bin, after = the staging one) and the tests of §6.2 step 6
 *           6 the report: publish-<n>/record.json, report.json (WE-N's format), report.html
 * keep      the user's Keep (§6.4): the changed files replace the live ones one by one (temp + rename, the manifests and
 *           slim.json last), each replaced file kept in publish-<n>/backup/ (a failure puts back what was swapped);
 *           `texpipe hero <tile> on` under the GPU lock (D7); the editor's base overlay; the pathspec commit of content/
 *           ("World edits: ..."); the staging exports go
 * discard   Go back: the staging exports go, the live export was never touched
 * undo      the newest kept publish's backup copied back (its content commit stays: the layers are still saved)
 *
 * The editor's base overlay (work/editor/<world>/base/): the editor shows the export *before* the edit pass plus the
 * layers (its height deltas add to the base, docs/WORLD_EDITOR.md D8). Once a publish is kept, the live export holds
 * the edits, so the editor's Vite serves, for every file a publish changed, the version the converter writes without
 * the layers (step 2's second run): `index.json` maps each such file to the SHA-256 of the live file it stands for,
 * and an entry whose live file changed since (a full convert) is ignored. Without it a kept raise would show twice.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { decodeNavData, type NavData } from '@sro/nav'
import { loadConfig, type SroConfig } from '../../../packages/convert/src/node-io.ts'
import { optimizeFiles, type FilesReport } from '../../../packages/convert/src/optimize/files.ts'
import { convertRegions, listFiles, type ConvertRegionsResult } from '../../../packages/convert/src/tools/convert-region.ts'
import { acquireConvertLock, convertLockPath } from '../../../packages/convert/src/world/convert-lock.ts'
import {
  checkPointsFrom, encodeWorldEditsReport, glbTriangleCount, PUBLISH_CHECKS, runPublishChecks, WORLD_EDITS_REPORT_FORMAT,
  WORLD_EDITS_REPORT_VERSION, type CheckPoint, type CheckScene, type ExternalCheck, type WorldEditsReport,
} from '../../../packages/convert/src/world/edits/checks.ts'
import { layerFiles, readWorldEditsLayers } from '../../../packages/convert/src/world/edits/index.ts'
import type { WorldEditsLayers } from '../../../packages/convert/src/world/edits/layers.ts'
import { decodeTerrainBin } from '../../../packages/convert/src/world/format.ts'
import type { WorldManifest } from '../../../packages/convert/src/world/manifest.ts'
import { tileKey } from '../../../packages/texpipe/src/format.ts'
import { commitPaths } from './git.ts'
import { readJournal } from './journal.ts'
import {
  HERO_COVER, PUBLISH_FORMAT, type JournalEntry, type PublishPhase, type PublishRecord, type PublishStep, type PublishView,
} from './protocol.ts'
import { renderReportHtml } from './report-html.ts'

// --- paths and records -----------------------------------------------------------------------------------------------

export interface PublishPaths {
  repoRoot: string
  /** The converter's work folder (sro.config.json workDir). */
  workRoot: string
  world: string
  /** content/world-edits/<world> (or a test folder). */
  layerDir: string
  /** work/editor/<world>: records, backups, the base overlay. */
  editorDir: string
  /** work/out/world/<world>, the live export. */
  liveDir: string
  /** work/out/world/<world>-edit, the staging export (WORLD_EDITOR §2.4). */
  stagingDir: string
  /** work/out-opt. */
  optRoot: string
  /** work/out-opt/world/<world>-edit, the staging out-opt export Test in game plays. */
  optStagingDir: string
}

export function publishPaths(repoRoot: string, workRoot: string, world: string, over: Partial<PublishPaths> = {}): PublishPaths {
  if (!/^[a-z0-9-]{1,64}$/.test(world) || world.endsWith('-edit')) throw new Error(`publish: ${JSON.stringify(world)} is not a world to publish`)
  const liveDir = over.liveDir ?? join(workRoot, 'out', 'world', world)
  const optRoot = over.optRoot ?? join(workRoot, 'out-opt')
  return {
    repoRoot, workRoot, world,
    layerDir: over.layerDir ?? join(repoRoot, 'content', 'world-edits', world),
    editorDir: over.editorDir ?? join(workRoot, 'editor', world),
    liveDir,
    stagingDir: over.stagingDir ?? `${liveDir}-edit`,
    optRoot,
    optStagingDir: over.optStagingDir ?? join(optRoot, 'world', `${world}-edit`),
  }
}

export const publishDir = (p: PublishPaths, n: number) => join(p.editorDir, `publish-${n}`)
const RECORD = 'record.json'
const PUBLISHED = 'published.json'
export const BASE_DIR = 'base'
export const BASE_INDEX = 'index.json'

/** The publish numbers that exist, ascending. */
export function publishNumbers(p: PublishPaths): number[] {
  if (!existsSync(p.editorDir)) return []
  return readdirSync(p.editorDir).map(d => /^publish-(\d+)$/.exec(d)?.[1]).filter((s): s is string => !!s).map(Number).sort((a, b) => a - b)
}

export function readRecord(p: PublishPaths, n: number): PublishRecord | null {
  const f = join(publishDir(p, n), RECORD)
  if (!existsSync(f)) return null
  const r = JSON.parse(readFileSync(f, 'utf8')) as PublishRecord
  return r.format === PUBLISH_FORMAT ? r : null
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const fileSha = (file: string) => sha256(readFileSync(file))

/** temp + rename beside the target (never in place: a hard-linked file must not change through its other name). */
export function putFile(file: string, data: Uint8Array | string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.pub.tmp`
  writeFileSync(tmp, data)
  renameRetry(tmp, file)
}

const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Windows: a file a dev server or an indexer holds open refuses a rename for a moment. */
function retry<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (e) {
      if (!RETRY.has((e as NodeJS.ErrnoException).code ?? '') || i >= 10) throw e
      sleepSync(30 * (i + 1))
    }
  }
}
const renameRetry = (from: string, to: string) => retry(() => renameSync(from, to))
const unlinkRetry = (file: string) => retry(() => unlinkSync(file))
const rmTree = (dir: string) => retry(() => rmSync(dir, { recursive: true, force: true }))

/** Copies by temp + rename (the source stays). */
function copyInto(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  const tmp = `${to}.${process.pid}.pub.tmp`
  copyFileSync(from, tmp)
  renameRetry(tmp, to)
}

/** A hard link (a copy where links fail): for backups of files about to be replaced by rename. */
function linkOrCopy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  if (existsSync(to)) unlinkRetry(to)
  try {
    linkSync(from, to)
  } catch {
    copyFileSync(from, to)
  }
}

export function writeRecord(p: PublishPaths, r: PublishRecord): void {
  putFile(join(publishDir(p, r.n), RECORD), JSON.stringify(r, null, 1) + '\n')
}

/** work/editor/<world>/published.json: the kept publishes, and how far Deploy sent them. */
export interface PublishedIndex {
  /**
   * `layers`: the layer files' SHA-256 the publish converted; `notApplied`: the journal ids not in effect then (an
   * undo or a revert of a published change since is published again: DL-7).
   */
  kept: Array<{ n: number; at: string; journalId: number; commit?: string; changes: string[]; undone?: string; layers?: Record<string, string>; notApplied?: number[] }>
  /** The newest publish a Deploy sent (0: none). */
  deployedThrough: number
  deployedAt?: string
}

export function readPublished(editorDir: string): PublishedIndex {
  const f = join(editorDir, PUBLISHED)
  if (!existsSync(f)) return { kept: [], deployedThrough: 0 }
  const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<PublishedIndex>
  return { kept: Array.isArray(j.kept) ? j.kept : [], deployedThrough: Number(j.deployedThrough) || 0, ...(j.deployedAt ? { deployedAt: j.deployedAt } : {}) }
}

export function writePublished(editorDir: string, idx: PublishedIndex): void {
  putFile(join(editorDir, PUBLISHED), JSON.stringify(idx, null, 1) + '\n')
}

/** The newest kept publish that was not undone. */
export const lastKept = (idx: PublishedIndex) => [...idx.kept].reverse().find(k => !k.undone) ?? null

// --- the journal since the last publish -------------------------------------------------------------------------------

/** Applied: an API-form entry below head, a page record not undone. */
function applied(entries: readonly JournalEntry[], head: number): JournalEntry[] {
  return entries.filter((e, i) => (e.record ? e.state !== 'undone' : i < head))
}

/** In effect now: an API-form entry below head, a page record neither undone nor reverted. */
const inEffect = (e: JournalEntry, i: number, head: number) => (e.record ? e.state !== 'undone' && e.state !== 'reverted' : i < head)

/**
 * The changes after `sinceId`: their labels, every region they touched, the cameras for before / after. `back`: the
 * changes up to `sinceId` (already published) whose state changed since that publish (`notAppliedThen`: the ids not
 * in effect then; unknown = all were): an undo, a revert or a redo after a Keep must be published too (DL-7).
 */
export function changesSince(editorDir: string, world: string, sinceId: number, notAppliedThen?: readonly number[]): {
  labels: string[]; regions: number[]; journalId: number; views: PublishView[]; notApplied: number[]; back: { labels: string[]; regions: number[] }
} {
  let j
  try {
    j = readJournal(editorDir, world)
  } catch {
    return { labels: [], regions: [], journalId: sinceId, views: [], notApplied: [], back: { labels: [], regions: [] } }
  }
  const after = j.entries.filter(e => e.id > sinceId)
  const done = applied(after, j.header.head - (j.entries.length - after.length))
  const regions = [...new Set(after.flatMap(e => e.regions))].sort((a, b) => a - b)
  const withView = done.filter(e => Array.isArray(e.view) && e.view.length >= 6)
  const views = [...withView.filter(e => e.starred), ...withView.filter(e => !e.starred)].slice(0, 8)
    .map(e => ({ id: e.id, label: e.label, view: e.view!, ...(e.starred ? { starred: true } : {}) }))
  const journalId = Math.max(sinceId, ...j.entries.map(e => e.id))
  const then = new Set(notAppliedThen ?? [])
  const notApplied: number[] = []
  const back = { labels: [] as string[], regions: new Set<number>() }
  const head = j.header.head
  j.entries.forEach((e, i) => {
    const now = inEffect(e, i, head)
    if (!now) notApplied.push(e.id)
    if (e.id > sinceId || now === !then.has(e.id)) return
    back.labels.push(now ? `Brought back: ${e.label}` : `Took back: ${e.label}`)
    for (const r of e.regions) back.regions.add(r)
  })
  return { labels: done.map(e => e.label), regions, journalId, views, notApplied, back: { labels: back.labels, regions: [...back.regions].sort((a, b) => a - b) } }
}

/** SHA-256 of every file of the layer folder (what a publish validates, converts and Keep commits). */
export function layerHashes(layerDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of layerFiles(layerDir)) if (!rel.split('/').some(seg => seg.startsWith('.'))) out[rel] = fileSha(join(layerDir, ...rel.split('/')))
  return out
}

const sameHashes = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every(k => a[k] === b[k])
}

/** The regions of the pixel layers that differ between two hash lists (added, removed or changed). */
function layerRegionsDiffering(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): number[] {
  const out = new Set<number>()
  for (const rel of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[rel] === b[rel]) continue
    const m = /^(?:height|paint|grass|walk)\/(\d+)_(\d+)\.png$/.exec(rel)
    if (m) out.add((Number(m[2]) << 8) | Number(m[1]))
  }
  return [...out]
}

const keptEntry = (rec: PublishRecord): PublishedIndex['kept'][number] => ({
  n: rec.n, at: rec.finishedAt ?? new Date().toISOString(), journalId: rec.journalId, ...(rec.commit ? { commit: rec.commit } : {}), changes: rec.changes,
  ...(rec.layerHashes ? { layers: rec.layerHashes } : {}), ...(rec.notApplied ? { notApplied: rec.notApplied } : {}),
})

/**
 * Kept publishes whose published.json entry could not be written at Keep (PS-2): added now, so Undo and Deploy see
 * them. Best effort; runs at the start of every publish job.
 */
export function repairPublished(p: PublishPaths): void {
  for (const n of publishNumbers(p)) {
    let rec: PublishRecord | null
    try {
      rec = readRecord(p, n)
    } catch {
      continue
    }
    if (!rec || rec.phase !== 'kept' || !rec.pendingIndex) continue
    try {
      const idx = readPublished(p.editorDir)
      if (!idx.kept.some(k => k.n === n)) {
        idx.kept.push(keptEntry(rec))
        idx.kept.sort((a, b) => a.n - b.n)
        writePublished(p.editorDir, idx)
      }
      delete rec.pendingIndex
      writeRecord(p, rec)
    } catch {
      // still not writable: the next job tries again
    }
  }
}

/** "World edits: Raised the ground at 171,97; Moved a tree; ... (+3 more)" (D39), at most ~72 characters a line. */
export function commitMessage(labels: readonly string[], n: number): string {
  const head = labels.length ? labels.slice(0, 3).join('; ') + (labels.length > 3 ? ` (+${labels.length - 3} more)` : '') : `publish ${n}`
  const subject = `World edits: ${head}`.slice(0, 200)
  const body = labels.length > 3 ? '\n\n' + labels.map(l => `- ${l}`).join('\n') : ''
  return `${subject}${body}\n\nPublished from the World Editor (publish ${n}).\n`
}

// --- step helpers ----------------------------------------------------------------------------------------------------

const PREPARE_STEPS: ReadonlyArray<[string, string]> = [
  ['validate', 'Check the layers'],
  ['convert', 'Build the changed regions (staging export)'],
  ['base', 'Build the editor base (the same regions without the layers)'],
  ['optimize', 'Optimize the changed files'],
  ['textures', 'Find tiles that need their full maps'],
  ['tests', 'Run the tests'],
  ['checks', 'Walking, reachability, props, budgets'],
  ['report', 'Write the report'],
]
const KEEP_STEPS: ReadonlyArray<[string, string]> = [
  ['locks', 'Wait for the convert (and texture) lock'],
  ['swap', 'Replace the live files (with a backup)'],
  ['hero', 'Give painted tiles their full maps (texpipe hero)'],
  ['base', 'Update the editor base'],
  ['commit', 'Commit the edit layers (content/)'],
  ['cleanup', 'Remove the staging exports'],
]

class Steps {
  private t = 0
  constructor(private readonly p: PublishPaths, readonly rec: PublishRecord, private readonly log: (l: string) => void) {}
  start(key: string, note?: string): void {
    const s = this.find(key)
    s.status = 'run'
    if (note) s.note = note
    this.t = performance.now()
    this.log(`publish ${this.rec.n}: ${s.title}${note ? ` (${note})` : ''}`)
    this.save()
  }
  done(key: string, note?: string, status: 'done' | 'skip' | 'fail' = 'done'): void {
    const s = this.find(key)
    s.status = status
    if (status !== 'skip') s.ms = Math.round(performance.now() - this.t)
    if (note !== undefined) s.note = note
    this.save()
  }
  skip(key: string, note: string): void {
    this.done(key, note, 'skip')
  }
  failRunning(error: string): void {
    for (const s of this.rec.steps) if (s.status === 'run') s.status = 'fail'
    this.rec.error = error
  }
  save(): void {
    writeRecord(this.p, this.rec)
  }
  private find(key: string): PublishStep {
    const s = this.rec.steps.find(x => x.key === key)
    if (!s) throw new Error(`publish: no step ${key}`)
    return s
  }
}

const stepsOf = (list: ReadonlyArray<[string, string]>): PublishStep[] => list.map(([key, title]) => ({ key, title, status: 'wait' as const }))

function readManifest(dir: string): WorldManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as WorldManifest
}

function readNav(dir: string): NavData {
  const b = readFileSync(join(dir, 'nav.bin'))
  return decodeNavData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * The convert lock (WORLD_EDITOR F15), re-entrant for this process: `pnpm sro world-edit publish` already holds it
 * around the whole publish (../../../packages/convert/src/cli.ts).
 */
async function convertLock(workRoot: string, label: string, waitMs: number, log: (l: string) => void): Promise<{ release(): void }> {
  const dir = convertLockPath(workRoot)
  try {
    const owner = readFileSync(join(dir, 'owner'), 'utf8')
    if (Number(/\bpid=(\d+)\b/.exec(owner)?.[1]) === process.pid && /\bhost=(\S+)/.exec(owner)?.[1] === hostname()) return { release: () => {} }
  } catch {
    // not held
  }
  return acquireConvertLock(dir, label, { waitMs, log })
}

/** The GPU lock (WAVE_PLAN8 §6.1, D27): mkdir must succeed; only its creator removes it. */
export async function acquireGpuLock(workRoot: string, label: string, waitMs: number, log: (l: string) => void = () => {}): Promise<() => void> {
  const dir = join(workRoot, 'tools', 'gpu.lock')
  const until = Date.now() + waitMs
  let said = ''
  mkdirSync(dirname(dir), { recursive: true })
  for (;;) {
    try {
      mkdirSync(dir)
      const owner = `${label} ${new Date().toISOString()}`
      writeFileSync(join(dir, 'owner'), owner + '\n')
      return () => {
        try {
          if (readFileSync(join(dir, 'owner'), 'utf8').trim() === owner) rmSync(dir, { recursive: true, force: true })
        } catch {
          // already gone
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let held = '(starting)'
    try {
      held = readFileSync(join(dir, 'owner'), 'utf8').trim() || held
    } catch {
      // no owner file yet
    }
    if (Date.now() >= until) throw new Error(`a texture or GPU job holds the GPU lock (${held}); try again when it is done`)
    if (held !== said) log(`publish: waiting for the GPU lock (${held})`)
    said = held
    await new Promise(r => setTimeout(r, Math.min(5000, Math.max(50, until - Date.now()))))
  }
}

// --- prepare ---------------------------------------------------------------------------------------------------------

export interface PrepareOptions {
  paths: PublishPaths
  cfg?: SroConfig
  log?: (line: string) => void
  /** How long to wait for a running convert (default 30 min). */
  lockWaitMs?: number
  /** convertRegions' record of earlier runs (default its own; null: none). */
  record?: string | null
  /** convertRegions' coast snapshot (default its own). */
  snapshot?: string | null
  /** Run the tests of §6.2 step 6 (default true). */
  tests?: boolean
  /** Replaces the incremental convert (tests). */
  convert?: (o: { only: number[]; edits: string | null; stagingDir: string; record?: string | null }) => Promise<Pick<ConvertRegionsResult, 'changed' | 'removed' | 'regions' | 'drift' | 'coast'>>
  /** Replaces optimize-out --files (tests). */
  optimize?: (o: Parameters<typeof optimizeFiles>[0]) => Promise<Pick<FilesReport, 'written' | 'removed'>>
  /** Replaces the vitest run (tests). */
  runTests?: (files: string[]) => Promise<{ ok: boolean; summary: string }>
  /** Replaces WE-N's checks on the two navs (tests; the default reads nav.bin of both exports). */
  checks?: (ctx: { live: WorldManifest; after: WorldManifest; layers: WorldEditsLayers; external: Record<string, ExternalCheck> }) => WorldEditsReport
}

/** The tests of §6.2 step 6 (D38): never the full suite. */
export function publishTests(repoRoot: string, opts: { coast: boolean; town: boolean }): string[] {
  const files = [
    'packages/shared/test/world-edits.test.ts',
    'packages/shared/test/world-edits-nav-rule.test.ts',
    'packages/convert/test/world-edits-apply.test.ts',
    'packages/convert/test/world-edits-nav.test.ts',
    'packages/nav/test/nav-instance.test.ts',
    'packages/nav/test/reachability.test.ts',
    ...(opts.coast ? ['packages/convert/test/coast-pass.test.ts', 'packages/convert/test/coast-link.test.ts'] : []),
    ...(opts.town ? ['packages/convert/test/town-graph.test.ts'] : []),
  ]
  return files.filter(f => existsSync(join(repoRoot, f)))
}

/** `vitest run <files>` in a child process (cwd the repo). */
export function runVitest(repoRoot: string, files: string[], timeoutMs = 10 * 60_000): Promise<{ ok: boolean; summary: string }> {
  return new Promise(res => {
    const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
    const child = spawn(process.execPath, [vitest, 'run', ...files], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    const take = (b: Buffer) => {
      out = (out + b.toString('utf8')).slice(-20_000)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      // eslint-disable-next-line no-control-regex
      const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
      const lines = plain.split('\n').map(l => l.trim()).filter(l => /^(Test Files|Tests)\b/.test(l))
      res({ ok: code === 0, summary: lines.join('; ') || (code === 0 ? 'passed' : `vitest exited with ${code}`) })
    })
  })
}

/** Painted tile ids (paint layers, masked vertices). */
function paintedTileIds(layers: WorldEditsLayers): Set<number> {
  const ids = new Set<number>()
  for (const l of layers.paint.values()) for (let i = 0; i < l.mask.length; i++) if (l.mask[i]) ids.add(l.words[i]! & 0x3ff)
  return ids
}

/**
 * D19: the painted tiles whose cover (vertex share over the non-synthetic regions, the inventory's `cover.all`) is at
 * least 0.1 % in the staging export and whose set is encoded but not hero.
 */
export function heroCandidates(stagingDir: string, man: WorldManifest, painted: ReadonlySet<number>, pbrIndex: { sets?: Record<string, { hero?: boolean }> } | null): Array<{ tile: string; cover: number }> {
  if (!painted.size || !pbrIndex?.sets) return []
  // TEL-4: B3's split measured cover as the MAX over the fields and the town / near-ring windows, so a tile painted
  // over a courtyard counts by the 3x3 regions around it as well as by the whole export
  const perRegion = new Map<string, { total: number; counts: Map<number, number> }>()
  const counts = new Map<number, number>()
  let total = 0
  for (const r of man.regions) {
    if (r.synthetic) continue
    const bin = decodeTerrainBin(readFileSync(join(stagingDir, r.terrain.file)))
    const own = new Map<number, number>()
    for (const w of bin.textures) {
      const id = w & 0x3ff
      if (painted.has(id)) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
        own.set(id, (own.get(id) ?? 0) + 1)
      }
    }
    total += bin.textures.length
    perRegion.set(`${r.x}_${r.z}`, { total: bin.textures.length, counts: own })
  }
  /** The tile's best cover over a 3x3 window centred on a region that holds it (from HERO_MIN_VERTICES painted). */
  const windowCover = (id: number) => {
    let best = 0
    for (const [key, reg] of perRegion) {
      if (!reg.counts.get(id)) continue
      const [x, z] = key.split('_').map(Number) as [number, number]
      let k = 0, all = 0
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = perRegion.get(`${x + dx}_${z + dz}`)
          if (!w) continue
          k += w.counts.get(id) ?? 0
          all += w.total
        }
      }
      if (k >= HERO_MIN_VERTICES && all) best = Math.max(best, k / all)
    }
    return best
  }
  const out: Array<{ tile: string; cover: number }> = []
  for (const t of man.tiles) {
    if (!painted.has(t.id)) continue
    const cover = Math.max((counts.get(t.id) ?? 0) / (total || 1), windowCover(t.id))
    const key = tileKey(t.source)
    const set = pbrIndex.sets[key]
    if (cover >= HERO_COVER && set && !set.hero) out.push({ tile: key.slice('tile2d:'.length), cover: +cover.toFixed(5) })
  }
  return out.sort((a, b) => a.tile.localeCompare(b.tile))
}

/** A window cover counts from this many painted vertices (~400 m^2): a few dabs never flip a tile. */
const HERO_MIN_VERTICES = 100

/** Check points (WORLD_EDITOR §6.3 row 3): nests, NPCs, gates, places, probes. */
function checkPoints(workRoot: string, man: WorldManifest, layers: WorldEditsLayers): CheckPoint[] {
  const data = (name: string) => readJsonFile<{ entries?: unknown[] }>(join(workRoot, 'out', 'data', `${name}.json`))?.entries
  return checkPointsFrom({
    nests: data('nests') as Parameters<typeof checkPointsFrom>[0]['nests'],
    npcs: data('npcs') as Parameters<typeof checkPointsFrom>[0]['npcs'],
    towns: data('towns') as Parameters<typeof checkPointsFrom>[0]['towns'],
    places: man.places,
    probes: layers.probes.map(p => ({ id: p.id, name: p.name, x: p.x, z: p.z, ...(p.y !== undefined ? { y: p.y } : {}) })),
  })
}

/** LOD0 triangles per model (glb JSON chunk), read once per file. */
function triangleCounter(dirs: { before: string; after: string }, scenes: { before: WorldManifest; after: WorldManifest }) {
  const cache = new Map<string, number>()
  const count = (dir: string, glb: string | undefined) => {
    if (!glb) return 0
    const f = join(dir, glb)
    let n = cache.get(f)
    if (n === undefined) {
      n = existsSync(f) ? glbTriangleCount(readFileSync(f)) : 0
      cache.set(f, n)
    }
    return n
  }
  return (which: 'before' | 'after', model: number) => count(dirs[which], (scenes[which].models[model] as { glb?: string } | undefined)?.glb)
}

/** A report with only row 1 run (the layers stopped the publish before any convert). */
function layersOnlyReport(world: string, layers: ExternalCheck): WorldEditsReport {
  return {
    format: WORLD_EDITS_REPORT_FORMAT, version: WORLD_EDITS_REPORT_VERSION, world, verdict: 'stop', complete: false,
    checks: PUBLISH_CHECKS.map(c => c.key === 'layers'
      ? { id: c.id, key: c.key, title: c.title, status: layers.status, summary: layers.summary, details: layers.details }
      : { id: c.id, key: c.key, title: c.title, status: 'skip' as const, summary: 'Not run: the layers must be valid first.' }),
    nav: { regions: [], totals: { touched: 0, closed: 0, opened: 0, closedSlope: 0, closedWater: 0, objects: 0 }, problems: [] },
    swim: { deepWaterTiles: 0, deepWaterM2: 0, regions: [] }, timingsMs: {},
  }
}

function sentenceOf(rec: PublishRecord, report: WorldEditsReport | null): string {
  if (rec.phase === 'failed') return `Publish failed: ${rec.error ?? 'see the report'}. Nothing was changed.`
  if (!report) return rec.sentence
  const warns = report.checks.filter(c => c.status === 'warn').length
  const stops = report.checks.filter(c => c.status === 'stop')
  if (stops.length) return `Publish stopped: ${stops.map(c => c.summary).join(' ')} Nothing was changed; fix it in the editor and publish again.`
  const drift = rec.drift?.length
    ? ` Note: ${rec.drift.length} file(s) outside your edit differ from the live map (it is older than the converter); they are not published (ask Claude for a full convert).`
    : ''
  return `Ready: ${warns ? `${warns} warning${warns === 1 ? '' : 's'} to look at` : 'every check passed'}. Keep sends it to the local map; Go back changes nothing.${drift}`
}

/** A staging out-opt export for Test in game: links of the live out-opt export + the optimized files. */
function buildOptStaging(p: PublishPaths, optDir: string, opt: Pick<FilesReport, 'written' | 'removed'>): void {
  const prefix = `world/${p.world}/`
  const liveOpt = join(p.optRoot, 'world', p.world)
  rmTree(p.optStagingDir)
  mkdirSync(p.optStagingDir, { recursive: true })
  for (const rel of listFiles(liveOpt)) linkOrCopy(join(liveOpt, ...rel.split('/')), join(p.optStagingDir, ...rel.split('/')))
  for (const rel of opt.written) {
    if (!rel.startsWith(prefix)) continue
    copyInto(join(optDir, ...rel.split('/')), join(p.optStagingDir, ...rel.slice(prefix.length).split('/')))
  }
  for (const rel of opt.removed) {
    if (!rel.startsWith(prefix)) continue
    const f = join(p.optStagingDir, ...rel.slice(prefix.length).split('/'))
    if (existsSync(f)) unlinkRetry(f)
  }
}

/**
 * The base overlay this publish leaves once kept: for every file the edited or the unedited run changed, the unedited
 * version where it differs from the edited one ({ gone } where the unedited export has no such file).
 */
function stageBase(p: PublishPaths, pubDir: string, edited: { changed: string[]; removed: string[] }, base: { changed: string[]; removed: string[] }, baseDir: string): {
  files: Record<string, { live: string } | { gone: true; live: string }>; drop: string[]
} {
  const files: Record<string, { live: string } | { gone: true; live: string }> = {}
  const drop: string[] = []
  const editedRemoved = new Set(edited.removed)
  const rels = [...new Set([...edited.changed, ...edited.removed, ...base.changed, ...base.removed])].sort()
  for (const rel of rels) {
    const after = editedRemoved.has(rel) ? null : join(p.stagingDir, ...rel.split('/'))
    const afterBytes = after && existsSync(after) ? readFileSync(after) : null
    const unedited = join(baseDir, ...rel.split('/'))
    const baseBytes = existsSync(unedited) ? readFileSync(unedited) : null
    if (!afterBytes && !baseBytes) {
      drop.push(rel)
      continue
    }
    if (afterBytes && baseBytes && afterBytes.equals(baseBytes)) {
      drop.push(rel)
      continue
    }
    if (!afterBytes) {
      // the edited export has no such file but the base has: the overlay serves it whatever the live export holds
      copyInto(unedited, join(pubDir, BASE_DIR, 'files', ...rel.split('/')))
      files[rel] = { live: '' }
      continue
    }
    const live = sha256(afterBytes)
    if (!baseBytes) files[rel] = { gone: true, live }
    else {
      copyInto(unedited, join(pubDir, BASE_DIR, 'files', ...rel.split('/')))
      files[rel] = { live }
    }
  }
  return { files, drop }
}

/** Runs steps 1-6 (see the header); returns the record (phase ready, stopped or failed). */
export async function preparePublish(opts: PrepareOptions): Promise<PublishRecord> {
  const p = opts.paths
  const log = opts.log ?? (() => {})
  const cfg = opts.cfg ?? (opts.convert ? undefined : loadConfig())
  const nums = publishNumbers(p)
  const n = (nums.at(-1) ?? 0) + 1
  const pubDir = publishDir(p, n)
  mkdirSync(pubDir, { recursive: true })
  /** An older publish still open is replaced once this one builds (the staging exports are rebuilt). */
  const replaceOlder = () => {
    for (const old of nums) {
      const r = readRecord(p, old)
      if (r && (r.phase === 'ready' || r.phase === 'stopped')) {
        r.phase = 'discarded'
        r.sentence = `Replaced by publish ${n}.`
        writeRecord(p, r)
        rmTree(join(publishDir(p, old), 'out-opt'))
        rmTree(join(publishDir(p, old), BASE_DIR))
      }
    }
  }
  repairPublished(p)
  const published = readPublished(p.editorDir)
  const prev = lastKept(published)
  const since = prev?.journalId ?? 0
  const ch = changesSince(p.editorDir, p.world, since, prev?.notApplied)
  const rec: PublishRecord = {
    format: PUBLISH_FORMAT, version: 1, n, world: p.world, phase: 'preparing', startedAt: new Date().toISOString(),
    steps: stepsOf(PREPARE_STEPS), sentence: 'Publishing: checking and building the changed regions...', changes: [...ch.labels, ...ch.back.labels],
    journalId: ch.journalId, views: ch.views, notApplied: ch.notApplied,
    pid: process.pid,
  }
  const steps = new Steps(p, rec, log)
  steps.save()
  const finish = (phase: PublishPhase, report: WorldEditsReport | null, sentence?: string) => {
    rec.phase = phase
    rec.finishedAt = new Date().toISOString()
    if (report) {
      rec.verdict = report.verdict
      putFile(join(pubDir, 'report.json'), encodeWorldEditsReport(report))
    }
    rec.sentence = sentence ?? sentenceOf(rec, report)
    for (const s of rec.steps) if (s.status === 'wait') s.status = 'skip'
    steps.save()
    putFile(join(pubDir, 'report.html'), renderReportHtml(rec, report, []))
    log(`publish ${n}: ${rec.sentence}`)
    return rec
  }

  try {
    // 1 validate
    steps.start('validate')
    if (!existsSync(join(p.liveDir, 'manifest.json'))) throw new Error(`no live export at ${p.liveDir} (run the convert first)`)
    let live = readManifest(p.liveDir)
    rec.liveManifest = fileSha(join(p.liveDir, 'manifest.json'))
    const files = layerFiles(p.layerDir)
    rec.layerHashes = layerHashes(p.layerDir)
    // DL-7: what changed since the last Keep also counts when it added no entry (an undo, a revert, a removed layer)
    const only = [...new Set([...ch.regions, ...ch.back.regions, ...(prev?.layers ? layerRegionsDiffering(prev.layers, rec.layerHashes) : [])])].sort((a, b) => a - b)
    const layersMoved = !!prev?.layers && !sameHashes(prev.layers, rec.layerHashes)
    const read = await readWorldEditsLayers(p.layerDir, { world: p.world, origin: live.space.originRegion, regions: live.regions })
    const problems = [...read.problems, ...read.unknown.map(f => `${f}: not a layer file`)]
    const layersCheck: ExternalCheck = problems.length
      ? { status: 'stop', summary: `${problems.length} problem(s) in the layers: ${problems[0]}`, details: problems }
      : { status: 'pass', summary: `${files.length} layer file(s), all valid.` }
    if (problems.length) {
      steps.done('validate', `${problems.length} problem(s)`, 'fail')
      return finish('stopped', layersOnlyReport(p.world, layersCheck))
    }
    if (!files.length && !only.length && !layersMoved) {
      steps.done('validate', 'no layers')
      return finish('stopped', null, 'Nothing to publish: there are no edits since the last publish.')
    }
    steps.done('validate', `${files.length} file(s)`)
    replaceOlder()

    // 2 convert: the staging export and the base, under the convert lock
    let lock: { release(): void } | null = null
    let edited: Pick<ConvertRegionsResult, 'changed' | 'removed' | 'regions' | 'drift' | 'coast'>
    let base: Pick<ConvertRegionsResult, 'changed' | 'removed'>
    const baseDir = join(pubDir, 'base-export')
    try {
      steps.start('convert', 'waiting for any running convert')
      lock = await convertLock(p.workRoot, `editor publish ${p.world} ${n}`, opts.lockWaitMs ?? 30 * 60_000, log)
      steps.start('convert', `${only.length} region(s) from the history + the layers' own`)
      const convert = opts.convert ?? (async o => convertRegions({
        world: p.world, only: o.only, liveDir: p.liveDir, stagingDir: o.stagingDir, edits: o.edits, cfg,
        ...(o.record !== undefined ? { record: o.record } : opts.record !== undefined ? { record: opts.record } : {}),
        ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}), log,
      }))
      edited = await convert({ only, edits: p.layerDir, stagingDir: p.stagingDir })
      // PS-5: the staging export links the live files as they are under the lock (a convert this publish waited for
      // may have rewritten them since the validate step): Keep compares against these
      live = readManifest(p.liveDir)
      rec.liveManifest = fileSha(join(p.liveDir, 'manifest.json'))
      rec.regions = edited.regions
      rec.drift = edited.drift
      steps.done('convert', `${edited.changed.length} changed, ${edited.removed.length} removed; ${edited.regions.core.length} region(s) + ring ${edited.regions.ring.length}`)
      steps.start('base')
      base = await convert({ only: edited.regions.core, edits: null, stagingDir: baseDir, record: null })
      steps.done('base', `${base.changed.length} file(s) differ without the layers`)
    } finally {
      lock?.release()
    }
    if (!edited.changed.length && !edited.removed.length) {
      rmTree(baseDir)
      rmTree(p.stagingDir)
      return finish('stopped', null, 'Nothing changed: the map already has these edits.')
    }
    const staged = stageBase(p, pubDir, edited, base, baseDir)
    putFile(join(pubDir, BASE_DIR, 'plan.json'), JSON.stringify(staged, null, 1) + '\n')
    rmTree(baseDir)

    // 3 optimize the changed files (+ the staging out-opt export for Test in game)
    steps.start('optimize')
    const optDir = join(pubDir, 'out-opt')
    rmTree(optDir)
    const list = [...edited.changed, ...edited.removed]
    const precompress = existsSync(join(p.optRoot, 'world', p.world, 'manifest.json.br'))
    const optimize = opts.optimize ?? optimizeFiles
    const opt = list.length
      ? await optimize({ inDir: p.stagingDir, outDir: optDir, files: list, prefix: `world/${p.world}/`, slimFrom: join(p.optRoot, 'slim.json'), precompress, log })
      : { written: [], removed: [] }
    rec.files = { out: edited.changed, outRemoved: edited.removed, opt: opt.written, optRemoved: opt.removed }
    if (existsSync(join(p.optRoot, 'world', p.world))) buildOptStaging(p, optDir, opt)
    steps.done('optimize', `${opt.written.length} written, ${opt.removed.length} removed${precompress ? ' (with .br)' : ''}`)

    // 4 tiles painted past 0.1 % cover
    steps.start('textures')
    const after = readManifest(p.stagingDir)
    const painted = paintedTileIds(read.layers)
    rec.hero = heroCandidates(p.stagingDir, after, painted, readJsonFile(join(p.workRoot, 'out', 'pbr', 'index.json')))
    steps.done('textures', painted.size ? `${painted.size} painted tile(s); ${rec.hero.length} to switch on` : 'no paint')

    // 5 tests, then the checks
    const scene = (m: WorldManifest): CheckScene => ({ placements: m.placements, models: m.models })
    const triangles = triangleCounter({ before: p.liveDir, after: p.stagingDir }, { before: live, after })
    const coastNew = after.warnings.filter(w => /^coast(?: check)?:/.test(w) && !live.warnings.includes(w))
    // the Walkable brush's limits: a force-open outside the bounds, in the sea or under a footprint stays closed
    const walkIgnored = after.warnings.filter(w => /^world edits: walk /.test(w))
    const bounds: ExternalCheck = coastNew.length
      ? { status: 'warn', summary: `${coastNew.length} new coast warning(s): ${coastNew[0]}`, details: [...coastNew, ...walkIgnored] }
      : walkIgnored.length
        ? { status: 'warn', summary: `Some ground you opened for walking stays closed: ${walkIgnored[0]}`, details: walkIgnored }
        : { status: 'pass', summary: 'Inside the map and its coast rules (the validators and the convert).' }
    const external: Record<string, ExternalCheck> = { layers: layersCheck, bounds }
    const extra = (after.report as { edits?: { nav?: unknown; baseChanged?: string[]; problems?: string[]; placements?: { problems?: string[] } } } | undefined)?.edits
    // H12-PS-3 (the convert's half): the staging convert reads the layers against the export and refuses the whole set
    // on a mismatch ("world edits: ... the layers are ignored"); a skipped edit or a nav mismatch is an "edits:" warning
    const refused = after.warnings.filter(w => /^world edits: .*the layers are ignored/.test(w) || /^edits: /.test(w))
    const editProblems = [...new Set([...(extra?.problems ?? []), ...(extra?.placements?.problems ?? []), ...refused])]
    if (extra?.baseChanged?.length) {
      external.layers = { status: 'warn', summary: `The ground under the edits changed since they were made in ${extra.baseChanged.join(', ')}: check those regions.`, details: { baseChanged: extra.baseChanged } }
    }
    // an edit the edits pass refused (a uid collision, the object changed under a move) stops here, never a silent skip
    if (editProblems.length) {
      external.layers = { status: 'stop', summary: `${editProblems.length} edit(s) could not be applied: ${editProblems[0]}`, details: editProblems }
    }
    if (opts.tests === false) {
      external.tests = { status: 'skip', summary: 'Not run (--no-tests).' }
      steps.skip('tests', 'not run')
    } else {
      steps.start('tests')
      const townIds = new Set(((readJsonFile<{ entries?: Array<{ regions?: number[] }> }>(join(p.workRoot, 'out', 'data', 'towns.json'))?.entries ?? []).flatMap(t => t.regions ?? [])))
      const testFiles = publishTests(p.repoRoot, { coast: edited.coast === 'run', town: edited.regions.core.some(id => townIds.has(id)) })
      const t = await (opts.runTests ?? (f => runVitest(p.repoRoot, f)))(testFiles)
      rec.tests = { ok: t.ok, files: testFiles, summary: t.summary }
      external.tests = { status: t.ok ? 'pass' : 'stop', summary: t.ok ? `${testFiles.length} test file(s) passed (${t.summary}).` : `Tests failed: ${t.summary}`, details: testFiles }
      steps.done('tests', t.summary, t.ok ? 'done' : 'fail')
    }
    steps.start('checks')
    const report = opts.checks ? opts.checks({ live, after, layers: read.layers, external }) : runPublishChecks({
      world: p.world, origin: live.space.originRegion, spawn: live.spawn ?? { x: 0, y: 0, z: 0 }, before: readNav(p.liveDir), after: readNav(p.stagingDir),
      nav: (extra?.nav ?? null) as Parameters<typeof runPublishChecks>[0]['nav'], points: checkPoints(p.workRoot, live, read.layers),
      scene: { before: scene(live), after: scene(after) }, triangles,
      lights: read.layers.lights.map(l => ({ x: l.x, z: l.z })),
      zones: read.layers.zones as Parameters<typeof runPublishChecks>[0]['zones'],
      external,
    })
    steps.done('checks', `verdict ${report.verdict}`)
    steps.start('report')
    steps.done('report')
    return finish(report.verdict === 'stop' ? 'stopped' : 'ready', report)
  } catch (e) {
    steps.failRunning((e as Error).message)
    return finish('failed', null)
  }
}

// --- keep, discard, undo ---------------------------------------------------------------------------------------------

/** One file of a swap: which tree, the path in it, whether a live file was there (then it is in the backup). */
export interface SwapEntry {
  tree: 'out' | 'opt' | 'base'
  rel: string
  had: boolean
  /** Removed from the live tree (no new file). */
  remove?: boolean
}

const treeRoot = (p: PublishPaths, tree: SwapEntry['tree']) => tree === 'out' ? p.liveDir : tree === 'opt' ? p.optRoot : join(p.editorDir, BASE_DIR)

/** Manifests and slim.json last (the client reads them first): files, slim, the out-opt manifest, the out manifest, the base index. */
function swapOrder(e: { tree: SwapEntry['tree']; rel: string }): number {
  if (e.tree === 'base') return e.rel === BASE_INDEX ? 6 : 1
  if (e.tree === 'opt' && /^slim\.json(\.br)?$/.test(e.rel)) return 3
  if (e.tree === 'opt' && /^world\/[^/]+\/manifest\.json(\.br)?$/.test(e.rel)) return 4
  if (e.tree === 'out' && e.rel === 'manifest.json') return 5
  return 0
}

/**
 * Replaces live files from their sources one by one (temp + rename), keeping every replaced or removed live file in
 * `backupDir/<tree>/<rel>`; on a failure puts back what it already swapped and throws. Returns the entries swapped.
 */
export function swapFiles(p: PublishPaths, backupDir: string, items: ReadonlyArray<{ tree: SwapEntry['tree']; rel: string; from: string | null }>): SwapEntry[] {
  const sorted = [...items].sort((a, b) => swapOrder(a) - swapOrder(b) || (a.tree < b.tree ? -1 : a.tree > b.tree ? 1 : 0) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const done: SwapEntry[] = []
  try {
    for (const it of sorted) {
      const target = join(treeRoot(p, it.tree), ...it.rel.split('/'))
      const had = existsSync(target)
      if (!had && !it.from) continue
      if (had) linkOrCopy(target, join(backupDir, it.tree, ...it.rel.split('/')))
      if (it.from) copyInto(it.from, target)
      else unlinkRetry(target)
      done.push({ tree: it.tree, rel: it.rel, had, ...(it.from ? {} : { remove: true }) })
    }
  } catch (e) {
    try {
      restoreFiles(p, backupDir, done)
    } catch (r) {
      throw new Error(`the swap stopped at a file (${(e as Error).message}) and putting back the ${done.length} file(s) already replaced failed too (${(r as Error).message}); the old files are in ${backupDir}`)
    }
    throw new Error(`the swap stopped at a file (${(e as Error).message}); the ${done.length} file(s) already replaced were put back`)
  }
  return done
}

/** Puts back swapped files from the backup (reverse order): a file that was there is copied back, a new one removed. */
export function restoreFiles(p: PublishPaths, backupDir: string, entries: readonly SwapEntry[]): void {
  for (const e of [...entries].reverse()) {
    const target = join(treeRoot(p, e.tree), ...e.rel.split('/'))
    if (e.had) copyInto(join(backupDir, e.tree, ...e.rel.split('/')), target)
    else if (existsSync(target)) unlinkRetry(target)
  }
}

export interface KeepOptions {
  paths: PublishPaths
  n: number
  log?: (line: string) => void
  lockWaitMs?: number
  /** `texpipe hero <tile>... on --json` (default: TT-B's verb in a child process); the repo-relative files it wrote. */
  hero?: (tiles: string[]) => Promise<{ files: string[] }>
  /** Re-optimizes out/pbr/index.json into out-opt after a hero flip (default optimize-out --files). */
  optimize?: (o: Parameters<typeof optimizeFiles>[0]) => Promise<Pick<FilesReport, 'written' | 'removed'>>
  /** The pathspec commit (default ./git.ts commitPaths). */
  commit?: (paths: string[], message: string) => string | null
}

/**
 * TT-B's verb in its own process, all tiles in one call (D7: WE-A's Publish never edits overrides.json or the index
 * itself): `pnpm texpipe hero <tile>... on --json` prints { on, tiles, warnings, files }.
 */
export function texpipeHero(repoRoot: string, tiles: string[]): Promise<{ files: string[] }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/texpipe/src/cli.ts', 'hero', ...tiles, 'on', '--json'], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr.on('data', (b: Buffer) => (err += b.toString()))
    child.on('close', code => {
      if (code !== 0) return rej(new Error(`texpipe hero: ${(err || out).trim().split('\n').pop() ?? code}`))
      try {
        const line = out.trim().split('\n').reverse().find(l => l.startsWith('{')) ?? '{}'
        const j = JSON.parse(line) as { files?: string[] }
        res({ files: Array.isArray(j.files) ? j.files : [] })
      } catch {
        rej(new Error('texpipe hero: no JSON answer'))
      }
    })
  })
}

function failKeep(p: PublishPaths, rec: PublishRecord, msg: string): PublishRecord {
  rec.phase = 'ready'
  rec.error = msg
  rec.sentence = `Keep did not run: ${msg}`
  writeRecord(p, rec)
  return rec
}

/** Keep (§6.2 step 8): see the header. Refuses unless the publish is ready and the live map is what it was built on. */
export async function keepPublish(opts: KeepOptions): Promise<PublishRecord> {
  const p = opts.paths
  const log = opts.log ?? (() => {})
  const rec = readRecord(p, opts.n)
  if (!rec) throw new Error(`publish ${opts.n} does not exist`)
  if (rec.phase !== 'ready') throw new Error(`publish ${opts.n} is ${rec.phase}, not ready to keep`)
  if (rec.verdict === 'stop') throw new Error(`publish ${opts.n} stopped at a check; it cannot be kept`)
  const pubDir = publishDir(p, opts.n)
  rec.phase = 'keeping'
  rec.steps = [...rec.steps.filter(s => !KEEP_STEPS.some(([k]) => `keep-${k}` === s.key)), ...stepsOf(KEEP_STEPS).map(s => ({ ...s, key: `keep-${s.key}` }))]
  delete rec.error
  const steps = new Steps(p, rec, log)
  steps.save()
  repairPublished(p)
  let releaseGpu: (() => void) | null = null
  let lock: { release(): void } | null = null
  let swappedOk = false
  let indexed = false
  try {
    steps.start('keep-locks')
    const wait = opts.lockWaitMs ?? 10 * 60_000
    if (rec.hero?.length) releaseGpu = await acquireGpuLock(p.workRoot, `WE-A editor publish ${p.world} ${opts.n} (texpipe hero)`, wait, log)
    lock = await convertLock(p.workRoot, `editor keep ${p.world} ${opts.n}`, wait, log)
    if (!existsSync(join(p.liveDir, 'manifest.json')) || fileSha(join(p.liveDir, 'manifest.json')) !== rec.liveManifest) {
      steps.done('keep-locks', 'the live map changed', 'fail')
      lock.release()
      lock = null
      return failKeep(p, rec, 'the map changed since this publish was built (a convert ran). Publish again.')
    }
    // PS-1: Keep commits the layer folder; it must hold exactly what this publish checked and converted
    if (rec.layerHashes && !sameHashes(rec.layerHashes, layerHashes(p.layerDir))) {
      steps.done('keep-locks', 'the edits changed', 'fail')
      lock.release()
      lock = null
      return failKeep(p, rec, 'your edits changed after this publish was built (a Save since). Publish again.')
    }
    steps.done('keep-locks')

    steps.start('keep-swap')
    const files = rec.files ?? { out: [], outRemoved: [], opt: [], optRemoved: [] }
    const plan = readJsonFile<{ files: Record<string, { live: string; gone?: true }>; drop: string[] }>(join(pubDir, BASE_DIR, 'plan.json')) ?? { files: {}, drop: [] }
    const baseIndexFile = join(p.editorDir, BASE_DIR, BASE_INDEX)
    const baseIndex = readJsonFile<{ files: Record<string, { live: string; gone?: true }> }>(baseIndexFile) ?? { files: {} }
    for (const rel of plan.drop) delete baseIndex.files[rel]
    Object.assign(baseIndex.files, plan.files)
    const sortedBase = Object.fromEntries(Object.entries(baseIndex.files).sort(([a], [b]) => (a < b ? -1 : 1)))
    putFile(join(pubDir, BASE_DIR, 'next-index.json'), JSON.stringify({ format: 'sro-editor-base', version: 1, world: p.world, files: sortedBase }, null, 1) + '\n')
    const items: Array<{ tree: SwapEntry['tree']; rel: string; from: string | null }> = [
      ...files.out.map(rel => ({ tree: 'out' as const, rel, from: join(p.stagingDir, ...rel.split('/')) })),
      ...files.outRemoved.map(rel => ({ tree: 'out' as const, rel, from: null })),
      ...files.opt.map(rel => ({ tree: 'opt' as const, rel, from: join(pubDir, 'out-opt', ...rel.split('/')) })),
      ...files.optRemoved.map(rel => ({ tree: 'opt' as const, rel, from: null })),
      // the base overlay swaps with the export, so Undo restores both
      ...Object.entries(plan.files).filter(([, v]) => !v.gone).map(([rel]) => ({ tree: 'base' as const, rel: `files/${rel}`, from: join(pubDir, BASE_DIR, 'files', ...rel.split('/')) })),
      ...[...plan.drop, ...Object.entries(plan.files).filter(([, v]) => v.gone).map(([rel]) => rel)].map(rel => ({ tree: 'base' as const, rel: `files/${rel}`, from: null })),
      { tree: 'base' as const, rel: BASE_INDEX, from: join(pubDir, BASE_DIR, 'next-index.json') },
    ]
    const swapped = swapFiles(p, join(pubDir, 'backup'), items)
    swappedOk = true
    // DL-6: what the live files are right after the swap (Undo refuses once a convert rewrote any of them)
    const afterSwap: Record<string, string> = {}
    for (const e of swapped) {
      if (e.tree === 'base') continue
      const f = join(treeRoot(p, e.tree), ...e.rel.split('/'))
      afterSwap[`${e.tree}:${e.rel}`] = existsSync(f) ? fileSha(f) : ''
    }
    rec.swap = swapped
    rec.afterSwap = afterSwap
    writeRecord(p, rec)
    putFile(join(pubDir, 'swap.json'), JSON.stringify(swapped, null, 1) + '\n')
    lock.release()
    lock = null
    steps.done('keep-swap', `${swapped.filter(s => s.tree !== 'base').length} live file(s) replaced`)

    steps.start('keep-hero')
    const flipped: string[] = []
    let heroFiles: string[] = []
    if (rec.hero?.length) {
      try {
        const tiles = rec.hero.map(h => h.tile)
        heroFiles = (await (opts.hero ?? (t => texpipeHero(p.repoRoot, t)))(tiles)).files
        flipped.push(...tiles)
        // the optimized export takes the index with the same per-file step as a full optimize
        const outRel = (f: string) => relative(join(p.workRoot, 'out'), resolve(p.repoRoot, f)).split('\\').join('/')
        const optFiles = heroFiles.map(outRel).filter(f => !f.startsWith('..'))
        if (optFiles.length) {
          const optimize = opts.optimize ?? optimizeFiles
          await optimize({ inDir: join(p.workRoot, 'out'), outDir: p.optRoot, files: optFiles, precompress: existsSync(join(p.optRoot, 'pbr', 'index.json.br')), log })
        }
        steps.done('keep-hero', flipped.join(', '))
      } catch (e) {
        steps.done('keep-hero', `${(e as Error).message} (the map is published; the tiles keep their plain look until a texture run)`, 'fail')
      }
    } else steps.skip('keep-hero', 'no painted tile past 0.1 %')
    releaseGpu?.()
    releaseGpu = null

    steps.start('keep-base')
    steps.done('keep-base', `${Object.keys(plan.files).length} file(s) in the base overlay`)

    steps.start('keep-commit')
    const rel = (abs: string) => relative(p.repoRoot, abs).split('\\').join('/')
    const layerRel = rel(p.layerDir)
    const paths = layerRel.startsWith('..') ? [] : [layerRel]
    for (const f of heroFiles) if (f.startsWith('content/')) paths.push(f)
    try {
      const sha = (opts.commit ?? ((ps, m) => commitPaths(p.repoRoot, ps, m)))(paths, commitMessage(rec.changes, rec.n))
      rec.commit = sha ?? 'nothing to commit'
      steps.done('keep-commit', rec.commit)
    } catch (e) {
      rec.commit = `not committed: ${(e as Error).message}`
      steps.done('keep-commit', rec.commit, 'fail')
    }

    steps.start('keep-cleanup')
    try {
      rmTree(p.stagingDir)
      rmTree(p.optStagingDir)
      rmTree(join(pubDir, 'out-opt'))
      steps.done('keep-cleanup')
    } catch (e) {
      steps.done('keep-cleanup', `left behind: ${(e as Error).message}`, 'fail')
    }

    rec.finishedAt = new Date().toISOString()
    const idx = readPublished(p.editorDir)
    idx.kept.push(keptEntry(rec))
    writePublished(p.editorDir, idx)
    indexed = true
    rec.phase = 'kept'
    rec.sentence = 'Published to the map on this PC. Restart the local server to play it here; Deploy sends it to the friends.'
    writeRecord(p, rec)
    putFile(join(pubDir, 'report.html'), renderReportHtml(rec, readJsonFile(join(pubDir, 'report.json')), shotsOf(pubDir)))
    return rec
  } catch (e) {
    steps.failRunning((e as Error).message)
    if (!swappedOk) return failKeep(p, rec, (e as Error).message)
    // PS-2: the live files are swapped (the record and swap.json list them): it is kept, with the error noted, and in
    // published.json (now, or by the next publish job when that file cannot be written yet), so Undo still works
    rec.phase = 'kept'
    rec.finishedAt ??= new Date().toISOString()
    rec.sentence = `Published, but a last step failed: ${(e as Error).message}`
    if (!indexed) {
      try {
        const idx = readPublished(p.editorDir)
        if (!idx.kept.some(k => k.n === rec.n)) idx.kept.push(keptEntry(rec))
        writePublished(p.editorDir, idx)
      } catch {
        rec.pendingIndex = true
      }
    }
    try {
      writeRecord(p, rec)
    } catch {
      // the record keeps its last state; swap.json and the backup are on disk
    }
    return rec
  } finally {
    lock?.release()
    releaseGpu?.()
  }
}

/** Go back: the staging exports go; the live export was never touched. */
export function discardPublish(p: PublishPaths, n: number): PublishRecord {
  const rec = readRecord(p, n)
  if (!rec) throw new Error(`publish ${n} does not exist`)
  if (rec.phase !== 'ready' && rec.phase !== 'stopped' && rec.phase !== 'failed') throw new Error(`publish ${n} is ${rec.phase}; only an open publish can be discarded`)
  rmTree(p.stagingDir)
  rmTree(p.optStagingDir)
  rmTree(join(publishDir(p, n), 'out-opt'))
  rmTree(join(publishDir(p, n), BASE_DIR))
  rec.phase = 'discarded'
  rec.finishedAt = new Date().toISOString()
  rec.sentence = 'Went back: nothing was changed. Your edits are still saved.'
  writeRecord(p, rec)
  return rec
}

/** Undo the newest kept publish: its backup goes back (the layers and their commit stay). */
export async function undoPublish(p: PublishPaths, n: number, opts: { lockWaitMs?: number; log?: (l: string) => void } = {}): Promise<PublishRecord> {
  repairPublished(p)
  const rec = readRecord(p, n)
  if (!rec) throw new Error(`publish ${n} does not exist`)
  const idx = readPublished(p.editorDir)
  const last = lastKept(idx)
  if (rec.phase !== 'kept' || last?.n !== n) throw new Error(`only the newest kept publish can be undone (publish ${last?.n ?? '-'})`)
  const entries = readJsonFile<SwapEntry[]>(join(publishDir(p, n), 'swap.json')) ?? rec.swap ?? null
  if (!entries) throw new Error(`publish ${n} has no swap list; it cannot be undone`)
  const lock = await convertLock(p.workRoot, `editor undo ${p.world} ${n}`, opts.lockWaitMs ?? 10 * 60_000, opts.log ?? (() => {}))
  try {
    // DL-6: the backups fit only the live files this Keep wrote; after a full convert they would make a mixed map
    for (const [key, want] of Object.entries(rec.afterSwap ?? {})) {
      const i = key.indexOf(':')
      const f = join(treeRoot(p, key.slice(0, i) as SwapEntry['tree']), ...key.slice(i + 1).split('/'))
      const now = existsSync(f) ? fileSha(f) : ''
      if (now !== want) throw new Error(`The map was rebuilt since publish ${n} (${key.slice(i + 1)} changed), so Undo would mix two maps. Publish again, or ask Claude.`)
    }
    restoreFiles(p, join(publishDir(p, n), 'backup'), entries)
  } finally {
    lock.release()
  }
  last.undone = new Date().toISOString()
  writePublished(p.editorDir, idx)
  rec.phase = 'undone'
  rec.sentence = `Undone: the map is back to how it was before publish ${n}. Your edits are still saved; publish again to bring them back.`
  writeRecord(p, rec)
  return rec
}

/** The before / after images the page sent (shots/*.png). */
export function shotsOf(pubDir: string): Array<{ name: string; dataUrl: string }> {
  const dir = join(pubDir, 'shots')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => /^[a-z0-9_-]{1,64}\.png$/.test(f)).sort()
    .map(f => ({ name: f, dataUrl: `data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}` }))
}

/** The overlay's index (the Vite side reads it to serve the base; ../vite.config.ts). */
export function baseIndexPath(editorDir: string): string {
  return resolve(editorDir, BASE_DIR, BASE_INDEX)
}
