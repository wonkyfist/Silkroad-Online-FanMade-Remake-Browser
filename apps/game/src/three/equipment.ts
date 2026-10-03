/**
 * The equipment manifest (/out/equipment/equipment.json, packages/convert tools/export-equipment.ts), fetched once
 * per page and indexed for @sro/appearance composeEquipment. Missing manifest = players wear only their weapon.
 */
import { EQUIPMENT_MANIFEST, indexManifest, isEquipmentManifest, type EquipmentLookup, type Gender } from '@sro/appearance'
import { OUT_PREFIX } from './slim.ts'

let lookup: Promise<EquipmentLookup | null> | null = null

export function equipmentLookup(): Promise<EquipmentLookup | null> {
  lookup ??= (async () => {
    try {
      const res = await fetch(OUT_PREFIX + EQUIPMENT_MANIFEST, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as unknown
      if (!isEquipmentManifest(data)) throw new Error('unexpected format')
      return indexManifest(data)
    } catch (err) {
      console.warn(`[models] ${OUT_PREFIX}${EQUIPMENT_MANIFEST} unavailable; characters are drawn without armour`, err)
      return null
    }
  })()
  return lookup
}

/** Gender of a character model code (manifest first, else the CodeName128 pattern). */
export function characterGender(code: string, l: EquipmentLookup | null): Gender {
  return l?.characters.get(code)?.gender ?? (/_WOMAN_|_FEMALE|_W_/.test(code) ? 'female' : 'male')
}
