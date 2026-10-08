/**
 * Lane NPC-C (docs/SHOPS.md §9 lane D): the shop's display rules (tabs by gender and level cap, how many one can
 * buy, sale value), the NPC dialog's options and conversation state, and the ?mock=1 NPC round trip (talk ->
 * dialog -> buy -> sell -> buyback) with every client frame checked by the shared validator.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  contentEntries,
  DEFAULT_LEVEL_CAP,
  MAX_ITEM_COUNT,
  parseClientMessage,
  type ItemDef,
  type ItemStack,
  type NpcDef,
  type ShopDef,
} from '@sro/shared'
import { intent } from '../src/hud/intents.ts'
import { NpcConversation } from '../src/hud/npc-state.ts'
import { bagRoom, buyLimit, dialogOptions, greetingOf, hasGenderTabs, maxAffordable, sellValue, SELL_CONFIRM_GOLD, shopFor, unsellable, visibleTabs, type BagView } from '../src/hud/shop-logic.ts'
import { en } from '../src/i18n/en.ts'
import { intents } from '../src/world/intents.ts'
import { mockWorld, of } from './npc-fixtures.ts'

const DATA_DIR = fileURLToPath(new URL('../../../work/out/data/', import.meta.url))

function item(code: string, extra: Partial<ItemDef> = {}): ItemDef {
  return { code, name: code, category: 'etc', maxStack: 1, price: 100, sellPrice: 30, reqLevel: 0, degree: 0, ...extra } as ItemDef
}

function bagOf(slots: (ItemStack | null)[]): BagView {
  return { bagSize: slots.length, item: i => slots[i] ?? null }
}

const ARMOR: ShopDef = {
  id: 'STORE_CH_ARMOR',
  npcs: ['NPC_CH_ARMOR'],
  tabs: [
    { name: 'Armor', items: ['M_CA_1', 'M_BA_3'], reqGender: 'male' },
    { name: 'Protector', items: ['M_LIGHT_1'], reqGender: 'male' },
    { name: 'Armor', items: ['W_CA_1', 'W_BA_3'], reqGender: 'female' },
    { name: 'Garment', items: ['W_BA_3'], reqGender: 'female' },
  ],
  provenance: 'client',
}
const DEFS = new Map<string, ItemDef>([
  ['M_CA_1', item('M_CA_1', { reqLevel: 1 })],
  ['M_BA_3', item('M_BA_3', { reqLevel: 21 })],
  ['M_LIGHT_1', item('M_LIGHT_1', { reqLevel: 1 })],
  ['W_CA_1', item('W_CA_1', { reqLevel: 1 })],
  ['W_BA_3', item('W_BA_3', { reqLevel: 21 })],
])

describe('shop tabs (visibleTabs)', () => {
  it('shows only the tabs of the player gender, hides goods above the cap and drops emptied tabs', () => {
    // a cap-20 server (the default before the Climb; DEFAULT_LEVEL_CAP is 25 now)
    const male = visibleTabs(ARMOR, 'male', 20, c => DEFS.get(c))
    expect(male.map(t => [t.name, t.items, t.index])).toEqual([
      ['Armor', ['M_CA_1'], 0],
      ['Protector', ['M_LIGHT_1'], 1],
    ])
    const female = visibleTabs(ARMOR, 'female', 20, c => DEFS.get(c))
    // Garment only held a level-21 chest: the tab disappears.
    expect(female.map(t => t.name)).toEqual(['Armor'])
    expect(female[0]!.reqGender).toBe('female')
    // Raising the cap brings them back with no data change.
    expect(visibleTabs(ARMOR, 'female', 21, c => DEFS.get(c)).map(t => t.items)).toEqual([['W_CA_1', 'W_BA_3'], ['W_BA_3']])
    expect(visibleTabs(ARMOR, 'female', DEFAULT_LEVEL_CAP, c => DEFS.get(c)).map(t => t.items)).toEqual([['W_CA_1', 'W_BA_3'], ['W_BA_3']])
    expect(hasGenderTabs(ARMOR)).toBe(true)
  })

  it('keeps goods without an ItemDef (the server decides) and tabs without a gender for everyone', () => {
    const shop: ShopDef = { id: 'S', npcs: ['N'], tabs: [{ name: 'Goods', items: ['UNKNOWN_ITEM'] }], provenance: 'client' }
    expect(visibleTabs(shop, 'female', 20, () => undefined)).toEqual([{ name: 'Goods', items: ['UNKNOWN_ITEM'], index: 0 }])
    expect(hasGenderTabs(shop)).toBe(false)
  })

  it('finds an NPC shop by NpcDef.shop, then by the shop npcs list', () => {
    const npcs = new Map<string, NpcDef>([['NPC_A', { code: 'NPC_A', shop: 'STORE_CH_ARMOR' } as NpcDef]])
    const shops = new Map([[ARMOR.id, ARMOR]])
    expect(shopFor('NPC_A', npcs, shops)?.id).toBe('STORE_CH_ARMOR')
    expect(shopFor('NPC_CH_ARMOR', npcs, shops)?.id).toBe('STORE_CH_ARMOR')
    expect(shopFor('NPC_NONE', npcs, shops)).toBeNull()
  })

  const real = existsSync(join(DATA_DIR, 'shops.json')) && existsSync(join(DATA_DIR, 'items.json'))
  it.skipIf(!real)('on the real export: Mrs Jang shows Armor / Protector / Garment for a man; the level-21 chests from cap 21 (the default 25)', () => {
    const shops = contentEntries<ShopDef>(JSON.parse(readFileSync(join(DATA_DIR, 'shops.json'), 'utf8')), 'shops')
    const items = new Map(contentEntries<ItemDef>(JSON.parse(readFileSync(join(DATA_DIR, 'items.json'), 'utf8')), 'items').map(d => [d.code, d]))
    const armor = shops.find(s => s.id === 'STORE_CH_ARMOR')!
    const male = visibleTabs(armor, 'male', 20, c => items.get(c))
    expect(male).toHaveLength(3)
    expect(male.every(t => t.reqGender === 'male')).toBe(true)
    const goods = male.flatMap(t => t.items)
    expect(goods.every(c => /^ITEM_CH_M_/.test(c))).toBe(true)
    expect(goods.some(c => /_03_BA_A$/.test(c))).toBe(false)
    expect(goods.some(c => /_03_CA_A$/.test(c))).toBe(true)
    // the Climb (docs/CLIMB.md §4.1): at the default cap 25 the shop's grade-A chests (level 21) are on sale
    expect(visibleTabs(armor, 'male', DEFAULT_LEVEL_CAP, c => items.get(c)).flatMap(t => t.items).some(c => /_03_BA_A$/.test(c))).toBe(true)
    const female = visibleTabs(armor, 'female', DEFAULT_LEVEL_CAP, c => items.get(c)).flatMap(t => t.items)
    expect(female.every(c => /^ITEM_CH_W_/.test(c))).toBe(true)
  })
})

describe('buying limits (maxAffordable / buyLimit)', () => {
  const herb = item('HERB', { maxStack: 50, price: 60 })
  it('is bound by gold', () => {
    expect(maxAffordable(herb, 600, bagOf([null, null]))).toBe(10)
    expect(buyLimit(herb, 59, bagOf([null]))).toEqual({ ok: false, reason: 'not_enough_gold' })
  })
  it('is bound by bag room, counting the room left on stacks it merges into', () => {
    const bag = bagOf([{ code: 'HERB', count: 45 }, { code: 'OTHER', count: 1 }, { code: 'HERB', count: 10, plus: 1 }])
    // 5 on the first stack; the +1 stack and the other item take nothing.
    expect(bagRoom(bag, 'HERB', 50)).toBe(5)
    expect(maxAffordable(herb, 1_000_000, bag)).toBe(5)
    expect(buyLimit(herb, 1_000_000, bagOf([{ code: 'OTHER', count: 1 }]))).toEqual({ ok: false, reason: 'inventory_full' })
  })
  it('is bound by the stack size for single items and by MAX_ITEM_COUNT overall', () => {
    const sword = item('SWORD', { maxStack: 1, price: 890 })
    expect(maxAffordable(sword, 10_000, bagOf([null, null, null]))).toBe(3)
    const arrow = item('ARROW', { maxStack: 250, price: 2 })
    expect(maxAffordable(arrow, 1e9, bagOf(Array.from({ length: 96 }, () => null)))).toBe(MAX_ITEM_COUNT)
    expect(maxAffordable(item('FREE', { maxStack: 5, price: 0 }), 0, bagOf([null]))).toBe(5)
  })
})

describe('selling', () => {
  it('pays sellPrice x count, and asks first at SELL_CONFIRM_GOLD', () => {
    expect(sellValue(item('A', { sellPrice: 21 }), 5)).toBe(105)
    expect(sellValue(undefined, 5)).toBe(0)
    expect(sellValue(item('S', { sellPrice: 1470 }), 1)).toBeGreaterThanOrEqual(SELL_CONFIRM_GOLD)
    expect(unsellable(item('Q', { category: 'quest' }))).toBe(true)
    expect(unsellable(item('N', { canSell: false }))).toBe(true)
    expect(unsellable(item('OK'))).toBe(false)
  })
})

describe('NPC dialog', () => {
  it('lists shop, storage and quest in a fixed order, never repair, with the retail captions', () => {
    expect(dialogOptions(['quest', 'storage', 'repair', 'shop'])).toEqual(['shop', 'storage', 'quest'])
    expect(dialogOptions([])).toEqual([])
    expect(en['npc.option.shop']).toBe('Trade in the shop.')
    expect(en['npc.option.storage']).toBe('Deposit into storage.')
    expect(en['npc.option.quest']).toBe('Talk to this person.')
    expect(en['npc.option.end']).toBe('End conversation.')
    expect(en['cast.cancelled']).toBe('The use of return scroll has been canceled.')
  })

  it('uses the exported greeting, else null (the generic line)', () => {
    const npcs = new Map<string, NpcDef>([
      ['NPC_CH_POTION', { code: 'NPC_CH_POTION', greeting: '  With consistent patients...  ' } as NpcDef],
      ['NPC_BLANK', { code: 'NPC_BLANK', greeting: '   ' } as NpcDef],
    ])
    expect(greetingOf('NPC_CH_POTION', npcs)).toBe('With consistent patients...')
    expect(greetingOf('NPC_BLANK', npcs)).toBeNull()
    expect(greetingOf('NPCX_AUTHORED', npcs, 'NPC_CH_POTION')).toBe('With consistent patients...')
    expect(greetingOf('NPC_NONE', npcs)).toBeNull()
  })

  it('keeps one conversation: panels need the service, and only the open NPC closes it', () => {
    const c = new NpcConversation()
    expect(c.close()).toBeNull()
    expect(c.show('shop')).toBe(false)
    c.opened({ t: 'npcDialog', npc: 7, code: 'NPC_CH_POTION', services: ['shop'] })
    expect(c.panel).toBe('dialog')
    expect(c.show('storage')).toBe(false)
    expect(c.show('shop')).toBe(true)
    // A close for an older NPC (replaced by a new talk) leaves this one open.
    expect(c.serverClosed({ t: 'npcDialogClose', npc: 3, reason: 'closed' })).toBe(false)
    expect(c.panel).toBe('shop')
    expect(c.serverClosed({ t: 'npcDialogClose', npc: 7, reason: 'too_far' })).toBe(true)
    expect(c.open).toBe(false)
    expect(c.panel).toBeNull()
    c.opened({ t: 'npcDialog', npc: 9, code: 'NPC_CH_WAREHOUSE_W', services: ['storage'] })
    expect(c.isWith(9)).toBe(true)
    const close = c.close()
    expect(close && parseClientMessage(JSON.stringify(close)).ok).toBe(true)
    expect(c.close()).toBeNull()
  })
})

// ---- ?mock=1 round trip ----------------------------------------------------------------------------------

describe('?mock=1 NPC dialog, shop and buyback (net/mock/npc.ts)', () => {
  it('talk -> dialog with services -> buy -> sell -> buyback -> close', async () => {
    const w = await mockWorld('Shopper')
    const talk = await w.send(intents.npcTalk(w.npc.id))
    expect(of(talk, 'actionResult')[0]).toEqual({ t: 'actionResult', re: 'npcTalk', ok: true })
    const dlg = of(talk, 'npcDialog')[0]!
    expect(dlg.npc).toBe(w.npc.id)
    expect(dlg.services).toEqual(['shop', 'storage'])
    expect(of(talk, 'buyback')[0]?.entries).toEqual([])

    const buy = await w.send(intent.shopBuy(w.npc.id, 'ITEM_ETC_HP_POTION_01', 3))
    expect(of(buy, 'actionResult')[0]?.ok).toBe(true)
    const bagSlot = of(buy, 'inventoryUpdate')[0]!.bag![0]!.slot
    const goldAfterBuy = of(buy, 'statsDelta')[0]!.stats.gold!

    const sale = await w.send(intent.shopSell(w.npc.id, bagSlot, 2))
    expect(of(sale, 'actionResult')[0]?.ok).toBe(true)
    const goldAfterSale = of(sale, 'statsDelta')[0]!.stats.gold!
    const bb = of(sale, 'buyback')[0]!
    expect(bb.entries).toHaveLength(1)
    expect(bb.entries[0]!.item).toMatchObject({ code: 'ITEM_ETC_HP_POTION_01', count: 2 })
    expect(bb.entries[0]!.price).toBe(goldAfterSale - goldAfterBuy)

    const back = await w.send(intent.shopBuyback(w.npc.id, 0))
    expect(of(back, 'actionResult')[0]?.ok).toBe(true)
    expect(of(back, 'statsDelta')[0]!.stats.gold).toBe(goldAfterBuy)
    expect(of(back, 'buyback')[0]!.entries).toEqual([])
    // The same index twice: gone.
    const again = await w.send(intent.shopBuyback(w.npc.id, 0))
    expect(of(again, 'actionResult')[0]).toMatchObject({ ok: false, reason: 'not_found' })

    const close = await w.send(intent.npcClose())
    expect(of(close, 'actionResult')[0]).toEqual({ t: 'actionResult', re: 'npcClose', ok: true })
    w.close()
  })

  it('closes the dialog when the player walks away, and refuses a talk from too far', async () => {
    const w = await mockWorld('Walker')
    await w.send(intents.npcTalk(w.npc.id))
    await w.send(intents.moveTo(w.npc.pos[0] + 40, w.npc.pos[2] + 40))
    const from = w.log.length
    await w.step(12_000)
    const closes = of(w.log.slice(from), 'npcDialogClose')
    expect(closes).toEqual([{ t: 'npcDialogClose', npc: w.npc.id, reason: 'too_far' }])
    const far = await w.send(intents.npcTalk(w.npc.id))
    expect(of(far, 'actionResult')[0]).toMatchObject({ re: 'npcTalk', ok: false, reason: 'too_far' })
    w.close()
  })
})
