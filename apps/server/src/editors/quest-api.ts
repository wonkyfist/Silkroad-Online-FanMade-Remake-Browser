import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  GM_API_MAX_BODY_BYTES,
  GM_API_RATE_LIMIT,
  QUEST_ID,
  validateQuestFile,
  type ApiError,
  type ApiGmQuestList,
  type ApiGmQuestResult,
  type ErrorCode,
  type QuestIssue,
  type QuestRefs,
} from '@sro/shared'
import { hashToken } from '../auth.ts'
import type { GameContext } from '../game.ts'
import { editorState, reloadQuests } from './live.ts'
import { editorAllowed, peekHistory, pushHistory, QUEST_OVERRIDE_DIR, readJsonFile, writeJsonAtomic } from './overrides.ts'

/**
 * The GM quest editor's HTTP routes (docs/QUESTS.md §5.4, docs/WAVE_PLAN.md §2.3; lane ED-S), routed from game.ts `api()`:
 * - GET /api/gm/quests -> ApiGmQuestList; POST /api/gm/quests/validate -> ApiGmQuestResult;
 * - PUT /api/gm/quests/:id (422 with issues, 409 on a stale baseRev), DELETE /api/gm/quests/:id,
 *   POST /api/gm/quests/:id/disable | enable -> ApiGmQuestResult.
 * Bearer token; the role is re-read from the DB on every call (`editorAllowed(role, EDITOR_ROLE)`; 403 `forbidden`,
 * audited as denied); bodies at most GM_API_MAX_BODY_BYTES (game.ts reads them); GM_API_RATE_LIMIT per account.
 * Writes go to DATA_DIR/content/quests/<ID>.json (a QuestFile with one quest plus the items and locations it adds; history
 * copy + atomic write), hot-reload the quest engine and send `contentChanged {kind: 'quests'}`; each adds a gm_audit row
 * questput / questdel / questoff / queston with args [id, rev].
 * Nothing here changes an account's role.
 */
export const GM_API_PREFIX = '/api/gm/'

export interface GmApiRequest {
  method: string
  /** URL path without the query. */
  path: string
  authorization: string | undefined
  /** Reads the JSON body of at most `limit` bytes (game.ts: readJson; its 400/413 errors propagate). */
  body: (limit: number) => Promise<unknown>
  now?: number
}

export interface GmApiResponse {
  status: number
  body: unknown
}

type Source = 'repo' | 'override'

interface RawFile {
  name: string
  source: Source
  json: unknown
  problem?: string
}

const err = (status: number, error: ErrorCode, message: string): GmApiResponse => ({ status, body: { error, message } satisfies ApiError })
const result = (status: number, r: ApiGmQuestResult): GmApiResponse => ({ status, body: r })
const issue = (path: string, message: string): QuestIssue => ({ path, message, severity: 'error' })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---- the quest files as the editor sees them (repo line + GM overrides) -------------------------------------

function readDir(dir: string | null, source: Source): RawFile[] {
  if (!dir || !existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((n) => /\.json$/i.test(n))
      .sort()
  } catch {
    return []
  }
  return names.map((name) => {
    const r = readJsonFile(join(dir, name))
    return 'json' in r ? { name, source, json: r.json } : { name, source, json: null, problem: 'error' in r ? r.error : 'missing' }
  })
}

function overrideDir(ctx: GameContext): string {
  return join(editorState(ctx).root, QUEST_OVERRIDE_DIR)
}

function readAll(ctx: GameContext): RawFile[] {
  const repo = ctx.config.contentDir ? join(ctx.config.contentDir, 'quests') : null
  return [...readDir(repo, 'repo'), ...readDir(overrideDir(ctx), 'override')]
}

function rawQuests(json: unknown): Record<string, unknown>[] {
  return isObj(json) && Array.isArray(json.quests) ? json.quests.filter(isObj) : []
}

function rawIds(json: unknown, list: string, key: string): string[] {
  const v = isObj(json) ? json[list] : undefined
  return Array.isArray(v) ? v.flatMap((x) => (isObj(x) && typeof x[key] === 'string' ? [x[key] as string] : [])) : []
}

/** The ids every file but `skip` defines (the external scope of the file being validated). */
function external(files: RawFile[], skip: (f: RawFile) => boolean) {
  const out = { items: new Set<string>(), locations: new Set<string>(), quests: new Set<string>() }
  for (const f of files) {
    if (skip(f)) continue
    for (const c of rawIds(f.json, 'items', 'code')) out.items.add(c)
    for (const l of rawIds(f.json, 'locations', 'id')) out.locations.add(l)
    for (const q of rawIds(f.json, 'quests', 'id')) out.quests.add(q)
  }
  return out
}

/** Export references for the validator (none without mobs.json: then the check is structural, like the quest book). */
export function questRefs(ctx: GameContext): QuestRefs | undefined {
  const d = ctx.data
  if (d.mobs.size === 0) return undefined
  return {
    mobs: new Set(d.mobs.keys()),
    items: new Set(d.items.keys()),
    npcs: new Set(d.npcs.map((n) => n.code)),
    levelCap: ctx.config.levelCap,
    mobInfo: (code) => {
      const m = d.mob(code)
      return m ? { level: m.level, unique: m.rarity === 'unique' } : undefined
    },
    itemReqLevel: (code) => d.item(code)?.reqLevel,
  }
}

const revOf = (v: unknown): number | undefined => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined)

interface QuestEntry {
  id: string
  title: string
  file: string
  source: Source
  rev: number
  disabled: boolean
  issues: QuestIssue[]
  raw: Record<string, unknown>
}

/** Every quest id with its winning copy (a later file wins; overrides come after the repo line). */
function view(ctx: GameContext, files = readAll(ctx)): Map<string, QuestEntry> {
  const refs = questRefs(ctx)
  const out = new Map<string, QuestEntry>()
  for (const f of files) {
    if (f.json === null) continue
    const { issues } = validateQuestFile(f.json, refs, external(files, (x) => x === f))
    const fileRev = isObj(f.json) ? revOf(f.json.rev) : undefined
    rawQuests(f.json).forEach((q, i) => {
      if (typeof q.id !== 'string') return
      const prefix = `quests[${i}]`
      out.set(q.id, {
        id: q.id,
        title: typeof q.title === 'string' ? q.title : q.id,
        file: f.name,
        source: f.source,
        rev: revOf(q.rev) ?? fileRev ?? 0,
        disabled: q.disabled === true,
        issues: issues.filter((x) => x.path === prefix || x.path.startsWith(`${prefix}.`) || x.path.startsWith(`${prefix}[`) || (f.source === 'override' && !x.path.startsWith('quests['))),
        raw: q,
      })
    })
  }
  return out
}

/** Quest ids whose giver, turn-in or a talk/deliver objective is the NPC `code` (NPC editor warnings). */
export function questsUsingNpc(ctx: GameContext, code: string): string[] {
  const out: string[] = []
  for (const q of view(ctx).values()) {
    const objectives = Array.isArray(q.raw.objectives) ? q.raw.objectives.filter(isObj) : []
    if (q.raw.giver === code || q.raw.turnIn === code || objectives.some((o) => o.npc === code)) out.push(q.id)
  }
  return out.sort()
}

// ---- auth and rate limit --------------------------------------------------------------------------------

interface Bucket {
  tokens: number
  at: number
}
const BUCKETS = new WeakMap<GameContext, Map<number, Bucket>>()

/** GM_API_RATE_LIMIT per account (token bucket: `perSecond`, `burst`). */
function allow(ctx: GameContext, accountId: number, now: number): boolean {
  let map = BUCKETS.get(ctx)
  if (!map) BUCKETS.set(ctx, (map = new Map()))
  const b = map.get(accountId) ?? { tokens: GM_API_RATE_LIMIT.burst, at: now }
  b.tokens = Math.min(GM_API_RATE_LIMIT.burst, b.tokens + ((now - b.at) / 1000) * GM_API_RATE_LIMIT.perSecond)
  b.at = now
  map.set(accountId, b)
  if (map.size > 1000) for (const [k, v] of map) if (now - v.at > 60_000) map.delete(k)
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

// ---- routes -------------------------------------------------------------------------------------------------

type Route = { kind: 'list' } | { kind: 'validate' } | { kind: 'put' | 'delete' | 'disable' | 'enable'; id: string }

function route(method: string, path: string): Route | 'bad_id' | null {
  const m = /^\/api\/gm\/quests(?:\/([^/]+)(?:\/(disable|enable))?)?$/.exec(path)
  if (!m) return null
  const [, id, action] = m
  if (id === undefined) return method === 'GET' ? { kind: 'list' } : null
  if (id === 'validate' && action === undefined) return method === 'POST' ? { kind: 'validate' } : null
  let decoded: string
  try {
    decoded = decodeURIComponent(id)
  } catch {
    return 'bad_id'
  }
  if (!QUEST_ID.test(decoded)) return 'bad_id'
  if (action !== undefined) return method === 'POST' ? { kind: action as 'disable' | 'enable', id: decoded } : null
  if (method === 'PUT') return { kind: 'put', id: decoded }
  if (method === 'DELETE') return { kind: 'delete', id: decoded }
  return null
}

const AUDIT_COMMAND: Record<Route['kind'], string> = {
  list: 'questlist',
  validate: 'questcheck',
  put: 'questput',
  delete: 'questdel',
  disable: 'questoff',
  enable: 'queston',
}

/** The body of PUT / validate: ApiGmQuestPut (unknown keys refused). */
function parsePut(body: unknown): { quest: Record<string, unknown>; items: unknown[]; locations: unknown[]; baseRev?: number } | string {
  if (!isObj(body)) return 'the body must be an object'
  for (const k of Object.keys(body)) if (!['quest', 'items', 'locations', 'baseRev'].includes(k)) return `unexpected field ${k}`
  if (!isObj(body.quest)) return 'quest must be an object'
  if (body.items !== undefined && !Array.isArray(body.items)) return 'items must be an array'
  if (body.locations !== undefined && !Array.isArray(body.locations)) return 'locations must be an array'
  if (body.baseRev !== undefined && revOf(body.baseRev) === undefined) return 'baseRev must be a whole number >= 0'
  return { quest: body.quest, items: (body.items as unknown[]) ?? [], locations: (body.locations as unknown[]) ?? [], ...(body.baseRev !== undefined ? { baseRev: body.baseRev as number } : {}) }
}

/** The override file for one quest (DATA_DIR/content/quests/<ID>.json). */
function overrideFile(ctx: GameContext, id: string, quest: Record<string, unknown>, items: unknown[], locations: unknown[], rev: number): Record<string, unknown> {
  const title = typeof quest.title === 'string' && quest.title.trim() !== '' ? quest.title : id
  return {
    schema: 1,
    kind: 'quests',
    id,
    title,
    world: ctx.config.world,
    items,
    locations,
    quests: [{ ...quest, rev }],
    rev,
    updatedAt: new Date().toISOString(),
  }
}

/** Validates the override file `json` for quest `id` against every other file (the repo line and the other overrides). */
function check(ctx: GameContext, files: RawFile[], id: string, json: Record<string, unknown>): { issues: QuestIssue[]; clean: unknown | null } {
  const name = `${id}.json`
  const { file, issues } = validateQuestFile(json, questRefs(ctx), external(files, (f) => f.source === 'override' && f.name === name))
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length > 0 || !file || !file.quests.some((q) => q.id === id)) {
    return { issues: errors.length > 0 ? issues : [...issues, issue('quests[0]', 'the quest did not validate')], clean: null }
  }
  return { issues, clean: file }
}

/** The next quest revision: above the current one and above any earlier override of it (kept in the history). */
function nextRev(ctx: GameContext, id: string, current: number): number {
  const root = editorState(ctx).root
  const rel = join(QUEST_OVERRIDE_DIR, `${id}.json`)
  const onDisk = readJsonFile(join(root, rel))
  const disk = 'json' in onDisk && isObj(onDisk.json) ? (revOf(onDisk.json.rev) ?? 0) : 0
  const old = peekHistory(root, rel)
  const hist = isObj(old) ? (revOf(old.rev) ?? 0) : 0
  return Math.max(current, disk, hist) + 1
}

/** Writes quest `id`'s override (history copy of the previous one first), then hot-reloads. */
function save(ctx: GameContext, id: string, file: unknown): void {
  const root = editorState(ctx).root
  const rel = join(QUEST_OVERRIDE_DIR, `${id}.json`)
  const prev = readJsonFile(join(root, rel))
  if ('json' in prev) pushHistory(root, rel, prev.json)
  writeJsonAtomic(join(root, rel), file)
  reloadQuests(ctx)
}

/**
 * Answers one /api/gm/* request. Throws only what `req.body()` throws (game.ts turns it into 400/413); every other
 * failure is an answer.
 */
export async function handleGmApi(ctx: GameContext, req: GmApiRequest): Promise<GmApiResponse> {
  const now = req.now ?? Date.now()
  const r = route(req.method, req.path)
  if (r === null) return err(404, 'not_found', 'no such endpoint')
  const m = /^Bearer\s+(\S{1,256})$/.exec(req.authorization ?? '')
  if (!m) return err(401, 'unauthorized', 'missing bearer token')
  const account = ctx.store.sessionAccount(hashToken(m[1]), now)
  if (!account) return err(401, 'unauthorized', 'session expired or invalid')
  if (!allow(ctx, account.id, now)) return err(429, 'rate_limited', 'too many quest editor requests, slow down')
  const command = r === 'bad_id' ? 'questapi' : AUDIT_COMMAND[r.kind]
  const target = r !== 'bad_id' && 'id' in r ? [r.id] : []
  const audit = (res: string, okay: boolean, args: string[] = target) =>
    ctx.store.audit({ accountId: account.id, characterId: null, command, args: args.map((a) => a.slice(0, 64)), result: res.slice(0, 500), ok: okay }, now)
  const denied = () => {
    audit(`denied: ${req.method} ${req.path.slice(0, 80)} needs the ${ctx.config.editorRole ?? 'gm'} role`, false)
    return err(403, 'forbidden', 'Game Master content editors only.')
  }
  // The role as stored right now (a `pnpm gm revoke` takes effect on the very next call).
  if (!editorAllowed(account.role, ctx.config.editorRole)) return denied()
  if (r === 'bad_id') return err(400, 'bad_request', 'quest ids are A-Z, 0-9 and _ (2-64 characters, a letter first)')

  let files = readAll(ctx)
  let quests = view(ctx, files)
  if (r.kind === 'list') {
    const engine = ctx.gameplay.quests as unknown as { book?: { rev?: unknown } }
    const rev = revOf(engine.book?.rev) ?? 0
    const list: ApiGmQuestList = {
      rev,
      quests: [...quests.values()].map((q) => ({ id: q.id, title: q.title, file: q.file, source: q.source, rev: q.rev, disabled: q.disabled, issues: q.issues })),
    }
    return { status: 200, body: list }
  }

  if (r.kind === 'validate' || r.kind === 'put') {
    const body = parsePut(await req.body(GM_API_MAX_BODY_BYTES))
    // The body may arrive long after the headers: the session, the role and the quests (baseRev) are checked again as
    // they are now. Everything from here to save() is synchronous, so no other request can slip in between.
    const again = ctx.store.sessionAccount(hashToken(m[1]), req.now ?? Date.now())
    if (!again || again.id !== account.id) return err(401, 'unauthorized', 'session expired or invalid')
    if (!editorAllowed(again.role, ctx.config.editorRole)) return denied()
    files = readAll(ctx)
    quests = view(ctx, files)
    if (typeof body === 'string') {
      if (r.kind === 'put') audit(`bad request: ${body}`, false)
      return err(400, 'bad_request', body)
    }
    const id = r.kind === 'put' ? r.id : typeof body.quest.id === 'string' && QUEST_ID.test(body.quest.id) ? body.quest.id : null
    const current = id ? quests.get(id) : undefined
    const curRev = current?.rev ?? 0
    if (!id) return result(r.kind === 'put' ? 422 : 200, { ok: false, rev: 0, issues: [issue('quest.id', 'a quest id (A-Z, 0-9, _)')] })
    if (body.quest.id !== id) {
      const res = { ok: false, rev: curRev, issues: [issue('quest.id', `must be ${id} (the id in the address)`)] }
      audit(`quest.id must be ${id}`, false)
      return result(422, res)
    }
    if (r.kind === 'put' && body.baseRev !== undefined && body.baseRev !== curRev) {
      audit(`stale: base rev ${body.baseRev}, now ${curRev}`, false, [id, String(curRev)])
      return result(409, { ok: false, rev: curRev, issues: [issue('baseRev', `the quest changed meanwhile (rev ${curRev}); reload it and apply your edit again`)] })
    }
    const rev = r.kind === 'put' ? nextRev(ctx, id, curRev) : curRev
    const json = overrideFile(ctx, id, body.quest, body.items, body.locations, rev)
    const checked = check(ctx, files, id, json)
    if (!checked.clean) {
      if (r.kind === 'validate') return result(200, { ok: false, rev: curRev, issues: checked.issues })
      const first = checked.issues.find((i) => i.severity === 'error')
      audit(first ? `${first.path}: ${first.message}` : 'invalid', false, [id, String(curRev)])
      return result(422, { ok: false, rev: curRev, issues: checked.issues })
    }
    if (r.kind === 'validate') return result(200, { ok: true, rev: curRev, issues: checked.issues })
    save(ctx, id, checked.clean)
    audit('ok', true, [id, String(rev)])
    ctx.config.log(`quest editor: ${account.username} saved ${id} (rev ${rev})`)
    return result(200, { ok: true, rev, issues: checked.issues })
  }

  const id = r.id
  const current = quests.get(id)
  const root = editorState(ctx).root
  const rel = join(QUEST_OVERRIDE_DIR, `${id}.json`)
  const onDisk = readJsonFile(join(root, rel))

  if (r.kind === 'delete') {
    if (!('json' in onDisk)) {
      audit('no override', false)
      return result(404, { ok: false, rev: current?.rev ?? 0, issues: [issue('', `${id} has no GM override`)] })
    }
    pushHistory(root, rel, onDisk.json)
    rmSync(join(root, rel), { force: true })
    reloadQuests(ctx)
    const after = view(ctx).get(id)
    const rev = after?.rev ?? 0
    audit('ok', true, [id, String(rev)])
    ctx.config.log(`quest editor: ${account.username} reverted ${id} to ${after ? 'the repo version' : 'nothing (override-only quest removed)'}`)
    return result(200, { ok: true, rev, issues: [] })
  }

  // disable / enable: writes `disabled` into the override (made from the repo version when there is none).
  if (!current) {
    audit('no such quest', false)
    return result(404, { ok: false, rev: 0, issues: [issue('', `no quest ${id}`)] })
  }
  const disabled = r.kind === 'disable'
  const rev = nextRev(ctx, id, current.rev)
  let json: Record<string, unknown>
  if ('json' in onDisk && isObj(onDisk.json)) {
    const base = onDisk.json
    json = { ...base, rev, updatedAt: new Date().toISOString(), quests: rawQuests(base).map((q) => (q.id === id ? { ...q, disabled, rev } : q)) }
  } else {
    json = overrideFile(ctx, id, { ...current.raw, disabled }, [], [], rev)
  }
  const checked = check(ctx, files, id, json)
  if (!checked.clean) {
    const first = checked.issues.find((i) => i.severity === 'error')
    audit(first ? `${first.path}: ${first.message}` : 'invalid', false, [id, String(current.rev)])
    return result(422, { ok: false, rev: current.rev, issues: checked.issues })
  }
  save(ctx, id, checked.clean)
  audit('ok', true, [id, String(rev)])
  ctx.config.log(`quest editor: ${account.username} ${disabled ? 'disabled' : 'enabled'} ${id} (rev ${rev})`)
  return result(200, { ok: true, rev, issues: checked.issues })
}
