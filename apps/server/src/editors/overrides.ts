import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AUTHORED_NPC_CODE,
  CODE_NAME,
  cleanQuestText,
  codePointLength,
  type ContentSource,
  type MobDef,
  type NestDef,
  type NpcDef,
  type Role,
} from '@sro/shared'
import type { EditorRole } from '../config.ts'
import type { GameData } from '../gamedata.ts'

/**
 * GM content override files under DATA_DIR/content/ (docs/QUESTS.md §5.1, §6.4; lane ED-S): the file formats of §6.4
 * verbatim, the atomic write (tmp + fsync + rename), the history copies (last 100 per file), the layering (remove, then
 * patch by id, then add) and the authored-nest check (decision 44: content-check.ts `checkNestDef` stays port-only).
 * Invalid override records are skipped with a log line, never fatal.
 *
 * Nothing here writes `accounts.role`: the editors only read the role through the usual checks (decision 48).
 */

export const NESTS_OVERRIDE_FILE = 'nests.override.json'
export const NPCS_OVERRIDE_FILE = 'npcs.override.json'
/** Sub-folders of DATA_DIR/content/. */
export const QUEST_OVERRIDE_DIR = 'quests'
export const HISTORY_DIR = 'history'
/** History copies kept per file. */
export const HISTORY_KEEP = 100
/** Authored nests get ids from here up (exported nests stay below). */
export const AUTHORED_NEST_ID_MIN = 1_000_000

/** GM editor bounds (docs/QUESTS.md §5.2, §5.3). */
export const NEST_COUNT_MAX = 50
export const NEST_RADIUS_MIN = 2
export const NEST_RADIUS_MAX = 200
export const NEST_RESPAWN_MAX_SEC = 86_400
export const NPC_NAME_MAX = 32
/** Most authored records per override file (a runaway script cannot grow the file without bound). */
export const OVERRIDE_RECORDS_MAX = 2000
/**
 * Most monsters all enabled authored nests may hold together (the sum of their counts). Like /spawn's
 * GM_SPAWN_TOTAL_MAX, it keeps a typo or a stolen GM session from persisting thousands of monsters that respawn after
 * every restart on the N100 host.
 */
export const NEST_AUTHORED_MOBS_MAX = 1000

/** The monsters the enabled authored nests of `o` hold together (checked against NEST_AUTHORED_MOBS_MAX). */
export function authoredMobTotal(o: Pick<NestOverrideFile, 'add'>): number {
  let n = 0
  for (const a of o.add) if (a.enabled !== false) n += a.count
  return n
}

export interface NestOverrideFile {
  schema: 1
  kind: 'nests-override'
  world: string
  rev: number
  updatedAt: string
  /** Authored nests: NestDef with id >= 1_000_000, provenance 'authored', source {file, by, at}. */
  add: AuthoredNest[]
  patch: NestPatch[]
  remove: number[]
}

export interface NestPatch {
  id: number
  mob?: string
  x?: number
  z?: number
  y?: number
  count?: number
  radius?: number
  spawnRadius?: number
  respawnSec?: [number, number]
  aggressive?: boolean
  championPct?: number
  enabled?: boolean
}

export type AuthoredNest = Omit<NestDef, 'provenance' | 'source'> & {
  provenance: 'authored'
  source: { file: 'nests.override.json'; by: string /* account */; at: string /* ISO */ }
}

export interface NpcOverrideFile {
  schema: 1
  kind: 'npcs-override'
  world: string
  rev: number
  updatedAt: string
  add: AuthoredNpc[]
  patch: NpcPatch[]
}

export interface AuthoredNpc {
  code: string /* NPCX_* */
  base: string
  name: string
  x: number
  z: number
  y?: number
  yaw: number
  shop?: string
}

export interface NpcPatch {
  code: string
  name?: string
  x?: number
  z?: number
  y?: number
  yaw?: number
  shop?: string | null
  hidden?: boolean
}

const RANK: Record<Role, number> = { player: 0, gm: 1, admin: 2 }

/** Whether an account with `role` may use the content editors (EDITOR_ROLE, default 'gm'; decision 48). */
export function editorAllowed(role: Role, editorRole: EditorRole = 'gm'): boolean {
  return RANK[role] >= RANK[editorRole]
}

// ---- files: atomic write and history --------------------------------------------------------------------

/** DATA_DIR/content. */
export function contentRoot(dataDir: string): string {
  return join(dataDir, 'content')
}

/** Blocks the thread for `ms` (only for a rename retry: Windows briefly locks a file an indexer or AV has open). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Writes `value` as JSON to `file` atomically: `file.tmp`, fsync, rename over `file`. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true })
        throw e
      }
      pause(20 * (attempt + 1))
    }
  }
}

/** Reads a JSON file: `missing` when it does not exist, `error` when it cannot be read or parsed. */
export function readJsonFile(file: string): { json: unknown } | { missing: true } | { error: string } {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { error: (e as Error).message }
  }
  try {
    return { json: JSON.parse(text) }
  } catch (e) {
    return { error: `not JSON: ${(e as Error).message}` }
  }
}

/** The history name of a content file path relative to DATA_DIR/content ('quests/JG_002.json' -> 'quests-JG_002.json'). */
export function historyName(rel: string): string {
  return rel.replace(/[\\/]/g, '-')
}

const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/

/** History copies of `rel`, oldest first (file names under DATA_DIR/content/history). */
export function listHistory(root: string, rel: string): string[] {
  const prefix = `${historyName(rel)}.`
  let names: string[]
  try {
    names = readdirSync(join(root, HISTORY_DIR))
  } catch {
    return []
  }
  return names.filter((n) => n.startsWith(prefix) && n.endsWith('.json') && STAMP.test(n.slice(prefix.length, -5))).sort()
}

/** A history file name for `rel` that does not exist yet (the ISO time, bumped by 1 ms while taken). */
function freshHistoryPath(root: string, rel: string): string {
  let t = Date.now()
  for (;;) {
    const stamp = new Date(t).toISOString().replace(/[:.]/g, '-')
    const path = join(root, HISTORY_DIR, `${historyName(rel)}.${stamp}.json`)
    if (!existsSync(path)) return path
    t++
  }
}

/** Copies `previous` (the file's content before a write) into the history and keeps the last HISTORY_KEEP copies. */
export function pushHistory(root: string, rel: string, previous: unknown): void {
  writeJsonAtomic(freshHistoryPath(root, rel), previous)
  const all = listHistory(root, rel)
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) rmSync(join(root, HISTORY_DIR, old), { force: true })
}

/** Takes the latest history copy of `rel` out of the history (undo). null when there is none or it is unreadable. */
export function popHistory(root: string, rel: string): unknown | null {
  const all = listHistory(root, rel)
  while (all.length > 0) {
    const name = all.pop()!
    const path = join(root, HISTORY_DIR, name)
    const r = readJsonFile(path)
    rmSync(path, { force: true })
    if ('json' in r) return r.json
  }
  return null
}

/** The latest history copy of `rel` without removing it (null when none). */
export function peekHistory(root: string, rel: string): unknown | null {
  const all = listHistory(root, rel)
  for (let i = all.length - 1; i >= 0; i--) {
    const r = readJsonFile(join(root, HISTORY_DIR, all[i]))
    if ('json' in r) return r.json
  }
  return null
}

/** Writes `next` to DATA_DIR/content/`rel` after copying `previous` (the version it replaces) into the history. */
export function saveVersioned(root: string, rel: string, previous: unknown, next: unknown): void {
  pushHistory(root, rel, previous)
  writeJsonAtomic(join(root, rel), next)
}

// ---- small checks -----------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const intIn = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
const numIn = (v: unknown, lo: number, hi: number): v is number => finite(v) && v >= lo && v <= hi
const COORD_MAX = 1e6

/** A display name typed by a GM: control/bidi characters dropped, whitespace collapsed; null when empty or too long. */
export function cleanNpcName(raw: string): string | null {
  const name = cleanQuestText(raw).replace(/\s+/g, ' ').trim()
  return name && codePointLength(name) <= NPC_NAME_MAX ? name : null
}

function respawnOk(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && intIn(v[0], 1, NEST_RESPAWN_MAX_SEC) && intIn(v[1], 1, NEST_RESPAWN_MAX_SEC) && v[0] <= v[1]
}

/** What the override readers need to know about the exported content. */
export interface OverrideRefs {
  world: string
  mob: (code: string) => MobDef | undefined
  /** Exported nests by id / NPCs by code (before any override). */
  nests: ReadonlyMap<number, NestDef>
  npcs: ReadonlyMap<string, NpcDef>
  shop: (id: string) => boolean
}

/**
 * The editors' own check of an authored nest (decision 44), returning a clean copy or the problems. `refs` (optional)
 * also requires a known mob.
 */
export function checkAuthoredNest(v: unknown, refs?: Pick<OverrideRefs, 'mob'>): { nest: AuthoredNest } | { problems: string[] } {
  if (!isObj(v)) return { problems: ['expected an object'] }
  const p: string[] = []
  if (!intIn(v.id, AUTHORED_NEST_ID_MIN, Number.MAX_SAFE_INTEGER)) p.push(`id: an integer >= ${AUTHORED_NEST_ID_MIN}`)
  if (typeof v.mob !== 'string' || !CODE_NAME.test(v.mob)) p.push('mob: a CodeName128')
  else if (refs && !refs.mob(v.mob)) p.push(`mob: unknown monster ${v.mob}`)
  if (!numIn(v.x, -COORD_MAX, COORD_MAX) || !numIn(v.z, -COORD_MAX, COORD_MAX)) p.push('x/z: finite numbers')
  if (v.y !== undefined && !numIn(v.y, -COORD_MAX, COORD_MAX)) p.push('y: a finite number')
  if (!intIn(v.count, 1, NEST_COUNT_MAX)) p.push(`count: 1-${NEST_COUNT_MAX}`)
  if (!numIn(v.radius, NEST_RADIUS_MIN, NEST_RADIUS_MAX)) p.push(`radius: ${NEST_RADIUS_MIN}-${NEST_RADIUS_MAX}`)
  if (!numIn(v.spawnRadius, 0, NEST_RADIUS_MAX)) p.push(`spawnRadius: 0-${NEST_RADIUS_MAX}`)
  if (!respawnOk(v.respawnSec)) p.push(`respawnSec: [min, max] seconds, 1-${NEST_RESPAWN_MAX_SEC}`)
  if (v.championPct !== undefined && !numIn(v.championPct, 0, 100)) p.push('championPct: 0-100')
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') p.push('enabled: a boolean')
  if (typeof v.world !== 'string' || v.world === '') p.push('world: a string')
  if (v.provenance !== 'authored') p.push("provenance: 'authored'")
  const t = v.tactics
  if (!isObj(t) || !Number.isInteger(t.id) || typeof t.aggressive !== 'boolean' || !numIn(t.sightRange, 0, 1000) || !numIn(t.leashRange, 0, 5000)) {
    p.push('tactics: {id, aggressive, sightRange, leashRange}')
  }
  const s = v.source
  if (!isObj(s) || s.file !== NESTS_OVERRIDE_FILE || typeof s.by !== 'string' || typeof s.at !== 'string') p.push('source: {file, by, at}')
  if (p.length > 0) return { problems: p }
  const tt = t as Record<string, unknown>
  const ss = s as Record<string, unknown>
  const nest: AuthoredNest = {
    id: v.id as number,
    mob: v.mob as string,
    x: v.x as number,
    z: v.z as number,
    ...(v.y !== undefined ? { y: v.y as number } : {}),
    radius: v.radius as number,
    spawnRadius: v.spawnRadius as number,
    count: v.count as number,
    respawnSec: [(v.respawnSec as number[])[0], (v.respawnSec as number[])[1]],
    ...(v.championPct !== undefined ? { championPct: v.championPct as number } : {}),
    tactics: { id: tt.id as number, aggressive: tt.aggressive as boolean, sightRange: tt.sightRange as number, leashRange: tt.leashRange as number },
    world: v.world as string,
    provenance: 'authored',
    source: { file: NESTS_OVERRIDE_FILE, by: String(ss.by).slice(0, 64), at: String(ss.at).slice(0, 64) },
    ...(v.enabled !== undefined ? { enabled: v.enabled as boolean } : {}),
  }
  return { nest }
}

/** A clean copy of a nest patch, or its problems. `refs` (optional) also requires a known exported nest and mob. */
export function checkNestPatch(v: unknown, refs?: Pick<OverrideRefs, 'mob' | 'nests'>): { patch: NestPatch } | { problems: string[] } {
  if (!isObj(v)) return { problems: ['expected an object'] }
  const p: string[] = []
  if (!intIn(v.id, 0, AUTHORED_NEST_ID_MIN - 1)) p.push(`id: an exported nest id (< ${AUTHORED_NEST_ID_MIN})`)
  else if (refs && !refs.nests.has(v.id)) p.push(`id: no exported nest ${v.id}`)
  if (v.mob !== undefined && (typeof v.mob !== 'string' || !CODE_NAME.test(v.mob) || (refs && !refs.mob(v.mob)))) p.push('mob: a known monster code')
  for (const k of ['x', 'z', 'y'] as const) if (v[k] !== undefined && !numIn(v[k], -COORD_MAX, COORD_MAX)) p.push(`${k}: a finite number`)
  if (v.count !== undefined && !intIn(v.count, 1, NEST_COUNT_MAX)) p.push(`count: 1-${NEST_COUNT_MAX}`)
  if (v.radius !== undefined && !numIn(v.radius, NEST_RADIUS_MIN, NEST_RADIUS_MAX)) p.push(`radius: ${NEST_RADIUS_MIN}-${NEST_RADIUS_MAX}`)
  if (v.spawnRadius !== undefined && !numIn(v.spawnRadius, 0, NEST_RADIUS_MAX)) p.push(`spawnRadius: 0-${NEST_RADIUS_MAX}`)
  if (v.respawnSec !== undefined && !respawnOk(v.respawnSec)) p.push('respawnSec: [min, max] seconds')
  if (v.championPct !== undefined && !numIn(v.championPct, 0, 100)) p.push('championPct: 0-100')
  for (const k of ['aggressive', 'enabled'] as const) if (v[k] !== undefined && typeof v[k] !== 'boolean') p.push(`${k}: a boolean`)
  if (p.length > 0) return { problems: p }
  const patch: NestPatch = { id: v.id as number }
  for (const k of ['mob', 'x', 'z', 'y', 'count', 'radius', 'spawnRadius', 'championPct', 'aggressive', 'enabled'] as const) {
    if (v[k] !== undefined) (patch as unknown as Record<string, unknown>)[k] = v[k]
  }
  if (v.respawnSec !== undefined) patch.respawnSec = [(v.respawnSec as number[])[0], (v.respawnSec as number[])[1]]
  return { patch }
}

/** A clean copy of an authored NPC, or its problems (`refs`: the base must be an exported NPC, the shop must exist). */
export function checkAuthoredNpc(v: unknown, refs?: Pick<OverrideRefs, 'npcs' | 'shop'>): { npc: AuthoredNpc } | { problems: string[] } {
  if (!isObj(v)) return { problems: ['expected an object'] }
  const p: string[] = []
  if (typeof v.code !== 'string' || !AUTHORED_NPC_CODE.test(v.code)) p.push('code: NPCX_*')
  if (typeof v.base !== 'string' || !CODE_NAME.test(v.base)) p.push('base: an NPC code')
  else if (refs && !refs.npcs.has(v.base)) p.push(`base: no NPC ${v.base} in npcs.json`)
  const name = typeof v.name === 'string' ? cleanNpcName(v.name) : null
  if (name === null) p.push(`name: 1-${NPC_NAME_MAX} characters`)
  if (!numIn(v.x, -COORD_MAX, COORD_MAX) || !numIn(v.z, -COORD_MAX, COORD_MAX)) p.push('x/z: finite numbers')
  if (v.y !== undefined && !numIn(v.y, -COORD_MAX, COORD_MAX)) p.push('y: a finite number')
  if (!finite(v.yaw)) p.push('yaw: a number')
  if (v.shop !== undefined && (typeof v.shop !== 'string' || (refs && !refs.shop(v.shop)))) p.push('shop: a shops.json id')
  if (p.length > 0) return { problems: p }
  return {
    npc: {
      code: v.code as string,
      base: v.base as string,
      name: name!,
      x: v.x as number,
      z: v.z as number,
      ...(v.y !== undefined ? { y: v.y as number } : {}),
      yaw: v.yaw as number,
      ...(v.shop !== undefined ? { shop: v.shop as string } : {}),
    },
  }
}

/** A clean copy of an exported NPC's patch, or its problems. */
export function checkNpcPatch(v: unknown, refs?: Pick<OverrideRefs, 'npcs' | 'shop'>): { patch: NpcPatch } | { problems: string[] } {
  if (!isObj(v)) return { problems: ['expected an object'] }
  const p: string[] = []
  if (typeof v.code !== 'string' || !CODE_NAME.test(v.code) || AUTHORED_NPC_CODE.test(v.code)) p.push('code: an exported NPC code')
  else if (refs && !refs.npcs.has(v.code)) p.push(`code: no NPC ${v.code} in npcs.json`)
  const name = typeof v.name === 'string' ? cleanNpcName(v.name) : null
  if (v.name !== undefined && name === null) p.push(`name: 1-${NPC_NAME_MAX} characters`)
  for (const k of ['x', 'z', 'y'] as const) if (v[k] !== undefined && !numIn(v[k], -COORD_MAX, COORD_MAX)) p.push(`${k}: a finite number`)
  if (v.yaw !== undefined && !finite(v.yaw)) p.push('yaw: a number')
  if (v.shop !== undefined && v.shop !== null && (typeof v.shop !== 'string' || (refs && !refs.shop(v.shop)))) p.push('shop: a shops.json id or null')
  if (v.hidden !== undefined && typeof v.hidden !== 'boolean') p.push('hidden: a boolean')
  if (p.length > 0) return { problems: p }
  const patch: NpcPatch = { code: v.code as string }
  if (name !== null) patch.name = name
  for (const k of ['x', 'z', 'y', 'yaw', 'hidden'] as const) if (v[k] !== undefined) (patch as unknown as Record<string, unknown>)[k] = v[k]
  if (v.shop !== undefined) patch.shop = v.shop as string | null
  return { patch }
}

// ---- override files: parse (skip bad records) and layer --------------------------------------------------

export function emptyNestOverride(world: string): NestOverrideFile {
  return { schema: 1, kind: 'nests-override', world, rev: 0, updatedAt: '', add: [], patch: [], remove: [] }
}

export function emptyNpcOverride(world: string): NpcOverrideFile {
  return { schema: 1, kind: 'npcs-override', world, rev: 0, updatedAt: '', add: [], patch: [] }
}

function envelope(json: unknown, kind: string, world: string): { o: Record<string, unknown>; rev: number; updatedAt: string } | string {
  if (!isObj(json)) return 'expected an object'
  if (json.schema !== 1) return 'schema must be 1'
  if (json.kind !== kind) return `kind must be '${kind}'`
  if (json.world !== world) return `world is ${JSON.stringify(json.world)}, this server runs ${world}`
  return { o: json, rev: intIn(json.rev, 0, Number.MAX_SAFE_INTEGER) ? json.rev : 0, updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt.slice(0, 64) : '' }
}

function records(o: Record<string, unknown>, key: string, problems: string[]): unknown[] {
  const v = o[key]
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    problems.push(`${key}: expected an array`)
    return []
  }
  if (v.length > OVERRIDE_RECORDS_MAX) problems.push(`${key}: only the first ${OVERRIDE_RECORDS_MAX} records are read`)
  return v.slice(0, OVERRIDE_RECORDS_MAX)
}

/** Reads a nests override (never throws): bad records are skipped and reported; a broken envelope gives an empty file. */
export function parseNestOverride(json: unknown, refs: OverrideRefs): { file: NestOverrideFile; problems: string[] } {
  const env = envelope(json, 'nests-override', refs.world)
  if (typeof env === 'string') return { file: emptyNestOverride(refs.world), problems: [env] }
  const problems: string[] = []
  const file: NestOverrideFile = { ...emptyNestOverride(refs.world), rev: env.rev, updatedAt: env.updatedAt }
  let authored = 0
  records(env.o, 'add', problems).forEach((v, i) => {
    const r = checkAuthoredNest(v, refs)
    if ('problems' in r) problems.push(`add[${i}]: ${r.problems.join('; ')}`)
    else if (file.add.some((n) => n.id === r.nest.id)) problems.push(`add[${i}]: duplicate id ${r.nest.id}`)
    else if (r.nest.world !== refs.world) problems.push(`add[${i}]: world ${r.nest.world}`)
    else {
      const n = r.nest.enabled === false ? 0 : r.nest.count
      if (authored + n > NEST_AUTHORED_MOBS_MAX) problems.push(`add[${i}]: over the cap of ${NEST_AUTHORED_MOBS_MAX} authored monsters`)
      else {
        authored += n
        file.add.push(r.nest)
      }
    }
  })
  records(env.o, 'patch', problems).forEach((v, i) => {
    const r = checkNestPatch(v, refs)
    if ('problems' in r) problems.push(`patch[${i}]: ${r.problems.join('; ')}`)
    else if (file.patch.some((n) => n.id === r.patch.id)) problems.push(`patch[${i}]: duplicate id ${r.patch.id}`)
    else file.patch.push(r.patch)
  })
  records(env.o, 'remove', problems).forEach((v, i) => {
    if (!intIn(v, 0, AUTHORED_NEST_ID_MIN - 1) || !refs.nests.has(v)) problems.push(`remove[${i}]: no exported nest ${JSON.stringify(v)}`)
    else if (!file.remove.includes(v)) file.remove.push(v)
  })
  return { file, problems }
}

/** Reads an NPCs override (never throws), like parseNestOverride. */
export function parseNpcOverride(json: unknown, refs: OverrideRefs): { file: NpcOverrideFile; problems: string[] } {
  const env = envelope(json, 'npcs-override', refs.world)
  if (typeof env === 'string') return { file: emptyNpcOverride(refs.world), problems: [env] }
  const problems: string[] = []
  const file: NpcOverrideFile = { ...emptyNpcOverride(refs.world), rev: env.rev, updatedAt: env.updatedAt }
  records(env.o, 'add', problems).forEach((v, i) => {
    const r = checkAuthoredNpc(v, refs)
    if ('problems' in r) problems.push(`add[${i}]: ${r.problems.join('; ')}`)
    else if (file.add.some((n) => n.code === r.npc.code)) problems.push(`add[${i}]: duplicate code ${r.npc.code}`)
    else file.add.push(r.npc)
  })
  records(env.o, 'patch', problems).forEach((v, i) => {
    const r = checkNpcPatch(v, refs)
    if ('problems' in r) problems.push(`patch[${i}]: ${r.problems.join('; ')}`)
    else if (file.patch.some((n) => n.code === r.patch.code)) problems.push(`patch[${i}]: duplicate code ${r.patch.code}`)
    else file.patch.push(r.patch)
  })
  return { file, problems }
}

/** An authored nest as the NestDef the spawner uses. */
export function authoredNestDef(a: AuthoredNest, mob?: MobDef): NestDef {
  const { source, ...rest } = a
  return { ...rest, provenance: 'authored', source: { file: source.file, zone: `authored by ${source.by}`, x: a.x, z: a.z }, ...(mob ? { level: mob.level } : {}) }
}

/** An exported nest with a GM patch applied. */
export function patchedNestDef(n: NestDef, p: NestPatch, mob?: MobDef): NestDef {
  const out: NestDef = { ...n, tactics: { ...n.tactics } }
  if (p.mob !== undefined) {
    out.mob = p.mob
    if (mob) out.level = mob.level
  }
  for (const k of ['x', 'z', 'y', 'count', 'radius', 'spawnRadius', 'championPct', 'enabled'] as const) {
    if (p[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = p[k]
  }
  if (p.respawnSec) out.respawnSec = [p.respawnSec[0], p.respawnSec[1]]
  if (p.aggressive !== undefined) out.tactics.aggressive = p.aggressive
  return out
}

/** Layering (docs/QUESTS.md §5.1): remove, then patch by id, then add. */
export function layerNests(base: readonly NestDef[], o: NestOverrideFile, mob: (code: string) => MobDef | undefined = () => undefined): NestDef[] {
  const removed = new Set(o.remove)
  const patches = new Map(o.patch.map((p) => [p.id, p]))
  const out: NestDef[] = []
  for (const n of base) {
    if (removed.has(n.id)) continue
    const p = patches.get(n.id)
    out.push(p ? patchedNestDef(n, p, p.mob ? mob(p.mob) : undefined) : n)
  }
  for (const a of o.add) out.push(authoredNestDef(a, mob(a.mob)))
  return out
}

/** Where a nest id comes from under `o`. */
export function nestSource(id: number, o: NestOverrideFile): ContentSource {
  if (id >= AUTHORED_NEST_ID_MIN) return 'authored'
  return o.patch.some((p) => p.id === id) ? 'patched' : 'export'
}

/** An authored NPC as the NpcDef the world places. */
export function authoredNpcDef(a: AuthoredNpc, world: string): NpcDef {
  return { code: a.code, name: a.name, x: a.x, z: a.z, ...(a.y !== undefined ? { y: a.y } : {}), yaw: a.yaw, world, ...(a.shop ? { shop: a.shop } : {}), model: null, provenance: 'authored' }
}

/** An exported NPC with a GM patch applied (`hidden` is handled by the layering). */
export function patchedNpcDef(n: NpcDef, p: NpcPatch): NpcDef {
  const out: NpcDef = { ...n }
  if (p.name !== undefined) out.name = p.name
  for (const k of ['x', 'z', 'y', 'yaw'] as const) if (p[k] !== undefined) out[k] = p[k]
  if (p.shop === null) delete out.shop
  else if (p.shop !== undefined) out.shop = p.shop
  return out
}

/**
 * Layering of the NPCs: the exported NPCs with their patches (hidden ones dropped), then the authored ones. Also returns
 * the model each authored NPC wears and the shop changes (code -> shop id, or null for "no shop").
 */
export function layerNpcs(base: readonly NpcDef[], o: NpcOverrideFile, world: string): { npcs: NpcDef[]; model: Map<string, string>; shop: Map<string, string | null> } {
  const patches = new Map(o.patch.map((p) => [p.code, p]))
  const npcs: NpcDef[] = []
  const shop = new Map<string, string | null>()
  for (const n of base) {
    const p = patches.get(n.code)
    if (p?.hidden) continue
    npcs.push(p ? patchedNpcDef(n, p) : n)
    if (p?.shop !== undefined) shop.set(n.code, p.shop)
  }
  const model = new Map<string, string>()
  for (const a of o.add) {
    npcs.push(authoredNpcDef(a, world))
    model.set(a.code, a.base)
    shop.set(a.code, a.shop ?? null)
  }
  return { npcs, model, shop }
}

/** Where an NPC code comes from under `o`. */
export function npcSource(code: string, o: NpcOverrideFile): ContentSource {
  if (o.add.some((a) => a.code === code)) return 'authored'
  return o.patch.some((p) => p.code === code) ? 'patched' : 'export'
}

// ---- the live state: exported content + override files, layered into GameData --------------------------------

export interface ContentState {
  /** DATA_DIR/content. */
  root: string
  world: string
  /** The exported content before any override (GameData's arrays are rebuilt from these). */
  base: { nests: NestDef[]; npcs: NpcDef[]; npcShop: Map<string, string> }
  nests: NestOverrideFile
  npcs: NpcOverrideFile
  /** Problems found reading each file (for `content status`). */
  problems: { nests: string[]; npcs: string[] }
}

const STATES = new WeakMap<GameData, ContentState>()

export function overrideRefs(data: GameData, st: Pick<ContentState, 'base' | 'world'>): OverrideRefs {
  return {
    world: st.world,
    mob: (code) => data.mob(code),
    nests: new Map(st.base.nests.map((n) => [n.id, n])),
    npcs: new Map(st.base.npcs.map((n) => [n.code, n])),
    shop: (id) => data.shops.has(id),
  }
}

/** Reads one override file of `st` from disk into `st` (never throws; problems are kept and returned). */
export function readOverride(data: GameData, st: ContentState, kind: 'nests' | 'npcs'): string[] {
  const rel = kind === 'nests' ? NESTS_OVERRIDE_FILE : NPCS_OVERRIDE_FILE
  const r = readJsonFile(join(st.root, rel))
  const refs = overrideRefs(data, st)
  let problems: string[]
  if ('missing' in r) {
    problems = []
    if (kind === 'nests') st.nests = emptyNestOverride(st.world)
    else st.npcs = emptyNpcOverride(st.world)
  } else if ('error' in r) {
    // An unreadable file keeps what was loaded before (at startup: nothing), so a half-edited file never wipes content.
    problems = [r.error]
  } else if (kind === 'nests') {
    const p = parseNestOverride(r.json, refs)
    st.nests = p.file
    problems = p.problems
  } else {
    const p = parseNpcOverride(r.json, refs)
    st.npcs = p.file
    problems = p.problems
  }
  st.problems[kind] = problems
  return problems
}

/** Rebuilds GameData's nests, NPCs, NPC shops and authored models from the exported content and `st`'s files. */
export function applyLayers(data: GameData, st: ContentState): void {
  const nests = layerNests(st.base.nests, st.nests, (c) => data.mob(c))
  data.nests.splice(0, data.nests.length, ...nests)
  const { npcs, model, shop } = layerNpcs(st.base.npcs, st.npcs, st.world)
  data.npcs.splice(0, data.npcs.length, ...npcs)
  data.npcShop.clear()
  for (const [k, v] of st.base.npcShop) data.npcShop.set(k, v)
  for (const [code, id] of shop) {
    if (id === null) data.npcShop.delete(code)
    else if (data.shops.has(id)) data.npcShop.set(code, id)
  }
  data.npcModel.clear()
  for (const [k, v] of model) data.npcModel.set(k, v)
}

/**
 * The content state of `data` (created on first use: the exported content as it is now, plus the override files read
 * from DATA_DIR/content and layered in). game.ts calls it right after GameData.load, before Gameplay places anything.
 */
export function contentState(data: GameData, dataDir: string, world: string, log: (msg: string) => void = () => {}): ContentState {
  const known = STATES.get(data)
  if (known) return known
  const st: ContentState = {
    root: contentRoot(dataDir),
    world,
    base: { nests: [...data.nests], npcs: [...data.npcs], npcShop: new Map(data.npcShop) },
    nests: emptyNestOverride(world),
    npcs: emptyNpcOverride(world),
    problems: { nests: [], npcs: [] },
  }
  STATES.set(data, st)
  for (const kind of ['nests', 'npcs'] as const) {
    const problems = readOverride(data, st, kind)
    for (const p of problems.slice(0, 10)) log(`content override ${kind}: skipped ${p}`)
    if (problems.length > 10) log(`content override ${kind}: ${problems.length - 10} more problems`)
  }
  applyLayers(data, st)
  const n = st.nests
  const c = st.npcs
  if (n.rev > 0 || c.rev > 0) {
    log(`content overrides (${st.root}): nests rev ${n.rev} (+${n.add.length} authored, ${n.patch.length} patched, ${n.remove.length} removed); npcs rev ${c.rev} (+${c.add.length} authored, ${c.patch.length} patched)`)
  }
  return st
}

/** Startup hook (game.ts): layers DATA_DIR/content/{nests,npcs}.override.json over the exported content. */
export function layerContentOverrides(data: GameData, dataDir: string, world: string, log: (msg: string) => void): ContentState {
  return contentState(data, dataDir, world, log)
}

/**
 * Repo overrides (CONTENT_DIR/{nests,npcs}.override.json): the same file formats, committed and deployed with the code,
 * for content decisions that belong to everyone's server (docs/QUESTS.md §5.1; Miaoryeong's spot, a sleeping tomb
 * pack). game.ts layers them into the exported content before layerContentOverrides captures it, so the GM files still
 * apply on top and the editors treat these changes as part of the export. Only `patch` (and nests' `remove`) are read:
 * authored `add` records need the GM editors' id and model bookkeeping, so they stay in DATA_DIR. Never throws.
 */
export function layerRepoOverrides(data: GameData, contentDir: string | undefined, world: string, log: (msg: string) => void): void {
  if (!contentDir) return
  const refs: OverrideRefs = {
    world,
    mob: (code) => data.mob(code),
    nests: new Map(data.nests.map((n) => [n.id, n])),
    npcs: new Map(data.npcs.map((n) => [n.code, n])),
    shop: (id) => data.shops.has(id),
  }
  for (const kind of ['nests', 'npcs'] as const) {
    const file = join(contentDir, kind === 'nests' ? NESTS_OVERRIDE_FILE : NPCS_OVERRIDE_FILE)
    const r = readJsonFile(file)
    if ('missing' in r) continue
    if ('error' in r) {
      log(`repo content ${kind}: skipped ${file}: ${r.error}`)
      continue
    }
    const p = kind === 'nests' ? parseNestOverride(r.json, refs) : parseNpcOverride(r.json, refs)
    const problems = [...p.problems, ...(p.file.add.length ? [`add: ${p.file.add.length} authored records ignored (GM editors only)`] : [])]
    for (const m of problems.slice(0, 10)) log(`repo content ${kind}: skipped ${m}`)
    if (kind === 'nests') {
      const o = { ...(p.file as NestOverrideFile), add: [] }
      data.nests.splice(0, data.nests.length, ...layerNests(data.nests, o, (c) => data.mob(c)))
      log(`repo content nests (${file}): ${o.patch.length} patched, ${o.remove.length} removed`)
    } else {
      const o = { ...(p.file as NpcOverrideFile), add: [] }
      const { npcs, shop } = layerNpcs(data.npcs, o, world)
      data.npcs.splice(0, data.npcs.length, ...npcs)
      for (const [code, id] of shop) {
        if (id === null) data.npcShop.delete(code)
        else if (data.shops.has(id)) data.npcShop.set(code, id)
      }
      log(`repo content npcs (${file}): ${o.patch.length} patched`)
    }
  }
}
