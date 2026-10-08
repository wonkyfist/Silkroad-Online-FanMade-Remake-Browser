/**
 * Wave 8 exporter lane EXP (docs/SYSTEMS_COMBAT.md §8 EXP, docs/WAVE_PLAN2.md §6.3, D6): horse items, Recovery Kits,
 * elixirs and Lucky Powders in items.json, cos.json, the MSKILL rows in skills.json, the repair role, and the
 * cos.horse.* / berserk.* sound cues. Synthetic rows first; then the real client + port data (skips without them).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { characterDataRow, itemDataRow, skillDataRow, type TextdataRow } from '@sro/formats'
import { checkContentFile, CONTENT_FILES, contentEntries, type CosDef, type DropTable, type ItemDef, type NpcDef, type ShopDef, type SkillDef } from '../../shared/src/index.ts'
import type { SoundCue } from '../../shared/src/sound.ts'
import { loadClientSources } from '../src/data/client-source.ts'
import { buildContent, type ContentOutput } from '../src/data/content.ts'
import { buildCos, buildCosDef } from '../src/data/cos.ts'
import { worldFrameFromManifest } from '../src/data/frame.ts'
import { buildItemDef, classifyItem, isExportedItem, itemIconSource, itemReinforce } from '../src/data/items.ts'
import { defaultPortDataDir, loadPortData } from '../src/data/port-source.ts'
import { buildMobSkills } from '../src/data/skills.ts'
import { textdataReader } from '../src/data/textdata-source.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'
import { BERSERK_CUES, planSoundIndex, swapEqSounds } from '../src/sound/build.ts'
import { parseEffectSound } from '../src/sound/effectsound.ts'
import { SoundResolver } from '../src/sound/resolve.ts'

const row = (cells: string[]): TextdataRow => ({ file: 't.txt', line: 1, cells })

function itemCells(code: string, typeId: [number, number, number, number], extra: Record<number, string> = {}): string[] {
  const c = Array.from({ length: 160 }, () => '0')
  Object.assign(c, { 0: '1', 1: '100', 2: code, 3: 'xxx', 4: 'xxx', 5: 'SN_' + code, 6: 'xxx', 9: String(typeId[0]), 10: String(typeId[1]), 11: String(typeId[2]), 12: String(typeId[3]) })
  Object.assign(c, { 14: '3', 16: '1', 17: '1', 20: '3', 32: '1', 33: '1', 34: '-1', 36: '-1', 38: '-1', 52: 'xxx', 53: 'xxx', 54: 'xxx', 57: '1', 58: '2', 61: '1' })
  for (let i = 118; i < 158; i += 2) Object.assign(c, { [i]: '-1', [i + 1]: 'xxx' })
  return Object.assign(c, extra)
}

function charCells(code: string, id: number, typeId: [number, number, number, number], extra: Record<number, string> = {}): string[] {
  const c = Array.from({ length: 104 }, () => '0')
  Object.assign(c, { 0: '1', 1: String(id), 2: code, 3: 'xxx', 4: 'xxx', 5: 'SN_' + code, 6: 'xxx', 9: String(typeId[0]), 10: String(typeId[1]), 11: String(typeId[2]), 12: String(typeId[3]) })
  for (let i = 32; i <= 38; i += 2) c[i] = '-1'
  Object.assign(c, { 48: '100', 52: 'xxx', 53: 'xxx', 54: 'xxx', 55: 'xxx', 56: 'xxx' })
  return Object.assign(c, extra)
}

/** FourCC tag value as skilldata stores it ('att' = 0x617474). */
const tag = (s: string) => [...s].reduce((v, ch) => v * 256 + ch.charCodeAt(0), 0)

function skillCells(code: string, id: number, params: number[], extra: Record<number, string> = {}): string[] {
  const c = Array.from({ length: 118 }, () => '0')
  Object.assign(c, { 0: '1', 1: String(id), 2: '0', 3: code, 4: '?', 5: 'xxx', 7: '1', 8: '2', 50: '255', 51: '255', 61: 'xxx', 62: 'xxx', 64: 'xxx' })
  params.forEach((v, i) => (c[69 + i] = String(v)))
  return Object.assign(c, extra)
}

const ctx = { strings: new Map([['SN_ITEM_COS_C_HORSE1', 'Red Horse'], ['SN_COS_C_HORSE1', 'Red Horse']]), exists: () => true, basicAttacks: new Map<number, string>() }

describe('items: horse, Recovery Kits, elixirs, Lucky Powders (synthetic)', () => {
  it('keeps the wave-8 codes in scope by code, not by degree', () => {
    const exported = (code: string, t: [number, number, number, number], x: Record<number, string> = {}) => isExportedItem(itemDataRow(row(itemCells(code, t, x))))
    expect(exported('ITEM_COS_C_HORSE1', [3, 3, 3, 2])).toBe(true)
    expect(exported('ITEM_COS_C_HORSE2', [3, 3, 3, 2])).toBe(false)
    expect(exported('ITEM_ETC_COS_HP_POTION_03', [3, 3, 1, 4])).toBe(true)
    expect(exported('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', [3, 3, 10, 1])).toBe(true)
    expect(exported('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_B', [3, 3, 10, 1], { 61: '2' })).toBe(false)
    expect(exported('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', [3, 3, 10, 2], { 61: '3' })).toBe(true)
    // Powders 5-9 have ItemDef.degree 2-3 and would pass MAX_ITEM_DEGREE: the code keeps them out. The 4th matches
    // degree 4, the Climb's cap tier (docs/CLIMB.md §4.1.2), and is exported.
    expect(exported('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_04', [3, 3, 10, 2], { 61: '4' })).toBe(true)
    expect(exported('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_05', [3, 3, 10, 2], { 61: '5' })).toBe(false)
    expect(classifyItem(itemDataRow(row(itemCells('X', [3, 3, 10, 1]))))).toEqual({ category: 'alchemy' })
  })

  it('reads the horse summon code, the kit target and cooldown group', () => {
    const horse = buildItemDef(itemDataRow(row(itemCells('ITEM_COS_C_HORSE1', [3, 3, 3, 2], { 33: '10', 118: '0', 119: 'COS_C_HORSE1' }))), ctx)
    expect(horse).toMatchObject({ category: 'scroll', reqLevel: 10, use: { summon: 'COS_C_HORSE1' } })
    const kit = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_COS_HP_POTION_01', [3, 3, 1, 4], { 118: '360', 119: 'HP', 120: '0', 122: '0', 124: '0' }))), ctx)
    expect(kit.use).toEqual({ hp: 360, cooldownGroup: 'cos_hp', cooldownMs: 1000, target: 'mount' })
    const pot = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_HP_POTION_01', [3, 3, 1, 1], { 118: '120', 120: '0', 122: '0', 124: '0' }))), ctx)
    expect(pot.use?.target).toBeUndefined()
  })

  it('unpacks elixir targets and big-endian rates, and the powder degree from Param1', () => {
    expect(itemReinforce(1, [0x06000000, 0x19140f0a, 0x0a0a0a0a, 0x0a050505])).toEqual({ kind: 'elixir', targets: [6], rates: [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5] })
    expect(itemReinforce(1, [0x01020300, 0, 0, 0])?.targets).toEqual([1, 2, 3])
    expect(itemReinforce(2, [2, 0x321e1408, 0x08080808, 0x08080808])).toEqual({ kind: 'powder', degree: 2, rates: [50, 30, 20, 8, 8, 8, 8, 8, 8, 8, 8, 8] })
    const powder = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_02', [3, 3, 10, 2], { 61: '2', 118: '2', 120: String(0x321e1408), 122: String(0x08080808), 124: String(0x08080808) }))), ctx)
    expect(powder.degree).toBe(1)
    expect(powder.reinforce).toMatchObject({ kind: 'powder', degree: 2 })
  })

  it('maps the missing _A elixir icon to the per-kind _b icon', () => {
    const elixir = itemDataRow(row(itemCells('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_SHIELD_A', [3, 3, 10, 1], { 54: 'item\\etc\\archemy_reinforce_recipe_a.ddj' })))
    expect(itemIconSource(elixir, a => !/recipe_a\.ddj$/.test(a)).icon).toBe('item\\etc\\archemy_reinforce_recipe_shield_b.ddj')
    expect(itemIconSource(elixir).icon).toBe('item\\etc\\archemy_reinforce_recipe_shield_b.ddj')
    expect(itemIconSource(elixir, () => true).icon).toBe('item\\etc\\archemy_reinforce_recipe_a.ddj')
    const def = buildItemDef(elixir, { ...ctx, hasIcon: a => !/recipe_a\.ddj$/.test(a) })
    expect(def.icon).toBe('/out/icon/item/etc/archemy_reinforce_recipe_shield_b.png')
    expect((def as { fieldSources?: Record<string, string> }).fieldSources?.icon).toMatch(/fallback/)
  })
})

describe('cos.json and the MSKILL rows (synthetic)', () => {
  it('builds a CosDef per summon item from characterdata', () => {
    const horseRow = characterDataRow(row(charCells('COS_C_HORSE1', 2191, [1, 2, 3, 1], { 46: '45', 47: '90', 50: '12', 52: 'cos\\c_horse1.bsr', 54: 'cos\\cos_c_horse1.ddj', 57: '20', 59: '983', 73: '20', 74: '20', 75: '65', 77: '65' })))
    expect(buildCosDef(horseRow, ctx)).toMatchObject({ code: 'COS_C_HORSE1', id: 2191, name: 'Red Horse', level: 20, hp: 983, walkSpeed: 4.5, runSpeed: 9, radius: 1.2, physAbsorb: 20, magAbsorb: 20, parryRate: 65, hitRate: 65, icon: '/out/icon/cos/cos_c_horse1.png' })
    const items = [{ code: 'ITEM_COS_C_HORSE1', use: { summon: 'COS_C_HORSE1' } }, { code: 'ITEM_X', use: { summon: 'COS_NOPE' } }] as ItemDef[]
    const r = buildCos(items, { ...ctx, byCode: new Map([['COS_C_HORSE1', horseRow]]) })
    expect(r.cos.map(c => c.code)).toEqual(['COS_C_HORSE1'])
    expect(r.models).toEqual(['res/cos/c_horse1.bsr'])
    expect(r.icons).toEqual(['cos\\cos_c_horse1.ddj'])
    expect(r.warnings).toHaveLength(1)
    expect(checkContentFile('cos', { schema: 1, kind: 'cos', generatedAt: '', sources: [], entries: r.cos })).toEqual([])
  })

  it('exports monster rows keyed by code, with aiChance, summons and pure-debuff rows', () => {
    const rows = [
      skillDataRow(row(skillCells('MSKILL_X_ATTACK01', 1, [tag('att'), 5, 100, 10, 12, 100], { 12: '0', 13: '1000', 14: '1500', 15: '2000', 21: '9', 66: '100' }))),
      skillDataRow(row(skillCells('MSKILL_X_GAS', 2, [tag('att'), 9, 0, 0, 0, 100, tag('ps'), 34, 100, 16], { 12: '1196', 14: '4000', 21: '16', 66: '10' }))),
      skillDataRow(row(skillCells('MSKILL_X_CURSE', 3, [tag('att'), 10, 367, 281, 321, 100], { 12: '3003', 21: '150', 66: '10' }))),
      skillDataRow(row(skillCells('MSKILL_X_SUMMON01', 4, [tag('ssou'), 1953, 0, 3, 6, 1952, 1, 2, 4], { 15: '500', 66: '80' }))),
    ]
    const skilleffect = [['#section', 'skillaniset2'], ['1', 'x', 'MSKILL_X_ATTACK01', '0', 'FALSE', '0', 'DEFAULT', 'none', 'none', 'ANI_ATTACK2'], ['#section', 'skilleffectset'], ['x', 'MSKILL_X_ATTACK01', 'SHOT', '1', 'TRUE']]
    const ids = new Map([[1953, 'MOB_CH_WHITETIGER'], [1952, 'MOB_CH_WHITETIGER_CLON']])
    const { skills, warnings } = buildMobSkills(rows, [{ code: 'MOB_X', skills: ['MSKILL_X_ATTACK01', 'MSKILL_X_GAS', 'MSKILL_X_CURSE', 'MSKILL_X_SUMMON01', 'MSKILL_MISSING'] }], { skilleffect }, new Map(), id => ids.get(id))
    expect(warnings).toEqual(['mob skills: MOB_X lists MSKILL_MISSING, which has no skilldata row'])
    const by = new Map(skills.map(s => [s.code, s]))
    expect(by.get('MSKILL_X_ATTACK01')).toMatchObject({ mob: true, mastery: null, group: 'MSKILL_X_ATTACK01', category: 'melee', kind: 'attack', aiChance: 100, cooldownMs: 2000, range: 0.9, animation: { shot: 'ATTACK2' }, hitCues: [{ phase: 'SHOT', event: 1 }], damage: { physPct: 100, flat: [10, 12], hits: 1 } })
    expect(by.get('MSKILL_X_ATTACK01')!.ui).toBeUndefined()
    const gas = by.get('MSKILL_X_GAS')!
    expect(gas.damage).toBeUndefined()
    expect(gas).toMatchObject({ kind: 'debuff', aiChance: 10, statuses: [{ status: 'poison', level: 34, chancePct: 100 }] })
    expect(by.get('MSKILL_X_CURSE')).toMatchObject({ category: 'ranged', range: 15, damage: { magPct: 367 } })
    expect(by.get('MSKILL_X_SUMMON01')!.summon).toEqual([{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 3, max: 6 }, { mob: 'MOB_CH_WHITETIGER_CLON', rarity: 1, min: 2, max: 4 }])
  })
})

describe('sound cues (synthetic)', () => {
  const r = (...c: string[]) => c.join('\t')
  const rows = parseEffectSound([
    r('UI', 'SND_EQDANGER', '-', '-', '-', '-', '0', 'ui\\', 'itembreak.wav', '80', 'warning'),
    r('UI', 'SND_EQBREAK', '-', '-', '-', '-', '0', 'ui\\', 'Itemdanger.wav', '80', 'break'),
    r('COS_C_HORSE', 'SND_STAND', '-', '-', '-', '-', '3', 'COS\\', 'COS_Horse_Stand.wav', '80', ''),
    r('COS_C_HORSE', 'VOC_MOAN', '-', 'NORMAL', '-', '-', '0', 'COS\\', 'COS_Horse_Moan1.wav', '80', ''),
    r('COS_C_HORSE', 'VOC_MOAN', '-', 'CRITYCAL', '-', '-', '0', 'COS\\', 'COS_Horse_Moan2.wav', '80', ''),
    r('COS_C_HORSE', 'VOC_DEATH', '-', '-', '-', '-', '0', 'COS\\', 'COS_Horse_Die.wav', '80', ''),
    r('COS_C_HORSE', 'SND_DEATH', '-', '-', '-', '-', '0', 'COS\\', 'COS_Horse_Thud.wav', '80', ''),
    r('COS_C_HORSE', 'SND_WALK1', '-', '-', '-', '-', '0', 'player\\', 'mvWalkHground.wav', '80', ''),
    r('COS_C_HORSE', 'SND_RUN1', '-', '-', '-', '-', '0', 'COS\\', 'COS_Horse_Run.wav', '80', ''),
  ].join('\n'))
  const files = ['ui/itembreak', 'ui/itemdanger', 'cos/cos_horse_stand', 'cos/cos_horse_moan1', 'cos/cos_horse_moan2', 'cos/cos_horse_die', 'cos/cos_horse_thud', 'cos/cos_horse_run', 'player/mvwalkhground', 'player/hwanchange', 'player/hwanreturn']

  it('adds cos.horse.* and berserk.*, and uncrosses ui.eqbreak / ui.eqdanger', () => {
    const plan = planSoundIndex({
      scope: 'jangan', rows, envAreas: [], regionAreas: [], skillEffectText: '', resolver: new SoundResolver(files.map(f => `${f}.wav`)),
      models: [], players: [], mobs: [], skillGroups: [], musicKeys: [],
    })
    const c = plan.index.cues
    expect(c['cos.horse.stand']).toEqual({ files: ['cos/cos_horse_stand'], gain: 0.8, category: 'sfx' })
    expect(c['cos.horse.moan']!.files).toEqual(['cos/cos_horse_moan1'])
    expect(c['cos.horse.moanCrit']!.files).toEqual(['cos/cos_horse_moan2'])
    expect(c['cos.horse.die']!.files).toEqual(['cos/cos_horse_die'])
    expect(c['cos.horse.thud']!.files).toEqual(['cos/cos_horse_thud'])
    expect(c['cos.horse.run']!.files).toEqual(['cos/cos_horse_run'])
    expect(c['berserk.start']).toEqual({ files: ['player/hwanchange'], gain: 1, category: 'sfx' })
    expect(c['berserk.end']!.files).toEqual(['player/hwanreturn'])
    expect(BERSERK_CUES.map(([k]) => k)).toEqual(['berserk.start', 'berserk.end'])
    expect(c['ui.eqbreak']!.files).toEqual(['ui/itembreak'])
    expect(c['ui.eqdanger']!.files).toEqual(['ui/itemdanger'])
    for (const f of ['cos/cos_horse_stand', 'player/hwanchange', 'player/hwanreturn']) expect(plan.files.has(f), f).toBe(true)
  })

  it('swaps only the retail crossed pair', () => {
    const cue = (f: string): SoundCue => ({ files: [f], gain: 0.8, category: 'ui' })
    const crossed = { 'ui.eqbreak': cue('ui/itemdanger'), 'ui.eqdanger': cue('ui/itembreak') }
    swapEqSounds(crossed)
    expect(crossed['ui.eqbreak'].files).toEqual(['ui/itembreak'])
    const straight = { 'ui.eqbreak': cue('ui/itembreak'), 'ui.eqdanger': cue('ui/itemdanger') }
    swapEqSounds(straight)
    expect(straight['ui.eqbreak'].files).toEqual(['ui/itembreak'])
  })
})

// ---- the real client + port data ----------------------------------------------------------------------------

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const portDir = hasConfig ? (process.env.SRO_PORT_DATA ?? defaultPortDataDir(loadConfig().clientDir)) : ''
const hasPort = hasConfig && existsSync(join(portDir, 'spawns.json'))

describe.skipIf(!hasPort)('wave-8 export on the real data (docs/SYSTEMS_COMBAT.md §8 EXP)', () => {
  let out: ContentOutput
  const entries = <T>(file: string) => contentEntries<T>(out.files[file])
  const item = (code: string) => entries<ItemDef>(CONTENT_FILES.items).find(i => i.code === code)!
  const skill = (code: string) => entries<SkillDef>(CONTENT_FILES.skills).find(s => s.code === code)!

  beforeAll(() => {
    const cfg = loadConfig()
    const media = openArchive('Media', cfg)
    const data = openArchive('Data', cfg)
    const manifest = join(cfg.workDir, 'out', 'world', 'jangan', 'manifest.json')
    out = buildContent({
      client: loadClientSources(textdataReader(media)),
      port: loadPortData(portDir),
      world: existsSync(manifest)
        ? worldFrameFromManifest(JSON.parse(readFileSync(manifest, 'utf8')))
        : { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([24743, 24744, 24745, 24999, 25000, 25001, 25255, 25256, 25257]) },
      exists: () => true,
      hasData: p => data.get(p) !== undefined,
      hasIcon: a => media.get('icon/' + a.replace(/\\/g, '/')) !== undefined,
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('Red Horse: level 10, 1,200 gold, summons COS_C_HORSE1; cos.json has its body', () => {
    expect(item('ITEM_COS_C_HORSE1')).toMatchObject({ name: 'Red Horse', reqLevel: 10, price: 1200, use: { summon: 'COS_C_HORSE1' } })
    const cos = entries<CosDef>(CONTENT_FILES.cos)
    // with the job system's four trade transports (docs/JOBS.md §5.4, layer 0)
    expect(cos.map(c => c.code).sort()).toEqual(['COS_C_HORSE1', 'COS_T_DHORSE1', 'COS_T_DONKEY', 'COS_T_HORSE1', 'COS_T_HORSE2'])
    expect(cos.find(c => c.code === 'COS_T_DONKEY')).toMatchObject({ name: 'Donkey' })
    expect(cos.find(c => c.code === 'COS_C_HORSE1')).toMatchObject({ id: 2191, level: 20, hp: 983, walkSpeed: 4.5, runSpeed: 9, radius: 1.2, icon: '/out/icon/cos/cos_c_horse1.png', model: { bsr: 'res/cos/c_horse1.bsr' } })
    expect(checkContentFile('cos', out.files[CONTENT_FILES.cos])).toEqual([])
    expect(out.report.models.cos).toEqual(['res/cos/c_horse1.bsr', 'res/cos/t_dhorse1.bsr', 'res/cos/t_donkey.bsr', 'res/cos/t_horse1.bsr', 'res/cos/t_horse2.bsr'])
    expect(out.report.icons).toContain('cos\\cos_c_horse1.ddj')
  })

  it('Recovery Kits heal the horse (360 / 660 / 1,110 HP)', () => {
    expect(['ITEM_ETC_COS_HP_POTION_01', 'ITEM_ETC_COS_HP_POTION_02', 'ITEM_ETC_COS_HP_POTION_03'].map(c => item(c).use)).toEqual(
      [360, 660, 1110].map(hp => ({ hp, cooldownGroup: 'cos_hp', cooldownMs: 1000, target: 'mount' })),
    )
  })

  it('elixirs and powders: targets, rates, degrees and the _b icon fallback', () => {
    const weapon = item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A')
    expect(weapon.category).toBe('alchemy')
    expect(weapon.reinforce?.kind).toBe('elixir')
    expect(weapon.reinforce?.targets).toEqual([6])
    expect(weapon.reinforce?.rates.slice(0, 4)).toEqual([25, 20, 15, 10])
    expect(weapon.reinforce?.rates.slice(8, 12)).toEqual([10, 5, 5, 5])
    expect(item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A').reinforce?.targets).toEqual([1, 2, 3])
    expect(item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_SHIELD_A').reinforce?.targets).toEqual([4])
    expect(item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ACCESSARY_A').reinforce?.targets).toEqual([5])
    expect(item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01').reinforce).toMatchObject({ kind: 'powder', degree: 1 })
    expect(item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01').reinforce?.rates[0]).toBe(50)
    const second = item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_02')
    expect(second.reinforce?.degree).toBe(2)
    expect(second.degree).toBe(1)
    for (const k of ['WEAPON', 'SHIELD', 'ARMOR', 'ACCESSARY']) {
      expect(item(`ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_${k}_A`).icon).toBe(`/out/icon/item/etc/archemy_reinforce_recipe_${k.toLowerCase()}_b.png`)
    }
    expect(item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_04').reinforce).toMatchObject({ kind: 'powder', degree: 4 })
    expect(entries<ItemDef>(CONTENT_FILES.items).some(i => /PROB_UP_A_0[5-9]|RECIPE_\w+_B$|C_HORSE[23]$/.test(i.code))).toBe(false)
  })

  it('types perPlus (Copper Sword +2.4 / +4.1 per plus)', () => {
    expect(item('ITEM_CH_SWORD_01_A').perPlus).toMatchObject({ physAttack: 2.4, magAttack: 4.1 })
  })

  it('exports the MSKILL rows of the Jangan mobs into skills.json', () => {
    const tigerHowl = skill('MSKILL_CH_TIGERWOMAN_ATTACK02')
    expect(tigerHowl).toMatchObject({ mob: true, mastery: null, aiChance: 30, area: { shape: 'caster', distance: 4, maxTargets: 5 } })
    expect(skill('MSKILL_CH_WATERGHOST_ATTACK02').statuses?.[0]).toMatchObject({ status: 'poison', level: 34 })
    expect(skill('MSKILL_CH_WATERGHOST_ATTACK02').damage).toBeUndefined()
    const mangyang = skill('MSKILL_CH_MANGNYANG_ATTACK02')
    expect(mangyang.damage?.hits).toBe(2)
    expect(mangyang.hitCues).toHaveLength(2)
    expect(skill('MSKILL_CH_TIGERWOMAN_ATTACK01')).toMatchObject({ castMs: 1109, actionMs: 1391, cooldownMs: 3000, animation: { shot: 'ATTACK1' } })
    expect(skill('MSKILL_CH_CHAKJI_ATTACK01').animation).toEqual({ shot: 'ATTACK2' })
    expect(skill('MSKILL_CH_TOMBSTONE_CLON_ATTACK01')).toMatchObject({ category: 'ranged', range: 10 })
    expect(skill('MSKILL_CH_TOMBSTONE_CLON_ATTACK01').hitCues?.[0]?.projectile).toBeTruthy()
    expect(skill('MSKILL_CH_TIGERWOMAN_SUMMON01').summon?.map(s => s.mob)).toEqual(['MOB_CH_WHITETIGER', 'MOB_CH_WHITETIGER_CLON'])
    // Every mob's default skill has a row; player rows are unchanged.
    const codes = new Set(entries<SkillDef>(CONTENT_FILES.skills).map(s => s.code))
    for (const m of entries<{ code: string; skills?: string[] }>(CONTENT_FILES.mobs)) for (const s of m.skills ?? []) expect(codes.has(s), `${m.code} ${s}`).toBe(true)
    expect(entries<SkillDef>(CONTENT_FILES.skills).filter(s => s.mob).every(s => s.mastery === null && !s.ui)).toBe(true)
    expect(out.report.counts.mobSkills).toBeGreaterThanOrEqual(43)
  })

  it('Machun sells the Red Horse and the kits; Jinjin the four powders (the 4th: degree 4, CLIMB D53); Chulsan and Mrs Jang repair', () => {
    const shops = entries<ShopDef>(CONTENT_FILES.shops)
    const stable = shops.find(s => s.id === 'STORE_CH_STABLE')!
    expect(stable.npcs).toEqual(['NPC_CH_HORSE'])
    expect(stable.tabs.flatMap(t => t.items)).toEqual(['ITEM_COS_C_HORSE1', 'ITEM_ETC_COS_HP_POTION_01', 'ITEM_ETC_COS_HP_POTION_02', 'ITEM_ETC_COS_HP_POTION_03'])
    expect(shops.find(s => s.id === 'STORE_CH_ACCESSORY')!.tabs.flatMap(t => t.items).filter(i => /ARCHEMY/.test(i))).toEqual(
      ['ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01', 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_02', 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_04'],
    )
    const npcs = entries<NpcDef>(CONTENT_FILES.npcs)
    const roles = (code: string) => npcs.find(n => n.code === code)?.roles ?? []
    expect(roles('NPC_CH_SMITH')).toContain('repair')
    expect(roles('NPC_CH_ARMOR')).toContain('repair')
    expect(roles('NPC_CH_HORSE')).toEqual(['shop'])
    expect(npcs.filter(n => n.roles?.includes('repair')).map(n => n.code).sort()).toEqual(['NPC_CH_ARMOR', 'NPC_CH_SMITH'])
  })

  it('drops.json: the Bandit (16) drops the port _A elixirs', () => {
    const bandit = entries<DropTable>(CONTENT_FILES.drops).find(d => d.mob === 'MOB_CH_BANDIT')!
    expect(bandit.groups.flatMap(g => g.entries.map(e => e.item))).toContain('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A')
  })
})
