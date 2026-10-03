/**
 * Adversarial robustness hunt (wave 3, lens "robustness"): protocol edge values, disconnects in the middle of every
 * timed action, session replacement, per-player module state after logout, and how legit-looking clients are treated
 * by the abuse rules. Runs the REAL server (temp DATA_DIR, work/out) over WebSockets with helpers.ts clients, so every
 * server frame also passes the client's strict parser. Skipped without the export.
 *
 * Tests named "BUG:" describe the correct behaviour and fail against the current code; the rest are regression guards
 * for attacks the code already refuses.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSE_CODE, MAX_GOLD, MAX_ITEM_COUNT, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import type { Npc } from '../src/world.ts'
import { seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'npcs', 'shops', 'skills', 'masteries'].map((f) => join(OUT, `data/${f}.json`))
const HAVE = (() => {
  const man = join(OUT, 'world', 'jangan', 'manifest.json')
  if (!existsSync(man) || !DATA.every((f) => existsSync(f))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world', 'jangan', m.nav.file))
})()

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const FIELD = ['108.97', '120']
const MANG = 'MOB_CH_MANGNYANG'
const HERB = 'ITEM_ETC_HP_POTION_01'
const RETURN_5S = 'ITEM_ETC_SCROLL_RETURN_03'
const SWORD = 'ITEM_CH_SWORD_01_A'
const WEAK_GUARD = 'SKILL_CH_COLD_GANGGI_A_01'
const SMASH = 'SKILL_CH_SWORD_SMASH_A_01'

describe.skipIf(!HAVE)('robustness (real server, WORLD_EXPORT=jangan)', () => {
  let s: TestServer
  let names = 0
  beforeAll(async () => {
    s = await startTestServer({
      config: { outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, moveSpeed: 12, tickHz: 20, rolePollMs: 50, rng: seeded(77), worldExport: 'jangan' },
    })
  }, 120_000)
  afterAll(async () => s?.stopAndClean())

  const player = (id: number) => s.ctx.world.players.get(id)!
  const npc = (code: string): Npc => [...s.ctx.world.npcs.values()].find((n) => n.code === code)!
  const slotOf = (characterId: number, code: string) => s.ctx.store.loadInventory(characterId).bag.findIndex((i) => i?.code === code)
  const count = (characterId: number, code: string) => s.ctx.store.loadInventory(characterId).bag.reduce((n, i) => n + (i?.code === code ? i.count : 0), 0)

  async function enter(c: Client, characterId: number) {
    c.send({ t: 'enterWorld', id: characterId })
    const w = await c.next('worldEnter')
    await c.next('skills')
    return w.self.id
  }

  async function hero(opts: { gm?: boolean; prefix?: string } = {}) {
    const acc = await newAccount(s.url, opts.prefix ?? 'rb')
    const accountId = s.ctx.store.accountByName(acc.username)!.id
    if (opts.gm) s.ctx.store.setRole(accountId, 'gm')
    const c = await Client.login(s.url, acc.token)
    const name = `Rb${(Date.now() % 1e4).toString(36)}${++names}`.slice(0, 12)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    const id = await enter(c, ch.id)
    return { c, acc, accountId, ch, name, id }
  }

  async function gm(c: Client, cmd: string, ...args: string[]) {
    c.send({ t: 'gm', cmd, args })
    const r = await c.next('gmResult', (m) => m.cmd === cmd)
    expect(r.ok, `${cmd} ${args.join(' ')}: ${r.message}`).toBe(true)
    return r
  }

  async function act(c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
  }

  /** The answer to request type `t`: its actionResult, or an error naming it. */
  async function reply(c: Client, t: string, timeoutMs = 3000): Promise<Msg<'actionResult'> | Msg<'error'>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const i = c.queue.findIndex((m) => (m.t === 'actionResult' || m.t === 'error') && m.re === t)
      if (i >= 0) return c.queue.splice(i, 1)[0] as Msg<'actionResult'> | Msg<'error'>
      if (Date.now() > deadline || c.isClosed) throw new Error(`no answer to ${t}${c.isClosed ? ' (closed)' : ''}`)
      await sleep(10)
    }
  }

  /** Everything the gameplay modules keep per player entity id / character id (private maps, read for the leak check). */
  function residue(id: number, characterId: number) {
    const g = s.ctx.gameplay as unknown as {
      skills: { casters: Map<number, unknown>; speeds: Map<number, unknown>; flights: { caster: number; target: number }[]; effects: { list(id: number): unknown[] } }
      npcs: { open: Map<number, unknown>; detours: Map<number, unknown> }
      itemUses: { casts: Map<number, unknown> }
      shops: { sold: Map<number, unknown> }
      storage: { accounts: Map<number, unknown> }
    }
    const out: string[] = []
    if (s.ctx.world.players.has(id)) out.push('world.players')
    if (g.skills.casters.has(id)) out.push('skills.casters')
    if (g.skills.speeds.has(id)) out.push('skills.speeds')
    if (g.skills.effects.list(id).length) out.push('skills.effects')
    if (g.skills.flights.some((f) => f.caster === id || f.target === id)) out.push('skills.flights')
    if (g.npcs.open.has(id)) out.push('npcs.open')
    if (g.npcs.detours.has(id)) out.push('npcs.detours')
    if (g.itemUses.casts.has(id)) out.push('itemUses.casts')
    if (g.shops.sold.has(characterId)) out.push('shops.sold')
    if (g.storage.accounts.has(characterId)) out.push('storage.accounts')
    return out
  }

  // ---- BUG: a talk walk moves a caster in the middle of a skill action ----------------------------------------

  it('BUG: npcTalk to a far NPC during a skill action must not walk the caster while the action runs (or must interrupt it)', async () => {
    // Weak Guard of Ice: a self buff (allowed in town), prepare 1000 + cast 1000 + action 1000 ms. The core holds the
    // attack and pickup walks while skills.busy() (gameplay.ts tickAction), and a client moveTo interrupts the action
    // (SKILLS §5 "Interrupts"). The NPC talk walk (npc.ts tickPlayer -> approach) checks neither, so the caster walks
    // 60 m across town with the buff still charging, and the buff lands at the end of the walk.
    const g = await hero({ gm: true })
    await gm(g.c, 'setlevel', g.name, '20')
    await gm(g.c, 'skill', 'all')
    await gm(g.c, 'heal')
    const herbalist = npc('NPC_CH_POTION')
    expect(s.ctx.world.distance(player(g.id), herbalist, Date.now())).toBeGreaterThan(30)
    g.c.queue.length = 0
    expect(await act(g.c, { t: 'useSkill', skill: WEAK_GUARD })).toMatchObject({ ok: true })
    const cast = await g.c.next('cast', (m) => m.id === g.id)
    const start = player(g.id).pos.slice() as number[]
    expect(await act(g.c, { t: 'npcTalk', npc: herbalist.id })).toMatchObject({ ok: true })
    // Watch until the action would have ended (release at 2000 ms, end at 3000 ms).
    await sleep(cast.prepareMs + cast.castMs + cast.actionMs + 300)
    const from = g.c.log.indexOf(cast)
    const after = g.c.log.slice(from)
    const interrupted = after.find((m) => m.t === 'castEnd' && m.instance === cast.instance)
    const buffed = after.findIndex((m) => m.t === 'effectAdd' && m.id === g.id)
    const firstMove = after.findIndex((m) => m.t === 'move' && m.id === g.id)
    const walkedDuringAction = firstMove >= 0 && (buffed < 0 || firstMove < buffed)
    // Correct: either the talk interrupted the action (castEnd, no buff) or the walk waited for the action to end.
    expect(
      { interrupted: !!interrupted, walkedDuringAction, movedMetres: Math.round(Math.hypot(player(g.id).pos[0] - start[0], player(g.id).pos[2] - start[2])) },
      'the caster walked towards the NPC while its skill action was still running, and the skill still landed',
    ).toSatisfy((r: { interrupted: boolean; walkedDuringAction: boolean }) => r.interrupted || !r.walkedDuringAction)
    g.c.close()
    await g.c.closed
  }, 30_000)

  // ---- BUG: strikes from per-type rate limits never decay --------------------------------------------------------

  it('BUG: a player mashing a refused skill key (8 presses/s for 11 s) is answered rate_limited, not disconnected as abuse', async () => {
    // The client re-sends useSkill on every key press while the server refuses it without arming a cooldown (e.g.
    // not_enough_mp: hotbar useSlot does not stop on the 'mp' block). Each press past the useSkill budget (5/s, burst
    // 10) is a strike, strikes never decay (connection.ts `strikes` only grows), and the 20th closes the socket with
    // CLOSE_CODE.abuse, which the client treats as a refused token (resume.ts tokenRefused) and logs the player out.
    const p = await hero({ prefix: 'mash' })
    const presses = 88
    for (let i = 0; i < presses && !p.c.isClosed; i++) {
      p.c.send({ t: 'useSkill', skill: SMASH })
      await sleep(125)
    }
    const limited = p.c.log.filter((m) => m.t === 'actionResult' && m.reason === 'rate_limited').length
    expect(limited, 'some presses must be over the budget for this test to mean anything').toBeGreaterThan(0)
    expect(p.c.isClosed, `socket closed after ${limited} rate-limited presses`).toBe(false)
    p.c.close()
    await p.c.closed
  }, 30_000)

  // ---- disconnects in the middle of every timed action ---------------------------------------------------------

  it('a socket dropped mid skill action, mid return cast, mid talk walk and with storage/buyback open leaves no per-player state behind', async () => {
    // 1. mid skill action (and with a buff on)
    const a = await hero({ gm: true })
    await gm(a.c, 'setlevel', a.name, '20')
    await gm(a.c, 'skill', 'all')
    await gm(a.c, 'heal')
    expect(await act(a.c, { t: 'useSkill', skill: WEAK_GUARD })).toMatchObject({ ok: true })
    await a.c.next('effectAdd', (m) => m.id === a.id, 5000)
    await sleep(2100) // cooldown 2 s
    expect(await act(a.c, { t: 'useSkill', skill: WEAK_GUARD })).toMatchObject({ ok: true })
    await a.c.next('cast', (m) => m.id === a.id)
    a.c.ws.terminate()
    await a.c.closed
    await sleep(100)
    expect(residue(a.id, a.ch.id)).toEqual([])

    // 2. mid return-scroll cast: nothing consumed, no warp, and the next stay can use it again
    const b = await hero({ gm: true })
    await gm(b.c, 'item', RETURN_5S, '2')
    await gm(b.c, 'tp', ...FIELD)
    expect(await act(b.c, { t: 'itemUse', bag: slotOf(b.ch.id, RETURN_5S) })).toMatchObject({ ok: true })
    await b.c.next('itemCast', (m) => m.id === b.id)
    b.c.ws.terminate()
    await b.c.closed
    await sleep(5300)
    expect(residue(b.id, b.ch.id)).toEqual([])
    expect(count(b.ch.id, RETURN_5S)).toBe(2)
    const b2 = await Client.login(s.url, b.acc.token)
    const b2id = await enter(b2, b.ch.id)
    expect(await act(b2, { t: 'itemUse', bag: slotOf(b.ch.id, RETURN_5S) })).toMatchObject({ ok: true })
    expect(await b2.next('itemCastEnd', (m) => m.id === b2id, 8000)).toMatchObject({ reason: 'done' })
    expect(count(b.ch.id, RETURN_5S)).toBe(1)
    b2.close()
    await b2.closed

    // 3. mid talk walk, after a sale (buyback) and with the storage window open
    const c = await hero({ gm: true })
    await gm(c.c, 'item', HERB, '5')
    const sansan = npc('NPC_CH_WAREHOUSE_W')
    const herbalist = npc('NPC_CH_POTION')
    expect(await act(c.c, { t: 'npcTalk', npc: sansan.id })).toMatchObject({ ok: true })
    await c.c.next('npcDialog', () => true, 15_000)
    expect(await act(c.c, { t: 'storageOpen', npc: sansan.id })).toMatchObject({ ok: true })
    await c.c.next('storage')
    expect(await act(c.c, { t: 'npcTalk', npc: herbalist.id })).toMatchObject({ ok: true })
    await c.c.next('npcDialog', (m) => m.npc === herbalist.id, 15_000)
    expect(await act(c.c, { t: 'shopSell', npc: herbalist.id, bag: slotOf(c.ch.id, HERB), count: 1 })).toMatchObject({ ok: true })
    expect(await act(c.c, { t: 'npcTalk', npc: sansan.id })).toMatchObject({ ok: true })
    await c.c.next('move', (m) => m.id === c.id)
    c.c.ws.terminate()
    await c.c.closed
    await sleep(100)
    expect(residue(c.id, c.ch.id)).toEqual([])

    // the server is still healthy
    const d = await hero()
    d.c.send({ t: 'ping', n: 1, clientTime: 1 })
    await d.c.next('pong')
    d.c.close()
    await d.c.closed
  }, 60_000)

  it('a second login of the same account mid cast / mid return cast replaces the first cleanly; the new stay starts without the old runtime state', async () => {
    const a = await hero({ gm: true })
    await gm(a.c, 'setlevel', a.name, '20')
    await gm(a.c, 'skill', 'all')
    await gm(a.c, 'item', RETURN_5S, '1')
    expect(await act(a.c, { t: 'useSkill', skill: WEAK_GUARD })).toMatchObject({ ok: true })
    await a.c.next('cast', (m) => m.id === a.id)
    const second = await Client.login(s.url, a.acc.token)
    expect((await a.c.closed).code).toBe(CLOSE_CODE.replaced)
    expect(residue(a.id, a.ch.id)).toEqual([])
    const id2 = await enter(second, a.ch.id)
    const w = second.log.find((m): m is Msg<'worldEnter'> => m.t === 'worldEnter')!
    expect(w.self.effects ?? []).toEqual([])
    // the cooldown of the interrupted cast survives (decision 8), the scroll is still there and usable
    expect(await act(second, { t: 'useSkill', skill: WEAK_GUARD })).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(await act(second, { t: 'itemUse', bag: slotOf(a.ch.id, RETURN_5S) })).toMatchObject({ ok: true })
    await second.next('itemCast', (m) => m.id === id2)
    const third = await Client.login(s.url, a.acc.token)
    expect((await second.closed).code).toBe(CLOSE_CODE.replaced)
    expect(residue(id2, a.ch.id)).toEqual([])
    expect(count(a.ch.id, RETURN_5S)).toBe(1)
    third.close()
    await third.closed
  }, 30_000)

  // ---- well-formed frames with hostile values ------------------------------------------------------------------

  it('well-formed wave-3 requests with hostile values (alive, dead, in the lobby) never reach server_error and never break a frame', async () => {
    const p = await hero({ gm: true })
    await gm(p.c, 'item', 'ITEM_ETC_GOLD_01', '10000')
    await gm(p.c, 'item', SWORD, '1')
    const sansan = npc('NPC_CH_WAREHOUSE_W').id
    const herbalist = npc('NPC_CH_POTION').id
    const mob = [...s.ctx.world.mobs.values()][0]!.id
    const ids = [sansan, herbalist, mob, p.id, 0, Number.MAX_SAFE_INTEGER]
    const frames: Record<string, unknown>[] = []
    for (const n of ids) {
      frames.push(
        { t: 'npcTalk', npc: n },
        { t: 'storageOpen', npc: n },
        { t: 'storageDeposit', npc: n, bag: 47, count: MAX_ITEM_COUNT, to: 179 },
        { t: 'storageWithdraw', npc: n, slot: 179, count: MAX_ITEM_COUNT, bag: 47 },
        { t: 'storageMove', npc: n, from: 0, to: 0 },
        { t: 'storageMove', npc: n, from: 149, to: 179 },
        { t: 'storageGold', npc: n, dir: 'withdraw', amount: MAX_GOLD },
        { t: 'storageGold', npc: n, dir: 'deposit', amount: MAX_GOLD },
        { t: 'shopBuyback', npc: n, index: 4 },
        { t: 'shopBuy', npc: n, item: 'ITEM_CH_M_HEAVY_03_BA_A', count: MAX_ITEM_COUNT },
        { t: 'shopBuy', npc: n, item: HERB, count: MAX_ITEM_COUNT },
        { t: 'shopSell', npc: n, bag: 0, count: MAX_ITEM_COUNT },
        { t: 'useSkill', skill: SMASH, target: n },
        { t: 'useSkill', skill: 'SKILL_CH_WATER_RESURRECTION_A_01', target: n },
        { t: 'useSkill', skill: 'SKILL_CH_WATER_HEAL_A_01', target: n },
      )
    }
    frames.push(
      { t: 'useSkill', skill: 'SKILL_CH_SWORD_BASE_01' },
      { t: 'useSkill', skill: 'A'.repeat(128) },
      { t: 'skillLearn', skill: 'SKILL_CH_WATER_RESURRECTION_A_02' },
      { t: 'masteryUp', mastery: 'FORCE' },
      { t: 'buffCancel', skill: WEAK_GUARD },
      { t: 'hotbarSet', slot: 39, entry: { kind: 'item', code: 'ITEM_ETC_GOLD_01' } },
      { t: 'hotbarSet', slot: 39, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_BASE_01' } },
      { t: 'hotbarSet', slot: 0, entry: { kind: 'item', code: 'Z'.repeat(128) } },
      { t: 'npcClose' },
      { t: 'itemUse', bag: 47 },
    )
    const run = async (label: string) => {
      p.c.queue.length = 0
      for (const f of frames) {
        p.c.send(f)
        const r = await reply(p.c, f.t as string)
        if (r.t === 'error') expect(r.code, `${label} ${JSON.stringify(f)}: ${r.message}`).not.toBe('server_error')
        await sleep(60) // stay under the per-type budgets; this test is about values, not rates
      }
      expect(p.c.isClosed, label).toBe(false)
    }
    await run('alive')
    s.ctx.gameplay.playerDied(player(p.id), Date.now())
    await run('dead')
    p.c.send({ t: 'leaveWorld' })
    await p.c.next('worldLeft')
    await run('lobby')
    expect(s.ctx.world.players.size).toBeGreaterThanOrEqual(0)
    p.c.close()
    await p.c.closed
  }, 120_000)

  // ---- chat and whisper edges ------------------------------------------------------------------------------------

  it('whisper edges: self in other case, lobby-only and invisible targets, unicode names, party + to, bidi text', async () => {
    const a = await hero({ prefix: 'wa' })
    const b = await hero({ prefix: 'wb' })
    const g = await hero({ gm: true, prefix: 'wg' })
    const bad = async (frame: Record<string, unknown>, code: string) => {
      a.c.send(frame)
      expect((await a.c.next('error', (m) => m.re === 'chat' || m.re === undefined)).code, JSON.stringify(frame)).toBe(code)
    }
    await bad({ t: 'chat', text: 'hi', to: a.name.toUpperCase() }, 'bad_request')
    await bad({ t: 'chat', text: 'hi', to: 'Nobody' }, 'not_found')
    await bad({ t: 'chat', text: 'hi', to: '李小龍' }, 'bad_request')
    await bad({ t: 'chat', text: 'hi', to: 'Ab' }, 'bad_request')
    await bad({ t: 'chat', text: 'hi', to: b.name, channel: 'party' }, 'bad_request')
    await bad({ t: 'chat', text: '‮⁦\u0000', to: b.name }, 'bad_request')
    // b goes back to the lobby: connected, but not online in the world
    b.c.send({ t: 'leaveWorld' })
    await b.c.next('worldLeft')
    await bad({ t: 'chat', text: 'hi', to: b.name }, 'not_found')
    // an invisible GM is "not online" for players
    await gm(g.c, 'invis', 'on')
    await bad({ t: 'chat', text: 'hi', to: g.name }, 'not_found')
    await sleep(1100)
    a.c.send({ t: 'chat', text: '‮evil‬ ok', to: g.name.toLowerCase() })
    await a.c.next('error', (m) => m.re === 'chat')
    expect(g.c.log.some((m) => m.t === 'chat' && m.channel === 'whisper')).toBe(false)
    for (const x of [a, b, g]) x.c.close()
    await Promise.all([a, b, g].map((x) => x.c.closed))
  }, 30_000)
})
