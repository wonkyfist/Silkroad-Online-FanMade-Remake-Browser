/**
 * The Climb to 25 (docs/CLIMB.md, wave 14 rebased to a cap of 25; build plan §20, layers L0 and L1): the re-levelled
 * monster roster (§2.2), the bands and their per-area remap, the level-difference EXP rule (§2.3), the four degrees'
 * required levels spaced inside the cap and degree 4 as the cap tier (§4.1.2, D53), the gear tiers (§4.1), the re-levelling of a boss to a new level (§2.6) and the
 * bar-fraction EXP conversion of live characters (§9.2, §9.3a). Pure and environment-neutral: the server and the client
 * both run `deriveClimbMobs`, so a `MOB_CL_*` entity finds its base's model, skills and clips on both sides.
 *
 * The roster's numbers are the model's `derive()` (work/tmp/climb25/gen-roster.ts over the real export, band attack and
 * gold factors applied; HP, attack and defence on the standard-monster curve, damage per second normalised into
 * 0.85–1.2 × standard). They are absolute values: a re-export of mobs.json changes the base's model, speed and skills,
 * never these numbers. Hit and parry are 25 + 2 × level and absorb = level (the retail rules); EXP is 23.5 × level.
 * The EXP curve itself is content (content/climb/levels.json, read by the server: CLIMB_LEVELS_FILE).
 */
import type { DropTable, ItemDef, MobDef, Range } from './content.ts'

/** The Climb's level cap (CLIMB §0.2; protocol.ts DEFAULT_LEVEL_CAP follows it). */
export const CLIMB_CAP = 25
/** The cap the live characters were saved under before the Climb (§9.3a: level 20s start the 20 → 21 bar at 0 %). */
export const PRE_CLIMB_CAP = 20
/** The cap-25 EXP curve (§3.2a), relative to CONTENT_DIR: `{ schema: 1, kind: 'climb-levels', exp: number[] }`. */
export const CLIMB_LEVELS_FILE = 'climb/levels.json'
/** characters.curve_version after the conversion to the cap-25 curve (db.ts migration 21). */
export const CLIMB_CURVE_VERSION = 1

export type ClimbRole = 'pack' | 'ranged' | 'healer' | 'coward' | 'caster'
export type ClimbBandId = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'B7' | 'B8'

/** One derived monster (§2.2): a new code on a retail base, with its own level and numbers. */
export interface ClimbRow {
  code: string
  /** The retail MobDef it is built on (model, skills, clips, speed, drop items). */
  base: string
  name: string
  band: ClimbBandId
  level: number
  /** Behaviours (layer L3 runs them; data only until then). */
  roles?: ClimbRole[]
  /** Helpers a coward calls: [min, max] (§2.3; default [1, 1]). */
  callN?: Range
  hp: number
  physAttack: Range
  magAttack: Range
  physDefence: number
  magDefence: number
  exp: number
  /** Gold per drop, standard gold of the level × the band's gold factor. */
  gold: Range
  /** Only summoned (Tiger Girl's Guard): never the result of a nest remap. */
  summonOnly?: true
}

export const CLIMB_ROSTER: readonly ClimbRow[] = [
  // B1
{ code: 'MOB_CL_MANGNYANG_1', base: 'MOB_CH_MANGNYANG', name: 'Mangyang', band: 'B1', level: 1, hp: 54, physAttack: [24, 27], magAttack: [0, 0], physDefence: 7, magDefence: 10, exp: 24, gold: [28, 59] },
  { code: 'MOB_CL_SMALLEYE_2', base: 'MOB_CH_BIGEYEGHOST_CLON', name: 'Small-Eyed Ghost', band: 'B1', level: 2, roles: ['pack'], hp: 55, physAttack: [21, 23], magAttack: [0, 0], physDefence: 9, magDefence: 14, exp: 47, gold: [32, 66] },
  { code: 'MOB_CL_BIGEYE_3', base: 'MOB_CH_BIGEYEGHOST', name: 'Big-Eyed Ghost', band: 'B1', level: 3, roles: ['pack'], hp: 85, physAttack: [23, 27], magAttack: [0, 0], physDefence: 9, magDefence: 15, exp: 71, gold: [35, 74] },
  { code: 'MOB_CL_OLDWEASEL_4', base: 'MOB_CH_GYO_CLON', name: 'Old Weasel', band: 'B1', level: 4, roles: ['coward'], callN: [1, 1], hp: 83, physAttack: [30, 34], magAttack: [0, 0], physDefence: 12, magDefence: 18, exp: 94, gold: [39, 81] },
  { code: 'MOB_CL_WEASEL_5', base: 'MOB_CH_GYO', name: 'Weasel', band: 'B1', level: 5, roles: ['coward', 'pack'], callN: [1, 1], hp: 119, physAttack: [35, 40], magAttack: [0, 0], physDefence: 12, magDefence: 19, exp: 118, gold: [42, 89] },
  // B2
  { code: 'MOB_CL_WGSLAVE_6', base: 'MOB_CH_WATERGHOST_CLON', name: 'Water Ghost Slave', band: 'B2', level: 6, roles: ['pack'], hp: 114, physAttack: [43, 49], magAttack: [0, 0], physDefence: 15, magDefence: 19, exp: 141, gold: [53, 110] },
  { code: 'MOB_CL_WATERGHOST_7', base: 'MOB_CH_WATERGHOST', name: 'Water Ghost', band: 'B2', level: 7, roles: ['healer'], hp: 156, physAttack: [49, 57], magAttack: [0, 0], physDefence: 15, magDefence: 29, exp: 165, gold: [56, 118] },
  { code: 'MOB_CL_BROKENSTONE_8', base: 'MOB_CH_STONEGHOST_CLON', name: 'Broken Stone Ghost', band: 'B2', level: 8, roles: ['pack'], hp: 204, physAttack: [49, 58], magAttack: [0, 0], physDefence: 22, magDefence: 24, exp: 188, gold: [61, 128] },
  { code: 'MOB_CL_TOMBGHOST_8', base: 'MOB_CH_TOMBSTONE_CLON', name: 'Tomb Stone Ghost', band: 'B2', level: 8, roles: ['ranged', 'caster'], hp: 204, physAttack: [0, 0], magAttack: [78, 87], physDefence: 15, magDefence: 35, exp: 188, gold: [61, 128] },
  { code: 'MOB_CL_STONEGHOST_9', base: 'MOB_CH_STONEGHOST', name: 'Stone Ghost', band: 'B2', level: 9, roles: ['pack'], hp: 194, physAttack: [66, 77], magAttack: [0, 0], physDefence: 22, magDefence: 35, exp: 212, gold: [64, 136] },
  { code: 'MOB_CL_TOMBSTONE_9', base: 'MOB_CH_TOMBSTONE', name: 'Tomb Stone', band: 'B2', level: 9, roles: ['ranged', 'healer'], hp: 194, physAttack: [0, 0], magAttack: [88, 99], physDefence: 22, magDefence: 29, exp: 212, gold: [64, 136] },
  // B3
  { code: 'MOB_CL_YEOHA_10', base: 'MOB_CH_YEOHA', name: 'Yeoha', band: 'B3', level: 10, roles: ['pack'], hp: 249, physAttack: [77, 91], magAttack: [0, 0], physDefence: 22, magDefence: 41, exp: 235, gold: [75, 158] },
  { code: 'MOB_CL_DECAYED_10', base: 'MOB_CH_YEOHA_CLON', name: 'Decayed Yeoha', band: 'B3', level: 10, roles: ['healer'], hp: 249, physAttack: [77, 91], magAttack: [0, 0], physDefence: 26, magDefence: 35, exp: 235, gold: [75, 158] },
  { code: 'MOB_CL_BANDITSUB_11', base: 'MOB_CH_BANDIT_CLON', name: 'Bandit Subordinate', band: 'B3', level: 11, roles: ['coward'], hp: 310, physAttack: [73, 86], magAttack: [0, 0], physDefence: 29, magDefence: 34, exp: 259, gold: [79, 166] },
  { code: 'MOB_CL_ARCHER_12', base: 'MOB_CH_BANDITARCHER', name: 'Bandit Archer', band: 'B3', level: 12, roles: ['ranged'], hp: 324, physAttack: [95, 113], magAttack: [0, 0], physDefence: 29, magDefence: 46, exp: 282, gold: [84, 175] },
  { code: 'MOB_CL_YOUNGTIGER_12', base: 'MOB_CH_TIGER_CLON', name: 'Young Tiger', band: 'B3', level: 12, roles: ['pack'], hp: 334, physAttack: [80, 95], magAttack: [0, 0], physDefence: 26, magDefence: 50, exp: 282, gold: [84, 175] },
  { code: 'MOB_CL_YEOHA_13', base: 'MOB_CH_YEOHA', name: 'Elder Yeoha', band: 'B3', level: 13, roles: ['pack'], hp: 433, physAttack: [105, 123], magAttack: [0, 0], physDefence: 31, magDefence: 57, exp: 306, gold: [88, 185] },
  // B4
  { code: 'MOB_CL_GRAVESTONE_12', base: 'MOB_CH_STONEGHOST_CLON', name: 'Grave Stone Ghost', band: 'B4', level: 12, roles: ['pack'], hp: 388, physAttack: [77, 90], magAttack: [0, 0], physDefence: 33, magDefence: 43, exp: 282, gold: [121, 252] },
  { code: 'MOB_CL_SENTINEL_13', base: 'MOB_CH_STONEGHOST', name: 'Tomb Sentinel', band: 'B4', level: 13, roles: ['pack'], hp: 361, physAttack: [100, 117], magAttack: [0, 0], physDefence: 34, magDefence: 55, exp: 306, gold: [126, 266] },
  { code: 'MOB_CL_KEEPER_14', base: 'MOB_CH_TOMBSTONE_CLON', name: 'Tomb Keeper', band: 'B4', level: 14, roles: ['ranged', 'healer'], hp: 518, physAttack: [0, 0], magAttack: [146, 163], physDefence: 33, magDefence: 65, exp: 329, gold: [133, 279] },
  { code: 'MOB_CL_RESTLESS_15', base: 'MOB_CH_TOMBSTONE', name: 'Restless Tomb Stone', band: 'B4', level: 15, roles: ['ranged', 'caster'], hp: 477, physAttack: [0, 0], magAttack: [159, 178], physDefence: 41, magDefence: 61, exp: 353, gold: [139, 293] },
  // B5
  { code: 'MOB_CL_TIGER_14', base: 'MOB_CH_TIGER', name: 'Tiger', band: 'B5', level: 14, roles: ['pack'], hp: 509, physAttack: [91, 109], magAttack: [0, 0], physDefence: 35, magDefence: 56, exp: 329, gold: [222, 465] },
  { code: 'MOB_CL_BOWMAN_15', base: 'MOB_CH_BANDITARCHER_CLON', name: 'Bandit Bowman', band: 'B5', level: 15, roles: ['ranged'], hp: 514, physAttack: [117, 141], magAttack: [0, 0], physDefence: 44, magDefence: 70, exp: 353, gold: [231, 489] },
  { code: 'MOB_CL_BANDIT_16', base: 'MOB_CH_BANDIT', name: 'Bandit', band: 'B5', level: 16, roles: ['coward'], hp: 755, physAttack: [107, 129], magAttack: [0, 0], physDefence: 51, magDefence: 70, exp: 376, gold: [243, 510] },
  { code: 'MOB_CL_BLACKTIGER_17', base: 'MOB_CH_WHITETIGER_CLON', name: 'Black Tiger', band: 'B5', level: 17, roles: ['pack'], hp: 749, physAttack: [115, 137], magAttack: [0, 0], physDefence: 42, magDefence: 89, exp: 400, gold: [252, 531] },
  { code: 'MOB_CL_WHITETIGER_18', base: 'MOB_CH_WHITETIGER', name: 'White Tiger', band: 'B5', level: 18, roles: ['pack'], hp: 809, physAttack: [122, 145], magAttack: [0, 0], physDefence: 55, magDefence: 89, exp: 423, gold: [264, 555] },
  { code: 'MOB_CL_ARCHER_18', base: 'MOB_CH_BANDITARCHER', name: 'Stronghold Archer', band: 'B5', level: 18, roles: ['ranged'], hp: 724, physAttack: [144, 172], magAttack: [0, 0], physDefence: 51, magDefence: 85, exp: 423, gold: [264, 555] },
  // B5 extras (§2.2 rule 2): the Tiger Mountains are not full of level-11 fodder
  { code: 'MOB_CL_BANDITSUB_15', base: 'MOB_CH_BANDIT_CLON', name: 'Bandit Subordinate', band: 'B5', level: 15, roles: ['coward'], hp: 553, physAttack: [100, 118], magAttack: [0, 0], physDefence: 42, magDefence: 57, exp: 353, gold: [231, 489] },
  { code: 'MOB_CL_YOUNGTIGER_14', base: 'MOB_CH_TIGER_CLON', name: 'Young Tiger', band: 'B5', level: 14, roles: ['pack'], hp: 446, physAttack: [92, 109], magAttack: [0, 0], physDefence: 32, magDefence: 62, exp: 329, gold: [222, 465] },
  // B7
  { code: 'MOB_CL_CHAKJIWORKER_19', base: 'MOB_CH_CHAKJI_CLON', name: 'Chakji Worker', band: 'B7', level: 19, roles: ['coward'], callN: [1, 2], hp: 958, physAttack: [123, 146], magAttack: [0, 0], physDefence: 59, magDefence: 95, exp: 447, gold: [309, 653] },
  { code: 'MOB_CL_CHAKJI_20', base: 'MOB_CH_CHAKJI', name: 'Chakji', band: 'B7', level: 20, roles: ['pack'], hp: 1031, physAttack: [131, 158], magAttack: [0, 0], physDefence: 64, magDefence: 102, exp: 470, gold: [323, 680] },
  { code: 'MOB_CL_GHOSTBUG_21', base: 'MOB_WC_GHOSTBUG', name: 'Ghost Bug', band: 'B7', level: 21, roles: ['pack'], hp: 1106, physAttack: [127, 152], magAttack: [0, 0], physDefence: 73, magDefence: 102, exp: 494, gold: [333, 704] },
  { code: 'MOB_CL_DEVILBUG_22', base: 'MOB_WC_DEVILBUG', name: 'Devil Bug', band: 'B7', level: 22, roles: ['pack'], hp: 1184, physAttack: [132, 157], magAttack: [0, 0], physDefence: 68, magDefence: 124, exp: 517, gold: [347, 728] },
  { code: 'MOB_CL_HYUNGNO_23', base: 'MOB_WC_HYUNGNO', name: 'Hyungno Ghost Soldier', band: 'B7', level: 23, roles: ['pack'], hp: 1264, physAttack: [162, 193], magAttack: [0, 0], physDefence: 77, magDefence: 124, exp: 541, gold: [357, 755] },
  // B8 (D53: the level-24/25 rows against the cap tier, degree 4; L8 2026-10-14: × 1.3 HP, × 1.1 attack, were × 1.6 / × 1.2,
  // which made the Sea Cliffs a dead band: 2.5–3.3 deaths/h for an average solo player in degree 4, a duo dying too)
  { code: 'MOB_CL_HYUNGNOSHAMAN_24', base: 'MOB_WC_HYUNGNO_CLON', name: 'Hyungno Shaman', band: 'B8', level: 24, roles: ['healer'], hp: 1751, physAttack: [183, 220], magAttack: [0, 0], physDefence: 77, magDefence: 140, exp: 564, gold: [392, 824] },
  { code: 'MOB_CL_POWDER_24', base: 'MOB_WC_GUNPOWDERGHOST_CLON', name: 'Powder Ghost', band: 'B8', level: 24, roles: ['ranged', 'caster'], hp: 1495, physAttack: [0, 0], magAttack: [296, 339], physDefence: 75, magDefence: 134, exp: 564, gold: [392, 824] },
  { code: 'MOB_CL_EARTHGHOST_25', base: 'MOB_WC_EARTHGHOST', name: 'Earth Ghost', band: 'B8', level: 25, roles: ['pack'], hp: 1623, physAttack: [199, 237], magAttack: [0, 0], physDefence: 92, magDefence: 127, exp: 588, gold: [403, 853] },
  { code: 'MOB_CL_TAOIST_25', base: 'MOB_WC_EARTHKING', name: 'Canyon Taoist', band: 'B8', level: 25, roles: ['ranged', 'healer'], hp: 1408, physAttack: [0, 0], magAttack: [254, 291], physDefence: 79, magDefence: 139, exp: 588, gold: [403, 853] },
  // Tiger Girl's summons at 25 (§2.6): White Tigers re-derived at 24
  { code: 'MOB_CL_TIGERGUARD_24', base: 'MOB_CH_WHITETIGER', name: "Tiger Girl's Guard", band: 'B5', level: 24, roles: ['pack'], hp: 1489, physAttack: [153, 182], magAttack: [0, 0], physDefence: 84, magDefence: 141, exp: 564, gold: [327, 687], summonOnly: true },
]

/**
 * §2.5 (L2): the band mini-bosses, MB1–MB5, MB7 and MB8 (there is no MB6). Derived like the roster (the model's
 * `derive()` over the real export: work/tmp/climb25 `bosses25.ts`' rows; D53's retune MB7 HP × 2.0, MB8 × 2.5) and
 * spawned by the uniques module (content/uniques.json: spot, adds, respawn, loot). `look` and `size` reuse a retail
 * model: a champion is drawn 1.35 ×, a giant 2 ×, the Canyon Lord 1.4 × (the client's boss look tints each).
 */
export interface ClimbBoss extends ClimbRow {
  id: 'MB1' | 'MB2' | 'MB3' | 'MB4' | 'MB5' | 'MB7' | 'MB8'
  look: 'champion' | 'giant' | 'lord'
  /** Body size over the base's own (model, label, pick and the server's body radius). */
  size: number
}

export const CLIMB_BOSSES: readonly ClimbBoss[] = [
  { id: 'MB1', code: 'MOB_CL_OLDSCAR_6', base: 'MOB_CH_GYO', name: 'Old Scar, the Weasel King', band: 'B1', level: 6, roles: ['coward'], callN: [1, 1], look: 'champion', size: 1.35, hp: 2004, physAttack: [49, 56], magAttack: [0, 0], physDefence: 14, magDefence: 22, exp: 1692, gold: [46, 96] },
  { id: 'MB2', code: 'MOB_CL_MAGISTRATE_10', base: 'MOB_CH_WATERGHOST', name: 'The Drowned Magistrate', band: 'B2', level: 10, look: 'champion', size: 1.35, hp: 4141, physAttack: [84, 97], magAttack: [0, 0], physDefence: 23, magDefence: 41, exp: 3290, gold: [60, 126] },
  { id: 'MB3', code: 'MOB_CL_GWANGMU_14', base: 'MOB_CH_BANDIT_CLON', name: 'Gwangmu the Robber Chief', band: 'B3', level: 14, roles: ['coward'], callN: [1, 2], look: 'champion', size: 1.35, hp: 6752, physAttack: [97, 114], magAttack: [0, 0], physDefence: 39, magDefence: 51, exp: 4935, gold: [74, 155] },
  { id: 'MB4', code: 'MOB_CL_GATEWARDEN_16', base: 'MOB_CH_STONEGHOST', name: 'The Gate Warden', band: 'B4', level: 16, look: 'giant', size: 2, hp: 9793, physAttack: [159, 185], magAttack: [0, 0], physDefence: 45, magDefence: 74, exp: 6016, gold: [81, 170] },
  { id: 'MB5', code: 'MOB_CL_HEUKPUNG_19', base: 'MOB_CH_BANDIT', name: 'Heukpung, the Black Wind', band: 'B5', level: 19, look: 'champion', size: 1.35, hp: 17340, physAttack: [128, 154], magAttack: [0, 0], physDefence: 64, magDefence: 92, exp: 8046, gold: [91, 192] },
  { id: 'MB7', code: 'MOB_CL_MODUN_23', base: 'MOB_WC_HYUNGNO', name: 'Mo-Dun, the Hyungno Warlord', band: 'B7', level: 23, look: 'giant', size: 2, hp: 45504, physAttack: [172, 205], magAttack: [0, 0], physDefence: 77, magDefence: 124, exp: 10820, gold: [105, 222] },
  { id: 'MB8', code: 'MOB_CL_HYEONGCHEON_25', base: 'MOB_WC_HYEONGCHEON', name: 'Hyeongcheon, the Canyon Lord', band: 'B8', level: 25, look: 'lord', size: 1.4, hp: 54675, physAttack: [236, 282], magAttack: [0, 0], physDefence: 91, magDefence: 120, exp: 12936, gold: [112, 237] },
]

/** The mini-boss of a derived code, if it is one. */
export const climbBossOf = (code: string): ClimbBoss | undefined => CLIMB_BOSSES.find((b) => b.code === code)

/** A band (§2.1): its levels, its areas (zones.json names) and its tuning factors (§2.2 attack, §4.5 gold). */
export interface ClimbBand {
  id: ClimbBandId
  name: string
  levels: Range
  /** zones.json area names (matched without regard to case). */
  areas: readonly string[]
  atk: number
  gold: number
}

/**
 * A place of a band cut out of a larger area by region (§2.1, the high country of 2026-10-10: Jangan is an island, so
 * the top bands live on its own west heights, inside the Tiger Mountains' zones). A place wins over its regions' area.
 */
export interface ClimbPlace {
  name: string
  band: ClimbBandId
  /** Regions, inclusive (region units: x east, z north). */
  x: Range
  z: Range
  /** Retail code -> derived code for the nests there (every base the place holds; §2.2 rule 1). */
  remap: Readonly<Record<string, string>>
}

export const CLIMB_BANDS: readonly ClimbBand[] = [
  { id: 'B1', name: 'The Millet Fields', levels: [1, 5], areas: ['Grassland', 'Hill of Ye Mt.'], atk: 1.0, gold: 1.0 },
  { id: 'B2', name: 'Lake, Swamp and the Old Graves', levels: [5, 10], areas: ['Lake Forest', 'Swamp area', 'Chinese Tomb'], atk: 1.05, gold: 1.15 },
  { id: 'B3', name: "Yeoha's Forest", levels: [9, 13], areas: ["Yeoha's Forest"], atk: 1.1, gold: 1.25 },
  { id: 'B4', name: 'The Tomb Approach', levels: [12, 15], areas: ['Enterance of Qin-Shi Tomb'], atk: 1.05, gold: 1.8 },
  { id: 'B5', name: 'The Tiger Mountains', levels: [14, 19], areas: ['North-Tiger Mt.', 'South-Tiger Mt.', "Bandit's Mountain Stronghold"], atk: 1.05, gold: 3.0 },
  { id: 'B6', name: 'The Qin-Shi Tomb', levels: [16, 25], areas: [], atk: 1.15, gold: 2.5 },
  // the high country (2026-10-10): the Western China side is open sea (docs/COAST.md §4.1), so B7 and B8 are the
  // island's north-west and west heights over the sea: the ferry landing and the ridge above it, the sea cliffs
  { id: 'B7', name: 'The Ferry Heights', levels: [19, 23], areas: ['Jangan Ferry'], atk: 0.95, gold: 3.4 },
  { id: 'B8', name: 'The Sea Cliffs', levels: [22, 25], areas: [], atk: 0.92, gold: 3.6 },
]

/**
 * The places of the high country (§2.1): the ridge above the ferry (North-Tiger's north-west, 52-110 m over the old
 * strait) is B7 with the ferry landing; the island's west rim (South-Tiger's and North-Tiger's west, 80-140 m over the
 * open sea, west of the Bandit's Mountain Stronghold) is B8. Their Tiger Mountain nests take the Western China roster.
 */
export const CLIMB_PLACES: readonly ClimbPlace[] = [
  {
    name: 'The Ferry Heights', band: 'B7', x: [156, 159], z: [94, 95],
    remap: {
      MOB_CH_TIGER_CLON: 'MOB_CL_CHAKJIWORKER_19', MOB_CH_BANDIT_CLON: 'MOB_CL_CHAKJIWORKER_19', MOB_CH_TIGER: 'MOB_CL_CHAKJI_20',
      MOB_CH_YEOHA: 'MOB_CL_CHAKJI_20', MOB_CH_WHITETIGER_CLON: 'MOB_CL_GHOSTBUG_21', MOB_CH_WHITETIGER: 'MOB_CL_DEVILBUG_22',
      MOB_CH_BANDIT: 'MOB_CL_HYUNGNO_23', MOB_CH_BANDITARCHER: 'MOB_CL_HYUNGNO_23', MOB_CH_BANDITARCHER_CLON: 'MOB_CL_HYUNGNO_23',
    },
  },
  {
    name: 'The Sea Cliffs', band: 'B8', x: [156, 158], z: [90, 93],
    remap: {
      MOB_CH_BANDIT_CLON: 'MOB_CL_HYUNGNOSHAMAN_24', MOB_CH_YEOHA: 'MOB_CL_HYUNGNOSHAMAN_24', MOB_CH_BANDITARCHER: 'MOB_CL_POWDER_24',
      MOB_CH_BANDITARCHER_CLON: 'MOB_CL_POWDER_24', MOB_CH_TIGER_CLON: 'MOB_CL_HYUNGNOSHAMAN_24', MOB_CH_BANDIT: 'MOB_CL_EARTHGHOST_25',
      MOB_CH_TIGER: 'MOB_CL_EARTHGHOST_25', MOB_CH_WHITETIGER_CLON: 'MOB_CL_EARTHGHOST_25', MOB_CH_WHITETIGER: 'MOB_CL_TAOIST_25',
    },
  },
]

/** The place of region (rx, rz), if a band place holds it. */
export function climbPlaceAt(region: { rx: number; rz: number } | null | undefined): ClimbPlace | undefined {
  if (!region) return undefined
  return CLIMB_PLACES.find((p) => region.rx >= p.x[0] && region.rx <= p.x[1] && region.rz >= p.z[0] && region.rz <= p.z[1])
}

/** The region of a packed region id ((z << 8) | x). */
export const climbRegionOf = (id: number | undefined): { rx: number; rz: number } | null =>
  id === undefined ? null : { rx: id & 255, rz: id >> 8 }

/** The band at a nest: its region's place first (§2.1's high country), else its area's band. */
export function climbBandAt(area: string | null | undefined, region?: { rx: number; rz: number } | null): ClimbBand | undefined {
  const place = climbPlaceAt(region)
  if (place) return CLIMB_BANDS.find((b) => b.id === place.band)
  return climbBandOfArea(area)
}

/**
 * Remaps across bases the base-match rule cannot make (§2.2 rule 1's examples): retail code → derived code, by area.
 * Everything else follows `climbCodeFor`'s rule; single nests are moved by `mob` patches in content/nests.override.json.
 */
export const CLIMB_AREA_REMAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // the forest's 8 Bandits and 24 Tigers are the Robbers' Camp's subordinates and the cubs' elders, not B5 monsters
  "Yeoha's Forest": { MOB_CH_BANDIT: 'MOB_CL_BANDITSUB_11', MOB_CH_TIGER: 'MOB_CL_YOUNGTIGER_12' },
  // the ferry landing (B7): its Tigers and Bandits are the far bank's crossers now, at the band's own levels
  'Jangan Ferry': { MOB_CH_TIGER_CLON: 'MOB_CL_CHAKJIWORKER_19', MOB_CH_TIGER: 'MOB_CL_CHAKJI_20', MOB_CH_WHITETIGER: 'MOB_CL_DEVILBUG_22', MOB_CH_BANDIT: 'MOB_CL_HYUNGNO_23' },
}

/**
 * §4.1.2 (D53, the user: "I meant to add degree 4 as the top gear"): every degree's retail required levels (`retail`,
 * the client's span from the first grade-A piece to the grade-C chest) are spaced linearly onto the Climb's span
 * (`climb`), so four degrees fit inside the cap: D1 1–8, D2 8–15, D3 15–21, D4 21–25. Order inside a degree is kept.
 */
export const CLIMB_DEGREE_LEVELS: Readonly<Record<number, { retail: Range; climb: Range }>> = {
  1: { retail: [1, 10], climb: [1, 8] },
  2: { retail: [8, 18], climb: [8, 15] },
  3: { retail: [16, 26], climb: [15, 21] },
  4: { retail: [24, 34], climb: [21, 25] },
}
/** The cap tier (§4.1.2): the top degree, worn from 21 to 25; its Moon and Sun are the level-25 hunt (RARE_TOP_MIN_LEVEL). */
export const CLIMB_TOP_DEGREE = 4
/** §4.4 (D53): from this monster level a derived monster's degree-3 gear drop may come as the same piece of degree 4, grade A. */
export const CLIMB_TOP_DROP_LEVEL = 21

/** §4.1 (cap 25, D53): the gear tiers by degree and grade, and where each comes from. Documentation and tooltips. */
export const CLIMB_TIERS: readonly { id: string; name: string; levels: Range; degree: number; grades: string; source: string }[] = [
  { id: 'T1', name: 'Copper', levels: [1, 6], degree: 1, grades: 'A, B', source: 'shop (A), drops in B1' },
  { id: 'T2', name: 'Long Copper', levels: [4, 8], degree: 1, grades: 'C', source: 'drops in B1/B2' },
  { id: 'T3', name: 'Infantry / Bronze', levels: [8, 13], degree: 2, grades: 'A, B', source: 'shop (A), drops in B2/B3' },
  { id: 'T4', name: 'Cavalry', levels: [12, 15], degree: 2, grades: 'C', source: 'drops in B3/B4' },
  { id: 'T5', name: 'Tribal Iron / Scale', levels: [15, 18], degree: 3, grades: 'A', source: 'shop, drops in B5' },
  { id: 'T6', name: 'Kang Iron', levels: [16, 19], degree: 3, grades: 'B', source: 'drops in B5 (White Tiger) and B7 (Chakji 19–20)' },
  { id: 'T7', name: 'Hun Iron / Wi Scale', levels: [18, 21], degree: 3, grades: 'C', source: 'drops in B7 (Ghost Bug, Devil Bug, Hyungno 21–23), never sold' },
  { id: 'T8', name: 'Snake Frost / Iron General / Holy Pure White', levels: [21, 23], degree: 4, grades: 'A', source: 'drops in B7 (21–23) and B8 (Hyungno Shaman), never sold' },
  { id: 'T9', name: 'Inexorable Frost / Silver General / Glory Pure White', levels: [22, 24], degree: 4, grades: 'B', source: 'drops in B8 (Powder Ghost, Earth Ghost), Tiger Girl, the Ice Yeti' },
  { id: 'T10', name: 'Cruel Frost / Gold General / Divine Pure White (the top tier)', levels: [23, 25], degree: 4, grades: 'C', source: 'drops in B8 (Canyon Taoist 25), Tiger Girl, the Ice Yeti, Hyeongcheon' },
  { id: 'T11', name: 'Seals of Star, Moon and Sun', levels: [1, 25], degree: 4, grades: 'A/B/C _RARE (each at its grade\'s level)', source: 'degree 4 Star: drops and bosses; degree 4 Moon and Sun: level-25 monsters and bosses only; degrees 1–3: RARITY\'s rates' },
]

// ---- the standard monster (work/tmp/climb25/lib.ts `std`, a quadratic fit over the retail normal monsters 1–24) ----

const quad = (c: readonly [number, number, number], l: number) => c[0] + c[1] * l + c[2] * l * l
const STD_FIT = {
  lnHp: [3.6834255449631437, 0.21440937608921873, -0.00268355220657579],
  lnAtk: [2.8231457144176684, 0.17902408842349238, -0.003373293496551577],
  pd: [5.367813824416653, 1.0027142965103302, 0.09080300326178214],
  md: [9.642047575164122, 0.9916710929546948, 0.18180529991727568],
} as const

/** The standard monster of a level: HP, mid attack, defences, hit/parry, EXP (§2.2). */
export const climbStd = {
  hp: (l: number) => Math.exp(quad(STD_FIT.lnHp, l)),
  atk: (l: number) => Math.exp(quad(STD_FIT.lnAtk, l)),
  pd: (l: number) => quad(STD_FIT.pd, l),
  md: (l: number) => quad(STD_FIT.md, l),
  hit: (l: number) => 25 + 2 * l,
  exp: (l: number) => Math.round(23.5 * l),
}

// ---- derived monsters ----------------------------------------------------------------------------------------------

/** The MobDef of a roster row: the base's model, skills, speed and behaviour with the row's level and numbers. */
export function deriveClimbMob(base: MobDef, row: ClimbRow): MobDef {
  const def: MobDef = {
    ...base,
    code: row.code,
    name: row.name,
    level: row.level,
    hp: row.hp,
    physAttack: [...row.physAttack],
    magAttack: [...row.magAttack],
    physDefence: row.physDefence,
    magDefence: row.magDefence,
    hitRate: climbStd.hit(row.level),
    parryRate: climbStd.hit(row.level),
    physAbsorb: row.level,
    magAbsorb: row.level,
    exp: row.exp,
    base: base.code,
    fieldSources: { ...(base.fieldSources ?? {}), climb: `docs/CLIMB.md §2.2: ${row.band} ${row.name} ${row.level} on ${base.code}` },
  }
  delete def.spExp
  return def
}

/**
 * Every roster row and mini-boss (§2.5) whose base is in `mobs` (rows without their base are left out: a partial
 * export). A boss is drawn and collides at its `size` and is a unique (its label, the target frame).
 */
export function deriveClimbMobs(mobs: ReadonlyMap<string, MobDef>): MobDef[] {
  const out: MobDef[] = []
  for (const row of CLIMB_ROSTER) {
    const base = mobs.get(row.base)
    if (base) out.push(deriveClimbMob(base, row))
  }
  for (const b of CLIMB_BOSSES) {
    const base = mobs.get(b.base)
    if (!base) continue
    const d = deriveClimbMob(base, b)
    out.push({ ...d, rarity: 'unique', scale: Math.round(base.scale * b.size), radius: Math.round(base.radius * b.size * 100) / 100, variants: ['unique'] })
  }
  return out
}

/**
 * §4.4 (D53): the cap-tier piece a derived monster of `level` may drop for its base's item `code`: from
 * CLIMB_TOP_DROP_LEVEL a degree-3 piece's degree-4 grade-A twin (`ITEM_CH_BLADE_03_C` → `ITEM_CH_BLADE_04_A`); `code`
 * itself otherwise, or when `has` (the catalog) has no such row.
 */
export function climbDropCode(code: string, level: number, has?: (code: string) => boolean): string {
  if (level < CLIMB_TOP_DROP_LEVEL) return code
  const m = /^(ITEM_CH_.+)_03((?:_[A-Z]{2})?)_[ABC]$/.exec(code)
  if (!m) return code
  const top = `${m[1]}_0${CLIMB_TOP_DEGREE}${m[2]}_A`
  return !has || has(top) ? top : code
}

/** The drop table of a derived monster: its base's items (the retail tiers; §4.4's cap-tier rule), the row's gold. Null without a base table. */
export function deriveClimbDrops(baseTable: DropTable | undefined, row: ClimbRow, has?: (code: string) => boolean): DropTable | null {
  if (!baseTable) return null
  return {
    ...baseTable,
    mob: row.code,
    gold: { chance: baseTable.gold?.chance ?? 0.7, amount: [...row.gold] },
    // §4.4 (D53): from level 21 a degree-3 piece's roll is half that piece, half its degree-4 grade-A twin (the Ferry
    // Heights' bugs and Hyungno soldiers stay the source of 03_C, now mid-tier)
    groups: baseTable.groups.map((g) => ({
      ...g,
      entries: g.entries.flatMap((e) => {
        const top = climbDropCode(e.item, row.level, has)
        return top === e.item ? [{ ...e }] : [{ ...e }, { ...e, item: top }]
      }),
    })),
  }
}

export const climbRow = (code: string): ClimbRow | undefined => CLIMB_ROSTER.find((r) => r.code === code) ?? CLIMB_BOSSES.find((r) => r.code === code)

/** The band of a zones.json area name (case does not matter), or undefined (a nameless region, the town). */
export function climbBandOfArea(area: string | null | undefined): ClimbBand | undefined {
  if (!area) return undefined
  const a = area.toLowerCase()
  return CLIMB_BANDS.find((b) => b.areas.some((x) => x.toLowerCase() === a))
}

/**
 * The derived code a nest of retail `code` (level `level`) in `area` holds (§2.2 rules 1–2): the area's explicit
 * remap; else a roster row of the same base in the area's band (the one nearest the retail level); else the row of
 * that base nearest the band (the fallback: the Hill of Ye's stone ghosts take B2's 8–9 rows); null = no row (uniques,
 * Hyeongcheon, unknown monsters keep their code). Tiger Girl's Guard is never a remap target. `region` (the nest's)
 * puts the high country's places (CLIMB_PLACES) first: their own remap, then their band.
 */
export function climbCodeFor(area: string | null | undefined, code: string, level: number, region?: { rx: number; rz: number } | null): string | null {
  const place = climbPlaceAt(region)
  if (place?.remap[code]) return place.remap[code]!
  const band = climbBandAt(area, region)
  const key = band && !place ? Object.keys(CLIMB_AREA_REMAP).find((k) => k.toLowerCase() === area!.toLowerCase()) : undefined
  const explicit = key ? CLIMB_AREA_REMAP[key]![code] : undefined
  if (explicit) return explicit
  const rows = CLIMB_ROSTER.filter((r) => r.base === code && !r.summonOnly)
  if (rows.length === 0) return null
  const inBand = band ? rows.filter((r) => r.band === band.id) : []
  const pool = inBand.length ? inBand : rows
  const target = band && !inBand.length ? Math.min(band.levels[1], Math.max(band.levels[0], level)) : level
  return [...pool].sort((a, b) => Math.abs(a.level - target) - Math.abs(b.level - target) || a.level - b.level)[0]!.code
}

// ---- EXP -----------------------------------------------------------------------------------------------------------

/**
 * §2.3 (D4): a monster 2 or more levels below the player pays −15 % per level from the second (2 below 85 %, 3 below
 * 70 %, … never under 10 %); a monster above pays +5 % a level, at most +15 %.
 */
export function levelDiffExpMul(playerLevel: number, mobLevel: number): number {
  const d = playerLevel - mobLevel
  if (d >= 2) return Math.max(0.1, 1 - 0.15 * (d - 1))
  if (d < 0) return 1 + Math.min(0.15, 0.05 * -d)
  return 1
}

/**
 * §9.2 / §9.3a: the EXP of a live character moved to a new curve. A character at the old cap (20) starts the next
 * bar at 0 (its overflow already went to SP-EXP); every other keeps the fraction of its bar, floor(exp / old × new),
 * always below the new bar (never a level gained or lost). `oldNeed` 0 (unknown) keeps nothing past the new bar.
 */
export function convertBarExp(level: number, exp: number, oldNeed: number, newNeed: number, oldCap = PRE_CLIMB_CAP): number {
  if (level === oldCap) return 0
  if (!(newNeed > 0)) return 0
  const e = Math.max(0, Math.floor(exp))
  const v = oldNeed > 0 ? Math.floor((e / oldNeed) * newNeed) : e
  return Math.max(0, Math.min(newNeed - 1, v))
}

/** Checks content/climb/levels.json: `exp` holds the EXP of levels 1 … n − 1 → n, every one positive and rising. */
export function checkClimbLevels(v: unknown): { exp: number[] } | { problems: string[] } {
  const p: string[] = []
  const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  if (!o) return { problems: ['expected an object'] }
  if (o.schema !== 1) p.push('schema: expected 1')
  if (o.kind !== 'climb-levels') p.push("kind: expected 'climb-levels'")
  const exp = o.exp
  if (!Array.isArray(exp) || exp.length === 0) p.push('exp: expected a non-empty array of numbers')
  else {
    exp.forEach((x, i) => {
      if (typeof x !== 'number' || !Number.isInteger(x) || x <= 0) p.push(`exp[${i}]: expected a positive whole number`)
      else if (i > 0 && typeof exp[i - 1] === 'number' && x <= (exp[i - 1] as number)) p.push(`exp[${i}]: must be more than level ${i}'s ${exp[i - 1]}`)
    })
  }
  return p.length ? { problems: p } : { exp: exp as number[] }
}

/** Chinese equipment the re-spacing moves: `ITEM_CH_<family>_<grade>` with an optional `_RARE` (not `_DEF`, not Europe). */
const CLIMB_GEAR_RE = /^(ITEM_CH_.+_0\d(?:_[A-Z]{2})?)_([ABC])(_RARE)?$/

/** §4.1.2: a retail required level of degree `degree` on the Climb's span (0 and degrees without a span are kept). */
export function climbDegreeLevel(degree: number, retailLevel: number): number {
  const s = CLIMB_DEGREE_LEVELS[degree]
  if (!s || retailLevel <= 0) return retailLevel
  const [r0, r1] = s.retail
  const [c0, c1] = s.climb
  const v = c0 + Math.round(((retailLevel - r0) * (c1 - c0)) / (r1 - r0))
  return Math.min(c1, Math.max(c0, v))
}

/**
 * §4.1.2: an item's required level in the Climb. Regular grades: the degree's span (climbDegreeLevel over the retail
 * level). A seal (`_RARE`) sits at its letter's grade level (Star = A, Moon = B, Sun = C) of the same family, which
 * `regular` looks up (retail gives all three seals the grade-A level; without the row the seal's own level is spaced).
 * Other items keep their level.
 */
export function climbItemLevel(
  item: Pick<ItemDef, 'code' | 'reqLevel' | 'degree' | 'retailReqLevel'>,
  regular?: (code: string) => Pick<ItemDef, 'code' | 'reqLevel' | 'degree' | 'retailReqLevel'> | undefined,
): number {
  const retail = item.retailReqLevel ?? item.reqLevel
  const m = CLIMB_GEAR_RE.exec(item.code)
  if (!m) return item.reqLevel
  if (m[3]) {
    const row = regular?.(`${m[1]}_${m[2]}`)
    if (row) return climbDegreeLevel(row.degree, row.retailReqLevel ?? row.reqLevel)
  }
  return climbDegreeLevel(item.degree, retail)
}

/**
 * §4.1.3 (D54, the user: "a degree 3 should never be stronger than a 4th degree rare weapon"): every degree-3 seal stays
 * under its family's degree-4 Seal of Star (the weakest degree-4 seal) on every power number: each stat endpoint, the
 * raw attack rolls and the per-plus increments end at most CLIMB_SEAL_CAP × the degree-4 Star's. Per number, with the
 * degree-3 Star, Moon and Sun values s ≤ m ≤ u and the cap T: nothing moves when u ≤ T; else Star keeps s (when s ≤ T)
 * and Moon and Sun are pressed linearly into [s, T], so Star < Moon < Sun stays; when even s > T all three scale by T / u.
 * Durability and the reinforce percentages are not power and stay. Idempotent (a second pass finds u = T).
 */
export const CLIMB_SEAL_CAP = 0.97
const SEAL_STATS = ['physAttack', 'magAttack', 'physDefence', 'magDefence', 'parryRate', 'blockRate', 'physAbsorb', 'magAbsorb', 'hitRate', 'critRate'] as const
const SEAL_ROLLS = ['physAttackMin', 'physAttackMax', 'magAttackMin', 'magAttackMax'] as const

export function applyClimbSealCaps(items: Map<string, ItemDef>, from = CLIMB_TOP_DEGREE - 1, to = CLIMB_TOP_DEGREE): number {
  const r1 = (v: number) => Math.round(v * 10) / 10
  const r2 = (v: number) => Math.round(v * 100) / 100
  let n = 0
  for (const star of items.values()) {
    const m = /^(ITEM_CH_.+)_0(\d)((?:_[A-Z]{2})?)_A_RARE$/.exec(star.code)
    if (!m || Number(m[2]) !== from) continue
    const fam = (d: number, l: string) => items.get(`${m[1]}_0${d}${m[3]}_${l}_RARE`)
    const top = fam(to, 'A')
    const rows = (['A', 'B', 'C'] as const).map((l) => fam(from, l))
    if (!top || rows.some((r) => !r)) continue
    const [s0, m0, u0] = rows as ItemDef[]
    const out = rows.map((r) => structuredClone(r!)) as ItemDef[]
    // one number of the three rows (get/set by the clone), against the cap value t
    const press = (get: (d: ItemDef) => number | undefined, set: (d: ItemDef, v: number) => void, t: number | undefined, round: (v: number) => number) => {
      const [s, mm, u] = [get(s0), get(m0), get(u0)]
      if (t === undefined || s === undefined || mm === undefined || u === undefined) return
      const cap = round(t * CLIMB_SEAL_CAP)
      if (u <= cap) return
      const f = (v: number) => (s <= cap ? (u > s ? s + ((v - s) * (cap - s)) / (u - s) : cap) : (v * cap) / u)
      set(out[1]!, round(Math.min(cap, f(mm))))
      set(out[2]!, cap)
      if (s > cap) set(out[0]!, round(f(s)))
    }
    for (const k of SEAL_STATS) {
      for (const i of [0, 1] as const) {
        press((d) => d.stats?.[k]?.[i], (d, v) => void (d.stats![k]![i] = v), top.stats?.[k]?.[i], r1)
      }
    }
    for (const k of SEAL_ROLLS) {
      // the export's raw attack bounds (items.ts `rolls`; not part of ItemDef)
      const rolls = (d: ItemDef) => (d as ItemDef & { rolls?: Record<string, [number, number]> }).rolls?.[k]
      for (const i of [0, 1] as const) press((d) => rolls(d)?.[i], (d, v) => void (rolls(d)![i] = v), rolls(top)?.[i], r1)
    }
    for (const k of Object.keys(u0.perPlus ?? {}) as (keyof NonNullable<ItemDef['perPlus']>)[]) {
      press((d) => d.perPlus?.[k], (d, v) => void (d.perPlus![k] = v), top.perPlus?.[k], r2)
    }
    out.forEach((d, i) => {
      if (JSON.stringify(d) !== JSON.stringify(rows[i])) {
        items.set(d.code, d)
        n++
      }
    })
  }
  return n
}

/**
 * Applies the re-spacing (§4.1.2) to a catalog in place, keeping `retailReqLevel` (so a second pass changes nothing),
 * then the degree-3 seal caps (§4.1.3, applyClimbSealCaps); returns how many rows changed.
 */
export function applyClimbItemLevels(items: Map<string, ItemDef>): number {
  return applyClimbReqLevels(items) + applyClimbSealCaps(items)
}

function applyClimbReqLevels(items: Map<string, ItemDef>): number {
  const changes: [string, number][] = []
  for (const it of items.values()) {
    const level = climbItemLevel(it, (c) => items.get(c))
    if (level !== it.reqLevel) changes.push([it.code, level])
  }
  for (const [code, level] of changes) {
    const it = items.get(code)!
    items.set(code, { ...it, reqLevel: level, retailReqLevel: it.retailReqLevel ?? it.reqLevel })
  }
  return changes.length
}

/**
 * §2.6: a boss moved to `level` (Tiger Girl at 25): defences shift by the standard curve's difference, hit and parry
 * +2 a level, absorb +1 a level. HP, attack and EXP stay: the boss's own tuning multiplies those.
 */
export function relevelMob(def: MobDef, level: number): MobDef {
  if (level === def.level) return def
  const d = level - def.level
  const sh = (v: number, f: (l: number) => number) => Math.max(1, Math.round(v + f(level) - f(def.level)))
  return {
    ...def,
    level,
    physDefence: sh(def.physDefence, climbStd.pd),
    magDefence: sh(def.magDefence, climbStd.md),
    hitRate: Math.max(1, def.hitRate + 2 * d),
    parryRate: Math.max(1, def.parryRate + 2 * d),
    ...(def.physAbsorb !== undefined ? { physAbsorb: Math.max(0, def.physAbsorb + d) } : {}),
    ...(def.magAbsorb !== undefined ? { magAbsorb: Math.max(0, def.magAbsorb + d) } : {}),
  }
}

// ---- L4: the death penalty (§6, D46, D51; fact-check F5, F6) -----------------------------------------------------

/** §6.1's defaults (the admin panel changes them live: config `penalty*`). */
export const CLIMB_PENALTY = {
  /** The penalty from this level (§6.1 "after level 15"); nothing at the cap (no bar is kept there, D22). */
  fromLevel: 15,
  /** The roll: a whole percent of the level's bar, minPct..maxPct (server RNG). */
  minPct: 1,
  maxPct: 20,
  /** A death within this many minutes of a penalised death costs nothing (§6.1 grace) ... */
  graceMin: 10,
  /** ... and from this level the window is longer (D51: 30 min from level 21). */
  graceHighFrom: 21,
  graceHighMin: 30,
  /** A player who leaves within this many seconds of monster damage stays in the world this long (F6). */
  lingerS: 10,
  /** A resurrection on the corpse refunds this share of the loss (§6.3: Soul Rebirth 50 %). */
  rezRefund: 0.5,
} as const

/** The roll as a whole percent in [minPct, maxPct] from `r` in [0, 1). A reversed range is read in order. */
export function climbPenaltyPct(r: number, minPct: number, maxPct: number): number {
  const lo = Math.max(0, Math.min(100, Math.round(Math.min(minPct, maxPct))))
  const hi = Math.max(0, Math.min(100, Math.round(Math.max(minPct, maxPct))))
  return lo + Math.min(hi - lo, Math.floor(r * (hi - lo + 1)))
}

/**
 * §6.1: the EXP a death takes: `pct` % of the level's bar, never more than the EXP already in the bar (never a
 * de-level; an empty bar loses nothing).
 */
export function climbPenaltyLoss(exp: number, need: number, pct: number): number {
  if (!(need > 0) || !(pct > 0) || !(exp > 0)) return 0
  return Math.max(0, Math.min(Math.floor(exp), Math.floor((pct / 100) * need)))
}

/** The grace window after a penalised death at `level` (§6.1, D51), ms. */
export function climbGraceMs(level: number, o: { graceMin: number; graceHighFrom: number; graceHighMin: number }): number {
  return Math.max(0, (level >= o.graceHighFrom ? o.graceHighMin : o.graceMin) * 60_000)
}

/** F5: what a refund of `want` EXP may pay when `refunded` of a `loss` was already paid back. */
export function climbRefundCap(loss: number, refunded: number, want: number): number {
  return Math.max(0, Math.min(Math.floor(want), Math.floor(loss) - Math.floor(refunded)))
}

// ---- L3: monster roles (§2.3, D3) --------------------------------------------------------------------------------

/** §2.3's numbers (`roles.json` in the spec; code data here like the roster). */
export const CLIMB_ROLE_RULES = {
  /** pack: up to `max` idle nest-mates within `radiusM` join after `delayMs` (a joiner never links on). */
  pack: { radiusM: 12, max: 2, delayMs: [500, 2000] as Range },
  /** ranged (and healers, "flee melee"): one step back per `everyMs` when a melee attacker is within `nearM`. */
  ranged: { nearM: 4, stepM: 6, everyMs: 6000, meleeRangeM: 4 },
  /** healer: every `everyMs`, an ally within `radiusM` under `belowPct` % HP gets `pct` % of its max HP after a `castMs` cast (a stun cancels it). */
  healer: { everyMs: 7000, radiusM: 15, belowPct: 70, pct: 12, castMs: 1400 },
  /** coward: under `belowPct` % HP, `chancePct` % run for `fleeMs`; alive after it, it calls `callN` idle nest-mates within `callRadiusM`, who join `joinMs` later. */
  coward: { belowPct: 25, chancePct: 60, fleeMs: 5000, callRadiusM: 30, joinMs: 3000 },
} as const

const ROLE_INDEX = new Map<string, ClimbRow>([...CLIMB_ROSTER, ...CLIMB_BOSSES].map((r) => [r.code, r]))

/** The roster row (roles, callN) of a derived monster code, if any. */
export function climbRowOf(code: string): ClimbRow | undefined {
  return ROLE_INDEX.get(code)
}
