/**
 * The equipment manifest contract (work/out/equipment/equipment.json), as consumed by composeEquipment().
 * Written by packages/convert (tools/export-equipment.ts, whose equipment/manifest.ts documents how Silkroad
 * composes a character and carries the same shapes); kept here so browser code needs no converter import.
 */
import type { EquipSlot } from '@sro/shared'

export const EQUIPMENT_MANIFEST_VERSION = 1
/** Path of the manifest relative to the converter output root (/out/). */
export const EQUIPMENT_MANIFEST = 'equipment/equipment.json'

/** BSR visual slots used by characters and equipment (packages/formats BSR_SLOT_NAMES). */
export type VisualSlot =
  | 'HAIR' | 'FACE' | 'TORSO_UPPER' | 'TORSO_LOWER' | 'OVERRIDE' | 'ARM_UPPER' | 'ARM_LOWER'
  | 'LEFT_HAND' | 'RIGHT_HAND' | 'SPEAR' | 'PELVIS' | 'THIGH' | 'CALF' | 'ATTACH_CAPE'

export type AttachMethod = 'BASE' | 'REPLACE' | 'ADD'
export type Gender = 'male' | 'female'
/** Armour classes (itemdata TypeID3 1/2/3), names as in packages/shared ArmorType. */
export type ArmorClass = 'garment' | 'protector' | 'armor'

export interface CharacterBody {
  /** CodeName128, e.g. CHAR_CH_MAN_ADVENTURER. */
  code: string
  gender: Gender
  bsr: string
  /** /out/ URL of the character glb. */
  glb: string
  /** BSK the skeleton comes from. */
  skeleton: string
  /** BASE slots: visual slot -> mesh node name in the character glb. */
  slots: Partial<Record<VisualSlot, string>>
}

export interface EquipmentModel {
  bsr: string
  /** /out/ URL of the converted glb. */
  glb: string
  /** /out/ URL of the converter sidecar. */
  sidecar: string
  kind: 'skinned' | 'socket'
  method: AttachMethod
  attachPoint: string | null
  slots: VisualSlot[]
  /** socket: bone of the character skeleton the model hangs under. */
  attachBone: string | null
  /** skinned: joint names of the skin, in order. */
  joints?: string[]
  /** skinned: mesh node names in the item glb. */
  meshes: string[]
}

export interface EquipmentItem {
  /** CodeName128, e.g. ITEM_CH_M_CLOTHES_01_BA_A_DEF. */
  code: string
  slot: EquipSlot
  /** null: either gender (shields, weapons). */
  gender: Gender | null
  armorClass?: ArmorClass
  /** Weapon family token (SWORD, BLADE, SPEAR, TBLADE, BOW). */
  weapon?: string
  twoHanded?: boolean
  degree: number
  reqLevel: number
  name: string | null
  /** null for items without a model (CA head items). */
  model: EquipmentModel | null
}

export interface EquipmentManifest {
  version: number
  generator?: string
  provenance?: string
  rules?: string[]
  characters: CharacterBody[]
  items: EquipmentItem[]
}

export function isEquipmentManifest(v: unknown): v is EquipmentManifest {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<EquipmentManifest>
  return m.version === EQUIPMENT_MANIFEST_VERSION && Array.isArray(m.characters) && Array.isArray(m.items)
}
