/**
 * The quest section of the NPC dialog (docs/QUESTS.md §2.3): the topics an NPC has for this character and the page
 * each one opens: Offer (Accept / Decline), Progress, Talk/deliver (Continue / Hand over, sends `questTalk`) and
 * Complete (reward choice, sends `questTurnIn`). Pages are plain data; `dialog-panel.ts` draws them in the NPC dialog
 * window, and only that adapter knows the host window. Requests go through `env.request`, which answers whether the
 * message went out (the panel then waits for the server's `questUpdate` or refusal). No DOM.
 */
import { MAX_ACTIVE_QUESTS, type ClientMessage, type QuestDef, type QuestObjective } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { QuestLookup } from './catalog.ts'
import { formatWait, objectiveLine, objectiveViews, paragraphs, rewardsView, type QuestNames, type QuestReader, type RewardView } from './format.ts'
import { questIntent } from './intents.ts'
import { objectiveCount, type QuestState, type QuestTopicRef, type TopicKind } from './state.ts'

export interface NpcDialogContext {
  /** NPC entity id (the requests name it). */
  npcId: number
  /** NPC identity code (`npcDialog.code`). */
  npcCode: string
  npcName: string
}

export interface NpcDialogPager {
  show(page: NpcDialogPage): void
  /** Back to the topic list (or the NPC's services). */
  back(): void
  close(): void
}

export interface PageObjective {
  text: string
  done: boolean
  locked?: boolean
}

export interface PageRewards {
  exp: number
  sp: number
  gold: number
  items: RewardView[]
  choice: RewardView[]
  /** Index into `choice` picked so far. */
  chosen?: number
  /** Picks a choice (the page is shown again). Absent = choices are only shown. */
  choose?(index: number): void
}

export interface PageButton {
  label: string
  kind?: 'primary' | 'normal'
  disabled?: boolean
  onClick(): void
}

export interface NpcDialogPage {
  /** The topic key ('quest:JG_003'); the panel keeps it to redraw the same page. */
  key: string
  title: string
  /** Plain text, `{name}` already filled. */
  paragraphs: string[]
  objectives?: PageObjective[]
  rewards?: PageRewards
  /** Short lines under the text (level, group, log full, withdrawn). */
  notes?: string[]
  buttons: PageButton[]
}

export type TopicIcon = 'quest-available' | 'quest-ready' | 'quest-progress' | 'quest-talk' | 'quest-repeatable'

export interface NpcDialogTopic {
  /** 'quest:JG_003' ('quest:JG_004:bun' for a talk objective). */
  key: string
  /** The option line. */
  label: string
  icon: TopicIcon
  order: number
  quest: string
  kind: TopicKind
  open(pager: NpcDialogPager): void
}

/** What the pages need from the game. */
export interface QuestDialogEnv {
  reader(): QuestReader
  /** Server time (ms). */
  now(): number
  names: QuestNames
  /** levels.json `exp` of a level (EXP percentage rewards). */
  expToNext(level: number): number
  /** Sends a quest request for `quest`; true when it went out. */
  request(msg: ClientMessage | null, quest: string): boolean
}

const ICONS: Record<TopicKind, TopicIcon> = { ready: 'quest-ready', talk: 'quest-talk', available: 'quest-available', repeatable: 'quest-repeatable', progress: 'quest-progress' }
const ORDER: Record<TopicKind, number> = { ready: 0, talk: 1, available: 2, repeatable: 3, progress: 4 }

/** The quest topics of one NPC for this character, in dialog order. */
export function questTopics(ctx: NpcDialogContext, quests: QuestState, catalog: QuestLookup, env: QuestDialogEnv): NpcDialogTopic[] {
  const who = env.reader()
  return quests.topicsFor(ctx.npcCode, who.level, env.now(), catalog).map(ref => topicOf(ctx, ref, quests, catalog, env))
}

function topicOf(ctx: NpcDialogContext, ref: QuestTopicRef, quests: QuestState, catalog: QuestLookup, env: QuestDialogEnv): NpcDialogTopic {
  const key = ref.objective ? `quest:${ref.quest.id}:${ref.objective.id}` : `quest:${ref.quest.id}`
  return {
    key,
    label: ref.kind === 'repeatable' && ref.quest.repeat && 'reset' in ref.quest.repeat ? t('quest.topic.daily', { title: ref.quest.title }) : t(`quest.topic.${ref.kind}`, { title: ref.quest.title }),
    icon: ICONS[ref.kind],
    order: ORDER[ref.kind],
    quest: ref.quest.id,
    kind: ref.kind,
    open: pager => pager.show(topicPage(ctx, ref, quests, catalog, env, pager)),
  }
}

/** The page a topic opens (docs/QUESTS.md §2.3). */
export function topicPage(ctx: NpcDialogContext, ref: QuestTopicRef, quests: QuestState, catalog: QuestLookup, env: QuestDialogEnv, pager: NpcDialogPager): NpcDialogPage {
  switch (ref.kind) {
    case 'available':
    case 'repeatable':
      return offerPage(ctx, ref.quest, quests, catalog, env, pager)
    case 'talk':
      return talkPage(ctx, ref.quest, ref.objective!, quests, catalog, env, pager)
    case 'ready':
      return completePage(ctx, ref.quest, catalog, env, pager)
    case 'progress':
      return progressPage(ref.quest, quests, catalog, env, pager)
  }
}

function kindNotes(def: QuestDef): string[] {
  const notes: string[] = []
  if (def.kind === 'repeatable') notes.push(t(def.repeat && 'reset' in def.repeat ? 'quest.daily' : 'quest.repeatable'))
  if (def.party) notes.push(t('quest.partyRecommended'))
  return notes
}

function pageRewards(def: QuestDef, env: QuestDialogEnv): PageRewards {
  return rewardsView(def, env.reader(), env.expToNext, env.names)
}

export function offerPage(ctx: NpcDialogContext, def: QuestDef, quests: QuestState, catalog: QuestLookup, env: QuestDialogEnv, pager: NpcDialogPager): NpcDialogPage {
  const who = env.reader()
  const full = quests.active.size >= MAX_ACTIVE_QUESTS
  const notes = [t('quest.log.level', { level: def.level }), ...kindNotes(def)]
  if (full) notes.push(t('quest.logFull', { n: quests.active.size, max: MAX_ACTIVE_QUESTS }))
  return {
    key: `quest:${def.id}`,
    title: def.title,
    paragraphs: paragraphs(def.dialog.offer, who),
    objectives: objectiveViews(def, null, catalog, env.names).map(v => ({ text: v.text, done: false, locked: v.locked })),
    rewards: pageRewards(def, env),
    notes,
    buttons: [
      { label: t('quest.accept'), kind: 'primary', disabled: full, onClick: () => void env.request(questIntent.questAccept(ctx.npcId, def.id), def.id) },
      { label: t('quest.decline'), onClick: () => pager.back() },
    ],
  }
}

export function progressPage(def: QuestDef, quests: QuestState, catalog: QuestLookup, env: QuestDialogEnv, pager: NpcDialogPager): NpcDialogPage {
  const p = quests.active.get(def.id) ?? null
  const notes: string[] = []
  if (def.disabled) notes.push(t('quest.withdrawn'))
  return {
    key: `quest:${def.id}`,
    title: def.title,
    paragraphs: paragraphs(def.dialog.progress, env.reader()),
    objectives: objectiveViews(def, p, catalog, env.names).map(v => ({ text: v.text, done: v.done, locked: v.locked })),
    notes,
    buttons: [{ label: t('quest.close'), onClick: () => pager.back() }],
  }
}

export function talkPage(
  ctx: NpcDialogContext,
  def: QuestDef,
  o: Extract<QuestObjective, { type: 'talk' | 'deliver' }>,
  quests: QuestState,
  catalog: QuestLookup,
  env: QuestDialogEnv,
  pager: NpcDialogPager,
): NpcDialogPage {
  const p = quests.active.get(def.id) ?? null
  const objectives = o.type === 'deliver' ? [{ text: objectiveLine(o, objectiveCount(o, p), catalog, env.names), done: false }] : undefined
  return {
    key: `quest:${def.id}:${o.id}`,
    title: def.title,
    paragraphs: paragraphs(o.text, env.reader()),
    objectives,
    buttons: [
      { label: t(o.type === 'deliver' ? 'quest.handOver' : 'quest.continue'), kind: 'primary', onClick: () => void env.request(questIntent.questTalk(ctx.npcId, def.id, o.id), def.id) },
      { label: t('quest.back'), onClick: () => pager.back() },
    ],
  }
}

/** The turn-in page; with reward choices, Complete waits for a pick (`choose` redraws the page). */
export function completePage(ctx: NpcDialogContext, def: QuestDef, catalog: QuestLookup, env: QuestDialogEnv, pager: NpcDialogPager, chosen?: number): NpcDialogPage {
  const rewards = pageRewards(def, env)
  const needChoice = rewards.choice.length > 0
  const pick = needChoice && chosen !== undefined && chosen >= 0 && chosen < rewards.choice.length ? chosen : undefined
  rewards.chosen = pick
  if (needChoice) rewards.choose = i => pager.show(completePage(ctx, def, catalog, env, pager, i))
  const notes = needChoice && pick === undefined ? [t('quest.chooseFirst')] : []
  return {
    key: `quest:${def.id}`,
    title: def.title,
    paragraphs: paragraphs(def.dialog.complete, env.reader()),
    rewards,
    notes,
    buttons: [
      {
        label: t('quest.complete'),
        kind: 'primary',
        disabled: needChoice && pick === undefined,
        onClick: () => void env.request(questIntent.questTurnIn(ctx.npcId, def.id, pick), def.id),
      },
      { label: t('quest.back'), onClick: () => pager.back() },
    ],
  }
}

/** "Available again in 3 h 20 min" for a repeatable on cooldown, else null. */
export function cooldownNote(def: QuestDef, quests: QuestState, now: number): string | null {
  const at = quests.availableAt(def)
  return at !== null && at > now ? t('quest.availableIn', { time: formatWait(at - now) }) : null
}
