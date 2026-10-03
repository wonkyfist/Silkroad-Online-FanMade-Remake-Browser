/**
 * H8 adversarial hunt, lens "gate" (docs/WAVE_PLAN2.md §6.8): the wave-8 locks as one matrix, and D43–D52 as abuse
 * cases.
 *
 * - Every wave-7B and wave-8 request type (and the rest of GAMEPLAY_REQUESTS, and a client moveTo) in each locked state
 *   (trading, stalling, mounted, fuse pending) gets the answer the docs give it: SOCIAL §2.3 + WAVE_PLAN2 §6.5 for the
 *   social allowlists, D43 for the mount gate, D44 for the alchemy soft lock (with its cancellers).
 * - A request type added later is refused by default by the two allowlist locks (trade, stall).
 * - The §6.7 cross flows in a seeded random order, 1,000 iterations, with inventory invariants after every flow: no
 *   duplicated unique item (each sword carries a unique plus/durability pair as its id), gold conserved across trades
 *   and stall sales, and the `social_log` rows adding up to every character's gold and sword changes.
 *
 * `BUG:` tests fail on purpose until the product code is fixed (the abuse-party.test.ts convention).
 * Synthetic flat world with a controlled clock (npc-harness.ts).
 */
import { GAMEPLAY_REQUESTS, GUILD_REQUESTS, STALL_REQUESTS, TRADE_REQUESTS, type CosDef, type GameplayRequest, type ItemDef, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { GameData } from '../src/gamedata.ts'
import type { GameplayMessage } from '../src/gameplay.ts'
import type { Fail, InvItem } from '../src/inventory.ts'
import { askGates, type GameplayModule } from '../src/modules.ts'
import type { Player } from '../src/world.ts'
import { LEVELS, MANGNYANG, item, seeded } from './fixtures.ts'
import { NPC_DEFS, NPC_ITEMS, SHOP_DEFS, npcHarness, type Msg, type NpcHarness } from './npc-harness.ts'

// ---- content ---------------------------------------------------------------------------------------------------

const RED: CosDef = {
  code: 'COS_C_HORSE1', id: 2191, name: 'Red Horse', level: 20, hp: 983, walkSpeed: 4.5, runSpeed: 9, radius: 1.2,
  physAbsorb: 20, magAbsorb: 20, parryRate: 65, hitRate: 65, model: null, icon: null,
}
const HORSE = item('ITEM_COS_C_HORSE1', { category: 'scroll', maxStack: 50, reqLevel: 10, price: 1200, sellPrice: 360, use: { summon: 'COS_C_HORSE1' } })
const KIT = item('ITEM_ETC_COS_HP_POTION_01', { category: 'potion', maxStack: 50, price: 190, use: { hp: 360, cooldownGroup: 'cos_hp', cooldownMs: 1000, target: 'mount' } })
const SWORD = item('ITEM_CH_SWORD_01_A', {
  category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 1, reqLevel: 1, race: 'china', typeId: [3, 1, 6, 2], range: 1.5,
  stats: { physAttack: [20, 30], magAttack: [10, 14], durability: [62, 76] }, perPlus: { physAttack: 2.4, magAttack: 4.1 },
})
const ELIXIR = item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', {
  category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, maxStack: 1, price: 50000,
  reinforce: { kind: 'elixir', targets: [6], rates: [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5] },
})
const POWDER = item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01', {
  category: 'alchemy', typeId: [3, 3, 10, 2], degree: 1, maxStack: 50,
  reinforce: { kind: 'powder', degree: 1, rates: [50, 30, 20, 8, 8, 8, 8, 8, 8, 8, 8, 8] },
})
const POTION = 'ITEM_ETC_HP_POTION_01'
const EXTRA: ItemDef[] = [HORSE, KIT, SWORD, ELIXIR, POWDER]

/** Far from town (0,0,0) and every NPC of NPC_DEFS. */
const FIELD: [number, number, number] = [200, 0, 200]

/** The +N and durability a buyer saw, in stallBuy's ItemStack convention (absent = 0 / full; SOC-1). */
const seenStack = (it: { plus: number; durability: number | null }): { plus?: number; durability?: number } => ({
  ...(it.plus ? { plus: it.plus } : {}),
  ...(it.durability !== null ? { durability: it.durability } : {}),
})

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})

interface P {
  p: Player
  inbox: ServerMessage[]
}

function setup(seed = 11) {
  const data = new GameData({ mobs: [MANGNYANG], items: [...NPC_ITEMS, ...EXTRA], levels: LEVELS, drops: [], npcs: NPC_DEFS, shops: SHOP_DEFS, towns: [] })
  // Stalls in the synthetic field (no town safe area here); a fast fuse keeps the random run short.
  const h = npcHarness({ data, config: { stallTownOnly: 0, rng: seeded(seed) } })
  harnesses.push(h)
  h.gameplay.mounts.defs.set(RED.code, RED)
  const g = h.gameplay
  const errors: string[] = []
  const all: P[] = []
  /** A level-10 character near FIELD; every player knows every other (interest is not under test). */
  const enter = (dx = 0, dz = 0): P => {
    const e = h.enter([FIELD[0] + dx, 0, FIELD[2] + dz])
    e.p.progress = { ...e.p.progress, level: 10 }
    for (const q of all) {
      q.p.known.add(e.p.id)
      e.p.known.add(q.p.id)
    }
    all.push(e)
    return e
  }
  const req = (x: P, msg: GameplayMessage) => h.req(x.p, x.inbox, msg)
  /** The combined gate verdict for `t` of `p`, exactly as Gameplay asks it (own handles exempt; moveTo: no owner). */
  const gate = (p: Player, t: GameplayRequest | 'moveTo'): Fail | null => {
    const own = t === 'moveTo' ? null : g.routes.get(t)
    return askGates(g.modules, own, p, t, h.now(), (e, where) => errors.push(`${where}: ${String(e)}`))
  }
  const slot = (p: Player, code: string, from = 0) => h.bag(p).findIndex((it, i) => i >= from && it?.code === code)
  return { h, g, enter, req, gate, errors, slot, all }
}
type S = ReturnType<typeof setup>

/** a asks b, b accepts: an open exchange. */
function openTrade(s: S, a: P, b: P) {
  expect(s.req(a, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: true })
  expect(s.req(b, { t: 'tradeRespond', from: a.p.id, accept: true })).toMatchObject({ ok: true })
  expect(s.g.trade.isTrading(a.p)).toBe(true)
}

/** A sword, an elixir and a powder in the bag, then alchemyReinforce: a pending fuse. */
function startFuse(s: S, x: P) {
  let sword = s.slot(x.p, SWORD.code)
  if (sword < 0) sword = s.h.give(x.p, SWORD.code, 1, { durability: 70 })
  let el = s.slot(x.p, ELIXIR.code)
  if (el < 0) el = s.h.give(x.p, ELIXIR.code, 1)
  let pw = s.slot(x.p, POWDER.code)
  if (pw < 0) pw = s.h.give(x.p, POWDER.code, 5)
  expect(s.req(x, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
  expect(s.g.alchemy.fusing(x.p)).not.toBeNull()
}

function mount(s: S, x: P) {
  let horse = s.slot(x.p, HORSE.code)
  if (horse < 0) horse = s.h.give(x.p, HORSE.code, 5)
  expect(s.req(x, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
  expect(s.g.mounts.ridden(x.p)).not.toBeNull()
}

function stall(s: S, x: P) {
  expect(s.req(x, { t: 'stallCreate', title: 'Gate test' })).toMatchObject({ ok: true })
  expect(s.g.stalls.stallOf(x.p)).toBeDefined()
}

// ---- the documented answers ------------------------------------------------------------------------------------

const PARTY: GameplayRequest[] = ['partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings']
const GUILD_NOT_CREATE = GUILD_REQUESTS.filter((t) => t !== 'guildCreate')
const COMMON: GameplayRequest[] = ['stopAction', 'hotbarSet', 'statUp', 'skillLearn', 'masteryUp', 'buffCancel', ...PARTY, ...GUILD_NOT_CREATE]

/** SOCIAL §2.3 + WAVE_PLAN2 §6.5, trade row "Allowed" (plus trade* itself, which the gate never sees; + jump, MOVEMENT §4.3). */
const TRADE_DOC_ALLOWED = new Set<GameplayRequest>([...COMMON, 'storageOpen', 'npcClose', 'emote', 'mountDismiss', 'jump', ...TRADE_REQUESTS])
/**
 * Not in either table, allowed on purpose by TR-S (trade.ts: "a visitor who accepted a trade must be able to close that
 * window"). It touches no bag; recorded as a tolerated extension rather than a finding.
 */
const TRADE_CODE_EXTRA = new Set<GameplayRequest>(['stallLeave'])
/** "Ends the state instead": the gate ends the trade and lets the request through. */
const TRADE_DOC_BREAKERS = new Set<GameplayRequest>(['attack', 'useSkill', 'npcTalk'])
/** Stall row: COMMON + stall* (own) + mountDismiss; everything else (moveTo included) → stalling. */
const STALL_DOC_ALLOWED = new Set<GameplayRequest>([...COMMON, 'mountDismiss', ...STALL_REQUESTS])
/** D43 (+ the wave-10 jump, docs/MOVEMENT.md §4.3). */
const MOUNT_DOC_REFUSED = new Set<GameplayRequest>(['sit', 'emote', 'stallCreate', 'alchemyReinforce', 'berserk', 'jump'])
/** D44. */
const FUSE_DOC_BUSY = new Set<GameplayRequest>(['tradeRequest', 'tradeRespond', 'stallCreate', 'itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemDrop', 'shopSell', 'storageDeposit', 'repair'])
/** COMBAT §4.4 step 3 (+ pickup, alchemy.ts header): cancel the fuse and go through. */
const FUSE_DOC_CANCELLERS = new Set<GameplayRequest | 'moveTo'>(['moveTo', 'attack', 'useSkill', 'npcTalk', 'pickup'])

/** Every request type the client can send that goes through the gate (respawn is answered before it). */
const TYPES: (GameplayRequest | 'moveTo')[] = [...GAMEPLAY_REQUESTS.filter((t) => t !== 'respawn'), 'moveTo']
const W7B_W8 = new Set<string>(['sit', 'emote', 'mountRide', 'mountDismount', 'mountDismiss', 'repair', 'alchemyReinforce', 'alchemyCancel', 'berserk', ...TRADE_REQUESTS, ...STALL_REQUESTS, ...GUILD_REQUESTS])

describe('gate matrix: every request type in each locked state (§6.8 "Gate")', () => {
  it('the matrix covers all 7B / wave-8 types and nothing is left out of GAMEPLAY_REQUESTS', () => {
    for (const t of W7B_W8) expect(TYPES, t).toContain(t)
    expect(new Set(TYPES).size).toBe(TYPES.length)
  })

  it('trading: the doc allowlist passes, attack/useSkill/npcTalk end the trade and pass, everything else is `trading`', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(2)
    const wrong: string[] = []
    for (const t of TYPES) {
      if (!s.g.trade.isTrading(a.p)) {
        s.h.advance(50)
        openTrade(s, a, b)
      }
      const v = s.gate(a.p, t)
      const ended = !s.g.trade.isTrading(a.p)
      let want: string
      if (t === 'moveTo') want = 'pass' // ended by the `moved` hook once accepted
      else if (TRADE_DOC_BREAKERS.has(t)) want = 'pass+ended'
      else if (TRADE_DOC_ALLOWED.has(t) || TRADE_CODE_EXTRA.has(t)) want = 'pass'
      else want = 'trading'
      const got = v ? v.reason : ended ? 'pass+ended' : 'pass'
      if (got !== want) wrong.push(`${t}: want ${want}, got ${got}`)
    }
    expect(wrong).toEqual([])
    expect(s.errors).toEqual([])
  })

  it('stalling: the doc allowlist passes, everything else (moveTo included) is `stalling`, and nothing ends the stall', () => {
    const s = setup()
    const a = s.enter()
    stall(s, a)
    const wrong: string[] = []
    for (const t of TYPES) {
      const v = s.gate(a.p, t)
      const want = t !== 'moveTo' && STALL_DOC_ALLOWED.has(t) ? 'pass' : 'stalling'
      const got = v ? v.reason : 'pass'
      if (got !== want) wrong.push(`${t}: want ${want}, got ${got}`)
    }
    expect(wrong).toEqual([])
    expect(s.g.stalls.stallOf(a.p)).toBeDefined()
    expect(s.errors).toEqual([])
  })

  it('mounted (D43): sit, emote, stallCreate, alchemyReinforce, berserk are `mounted`; tradeRequest / tradeRespond pass', () => {
    const s = setup()
    const a = s.enter()
    mount(s, a)
    const wrong: string[] = []
    for (const t of TYPES) {
      const v = s.gate(a.p, t)
      const want = t !== 'moveTo' && MOUNT_DOC_REFUSED.has(t) ? 'mounted' : 'pass'
      const got = v ? v.reason : 'pass'
      if (got !== want) wrong.push(`${t}: want ${want}, got ${got}`)
    }
    expect(wrong).toEqual([])
    expect(s.g.mounts.ridden(a.p)).not.toBeNull()
    expect(s.errors).toEqual([])
  })

  it('fuse pending (D44): the D44 list is `busy`, the cancellers cancel and pass, everything else passes with the fuse kept', () => {
    const s = setup()
    const a = s.enter()
    const wrong: string[] = []
    for (const t of TYPES) {
      if (!s.g.alchemy.fusing(a.p)) startFuse(s, a)
      const v = s.gate(a.p, t)
      const cancelled = !s.g.alchemy.fusing(a.p)
      let want: string
      if (FUSE_DOC_CANCELLERS.has(t)) want = 'pass+cancelled'
      else if (t !== 'moveTo' && FUSE_DOC_BUSY.has(t)) want = 'busy'
      else want = 'pass'
      const got = v ? v.reason : cancelled ? 'pass+cancelled' : 'pass'
      if (got !== want) wrong.push(`${t}: want ${want}, got ${got}`)
    }
    expect(wrong).toEqual([])
    expect(s.errors).toEqual([])
  })

  it('the request-level answers of the locked states (the gate result reaches the actionResult)', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(2)
    const c = s.enter(-2)
    // trading: D45 / D46 and the 7B / wave-8 siblings.
    openTrade(s, a, b)
    for (const t of ['alchemyReinforce', 'alchemyCancel', 'repair', 'mountRide', 'mountDismount', 'berserk', 'sit', 'stallCreate', 'stallVisit', 'stallBuy', 'guildCreate', 'itemUse', 'pickup'] as const) {
      const frame = FRAMES[t]
      expect(s.req(a, frame), t).toMatchObject({ ok: false, reason: 'trading' })
    }
    expect(s.req(a, { t: 'emote', emote: 'hi' })).toMatchObject({ ok: true })
    expect(s.g.trade.isTrading(a.p)).toBe(true)
    expect(s.req(a, { t: 'tradeCancel' })).toMatchObject({ ok: true })
    // stalling: the owner cannot visit or buy elsewhere either (the stall module answers for its own types).
    stall(s, c)
    expect(s.req(c, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: false })
    for (const t of ['sit', 'emote', 'repair', 'alchemyReinforce', 'mountRide', 'mountDismount', 'berserk', 'tradeRequest', 'npcTalk', 'attack', 'useSkill', 'itemUse'] as const) {
      expect(s.req(c, FRAMES[t]), t).toMatchObject({ ok: false, reason: 'stalling' })
    }
    // fuse pending: tradeRequest busy, moveTo cancels, nothing consumed (flow 4).
    startFuse(s, b)
    const before = JSON.stringify(s.h.bag(b.p))
    expect(s.req(b, { t: 'tradeRequest', target: a.p.id })).toMatchObject({ ok: false, reason: 'busy' })
    // an invitee who is fusing: the requester is told `busy` (the trade module asks the invitee's gates).
    expect(s.req(a, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: false, reason: 'busy' })
    expect(s.g.onMoveTo(b.p, s.h.now())).toBe(true)
    expect(s.g.alchemy.fusing(b.p)).toBeNull()
    expect(JSON.stringify(s.h.bag(b.p))).toBe(before)
  })
})

/** One minimal valid frame per request type used above. */
const FRAMES: Record<string, GameplayMessage> = {
  alchemyReinforce: { t: 'alchemyReinforce', item: 0, elixir: 1 },
  alchemyCancel: { t: 'alchemyCancel' },
  repair: { t: 'repair', npc: 1 },
  mountRide: { t: 'mountRide', cos: 1 },
  mountDismount: { t: 'mountDismount' },
  berserk: { t: 'berserk' },
  sit: { t: 'sit', on: true },
  emote: { t: 'emote', emote: 'hi' },
  stallCreate: { t: 'stallCreate', title: '' },
  stallVisit: { t: 'stallVisit', owner: 1 },
  stallBuy: { t: 'stallBuy', owner: 1, slot: 0, code: 'X', count: 1, price: 1 },
  guildCreate: { t: 'guildCreate', npc: 1, name: 'Tigers' },
  itemUse: { t: 'itemUse', bag: 0 },
  pickup: { t: 'pickup', id: 1 },
  tradeRequest: { t: 'tradeRequest', target: 1 },
  npcTalk: { t: 'npcTalk', npc: 1 },
  attack: { t: 'attack', target: 1 },
  useSkill: { t: 'useSkill', skill: 'SKILL_X' },
}

describe('a request type added later (allowlist locks, SOCIAL §2.3)', () => {
  it('trading and stalling refuse an unknown future type, core-routed or module-routed; mounted and fuse do not lock it', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(2)
    const c = s.enter(-2)
    const future = 'futureBagSwap' as GameplayRequest
    const futureMod: GameplayModule = { name: 'future', handles: [future], request: (_p, _m, answer) => answer(true) }
    // As the core would route it (no owner) ...
    openTrade(s, a, b)
    stall(s, c)
    expect(askGates(s.g.modules, null, a.p, future, s.h.now(), () => {})).toMatchObject({ reason: 'trading' })
    expect(askGates(s.g.modules, null, c.p, future, s.h.now(), () => {})).toMatchObject({ reason: 'stalling' })
    // ... and as a new module that handles it (its own gate exempt, the social gates still asked).
    const mods = [...s.g.modules, futureMod]
    expect(askGates(mods, futureMod, a.p, future, s.h.now(), () => {})).toMatchObject({ reason: 'trading' })
    expect(askGates(mods, futureMod, c.p, future, s.h.now(), () => {})).toMatchObject({ reason: 'stalling' })
    const d = s.enter(4)
    mount(s, d)
    expect(askGates(mods, futureMod, d.p, future, s.h.now(), () => {})).toBeNull()
  })
})

describe('D43–D52 abuse cases', () => {
  it('D49: the cos entity is never an item, a trade partner, a stall or an attack target', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(2)
    mount(s, b)
    const cos = s.g.mounts.horseOf(b.p)!.id
    a.p.known.add(cos)
    expect(s.req(a, { t: 'pickup', id: cos })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(s.req(a, { t: 'tradeRequest', target: cos })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(s.req(a, { t: 'stallVisit', owner: cos })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(s.req(a, { t: 'attack', target: cos })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(s.req(a, { t: 'mountRide', cos })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('D49: summon and ride while berserk are berserk_active; berserk while mounted is mounted', () => {
    const s = setup()
    const a = s.enter()
    s.g.berserk.gm(a.p, ['5'])
    expect(s.req(a, { t: 'berserk' })).toMatchObject({ ok: true })
    const horse = s.h.give(a.p, HORSE.code, 2)
    expect(s.req(a, { t: 'itemUse', bag: horse })).toMatchObject({ ok: false, reason: 'berserk_active' })
    s.g.berserk.end(a.p)
    mount(s, a)
    s.g.berserk.gm(a.p, ['5'])
    expect(s.req(a, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'mounted' })
  })

  it('D52: a Recovery Kit sends itemEffect with the horse id to a viewer; refused while trading or stalling', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(2)
    mount(s, a)
    const cos = s.g.mounts.horseOf(a.p)!
    cos.hp = 100
    const kit = s.h.give(a.p, KIT.code, 3)
    const from = b.inbox.length
    expect(s.req(a, { t: 'itemUse', bag: kit })).toMatchObject({ ok: true })
    expect(b.inbox.slice(from).filter((m) => m.t === 'itemEffect')).toEqual([{ t: 'itemEffect', id: cos.id, item: KIT.code }])
    s.h.advance(1100)
    openTrade(s, a, b)
    expect(s.req(a, { t: 'itemUse', bag: kit })).toMatchObject({ ok: false, reason: 'trading' })
  })

  it('D48 / D47 flow 3: a broken sword listed and bought arrives broken; itemEquip then answers broken', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(2)
    s.h.setGold(b.p, 10_000)
    const bag = s.h.give(a.p, SWORD.code, 1, { plus: 3, durability: 0 })
    stall(s, a)
    expect(s.req(a, { t: 'stallItem', slot: 0, bag, count: 1, price: 777 })).toMatchObject({ ok: true })
    expect(s.req(a, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    expect(s.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    // The buyer names the +3 and the durability 0 it saw (SOC-1: the purchase is bound to the exact item).
    expect(s.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: SWORD.code, count: 1, plus: 3, durability: 0, price: 777 })).toMatchObject({ ok: true })
    const got = s.slot(b.p, SWORD.code)
    expect(s.h.bag(b.p)[got]).toMatchObject({ plus: 3, durability: 0 })
    expect(s.req(b, { t: 'itemEquip', bag: got })).toMatchObject({ ok: false, reason: 'broken' })
    expect(s.req(b, { t: 'alchemyReinforce', item: got, elixir: s.h.give(b.p, ELIXIR.code, 1) })).toMatchObject({ ok: false, reason: 'broken' })
  })

  it('BUG: D43 — mounting a horse mid-fuse (itemUse summon) leaves the fuse running, and it resolves while mounted', () => {
    const s = setup()
    const a = s.enter()
    startFuse(s, a)
    const horse = s.h.give(a.p, HORSE.code, 2)
    // The documented answers: alchemyReinforce while mounted is `mounted` (D43, COMBAT §4.4 step 1), and the summon
    // "stops the player" like a skill start. Either the summon is refused while fusing or it ends the fuse.
    const r = s.req(a, { t: 'itemUse', bag: horse })
    const mountedWithFuse = r.ok && s.g.mounts.ridden(a.p) !== null && s.g.alchemy.fusing(a.p) !== null
    s.h.advance(3500)
    const res = s.h.of(a.inbox, 'alchemyResult').at(-1)
    expect({ mountedWithFuse, resolvedWhileMounted: res !== undefined && res.outcome !== 'cancelled' && s.g.mounts.ridden(a.p) !== null }).toEqual({
      mountedWithFuse: false,
      resolvedWhileMounted: false,
    })
  })

  it('BUG: D43 — boarding a parked horse mid-fuse (mountRide within 2 m) keeps the fuse, which then resolves on horseback', () => {
    const s = setup()
    const a = s.enter()
    mount(s, a)
    s.h.advance(100)
    expect(s.req(a, { t: 'mountDismount' })).toMatchObject({ ok: true })
    const cos = s.g.mounts.horseOf(a.p)!
    startFuse(s, a)
    const r = s.req(a, { t: 'mountRide', cos: cos.id })
    const mountedWithFuse = r.ok && s.g.mounts.ridden(a.p) !== null && s.g.alchemy.fusing(a.p) !== null
    s.h.advance(3500)
    const res = s.h.of(a.inbox, 'alchemyResult').at(-1)
    expect({ mountedWithFuse, resolvedWhileMounted: res !== undefined && res.outcome !== 'cancelled' && s.g.mounts.ridden(a.p) !== null }).toEqual({
      mountedWithFuse: false,
      resolvedWhileMounted: false,
    })
  })
})

// ---- cross-system item states: the §6.7 flows in a seeded random order ------------------------------------------

type LogItem = { code: string; count: number; plus?: number; durability?: number }

describe('cross-system item states: §6.7 flows in seeded random order, 1,000 iterations (D43–D52)', () => {
  it('no duplicated sword, gold conserved, social_log adds up to every change, every flow gets its documented answer', () => {
    const s = setup(5)
    const rng = seeded(8008)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!
    const HOME: [number, number][] = [[0, 0], [2, 0], [-2, 0]]
    const ps = HOME.map(([dx, dz]) => s.enter(dx, dz))
    const START_GOLD = 1_000_000
    // Unique swords: plus/durability is the identity (no alchemy success and no combat wear in this run).
    let nextKey = 0
    const mint = (x: P, broken: boolean) => {
      const plus = 1 + (nextKey % 9)
      const durability = broken ? 0 : 1 + Math.floor(nextKey / 9)
      nextKey++
      s.h.give(x.p, SWORD.code, 1, { plus, durability })
    }
    for (const x of ps) {
      s.h.setGold(x.p, START_GOLD)
      for (let i = 0; i < 5; i++) mint(x, i === 4)
      s.h.give(x.p, POTION, 40)
      s.h.give(x.p, HORSE.code, 50)
      s.h.give(x.p, KIT.code, 50)
      s.h.give(x.p, ELIXIR.code, 1)
      s.h.give(x.p, POWDER.code, 10)
    }
    const key = (it: { plus?: number; durability?: number | null }) => `${it.plus ?? 0}/${it.durability ?? null}`
    const swordsOf = (x: P) => {
      const inv = s.h.store.loadInventory(x.p.characterId)
      return [...inv.bag, ...Object.values(inv.equip)].filter((it): it is InvItem => !!it && it.code === SWORD.code).map(key).sort()
    }
    const potionsOf = (x: P) => s.h.countOf(x.p, POTION)
    const goldOf = (x: P) => s.h.store.loadInventory(x.p.characterId).gold
    const initial = new Map(ps.map((x) => [x.p.characterId, { swords: swordsOf(x), potions: potionsOf(x), gold: goldOf(x) }]))
    const everySword = ps.flatMap(swordsOf).sort()
    expect(new Set(everySword).size).toBe(everySword.length)

    const violations: string[] = []
    const check = (where: string) => {
      const now = ps.flatMap(swordsOf).sort()
      if (JSON.stringify(now) !== JSON.stringify(everySword)) violations.push(`${where}: sword set ${now.length} vs ${everySword.length}`)
      const total = ps.reduce((n, x) => n + goldOf(x), 0)
      if (total !== START_GOLD * ps.length) violations.push(`${where}: gold ${total}`)
      // Replay social_log per character.
      const rows = s.h.store.db.prepare('SELECT kind, a_char, b_char, a_gold, b_gold, a_items, b_items FROM social_log ORDER BY id').all() as {
        kind: string
        a_char: number
        b_char: number
        a_gold: number
        b_gold: number
        a_items: string
        b_items: string
      }[]
      for (const x of ps) {
        const id = x.p.characterId
        const base = initial.get(id)!
        let gold = base.gold
        let potions = base.potions
        const swords = [...base.swords]
        for (const r of rows) {
          const side = r.a_char === id ? 'a' : r.b_char === id ? 'b' : null
          if (!side) continue
          const gave = JSON.parse(side === 'a' ? r.a_items : r.b_items) as LogItem[]
          const got = JSON.parse(side === 'a' ? r.b_items : r.a_items) as LogItem[]
          gold += side === 'a' ? r.b_gold - r.a_gold : r.a_gold - r.b_gold
          for (const it of gave) {
            if (it.code === POTION) potions -= it.count
            if (it.code === SWORD.code) {
              const i = swords.indexOf(key(it))
              if (i < 0) violations.push(`${where}: the log says ${x.p.name} gave a sword it never had`)
              else swords.splice(i, 1)
            }
          }
          for (const it of got) {
            if (it.code === POTION) potions += it.count
            if (it.code === SWORD.code) swords.push(key(it))
          }
        }
        if (gold !== goldOf(x)) violations.push(`${where}: ${x.p.name} gold ${goldOf(x)} but the log says ${gold}`)
        if (potions !== potionsOf(x)) violations.push(`${where}: ${x.p.name} potions ${potionsOf(x)} but the log says ${potions}`)
        if (JSON.stringify(swords.sort()) !== JSON.stringify(swordsOf(x))) violations.push(`${where}: ${x.p.name} swords differ from the log`)
      }
    }
    const answers: string[] = []
    const expectReason = (where: string, r: Msg<'actionResult'>, want: string | true) => {
      const got = r.ok ? true : r.reason
      if (got !== want) answers.push(`${where}: want ${String(want)}, got ${String(got)} (${r.ok ? '' : (r.message ?? '')})`)
    }
    const send = (x: P, msg: GameplayMessage) => s.h.req(x.p, x.inbox, msg)
    /** Quietly ends every lock and puts everyone home, standing, with no horse and no berserk. */
    const reset = () => {
      for (const x of ps) {
        s.g.request(x.p, { t: 'tradeCancel' }, s.h.now())
        if (s.g.stalls.stallOf(x.p)) s.g.request(x.p, { t: 'stallClose' }, s.h.now())
        s.g.request(x.p, { t: 'stallLeave' }, s.h.now())
        s.g.alchemy.cancel(x.p)
        if (s.g.mounts.horseOf(x.p)) s.g.request(x.p, { t: 'mountDismiss' }, s.h.now())
        s.g.berserk.end(x.p)
      }
      s.h.advance(1100)
      ps.forEach((x, i) => {
        s.h.world.halt(x.p, s.h.now())
        x.p.action = null
        x.p.pos = [FIELD[0] + HOME[i]![0], 0, FIELD[2] + HOME[i]![1]]
        s.g.posture.standUp(x.p)
      })
    }
    /** Untracked consumables (horses, kits, elixirs, powders) may have been traded or sold away by the noise. */
    const ensure = (x: P, code: string) => {
      const at = s.slot(x.p, code)
      return at >= 0 ? at : s.h.give(x.p, code, code === ELIXIR.code ? 1 : 10)
    }
    const slotOfKey = (x: P, k: string) => s.h.bag(x.p).findIndex((it) => it?.code === SWORD.code && key(it) === k)
    const anySword = (x: P) => {
      const idx = s.h.bag(x.p).map((it, i) => (it?.code === SWORD.code ? i : -1)).filter((i) => i >= 0)
      return idx.length ? pick(idx) : -1
    }

    const FLOWS: Record<string, (x: P, y: P) => void> = {
      // 2: trade a +N sword with durability; a repair mid-window is `trading` (D46); it arrives unchanged (D47).
      trade(x, y) {
        const bag = anySword(x)
        if (bag < 0) return
        const k = key(s.h.bag(x.p)[bag]!)
        expectReason('trade.request', send(x, { t: 'tradeRequest', target: y.p.id }), true)
        expectReason('trade.respond', send(y, { t: 'tradeRespond', from: x.p.id, accept: true }), true)
        expectReason('trade.offer', send(x, { t: 'tradeOffer', bag }), true)
        const gold = Math.floor(rng() * 5000)
        if (gold) expectReason('trade.gold', send(y, { t: 'tradeGold', amount: gold }), true)
        const pot = s.slot(y.p, POTION)
        if (pot >= 0 && rng() < 0.5) expectReason('trade.potions', send(y, { t: 'tradeOffer', bag: pot, count: 1 }), true)
        expectReason('trade.repair', send(x, { t: 'repair', npc: 1 }), 'trading')
        expectReason('trade.lockX', send(x, { t: 'tradeLock' }), true)
        expectReason('trade.lockY', send(y, { t: 'tradeLock' }), true)
        if (rng() < 0.2) {
          expectReason('trade.cancel', send(y, { t: 'tradeCancel' }), true)
          return
        }
        expectReason('trade.acceptX', send(x, { t: 'tradeAccept' }), true)
        expectReason('trade.acceptY', send(y, { t: 'tradeAccept' }), true)
        if (slotOfKey(y, k) < 0) answers.push(`trade: sword ${k} did not arrive`)
      },
      // 3: list a (maybe broken) sword in a stall; buy it; a stale price is stall_changed; a broken one cannot be worn.
      stall(x, y) {
        const bag = anySword(x)
        if (bag < 0) return
        const it = s.h.bag(x.p)[bag]!
        expectReason('stall.create', send(x, { t: 'stallCreate', title: '' }), true)
        const price = 1 + Math.floor(rng() * 9000)
        expectReason('stall.item', send(x, { t: 'stallItem', slot: 0, bag, count: 1, price }), true)
        expectReason('stall.open', send(x, { t: 'stallOpen', open: true }), true)
        expectReason('stall.visit', send(y, { t: 'stallVisit', owner: x.p.id }), true)
        if (rng() < 0.25) {
          expectReason('stall.stale', send(y, { t: 'stallBuy', owner: x.p.id, slot: 0, code: SWORD.code, count: 1, price: price + 1 }), 'stall_changed')
        } else {
          expectReason('stall.buy', send(y, { t: 'stallBuy', owner: x.p.id, slot: 0, code: SWORD.code, count: 1, ...seenStack(it), price }), true)
          const got = slotOfKey(y, key(it))
          if (got < 0) answers.push('stall: the sword did not arrive')
          else if (it.durability === 0) expectReason('stall.equipBroken', send(y, { t: 'itemEquip', bag: got }), 'broken')
        }
        expectReason('stall.close', send(x, { t: 'stallClose' }), true)
      },
      // 4: a fuse, then tradeRequest → busy both ways; stallCreate busy; moveTo cancels; nothing consumed (D44).
      fuse(x, y) {
        const bag = s.h.bag(x.p)
        const sw = bag.findIndex((i) => i?.code === SWORD.code && i.durability !== 0 && i.plus < 12)
        if (sw < 0) return
        const elixir = ensure(x, ELIXIR.code)
        const powder = ensure(x, POWDER.code)
        const before = JSON.stringify(s.h.bag(x.p))
        expectReason('fuse.start', send(x, { t: 'alchemyReinforce', item: sw, elixir, powder }), true)
        expectReason('fuse.trade', send(x, { t: 'tradeRequest', target: y.p.id }), 'busy')
        expectReason('fuse.tradeIn', send(y, { t: 'tradeRequest', target: x.p.id }), 'busy')
        expectReason('fuse.stall', send(x, { t: 'stallCreate', title: '' }), 'busy')
        if (s.g.onMoveTo(x.p, s.h.now())) s.h.world.moveTo(x.p, x.p.pos[0] + 0.5, x.p.pos[2], s.h.now())
        if (s.g.alchemy.fusing(x.p)) answers.push('fuse: moveTo did not cancel')
        if (JSON.stringify(s.h.bag(x.p)) !== before) answers.push('fuse: something was consumed')
      },
      // 5: mounted: stallCreate and sit are `mounted`, tradeRequest is fine (D43).
      mounted(x, y) {
        expectReason('mounted.summon', send(x, { t: 'itemUse', bag: ensure(x, HORSE.code) }), true)
        expectReason('mounted.stall', send(x, { t: 'stallCreate', title: '' }), 'mounted')
        expectReason('mounted.sit', send(x, { t: 'sit', on: true }), 'mounted')
        expectReason('mounted.trade', send(x, { t: 'tradeRequest', target: y.p.id }), true)
        expectReason('mounted.decline', send(y, { t: 'tradeRespond', from: x.p.id, accept: false }), true)
      },
      // 6: while trading, the siblings are `trading`; emote passes.
      trading(x, y) {
        expectReason('trading.request', send(x, { t: 'tradeRequest', target: y.p.id }), true)
        expectReason('trading.respond', send(y, { t: 'tradeRespond', from: x.p.id, accept: true }), true)
        for (const t of ['alchemyReinforce', 'repair', 'mountRide', 'berserk', 'sit'] as const) expectReason(`trading.${t}`, send(x, FRAMES[t]!), 'trading')
        expectReason('trading.emote', send(x, { t: 'emote', emote: 'joy' }), true)
      },
      // 7: summon while berserk (D49).
      berserk(x) {
        s.g.berserk.gm(x.p, ['5'])
        expectReason('berserk.on', send(x, { t: 'berserk' }), true)
        expectReason('berserk.summon', send(x, { t: 'itemUse', bag: ensure(x, HORSE.code) }), 'berserk_active')
      },
      // 8: a Recovery Kit → itemEffect {id: cos} to viewers (D52).
      kit(x, y) {
        expectReason('kit.summon', send(x, { t: 'itemUse', bag: ensure(x, HORSE.code) }), true)
        const cos = s.g.mounts.horseOf(x.p)
        if (!cos) return
        cos.hp = 10
        const from = y.inbox.length
        expectReason('kit.use', send(x, { t: 'itemUse', bag: ensure(x, KIT.code) }), true)
        const fx = y.inbox.slice(from).filter((m) => m.t === 'itemEffect')
        if (JSON.stringify(fx) !== JSON.stringify([{ t: 'itemEffect', id: cos.id, item: KIT.code }])) answers.push(`kit: ${JSON.stringify(fx)}`)
      },
    }

    /** Well-formed noise after each flow (no gold sinks or sources, no consumption): the locks meet in random states. */
    const noise = (x: P) => {
      const o = pick(ps.filter((q) => q !== x))
      const bag = Math.floor(rng() * 12)
      const frames: GameplayMessage[] = [
        { t: 'itemMove', from: bag, to: Math.floor(rng() * 12) },
        { t: 'itemSplit', from: Math.max(0, s.slot(x.p, POTION)), to: Math.floor(rng() * 20), count: 1 },
        { t: 'itemEquip', bag },
        { t: 'itemUnequip', slot: 'weapon' },
        { t: 'tradeRequest', target: o.p.id },
        { t: 'tradeRespond', from: o.p.id, accept: rng() < 0.7 },
        { t: 'tradeOffer', bag, count: rng() < 0.5 ? 1 : undefined },
        { t: 'tradeTake', slot: Math.floor(rng() * 3) },
        { t: 'tradeGold', amount: Math.floor(rng() * 3000) },
        { t: 'tradeLock' },
        { t: 'tradeAccept' },
        { t: 'tradeCancel' },
        { t: 'stallCreate', title: '' },
        { t: 'stallItem', slot: Math.floor(rng() * 3), bag, count: 1, price: 1 + Math.floor(rng() * 2000) },
        { t: 'stallOpen', open: rng() < 0.7 },
        { t: 'stallClose' },
        { t: 'stallVisit', owner: o.p.id },
        { t: 'stallLeave' },
        { t: 'stallBuy', owner: o.p.id, slot: Math.floor(rng() * 3), code: SWORD.code, count: 1, price: 1 + Math.floor(rng() * 2000) },
        { t: 'mountDismount' },
        { t: 'mountDismiss' },
        { t: 'sit', on: rng() < 0.5 },
        { t: 'emote', emote: 'hi' },
        { t: 'stopAction' },
      ]
      // A buy at the real listed price now and then, so noise purchases happen too.
      const st = s.g.stalls.stallOf(o.p)
      const l = st ? st.items.findIndex((it) => it !== null) : -1
      if (st && l >= 0) {
        const it = st.items[l]!
        frames.push({ t: 'stallBuy', owner: o.p.id, slot: l, code: it.code, count: it.count, ...seenStack(it), price: it.price })
      }
      if (rng() < 0.1) {
        if (s.g.onMoveTo(x.p, s.h.now())) s.h.world.moveTo(x.p, x.p.pos[0] + (rng() - 0.5), x.p.pos[2] + (rng() - 0.5), s.h.now())
        return
      }
      s.g.request(x.p, pick(frames), s.h.now())
    }

    const names = Object.keys(FLOWS)
    const ran: Record<string, number> = {}
    for (let i = 0; i < 1000; i++) {
      reset()
      const order = [...ps].sort(() => rng() - 0.5)
      const name = pick(names)
      ran[name] = (ran[name] ?? 0) + 1
      FLOWS[name]!(order[0]!, order[1]!)
      check(`#${i} ${name}`)
      for (let n = 0; n < 6; n++) noise(pick(ps))
      s.h.advance(50)
      check(`#${i} ${name}+noise`)
      if (violations.length || answers.length > 20) break
    }
    expect(violations.slice(0, 10)).toEqual([])
    expect(answers.slice(0, 20)).toEqual([])
    expect(s.errors).toEqual([])
    expect(Object.keys(ran).sort()).toEqual([...names].sort())
    // Trades and sales really happened.
    const kinds = s.h.store.db.prepare('SELECT kind, COUNT(*) AS n FROM social_log GROUP BY kind').all() as { kind: string; n: number }[]
    for (const k of kinds) expect(k.n, k.kind).toBeGreaterThan(30)
    expect(kinds.map((k) => k.kind).sort()).toEqual(['stall', 'trade'])
  }, 120_000)
})
