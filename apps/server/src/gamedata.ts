import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTENT_FILES,
  CODE_NAME,
  TOWNS_FILE,
  ZONES_FILE,
  checkDropTable,
  checkItemDef,
  checkLevelDef,
  checkMobDef,
  checkNestDef,
  checkZoneDef,
  contentEntries,
  type ContentKind,
  type DropTable,
  type EquipSlot,
  type ItemDef,
  type LevelDef,
  type MobDef,
  type NestDef,
  type NpcDef,
  type ShopDef,
  type StarterOutfit,
  type StarterWeapon,
  type TownDef,
  type ZoneDef,
} from '@sro/shared'
import { REGION_SIZE_M, regionAt } from './content.ts'

/**
 * Gameplay content read from OUT_DIR/data (docs/PROTOCOL.md "Content files"). Every file is optional: a missing
 * or unreadable file leaves that part of the game empty (no monsters, no items...) instead of stopping the
 * server. Bad records are skipped one by one and reported in the startup log.
 */

export type LoadedKind = 'mobs' | 'nests' | 'items' | 'levels' | 'drops' | 'npcs' | 'shops'

export const LOADED_KINDS: readonly LoadedKind[] = ['mobs', 'nests', 'items', 'levels', 'drops', 'npcs', 'shops']

export interface LoadReport {
  kind: LoadedKind
  /** Records kept. */
  count: number
  /** Records skipped as malformed. */
  skipped: number
  /** 'missing', 'ok' or an error message. */
  status: string
  /** The first few problems (for the log). */
  problems: string[]
}

export type ContentParts = Partial<{
  mobs: MobDef[]
  nests: NestDef[]
  items: ItemDef[]
  levels: LevelDef[]
  drops: DropTable[]
  npcs: NpcDef[]
  shops: ShopDef[]
  towns: TownDef[]
  zones: ZoneDef[]
}>

type Check = (v: unknown, where: string) => string[]

export type { TownDef, ZoneDef }

/** Reads towns.json leniently: records with a code, a world and a finite spawn; a malformed safe area is dropped. */
export function parseTowns(text: string | null): TownDef[] {
  if (text === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.entries) ? raw.entries : []
  const out: TownDef[] = []
  for (const t of list) {
    if (!isObj(t) || typeof t.code !== 'string' || typeof t.world !== 'string' || !isObj(t.spawn)) continue
    const sp = t.spawn
    if (!finite(sp.x) || !finite(sp.z)) continue
    const town: TownDef = { code: t.code, name: typeof t.name === 'string' ? t.name : t.code, world: t.world, spawn: { x: sp.x, y: finite(sp.y) ? sp.y : 0, z: sp.z } }
    const a = t.safeArea
    if (isObj(a) && finite(a.x) && finite(a.z) && finite(a.halfX) && finite(a.halfZ) && a.halfX > 0 && a.halfZ > 0) {
      town.safeArea = { x: a.x, z: a.z, halfX: a.halfX, halfZ: a.halfZ }
    }
    out.push(town)
  }
  return out
}

/**
 * Reads zones.json leniently (docs/FIELDS.md §6.2): the wrapper's `entries` (or a bare array), keeping the records
 * checkZoneDef accepts. Region names only label places (character list, GM `where`), so a bad file is never fatal.
 */
export function parseZones(text: string | null): ZoneDef[] {
  if (text === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.entries) ? raw.entries : []
  return list.filter((z, i) => checkZoneDef(z, `zones[${i}]`).length === 0) as ZoneDef[]
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function checkNpc(v: unknown, where: string): string[] {
  if (!isObj(v)) return [`${where}: expected an object`]
  const out: string[] = []
  if (typeof v.code !== 'string' || !CODE_NAME.test(v.code)) out.push(`${where}.code: expected a CodeName128 id`)
  if (!finite(v.x) || !finite(v.z)) out.push(`${where}: x/z must be finite numbers`)
  if (v.yaw !== undefined && !finite(v.yaw)) out.push(`${where}.yaw: expected a number`)
  if (typeof v.world !== 'string') out.push(`${where}.world: expected a string`)
  return out
}

function checkShop(v: unknown, where: string): string[] {
  if (!isObj(v)) return [`${where}: expected an object`]
  const out: string[] = []
  if (typeof v.id !== 'string' || v.id === '') out.push(`${where}.id: expected a string`)
  if (!Array.isArray(v.npcs) || !v.npcs.every((n) => typeof n === 'string')) out.push(`${where}.npcs: expected string[]`)
  if (!Array.isArray(v.tabs) || !v.tabs.every((t) => isObj(t) && Array.isArray(t.items) && t.items.every((i) => typeof i === 'string'))) {
    out.push(`${where}.tabs: expected {name, items[]}[]`)
  }
  return out
}

const CHECKS: Record<LoadedKind, Check> = {
  mobs: checkMobDef,
  nests: checkNestDef,
  items: checkItemDef,
  levels: checkLevelDef,
  drops: checkDropTable,
  npcs: checkNpc,
  shops: checkShop,
}

/** Parses one content file's text into its valid records, reporting what was skipped. */
export function parseContent<T>(kind: LoadedKind, text: string | null): { entries: T[]; report: LoadReport } {
  const report: LoadReport = { kind, count: 0, skipped: 0, status: 'missing', problems: [] }
  if (text === null) return { entries: [], report }
  let raw: unknown[]
  try {
    const json: unknown = JSON.parse(text)
    raw = contentEntries<unknown>(json, Array.isArray(json) ? undefined : (kind as ContentKind))
  } catch (e) {
    report.status = (e as Error).message
    return { entries: [], report }
  }
  const entries: T[] = []
  raw.forEach((e, i) => {
    const problems = CHECKS[kind](e, `${CONTENT_FILES[kind]}[${i}]`)
    if (problems.length === 0) entries.push(e as T)
    else {
      report.skipped++
      if (report.problems.length < 5) report.problems.push(...problems.slice(0, 5 - report.problems.length))
    }
  })
  report.status = 'ok'
  report.count = entries.length
  return { entries, report }
}

/** Gender of a Chinese player model code (CHAR_CH_WOMAN_* = female). */
export function genderOf(model: string): 'male' | 'female' {
  return /^CHAR_[A-Z]+_WOMAN_/.test(model) ? 'female' : 'male'
}

export class GameData {
  readonly mobs = new Map<string, MobDef>()
  readonly nests: NestDef[] = []
  readonly items = new Map<string, ItemDef>()
  /** levels[i] = LevelDef of level i + 1 (sorted, gaps filled by the nearest lower row). */
  readonly levels: LevelDef[] = []
  readonly drops = new Map<string, DropTable>()
  readonly npcs: NpcDef[] = []
  readonly shops = new Map<string, ShopDef>()
  /** Shop id per NPC code (from NpcDef.shop, then ShopDef.npcs). */
  readonly npcShop = new Map<string, string>()
  /**
   * GM-authored NPCs (NPCX_*) -> the npcs.json code whose model they wear. Filled with the DATA_DIR/content overrides
   * layered over npcs.json/nests.json by editors/overrides.ts `layerContentOverrides` (docs/QUESTS.md §5.1; lane ED-S).
   */
  readonly npcModel = new Map<string, string>()
  readonly towns: TownDef[] = []
  /** zones.json by region id (z << 8 | x). */
  readonly zones = new Map<number, ZoneDef>()
  /** Lower-cased zone name -> its majority spelling (zoneSpelling, built on first use). */
  private spellings: Map<string, string> | null = null
  readonly reports: LoadReport[] = []

  /** Reads every content file from OUT_DIR/data. Never throws. */
  static load(outDir: string): GameData {
    const read = (kind: LoadedKind): string | null => {
      try {
        return readFileSync(join(outDir, 'data', CONTENT_FILES[kind]), 'utf8')
      } catch {
        return null
      }
    }
    const parts: ContentParts = {}
    const reports: LoadReport[] = []
    for (const kind of LOADED_KINDS) {
      const { entries, report } = parseContent(kind, read(kind))
      ;(parts as Record<string, unknown[]>)[kind] = entries
      reports.push(report)
    }
    let towns: string | null = null
    try {
      towns = readFileSync(join(outDir, 'data', TOWNS_FILE), 'utf8')
    } catch {
      towns = null
    }
    parts.towns = parseTowns(towns)
    let zones: string | null = null
    try {
      zones = readFileSync(join(outDir, 'data', ZONES_FILE), 'utf8')
    } catch {
      zones = null
    }
    parts.zones = parseZones(zones)
    return new GameData(parts, reports)
  }

  constructor(parts: ContentParts = {}, reports: LoadReport[] = []) {
    this.reports = reports
    for (const m of parts.mobs ?? []) this.mobs.set(m.code, m)
    for (const i of parts.items ?? []) this.items.set(i.code, i)
    for (const d of parts.drops ?? []) this.drops.set(d.mob, d)
    for (const s of parts.shops ?? []) this.shops.set(s.id, s)
    this.nests.push(...(parts.nests ?? []))
    this.towns.push(...(parts.towns ?? []))
    for (const z of parts.zones ?? []) this.zones.set(z.region, z)
    this.npcs.push(...(parts.npcs ?? []))
    const levels = [...(parts.levels ?? [])].filter((l) => Number.isInteger(l.level) && l.level >= 1).sort((a, b) => a.level - b.level)
    for (const l of levels) {
      while (this.levels.length < l.level - 1) this.levels.push({ ...(this.levels.at(-1) ?? { exp: 0, masterySp: 0 }), level: this.levels.length + 1 })
      if (this.levels.length === l.level - 1) this.levels.push(l)
    }
    for (const s of this.shops.values()) for (const n of s.npcs) if (!this.npcShop.has(n)) this.npcShop.set(n, s.id)
    for (const n of this.npcs) if (n.shop && this.shops.has(n.shop)) this.npcShop.set(n.code, n.shop)
  }

  /** The first town of a world (its return point and safe area). */
  town(world: string): TownDef | undefined {
    return this.towns.find((t) => t.world === world)
  }

  /** Whether x/z lies in a town safe area of `world`. */
  inSafeArea(world: string, x: number, z: number): boolean {
    return this.towns.some((t) => t.world === world && t.safeArea && Math.abs(x - t.safeArea.x) <= t.safeArea.halfX && Math.abs(z - t.safeArea.z) <= t.safeArea.halfZ)
  }

  /**
   * The zones.json record of the region under x/z (world metres), given the world's region origin
   * (WorldSetup.regionOrigin); undefined outside the listed regions or without zones.json.
   */
  zoneAt(x: number, z: number, origin: { ox: number; oz: number } | null): ZoneDef | undefined {
    const r = regionAt(origin, x, z)
    return r ? this.zones.get(r.id) : undefined
  }

  /**
   * The client's English area name at x/z, by the client's own rule (apps/game world/map/zones.ts ZoneIndex.nameAt), so
   * the character list says what the HUD and the minimap say: the region's own name, else the named region of the 8
   * around it nearest to the point (a nameless region, docs/FIELDS.md §8), in the spelling most regions use ('Chinese
   * Tomb' over 'Chinese tomb'); '' outside the listed regions, without zones.json or with no named region near.
   */
  zoneName(x: number, z: number, origin: { ox: number; oz: number } | null): string {
    const r = regionAt(origin, x, z)
    if (!r || !origin) return ''
    const own = this.zones.get(r.id)
    if (own?.name) return this.zoneSpelling(own.name)
    let best = ''
    let bestD = Infinity
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const rx = r.rx + dx
        const rz = r.rz + dz
        if ((!dx && !dz) || rx < 0 || rx > 255 || rz < 0 || rz > 255) continue
        const e = this.zones.get((rz << 8) | rx)
        if (!e?.name) continue
        // distance (m) from the point to that region's square (region rx spans x from (rx - ox) * 192; z runs south)
        const x0 = (rx - origin.ox) * REGION_SIZE_M
        const z1 = -(rz - origin.oz) * REGION_SIZE_M
        const d = Math.hypot(Math.max(x0 - x, 0, x - (x0 + REGION_SIZE_M)), Math.max(z1 - REGION_SIZE_M - z, 0, z - z1))
        if (d < bestD) {
          bestD = d
          best = this.zoneSpelling(e.name)
        }
      }
    }
    return best
  }

  /** The spelling most zones.json regions use for a name, ignoring case (ties: the first in locale order, as the client). */
  private zoneSpelling(name: string): string {
    if (!this.spellings) {
      const votes = new Map<string, Map<string, number>>()
      for (const zone of this.zones.values()) {
        if (!zone.name) continue
        const v = votes.get(zone.name.toLowerCase()) ?? new Map<string, number>()
        v.set(zone.name, (v.get(zone.name) ?? 0) + 1)
        votes.set(zone.name.toLowerCase(), v)
      }
      this.spellings = new Map([...votes].map(([k, v]) => [k, [...v].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]]))
    }
    return this.spellings.get(name.toLowerCase()) ?? name
  }

  /** One log line per content kind. */
  summary(): string[] {
    const towns = this.towns.length ? [`content towns.json: ${this.towns.map((t) => `${t.name} (${t.world}${t.safeArea ? ', safe area' : ''})`).join(', ')}`] : ['content towns.json: missing or empty']
    const names = new Set([...this.zones.values()].map((z) => z.name).filter(Boolean))
    // optional file: a line only when it loaded
    const zones = this.zones.size ? [`content zones.json: ${this.zones.size} regions, ${names.size} area names`] : []
    return [...this.reports.map((r) => {
      const head = `content ${CONTENT_FILES[r.kind]}: `
      if (r.status === 'missing') return `${head}missing (none loaded)`
      if (r.status !== 'ok') return `${head}unreadable (${r.status})`
      const skipped = r.skipped ? `, ${r.skipped} skipped: ${r.problems.join('; ')}` : ''
      return `${head}${r.count} loaded${skipped}`
    }), ...towns, ...zones]
  }

  mob(code: string): MobDef | undefined {
    return this.mobs.get(code)
  }

  item(code: string): ItemDef | undefined {
    return this.items.get(code)
  }

  /** EXP needed to go from `level` to `level + 1`; 0 when unknown or at/after `cap`. */
  expToNext(level: number, cap: number): number {
    if (level >= cap) return 0
    return this.levels[level - 1]?.exp ?? 0
  }

  /**
   * The starter weapon of a family: the family's lowest-degree Chinese weapon with no level requirement,
   * preferring the client's `_DEF` (default) rows, e.g. ITEM_CH_SWORD_01_A_DEF.
   */
  starterWeapon(family: StarterWeapon): ItemDef | null {
    const candidates = [...this.items.values()].filter(
      (i) => i.category === 'weapon' && i.weaponType === family && i.reqLevel <= 1 && i.race !== 'europe',
    )
    return pickDefault(candidates)
  }

  /**
   * Default garment set for a gender: every Chinese garment with no level requirement whose code ends in `_DEF`
   * (the client's default clothes), one per slot; without such rows, the lowest-degree garment for chest, legs
   * and feet.
   */
  starterGarments(gender: 'male' | 'female'): ItemDef[] {
    const garments = [...this.items.values()].filter(
      (i) =>
        i.category === 'armor' &&
        i.armorType === 'garment' &&
        i.slot !== undefined &&
        i.reqLevel <= 1 &&
        i.race !== 'europe' &&
        (i.reqGender === gender || i.reqGender === 'any'),
    )
    const bySlot = new Map<string, ItemDef[]>()
    for (const g of garments) bySlot.set(g.slot!, [...(bySlot.get(g.slot!) ?? []), g])
    const defaults = [...bySlot.entries()].filter(([, list]) => list.some((i) => i.code.endsWith('_DEF')))
    if (defaults.length > 0) return defaults.map(([, list]) => pickDefault(list)!).filter(Boolean)
    const out: ItemDef[] = []
    for (const slot of ['chest', 'legs', 'feet'] as EquipSlot[]) {
      const pick = pickDefault(bySlot.get(slot) ?? [])
      if (pick) out.push(pick)
    }
    return out
  }

  /**
   * The default set of a starter outfit for a gender: the client's `ITEM_CH_{M|W}_{CLOTHES|LIGHT|HEAVY}_01_<part>_A_DEF`
   * rows (one per slot); without them, the same armour type's level-1 Chinese `_DEF` rows; for 'clothes' finally
   * starterGarments().
   */
  starterOutfit(gender: 'male' | 'female', outfit: StarterOutfit): ItemDef[] {
    const g = gender === 'male' ? 'M' : 'W'
    const exact = new RegExp(`^ITEM_CH_${g}_${outfit.toUpperCase()}_01_[A-Z]+_A_DEF$`)
    const type = OUTFIT_ARMOR_TYPE[outfit]
    const pick = (match: (i: ItemDef) => boolean): ItemDef[] => {
      const bySlot = new Map<string, ItemDef[]>()
      for (const i of this.items.values()) {
        if (i.category !== 'armor' || i.slot === undefined || i.reqLevel > 1 || i.race === 'europe') continue
        if (i.reqGender !== gender && i.reqGender !== 'any') continue
        if (match(i)) bySlot.set(i.slot, [...(bySlot.get(i.slot) ?? []), i])
      }
      return [...bySlot.values()].map((list) => pickDefault(list)!).filter(Boolean)
    }
    const sets = pick((i) => exact.test(i.code))
    if (sets.length > 0) return sets
    const typed = pick((i) => i.armorType === type && i.code.endsWith('_DEF'))
    if (typed.length > 0) return typed
    return outfit === 'clothes' ? this.starterGarments(gender) : []
  }

  /** Shop of an NPC code, if any. */
  shopOf(npcCode: string): ShopDef | undefined {
    const id = this.npcShop.get(npcCode)
    return id === undefined ? undefined : this.shops.get(id)
  }
}

/** Armour type of each starter outfit (ItemDef.armorType). */
const OUTFIT_ARMOR_TYPE: Record<StarterOutfit, ItemDef['armorType']> = { clothes: 'garment', light: 'protector', heavy: 'armor' }

/** `_DEF` rows first, then the lowest degree, then the lowest client id. */
function pickDefault(list: ItemDef[]): ItemDef | null {
  if (list.length === 0) return null
  return [...list].sort(
    (a, b) => Number(b.code.endsWith('_DEF')) - Number(a.code.endsWith('_DEF')) || a.degree - b.degree || a.id - b.id,
  )[0]
}
