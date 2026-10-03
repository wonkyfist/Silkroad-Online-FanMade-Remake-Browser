/**
 * Repair at the Blacksmith and the Protector Trader (docs/SYSTEMS_COMBAT.md §3.3; lane DR): the service check, the
 * validation order, the price ceil(repairCost × missing / max), all-or-nothing gold, the message order, a broken worn
 * item coming back (stats), duplicate refs, and the D47 regression (storage and buyback keep durability).
 * Synthetic NPC world with a controlled clock (npc-harness.ts); the numbers are the Copper Sword's (76, 198).
 */
import type { EquipSlot, ItemDef, NpcDef, RepairRef, ServerMessage, ShopDef } from '@sro/shared'
import { parseClientMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { isRepairable, maxDurability, repairPrice } from '../src/durability.ts'
import { GameData } from '../src/gamedata.ts'
import type { InvItem } from '../src/inventory.ts'
import { REPAIR_GOLD_TEXT, UNREPAIRABLE_TEXT } from '../src/repair.ts'
import type { Player } from '../src/world.ts'
import { ITEMS, LEVELS, MANGNYANG, item } from './fixtures.ts'
import { npcHarness, type Msg, type NpcHarness } from './npc-harness.ts'

export const SWORD = item('ITEM_CH_SWORD_01_A', { category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 1, reqLevel: 1, race: 'china', typeId: [3, 1, 6, 2], range: 1.5, price: 890, sellPrice: 100, canRepair: true, repairCost: 198, stats: { physAttack: [30, 36], durability: [62, 76] } })
export const SHIELD = item('ITEM_CH_SHIELD_01_A', { category: 'shield', slot: 'shield', reqLevel: 1, race: 'china', canRepair: true, repairCost: 110, stats: { blockRate: [10, 10], physDefence: [3, 3], durability: [46, 56] } })
export const CHEST = item('ITEM_CH_M_HEAVY_01_BA_A', { category: 'armor', slot: 'chest', armorType: 'heavy', reqLevel: 1, reqGender: 'male', race: 'china', canRepair: true, repairCost: 116, stats: { physDefence: [8, 8], durability: [48, 59] } })
export const RING = item('ITEM_CH_RING_01_A', { category: 'accessory', slot: 'ring', reqLevel: 1, race: 'china', canRepair: false })

const DUR_ITEMS: ItemDef[] = [...ITEMS.filter((i) => ![SWORD.code, SHIELD.code, RING.code].includes(i.code)), SWORD, SHIELD, CHEST, RING]
const npc = (code: string, x: number, z: number, over: Partial<NpcDef> = {}): NpcDef => ({ code, name: code, x, z, yaw: 0, world: 'jangan', model: null, provenance: 'client', ...over })
const NPCS: NpcDef[] = [
  npc('NPC_CH_SMITH', 20, 0, { name: 'Blacksmith Chulsan', shop: 'STORE_CH_SMITH', roles: ['shop', 'repair'] }),
  npc('NPC_CH_ARMOR', 20, 40, { name: 'Protector Trader Mrs Jang', shop: 'STORE_CH_ARMOR', roles: ['shop', 'repair'] }),
  npc('NPC_CH_WAREHOUSE_W', -40, 0, { roles: ['storage'] }),
  npc('NPC_CH_POTION', 60, 0, { shop: 'STORE_CH_POTION' }),
]
const SHOPS: ShopDef[] = [
  { id: 'STORE_CH_SMITH', npcs: ['NPC_CH_SMITH'], tabs: [{ name: 'Sword', items: [SWORD.code, SHIELD.code] }], provenance: 'client' },
  { id: 'STORE_CH_ARMOR', npcs: ['NPC_CH_ARMOR'], tabs: [{ name: 'Armor', items: [CHEST.code] }], provenance: 'client' },
  { id: 'STORE_CH_POTION', npcs: ['NPC_CH_POTION'], tabs: [{ name: 'Potion', items: ['ITEM_ETC_HP_POTION_01'] }], provenance: 'client' },
]

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})
function setup() {
  const data = new GameData({ mobs: [MANGNYANG], items: DUR_ITEMS, levels: LEVELS, drops: [], npcs: NPCS, shops: SHOPS, towns: [] })
  const h = npcHarness({ data, npcs: NPCS })
  harnesses.push(h)
  return h
}

const AT_SMITH: [number, number, number] = [23, 0, 0]

/** Puts `code` in an equipment slot at `durability` (null = full) and refreshes the player like a real equip. */
function wear(h: NpcHarness, p: Player, slot: EquipSlot, code: string, durability: number | null) {
  const { draft } = h.store.inventoryTx(p.characterId, (d) => {
    d.setEquip(slot, { code, count: 1, plus: 0, durability })
    return { ok: true, value: undefined }
  })
  h.gameplay.afterInventory(p, draft)
}
const equipOf = (h: NpcHarness, p: Player, slot: EquipSlot): InvItem | undefined => h.store.loadInventory(p.characterId).equip[slot]
const repair = (h: NpcHarness, p: Player, inbox: ServerMessage[], items?: RepairRef[]) => {
  const smith = h.npcByCode('NPC_CH_SMITH')
  return h.req(p, inbox, items ? { t: 'repair', npc: smith.id, items } : { t: 'repair', npc: smith.id })
}

describe('repair pricing (durability.ts)', () => {
  it('ceil(repairCost × missing / max): a broken Copper Sword 198, 70/76 costs 16, full costs 0', () => {
    expect(maxDurability(SWORD)).toBe(76)
    expect(repairPrice(SWORD, { durability: 0 })).toBe(198)
    expect(repairPrice(SWORD, { durability: 70 })).toBe(16)
    expect(repairPrice(SWORD, { durability: 75 })).toBe(3)
    expect(repairPrice(SWORD, {})).toBe(0)
    expect(repairPrice(SWORD, { durability: null })).toBe(0)
    expect(isRepairable(SWORD)).toBe(true)
    expect(isRepairable(RING)).toBe(false)
    expect(isRepairable(item('X', { repairCost: 10 }))).toBe(false) // no roll
  })
})

describe('repair requests (repair.ts)', () => {
  it('the Smith and Mrs Jang offer repair; the Storage-keeper and the potion merchant do not', () => {
    const h = setup()
    const { p, inbox } = h.enter(AT_SMITH)
    const smith = h.npcByCode('NPC_CH_SMITH')
    h.req(p, inbox, { t: 'npcTalk', npc: smith.id })
    expect(h.of(inbox, 'npcDialog').at(-1)?.services).toContain('repair')
    for (const code of ['NPC_CH_WAREHOUSE_W', 'NPC_CH_POTION']) {
      const n = h.npcByCode(code)
      const q = h.enter([n.x + 2, 0, n.z], 1000)
      wear(h, q.p, 'weapon', SWORD.code, 10)
      expect(h.req(q.p, q.inbox, { t: 'repair', npc: n.id })).toMatchObject({ ok: false, reason: 'not_found' })
    }
    const armor = h.npcByCode('NPC_CH_ARMOR')
    const r = h.enter([armor.x + 2, 0, armor.z], 1000)
    wear(h, r.p, 'weapon', SWORD.code, 10)
    // Mrs Jang repairs every item, a sword too.
    expect(h.req(r.p, r.inbox, { t: 'repair', npc: armor.id })).toMatchObject({ ok: true })
  })

  it('repair all at Chulsan: sum of ceil(198 × missing / 76) and the others, then ok → inventoryUpdate → statsDelta → stats', () => {
    const h = setup()
    const { p, inbox } = h.enter(AT_SMITH, 5000)
    wear(h, p, 'weapon', SWORD.code, 70) // 16
    wear(h, p, 'shield', SHIELD.code, 28) // ceil(110 × 28 / 56) = 55
    wear(h, p, 'chest', CHEST.code, null) // full: nothing
    const bag = h.give(p, SWORD.code, 1, { durability: 0 }) // 198
    const ring = h.give(p, RING.code) // not repairable: skipped in repair all
    const total = 16 + 55 + 198
    const from = inbox.length
    expect(repair(h, p, inbox)).toMatchObject({ ok: true })
    const out = inbox.slice(from)
    expect(out.map((m) => m.t)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta', 'stats'])
    const up = out[1] as Msg<'inventoryUpdate'>
    expect(up.gold).toBe(5000 - total)
    expect(up.bag).toEqual([{ slot: bag, item: { code: SWORD.code, count: 1 } }])
    expect(up.equip?.map((e) => e.slot).sort()).toEqual(['shield', 'weapon'])
    expect(up.equip?.every((e) => e.item && e.item.durability === undefined)).toBe(true)
    expect(p.gold).toBe(5000 - total)
    expect(equipOf(h, p, 'weapon')?.durability).toBeNull()
    expect(equipOf(h, p, 'shield')?.durability).toBeNull()
    expect(h.bag(p)[bag]?.durability).toBeNull()
    expect(h.bag(p)[ring]?.code).toBe(RING.code)
    expect(h.store.loadInventory(p.characterId).gold).toBe(5000 - total)
    // Everything is full now.
    expect(repair(h, p, inbox)).toMatchObject({ ok: false, reason: 'nothing_to_repair' })
  })

  it('a broken worn weapon comes back: its attack returns in stats', () => {
    const h = setup()
    const { p, inbox } = h.enter(AT_SMITH, 1000)
    wear(h, p, 'weapon', SWORD.code, 0)
    const broken = p.combat.physAttack[1]
    expect(repair(h, p, inbox, [{ equip: 'weapon' }])).toMatchObject({ ok: true })
    const stats = h.of(inbox, 'stats').at(-1)!
    expect(stats.stats.physAttack[1]).toBeGreaterThan(broken)
    expect(p.gold).toBe(1000 - 198)
  })

  it('a single ref repairs only that item; a ref named twice is paid once', () => {
    const h = setup()
    const { p, inbox } = h.enter(AT_SMITH, 1000)
    wear(h, p, 'weapon', SWORD.code, 70)
    const bag = h.give(p, SWORD.code, 1, { durability: 38 }) // ceil(198 × 38 / 76) = 99
    expect(repair(h, p, inbox, [{ bag }, { bag }])).toMatchObject({ ok: true })
    expect(p.gold).toBe(1000 - 99)
    expect(h.bag(p)[bag]?.durability).toBeNull()
    expect(equipOf(h, p, 'weapon')?.durability).toBe(70)
    const up = h.of(inbox, 'inventoryUpdate').at(-1)!
    expect(up.equip).toBeUndefined()
    expect(h.of(inbox, 'stats').length).toBeGreaterThan(0)
  })

  it('validation order: invalid_slot, then not_usable, then nothing_to_repair, then not_enough_gold (nothing changes)', () => {
    const h = setup()
    const { p, inbox } = h.enter(AT_SMITH, 100)
    wear(h, p, 'weapon', SWORD.code, 0)
    const ring = h.give(p, RING.code)
    expect(repair(h, p, inbox, [{ bag: 30 }])).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(repair(h, p, inbox, [{ equip: 'shield' }])).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(repair(h, p, inbox, [{ bag: ring }, { equip: 'weapon' }])).toMatchObject({ ok: false, reason: 'not_usable', message: UNREPAIRABLE_TEXT })
    const before = h.store.loadInventory(p.characterId)
    const from = inbox.length
    expect(repair(h, p, inbox, [{ equip: 'weapon' }])).toMatchObject({ ok: false, reason: 'not_enough_gold', message: REPAIR_GOLD_TEXT })
    expect(repair(h, p, inbox)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(inbox.slice(from).map((m) => m.t)).toEqual(['actionResult', 'actionResult'])
    expect(h.store.loadInventory(p.characterId)).toEqual(before)
    expect(p.gold).toBe(100)
  })

  it('a ring alone → nothing_to_repair (repair all); a full item alone → nothing_to_repair', () => {
    const h = setup()
    const { p, inbox } = h.enter(AT_SMITH, 1000)
    // The starter kit has no durability rolls in these fixtures except what we wear.
    h.store.inventoryTx(p.characterId, (d) => {
      for (const s of Object.keys(d.equip) as EquipSlot[]) d.setEquip(s, null)
      return { ok: true, value: undefined }
    })
    wear(h, p, 'ring1', RING.code, null)
    expect(repair(h, p, inbox)).toMatchObject({ ok: false, reason: 'nothing_to_repair' })
    wear(h, p, 'weapon', SWORD.code, null)
    expect(repair(h, p, inbox, [{ equip: 'weapon' }])).toMatchObject({ ok: false, reason: 'nothing_to_repair' })
  })

  it('from 9 m → too_far; dead → dead', () => {
    const h = setup()
    const { p, inbox } = h.enter([29, 0, 0], 1000)
    wear(h, p, 'weapon', SWORD.code, 10)
    expect(repair(h, p, inbox)).toMatchObject({ ok: false, reason: 'too_far' })
    const q = h.enter(AT_SMITH, 1000)
    wear(h, q.p, 'weapon', SWORD.code, 10)
    q.p.dead = true
    expect(repair(h, q.p, q.inbox)).toMatchObject({ ok: false, reason: 'dead' })
  })

  it('the validator takes 1..16 refs, strict {equip} xor {bag}', () => {
    const ok = (v: unknown) => parseClientMessage(JSON.stringify(v)).ok
    expect(ok({ t: 'repair', npc: 1 })).toBe(true)
    expect(ok({ t: 'repair', npc: 1, items: [{ equip: 'weapon' }, { bag: 3 }] })).toBe(true)
    expect(ok({ t: 'repair', npc: 1, items: [] })).toBe(false)
    expect(ok({ t: 'repair', npc: 1, items: Array.from({ length: 17 }, (_, i) => ({ bag: i })) })).toBe(false)
    expect(ok({ t: 'repair', npc: 1, items: [{ equip: 'weapon', bag: 1 }] })).toBe(false)
  })
})

describe('durability travels with the item (D47 regression)', () => {
  it('storage deposit and withdraw keep durability and plus', () => {
    const h = setup()
    const keeper = h.npcByCode('NPC_CH_WAREHOUSE_W')
    const { p, inbox } = h.enter([keeper.x + 2, 0, keeper.z], 5000)
    const bag = h.give(p, SWORD.code, 1, { durability: 17, plus: 2 })
    expect(h.req(p, inbox, { t: 'storageOpen', npc: keeper.id })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'storageDeposit', npc: keeper.id, bag })).toMatchObject({ ok: true })
    expect(h.bag(p)[bag]).toBeNull()
    const put = h.of(inbox, 'storageUpdate').at(-1)!
    expect(put.slots?.[0]?.item).toEqual({ code: SWORD.code, count: 1, plus: 2, durability: 17 })
    expect(h.req(p, inbox, { t: 'storageWithdraw', npc: keeper.id, slot: put.slots![0]!.slot, bag: 5 })).toMatchObject({ ok: true })
    expect(h.bag(p)[5]).toEqual({ code: SWORD.code, count: 1, plus: 2, durability: 17 })
  })

  it('sell then buy back keeps durability (a broken sword stays broken)', () => {
    const h = setup()
    const smith = h.npcByCode('NPC_CH_SMITH')
    const { p, inbox } = h.enter(AT_SMITH, 5000)
    h.req(p, inbox, { t: 'npcTalk', npc: smith.id })
    const bag = h.give(p, SWORD.code, 1, { durability: 0 })
    expect(h.req(p, inbox, { t: 'shopSell', npc: smith.id, bag })).toMatchObject({ ok: true })
    const list = h.of(inbox, 'buyback').at(-1)!
    expect(list.entries[0]?.item).toMatchObject({ code: SWORD.code, durability: 0 })
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: smith.id, index: 0 })).toMatchObject({ ok: true })
    const back = h.bag(p).find((i) => i?.code === SWORD.code)
    expect(back?.durability).toBe(0)
  })
})
