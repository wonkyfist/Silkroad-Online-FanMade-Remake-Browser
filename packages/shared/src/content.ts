/**
 * Content contracts: the JSON the data exporter writes to work/out/data/ (served at /out/data/) and the server
 * and client read. Environment-neutral. docs/PROTOCOL.md "Content files" lists every file.
 *
 * Rules:
 *  - Records are keyed by CodeName128 (`code`), never by file paths; model/icon paths are presentation only, so
 *    the art can be replaced without touching gameplay or saved data.
 *  - Distances are metres and positions are glTF metres in the world manifest frame (docs/CONVENTIONS.md
 *    "World space"); client textdata stores decimetres ("units"), so the exporter multiplies by 0.1.
 *    Times are milliseconds unless a field name says otherwise.
 *  - Every field documents its source. "client:" = our own vSRO 1.188 client textdata (authoritative for stats,
 *    levels, EXP and models). "port:" = the third-party port's JSON, which carries server-only vSRO tables
 *    (Tab_RefNest/Hive/Tactics, drops); such records carry `provenance: PROVENANCE_PORT`.
 *    Column numbers are 0-based textdata columns; characterdata columns after 60 follow the vSRO _RefObjChar
 *    column order (Db2Media/RSBot) and must be checked against real rows by the exporter.
 *  - Files may carry more keys than listed (additive changes); readers ignore unknown keys.
 *  - Data exists for all levels; the server gates content by its level cap (LEVEL_CAP, default 20).
 */

import type { SkillStatusKind, StarterWeapon } from './protocol.ts'

/** Bump only for breaking changes to a content file; additive fields keep the version. */
export const CONTENT_SCHEMA_VERSION = 1

/** Provenance tag for every record derived from the third-party port's server data. */
export const PROVENANCE_PORT = 'vsro-server-db via third-party port'

/**
 * Where a record (or a field, see `fieldSources`) comes from.
 * 'client' = our client textdata; 'formula' = computed by a documented rule; 'authored' = hand-written by us.
 */
export type Provenance = 'client' | typeof PROVENANCE_PORT | 'formula' | 'authored'

/** Files under /out/data/. levels.json predates the wrapper and is a bare LevelDef[]; the rest use ContentFile. */
export const CONTENT_FILES = {
  mobs: 'mobs.json',
  nests: 'nests.json',
  items: 'items.json',
  skills: 'skills.json',
  masteries: 'masteries.json',
  npcs: 'npcs.json',
  shops: 'shops.json',
  drops: 'drops.json',
  levels: 'levels.json',
  /** Wave 8 (docs/SYSTEMS_COMBAT.md §6.3): horses (CosDef). */
  cos: 'cos.json',
} as const

export type ContentKind = keyof typeof CONTENT_FILES

/** Wrapper of every new content file. */
export interface ContentFile<T> {
  schema: typeof CONTENT_SCHEMA_VERSION
  kind: ContentKind
  /** ISO time the exporter ran. */
  generatedAt: string
  /** Human-readable inputs, e.g. ['client:characterdata.txt', 'port:spawns.json']. */
  sources: string[]
  entries: T[]
}

/** [min, max], inclusive. */
export type Range = [number, number]

/** Converted model (docs/CONVENTIONS.md): URLs under /out/. */
export interface ModelRef {
  /** Resource in Data.pk2, e.g. res/mob/china/mangnyang.bsr (client: AssocFileObj128 col 52). */
  bsr: string
  /** e.g. /out/mob/china/mangnyang.glb */
  glb: string
  /** Converter sidecar (clips, attach bones), e.g. /out/mob/china/mangnyang.json */
  sidecar: string
}

// ---- monsters -------------------------------------------------------------------------------------

/** Definition rarity (client: Rarity col 15; §4.4 of the research report). */
export type MobRarity = 'normal' | 'champion' | 'unique' | 'giant' | 'titan' | 'elite' | 'strongElite' | 'special'

export const MOB_RARITIES: readonly MobRarity[] = ['normal', 'champion', 'unique', 'giant', 'titan', 'elite', 'strongElite', 'special']

/**
 * Spawn-time variant of a live mob. Ordinary mobs share one definition and are rolled as champion/giant at spawn
 * (nest `championPct`); uniques are their own definitions. Stat multipliers per variant are server config
 * (not in client data).
 */
export type MobVariant = 'normal' | 'champion' | 'giant' | 'titan' | 'elite' | 'unique' | 'party'

export const MOB_VARIANTS: readonly MobVariant[] = ['normal', 'champion', 'giant', 'titan', 'elite', 'unique', 'party']

/** mobs.json: ContentFile<MobDef>. Monsters are characterdata rows with TypeID 1/2/1/x. */
export interface MobDef {
  /** client: CodeName128 (col 2), e.g. MOB_CH_MANGNYANG. */
  code: string
  /** client: ID (col 1). Source field only; never used as a reference. */
  id: number
  /** English name (client: NameStrID128 col 5 -> textdata string tables); null if missing. */
  name: string | null
  /** client: TypeID1-4 (cols 9-12). */
  typeId: [number, number, number, number]
  rarity: MobRarity
  /** client: Lvl (col 57). */
  level: number
  /** client: MaxHP (col 59). */
  hp: number
  /** client: MaxMP (col 60). */
  mp: number
  /**
   * Basic-attack damage roll. client: the mob's first default skill (DefaultSkill_1, col 83) -> skilldata `att`
   * param min/max. When that is missing the exporter fills a formula and says so in `fieldSources`.
   */
  physAttack: Range
  magAttack: Range
  /** client: PD (col 71) / MD (col 72). */
  physDefence: number
  magDefence: number
  /** client: PAR (col 73) / MAR (col 74): absorption, percent. */
  physAbsorb?: number
  magAbsorb?: number
  /** client: HR (col 77). */
  hitRate: number
  /** client: ER (col 75): parry (evasion) rate. */
  parryRate: number
  /** client: BR (col 76) / CHR (col 78). */
  blockRate?: number
  critRate?: number
  /** Reach of the basic attack in metres beyond both body radii (client: default skill Range col 21, dm x 0.1). */
  attackRange: number
  /** Time between basic attacks (client: default skill ReuseDelay col 14, or CoolTime col 15 on monster rows). */
  attackIntervalMs: number
  /** Body radius in metres (client: BCRadius col 50 x 0.1). */
  radius: number
  /** m/s (client: Speed1 / Speed2 cols 46-47, units/s x 0.1; a player's 50 is 5 m/s). */
  walkSpeed: number
  runSpeed: number
  /**
   * Default aggression when a nest's tactics do not say. port: Tab_RefTactics aggress type of its nests when all
   * agree; otherwise false. Per-nest `NestDef.tactics.aggressive` wins.
   */
  aggressive: boolean
  /** client: ExpToGive (col 79). */
  exp: number
  /** SP-EXP awarded (400 SP-EXP = 1 SP). Not in client data; absent = the server's rule (default: equal to exp). */
  spExp?: number
  /** client: Scale (col 48), percent. */
  scale: number
  /** Model; null when the BSR is not converted. */
  model: ModelRef | null
  /** Default skill codes (client: DefaultSkill_1..10, cols 83-92), for the skills wave. */
  skills?: string[]
  /**
   * Wave 8 (docs/SYSTEMS_COMBAT.md §2.4): the exporter's summary of each default skill row (already in mobs.json).
   * Documentation only: the server reads the MSKILL rows from skills.json.
   */
  attacks?: MobAttack[]
  /** Variants this mob may spawn as (port: mobs.json `variants`); absent = normal only. */
  variants?: MobVariant[]
  /**
   * Wave 11 (docs/UNIQUES.md §2.2): the creature this mob rides (client: characterdata `ride` column, e.g. Tiger
   * Girl on her Blue Tiger), seated on the ride's `joint` (always 'saddle' today). Absent = rides nothing (and in every
   * export older than wave 11). The client draws the two as one composite actor.
   */
  ride?: MobRide
  /** Fields whose source is not the one documented above, e.g. { physAttack: 'formula: level table' }. */
  fieldSources?: Record<string, string>
}

/** `MobDef.ride` (wave 11): the ridden creature's model (same /out/ paths as every ModelRef) and the seat joint. */
export interface MobRide {
  model: ModelRef
  /** Joint of the ride's skeleton the rider sits on, e.g. 'saddle' (checked against the skeleton at convert time). */
  joint: string
}

/** mobs.json `attacks[]`: one default skill row of a monster (packages/convert/src/data/skills.ts mobAttack). */
export interface MobAttack {
  /** MSKILL_* row code. */
  code: string
  damage?: SkillDamage
  castMs: number
  actionMs: number
  cooldownMs: number
  /** Metres beyond both body radii (skilldata col 21 x 0.1). */
  range: number
}

/** How a nest's mobs behave (port: Tab_RefTactics via the nest's tacticsId). */
export interface TacticsDef {
  /** port: tacticsId. */
  id: number
  /** Attacks players in sight unprovoked (port: aggressTypeRaw; 0 = aggressive per go-sro, unverified). */
  aggressive: boolean
  /** Aggro radius in metres (port: sightRangeU; vSRO search radius = 15 + nSightRange units). */
  sightRange: number
  /** Leash: a chasing mob gives up past this distance from its nest centre, metres (port: traceBoundaryU). */
  leashRange: number
  /** Raw port values kept for later analysis. */
  raw?: Record<string, number>
}

/** nests.json: ContentFile<NestDef>. Every record: provenance PROVENANCE_PORT (Tab_RefNest is server-only). */
export interface NestDef {
  /** port: nestId (Tab_RefNest dwNestID). */
  id: number
  /** Mob CodeName128 (port: vsroCode), resolved against mobs.json. */
  mob: string
  /** Nest centre, glTF metres in the world manifest frame (converted from the port's own frame; see `source`). */
  x: number
  z: number
  /** Height hint (metres); the server snaps to the navmesh/terrain. */
  y?: number
  /** Silkroad region id (z << 8 | x) of the centre, when known. */
  region?: number
  /** Roam radius in metres (port: radius = nRadius). */
  radius: number
  /** Spawn radius in metres (port: spawnRadius = nGenerateRadius). */
  spawnRadius: number
  /** Mobs alive at once (port: count, Tab_RefHive/Nest total count). */
  count: number
  /** Respawn delay after a death, seconds [min, max] (port: respawnDelaySec = dwDelayTimeMin/Max). */
  respawnSec: Range
  /** Percent chance a spawn rolls champion (port: championPct). */
  championPct?: number
  tactics: TacticsDef
  /** World name the nest belongs to (manifest name, e.g. 'jangan'). */
  world: string
  /**
   * nests.json records are always PROVENANCE_PORT (checkNestDef enforces it). Wave 4 widens the type for GM-authored
   * nests ('authored', ids >= 1_000_000, validated by the editors' own check; docs/QUESTS.md §6.4, WAVE_PLAN decision 44).
   */
  provenance: Provenance
  /** The untouched port record position and province, for audit/re-derivation. */
  source: { file: string; zone: string; x: number; z: number; y?: number }
  /** Exporter: false switches the nest off (only the configured province is enabled). Absent = enabled. */
  enabled?: boolean
  /** Exporter: level of the nest's mob (a copy of MobDef.level, for filtering without mobs.json). */
  level?: number
  /** Exporter: whether the centre lies inside the currently converted world regions. Informational. */
  inConvertedRegion?: boolean
  /**
   * Exporter (unique mobs only): nests sharing a group hold at most ONE living mob between them; each respawn
   * picks one of the group's nests at random (server rule, the retail unique behaviour).
   */
  uniqueGroup?: string
}

// ---- items ----------------------------------------------------------------------------------------

/** Gameplay equipment slots (not the BSR visual slots). ring1/ring2 both take a 'ring'. */
export type EquipSlot =
  | 'head' | 'shoulders' | 'chest' | 'legs' | 'hands' | 'feet'
  | 'weapon' | 'shield' | 'earring' | 'necklace' | 'ring1' | 'ring2'

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'head', 'shoulders', 'chest', 'legs', 'hands', 'feet', 'weapon', 'shield', 'earring', 'necklace', 'ring1', 'ring2',
]

/** Where an item can be worn: an EquipSlot, except rings which fit ring1 or ring2. */
export type ItemSlotKind = Exclude<EquipSlot, 'ring1' | 'ring2'> | 'ring'

/** Which equip slots accept an item of a slot kind. */
export function equipSlotsFor(kind: ItemSlotKind): EquipSlot[] {
  return kind === 'ring' ? ['ring1', 'ring2'] : [kind]
}

export type ItemCategory =
  | 'weapon' | 'shield' | 'armor' | 'accessory'
  | 'potion' | 'pill' | 'scroll' | 'ammo' | 'gold' | 'quest' | 'etc'
  /** Wave 8: elixirs and Lucky Powders (TypeID 3/3/10/x; docs/SYSTEMS_COMBAT.md §4.1). */
  | 'alchemy'

/** Every ItemCategory (content-check). */
export const ITEM_CATEGORIES: readonly ItemCategory[] = ['weapon', 'shield', 'armor', 'accessory', 'potion', 'pill', 'scroll', 'ammo', 'gold', 'quest', 'etc', 'alchemy']

/** Chinese weapon families (TypeID 3/1/6/x); the five StarterWeapon values are the ones in scope. */
export type WeaponType = StarterWeapon

/** Chinese armour classes (client: TypeID4 1 garment, 2 protector, 3 armour). */
export type ArmorType = 'garment' | 'protector' | 'armor'

/** Stat block of an item definition: [min, max] of the roll, before + (enhancement) increments. */
export interface ItemStats {
  /** client itemdata cols 95-112 (physical/magical attack ranges). */
  physAttack?: Range
  magAttack?: Range
  /** client itemdata cols 63-85 (durability, PD, ER, PAR, BR, MD, MAR ranges). */
  physDefence?: Range
  magDefence?: Range
  parryRate?: Range
  blockRate?: Range
  physAbsorb?: Range
  magAbsorb?: Range
  durability?: Range
  /** client itemdata cols 113-117 (HR, critical). */
  hitRate?: Range
  critRate?: Range
}

/** Effect of a usable item (client itemdata Param1-4, cols 118-125). */
export interface ItemUse {
  /** Flat HP/MP restored. */
  hp?: number
  mp?: number
  /** Percent of max HP/MP restored. */
  hpPct?: number
  mpPct?: number
  /** Shared cooldown group and its time (potions of one kind share one cooldown). */
  cooldownGroup?: string
  cooldownMs?: number
  /** Teleports the user to its return point (return scroll). */
  returnToTown?: boolean
  /** Cast time before the effect (return scroll). */
  castMs?: number
  // ---- wave 8 (docs/SYSTEMS_COMBAT.md §6.3) ----
  /** Horse items: the CosDef code summoned (itemdata Param1 Desc, e.g. COS_C_HORSE1). */
  summon?: string
  /** Recovery Kits: 'mount' = the effect applies to the user's horse, not the user. Absent = self. */
  target?: 'mount'
}

/** The worn-item stats a +1 enhancement raises (ItemDef.perPlus keys). */
export type PerPlusStat = 'physAttack' | 'magAttack' | 'physDefence' | 'magDefence' | 'parryRate' | 'physAbsorb' | 'magAbsorb' | 'hitRate'
export const PER_PLUS_STATS: readonly PerPlusStat[] = ['physAttack', 'magAttack', 'physDefence', 'magDefence', 'parryRate', 'physAbsorb', 'magAbsorb', 'hitRate']

/** Alchemy material data (elixirs and Lucky Powders; docs/SYSTEMS_COMBAT.md §4.1, §4.3). */
export interface ItemReinforce {
  kind: 'elixir' | 'powder'
  /** Elixirs: the equipment TypeID3 values it fits (Param1 bytes, zero bytes dropped). */
  targets?: number[]
  /** Powders: the equipment degree it matches (Param1, 1..12). Never the powder's own ItemDef.degree. */
  degree?: number
  /** rates[i] = percent for target plus i + 1 (Param2-4 bytes, big-endian, 12 values). */
  rates: number[]
}

/** items.json: ContentFile<ItemDef>. itemdata rows (TypeID 3/x/x/x). */
export interface ItemDef {
  /** client: CodeName128, e.g. ITEM_CH_SWORD_01_A, ITEM_ETC_HP_POTION_01, ITEM_ETC_GOLD_01. */
  code: string
  /** client: ID (col 1). */
  id: number
  /** English name via NameStrID128 (col 5); null if missing. */
  name: string | null
  /** client: TypeID1-4 (cols 9-12). */
  typeId: [number, number, number, number]
  category: ItemCategory
  /** Equipment only. */
  slot?: ItemSlotKind
  weaponType?: WeaponType
  armorType?: ArmorType
  /** client: ceil(ItemClass col 61 / 3); 0 for items without a class. */
  degree: number
  /** client: the ReqLevel whose ReqLevelType is the character level (cols 32-39); 0 = none. */
  reqLevel: number
  /** client: ReqGender (col 58). */
  reqGender: 'male' | 'female' | 'any'
  /** client: Country (col 14): 0 china, 1 europe, 3 any. */
  race: 'china' | 'europe' | 'any'
  /** client: TwoHanded (col 93); weapons only. */
  twoHanded?: boolean
  /** Weapon reach beyond both body radii, metres (client: Range col 94 x 0.1). */
  range?: number
  /** Basic-attack skill code of a weapon (for the skills wave); client skilldata weapon basic attack. */
  basicAttack?: string
  stats?: ItemStats
  use?: ItemUse
  /** client: MaxStack (col 57); 1 = not stackable. */
  maxStack: number
  /** Buy price in gold (client: Price col 26) and NPC sell-back price (SellPrice col 31). */
  price: number
  sellPrice: number
  /** client: CanTrade/CanSell/CanDrop flags; absent = allowed. */
  canSell?: boolean
  canDrop?: boolean
  /** Wave 8 (docs/SYSTEMS_SOCIAL.md §8): client itemdata CanTrade col 16; false = no trade offer and no stall listing. */
  canTrade?: boolean
  /** Converted model (AssocFileObj128 col 52); null when not converted or none. */
  model: ModelRef | null
  /** Ground (dropped) model (AssocFileDrop128 col 53), when it differs from `model`. */
  dropModel?: ModelRef | null
  /** Icon URL (AssocFileIcon128 col 54, ddj -> png), e.g. /out/icon/item/china/weapon/sword_01_a.png; null if none. */
  icon: string | null
  fieldSources?: Record<string, string>
  // ---- wave 3 additions (docs/SHOPS.md §7.5; optional, absent = 0 / allowed) ----
  /** Storage fee per unit (client itemdata KeepingFee col 30). */
  keepFee?: number
  /** Repair cost of a fully broken item (client itemdata Cost_Repair col 27); 0/absent = not repairable. */
  repairCost?: number
  /** client itemdata CanRepair col 22 (0 = false). */
  canRepair?: boolean
  /** Authored: false = cannot go into storage (quest items). */
  canStore?: boolean
  /** Universal pills: highest abnormal-state level cured (client itemdata Param1: 36 / 68 / 108 / 172 / 228). */
  cureLevel?: number
  // ---- wave 8 additions (docs/SYSTEMS_COMBAT.md §6.3; optional) ----
  /** +1 increments (itemdata cols 67, 70, 73, 78, 81, 99, 104, 115): added x plus to the worn item's stat. */
  perPlus?: Partial<Record<PerPlusStat, number>>
  /** Alchemy materials (category 'alchemy'): what they fit and their per-plus success percents. */
  reinforce?: ItemReinforce
}

/** One item in a bag or equipment slot (also what the server stores). */
export interface ItemStack {
  /** ItemDef code. */
  code: string
  /** 1..ItemDef.maxStack. */
  count: number
  /** Enhancement level (+N); absent = 0. */
  plus?: number
  /** Current durability; absent = full. */
  durability?: number
}

/** Gold piles on the ground use these item codes (client itemdata), picked by amount. */
export const GOLD_ITEM_CODES = ['ITEM_ETC_GOLD_01', 'ITEM_ETC_GOLD_02', 'ITEM_ETC_GOLD_03'] as const

// ---- skills (docs/SKILLS.md; executed by the server from wave 3) ------------------------------------------

/** skilldata Param1 category (col 68). */
export type SkillCategory = 'melee' | 'ranged' | 'buff' | 'passive'

/** Damage parameters (client: skilldata FourCC 'att' record; 'mc' [2, N] = hit count). */
export interface SkillDamage {
  /** Percent of the attacker's physical / magical attack. */
  physPct: number
  magPct: number
  /** Flat damage added, [min, max]. */
  flat: Range
  hits: number
}

/** skills.json: ContentFile<SkillDef>. skilldata rows (§4.3, §5.5 of the research report). */
export interface SkillDef {
  /** client: Basic_Code (col 3), e.g. SKILL_CH_SWORD_SMASH_A_01. */
  code: string
  /** client: ID (col 1). */
  id: number
  name: string | null
  /** Mastery code (MasteryDef.code) and required mastery level (client: cols 34-37). */
  mastery: string | null
  masteryLevel: number
  /** client: Basic_Level (col 7). */
  skillLevel: number
  /** SP to learn (client: col 46). */
  sp: number
  /** MP cost (client: col 53). */
  mp: number
  category: SkillCategory
  /** Server release time: action start -> damage (client: CastingTime col 12). */
  castMs: number
  /** Recovery after release; the action closes at castMs + actionMs (client: ActionDuration col 13). */
  actionMs: number
  /** Cooldown (client: ReuseDelay col 14); for basic attacks the repeat cadence. */
  cooldownMs: number
  /** Reach beyond both body radii, metres (client: Range col 21 x 0.1). */
  range: number
  /** Weapons that can use it (client: cols 50/51); empty = any. */
  weapons: WeaponType[]
  /** Next segment of a chain (client: Basic_ChainCode col 9), a skill code. */
  chainNext?: string
  /** Animation type names per phase (client: skilleffect skillaniset2 cols 7-9), e.g. { shot: 'SKILL_5' }. */
  animation?: { ready?: string; wait?: string; shot?: string }
  damage?: SkillDamage
  /** True for weapon basic attacks (auto-attack). */
  basicAttack?: boolean
  icon: string | null
  // ---- wave 3 additions (docs/SKILLS.md §3; all optional, absent = the default in parentheses) ----
  /** client: Basic_Group (col 5), e.g. SKILL_CH_SWORD_SMASH_A: rows of one line share it (cooldowns, learning). */
  group?: string
  /** What the skill does (col 8 + params); present on every exported row. */
  kind?: SkillKind
  /** Target rules (cols 22-33); present on every exported row. */
  targets?: SkillTargets
  /** English tooltip text (UI_SkillToolTip_Desc col 64). */
  description?: string
  /** Basic_Activity 1 (col 8): used instantly, without an action (imbues, Grass Walk). (false) */
  instant?: true
  /** Skill window placement (cols 57-60); absent = not shown (basic attacks, chain segments after the first). */
  ui?: SkillUi
  /** skillaniset2 AniGroup (col 6): SWORD / SPEAR / BOW / DEFAULT. */
  aniGroup?: string
  /** Damage moments (skilleffectset DMG Event rows), in play order. */
  hitCues?: SkillHitCue[]
  /** 'dura' (ms): how long the buff / imbue window lasts. */
  durationMs?: number
  area?: SkillArea
  statuses?: SkillStatus[]
  heal?: SkillHeal
  /** 'onff' [interval ms, MP]: a toggle that drains MP every interval while on (Crystal Wall). */
  toggle?: { intervalMs: number; mp: number }
  /** 'reqi' [TypeID3, TypeID4]: item that must be equipped (4/1 Chinese shield, 6/6 bow). */
  requiresItem?: { typeId3: number; typeId4: number }
  /** 'reqc' [state]: target state required (1 = knocked down, for Flower Bloom Blade). */
  requiresTargetState?: number
  /** 'cnsm' [TypeID3, TypeID4, count]: ammunition consumed per use (bow skills: 1 arrow). */
  consumes?: { typeId3: number; typeId4: number; count: number }
  /** Consume_HPRatio / Consume_MPRatio (cols 54, 55), percent. */
  hpPct?: number
  mpPct?: number
  /** ReqCommon_Str / Int (cols 38, 39). */
  reqStr?: number
  reqInt?: number
  /** Action_Overlap (col 18) raw: low byte = buff stacking class (all imbues 1), high byte set on attack skills. */
  overlap?: number
  /** Action_AutoAttackType (col 19): 1 on attack skills (basic attack resumes after), 2 on some ranged/buff rows. */
  autoAttack?: number
  /** Chain segments: the first segment's code and this segment's 1-based position. */
  chainRoot?: string
  chainIndex?: number
  /** FourCC parameter records (cols 69-117) as stored; the decoded fields above cover the known tags. */
  params?: SkillParamRecord[]
  /** PreparingTime (col 11): the READY phase before the cast (charged skills). (0) */
  preparingMs?: number
  /** Consume_HP (col 52): flat HP cost. (0) */
  hp?: number
  /** ReqLearn_Skill1-3 (cols 40-45): skill groups and levels that must be learned first. */
  requires?: { group: string; level: number }[]
  // ---- wave 8 additions (docs/SYSTEMS_COMBAT.md §2.4; monster rows MSKILL_*) ----
  /** Monster row: never learnable or usable by players (SkillEngine.plan already refuses mastery null). */
  mob?: true
  /** skilldata AI_AttackChance (col 66): the pick weight on attack rows; the HP-% band on SUMMON rows. */
  aiChance?: number
  /** 'ssou' records of a SUMMON row: [refObjId, rarity byte, min, max] resolved to mob codes. */
  summon?: SkillSummon[]
}

/** One 'ssou' record of a monster SUMMON row (docs/SYSTEMS_COMBAT.md §2.2). */
export interface SkillSummon {
  /** MobDef code. */
  mob: string
  /** The rarity byte (0 normal, 1 champion, 4 giant, 6 elite). */
  rarity: number
  min: number
  max: number
}

/**
 * What the skill does, for the engine and the tooltip: passive (activity 0 / Param1 4), imbue (activity 1 with an
 * 'att' record: the weapon-infusing force skills), attack ('att'), resurrect ('resu'), heal ('heal'), cure
 * ('curt'/'curl'), debuff (hits enemies with statuses only: Cold wave - Arrest), otherwise buff.
 */
export type SkillKind = 'passive' | 'imbue' | 'attack' | 'resurrect' | 'heal' | 'cure' | 'debuff' | 'buff'

export const SKILL_KINDS: readonly SkillKind[] = ['passive', 'imbue', 'attack', 'resurrect', 'heal', 'cure', 'debuff', 'buff']

/** skilldata TargetGroup flags (cols 26-32), in column order. */
export type SkillTargetGroup = 'self' | 'ally' | 'party' | 'enemy_mob' | 'enemy_player' | 'neutral' | 'any'

/** skilldata cols 22-33: Target_Required, TargetType_Animal/Land/Building, TargetGroup_Self..DontCare, SelectDeadBody. */
export interface SkillTargets {
  /** Target_Required (col 22): the skill needs a selected target. */
  required: boolean
  /** TargetGroup flags (cols 26-32), in column order. */
  groups: SkillTargetGroup[]
  /** TargetEtc_SelectDeadBody (col 33): resurrection targets a corpse. */
  deadBody?: true
}

/**
 * Skill window placement (cols 57-60): tab 0 weapon / 1 force (skillmasterydata Type), page = the mastery within
 * the tab (Bicheon 0, Heuksal 1, Pacheon 2; Cold 0, Lightning 1, Fire 2, Force 3), column = the skill line
 * (skillgroup.txt row: 0 Smash, 1 Chain, ... 8 passive), row = the tier (A 0, B 1, C 2).
 */
export interface SkillUi {
  tab: 'weapon' | 'force'
  page: number
  column: number
  row: number
}

/**
 * 'efr' [1, shape, distance, maxTargets, reduction, targetMask] (docs/SKILLS.md §4.2): 1 a circle around the caster,
 * 2 a circle around the primary target, 3 a melee pierce, 4 a projectile pierce, 6 a chain from target to target.
 */
export interface SkillArea {
  shape: 'caster' | 'target' | 'pierce' | 'projectile_pierce' | 'chain' | `unknown_${number}`
  /** metres (arg 2 x 0.1): radius for caster/target circles and chain jumps; unconfirmed for the pierce shapes. */
  distance: number
  /** Counts the primary target (0 = unlimited). */
  maxTargets: number
  /** Arg 4 as stored (percent; probably the damage reduction for secondary targets, unconfirmed). */
  reductionPct: number
  /** Target-group bits of cols 26-30 (1 self, 2 ally, 4 party, 8 enemy mob, 16 enemy player). */
  targetMask: number
  raw: number[]
}

/**
 * Abnormal states and crowd control a skill inflicts (param records fz fb es bu ps zb dn st ko kb; docs/SKILLS.md
 * §4.1). `status` values are the protocol's SkillStatusKind.
 */
export interface SkillStatus {
  status: SkillStatusKind
  level: number
  chancePct: number
  durationMs?: number
  /** Remaining args as stored (es: effect %, bu: damage, kb: first arg). */
  extra?: number[]
}

/** 'heal' [hp, hp %, mp, mp %]. */
export interface SkillHeal {
  hp: number
  hpPct: number
  mp: number
  mpPct: number
}

/**
 * A damage moment (skilleffectset DMG Event row, docs/SKILLS.md §5.3): `event` N = the N-th hit event of that
 * phase's clip, 0 = the phase start. `projectile` = the damage shows on arrival.
 */
export interface SkillHitCue {
  phase: string
  event: number
  projectile?: { move: string; delayMs: number; speed: number }
}

/** One FourCC parameter record of skilldata ('' tag for values before the first tag). */
export interface SkillParamRecord {
  tag: string
  args: number[]
}

/** masteries.json: ContentFile<MasteryDef>. */
export interface MasteryDef {
  /** e.g. 'BICHEON' (client: mastery id 257 = UIIT_STT_MASTERY_VI). */
  code: string
  /** client mastery id, e.g. 257. */
  id: number
  name: string | null
  race: 'china' | 'europe'
  weapons: WeaponType[]
  /** Skill codes, lowest mastery level first. */
  skills: string[]
  // ---- wave 3 additions (skillmasterydata; optional) ----
  /** Skill window tab (col 6 Type: 0 weapon, 1 force). */
  tab?: 'weapon' | 'force'
  /** Page inside the tab (the skills' UI_SkillPage): Bicheon 0 .. Pacheon 2, Cold 0 .. Force 3. */
  page?: number
  /** Skill lines on the page (col 3 GroupNum). */
  lines?: number
  /** Tab caption (col 5 via the string tables). */
  tabName?: string
  /** Mastery icon URLs (cols 11/12), e.g. /out/icon/skillmastery/china/mastery_sword.png. */
  icon?: string
  iconFocus?: string
}

// ---- NPCs and shops ---------------------------------------------------------------------------------

/** npcs.json: ContentFile<NpcDef>. characterdata rows with TypeID 1/2/2/x placed by npcpos.txt. */
export interface NpcDef {
  /** client: CodeName128 of the NPC character, e.g. NPC_CH_POTION. */
  code: string
  name: string | null
  /** glTF metres in the world manifest frame (client: npcpos.txt region + local x/y/z). */
  x: number
  z: number
  y?: number
  /** radians about +Y (protocol yaw convention). */
  yaw: number
  world: string
  /** ShopDef id when the NPC sells items. */
  shop?: string
  /** Services beyond a shop ('teleport', 'storage'; wave 8: 'repair' on NPC_CH_SMITH / NPC_CH_ARMOR). */
  roles?: string[]
  model: ModelRef | null
  provenance: Provenance
  /** Wave 3: English greeting (npcchat.txt SN_<code>_BS -> textquest_speech&name.txt col 8); absent = a generic line. */
  greeting?: string
}

/** cos.json: ContentFile<CosDef> (kind 'cos'; wave 8, docs/SYSTEMS_COMBAT.md §6.3). characterdata TypeID 1/2/3/1. */
export interface CosDef {
  /** client: CodeName128 (col 2), e.g. COS_C_HORSE1. */
  code: string
  id: number
  name: string | null
  /** client: Lvl (57), MaxHP (59). */
  level: number
  hp: number
  /** m/s (cols 46/47 x 0.1): 4.5 / 9.0 for the Red Horse. */
  walkSpeed: number
  runSpeed: number
  /** metres (BCRadius col 50 x 0.1). */
  radius: number
  physAbsorb: number
  magAbsorb: number
  parryRate: number
  hitRate: number
  model: ModelRef | null
  /** client: AssocFileIcon128 (col 54), e.g. /out/icon/cos/cos_c_horse1.png. */
  icon: string | null
  fieldSources?: Record<string, string>
}

/** shops.json: ContentFile<ShopDef>. client: refshop* tables (port: npcshops.json only as a fallback). */
export interface ShopDef {
  /** Stable id, e.g. the client shop CodeName128 (STORE_CH_POTION). */
  id: string
  /** NPC codes that open this shop. */
  npcs: string[]
  /**
   * `reqGender` (wave 3, armour tabs): the gender the tab group sells for (refshoptabgroup GROUP1 = male,
   * GROUP2 = female); absent = everyone.
   */
  tabs: { name: string; items: string[]; reqGender?: 'male' | 'female' }[]
  provenance: Provenance
}

// ---- drops ----------------------------------------------------------------------------------------

/** One weighted choice of a drop group. */
export interface DropEntry {
  /** ItemDef code. */
  item: string
  /** Relative weight inside its group. */
  weight: number
  /** Stack size rolled uniformly, [min, max]; absent = 1. */
  count?: Range
}

/** A drop group is rolled once per kill with `chance`, then one entry is picked by weight. */
export interface DropGroup {
  /** 0..1. */
  chance: number
  entries: DropEntry[]
}

/**
 * drops.json: ContentFile<DropTable>, one per mob code. port: _RefDropGold (gold) and the
 * _RefMonster_AssignedItem(Rnd)Drop / _RefDropItemGroup / _RefDropClassSel_* chain (items); provenance PROVENANCE_PORT.
 * Only items that exist in items.json are kept.
 */
export interface DropTable {
  mob: string
  /** Gold: dropped with `chance` (0..1), amount uniform in `amount`. */
  gold?: { chance: number; amount: Range }
  groups: DropGroup[]
  provenance: Provenance
}

// ---- uniques (wave 11) ----------------------------------------------------------------------------

/**
 * content/uniques.json (ours, authored; docs/UNIQUES.md §3, §5.3; not an export, not in CONTENT_FILES): the unique
 * monsters run as world bosses by the server's uniques module. Check with checkUniquesFile(); the server refuses to
 * start on any problem (an unknown mob, no camps, a bad range, a missing drop table).
 */
export const UNIQUES_FILE = 'uniques.json'

export interface UniquesFile {
  schema: 1
  kind: 'uniques'
  uniques: UniqueDef[]
  /** Unique drop tables by id (`UniqueDef.drops`); they replace the mob's drops.json row for the field unique. */
  dropTables: Record<string, UniqueDropTable>
}

/** One unique (docs/UNIQUES.md §3.2 spawn rules, §3.6 behaviour). Times in minutes or seconds as named. */
export interface UniqueDef {
  /** MobDef code, e.g. MOB_CH_TIGERWOMAN. */
  mob: string
  /** World folder (base name), e.g. 'jangan'. */
  world: string
  /** 'uniqueGroup' = the nests of the mob's `uniqueGroup` in nests.json, re-read at every roll; or explicit nest ids. */
  camps: 'uniqueGroup' | number[]
  /** Respawn after a kill (or a GM despawn), uniform [min, max] minutes. */
  respawnMin: Range
  /** First spawn on a fresh database, minutes after the server starts. */
  firstSpawnMin: Range
  /** Spawn after a restart while alive, or a restart that finds the due time passed, minutes after the boot. */
  restartSpawnMin: Range
  /** Multipliers on the `unique` variant's stats (createMob's MobTuning path). */
  tuning: { hpMul: number; attackMul: number; expMul: number }
  /** The rows' own SUMMON bands (aiChance 80 / 60 / 40); each wave clipped to `perWave`, `maxAlive`, `variants`. */
  summons: { on: boolean; perWave: number; maxAlive: number; variants: MobVariant[] }
  /** At or below `hpPct` % HP, outgoing damage × `damageMul`, once per life. */
  enrage: { hpPct: number; damageMul: number }
  /** `afterSec` after the fight started (first damage since the last reset), outgoing damage × `damageMul`. */
  fury: { afterSec: number; damageMul: number }
  /** Corpse time in seconds (normal mobs keep CORPSE_MS). */
  corpseSec: number
  /** Server-wide `uniqueNotice` on appear / defeat; the mob's own roar to players within `roarRadiusM` at the spawn. */
  announce: { appear: boolean; defeat: boolean; roarRadiusM: number }
  /** UniquesFile.dropTables id. */
  drops: string
}

/** A unique's loot (docs/UNIQUES.md §3.4). Every group is rolled `rolls` times (default 1), each with `chance`. */
export interface UniqueDropTable {
  /** `piles` gold drops of `amount` each, with `chance` (0..1). */
  gold?: { chance: number; piles: number; amount: Range }
  groups: UniqueDropGroup[]
}

/**
 * One group: `chance` (0..1) per roll, then one pick by weight from `entries` (the DropGroup format), or from the
 * gear pool `pool` (resolved from items.json at server start). `plus` rolls the dropped item's plus level by weight.
 */
export interface UniqueDropGroup {
  chance: number
  /** Times this group is rolled; default 1. */
  rolls?: number
  entries?: DropEntry[]
  pool?: UniqueGearPool
  /** Plus levels by weight, e.g. [{plus: 0, weight: 55}, {plus: 1, weight: 25}, ...]; absent = +0. */
  plus?: Array<{ plus: number; weight: number }>
}

/**
 * A gear pool rule: equipment of `degree` (weapons, shields, armour of both sexes, accessories) whose `reqLevel` is at
 * most `maxReqLevel` ('levelCap' = the server's LEVEL_CAP). `gradeWeights` weight the wearable grades from the highest
 * down (e.g. [60, 40]); `rare` picks the `_RARE` (Seal of Star) rows instead of the normal ones.
 */
export interface UniqueGearPool {
  degree: number
  maxReqLevel: 'levelCap' | number
  gradeWeights?: number[]
  rare?: boolean
}

// ---- towns ----------------------------------------------------------------------------------------

/** towns.json (exporter; a ContentFile-shaped wrapper with kind 'towns', not part of CONTENT_FILES). */
export const TOWNS_FILE = 'towns.json'

/**
 * A town: its return point (client teleportdata arrival point, y = terrain height) and its safe area (port
 * safe-areas.json, provenance PROVENANCE_PORT): no combat inside, and monsters ignore players standing there.
 * glTF metres in the world manifest frame.
 */
export interface TownDef {
  code: string
  name: string
  world: string
  spawn: { x: number; y: number; z: number }
  /** Axis-aligned rectangle: centre and half extents (metres). */
  safeArea?: { x: number; z: number; halfX: number; halfZ: number }
  /** Region ids (z << 8 | x) of the town. */
  regions?: number[]
}

// ---- zones ----------------------------------------------------------------------------------------

/**
 * zones.json (exporter, docs/FIELDS.md §6.2; a ContentFile-shaped wrapper with kind 'zones', not part of
 * CONTENT_FILES, like towns.json). One ZoneDef per region of the world export. Check with checkZoneDef().
 */
export const ZONES_FILE = 'zones.json'

/** One region of the world export with its client names (textzonename.txt, refregion.txt). Provenance: client. */
export interface ZoneDef {
  /** Region id z << 8 | x. */
  region: number
  rx: number
  rz: number
  /** English area name: textzonename.txt tab field 8 (0-based; header 'English') for this region id; '' when none. */
  name: string
  /**
   * refregion.txt field 4 (AreaName) only when it is a readable code (/^[A-Za-z0-9_]+$/, e.g. 'Town_Jangan');
   * null otherwise (the other values are literal '?' runs in this client).
   */
  area: string | null
  /** refregion.txt field 3 (ContinentName: 'CHINA' | 'West_China' ...); null when the region has no refregion row. */
  continent: string | null
  /** towns.json code when the region belongs to a town (TownDef.regions). */
  town?: string
}

// ---- levels ---------------------------------------------------------------------------------------

/** levels.json: LevelDef[] (bare array, same shape the exporter already writes). client: leveldata.txt. */
export interface LevelDef {
  level: number
  /** EXP to go from `level` to `level + 1`, not cumulative (col 1). */
  exp: number
  /** SP to raise a weapon mastery to `level` (col 2). */
  masterySp: number
}

/** SRO growth rules the server applies (research report §4.5). */
export const CHARACTER_RULES = {
  /** STR and INT of a new level-1 character. */
  baseStr: 20,
  baseInt: 20,
  /** Every level-up adds 1 STR, 1 INT and this many free stat points. */
  statPointsPerLevel: 3,
  /** SP-EXP per skill point. */
  spExpPerSp: 400,
  /** Bag slots of a new character. */
  bagSize: 48,
} as const

// ---- reading helpers ---------------------------------------------------------------------------------

/** Entries of a content file: a ContentFile wrapper or a bare array (levels.json). Throws on anything else. */
export function contentEntries<T>(json: unknown, kind?: ContentKind): T[] {
  if (Array.isArray(json)) return json as T[]
  if (typeof json === 'object' && json !== null) {
    const f = json as Partial<ContentFile<T>>
    if (f.schema !== CONTENT_SCHEMA_VERSION) throw new Error(`content file schema ${String(f.schema)} is not ${CONTENT_SCHEMA_VERSION}`)
    if (kind && f.kind !== kind) throw new Error(`content file kind ${String(f.kind)} is not ${kind}`)
    if (Array.isArray(f.entries)) return f.entries
  }
  throw new Error('not a content file')
}
