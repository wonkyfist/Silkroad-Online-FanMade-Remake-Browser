import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  NEWS_ID,
  NEWS_IMAGE_MAX_BYTES,
  NEWS_IMAGE_NAME,
  compareNews,
  parseNewsFile,
  serializeNewsFile,
  sortNews,
  unseenNews,
  type AdminNewsRow,
  type NewsEntry,
} from '@sro/shared'
import type { Store } from './db.ts'
import { contentRoot, writeFileAtomic } from './editors/overrides.ts'

/**
 * The "What's new" entries (docs/CHANGELOG_WINDOW.md): the repo files `CONTENT_DIR/changelog/<id>.md` (written at each
 * deploy) with the admin panel's files `DATA_DIR/content/changelog/<id>.md` layered over them (same id: the panel's
 * copy wins; a new id adds an entry). Images live in `img/` beside the entries, the panel's first. Everything is read
 * at start and after every panel save; a file that does not parse is skipped with a log line, never fatal.
 */

export const NEWS_DIR = 'changelog'
export const NEWS_IMG_DIR = 'img'

/** Image file signatures by extension (an upload must be what its name says). */
function imageKind(bytes: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp'
  return null
}

/** Whether `bytes` are an image of the type `name`'s extension says. */
export function imageMatchesName(name: string, bytes: Uint8Array): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1)
  const kind = imageKind(bytes)
  return kind !== null && (kind === ext || (kind === 'jpg' && ext === 'jpeg'))
}

function listDir(dir: string | null, ext: RegExp): string[] {
  if (!dir || !existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => ext.test(f)).sort()
  } catch {
    return []
  }
}

export class NewsStore {
  private repo = new Map<string, NewsEntry>()
  private panel = new Map<string, NewsEntry>()
  private imageSet = new Set<string>()
  /** Problems of the last reload (files skipped). */
  problems: string[] = []

  constructor(
    /** CONTENT_DIR/changelog, or null (no repo entries). */
    readonly repoDir: string | null,
    /** DATA_DIR/content/changelog (the admin panel's layer). */
    readonly panelDir: string,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.reload()
  }

  static open(config: { contentDir?: string; dataDir: string; log: (m: string) => void }): NewsStore {
    return new NewsStore(config.contentDir ? join(config.contentDir, NEWS_DIR) : null, join(contentRoot(config.dataDir), NEWS_DIR), config.log)
  }

  /** The image folders, the panel's first (the order images are looked up and served in). */
  get imageDirs(): string[] {
    return [join(this.panelDir, NEWS_IMG_DIR), ...(this.repoDir ? [join(this.repoDir, NEWS_IMG_DIR)] : [])]
  }

  reload(): void {
    this.imageSet = new Set(this.imageDirs.flatMap((d) => listDir(d, NEWS_IMAGE_NAME)))
    this.problems = []
    this.repo = this.readDir(this.repoDir, 'repo')
    this.panel = this.readDir(this.panelDir, 'panel')
    for (const p of this.problems) this.log(`news: ${p}`)
  }

  private readDir(dir: string | null, label: string): Map<string, NewsEntry> {
    const out = new Map<string, NewsEntry>()
    for (const file of listDir(dir, /\.md$/)) {
      const id = file.slice(0, -3)
      if (!NEWS_ID.test(id)) {
        if (!/^readme$/i.test(id)) this.problems.push(`${label} ${file}: the file name is not an entry id (lower-case letters, digits, dashes)`)
        continue
      }
      let text: string
      try {
        text = readFileSync(join(dir!, file), 'utf8')
      } catch (e) {
        this.problems.push(`${label} ${file}: ${(e as Error).message}`)
        continue
      }
      const r = parseNewsFile(text, id, this.imageSet)
      if ('problems' in r) this.problems.push(`${label} ${file}: ${r.problems.join('; ')}`)
      else out.set(id, r.entry)
    }
    return out
  }

  /** Every image file name (both folders). */
  images(): string[] {
    return [...this.imageSet].sort()
  }

  hasImage(name: string): boolean {
    return this.imageSet.has(name)
  }

  /** Every entry, drafts included, newest first, with where it comes from (the admin panel). */
  all(): AdminNewsRow[] {
    const rows: AdminNewsRow[] = []
    for (const [id, e] of this.panel) rows.push({ ...e, source: this.repo.has(id) ? 'edited' : 'panel' })
    for (const [id, e] of this.repo) if (!this.panel.has(id)) rows.push({ ...e, source: 'repo' })
    return sortNews(rows)
  }

  /** The entries players see (no drafts), newest first. */
  published(): NewsEntry[] {
    return this.all()
      .filter((e) => !e.draft)
      .map(({ source: _source, ...e }) => e)
  }

  get(id: string): AdminNewsRow | undefined {
    return this.all().find((e) => e.id === id)
  }

  /** The published entries `accountId` has not seen, newest first (at most NEWS_UNSEEN_MAX). */
  unseenFor(store: Store, accountId: number): NewsEntry[] {
    const m = store.newsMark(accountId)
    if (!m) return []
    return unseenNews(this.published(), m.mark, m.createdAt)
  }

  /**
   * Marks entry `id` (and everything older) as seen for `accountId`; the mark never moves back. Returns the unseen
   * entries afterwards, or null when there is no such published entry.
   */
  markSeen(store: Store, accountId: number, id: string): NewsEntry[] | null {
    const entry = this.published().find((e) => e.id === id)
    const m = store.newsMark(accountId)
    if (!entry || !m) return null
    if (!m.mark || compareNews(entry, m.mark) > 0) store.setNewsMark(accountId, { date: entry.date, id: entry.id })
    return this.unseenFor(store, accountId)
  }

  /** Writes the panel's copy of an entry (checked by the caller) and reloads. */
  save(entry: NewsEntry): void {
    writeFileAtomic(join(this.panelDir, `${entry.id}.md`), serializeNewsFile(entry))
    this.reload()
  }

  /** Removes the panel's copy (a repo entry goes back to its file; a panel-only entry is gone). False when there was none. */
  revert(id: string): boolean {
    if (!NEWS_ID.test(id)) return false
    const file = join(this.panelDir, `${id}.md`)
    if (!existsSync(file)) return false
    rmSync(file, { force: true })
    this.reload()
    return true
  }

  /** Stores an uploaded image in the panel's folder (the name and the bytes are checked here). */
  saveImage(name: string, bytes: Uint8Array): { ok: true } | { error: string } {
    if (!NEWS_IMAGE_NAME.test(name)) return { error: 'the name must be lower-case letters, digits, - or _, ending in .jpg, .png or .webp' }
    if (bytes.length === 0) return { error: 'the file is empty' }
    if (bytes.length > NEWS_IMAGE_MAX_BYTES) return { error: `the image is larger than ${Math.round(NEWS_IMAGE_MAX_BYTES / 1024)} KB` }
    if (!imageMatchesName(name, bytes)) return { error: 'the file is not the image type its name says (JPEG, PNG or WebP)' }
    writeFileAtomic(join(this.panelDir, NEWS_IMG_DIR, name), bytes)
    this.reload()
    return { ok: true }
  }
}
