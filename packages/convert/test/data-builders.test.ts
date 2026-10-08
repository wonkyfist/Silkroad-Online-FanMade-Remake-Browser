import { describe, expect, it } from 'vitest'
import { characterDataRow, itemDataRow, parseSkillParams, type CharacterDataRow, type TextdataRow } from '@sro/formats'
import { checkDropTable, checkMobDef, checkNestDef, PROVENANCE_PORT } from '../../shared/src/index.ts'
import { buildDrops } from '../src/data/drops.ts'
import type { WorldFrame } from '../src/data/frame.ts'
import { npcGreetingKey, npcGreetings } from '../src/data/client-source.ts'
import { buildItemDef, classifyItem, isExportedItem } from '../src/data/items.ts'
import { buildMobDef, championModelSource, mobModelSource, type MobContext } from '../src/data/mobs.ts'
import { iconUrl, modelRef } from '../src/data/models.ts'
import { buildNest } from '../src/data/nests.ts'
import { buildNpcs, matchFacing, regionsOfContinent, shopChain } from '../src/data/npcs.ts'
import type { PortNest } from '../src/data/port-source.ts'
import { skillAnimations, skillCategory, skillDamage } from '../src/data/skills.ts'

const row = (cells: string[]): TextdataRow => ({ file: 't.txt', line: 1, cells })

function itemCells(code: string, typeId: [number, number, number, number], extra: Record<number, string> = {}): string[] {
  const c = Array.from({ length: 160 }, () => '0')
  Object.assign(c, { 0: '1', 1: '100', 2: code, 3: 'xxx', 4: 'xxx', 5: 'SN_' + code, 6: 'xxx', 9: String(typeId[0]), 10: String(typeId[1]), 11: String(typeId[2]), 12: String(typeId[3]) })
  Object.assign(c, { 17: '1', 20: '3', 32: '1', 33: '1', 34: '-1', 36: '-1', 38: '-1', 52: 'xxx', 53: 'xxx', 54: 'xxx', 57: '1', 58: '2', 61: '1' })
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

describe('items', () => {
  it('selects Chinese equipment up to degree 4 (the cap tier of CLIMB §4.1.2) and the listed consumables', () => {
    const sword = itemDataRow(row(itemCells('ITEM_CH_SWORD_01_A', [3, 1, 6, 2])))
    expect(isExportedItem(sword)).toBe(true)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_CH_SWORD_04_A', [3, 1, 6, 2], { 61: '10' }))))).toBe(true)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_CH_SWORD_05_A', [3, 1, 6, 2], { 61: '13' }))))).toBe(false)
    // docs/RARITY.md §2: weapon seals at every degree (a degree-1 Seal of Star sword is in)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_CH_SWORD_01_A_RARE', [3, 1, 6, 2]))))).toBe(true)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_CH_SHIELD_01_A_RARE', [3, 1, 4, 1]))))).toBe(false)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_EU_SWORD_01_A', [3, 1, 6, 7], { 14: '1' }))))).toBe(false)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_CH_W_HEAVY_02_BA_B', [3, 1, 3, 3], { 61: '5' }))))).toBe(true)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_ETC_HP_POTION_01', [3, 3, 1, 1], { 14: '3' }))))).toBe(true)
    expect(isExportedItem(itemDataRow(row(itemCells('ITEM_ETC_TRADE_CH_01', [3, 3, 3, 1], { 14: '3' }))))).toBe(false)
  })

  it('classifies by TypeID', () => {
    const cls = (t: [number, number, number, number]) => classifyItem(itemDataRow(row(itemCells('X', t))))
    expect(cls([3, 1, 6, 5])).toEqual({ category: 'weapon', slot: 'weapon', weaponType: 'glaive' })
    expect(cls([3, 1, 1, 1])).toEqual({ category: 'armor', slot: 'head', armorType: 'garment' })
    expect(cls([3, 1, 3, 6])).toEqual({ category: 'armor', slot: 'feet', armorType: 'armor' })
    expect(cls([3, 1, 5, 3])).toEqual({ category: 'accessory', slot: 'ring' })
    expect(cls([3, 1, 4, 1])).toEqual({ category: 'shield', slot: 'shield' })
    expect(cls([3, 3, 3, 1])).toEqual({ category: 'scroll' })
    expect(cls([3, 3, 5, 0])).toEqual({ category: 'gold' })
  })

  it('builds weapon stats (mean of the min and max rolls) and potion / scroll use', () => {
    const ctx = { strings: new Map([['SN_ITEM_CH_SWORD_01_A', 'Copper Sword']]), exists: () => true, basicAttacks: new Map([[2, 'SKILL_CH_SWORD_BASE_01']]) }
    const sword = buildItemDef(
      itemDataRow(row(itemCells('ITEM_CH_SWORD_01_A', [3, 1, 6, 2], { 14: '0', 26: '890', 31: '427', 52: 'item\\china\\weapon\\sword_01.bsr', 54: 'item\\china\\weapon\\sword_01.ddj', 63: '62.0', 64: '76.0', 94: '6', 95: '15.0', 96: '16.0', 97: '16.0', 98: '18.0', 99: '2.4000001' }))),
      ctx,
    )
    expect(sword).toMatchObject({ code: 'ITEM_CH_SWORD_01_A', name: 'Copper Sword', category: 'weapon', weaponType: 'sword', race: 'china', range: 0.6, price: 890, sellPrice: 427, basicAttack: 'SKILL_CH_SWORD_BASE_01' })
    expect(sword.stats).toEqual({ physAttack: [15.5, 17], durability: [62, 76] })
    expect(sword.perPlus).toEqual({ physAttack: 2.4 })
    expect(sword.model).toEqual({ bsr: 'res/item/china/weapon/sword_01.bsr', glb: '/out/item/china/weapon/sword_01.glb', sidecar: '/out/item/china/weapon/sword_01.json' })
    expect(sword.icon).toBe('/out/icon/item/china/weapon/sword_01.png')
    const potion = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_HP_POTION_01', [3, 3, 1, 1], { 14: '3', 57: '50', 118: '120', 120: '0', 122: '0', 124: '0' }))), ctx)
    expect(potion).toMatchObject({ category: 'potion', maxStack: 50, race: 'any', use: { hp: 120, cooldownGroup: 'hp' } })
    const scroll = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_SCROLL_RETURN_01', [3, 3, 3, 1], { 118: '30000', 120: '1', 122: '-1', 123: 'RESURRECT' }))), ctx)
    expect(scroll.use).toEqual({ returnToTown: true, castMs: 30000 })
    const def = buildItemDef(itemDataRow(row(itemCells('ITEM_CH_SWORD_01_A_DEF', [3, 1, 6, 2], { 17: '0', 20: '0' }))), { ...ctx, hasIcon: () => false })
    expect(def).toMatchObject({ canSell: false, canDrop: false, icon: null })
  })

  it('reads keepFee (col 30), repairCost (col 27), canRepair (col 22) and writes the 1000 ms potion/pill cooldown', () => {
    const ctx = { strings: new Map<string, string>(), exists: () => true, basicAttacks: new Map<number, string>() }
    const sword = buildItemDef(itemDataRow(row(itemCells('ITEM_CH_SWORD_01_A', [3, 1, 6, 2], { 22: '1', 27: '198', 30: '21' }))), ctx)
    expect(sword).toMatchObject({ keepFee: 21, repairCost: 198, canRepair: true })
    const ring = buildItemDef(itemDataRow(row(itemCells('ITEM_CH_RING_01_A', [3, 1, 5, 3], { 22: '0', 27: '0', 30: '5' }))), ctx)
    expect(ring).toMatchObject({ keepFee: 5, canRepair: false })
    expect(ring.repairCost).toBeUndefined()
    const potion = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_HP_POTION_01', [3, 3, 1, 1], { 14: '3', 118: '120', 120: '0', 122: '0', 124: '0' }))), ctx)
    expect(potion.use).toEqual({ hp: 120, cooldownGroup: 'hp', cooldownMs: 1000 })
    expect(potion.fieldSources?.['use.cooldownMs']).toBe('rule: POTION_COOLDOWN_MS (no client column)')
    expect(potion.keepFee).toBeUndefined()
    const pill = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_CURE_ALL_01', [3, 3, 2, 6], { 14: '3', 118: '36' }))), ctx)
    expect(pill).toMatchObject({ use: { cooldownGroup: 'cure', cooldownMs: 1000 }, cureLevel: 36 })
    const scroll = buildItemDef(itemDataRow(row(itemCells('ITEM_ETC_SCROLL_RETURN_01', [3, 3, 3, 1], { 118: '30000', 120: '1', 122: '-1', 123: 'RESURRECT' }))), ctx)
    expect(scroll.use?.cooldownMs).toBeUndefined()
  })

  it('references models only when converted and icons as PNG URLs', () => {
    expect(modelRef('mob\\china\\tiger.bsr', () => false)).toBeNull()
    expect(modelRef('mob\\china\\tiger.bsr', url => url === '/out/mob/china/tiger.glb')?.sidecar).toBe('/out/mob/china/tiger.json')
    expect(modelRef('npc\\x.cpd', () => true)).toBeNull()
    expect(iconUrl('Skill\\China\\Sword_Smash_A.ddj')).toBe('/out/icon/skill/china/sword_smash_a.png')
    expect(iconUrl(undefined)).toBeNull()
  })
})

describe('skills', () => {
  const detail = (activity: number, category: number, params: number[]) => ({ activity, category, params: parseSkillParams(params) }) as Parameters<typeof skillCategory>[0]
  it('categorizes and reads damage', () => {
    expect(skillCategory(detail(2, 0, [6386804, 5, 143, 15, 18, 143]))).toBe('melee')
    expect(skillCategory(detail(2, 1, [6386804, 6, 84, 0, 0, 84]))).toBe('ranged')
    expect(skillCategory(detail(1, 3, [1685418593, 5000, 6386804, 8, 100, 13, 19, 100]))).toBe('buff')
    expect(skillCategory(detail(2, 0, [1751474540, 369]))).toBe('buff') // 'heal'
    expect(skillCategory(detail(0, 4, []))).toBe('passive')
    expect(skillDamage(parseSkillParams([6386804, 5, 60, 0, 0, 60, 28003, 2, 2]))).toEqual({ physPct: 60, magPct: 0, flat: [0, 0], hits: 2 })
    expect(skillDamage(parseSkillParams([6386804, 10, 250, 62, 94, 83]))).toEqual({ physPct: 0, magPct: 250, flat: [62, 94], hits: 1 })
    expect(skillDamage(parseSkillParams([1751474540, 369]))).toBeUndefined()
  })

  it('reads the skillaniset2 section of skilleffect', () => {
    const t = [
      ['#section', 'characterInfo'],
      ['CHAR_CH_MAN_ADVENTURER', 'PCM_ADVENTURER'],
      ['#section', 'skillaniset2'],
      ['1', 'x', 'SKILL_CH_SWORD_SMASH_A', '0', 'FALSE', '0', 'SWORD', 'none', 'none', 'ANI_SKILL_1'],
      ['1', 'x', 'SKILL_CH_SWORD_BASE', '0', 'FALSE', '0', 'SWORD', 'none', 'none', 'ANI_ATTACK1,ANI_ATTACK2'],
      ['1', 'x', 'SKILL_CH_SWORD_SMASH_A', '0', 'FALSE', '0', 'BLADE', 'ANI_X', 'none', 'ANI_SKILL_9'],
      ['#section', 'skilleffectset'],
      ['x', 'SKILL_CH_OTHER', 'SHOT'],
    ]
    const a = skillAnimations(t)
    expect(a.get('SKILL_CH_SWORD_SMASH_A')).toEqual({ shot: 'SKILL_1' })
    expect(a.get('SKILL_CH_SWORD_BASE')).toEqual({ shot: 'ATTACK1,ATTACK2' })
    expect(a.has('SKILL_CH_OTHER')).toBe(false)
  })
})

describe('mobs', () => {
  it('borrows the base model for *_CLON rows (the _clon sibling when present) and finds champion looks', () => {
    const base = characterDataRow(row(charCells('MOB_CH_BIGEYEGHOST', 1935, [1, 2, 1, 1], { 52: 'mob\\china\\bigeyeghost.bsr' })))
    const clon = characterDataRow(row(charCells('MOB_CH_BIGEYEGHOST_CLON', 1934, [1, 2, 1, 1], { 4: 'MOB_CH_BIGEYEGHOST', 93: '1' })))
    const byCode = new Map<string, CharacterDataRow>([[base.codeName, base], [clon.codeName, clon]])
    const files = new Set(['res/mob/china/bigeyeghost.bsr', 'res/mob/china/bigeyeghost_clon.bsr', 'res/mob/china/bigeyeghost_champ.bsr'])
    expect(mobModelSource(clon, byCode, p => files.has(p)).assoc).toBe('mob\\china\\bigeyeghost_clon.bsr')
    expect(mobModelSource(clon, byCode, p => p === 'res/mob/china/bigeyeghost.bsr').assoc).toBe('mob\\china\\bigeyeghost.bsr')
    expect(mobModelSource(base, byCode, () => false).assoc).toBe('mob\\china\\bigeyeghost.bsr')
    expect(championModelSource('mob\\china\\bigeyeghost_clon.bsr', p => files.has(p))).toBe('mob\\china\\bigeyeghost_champ.bsr')
    expect(championModelSource('mob\\china\\tiger.bsr', () => false)).toBeUndefined()
  })

  it('aggressive from the nest tactics (aggressTypeRaw 0); a passive mob\'s champion is aggressive when the port links champion tactics', () => {
    const rows = [['MOB_CH_MANGNYANG', 1907], ['MOB_CH_GYO_CLON', 1913], ['MOB_CH_TIGER', 1925]] as const
    const byCode = new Map<string, CharacterDataRow>(rows.map(([code, id]) => [code, characterDataRow(row(charCells(code, id, [1, 2, 1, 1], { 52: 'mob\\china\\x.bsr' })))]))
    const portNest = (vsroCode: string, mobId: string, aggressTypeRaw: number): PortNest => ({
      nestId: 1, mobId, vsroCode, x: 0, z: 0, count: 1, radius: 75, spawnRadius: 60, tacticsId: 2, sightRangeU: 17.3, aggressTypeRaw, traceBoundaryU: 75, respawnDelaySec: [8, 12],
    })
    const ctx: MobContext = {
      byCode,
      skillsById: new Map(),
      strings: new Map(),
      exists: () => true,
      hasData: () => false,
      nests: [portNest('MOB_CH_MANGNYANG', 'mob_mangyang', 1), portNest('MOB_CH_GYO_CLON', 'mob_gyo_clon', 1), portNest('MOB_CH_TIGER', 'mob_tiger', 0)],
      portMobs: [{ id: 'mob_mangyang', combat: { championTacticsId: 1 } }, { id: 'mob_gyo_clon', combat: {} }, { id: 'mob_tiger' }],
    }
    const mang = buildMobDef('MOB_CH_MANGNYANG', ctx).mob
    expect(mang).toMatchObject({ aggressive: false, championAggressive: true })
    expect((mang.fieldSources as Record<string, string>).championAggressive).toMatch(/championTacticsId 1/)
    expect(buildMobDef('MOB_CH_GYO_CLON', ctx).mob).toMatchObject({ aggressive: false, championAggressive: false })
    const tiger = buildMobDef('MOB_CH_TIGER', ctx).mob
    expect(tiger.aggressive).toBe(true)
    expect('championAggressive' in tiger).toBe(false)
    for (const m of [mang, tiger]) expect(checkMobDef(m)).toEqual([])
  })
})

describe('nests', () => {
  const world: WorldFrame = { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([25258]) }
  const nest: PortNest = {
    nestId: 249, mobId: 'mob_mangyang', vsroCode: 'MOB_CH_MANGNYANG', x: 10201.9, z: 1786.93, y: 3.12, level: 1, count: 15, radius: 75, spawnRadius: 60,
    championPct: 10, respawn: 1, tacticsId: 2, sightRangeU: 17.3, aggressTypeRaw: 1, traceBoundaryU: 75, staminaRaw: 100, staminaVarPct: 50, respawnDelaySec: [8, 12],
  }
  it('converts a port nest into the world frame with metres and provenance', () => {
    const n = buildNest(nest, 'jangan_province', { scale: 1.5, offsetX: 0, offsetZ: 0 }, world, new Set())
    expect(n).toMatchObject({ id: 249, mob: 'MOB_CH_MANGNYANG', x: 465.267, z: -231.287, y: 2.08, region: 25258, radius: 50, spawnRadius: 40, count: 15, respawnSec: [8, 12], championPct: 10 })
    expect(n.tactics).toMatchObject({ id: 2, aggressive: false, sightRange: 11.533, leashRange: 50 })
    expect(n).toMatchObject({ world: 'jangan', provenance: PROVENANCE_PORT, enabled: true, inConvertedRegion: true, source: { file: 'spawns.json', zone: 'jangan_province', x: 10201.9, z: 1786.93, y: 3.12 } })
    expect(checkNestDef(n)).toEqual([])
    const other = buildNest({ ...nest, aggressTypeRaw: 0 }, 'donwhang_province', { scale: 1.5, offsetX: 0, offsetZ: 0 }, world, new Set(['MOB_CH_MANGNYANG']))
    expect(other).toMatchObject({ world: 'donwhang', enabled: false, uniqueGroup: 'MOB_CH_MANGNYANG', tactics: { aggressive: true } })
  })
})

describe('drops', () => {
  it('divides the port rates back out, takes gold amounts from levelgold and splits gendered armour', () => {
    const port = {
      rates: { goldRate: 30, itemDropRate: 2, rareDropRate: 1 },
      tables: [{
        mobId: 'mob_mangyang', vsroCode: 'MOB_CH_MANGNYANG', level: 1, gold: { chance: 0.7, min: 840, max: 1770 },
        items: [
          { itemId: 'hp_potion_01', qty: 1, chance: 0.02 },
          { itemId: 'clothes01_chest', qty: 1, chance: 0.001 },
          { itemId: 'eu_sword01', qty: 1, chance: 0.001 },
          { itemId: 'arrow_bundle', qty: 5, chance: 0.01 },
          { itemId: 'nope', qty: 1, chance: 0.5 },
        ],
      }],
    }
    const itemMap = {
      hp_potion_01: { code: 'ITEM_ETC_HP_POTION_01' },
      clothes01_chest: { code: 'ITEM_CH_M_CLOTHES_01_BA_A', codeW: 'ITEM_CH_W_CLOTHES_01_BA_A' },
      eu_sword01: { code: 'ITEM_EU_SWORD_01_A' },
      arrow_bundle: { code: 'ITEM_ETC_AMMO_ARROW_01' },
    }
    const items = new Set(['ITEM_ETC_HP_POTION_01', 'ITEM_CH_M_CLOTHES_01_BA_A', 'ITEM_CH_W_CLOTHES_01_BA_A', 'ITEM_ETC_AMMO_ARROW_01'])
    const r = buildDrops([{ code: 'MOB_CH_MANGNYANG', level: 1 }, { code: 'MOB_X', level: 2 }], port, itemMap, items, [{ level: 1, min: 28, max: 59 }])
    expect(r.missing).toEqual(['MOB_X'])
    expect(r.skipped).toEqual({ unmapped: 1, notExported: 1 })
    expect(r.goldCheck).toEqual({ equal: 1, differ: [] })
    const t = r.drops[0]!
    expect(t.gold).toEqual({ chance: 0.7, amount: [28, 59] })
    expect(t.groups).toEqual([
      { chance: 0.01, entries: [{ item: 'ITEM_ETC_HP_POTION_01', weight: 1 }] },
      { chance: 0.0005, entries: [{ item: 'ITEM_CH_M_CLOTHES_01_BA_A', weight: 1 }, { item: 'ITEM_CH_W_CLOTHES_01_BA_A', weight: 1 }] },
      { chance: 0.005, entries: [{ item: 'ITEM_ETC_AMMO_ARROW_01', weight: 1, count: [5, 5] }] },
    ])
    expect(t.provenance).toBe(PROVENANCE_PORT)
    expect(checkDropTable(t)).toEqual([])
  })
})

describe('npcs and shops', () => {
  const live = (...c: string[]) => ['1', '15', ...c]
  const tables = {
    refshopgroup: [live('981', 'GROUP_STORE_CH_POTION', 'NPC_CH_POTION')],
    refmappingshopgroup: [live('GROUP_STORE_CH_POTION', 'STORE_CH_POTION')],
    refmappingshopwithtab: [live('STORE_CH_POTION', 'STORE_CH_POTION_GROUP1')],
    refshoptab: [live('2414', 'STORE_CH_POTION_TAB1', 'STORE_CH_POTION_GROUP1', 'SN_TAB_POTION', 'xxx')],
    refshopgoods: [live('STORE_CH_POTION_TAB1', 'PACKAGE_ITEM_ETC_MP_POTION_01', '1'), live('STORE_CH_POTION_TAB1', 'PACKAGE_ITEM_ETC_HP_POTION_01', '0'), live('STORE_CH_POTION_TAB1', 'PACKAGE_ITEM_ETC_DETECT_01', '2')],
    refscrapofpackageitem: [live('PACKAGE_ITEM_ETC_HP_POTION_01', 'ITEM_ETC_HP_POTION_01'), live('PACKAGE_ITEM_ETC_MP_POTION_01', 'ITEM_ETC_MP_POTION_01'), live('PACKAGE_ITEM_ETC_DETECT_01', 'ITEM_ETC_DETECT_01')],
  }

  it('follows the refshop chain and places NPCs from npcpos in the world frame', () => {
    const chain = shopChain(tables)
    expect(chain.npcsByStore.get('STORE_CH_POTION')).toEqual(['NPC_CH_POTION'])
    const npc = characterDataRow(row(charCells('NPC_CH_POTION', 2005, [1, 2, 2, 0], { 52: 'npc\\npc\\chinashop_herbalistman.bsr' })))
    const world: WorldFrame = { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([25000]) }
    const regions = regionsOfContinent([['25000', '168', '97', 'CHINA', 'Town_Jangan'], ['26265', '153', '102', 'West_China', 'x']], 'CHINA')
    expect([...regions]).toEqual([25000])
    const r = buildNpcs(
      [{ refId: 2005, region: 25000, x: 1584.08, y: -0.5, z: 1407.29 }, { refId: 2005, region: 26265, x: 0, y: 0, z: 0 }],
      {
        byId: new Map([[2005, npc]]),
        strings: new Map([['SN_NPC_CH_POTION', 'Herbalist Yangyun'], ['SN_TAB_POTION', 'Potion']]),
        exists: () => true,
        world,
        regions,
        teleportsByNpc: new Map(),
        chain,
        itemCodes: new Set(['ITEM_ETC_HP_POTION_01', 'ITEM_ETC_MP_POTION_01']),
      },
    )
    expect(r.npcs).toHaveLength(1)
    expect(r.npcs[0]).toMatchObject({ code: 'NPC_CH_POTION', name: 'Herbalist Yangyun', x: 158.408, z: -140.729, y: -0.05, yaw: 0, shop: 'STORE_CH_POTION', roles: ['shop'], provenance: 'client', inConvertedRegion: true })
    expect(r.shops).toEqual([{ id: 'STORE_CH_POTION', npcs: ['NPC_CH_POTION'], tabs: [{ name: 'Potion', items: ['ITEM_ETC_HP_POTION_01', 'ITEM_ETC_MP_POTION_01'] }], provenance: 'client' }])
    expect(r.droppedGoods).toEqual({ STORE_CH_POTION: ['ITEM_ETC_DETECT_01'] })
    expect(r.models).toEqual(['res/npc/npc/chinashop_herbalistman.bsr'])
    expect(r.npcs[0]!.greeting).toBeUndefined()
  })

  it('resolves greetings through npcchat (the _BS id need not follow the NPC code) and keeps "..."', () => {
    const speech = new Map([
      ['SN_NPC_CH_POTION_BS', 'With consistent patients\\nwe run short.  '],
      ['SN_NPC_CH_WAREHOUSE_M_BS', '...'],
      ['SN_NPC_SD_ARENA_MANAGER_BS', ''],
      ['SN_NPC_ODD_BS', 'Should not be used'],
    ])
    const chat = [
      ['1', 'NPC_CH_POTION', 'SN_NPC_CH_POTION_BS', 'SN_NPC_CH_POTION_PS'],
      ['1', 'NPC_CH_WAREHOUSE_M', 'SN_NPC_CH_WAREHOUSE_M_BS', 'SN_NPC_CH_WAREHOUSE_M_PS'],
      ['1', 'NPC_BATTLE_ARENA_MANAGER', 'SN_NPC_SD_ARENA_MANAGER_BS', 'SN_NPC_SD_ARENA_MANAGER_PS'],
      ['0', 'NPC_CH_SMITH', 'SN_NPC_ODD_BS', 'xxx'],
      ['1', 'NPC_CH_POTION', 'SN_NPC_ODD_BS', 'xxx'],
    ]
    const greetings = npcGreetings(chat, speech)
    expect(Object.fromEntries(greetings)).toEqual({ NPC_CH_POTION: 'With consistent patients\nwe run short.', NPC_CH_WAREHOUSE_M: '...' })
    const strings = new Map([['SN_NPC_CH_POTION', 'Herbalist Yangyun'], ...[...greetings].map(([k, v]) => [npcGreetingKey(k), v] as [string, string])])
    const npc = characterDataRow(row(charCells('NPC_CH_POTION', 2005, [1, 2, 2, 0])))
    const r = buildNpcs([{ refId: 2005, region: 25000, x: 0, y: 0, z: 0 }], {
      byId: new Map([[2005, npc]]),
      strings,
      exists: () => true,
      world: { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([25000]) },
      regions: new Set([25000]),
      teleportsByNpc: new Map(),
      chain: shopChain({ refshopgroup: [], refmappingshopgroup: [], refmappingshopwithtab: [], refshoptab: [], refshopgoods: [], refscrapofpackageitem: [] }),
      itemCodes: new Set(),
    })
    expect(r.npcs[0]!.greeting).toBe('With consistent patients\nwe run short.')
  })
})

describe('NPC facing (port placements -> yaw)', () => {
  const world: WorldFrame = { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([25000]) }
  const keeper = (code: string, id: number) => characterDataRow(row(charCells(code, id, [1, 2, 2, 0])))
  // npcpos.txt: Wangu and Sansan 4.5 cm apart at the storage fountain; the port's zones.jangan_province.npcs faces
  // them differently (rotY -0.4 and -0.017); a gate soldier only in teleporters.json (no code on the record).
  const npcPos = [
    { refId: 1, region: 25000, x: 980.8, y: 0, z: 989.13 },
    { refId: 2, region: 25000, x: 980.35, y: 0, z: 989.19 },
    { refId: 3, region: 25000, x: 1900, y: 0, z: 1500 },
  ]
  const ctx = {
    byId: new Map([[1, keeper('NPC_CH_WAREHOUSE_M', 1)], [2, keeper('NPC_CH_WAREHOUSE_W', 2)], [3, keeper('NPC_CH_SOLDIER_EA2', 3)]]),
    strings: new Map<string, string>(),
    exists: () => true,
    world,
    regions: new Set([25000]),
    teleportsByNpc: new Map(),
    chain: shopChain({ refshopgroup: [], refmappingshopgroup: [], refmappingshopwithtab: [], refshoptab: [], refshopgoods: [], refscrapofpackageitem: [] }),
    itemCodes: new Set<string>(),
    portFrame: { scale: 1.5, offsetX: 0, offsetZ: 0 },
  }
  // port = 1.5 x game metres; game X = 192 (168 - 135) + lx / 10, Y = 192 (97 - 92) + lz / 10.
  const portAt = (lx: number, lz: number) => ({ x: 1.5 * (6336 + lx / 10), z: 1.5 * (960 + lz / 10) })

  it('reads zones.<province>.npcs, matches by code first, and turns rotY into yaw = pi - rotY', () => {
    const port = {
      shops: [{ id: 'npc_ch_warehouse', sroCode: 'NPC_CH_WAREHOUSE_M' }],
      zoneNpcs: {
        jangan_province: [
          // Sansan's record first and nearest to Wangu too: position alone would give Wangu her facing.
          { npcId: 'npc_ch_warehouse_w', ...portAt(980.7, 989.15), rotY: -0.017 },
          { npcId: 'npc_ch_warehouse', ...portAt(983.8, 989.13), rotY: -0.4 },
        ],
        zone_city: [{ npcId: 'npc_ch_warehouse', ...portAt(980.8, 989.13), rotY: 2 }],
      },
      teleporters: { jangan_province: [{ id: 'gate_npc_ch_soldier_ea2', ...portAt(1900.3, 1500), rotY: Math.PI / 2 }] },
    }
    const r = buildNpcs(npcPos, { ...ctx, port })
    const yaw = (code: string) => r.npcs.find(n => n.code === code)!.yaw
    // Wangu: rotY -0.4 -> pi + 0.4 -> -2.742 (faces north, slightly west: his chest is behind him, to the south).
    expect(yaw('NPC_CH_WAREHOUSE_M')).toBeCloseTo(-2.742, 3)
    // Sansan: rotY -0.017 -> -3.125 (north).
    expect(yaw('NPC_CH_WAREHOUSE_W')).toBeCloseTo(-3.125, 3)
    // A code-less teleporter record within 1 m: rotY pi/2 (port east) stays east (+x), yaw pi/2.
    expect(yaw('NPC_CH_SOLDIER_EA2')).toBeCloseTo(Math.PI / 2, 3)
    expect(r.npcs.find(n => n.code === 'NPC_CH_WAREHOUSE_M')!.fieldSources).toMatchObject({ yaw: expect.stringContaining('zones.jangan_province npc_ch_warehouse rotY -0.4') })
  })

  it('matchFacing skips a nearer record that names another placed NPC, and keeps 0 when nothing is within 1 m', () => {
    const placed = new Set(['A', 'B'])
    const recs = [
      { x: 0.01, z: 0, rotY: 1, label: 'b', code: 'B' },
      { x: 0.5, z: 0, rotY: 2, label: 'unnamed' },
      { x: 1.5, z: 0, rotY: 3, label: 'a', code: 'A' },
    ]
    expect(matchFacing(recs, 'A', { x: 0, z: 0 }, placed)?.label).toBe('a')
    expect(matchFacing(recs.slice(0, 2), 'A', { x: 0, z: 0 }, placed)?.label).toBe('unnamed')
    // A record naming a code nobody places (the port's own npcId spelling) still counts by position.
    expect(matchFacing([{ x: 0.2, z: 0, rotY: 1, label: 'x', code: 'NPC_UNKNOWN' }], 'A', { x: 0, z: 0 }, placed)?.label).toBe('x')
    expect(matchFacing([{ x: 1.2, z: 0, rotY: 1, label: 'far' }], 'A', { x: 0, z: 0 }, placed)).toBeUndefined()
    const r = buildNpcs(npcPos.slice(0, 1), { ...ctx, port: { shops: [], teleporters: {} } })
    expect(r.npcs[0]).toMatchObject({ yaw: 0, fieldSources: { yaw: expect.stringMatching(/^default 0/) } })
  })
})
