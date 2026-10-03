/**
 * Wave 8 social end to end (docs/SYSTEMS_SOCIAL.md §10.9, docs/WAVE_PLAN2.md §6.7) on the REAL jangan-fields export
 * (wave8-harness.ts): two players over WebSockets, every frame checked by the shared parser.
 *
 *  1. a full exchange: request → accept → offers (a stack, a +N weapon, gold) on both sides → lock → accept → the swap
 *     (the §13 order: actionResult, inventoryUpdate, statsDelta, tradeEnd done), the bags and gold, the social_log row
 *  2. a stall: create in town (the sign reaches the other player), list, open, a visit (the greeting), a buy (buyer and
 *     owner orders, stallSold, the system line), Modify → stall_closed, a stale price → stall_changed
 *  3. a guild: create at Leebaek (the gold, the nameplate), invite + accept, guild chat to members only, a relog brings
 *     the `guild` frame back
 *  4. a server restart: the guild (members, notice) is still there; the stall is gone
 *
 * Skipped without the export.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODES, GATE, HAVE_W8, W8Harness, until, type Hero } from './wave8-harness.ts'

describe.skipIf(!HAVE_W8)('wave 8 social flows on WORLD_EXPORT=jangan-fields', () => {
  const h = new W8Harness('Soc')
  let a: Hero
  let b: Hero
  let c3: Hero
  let spot: [number, number]
  const guildName = `Wolf${(Date.now() % 1e5).toString(36)}`.slice(0, 12)
  beforeAll(async () => {
    await h.start()
    a = await h.hero({ level: 12 })
    b = await h.hero({ level: 12 })
    c3 = await h.hero({ level: 12 })
    spot = h.townSpot()
    for (const x of [a, b, c3]) await h.tp(x, spot[0], spot[1])
  }, 120_000)
  afterAll(async () => {
    await h.bye(...[a, b, c3].filter(Boolean))
    await h.stop()
  })

  it('1. a full exchange: offers, gold, lock, accept, the swap and its log row', async () => {
    const herbs = await h.give(a, CODES.herb, 20)
    const sword = await h.give(a, CODES.sword, 1)
    await h.gm(a.c, 'plus', String(sword), '3')
    await h.give(a, CODES.gold, 2000)
    const bHerbs = await h.give(b, CODES.herb, 7)
    const goldA = h.inv(a.characterId).gold
    const goldB = h.inv(b.characterId).gold
    h.drain(a, b)
    expect(await h.act(a.c, { t: 'tradeRequest', target: b.id })).toMatchObject({ ok: true })
    const req = await b.c.next('tradeRequested')
    expect(req).toMatchObject({ from: a.id, name: a.name, level: 12 })
    expect(await h.act(b.c, { t: 'tradeRespond', from: a.id, accept: true })).toMatchObject({ ok: true })
    await a.c.next('trade')
    await b.c.next('trade')
    expect(await h.act(a.c, { t: 'tradeOffer', bag: herbs, count: 5 })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'tradeOffer', bag: sword })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'tradeGold', amount: 500 })).toMatchObject({ ok: true })
    expect(await h.act(b.c, { t: 'tradeOffer', bag: bHerbs })).toMatchObject({ ok: true })
    // B sees A's side: the +3 sword without a bag index.
    const seen = await until(() => [...b.c.log].reverse().find((m) => m.t === 'trade' && m.trade.theirs.gold === 500 && m.trade.mine.items.some(Boolean)), 'B to see both offers')
    if (seen.t !== 'trade') throw new Error('unreachable')
    expect(seen.trade.theirs.items.find((x) => x?.stack.code === CODES.sword)).toMatchObject({ stack: { plus: 3 } })
    expect(seen.trade.theirs.items.every((x) => x === null || x.bag === undefined)).toBe(true)
    // Starter items stay out (canTrade false).
    const starter = h.inv(a.characterId).bag.findIndex((x) => x?.code.endsWith('_DEF'))
    if (starter >= 0) expect(await h.act(a.c, { t: 'tradeOffer', bag: starter })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(await h.act(a.c, { t: 'tradeLock' })).toMatchObject({ ok: true })
    expect(await h.act(b.c, { t: 'tradeLock' })).toMatchObject({ ok: true })
    // While trading, the lock refuses a drop.
    expect(await h.act(a.c, { t: 'itemDrop', bag: herbs })).toMatchObject({ ok: false, reason: 'trading' })
    expect(await h.act(a.c, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    h.drain(a, b)
    const from = a.c.log.length
    expect(await h.act(b.c, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    expect(await a.c.next('tradeEnd')).toMatchObject({ reason: 'done' })
    expect(await b.c.next('tradeEnd')).toMatchObject({ reason: 'done' })
    expect(a.c.log.slice(from).map((m) => m.t).filter((t) => ['inventoryUpdate', 'statsDelta', 'tradeEnd'].includes(t))).toEqual(['inventoryUpdate', 'statsDelta', 'tradeEnd'])
    expect(h.count(a.characterId, CODES.herb)).toBe(15 + 7)
    expect(h.count(b.characterId, CODES.herb)).toBe(5)
    expect(h.inv(b.characterId).bag.find((x) => x?.code === CODES.sword)).toMatchObject({ plus: 3 })
    expect(h.count(a.characterId, CODES.sword)).toBe(0)
    expect(h.inv(a.characterId).gold).toBe(goldA - 500)
    expect(h.inv(b.characterId).gold).toBe(goldB + 500)
    const log = h.s.ctx.store.db.prepare("SELECT * FROM social_log WHERE kind = 'trade'").all() as { a_gold: number; b_gold: number }[]
    expect(log).toHaveLength(1)
  }, 60_000)

  it('2. a stall: create, list, open, visit, buy; Modify closes it to buyers; a stale price is refused', async () => {
    const herbs = h.slotOf(a.characterId, CODES.herb)
    h.drain(a, b, c3)
    expect(await h.act(a.c, { t: 'stallCreate', title: 'Cheap herbs' })).toMatchObject({ ok: true })
    const own = await a.c.next('stall')
    expect(own.stall).toMatchObject({ owner: a.id, title: 'Cheap herbs', state: 'modify' })
    await b.c.next('entityUpdate', (m) => m.id === a.id && m.stall === 'Cheap herbs')
    // The owner cannot walk.
    const at = h.player(a.id).pos
    a.c.send({ t: 'moveTo', x: at[0] + 3, z: at[2] })
    await a.c.none('move', 200)
    expect(await h.act(a.c, { t: 'stallItem', slot: 0, bag: herbs, count: 10, price: 30 })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'stallText', greeting: 'Hello there' })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    expect(await h.act(b.c, { t: 'stallVisit', owner: a.id })).toMatchObject({ ok: true })
    const view = await b.c.next('stall', (m) => m.stall !== null)
    expect(view.stall).toMatchObject({ greeting: 'Hello there', state: 'open' })
    expect(view.stall!.items[0]).toMatchObject({ stack: { code: CODES.herb, count: 10 }, price: 30 })
    expect(view.stall!.items[0]!.bag).toBeUndefined()
    const goldA = h.inv(a.characterId).gold
    const goldB = h.inv(b.characterId).gold
    h.drain(a, b)
    const fa = a.c.log.length
    const fb = b.c.log.length
    expect(await h.act(b.c, { t: 'stallBuy', owner: a.id, slot: 0, code: CODES.herb, count: 10, price: 30 })).toMatchObject({ ok: true })
    const sold = await a.c.next('stallSold')
    expect(sold).toMatchObject({ slot: 0, buyer: b.name, code: CODES.herb, count: 10, price: 30 })
    await a.c.next('chat', (m) => m.channel === 'system' && m.text.includes(b.name))
    expect(b.c.log.slice(fb).map((m) => m.t).filter((t) => ['actionResult', 'inventoryUpdate', 'statsDelta'].includes(t)).slice(0, 3)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta'])
    expect(a.c.log.slice(fa).map((m) => m.t).filter((t) => ['inventoryUpdate', 'statsDelta', 'stallSold', 'chat'].includes(t)).slice(0, 4)).toEqual(['inventoryUpdate', 'statsDelta', 'stallSold', 'chat'])
    expect(h.inv(a.characterId).gold).toBe(goldA + 30)
    expect(h.inv(b.characterId).gold).toBe(goldB - 30)
    expect(h.count(b.characterId, CODES.herb)).toBe(15)
    // List the rest, then Modify: buyers get stall_closed; a changed price is stall_changed.
    const rest = h.slotOf(a.characterId, CODES.herb)
    expect(await h.act(a.c, { t: 'stallOpen', open: false })).toMatchObject({ ok: true })
    expect(await h.act(a.c, { t: 'stallItem', slot: 1, bag: rest, count: 5, price: 40 })).toMatchObject({ ok: true })
    expect(await h.act(b.c, { t: 'stallBuy', owner: a.id, slot: 1, code: CODES.herb, count: 5, price: 40 })).toMatchObject({ ok: false, reason: 'stall_closed' })
    expect(await h.act(a.c, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    expect(await h.act(b.c, { t: 'stallBuy', owner: a.id, slot: 1, code: CODES.herb, count: 5, price: 35 })).toMatchObject({ ok: false, reason: 'stall_changed' })
    // Stall chat reaches the owner and the visitors only.
    a.c.send({ t: 'chat', channel: 'stall', text: 'thanks' })
    await b.c.next('chat', (m) => m.channel === 'stall' && m.text === 'thanks')
    await c3.c.none('chat', 200).catch(() => {
      if (c3.c.queue.some((m) => m.t === 'chat' && m.channel === 'stall')) throw new Error('stall chat leaked to a non-visitor')
    })
    expect(await h.act(b.c, { t: 'stallLeave' })).toMatchObject({ ok: true })
  }, 60_000)

  it('3. a guild: create at Leebaek, invite + accept, guild chat to members only, the relog frame', async () => {
    const leebaek = h.npc(CODES.guildManager)
    await h.give(b, CODES.gold, 10000)
    await h.give(b, CODES.gold, 10000)
    await h.tp(b, leebaek.pos[0] + 2, leebaek.pos[2])
    const gold = h.inv(b.characterId).gold
    h.drain(b)
    expect(await h.act(b.c, { t: 'guildCreate', npc: leebaek.id, name: guildName })).toMatchObject({ ok: true })
    const g = await b.c.next('guild', (m) => m.guild !== null)
    expect(g.guild).toMatchObject({ name: guildName, master: b.characterId })
    await b.c.next('entityUpdate', (m) => m.id === b.id && m.guild === guildName)
    expect(h.inv(b.characterId).gold).toBe(gold - 10000)
    // Invite C (A runs a stall and stays out of it).
    await h.tp(c3, leebaek.pos[0] + 3, leebaek.pos[2])
    expect(await h.act(b.c, { t: 'guildInvite', name: c3.name })).toMatchObject({ ok: true })
    const inv = await c3.c.next('guildInvited')
    expect(inv).toMatchObject({ name: guildName, from: b.name })
    expect(await h.act(c3.c, { t: 'guildRespond', guild: inv.guild, accept: true })).toMatchObject({ ok: true })
    const joined = await c3.c.next('guild', (m) => m.guild !== null)
    expect(joined.guild!.members.map((m) => m.name).sort()).toEqual([b.name, c3.name].sort())
    expect(await h.act(b.c, { t: 'guildNotice', title: 'Meet', text: 'At the gate at eight.' })).toMatchObject({ ok: true })
    h.drain(a, b, c3)
    b.c.send({ t: 'chat', channel: 'guild', text: 'hello guild' })
    await c3.c.next('chat', (m) => m.channel === 'guild' && m.text === 'hello guild')
    await b.c.next('chat', (m) => m.channel === 'guild' && m.text === 'hello guild')
    await new Promise((r) => setTimeout(r, 200))
    expect(a.c.queue.some((m) => m.t === 'chat' && m.channel === 'guild')).toBe(false)
    // A relog: the guild frame comes back (after the other enter frames), and the nameplate name in worldEnter.self.
    c3 = await h.relog(c3)
    expect(c3.w.self.guild).toBe(guildName)
    const back = c3.enterLog().find((m) => m.t === 'guild')
    expect(back && back.t === 'guild' && back.guild?.name).toBe(guildName)
  }, 60_000)

  it('4. a server restart: the guild (members, notice) is still there; the stall is gone', async () => {
    expect(h.g.stalls.stalls.size).toBe(1)
    const herbs = h.count(a.characterId, CODES.herb)
    await h.bye(a, b, c3)
    await h.restart()
    b = await h.relog(b)
    a = await h.relog(a)
    const g = b.enterLog().find((m) => m.t === 'guild')
    if (!g || g.t !== 'guild') throw new Error('no guild frame after the restart')
    expect(g.guild).toMatchObject({ name: guildName, notice: { title: 'Meet', text: 'At the gate at eight.' } })
    expect(g.guild!.members.map((m) => m.name).sort()).toEqual([b.name, c3.name].sort())
    expect(h.g.stalls.stalls.size).toBe(0)
    expect(a.w.self.stall).toBeUndefined()
    // A's listed (unsold) herbs never left the bag.
    expect(h.count(a.characterId, CODES.herb)).toBe(herbs)
    expect(herbs).toBeGreaterThanOrEqual(5)
  }, 90_000)
})
