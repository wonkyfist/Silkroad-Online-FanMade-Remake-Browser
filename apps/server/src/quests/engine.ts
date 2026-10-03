import {
  MAX_ACTIVE_QUESTS,
  NPC_INTERACT_RANGE,
  PARTY_SHARE_RANGE,
  QUEST_ITEM_CODE,
  objectiveGoal,
  questLineText,
  type GameplayRequest,
  type QuestDef,
  type QuestDoneEntry,
  type QuestEvent,
  type QuestLineCondition,
  type QuestObjective,
  type QuestProgress,
  type QuestRefs,
  type QuestStatus,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import { done, fail, type Result } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Mob, Npc, Player } from '../world.ts'
import { QuestBook } from './book.ts'
import { Encounters, type LiveEncounter } from './encounter.ts'
import { countCode, takeCode, turnInTx } from './rewards.ts'
import { QuestStore, type DoneRecord } from './store.ts'

/**
 * The quest engine (docs/QUESTS.md §1.3, §1.5, §1.6; lane QS-S), a GameplayModule: everything reaches it through the
 * module hooks, never through gameplay.ts edits.
 *
 * - `enter` sends the `quests` snapshot (after skills, docs/PROTOCOL.md enter order); `forget` drops the runtime log.
 * - `request`: questAccept / questTurnIn / questAbandon / questTalk / questUseItem, exactly one actionResult each,
 *   sent before any effect.
 * - `mobDied(m, now, credit)`: kill and collect objectives for every credited player (decision 40: alive damage
 *   dealers plus the eligible party members, supplied by Gameplay / PartyManager). Quest drops never touch the
 *   ground: each credited player who needs one rolls for itself and it goes straight into its quest bag.
 * - `tickPlayer`: `reach` objectives (every QUEST_REACH_CHECK_MS per player); `inventoryChanged`: `have` recount
 *   (ready -> active when the bag drops below the count); `tick`: encounter despawn.
 * - `hasTopics(p, npc)`: wired into NpcDialogs.topics, so npcDialog.services gets 'quest'.
 * - `dialogLines(p, npc)` (wave 11, docs/UNIQUES.md §3.10, lane U-Q): wired into NpcDialogs.lines; the quest files'
 *   conditional greeting lines whose server fact holds now (QUEST_LINE_CONDITIONS: `uniqueAlive` -> the area).
 *
 * Quest items (QITEM_*) live only in the quest bag (`quest_items`), never in the inventory (decision 4). The runtime
 * log mirrors the database, which is written on every change.
 */

/** How often (ms) a player's open `reach` objectives are checked (docs/QUESTS.md §1.7). */
export const QUEST_REACH_CHECK_MS = 500

/** One active quest of a player (the runtime mirror of quest_state + quest_items). */
export interface ActiveQuest {
  quest: string
  rev: number
  status: QuestStatus
  counts: Record<string, number>
  acceptedAt: number
  /** Quest item code -> count (this quest's quest bag). */
  items: Map<string, number>
}

export interface QuestLog {
  active: Map<string, ActiveQuest>
  done: Map<string, DoneRecord>
  /** Next reach check (ms). */
  nextReachAt: number
}

type Obj = QuestObjective

/** The GameData refs the quest files are validated against (none when the export is missing: structure only). */
export function questRefs(g: Pick<Gameplay, 'data' | 'config'>): QuestRefs | undefined {
  const d = g.data
  if (d.mobs.size === 0 || d.items.size === 0 || d.npcs.length === 0) return undefined
  return { mobs: new Set(d.mobs.keys()), items: new Set(d.items.keys()), npcs: new Set(d.npcs.map((n) => n.code)), levelCap: g.config.levelCap }
}

/** The next daily reset (QUEST_DAILY_RESET_HOUR, server local time) strictly after `lastAt`. */
export function nextDailyReset(lastAt: number, hour: number): number {
  const d = new Date(lastAt)
  d.setHours(hour, 0, 0, 0)
  if (d.getTime() <= lastAt) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * The count of objective `id` (0 when unset). Own keys only: an objective id such as `constructor` must never read an
 * inherited Object.prototype member (NaN counts, frames the client parser refuses).
 */
export const countOf = (counts: Readonly<Record<string, number>>, id: string): number => (Object.hasOwn(counts, id) ? counts[id] : 0)

const complete = (o: Obj, counts: Record<string, number>): boolean => countOf(counts, o.id) >= objectiveGoal(o)

/** Whether `o` still waits for its `after` objective. */
function gated(def: QuestDef, o: Obj, counts: Record<string, number>): boolean {
  if (!o.after) return false
  const first = def.objectives.find((x) => x.id === o.after)
  return first !== undefined && !complete(first, counts)
}

/** Quest item codes a quest uses (grants, collect, deliver, useItem). */
function questItemCodes(def: QuestDef): Set<string> {
  const out = new Set<string>()
  for (const g of def.giveOnAccept ?? []) out.add(g.item)
  for (const o of def.objectives) if ((o.type === 'collect' || o.type === 'deliver' || o.type === 'useItem') && QUEST_ITEM_CODE.test(o.item)) out.add(o.item)
  return out
}

export class QuestEngine implements GameplayModule {
  readonly name = 'quests'
  readonly handles: readonly GameplayRequest[] = ['questAccept', 'questTurnIn', 'questAbandon', 'questTalk', 'questUseItem']
  /** A dead player may still abandon a quest (docs/WAVE_PLAN.md decision 36). */
  readonly whileDead: readonly GameplayRequest[] = ['questAbandon']
  /** The catalog (repo content + GM overrides). Replace it with setContent() so the logs are re-mapped. */
  book: QuestBook
  readonly store: QuestStore
  readonly encounters: Encounters
  /** Runtime logs by character id (loaded on enter, or on first use). */
  private readonly logs = new Map<number, QuestLog>()

  constructor(readonly g: Gameplay) {
    this.store = new QuestStore(g.store)
    this.encounters = new Encounters(g)
    this.book = this.loadBook()
  }

  // ---- content (hot reload, docs/QUESTS.md §5.4) ---------------------------------------------------------

  /**
   * Makes `book` the catalog (default: the current one after an in-place replace()/remove()), re-maps the logs of the
   * players in the world (counts kept for objective ids that still exist, clamped; status recomputed; quest items the
   * quest no longer uses dropped; `questUpdate changed` to each affected player) and tells everyone
   * `contentChanged {kind: 'quests', rev}`.
   */
  setContent(book: QuestBook = this.book): void {
    this.book = book
    for (const p of this.g.world.players.values()) {
      const log = this.logs.get(p.characterId)
      if (!log) continue
      let bag: ReturnType<Gameplay['store']['loadInventory']>['bag'] | null = null
      for (const a of log.active.values()) {
        const def = this.book.quest(a.quest)
        if (!def) continue
        bag ??= this.g.store.loadInventory(p.characterId).bag
        if (this.normalize(a, def, bag)) {
          this.saveAll(p, a)
          this.update(p, a, 'changed')
        }
      }
    }
    this.g.world.broadcast({ t: 'contentChanged', kind: 'quests', rev: this.book.rev })
  }

  /** Re-reads every quest file from disk (after an editor wrote an override) and re-maps (setContent). Returns the rev. */
  reloadContent(): number {
    // A fresh book with fresh refs (the NPC editor may have added NPCX_* codes since the last load).
    const next = this.loadBook()
    next.rev = this.book.rev + 1
    this.setContent(next)
    return this.book.rev
  }

  private loadBook(): QuestBook {
    const g = this.g
    return QuestBook.load({ contentDir: g.config.contentDir, dataDir: g.config.dataDir, refs: questRefs(g), log: (m) => g.config.log(m) })
  }

  // ---- log ---------------------------------------------------------------------------------------------

  /** The player's runtime log (loaded from the database on first use, re-mapped to the current content). */
  logOf(p: Player): QuestLog {
    let log = this.logs.get(p.characterId)
    if (log) return log
    const save = this.store.load(p.characterId)
    log = { active: new Map(), done: save.done, nextReachAt: 0 }
    let bag: ReturnType<Gameplay['store']['loadInventory']>['bag'] | null = null
    for (const s of save.active) {
      const a: ActiveQuest = { quest: s.quest, rev: s.rev, status: s.status, counts: s.counts, acceptedAt: s.acceptedAt, items: save.items.get(s.quest) ?? new Map() }
      log.active.set(a.quest, a)
      const def = this.book.quest(a.quest)
      if (!def) continue
      bag ??= this.g.store.loadInventory(p.characterId).bag
      if (this.normalize(a, def, bag)) this.saveAll(p, a)
    }
    this.logs.set(p.characterId, log)
    return log
  }

  /** The client view of an active quest. */
  progress(p: Player, a: ActiveQuest): QuestProgress {
    const out: QuestProgress = {
      quest: a.quest,
      rev: a.rev,
      status: a.status,
      counts: { ...a.counts },
      items: [...a.items].filter(([, n]) => n > 0).map(([code, count]) => ({ code, count })),
      acceptedAt: a.acceptedAt,
    }
    const until = this.encounters.untilFor(a.quest, p.characterId)
    if (until !== undefined) out.encounterUntil = until
    return out
  }

  /** When a completed quest can be taken again (repeatables), or undefined (never, or unknown quest). */
  availableAt(def: QuestDef | undefined, rec: DoneRecord): number | undefined {
    if (!def || def.kind !== 'repeatable' || !def.repeat) return undefined
    if ('reset' in def.repeat) return nextDailyReset(rec.lastAt, this.g.config.questDailyResetHour ?? 4)
    return rec.lastAt + def.repeat.cooldownSec * 1000
  }

  doneEntry(quest: string, rec: DoneRecord): QuestDoneEntry {
    const out: QuestDoneEntry = { quest, times: rec.times, lastAt: rec.lastAt }
    const at = this.availableAt(this.book.quest(quest), rec)
    if (at !== undefined) out.availableAt = at
    return out
  }

  /**
   * Brings `a` in line with `def`: counts only for existing objectives (clamped), collect counts from the quest bag,
   * `have` counts from `bag` (when given), quest items the quest no longer uses dropped, rev and status. Returns
   * whether anything changed.
   */
  private normalize(a: ActiveQuest, def: QuestDef, bag: readonly ({ code: string; count: number } | null)[] | null): boolean {
    const before = JSON.stringify([a.rev, a.status, a.counts, [...a.items]])
    const counts: Record<string, number> = {}
    for (const o of def.objectives) counts[o.id] = Math.max(0, Math.min(objectiveGoal(o), Math.floor(countOf(a.counts, o.id))))
    const used = questItemCodes(def)
    for (const code of [...a.items.keys()]) {
      const n = a.items.get(code) ?? 0
      if (!used.has(code) || n <= 0) a.items.delete(code)
      else if (n > this.book.itemStack(code)) a.items.set(code, this.book.itemStack(code))
    }
    this.derive(def, counts, a.items, bag)
    a.counts = counts
    a.rev = def.rev ?? 0
    a.status = def.objectives.every((o) => complete(o, counts)) ? 'ready' : 'active'
    return JSON.stringify([a.rev, a.status, a.counts, [...a.items]]) !== before
  }

  /** Derived counts: collect = quest items held (+ those a completed deliver of this quest handed in); have = the bag. */
  private derive(def: QuestDef, counts: Record<string, number>, items: ReadonlyMap<string, number>, bag: readonly ({ code: string; count: number } | null)[] | null): void {
    for (const o of def.objectives) {
      if (o.type === 'collect') {
        let delivered = 0
        for (const d of def.objectives) if (d.type === 'deliver' && d.item === o.item && complete(d, counts)) delivered += d.count
        counts[o.id] = Math.min(o.count, (items.get(o.item) ?? 0) + delivered)
      } else if (o.type === 'have' && bag) {
        counts[o.id] = gated(def, o, counts) ? 0 : Math.min(o.count, countCode(bag, o.item))
      }
    }
  }

  /** Recomputes the status from the counts. */
  private restatus(def: QuestDef, a: ActiveQuest): QuestStatus {
    a.status = def.objectives.every((o) => complete(o, a.counts)) ? 'ready' : 'active'
    return a.status
  }

  private saveAll(p: Player, a: ActiveQuest): void {
    this.store.saveQuest(p.characterId, a.quest, a.counts, a.status, a.rev, a.items)
  }

  private update(p: Player, a: ActiveQuest | null, event: QuestEvent, quest = a?.quest ?? '', extra: { objective?: string; done?: QuestDoneEntry } = {}): void {
    p.send({ t: 'questUpdate', quest, event, progress: a ? this.progress(p, a) : null, ...extra })
  }

  /** The event for a change: ready (the quest just became ready), objective (one completed), else progress. */
  private announce(p: Player, a: ActiveQuest, wasReady: boolean, objective: string | null): void {
    if (a.status === 'ready' && !wasReady) return this.update(p, a, 'ready')
    if (objective) return this.update(p, a, 'objective', a.quest, { objective })
    this.update(p, a, 'progress')
  }

  // ---- offers and topics -------------------------------------------------------------------------------

  /** Why `def` is not offered to `p` now (null: it is). docs/QUESTS.md §1.3 "Offered" and the accept reasons. */
  offerProblem(p: Player, def: QuestDef, now: number): Result<never> | null {
    const log = this.logOf(p)
    if (def.disabled) return fail('not_found', 'this quest was withdrawn')
    const level = p.progress.level
    if (level < def.level) return fail('requirements', `requires level ${def.level}`)
    if (def.maxLevel !== undefined && level > def.maxLevel) return fail('requirements', `only up to level ${def.maxLevel}`)
    for (const r of def.requires?.quests ?? []) if (!log.done.has(r)) return fail('requirements', 'an earlier quest comes first')
    if (log.active.has(def.id)) return fail('quest_active')
    const rec = log.done.get(def.id)
    if (rec) {
      const at = this.availableAt(def, rec)
      if (at === undefined) return fail('quest_done')
      if (now < at) return fail('cooldown', 'come back after the daily reset')
    }
    return null
  }

  /** Whether the NPC `code` (its identity) has an offered, ready, in-progress or talk/deliver topic for `p`. */
  /**
   * The quest files' greeting lines of NPC `code` whose condition holds now, `{area}` filled in (lane U-Q). Facts:
   * `uniqueAlive(mob)` = the uniques module's live field unique of that code and its area (no module = never).
   */
  dialogLines(_p: Player, code: string): string[] {
    const out: string[] = []
    for (const line of this.book.linesByNpc.get(code) ?? []) {
      const fact = this.lineFact(line.when)
      if (!fact) continue
      const text = questLineText(line, fact.area)
      if (text !== null) out.push(text)
    }
    return out
  }

  /** One condition of QUEST_LINE_CONDITIONS: null when it does not hold, else its fact (the area name, maybe ''). */
  private lineFact(when: QuestLineCondition): { area: string } | null {
    const alive = this.g.uniques?.alive(when.uniqueAlive) ?? null
    return alive ? { area: alive.area } : null
  }

  hasTopics(p: Player, code: string): boolean {
    const now = this.g.now
    for (const def of this.book.byGiver.get(code) ?? []) if (this.offerProblem(p, def, now) === null) return true
    for (const a of this.logOf(p).active.values()) {
      const def = this.book.quest(a.quest)
      if (!def || def.disabled) continue
      if (def.turnIn === code) return true
      for (const o of def.objectives) {
        if ((o.type === 'talk' || o.type === 'deliver') && o.npc === code && !complete(o, a.counts) && !gated(def, o, a.counts)) return true
      }
    }
    return false
  }

  // ---- requests ----------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'questAccept':
        return this.accept(p, msg.npc, msg.quest, answer, now)
      case 'questTurnIn':
        return this.turnIn(p, msg.npc, msg.quest, msg.choice, answer, now)
      case 'questAbandon':
        return this.abandon(p, msg.quest, answer, now)
      case 'questTalk':
        return this.talk(p, msg.npc, msg.quest, msg.objective, answer, now)
      case 'questUseItem':
        return this.useItem(p, msg.quest, msg.objective, answer, now)
    }
    answer(fail('not_found'))
  }

  /** The NPC entity `id` `p` may deal with: sent to its client and within NPC_INTERACT_RANGE. */
  private npcFor(p: Player, id: number, now: number): Result<Npc> {
    const npc = this.g.world.npcs.get(id)
    if (!npc || !p.known.has(id)) return fail('not_found')
    if (this.g.world.distance(p, npc, now) > NPC_INTERACT_RANGE) return fail('too_far')
    return done(npc)
  }

  accept(p: Player, npcId: number, quest: string, answer: Answer, now: number): void {
    const npc = this.npcFor(p, npcId, now)
    if (!npc.ok) return answer(npc)
    const def = this.book.quest(quest)
    if (!def || def.giver !== npc.value.code) return answer(fail('not_found'))
    const problem = this.offerProblem(p, def, now)
    if (problem) return answer(problem)
    const log = this.logOf(p)
    if (log.active.size >= MAX_ACTIVE_QUESTS) return answer(fail('quest_log_full'))
    const items = new Map<string, number>()
    for (const g of def.giveOnAccept ?? []) items.set(g.item, Math.min(this.book.itemStack(g.item), (items.get(g.item) ?? 0) + g.count))
    const a: ActiveQuest = { quest: def.id, rev: def.rev ?? 0, status: 'active', counts: {}, acceptedAt: now, items }
    this.normalize(a, def, this.needsBag(def) ? this.g.store.loadInventory(p.characterId).bag : null)
    this.checkReach(p, def, a, now)
    this.store.accept(p.characterId, { quest: a.quest, status: a.status, rev: a.rev, counts: a.counts, acceptedAt: a.acceptedAt }, a.items)
    log.active.set(a.quest, a)
    answer(true)
    this.update(p, a, 'accepted')
  }

  private needsBag(def: QuestDef): boolean {
    return def.objectives.some((o) => o.type === 'have')
  }

  turnIn(p: Player, npcId: number, quest: string, choice: number | undefined, answer: Answer, now: number): void {
    const npc = this.npcFor(p, npcId, now)
    if (!npc.ok) return answer(npc)
    const log = this.logOf(p)
    const a = log.active.get(quest)
    const def = this.book.quest(quest)
    if (!a || !def) return answer(fail('not_found'))
    if (def.disabled) return answer(fail('not_found', 'this quest was withdrawn'))
    if (def.turnIn !== npc.value.code) return answer(fail('not_found'))
    // `have` counts are live: recount before deciding.
    if (this.needsBag(def) && this.normalize(a, def, this.g.store.loadInventory(p.characterId).bag)) this.saveAll(p, a)
    if (a.status !== 'ready') return answer(fail('not_complete'))
    const picks = def.rewards.choice ?? []
    if (picks.length > 0) {
      if (choice === undefined) return answer(fail('choice_required'))
      if (choice < 0 || choice >= picks.length) return answer(fail('invalid_slot', 'no such reward'))
    }
    const takes = def.objectives.flatMap((o) => (o.type === 'have' && o.consume ? [{ code: o.item, count: o.count }] : []))
    const r = turnInTx(this.g, this.store, p, def, picks.length > 0 ? choice : undefined, takes, now)
    if (!r.ok) return answer(r)
    const t = r.value
    if (t.missing.length) this.g.config.log(`quest ${def.id}: reward items not in the export, skipped: ${t.missing.join(', ')}`)
    log.active.delete(quest)
    const prev = log.done.get(quest)
    const rec = { times: (prev?.times ?? 0) + 1, lastAt: now }
    log.done.set(quest, rec)
    answer(true)
    this.update(p, null, 'completed', quest, { done: this.doneEntry(quest, rec) })
    this.g.afterInventory(p, t.draft)
    if (t.exp > 0 || t.spExp > 0) this.g.applyProgress(p, t.next, t.levels, { exp: Math.round(t.exp), spExp: Math.round(t.spExp), quest })
  }

  abandon(p: Player, quest: string, answer: Answer, now = Date.now()): void {
    const log = this.logOf(p)
    if (!log.active.has(quest)) return answer(fail('not_found'))
    this.store.removeQuest(p.characterId, quest)
    log.active.delete(quest)
    this.encounters.abandon(quest, p.characterId, now)
    answer(true)
    this.update(p, null, 'abandoned', quest)
  }

  talk(p: Player, npcId: number, quest: string, objective: string, answer: Answer, now: number): void {
    const npc = this.npcFor(p, npcId, now)
    if (!npc.ok) return answer(npc)
    const a = this.logOf(p).active.get(quest)
    const def = this.book.quest(quest)
    if (!a || !def || def.disabled) return answer(fail('not_found'))
    const o = def.objectives.find((x) => x.id === objective)
    if (!o || (o.type !== 'talk' && o.type !== 'deliver') || o.npc !== npc.value.code) return answer(fail('not_found'))
    if (complete(o, a.counts)) return answer(fail('not_found', 'already done'))
    if (gated(def, o, a.counts)) return answer(fail('requirements', 'not yet'))
    const wasReady = a.status === 'ready'
    if (o.type === 'talk') {
      a.counts[o.id] = 1
      this.restatus(def, a)
      this.saveAll(p, a)
      answer(true)
      return this.announce(p, a, wasReady, o.id)
    }
    if (QUEST_ITEM_CODE.test(o.item)) {
      // A quest item hands in from the quest bag.
      const held = a.items.get(o.item) ?? 0
      if (held < o.count) return answer(fail('not_complete', `you need ${o.count}`))
      if (held === o.count) a.items.delete(o.item)
      else a.items.set(o.item, held - o.count)
      a.counts[o.id] = o.count
      this.derive(def, a.counts, a.items, null)
      this.restatus(def, a)
      this.saveAll(p, a)
      answer(true)
      return this.announce(p, a, wasReady, o.id)
    }
    // An ItemDef hands in from the bag, in one transaction with the new counts.
    const counts = { ...a.counts, [o.id]: o.count }
    const status: QuestStatus = def.objectives.every((x) => complete(x, counts)) ? 'ready' : 'active'
    const { result, draft } = this.g.store.inventoryTx(
      p.characterId,
      (d) => takeCode(d, o.item, o.count),
      () => this.store.saveCounts(p.characterId, a.quest, counts, status, a.rev),
    )
    if (!result.ok) return answer(result)
    a.counts = counts
    a.status = status
    answer(true)
    this.g.afterInventory(p, draft)
    this.announce(p, a, wasReady, o.id)
  }

  useItem(p: Player, quest: string, objective: string, answer: Answer, now: number): void {
    const a = this.logOf(p).active.get(quest)
    const def = this.book.quest(quest)
    if (!a || !def || def.disabled) return answer(fail('not_found'))
    const o = def.objectives.find((x) => x.id === objective)
    if (!o || o.type !== 'useItem') return answer(fail('not_found'))
    if ((a.items.get(o.item) ?? 0) < 1) return answer(fail('not_found', 'you do not have it'))
    if (gated(def, o, a.counts)) return answer(fail('requirements', 'not yet'))
    const loc = this.book.location(o.location)
    if (!loc) return answer(fail('not_found'))
    const [x, , z] = this.g.world.positionAt(p, now)
    if (Math.hypot(x - loc.x, z - loc.z) > loc.radius) return answer(fail('wrong_place', `use it at ${loc.name}`))
    const already = complete(o, a.counts)
    // Done already: an encounter may be summoned again while a later objective is open (it despawned unkilled).
    if (already && (!o.encounter || def.objectives.every((x) => x === o || complete(x, a.counts)))) return answer(fail('not_found', 'already done'))
    let owners: Set<number> | null = null
    if (o.encounter) {
      owners = this.groupOf(p)
      if (this.encounters.liveFor(def.id, owners)) return answer(fail('cooldown', 'It is already here.'))
      if (this.encounters.readyAt(def.id, p.characterId, now) > now) return answer(fail('cooldown'))
    }
    const wasReady = a.status === 'ready'
    if (!already) {
      a.counts[o.id] = 1
      if (o.consume) {
        const held = a.items.get(o.item) ?? 0
        if (held <= 1) a.items.delete(o.item)
        else a.items.set(o.item, held - 1)
      }
      this.restatus(def, a)
      this.saveAll(p, a)
    }
    answer(true)
    let spawned: LiveEncounter | null = null
    if (o.encounter && owners) spawned = this.encounters.spawn(p, def.id, o.id, o.encounter, owners, now)
    if (!already) this.announce(p, a, wasReady, o.id)
    else if (spawned) this.update(p, a, 'progress')
    // A party quest's use counts for every member within 60 m who has it open (docs/QUESTS.md §1.6).
    if (def.party && !already) {
      for (const q of this.partyNear(p, now)) {
        const qa = this.logOf(q).active.get(def.id)
        if (!qa || complete(o, qa.counts) || gated(def, o, qa.counts)) continue
        const qWasReady = qa.status === 'ready'
        qa.counts[o.id] = 1
        this.restatus(def, qa)
        this.saveAll(q, qa)
        this.announce(q, qa, qWasReady, o.id)
      }
    }
    if (spawned) {
      for (const q of this.g.world.players.values()) {
        if (q === p || !spawned.owners.has(q.characterId)) continue
        const qa = this.logs.get(q.characterId)?.active.get(def.id)
        if (qa) this.update(q, qa, 'progress')
      }
    }
  }

  /** Character ids of `p`'s owner group: itself plus its party members in the world. */
  groupOf(p: Player): Set<number> {
    const out = new Set([p.characterId])
    for (const q of this.g.world.players.values()) if (q !== p && this.g.party.sameParty(p, q)) out.add(q.characterId)
    return out
  }

  /** Alive party members of `p` within PARTY_SHARE_RANGE (XZ). */
  private partyNear(p: Player, now: number): Player[] {
    const [x, , z] = this.g.world.positionAt(p, now)
    const out: Player[] = []
    for (const q of this.g.world.players.values()) {
      if (q === p || q.dead || !this.g.party.sameParty(p, q)) continue
      const [qx, , qz] = this.g.world.positionAt(q, now)
      if (Math.hypot(qx - x, qz - z) <= PARTY_SHARE_RANGE) out.push(q)
    }
    return out
  }

  // ---- hooks -------------------------------------------------------------------------------------------

  enter(p: Player): void {
    // A fresh read: the database is the truth when a character (re)enters.
    this.logs.delete(p.characterId)
    const log = this.logOf(p)
    const active = [...log.active.values()].map((a) => this.progress(p, a))
    const doneList = [...log.done].map(([quest, rec]) => this.doneEntry(quest, rec))
    p.send({ t: 'quests', active, done: doneList, rev: this.book.rev })
  }

  forget(p: Player): void {
    this.logs.delete(p.characterId)
  }

  /** Kill and collect objectives for every credited player (docs/QUESTS.md §1.5, decision 40). */
  mobDied(m: Mob, now: number, credit: ReadonlySet<number>): void {
    if (m.encounter) this.encounterMobGone(m, now, true)
    const kills = this.book.killIndex.get(m.def.code)
    const drops = this.book.dropIndex.get(m.def.code)
    if (!kills && !drops) return
    for (const id of credit) {
      const p = this.g.world.players.get(id)
      if (!p) continue
      const log = this.logOf(p)
      const touched = new Map<string, { wasReady: boolean; objective: string | null }>()
      const touch = (a: ActiveQuest, objective: string | null) => {
        const t = touched.get(a.quest)
        if (!t) touched.set(a.quest, { wasReady: a.status === 'ready', objective })
        else if (objective) t.objective = objective
      }
      for (const k of kills ?? []) {
        const a = log.active.get(k.quest.id)
        const def = this.book.quest(k.quest.id)
        if (!a || def !== k.quest || def.disabled) continue
        const o = k.objective
        if (complete(o, a.counts) || gated(def, o, a.counts)) continue
        touch(a, null)
        a.counts[o.id] = countOf(a.counts, o.id) + 1
        if (complete(o, a.counts)) touch(a, o.id)
      }
      for (const d of drops ?? []) {
        const a = log.active.get(d.quest.id)
        const def = this.book.quest(d.quest.id)
        if (!a || def !== d.quest || def.disabled) continue
        const o = d.objective
        if (complete(o, a.counts) || gated(def, o, a.counts)) continue
        if (this.g.rng() >= d.chance) continue
        const held = a.items.get(d.item) ?? 0
        if (held >= this.book.itemStack(d.item)) continue
        touch(a, null)
        a.items.set(d.item, held + 1)
        this.derive(def, a.counts, a.items, null)
        const name = this.book.item(d.item)?.name ?? d.item
        p.send({ t: 'chat', channel: 'system', text: `${name} (${Math.min(o.count, countOf(a.counts, o.id))}/${o.count})` })
        if (complete(o, a.counts)) touch(a, o.id)
      }
      for (const [quest, t] of touched) {
        const a = log.active.get(quest)!
        const def = this.book.quest(quest)!
        this.restatus(def, a)
        this.saveAll(p, a)
        this.announce(p, a, t.wasReady, t.objective)
      }
    }
  }

  /** `reach` objectives, throttled per player (dead players are skipped by Gameplay). */
  tickPlayer(p: Player, now: number): void {
    const log = this.logs.get(p.characterId)
    if (!log || log.active.size === 0 || now < log.nextReachAt) return
    log.nextReachAt = now + QUEST_REACH_CHECK_MS
    for (const a of log.active.values()) {
      const def = this.book.quest(a.quest)
      if (!def || def.disabled || !def.objectives.some((o) => o.type === 'reach')) continue
      const wasReady = a.status === 'ready'
      const hit = this.checkReach(p, def, a, now)
      if (!hit) continue
      this.restatus(def, a)
      this.saveAll(p, a)
      this.announce(p, a, wasReady, hit)
    }
  }

  /** Completes the open reach objectives `p` stands in; returns the last one completed, or null. */
  private checkReach(p: Player, def: QuestDef, a: ActiveQuest, now: number): string | null {
    let hit: string | null = null
    let pos: [number, number] | null = null
    for (const o of def.objectives) {
      if (o.type !== 'reach' || complete(o, a.counts) || gated(def, o, a.counts)) continue
      const loc = this.book.location(o.location)
      if (!loc) continue
      if (!pos) {
        const at = this.g.world.positionAt(p, now)
        pos = [at[0], at[2]]
      }
      if (Math.hypot(pos[0] - loc.x, pos[1] - loc.z) > loc.radius) continue
      a.counts[o.id] = 1
      hit = o.id
    }
    if (hit) this.restatus(def, a)
    return hit
  }

  /** `have` recount after any inventory change (docs/QUESTS.md §1.5; ready -> active when the bag drops). */
  inventoryChanged(p: Player): void {
    const log = this.logs.get(p.characterId)
    if (!log) return
    let bag: ReturnType<Gameplay['store']['loadInventory']>['bag'] | null = null
    for (const a of log.active.values()) {
      const def = this.book.quest(a.quest)
      if (!def || !this.needsBag(def)) continue
      bag ??= this.g.store.loadInventory(p.characterId).bag
      const wasReady = a.status === 'ready'
      const before = { ...a.counts }
      this.derive(def, a.counts, a.items, bag)
      if (def.objectives.every((o) => countOf(before, o.id) === countOf(a.counts, o.id))) continue
      this.restatus(def, a)
      this.saveAll(p, a)
      const full = def.objectives.find((o) => o.type === 'have' && complete(o, a.counts) && !complete(o, before))
      this.announce(p, a, wasReady, full?.id ?? null)
    }
  }

  /**
   * An encounter mob died. A kill (`cooldown`) starts the owners' cooldown whoever got the credit; Gameplay calls this
   * with `cooldown` false for a GM kill (no rewards, no credit), which only ends the encounter.
   */
  encounterMobGone(m: Mob, now: number, cooldown: boolean): void {
    const ended = this.encounters.mobDied(m, now, cooldown)
    if (ended) this.encounterEnded(ended)
  }

  /** Encounter despawns (unkilled after despawnSec). */
  tick(now: number): void {
    for (const e of this.encounters.tick(now)) this.encounterEnded(e)
  }

  /** An encounter ended (killed or despawned): its owners' progress drops `encounterUntil`. */
  private encounterEnded(e: LiveEncounter): void {
    for (const q of this.g.world.players.values()) {
      if (!e.owners.has(q.characterId)) continue
      const a = this.logs.get(q.characterId)?.active.get(e.quest)
      if (a) this.update(q, a, 'progress')
    }
  }
}
