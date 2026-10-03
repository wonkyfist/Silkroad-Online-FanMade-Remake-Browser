/**
 * Quest content types and their validator (docs/QUESTS.md §1.2, §6.1). Environment-neutral: the server
 * loads quest files with it, the GM editors validate edits with it, and the client reads the catalog types.
 *
 * Quest files live in `content/quests/*.json` (repo) and `DATA_DIR/content/quests/<QUEST_ID>.json` (GM overrides).
 * They are authored content: original writing plus CodeName128 ids, never retail data.
 */

import type { ArmorType } from './content.ts'
import { MAX_GOLD, MAX_ITEM_COUNT, MAX_NPC_DIALOG_LINE, type StarterOutfit } from './protocol.ts'

export const QUEST_FILE_SCHEMA = 1
/** Quest ids: JG_001. Quest items: QITEM_*. Locations: LOC_*. Authored NPCs: NPCX_*. Objective ids: lower-case. */
export const QUEST_ID = /^[A-Z][A-Z0-9_]{1,63}$/
export const QUEST_ITEM_CODE = /^QITEM_[A-Z0-9_]{1,64}$/
export const QUEST_LOCATION_ID = /^LOC_[A-Z0-9_]{1,64}$/
export const AUTHORED_NPC_CODE = /^NPCX_[A-Z0-9_]{1,64}$/
export const OBJECTIVE_ID = /^[a-z][a-z0-9_]{0,23}$/
export const MAX_ACTIVE_QUESTS = 10
export const MAX_QUEST_OBJECTIVES = 8
export const MAX_REWARD_CHOICES = 8
export const MAX_QUEST_TEXT = 1200
export const MAX_QUEST_TITLE = 60

// ---- further bounds (W4-P; not in the §6.1 list, same rules) ----
/** Quest file id: the questline file stem ('jangan') or, for override files, the quest id. */
export const QUEST_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Code points: quest summary (one log line), objective label, quest item description, file notes. */
export const MAX_QUEST_SUMMARY = 300
export const MAX_OBJECTIVE_LABEL = 100
export const MAX_QUEST_ITEM_DESCRIPTION = 300
export const MAX_QUEST_NOTES = 4000
/** Quest bag: distinct quest item codes one quest may use, and the default stack of a quest item. */
export const MAX_QUEST_BAG_CODES = 8
export const DEFAULT_QUEST_ITEM_STACK = 99
export const MAX_QUEST_ITEM_STACK = 9999
/** Plain reward items per quest (`rewards.items`). */
export const MAX_REWARD_ITEMS = 8
/** Mob codes per kill objective, sources per collect objective, `requires.quests` entries, `giveOnAccept` grants. */
export const MAX_OBJECTIVE_MOBS = 8
export const MAX_COLLECT_SOURCES = 8
export const MAX_QUEST_REQUIRES = 16
export const MAX_QUEST_GRANTS = 8
/** Kills / items / hand-ins one objective may ask for. */
export const MAX_OBJECTIVE_COUNT = 1000
/** Mobs one encounter spawns. */
export const MAX_ENCOUNTER_MOBS = 10
/** Location radius, metres. */
export const MIN_LOCATION_RADIUS = 5
export const MAX_LOCATION_RADIUS = 200
/** Records per quest file. */
export const MAX_FILE_QUESTS = 1000
export const MAX_FILE_ITEMS = 256
export const MAX_FILE_LOCATIONS = 256
/** Highest quest level without refs (with refs: refs.levelCap). */
export const MAX_QUEST_LEVEL = 300
/** Largest `rewards.exp`. */
export const MAX_QUEST_EXP = 1_000_000_000
/** Largest repeat cooldown: 30 days. */
export const MAX_QUEST_COOLDOWN_SEC = 30 * 86_400
/** Wave 11 (docs/UNIQUES.md §3.10, lane U-Q): dialog lines per file, their text bound, their id rule. */
export const MAX_FILE_LINES = 64
export const MAX_QUEST_LINE_TEXT = MAX_NPC_DIALOG_LINE
export const QUEST_LINE_ID = /^[a-z][a-z0-9_]{0,47}$/

export type QuestKind = 'main' | 'side' | 'repeatable'
export const QUEST_KINDS: readonly QuestKind[] = ['main', 'side', 'repeatable']
export type ArmorClassToken = 'CLOTHES' | 'LIGHT' | 'HEAVY'
export const ARMOR_CLASS_TOKENS: readonly ArmorClassToken[] = ['CLOTHES', 'LIGHT', 'HEAVY']

export interface QuestFile {
  schema: typeof QUEST_FILE_SCHEMA
  kind: 'quests'
  /** Questline id = file stem ('jangan'); override files use the quest id. */
  id: string
  title: string
  world: string
  notes?: string
  items: QuestItemDef[]
  locations: QuestLocation[]
  quests: QuestDef[]
  /** Wave 11 (lane U-Q): conditional lines NPCs add to their greeting (absent = none). */
  lines?: QuestDialogLine[]
  /** Server-assigned on override files. */
  rev?: number
  updatedAt?: string
}

/**
 * A line an NPC adds to its greeting while a server fact holds (docs/UNIQUES.md §3.10, lane U-Q): the quest engine's
 * condition list is QUEST_LINE_CONDITIONS. `{area}` in `text` becomes the fact's area name; where the fact has no area
 * name, `textNoArea` is shown instead (absent = the line is skipped).
 */
export interface QuestDialogLine {
  id: string
  /** NPC identity code (NpcDef.code or NPCX_*). */
  npc: string
  text: string
  textNoArea?: string
  when: QuestLineCondition
}

/** `uniqueAlive`: the field unique of this mob code is alive (uniques module; UNIQUES=off = never). */
export type QuestLineCondition = { uniqueAlive: string }
export type QuestLineConditionKind = keyof QuestLineCondition
export const QUEST_LINE_CONDITIONS: readonly QuestLineConditionKind[] = ['uniqueAlive']

/** A line's text with `{area}` filled in; null when there is no area name and no `textNoArea`. */
export function questLineText(line: QuestDialogLine, area: string): string | null {
  if (line.text.includes('{area}')) {
    if (area.trim() === '') return line.textNoArea ?? null
    return line.text.replaceAll('{area}', area)
  }
  return line.text
}

export interface QuestItemDef {
  code: string
  name: string
  description?: string
  /** A client item code whose icon is borrowed (ITEM_QNO_CH_*); absent = generic quest icon. */
  iconItem?: string
  /** Default 99. */
  maxStack?: number
}

export interface QuestLocation {
  id: string
  name: string
  /** glTF metres, world manifest frame. */
  x: number
  z: number
  /** Metres, 5..200. */
  radius: number
}

export interface QuestDef {
  id: string
  title: string
  chapter?: string
  kind: QuestKind
  /** Offered from this character level (1..LEVEL_CAP). */
  level: number
  /** Not offered above this level. */
  maxLevel?: number
  /** NPC identity codes (NpcDef.code or NPCX_*). */
  giver: string
  turnIn: string
  requires?: { quests?: string[] }
  /** Only for kind 'repeatable'. */
  repeat?: { reset: 'daily' } | { cooldownSec: number }
  /** Group recommended; also shares useItem completion with party members within 60 m. */
  party?: boolean
  summary: string
  giveOnAccept?: QuestItemGrant[]
  /** 0..MAX_QUEST_OBJECTIVES; [] = report to turnIn. */
  objectives: QuestObjective[]
  rewards: QuestRewards
  dialog: QuestDialog
  disabled?: boolean
  /** Server-assigned edit revision. */
  rev?: number
}

export interface QuestItemGrant {
  item: string
  count: number
}

interface ObjectiveBase {
  id: string
  /** Log/tracker line; default generated from the type (i18n quest.objective.*). */
  label?: string
  /** Location id drawn on the minimap as a hint. */
  hint?: string
  /** Objective id that must be complete before this one counts. */
  after?: string
}

export type QuestObjective =
  | (ObjectiveBase & { type: 'kill'; mobs: string[]; count: number })
  | (ObjectiveBase & { type: 'collect'; item: string; count: number; from: { mob: string; chance: number }[] })
  | (ObjectiveBase & { type: 'talk'; npc: string; text: string })
  | (ObjectiveBase & { type: 'deliver'; npc: string; item: string; count: number; text: string })
  | (ObjectiveBase & { type: 'have'; item: string; count: number; consume?: boolean })
  | (ObjectiveBase & { type: 'reach'; location: string })
  | (ObjectiveBase & { type: 'useItem'; item: string; location: string; consume?: boolean; text?: string; encounter?: QuestEncounter })

export type QuestObjectiveType = QuestObjective['type']
export const QUEST_OBJECTIVE_TYPES: readonly QuestObjectiveType[] = ['kill', 'collect', 'talk', 'deliver', 'have', 'reach', 'useItem']

export interface QuestEncounter {
  mob: string
  count: number
  /** Multipliers over MobDef × VARIANT_RULES (defaults 1). */
  hpMul?: number
  expMul?: number
  attackMul?: number
  /** Unkilled encounter mobs despawn after this. */
  despawnSec: number
  /** Before the item can summon again after a despawn (default 60). */
  cooldownSec?: number
}

export interface QuestRewards {
  exp: number
  /** Extra EXP: this percent of levels[character level].exp at turn-in (repeatables). */
  expPctOfLevel?: number
  /** Skill points (granted as sp × 400 SP-EXP). */
  sp: number
  gold: number
  items?: RewardItem[]
  /** Pick exactly one (questTurnIn.choice). */
  choice?: RewardItem[]
}

export interface RewardItem {
  /** ItemDef code; may contain {G} and {ARMOR} (expandRewardCode). */
  item: string
  /** Default 1. */
  count?: number
}

export interface QuestDialog {
  offer: string
  progress: string
  complete: string
}

export interface QuestRefs {
  mobs: ReadonlySet<string>
  items: ReadonlySet<string>
  npcs: ReadonlySet<string>
  levelCap: number
  /** Optional (W4-P): mob level and uniqueness, for the "mob at most 3 levels above the quest" warning. */
  mobInfo?: (code: string) => { level: number; unique: boolean } | undefined
  /** Optional (W4-P): ItemDef.reqLevel, for the "reward reqLevel at most quest level + 2" warning. */
  itemReqLevel?: (code: string) => number | undefined
}

export interface QuestIssue {
  path: string
  message: string
  severity: 'error' | 'warning'
}

/** Ids defined outside the file being checked (other quest files: the repo line an override builds on). */
export interface QuestScope {
  items: ReadonlySet<string>
  locations: ReadonlySet<string>
  quests: ReadonlySet<string>
}

/** Goal count of an objective: kill/collect/deliver/have = `count`; talk/reach/useItem = 1. */
export function objectiveGoal(o: QuestObjective): number {
  return o.type === 'kill' || o.type === 'collect' || o.type === 'deliver' || o.type === 'have' ? o.count : 1
}

// ---- reward codes, EXP ------------------------------------------------------------------------------

const TOKEN = /\{([A-Z]+)\}/g
const REWARD_TOKENS = new Set(['G', 'ARMOR'])

/** 'ITEM_CH_{G}_{ARMOR}_02_BA_A' -> 'ITEM_CH_W_LIGHT_02_BA_A'. */
export function expandRewardCode(code: string, who: { gender: 'male' | 'female'; armor: ArmorClassToken }): string {
  return code.replaceAll('{G}', who.gender === 'female' ? 'W' : 'M').replaceAll('{ARMOR}', who.armor)
}

/** Every expansion of a templated code (6 for {G}+{ARMOR}), for validation. */
export function rewardCodeVariants(code: string): string[] {
  const out = new Set<string>()
  for (const gender of code.includes('{G}') ? (['male', 'female'] as const) : (['male'] as const)) {
    for (const armor of code.includes('{ARMOR}') ? ARMOR_CLASS_TOKENS : (['CLOTHES'] as const)) out.add(expandRewardCode(code, { gender, armor }))
  }
  return [...out]
}

/** EXP a turn-in gives at `level`: rewards.exp + expPctOfLevel % of expToNext(level), rounded down. */
export function questRewardExp(r: QuestRewards, level: number, expToNext: (level: number) => number): number {
  const pct = r.expPctOfLevel ?? 0
  const extra = pct > 0 ? Math.floor((pct / 100) * Math.max(0, expToNext(level) || 0)) : 0
  return Math.max(0, Math.floor(r.exp)) + extra
}

/** {G} source: CHAR_CH_WOMAN_* (and any *_WOMAN_* model) is female. */
export function genderOfModel(model: string): 'male' | 'female' {
  return model.includes('_WOMAN_') ? 'female' : 'male'
}

/** {ARMOR} source: the equipped chest item's armorType, else the creation outfit, else CLOTHES. */
export function armorClassToken(chest: ArmorType | undefined, outfit?: StarterOutfit): ArmorClassToken {
  if (chest === 'armor') return 'HEAVY'
  if (chest === 'protector') return 'LIGHT'
  if (chest === 'garment') return 'CLOTHES'
  return outfit === 'heavy' ? 'HEAVY' : outfit === 'light' ? 'LIGHT' : 'CLOTHES'
}

// ---- text -----------------------------------------------------------------------------------------

/** C0/C1 controls except '\n', and bidi controls (quest text renders as plain text; newlines split paragraphs). */
const UNSAFE_TEXT = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g

/** Strips control and bidi characters (keeps '\n'). */
export function cleanQuestText(s: string): string {
  return s.replace(UNSAFE_TEXT, '')
}

function codePoints(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

// ---- validation -----------------------------------------------------------------------------------

/** CodeName128 ids (same rule as validate.ts CODE_NAME; not imported to keep this module free of import cycles). */
const CODE = /^[A-Z0-9_]{1,128}$/
const REWARD_CODE = /^[A-Z0-9_{}]{1,128}$/
const WORLD_ID = /^[a-z0-9_-]{1,64}$/
const MAX_COORD = 1_000_000

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function at(base: string, k: string | number): string {
  if (typeof k === 'number') return `${base}[${k}]`
  return base ? `${base}.${k}` : k
}

/** Collects issues; every reader returns undefined (and records an error) when the value is unusable. */
class Checker {
  readonly issues: QuestIssue[] = []
  errors = 0

  error(path: string, message: string): void {
    this.issues.push({ path, message, severity: 'error' })
    this.errors++
  }

  warn(path: string, message: string): void {
    this.issues.push({ path, message, severity: 'warning' })
  }

  keys(o: Obj, path: string, known: readonly string[]): void {
    for (const k of Object.keys(o)) if (!known.includes(k)) this.warn(at(path, k), 'unknown field (ignored)')
  }

  missing(o: Obj, k: string, path: string, required: boolean): boolean {
    if (o[k] !== undefined) return false
    if (required) this.error(at(path, k), 'missing')
    return true
  }

  text(o: Obj, k: string, path: string, max: number, required = true): string | undefined {
    if (this.missing(o, k, path, required)) return undefined
    const v = o[k]
    const p = at(path, k)
    if (typeof v !== 'string') return void this.error(p, 'must be a string')
    const s = cleanQuestText(v)
    if (s !== v) this.warn(p, 'control or bidi characters removed')
    if (s.trim() === '') return void this.error(p, 'must not be empty')
    if (codePoints(s) > max) return void this.error(p, `at most ${max} characters`)
    return s
  }

  match(o: Obj, k: string, path: string, re: RegExp, what: string, required = true): string | undefined {
    if (this.missing(o, k, path, required)) return undefined
    const v = o[k]
    if (typeof v !== 'string' || !re.test(v)) return void this.error(at(path, k), `must be ${what}`)
    return v
  }

  num(o: Obj, k: string, path: string, min: number, max: number, required = true, integer = false): number | undefined {
    if (this.missing(o, k, path, required)) return undefined
    const v = o[k]
    const p = at(path, k)
    if (typeof v !== 'number' || !Number.isFinite(v)) return void this.error(p, 'must be a number')
    if (integer && !Number.isInteger(v)) return void this.error(p, 'must be an integer')
    if (v < min || v > max) return void this.error(p, `must be ${min}..${max}`)
    return v
  }

  int(o: Obj, k: string, path: string, min: number, max: number, required = true): number | undefined {
    return this.num(o, k, path, min, max, required, true)
  }

  bool(o: Obj, k: string, path: string): boolean | undefined {
    if (o[k] === undefined) return undefined
    if (typeof o[k] !== 'boolean') return void this.error(at(path, k), 'must be true or false')
    return o[k] as boolean
  }

  array(o: Obj, k: string, path: string, max: number, required = true): unknown[] | undefined {
    if (this.missing(o, k, path, required)) return undefined
    const v = o[k]
    if (!Array.isArray(v)) return void this.error(at(path, k), 'must be an array')
    if (v.length > max) return void this.error(at(path, k), `at most ${max} entries`)
    return v
  }

  obj(v: unknown, path: string): Obj | undefined {
    if (!isObj(v)) return void this.error(path, 'must be an object')
    return v
  }
}

/** What a quest may reference, plus quest item stacks (for count bounds). */
interface Ctx {
  scope: QuestScope
  stacks: ReadonlyMap<string, number>
  refs?: QuestRefs
}

function mobCode(c: Checker, o: Obj, k: string, path: string, ctx: Ctx): string | undefined {
  const code = c.match(o, k, path, CODE, 'a mob code (CodeName128)')
  if (code !== undefined && ctx.refs && !ctx.refs.mobs.has(code)) c.error(at(path, k), `unknown mob ${code}`)
  return code
}

function npcCode(c: Checker, o: Obj, k: string, path: string, ctx: Ctx): string | undefined {
  const code = c.match(o, k, path, CODE, 'an NPC code (NPC_* or NPCX_*)')
  if (code !== undefined && ctx.refs && !ctx.refs.npcs.has(code)) {
    if (AUTHORED_NPC_CODE.test(code)) c.warn(at(path, k), `authored NPC ${code} does not exist (the quest cannot be offered until it does)`)
    else c.error(at(path, k), `unknown NPC ${code}`)
  }
  return code
}

function questItem(c: Checker, o: Obj, k: string, path: string, ctx: Ctx): string | undefined {
  const code = c.match(o, k, path, QUEST_ITEM_CODE, 'a quest item code (QITEM_*)')
  if (code !== undefined && !ctx.scope.items.has(code)) c.error(at(path, k), `unknown quest item ${code}`)
  return code
}

/** An ItemDef code (checked against refs.items), never a quest item. */
function itemCode(c: Checker, o: Obj, k: string, path: string, ctx: Ctx): string | undefined {
  const code = c.match(o, k, path, CODE, 'an item code (CodeName128)')
  if (code === undefined) return undefined
  if (QUEST_ITEM_CODE.test(code)) return void c.error(at(path, k), 'must be a regular item, not a quest item')
  if (ctx.refs && !ctx.refs.items.has(code)) c.error(at(path, k), `unknown item ${code}`)
  return code
}

function locationId(c: Checker, o: Obj, k: string, path: string, ctx: Ctx, required = true): string | undefined {
  const id = c.match(o, k, path, QUEST_LOCATION_ID, 'a location id (LOC_*)', required)
  if (id !== undefined && !ctx.scope.locations.has(id)) c.error(at(path, k), `unknown location ${id}`)
  return id
}

function stackOf(ctx: Ctx, item: string | undefined): number {
  return (item && ctx.stacks.get(item)) || DEFAULT_QUEST_ITEM_STACK
}

const BASE_KEYS = ['id', 'type', 'label', 'hint', 'after'] as const
const TYPE_KEYS: Record<QuestObjectiveType, readonly string[]> = {
  kill: ['mobs', 'count'],
  collect: ['item', 'count', 'from'],
  talk: ['npc', 'text'],
  deliver: ['npc', 'item', 'count', 'text'],
  have: ['item', 'count', 'consume'],
  reach: ['location'],
  useItem: ['item', 'location', 'consume', 'text', 'encounter'],
}

function objective(c: Checker, v: unknown, p: string, ctx: Ctx, earlier: ReadonlySet<string>): QuestObjective | undefined {
  const o = c.obj(v, p)
  if (!o) return undefined
  const type = o.type
  if (typeof type !== 'string' || !(QUEST_OBJECTIVE_TYPES as readonly string[]).includes(type)) {
    return void c.error(at(p, 'type'), `must be one of ${QUEST_OBJECTIVE_TYPES.join(', ')}`)
  }
  const t = type as QuestObjectiveType
  c.keys(o, p, [...BASE_KEYS, ...TYPE_KEYS[t]])
  const id = c.match(o, 'id', p, OBJECTIVE_ID, 'a lower-case objective id (a-z, 0-9, _; at most 24)')
  const label = c.text(o, 'label', p, MAX_OBJECTIVE_LABEL, false)
  const hint = locationId(c, o, 'hint', p, ctx, false)
  let after: string | undefined
  if (o.after !== undefined) {
    after = c.match(o, 'after', p, OBJECTIVE_ID, 'an objective id')
    if (after !== undefined && !earlier.has(after)) c.error(at(p, 'after'), `must name an earlier objective of this quest (${after})`)
  }
  const base = { id: id ?? '', ...(label !== undefined ? { label } : {}), ...(hint !== undefined ? { hint } : {}), ...(after !== undefined ? { after } : {}) }
  switch (t) {
    case 'kill': {
      const list = c.array(o, 'mobs', p, MAX_OBJECTIVE_MOBS) ?? []
      if (Array.isArray(o.mobs) && list.length === 0) c.error(at(p, 'mobs'), 'needs at least one mob')
      const mobs: string[] = []
      list.forEach((m, i) => {
        const mp = at(at(p, 'mobs'), i)
        if (typeof m !== 'string' || !CODE.test(m)) return void c.error(mp, 'must be a mob code (CodeName128)')
        if (ctx.refs && !ctx.refs.mobs.has(m)) c.error(mp, `unknown mob ${m}`)
        if (mobs.includes(m)) c.error(mp, `duplicate mob ${m}`)
        else mobs.push(m)
      })
      return { ...base, type: 'kill', mobs, count: c.int(o, 'count', p, 1, MAX_OBJECTIVE_COUNT) ?? 1 }
    }
    case 'collect': {
      const item = questItem(c, o, 'item', p, ctx)
      const count = c.int(o, 'count', p, 1, stackOf(ctx, item)) ?? 1
      const list = c.array(o, 'from', p, MAX_COLLECT_SOURCES) ?? []
      if (Array.isArray(o.from) && list.length === 0) c.error(at(p, 'from'), 'needs at least one source mob')
      const from: { mob: string; chance: number }[] = []
      list.forEach((s, i) => {
        const sp = at(at(p, 'from'), i)
        const so = c.obj(s, sp)
        if (!so) return
        c.keys(so, sp, ['mob', 'chance'])
        const mob = mobCode(c, so, 'mob', sp, ctx)
        const chance = c.num(so, 'chance', sp, 0, 1)
        if (chance === 0) c.error(at(sp, 'chance'), 'must be above 0')
        if (mob === undefined || chance === undefined) return
        if (from.some((f) => f.mob === mob)) c.error(at(sp, 'mob'), `duplicate source ${mob}`)
        else from.push({ mob, chance })
      })
      return { ...base, type: 'collect', item: item ?? '', count, from }
    }
    case 'talk':
      return { ...base, type: 'talk', npc: npcCode(c, o, 'npc', p, ctx) ?? '', text: c.text(o, 'text', p, MAX_QUEST_TEXT) ?? '' }
    case 'deliver': {
      const npc = npcCode(c, o, 'npc', p, ctx) ?? ''
      const raw = o.item
      const item = typeof raw === 'string' && QUEST_ITEM_CODE.test(raw) ? questItem(c, o, 'item', p, ctx) : itemCode(c, o, 'item', p, ctx)
      const max = item && QUEST_ITEM_CODE.test(item) ? stackOf(ctx, item) : MAX_ITEM_COUNT
      const count = c.int(o, 'count', p, 1, max) ?? 1
      return { ...base, type: 'deliver', npc, item: item ?? '', count, text: c.text(o, 'text', p, MAX_QUEST_TEXT) ?? '' }
    }
    case 'have': {
      const item = itemCode(c, o, 'item', p, ctx) ?? ''
      const count = c.int(o, 'count', p, 1, MAX_ITEM_COUNT) ?? 1
      const consume = c.bool(o, 'consume', p)
      return { ...base, type: 'have', item, count, ...(consume !== undefined ? { consume } : {}) }
    }
    case 'reach':
      return { ...base, type: 'reach', location: locationId(c, o, 'location', p, ctx) ?? '' }
    case 'useItem': {
      const item = questItem(c, o, 'item', p, ctx) ?? ''
      const location = locationId(c, o, 'location', p, ctx) ?? ''
      const consume = c.bool(o, 'consume', p)
      const text = c.text(o, 'text', p, MAX_QUEST_TEXT, false)
      const encounter = o.encounter !== undefined ? questEncounter(c, o.encounter, at(p, 'encounter'), ctx) : undefined
      return {
        ...base, type: 'useItem', item, location,
        ...(consume !== undefined ? { consume } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(encounter !== undefined ? { encounter } : {}),
      }
    }
  }
}

function questEncounter(c: Checker, v: unknown, p: string, ctx: Ctx): QuestEncounter | undefined {
  const o = c.obj(v, p)
  if (!o) return undefined
  c.keys(o, p, ['mob', 'count', 'hpMul', 'expMul', 'attackMul', 'despawnSec', 'cooldownSec'])
  const mob = mobCode(c, o, 'mob', p, ctx) ?? ''
  const count = c.int(o, 'count', p, 1, MAX_ENCOUNTER_MOBS) ?? 1
  const hpMul = c.num(o, 'hpMul', p, 0, 100, false)
  if (hpMul === 0) c.error(at(p, 'hpMul'), 'must be above 0')
  const expMul = c.num(o, 'expMul', p, 0, 100, false)
  const attackMul = c.num(o, 'attackMul', p, 0, 100, false)
  if (attackMul === 0) c.error(at(p, 'attackMul'), 'must be above 0')
  const despawnSec = c.int(o, 'despawnSec', p, 10, 3600) ?? 600
  const cooldownSec = c.int(o, 'cooldownSec', p, 0, 86_400, false)
  return {
    mob, count,
    ...(hpMul !== undefined ? { hpMul } : {}),
    ...(expMul !== undefined ? { expMul } : {}),
    ...(attackMul !== undefined ? { attackMul } : {}),
    despawnSec,
    ...(cooldownSec !== undefined ? { cooldownSec } : {}),
  }
}

function rewardItems(c: Checker, o: Obj, k: 'items' | 'choice', p: string, ctx: Ctx, max: number, level: number | undefined): RewardItem[] | undefined {
  const list = c.array(o, k, p, max, false)
  if (list === undefined) return undefined
  const out: RewardItem[] = []
  list.forEach((v, i) => {
    const ip = at(at(p, k), i)
    const r = c.obj(v, ip)
    if (!r) return
    c.keys(r, ip, ['item', 'count'])
    const code = c.match(r, 'item', ip, REWARD_CODE, 'an item code (CodeName128, tokens {G} and {ARMOR} allowed)')
    const count = c.int(r, 'count', ip, 1, MAX_ITEM_COUNT, false)
    if (code === undefined) return
    const tokens = [...code.matchAll(TOKEN)].map((m) => m[1]!)
    const bad = tokens.find((t) => !REWARD_TOKENS.has(t))
    if (bad !== undefined) return void c.error(at(ip, 'item'), `unknown token {${bad}} (only {G} and {ARMOR})`)
    const variants = rewardCodeVariants(code)
    const invalid = variants.find((x) => !CODE.test(x))
    if (invalid !== undefined) return void c.error(at(ip, 'item'), `expands to an invalid code ${invalid}`)
    if (variants.some((x) => QUEST_ITEM_CODE.test(x))) return void c.error(at(ip, 'item'), 'quest items cannot be rewards')
    const unknown = ctx.refs ? variants.filter((x) => !ctx.refs!.items.has(x)) : []
    if (unknown.length > 0) c.error(at(ip, 'item'), `unknown item${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`)
    const high = variants.map((x) => [x, ctx.refs?.itemReqLevel?.(x)] as const).filter(([, req]) => req !== undefined && level !== undefined && req > level + 2)
    if (high.length > 0) c.warn(at(ip, 'item'), `${high[0]![0]} needs level ${high[0]![1]}, above the quest level + 2`)
    out.push({ item: code, ...(count !== undefined ? { count } : {}) })
  })
  if (k === 'choice' && out.length === 1) c.warn(at(p, k), 'a choice of one item; use rewards.items')
  return out
}

function questRewards(c: Checker, v: unknown, p: string, ctx: Ctx, level: number | undefined): QuestRewards {
  const o = c.obj(v, p)
  if (!o) return { exp: 0, sp: 0, gold: 0 }
  c.keys(o, p, ['exp', 'expPctOfLevel', 'sp', 'gold', 'items', 'choice'])
  const exp = c.int(o, 'exp', p, 0, MAX_QUEST_EXP) ?? 0
  const expPctOfLevel = c.num(o, 'expPctOfLevel', p, 0, 100, false)
  const sp = c.int(o, 'sp', p, 0, 100_000) ?? 0
  const gold = c.int(o, 'gold', p, 0, MAX_GOLD) ?? 0
  const items = rewardItems(c, o, 'items', p, ctx, MAX_REWARD_ITEMS, level)
  const choice = rewardItems(c, o, 'choice', p, ctx, MAX_REWARD_CHOICES, level)
  return {
    exp,
    ...(expPctOfLevel !== undefined ? { expPctOfLevel } : {}),
    sp,
    gold,
    ...(items !== undefined ? { items } : {}),
    ...(choice !== undefined ? { choice } : {}),
  }
}

const QUEST_KEYS = [
  'id', 'title', 'chapter', 'kind', 'level', 'maxLevel', 'giver', 'turnIn', 'requires', 'repeat', 'party', 'summary',
  'giveOnAccept', 'objectives', 'rewards', 'dialog', 'disabled', 'rev',
] as const

/** Parses one quest (clean copy: known keys only, text cleaned). Issues go to `c`; the copy is usable only when no error was added. */
function questDef(c: Checker, v: unknown, p: string, ctx: Ctx): QuestDef | undefined {
  const o = c.obj(v, p)
  if (!o) return undefined
  c.keys(o, p, QUEST_KEYS)
  const refs = ctx.refs
  const cap = refs?.levelCap ?? MAX_QUEST_LEVEL
  const id = c.match(o, 'id', p, QUEST_ID, 'a quest id (A-Z, 0-9, _; e.g. JG_001)') ?? ''
  const title = c.text(o, 'title', p, MAX_QUEST_TITLE) ?? ''
  const chapter = c.text(o, 'chapter', p, MAX_QUEST_TITLE, false)
  let kind: QuestKind = 'main'
  if (typeof o.kind === 'string' && (QUEST_KINDS as readonly string[]).includes(o.kind)) kind = o.kind as QuestKind
  else c.error(at(p, 'kind'), `must be one of ${QUEST_KINDS.join(', ')}`)
  const level = c.int(o, 'level', p, 1, cap)
  const maxLevel = c.int(o, 'maxLevel', p, 1, cap, false)
  if (level !== undefined && maxLevel !== undefined && maxLevel < level) c.error(at(p, 'maxLevel'), 'must be at least level')
  const giver = npcCode(c, o, 'giver', p, ctx) ?? ''
  const turnIn = npcCode(c, o, 'turnIn', p, ctx) ?? ''

  let requires: QuestDef['requires']
  if (o.requires !== undefined) {
    const rp = at(p, 'requires')
    const ro = c.obj(o.requires, rp)
    if (ro) {
      c.keys(ro, rp, ['quests'])
      const list = c.array(ro, 'quests', rp, MAX_QUEST_REQUIRES, false)
      if (list) {
        const quests: string[] = []
        list.forEach((q, i) => {
          const qp = at(at(rp, 'quests'), i)
          if (typeof q !== 'string' || !QUEST_ID.test(q)) return void c.error(qp, 'must be a quest id')
          if (q === id) return void c.error(qp, 'a quest cannot require itself')
          if (quests.includes(q)) return void c.error(qp, `duplicate ${q}`)
          if (!ctx.scope.quests.has(q)) c.error(qp, `unknown quest ${q}`)
          quests.push(q)
        })
        requires = { quests }
      } else requires = {}
    }
  }

  let repeat: QuestDef['repeat']
  if (o.repeat !== undefined) {
    const rp = at(p, 'repeat')
    const ro = c.obj(o.repeat, rp)
    if (ro) {
      if (ro.reset !== undefined) {
        c.keys(ro, rp, ['reset'])
        if (ro.reset === 'daily') repeat = { reset: 'daily' }
        else c.error(at(rp, 'reset'), "must be 'daily'")
      } else if (ro.cooldownSec !== undefined) {
        c.keys(ro, rp, ['cooldownSec'])
        const s = c.int(ro, 'cooldownSec', rp, 60, MAX_QUEST_COOLDOWN_SEC)
        if (s !== undefined) repeat = { cooldownSec: s }
      } else c.error(rp, 'needs reset or cooldownSec')
    }
    if (kind !== 'repeatable') c.error(rp, "only repeatable quests repeat (kind 'repeatable')")
  } else if (kind === 'repeatable') c.error(at(p, 'repeat'), 'a repeatable quest needs repeat ({reset: daily} or {cooldownSec})')

  const party = c.bool(o, 'party', p)
  const summary = c.text(o, 'summary', p, MAX_QUEST_SUMMARY) ?? ''

  let giveOnAccept: QuestItemGrant[] | undefined
  const grants = c.array(o, 'giveOnAccept', p, MAX_QUEST_GRANTS, false)
  if (grants) {
    giveOnAccept = []
    grants.forEach((g, i) => {
      const gp = at(at(p, 'giveOnAccept'), i)
      const go = c.obj(g, gp)
      if (!go) return
      c.keys(go, gp, ['item', 'count'])
      const item = questItem(c, go, 'item', gp, ctx)
      const count = c.int(go, 'count', gp, 1, stackOf(ctx, item))
      if (item === undefined || count === undefined) return
      if (giveOnAccept!.some((x) => x.item === item)) return void c.error(at(gp, 'item'), `duplicate grant ${item}`)
      giveOnAccept!.push({ item, count })
    })
  }

  const objectives: QuestObjective[] = []
  const list = c.array(o, 'objectives', p, MAX_QUEST_OBJECTIVES) ?? []
  const ids = new Set<string>()
  list.forEach((v, i) => {
    const op = at(at(p, 'objectives'), i)
    const obj = objective(c, v, op, ctx, ids)
    if (!obj) return
    if (obj.id) {
      if (ids.has(obj.id)) c.error(at(op, 'id'), `duplicate objective id ${obj.id}`)
      ids.add(obj.id)
    }
    objectives.push(obj)
  })

  // Quest items the objectives need must come from giveOnAccept (deliver may also hand in what a collect gathered).
  const granted = new Map((giveOnAccept ?? []).map((g) => [g.item, g.count]))
  const collected = new Map<string, number>()
  objectives.forEach((ob) => {
    if (ob.type === 'collect' && ob.item) collected.set(ob.item, Math.max(collected.get(ob.item) ?? 0, ob.count))
  })
  const bag = new Set<string>(granted.keys())
  objectives.forEach((ob, i) => {
    const op = at(at(p, 'objectives'), i)
    if (ob.type === 'collect' && ob.item) bag.add(ob.item)
    if (ob.type === 'useItem' && ob.item) {
      bag.add(ob.item)
      if (!granted.has(ob.item)) c.error(at(op, 'item'), `${ob.item} must be granted by giveOnAccept`)
    }
    if (ob.type === 'deliver' && QUEST_ITEM_CODE.test(ob.item)) {
      bag.add(ob.item)
      const have = Math.max(granted.get(ob.item) ?? 0, collected.get(ob.item) ?? 0)
      if (have < ob.count) c.error(at(op, 'item'), `${ob.count} ${ob.item} must be granted by giveOnAccept (or collected first)`)
    }
    if (ob.type === 'kill' && refs?.mobInfo && level !== undefined) {
      const limit = kind === 'repeatable' ? (maxLevel ?? level) : level + 3
      for (const m of ob.mobs) {
        const info = refs.mobInfo(m)
        if (info && !info.unique && info.level > limit) c.warn(at(op, 'mobs'), `${m} is level ${info.level}, above ${limit}`)
      }
    }
  })
  if (bag.size > MAX_QUEST_BAG_CODES) c.error(at(p, 'objectives'), `uses ${bag.size} quest items; at most ${MAX_QUEST_BAG_CODES}`)

  const rewards = questRewards(c, o.rewards, at(p, 'rewards'), ctx, level)

  const dp = at(p, 'dialog')
  const d = c.obj(o.dialog, dp)
  const dialog: QuestDialog = { offer: '', progress: '', complete: '' }
  if (d) {
    c.keys(d, dp, ['offer', 'progress', 'complete'])
    dialog.offer = c.text(d, 'offer', dp, MAX_QUEST_TEXT) ?? ''
    dialog.progress = c.text(d, 'progress', dp, MAX_QUEST_TEXT) ?? ''
    dialog.complete = c.text(d, 'complete', dp, MAX_QUEST_TEXT) ?? ''
  }
  const disabled = c.bool(o, 'disabled', p)
  const rev = c.int(o, 'rev', p, 0, Number.MAX_SAFE_INTEGER, false)

  return {
    id, title,
    ...(chapter !== undefined ? { chapter } : {}),
    kind,
    level: level ?? 1,
    ...(maxLevel !== undefined ? { maxLevel } : {}),
    giver, turnIn,
    ...(requires !== undefined ? { requires } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(party !== undefined ? { party } : {}),
    summary,
    ...(giveOnAccept !== undefined ? { giveOnAccept } : {}),
    objectives,
    rewards,
    dialog,
    ...(disabled !== undefined ? { disabled } : {}),
    ...(rev !== undefined ? { rev } : {}),
  }
}

function questItemDef(c: Checker, v: unknown, p: string): QuestItemDef | undefined {
  const o = c.obj(v, p)
  if (!o) return undefined
  c.keys(o, p, ['code', 'name', 'description', 'iconItem', 'maxStack'])
  const code = c.match(o, 'code', p, QUEST_ITEM_CODE, 'a quest item code (QITEM_*)')
  const name = c.text(o, 'name', p, MAX_QUEST_TITLE)
  const description = c.text(o, 'description', p, MAX_QUEST_ITEM_DESCRIPTION, false)
  const iconItem = c.match(o, 'iconItem', p, CODE, 'a client item code (CodeName128)', false)
  const maxStack = c.int(o, 'maxStack', p, 1, MAX_QUEST_ITEM_STACK, false)
  if (code === undefined || name === undefined) return undefined
  return {
    code, name,
    ...(description !== undefined ? { description } : {}),
    ...(iconItem !== undefined ? { iconItem } : {}),
    ...(maxStack !== undefined ? { maxStack } : {}),
  }
}

function questLocation(c: Checker, v: unknown, p: string): QuestLocation | undefined {
  const o = c.obj(v, p)
  if (!o) return undefined
  c.keys(o, p, ['id', 'name', 'x', 'z', 'radius'])
  const id = c.match(o, 'id', p, QUEST_LOCATION_ID, 'a location id (LOC_*)')
  const name = c.text(o, 'name', p, MAX_QUEST_TITLE)
  const x = c.num(o, 'x', p, -MAX_COORD, MAX_COORD)
  const z = c.num(o, 'z', p, -MAX_COORD, MAX_COORD)
  const radius = c.num(o, 'radius', p, MIN_LOCATION_RADIUS, MAX_LOCATION_RADIUS)
  if (id === undefined || name === undefined || x === undefined || z === undefined || radius === undefined) return undefined
  return { id, name, x, z, radius }
}

const LINE_TOKEN = /\{([^}]*)\}/g

function lineText(c: Checker, o: Obj, k: string, p: string, required: boolean): string | undefined {
  const s = c.text(o, k, p, MAX_QUEST_LINE_TEXT, required)
  if (s !== undefined) for (const m of s.matchAll(LINE_TOKEN)) if (m[1] !== 'area') c.warn(at(p, k), `unknown token {${m[1]}} (shown as typed)`)
  return s
}

function questDialogLine(c: Checker, v: unknown, p: string, ctx: Ctx): QuestDialogLine | undefined {
  const o = c.obj(v, p)
  if (!o) return undefined
  c.keys(o, p, ['id', 'npc', 'text', 'textNoArea', 'when'])
  const id = c.match(o, 'id', p, QUEST_LINE_ID, 'a line id (a-z, 0-9, _)')
  const npc = npcCode(c, o, 'npc', p, ctx)
  const text = lineText(c, o, 'text', p, true)
  const textNoArea = lineText(c, o, 'textNoArea', p, false)
  if (textNoArea?.includes('{area}')) c.error(at(p, 'textNoArea'), 'must not use {area}')
  const wp = at(p, 'when')
  const w = o.when === undefined ? void c.error(wp, 'missing') : c.obj(o.when, wp)
  let when: QuestLineCondition | undefined
  if (w) {
    // An unknown condition is an error (never a silently weaker condition): the line is dropped.
    for (const k of Object.keys(w)) if (!(QUEST_LINE_CONDITIONS as readonly string[]).includes(k)) c.error(at(wp, k), `unknown condition (known: ${QUEST_LINE_CONDITIONS.join(', ')})`)
    const kinds = QUEST_LINE_CONDITIONS.filter((k) => w[k] !== undefined)
    if (kinds.length !== 1) c.error(wp, `must have exactly one of ${QUEST_LINE_CONDITIONS.join(', ')}`)
    else {
      const mob = mobCode(c, w, 'uniqueAlive', wp, ctx)
      const info = mob !== undefined ? ctx.refs?.mobInfo?.(mob) : undefined
      if (info && !info.unique) c.warn(at(wp, 'uniqueAlive'), `${mob} is not a unique monster (the line never shows)`)
      if (mob !== undefined) when = { uniqueAlive: mob }
    }
  }
  if (id === undefined || npc === undefined || text === undefined || when === undefined) return undefined
  return { id, npc, text, ...(textNoArea !== undefined ? { textNoArea } : {}), when }
}

/** Quests on a `requires` cycle (only edges inside `defs`). */
function requireCycles(defs: readonly QuestDef[]): Set<string> {
  const byId = new Map(defs.map((d) => [d.id, d]))
  const state = new Map<string, 1 | 2>()
  const onCycle = new Set<string>()
  const stack: string[] = []
  const visit = (id: string): void => {
    state.set(id, 1)
    stack.push(id)
    for (const r of byId.get(id)?.requires?.quests ?? []) {
      if (!byId.has(r)) continue
      if (state.get(r) === 1) for (const s of stack.slice(stack.indexOf(r))) onCycle.add(s)
      else if (!state.has(r)) visit(r)
    }
    stack.pop()
    state.set(id, 2)
  }
  for (const d of defs) if (!state.has(d.id)) visit(d.id)
  return onCycle
}

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Structural + reference validation of a whole quest file (refs optional: the client editor has only some).
 * Never throws. `file` is null when the envelope is unusable; otherwise it is a clean copy (known keys only,
 * text cleaned) holding only the items, locations and quests without errors. `external` names ids defined in
 * other files (an override file may use the repo line's items, locations and prerequisites).
 */
export function validateQuestFile(json: unknown, refs?: QuestRefs, external?: Partial<QuestScope>): { file: QuestFile | null; issues: QuestIssue[] } {
  const c = new Checker()
  const o = c.obj(json, '')
  if (!o) return { file: null, issues: c.issues }
  c.keys(o, '', ['schema', 'kind', 'id', 'title', 'world', 'notes', 'items', 'locations', 'quests', 'lines', 'rev', 'updatedAt'])
  if (o.schema !== QUEST_FILE_SCHEMA) c.error('schema', `must be ${QUEST_FILE_SCHEMA}`)
  if (o.kind !== 'quests') c.error('kind', "must be 'quests'")
  const id = c.match(o, 'id', '', QUEST_FILE_ID, 'a file id (letters, digits, _ and -)')
  const title = c.text(o, 'title', '', MAX_QUEST_TITLE)
  const world = c.match(o, 'world', '', WORLD_ID, 'a world id (e.g. jangan)')
  const notes = c.text(o, 'notes', '', MAX_QUEST_NOTES, false)
  const rev = c.int(o, 'rev', '', 0, Number.MAX_SAFE_INTEGER, false)
  const updatedAt = c.text(o, 'updatedAt', '', 64, false)
  const rawItems = c.array(o, 'items', '', MAX_FILE_ITEMS)
  const rawLocations = c.array(o, 'locations', '', MAX_FILE_LOCATIONS)
  const rawQuests = c.array(o, 'quests', '', MAX_FILE_QUESTS)
  if (c.errors > 0 || id === undefined || title === undefined || world === undefined || !rawItems || !rawLocations || !rawQuests) {
    return { file: null, issues: c.issues }
  }

  const items: QuestItemDef[] = []
  rawItems.forEach((v, i) => {
    const before = c.errors
    const item = questItemDef(c, v, at('items', i))
    if (!item || c.errors > before) return
    if (items.some((x) => x.code === item.code)) return void c.error(at(at('items', i), 'code'), `duplicate quest item ${item.code}`)
    items.push(item)
  })
  const locations: QuestLocation[] = []
  rawLocations.forEach((v, i) => {
    const before = c.errors
    const loc = questLocation(c, v, at('locations', i))
    if (!loc || c.errors > before) return
    if (locations.some((x) => x.id === loc.id)) return void c.error(at(at('locations', i), 'id'), `duplicate location ${loc.id}`)
    locations.push(loc)
  })

  const questIds = new Set<string>(external?.quests ?? EMPTY)
  for (const q of rawQuests) if (isObj(q) && typeof q.id === 'string' && QUEST_ID.test(q.id)) questIds.add(q.id)
  const ctx: Ctx = {
    scope: {
      items: new Set([...(external?.items ?? EMPTY), ...items.map((x) => x.code)]),
      locations: new Set([...(external?.locations ?? EMPTY), ...locations.map((x) => x.id)]),
      quests: questIds,
    },
    stacks: new Map(items.map((x) => [x.code, x.maxStack ?? DEFAULT_QUEST_ITEM_STACK])),
    refs,
  }

  const parsed: { def: QuestDef; index: number; ok: boolean }[] = []
  const seen = new Set<string>()
  rawQuests.forEach((v, i) => {
    const p = at('quests', i)
    const before = c.errors
    const def = questDef(c, v, p, ctx)
    if (!def) return
    if (def.id && seen.has(def.id)) c.error(at(p, 'id'), `duplicate quest ${def.id}`)
    else if (def.id) seen.add(def.id)
    parsed.push({ def, index: i, ok: c.errors === before })
  })

  for (const cyc of requireCycles(parsed.map((x) => x.def))) {
    for (const x of parsed) {
      if (x.def.id !== cyc) continue
      c.error(at(at('quests', x.index), 'requires'), `requires cycle through ${cyc}`)
      x.ok = false
    }
  }

  const levels = new Map(parsed.map((x) => [x.def.id, x.def.level]))
  for (const x of parsed) {
    for (const r of x.def.requires?.quests ?? []) {
      const l = levels.get(r)
      if (l !== undefined && l > x.def.level) c.warn(at(at('quests', x.index), 'requires'), `${r} is level ${l}, above this quest's ${x.def.level}`)
    }
  }

  // Optional and outside the envelope check: a broken `lines` drops only the lines, never the quests.
  const rawLines = c.array(o, 'lines', '', MAX_FILE_LINES, false)
  const lines: QuestDialogLine[] = []
  rawLines?.forEach((v, i) => {
    const before = c.errors
    const line = questDialogLine(c, v, at('lines', i), ctx)
    if (!line || c.errors > before) return
    if (lines.some((x) => x.id === line.id)) return void c.error(at(at('lines', i), 'id'), `duplicate line ${line.id}`)
    lines.push(line)
  })

  const quests = parsed.filter((x) => x.ok).map((x) => x.def)
  const used = new Set<string>()
  for (const q of parsed.map((x) => x.def)) {
    for (const g of q.giveOnAccept ?? []) used.add(g.item)
    for (const ob of q.objectives) if (ob.type === 'collect' || ob.type === 'deliver' || ob.type === 'useItem') used.add(ob.item)
  }
  items.forEach((it) => {
    if (!used.has(it.code)) c.warn(at(at('items', items.indexOf(it)), 'code'), `quest item ${it.code} is not used`)
  })

  const file: QuestFile = {
    schema: QUEST_FILE_SCHEMA, kind: 'quests', id, title, world,
    ...(notes !== undefined ? { notes } : {}),
    items, locations, quests,
    ...(rawLines !== undefined ? { lines } : {}),
    ...(rev !== undefined ? { rev } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
  return { file, issues: c.issues }
}

/**
 * Validates one quest against the ids in scope (quest items, locations, quests of the whole catalog) and,
 * when given, the export refs. Paths are relative to the quest ('objectives[0].count'). Never throws.
 * Quest item counts are bounded by DEFAULT_QUEST_ITEM_STACK unless `stacks` gives an item's maxStack.
 */
export function validateQuestDef(
  def: unknown,
  scope: { items: ReadonlySet<string>; locations: ReadonlySet<string>; quests: ReadonlySet<string> },
  refs?: QuestRefs,
  stacks?: ReadonlyMap<string, number>,
): QuestIssue[] {
  const c = new Checker()
  questDef(c, def, '', { scope, stacks: stacks ?? new Map(), refs })
  return c.issues
}
