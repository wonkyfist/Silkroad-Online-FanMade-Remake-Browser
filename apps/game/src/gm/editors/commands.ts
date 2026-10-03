/**
 * GM content editor commands (docs/QUESTS.md §5.2, §5.3; lane ED-C): builders for the server's `nest`, `npc` and
 * `content` GM commands and tolerant readers of their `gmResult.data`. Every builder goes through gm/commands.ts
 * `gmMessage`, so the message passes the shared protocol validator; the bounds mirror apps/server/src/editors
 * (NEST_COUNT_MAX, NEST_RADIUS_MIN/MAX, NEST_RESPAWN_MAX_SEC, NPC_NAME_MAX). The server re-checks everything.
 * Pure module (no DOM): unit-tested in test/editors.test.ts.
 */
import { CODE_NAME, cleanQuestText, codePointLength, type ContentChangeKind, type ContentSource, type GmNestInfo, type GmNpcInfo } from '@sro/shared'
import { t } from '../../i18n/index.ts'
import { contentCode, gmMessage, parseCount, type GmBuild } from '../commands.ts'

/** Server bounds (apps/server/src/editors/overrides.ts). */
export const NEST_COUNT_MAX = 50
export const NEST_RADIUS_MIN = 2
export const NEST_RADIUS_MAX = 200
export const NEST_RESPAWN_MAX_SEC = 86_400
export const NEST_NEAR_DEFAULT = 150
export const NEST_NEAR_MAX = 1000
export const NPC_NEAR_DEFAULT = 60
export const NPC_NAME_MAX = 32
/** Ids from here up are GM-authored nests (AUTHORED_NEST_ID_MIN). */
export const AUTHORED_NEST_ID_MIN = 1_000_000
/** `nest add` defaults (the server's ADD_DEFAULTS). */
export const NEST_ADD_DEFAULTS = { count: 5, radius: 30, respawnSec: 30 } as const

export type NestField = 'mob' | 'count' | 'radius' | 'spawnradius' | 'respawn' | 'aggressive' | 'champion' | 'enabled'
export const NEST_FIELDS: readonly NestField[] = ['mob', 'count', 'radius', 'spawnradius', 'respawn', 'aggressive', 'champion', 'enabled']

const fail = (error: string): GmBuild => ({ ok: false, error })

/** A number typed in a field ('12', '12.5'); null when it is not one. */
function parseNumber(raw: string | number): number | null {
  const s = String(raw).trim()
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/** Numbers go out without trailing zeros ('30', '12.5'). */
function fmtNum(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** Respawn seconds as typed: '30' -> [30, 30], '20-40' -> [20, 40] (1..NEST_RESPAWN_MAX_SEC, min <= max). */
export function parseRespawn(raw: string | number): [number, number] | null {
  const m = /^(\d{1,6})(?:\s*-\s*(\d{1,6}))?$/.exec(String(raw).trim())
  if (!m) return null
  const lo = Number(m[1])
  const hi = m[2] === undefined ? lo : Number(m[2])
  return lo >= 1 && hi <= NEST_RESPAWN_MAX_SEC && lo <= hi ? [lo, hi] : null
}

/** [20, 40] -> '20-40', [30, 30] -> '30'. */
export function fmtRespawn(r: readonly [number, number]): string {
  return r[0] === r[1] ? String(r[0]) : `${r[0]}-${r[1]}`
}

/** A nest id as typed ('#1000000', '42'); null when it is not one. */
export function parseNestId(raw: string | number): number | null {
  const s = String(raw).trim().replace(/^#/, '')
  if (!/^\d{1,16}$/.test(s)) return null
  const v = Number(s)
  return Number.isSafeInteger(v) ? v : null
}

/** The display name rule of the server (cleanNpcName): no control characters, whitespace collapsed, 1..32 code points. */
export function cleanNpcName(raw: string): string | null {
  const s = cleanQuestText(raw).replace(/\s+/g, ' ').trim()
  const n = codePointLength(s)
  return n >= 1 && n <= NPC_NAME_MAX ? s : null
}

function nestIdOr(raw: string | number, build: (id: number) => GmBuild): GmBuild {
  const id = parseNestId(raw)
  return id === null ? fail(t('gm.editor.err.nestId')) : build(id)
}

function npcCodeOr(raw: string, build: (code: string) => GmBuild): GmBuild {
  const code = raw.trim().toUpperCase()
  return CODE_NAME.test(code) ? build(code) : fail(t('gm.editor.err.npcCode'))
}

function nearRadius(raw: string | number | undefined, cmd: 'nest' | 'npc'): GmBuild {
  if (raw === undefined || String(raw).trim() === '') return gmMessage(cmd, ['near'])
  const r = parseNumber(raw)
  if (r === null || r <= 0 || r > NEST_NEAR_MAX) return fail(t('gm.editor.err.near', { max: NEST_NEAR_MAX }))
  return gmMessage(cmd, ['near', fmtNum(r)])
}

/** The value of `nest set <id> <field> <value>` as the server parses it; an error text when it is out of bounds. */
export function nestFieldValue(field: NestField, value: string | number | boolean): string | { error: string } {
  switch (field) {
    case 'mob': {
      const code = contentCode(String(value))
      return code ?? { error: t('gm.err.code', { example: 'MOB_CH_MANGNYANG' }) }
    }
    case 'count': {
      const n = parseCount(typeof value === 'boolean' ? '' : value, NEST_COUNT_MAX)
      return n === null || n === undefined ? { error: t('gm.editor.err.count', { max: NEST_COUNT_MAX }) } : String(n)
    }
    case 'radius':
    case 'spawnradius': {
      const v = typeof value === 'boolean' ? null : parseNumber(value)
      const lo = field === 'radius' ? NEST_RADIUS_MIN : 0
      if (v === null || v < lo || v > NEST_RADIUS_MAX) return { error: t('gm.editor.err.radius', { min: lo, max: NEST_RADIUS_MAX }) }
      return fmtNum(v)
    }
    case 'respawn': {
      const r = typeof value === 'boolean' ? null : parseRespawn(value)
      return r ? fmtRespawn(r) : { error: t('gm.editor.err.respawn', { max: NEST_RESPAWN_MAX_SEC }) }
    }
    case 'aggressive':
    case 'enabled': {
      if (typeof value === 'boolean') return value ? 'on' : 'off'
      const s = String(value).trim().toLowerCase()
      if (['on', 'yes', 'true', '1'].includes(s)) return 'on'
      if (['off', 'no', 'false', '0'].includes(s)) return 'off'
      return { error: t('gm.editor.err.onOff') }
    }
    case 'champion': {
      const v = typeof value === 'boolean' ? null : parseNumber(value)
      return v === null || v < 0 || v > 100 ? { error: t('gm.editor.err.champion') } : fmtNum(v)
    }
  }
}

export const editorCmd = {
  // ---- spawn editor (`nest`) ----
  /** nest near [radius]: nests with a centre within radius of the GM (server default 150 m). */
  nestNear: (radius?: string | number): GmBuild => nearRadius(radius, 'nest'),
  /** nest add <mob> [count] [radius] [respawn]: empty fields take the server defaults (5, 30 m, 30 s). */
  nestAdd(mob: string, count?: string | number, radius?: string | number, respawn?: string | number): GmBuild {
    const code = contentCode(mob)
    if (!code) return fail(t('gm.err.code', { example: 'MOB_CH_MANGNYANG' }))
    const c = String(count ?? '').trim() === '' ? NEST_ADD_DEFAULTS.count : parseCount(count, NEST_COUNT_MAX)
    if (c === null || c === undefined) return fail(t('gm.editor.err.count', { max: NEST_COUNT_MAX }))
    const rRaw = String(radius ?? '').trim()
    const r = rRaw === '' ? NEST_ADD_DEFAULTS.radius : parseNumber(rRaw)
    if (r === null || r < NEST_RADIUS_MIN || r > NEST_RADIUS_MAX) return fail(t('gm.editor.err.radius', { min: NEST_RADIUS_MIN, max: NEST_RADIUS_MAX }))
    const sRaw = String(respawn ?? '').trim()
    const s = sRaw === '' ? ([NEST_ADD_DEFAULTS.respawnSec, NEST_ADD_DEFAULTS.respawnSec] as [number, number]) : parseRespawn(sRaw)
    if (!s) return fail(t('gm.editor.err.respawn', { max: NEST_RESPAWN_MAX_SEC }))
    return gmMessage('nest', ['add', code, String(c), fmtNum(r), fmtRespawn(s)])
  },
  /** nest move <id>: the centre goes to the GM's position. */
  nestMove: (id: string | number): GmBuild => nestIdOr(id, n => gmMessage('nest', ['move', String(n)])),
  nestSet(id: string | number, field: NestField, value: string | number | boolean): GmBuild {
    if (!NEST_FIELDS.includes(field)) return fail(t('gm.editor.err.field'))
    return nestIdOr(id, n => {
      const v = nestFieldValue(field, value)
      return typeof v === 'string' ? gmMessage('nest', ['set', String(n), field, v]) : fail(v.error)
    })
  },
  /** Authored nests are deleted; exported ones go on the override's remove list. */
  nestRemove: (id: string | number): GmBuild => nestIdOr(id, n => gmMessage('nest', ['remove', String(n)])),
  /** Drops an exported nest's override (patch or removal). */
  nestRestore: (id: string | number): GmBuild => nestIdOr(id, n => (n >= AUTHORED_NEST_ID_MIN ? fail(t('gm.editor.err.restoreAuthored')) : gmMessage('nest', ['restore', String(n)]))),
  nestUndo: (): GmBuild => gmMessage('nest', ['undo']),

  // ---- NPC editor (`npc`) ----
  npcNear: (radius?: string | number): GmBuild => nearRadius(radius, 'npc'),
  /** npc add <base code> <name>: a new NPCX_<n> at the GM's position and facing, wearing `base`'s look. */
  npcAdd(base: string, name: string): GmBuild {
    const code = contentCode(base)
    if (!code) return fail(t('gm.err.code', { example: 'NPC_CH_SMITH' }))
    const clean = cleanNpcName(name)
    if (clean === null) return fail(t('gm.editor.err.npcName', { max: NPC_NAME_MAX }))
    return gmMessage('npc', ['add', code, clean])
  },
  npcMove: (code: string): GmBuild => npcCodeOr(code, c => gmMessage('npc', ['move', c])),
  /** Turns the NPC to the GM's facing. */
  npcFace: (code: string): GmBuild => npcCodeOr(code, c => gmMessage('npc', ['face', c])),
  npcRename(code: string, name: string): GmBuild {
    return npcCodeOr(code, c => {
      const clean = cleanNpcName(name)
      return clean === null ? fail(t('gm.editor.err.npcName', { max: NPC_NAME_MAX })) : gmMessage('npc', ['rename', c, clean])
    })
  },
  /** npc shop <code> <shop id | none>. */
  npcShop(code: string, shop: string | null): GmBuild {
    return npcCodeOr(code, c => {
      const s = (shop ?? '').trim()
      if (!s || s.toLowerCase() === 'none') return gmMessage('npc', ['shop', c, 'none'])
      if (!/^[A-Za-z0-9_]{1,128}$/.test(s)) return fail(t('gm.editor.err.shop'))
      return gmMessage('npc', ['shop', c, s])
    })
  },
  /** Authored NPCs are deleted; exported ones are hidden. */
  npcRemove: (code: string): GmBuild => npcCodeOr(code, c => gmMessage('npc', ['remove', c])),
  npcRestore: (code: string): GmBuild => npcCodeOr(code, c => gmMessage('npc', ['restore', c])),
  npcUndo: (): GmBuild => gmMessage('npc', ['undo']),

  // ---- `content` ----
  contentStatus: (): GmBuild => gmMessage('content', ['status']),
  contentReload: (kind: ContentChangeKind | 'all' = 'all'): GmBuild => gmMessage('content', ['reload', kind]),
}

// ---- reading gmResult.data (tolerant: data is `unknown` on the wire) ------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const SOURCES: readonly ContentSource[] = ['export', 'patched', 'authored']
const source = (v: unknown): ContentSource => (SOURCES.includes(v as ContentSource) ? (v as ContentSource) : 'export')

export function readNestInfo(v: unknown): GmNestInfo | null {
  if (!isRecord(v) || !finite(v.id) || typeof v.mob !== 'string' || !finite(v.x) || !finite(v.z)) return null
  const rs = Array.isArray(v.respawnSec) && v.respawnSec.length === 2 && v.respawnSec.every(finite) ? ([v.respawnSec[0], v.respawnSec[1]] as [number, number]) : ([0, 0] as [number, number])
  return {
    id: v.id,
    mob: v.mob,
    mobName: typeof v.mobName === 'string' && v.mobName ? v.mobName : v.mob,
    level: finite(v.level) ? v.level : 0,
    x: v.x,
    z: v.z,
    radius: finite(v.radius) ? v.radius : 0,
    spawnRadius: finite(v.spawnRadius) ? v.spawnRadius : finite(v.radius) ? v.radius : 0,
    count: finite(v.count) ? v.count : 0,
    alive: finite(v.alive) ? v.alive : 0,
    respawnSec: rs,
    aggressive: v.aggressive === true,
    enabled: v.enabled !== false,
    source: source(v.source),
  }
}

export function readNpcInfo(v: unknown): GmNpcInfo | null {
  if (!isRecord(v) || typeof v.code !== 'string' || !finite(v.x) || !finite(v.z)) return null
  return {
    code: v.code,
    base: typeof v.base === 'string' && v.base ? v.base : v.code,
    name: typeof v.name === 'string' && v.name ? v.name : v.code,
    x: v.x,
    z: v.z,
    yaw: finite(v.yaw) ? v.yaw : 0,
    entity: finite(v.entity) ? v.entity : null,
    ...(typeof v.shop === 'string' && v.shop ? { shop: v.shop } : {}),
    ...(v.hidden === true ? { hidden: true } : {}),
    source: source(v.source),
  }
}

/** What one `nest` reply says: a near list, one nest (add/move/set/restore), a removed id, or an undo revision. */
export interface NestResult {
  nests?: GmNestInfo[]
  nest?: GmNestInfo
  removed?: number
  rev?: number
}

export function readNestResult(data: unknown): NestResult {
  if (!isRecord(data)) return {}
  const out: NestResult = {}
  if (Array.isArray(data.nests)) out.nests = data.nests.map(readNestInfo).filter((n): n is GmNestInfo => n !== null)
  const nest = readNestInfo(data.nest)
  if (nest) out.nest = nest
  if (finite(data.id)) out.removed = data.id
  if (finite(data.rev)) out.rev = data.rev
  return out
}

export interface NpcResult {
  npcs?: GmNpcInfo[]
  npc?: GmNpcInfo
  removed?: string
  rev?: number
}

export function readNpcResult(data: unknown): NpcResult {
  if (!isRecord(data)) return {}
  const out: NpcResult = {}
  if (Array.isArray(data.npcs)) out.npcs = data.npcs.map(readNpcInfo).filter((n): n is GmNpcInfo => n !== null)
  const npc = readNpcInfo(data.npc)
  if (npc) out.npc = npc
  if (typeof data.code === 'string') out.removed = data.code
  if (finite(data.rev)) out.rev = data.rev
  return out
}

/** Replaces or inserts `item` (by key) in a list, keeping its order; removes it when `item` is null. */
export function upsert<T>(list: readonly T[], key: (x: T) => string | number, k: string | number, item: T | null): T[] {
  const i = list.findIndex(x => key(x) === k)
  if (item === null) return i < 0 ? [...list] : [...list.slice(0, i), ...list.slice(i + 1)]
  if (i < 0) return [item, ...list]
  const out = [...list]
  out[i] = item
  return out
}

/** Metres between two ground points. */
export function dist2d(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** The NPC identity an entity shows (decision 43: `npc` when it differs from the model, else `model`). */
export function npcIdentity(state: { npc?: string; model: string }): string {
  return state.npc ?? state.model
}
