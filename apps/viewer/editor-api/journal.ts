/**
 * The edit journal (docs/WORLD_EDITOR.md §3.4, D16, D17): `work/editor/<world>/journal.ndjson` plus one patch per
 * change in `patches/<id>.bin` (./patch.ts), outside git, kept across restarts.
 *
 * journal.ndjson: line 1 is the header { format, version, world, head, folded, nextId, files }, then one entry per
 * line, oldest first. Entries [0, head) are applied to the saved layers, [head, n) can be redone. `files` maps every
 * layer file to the SHA-256 the last save wrote, so a load can tell when the layers changed outside the editor (an
 * interrupted save, git, another tool). The file is always rewritten whole through temp + rename (the API's save
 * writes it after the layers and the patches); it stays small (≤ 2,000 short lines).
 *
 * The cap (D17): beyond JOURNAL_MAX_CHANGES changes or JOURNAL_MAX_BYTES of patches, the oldest applied changes fold
 * into the saved state (their patches are removed; `folded` counts them); they stay revertible per region and through
 * git.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  JOURNAL_FORMAT, JOURNAL_MAX_BYTES, JOURNAL_MAX_CHANGES, JOURNAL_VERSION, type JournalEntry, type JournalState,
  type JournalUpdate,
} from './protocol.ts'
import type { FileStep } from './atomic.ts'

export const JOURNAL_FILE = 'journal.ndjson'
export const PATCH_DIR = 'patches'

interface JournalHeader {
  format: typeof JOURNAL_FORMAT
  version: number
  world: string
  head: number
  folded: number
  nextId: number
  files: Record<string, string>
}

export interface JournalData {
  header: JournalHeader
  entries: JournalEntry[]
}

export class JournalError extends Error {}

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi

/** Checks a page-made entry (the API stamps `time` and `bytes`); returns the cleaned copy. */
export function checkEntry(e: unknown): JournalEntry {
  const r = e as Record<string, unknown>
  if (typeof e !== 'object' || e === null) throw new JournalError('a change must be an object')
  if (!isInt(r.id, 1, Number.MAX_SAFE_INTEGER)) throw new JournalError('a change needs an id (a positive whole number)')
  if (typeof r.label !== 'string' || !r.label || r.label.length > 300) throw new JournalError(`change ${r.id}: a label of 1-300 characters`)
  if (typeof r.tool !== 'string' || !/^[a-z0-9-]{1,40}$/.test(r.tool)) throw new JournalError(`change ${r.id}: a tool name (a-z, 0-9, -)`)
  if (!Array.isArray(r.regions) || r.regions.length > 4096 || !r.regions.every(x => isInt(x, 0, 0xffff))) {
    throw new JournalError(`change ${r.id}: regions must be region ids (0..65535)`)
  }
  const out: JournalEntry = { id: r.id, label: r.label, tool: r.tool, regions: [...(r.regions as number[])] }
  if (r.time !== undefined) {
    if (typeof r.time !== 'string' || r.time.length > 40 || Number.isNaN(Date.parse(r.time))) throw new JournalError(`change ${r.id}: time must be an ISO time`)
    out.time = r.time
  }
  if (r.revertOf !== undefined) {
    if (!isInt(r.revertOf, 1, Number.MAX_SAFE_INTEGER)) throw new JournalError(`change ${r.id}: revertOf must be a change id`)
    out.revertOf = r.revertOf
  }
  if (r.dependsOn !== undefined) {
    if (!Array.isArray(r.dependsOn) || r.dependsOn.length > 4096 || !r.dependsOn.every(x => isInt(x, 1, Number.MAX_SAFE_INTEGER))) {
      throw new JournalError(`change ${r.id}: dependsOn must be change ids`)
    }
    out.dependsOn = [...(r.dependsOn as number[])]
  }
  if (r.view !== undefined) {
    if (!Array.isArray(r.view) || r.view.length > 16 || !r.view.every(x => typeof x === 'number' && Number.isFinite(x))) {
      throw new JournalError(`change ${r.id}: view must be up to 16 numbers`)
    }
    out.view = [...(r.view as number[])]
  }
  if (r.starred !== undefined) out.starred = r.starred === true
  return out
}

export const emptyJournal = (world: string): JournalData => ({
  header: { format: JOURNAL_FORMAT, version: JOURNAL_VERSION, world, head: 0, folded: 0, nextId: 1, files: {} },
  entries: [],
})

/** Reads the journal of a world folder; an absent file is an empty journal. */
export function readJournal(dir: string, world: string): JournalData {
  let text: string
  try {
    text = readFileSync(join(dir, JOURNAL_FILE), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyJournal(world)
    throw e
  }
  const lines = text.split('\n').filter(l => l.trim())
  if (!lines.length) return emptyJournal(world)
  const header = JSON.parse(lines[0]!) as JournalHeader
  if (header.format !== JOURNAL_FORMAT || header.version !== JOURNAL_VERSION) throw new JournalError(`${JOURNAL_FILE}: not a version ${JOURNAL_VERSION} editor journal`)
  if (header.world !== world) throw new JournalError(`${JOURNAL_FILE}: the journal of ${header.world}, not ${world}`)
  const entries = lines.slice(1).map(l => JSON.parse(l) as JournalEntry)
  if (!isInt(header.head, 0, entries.length)) throw new JournalError(`${JOURNAL_FILE}: head ${header.head} is outside 0..${entries.length}`)
  header.files ??= {}
  return { header, entries }
}

export const serializeJournal = (j: JournalData): string =>
  [JSON.stringify(j.header), ...j.entries.map(e => JSON.stringify(e))].join('\n') + '\n'

export const patchFile = (dir: string, id: number) => join(dir, PATCH_DIR, `${id}.bin`)

export function journalState(j: JournalData): JournalState {
  return {
    head: j.header.head,
    folded: j.header.folded,
    nextId: j.header.nextId,
    entries: j.entries.map(e => ({ ...e })),
    bytes: j.entries.reduce((s, e) => s + (e.bytes ?? 0), 0),
  }
}

export interface JournalPlan {
  next: JournalData
  /** Patch files to write (before the layers). */
  patches: FileStep[]
  /** Patch files to remove (after the journal: dropped redo entries and folded ones). */
  stale: FileStep[]
}

/**
 * Plans an update (pure but for the paths): drop the redo tail past `dropAfterId`, append the new changes, set the
 * head, record the layer hashes, then fold over the cap. Throws a JournalError for anything inconsistent.
 */
export function planJournalUpdate(
  dir: string,
  current: JournalData,
  update: JournalUpdate | undefined,
  files: Record<string, string>,
  opts: { maxChanges?: number; maxBytes?: number; now?: () => Date } = {},
): JournalPlan {
  const maxChanges = opts.maxChanges ?? JOURNAL_MAX_CHANGES
  const maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES
  const now = opts.now ?? (() => new Date())
  const header = { ...current.header, files: { ...files } }
  let entries = current.entries.map(e => ({ ...e }))
  const patches: FileStep[] = []
  const stale: FileStep[] = []
  if (update) {
    if (update.dropAfterId !== undefined && update.dropAfterId !== null) {
      if (!isInt(update.dropAfterId, 0, Number.MAX_SAFE_INTEGER)) throw new JournalError('dropAfterId must be a change id or 0')
      for (const e of entries) if (e.id > update.dropAfterId) stale.push({ file: patchFile(dir, e.id), remove: true })
      entries = entries.filter(e => e.id <= update.dropAfterId!)
    }
    let last = Math.max(header.nextId - 1, ...entries.map(e => e.id), 0)
    for (const a of update.append ?? []) {
      const entry = checkEntry(a?.entry)
      if (entry.id <= last) throw new JournalError(`change ${entry.id}: ids must increase (the next is ${last + 1} or above)`)
      if (typeof a.patch !== 'string') throw new JournalError(`change ${entry.id}: missing its patch`)
      const bytes = Buffer.from(a.patch, 'base64')
      entry.bytes = bytes.length
      entry.time ??= now().toISOString()
      patches.push({ file: patchFile(dir, entry.id), data: bytes })
      entries.push(entry)
      last = entry.id
    }
    header.nextId = Math.max(header.nextId, last + 1)
    if (!isInt(update.head, 0, entries.length)) throw new JournalError(`head ${update.head} is outside 0..${entries.length}`)
    header.head = update.head
  }
  // The cap: fold the oldest applied changes; if every change is a redo entry, drop the newest redo entries.
  let bytes = entries.reduce((s, e) => s + (e.bytes ?? 0), 0)
  while (entries.length > maxChanges || (bytes > maxBytes && entries.length > 0)) {
    const e = header.head > 0 ? entries.shift()! : entries.pop()!
    if (header.head > 0) {
      header.head--
      header.folded++
    }
    bytes -= e.bytes ?? 0
    const appended = patches.findIndex(p => p.file === patchFile(dir, e.id))
    if (appended >= 0) patches.splice(appended, 1)
    else stale.push({ file: patchFile(dir, e.id), remove: true })
  }
  return { next: { header, entries }, patches, stale }
}

/**
 * Plans a page-form journal (the page sends every change record, oldest first, each save): a record whose JSON is
 * unchanged keeps its patch file; a changed or new one is (re)written; a stored entry the page no longer sends is
 * removed. Ids must increase; past the cap the oldest records fold. The head counts the records not undone.
 */
export function planJournalRecords(
  dir: string,
  current: JournalData,
  records: readonly unknown[],
  files: Record<string, string>,
  opts: { maxChanges?: number; maxBytes?: number; now?: () => Date } = {},
): JournalPlan {
  const maxChanges = opts.maxChanges ?? JOURNAL_MAX_CHANGES
  const maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES
  const now = opts.now ?? (() => new Date())
  if (!Array.isArray(records) || records.length > 1_000_000) throw new JournalError('the journal must be a list of changes')
  const stored = new Map(current.entries.map(e => [e.id, e]))
  let entries: JournalEntry[] = []
  const texts = new Map<number, Buffer>()
  let last = 0
  for (const r of records) {
    const rec = r as Record<string, unknown>
    if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new JournalError('every change must be an object')
    if (!isInt(rec.id, 1, Number.MAX_SAFE_INTEGER) || rec.id <= last) throw new JournalError(`change ${String(rec.id)}: ids must be positive and increasing`)
    last = rec.id
    const text = Buffer.from(JSON.stringify(rec), 'utf8')
    const hash = createHash('sha256').update(text).digest('hex')
    const label = typeof rec.label === 'string' && rec.label ? rec.label.slice(0, 300) : `Change ${rec.id}`
    const regions = Array.isArray(rec.regions) ? rec.regions.filter(x => isInt(x, 0, 0xffff)).slice(0, 4096) as number[] : []
    const time = typeof rec.at === 'string' && !Number.isNaN(Date.parse(rec.at)) ? rec.at.slice(0, 40) : stored.get(rec.id)?.time ?? now().toISOString()
    const tool = typeof rec.tool === 'string' && /^[a-z0-9-]{1,40}$/.test(rec.tool) ? rec.tool : 'change'
    const entry: JournalEntry = { id: rec.id, time, label, tool, regions, bytes: text.length, hash, record: true }
    if (typeof rec.state === 'string') entry.state = rec.state.slice(0, 20)
    // the camera the page recorded (WE-U2): Publish's before / after views and Test in game's spot
    if (Array.isArray(rec.view) && rec.view.length >= 6 && rec.view.length <= 16 && rec.view.every(x => typeof x === 'number' && Number.isFinite(x))) entry.view = [...(rec.view as number[])]
    if (rec.starred === true) entry.starred = true
    entries.push(entry)
    texts.set(rec.id, text)
  }
  // The cap: fold the oldest.
  let bytes = entries.reduce((s, e) => s + (e.bytes ?? 0), 0)
  while (entries.length > maxChanges || (bytes > maxBytes && entries.length > 0)) {
    bytes -= entries[0]!.bytes ?? 0
    entries = entries.slice(1)
  }
  const keep = new Set(entries.map(e => e.id))
  // Folded: every change older than the oldest kept one that is gone now (the page's own cap or ours); a stored change
  // newer than that and gone was dropped (a redo tail), not folded.
  const firstKept = entries[0]?.id ?? Infinity
  const gone = new Set<number>()
  for (const id of [...current.entries.map(e => e.id), ...texts.keys()]) if (!keep.has(id) && id < firstKept) gone.add(id)
  const folded = gone.size
  const patches: FileStep[] = []
  for (const e of entries) {
    const old = stored.get(e.id)
    if (!old || old.hash !== e.hash || !old.record) patches.push({ file: patchFile(dir, e.id), data: texts.get(e.id)! })
  }
  const stale: FileStep[] = current.entries.filter(e => !keep.has(e.id)).map(e => ({ file: patchFile(dir, e.id), remove: true as const }))
  const header = {
    ...current.header,
    files: { ...files },
    head: entries.filter(e => e.state !== 'undone').length,
    folded: current.header.folded + folded,
    nextId: Math.max(current.header.nextId, last + 1),
  }
  return { next: { header, entries }, patches, stale }
}

/** Plans a reset: every change folds into the saved state (when the layers changed outside the editor). */
export function planJournalReset(dir: string, current: JournalData, files: Record<string, string>): JournalPlan {
  return {
    next: {
      header: { ...current.header, head: 0, folded: current.header.folded + current.header.head, files: { ...files } },
      entries: [],
    },
    patches: [],
    stale: current.entries.map(e => ({ file: patchFile(dir, e.id), remove: true as const })),
  }
}
