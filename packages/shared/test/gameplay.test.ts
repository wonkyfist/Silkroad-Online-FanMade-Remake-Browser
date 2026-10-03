import { describe, expect, it } from 'vitest'
import {
  CLIENT_RATE_LIMITS,
  CONTENT_SCHEMA_VERSION,
  EQUIP_SLOTS,
  GAMEPLAY_REQUESTS,
  MAX_BAG_SIZE,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_COMBAT_HITS,
  MAX_ITEM_COUNT,
  PLAYER_STAT_KEYS,
  PROVENANCE_PORT,
  checkContentFile,
  checkDropTable,
  checkItemDef,
  checkMobDef,
  checkNestDef,
  contentEntries,
  equipSlotsFor,
  isPlayerEntity,
  parseClientMessage,
  parseServerMessage,
  utf8Length,
  type ClientMessage,
  type DropTable,
  type EntityState,
  type Inventory,
  type ItemDef,
  type MobDef,
  type NestDef,
  type PlayerStats,
  type ServerMessage,
} from '../src/index.ts'

const client = (v: unknown) => parseClientMessage(JSON.stringify(v))
const server = (v: unknown) => parseServerMessage(JSON.stringify(v))

describe('gameplay client messages', () => {
  it('accepts every well-formed request, with and without optional keys', () => {
    const good: ClientMessage[] = [
      { t: 'attack', target: 12 },
      { t: 'stopAction' },
      { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01' },
      { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: 5 },
      { t: 'pickup', id: 99 },
      { t: 'respawn' },
      { t: 'statUp', stat: 'str', points: 3 },
      { t: 'statUp', stat: 'int', points: 1 },
      { t: 'itemMove', from: 0, to: 47 },
      { t: 'itemSplit', from: 3, to: 4, count: 10 },
      { t: 'itemEquip', bag: 2 },
      { t: 'itemEquip', bag: 2, slot: 'ring2' },
      { t: 'itemUnequip', slot: 'weapon' },
      { t: 'itemUnequip', slot: 'weapon', bag: 13 },
      { t: 'itemUse', bag: 5 },
      { t: 'itemDrop', bag: 5 },
      { t: 'itemDrop', bag: 5, count: 2 },
      { t: 'shopBuy', npc: 7, item: 'ITEM_ETC_HP_POTION_01', count: 50 },
      { t: 'shopSell', npc: 7, bag: 9 },
      { t: 'shopSell', npc: 7, bag: 9, count: 1 },
    ]
    for (const m of good) expect(client(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
  })

  it('rejects bad values, missing and unexpected keys', () => {
    const bad = [
      { t: 'attack' },
      { t: 'attack', target: -1 },
      { t: 'attack', target: 1.5 },
      { t: 'attack', target: '3' },
      { t: 'attack', target: 1, x: 2 },
      { t: 'stopAction', now: true },
      { t: 'useSkill', skill: 'skill_lower' },
      { t: 'useSkill', skill: '' },
      { t: 'useSkill', skill: 'A'.repeat(129) },
      { t: 'useSkill', skill: 'SKILL_X', target: null },
      { t: 'pickup', id: Number.MAX_SAFE_INTEGER + 2 },
      { t: 'respawn', mode: 'here' },
      { t: 'statUp', stat: 'dex', points: 1 },
      { t: 'statUp', stat: 'str', points: 0 },
      { t: 'statUp', stat: 'str', points: 1001 },
      { t: 'itemMove', from: 0, to: MAX_BAG_SIZE },
      { t: 'itemMove', from: -1, to: 0 },
      { t: 'itemSplit', from: 0, to: 1, count: 0 },
      { t: 'itemSplit', from: 0, to: 1, count: MAX_ITEM_COUNT + 1 },
      { t: 'itemSplit', from: 0, to: 1 },
      { t: 'itemEquip', bag: 0, slot: 'ring' },
      { t: 'itemEquip', bag: 0, slot: 'cape' },
      { t: 'itemUnequip', slot: 'ring3' },
      { t: 'itemUnequip', slot: 'head', bag: 200 },
      { t: 'itemUse', bag: '1' },
      { t: 'itemDrop', bag: 1, count: -3 },
      { t: 'shopBuy', npc: 1, item: 'ITEM_X', count: 0 },
      { t: 'shopBuy', npc: 1, item: 'item x', count: 1 },
      { t: 'shopBuy', npc: 1, count: 1 },
      { t: 'shopSell', npc: 1, bag: 1, count: 1, price: 0 },
    ]
    for (const m of bad) expect(client(m).ok, JSON.stringify(m)).toBe(false)
  })

  it('fits every request in one frame', () => {
    const biggest: ClientMessage = { t: 'shopBuy', npc: Number.MAX_SAFE_INTEGER, item: 'A'.repeat(128), count: MAX_ITEM_COUNT }
    expect(utf8Length(JSON.stringify(biggest))).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES)
  })

  it('has a rate limit for every gameplay request', () => {
    for (const r of GAMEPLAY_REQUESTS) {
      const p = client({ t: r })
      expect(p.ok ? '' : p.error, r).not.toBe('unknown message type')
      expect(CLIENT_RATE_LIMITS[r], r).toBeDefined()
    }
  })
})

const player: EntityState = { id: 1, kind: 'player', name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', level: 3, weapon: 'blade', pos: [1, 2, 3], yaw: 0 }
const mob: EntityState = {
  id: 2, kind: 'mob', name: 'Mangnyang', model: 'MOB_CH_MANGNYANG', level: 1, pos: [4, 0, 5], yaw: 1,
  hp: 54, maxHp: 54, state: 'alive', variant: 'champion',
  move: { from: [4, 0, 5], to: [6, 0, 5], speed: 3.3, startedAt: 1000 },
}
const npc: EntityState = { id: 3, kind: 'npc', name: 'Herbalist', model: 'NPC_CH_POTION', level: 0, pos: [0, 0, 0], yaw: 0 }
const loot: EntityState = {
  id: 4, kind: 'item', name: 'Gold', model: 'ITEM_ETC_GOLD_01', level: 0, pos: [4, 0, 5], yaw: 0,
  count: 37, owner: 1, ownerUntil: 31000, expiresAt: 121000,
}

const stats: PlayerStats = {
  level: 5, exp: 100, expToNext: 2938, sp: 12, spExp: 150, hp: 300, maxHp: 320, mp: 280, maxMp: 300, str: 24, int: 24,
  statPoints: 12, gold: 1500, physAttack: [10, 14], magAttack: [8, 12], physDefence: 12, magDefence: 9, hitRate: 30, parryRate: 28,
}

const inv: Inventory = {
  bagSize: 3,
  bag: [{ code: 'ITEM_ETC_HP_POTION_01', count: 20 }, null, { code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 2, durability: 30 }],
  equip: { weapon: { code: 'ITEM_CH_BLADE_01_A_DEF', count: 1 }, ring1: { code: 'ITEM_CH_RING_01_A', count: 1 } },
  gold: 1500,
}

describe('gameplay server messages', () => {
  it('parses every new message', () => {
    const good: ServerMessage[] = [
      { t: 'spawn', entity: mob },
      { t: 'spawn', entity: npc },
      { t: 'spawn', entity: loot },
      { t: 'spawn', entity: { ...player, hp: 300, maxHp: 320, state: 'dead', equip: { weapon: 'ITEM_CH_BLADE_01_A_DEF', chest: 'ITEM_CH_M_HEAVY_01_BA_A' } } },
      { t: 'worldEnter', self: player, world: { name: 'jangan', serverTime: 1, tickRate: 10 }, entities: [mob, npc, loot] },
      { t: 'entityUpdate', id: 2, hp: 0, state: 'dead' },
      { t: 'entityUpdate', id: 1, hp: 320, maxHp: 340, state: 'alive', level: 6 },
      { t: 'actionResult', re: 'attack', ok: true },
      { t: 'actionResult', re: 'useSkill', ok: false, reason: 'not_implemented', message: 'Skills arrive later.' },
      { t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'hit', damage: 20, hp: 34 }, { outcome: 'crit', damage: 40, hp: 0 }], killed: true },
      { t: 'combat', attacker: 2, target: 1, skill: 'MSKILL_MANGNYANG_BASE', hits: [{ outcome: 'miss', damage: 0, hp: 300 }] },
      { t: 'stats', stats },
      { t: 'statsDelta', stats: { exp: 124, sp: 12 }, gain: { exp: 24, spExp: 24, from: 2 } },
      { t: 'statsDelta', stats: { hp: 10 } },
      { t: 'levelUp', id: 1, level: 6 },
      { t: 'inventory', inventory: inv },
      { t: 'inventoryUpdate', bag: [{ slot: 1, item: { code: 'ITEM_ETC_GOLD_01', count: 1 } }, { slot: 0, item: null }], equip: [{ slot: 'weapon', item: null }], gold: 1537 },
      { t: 'inventoryUpdate', gold: 0 },
      { t: 'appearance', id: 1, equip: { weapon: 'ITEM_CH_SWORD_01_A' } },
    ]
    for (const m of good) expect(server(m), m.t).toEqual({ ok: true, msg: m })
  })

  it('keeps accepting what older servers send', () => {
    const m: ServerMessage = { t: 'spawn', entity: player }
    expect(server(m)).toEqual({ ok: true, msg: m })
    expect(server({ t: 'entityUpdate', id: 1, invisible: true })).toEqual({ ok: true, msg: { t: 'entityUpdate', id: 1, invisible: true } })
  })

  it('requires the weapon of a player but not of other kinds', () => {
    const { weapon: _, ...noWeapon } = player
    expect(server({ t: 'spawn', entity: noWeapon }).ok).toBe(false)
    expect(server({ t: 'spawn', entity: { ...mob, weapon: 'bow' } }).ok).toBe(true)
    expect(server({ t: 'spawn', entity: { ...mob, weapon: 'axe' } }).ok).toBe(false)
    expect(isPlayerEntity(player)).toBe(true)
    expect(isPlayerEntity(mob)).toBe(false)
  })

  it('rejects bad known fields', () => {
    const bad = [
      { t: 'spawn', entity: { ...mob, kind: 'pet' } },
      { t: 'spawn', entity: { ...mob, hp: -1 } },
      { t: 'spawn', entity: { ...mob, state: 'sleeping' } },
      { t: 'spawn', entity: { ...mob, variant: 'boss' } },
      { t: 'spawn', entity: { ...loot, count: 1.5 } },
      { t: 'spawn', entity: { ...player, equip: { weapon: 5 } } },
      { t: 'entityUpdate', id: 1, state: 'zombie' },
      { t: 'actionResult', re: 'moveTo', ok: false },
      { t: 'actionResult', re: 'attack', ok: false, reason: 'because' },
      { t: 'combat', attacker: 1, target: 2, hits: [] },
      { t: 'combat', attacker: 1, target: 2, hits: Array.from({ length: MAX_COMBAT_HITS + 1 }, () => ({ outcome: 'hit', damage: 1, hp: 1 })) },
      { t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'graze', damage: 1, hp: 1 }] },
      { t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'hit', damage: -1, hp: 1 }] },
      { t: 'stats', stats: { ...stats, gold: undefined } },
      { t: 'stats', stats: { ...stats, physAttack: 5 } },
      { t: 'statsDelta', stats: { exp: 'lots' } },
      { t: 'inventory', inventory: { ...inv, bagSize: 4 } },
      { t: 'inventory', inventory: { ...inv, bag: [{ code: 'X', count: 0 }, null, null] } },
      { t: 'inventory', inventory: { ...inv, bagSize: MAX_BAG_SIZE + 1 } },
      { t: 'inventoryUpdate', bag: [{ slot: MAX_BAG_SIZE, item: null }] },
      { t: 'inventoryUpdate', equip: [{ slot: 'ring', item: null }] },
      { t: 'levelUp', id: 1 },
    ]
    for (const m of bad) expect(server(m).ok, JSON.stringify(m)).toBe(false)
  })

  it('drops unknown keys (additive changes stay compatible)', () => {
    const r = server({ t: 'statsDelta', stats: { exp: 1, luck: 7 }, extra: 1 })
    expect(r).toEqual({ ok: true, msg: { t: 'statsDelta', stats: { exp: 1 } } })
    const e = server({ t: 'spawn', entity: { ...mob, mood: 'angry' } })
    expect(e.ok && e.msg.t === 'spawn' && 'mood' in e.msg.entity).toBe(false)
  })

  it('PLAYER_STAT_KEYS matches PlayerStats', () => {
    expect([...PLAYER_STAT_KEYS].sort()).toEqual(Object.keys(stats).sort())
  })
})

describe('content contracts', () => {
  const mobDef: MobDef = {
    code: 'MOB_CH_MANGNYANG', id: 1954, name: 'Mangnyang', typeId: [1, 2, 1, 0], rarity: 'normal', level: 1, hp: 54, mp: 0,
    physAttack: [17, 19], magAttack: [0, 0], physDefence: 7, magDefence: 10, hitRate: 27, parryRate: 27,
    attackRange: 0.6, attackIntervalMs: 3000, radius: 0.5, walkSpeed: 1.6, runSpeed: 5, aggressive: false, exp: 24, scale: 100,
    model: { bsr: 'res/mob/china/mangnyang.bsr', glb: '/out/mob/china/mangnyang.glb', sidecar: '/out/mob/china/mangnyang.json' },
  }
  const nest: NestDef = {
    id: 249, mob: 'MOB_CH_MANGNYANG', x: 100, z: -50, radius: 7.5, spawnRadius: 6, count: 15, respawnSec: [8, 12], championPct: 10,
    tactics: { id: 2, aggressive: false, sightRange: 1.7, leashRange: 7.5 }, world: 'jangan', provenance: PROVENANCE_PORT,
    source: { file: 'spawns.json', zone: 'jangan_province', x: 10201.9, z: 1786.93, y: 3.12 },
  }
  const item: ItemDef = {
    code: 'ITEM_CH_SWORD_01_A', id: 3633, name: 'Copper Sword', typeId: [3, 1, 6, 2], category: 'weapon', slot: 'weapon', weaponType: 'sword',
    degree: 1, reqLevel: 1, reqGender: 'any', race: 'china', maxStack: 1, price: 100, sellPrice: 20, model: null, icon: null,
  }
  const drop: DropTable = {
    mob: 'MOB_CH_MANGNYANG', gold: { chance: 0.6, amount: [5, 12] },
    groups: [{ chance: 0.1, entries: [{ item: 'ITEM_ETC_HP_POTION_01', weight: 3, count: [1, 2] }, { item: 'ITEM_CH_SWORD_01_A', weight: 1 }] }],
    provenance: PROVENANCE_PORT,
  }

  it('checks well-formed records clean', () => {
    expect(checkMobDef(mobDef)).toEqual([])
    expect(checkNestDef(nest)).toEqual([])
    expect(checkItemDef(item)).toEqual([])
    expect(checkDropTable(drop)).toEqual([])
  })

  it('reports broken records', () => {
    expect(checkMobDef({ ...mobDef, code: 'mob lower', physAttack: [5, 1], hp: -1 })).toHaveLength(3)
    expect(checkNestDef({ ...nest, provenance: 'client', count: 0, tactics: undefined })).toHaveLength(3)
    expect(checkItemDef({ ...item, slot: undefined })).toHaveLength(1)
    expect(checkDropTable({ ...drop, groups: [{ chance: 1, entries: [{ item: 'X', weight: -1 }] }] })).toHaveLength(1)
  })

  it('reads wrapped and bare content files', () => {
    const file = { schema: CONTENT_SCHEMA_VERSION, kind: 'mobs', generatedAt: '2026-09-27T00:00:00Z', sources: ['client:characterdata.txt'], entries: [mobDef] }
    expect(contentEntries(file, 'mobs')).toEqual([mobDef])
    expect(() => contentEntries(file, 'items')).toThrow()
    expect(() => contentEntries({ ...file, schema: 99 })).toThrow()
    expect(contentEntries([{ level: 1, exp: 118, masterySp: 1 }])).toHaveLength(1)
    expect(checkContentFile('mobs', file)).toEqual([])
    expect(checkContentFile('levels', [{ level: 1, exp: 118, masterySp: 1 }, { level: 0 }])).toHaveLength(3)
    expect(checkContentFile('nests', { nope: true })).toHaveLength(1)
  })

  it('maps item slot kinds to equip slots', () => {
    expect(equipSlotsFor('ring')).toEqual(['ring1', 'ring2'])
    expect(equipSlotsFor('head')).toEqual(['head'])
    expect(EQUIP_SLOTS).toHaveLength(12)
  })
})
