/**
 * NPC dialogs and shops (docs/SHOPS.md §3, §6, §9 lane A; docs/WAVE_PLAN.md §4.5): npcTalk with the talk walk and
 * the server-side closes, the services an NPC offers, shop buy/sell with the level-cap filter, stack caps and the
 * strict gold cap, the in-memory buyback, and the abuse cases. A synthetic world with a controlled clock (npc-harness.ts).
 */
import { BUYBACK_SLOTS, MAX_GOLD, MAX_ITEM_COUNT, NPC_APPROACH_RANGE, NPC_INTERACT_RANGE, parseClientMessage, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/gm.ts'
import type { GameContext } from '../src/game.ts'
import type { Player } from '../src/world.ts'
import { MANGNYANG } from './fixtures.ts'
import { ARROWS, CHEST_19, CHEST_21, NO_SELL, RETURN_01, npcHarness, type Msg, type NpcHarness } from './npc-harness.ts'

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})
function setup(opts: Parameters<typeof npcHarness>[0] = {}) {
  const h = npcHarness(opts)
  harnesses.push(h)
  return h
}

const HP = 'ITEM_ETC_HP_POTION_01'
const BLADE = 'ITEM_CH_BLADE_02_A'
const types = (inbox: ServerMessage[], from = 0) => inbox.slice(from).map((m) => m.t)
const dist = (h: NpcHarness, p: Player, id: number) => h.world.distance(p, h.world.npcs.get(id)!, h.now())

describe('NPCs in the world', () => {
  it('places every NPC of this world, both storage keepers included', () => {
    const h = setup()
    const codes = [...h.world.npcs.values()].map((n) => n.code).sort()
    expect(codes).toEqual(['NPC_CH_ACCESSORY', 'NPC_CH_ARMOR', 'NPC_CH_CAPPED', 'NPC_CH_CHEF', 'NPC_CH_POTION', 'NPC_CH_WAREHOUSE_M', 'NPC_CH_WAREHOUSE_W'])
  })
})

describe('npcTalk', () => {
  it('in range: ok, then npcDialog with the services, then the buyback list for a shop', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'npcTalk', npc: potion.id })).toMatchObject({ ok: true })
    // (the stop turns the player to face the NPC)
    expect(types(inbox, from)).toEqual(['actionResult', 'stop', 'npcDialog', 'buyback'])
    expect(p.yaw).toBeCloseTo(Math.PI / 2)
    expect(h.of(inbox, 'npcDialog')[0]).toEqual({ t: 'npcDialog', npc: potion.id, code: 'NPC_CH_POTION', services: ['shop'] })
    expect(h.of(inbox, 'buyback')[0]).toEqual({ t: 'buyback', entries: [] })
    expect(h.gameplay.npcs.dialogOf(p)).toBe(potion.id)
  })

  it('services: none for a talker, none for a shop whose goods are all above the level cap, storage only when storage exists', () => {
    const h = setup()
    const { p, inbox } = h.enter([-35, 0, 40])
    h.req(p, inbox, { t: 'npcTalk', npc: h.npcByCode('NPC_CH_CHEF').id })
    expect(h.of(inbox, 'npcDialog').at(-1)!.services).toEqual([])
    expect(h.of(inbox, 'buyback')).toHaveLength(0)
    const capped = h.enter([55, 0, 40])
    h.req(capped.p, capped.inbox, { t: 'npcTalk', npc: h.npcByCode('NPC_CH_CAPPED').id })
    expect(h.of(capped.inbox, 'npcDialog').at(-1)!.services).toEqual([])
    const keeper = h.enter([-35, 0, 0])
    h.req(keeper.p, keeper.inbox, { t: 'npcTalk', npc: h.npcByCode('NPC_CH_WAREHOUSE_W').id })
    expect(h.of(keeper.inbox, 'npcDialog').at(-1)!.services).toEqual(h.gameplay.storage.enabled ? ['storage'] : [])
  })

  it('offers the quest service when the quest hook has a topic (wave-4 seam)', () => {
    const h = setup()
    h.gameplay.npcs.topics = (_p, code) => code === 'NPC_CH_CHEF'
    const { p, inbox } = h.enter([-35, 0, 40])
    h.req(p, inbox, { t: 'npcTalk', npc: h.npcByCode('NPC_CH_CHEF').id })
    expect(h.of(inbox, 'npcDialog').at(-1)!.services).toEqual(['quest'])
  })

  it('at 30 m: ok at once, walks to 3 m, stops facing the NPC, then opens the dialog', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([-10, 0, 0])
    expect(dist(h, p, potion.id)).toBeCloseTo(30)
    expect(h.req(p, inbox, { t: 'npcTalk', npc: potion.id })).toMatchObject({ ok: true })
    expect(h.of(inbox, 'npcDialog')).toHaveLength(0)
    expect(p.action).toMatchObject({ kind: 'talk', npc: potion.id })
    h.advance(200)
    expect(h.of(inbox, 'move').some((m) => m.id === p.id)).toBe(true)
    expect(h.of(inbox, 'npcDialog')).toHaveLength(0)
    h.advance(8000)
    const dialog = h.of(inbox, 'npcDialog')
    expect(dialog).toHaveLength(1)
    expect(p.action).toBeNull()
    expect(p.move).toBeNull()
    expect(dist(h, p, potion.id)).toBeLessThanOrEqual(NPC_APPROACH_RANGE)
    // the last stop before the dialog faces the NPC (east: yaw pi/2 in the protocol's convention)
    const stopAt = inbox.findLastIndex((m) => m.t === 'stop' && m.id === p.id)
    expect(stopAt).toBeGreaterThan(-1)
    expect(stopAt).toBeLessThan(inbox.indexOf(dialog[0]))
  })

  it('a moveTo during the talk walk cancels it: no dialog', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([-10, 0, 0])
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    h.advance(500)
    expect(h.gameplay.onMoveTo(p, h.now())).toBe(true)
    h.world.moveTo(p, -20, 0, h.now())
    h.advance(8000)
    expect(h.of(inbox, 'npcDialog')).toHaveLength(0)
  })

  it('a walk blocked short of 3 m but within 8 m still opens the dialog; one blocked farther away says so', () => {
    // a wall at x = 14.5: the potion merchant (x 20) is 5.5 m behind it
    const h = setup({ validator: (from, to) => [Math.min(to[0], 14.5), from[1], to[2]] })
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([-10, 0, 0])
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    h.advance(10_000)
    expect(h.of(inbox, 'npcDialog')).toHaveLength(1)
    expect(dist(h, p, potion.id)).toBeGreaterThan(NPC_APPROACH_RANGE)
    expect(dist(h, p, potion.id)).toBeLessThanOrEqual(NPC_INTERACT_RANGE)
    // the accessory trader (x 60) is 45 m behind the same wall: no dialog, a system line
    const acc = h.npcByCode('NPC_CH_ACCESSORY')
    const q = h.enter([-10, 0, 0])
    h.req(q.p, q.inbox, { t: 'npcTalk', npc: acc.id })
    h.advance(20_000)
    expect(h.of(q.inbox, 'npcDialog')).toHaveLength(0)
    expect(h.of(q.inbox, 'chat').some((m) => m.channel === 'system' && /cannot get to/.test(m.text))).toBe(true)
    expect(q.p.action).toBeNull()
  })

  it('a walk blocked by a wall that has a way around goes around it (straight legs), then talks', () => {
    // a 20 m wall across x = 5 (|z| < 10) between the player (x -10) and the potion merchant (x 20)
    const wall = (from: Vec3, to: Vec3): Vec3 => {
      const [fx, , fz] = from
      const [tx, , tz] = to
      if (fx < 5 !== tx < 5) {
        const zc = fz + ((5 - fx) / (tx - fx)) * (tz - fz)
        if (Math.abs(zc) < 10) {
          const x = fx < 5 ? 4.99 : 5.01
          return [x, from[1], fz + ((x - fx) / (tx - fx)) * (tz - fz)]
        }
      }
      return [tx, from[1], tz]
    }
    const h = setup({ validator: wall })
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([-10, 0, 0])
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    h.advance(20_000)
    expect(h.of(inbox, 'npcDialog')).toHaveLength(1)
    expect(dist(h, p, potion.id)).toBeLessThanOrEqual(NPC_APPROACH_RANGE)
    // the blocked straight walk, then the two legs around the wall's end
    expect(h.of(inbox, 'move').filter((m) => m.id === p.id).length).toBeGreaterThanOrEqual(3)
    expect(h.of(inbox, 'chat')).toHaveLength(0)
    expect(p.action).toBeNull()
    // a moveTo during the detour cancels it
    const q = h.enter([-10, 0, 0])
    h.req(q.p, q.inbox, { t: 'npcTalk', npc: potion.id })
    h.advance(3000)
    h.gameplay.onMoveTo(q.p, h.now())
    h.world.moveTo(q.p, -10, 0, h.now())
    h.advance(20_000)
    expect(h.of(q.inbox, 'npcDialog')).toHaveLength(0)
  })

  it('closes too_far past 8 m, not before', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    p.pos = [20 - 7.9, 0, 0]
    h.advance(100)
    expect(h.of(inbox, 'npcDialogClose')).toHaveLength(0)
    p.pos = [20 - 8.1, 0, 0]
    h.advance(100)
    expect(h.of(inbox, 'npcDialogClose')).toEqual([{ t: 'npcDialogClose', npc: potion.id, reason: 'too_far' }])
    expect(h.gameplay.npcs.dialogOf(p)).toBeNull()
    h.advance(500)
    expect(h.of(inbox, 'npcDialogClose')).toHaveLength(1)
  })

  it('closes on death (dead), on the respawn / return warp (warp) and on a GM teleport (warp)', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    h.gameplay.gmKill(p, h.now())
    expect(h.of(inbox, 'npcDialogClose').at(-1)).toEqual({ t: 'npcDialogClose', npc: potion.id, reason: 'dead' })
    // dead: npcClose still works (the allowlist), npcTalk does not
    expect(h.req(p, inbox, { t: 'npcClose' })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'npcTalk', npc: potion.id })).toMatchObject({ ok: false, reason: 'dead' })
    h.req(p, inbox, { t: 'respawn' })
    // back at the town point (0,0,0), 20 m away; talk again from next to the NPC, then warp to town
    p.pos = [15, 0, 0]
    h.world.snapshotFor(p, h.now())
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    const before = inbox.length
    h.gameplay.toTown(p)
    expect(types(inbox, before).filter((t) => t === 'warp' || t === 'npcDialogClose')).toEqual(['warp', 'npcDialogClose'])
    expect(h.of(inbox, 'npcDialogClose').at(-1)!.reason).toBe('warp')
    // GM tp: the real command fans out warped(p, 'gm')
    p.pos = [15, 0, 0]
    h.world.snapshotFor(p, h.now())
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    const ctx = { world: h.world, gameplay: h.gameplay, data: h.data, setup: { spawn: { x: 0, y: 0, z: 0 } }, config: h.config } as unknown as GameContext
    const conn = { player: p, role: 'gm', account: 'gm', send: () => {} } as never
    expect(COMMANDS.tp.run({ ctx, conn, role: 'gm', args: ['16', '0'], self: p }).ok).toBe(true)
    expect(h.of(inbox, 'npcDialogClose').at(-1)).toEqual({ t: 'npcDialogClose', npc: potion.id, reason: 'warp' })
  })

  it('a second talk replaces the first: close (closed) for the old NPC, then the new dialog', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const armor = h.npcByCode('NPC_CH_ARMOR')
    const { p, inbox } = h.enter([20, 0, 20]) // 20 m from both: walks
    p.pos = [20, 0, 5]
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    expect(h.of(inbox, 'npcDialog')).toHaveLength(1)
    const from = inbox.length
    h.req(p, inbox, { t: 'npcTalk', npc: armor.id })
    expect(types(inbox, from).slice(0, 2)).toEqual(['actionResult', 'npcDialogClose'])
    expect(h.of(inbox, 'npcDialogClose').at(-1)).toEqual({ t: 'npcDialogClose', npc: potion.id, reason: 'closed' })
    h.advance(10_000)
    expect(h.of(inbox, 'npcDialog').at(-1)!.npc).toBe(armor.id)
    // the same NPC again, in range: the dialog is simply sent again (no close)
    const closes = h.of(inbox, 'npcDialogClose').length
    h.req(p, inbox, { t: 'npcTalk', npc: armor.id })
    expect(h.of(inbox, 'npcDialogClose')).toHaveLength(closes)
    expect(h.of(inbox, 'npcDialog').at(-1)!.npc).toBe(armor.id)
  })

  it('npcTalk on a mob, a ground item, a player, an unknown id or an NPC the client has not seen: not_found', () => {
    const h = setup()
    const { p, inbox } = h.enter([15, 0, 0])
    const q = h.enter([16, 0, 0])
    const mob = h.gameplay.createMob(MANGNYANG, 'normal', 14, 1, 0, null, h.now())
    const it = h.gameplay.spawnGroundItem('ITEM_ETC_HP_POTION_01', 1, 0, [14, 0, -1], null, h.now())
    for (const id of [mob.id, it.id, q.p.id, p.id, 999_999]) expect(h.req(p, inbox, { t: 'npcTalk', npc: id }), String(id)).toMatchObject({ ok: false, reason: 'not_found' })
    const potion = h.npcByCode('NPC_CH_POTION')
    p.known.delete(potion.id)
    expect(h.req(p, inbox, { t: 'npcTalk', npc: potion.id })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.of(inbox, 'npcDialog')).toHaveLength(0)
  })

  it('npcClose: always ok, drops the dialog and a pending talk walk', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    expect(h.req(p, inbox, { t: 'npcClose' })).toMatchObject({ ok: true })
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    expect(h.req(p, inbox, { t: 'npcClose' })).toMatchObject({ ok: true })
    expect(h.gameplay.npcs.dialogOf(p)).toBeNull()
    p.pos = [-10, 0, 0]
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    h.req(p, inbox, { t: 'npcClose' })
    expect(p.action).toBeNull()
    h.advance(8000)
    expect(h.of(inbox, 'npcDialog')).toHaveLength(1)
    expect(h.of(inbox, 'npcDialogClose')).toHaveLength(0)
  })

  it('forget drops the dialog without a message', () => {
    const h = setup()
    const { p, inbox } = h.enter([15, 0, 0])
    h.req(p, inbox, { t: 'npcTalk', npc: h.npcByCode('NPC_CH_POTION').id })
    h.gameplay.forget(p)
    expect(h.gameplay.npcs.dialogOf(p)).toBeNull()
    expect(h.of(inbox, 'npcDialogClose')).toHaveLength(0)
  })
})

describe('shop buy', () => {
  it('exact gold arithmetic; the bag and gold change together', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0], 1000)
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 7 })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta'])
    expect(p.gold).toBe(1000 - 7 * 20)
    expect(h.store.loadInventory(p.characterId).gold).toBe(860)
    expect(h.countOf(p, HP)).toBe(7)
    // 250 arrows at 2 gold: one stack
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: ARROWS.code, count: 250 })).toMatchObject({ ok: true })
    expect(p.gold).toBe(360)
    expect(h.bag(p).filter((i) => i?.code === ARROWS.code)).toHaveLength(1)
  })

  it('not_enough_gold, and inventory_full leaves the gold unchanged', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0], 499)
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: BLADE, count: 1 })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    h.setGold(p, 5000)
    h.edit(p, (d) => {
      for (let i = 0; i < d.bagSize; i++) if (!d.bag[i]) d.setBag(i, { code: NO_SELL.code, count: 1, plus: 0, durability: null })
    })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: BLADE, count: 1 })).toMatchObject({ ok: false, reason: 'inventory_full' })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 1 })).toMatchObject({ ok: false, reason: 'inventory_full' })
    expect(h.store.loadInventory(p.characterId).gold).toBe(5000)
    expect(p.gold).toBe(5000)
  })

  it('goods above the level cap are refused (not_found); a raised cap sells them', () => {
    const h = setup()
    const armor = h.npcByCode('NPC_CH_ARMOR')
    const { p, inbox } = h.enter([20, 0, 35], 100_000)
    expect(h.req(p, inbox, { t: 'shopBuy', npc: armor.id, item: CHEST_21.code, count: 1 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: armor.id, item: CHEST_19.code, count: 1 })).toMatchObject({ ok: true })
    const raised = setup({ config: { levelCap: 21 } })
    const q = raised.enter([20, 0, 35], 100_000)
    expect(raised.req(q.p, q.inbox, { t: 'shopBuy', npc: raised.npcByCode('NPC_CH_ARMOR').id, item: CHEST_21.code, count: 1 })).toMatchObject({ ok: true })
    // and the all-capped NPC opens a shop once the cap allows it
    raised.req(q.p, q.inbox, { t: 'npcTalk', npc: raised.npcByCode('NPC_CH_CAPPED').id })
    q.p.pos = [55, 0, 40]
    raised.req(q.p, q.inbox, { t: 'npcTalk', npc: raised.npcByCode('NPC_CH_CAPPED').id })
    expect(raised.of(q.inbox, 'npcDialog').at(-1)!.services).toEqual(['shop'])
  })

  it('an item that is not in this NPC\'s shop, an NPC without a shop, a non-NPC, or a shop 9 m away are refused', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0], 100_000)
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: RETURN_01.code, count: 1 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: 'ITEM_NOT_A_THING', count: 1 })).toMatchObject({ ok: false, reason: 'not_found' })
    const q = h.enter([-35, 0, 40], 100_000)
    expect(h.req(q.p, q.inbox, { t: 'shopBuy', npc: h.npcByCode('NPC_CH_CHEF').id, item: HP, count: 1 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(q.p, q.inbox, { t: 'shopBuy', npc: p.id, item: HP, count: 1 })).toMatchObject({ ok: false, reason: 'not_found' })
    p.pos = [11, 0, 0]
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 1 })).toMatchObject({ ok: false, reason: 'too_far' })
    p.pos = [12.5, 0, 0]
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 1 })).toMatchObject({ ok: true })
  })

  it('count above maxStack x bag size is invalid_count; zero, negative, fractional and huge counts never reach the rules', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0], MAX_GOLD)
    const bagSize = h.store.loadInventory(p.characterId).bagSize
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 50 * bagSize + 1 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: BLADE, count: bagSize + 1 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    // defence in depth if a bad count ever got past the validator
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 0 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: -3 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 1.5 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.store.loadInventory(p.characterId).gold).toBe(MAX_GOLD)
    for (const count of [0, -1, 1.5, MAX_ITEM_COUNT + 1, 1e300, '5', null]) {
      expect(parseClientMessage(JSON.stringify({ t: 'shopBuy', npc: potion.id, item: HP, count })).ok, String(count)).toBe(false)
      expect(parseClientMessage(JSON.stringify({ t: 'shopSell', npc: potion.id, bag: 0, count })).ok, String(count)).toBe(false)
    }
    for (const index of [-1, BUYBACK_SLOTS, 0.5]) expect(parseClientMessage(JSON.stringify({ t: 'shopBuyback', npc: potion.id, index })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ t: 'shopBuyback', npc: potion.id, index: 0, extra: 1 })).ok).toBe(false)
  })
})

describe('shop sell', () => {
  it('pays sellPrice x count: ok -> inventoryUpdate -> statsDelta -> buyback', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    const slot = h.give(p, HP, 10)
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot, count: 4 })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta', 'buyback'])
    expect(p.gold).toBe(4 * 5)
    expect(h.countOf(p, HP)).toBe(6)
    expect(h.of(inbox, 'buyback').at(-1)!.entries).toEqual([{ item: { code: HP, count: 4 }, price: 20 }])
    // no count: the whole stack
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot })).toMatchObject({ ok: true })
    expect(p.gold).toBe(50)
    expect(h.bag(p)[slot]).toBeNull()
  })

  it('a sale that would pass MAX_GOLD fails gold_limit and changes nothing', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0], MAX_GOLD - 1)
    const slot = h.give(p, HP, 10)
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot, count: 1 })).toMatchObject({ ok: false, reason: 'gold_limit' })
    expect(h.bag(p)[slot]).toMatchObject({ code: HP, count: 10 })
    expect(h.store.loadInventory(p.characterId).gold).toBe(MAX_GOLD - 1)
    expect(h.gameplay.shops.entries(p)).toEqual([])
    // up to exactly the cap is fine
    h.setGold(p, MAX_GOLD - 5)
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot, count: 1 })).toMatchObject({ ok: true })
    expect(p.gold).toBe(MAX_GOLD)
  })

  it('abuse: double sell of one slot, count above the stack, quest and unsellable items, equipped items, empty slots', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    const slot = h.give(p, BLADE, 1)
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(p.gold).toBe(100)
    const stack = h.give(p, HP, 3)
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: stack, count: 4 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: stack, count: 0 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: h.give(p, 'ITEM_ETC_QUEST_01') })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: h.give(p, NO_SELL.code) })).toMatchObject({ ok: false, reason: 'not_usable' })
    // the worn blade is not in the bag: selling "its" slot sells nothing, and it stays worn
    const inv = h.store.loadInventory(p.characterId)
    expect(inv.equip.weapon?.code).toBe('ITEM_CH_BLADE_01_A_DEF')
    const empty = inv.bag.findIndex((i) => i === null)
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: empty })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: 9999 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.store.loadInventory(p.characterId).equip.weapon?.code).toBe('ITEM_CH_BLADE_01_A_DEF')
    expect(p.gold).toBe(100)
    // 9 m away: too_far, nothing sold
    p.pos = [11, 0, 0]
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: stack })).toMatchObject({ ok: false, reason: 'too_far' })
    expect(h.bag(p)[stack]).toMatchObject({ count: 3 })
  })

  it('dead players cannot trade', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0], 1000)
    const slot = h.give(p, HP, 3)
    h.gameplay.gmKill(p, h.now())
    expect(h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 1 })).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot })).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'dead' })
  })
})

describe('buyback', () => {
  it('restores the exact stack (plus, durability) for exactly the price paid', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    const blade = h.give(p, BLADE, 1, { plus: 3, durability: 41 })
    const herbs = h.give(p, HP, 5)
    h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: blade })
    h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: herbs })
    expect(p.gold).toBe(125)
    expect(h.gameplay.shops.entries(p)).toEqual([
      { item: { code: BLADE, count: 1, plus: 3, durability: 41 }, price: 100 },
      { item: { code: HP, count: 5 }, price: 25 },
    ])
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta', 'buyback'])
    expect(p.gold).toBe(25)
    expect(h.bag(p).find((i) => i?.code === BLADE)).toEqual({ code: BLADE, count: 1, plus: 3, durability: 41 })
    expect(h.of(inbox, 'buyback').at(-1)!.entries).toEqual([{ item: { code: HP, count: 5 }, price: 25 }])
    // the same index again is now the herbs; they cost exactly 25
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: true })
    expect(p.gold).toBe(0)
    expect(h.countOf(p, HP)).toBe(5)
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('keeps the last 5 sales (the 6th pushes out the oldest); a double buyback of one entry fails; forget empties it', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    const slot = h.give(p, HP, 50)
    for (let i = 1; i <= 6; i++) h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot, count: i })
    expect(h.gameplay.shops.entries(p).map((e) => e.item.count)).toEqual([2, 3, 4, 5, 6])
    expect(h.of(inbox, 'buyback').at(-1)!.entries).toHaveLength(BUYBACK_SLOTS)
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 4 })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 4 })).toMatchObject({ ok: false, reason: 'not_found' })
    h.gameplay.forget(p)
    expect(h.gameplay.shops.entries(p)).toEqual([])
  })

  it('needs gold, bag room, a shop NPC in range; the entry survives a failed attempt', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([15, 0, 0])
    h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: h.give(p, BLADE, 1) })
    h.setGold(p, 99)
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    h.setGold(p, 100)
    h.edit(p, (d) => {
      for (let i = 0; i < d.bagSize; i++) if (!d.bag[i]) d.setBag(i, { code: NO_SELL.code, count: 1, plus: 0, durability: null })
    })
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'inventory_full' })
    expect(h.store.loadInventory(p.characterId).gold).toBe(100)
    expect(h.gameplay.shops.entries(p)).toHaveLength(1)
    const chef = h.npcByCode('NPC_CH_CHEF')
    p.pos = [-35, 0, 40]
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: chef.id, index: 0 })).toMatchObject({ ok: false, reason: 'not_found' })
    p.pos = [11, 0, 0]
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'too_far' })
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 3 })).toMatchObject({ ok: false, reason: 'too_far' })
    p.pos = [15, 0, 0]
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 3 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.gameplay.shops.entries(p)).toHaveLength(1)
  })

  it('each character has its own list', () => {
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const a = h.enter([15, 0, 0])
    const b = h.enter([15, 0, 1], 1000)
    h.req(a.p, a.inbox, { t: 'shopSell', npc: potion.id, bag: h.give(a.p, BLADE, 1) })
    expect(h.req(b.p, b.inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.gameplay.shops.entries(b.p)).toEqual([])
  })
})

describe('message shapes', () => {
  it('every frame the NPC and shop code sends passes the shared server parser', async () => {
    const { parseServerMessage } = await import('@sro/shared')
    const h = setup()
    const potion = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter([-10, 0, 0], 1000)
    h.req(p, inbox, { t: 'npcTalk', npc: potion.id })
    h.advance(8000)
    h.req(p, inbox, { t: 'shopBuy', npc: potion.id, item: HP, count: 3 })
    h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: h.bag(p).findIndex((i) => i?.code === HP), count: 2 })
    h.req(p, inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })
    p.pos = [0, 0, 0]
    h.advance(100)
    const seen = new Set<string>()
    for (const m of inbox) {
      const r = parseServerMessage(JSON.stringify(m))
      expect(r.ok, JSON.stringify(m)).toBe(true)
      seen.add(m.t)
    }
    for (const t of ['npcDialog', 'buyback', 'npcDialogClose', 'inventoryUpdate'] as Msg<'npcDialog'>['t'][]) expect(seen.has(t)).toBe(true)
  })
})
