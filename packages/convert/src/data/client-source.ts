/**
 * The client textdata tables the content export reads (Media.pk2 server_dep/silkroad/textdata). Pure over a
 * TextdataReader, so tests can feed synthetic tables. Column meanings: docs/DATA.md and packages/formats/src/textdata.ts.
 */
import {
  buildStringMap,
  characterDataRow,
  itemDataRow,
  levelDataRow,
  levelGoldRow,
  loadTextdataTable,
  npcPosRow,
  skillDataRow,
  type CharacterDataRow,
  type ItemDataRow,
  type LevelDataRow,
  type LevelGoldRow,
  type NpcPosRow,
  type SkillDataRow,
  type TextdataReader,
} from '@sro/formats'

export interface ClientSources {
  characters: CharacterDataRow[]
  items: ItemDataRow[]
  /** Plaintext skilldata_*.txt rows (the *enc twins are not needed: the plaintext files are in this client). */
  skills: SkillDataRow[]
  levels: LevelDataRow[]
  levelGold: LevelGoldRow[]
  npcPos: NpcPosRow[]
  /** Raw cells of the smaller tables, keyed by file name (see TABLES). */
  tables: Record<RawTable, string[][]>
  /**
   * English text of textuisystem + textdataname (the equip/skill, object and new string tables), plus each NPC's
   * greeting under npcGreetingKey(code) (npcchat.txt -> textquest_speech&name.txt; docs/SHOPS.md §1.1, §7.5).
   */
  strings: Map<string, string>
}

/** Tables read as raw cells. */
export const RAW_TABLES = [
  'refregion.txt',
  'teleportdata.txt',
  'refshopgroup.txt',
  'refmappingshopgroup.txt',
  'refmappingshopwithtab.txt',
  'refshoptab.txt',
  'refshopgoods.txt',
  'refscrapofpackageitem.txt',
  'skillmasterydata.txt',
  'skilleffect.txt',
] as const

export type RawTable = (typeof RAW_TABLES)[number]

export const CONTENT_STRING_TABLES = ['textuisystem.txt', 'textdataname.txt'] as const

/** npcchat.txt: Service, OwnerCodeName_128 (NPC code), msg1_strid_128 (the _BS greeting id), msg2_strid_128 (_PS). */
export const NPC_CHAT_TABLE = 'npcchat.txt'
/** The NPC speech strings (same language columns as the other string tables; English = col 8). */
export const NPC_SPEECH_TABLE = 'textquest_speech&name.txt'

/**
 * The strings-map key of an NPC's greeting. It is not a client string id (the _BS id does not always follow the
 * NPC code: NPC_BATTLE_ARENA_MANAGER -> SN_NPC_SD_ARENA_MANAGER_BS), so it cannot collide with one.
 */
export const npcGreetingKey = (npcCode: string): string => `npcchat:${npcCode}`

/**
 * NPC code -> English greeting: each live npcchat row's _BS id looked up in the speech strings. Rows whose id has no
 * (or an empty) English text are left out, so the game shows its generic line. The first live row per NPC wins.
 */
export function npcGreetings(npcchat: readonly (readonly string[])[], speech: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of npcchat) {
    const code = c[1]?.trim()
    if (c[0]?.trim() !== '1' || !code || out.has(code)) continue
    const text = textOf(speech, c[2]?.trim())
    if (text) out.set(code, text)
  }
  return out
}

export function loadClientSources(read: TextdataReader): ClientSources {
  const rows = (name: string) => loadTextdataTable(name, read).rows
  const tables = {} as Record<RawTable, string[][]>
  for (const t of RAW_TABLES) tables[t] = rows(t).map(r => r.cells)
  const strings = buildStringMap(CONTENT_STRING_TABLES.flatMap(t => rows(t)), 'english')
  const speech = buildStringMap(rows(NPC_SPEECH_TABLE).filter(r => r.cells.length >= 3), 'english')
  for (const [code, text] of npcGreetings(rows(NPC_CHAT_TABLE).map(r => r.cells), speech)) strings.set(npcGreetingKey(code), text)
  return {
    characters: rows('characterdata.txt').map(characterDataRow),
    items: rows('itemdata.txt').map(itemDataRow),
    skills: rows('skilldata.txt').map(skillDataRow),
    levels: rows('leveldata.txt').map(levelDataRow),
    levelGold: rows('levelgold.txt').map(levelGoldRow),
    npcPos: rows('npcpos.txt').map(npcPosRow),
    tables,
    strings,
  }
}

/** Service 1 rows only; later rows with the same code do not replace earlier ones. */
export function indexByCode<T extends { codeName: string; service: boolean }>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const r of rows) if (r.service && !out.has(r.codeName)) out.set(r.codeName, r)
  return out
}

export function indexById<T extends { id: number; service: boolean }>(rows: readonly T[]): Map<number, T> {
  const out = new Map<number, T>()
  for (const r of rows) if (r.service && !out.has(r.id)) out.set(r.id, r)
  return out
}

/** Joymax writes line breaks as the two characters '\n'. */
export const unescapeText = (s: string) => s.replace(/\\n/g, '\n')

/** English text for a string key; null when the key is absent or empty. */
export function textOf(strings: ReadonlyMap<string, string>, key: string | undefined): string | null {
  if (!key) return null
  const s = strings.get(key)
  return s ? unescapeText(s).trim() || null : null
}
