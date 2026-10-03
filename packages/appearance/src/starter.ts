/**
 * Character-creation choices of the original client (Media/resinfo/pscharactercreatechina.txt: Figure, Height,
 * Volume, Cloth, Arms) and the items they stand for. Cloth picks one of the three `*_DEF` starter sets
 * (garment / protector / armour chest, legs and feet); Arms picks the `*_DEF` starter weapon.
 */
import {
  APPEARANCE_STEPS,
  DEFAULT_HEIGHT,
  DEFAULT_VOLUME,
  STARTER_OUTFITS,
  STARTER_WEAPONS,
  type ClientMessage,
  type EquipSlot,
  type StarterOutfit,
  type StarterWeapon,
} from '@sro/shared'
import type { Gender } from './manifest.ts'
import { clampStep } from './scale.ts'

/** The `*_DEF` starter item of each starter weapon family. */
export const STARTER_WEAPON_ITEMS: Record<StarterWeapon, string> = {
  sword: 'ITEM_CH_SWORD_01_A_DEF',
  blade: 'ITEM_CH_BLADE_01_A_DEF',
  spear: 'ITEM_CH_SPEAR_01_A_DEF',
  glaive: 'ITEM_CH_TBLADE_01_A_DEF',
  bow: 'ITEM_CH_BOW_01_A_DEF',
}

/** Item class token of each starter outfit (ITEM_CH_<M|W>_<token>_01_<part>_A_DEF). */
export const OUTFIT_CLASS: Record<StarterOutfit, 'CLOTHES' | 'LIGHT' | 'HEAVY'> = {
  clothes: 'CLOTHES',
  light: 'LIGHT',
  heavy: 'HEAVY',
}

/** Armour class of each starter outfit (EquipmentItem.armorClass / ArmorType). */
export const OUTFIT_ARMOR_CLASS: Record<StarterOutfit, 'garment' | 'protector' | 'armor'> = {
  clothes: 'garment',
  light: 'protector',
  heavy: 'armor',
}

const OUTFIT_PARTS: ReadonlyArray<[EquipSlot, string]> = [['chest', 'BA'], ['legs', 'LA'], ['feet', 'FA']]

/** Chest, legs and feet of a starter outfit for a gender. */
export function starterOutfitItems(gender: Gender, outfit: StarterOutfit): Partial<Record<EquipSlot, string>> {
  const g = gender === 'female' ? 'W' : 'M'
  const out: Partial<Record<EquipSlot, string>> = {}
  for (const [slot, part] of OUTFIT_PARTS) out[slot] = `ITEM_CH_${g}_${OUTFIT_CLASS[outfit]}_01_${part}_A_DEF`
  return out
}

/** Everything a new character wears: the starter outfit plus the starter weapon. */
export function starterEquipment(gender: Gender, outfit: StarterOutfit, weapon: StarterWeapon): Partial<Record<EquipSlot, string>> {
  return { ...starterOutfitItems(gender, outfit), weapon: STARTER_WEAPON_ITEMS[weapon] }
}

/** The creation screen's choices (defaults: middle Height and Volume, garment). */
export interface CreationChoices {
  name: string
  model: string
  weapon: StarterWeapon
  height?: number
  volume?: number
  outfit?: StarterOutfit
}

export const DEFAULT_OUTFIT: StarterOutfit = 'clothes'

/** Step a creation carousel value by d (wrapping). */
export function stepChoice<T>(list: readonly T[], current: T, d: number): T {
  const i = Math.max(0, list.indexOf(current))
  return list[(i + d + list.length * 4) % list.length]!
}

/** Step a Height/Volume value by d (clamped to 0..4, no wrap, like the original arrows). */
export function stepScale(current: number, d: number): number {
  return Math.min(APPEARANCE_STEPS - 1, Math.max(0, current + d))
}

/** The charCreate request for a set of choices (always carries height, volume and outfit). */
export function buildCharCreate(c: CreationChoices): Extract<ClientMessage, { t: 'charCreate' }> {
  return {
    t: 'charCreate',
    name: c.name.trim(),
    model: c.model,
    weapon: STARTER_WEAPONS.includes(c.weapon) ? c.weapon : 'blade',
    height: clampStep(c.height, DEFAULT_HEIGHT),
    volume: clampStep(c.volume, DEFAULT_VOLUME),
    outfit: c.outfit && STARTER_OUTFITS.includes(c.outfit) ? c.outfit : DEFAULT_OUTFIT,
  }
}
