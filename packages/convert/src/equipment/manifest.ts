/**
 * Equipment manifest (work/out/equipment/equipment.json): what the game client and the model viewer need to dress a
 * character. Environment-neutral (no node:*), so browser code can import it through a relative path.
 *
 * How Silkroad composes a character (vSRO 1.188; evidence in tools/export-equipment.ts and
 * test/equipment.corpus.test.ts):
 *
 *  - Every BSR ends with a ResAttachable section: kind (0 CHAR, 1 ITEM), attach point (_ha _ba _la _fa _sa _aa,
 *    LEFT_HAND, RIGHT_HAND, CHAR), attach method (BASE 0 / REPLACE 1 / ADD 2) and a list of visual slots, each
 *    naming one of the resource's meshes (SilkroadDoc JMXVRES; enums in packages/formats/src/bsr.ts).
 *  - A player character BSR is BASE: its slots map the body to meshes, e.g. chinaman_adventurer
 *    HAIR -> chinaman_Adventurer_hair, FACE -> ..._face, TORSO_UPPER -> man_torso_upper, TORSO_LOWER, PELVIS,
 *    THIGH, CALF, ARM_UPPER, ARM_LOWER. All 13 men share the man_* body parts and europeman_skel.bsk; all 13
 *    women share woman_* (ARM_LOWER is woman_arm_fore) and europewoman_skel.bsk. Only hair and face differ.
 *  - An armour BSR (res/item/china/{man,woman}_item/<class>_<nn>_<part>.bsr) has no skeleton: its meshes carry
 *    their own bone palettes with Bip01 names and are skinned to the wearer's skeleton by name (every bone of
 *    all 531 Chinese armour/shield resources exists in the gender's skeleton).
 *  - REPLACE: the base meshes in the item's slots are hidden and the item mesh is drawn instead (a chest lists
 *    TORSO_UPPER/TORSO_LOWER, heavy chests also ARM_UPPER; trousers PELVIS/THIGH; boots CALF; heavy gloves
 *    ARM_LOWER; helmets HAIR). Measured: the listed parts are covered by the item (the normal line of every
 *    hidden body vertex hits the item or a visible neighbour within 10 cm; at most 4.5 cm on the starter sets).
 *  - ADD: nothing is hidden; the mesh is drawn over the body. Shoulder pads (slot OVERRIDE, which no body has;
 *    a few are REPLACE, which then hides nothing either)
 *    and garment/protector gloves (ARM_LOWER) are ADD: the gloves cover only 60-93 % of the bare forearm and
 *    hand, so hiding it would open holes.
 *  - Helmets REPLACE HAIR (the helmet covers only 26-65 % of the hair; the rest must disappear). CA head items
 *    ("crown") have no model at all: nothing is drawn and the hair stays. FACE is never replaced.
 *  - Shields and weapons have their own skeleton with an attach bone (Bip01 L Hand, Bip01 R HandMid, ...):
 *    rigid, drawn under that bone with the SRO socket rule (docs/CONVENTIONS.md "Attach rule"). So are the
 *    garment shoulder pieces (clothes_0N_sa: a collar on Bip01 Neck1): kind follows the BSR, not the item type.
 *  - Avatars/costumes (res/item/avatar, dress/hat/attach slots) use the same machinery and are out of scope.
 */
import type { EquipSlot } from '../../../shared/src/content.ts'

export const EQUIPMENT_MANIFEST_VERSION = 1
export const EQUIPMENT_DIR = 'equipment'
export const EQUIPMENT_MANIFEST = 'equipment/equipment.json'
export const EQUIPMENT_PROVENANCE = 'vSRO 1.188 client (Data.pk2 res/, Media.pk2 textdata)'

/** BSR visual slots used by characters and equipment (packages/formats BSR_SLOT_NAMES). */
export type VisualSlot =
  | 'HAIR' | 'FACE' | 'TORSO_UPPER' | 'TORSO_LOWER' | 'OVERRIDE' | 'ARM_UPPER' | 'ARM_LOWER'
  | 'LEFT_HAND' | 'RIGHT_HAND' | 'SPEAR' | 'PELVIS' | 'THIGH' | 'CALF' | 'ATTACH_CAPE'

export type AttachMethod = 'BASE' | 'REPLACE' | 'ADD'
export type Gender = 'male' | 'female'
/** Armour classes (itemdata TypeID3 1/2/3), names as in packages/shared ArmorType. */
export type ArmorClass = 'garment' | 'protector' | 'armor'

/**
 * How an item is drawn:
 *  skinned  meshes skinned to the wearer's skeleton (same joint names, order and inverse binds as the character
 *           glb): bind the item's skin to the character's joints; hides `hides` of the wearer's base meshes.
 *  socket   rigid model under `attachBone` with the SRO socket rule.
 *  none     no model (CA head items): nothing to draw, nothing hidden.
 */
export type EquipmentKind = 'skinned' | 'socket' | 'none'

export interface CharacterBody {
  /** CodeName128, e.g. CHAR_CH_MAN_ADVENTURER. */
  code: string
  gender: Gender
  bsr: string
  /** /out/ URL of the character glb (pnpm sro convert output). */
  glb: string
  /** BSK the skeleton comes from, e.g. prim/skel/char/europe/europeman_skel.bsk. */
  skeleton: string
  /** BASE slots: visual slot -> mesh node name in the character glb. */
  slots: Partial<Record<VisualSlot, string>>
}

export interface EquipmentModel {
  /** Item BSR in Data.pk2 (forward slashes). */
  bsr: string
  /** /out/ URL of the converted glb. */
  glb: string
  /** /out/ URL of the converter sidecar. */
  sidecar: string
  kind: 'skinned' | 'socket'
  method: AttachMethod
  /** ResAttachable attach point name (_ba, LEFT_HAND, ...). */
  attachPoint: string | null
  /** Visual slots the resource lists. */
  slots: VisualSlot[]
  /** socket: bone of the character skeleton the model hangs under. */
  attachBone: string | null
  /** skinned: joint names of the skin, in order (identical to the wearer's skeleton). */
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
  /** English name, when the string table has one. */
  name: string | null
  /** null for items without a model (CA head items). */
  model: EquipmentModel | null
}

export interface EquipmentManifest {
  version: number
  generator: string
  provenance: string
  /** Rules applied by compose(), spelled out for readers of the JSON. */
  rules: string[]
  characters: CharacterBody[]
  items: EquipmentItem[]
}

/** Per-item sidecar (next to the item glb). */
export interface EquipmentSidecar {
  code: string[]
  bsr: string
  gender: Gender | null
  kind: 'skinned' | 'socket'
  method: AttachMethod
  attachPoint: string | null
  slots: VisualSlot[]
  attachBone: string | null
  /** skinned + REPLACE: the base body meshes the item hides on this gender's characters. */
  hides: string[]
  skeleton: string | null
  joints: string[]
  /** skinned: measured coverage of each hidden body part by the item plus the parts that stay visible. */
  coverage?: CoverageReport[]
  provenance: string
}

export interface CoverageReport {
  slot: VisualSlot
  mesh: string
  vertices: number
  /**
   * Vertices above the ground whose normal line hits no visible surface within 10 cm and that have none within
   * 1.5 cm. Meaningless for HAIR: hair is a shell off the scalp that a helmet hides whole.
   */
  gaps: number
  /** Largest distance (m) along a normal from a hidden body vertex to the surface that replaces it. */
  maxOffsetM: number
}

export const MANIFEST_RULES = [
  'Items reference content by CodeName128; paths only say where the art lives today.',
  'skinned items bind to the wearer skeleton by joint name (same names, order and inverse binds).',
  'REPLACE hides the wearer base meshes in the item slots; ADD hides nothing; items never hide other items.',
  'socket items hang under attachBone with the bone bind-pose world rotation cancelled (SRO socket rule).',
  'A shield cannot be combined with a two-handed weapon.',
]

export function isEquipmentManifest(v: unknown): v is EquipmentManifest {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<EquipmentManifest>
  return m.version === EQUIPMENT_MANIFEST_VERSION && Array.isArray(m.characters) && Array.isArray(m.items)
}
