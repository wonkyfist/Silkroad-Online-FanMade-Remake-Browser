/**
 * Game data built from the client's textdata tables: the selectable Chinese characters, the level table and the
 * Chinese starter weapons. Pure functions over a TextdataReader; tools/export-data.ts writes the JSON and documents
 * the files for their consumers.
 *
 * Evidence used to pick the creation choices (vSRO 1.188, Media.pk2):
 *  - characterdata: the 26 rows CHAR_CH_MAN_* / CHAR_CH_WOMAN_* (ID 1907-1932) are the only Chinese player
 *    characters (TypeID 1/1/0/0, Country 0, Lvl 1, CharGender 1/0), each with a res/char/china/*.bsr model.
 *  - textuisystem: the character-creation screen has a name and an explanation for each of the 26
 *    (UIO_NEWCHAR_MAN_<X>, UIO_NEWCHAR_FEMALE_<X>, *_EXPLANATION), including BOGY, MONKEY, FOX and KANGSI; the
 *    creation layout (resinfo/pscharactercreatechina.txt) has the explanation window that shows them.
 *  - Models without a characterdata row are not choices: chinaman_spidey.bsr (no row, no string) and the
 *    *_hwan_hair.bsr overlays (charactervisualchange: berserk hair).
 *  - itemdata: the creation defaults are the *_DEF items (CanTrade 0, CanBuy 0, Korean name suffix "(기본)"
 *    "basic"): exactly one Chinese weapon per family, plus the armour sets, a shield and arrows. Their families
 *    match the creation labels UIO_NEWCHAR_STT_SWORD/BLADE/SPEAR/TBLADE/BOW.
 */
import type { StarterWeapon } from '../../../shared/src/protocol.ts'
import {
  buildStringMap,
  CH_WEAPON_TID4,
  characterDataRow,
  COUNTRY_CHINA,
  GENDER_FEMALE,
  GENDER_MALE,
  isPlayerCharacter,
  itemDataRow,
  levelDataRow,
  loadTextdataTable,
  normalizePk2Path,
  textdataInt,
  type CharacterDataRow,
  type ItemDataRow,
  type LevelDataRow,
  type TextdataReader,
} from '@sro/formats'

// ---- JSON schema (work/out/data/*.json) -----------------------------------------------------------

/** characters.json: CharacterEntry[] — the creation choices, in characterdata ID order (men first). */
export interface CharacterEntry {
  /** CodeName128, the id gameplay and saved data use (protocol `model`), e.g. CHAR_CH_MAN_ADVENTURER. */
  code: string
  race: 'china'
  gender: 'male' | 'female'
  /** Creation-screen persona name (English), e.g. "Ryujoyeong"; null if the string is missing. */
  name: string | null
  /** textuisystem key of `name`; the explanation is `${nameKey}_EXPLANATION`. */
  nameKey: string | null
  /** Creation-screen explanation (English), with real line breaks. */
  description: string | null
  /** Model in Data.pk2, e.g. res/char/china/chinaman_adventurer.bsr. */
  bsr: string
  /** Converted model URL, e.g. /out/char/china/chinaman_adventurer.glb. */
  glb: string
  /** Converter sidecar URL (clips, attach bones, materials), e.g. /out/char/china/chinaman_adventurer.json. */
  sidecar: string
}

/** levels.json: LevelEntry[] for levels 1..30. */
export interface LevelEntry {
  level: number
  /** EXP needed to go from `level` to `level + 1` (not cumulative). */
  exp: number
  /** SP needed to raise a weapon mastery to `level`. */
  masterySp: number
}

/** weapons.json: WeaponEntry[], one per StarterWeapon in protocol order (sword, blade, spear, glaive, bow). */
export interface WeaponEntry {
  family: StarterWeapon
  /** Creation-default item (CodeName128), e.g. ITEM_CH_SWORD_01_A_DEF: degree 1, not tradable. */
  code: string
  /** Lowest-degree ordinary item of the family with the same model, e.g. ITEM_CH_SWORD_01_A. */
  baseCode: string
  /** Item name (English), e.g. "Copper Sword". */
  name: string | null
  /** Creation-screen family label (English), e.g. "Glaive". */
  familyName: string | null
  degree: number
  /** Required character level. */
  reqLevel: number
  /** Two-handed weapons (spear, glaive, bow) cannot be used with a shield. */
  twoHanded: boolean
  /** Reach in world units (decimetres) beyond the body radius: 6 sword/blade, 18 spear/glaive, 180 bow. */
  range: number
  /** Creation-default ammunition (bow only), e.g. ITEM_ETC_AMMO_ARROW_01_DEF. */
  ammo?: string
  bsr: string
  glb: string
  sidecar: string
}

/** strings.json: English text for every key referenced above plus the creation-screen labels. */
export type StringsFile = Record<string, string>

export interface GameData {
  characters: CharacterEntry[]
  levels: LevelEntry[]
  weapons: WeaponEntry[]
  strings: StringsFile
}

export const DATA_FILES = {
  characters: 'characters.json',
  levels: 'levels.json',
  weapons: 'weapons.json',
  strings: 'strings.json',
} as const

export const MAX_EXPORTED_LEVEL = 30

// ---- sources ------------------------------------------------------------------------------------

export interface GameDataSources {
  characters: CharacterDataRow[]
  items: ItemDataRow[]
  levels: LevelDataRow[]
  /** English strings from STRING_TABLES. */
  strings: Map<string, string>
}

/** textuisystem (UI, incl. the creation screen) and textdataname (index: equip & skill, object, new). */
export const STRING_TABLES = ['textuisystem.txt', 'textdataname.txt'] as const

export function loadGameDataSources(read: TextdataReader): GameDataSources {
  return {
    characters: loadTextdataTable('characterdata.txt', read).rows.map(characterDataRow),
    items: loadTextdataTable('itemdata.txt', read).rows.map(itemDataRow),
    levels: loadTextdataTable('leveldata.txt', read).rows.map(levelDataRow),
    strings: buildStringMap(STRING_TABLES.flatMap(t => loadTextdataTable(t, read).rows), 'english'),
  }
}

// ---- paths ------------------------------------------------------------------------------------

/** AssocFileObj128 ('char\china\chinaman_adventurer.bsr', relative to res/) -> 'res/char/china/chinaman_adventurer.bsr'. */
export function resourcePath(assocFileObj: string): string {
  return 'res/' + normalizePk2Path(assocFileObj)
}

/** Where `pnpm sro convert` puts a BSR (gltf/output.ts: categoryOf + baseNameOf), as URLs under /out/. */
export function convertedPaths(bsr: string): { rel: string; glb: string; sidecar: string } {
  const parts = normalizePk2Path(bsr).split('/')
  const base = parts.pop()!.replace(/\.[^.]*$/, '')
  if (parts[0] === 'res') parts.shift()
  const rel = [...parts, base].join('/')
  return { rel, glb: `/out/${rel}.glb`, sidecar: `/out/${rel}.json` }
}

/** Joymax stores line breaks inside strings as the two characters '\n'. */
function unescapeText(s: string): string {
  return s.replace(/\\n/g, '\n')
}

// ---- characters ---------------------------------------------------------------------------------

const CREATION_CODE = /^CHAR_CH_(MAN|WOMAN)_([A-Z0-9_]+)$/

/** Candidate creation-screen name keys; the UI table spells NECROMENCER (the CodeName128 spelling) NECROMANCER. */
export function creationNameKeys(code: string): string[] {
  const m = CREATION_CODE.exec(code)
  if (!m) return []
  const sex = m[1] === 'MAN' ? 'MAN' : 'FEMALE'
  const keys = [`UIO_NEWCHAR_${sex}_${m[2]}`]
  const fixed = m[2]!.replace('NECROMENCER', 'NECROMANCER')
  if (fixed !== m[2]) keys.push(`UIO_NEWCHAR_${sex}_${fixed}`)
  return keys
}

export interface Rejected {
  code: string
  reasons: string[]
}

/** Chinese player characters that are creation choices; other Chinese player rows are returned with reasons. */
export function selectCreationCharacters(
  rows: readonly CharacterDataRow[],
  strings: ReadonlyMap<string, string>,
): { selected: Array<{ row: CharacterDataRow; nameKey: string }>; rejected: Rejected[] } {
  const selected: Array<{ row: CharacterDataRow; nameKey: string }> = []
  const rejected: Rejected[] = []
  for (const row of rows) {
    if (!row.service || !isPlayerCharacter(row) || row.country !== COUNTRY_CHINA) continue
    const reasons: string[] = []
    const m = CREATION_CODE.exec(row.codeName)
    if (!m) reasons.push('CodeName128 is not CHAR_CH_MAN_* or CHAR_CH_WOMAN_*')
    else if (row.gender !== (m[1] === 'MAN' ? GENDER_MALE : GENDER_FEMALE)) reasons.push(`CharGender ${row.gender} contradicts the code`)
    if (row.typeId[2] !== 0 || row.typeId[3] !== 0) reasons.push(`TypeID ${row.typeId.join('/')} is not 1/1/0/0`)
    if (row.level !== 1) reasons.push(`Lvl ${row.level} is not 1`)
    if (!row.assocFileObj?.toLowerCase().endsWith('.bsr')) reasons.push(`model ${row.assocFileObj ?? 'none'} is not a .bsr`)
    const nameKey = creationNameKeys(row.codeName).find(k => strings.has(k))
    if (!nameKey) reasons.push('no creation-screen name (UIO_NEWCHAR_*) in textuisystem')
    if (reasons.length || !nameKey) rejected.push({ code: row.codeName, reasons })
    else selected.push({ row, nameKey })
  }
  selected.sort((a, b) => a.row.id - b.row.id)
  return { selected, rejected }
}

// ---- weapons ------------------------------------------------------------------------------------

/** Chinese weapon families: protocol name and the CodeName128 token (a glaive is a TBLADE). */
export const CH_WEAPON_FAMILIES: ReadonlyArray<{ family: StarterWeapon; token: string }> = [
  { family: 'sword', token: 'SWORD' },
  { family: 'blade', token: 'BLADE' },
  { family: 'spear', token: 'SPEAR' },
  { family: 'glaive', token: 'TBLADE' },
  { family: 'bow', token: 'BOW' },
]

const TID4: Readonly<Record<StarterWeapon, number>> = CH_WEAPON_TID4

function isChineseWeapon(r: ItemDataRow, family: StarterWeapon): boolean {
  const [t1, t2, t3, t4] = r.typeId
  return r.service && t1 === 3 && t2 === 1 && t3 === 6 && t4 === TID4[family] && r.country === COUNTRY_CHINA
}

type TextLookup = (key: string | undefined) => string | null

function buildWeapon(items: readonly ItemDataRow[], text: TextLookup, family: StarterWeapon, token: string): WeaponEntry {
  const rows = items.filter(r => isChineseWeapon(r, family))
  const defaults = rows.filter(r => r.codeName.endsWith('_DEF'))
  if (defaults.length !== 1) throw new Error(`${family}: expected one creation-default (*_DEF) weapon, found ${defaults.map(r => r.codeName).join(', ') || 'none'}`)
  const def = defaults[0]!
  const plain = new RegExp(`^ITEM_CH_${token}_\\d+_A$`)
  const base = rows
    .filter(r => plain.test(r.codeName))
    .sort((a, b) => a.degree - b.degree || a.itemClass - b.itemClass || a.id - b.id)[0]
  if (!base) throw new Error(`${family}: no ITEM_CH_${token}_NN_A item`)
  const minDegree = Math.min(...rows.filter(r => r.degree > 0).map(r => r.degree))
  if (def.degree !== minDegree || base.degree !== minDegree) {
    throw new Error(`${family}: ${def.codeName} (degree ${def.degree}) / ${base.codeName} (degree ${base.degree}) are not the lowest degree ${minDegree}`)
  }
  if (!def.assocFileObj) throw new Error(`${def.codeName}: no model (AssocFileObj128)`)
  if (base.assocFileObj !== def.assocFileObj) throw new Error(`${family}: ${def.codeName} and ${base.codeName} use different models`)
  const bsr = resourcePath(def.assocFileObj)
  const { glb, sidecar } = convertedPaths(bsr)
  const entry: WeaponEntry = {
    family,
    code: def.codeName,
    baseCode: base.codeName,
    name: text(def.nameStrId),
    familyName: text(`UIO_NEWCHAR_STT_${token}`),
    degree: def.degree,
    reqLevel: def.reqLevels[0]!.type === -1 ? 0 : def.reqLevels[0]!.level,
    twoHanded: def.twoHanded,
    range: def.range,
    bsr,
    glb,
    sidecar,
  }
  // _RefObjItem Quivered (col 86) and Ammo1_TID4 (col 87): the bow takes arrows (TypeID 3/3/4/1).
  const defRow = { file: '', line: 0, cells: def.cells }
  if (textdataInt(defRow, 86, 'Quivered') === 1) {
    const ammoTid4 = textdataInt(defRow, 87, 'Ammo1_TID4')
    const ammo = items.filter(r => r.service && r.typeId.join('/') === `3/3/4/${ammoTid4}` && r.codeName.endsWith('_DEF'))
    if (ammo.length !== 1) throw new Error(`${def.codeName}: expected one default ammo 3/3/4/${ammoTid4}, found ${ammo.length}`)
    entry.ammo = ammo[0]!.codeName
    text(ammo[0]!.nameStrId)
  }
  return entry
}

// ---- build ------------------------------------------------------------------------------------

/** Creation-screen labels exported to strings.json alongside the names used by the entries. */
export const CREATION_UI_KEYS = [
  'UIO_NEWCHAR_CTL_CHINESE',
  'UIO_NEWCHAR_CTL_CHINESE_TT',
  'UIO_NEWCHAR_STT_NAME',
  'UIO_NEWCHAR_CTL_CHECK_OVERLAP',
  'UIO_NEWCHAR_STT_SEX',
  'UIO_NEWCHAR_CTL_MALE',
  'UIO_NEWCHAR_CTL_FEMALE',
  'UIO_NEWCHAR_STT_WEAPON',
  'UIO_NEWCHAR_STT_PROTECTOR',
  'UIO_NEWCHAR_STT_CLOTHES',
  'UIO_NEWCHAR_STT_LIGHT_ARMOR',
  'UIO_NEWCHAR_STT_HEAVY_ARMOR',
  'UIO_NEWCHAR_CTL_CONFIRM',
  'UIO_NEWCHAR_MSG_CREATE',
] as const

export function buildGameData(src: GameDataSources, maxLevel = MAX_EXPORTED_LEVEL): { data: GameData; rejected: Rejected[] } {
  const strings: StringsFile = {}
  const text: TextLookup = key => {
    if (!key) return null
    const s = src.strings.get(key)
    if (s === undefined) return null
    strings[key] = unescapeText(s)
    return strings[key]!
  }
  for (const key of CREATION_UI_KEYS) {
    if (text(key) === null) throw new Error(`textuisystem: missing ${key}`)
  }

  const { selected, rejected } = selectCreationCharacters(src.characters, src.strings)
  const characters = selected.map(({ row, nameKey }): CharacterEntry => {
    const bsr = resourcePath(row.assocFileObj!)
    const { glb, sidecar } = convertedPaths(bsr)
    return {
      code: row.codeName,
      race: 'china',
      gender: row.gender === GENDER_MALE ? 'male' : 'female',
      name: text(nameKey),
      nameKey,
      description: text(`${nameKey}_EXPLANATION`),
      bsr,
      glb,
      sidecar,
    }
  })

  const byLevel = new Map(src.levels.map(r => [r.level, r]))
  const levels: LevelEntry[] = []
  for (let level = 1; level <= maxLevel; level++) {
    const row = byLevel.get(level)
    if (!row) throw new Error(`leveldata: no row for level ${level}`)
    levels.push({ level, exp: row.exp, masterySp: row.masterySp })
  }

  const weapons = CH_WEAPON_FAMILIES.map(({ family, token }) => buildWeapon(src.items, text, family, token))

  return { data: { characters, levels, weapons, strings }, rejected }
}

/** File name -> exact file contents (2-space JSON, trailing newline). */
export function serializeGameData(data: GameData): Record<string, string> {
  const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n'
  return {
    [DATA_FILES.characters]: json(data.characters),
    [DATA_FILES.levels]: json(data.levels),
    [DATA_FILES.weapons]: json(data.weapons),
    [DATA_FILES.strings]: json(data.strings),
  }
}
