/**
 * Content lookup by CodeName128. Gameplay and saved data only carry ids (CHAR_CH_MAN_ADVENTURER, 'bow'),
 * this module maps them to converted assets under /out/:
 *   1. /out/data/characters.json (data export; format read tolerantly, see parseCharactersJson)
 *   2. /out/index.json (converter index), deriving ids from file names: char/china/chinaman_x -> CHAR_CH_MAN_X
 */
import { CONTENT_FILES, contentEntries, installSiegeContent, installSiegeEventContent, installSiegeHunterContent, installSiegeLawContent, installWinterContent, PLAYER_MODELS_CH, STARTER_WEAPONS, type CosDef, type ItemDef, type MobDef, type StarterWeapon } from '@sro/shared'
import { gameText, t, type StringKey } from '../i18n/index.ts'
import { builtinTables, fetchContentTables, type ContentTables } from './gameplay.ts'
import { applyWinterIcons } from './winter-icons.ts'

export { STARTER_WEAPONS }

export const OUT = '/out/'

export type Gender = 'male' | 'female'

export interface CharacterModel {
  /** CodeName128, e.g. CHAR_CH_MAN_ADVENTURER */
  code: string
  gender: Gender
  race: string
  /** Short display label, e.g. "Adventurer" */
  label: string
  /** URL of the glb */
  glb: string
  sidecar?: string
  /** Offered at character creation. */
  selectable: boolean
  /** Creation-screen persona name and story (data export: textuisystem UIO_NEWCHAR_*). */
  persona?: string
  description?: string
}

export interface WeaponModel {
  family: StarterWeapon
  label: string
  /** Item name, e.g. Copper Sword (data export). */
  name?: string
  code?: string
  glb: string
  sidecar?: string
}

/**
 * Starter weapon families: converted model, display name (the game's own textdata id, else the UI table)
 * and a one-line description (UI table).
 */
export const WEAPON_INFO: Record<StarterWeapon, { file: string; textId: string; label: StringKey; about: StringKey }> = {
  sword: { file: 'item/china/weapon/sword_01', textId: 'UIO_NEWCHAR_STT_SWORD', label: 'weapon.sword', about: 'weapon.sword.about' },
  blade: { file: 'item/china/weapon/blade_01', textId: 'UIO_NEWCHAR_STT_BLADE', label: 'weapon.blade', about: 'weapon.blade.about' },
  spear: { file: 'item/china/weapon/spear_01', textId: 'UIO_NEWCHAR_STT_SPEAR', label: 'weapon.spear', about: 'weapon.spear.about' },
  glaive: { file: 'item/china/weapon/tblade_01', textId: 'UIO_NEWCHAR_STT_TBLADE', label: 'weapon.glaive', about: 'weapon.glaive.about' },
  bow: { file: 'item/china/weapon/bow_01', textId: 'UIO_NEWCHAR_STT_BOW', label: 'weapon.bow', about: 'weapon.bow.about' },
}

/** English family name of a starter weapon, e.g. "Glaive"; unknown families show their id. */
export function weaponLabel(family: string): string {
  const info = WEAPON_INFO[family as StarterWeapon]
  return info ? gameText(info.textId, t(info.label)) : family
}

export function weaponAbout(family: StarterWeapon): string {
  return t(WEAPON_INFO[family].about)
}

/** The 26 Chinese player models of vSRO 1.188 (refobjchar ids 1907-1932), from the shared protocol. */
export const CHINESE_PLAYER_CODES: readonly string[] = PLAYER_MODELS_CH

export function outUrl(path: string): string {
  if (/^(\/|https?:|blob:|data:)/.test(path)) return path
  return OUT + path.replace(/^\.?\//, '')
}

export function genderOf(code: string): Gender {
  return /_WOMAN_|_FEMALE|_W_/.test(code) ? 'female' : 'male'
}

export function labelOf(code: string): string {
  const tail = code.replace(/^CHAR_[A-Z]+_(WO)?MAN_/, '')
  return tail
    .split('_')
    .map(w => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}

/** chinaman_adventurer -> CHAR_CH_MAN_ADVENTURER; europewoman_x -> CHAR_EU_WOMAN_X */
export function codeFromFileName(name: string): string | undefined {
  const m = /^(china|europe)(woman|man)_([a-z0-9_]+)$/i.exec(name)
  if (!m) return undefined
  return `CHAR_${m[1]!.toLowerCase() === 'china' ? 'CH' : 'EU'}_${m[2]!.toUpperCase()}_${m[3]!.toUpperCase()}`
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Reads /out/data/characters.json. Accepted shapes: an array of entries, `{ characters: [...] }`, or an object
 * keyed by CodeName128. Per entry: code from codeName128 | codeName | code | id | key; glb from glb | model.glb |
 * asset.glb | file (".glb" appended when missing); gender from gender | sex (else from the code); selectable from
 * selectable | playable | creatable (else: one of the Chinese player codes).
 */
export function parseCharactersJson(data: unknown): CharacterModel[] {
  let rows: [string | undefined, unknown][] = []
  if (Array.isArray(data)) rows = data.map(e => [undefined, e])
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    const list = o.characters ?? o.models ?? o.items
    if (Array.isArray(list)) rows = list.map(e => [undefined, e])
    else if (list && typeof list === 'object') rows = Object.entries(list as Record<string, unknown>)
    else rows = Object.entries(o).filter(([k]) => k.startsWith('CHAR_'))
  }
  const out: CharacterModel[] = []
  for (const [key, raw] of rows) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    const nested = (k: string) => (e[k] && typeof e[k] === 'object' ? (e[k] as Record<string, unknown>) : undefined)
    const code = str(e.codeName128) ?? str(e.codeName) ?? str(e.code) ?? str(e.id) ?? key
    if (!code || !/^CHAR_/.test(code)) continue
    let glb = str(e.glb) ?? str(nested('model')?.glb) ?? str(nested('asset')?.glb) ?? str(nested('assets')?.glb) ?? str(e.model) ?? str(e.file)
    if (!glb) continue
    if (!/\.glb$/i.test(glb)) glb += '.glb'
    const sidecar = str(e.sidecar) ?? str(nested('model')?.sidecar) ?? glb.replace(/\.glb$/i, '.json')
    const sex = String(e.gender ?? e.sex ?? '').toLowerCase()
    const gender: Gender = /^(f|female|woman|w|1)$/.test(sex) ? 'female' : /^(m|male|man|0)$/.test(sex) ? 'male' : genderOf(code)
    const flag = e.selectable ?? e.playable ?? e.creatable
    out.push({
      code,
      gender,
      race: str(e.race) ?? str(e.country) ?? (code.startsWith('CHAR_CH_') ? 'china' : code.startsWith('CHAR_EU_') ? 'europe' : 'other'),
      label: str(e.label) ?? str(e.displayName) ?? str(e.nameEn) ?? labelOf(code),
      glb: outUrl(glb),
      sidecar: outUrl(sidecar),
      selectable: typeof flag === 'boolean' ? flag : CHINESE_PLAYER_CODES.includes(code),
      persona: str(e.name),
      description: str(e.description),
    })
  }
  return out
}

/** Reads /out/data/weapons.json: WeaponEntry[] { family, code, name, familyName, glb, sidecar } (packages/convert/src/data/game-data.ts). */
export function parseWeaponsJson(data: unknown): Partial<Record<StarterWeapon, WeaponModel>> {
  const out: Partial<Record<StarterWeapon, WeaponModel>> = {}
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as { weapons?: unknown }).weapons : undefined
  if (!Array.isArray(list)) return out
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    const family = e.family as StarterWeapon
    const glb = str(e.glb)
    if (!STARTER_WEAPONS.includes(family) || !glb || out[family]) continue
    out[family] = {
      family,
      label: str(e.familyName) ?? weaponLabel(family),
      name: str(e.name),
      code: str(e.code),
      glb: outUrl(glb),
      sidecar: str(e.sidecar) ? outUrl(str(e.sidecar)!) : undefined,
    }
  }
  return out
}

interface IndexRow {
  id: string
  name?: string
  category?: string
  glb: string
  sidecar?: string
}

/** Characters derivable from the converter's /out/index.json. */
export function charactersFromIndex(index: unknown): CharacterModel[] {
  if (!Array.isArray(index)) return []
  const out: CharacterModel[] = []
  for (const row of index as IndexRow[]) {
    if (!row || typeof row.glb !== 'string' || typeof row.id !== 'string') continue
    if (!/^char\//.test(row.category ?? row.id)) continue
    const file = row.id.split('/').pop()!
    const code = codeFromFileName(file)
    if (!code) continue
    out.push({
      code,
      gender: genderOf(code),
      race: code.startsWith('CHAR_CH_') ? 'china' : 'europe',
      label: labelOf(code),
      glb: outUrl(row.glb),
      sidecar: row.sidecar ? outUrl(row.sidecar) : undefined,
      selectable: CHINESE_PLAYER_CODES.includes(code),
    })
  }
  return out
}

export function weaponsFromIndex(index: unknown): Partial<Record<StarterWeapon, WeaponModel>> {
  const out: Partial<Record<StarterWeapon, WeaponModel>> = {}
  if (!Array.isArray(index)) return out
  for (const family of STARTER_WEAPONS) {
    const info = WEAPON_INFO[family]
    const row = (index as IndexRow[]).find(r => r && r.id === info.file)
    if (row) out[family] = { family, label: weaponLabel(family), glb: outUrl(row.glb), sidecar: row.sidecar ? outUrl(row.sidecar) : undefined }
  }
  return out
}

/** A renderable model referenced by CodeName128 (mobs, NPCs, dropped items). */
export interface ContentModel {
  code: string
  glb: string
  sidecar?: string
}

/** What the world needs to draw a mob. */
export interface MobVisual {
  code: string
  name: string
  level: number
  /** Converted model; undefined = draw a placeholder. */
  model?: ContentModel
  /** Uniform scale factor (MobDef.scale is percent). */
  scale: number
  /** Body radius in metres. */
  radius: number
  /**
   * Wave 11 (docs/UNIQUES.md §2.2): the creature this mob rides (MobDef.ride with its /out/ urls), seated on `joint`;
   * absent = none (world/ride-mob.ts draws the composite).
   */
  ride?: { model: ContentModel; joint: string }
}

const REGION_CODE: Record<string, string> = { china: 'CH', europe: 'EU', oasis: 'OA', roc: 'RO', karakoram: 'KK', taklamakan: 'TK' }

/** Converter ids of non-player models -> CodeName128: mob/china/mangnyang -> MOB_CH_MANGNYANG, npc/china/x -> NPC_CH_X. */
export function contentCodeFromIndexId(id: string): string | undefined {
  const m = /^(mob|npc)\/([a-z0-9_]+)\/([a-z0-9_]+)$/i.exec(id)
  if (!m) return undefined
  const region = REGION_CODE[m[2]!.toLowerCase()] ?? m[2]!.toUpperCase()
  return `${m[1]!.toUpperCase()}_${region}_${m[3]!.toUpperCase()}`
}

/** Mob and NPC models derivable from the converter's /out/index.json. */
export function contentModelsFromIndex(index: unknown): Map<string, ContentModel> {
  const out = new Map<string, ContentModel>()
  if (!Array.isArray(index)) return out
  for (const row of index as IndexRow[]) {
    if (!row || typeof row.glb !== 'string' || typeof row.id !== 'string') continue
    const code = contentCodeFromIndexId(row.id)
    if (code && !out.has(code)) out.set(code, { code, glb: outUrl(row.glb), sidecar: row.sidecar ? outUrl(row.sidecar) : undefined })
  }
  return out
}

/**
 * Reads /out/data/cos.json (ContentFile<CosDef>, or a bare array): the rows with a code and HP, model and icon URLs
 * under /out/. A malformed file gives no horses (warned), never an exception.
 */
export function parseCosJson(data: unknown): CosDef[] {
  let rows: unknown[]
  try {
    rows = contentEntries<unknown>(data, 'cos')
  } catch (err) {
    console.warn(`[content] ${CONTENT_FILES.cos} ignored:`, err)
    return []
  }
  const out: CosDef[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const d = r as CosDef
    if (typeof d.code !== 'string' || !d.code || typeof d.hp !== 'number') continue
    const model = d.model && typeof d.model.glb === 'string' ? { ...d.model, glb: outUrl(d.model.glb), sidecar: outUrl(typeof d.model.sidecar === 'string' ? d.model.sidecar : d.model.glb.replace(/\.glb$/i, '.json')) } : null
    out.push({ ...d, model, icon: typeof d.icon === 'string' && d.icon ? outUrl(d.icon) : null })
  }
  return out
}

/** Weapon family of an item code (ItemDef.weaponType, else the Chinese code pattern ITEM_CH_<FAMILY>_...). */
export function weaponFamilyOf(code: string, def?: ItemDef): StarterWeapon | undefined {
  if (def?.weaponType && STARTER_WEAPONS.includes(def.weaponType)) return def.weaponType
  const m = /^ITEM_CH_(SWORD|BLADE|SPEAR|TBLADE|BOW)_/.exec(code)
  if (!m) return undefined
  return m[1] === 'TBLADE' ? 'glaive' : (m[1]!.toLowerCase() as StarterWeapon)
}

export class Catalog {
  private readonly byCodeMap = new Map<string, CharacterModel>()
  /** Horses by code (cos.json, lane MR-C). */
  private readonly cosMap = new Map<string, CosDef>()

  constructor(
    readonly characters: CharacterModel[],
    readonly weapons: Partial<Record<StarterWeapon, WeaponModel>>,
    /** Where the character list came from, for diagnostics. */
    readonly source: string,
    /** Gameplay content (mobs, items, NPCs, shops, drops, levels): export over the builtin stand-ins. */
    readonly content: ContentTables = builtinTables(),
    /** Mob/NPC models from the converter index, for codes the export does not give a model. */
    readonly contentModels: Map<string, ContentModel> = new Map(),
    /** Horses (/out/data/cos.json, parseCosJson). */
    cos: readonly CosDef[] = [],
  ) {
    for (const c of characters) if (!this.byCodeMap.has(c.code)) this.byCodeMap.set(c.code, c)
    for (const d of cos) this.cosMap.set(d.code, d)
  }

  character(code: string): CharacterModel | undefined {
    return this.byCodeMap.get(code) ?? this.byCodeMap.get(code.toUpperCase())
  }

  /** Model to show for an id; unknown ids fall back to the adventurer of the same gender so nothing is invisible. */
  characterOrFallback(code: string): CharacterModel | undefined {
    return this.character(code) ?? this.character(genderOf(code) === 'female' ? 'CHAR_CH_WOMAN_ADVENTURER' : 'CHAR_CH_MAN_ADVENTURER') ?? this.characters[0]
  }

  selectable(gender: Gender): CharacterModel[] {
    const list = this.characters.filter(c => c.selectable && c.gender === gender && c.race === 'china')
    const order = (c: CharacterModel) => {
      const i = CHINESE_PLAYER_CODES.indexOf(c.code)
      return i < 0 ? 999 : i
    }
    return list.sort((a, b) => order(a) - order(b))
  }

  weapon(family: StarterWeapon): WeaponModel | undefined {
    return this.weapons[family]
  }

  item(code: string): ItemDef | undefined {
    return this.content.items.get(code)
  }

  /** English display name of an item code (the code itself when unknown). */
  itemName(code: string): string {
    return this.content.items.get(code)?.name ?? code
  }

  mob(code: string): MobVisual {
    const def: MobDef | undefined = this.content.mobs.get(code)
    const exported = def?.model ? { code, glb: outUrl(def.model.glb), sidecar: def.model.sidecar ? outUrl(def.model.sidecar) : undefined } : undefined
    return {
      code,
      name: def?.name ?? code,
      level: def?.level ?? 0,
      model: exported ?? this.contentModels.get(code),
      scale: def && def.scale > 0 ? def.scale / 100 : 1,
      radius: def?.radius ?? 0.5,
      ...(def?.ride?.model?.glb && def.ride.joint
        ? { ride: { model: { code: `${code}#ride`, glb: outUrl(def.ride.model.glb), sidecar: def.ride.model.sidecar ? outUrl(def.ride.model.sidecar) : undefined }, joint: def.ride.joint } }
        : {}),
    }
  }

  npc(code: string): ContentModel | undefined {
    const def = this.content.npcs.get(code)
    if (def?.model) return { code, glb: outUrl(def.model.glb), sidecar: def.model.sidecar ? outUrl(def.model.sidecar) : undefined }
    return this.contentModels.get(code)
  }

  /**
   * A horse (or other COS) by CodeName128, e.g. COS_C_HORSE1: model, radius, name, icon from /out/data/cos.json
   * (docs/SYSTEMS_COMBAT.md §1.5); null for an unknown code or before cos.json is exported.
   */
  cos(code: string): CosDef | null {
    return this.cosMap.get(code) ?? null
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

export async function loadCatalog(): Promise<Catalog> {
  let index: unknown = []
  try {
    index = await fetchJson(`${OUT}index.json`)
  } catch (err) {
    console.warn('[content] /out/index.json unavailable', err)
  }
  let characters: CharacterModel[] = []
  let source = '/out/index.json'
  try {
    characters = parseCharactersJson(await fetchJson(`${OUT}data/characters.json`))
    if (characters.length) source = '/out/data/characters.json'
  } catch {
    // Not exported yet: fall back to the converter index.
  }
  // Merge: characters.json wins, the index fills in models it does not list. When the export offers
  // any selectable model it is authoritative for creation (the server applies the same rule,
  // apps/server/src/content.ts), so index-only models are display-only.
  const exported = characters.some(c => c.selectable)
  const seen = new Set(characters.map(c => c.code))
  for (const c of charactersFromIndex(index)) if (!seen.has(c.code)) characters.push(exported ? { ...c, selectable: false } : c)
  let weapons: Partial<Record<StarterWeapon, WeaponModel>> = {}
  try {
    weapons = parseWeaponsJson(await fetchJson(`${OUT}data/weapons.json`))
  } catch {
    // Not exported yet.
  }
  const content = await fetchContentTables(`${OUT}data/`).catch(err => {
    console.warn('[content] gameplay content unavailable; using the builtin stand-ins', err)
    return builtinTables()
  })
  // docs/WINTER.md §13: the winter monsters (derived from their retail bases), Ginger Tea and the gift box, with painted icons
  installWinterContent(content)
  applyWinterIcons(content.items)
  // docs/SIEGE.md §2.4 (layer 3): Master Mason Ko, his shop, the Mason's Kit and the Stone Block (retail icons)
  installSiegeContent(content, 'jangan')
  // docs/SIEGE.md §6.5 (layer 4): the sapper, the Stone Ram, the Bandit Warlord, the Town Bell and the Siege Seal
  installSiegeEventContent(content)
  // docs/SIEGE.md §7 (layer 5): the Thunder Keg, Saltpeter and Old Fang the Fence (retail icons)
  installSiegeLawContent(content, 'jangan')
  // docs/SIEGE.md §8.2, §8.5 (layer 6): Captain Yun, his shop and the Hunter's Net, Warden Bae
  installSiegeHunterContent(content, 'jangan')
  console.info(`[content] mobs ${content.mobs.size}, items ${content.items.size}; exported: ${content.exported.join(', ') || 'none (builtin stand-ins)'}`)
  // Horses (lane MR-C): cos.json, when exported.
  const cos = await fetchJson(`${OUT}data/${CONTENT_FILES.cos}`).then(parseCosJson, () => [])
  return new Catalog(characters, { ...weaponsFromIndex(index), ...weapons }, source, content, contentModelsFromIndex(index), cos)
}
