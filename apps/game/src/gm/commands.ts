/**
 * GM (Game Master) command construction, shared by the GM window and the chat box.
 * Every builder returns a protocol `gm` message that passes packages/shared validation (GM_COMMAND,
 * GM_MAX_ARGS, GM_MAX_ARG_LENGTH, MAX_CLIENT_MESSAGE_BYTES) or an English error for the window to show.
 * The command set and argument forms are the server's (apps/server/src/gm.ts, README "GM").
 * Pure module (no DOM): unit-tested in test/gm.test.ts against parseClientMessage.
 */
import {
  CHARACTER_NAME,
  CODE_NAME,
  MAX_ITEM_COUNT,
  DEFAULT_LEVEL_CAP,
  GM_COMMAND,
  GM_MAX_ARG_LENGTH,
  GM_MAX_ARGS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_COORD,
  ROLES,
  codePointLength,
  utf8Length,
  type ClientMessage,
  type GmPlayerInfo,
  type GmPreset,
  type Role,
  type Vec3,
} from '@sro/shared'
import { t } from '../i18n/index.ts'

export type GmMessage = Extract<ClientMessage, { t: 'gm' }>
export type GmBuild = { ok: true; msg: GmMessage } | { ok: false; error: string }

/** Server limits mirrored for the UI (apps/server/src/gm.ts). The server re-checks everything. */
export const GM_SPEED_MIN = 0.5
export const GM_SPEED_MAX = 5
export const GM_NOTICE_MAX = 300
/** The world's own spawn preset; the server always has it (tp <world name> / tp spawn). */
export const GM_HOME_PRESET = 'jangan'

const fail = (error: string): GmBuild => ({ ok: false, error })

/** gameplay GM commands (docs/PROTOCOL.md section 10): spawn 1..50 mobs, item counts up to MAX_ITEM_COUNT. */
export const GM_SPAWN_MAX = 50
export const GM_ITEM_MAX = MAX_ITEM_COUNT

/** A CodeName128 as typed ("mob_ch_mangnyang " -> "MOB_CH_MANGNYANG"); null when it cannot be one. */
export function contentCode(raw: string): string | null {
  const code = raw.trim().toUpperCase()
  return CODE_NAME.test(code) ? code : null
}

/** An optional count field: '' -> undefined (server default), a whole number in 1..max, else null. */
export function parseCount(raw: string | number | undefined, max: number): number | undefined | null {
  if (raw === undefined) return undefined
  const s = String(raw).trim()
  if (!s) return undefined
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= max ? n : null
}

/** The one place a `gm` message is made: checks the protocol limits the server validator enforces. */
export function gmMessage(cmd: string, args: string[] = []): GmBuild {
  if (!GM_COMMAND.test(cmd)) return fail(t('gm.err.command', { cmd }))
  if (args.length > GM_MAX_ARGS) return fail(t('gm.err.tooManyArgs', { max: GM_MAX_ARGS }))
  for (const a of args) if (codePointLength(a) > GM_MAX_ARG_LENGTH) return fail(t('gm.err.argTooLong', { max: GM_MAX_ARG_LENGTH }))
  const msg: GmMessage = { t: 'gm', cmd, args: [...args] }
  if (utf8Length(JSON.stringify(msg)) > MAX_CLIENT_MESSAGE_BYTES) return fail(t('gm.err.tooLong'))
  return { ok: true, msg }
}

/** Trims and checks a character name as typed or picked (a leading @ is allowed and kept off). */
export function playerName(raw: string): string | null {
  const name = raw.trim().replace(/^@/, '')
  return CHARACTER_NAME.test(name) ? name : null
}

function withPlayer(raw: string, build: (name: string) => GmBuild): GmBuild {
  const name = playerName(raw)
  return name ? build(name) : fail(t('gm.err.player'))
}

/** Parses a coordinate typed in a field ("12.5", "-300", " 4 "). */
export function parseCoord(raw: string): number | null {
  const s = raw.trim()
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null
  const v = Number(s)
  return Number.isFinite(v) && Math.abs(v) <= MAX_COORD ? v : null
}

/** Coordinates go out with 0.1 m precision (the server prints the same). */
export function fmtCoord(v: number): string {
  const r = Math.round(v * 10) / 10
  return (Object.is(r, -0) ? 0 : r).toFixed(1)
}

export const gm = {
  help: (): GmBuild => gmMessage('help'),
  who: (): GmBuild => gmMessage('who'),
  where: (name?: string): GmBuild => (name ? withPlayer(name, n => gmMessage('where', [n])) : gmMessage('where')),
  /** tp with no args: the server answers with the preset list (data.presets). */
  places: (): GmBuild => gmMessage('tp'),
  tpTo(x: number, z: number): GmBuild {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD) return fail(t('gm.err.coords'))
    return gmMessage('tp', [fmtCoord(x), fmtCoord(z)])
  },
  /** tp to fields as typed. */
  tpFields(xs: string, zs: string): GmBuild {
    const x = parseCoord(xs)
    const z = parseCoord(zs)
    if (x === null || z === null) return fail(t('gm.err.coords'))
    return gm.tpTo(x, z)
  },
  tpPlace(name: string): GmBuild {
    const place = name.trim().toLowerCase()
    if (!place || /\s/.test(place) || place.startsWith('@')) return fail(t('gm.err.place'))
    return gmMessage('tp', [place])
  },
  /** tp next to an NPC by (part of) its name: `tp npc <words>`; the server refuses an ambiguous name with the list. */
  tpNpc(name: string): GmBuild {
    const words = name.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return fail(t('gm.err.npc'))
    return gmMessage('tp', ['npc', ...splitWords(words.join(' '), GM_MAX_ARG_LENGTH)])
  },
  /** tp to a player: the @ prefix makes the server skip place names. */
  tpPlayer: (name: string): GmBuild => withPlayer(name, n => gmMessage('tp', [`@${n}`])),
  summon: (name: string): GmBuild => withPlayer(name, n => gmMessage('summon', [n])),
  kick(name: string, reason = ''): GmBuild {
    return withPlayer(name, n => {
      const r = reason.trim().replace(/\s+/g, ' ')
      if (codePointLength(r) > GM_MAX_ARG_LENGTH) return fail(t('gm.err.reasonTooLong', { max: GM_MAX_ARG_LENGTH }))
      return gmMessage('kick', r ? [n, r] : [n])
    })
  },
  notice(text: string): GmBuild {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return fail(t('gm.err.noticeEmpty'))
    if (codePointLength(clean) > GM_NOTICE_MAX) return fail(t('gm.err.noticeLong', { max: GM_NOTICE_MAX }))
    return gmMessage('notice', splitWords(clean, GM_MAX_ARG_LENGTH))
  },
  setLevel(name: string, level: number, cap = DEFAULT_LEVEL_CAP): GmBuild {
    if (!Number.isInteger(level) || level < 1 || level > cap) return fail(t('gm.err.level', { cap }))
    return withPlayer(name, n => gmMessage('setlevel', [n, String(level)]))
  },
  speed(mul: number): GmBuild {
    if (!Number.isFinite(mul) || mul < GM_SPEED_MIN || mul > GM_SPEED_MAX) return fail(t('gm.err.speed', { min: GM_SPEED_MIN, max: GM_SPEED_MAX }))
    return gmMessage('speed', [String(Math.round(mul * 100) / 100)])
  },
  invis: (on: boolean): GmBuild => gmMessage('invis', [on ? 'on' : 'off']),
  /** spawn <mob code> [1..50]: an empty count leaves the server default (1). */
  spawn(code: string, count?: string | number): GmBuild {
    const c = contentCode(code)
    if (!c) return fail(t('gm.err.code', { example: 'MOB_CH_MANGNYANG' }))
    const n = parseCount(count, GM_SPAWN_MAX)
    if (n === null) return fail(t('gm.err.count', { max: GM_SPAWN_MAX }))
    return gmMessage('spawn', n === undefined ? [c] : [c, String(n)])
  },
  /** item <item code> [n]: gold codes (ITEM_ETC_GOLD_*) add n gold. */
  item(code: string, count?: string | number): GmBuild {
    const c = contentCode(code)
    if (!c) return fail(t('gm.err.code', { example: 'ITEM_ETC_HP_POTION_01' }))
    const n = parseCount(count, GM_ITEM_MAX)
    if (n === null) return fail(t('gm.err.count', { max: GM_ITEM_MAX }))
    return gmMessage('item', n === undefined ? [c] : [c, String(n)])
  },
  /** kill [entity id]: no id = the GM's current attack target. */
  kill(id?: string | number): GmBuild {
    const s = id === undefined ? '' : String(id).trim()
    if (!s) return gmMessage('kill')
    if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) return fail(t('gm.err.entity'))
    return gmMessage('kill', [String(Number(s))])
  },
  /** heal [player]: no name = yourself. */
  heal(name = ''): GmBuild {
    return name.trim() ? withPlayer(name, n => gmMessage('heal', [n])) : gmMessage('heal')
  },
}

/** Quick picks of the GM window (codes from the client's own data; the server checks they exist). */
export const GM_QUICK_MOBS: readonly string[] = ['MOB_CH_MANGNYANG', 'MOB_CH_TIGER', 'MOB_CH_TIGERWOMAN']
export const GM_QUICK_ITEMS: readonly { code: string; count: number }[] = [
  { code: 'ITEM_ETC_HP_POTION_01', count: 20 },
  { code: 'ITEM_ETC_MP_POTION_01', count: 20 },
  { code: 'ITEM_ETC_GOLD_01', count: 1000 },
  { code: 'ITEM_ETC_SCROLL_RETURN_01', count: 5 },
  { code: 'ITEM_CH_SWORD_01_A', count: 1 },
  { code: 'ITEM_CH_BLADE_01_A', count: 1 },
  { code: 'ITEM_CH_SPEAR_01_A', count: 1 },
  { code: 'ITEM_CH_TBLADE_01_A', count: 1 },
  { code: 'ITEM_CH_BOW_01_A', count: 1 },
  { code: 'ITEM_ETC_AMMO_ARROW_01', count: 250 },
  { code: 'ITEM_CH_SHIELD_01_A', count: 1 },
  { code: 'ITEM_CH_M_LIGHT_01_HA_A', count: 1 },
  { code: 'ITEM_CH_M_LIGHT_01_BA_A', count: 1 },
  { code: 'ITEM_CH_RING_01_A', count: 2 },
]

/** "MOB_CH_TIGERWOMAN" -> "Tigerwoman" (label when mobs.json has no name). */
export function prettyMob(code: string): string {
  const words = code.replace(/^MOB_(CH_|EU_|OA_)?/, '').split('_').filter(Boolean)
  return words.map(w => (/^\d+$/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ') || code
}

/**
 * Packs words into args of at most `max` code points. The server joins args with single spaces, so
 * the text arrives unchanged (whitespace already collapsed). A word longer than `max` is cut.
 */
export function splitWords(text: string, max: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const word of text.split(' ')) {
    let w = word
    while (codePointLength(w) > max) {
      if (cur) out.push(cur)
      cur = ''
      const cps = [...w]
      out.push(cps.slice(0, max).join(''))
      w = cps.slice(max).join('')
    }
    if (!w) continue
    if (!cur) cur = w
    else if (codePointLength(cur) + 1 + codePointLength(w) <= max) cur += ` ${w}`
    else {
      out.push(cur)
      cur = w
    }
  }
  if (cur) out.push(cur)
  return out
}

/** A chat line that opens the GM window locally instead of being sent ("/gm"). */
export function isGmWindowCommand(text: string): boolean {
  return /^\/gm\s*$/i.test(text.trim())
}

// ---- reading gmResult.data (tolerant: data is `unknown` on the wire) ---------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function readVec3(v: unknown): Vec3 | null {
  return Array.isArray(v) && v.length === 3 && v.every(finite) ? [v[0], v[1], v[2]] : null
}

export function readPlayerInfo(v: unknown): GmPlayerInfo | null {
  if (!isRecord(v) || !finite(v.id) || typeof v.name !== 'string') return null
  const pos = readVec3(v.pos)
  if (!pos) return null
  const rxz = Array.isArray(v.regionXZ) && v.regionXZ.length === 2 && v.regionXZ.every(finite) ? ([v.regionXZ[0], v.regionXZ[1]] as [number, number]) : null
  return {
    id: v.id,
    name: v.name,
    account: typeof v.account === 'string' ? v.account : '',
    role: (ROLES as readonly unknown[]).includes(v.role) ? (v.role as Role) : 'player',
    level: finite(v.level) ? v.level : 1,
    pos,
    region: finite(v.region) ? v.region : null,
    regionXZ: rxz,
    invisible: v.invisible === true,
    speed: finite(v.speed) ? v.speed : 1,
  }
}

/** `who` data: { players: GmPlayerInfo[] }. */
export function readPlayers(data: unknown): GmPlayerInfo[] | null {
  if (!isRecord(data) || !Array.isArray(data.players)) return null
  return data.players.map(readPlayerInfo).filter((p): p is GmPlayerInfo => p !== null)
}

/** `tp` (no args) data: { presets: GmPreset[] }. */
export function readPresets(data: unknown): GmPreset[] | null {
  if (!isRecord(data) || !Array.isArray(data.presets)) return null
  return data.presets
    .filter((p): p is GmPreset => isRecord(p) && typeof p.name === 'string' && finite(p.x) && finite(p.z))
    .map(p => {
      const out: GmPreset = { name: p.name, x: p.x, z: p.z }
      if (typeof p.group === 'string') out.group = p.group
      const aliases = Array.isArray(p.aliases) ? p.aliases.filter((a): a is string => typeof a === 'string') : []
      if (aliases.length) out.aliases = aliases
      return out
    })
}

/** The teleport tab's groups, in order (the server's places.json groups; anything else is Other). */
export const GM_PLACE_GROUPS = ['town', 'fields', 'coast', 'bosses', 'other'] as const
export type GmPlaceGroup = (typeof GM_PLACE_GROUPS)[number]

/**
 * The places matching a search (case-insensitive, in the name or an alias; spaces match '-' and '_'), grouped in
 * GM_PLACE_GROUPS order without empty groups. A preset without a known group (an older server) is Other, except the
 * world spawn (GM_HOME_PRESET, spawn), which is Town.
 */
export function groupPlaces(presets: readonly GmPreset[], query = ''): { group: GmPlaceGroup; places: GmPreset[] }[] {
  const q = query.trim().toLowerCase().replace(/[\s_]+/g, '-')
  const norm = (s: string) => s.toLowerCase().replace(/_/g, '-')
  const hit = (p: GmPreset) => !q || [p.name, ...(p.aliases ?? [])].some(n => norm(n).includes(q))
  const groupOf = (p: GmPreset): GmPlaceGroup => {
    const g = GM_PLACE_GROUPS.find(x => x === p.group)
    if (g) return g
    return p.name === GM_HOME_PRESET || p.name === 'spawn' ? 'town' : 'other'
  }
  return GM_PLACE_GROUPS.map(group => ({ group, places: presets.filter(p => groupOf(p) === group && hit(p)) })).filter(g => g.places.length > 0)
}

/** `speed` / `invis` data. */
export function readSelfFlags(data: unknown): { speed?: number; invisible?: boolean } {
  if (!isRecord(data)) return {}
  const out: { speed?: number; invisible?: boolean } = {}
  if (finite(data.speed)) out.speed = data.speed
  if (typeof data.invisible === 'boolean') out.invisible = data.invisible
  return out
}

/** "168x97" style region text, or '' when the server has no region origin. */
export function regionText(p: GmPlayerInfo): string {
  return p.regionXZ ? `${p.regionXZ[0]}x${p.regionXZ[1]}` : ''
}
