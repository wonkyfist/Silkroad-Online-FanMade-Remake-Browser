/**
 * Pure character + equipment composition (no node:*, no Babylon): given a character model code and the item codes
 * it wears, which of its base meshes to show or hide and which item glbs to bind, and how. The rules are the ones
 * documented in packages/convert/src/equipment/manifest.ts; the game client, the model viewer and the converter
 * tests all call this.
 */
import { EQUIP_SLOTS, type EquipSlot } from '@sro/shared'
import type { CharacterBody, EquipmentItem, EquipmentManifest, VisualSlot } from './manifest.ts'

export interface BoundItem {
  code: string
  slot: EquipSlot
  kind: 'skinned' | 'socket'
  /** /out/ URL. */
  glb: string
  /** socket items: bone to hang under (SRO socket rule). */
  attachBone: string | null
  /** skinned items: joint names the item skin expects (bind by name to the character's joints). */
  joints: string[]
  meshes: string[]
}

export interface RejectedItem {
  code: string
  reason: 'unknown' | 'gender' | 'slot_taken' | 'two_handed'
  detail: string
}

export interface Composition {
  character: CharacterBody
  /** Base meshes of the character that stay visible, in slot order. */
  show: string[]
  /** Base meshes hidden by REPLACE items. */
  hide: string[]
  /** Hidden base mesh -> item codes that hide it. */
  hiddenBy: Record<string, string[]>
  /** Items to draw (skinned first, then socket), in the order given. */
  bind: BoundItem[]
  /** Equipped items that have no model (CA head items): worn, nothing drawn. */
  invisible: string[]
  rejected: RejectedItem[]
}

export interface EquipmentLookup {
  characters: Map<string, CharacterBody>
  items: Map<string, EquipmentItem>
}

export function indexManifest(manifest: EquipmentManifest): EquipmentLookup {
  return {
    characters: new Map(manifest.characters.map(c => [c.code, c])),
    items: new Map(manifest.items.map(i => [i.code, i])),
  }
}

/**
 * One item per equip slot (a later code for the same slot replaces the earlier one, which is reported), items of
 * the other gender are refused, and a shield is refused next to a two-handed weapon.
 */
export function composeEquipment(source: EquipmentManifest | EquipmentLookup, characterCode: string,
  itemCodes: readonly string[]): Composition {
  const lookup = 'version' in source ? indexManifest(source) : source
  const character = lookup.characters.get(characterCode)
  if (!character) throw new Error(`unknown character ${JSON.stringify(characterCode)}`)
  const rejected: RejectedItem[] = []
  const bySlot = new Map<EquipSlot, EquipmentItem>()
  for (const code of itemCodes) {
    const item = lookup.items.get(code)
    if (!item) {
      rejected.push({ code, reason: 'unknown', detail: 'not in the equipment manifest' })
      continue
    }
    if (item.gender && item.gender !== character.gender) {
      rejected.push({ code, reason: 'gender', detail: `${item.gender} item on a ${character.gender} character` })
      continue
    }
    const previous = bySlot.get(item.slot)
    if (previous) rejected.push({ code: previous.code, reason: 'slot_taken', detail: `${item.slot} is taken by ${code}` })
    bySlot.set(item.slot, item)
  }
  const weapon = bySlot.get('weapon')
  const shield = bySlot.get('shield')
  if (weapon?.twoHanded && shield) {
    rejected.push({ code: shield.code, reason: 'two_handed', detail: `${weapon.code} is two-handed` })
    bySlot.delete('shield')
  }

  const worn = itemCodes.map(c => lookup.items.get(c)).filter((i): i is EquipmentItem => !!i && bySlot.get(i.slot) === i)
  const hiddenSlots = new Map<VisualSlot, string[]>()
  const bind: BoundItem[] = []
  const invisible: string[] = []
  for (const item of worn) {
    const m = item.model
    if (!m) {
      invisible.push(item.code)
      continue
    }
    if (m.kind === 'skinned' && m.method === 'REPLACE') {
      for (const s of m.slots) hiddenSlots.set(s, [...(hiddenSlots.get(s) ?? []), item.code])
    }
    bind.push({ code: item.code, slot: item.slot, kind: m.kind, glb: m.glb, attachBone: m.attachBone, joints: m.joints ?? [], meshes: m.meshes })
  }
  bind.sort((a, b) => Number(a.kind === 'socket') - Number(b.kind === 'socket'))

  const show: string[] = []
  const hide: string[] = []
  const hiddenBy: Record<string, string[]> = {}
  for (const [slot, mesh] of Object.entries(character.slots) as Array<[VisualSlot, string]>) {
    const by = hiddenSlots.get(slot)
    if (by) {
      if (!hide.includes(mesh)) hide.push(mesh)
      hiddenBy[mesh] = [...new Set([...(hiddenBy[mesh] ?? []), ...by])]
    } else if (!show.includes(mesh)) show.push(mesh)
  }
  // A mesh shared by several slots is hidden when any of them is replaced.
  return { character, show: show.filter(m => !hide.includes(m)), hide, hiddenBy, bind, invisible, rejected }
}

/** composeEquipment for a worn-items record (EntityState.equip / CharacterSummary.equip), in EQUIP_SLOTS order. */
export function composeWorn(source: EquipmentManifest | EquipmentLookup, characterCode: string,
  equip: Partial<Record<EquipSlot, string>> | undefined): Composition {
  return composeEquipment(source, characterCode, wornCodes(equip))
}

/** The item codes of a worn-items record, in EQUIP_SLOTS order. */
export function wornCodes(equip: Partial<Record<EquipSlot, string>> | undefined): string[] {
  if (!equip) return []
  return EQUIP_SLOTS.map(s => equip[s]).filter((c): c is string => typeof c === 'string' && c.length > 0)
}

/** Joint names of `wanted` missing from `available` (a skinned item binds only when this is empty). */
export function missingJoints(wanted: readonly string[], available: Iterable<string>): string[] {
  const have = new Set(available)
  return wanted.filter(j => !have.has(j))
}
