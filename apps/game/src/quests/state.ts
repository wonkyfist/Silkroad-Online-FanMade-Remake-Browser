/**
 * The own quest log as the server describes it (docs/QUESTS.md §2.1): `quests` (snapshot after `inventory`) and
 * `questUpdate` (one quest, full replace). Keeps `active` and `done`, and answers what the NPC markers, the NPC
 * dialog and the log need: availability (level, prerequisites, repeat cooldowns), the marker of an NPC (§2.2
 * priority table) and the quest topics of an NPC. The server decides everything; this only mirrors it. No DOM.
 */
import { objectiveGoal, type QuestDef, type QuestDoneEntry, type QuestEvent, type QuestObjective, type QuestProgress, type ServerMessage } from '@sro/shared'
import type { QuestLookup } from './catalog.ts'

/** NPC marks, highest priority first (docs/QUESTS.md §2.2). */
export type QuestMark = 'ready' | 'talk' | 'available' | 'repeatable' | 'progress' | 'soon'
export const QUEST_MARKS: readonly QuestMark[] = ['ready', 'talk', 'available', 'repeatable', 'progress', 'soon']
/** A quest from an NPC shows the grey "soon" mark this many levels before it unlocks. */
export const SOON_LEVELS = 2
/** Daily repeatables reset at this local hour when the server sent no `availableAt` (server default). */
export const DAILY_RESET_HOUR = 4

export interface NpcMark {
  mark: QuestMark
  /** 'soon': the lowest level that unlocks a quest here. */
  level?: number
}

export type TopicKind = 'ready' | 'talk' | 'available' | 'repeatable' | 'progress'
const TOPIC_ORDER: Record<TopicKind, number> = { ready: 0, talk: 1, available: 2, repeatable: 3, progress: 4 }

/** One thing the player can talk about with an NPC. */
export interface QuestTopicRef {
  kind: TopicKind
  quest: QuestDef
  /** 'talk': the talk/deliver objective at this NPC. */
  objective?: Extract<QuestObjective, { type: 'talk' | 'deliver' }>
}

export type Availability = 'offered' | 'disabled' | 'active' | 'done' | 'cooldown' | 'requires' | 'level' | 'tooHigh'

// ---- objectives ------------------------------------------------------------------------------------------

/** Progress count of one objective (collect falls back to the quest items held; a ready quest counts as full). */
export function objectiveCount(o: QuestObjective, p: QuestProgress | null | undefined): number {
  if (!p) return 0
  const goal = objectiveGoal(o)
  const n = p.counts[o.id]
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), goal)
  if (o.type === 'collect') {
    const held = p.items.find(i => i.code === o.item)?.count ?? 0
    return Math.min(held, goal)
  }
  return p.status === 'ready' ? goal : 0
}

export function objectiveDone(o: QuestObjective, p: QuestProgress | null | undefined): boolean {
  return objectiveCount(o, p) >= objectiveGoal(o)
}

/** Gated by `after`: the named objective is not complete yet. */
export function objectiveLocked(o: QuestObjective, def: QuestDef, p: QuestProgress | null | undefined): boolean {
  if (!o.after) return false
  const before = def.objectives.find(x => x.id === o.after)
  return !!before && !objectiveDone(before, p)
}

/** Still to do and not gated. */
export function objectiveOpen(o: QuestObjective, def: QuestDef, p: QuestProgress | null | undefined): boolean {
  return !objectiveDone(o, p) && !objectiveLocked(o, def, p)
}

/**
 * The useItem objective the Use button acts on: an open one, or a done one with an encounter that can be summoned
 * again (a later objective is still open, no encounter lives, the item is still held). Null when none.
 */
export function usableObjective(def: QuestDef, p: QuestProgress, now: number): Extract<QuestObjective, { type: 'useItem' }> | null {
  for (const o of def.objectives) {
    if (o.type !== 'useItem') continue
    if (objectiveOpen(o, def, p)) return o
    const held = p.items.find(i => i.code === o.item)?.count ?? 0
    const live = p.encounterUntil !== undefined && p.encounterUntil > now
    if (o.encounter && !live && held > 0 && objectiveDone(o, p) && def.objectives.some(x => x !== o && !objectiveDone(x, p))) return o
  }
  return null
}

/** Next local `hour`:00 strictly after `at` (ms). */
export function nextReset(at: number, hour = DAILY_RESET_HOUR): number {
  const d = new Date(at)
  d.setHours(hour, 0, 0, 0)
  if (d.getTime() <= at) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// ---- state -----------------------------------------------------------------------------------------------

export interface QuestChange {
  /** 'reset' (worldEnter), 'snapshot' (`quests`), 'update' (`questUpdate`). */
  kind: 'reset' | 'snapshot' | 'update'
  quest?: string
  event?: QuestEvent
  prev?: QuestProgress | null
  next?: QuestProgress | null
  objective?: string
  done?: QuestDoneEntry
}

export class QuestState {
  readonly active = new Map<string, QuestProgress>()
  readonly done = new Map<string, QuestDoneEntry>()
  /** Catalog revision the last snapshot named (-1 before one). */
  rev = -1
  /** False until the first `quests` snapshot. */
  known = false
  private readonly listeners = new Set<(c: QuestChange) => void>()

  onChange(fn: (c: QuestChange) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Applies a server message; returns what changed (null = not a quest message). Listeners run after. */
  apply(msg: ServerMessage): QuestChange | null {
    let change: QuestChange | null = null
    switch (msg.t) {
      case 'worldEnter':
        this.active.clear()
        this.done.clear()
        this.known = false
        change = { kind: 'reset' }
        break
      case 'quests':
        this.active.clear()
        this.done.clear()
        for (const p of msg.active) this.active.set(p.quest, p)
        for (const d of msg.done) this.done.set(d.quest, d)
        this.rev = msg.rev
        this.known = true
        change = { kind: 'snapshot' }
        break
      case 'questUpdate': {
        const prev = this.active.get(msg.quest) ?? null
        if (msg.progress) this.active.set(msg.quest, msg.progress)
        else this.active.delete(msg.quest)
        if (msg.done) this.done.set(msg.quest, msg.done)
        change = { kind: 'update', quest: msg.quest, event: msg.event, prev, next: msg.progress, objective: msg.objective, done: msg.done }
        break
      }
      default:
        return null
    }
    for (const fn of [...this.listeners]) {
      try {
        fn(change)
      } catch (err) {
        console.error('[quests] state listener failed', err)
      }
    }
    return change
  }

  /** Active quests, oldest first. */
  activeList(): QuestProgress[] {
    return [...this.active.values()].sort((a, b) => a.acceptedAt - b.acceptedAt || (a.quest < b.quest ? -1 : 1))
  }

  isDone(id: string): boolean {
    return this.done.has(id)
  }

  /** When a done repeatable can be taken again (server ms); null = never (not repeatable) or not done. */
  availableAt(def: QuestDef): number | null {
    const d = this.done.get(def.id)
    if (!d) return null
    if (def.kind !== 'repeatable' || !def.repeat) return null
    if (typeof d.availableAt === 'number') return d.availableAt
    if ('cooldownSec' in def.repeat) return d.lastAt + def.repeat.cooldownSec * 1000
    return nextReset(d.lastAt)
  }

  /** Whether `def` is offered to a character of `level` at server time `now` (docs/QUESTS.md §1.3 "Offered"). */
  availability(def: QuestDef, level: number, now: number): Availability {
    if (def.disabled) return 'disabled'
    if (this.active.has(def.id)) return 'active'
    if (this.done.has(def.id)) {
      const at = this.availableAt(def)
      if (at === null) return 'done'
      if (at > now) return 'cooldown'
    }
    for (const r of def.requires?.quests ?? []) if (!this.done.has(r)) return 'requires'
    if (level < def.level) return 'level'
    if (def.maxLevel !== undefined && level > def.maxLevel) return 'tooHigh'
    return 'offered'
  }

  /** The highest-priority mark over the NPC identity `npc` (docs/QUESTS.md §2.2), or null. */
  markFor(npc: string, level: number, now: number, cat: QuestLookup): NpcMark | null {
    let best = QUEST_MARKS.length
    let soon = Infinity
    const take = (m: QuestMark) => {
      best = Math.min(best, QUEST_MARKS.indexOf(m))
    }
    for (const q of cat.turnedInAt(npc)) {
      const p = this.active.get(q.id)
      if (!p || q.disabled) continue
      take(p.status === 'ready' ? 'ready' : 'progress')
    }
    if (best > 0) {
      for (const q of cat.talkedAt(npc)) {
        const p = this.active.get(q.id)
        if (!p || q.disabled) continue
        if (q.objectives.some(o => (o.type === 'talk' || o.type === 'deliver') && o.npc === npc && objectiveOpen(o, q, p))) take('talk')
      }
    }
    for (const q of cat.givenBy(npc)) {
      const a = this.availability(q, level, now)
      if (a === 'offered') take(q.kind === 'repeatable' ? 'repeatable' : 'available')
      else if (a === 'level' && q.level - level <= SOON_LEVELS) {
        take('soon')
        soon = Math.min(soon, q.level)
      }
    }
    if (best >= QUEST_MARKS.length) return null
    const mark = QUEST_MARKS[best]!
    return mark === 'soon' ? { mark, level: soon } : { mark }
  }

  /** What the player can talk about with `npc`: turn-ins, talk/deliver objectives, offers, quests in progress. */
  topicsFor(npc: string, level: number, now: number, cat: QuestLookup): QuestTopicRef[] {
    const out: QuestTopicRef[] = []
    const seen = new Set<string>()
    for (const q of cat.turnedInAt(npc)) {
      const p = this.active.get(q.id)
      if (!p) continue
      // A withdrawn quest can be looked at (progress page) but not turned in.
      out.push({ kind: p.status === 'ready' && !q.disabled ? 'ready' : 'progress', quest: q })
      seen.add(q.id)
    }
    for (const q of cat.talkedAt(npc)) {
      const p = this.active.get(q.id)
      if (!p || q.disabled) continue
      for (const o of q.objectives) {
        if ((o.type === 'talk' || o.type === 'deliver') && o.npc === npc && objectiveOpen(o, q, p)) out.push({ kind: 'talk', quest: q, objective: o })
      }
    }
    for (const q of cat.givenBy(npc)) {
      if (seen.has(q.id)) continue
      if (this.availability(q, level, now) === 'offered') out.push({ kind: q.kind === 'repeatable' ? 'repeatable' : 'available', quest: q })
    }
    // A quest in progress that has a talk here is reached through the talk.
    const talking = new Set(out.filter(t => t.kind === 'talk').map(t => t.quest.id))
    return out
      .filter(t => t.kind !== 'progress' || !talking.has(t.quest.id))
      .map((t, i) => ({ t, i }))
      .sort((a, b) => TOPIC_ORDER[a.t.kind] - TOPIC_ORDER[b.t.kind] || a.t.quest.level - b.t.quest.level || a.i - b.i)
      .map(x => x.t)
  }
}

/** NPC identity of an entity (docs/WAVE_PLAN.md decision 43): authored NPCs send `npc`, the rest are their model. */
export function npcIdentity(state: { npc?: string; model: string }): string {
  return state.npc ?? state.model
}
