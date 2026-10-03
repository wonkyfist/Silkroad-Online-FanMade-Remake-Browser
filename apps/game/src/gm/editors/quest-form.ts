/**
 * The Quest Editor's form model (docs/QUESTS.md §5.4; lane ED-C): a QuestDef as the form fields hold it (numbers as the
 * typed text, optional parts as `undefined`) and back. `questToForm` then `formToQuest` gives the same quest (the test
 * round-trips every quest of content/quests/jangan.json). A number field that does not parse is sent as typed, so the
 * shared validator reports it at its own path. Also: issue paths -> form fields, and the reward helpers of the form.
 * Pure module (no DOM).
 */
import {
  QUEST_OBJECTIVE_TYPES,
  expandRewardCode,
  type ArmorClassToken,
  type QuestDef,
  type QuestEncounter,
  type QuestIssue,
  type QuestItemDef,
  type QuestKind,
  type QuestLocation,
  type QuestObjective,
  type QuestObjectiveType,
  type RewardItem,
} from '@sro/shared'

export interface RewardForm {
  item: string
  /** '' = absent (count 1). */
  count: string
}

export interface GrantForm {
  item: string
  count: string
}

export interface EncounterForm {
  mob: string
  count: string
  hpMul: string
  expMul: string
  attackMul: string
  despawnSec: string
  cooldownSec: string
}

/** One objective with every type's fields (switching the type keeps what was typed). */
export interface ObjectiveForm {
  type: QuestObjectiveType
  id: string
  label: string
  hint: string
  after: string
  mobs: string[]
  count: string
  item: string
  from: { mob: string; chance: string }[]
  npc: string
  text: string
  location: string
  consume?: boolean
  encounter?: EncounterForm
}

export interface QuestForm {
  id: string
  title: string
  chapter: string
  kind: QuestKind
  level: string
  maxLevel: string
  giver: string
  turnIn: string
  /** undefined = no `requires`. */
  requires?: string[]
  repeatMode: '' | 'daily' | 'cooldown'
  cooldownSec: string
  party?: boolean
  summary: string
  giveOnAccept?: GrantForm[]
  objectives: ObjectiveForm[]
  exp: string
  expPctOfLevel: string
  sp: string
  gold: string
  rewardItems?: RewardForm[]
  choice?: RewardForm[]
  offer: string
  progress: string
  complete: string
  /** Carried through unchanged (the Disable/Enable buttons and the server own them). */
  disabled?: boolean
  rev?: number
}

const str = (v: number | undefined): string => (v === undefined ? '' : String(v))

/** A typed number: '' -> undefined, '12' / '-3.5' / '0.05' -> the number, anything else -> the text as typed. */
export function numOut(raw: string): number | undefined {
  const s = raw.trim()
  if (s === '') return undefined
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) {
    const v = Number(s)
    if (Number.isFinite(v)) return v
  }
  // Sent as typed: the validator names the field ("must be a number").
  return s as unknown as number
}

/** A required number: an empty field is sent as '' so the validator reports it. */
function numReq(raw: string): number {
  return numOut(raw) ?? ('' as unknown as number)
}

export function emptyObjective(type: QuestObjectiveType = 'kill', id = 'obj'): ObjectiveForm {
  return { type, id, label: '', hint: '', after: '', mobs: [], count: '1', item: '', from: [], npc: '', text: '', location: '' }
}

export function emptyEncounter(): EncounterForm {
  return { mob: '', count: '1', hpMul: '', expMul: '', attackMul: '', despawnSec: '300', cooldownSec: '' }
}

/** A new quest's form (level 1, giver and turn-in = `npc`). */
export function newQuestForm(id: string, npc = ''): QuestForm {
  return {
    id,
    title: '',
    chapter: '',
    kind: 'side',
    level: '1',
    maxLevel: '',
    giver: npc,
    turnIn: npc,
    repeatMode: '',
    cooldownSec: '',
    summary: '',
    objectives: [emptyObjective('kill', 'kill')],
    exp: '0',
    expPctOfLevel: '',
    sp: '0',
    gold: '0',
    offer: '',
    progress: '',
    complete: '',
  }
}

function rewardsToForm(list: RewardItem[] | undefined): RewardForm[] | undefined {
  return list?.map(r => ({ item: r.item, count: str(r.count) }))
}

function rewardsOut(list: RewardForm[] | undefined): RewardItem[] | undefined {
  return list?.map(r => {
    const count = numOut(r.count)
    return count === undefined ? { item: r.item.trim() } : { item: r.item.trim(), count }
  })
}

function encounterToForm(e: QuestEncounter): EncounterForm {
  return {
    mob: e.mob,
    count: str(e.count),
    hpMul: str(e.hpMul),
    expMul: str(e.expMul),
    attackMul: str(e.attackMul),
    despawnSec: str(e.despawnSec),
    cooldownSec: str(e.cooldownSec),
  }
}

function encounterOut(e: EncounterForm): QuestEncounter {
  const hpMul = numOut(e.hpMul)
  const expMul = numOut(e.expMul)
  const attackMul = numOut(e.attackMul)
  const cooldownSec = numOut(e.cooldownSec)
  return {
    mob: e.mob.trim(),
    count: numReq(e.count),
    ...(hpMul !== undefined ? { hpMul } : {}),
    ...(expMul !== undefined ? { expMul } : {}),
    ...(attackMul !== undefined ? { attackMul } : {}),
    despawnSec: numReq(e.despawnSec),
    ...(cooldownSec !== undefined ? { cooldownSec } : {}),
  }
}

export function objectiveToForm(o: QuestObjective): ObjectiveForm {
  const f = emptyObjective(o.type, o.id)
  f.label = o.label ?? ''
  f.hint = o.hint ?? ''
  f.after = o.after ?? ''
  switch (o.type) {
    case 'kill':
      f.mobs = [...o.mobs]
      f.count = str(o.count)
      break
    case 'collect':
      f.item = o.item
      f.count = str(o.count)
      f.from = o.from.map(s => ({ mob: s.mob, chance: str(s.chance) }))
      break
    case 'talk':
      f.npc = o.npc
      f.text = o.text
      break
    case 'deliver':
      f.npc = o.npc
      f.item = o.item
      f.count = str(o.count)
      f.text = o.text
      break
    case 'have':
      f.item = o.item
      f.count = str(o.count)
      if (o.consume !== undefined) f.consume = o.consume
      break
    case 'reach':
      f.location = o.location
      break
    case 'useItem':
      f.item = o.item
      f.location = o.location
      if (o.consume !== undefined) f.consume = o.consume
      f.text = o.text ?? ''
      if (o.encounter) f.encounter = encounterToForm(o.encounter)
      break
  }
  return f
}

export function objectiveOut(f: ObjectiveForm): QuestObjective {
  const common = {
    ...(f.after.trim() ? { after: f.after.trim() } : {}),
    ...(f.label.trim() ? { label: f.label } : {}),
    ...(f.hint.trim() ? { hint: f.hint.trim() } : {}),
  }
  const id = f.id.trim()
  switch (f.type) {
    case 'kill':
      return { id, type: 'kill', mobs: f.mobs.map(m => m.trim()).filter(Boolean), count: numReq(f.count), ...common }
    case 'collect':
      return { id, type: 'collect', item: f.item.trim(), count: numReq(f.count), from: f.from.map(s => ({ mob: s.mob.trim(), chance: numReq(s.chance) })), ...common }
    case 'talk':
      return { id, type: 'talk', npc: f.npc.trim(), text: f.text, ...common }
    case 'deliver':
      return { id, type: 'deliver', npc: f.npc.trim(), item: f.item.trim(), count: numReq(f.count), text: f.text, ...common }
    case 'have':
      return { id, type: 'have', item: f.item.trim(), count: numReq(f.count), ...(f.consume !== undefined ? { consume: f.consume } : {}), ...common }
    case 'reach':
      return { id, type: 'reach', location: f.location.trim(), ...common }
    case 'useItem':
      return {
        id,
        type: 'useItem',
        item: f.item.trim(),
        location: f.location.trim(),
        ...(f.consume !== undefined ? { consume: f.consume } : {}),
        ...(f.text !== '' ? { text: f.text } : {}),
        ...(f.encounter ? { encounter: encounterOut(f.encounter) } : {}),
        ...common,
      }
  }
}

export function questToForm(q: QuestDef): QuestForm {
  const repeat = q.repeat
  return {
    id: q.id,
    title: q.title,
    chapter: q.chapter ?? '',
    kind: q.kind,
    level: str(q.level),
    maxLevel: str(q.maxLevel),
    giver: q.giver,
    turnIn: q.turnIn,
    ...(q.requires ? { requires: [...(q.requires.quests ?? [])] } : {}),
    repeatMode: !repeat ? '' : 'reset' in repeat ? 'daily' : 'cooldown',
    cooldownSec: repeat && 'cooldownSec' in repeat ? String(repeat.cooldownSec) : '',
    ...(q.party !== undefined ? { party: q.party } : {}),
    summary: q.summary,
    ...(q.giveOnAccept ? { giveOnAccept: q.giveOnAccept.map(g => ({ item: g.item, count: str(g.count) })) } : {}),
    objectives: q.objectives.map(objectiveToForm),
    exp: str(q.rewards.exp),
    expPctOfLevel: str(q.rewards.expPctOfLevel),
    sp: str(q.rewards.sp),
    gold: str(q.rewards.gold),
    ...(q.rewards.items ? { rewardItems: rewardsToForm(q.rewards.items) } : {}),
    ...(q.rewards.choice ? { choice: rewardsToForm(q.rewards.choice) } : {}),
    offer: q.dialog.offer,
    progress: q.dialog.progress,
    complete: q.dialog.complete,
    ...(q.disabled !== undefined ? { disabled: q.disabled } : {}),
    ...(q.rev !== undefined ? { rev: q.rev } : {}),
  }
}

export function formToQuest(f: QuestForm): QuestDef {
  const maxLevel = numOut(f.maxLevel)
  const expPct = numOut(f.expPctOfLevel)
  const items = rewardsOut(f.rewardItems)
  const choice = rewardsOut(f.choice)
  const repeat: QuestDef['repeat'] | undefined = f.repeatMode === 'daily' ? { reset: 'daily' } : f.repeatMode === 'cooldown' ? { cooldownSec: numReq(f.cooldownSec) } : undefined
  return {
    id: f.id.trim(),
    title: f.title,
    ...(f.chapter.trim() ? { chapter: f.chapter } : {}),
    kind: f.kind,
    level: numReq(f.level),
    ...(maxLevel !== undefined ? { maxLevel } : {}),
    giver: f.giver.trim(),
    turnIn: f.turnIn.trim(),
    ...(f.requires ? { requires: { quests: f.requires.map(q => q.trim()).filter(Boolean) } } : {}),
    ...(repeat ? { repeat } : {}),
    ...(f.party !== undefined ? { party: f.party } : {}),
    summary: f.summary,
    ...(f.giveOnAccept ? { giveOnAccept: f.giveOnAccept.map(g => ({ item: g.item.trim(), count: numReq(g.count) })) } : {}),
    objectives: f.objectives.map(objectiveOut),
    rewards: {
      exp: numReq(f.exp),
      ...(expPct !== undefined ? { expPctOfLevel: expPct } : {}),
      sp: numReq(f.sp),
      gold: numReq(f.gold),
      ...(items ? { items } : {}),
      ...(choice ? { choice } : {}),
    },
    dialog: { offer: f.offer, progress: f.progress, complete: f.complete },
    ...(f.disabled !== undefined ? { disabled: f.disabled } : {}),
    ...(f.rev !== undefined ? { rev: f.rev } : {}),
  }
}

/** A deep copy (forms are plain JSON). */
export function cloneForm(f: QuestForm): QuestForm {
  return JSON.parse(JSON.stringify(f)) as QuestForm
}

/** Stable JSON (sorted keys) for comparing quests and noticing unsaved edits. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x
    const o = x as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]))
  })
}

// ---- objective helpers ------------------------------------------------------------------------------------

/** A free objective id for a new objective of `type` ('kill', 'kill_2', ...). */
export function freeObjectiveId(objectives: readonly ObjectiveForm[], type: QuestObjectiveType): string {
  const base = type === 'useItem' ? 'use' : type
  const used = new Set(objectives.map(o => o.id))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`
}

/** Moves objective `i` by `delta`; an `after` that would now point at a later objective is cleared. */
export function moveObjective(list: ObjectiveForm[], i: number, delta: number): ObjectiveForm[] {
  const j = i + delta
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list
  const out = [...list]
  const [x] = out.splice(i, 1)
  out.splice(j, 0, x!)
  return fixAfter(out)
}

/** Clears `after` values that no longer name an earlier objective. */
export function fixAfter(list: ObjectiveForm[]): ObjectiveForm[] {
  return list.map((o, i) => (o.after && !list.slice(0, i).some(p => p.id === o.after) ? { ...o, after: '' } : o))
}

export const OBJECTIVE_TYPES: readonly QuestObjectiveType[] = QUEST_OBJECTIVE_TYPES

/** The fields an objective type shows (besides id, label, hint and after). */
export function objectiveFields(type: QuestObjectiveType): readonly ('mobs' | 'count' | 'item' | 'from' | 'npc' | 'text' | 'location' | 'consume' | 'encounter')[] {
  switch (type) {
    case 'kill':
      return ['mobs', 'count']
    case 'collect':
      return ['item', 'count', 'from']
    case 'talk':
      return ['npc', 'text']
    case 'deliver':
      return ['npc', 'item', 'count', 'text']
    case 'have':
      return ['item', 'count', 'consume']
    case 'reach':
      return ['location']
    case 'useItem':
      return ['item', 'location', 'consume', 'text', 'encounter']
  }
}

// ---- rewards -----------------------------------------------------------------------------------------------

/** EXP suggestion: 15 % of the EXP from the quest's level to the next (docs/QUESTS.md §5.4). */
export function suggestExp(level: number, expToNext: (level: number) => number): number {
  return Math.max(0, Math.round(0.15 * (expToNext(level) || 0)))
}

/** SP suggestion: EXP / 600, at least 1 when there is EXP. */
export function suggestSp(exp: number): number {
  if (!(exp > 0)) return 0
  return Math.max(1, Math.round(exp / 600))
}

/** The distinct codes a templated reward code gives, labelled (6 for {G}+{ARMOR}). */
export function rewardPreview(code: string): { who: string; code: string }[] {
  const out: { who: string; code: string }[] = []
  const genders = code.includes('{G}') ? (['male', 'female'] as const) : (['male'] as const)
  const armors: readonly ArmorClassToken[] = code.includes('{ARMOR}') ? ['CLOTHES', 'LIGHT', 'HEAVY'] : ['CLOTHES']
  for (const gender of genders) {
    for (const armor of armors) {
      const who = [code.includes('{G}') ? (gender === 'female' ? 'F' : 'M') : '', code.includes('{ARMOR}') ? armor.toLowerCase() : ''].filter(Boolean).join(' ')
      out.push({ who, code: expandRewardCode(code, { gender, armor }) })
    }
  }
  return out
}

// ---- issues ------------------------------------------------------------------------------------------------

/** Where an issue points in the editor: the quest (a path relative to it), a local quest item, or a local location. */
export type IssueTarget = { kind: 'quest'; path: string } | { kind: 'item'; index: number; path: string } | { kind: 'location'; index: number; path: string } | { kind: 'other'; path: string }

/**
 * Maps an issue path to the form. The server answers with paths of the override file it built
 * (`quests[0].objectives[1].count`, `items[0].name`, `locations[2].x`, `baseRev`), the list with paths of the quest's own
 * file (`quests[3].level`); local checks use quest paths.
 */
export function issueTarget(path: string): IssueTarget {
  // An override file holds one quest (quests[0]); the list's issues of a repo quest keep its index in the repo file.
  let m = /^quests\[\d+\](?:\.(.*))?$/.exec(path)
  if (m) return { kind: 'quest', path: m[1] ?? '' }
  m = /^quest\.(.*)$/.exec(path)
  if (m) return { kind: 'quest', path: m[1]! }
  m = /^items\[(\d+)\](?:\.(.*))?$/.exec(path)
  if (m) return { kind: 'item', index: Number(m[1]), path: m[2] ?? '' }
  m = /^locations\[(\d+)\](?:\.(.*))?$/.exec(path)
  if (m) return { kind: 'location', index: Number(m[1]), path: m[2] ?? '' }
  if (/^(id|title|chapter|kind|level|maxLevel|giver|turnIn|requires|repeat|party|summary|giveOnAccept|objectives|rewards|dialog)\b/.test(path)) return { kind: 'quest', path }
  return { kind: 'other', path }
}

/** The form key of a field path: the longest registered prefix ('objectives[0].mobs[1]' -> 'objectives[0].mobs'). */
export function fieldFor(path: string, registered: (key: string) => boolean): string | null {
  let p = path
  for (;;) {
    if (registered(p)) return p
    const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('['))
    if (cut <= 0) return registered(p) ? p : null
    p = p.slice(0, cut)
  }
}

/** Issue key of a local record: 'item:0.name', 'location:1.x' (the form registers its fields with these keys). */
export function issueKey(target: IssueTarget): string {
  switch (target.kind) {
    case 'quest':
      return target.path
    case 'item':
      return `item:${target.index}${target.path ? `.${target.path}` : ''}`
    case 'location':
      return `location:${target.index}${target.path ? `.${target.path}` : ''}`
    case 'other':
      return target.path
  }
}

/** Errors first, then warnings; stable otherwise. */
export function sortIssues(issues: readonly QuestIssue[]): QuestIssue[] {
  return [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}

// ---- local quest items and locations (sent in the PUT body) ------------------------------------------------

export interface ItemForm {
  code: string
  name: string
  description: string
  iconItem: string
  maxStack: string
}

export interface LocationForm {
  id: string
  name: string
  x: string
  z: string
  radius: string
}

export function itemToForm(i: QuestItemDef): ItemForm {
  return { code: i.code, name: i.name, description: i.description ?? '', iconItem: i.iconItem ?? '', maxStack: str(i.maxStack) }
}

export function itemOut(f: ItemForm): QuestItemDef {
  const maxStack = numOut(f.maxStack)
  return {
    code: f.code.trim(),
    name: f.name,
    ...(f.description.trim() ? { description: f.description } : {}),
    ...(f.iconItem.trim() ? { iconItem: f.iconItem.trim() } : {}),
    ...(maxStack !== undefined ? { maxStack } : {}),
  }
}

export function locationToForm(l: QuestLocation): LocationForm {
  return { id: l.id, name: l.name, x: str(l.x), z: str(l.z), radius: str(l.radius) }
}

export function locationOut(f: LocationForm): QuestLocation {
  return { id: f.id.trim(), name: f.name, x: numReq(f.x), z: numReq(f.z), radius: numReq(f.radius) }
}

/** A free id with `prefix` ('LOC_JG_040', 'LOC_JG_040_2', ...) among `used`. */
export function freeId(prefix: string, used: ReadonlySet<string>): string {
  const base = prefix.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`
}
