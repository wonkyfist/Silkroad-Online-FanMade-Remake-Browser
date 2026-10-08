/**
 * The Climb to 25 (docs/CLIMB.md §20 L0/L1; packages/shared/src/climb.ts): the roster's golden rows (§2.2), the bands
 * and the remap rule, the cap-25 curve file (§3.2a), the level-difference EXP (§2.3), the four degrees inside the cap (§4.1.2, D53),
 * the bar-fraction conversion of live characters (§9.2, §9.3a) and the re-levelling of a boss (§2.6).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLIMB_AREA_REMAP,
  CLIMB_BANDS,
  CLIMB_CAP,
  CLIMB_DEGREE_LEVELS,
  CLIMB_TIERS,
  CLIMB_TOP_DEGREE,
  CLIMB_TOP_DROP_LEVEL,
  CLIMB_LEVELS_FILE,
  CLIMB_PLACES,
  CLIMB_ROSTER,
  DEFAULT_LEVEL_CAP,
  PILOT_DEFAULTS,
  SIEGE_EVENT_DEFAULTS,
  SIEGE_MOBS,
  WINTER_MOBS,
  WINTER_PLAY,
  applyClimbItemLevels,
  checkClimbLevels,
  checkUniquesFile,
  climbBandAt,
  climbBandOfArea,
  climbCodeFor,
  climbPlaceAt,
  climbDegreeLevel,
  climbDropCode,
  climbItemLevel,
  climbStd,
  convertBarExp,
  deriveClimbDrops,
  deriveClimbMob,
  deriveClimbMobs,
  levelDiffExpMul,
  relevelMob,
  type DropTable,
  type ItemDef,
  type MobDef,
} from '../src/index.ts'

const REPO = join(import.meta.dirname, '../../..')
const curveFile = JSON.parse(readFileSync(join(REPO, 'content', CLIMB_LEVELS_FILE), 'utf8')) as unknown
const uniquesFile = JSON.parse(readFileSync(join(REPO, 'content/uniques.json'), 'utf8')) as { uniques: Record<string, any>[]; dropTables: Record<string, { groups: { chance: number; pool?: Record<string, unknown> }[] }> }

const base = (code: string, over: Partial<MobDef> = {}): MobDef => ({
  code, id: 1, name: code, typeId: [1, 2, 1, 1], rarity: 'normal', level: 10, hp: 100, mp: 0, physAttack: [10, 12], magAttack: [0, 0],
  physDefence: 10, magDefence: 10, hitRate: 45, parryRate: 45, attackRange: 1, attackIntervalMs: 2000, radius: 0.6, walkSpeed: 1.5,
  runSpeed: 5, aggressive: false, exp: 235, scale: 100, model: { bsr: 'res/mob/x.bsr', glb: 'mob/x.glb', sidecar: 'mob/x.json' } as MobDef['model'], skills: ['MSKILL_X'], ...over,
})

describe('the cap', () => {
  it('is 25 by default (was 20)', () => {
    expect(CLIMB_CAP).toBe(25)
    expect(DEFAULT_LEVEL_CAP).toBe(25)
  })
})

describe('the cap-25 curve (content/climb/levels.json, §3.2a)', () => {
  const c = checkClimbLevels(curveFile)
  if (!('exp' in c)) throw new Error(c.problems.join('; '))
  const exp = c.exp
  it('holds levels 1 -> 25 (24 bars), rising at every level, 1,555,570 EXP in all', () => {
    expect(exp).toHaveLength(CLIMB_CAP - 1)
    for (let i = 1; i < exp.length; i++) expect(exp[i], `level ${i + 1}`).toBeGreaterThan(exp[i - 1]!)
    expect(exp.reduce((a, b) => a + b, 0)).toBe(1_555_570)
  })
  it("matches §3.2a's rows: 1,780 at 1, 122,000 at 20, 244,000 at 24; 1 -> 20 = 678,570, 20 -> 25 = 877,000", () => {
    expect(exp[0]).toBe(1780)
    expect(exp[19]).toBe(122_000)
    expect(exp[23]).toBe(244_000)
    expect(exp.slice(0, 19).reduce((a, b) => a + b, 0)).toBe(678_570)
    expect(exp.slice(19).reduce((a, b) => a + b, 0)).toBe(877_000)
  })
  it('the checker refuses a bad file', () => {
    expect(checkClimbLevels({ schema: 1, kind: 'climb-levels', exp: [10, 5] })).toEqual({ problems: [expect.stringMatching(/exp\[1\]/)] })
    expect('problems' in checkClimbLevels({ schema: 2, kind: 'x', exp: [] })).toBe(true)
    expect('problems' in checkClimbLevels([1, 2])).toBe(true)
    expect(checkClimbLevels({ schema: 1, kind: 'climb-levels', exp: [3, 4.5] })).toEqual({ problems: ['exp[1]: expected a positive whole number'] })
  })
})

describe('the roster (§2.2)', () => {
  const row = (code: string) => CLIMB_ROSTER.find((r) => r.code === code)!
  it('39 rows with unique codes, every derived code MOB_CL_*', () => {
    expect(CLIMB_ROSTER).toHaveLength(39)
    expect(new Set(CLIMB_ROSTER.map((r) => r.code)).size).toBe(39)
    for (const r of CLIMB_ROSTER) expect(r.code).toMatch(/^MOB_CL_[A-Z]+_\d+$/)
  })
  it("§2.2's HP and EXP column, row by row", () => {
    const golden: [string, number, number, number][] = [
      ['MOB_CL_MANGNYANG_1', 1, 54, 24], ['MOB_CL_WEASEL_5', 5, 119, 118], ['MOB_CL_WATERGHOST_7', 7, 156, 165],
      ['MOB_CL_TOMBSTONE_9', 9, 194, 212], ['MOB_CL_YEOHA_13', 13, 433, 306], ['MOB_CL_RESTLESS_15', 15, 477, 353],
      ['MOB_CL_BANDIT_16', 16, 755, 376], ['MOB_CL_BLACKTIGER_17', 17, 749, 400], ['MOB_CL_WHITETIGER_18', 18, 809, 423],
      ['MOB_CL_CHAKJIWORKER_19', 19, 958, 447], ['MOB_CL_CHAKJI_20', 20, 1031, 470], ['MOB_CL_GHOSTBUG_21', 21, 1106, 494],
      ['MOB_CL_DEVILBUG_22', 22, 1184, 517], ['MOB_CL_HYUNGNO_23', 23, 1264, 541], ['MOB_CL_HYUNGNOSHAMAN_24', 24, 1751, 564],
      ['MOB_CL_POWDER_24', 24, 1495, 564], ['MOB_CL_EARTHGHOST_25', 25, 1623, 588], ['MOB_CL_TAOIST_25', 25, 1408, 588],
      ['MOB_CL_TIGERGUARD_24', 24, 1489, 564],
    ]
    for (const [code, level, hp, exp] of golden) expect(row(code), code).toMatchObject({ level, hp, exp })
  })
  it('L8: the Sea Cliffs (B8) are a hard band, not a wall: HP within 0.85-1.25 x the standard monster of the level (D53 x 1.6 made 1.48)', () => {
    for (const r of CLIMB_ROSTER.filter((x) => x.band === 'B8')) {
      const k = r.hp / climbStd.hp(r.level)
      expect(k, r.code).toBeGreaterThan(0.85)
      expect(k, r.code).toBeLessThan(1.25)
    }
  })
  it('EXP is 23.5 x level, rounded (retail rule)', () => {
    for (const r of CLIMB_ROSTER) expect(r.exp, r.code).toBe(climbStd.exp(r.level))
  })
  it('every level 1-25 has a field monster; every field band has a monster in its range', () => {
    const field = CLIMB_ROSTER.filter((r) => !r.summonOnly)
    for (let l = 1; l <= CLIMB_CAP; l++) expect(field.some((r) => r.level === l), `level ${l}`).toBe(true)
    for (const b of CLIMB_BANDS.filter((x) => x.areas.length || CLIMB_PLACES.some((p) => p.band === x.id))) {
      const own = field.filter((r) => r.band === b.id)
      expect(own.length, b.id).toBeGreaterThan(0)
      for (const r of own) expect(r.level >= b.levels[0] - 1 && r.level <= b.levels[1], `${r.code} in ${b.id}`).toBe(true)
    }
  })
  it('the top band (B8) is 22-25 and holds the level-25 monsters', () => {
    expect(CLIMB_BANDS.find((b) => b.id === 'B8')!.levels).toEqual([22, 25])
    expect(CLIMB_ROSTER.filter((r) => r.level === 25).map((r) => r.band)).toEqual(['B8', 'B8'])
  })
})

describe('deriveClimbMob', () => {
  const tiger = base('MOB_CH_WHITETIGER', { level: 18, hp: 809, spExp: 5, fieldSources: { model: 'x' } })
  it("keeps the base's model, skills and speed; takes the row's level, numbers, retail hit rules, and `base`", () => {
    const d = deriveClimbMob(tiger, CLIMB_ROSTER.find((r) => r.code === 'MOB_CL_TIGERGUARD_24')!)
    expect(d).toMatchObject({ code: 'MOB_CL_TIGERGUARD_24', base: 'MOB_CH_WHITETIGER', name: "Tiger Girl's Guard", level: 24, hp: 1489, physAttack: [153, 182], hitRate: 73, parryRate: 73, physAbsorb: 24, exp: 564, model: tiger.model, skills: tiger.skills, runSpeed: 5 })
    expect(d.spExp).toBeUndefined()
    expect(d.fieldSources?.climb).toMatch(/§2\.2/)
    expect(tiger.code).toBe('MOB_CH_WHITETIGER')
  })
  it('deriveClimbMobs skips rows whose base is missing', () => {
    const out = deriveClimbMobs(new Map([[tiger.code, tiger]]))
    expect(out.map((d) => d.code).sort()).toEqual(['MOB_CL_TIGERGUARD_24', 'MOB_CL_WHITETIGER_18'])
  })
  it("deriveClimbDrops: the base's items and the row's gold", () => {
    const t: DropTable = { mob: 'MOB_CH_WHITETIGER', gold: { chance: 0.7, amount: [40, 80] }, groups: [{ chance: 0.1, entries: [{ item: 'ITEM_X', weight: 1 }] }], provenance: 'p' as DropTable['provenance'] }
    const r = CLIMB_ROSTER.find((x) => x.code === 'MOB_CL_WHITETIGER_18')!
    expect(deriveClimbDrops(t, r)).toMatchObject({ mob: r.code, gold: { chance: 0.7, amount: r.gold }, groups: t.groups })
    expect(deriveClimbDrops(undefined, r)).toBeNull()
  })
})

describe('the area remap (§2.2 rules 1-2)', () => {
  const cases: [string, string, number, string | null][] = [
    // B1: own rows; the Hill of Ye's stone ghosts fall back to B2's 8-9 rows
    ['Grassland', 'MOB_CH_MANGNYANG', 1, 'MOB_CL_MANGNYANG_1'],
    ['Hill of Ye Mt.', 'MOB_CH_STONEGHOST', 9, 'MOB_CL_STONEGHOST_9'],
    ['Hill of Ye Mt.', 'MOB_CH_STONEGHOST_CLON', 8, 'MOB_CL_BROKENSTONE_8'],
    ['Grassland', 'MOB_CH_YEOHA', 10, 'MOB_CL_YEOHA_10'],
    // B2 and B4: one model, two levels by area
    ['Chinese Tomb', 'MOB_CH_STONEGHOST', 9, 'MOB_CL_STONEGHOST_9'],
    ['Enterance of Qin-Shi Tomb', 'MOB_CH_STONEGHOST', 9, 'MOB_CL_SENTINEL_13'],
    ['Enterance of Qin-Shi Tomb', 'MOB_CH_TOMBSTONE_CLON', 8, 'MOB_CL_KEEPER_14'],
    ['lake forest', 'MOB_CH_BIGEYEGHOST', 3, 'MOB_CL_BIGEYE_3'],
    // B3: the explicit cross-base remaps
    ["Yeoha's Forest", 'MOB_CH_BANDIT', 16, 'MOB_CL_BANDITSUB_11'],
    ["Yeoha's Forest", 'MOB_CH_TIGER', 14, 'MOB_CL_YOUNGTIGER_12'],
    ["Yeoha's Forest", 'MOB_CH_BANDITARCHER', 12, 'MOB_CL_ARCHER_12'],
    // B5: back at retail levels for the big cats; the extras; Yeoha become Elder Yeoha
    ['North-Tiger Mt.', 'MOB_CH_WHITETIGER', 18, 'MOB_CL_WHITETIGER_18'],
    ['North-Tiger Mt.', 'MOB_CH_WHITETIGER_CLON', 17, 'MOB_CL_BLACKTIGER_17'],
    ['South-Tiger Mt.', 'MOB_CH_BANDIT_CLON', 11, 'MOB_CL_BANDITSUB_15'],
    ['North-Tiger Mt.', 'MOB_CH_TIGER_CLON', 13, 'MOB_CL_YOUNGTIGER_14'],
    ['North-Tiger Mt.', 'MOB_CH_YEOHA', 10, 'MOB_CL_YEOHA_13'],
    ["Bandit's Mountain Stronghold", 'MOB_CH_BANDITARCHER', 12, 'MOB_CL_ARCHER_18'],
    // B7 at the ferry landing: the Chakji and the crossers at the band's levels
    ['Jangan Ferry', 'MOB_CH_CHAKJI_CLON', 19, 'MOB_CL_CHAKJIWORKER_19'],
    ['Jangan Ferry', 'MOB_CH_BANDIT', 16, 'MOB_CL_HYUNGNO_23'],
    ['Jangan Ferry', 'MOB_CH_WHITETIGER', 18, 'MOB_CL_DEVILBUG_22'],
    // no row: the uniques and Hyeongcheon keep their code (the overrides empty Hyeongcheon's nests)
    ['North-Tiger Mt.', 'MOB_CH_TIGERWOMAN', 20, null],
    ['Enterance of Qin-Shi Tomb', 'MOB_WC_HYEONGCHEON', 30, null],
  ]
  for (const [area, code, level, want] of cases) it(`${area}: ${code} -> ${want}`, () => expect(climbCodeFor(area, code, level)).toBe(want))
  it('the high country (2026-10-10): the Ferry Heights (B7) and the Sea Cliffs (B8) are regions of the Tiger Mountains', () => {
    const heights = { rx: 157, rz: 94 }
    const cliffs = { rx: 156, rz: 91 }
    expect(climbPlaceAt(heights)?.name).toBe('The Ferry Heights')
    expect(climbBandAt('North-Tiger Mt.', heights)?.id).toBe('B7')
    expect(climbBandAt('South-Tiger Mt.', cliffs)?.id).toBe('B8')
    expect(climbBandAt('North-Tiger Mt.', { rx: 160, rz: 94 })?.id).toBe('B5')
    expect(climbCodeFor('North-Tiger Mt.', 'MOB_CH_WHITETIGER', 18, heights)).toBe('MOB_CL_DEVILBUG_22')
    expect(climbCodeFor('North-Tiger Mt.', 'MOB_CH_TIGER_CLON', 13, heights)).toBe('MOB_CL_CHAKJIWORKER_19')
    expect(climbCodeFor('South-Tiger Mt.', 'MOB_CH_BANDIT', 16, cliffs)).toBe('MOB_CL_EARTHGHOST_25')
    expect(climbCodeFor('South-Tiger Mt.', 'MOB_CH_WHITETIGER', 18, cliffs)).toBe('MOB_CL_TAOIST_25')
    expect(climbCodeFor('South-Tiger Mt.', 'MOB_CH_BANDITARCHER_CLON', 15, cliffs)).toBe('MOB_CL_POWDER_24')
    expect(climbCodeFor('South-Tiger Mt.', 'MOB_CH_BANDIT_CLON', 11, cliffs)).toBe('MOB_CL_HYUNGNOSHAMAN_24')
    // outside the places the Tiger Mountains stay B5; Tiger Girl keeps her code everywhere
    expect(climbCodeFor('South-Tiger Mt.', 'MOB_CH_BANDIT', 16, { rx: 160, rz: 90 })).toBe('MOB_CL_BANDIT_16')
    expect(climbCodeFor('South-Tiger Mt.', 'MOB_CH_TIGERWOMAN', 20, cliffs)).toBeNull()
    // every place's remap targets a row of its own band; every B7/B8 field row has a home on the island
    for (const p of CLIMB_PLACES) for (const c of Object.values(p.remap)) expect(CLIMB_ROSTER.find((r) => r.code === c)?.band, `${p.name} ${c}`).toBe(p.band)
    const homes = new Set([...CLIMB_PLACES.flatMap((p) => Object.values(p.remap)), ...Object.values(CLIMB_AREA_REMAP['Jangan Ferry']!), 'MOB_CL_CHAKJIWORKER_19'])
    for (const r of CLIMB_ROSTER.filter((x) => (x.band === 'B7' || x.band === 'B8') && !x.summonOnly)) expect(homes.has(r.code), r.code).toBe(true)
  })
  it("Tiger Girl's Guard is never a nest's monster; an unnamed area falls back by level", () => {
    expect(CLIMB_BANDS.flatMap((b) => b.areas).flatMap((a) => ['MOB_CH_WHITETIGER'].map((c) => climbCodeFor(a, c, 18)))).not.toContain('MOB_CL_TIGERGUARD_24')
    expect(climbCodeFor(null, 'MOB_CH_YEOHA', 10)).toBe('MOB_CL_YEOHA_10')
    expect(climbBandOfArea('NORTH-TIGER MT.')?.id).toBe('B5')
    expect(climbBandOfArea('Jangan')).toBeUndefined()
  })
})

describe('the level-difference EXP (§2.3, D4)', () => {
  it('-15 % a level from 2 below, never under 10 %; +5 % a level above, at most +15 %', () => {
    expect(levelDiffExpMul(10, 10)).toBe(1)
    expect(levelDiffExpMul(11, 10)).toBe(1)
    expect(levelDiffExpMul(12, 10)).toBeCloseTo(0.85)
    expect(levelDiffExpMul(13, 10)).toBeCloseTo(0.7)
    expect(levelDiffExpMul(25, 1)).toBeCloseTo(0.1)
    expect(levelDiffExpMul(10, 11)).toBeCloseTo(1.05)
    expect(levelDiffExpMul(10, 13)).toBeCloseTo(1.15)
    expect(levelDiffExpMul(1, 25)).toBeCloseTo(1.15)
  })
})

describe('four degrees inside the cap (§4.1.2, D53)', () => {
  const it4 = (code: string, degree: number, reqLevel: number): ItemDef => ({ code, degree, reqLevel } as ItemDef)
  it('spaces each degree linearly: D1 1-8, D2 8-15, D3 15-21, D4 21-25', () => {
    expect(CLIMB_TOP_DEGREE).toBe(4)
    expect(Object.fromEntries(Object.entries(CLIMB_DEGREE_LEVELS).map(([d, x]) => [d, x.climb]))).toEqual({ 1: [1, 8], 2: [8, 15], 3: [15, 21], 4: [21, 25] })
    // the retail spans' ends land on the Climb's
    for (const x of Object.values(CLIMB_DEGREE_LEVELS)) {
      for (const [r, c] of [[x.retail[0], x.climb[0]], [x.retail[1], x.climb[1]]] as const) expect(climbDegreeLevel(Number(Object.keys(CLIMB_DEGREE_LEVELS).find((k) => CLIMB_DEGREE_LEVELS[Number(k)] === x)), r)).toBe(c)
    }
    // degree 4: weapons A/B/C 24/26/29 -> 21/22/23, the chest 29/31/34 -> 23/24/25
    expect([24, 26, 29, 31, 34].map((r) => climbDegreeLevel(4, r))).toEqual([21, 22, 23, 24, 25])
    // degree 3 (the old squeeze's chest 26 -> 25 is now 21; the grade-C weapon 21 -> 18)
    expect([16, 18, 21, 26].map((r) => climbDegreeLevel(3, r))).toEqual([15, 16, 18, 21])
    expect(climbDegreeLevel(9, 40)).toBe(40)
    expect(climbDegreeLevel(1, 0)).toBe(0)
  })
  it("regular rows by their degree, seals at their letter's grade level, _DEF and other items unchanged", () => {
    const items = new Map<string, ItemDef>(
      [
        it4('ITEM_CH_BLADE_04_A', 4, 24), it4('ITEM_CH_BLADE_04_B', 4, 26), it4('ITEM_CH_BLADE_04_C', 4, 29),
        it4('ITEM_CH_BLADE_04_A_RARE', 4, 24), it4('ITEM_CH_BLADE_04_B_RARE', 4, 24), it4('ITEM_CH_BLADE_04_C_RARE', 4, 24),
        it4('ITEM_CH_M_HEAVY_04_BA_C', 4, 34), it4('ITEM_CH_W_LIGHT_03_BA_C', 4 - 1, 26), it4('ITEM_CH_SWORD_01_A_DEF', 1, 1),
        it4('ITEM_ETC_HP_POTION_04', 1, 0), it4('ITEM_CH_RING_04_C_RARE', 4, 24),
      ].map((i) => [i.code, i]),
    )
    expect(climbItemLevel(items.get('ITEM_CH_BLADE_04_C_RARE')!, (c) => items.get(c))).toBe(23)
    expect(climbItemLevel(items.get('ITEM_CH_RING_04_C_RARE')!)).toBe(21) // no regular row: the seal's own level is spaced
    expect(applyClimbItemLevels(items)).toBe(9)
    const lv = (c: string) => items.get(c)!.reqLevel
    expect(['A', 'B', 'C'].map((g) => lv(`ITEM_CH_BLADE_04_${g}`))).toEqual([21, 22, 23])
    expect(['A', 'B', 'C'].map((g) => lv(`ITEM_CH_BLADE_04_${g}_RARE`))).toEqual([21, 22, 23])
    expect(lv('ITEM_CH_M_HEAVY_04_BA_C')).toBe(25)
    expect(lv('ITEM_CH_W_LIGHT_03_BA_C')).toBe(21)
    expect(items.get('ITEM_CH_M_HEAVY_04_BA_C')!.retailReqLevel).toBe(34)
    expect(lv('ITEM_CH_SWORD_01_A_DEF')).toBe(1)
    expect(lv('ITEM_ETC_HP_POTION_04')).toBe(0)
    // a second pass changes nothing (the retail level is kept)
    expect(applyClimbItemLevels(items)).toBe(0)
    expect(lv('ITEM_CH_BLADE_04_C')).toBe(23)
  })
  it('the tiers: D3 is mid-tier, D4 grade C the top normal tier 23-25', () => {
    const t = (d: number, g: string) => CLIMB_TIERS.find((x) => x.degree === d && x.grades === g)!
    expect(t(3, 'C').levels).toEqual([18, 21])
    expect([t(4, 'A').levels, t(4, 'B').levels, t(4, 'C').levels]).toEqual([[21, 23], [22, 24], [23, 25]])
    expect(Math.max(...CLIMB_TIERS.map((x) => x.levels[1]))).toBe(CLIMB_CAP)
  })
  it("from level 21 a derived monster's degree-3 gear roll is half that piece, half its degree-4 grade-A twin (§4.4)", () => {
    expect(CLIMB_TOP_DROP_LEVEL).toBe(21)
    expect(climbDropCode('ITEM_CH_BLADE_03_C', 21)).toBe('ITEM_CH_BLADE_04_A')
    expect(climbDropCode('ITEM_CH_W_CLOTHES_03_FA_C', 23)).toBe('ITEM_CH_W_CLOTHES_04_FA_A')
    expect(climbDropCode('ITEM_CH_BLADE_03_C', 20)).toBe('ITEM_CH_BLADE_03_C')
    expect(climbDropCode('ITEM_CH_BLADE_04_B', 25)).toBe('ITEM_CH_BLADE_04_B')
    expect(climbDropCode('ITEM_ETC_HP_POTION_03', 25)).toBe('ITEM_ETC_HP_POTION_03')
    expect(climbDropCode('ITEM_CH_BLADE_03_C', 22, () => false)).toBe('ITEM_CH_BLADE_03_C')
    const t = { mob: 'MOB_WC_GHOSTBUG', provenance: 'p' as DropTable['provenance'], groups: [{ chance: 0.001, entries: [{ item: 'ITEM_CH_SPEAR_03_C', weight: 1 }, { item: 'ITEM_ETC_CURE_ALL_01', weight: 1 }] }] }
    const bug = CLIMB_ROSTER.find((r) => r.code === 'MOB_CL_GHOSTBUG_21')!
    const chakji = CLIMB_ROSTER.find((r) => r.code === 'MOB_CL_CHAKJI_20')!
    expect(deriveClimbDrops(t, bug)!.groups[0]!.entries.map((e) => e.item)).toEqual(['ITEM_CH_SPEAR_03_C', 'ITEM_CH_SPEAR_04_A', 'ITEM_ETC_CURE_ALL_01'])
    expect(deriveClimbDrops(t, chakji)!.groups[0]!.entries.map((e) => e.item)).toEqual(['ITEM_CH_SPEAR_03_C', 'ITEM_ETC_CURE_ALL_01'])
    expect(t.groups[0]!.entries[0]!.item).toBe('ITEM_CH_SPEAR_03_C')
  })
})

describe('live characters (§9.2, §9.3a)', () => {
  it('level 20s start the 20 -> 21 bar at 0 %', () => {
    expect(convertBarExp(20, 0, 282_000, 122_000)).toBe(0)
    expect(convertBarExp(20, 50_000, 282_000, 122_000)).toBe(0)
  })
  it('the rest keep their bar fraction, never a level gained or lost', () => {
    expect(convertBarExp(1, 59, 118, 1780)).toBe(890)
    expect(convertBarExp(15, 48_469, 96_938, 59_600)).toBe(29_800)
    expect(convertBarExp(19, 238_877, 238_878, 105_000)).toBe(104_999)
    expect(convertBarExp(12, 999_999, 47_940, 37_600)).toBe(37_599)
    expect(convertBarExp(5, 0, 2938, 7720)).toBe(0)
    expect(convertBarExp(5, -5, 2938, 7720)).toBe(0)
    // unknown old bar: the EXP is kept, under the new bar
    expect(convertBarExp(3, 500, 0, 3960)).toBe(500)
    expect(convertBarExp(3, 5000, 0, 3960)).toBe(3959)
    // above the old cap (a dev server with a higher LEVEL_CAP): the fraction too
    expect(convertBarExp(22, 213_877, 427_755, 168_000)).toBe(83_999)
  })
})

describe('Tiger Girl at level 25 (§2.6, D42)', () => {
  const tg = uniquesFile.uniques.find((u) => u.mob === 'MOB_CH_TIGERWOMAN')!
  it('content/uniques.json: level 25, hpMul 0.18, attackMul 1.4, expMul 0.2, fury x3 at 10 min, her White Tigers summon the Guard', () => {
    expect(tg.level).toBe(25)
    expect(tg.tuning).toEqual({ hpMul: 0.18, attackMul: 1.4, expMul: 0.2 })
    expect(tg.fury).toEqual({ afterSec: 600, damageMul: 3 })
    expect(tg.enrage).toEqual({ hpPct: 20, damageMul: 1.25 })
    expect(tg.summons.mobs).toEqual({ MOB_CH_WHITETIGER: 'MOB_CL_TIGERGUARD_24', MOB_CH_WHITETIGER_CLON: 'MOB_CL_TIGERGUARD_24' })
    expect(tg.pilot.kit.find((k: { id: string }) => k.id === 'pack').mob).toBe('MOB_CH_WHITETIGER') // remapped by summons.mobs at the call
    expect(tg.pilot.defaults.eligibility.minLevel).toBe(25)
    expect(tg.pilot.defaults.win.downMinLevel).toBe(20)
    expect(PILOT_DEFAULTS.eligibility.minLevel).toBe(25)
    expect(PILOT_DEFAULTS.win.downMinLevel).toBe(20)
    expect(checkUniquesFile(uniquesFile)).toEqual([])
  })
  it("her numbers on the retail row: 598,720 x 0.18 = 107,770 HP, 181-217 x 1.4 = 253-304, 451,200 x 0.2 = 90,240 EXP; defences and hit at 25", () => {
    const her = base('MOB_CH_TIGERWOMAN', { rarity: 'unique', level: 20, hp: 598_720, physAttack: [181, 217], physDefence: 42, magDefence: 60, hitRate: 65, parryRate: 50, physAbsorb: 20, exp: 451_200 })
    const at25 = relevelMob(her, tg.level)
    expect(Math.round(at25.hp * tg.tuning.hpMul)).toBe(107_770)
    expect(at25.physAttack.map((a) => Math.round(a * tg.tuning.attackMul))).toEqual([253, 304])
    expect(Math.round(at25.exp * tg.tuning.expMul)).toBe(90_240)
    expect(at25).toMatchObject({ level: 25, hitRate: 75, parryRate: 60, physAbsorb: 25 })
    expect(at25.physDefence).toBe(42 + Math.round(climbStd.pd(25) - climbStd.pd(20)))
    expect(at25.magDefence).toBe(60 + Math.round(climbStd.md(25) - climbStd.md(20)))
    expect(relevelMob(her, 20)).toBe(her)
  })
  it('her loot (D54): a seal 2 % of each of her 3 gear drops, Star 1.5 %, Moon 0.4 %, Sun 0.1 %, degree 4', () => {
    const groups = uniquesFile.dropTables[tg.drops]!.groups.filter((g) => g.pool?.rare)
    expect(groups.map((g) => [g.chance, (g as { rolls?: number }).rolls, g.pool!.seal ?? 'star', g.pool!.degree])).toEqual([[0.015, 3, 'star', 4], [0.004, 3, 'moon', 4], [0.001, 3, 'sun', 4]])
  })
})

describe('the other bosses at 25 (§2.6, D44)', () => {
  it('the Ice Yeti: level 25, 30,000 x YETI_HP_MUL 2.6 = 78,000 HP, attack 189-240 (D53), EXP pool 90,000', () => {
    const y = WINTER_MOBS.find((m) => m.name === 'Ice Yeti')!
    expect(y).toMatchObject({ level: 25, hp: 30_000, physAttack: [189, 240], exp: 90_000, hitRate: 75 })
    expect(y.hp * WINTER_PLAY.yeti.hpMul).toBe(78_000)
  })
  it('the siege Warlord: 96,000 x s^0.9 HP, attack x 1.15', () => {
    expect(SIEGE_EVENT_DEFAULTS.army.warlordHp).toBe(96_000)
    expect(SIEGE_MOBS.find((m) => m.name === 'Bandit Warlord')!.atkMul).toBe(1.15)
  })
})
