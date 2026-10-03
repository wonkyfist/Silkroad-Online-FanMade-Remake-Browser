/**
 * Alchemy (docs/SYSTEMS_COMBAT.md §4, §8 lane AL; docs/WAVE_PLAN2.md D40, D44, D48, D51): the success table, the
 * start checks, the server-timed fuse and its cancels, the finish-time re-check, the D44 soft lock, the authored elixir
 * drop and the GM `plus` command. Synthetic NPC world with a controlled clock (npc-harness.ts); numbers are the
 * exported _A elixir / Lucky Powder rows.
 */
import type { ItemDef, ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { DESTROY_CHANCE, ELIXIR_DROP_WEIGHTS, FUSE_LOCKED, successChance } from '../src/alchemy.ts'
import type { ServerConfig } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { playerCombatStats } from '../src/formulas.ts'
import type { Mob, Player } from '../src/world.ts'
import { LEVELS, MANGNYANG, item } from './fixtures.ts'
import { NPC_DEFS, NPC_ITEMS, SHOP_DEFS, npcHarness, type Msg, type NpcHarness } from './npc-harness.ts'

const ELIXIR_RATES = [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5]
const POWDER_RATES = [50, 30, 20, 8, 8, 8, 8, 8, 8, 8, 8, 8]

const SWORD = item('ITEM_CH_SWORD_01_A', {
  category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 1, reqLevel: 1, race: 'china', typeId: [3, 1, 6, 2], range: 1.5,
  stats: { physAttack: [20, 30], magAttack: [10, 14], durability: [62, 76] },
  perPlus: { physAttack: 2.4, magAttack: 4.1 },
})
const SWORD_D2 = item('ITEM_CH_SWORD_03_A', { ...SWORD, code: 'ITEM_CH_SWORD_03_A', degree: 2 })
const ARMOR = item('ITEM_CH_M_HEAVY_01_BA_A', {
  category: 'armor', slot: 'chest', armorType: 'armor', degree: 1, reqLevel: 1, reqGender: 'male', race: 'china', typeId: [3, 1, 3, 3],
  stats: { physDefence: [10, 10], magDefence: [6, 6] }, perPlus: { physDefence: 0.4, magDefence: 0.5 },
})
const elixir = (kind: string, targets: number[]): ItemDef =>
  item(`ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_${kind}_A`, { category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, maxStack: 1, price: 50000, reinforce: { kind: 'elixir', targets, rates: ELIXIR_RATES } })
const powder = (n: 1 | 2 | 3): ItemDef =>
  item(`ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_0${n}`, { category: 'alchemy', typeId: [3, 3, 10, 2], degree: 1, maxStack: 50, reinforce: { kind: 'powder', degree: n, rates: POWDER_RATES } })
const E_WEAPON = elixir('WEAPON', [6])
const E_ARMOR = elixir('ARMOR', [1, 2, 3])
const E_SHIELD = elixir('SHIELD', [4])
const E_ACC = elixir('ACCESSARY', [5])
const P1 = powder(1)
const P2 = powder(2)
const P3 = powder(3)
const ALCHEMY_ITEMS = [SWORD, SWORD_D2, ARMOR, E_WEAPON, E_ARMOR, E_SHIELD, E_ACC, P1, P2, P3]

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})

function setup(config: Partial<ServerConfig> = {}, items: ItemDef[] = ALCHEMY_ITEMS) {
  const data = new GameData({ mobs: [{ ...MANGNYANG, level: 8 }], items: [...NPC_ITEMS, ...items], levels: LEVELS, drops: [], npcs: NPC_DEFS, shops: SHOP_DEFS, towns: [] })
  const h = npcHarness({ data, config })
  harnesses.push(h)
  return h
}

/** Far from town (0,0,0) and from every NPC. */
const FIELD: [number, number, number] = [200, 0, 200]

/** A player in the field with a sword, a weapon elixir and 5 Lucky Powders (1st) in the bag. */
function kit(h: NpcHarness, plus = 0) {
  const { p, inbox } = h.enter(FIELD)
  const sword = h.give(p, SWORD.code, 1, { plus })
  const el = h.give(p, E_WEAPON.code, 1)
  const pw = h.give(p, P1.code, 5)
  return { p, inbox, sword, el, pw }
}

const since = (inbox: ServerMessage[], from: number) => inbox.slice(from)
const results = (h: NpcHarness, inbox: ServerMessage[]) => h.of(inbox, 'alchemyResult')

describe('success chance (§4.3)', () => {
  it('ALCHEMY_RATE 1: 75 / 50 / 35 / 18 with a matching powder, 25 / 20 / 15 / 10 without', () => {
    expect([0, 1, 2, 3].map((plus) => successChance(SWORD, plus, E_WEAPON, P1, 1))).toEqual([75, 50, 35, 18])
    expect([0, 1, 2, 3].map((plus) => successChance(SWORD, plus, E_WEAPON, null, 1))).toEqual([25, 20, 15, 10])
    expect(successChance(SWORD, 9, E_WEAPON, P1, 1)).toBe(13)
  })

  it('a powder of another degree adds nothing; the rate multiplies and the chance clamps to 100', () => {
    expect(successChance(SWORD, 0, E_WEAPON, P2, 1)).toBe(25)
    expect(successChance(SWORD_D2, 0, E_WEAPON, P2, 1)).toBe(75)
    expect(successChance(SWORD, 0, E_WEAPON, P1, 1.5)).toBe(100)
    expect(successChance(SWORD, 3, E_WEAPON, P1, 1.5)).toBe(27)
    expect(successChance(SWORD, 3, E_WEAPON, P1, 10)).toBe(100)
    expect(successChance(SWORD, 0, E_WEAPON, P1, 0)).toBe(0)
  })
})

describe('alchemyReinforce: the start checks (§4.4 step 1)', () => {
  it('a degree-2 powder on a degree-1 sword is alchemy_mismatch; the 1st powder is accepted', () => {
    const h = setup()
    const { p, inbox, sword, el } = kit(h)
    const p2 = h.give(p, P2.code, 1)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: p2 })).toMatchObject({ ok: false, reason: 'alchemy_mismatch' })
    const p1 = h.bag(p).findIndex((i) => i?.code === P1.code)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: p1 })).toMatchObject({ ok: true })
  })

  it('a weapon elixir on armour is alchemy_mismatch; an armour elixir fits', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const armor = h.give(p, ARMOR.code, 1)
    const ew = h.give(p, E_WEAPON.code, 1)
    const ea = h.give(p, E_ARMOR.code, 1)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: armor, elixir: ew })).toMatchObject({ ok: false, reason: 'alchemy_mismatch' })
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: armor, elixir: ea })).toMatchObject({ ok: true })
  })

  it('a worn item (its bag slot is empty) is invalid_slot; a potion is not_usable; an elixir in the item slot too', () => {
    const h = setup()
    const { p, inbox, sword, el } = kit(h)
    expect(h.req(p, inbox, { t: 'itemEquip', bag: sword })).toMatchObject({ ok: true })
    const at = h.bag(p)[sword]
    expect(at?.code).not.toBe(SWORD.code) // the starter weapon swapped back in, or empty
    const empty = h.bag(p).findIndex((i, n) => !i && n > el)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: empty, elixir: el })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    const potion = h.give(p, 'ITEM_ETC_HP_POTION_01', 3)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: potion, elixir: el })).toMatchObject({ ok: false, reason: 'not_usable' })
    const other = h.give(p, E_ARMOR.code, 1)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: other, elixir: el })).toMatchObject({ ok: false, reason: 'not_usable' })
  })

  it('the elixir slot must hold an elixir, the powder slot a powder', () => {
    const h = setup()
    const { p, inbox, sword, el, pw } = kit(h)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: pw })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: el === 0 ? 1 : 0 })).toMatchObject({ ok: false })
  })

  it('D48: a broken item is refused with broken', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const sword = h.give(p, SWORD.code, 1, { durability: 0 })
    const el = h.give(p, E_WEAPON.code, 1)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: false, reason: 'broken' })
  })

  it('the cap: an item at ALCHEMY_MAX_PLUS is max_plus', () => {
    const h = setup()
    const { p, inbox, sword, el } = kit(h, 10)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: false, reason: 'max_plus' })
    const h2 = setup({ alchemyMaxPlus: 3 })
    const b = kit(h2, 3)
    expect(h2.req(b.p, b.inbox, { t: 'alchemyReinforce', item: b.sword, elixir: b.el })).toMatchObject({ ok: false, reason: 'max_plus' })
  })

  it('refused while dead; a second fuse while one runs is busy', () => {
    const h = setup()
    const { p, inbox, sword, el, pw } = kit(h)
    const el2 = h.give(p, E_WEAPON.code, 1)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el2, powder: pw })).toMatchObject({ ok: false, reason: 'busy' })
    p.dead = true
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el2 })).toMatchObject({ ok: false, reason: 'dead' })
    // alchemyCancel is allowed while dead (whileDead) and answers ok.
    expect(h.req(p, inbox, { t: 'alchemyCancel' })).toMatchObject({ ok: true })
  })
})

describe('the fuse (§4.4 steps 2-4)', () => {
  it('ok, then alchemyStart; nothing is consumed during the fuse; success at the end sets +1 and takes elixir and 1 powder', () => {
    const h = setup({ alchemyRate: 10 }) // 100 %
    const { p, inbox, sword, el, pw } = kit(h)
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toEqual({ t: 'actionResult', re: 'alchemyReinforce', ok: true })
    expect(since(inbox, from).map((m) => m.t)).toEqual(['actionResult', 'alchemyStart'])
    expect(h.of(inbox, 'alchemyStart')).toEqual([{ t: 'alchemyStart', item: sword, readyInMs: 3000 }])
    h.advance(2900)
    expect(results(h, inbox)).toEqual([])
    expect(h.countOf(p, E_WEAPON.code)).toBe(1)
    expect(h.countOf(p, P1.code)).toBe(5)
    const before = inbox.length
    h.advance(150)
    const after = since(inbox, before)
    expect(after.map((m) => m.t)).toEqual(['inventoryUpdate', 'alchemyResult'])
    expect(results(h, inbox)).toEqual([{ t: 'alchemyResult', item: sword, code: SWORD.code, outcome: 'success', plus: 1 }])
    expect(h.bag(p)[sword]).toMatchObject({ code: SWORD.code, plus: 1 })
    expect(h.countOf(p, E_WEAPON.code)).toBe(0)
    expect(h.countOf(p, P1.code)).toBe(4)
  })

  it('failure at +4 resets to +0; the elixir and the powder are consumed; nothing is destroyed by default', () => {
    const h = setup({ alchemyRate: 0 }) // 0 %
    const { p, inbox, sword, el, pw } = kit(h, 4)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
    h.advance(3100)
    expect(results(h, inbox)).toEqual([{ t: 'alchemyResult', item: sword, code: SWORD.code, outcome: 'fail', plus: 0 }])
    expect(h.bag(p)[sword]).toMatchObject({ code: SWORD.code, plus: 0 })
    expect(h.countOf(p, E_WEAPON.code)).toBe(0)
    expect(h.countOf(p, P1.code)).toBe(4)
  })

  it('ALCHEMY_DESTROY 1: a failure from +5 may destroy the item (10 %); below +5 never', () => {
    expect(DESTROY_CHANCE).toBe(0.1)
    const h = setup({ alchemyRate: 0, alchemyDestroy: 1 })
    ;(h.gameplay as unknown as { rng: () => number }).rng = () => 0 // every roll lands low: fail, then destroy
    const { p, inbox, sword, el } = kit(h, 5)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    h.advance(3100)
    expect(results(h, inbox).at(-1)).toMatchObject({ outcome: 'fail', plus: 0 })
    expect(h.bag(p)[sword]).toBeNull()
    // The slot empties in the inventoryUpdate before the result (the client says "destroyed" from that).
    expect(h.of(inbox, 'inventoryUpdate').at(-1)!.bag).toContainEqual({ slot: sword, item: null })
    const b = kit(h, 4)
    expect(h.req(b.p, b.inbox, { t: 'alchemyReinforce', item: b.sword, elixir: b.el })).toMatchObject({ ok: true })
    h.advance(3100)
    expect(h.bag(b.p)[b.sword]).toMatchObject({ code: SWORD.code, plus: 0 })
  })

  it('without a powder only the elixir is taken; ALCHEMY_FUSE_MS 0 finishes at once', () => {
    const h = setup({ alchemyRate: 10, alchemyFuseMs: 0 })
    const { p, inbox, sword, el } = kit(h, 2)
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    expect(since(inbox, from).map((m) => m.t)).toEqual(['actionResult', 'alchemyStart', 'inventoryUpdate', 'alchemyResult'])
    expect(h.bag(p)[sword]).toMatchObject({ plus: 3 })
    expect(h.countOf(p, P1.code)).toBe(5)
  })

  it('a +3 sword adds 3 x perPlus to the attack numbers in stats', () => {
    const h = setup({ alchemyRate: 10, alchemyFuseMs: 0 })
    const { p, inbox, sword, el } = kit(h, 2)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'itemEquip', bag: sword })).toMatchObject({ ok: true })
    const s = h.gameplay.stats(p)
    const worn = [{ def: SWORD, stack: { code: SWORD.code, count: 1, plus: 3 } }]
    const want = playerCombatStats(p.progress.level, p.progress.str, p.progress.int, worn)
    const plain = playerCombatStats(p.progress.level, p.progress.str, p.progress.int, [{ def: SWORD, stack: { code: SWORD.code, count: 1 } }])
    expect(s.physAttack).toEqual(want.physAttack)
    expect(want.physAttack[0] - plain.physAttack[0]).toBe(Math.round(20 + 7.2) - 20)
    expect(want.physAttack[1] - plain.physAttack[1]).toBe(Math.round(30 + 7.2) - 30)
  })

  it('a success from ALCHEMY_ANNOUNCE_FROM is announced to every player; below it is not', () => {
    const h = setup({ alchemyRate: 10, alchemyFuseMs: 0 })
    const other = h.enter([-300, 0, -300])
    const { p, inbox, sword, el } = kit(h, 6)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    const line = `${p.name} enhanced ${SWORD.name} to +7!`
    expect(h.of(other.inbox, 'chat').map((c) => c.text)).toContain(line)
    expect(h.of(inbox, 'chat').map((c) => c.text)).toContain(line)
    const b = kit(h, 5)
    expect(h.req(b.p, b.inbox, { t: 'alchemyReinforce', item: b.sword, elixir: b.el })).toMatchObject({ ok: true })
    expect(h.of(other.inbox, 'chat').filter((c) => /enhanced/.test(c.text))).toHaveLength(1)
  })
})

describe('cancels (§4.4 step 3): nothing is consumed', () => {
  function started(h: NpcHarness) {
    const k = kit(h, 3)
    expect(h.req(k.p, k.inbox, { t: 'alchemyReinforce', item: k.sword, elixir: k.el, powder: k.pw })).toMatchObject({ ok: true })
    return k
  }
  const untouched = (h: NpcHarness, p: Player, sword: number) => {
    expect(h.bag(p)[sword]).toMatchObject({ code: SWORD.code, plus: 3 })
    expect(h.countOf(p, E_WEAPON.code)).toBe(1)
    expect(h.countOf(p, P1.code)).toBe(5)
  }
  const cancelledOnce = (h: NpcHarness, inbox: ServerMessage[], sword: number) =>
    expect(results(h, inbox)).toEqual([{ t: 'alchemyResult', item: sword, code: SWORD.code, outcome: 'cancelled', plus: 3 }])

  it('alchemyCancel', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword } = started(h)
    h.advance(1000)
    expect(h.req(p, inbox, { t: 'alchemyCancel' })).toMatchObject({ ok: true })
    h.advance(3000)
    cancelledOnce(h, inbox, sword)
    untouched(h, p, sword)
    // A second cancel (nothing running) is harmless.
    expect(h.req(p, inbox, { t: 'alchemyCancel' })).toMatchObject({ ok: true })
    expect(results(h, inbox)).toHaveLength(1)
  })

  it('a moveTo', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword } = started(h)
    h.advance(500)
    expect(h.gameplay.onMoveTo(p, h.now())).toBe(true)
    h.advance(3000)
    cancelledOnce(h, inbox, sword)
    untouched(h, p, sword)
  })

  it('an attack request (auto-attack is p.action) and a pickup walk', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword } = started(h)
    const m: Mob = h.gameplay.createMob(MANGNYANG, 'normal', 230, 230, 0, null, h.now())
    p.known.add(m.id)
    expect(h.req(p, inbox, { t: 'attack', target: m.id })).toMatchObject({ ok: true })
    h.advance(3000)
    cancelledOnce(h, inbox, sword)
    untouched(h, p, sword)
  })

  it('death and a warp', () => {
    const h = setup({ alchemyRate: 10 })
    const a = started(h)
    const m: Mob = h.gameplay.createMob(MANGNYANG, 'normal', 201, 201, 0, null, h.now())
    h.gameplay.dealHits(m, a.p, [{ outcome: 'hit', damage: 999999, hp: 0 }], {}, h.now())
    expect(a.p.dead).toBe(true)
    cancelledOnce(h, a.inbox, a.sword)
    untouched(h, a.p, a.sword)
    const b = started(h)
    h.gameplay.warped(b.p, 'gm', h.now())
    h.advance(3100)
    cancelledOnce(h, b.inbox, b.sword)
    untouched(h, b.p, b.sword)
  })

  it('the finish re-checks the slots: an elixir that left its slot ends cancelled and nothing is taken', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword, el } = started(h)
    // Straight into the database (no request reaches the module): only the finish can notice.
    const free = h.bag(p).findIndex((i) => !i)
    h.edit(p, (d) => {
      d.setBag(free, d.bag[el])
      d.setBag(el, null)
    })
    h.advance(3100)
    cancelledOnce(h, inbox, sword)
    untouched(h, p, sword)
  })

  it('the item swapped for another +3 of the same code during the fuse is re-checked (plus and code)', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword } = started(h)
    h.edit(p, (d) => d.setBag(sword, { ...d.bag[sword]!, plus: 1 }))
    h.advance(3100)
    expect(results(h, inbox)).toEqual([{ t: 'alchemyResult', item: sword, code: SWORD.code, outcome: 'cancelled', plus: 3 }])
    expect(h.bag(p)[sword]).toMatchObject({ plus: 1 })
    expect(h.countOf(p, E_WEAPON.code)).toBe(1)
  })

  it('logout drops the fuse silently', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword } = started(h)
    h.gameplay.forget(p)
    expect(h.gameplay.alchemy.fusing(p)).toBeNull()
    h.advance(3100)
    expect(results(h, inbox)).toEqual([])
    untouched(h, p, sword)
  })
})

describe('D44 soft lock while a fuse is pending', () => {
  it('the locked requests answer busy; moves still cancel; after the fuse they work again', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword, el, pw } = kit(h)
    const other = h.enter([203, 0, 200])
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
    const npc = h.npcByCode('NPC_CH_POTION').id
    const free = h.bag(p).findIndex((i) => !i)
    const probes = {
      tradeRequest: { t: 'tradeRequest', target: other.p.id },
      tradeRespond: { t: 'tradeRespond', from: other.p.id, accept: true },
      stallCreate: { t: 'stallCreate', title: 'Shop' },
      itemMove: { t: 'itemMove', from: el, to: free },
      itemSplit: { t: 'itemSplit', from: pw, to: free, count: 1 },
      itemEquip: { t: 'itemEquip', bag: sword },
      itemUnequip: { t: 'itemUnequip', slot: 'weapon' },
      itemDrop: { t: 'itemDrop', bag: el },
      shopSell: { t: 'shopSell', npc, bag: el },
      storageDeposit: { t: 'storageDeposit', npc, bag: el },
      repair: { t: 'repair', npc },
    } as const
    expect(new Set(Object.keys(probes))).toEqual(FUSE_LOCKED)
    for (const [t, msg] of Object.entries(probes)) {
      expect(h.req(p, inbox, msg as never), t).toMatchObject({ ok: false, reason: 'busy' })
    }
    // Nothing was touched, and the fuse still runs to its end.
    h.advance(3100)
    expect(results(h, inbox).map((r) => r.outcome)).toEqual(['success'])
    expect(h.req(p, inbox, { t: 'itemMove', from: sword, to: free })).toMatchObject({ ok: true })
  })

  it('a trade request during a fuse is busy (D44), then a moveTo cancels the fuse and nothing is consumed', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword, el, pw } = kit(h)
    const other = h.enter([203, 0, 200])
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'tradeRequest', target: other.p.id })).toMatchObject({ ok: false, reason: 'busy' })
    expect(h.gameplay.onMoveTo(p, h.now())).toBe(true)
    expect(results(h, inbox)).toEqual([{ t: 'alchemyResult', item: sword, code: SWORD.code, outcome: 'cancelled', plus: 0 }])
    expect(h.countOf(p, E_WEAPON.code)).toBe(1)
    expect(h.countOf(p, P1.code)).toBe(5)
    // Unlocked again: the trade request reaches the trade module (whatever it answers, not busy).
    expect(h.req(p, inbox, { t: 'tradeRequest', target: other.p.id })).not.toMatchObject({ reason: 'busy' })
  })

  it('potions and chat-free requests are not locked', () => {
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword, el } = kit(h)
    const potion = h.give(p, 'ITEM_ETC_HP_POTION_01', 3)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    p.hp = 1
    expect(h.req(p, inbox, { t: 'itemUse', bag: potion })).toMatchObject({ ok: true })
    expect(h.gameplay.alchemy.fusing(p)).not.toBeNull()
  })
})

describe('D51: the authored elixir drop', () => {
  const mobAt = (level: number) => ({ level }) as Mob

  it('about ELIXIR_DROP_PCT x DROP_RATE of 100,000 level-8 kills, weighted 40 / 40 / 10 / 10', () => {
    const h = setup({ dropRate: 2 })
    const counts = new Map<string, number>()
    let drops = 0
    for (let i = 0; i < 100_000; i++) {
      for (const d of h.gameplay.alchemy.extraDrops(mobAt(8))) {
        drops++
        expect(d.count).toBe(1)
        counts.set(d.code, (counts.get(d.code) ?? 0) + 1)
      }
    }
    // 0.8 % x 2 = 1.6 %: 1,600 expected; 4 sigma is about 160.
    expect(drops).toBeGreaterThan(1440)
    expect(drops).toBeLessThan(1760)
    for (const [code, w] of ELIXIR_DROP_WEIGHTS) expect((counts.get(code) ?? 0) / drops).toBeCloseTo(w / 100, 1)
  })

  it('none below ELIXIR_DROP_MIN_LEVEL, none at 0 %, and only exported elixirs', () => {
    const h = setup({ elixirDropPct: 100 })
    expect(h.gameplay.alchemy.extraDrops(mobAt(4))).toEqual([])
    expect(h.gameplay.alchemy.extraDrops(mobAt(5))).toHaveLength(1)
    const off = setup({ elixirDropPct: 0 })
    for (let i = 0; i < 1000; i++) expect(off.gameplay.alchemy.extraDrops(mobAt(20))).toEqual([])
    const bare = setup({ elixirDropPct: 100 }, [SWORD, E_ARMOR])
    for (let i = 0; i < 50; i++) expect(bare.gameplay.alchemy.extraDrops(mobAt(20))).toEqual([{ code: E_ARMOR.code, count: 1 }])
    const none = setup({ elixirDropPct: 100 }, [SWORD])
    expect(none.gameplay.alchemy.extraDrops(mobAt(20))).toEqual([])
  })

  it('a kill drops it on the ground like any loot (owned by the killer)', () => {
    const h = setup({ elixirDropPct: 100, elixirDropMinLevel: 1 })
    const { p } = h.enter(FIELD)
    const m = h.gameplay.createMob({ ...MANGNYANG, level: 8 }, 'normal', 206, 204, 0, null, h.now())
    p.known.add(m.id)
    h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: 999999, hp: 0 }], {}, h.now())
    const loot = [...h.world.items.values()]
    expect(loot.map((i) => i.code).filter((c) => c.startsWith('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_'))).toHaveLength(1)
  })
})

describe('GM plus', () => {
  it('sets the plus of a bag item or a worn item (stats follow); refuses bad input', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const sword = h.give(p, SWORD.code, 1)
    expect(h.gameplay.alchemy.gm(p, [String(sword), '7'])).toEqual({ ok: true, message: `${SWORD.name} is now +7.` })
    expect(h.bag(p)[sword]).toMatchObject({ plus: 7 })
    expect(h.of(inbox, 'inventoryUpdate').at(-1)).toMatchObject({ bag: [{ slot: sword, item: { code: SWORD.code, count: 1, plus: 7 } }] })
    expect(h.req(p, inbox, { t: 'itemEquip', bag: sword })).toMatchObject({ ok: true })
    const before = h.gameplay.stats(p).physAttack
    const from = inbox.length
    expect(h.gameplay.alchemy.gm(p, ['weapon', '0'])).toMatchObject({ ok: true })
    const stats = h.of(since(inbox, from), 'stats')
    expect(stats).toHaveLength(1)
    expect(stats[0]!.stats.physAttack[0]).toBeLessThan(before[0])
    for (const bad of [[], ['weapon'], ['weapon', '13'], ['weapon', '-1'], ['cape', '1'], ['x', '1'], ['0', '1', '2']]) {
      expect(h.gameplay.alchemy.gm(p, bad).ok, bad.join(' ')).toBe(false)
    }
    const potion = h.give(p, 'ITEM_ETC_HP_POTION_01', 1)
    expect(h.gameplay.alchemy.gm(p, [String(potion), '1'])).toMatchObject({ ok: false })
    const empty = h.bag(p).findIndex((i) => !i)
    expect(h.gameplay.alchemy.gm(p, [String(empty), '1'])).toMatchObject({ ok: false })
  })
})

describe('messages parse on the wire', () => {
  it('alchemyStart / alchemyResult are within the protocol bounds', async () => {
    const { parseServerMessage } = await import('@sro/shared')
    const h = setup({ alchemyRate: 10 })
    const { p, inbox, sword, el, pw } = kit(h)
    h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })
    h.advance(3100)
    for (const m of [...h.of(inbox, 'alchemyStart'), ...h.of(inbox, 'alchemyResult')] as (Msg<'alchemyStart'> | Msg<'alchemyResult'>)[]) {
      expect(parseServerMessage(JSON.stringify(m))).toEqual({ ok: true, msg: m })
    }
  })
})
