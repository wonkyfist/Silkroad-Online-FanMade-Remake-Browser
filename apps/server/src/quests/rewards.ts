import {
  CHARACTER_RULES,
  armorClassToken,
  expandRewardCode,
  questRewardExp,
  type ArmorClassToken,
  type QuestDef,
  type StarterOutfit,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import { addGold, addItem, done, fail, type InvDraft, type Result } from '../inventory.ts'
import type { Progress } from '../progression.ts'
import type { Player } from '../world.ts'
import type { QuestStore } from './store.ts'

/**
 * Quest turn-in rewards (docs/QUESTS.md §1.3; lane QS-S).
 *
 * - Reward codes expand `{G}` / `{ARMOR}` per character (shared `expandRewardCode`): the gender of the model and the
 *   armour class of the equipped chest item, else the creation outfit.
 * - EXP = the shared `questRewardExp` (rewards.exp + expPctOfLevel % of the level's EXP); SP = sp x 400 SP-EXP, so the
 *   SP-EXP path of `gainExp` stays the only one. At the level cap the EXP would be lost: with QUEST_CAP_EXP_TO_SPEXP
 *   (default on) it is added as SP-EXP instead (decision 40).
 * - The turn-in is ONE SQLite transaction (`store.inventoryTx(..., extra)`): take the consumed `have` items, add the
 *   reward items and gold, delete the state and the quest items, record the completion and save the new progress
 *   (`g.computeReward` works on a copy). The caller announces after the commit (`g.afterInventory`, then
 *   `g.applyProgress(p, next, levels, { exp, spExp, quest })`; decision 42).
 */

export interface RewardWho {
  gender: 'male' | 'female'
  armor: ArmorClassToken
}

/** Who the reward codes are expanded for: the character's gender and the armour class of its chest (else outfit). */
export function rewardWho(g: Gameplay, p: Player): RewardWho {
  const chest = p.equip.chest ? g.data.item(p.equip.chest.code)?.armorType : undefined
  let outfit: StarterOutfit | undefined
  if (!chest) outfit = g.store.characterById(p.characterId)?.outfit
  return { gender: p.gender, armor: armorClassToken(chest, outfit) }
}

/** The items a turn-in gives: every `rewards.items` entry plus the chosen `rewards.choice` entry, codes expanded. */
export function rewardItems(def: QuestDef, who: RewardWho, choice?: number): { code: string; count: number }[] {
  const out: { code: string; count: number }[] = []
  for (const r of def.rewards.items ?? []) out.push({ code: expandRewardCode(r.item, who), count: r.count ?? 1 })
  const picks = def.rewards.choice ?? []
  if (picks.length > 0 && choice !== undefined && picks[choice]) out.push({ code: expandRewardCode(picks[choice].item, who), count: picks[choice].count ?? 1 })
  return out
}

/**
 * EXP and SP-EXP of a turn-in at the character's current level. At the cap the EXP becomes SP-EXP when
 * `capToSpExp` is on (QUEST_CAP_EXP_TO_SPEXP).
 */
export function turnInGain(def: QuestDef, level: number, levelCap: number, expToNext: (level: number) => number, capToSpExp = true): { exp: number; spExp: number } {
  let exp = questRewardExp(def.rewards, level, expToNext)
  let spExp = Math.max(0, Math.floor(def.rewards.sp)) * CHARACTER_RULES.spExpPerSp
  if (level >= levelCap && capToSpExp) {
    spExp += exp
    exp = 0
  }
  return { exp, spExp }
}

/** Takes `count` of an ItemDef code from the bag, from the last slots first (fewest moves in the first slots). */
export function takeCode(d: InvDraft, code: string, count: number): Result {
  let have = 0
  for (const it of d.bag) if (it?.code === code) have += it.count
  if (have < count) return fail('not_complete', `you need ${count}`)
  let left = count
  for (let i = d.bagSize - 1; i >= 0 && left > 0; i--) {
    const it = d.bag[i]
    if (!it || it.code !== code) continue
    const n = Math.min(left, it.count)
    d.setBag(i, n === it.count ? null : { ...it, count: it.count - n })
    left -= n
  }
  return done(undefined)
}

/** How many of an ItemDef code the bag holds. */
export function countCode(bag: readonly ({ code: string; count: number } | null)[], code: string): number {
  let n = 0
  for (const it of bag) if (it?.code === code) n += it.count
  return n
}

export interface TurnInResult {
  draft: InvDraft
  next: Progress
  levels: number
  exp: number
  spExp: number
  /** Reward codes the export does not know (skipped, logged). */
  missing: string[]
}

/**
 * The turn-in transaction. `takes` are the consumed `have` items. Fails (and changes nothing) with `inventory_full`
 * when the rewards do not fit, `not_complete` when a consumed item is gone.
 */
export function turnInTx(g: Gameplay, quests: QuestStore, p: Player, def: QuestDef, choice: number | undefined, takes: { code: string; count: number }[], now: number): Result<TurnInResult> {
  const cap = g.config.levelCap
  const { exp, spExp } = turnInGain(def, p.progress.level, cap, (l) => g.data.expToNext(l, cap), g.config.questCapExpToSpExp !== false)
  const { next, levels } = g.computeReward(p, exp, spExp)
  const items = rewardItems(def, rewardWho(g, p), choice)
  const missing: string[] = []
  const { result, draft } = g.store.inventoryTx(
    p.characterId,
    (d) => {
      for (const t of takes) {
        const r = takeCode(d, t.code, t.count)
        if (!r.ok) return r
      }
      for (const it of items) {
        const itemDef = g.data.item(it.code)
        if (!itemDef) {
          missing.push(it.code)
          continue
        }
        const r = addItem(d, itemDef, it.count)
        if (!r.ok) return r
      }
      if (def.rewards.gold > 0) addGold(d, def.rewards.gold)
      return done(undefined)
    },
    () => {
      quests.turnIn(p.characterId, def.id, now)
      g.store.saveProgress(p.characterId, next)
    },
  )
  if (!result.ok) return result
  return done({ draft, next, levels, exp, spExp, missing })
}
