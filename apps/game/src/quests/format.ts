/**
 * Quest text for the UI (docs/QUESTS.md §2.3-§2.5): objective lines ("Mangyang slain 3/8"), reward views with the
 * {G}/{ARMOR} expansion the server will apply, `{name}` fill, wait times, and the notifications a `questUpdate`
 * produces (accepted, progress, objective done, ready, completed). Pure functions; names come from a QuestNames
 * the caller builds from the game content. No DOM.
 */
import {
  expandRewardCode,
  objectiveGoal,
  questRewardExp,
  type ArmorClassToken,
  type QuestDef,
  type QuestLocation,
  type QuestObjective,
  type QuestProgress,
  type RewardItem,
} from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { QuestLookup } from './catalog.ts'
import { objectiveCount, objectiveLocked, type QuestChange } from './state.ts'

/** Display names and icons (mobs, NPCs, items and quest items). */
export interface QuestNames {
  mob(code: string): string
  npc(code: string): string
  /** ItemDef or quest item name. */
  item(code: string): string
  /** Icon URL (a quest item borrows its `iconItem`'s), or null. */
  icon(code: string): string | null
}

/** Who reads the text: `{name}`, the level for EXP percentages, and the reward code expansion. */
export interface QuestReader {
  name: string
  level: number
  gender: 'male' | 'female'
  armor: ArmorClassToken
}

/** Fills `{name}` (the character's name); other braces stay as written. */
export function fillText(text: string, who: Pick<QuestReader, 'name'>): string {
  return text.replace(/\{name\}/g, who.name)
}

/** Dialog text as paragraphs (split on newlines), `{name}` filled. */
export function paragraphs(text: string, who: Pick<QuestReader, 'name'>): string[] {
  return fillText(text, who)
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
}

export function placeName(id: string, cat: Pick<QuestLookup, 'location'>): string {
  return cat.location(id)?.name ?? id
}

/** Distinct names joined with " / " (a kill objective over several mobs). */
function joinNames(codes: readonly string[], name: (c: string) => string): string {
  return [...new Set(codes.map(name))].join(' / ')
}

/** One objective line with its count: the `label` when authored, else the generated line of its type. */
export function objectiveLine(o: QuestObjective, count: number, cat: Pick<QuestLookup, 'location'>, names: QuestNames): string {
  const goal = objectiveGoal(o)
  if (o.label) return goal > 1 ? t('quest.objective.count', { label: o.label, n: count, count: goal }) : o.label
  switch (o.type) {
    case 'kill':
      return t('quest.objective.kill', { mob: joinNames(o.mobs, names.mob), n: count, count: goal })
    case 'collect':
      return t('quest.objective.collect', { item: names.item(o.item), n: count, count: goal })
    case 'have':
      return t('quest.objective.have', { item: names.item(o.item), n: count, count: goal })
    case 'talk':
      return t('quest.objective.talk', { npc: names.npc(o.npc) })
    case 'deliver':
      return goal > 1 ? t('quest.objective.deliverCount', { item: names.item(o.item), count: goal, npc: names.npc(o.npc) }) : t('quest.objective.deliver', { item: names.item(o.item), npc: names.npc(o.npc) })
    case 'reach':
      return t('quest.objective.reach', { place: placeName(o.location, cat) })
    case 'useItem':
      return t('quest.objective.useItem', { item: names.item(o.item), place: placeName(o.location, cat) })
  }
}

/** Where an objective happens: its location (reach, useItem) or its minimap hint. */
export function objectiveLocation(o: QuestObjective, cat: Pick<QuestLookup, 'location'>): QuestLocation | undefined {
  const id = o.type === 'reach' || o.type === 'useItem' ? o.location : o.hint
  return id ? cat.location(id) : undefined
}

export interface ObjectiveView {
  /** Objective id ('' for the "report to" line of a quest without objectives). */
  id: string
  type: QuestObjective['type'] | 'report'
  text: string
  count: number
  goal: number
  done: boolean
  /** Gated by `after`. */
  locked: boolean
  objective?: QuestObjective
}

/** The objective lines of a quest (a quest without objectives shows "Report to <turn-in>"). */
export function objectiveViews(def: QuestDef, p: QuestProgress | null | undefined, cat: Pick<QuestLookup, 'location'>, names: QuestNames): ObjectiveView[] {
  if (!def.objectives.length) {
    const done = p?.status === 'ready'
    return [{ id: '', type: 'report', text: t('quest.objective.report', { npc: names.npc(def.turnIn) }), count: done ? 1 : 0, goal: 1, done, locked: false }]
  }
  return def.objectives.map(o => {
    const count = objectiveCount(o, p)
    const goal = objectiveGoal(o)
    return { id: o.id, type: o.type, text: objectiveLine(o, count, cat, names), count, goal, done: count >= goal, locked: objectiveLocked(o, def, p), objective: o }
  })
}

export interface RewardView {
  /** The expanded item code. */
  code: string
  name: string
  icon: string | null
  count: number
}

export interface RewardsView {
  exp: number
  sp: number
  gold: number
  items: RewardView[]
  choice: RewardView[]
}

export function rewardView(r: RewardItem, who: Pick<QuestReader, 'gender' | 'armor'>, names: QuestNames): RewardView {
  const code = expandRewardCode(r.item, who)
  return { code, name: names.item(code), icon: names.icon(code), count: Math.max(1, r.count ?? 1) }
}

/** The rewards as this character would get them now (EXP percentages use its level). */
export function rewardsView(def: QuestDef, who: QuestReader, expToNext: (level: number) => number, names: QuestNames): RewardsView {
  const r = def.rewards
  return {
    exp: questRewardExp(r, who.level, expToNext),
    sp: Math.max(0, r.sp),
    gold: Math.max(0, r.gold),
    items: (r.items ?? []).map(i => rewardView(i, who, names)),
    choice: (r.choice ?? []).map(i => rewardView(i, who, names)),
  }
}

/** "3 h 20 min", "12 min", "less than a minute". */
export function formatWait(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return t('quest.time.s')
  if (m < 60) return t('quest.time.m', { m })
  return t('quest.time.hm', { h: Math.floor(m / 60), m: m % 60 })
}

/** Big numbers with thousands separators ("1,234"). */
export function formatAmount(n: number): string {
  return Math.floor(n).toLocaleString('en-US')
}

// ---- notifications ---------------------------------------------------------------------------------------

export interface QuestNotice {
  text: string
  kind: 'info' | 'loot' | 'error'
  /** Completion: a banner with this quest title. */
  banner?: string
  /** A useItem "vision": shown centre-screen for 6 s and as a system chat line. */
  vision?: string
  /** Also a system chat line (milestones, not every kill). */
  chat?: boolean
}

/**
 * What to tell the player about one `questUpdate` (docs/QUESTS.md §2.5): accepted, each count that rose (quest items
 * loot-style), an objective completed, ready ("Return to ..."), completed (banner), abandoned, changed/withdrawn.
 */
export function questNotices(change: QuestChange, def: QuestDef | undefined, cat: Pick<QuestLookup, 'location'>, names: QuestNames, who: Pick<QuestReader, 'name'>): QuestNotice[] {
  if (change.kind !== 'update' || !change.quest) return []
  const title = def?.title ?? change.quest
  const out: QuestNotice[] = []
  const prev = change.prev ?? null
  const next = change.next ?? null
  switch (change.event) {
    case 'completed':
      return [{ text: t('quest.toast.completed', { title }), kind: 'info', banner: title, chat: true }]
    case 'abandoned':
      return [{ text: t('quest.toast.abandoned', { title }), kind: 'info', chat: true }]
    case 'changed':
      return [{ text: t(def?.disabled || !next ? 'quest.toast.withdrawn' : 'quest.toast.changed', { title }), kind: 'info', chat: true }]
    case 'accepted':
      out.push({ text: t('quest.toast.accepted', { title }), kind: 'info', chat: true })
      break
  }
  if (def && next && change.event !== 'accepted') {
    for (const o of def.objectives) {
      const before = objectiveCount(o, prev)
      const after = objectiveCount(o, next)
      if (after <= before) continue
      const goal = objectiveGoal(o)
      const line = objectiveLine(o, after, cat, names)
      if (goal > 1) out.push({ text: line, kind: o.type === 'collect' ? 'loot' : 'info' })
      else out.push({ text: t('quest.toast.objectiveDone', { line }), kind: 'info' })
      if (o.type === 'useItem' && o.text && after >= goal) out.push({ text: '', kind: 'info', vision: fillText(o.text, who).trim() })
    }
  }
  if (def && next?.status === 'ready' && prev?.status !== 'ready' && !def.disabled) out.push({ text: t('quest.toast.ready', { npc: names.npc(def.turnIn) }), kind: 'info', chat: true })
  return out
}
