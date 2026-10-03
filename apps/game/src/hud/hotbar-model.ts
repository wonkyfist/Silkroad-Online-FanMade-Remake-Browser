/**
 * The hotbar's rules without DOM (docs/SKILLS.md §10.3; docs/WAVE_PLAN.md decision 7): 40 slots in 4 pages of 10
 * (keys 1-0, pages F1-F4), what a slot shows and whether it is greyed out, and the message pressing it sends:
 * `useSkill` with the group's highest learned row and the fitting target, or `itemUse` of the lowest bag slot that
 * holds the entry's item. The server stays the judge; greying is a hint.
 */
import { HOTBAR_SLOTS, type ClientMessage, type EquipSlot, type HotbarEntry, type ItemDef, type ItemStack, type SkillDef } from '@sro/shared'
import { weaponFamilyOf } from '../content/catalog.ts'
import type { SkillCatalog, SkillState } from '../content/skills.ts'
import { itemCooldownKey, skillCooldownKey } from './cooldowns.ts'
import { intent } from './intents.ts'

export const HOTBAR_PAGE_SIZE = 10
export const HOTBAR_PAGES = HOTBAR_SLOTS / HOTBAR_PAGE_SIZE
/** KeyboardEvent.key of the 10 visible slots, left to right. */
export const HOTBAR_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const
/** Page keys F1-F4. */
export const HOTBAR_PAGE_KEYS = ['f1', 'f2', 'f3', 'f4'] as const

/** Absolute slot (0..39) of visible slot `i` on `page`. */
export function hotbarSlot(page: number, i: number): number {
  return page * HOTBAR_PAGE_SIZE + i
}

/** Why a slot is greyed out. */
export type SlotBlock = 'not_learned' | 'no_item' | 'mp' | 'weapon' | 'requirements'

/** What the hotbar needs to know about the character (the HUD's inventory, stats and catalogs). */
export interface HotbarContext {
  catalog: SkillCatalog
  state: SkillState
  item(code: string): ItemDef | undefined
  bagSize: number
  bag(i: number): ItemStack | null
  equipped(slot: EquipSlot): ItemStack | null
  /** Current MP and max MP (null before the first `stats`). */
  mp: number | null
  maxMp: number | null
}

export interface ResolvedSlot {
  entry: HotbarEntry
  /** Skill: the row to send (the highest learned, else the entry's own code). Item: the item code. */
  code: string
  icon: string | null
  /** Items: how many the bag holds in all. */
  count?: number
  /** Items: the lowest bag index holding the code. */
  bag?: number
  cooldownKey: string | null
  block: SlotBlock | null
}

/** Lowest bag index holding `code` (-1 when none). */
export function bagIndexOf(ctx: Pick<HotbarContext, 'bagSize' | 'bag'>, code: string): number {
  for (let i = 0; i < ctx.bagSize; i++) if (ctx.bag(i)?.code === code) return i
  return -1
}

/** Why the character cannot use `def` right now as far as the client can tell (null = looks fine). */
export function skillBlock(def: SkillDef, ctx: HotbarContext): SlotBlock | null {
  if (!ctx.state.isLearned(def.code)) return 'not_learned'
  if (def.weapons.length) {
    const w = ctx.equipped('weapon')
    const family = w ? weaponFamilyOf(w.code, ctx.item(w.code)) : undefined
    if (!family || !def.weapons.includes(family)) return 'weapon'
  }
  const req = def.requiresItem
  if (req) {
    const worn = (['weapon', 'shield'] as const).map(s => ctx.equipped(s)).filter((x): x is ItemStack => !!x)
    if (!worn.some(s => ctx.item(s.code)?.typeId[2] === req.typeId3 && ctx.item(s.code)?.typeId[3] === req.typeId4)) return 'requirements'
  }
  if (ctx.mp !== null) {
    const need = def.mp + Math.ceil(((def.mpPct ?? 0) * (ctx.maxMp ?? 0)) / 100)
    if (ctx.mp < need) return 'mp'
  }
  return null
}

/** What a hotbar entry shows and does now. */
export function resolveSlot(entry: HotbarEntry, ctx: HotbarContext): ResolvedSlot {
  if (entry.kind === 'item') {
    const def = ctx.item(entry.code)
    let count = 0
    let bag = -1
    for (let i = 0; i < ctx.bagSize; i++) {
      const s = ctx.bag(i)
      if (s?.code !== entry.code) continue
      count += s.count
      if (bag < 0) bag = i
    }
    const group = def?.use?.cooldownGroup
    return {
      entry,
      code: entry.code,
      icon: def?.icon ?? null,
      count,
      ...(bag >= 0 ? { bag } : {}),
      cooldownKey: group ? itemCooldownKey(group) : null,
      block: bag < 0 ? 'no_item' : null,
    }
  }
  const group = ctx.catalog.groupOf(entry.code)
  const code = ctx.state.code(group) ?? entry.code
  const def = ctx.catalog.get(code)
  return {
    entry,
    code,
    icon: ctx.catalog.icon(code),
    cooldownKey: skillCooldownKey(group),
    block: def ? skillBlock(def, ctx) : ctx.state.isLearned(code) ? null : 'not_learned',
  }
}

/** The selected target, as the hotbar sees it. */
export interface TargetRef {
  id: number
  kind: 'player' | 'mob' | 'npc' | 'item'
  dead: boolean
}

/**
 * The `target` of a useSkill (SKILLS.md §10.1 step 5; decision 13): skills that need no target send none; friendly
 * skills take the selected player (a corpse for resurrection) and fall back to yourself; enemy skills need a live
 * selected monster (no PvP), else 'need_target' and nothing is sent.
 */
export function skillTarget(def: SkillDef | undefined, selected: TargetRef | null, selfId: number | null): { target?: number } | 'need_target' {
  const tg = def?.targets
  if (!tg || !tg.required) return {}
  const enemy = tg.groups.some(g => g === 'enemy_mob' || g === 'enemy_player' || g === 'neutral' || g === 'any')
  if (enemy) return selected && selected.kind === 'mob' && !selected.dead ? { target: selected.id } : 'need_target'
  if (tg.deadBody) return selected && selected.kind === 'player' && selected.dead ? { target: selected.id } : 'need_target'
  if (selected && selected.kind === 'player' && !selected.dead) return { target: selected.id }
  return selfId !== null ? { target: selfId } : {}
}

/** The message pressing a resolved slot sends (null: nothing to send, e.g. no item left). */
export function slotMessage(r: ResolvedSlot, def: SkillDef | undefined, selected: TargetRef | null, selfId: number | null): ClientMessage | 'need_target' | null {
  if (r.entry.kind === 'item') return r.bag === undefined ? null : intent.itemUse(r.bag)
  const tgt = skillTarget(def, selected, selfId)
  if (tgt === 'need_target') return tgt
  return intent.useSkill(r.code, tgt.target)
}

/** Whether an item can sit on the hotbar (decision 7: consumables only). */
export function hotbarItemAllowed(def: ItemDef | undefined): boolean {
  return !!def?.use
}

/**
 * Messages for dropping `entry` on `to` when it came from hotbar slot `from` (a move: the two slots swap), or from
 * outside the hotbar (`from` null: the slot is overwritten).
 */
export function hotbarDrop(hotbar: readonly (HotbarEntry | null)[], entry: HotbarEntry, from: number | null, to: number): ClientMessage[] {
  if (from === to) return []
  const out: ClientMessage[] = []
  const set = intent.hotbarSet(to, entry)
  if (set) out.push(set)
  if (from !== null) {
    const back = intent.hotbarSet(from, hotbar[to] ?? null)
    if (back) out.push(back)
  }
  return out
}
