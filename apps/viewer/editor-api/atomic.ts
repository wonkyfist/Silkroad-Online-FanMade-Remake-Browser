/**
 * Atomic file I/O for the editor API (docs/WORLD_EDITOR.md §3.5 D18, §2.2 D3): every write is temp + fsync + rename in
 * the target's folder, never in place (a hard-linked staging file must never change the live one, §F14), and only
 * inside the API's writable roots. A save is two-phase: every temp file is written and synced first (any failure
 * removes them all and changes nothing), then the renames run in order, the journal last.
 *
 * Windows: a rename over a file another process has open (a dev server, an indexer, Dropbox) can fail with EPERM /
 * EBUSY / EACCES for a moment; renames and removes retry with a short backoff before they give up.
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRIES = 8

let tempCounter = 0

/** True when `file` is `root` itself or inside it (after resolving). */
export function isInside(root: string, file: string): boolean {
  const r = resolve(root)
  const f = resolve(file)
  return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * A relative path from the page (forward slashes) resolved under `root`; throws for anything that could leave it:
 * absolute paths, drive letters, backslashes, `.` / `..` segments, empty segments, NUL.
 */
export function resolveUnder(root: string, rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.length > 200) throw new PathError('expected a relative path')
  if (rel.includes('\\') || rel.includes('\0') || rel.includes(':') || isAbsolute(rel) || rel.startsWith('/')) {
    throw new PathError(`not a relative path: ${JSON.stringify(rel)}`)
  }
  for (const seg of rel.split('/')) if (!seg || seg === '.' || seg === '..') throw new PathError(`bad path segment in ${JSON.stringify(rel)}`)
  const file = join(root, ...rel.split('/'))
  if (!isInside(root, file) || resolve(file) === resolve(root)) throw new PathError(`${JSON.stringify(rel)} leaves its folder`)
  return file
}

export class PathError extends Error {}

/** The roots the API may write under (D3); every write and remove checks it. */
export class WriteScope {
  readonly roots: readonly string[]
  constructor(roots: readonly string[]) {
    this.roots = roots.map(r => resolve(r))
  }
  check(file: string): string {
    const f = resolve(file)
    if (!this.roots.some(r => isInside(r, f) && f !== r)) throw new PathError(`the editor may not write ${f}`)
    return f
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function retry<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (!RETRY_CODES.has(code) || attempt >= RETRIES) throw e
      sleepSync(25 * (attempt + 1))
    }
  }
}

/** Writes and fsyncs a temp file beside `file`; returns its path. */
export function writeTemp(file: string, data: Uint8Array | string): string {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${++tempCounter}.tmp`)
  const fd = openSync(tmp, 'wx')
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    rmSync(tmp, { force: true })
    throw e
  }
  closeSync(fd)
  return tmp
}

/** temp + fsync + rename, inside the scope. */
export function writeFileAtomic(scope: WriteScope, file: string, data: Uint8Array | string): void {
  scope.check(file)
  const tmp = writeTemp(file, data)
  try {
    retry(() => renameSync(tmp, file))
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** Removes a file inside the scope (absent is fine). */
export function removeFile(scope: WriteScope, file: string): boolean {
  scope.check(file)
  try {
    retry(() => unlinkSync(file))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

export type FileStep = { file: string; data: Uint8Array | string } | { file: string; remove: true }

/**
 * Two-phase write of several files: all temps first (a failure removes them and leaves every target as it was), then
 * the renames and removes in the given order. Each target is hard-linked to a backup before it is replaced (or
 * renamed to it before it is removed), so a failure part-way puts every earlier target back (H-12 DL-5): a save is
 * all or nothing. Only when that rollback itself fails does a `PartialWriteError` name what was already replaced.
 */
export function commitFiles(scope: WriteScope, steps: readonly FileStep[]): { written: string[]; removed: string[] } {
  for (const s of steps) scope.check(s.file)
  const temps: Array<string | null> = []
  try {
    for (const s of steps) temps.push('data' in s ? writeTemp(s.file, s.data) : null)
  } catch (e) {
    for (const t of temps) if (t) rmSync(t, { force: true })
    throw e
  }
  const written: string[] = []
  const removed: string[] = []
  /** What each done step changed: the target's backup (null: the target did not exist before). */
  const done: Array<{ file: string; backup: string | null }> = []
  const backupOf = (file: string) => join(dirname(file), `.${basename(file)}.${process.pid}.${++tempCounter}.bak`)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    try {
      if ('data' in s) {
        let backup: string | null = backupOf(s.file)
        try {
          linkSync(s.file, backup)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          backup = null
        }
        try {
          retry(() => renameSync(temps[i]!, s.file))
        } catch (e) {
          if (backup) rmSync(backup, { force: true })
          throw e
        }
        done.push({ file: s.file, backup })
        written.push(s.file)
      } else {
        const backup = backupOf(s.file)
        try {
          retry(() => renameSync(s.file, backup))
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw e
        }
        done.push({ file: s.file, backup })
        removed.push(s.file)
      }
    } catch (e) {
      for (let j = i; j < temps.length; j++) if (temps[j]) rmSync(temps[j]!, { force: true })
      const failed: string[] = []
      for (const d of done.reverse()) {
        try {
          if (d.backup) retry(() => renameSync(d.backup!, d.file))
          else retry(() => unlinkSync(d.file))
        } catch {
          failed.push(d.file)
        }
      }
      if (!failed.length) throw e
      throw new PartialWriteError(`${(e as Error).message} (and ${failed.length} file(s) could not be put back)`, written, removed)
    }
  }
  for (const d of done) if (d.backup) rmSync(d.backup, { force: true })
  return { written, removed }
}

export class PartialWriteError extends Error {
  readonly written: string[]
  readonly removed: string[]
  constructor(message: string, written: string[], removed: string[]) {
    super(message)
    this.written = written
    this.removed = removed
  }
}
