/**
 * Wave 8 cross-system flows (docs/WAVE_PLAN2.md §6.7 flows 1-9) on the REAL jangan-fields export (wave8-harness.ts):
 * the places where horses, durability, alchemy, Berserk, trade, stalls and guilds meet, over WebSockets.
 *
 *  1. enter-world order with a saved horse and a guild (§3.2.8 / PROTOCOL §11), and `stats.hwan` = the saved points (D34)
 *  2. a +3 sword at 10/76 durability trades as +3 at 10/76; a repair by its owner mid-window is refused `trading` (D46)
 *  3. a broken sword listed in a stall and bought arrives at durability 0; equipping it is refused `broken` (D47)
 *  4. a fuse running: `tradeRequest` → `busy`; `moveTo` → `alchemyResult cancelled`, nothing consumed (D44)
 *  5. mounted: `stallCreate` → `mounted`, `sit` → `mounted`, `tradeRequest` → ok (D43)
 *  6. while trading: `alchemyReinforce`, `repair`, `mountRide`, `berserk`, `sit` → `trading`; `emote` → ok
 *  7. summoning while berserk → `berserk_active` (D49)
 *  8. a Recovery Kit → `itemEffect {id: <the horse>}` to viewers (D52)
 *  9. a Tomb Stone Ghost's mob-skill `cast` reaches a client, then `combat {instance}` with `at` (its force bolt); the
 *     client half (FX-C1 consuming it) is apps/game/test/mob-skill-view.test.ts on the real rows
 *
 * Skipped without the export.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep } from './helpers.ts'
import { CODES, FIELD, HAVE_W8, W8Harness, until, type Hero } from './wave8-harness.ts'

describe.skipIf(!HAVE_W8)('wave 8 cross-system flows on WORLD_EXPORT=jangan-fields', () => {
  const h = new W8Harness('X8', { alchemyFuseMs: 2000, mobDamageRate: 0.05 })
  let a: Hero
  let b: Hero
  let spot: [number, number]
  beforeAll(async () => {
    await h.start()
    a = await h.hero({ level: 15 })
    b = await h.hero({ level: 15 })
    spot = h.townSpot()
  }, 120_000)
  afterAll(async () => {
    await h.bye(...[a, b].filter(Boolean))
    await h.stop()
  })

  /** Opens a trade window between x (requester) and y. */
  const openTrade = async (x: Hero, y: Hero) => {
    await sleep(1100) // tradeRequest's budget is 1/s (burst 3); the flows ask often
    expect(await h.act(x.c, { t: 'tradeRequest', target: y.id })).toMatchObject({ ok: true })
    await y.c.next('tradeRequested', (m) => m.from === x.id)
    expect(await h.act(y.c, { t: 'tradeRespond', from: x.id, accept: true })).toMatchObject({ ok: true })
    await x.c.next('trade')
    await y.c.next('trade')
  }
  /** A tradable sword in x's bag at +plus and durability dur (equip, /dur, unequip, /plus). */
  const sword = async (x: Hero, plus: number, dur: number): Promise<number> => {
    const bag = await h.give(x, CODES.sword, 1)
    expect(await h.act(x.c, { t: 'itemEquip', bag })).toMatchObject({ ok: true })
    await h.gm(x.c, 'dur', 'weapon', String(dur))
    const back = h.inv(x.characterId).bag.findIndex((i) => i === null)
    expect(await h.act(x.c, { t: 'itemUnequip', slot: 'weapon', bag: back })).toMatchObject({ ok: true })
    if (plus) await h.gm(x.c, 'plus', String(back), String(plus))
    // Put the starter weapon back on so x can still fight.
    const starter = h.inv(x.characterId).bag.findIndex((i) => i?.code.endsWith('_DEF') && /SWORD/.test(i.code))
    if (starter >= 0) expect(await h.act(x.c, { t: 'itemEquip', bag: starter })).toMatchObject({ ok: true })
    return h.slotOf(x.characterId, CODES.sword)
  }

  it('1. enter-world order with a saved horse and a guild; stats.hwan = the saved points (D34)', async () => {
    const leebaek = h.npc(CODES.guildManager)
    await h.tp(a, leebaek.pos[0] + 2, leebaek.pos[2])
    await h.give(a, CODES.gold, 10000)
    await h.give(a, CODES.gold, 10000)
    const name = `Cross${(Date.now() % 1e5).toString(36)}`.slice(0, 12)
    expect(await h.act(a.c, { t: 'guildCreate', npc: leebaek.id, name })).toMatchObject({ ok: true })
    await h.gm(a.c, 'horse')
    await a.c.next('spawn', (m) => m.entity.kind === 'cos')
    await h.gm(a.c, 'hwan', '3')
    a = await h.relog(a, 500)
    const log = a.enterLog()
    const kinds = log
      .map((m): string | null => (m.t === 'spawn' ? (m.entity.kind === 'cos' ? 'spawn:cos' : null) : m.t === 'entityUpdate' ? (m.mount !== undefined || m.rider !== undefined ? 'eu:mount' : null) : m.t))
      .filter((t): t is string => t !== null && ['worldEnter', 'stats', 'inventory', 'skills', 'quests', 'spawn:cos', 'eu:mount', 'guild'].includes(t))
    // Collapse the entityUpdate pair.
    const order = kinds.filter((t, i) => !(t === 'eu:mount' && kinds[i - 1] === 'eu:mount'))
    expect(order).toEqual(['worldEnter', 'stats', 'inventory', 'skills', 'quests', 'spawn:cos', 'eu:mount', 'guild'])
    expect(a.stats.stats.hwan).toBe(3)
    expect(a.w.self.guild).toBe(name)
    // Tidy up for the next flows: no horse, no points.
    await h.gm(a.c, 'horse', 'off')
    await h.gm(a.c, 'hwan', '0')
  }, 60_000)

  it('2. a +3 sword at 10/76 trades as +3 at 10/76; a repair mid-window is refused trading (D46)', async () => {
    const smith = h.npc(CODES.smith)
    await h.tp(a, smith.pos[0] + 1.5, smith.pos[2])
    await h.tp(b, smith.pos[0] + 2.5, smith.pos[2])
    const bag = await sword(a, 3, 10)
    expect(h.inv(a.characterId).bag[bag]).toMatchObject({ code: CODES.sword, plus: 3, durability: 10 })
    await openTrade(a, b)
    expect(await h.act(a.c, { t: 'tradeOffer', bag })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'repair', npc: smith.id, items: [{ bag }] })).toMatchObject({ ok: false, reason: 'trading' })
    expect(await h.act(a.c, { t: 'tradeLock' })).toMatchObject({ ok: true })
    expect(await h.act(b.c, { t: 'tradeLock' })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    expect(await h.act(b.c, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    await a.c.next('tradeEnd', (m) => m.reason === 'done')
    await b.c.next('tradeEnd', (m) => m.reason === 'done')
    expect(h.inv(b.characterId).bag.find((x) => x?.code === CODES.sword)).toMatchObject({ plus: 3, durability: 10 })
    expect(h.count(a.characterId, CODES.sword)).toBe(0)
  }, 60_000)

  it('3. a broken sword bought from a stall arrives at durability 0; equipping it is refused broken (D47)', async () => {
    await h.tp(a, spot[0], spot[1])
    await h.tp(b, spot[0] + 2, spot[1])
    const bag = await sword(a, 0, 0)
    expect(h.inv(a.characterId).bag[bag]).toMatchObject({ durability: 0 })
    await h.give(b, CODES.gold, 100)
    expect(await h.act(a.c, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'stallItem', slot: 0, bag, count: 1, price: 10 })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    // The buyer names the durability 0 it saw (SOC-1: the purchase is bound to the exact item).
    expect(await h.act(b.c, { t: 'stallBuy', owner: a.id, slot: 0, code: CODES.sword, count: 1, durability: 0, price: 10 })).toMatchObject({ ok: true })
    const got = h.slotOf(b.characterId, CODES.sword)
    const broken = h.inv(b.characterId).bag.findIndex((x) => x?.code === CODES.sword && x.durability === 0)
    expect(got).toBeGreaterThanOrEqual(0)
    expect(broken).toBeGreaterThanOrEqual(0)
    expect(await h.act(b.c, { t: 'itemEquip', bag: broken })).toMatchObject({ ok: false, reason: 'broken' })
    expect(await h.act(a.c, { t: 'stallClose' })).toMatchObject({ ok: true })
  }, 60_000)

  it('4. a fuse running: tradeRequest → busy; moveTo → alchemyResult cancelled, nothing consumed (D44)', async () => {
    const item = await h.give(a, CODES.sword, 1)
    await h.give(a, CODES.elixir, 1)
    const elixir = h.slotOf(a.characterId, CODES.elixir)
    expect(await h.act(a.c, { t: 'alchemyReinforce', item, elixir })).toMatchObject({ ok: true })
    await a.c.next('alchemyStart')
    expect(await h.act(a.c, { t: 'tradeRequest', target: b.id })).toMatchObject({ ok: false, reason: 'busy' })
    // The other way round too: B asking A gets A's busy.
    expect((await h.act(b.c, { t: 'tradeRequest', target: a.id })).ok).toBe(false)
    const at = h.player(a.id).pos
    a.c.send({ t: 'moveTo', x: at[0] + 2, z: at[2] })
    expect(await a.c.next('alchemyResult')).toMatchObject({ item, outcome: 'cancelled' })
    expect(h.count(a.characterId, CODES.elixir)).toBe(1)
    expect(h.inv(a.characterId).bag[item]).toMatchObject({ code: CODES.sword })
    expect(h.inv(a.characterId).bag[item]?.plus ?? 0).toBe(0)
  }, 60_000)

  it('5. mounted: stallCreate → mounted, sit → mounted, tradeRequest → ok (D43)', async () => {
    await h.tp(a, spot[0], spot[1])
    await h.tp(b, spot[0] + 2, spot[1])
    await h.gm(a.c, 'horse')
    await until(() => h.g.mounts.ridden(h.player(a.id)), 'A to ride')
    expect(await h.act(a.c, { t: 'stallCreate', title: '' })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(await h.act(a.c, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(await h.act(a.c, { t: 'emote', emote: 'hi' })).toMatchObject({ ok: false, reason: 'mounted' })
    h.drain(b)
    expect(await h.act(a.c, { t: 'tradeRequest', target: b.id })).toMatchObject({ ok: true })
    await b.c.next('tradeRequested', (m) => m.from === a.id)
    expect(await h.act(a.c, { t: 'tradeCancel' })).toMatchObject({ ok: true })
  }, 60_000)

  it('6. while trading: alchemyReinforce, repair, mountRide, berserk, sit → trading; emote → ok', async () => {
    // A still owns the (ridden) horse from flow 5; dismount so mountRide has a parked horse to ask about.
    expect(await h.act(a.c, { t: 'mountDismount' })).toMatchObject({ ok: true })
    const horse = h.g.mounts.horseOf(h.player(a.id))!
    await h.gm(a.c, 'hwan', '5')
    const item = await h.give(a, CODES.sword, 1)
    await h.give(a, CODES.elixir, 1)
    const elixir = h.slotOf(a.characterId, CODES.elixir)
    const smith = h.npc(CODES.smith)
    h.drain(a, b)
    await openTrade(a, b)
    expect(await h.act(a.c, { t: 'alchemyReinforce', item, elixir })).toMatchObject({ ok: false, reason: 'trading' })
    expect(await h.act(a.c, { t: 'repair', npc: smith.id })).toMatchObject({ ok: false, reason: 'trading' })
    expect(await h.act(a.c, { t: 'mountRide', cos: horse.id })).toMatchObject({ ok: false, reason: 'trading' })
    expect(await h.act(a.c, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'trading' })
    expect(await h.act(a.c, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'trading' })
    expect(await h.act(a.c, { t: 'emote', emote: 'hi' })).toMatchObject({ ok: true })
    expect(h.g.trade.isTrading(h.player(a.id))).toBe(true)
    expect(await h.act(a.c, { t: 'tradeCancel' })).toMatchObject({ ok: true })
    await b.c.next('tradeEnd')
    expect(await h.act(a.c, { t: 'mountDismiss' })).toMatchObject({ ok: true })
  }, 60_000)

  it('7. summoning while berserk → berserk_active (D49)', async () => {
    await h.tp(a, FIELD[0], FIELD[1])
    await h.gm(a.c, 'hwan', '5')
    expect(await h.act(a.c, { t: 'berserk' })).toMatchObject({ ok: true })
    const bag = await h.give(a, CODES.horse, 1)
    expect(await h.act(a.c, { t: 'itemUse', bag })).toMatchObject({ ok: false, reason: 'berserk_active' })
    await h.gm(a.c, 'hwan', 'stop')
  }, 60_000)

  it('8. a Recovery Kit → itemEffect {id: the horse} to viewers (D52)', async () => {
    await h.tp(a, FIELD[0], FIELD[1])
    await h.tp(b, FIELD[0] + 2, FIELD[1])
    await h.gm(a.c, 'horse')
    const c = await until(() => h.g.mounts.ridden(h.player(a.id)), 'A to ride')
    c.hp = c.maxHp - 500
    const kit = await h.give(a, CODES.kit, 1)
    h.drain(a, b)
    expect(await h.act(a.c, { t: 'itemUse', bag: kit })).toMatchObject({ ok: true })
    await b.c.next('entityUpdate', (m) => m.id === c.id && m.hp !== undefined)
    expect(await b.c.next('itemEffect')).toMatchObject({ id: c.id, item: CODES.kit })
    expect(await a.c.next('itemEffect')).toMatchObject({ id: c.id, item: CODES.kit })
    await h.gm(a.c, 'horse', 'off')
  }, 60_000)

  it('9. a Tomb Stone Ghost cast reaches the client, then combat {instance} with at (the force bolt)', async () => {
    await sleep(1100) // the GM command budget
    await h.tp(a, FIELD[0], FIELD[1] + 30)
    const r = await h.gm(a.c, 'spawn', CODES.tombGhost, '1')
    const ghost = (r.data as { ids: number[] }).ids[0]!
    const m = h.s.ctx.world.mobs.get(ghost)!
    const at = h.s.ctx.world.positionAt(m, Date.now())
    await h.tp(a, at[0] + 6, at[2])
    h.drain(a)
    const t0 = h.g.now
    const res = await h.gm(a.c, 'mobskill', String(ghost), '1')
    expect(res.data).toMatchObject({ skill: 'MSKILL_CH_TOMBSTONE_CLON_ATTACK01' })
    const cast = await a.c.next('cast', (x) => x.id === ghost, 5000)
    expect(cast.castMs).toBeGreaterThan(1000)
    const hit = await a.c.next('combat', (x) => x.attacker === ghost && x.instance === cast.instance, 8000)
    expect(hit.skill).toBe('MSKILL_CH_TOMBSTONE_CLON_ATTACK01')
    expect(hit.target).toBe(a.id)
    expect(typeof hit.at).toBe('number')
    // `at` (server ms) is after the release: the wind-up, then the bolt's flight (6 m at 20 m/s).
    expect(hit.at!).toBeGreaterThan(t0 + cast.castMs)
  }, 60_000)
})
