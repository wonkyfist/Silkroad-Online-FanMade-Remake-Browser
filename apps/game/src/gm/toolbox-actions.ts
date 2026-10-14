/**
 * The GM Toolbox tab's action catalogue (pure, no DOM; test/gm-toolbox.test.ts): every one-click action of the
 * in-game GM panel as a server GM command with typed fields. Building goes through gm/commands.ts `gmMessage`, so the
 * protocol limits hold; the server checks everything again (apps/server/src/gm-tools.ts, gm.ts).
 * `confirm` actions are destructive or reach every player: the tab asks for a second click before sending them.
 */
import { GM_MAX_ARG_LENGTH } from '@sro/shared'
import type { StringKey } from '../i18n/index.ts'
import { gmMessage, splitWords, type GmBuild } from './commands.ts'

export type ToolGroup = 'items' | 'inventory' | 'character' | 'world' | 'players' | 'events'
export const TOOL_GROUPS: readonly ToolGroup[] = ['items', 'inventory', 'character', 'world', 'players', 'events']

export type ParamKind = 'text' | 'number' | 'player' | 'item' | 'mob' | 'place' | 'select'

export interface ParamSpec {
  key: string
  kind: ParamKind
  /** Select options (the first is the default unless `def`). */
  options?: readonly string[]
  def?: string
  /** May stay empty (the argument is then left out). */
  optional?: boolean
  /** The rest of the line (split into words, for reasons and announcements). */
  rest?: boolean
}

export interface ToolAction {
  id: string
  group: ToolGroup
  params: readonly ParamSpec[]
  /** Destructive or global: needs a second click. */
  confirm?: boolean
  /** The GM's ground cursor fills `x`/`z` (tp to cursor). */
  cursor?: boolean
  /** The command and its arguments from the field values (trimmed; empty optional ones are ''). */
  build(v: Readonly<Record<string, string>>): { cmd: string; args: string[] }
}

const P = (key: string, kind: ParamKind, more: Partial<ParamSpec> = {}): ParamSpec => ({ key, kind, ...more })
const who = P('player', 'player', { optional: true })
const target = P('player', 'player')
const DEGREES = ['1', '2', '3', '4', '5', '6', '7', '8'] as const
const ARMORS = ['protector', 'armor', 'garment', 'none'] as const
const WEAPONS = ['blade', 'sword', 'spear', 'glaive', 'bow', 'none'] as const
const TIERS = ['normal', 'star', 'moon', 'sun'] as const
const WEATHER = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog', 'snow', 'blizzard'] as const
/** Non-empty values, in order. */
const a = (...xs: (string | undefined)[]): string[] => xs.filter((x): x is string => !!x && x.length > 0)
const self = (v: string | undefined) => v || '.'

export const TOOL_ACTIONS: readonly ToolAction[] = [
  // ---- items ----
  {
    id: 'gearset',
    group: 'items',
    params: [P('degree', 'select', { options: DEGREES, def: '1' }), P('armor', 'select', { options: ARMORS }), P('weapon', 'select', { options: WEAPONS }), P('tier', 'select', { options: TIERS }), P('plus', 'number', { optional: true }), P('acc', 'select', { options: ['yes', 'no'] }), P('wear', 'select', { options: ['no', 'yes'] }), who],
    build: (v) => ({ cmd: 'gearset', args: a(v.degree, v.armor, v.weapon, v.tier !== 'normal' ? v.tier : '', v.plus && v.plus !== '0' ? `+${v.plus}` : '', v.acc === 'no' ? 'noacc' : '', v.wear === 'yes' ? 'wear' : '', v.player) }),
  },
  {
    id: 'weaponkit',
    group: 'items',
    params: [P('weapon', 'select', { options: WEAPONS.slice(0, 5) }), P('degree', 'select', { options: DEGREES, def: '1' }), P('tier', 'select', { options: TIERS }), P('plus', 'number', { optional: true }), who],
    build: (v) => ({ cmd: 'gearset', args: a(v.degree, 'none', v.weapon, v.tier !== 'normal' ? v.tier : '', v.plus && v.plus !== '0' ? `+${v.plus}` : '', 'noacc', v.player) }),
  },
  { id: 'starter', group: 'items', params: [who], build: (v) => ({ cmd: 'starter', args: a(v.player) }) },
  { id: 'potions', group: 'items', params: [who, P('count', 'number', { optional: true, def: '50' })], build: (v) => ({ cmd: 'potions', args: a(self(v.player), v.count) }) },
  { id: 'give', group: 'items', params: [who, P('item', 'item'), P('count', 'number', { optional: true, def: '1' }), P('plus', 'number', { optional: true })], build: (v) => ({ cmd: 'give', args: a(self(v.player), v.item.toUpperCase(), v.count, v.plus && v.plus !== '0' ? `+${v.plus}` : '') }) },
  { id: 'rewardall', group: 'items', confirm: true, params: [P('item', 'item', { def: 'gold' }), P('count', 'number', { def: '1' })], build: (v) => ({ cmd: 'rewardall', args: a(v.item, v.count) }) },
  // ---- inventory ----
  { id: 'inv', group: 'inventory', params: [who], build: (v) => ({ cmd: 'inv', args: a(v.player) }) },
  { id: 'invclear', group: 'inventory', confirm: true, params: [who, P('equipped', 'select', { options: ['keep', 'delete'] })], build: (v) => ({ cmd: 'invclear', args: a(self(v.player), v.equipped === 'delete' ? 'all' : '') }) },
  { id: 'invdrop', group: 'inventory', confirm: true, params: [who], build: (v) => ({ cmd: 'invdrop', args: a(v.player) }) },
  { id: 'invdel', group: 'inventory', confirm: true, params: [who, P('slot', 'number')], build: (v) => ({ cmd: 'invdel', args: a(self(v.player), v.slot) }) },
  { id: 'repair', group: 'inventory', params: [who], build: (v) => ({ cmd: 'repair', args: a(v.player) }) },
  { id: 'sort', group: 'inventory', params: [who], build: (v) => ({ cmd: 'sort', args: a(v.player) }) },
  { id: 'gold', group: 'inventory', params: [who, P('amount', 'text', { def: '+1000000' })], build: (v) => ({ cmd: 'gold', args: a(self(v.player), v.amount) }) },
  // ---- character ----
  { id: 'setlevel', group: 'character', params: [target, P('level', 'number')], build: (v) => ({ cmd: 'setlevel', args: a(v.player, v.level) }) },
  { id: 'skillsp', group: 'character', params: [P('count', 'number', { def: '10000' })], build: (v) => ({ cmd: 'skill', args: a('sp', v.count) }) },
  { id: 'skillall', group: 'character', params: [P('mastery', 'text', { optional: true })], build: (v) => ({ cmd: 'skill', args: a('all', v.mastery) }) },
  { id: 'skillreset', group: 'character', confirm: true, params: [], build: () => ({ cmd: 'skill', args: ['reset'] }) },
  { id: 'cooldowns', group: 'character', params: [], build: () => ({ cmd: 'skill', args: ['cooldown'] }) },
  { id: 'heal', group: 'character', params: [who], build: (v) => ({ cmd: 'heal', args: a(v.player) }) },
  { id: 'berserk', group: 'character', params: [], build: () => ({ cmd: 'hwan', args: ['5'] }) },
  { id: 'invis', group: 'character', params: [P('state', 'select', { options: ['on', 'off'] })], build: (v) => ({ cmd: 'invis', args: a(v.state) }) },
  { id: 'god', group: 'character', params: [P('state', 'select', { options: ['on', 'off'] })], build: (v) => ({ cmd: 'god', args: a(v.state) }) },
  { id: 'speed', group: 'character', params: [P('mul', 'number', { def: '2' })], build: (v) => ({ cmd: 'speed', args: a(v.mul) }) },
  { id: 'tpplace', group: 'character', params: [P('place', 'place')], build: (v) => ({ cmd: 'tp', args: a(v.place.toLowerCase()) }) },
  { id: 'tpplayer', group: 'character', params: [target], build: (v) => ({ cmd: 'tp', args: a(`@${v.player.replace(/^@/, '')}`) }) },
  { id: 'tpcursor', group: 'character', cursor: true, params: [], build: (v) => ({ cmd: 'tp', args: a(v.x, v.z) }) },
  { id: 'summon', group: 'character', params: [target], build: (v) => ({ cmd: 'summon', args: a(v.player) }) },
  // ---- world ----
  { id: 'weather', group: 'world', params: [P('state', 'select', { options: WEATHER }), P('minutes', 'number', { optional: true, def: '30' })], build: (v) => ({ cmd: 'weather', args: a(v.state, v.minutes) }) },
  { id: 'weatherauto', group: 'world', params: [], build: () => ({ cmd: 'weather', args: ['auto'] }) },
  { id: 'lightning', group: 'world', params: [P('where', 'select', { options: ['here', 'sky', 'tree'] })], build: (v) => ({ cmd: 'weather', args: a('strike', v.where) }) },
  { id: 'stormstart', group: 'world', confirm: true, params: [P('minutes', 'number', { optional: true, def: '10' })], build: (v) => ({ cmd: 'storm', args: a('start', v.minutes) }) },
  { id: 'stormstop', group: 'world', params: [], build: () => ({ cmd: 'storm', args: ['stop'] }) },
  { id: 'tornado', group: 'world', confirm: true, params: [], build: () => ({ cmd: 'storm', args: ['tornado', 'here'] }) },
  { id: 'time', group: 'world', params: [P('hhmm', 'text', { def: '12:00' })], build: (v) => ({ cmd: 'time', args: a(v.hhmm) }) },
  { id: 'timefreeze', group: 'world', params: [P('state', 'select', { options: ['freeze', 'resume', 'reset'] })], build: (v) => ({ cmd: 'time', args: a(v.state) }) },
  { id: 'winter', group: 'world', confirm: true, params: [P('state', 'select', { options: ['on', 'off'] })], build: (v) => ({ cmd: 'winter', args: a('preview', v.state) }) },
  { id: 'spawn', group: 'world', params: [P('mob', 'mob'), P('count', 'number', { optional: true, def: '1' })], build: (v) => ({ cmd: 'spawn', args: a(v.mob.toUpperCase(), v.count) }) },
  { id: 'unique', group: 'world', params: [P('name', 'text')], build: (v) => ({ cmd: 'unique', args: a('spawn', v.name, 'here') }) },
  { id: 'yeti', group: 'world', params: [], build: () => ({ cmd: 'yeti', args: ['spawn', 'here'] }) },
  { id: 'killall', group: 'world', confirm: true, params: [P('radius', 'number', { optional: true, def: '30' }), P('uniques', 'select', { options: ['no', 'yes'] })], build: (v) => ({ cmd: 'killall', args: a(v.radius, v.uniques === 'yes' ? 'all' : '') }) },
  { id: 'killtarget', group: 'world', params: [], build: () => ({ cmd: 'kill', args: [] }) },
  { id: 'respawn', group: 'world', params: [], build: () => ({ cmd: 'respawn', args: [] }) },
  { id: 'siegestart', group: 'world', confirm: true, params: [P('minutes', 'number', { optional: true, def: '5' })], build: (v) => ({ cmd: 'siege', args: a('start', v.minutes) }) },
  { id: 'siegestop', group: 'world', confirm: true, params: [], build: () => ({ cmd: 'siege', args: ['stop'] }) },
  { id: 'caravan', group: 'world', confirm: true, params: [], build: () => ({ cmd: 'caravan', args: ['start'] }) },
  // ---- players and moderation ----
  { id: 'who', group: 'players', params: [], build: () => ({ cmd: 'who', args: [] }) },
  { id: 'where', group: 'players', params: [target], build: (v) => ({ cmd: 'where', args: a(v.player) }) },
  { id: 'warn', group: 'players', params: [target, P('text', 'text', { rest: true })], build: (v) => ({ cmd: 'warn', args: a(v.player, ...words(v.text)) }) },
  { id: 'mute', group: 'players', params: [target, P('minutes', 'number', { def: '10' }), P('reason', 'text', { optional: true, rest: true })], build: (v) => ({ cmd: 'mute', args: a(v.player, v.minutes, ...words(v.reason)) }) },
  { id: 'unmute', group: 'players', params: [target], build: (v) => ({ cmd: 'unmute', args: a(v.player) }) },
  { id: 'chatlog', group: 'players', params: [target], build: (v) => ({ cmd: 'chatlog', args: a(v.player) }) },
  { id: 'jail', group: 'players', confirm: true, params: [target, P('minutes', 'number', { def: '15' }), P('reason', 'text', { optional: true, rest: true })], build: (v) => ({ cmd: 'law', args: a('jail', v.player, v.minutes, ...words(v.reason)) }) },
  { id: 'release', group: 'players', params: [target], build: (v) => ({ cmd: 'law', args: a('release', v.player) }) },
  { id: 'kick', group: 'players', confirm: true, params: [target, P('reason', 'text', { optional: true, rest: true })], build: (v) => ({ cmd: 'kick', args: a(v.player, ...words(v.reason)) }) },
  { id: 'ban', group: 'players', confirm: true, params: [target, P('reason', 'text', { rest: true })], build: (v) => ({ cmd: 'ban', args: a(v.player, ...words(v.reason)) }) },
  { id: 'unban', group: 'players', params: [target], build: (v) => ({ cmd: 'unban', args: a(v.player) }) },
  { id: 'announce', group: 'players', confirm: true, params: [P('text', 'text', { rest: true })], build: (v) => ({ cmd: 'announce', args: words(v.text) }) },
  // ---- events ----
  { id: 'boost', group: 'events', confirm: true, params: [P('kind', 'select', { options: ['exp', 'drop', 'both'] }), P('mul', 'number', { def: '2' }), P('minutes', 'number', { def: '30' })], build: (v) => ({ cmd: 'boost', args: a(v.kind, v.mul, v.minutes) }) },
  { id: 'boostoff', group: 'events', confirm: true, params: [], build: () => ({ cmd: 'boost', args: ['off'] }) },
  { id: 'booststatus', group: 'events', params: [], build: () => ({ cmd: 'boost', args: [] }) },
  { id: 'hideseek', group: 'events', confirm: true, params: [P('hint', 'text', { optional: true, rest: true })], build: (v) => ({ cmd: 'event', args: a('hideseek', ...words(v.hint)) }) },
  { id: 'bossrush', group: 'events', confirm: true, params: [P('mob', 'mob'), P('count', 'number', { optional: true, def: '5' })], build: (v) => ({ cmd: 'event', args: a('bossrush', v.mob.toUpperCase(), v.count) }) },
  { id: 'arena', group: 'events', confirm: true, params: [P('minutes', 'number', { optional: true, def: '5' })], build: (v) => ({ cmd: 'event', args: a('arena', v.minutes) }) },
  { id: 'eventend', group: 'events', confirm: true, params: [P('text', 'text', { optional: true, rest: true })], build: (v) => ({ cmd: 'event', args: a('end', ...words(v.text)) }) },
]

function words(text: string | undefined): string[] {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean ? splitWords(clean, GM_MAX_ARG_LENGTH) : []
}

/** Builds an action with its field values; a missing required field fails before anything is sent. */
export function buildAction(action: ToolAction, values: Readonly<Record<string, string>>, missing: (key: string) => string): GmBuild {
  const v: Record<string, string> = {}
  for (const p of action.params) {
    const raw = (values[p.key] ?? '').trim()
    const val = raw || (p.kind === 'select' ? (p.def ?? p.options?.[0] ?? '') : '')
    if (!val && !p.optional) return { ok: false, error: missing(p.key) }
    v[p.key] = val
  }
  for (const k of ['x', 'z']) if (values[k] !== undefined) v[k] = values[k]!
  const { cmd, args } = action.build(v)
  return gmMessage(cmd, args)
}

/** Splits a typed command line (`/gearset 3 armor blade`) into a gm message. */
export function buildLine(line: string): GmBuild {
  const tokens = line.trim().replace(/^\//, '').split(/\s+/).filter(Boolean)
  const cmd = (tokens.shift() ?? '').toLowerCase()
  return gmMessage(cmd, tokens.length > 8 ? [...tokens.slice(0, 7), tokens.slice(7).join(' ')] : tokens)
}

/** Whether an action matches a search (its label, its command or its id). */
export function matches(action: ToolAction, label: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return label.toLowerCase().includes(q) || action.id.includes(q) || action.build(Object.fromEntries(action.params.map((p) => [p.key, p.def ?? p.options?.[0] ?? '']))).cmd.includes(q)
}

/** Keeps a most-recent-first list without duplicates, at most `max`. */
export function pushRecent(list: readonly string[], line: string, max = 15): string[] {
  return [line, ...list.filter((x) => x !== line)].slice(0, max)
}

export const actionLabel = (id: string): StringKey => `gm.tools.a.${id}` as StringKey
export const paramLabel = (key: string): StringKey => `gm.tools.p.${key}` as StringKey
export const groupLabel = (g: ToolGroup | 'fav' | 'recent' | 'all'): StringKey => `gm.tools.g.${g}` as StringKey
