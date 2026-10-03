/**
 * Quest intents (docs/QUESTS.md §6.3; WAVE_PLAN §2.2). Same style as hud/intents.ts: every builder returns a message
 * that passes the server's strict validator (parseClientMessage), or null when there is nothing sensible to send.
 * Nothing here changes local state; the server's `quests` / `questUpdate` decide what the windows show. No DOM.
 * Created by W4-FC; lane QS-C owns it afterwards.
 */
import { MAX_REWARD_CHOICES, OBJECTIVE_ID, QUEST_ID, type ClientMessage } from '@sro/shared'

type Msg<K extends ClientMessage['t']> = Extract<ClientMessage, { t: K }>

/** Longest quest id the server takes (validate.ts questId). */
const MAX_QUEST_ID = 64

const entityId = (n: number) => Number.isSafeInteger(n) && n >= 0
const questId = (s: string) => typeof s === 'string' && s.length <= MAX_QUEST_ID && QUEST_ID.test(s)
const objectiveId = (s: string) => typeof s === 'string' && OBJECTIVE_ID.test(s)

export const questIntent = {
  /** Accept `quest` from the NPC entity `npc` (its giver). */
  questAccept(npc: number, quest: string): Msg<'questAccept'> | null {
    return entityId(npc) && questId(quest) ? { t: 'questAccept', npc, quest } : null
  },
  /** Turn in at the NPC entity `npc`; `choice` = index into `rewards.choice` (required when the quest has choices). */
  questTurnIn(npc: number, quest: string, choice?: number): Msg<'questTurnIn'> | null {
    if (!entityId(npc) || !questId(quest)) return null
    if (choice === undefined) return { t: 'questTurnIn', npc, quest }
    return Number.isInteger(choice) && choice >= 0 && choice < MAX_REWARD_CHOICES ? { t: 'questTurnIn', npc, quest, choice } : null
  },
  questAbandon(quest: string): Msg<'questAbandon'> | null {
    return questId(quest) ? { t: 'questAbandon', quest } : null
  },
  /** A `talk` or `deliver` objective at the NPC entity `npc`. */
  questTalk(npc: number, quest: string, objective: string): Msg<'questTalk'> | null {
    return entityId(npc) && questId(quest) && objectiveId(objective) ? { t: 'questTalk', npc, quest, objective } : null
  },
  /** A `useItem` objective (the server checks the place). */
  questUseItem(quest: string, objective: string): Msg<'questUseItem'> | null {
    return questId(quest) && objectiveId(objective) ? { t: 'questUseItem', quest, objective } : null
  },
}
