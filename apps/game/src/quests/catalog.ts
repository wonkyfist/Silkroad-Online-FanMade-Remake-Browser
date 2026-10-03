/**
 * The quest catalog (docs/QUESTS.md §2.1): the merged quest files (repo + GM overrides) from `GET /api/quests` (Bearer
 * token), fetched after `worldEnter`, again on `contentChanged {kind: 'quests'}` and whenever a `quests` snapshot names a
 * newer revision. Files are validated with the shared validator (a broken quest is dropped, the rest stay) and merged in
 * order: a later quest, item or location with the same id replaces the earlier one. Indexed by giver, turn-in and
 * talk/deliver NPC. No DOM.
 */
import { validateQuestFile, type ApiQuestCatalog, type QuestDef, type QuestItemDef, type QuestLocation } from '@sro/shared'

/** What the state, dialog and log code read (tests build one from a plain file list). */
export interface QuestLookup {
  quest(id: string): QuestDef | undefined
  item(code: string): QuestItemDef | undefined
  location(id: string): QuestLocation | undefined
  /** Quests this NPC identity gives, in file order. */
  givenBy(npc: string): readonly QuestDef[]
  /** Quests that turn in at this NPC identity. */
  turnedInAt(npc: string): readonly QuestDef[]
  /** Quests with a talk/deliver objective at this NPC identity. */
  talkedAt(npc: string): readonly QuestDef[]
  all(): Iterable<QuestDef>
}

const NONE: readonly QuestDef[] = []

/** A merged, indexed set of quest files. */
export class QuestIndex implements QuestLookup {
  readonly quests = new Map<string, QuestDef>()
  readonly items = new Map<string, QuestItemDef>()
  readonly locations = new Map<string, QuestLocation>()
  private readonly byGiver = new Map<string, QuestDef[]>()
  private readonly byTurnIn = new Map<string, QuestDef[]>()
  private readonly byTalk = new Map<string, QuestDef[]>()
  /** Quests dropped by the validator (logged once per load). */
  readonly dropped: string[] = []

  /** Validates and merges `files` in order. Junk entries are skipped. */
  constructor(files: readonly unknown[] = []) {
    const scope = { items: new Set<string>(), locations: new Set<string>(), quests: new Set<string>() }
    for (const raw of files) {
      const { file, issues } = validateQuestFile(raw, undefined, scope)
      if (!file) {
        this.dropped.push(`file: ${issues.find(i => i.severity === 'error')?.message ?? 'invalid'}`)
        continue
      }
      for (const i of issues) if (i.severity === 'error') this.dropped.push(`${file.id} ${i.path}: ${i.message}`)
      for (const it of file.items) {
        this.items.set(it.code, it)
        scope.items.add(it.code)
      }
      for (const l of file.locations) {
        this.locations.set(l.id, l)
        scope.locations.add(l.id)
      }
      for (const q of file.quests) {
        this.quests.set(q.id, q)
        scope.quests.add(q.id)
      }
    }
    const push = (m: Map<string, QuestDef[]>, k: string, q: QuestDef) => {
      const list = m.get(k)
      if (!list) m.set(k, [q])
      else if (!list.includes(q)) list.push(q)
    }
    for (const q of this.quests.values()) {
      push(this.byGiver, q.giver, q)
      push(this.byTurnIn, q.turnIn, q)
      for (const o of q.objectives) if (o.type === 'talk' || o.type === 'deliver') push(this.byTalk, o.npc, q)
    }
  }

  quest(id: string): QuestDef | undefined {
    return this.quests.get(id)
  }

  item(code: string): QuestItemDef | undefined {
    return this.items.get(code)
  }

  location(id: string): QuestLocation | undefined {
    return this.locations.get(id)
  }

  givenBy(npc: string): readonly QuestDef[] {
    return this.byGiver.get(npc) ?? NONE
  }

  turnedInAt(npc: string): readonly QuestDef[] {
    return this.byTurnIn.get(npc) ?? NONE
  }

  talkedAt(npc: string): readonly QuestDef[] {
    return this.byTalk.get(npc) ?? NONE
  }

  all(): Iterable<QuestDef> {
    return this.quests.values()
  }

  get size(): number {
    return this.quests.size
  }
}

/** Reads an `ApiQuestCatalog` body; null when it is not one. */
export function readCatalogBody(body: unknown): { rev: number; files: unknown[] } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Partial<ApiQuestCatalog>
  if (!Array.isArray(b.files)) return null
  const rev = typeof b.rev === 'number' && Number.isFinite(b.rev) ? b.rev : 0
  return { rev, files: b.files as unknown[] }
}

export type CatalogLoader = () => Promise<unknown>

/** `GET /api/quests` with the session's Bearer token (same origin; Vite proxies /api in dev). */
export function httpCatalogLoader(token: () => string, base = '/api'): CatalogLoader {
  return async () => {
    const headers: Record<string, string> = {}
    const tok = token()
    if (tok) headers.Authorization = `Bearer ${tok}`
    const res = await fetch(`${base}/quests`, { headers, cache: 'no-cache' })
    if (!res.ok) throw new Error(`GET /api/quests: HTTP ${res.status}`)
    return res.json() as Promise<unknown>
  }
}

/** Retry delays after a failed fetch (the last one repeats). */
const RETRY_MS = [2000, 5000, 15_000, 30_000]

/** The live catalog of one world visit: the current QuestIndex, refetched on demand with retries. */
export class QuestCatalog implements QuestLookup {
  private index = new QuestIndex()
  /** Revision of the loaded files (-1 before the first load). */
  rev = -1
  private inflight: Promise<void> | null = null
  /** A refresh was asked for while one was running: run once more after it. */
  private again = false
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly loader: CatalogLoader, private readonly log: Pick<Console, 'warn'> = console) {}

  get loaded(): boolean {
    return this.rev >= 0
  }

  /** Called after every successful load. Returns an unregister function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Replaces the catalog from an `ApiQuestCatalog` body; false when the body is not one. */
  load(body: unknown): boolean {
    const b = readCatalogBody(body)
    if (!b) return false
    const next = new QuestIndex(b.files)
    if (next.dropped.length) this.log.warn(`[quests] ${next.dropped.length} quest issue(s) in the catalog`, next.dropped.slice(0, 10))
    this.index = next
    this.rev = b.rev
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch (err) {
        console.error('[quests] catalog listener failed', err)
      }
    }
    return true
  }

  /** Fetches the catalog again (coalesced: at most one request at a time). */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inflight) {
      this.again = true
      return this.inflight
    }
    clearTimeout(this.retryTimer)
    this.inflight = (async () => {
      try {
        const body = await this.loader()
        if (this.disposed) return
        if (!this.load(body)) throw new Error('not a quest catalog')
        this.failures = 0
      } catch (err) {
        if (this.disposed) return
        const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]!
        this.failures++
        this.log.warn(`[quests] quest catalog unavailable (retry in ${wait / 1000} s)`, err)
        this.retryTimer = setTimeout(() => void this.refresh(), wait)
      } finally {
        this.inflight = null
      }
      if (this.again && !this.disposed) {
        this.again = false
        await this.refresh()
      }
    })()
    return this.inflight
  }

  /** Refetches when the server names a revision other than the loaded one. */
  ensureRev(rev: number): void {
    if (rev !== this.rev && !this.inflight) void this.refresh()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.retryTimer)
    this.listeners.clear()
  }

  quest(id: string): QuestDef | undefined {
    return this.index.quest(id)
  }

  item(code: string): QuestItemDef | undefined {
    return this.index.item(code)
  }

  location(id: string): QuestLocation | undefined {
    return this.index.location(id)
  }

  givenBy(npc: string): readonly QuestDef[] {
    return this.index.givenBy(npc)
  }

  turnedInAt(npc: string): readonly QuestDef[] {
    return this.index.turnedInAt(npc)
  }

  talkedAt(npc: string): readonly QuestDef[] {
    return this.index.talkedAt(npc)
  }

  all(): Iterable<QuestDef> {
    return this.index.all()
  }
}
