import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  DEFAULT_QUEST_ITEM_STACK,
  validateQuestFile,
  type ApiQuestCatalog,
  type QuestDef,
  type QuestDialogLine,
  type QuestFile,
  type QuestIssue,
  type QuestItemDef,
  type QuestLocation,
  type QuestObjective,
  type QuestRefs,
} from '@sro/shared'

/**
 * The quest catalog (docs/QUESTS.md §1.1, §1.5, §5.4; lane QS-S).
 *
 * Loading order: every repo file CONTENT_DIR/quests/*.json (alphabetical), then every override file
 * DATA_DIR/content/quests/*.json (alphabetical); a later quest, item or location with the same id replaces the
 * earlier one. Each file is validated with the shared `validateQuestFile(json, refs, external)` against the GameData
 * refs, with the ids of the other files as the external scope. Problems are logged, never fatal: a quest with errors is
 * dropped, the rest of its file stays.
 *
 * The book then builds the indexes the engine uses (byGiver, byTurnIn, killIndex, dropIndex) and the merged catalog
 * for `GET /api/quests` (each quest, item and location once: the winning copy, inside the file it came from).
 * `replace()` / `remove()` / `reload()` are the GM editors' hot-reload entry points (they bump `rev`); the engine's
 * `setContent()` re-maps the players' logs afterwards.
 */

export type QuestSource = 'repo' | 'override'

/** One loaded quest file (a clean copy: only the records without errors). */
export interface LoadedQuestFile {
  /** File name, e.g. 'jangan.json' or 'JG_002.json'. */
  name: string
  source: QuestSource
  file: QuestFile
  issues: QuestIssue[]
}

/** A kill objective of one quest that a mob counts for. */
export interface KillEntry {
  quest: QuestDef
  objective: Extract<QuestObjective, { type: 'kill' }>
}

/** A collect objective of one quest that a mob may drop for. */
export interface DropEntry {
  quest: QuestDef
  objective: Extract<QuestObjective, { type: 'collect' }>
  item: string
  chance: number
}

export interface QuestBookOptions {
  /** CONTENT_DIR (repo content); its quests/ folder. Absent: no repo quests. */
  contentDir?: string
  /** DATA_DIR; overrides live in DATA_DIR/content/quests. Absent: no overrides. */
  dataDir?: string
  refs?: QuestRefs
  log?: (msg: string) => void
}

/** Raw input of a rebuild: a file's name, source and parsed JSON (null: unreadable). */
interface RawFile {
  name: string
  source: QuestSource
  json: unknown
  /** Why the file could not be read or parsed. */
  problem?: string
}

const JSON_FILE = /\.json$/i

/** Most error lines one load writes to the log (the rest are counted). */
const MAX_LOGGED_ERRORS = 20

function readDir(dir: string | undefined, source: QuestSource): RawFile[] {
  if (!dir || !existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => JSON_FILE.test(n)).sort()
  } catch (e) {
    return [{ name: basename(dir), source, json: null, problem: `cannot read the folder: ${(e as Error).message}` }]
  }
  return names.map((name) => {
    try {
      return { name, source, json: JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown }
    } catch (e) {
      return { name, source, json: null, problem: (e as Error).message }
    }
  })
}

/** Loose id sets of a raw file (for the other files' external scope). */
function rawIds(json: unknown): { items: string[]; locations: string[]; quests: string[] } {
  const out = { items: [] as string[], locations: [] as string[], quests: [] as string[] }
  if (typeof json !== 'object' || json === null) return out
  const o = json as Record<string, unknown>
  const ids = (list: unknown, key: string) => (Array.isArray(list) ? list.flatMap((x) => (x && typeof x === 'object' && typeof (x as Record<string, unknown>)[key] === 'string' ? [(x as Record<string, string>)[key]] : [])) : [])
  out.items = ids(o.items, 'code')
  out.locations = ids(o.locations, 'id')
  out.quests = ids(o.quests, 'id')
  return out
}

/** A small stable hash (FNV-1a), so the first catalog revision differs when the content does. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export class QuestBook {
  /** Catalog revision (ETag `"q<rev>"`); bumped on every hot reload. */
  rev = 0
  /** Loaded files in load order (repo, then overrides). */
  files: LoadedQuestFile[] = []
  /** The winning copy of every quest / quest item / location. */
  readonly quests = new Map<string, QuestDef>()
  readonly items = new Map<string, QuestItemDef>()
  readonly locations = new Map<string, QuestLocation>()
  /** Quest id -> the file and source its winning copy came from. */
  readonly origin = new Map<string, { file: string; source: QuestSource }>()
  /** Quest id -> the issues its file reported for it (paths relative to the file). */
  readonly issues = new Map<string, QuestIssue[]>()
  /** NPC identity -> quests it gives / takes back. */
  readonly byGiver = new Map<string, QuestDef[]>()
  readonly byTurnIn = new Map<string, QuestDef[]>()
  /** Mob code -> kill objectives it counts for. */
  readonly killIndex = new Map<string, KillEntry[]>()
  /** Mob code -> collect objectives it drops for. */
  readonly dropIndex = new Map<string, DropEntry[]>()
  /** Wave 11 (lane U-Q): the winning copy of every dialog line (by id), and NPC identity -> its lines. */
  readonly lines = new Map<string, QuestDialogLine>()
  readonly linesByNpc = new Map<string, QuestDialogLine[]>()
  /** File-level problems (unreadable files, broken envelopes). */
  problems: string[] = []
  private raw: RawFile[] = []
  private cached: ApiQuestCatalog | null = null

  constructor(
    private readonly opts: QuestBookOptions = {},
    raw: RawFile[] = [],
  ) {
    this.raw = raw
    this.build()
    this.rev = hash(JSON.stringify(this.files.map((f) => f.file))) % 1_000_000_000
  }

  /** Reads CONTENT_DIR/quests and DATA_DIR/content/quests and builds the book. */
  static load(opts: QuestBookOptions): QuestBook {
    const book = new QuestBook(opts, QuestBook.readAll(opts))
    book.report()
    return book
  }

  /** A book over in-memory files (tests, the editors' validation). */
  static fromFiles(files: { name: string; json: unknown; source?: QuestSource }[], opts: QuestBookOptions = {}): QuestBook {
    return new QuestBook(opts, files.map((f) => ({ name: f.name, source: f.source ?? 'repo', json: f.json })))
  }

  private static readAll(opts: QuestBookOptions): RawFile[] {
    return [...readDir(opts.contentDir && join(opts.contentDir, 'quests'), 'repo'), ...readDir(opts.dataDir && QuestBook.overrideDir(opts.dataDir), 'override')]
  }

  /** Where the GM quest overrides live: DATA_DIR/content/quests. */
  static overrideDir(dataDir: string): string {
    return join(dataDir, 'content', 'quests')
  }

  /** One log line per load plus the first errors (docs/QUESTS.md §1.2: like gamedata.ts, never fatal). */
  report(): void {
    const log = this.opts.log
    if (!log) return
    const all = this.files.flatMap((f) => f.issues.map((i) => ({ f: f.name, i })))
    const errors = all.filter((x) => x.i.severity === 'error')
    const warnings = all.length - errors.length
    const overrides = this.files.filter((f) => f.source === 'override').length
    log(
      `content quests: ${this.quests.size} quests, ${this.items.size} quest items, ${this.locations.size} locations from ${this.files.length} files` +
        `${overrides ? ` (${overrides} GM overrides)` : ''}; ${errors.length} errors, ${warnings} warnings${this.opts.refs ? '' : ' (no export refs: structure only)'}`,
    )
    for (const p of this.problems) log(`content quests: ${p}`)
    for (const x of errors.slice(0, MAX_LOGGED_ERRORS)) log(`content quests: ${x.f} ${x.i.path}: ${x.i.message}`)
    if (errors.length > MAX_LOGGED_ERRORS) log(`content quests: ... and ${errors.length - MAX_LOGGED_ERRORS} more errors`)
  }

  // ---- lookups ------------------------------------------------------------------------------------------

  quest(id: string): QuestDef | undefined {
    return this.quests.get(id)
  }

  item(code: string): QuestItemDef | undefined {
    return this.items.get(code)
  }

  location(id: string): QuestLocation | undefined {
    return this.locations.get(id)
  }

  /** Most of a quest item one quest may hold (maxStack, default 99). */
  itemStack(code: string): number {
    return this.items.get(code)?.maxStack ?? DEFAULT_QUEST_ITEM_STACK
  }

  /** The merged catalog for GET /api/quests (each record once, in its own file; cached until the next reload). */
  catalog(): ApiQuestCatalog {
    if (!this.cached) {
      const files: QuestFile[] = []
      for (const f of this.files) {
        const quests = f.file.quests.filter((q) => this.origin.get(q.id)?.file === f.name && this.quests.get(q.id) === q)
        const items = f.file.items.filter((i) => this.items.get(i.code) === i)
        const locations = f.file.locations.filter((l) => this.locations.get(l.id) === l)
        if (quests.length + items.length + locations.length === 0) continue
        files.push({ ...f.file, quests, items, locations })
      }
      this.cached = { rev: this.rev, files }
    }
    return this.cached
  }

  // ---- hot reload (GM editors, docs/QUESTS.md §5.4) -----------------------------------------------------

  /**
   * Adds or replaces an override file (by `name`, default `<first quest id>.json`) and rebuilds. Returns the issues of
   * that file (errors mean some of its records were dropped).
   */
  replace(json: unknown, name?: string): QuestIssue[] {
    const ids = rawIds(json)
    const file = name ?? `${ids.quests[0] ?? 'override'}.json`
    const i = this.raw.findIndex((r) => r.source === 'override' && r.name === file)
    const entry: RawFile = { name: file, source: 'override', json }
    if (i >= 0) this.raw[i] = entry
    else {
      this.raw.push(entry)
      this.raw.sort((a, b) => (a.source === b.source ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.source === 'repo' ? -1 : 1))
    }
    this.rebuild()
    return this.files.find((f) => f.name === file && f.source === 'override')?.issues ?? []
  }

  /** Removes the override file `name` (or `<questId>.json`): the repo version returns, or the quest disappears. */
  remove(nameOrQuest: string): boolean {
    const file = JSON_FILE.test(nameOrQuest) ? nameOrQuest : `${nameOrQuest}.json`
    const i = this.raw.findIndex((r) => r.source === 'override' && r.name === file)
    if (i < 0) return false
    this.raw.splice(i, 1)
    this.rebuild()
    return true
  }

  /** Re-reads every file from disk (the editors write the override, then call this through QuestEngine.reloadContent). */
  reload(): void {
    this.raw = QuestBook.readAll(this.opts)
    this.rebuild()
    this.report()
  }

  private rebuild(): void {
    this.build()
    this.rev++
  }

  // ---- build ---------------------------------------------------------------------------------------------

  private build(): void {
    this.cached = null
    this.files = []
    this.problems = []
    for (const m of [this.quests, this.items, this.locations, this.origin, this.issues, this.byGiver, this.byTurnIn, this.killIndex, this.dropIndex, this.lines, this.linesByNpc]) m.clear()
    const ids = this.raw.map((r) => rawIds(r.json))
    this.raw.forEach((r, n) => {
      if (r.problem !== undefined || r.json === null) {
        this.problems.push(`${r.source} file ${r.name}: ${r.problem ?? 'empty'}`)
        return
      }
      // The ids of every other file are in scope (an override builds on the repo line; files may reference each other).
      const external = { items: new Set<string>(), locations: new Set<string>(), quests: new Set<string>() }
      ids.forEach((x, m) => {
        if (m === n) return
        for (const c of x.items) external.items.add(c)
        for (const l of x.locations) external.locations.add(l)
        for (const q of x.quests) external.quests.add(q)
      })
      const { file, issues } = validateQuestFile(r.json, this.opts.refs, external)
      if (!file) {
        const first = issues.find((i) => i.severity === 'error')
        this.problems.push(`${r.source} file ${r.name} skipped: ${first ? `${first.path || '(file)'}: ${first.message}` : 'invalid'}`)
        return
      }
      this.files.push({ name: r.name, source: r.source, file, issues })
      const rawQuests = Array.isArray((r.json as Record<string, unknown>).quests) ? ((r.json as Record<string, unknown>).quests as unknown[]) : []
      for (const item of file.items) this.items.set(item.code, item)
      for (const loc of file.locations) this.locations.set(loc.id, loc)
      for (const line of file.lines ?? []) this.lines.set(line.id, line)
      for (const q of file.quests) {
        this.quests.set(q.id, q)
        this.origin.set(q.id, { file: r.name, source: r.source })
        const index = rawQuests.findIndex((x) => (x as { id?: unknown } | null)?.id === q.id)
        const prefix = `quests[${index}]`
        this.issues.set(q.id, issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`) || i.path.startsWith(`${prefix}[`)))
      }
      // Quests of this file that were dropped (errors) keep their issues too, for the editors' list.
      rawQuests.forEach((x, index) => {
        const id = (x as { id?: unknown } | null)?.id
        if (typeof id !== 'string' || file.quests.some((q) => q.id === id)) return
        const prefix = `quests[${index}]`
        const own = issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`) || i.path.startsWith(`${prefix}[`))
        if (!this.quests.has(id)) this.issues.set(id, own)
      })
    })
    for (const q of this.quests.values()) this.index(q)
    for (const line of this.lines.values()) {
      const list = this.linesByNpc.get(line.npc)
      if (list) list.push(line)
      else this.linesByNpc.set(line.npc, [line])
    }
  }

  private index(q: QuestDef): void {
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
      const list = m.get(k)
      if (list) list.push(v)
      else m.set(k, [v])
    }
    push(this.byGiver, q.giver, q)
    push(this.byTurnIn, q.turnIn, q)
    for (const o of q.objectives) {
      if (o.type === 'kill') for (const mob of new Set(o.mobs)) push(this.killIndex, mob, { quest: q, objective: o })
      else if (o.type === 'collect') for (const f of o.from) push(this.dropIndex, f.mob, { quest: q, objective: o, item: o.item, chance: f.chance })
    }
  }
}
