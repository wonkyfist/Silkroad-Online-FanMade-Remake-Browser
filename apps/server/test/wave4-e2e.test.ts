/**
 * Wave 4 end to end (docs/WAVE_PLAN.md §5.4, the W4-I headless flows) on the export the game is played on
 * (WORLD_EXPORT=jangan-fields, W3-I decision) with the real quest file (content/quests/jangan.json): the real server
 * (temp DATA_DIR, work/out + work/out-opt) driven over WebSockets by helpers.ts clients, every frame checked by the
 * strict shared parser.
 *
 *  1. enter order: worldEnter -> stats -> inventory -> skills -> quests (-> party when in one, flow 7)
 *  2. Act I: JG_001 Fengil -> Hwangno (gain.quest, 5 herbs); JG_002 eight GM-spawned Mangyang; JG_004's deliver by
 *     questTalk
 *  3. collect: quest drops go to the quest bag (never the ground); questAbandon removes the quest items
 *  4. `have` recount: JG_010's potions; selling one drops the quest from ready back to active
 *  5. encounter: JG_025's Binding Bell at LOC_TIGER_SHRINE (hpMul), a second ring -> cooldown, GM spawn count unaffected
 *  6. party: invite/accept, share-mode EXP by the formula, `#` party chat, kill credit for a member who did no damage,
 *     disconnect -> offline, relog -> party last in the enter sequence (the 120 s removal is in party.test.ts)
 *  7. editors: /nest add MOB_CH_GYO 8 25 survives a restart, /nest undo; PUT /api/gm/quests/JG_002 count 3 -> a player at
 *     3/8 gets contentChanged + questUpdate changed -> ready; a player gets 403 and an audit row
 *  8. abuse: extra keys on every wave-4 client type, partyKick by a non-leader, questTurnIn without a needed choice
 *  9. daily: JG_R01 turned in, refused until the 04:00 reset, offered again once the clock passes it (fake Date)
 *
 * The plan's numbering (§5.4) is kept in the test names. Skipped without the export.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { QuestDef, ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { VARIANT_RULES } from '../src/formulas.ts'
import { startServer } from '../src/game.ts'
import { killExp } from '../src/gameplay.ts'
import { levelShares, partyPool } from '../src/party.ts'
import { nextDailyReset } from '../src/quests/engine.ts'
import type { Mob, Npc } from '../src/world.ts'
import { seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const CONTENT = join(REPO_ROOT, 'content')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'npcs', 'shops', 'skills', 'masteries'].map((f) => join(OUT, `data/${f}.json`))
const HAVE_FIELDS = (() => {
  const man = join(OUT, 'world/jangan-fields/manifest.json')
  if (!existsSync(man) || !DATA.every((f) => existsSync(f)) || !existsSync(join(CONTENT, 'quests/jangan.json'))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world/jangan-fields', m.nav.file))
})()

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** The Mangnyang field south of the town gate, outside the safe area (wave3-e2e's FIELD). */
const FIELD = ['108.97', '120']
const MANG = 'MOB_CH_MANGNYANG'
const HP_SMALL = 'ITEM_ETC_HP_POTION_02'

async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(20)
  }
}

describe.skipIf(!HAVE_FIELDS)('wave 4 flows on WORLD_EXPORT=jangan-fields', () => {
  let s: TestServer
  const logs: string[] = []
  let roll: () => number = seeded(41)
  let names = 0

  beforeAll(async () => {
    s = await startTestServer({
      logs,
      config: {
        outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, moveSpeed: 30, tickHz: 20, rolePollMs: 50,
        rng: () => roll(), worldExport: 'jangan-fields', contentDir: CONTENT,
      },
    })
    expect(s.ctx.nav.kind).toBe('mesh')
  }, 120_000)
  afterAll(async () => {
    vi.useRealTimers()
    await s?.stopAndClean()
  })

  const npc = (code: string): Npc => {
    const n = [...s.ctx.world.npcs.values()].find((x) => x.code === code)
    if (!n) throw new Error(`no NPC ${code}`)
    return n
  }
  const player = (id: number) => s.ctx.world.players.get(id)!
  const bag = (characterId: number) => s.ctx.store.loadInventory(characterId).bag
  const count = (characterId: number, code: string) => bag(characterId).reduce((n, i) => n + (i?.code === code ? i.count : 0), 0)
  const book = () => s.ctx.gameplay.quests.book

  const act = async (c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> => {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
  }
  const gm = async (c: Client, cmd: string, ...args: string[]) => {
    c.send({ t: 'gm', cmd, args })
    const r = await c.next('gmResult', (m) => m.cmd === cmd, 5000)
    expect(r.ok, `${cmd} ${args.join(' ')}: ${r.message}`).toBe(true)
    return r
  }
  const enter = async (c: Client, characterId: number) => {
    const from = c.log.length
    c.send({ t: 'enterWorld', id: characterId })
    const w = await c.next('worldEnter')
    const quests = await c.next('quests')
    const order = () => c.log.slice(from).map((m) => m.t).filter((t) => ['worldEnter', 'stats', 'inventory', 'skills', 'quests', 'party'].includes(t))
    return { w, id: w.self.id, quests, order }
  }
  /** A fresh account (GM unless `gm: false`, set as the owner CLI does) with one character in the world. */
  const hero = async (opts: { done?: string[]; gm?: boolean } = {}) => {
    const acc = await newAccount(s.url, 'w4')
    if (opts.gm !== false) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    const name = `W4${(Date.now() % 1e4).toString(36)}${++names}`.slice(0, 12)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    const ins = s.ctx.store.db.prepare('INSERT INTO quest_done (character_id, quest, times, last_at) VALUES (?, ?, 1, ?)')
    for (const q of opts.done ?? []) ins.run(ch.id, q, Date.now() - 1000)
    const e = await enter(c, ch.id)
    return { c, acc, ch, name, ...e }
  }
  type Hero = Awaited<ReturnType<typeof hero>>
  const bye = async (...heroes: Hero[]) => {
    for (const x of heroes) x.c.close()
    await Promise.all(heroes.map((x) => x.c.closed))
  }
  /** Teleports next to an NPC (inside the 8 m interact range). */
  const near = async (c: Client, code: string) => {
    const n = npc(code)
    await gm(c, 'tp', String(n.pos[0] + 1.5), String(n.pos[2]))
    await sleep(60)
    return n
  }
  const accept = async (h: Hero, code: string, quest: string) => {
    const n = await near(h.c, code)
    expect(await act(h.c, { t: 'questAccept', npc: n.id, quest }), `${quest} accept`).toMatchObject({ ok: true })
    return h.c.next('questUpdate', (m) => m.quest === quest && m.event === 'accepted')
  }
  /** GM-spawns `n` one-hit monsters next to `h` (they never regenerate). */
  const spawn = async (h: Hero, code: string, n: number) => {
    const r = await gm(h.c, 'spawn', code, String(n))
    const ids = (r.data as { ids: number[] }).ids
    expect(ids).toHaveLength(n)
    for (const id of ids) {
      const m = s.ctx.world.mobs.get(id)!
      m.hp = 1
      m.nextRegenAt = Date.now() + 1e9
    }
    return ids
  }
  /** Kills each monster with basic attacks, one after the other. */
  const kill = async (h: Hero, ids: number[]) => {
    for (const id of ids) {
      expect(await act(h.c, { t: 'attack', target: id })).toMatchObject({ ok: true })
      await until(() => { const m = s.ctx.world.mobs.get(id); return !m || m.ai === 'dead' || m.hp <= 0 }, `mob ${id} dies`, 10_000)
    }
  }

  it('1. enter: worldEnter -> stats -> inventory -> skills -> quests (no party frame when not in one)', async () => {
    const h = await hero({ gm: false })
    await h.c.next('skills').catch(() => undefined)
    await sleep(100)
    expect(h.order()).toEqual(['worldEnter', 'stats', 'inventory', 'skills', 'quests'])
    expect(h.quests).toMatchObject({ active: [], done: [] })
    expect(h.quests.rev).toBe(book().rev)
    expect(logs.some((l) => /content quests: \d+ quests, \d+ quest items, \d+ locations from 1 files; 0 errors/.test(l))).toBe(true)
    await bye(h)
  })

  it('2. Act I: JG_001 Fengil -> Hwangno (gain.quest, 5 herbs); JG_002 eight Mangyang; JG_004 deliver by questTalk', async () => {
    const h = await hero()
    await gm(h.c, 'invis', 'on')
    const fengil = await near(h.c, 'NPC_CH_SOLDIER_EM2')
    expect(await act(h.c, { t: 'npcTalk', npc: fengil.id })).toMatchObject({ ok: true })
    expect((await h.c.next('npcDialog', (m) => m.npc === fengil.id)).services).toContain('quest')
    expect(await act(h.c, { t: 'questAccept', npc: fengil.id, quest: 'JG_001' })).toMatchObject({ ok: true })
    expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_001')).toMatchObject({ event: 'accepted', progress: { status: 'ready' } })
    // turning in at the giver is refused: Hwangno takes it
    expect(await act(h.c, { t: 'questTurnIn', npc: fengil.id, quest: 'JG_001' })).toMatchObject({ ok: false })
    const chief = await near(h.c, 'NPC_CH_CHEF')
    expect(await act(h.c, { t: 'npcTalk', npc: chief.id })).toMatchObject({ ok: true })
    expect((await h.c.next('npcDialog', (m) => m.npc === chief.id)).services).toContain('quest')
    expect(await act(h.c, { t: 'questTurnIn', npc: chief.id, quest: 'JG_001' })).toMatchObject({ ok: true })
    expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_001')).toMatchObject({ event: 'completed', progress: null, done: { quest: 'JG_001', times: 1 } })
    expect((await h.c.next('statsDelta', (m) => m.gain?.quest === 'JG_001')).gain).toEqual({ exp: 60, spExp: 400, quest: 'JG_001' })
    expect(count(h.ch.id, 'ITEM_ETC_HP_POTION_01')).toBe(5)
    // done once: not offered again
    expect(await act(h.c, { t: 'questAccept', npc: fengil.id, quest: 'JG_001' })).toMatchObject({ ok: false })

    expect(await act(h.c, { t: 'questAccept', npc: chief.id, quest: 'JG_002' })).toMatchObject({ ok: true })
    await h.c.next('questUpdate', (m) => m.quest === 'JG_002' && m.event === 'accepted')
    expect(await act(h.c, { t: 'questTurnIn', npc: chief.id, quest: 'JG_002' })).toMatchObject({ ok: false, reason: 'not_complete' })
    await gm(h.c, 'tp', ...FIELD)
    const ids = await spawn(h, MANG, 8)
    const seen: string[] = []
    for (const id of ids) {
      await kill(h, [id])
      const u = await h.c.next('questUpdate', (m) => m.quest === 'JG_002' && m.event !== 'accepted', 10_000)
      seen.push(`${u.event}:${u.progress?.counts.mangyang}`)
    }
    expect(seen.slice(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `progress:${n}`))
    expect(seen[7]).toBe('ready:8')
    await near(h.c, 'NPC_CH_CHEF')
    expect(await act(h.c, { t: 'questTurnIn', npc: chief.id, quest: 'JG_002' })).toMatchObject({ ok: true })
    expect((await h.c.next('statsDelta', (m) => m.gain?.quest === 'JG_002')).gain).toMatchObject({ exp: 120, quest: 'JG_002' })
    expect(count(h.ch.id, 'ITEM_ETC_MP_POTION_01')).toBe(5)

    // JG_004: the Meat Bun is given on accept (quest bag) and handed over to Sochil with questTalk
    const acc = await accept(h, 'NPC_CH_CHEF', 'JG_004')
    expect(acc.progress!.items).toEqual([{ code: 'QITEM_MEAT_BUN', count: 1 }])
    const boy = await near(h.c, 'NPC_CH_BEGGARBOY')
    expect(await act(h.c, { t: 'questTalk', npc: boy.id, quest: 'JG_004', objective: 'nope' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await act(h.c, { t: 'questTalk', npc: boy.id, quest: 'JG_004', objective: 'bun' })).toMatchObject({ ok: true })
    expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_004' && m.event !== 'accepted')).toMatchObject({ event: 'ready', progress: { counts: { bun: 1 }, items: [] } })
    expect(await act(h.c, { t: 'questTalk', npc: boy.id, quest: 'JG_004', objective: 'bun' })).toMatchObject({ ok: false })
    await bye(h)
  }, 90_000)

  it('3. collect: quest drops go to the quest bag, not the ground; questAbandon removes the quest items; a choice turn-in', async () => {
    const h = await hero({ done: ['JG_001', 'JG_002'] })
    await gm(h.c, 'setlevel', h.name, '2')
    await gm(h.c, 'invis', 'on')
    await accept(h, 'NPC_CH_POTION', 'JG_003')
    await gm(h.c, 'tp', ...FIELD)
    roll = () => 0.45 // under the hide's 0.5 chance, over the miss and block chances: a hide on every kill
    try {
      const ids = await spawn(h, MANG, 2)
      await kill(h, ids)
      const u = await h.c.next('questUpdate', (m) => m.quest === 'JG_003' && m.progress?.counts.hides === 2, 10_000)
      expect(u.progress!.items).toEqual([{ code: 'QITEM_MANGYANG_HIDE', count: 2 }])
      expect(await h.c.next('chat', (m) => m.channel === 'system' && /Mangyang Hide \(2\/6\)/.test(m.text))).toBeTruthy()
      expect([...s.ctx.world.items.values()].some((i) => i.code.startsWith('QITEM_'))).toBe(false)
      expect(bag(h.ch.id).some((i) => i?.code.startsWith('QITEM_'))).toBe(false)
      expect(s.ctx.store.db.prepare('SELECT count FROM quest_items WHERE character_id = ? AND code = ?').get(h.ch.id, 'QITEM_MANGYANG_HIDE')).toMatchObject({ count: 2 })

      expect(await act(h.c, { t: 'questAbandon', quest: 'JG_003' })).toMatchObject({ ok: true })
      expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_003' && m.event === 'abandoned')).toMatchObject({ progress: null })
      expect(s.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM quest_items WHERE character_id = ?').get(h.ch.id)).toMatchObject({ n: 0 })

      // again, to the end: six hides -> ready; a turn-in without the reward choice is refused (flow 9)
      await accept(h, 'NPC_CH_POTION', 'JG_003')
      await gm(h.c, 'tp', ...FIELD)
      await kill(h, await spawn(h, MANG, 6))
      await h.c.next('questUpdate', (m) => m.quest === 'JG_003' && m.event === 'ready', 10_000)
    } finally {
      roll = seeded(42)
    }
    const herbalist = await near(h.c, 'NPC_CH_POTION')
    expect(await act(h.c, { t: 'questTurnIn', npc: herbalist.id, quest: 'JG_003' })).toMatchObject({ ok: false, reason: 'choice_required' })
    expect(await act(h.c, { t: 'questTurnIn', npc: herbalist.id, quest: 'JG_003', choice: 7 })).toMatchObject({ ok: false })
    const mp0 = count(h.ch.id, 'ITEM_ETC_MP_POTION_01')
    expect(await act(h.c, { t: 'questTurnIn', npc: herbalist.id, quest: 'JG_003', choice: 1 })).toMatchObject({ ok: true })
    expect(count(h.ch.id, 'ITEM_ETC_MP_POTION_01') - mp0).toBe(10)
    expect(s.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM quest_items WHERE character_id = ?').get(h.ch.id)).toMatchObject({ n: 0 })
    await bye(h)
  }, 90_000)

  it('4. have recount: JG_010 ready with 5 potions; selling one takes it back to active; buying one makes it ready again', async () => {
    const chain = ['JG_001', 'JG_002', 'JG_003', 'JG_004', 'JG_005', 'JG_006', 'JG_008', 'JG_009']
    const h = await hero({ done: chain })
    await gm(h.c, 'setlevel', h.name, '6')
    await gm(h.c, 'invis', 'on')
    await gm(h.c, 'item', 'ITEM_ETC_GOLD_01', '5000')
    await accept(h, 'NPC_CH_SHAMAN', 'JG_010')
    await gm(h.c, 'tp', ...FIELD)
    await kill(h, await spawn(h, 'MOB_CH_WATERGHOST_CLON', 12))
    const slaves = await h.c.next('questUpdate', (m) => m.quest === 'JG_010' && m.progress?.counts.slaves === 12, 10_000)
    expect(slaves.progress!.status).toBe('active')
    await gm(h.c, 'item', HP_SMALL, '5')
    const ready = await h.c.next('questUpdate', (m) => m.quest === 'JG_010' && m.event === 'ready')
    expect(ready.progress!.counts).toMatchObject({ slaves: 12, potions: 5 })

    const herbalist = await near(h.c, 'NPC_CH_POTION')
    const talk = await act(h.c, { t: 'npcTalk', npc: herbalist.id })
    expect(talk, JSON.stringify(talk)).toMatchObject({ ok: true })
    await h.c.next('npcDialog', (m) => m.npc === herbalist.id, 10_000)
    const at = bag(h.ch.id).findIndex((i) => i?.code === HP_SMALL)
    expect(await act(h.c, { t: 'shopSell', npc: herbalist.id, bag: at, count: 1 })).toMatchObject({ ok: true })
    const back = await h.c.next('questUpdate', (m) => m.quest === 'JG_010' && m.progress?.counts.potions === 4)
    expect(back.progress).toMatchObject({ status: 'active', counts: { slaves: 12, potions: 4 } })
    expect(await act(h.c, { t: 'shopBuy', npc: herbalist.id, item: HP_SMALL, count: 1 })).toMatchObject({ ok: true })
    expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_010' && m.event !== 'progress')).toMatchObject({ event: 'ready', progress: { counts: { potions: 5 } } })
    // the turn-in consumes the five
    const shaman = await near(h.c, 'NPC_CH_SHAMAN')
    expect(await act(h.c, { t: 'questTurnIn', npc: shaman.id, quest: 'JG_010' })).toMatchObject({ ok: true })
    expect(count(h.ch.id, HP_SMALL)).toBe(0)
    await bye(h)
  }, 90_000)

  it('6. encounter: the Binding Bell at LOC_TIGER_SHRINE summons the Tiger Girl (hpMul); a second ring -> cooldown; GM spawn count unaffected', async () => {
    const chain = [...book().quests.values()].filter((q) => q.kind === 'main' && q.id < 'JG_025').map((q) => q.id)
    const h = await hero({ done: chain })
    await gm(h.c, 'setlevel', h.name, '19')
    await gm(h.c, 'invis', 'on')
    const acc = await accept(h, 'NPC_CH_SMITH', 'JG_025')
    expect(acc.progress!.items).toEqual([{ code: 'QITEM_BINDING_BELL', count: 1 }])
    expect(await act(h.c, { t: 'questUseItem', quest: 'JG_025', objective: 'bell' })).toMatchObject({ ok: false, reason: 'wrong_place' })
    const shrine = book().location('LOC_TIGER_SHRINE')!
    await gm(h.c, 'tp', String(shrine.x), String(shrine.z))
    await sleep(60)
    const gmSpawned = () => [...s.ctx.world.mobs.values()].filter((m) => m.nest === null && !m.encounter && m.ai !== 'dead').length
    const before = gmSpawned()
    expect(await act(h.c, { t: 'questUseItem', quest: 'JG_025', objective: 'bell' })).toMatchObject({ ok: true })
    const up = await h.c.next('questUpdate', (m) => m.quest === 'JG_025' && m.event === 'objective')
    expect(up).toMatchObject({ objective: 'bell', progress: { counts: { bell: 1, tigergirl: 0, seal: 0 } } })
    const girls = [...s.ctx.world.mobs.values()].filter((m) => m.encounter?.quest === 'JG_025')
    expect(girls).toHaveLength(1)
    const girl: Mob = girls[0]
    expect(girl.def.code).toBe('MOB_CH_TIGERWOMAN')
    expect(girl.maxHp).toBe(Math.round(girl.def.hp * VARIANT_RULES[girl.variant].hp * 0.05))
    expect(gmSpawned()).toBe(before)
    expect(await act(h.c, { t: 'questUseItem', quest: 'JG_025', objective: 'bell' })).toMatchObject({ ok: false, reason: 'cooldown' })
    const r = await gm(h.c, 'spawn', MANG, '1')
    expect(gmSpawned()).toBe(before + 1)
    s.ctx.gameplay.gmKill(s.ctx.world.mobs.get((r.data as { ids: number[] }).ids[0])!)
    girl.hp = 1
    girl.nextRegenAt = Date.now() + 1e9
    expect(await act(h.c, { t: 'attack', target: girl.id })).toMatchObject({ ok: true })
    const done = await h.c.next('questUpdate', (m) => m.quest === 'JG_025' && m.event === 'ready', 10_000)
    expect(done.progress).toMatchObject({ counts: { bell: 1, tigergirl: 1, seal: 1 } })
    expect(s.ctx.gameplay.quests.encounters.all()).toHaveLength(0)
    await bye(h)
  }, 90_000)

  it('7. party: invite/accept, share-mode EXP by the formula, # chat to members only, kill credit without damage, offline and relog', async () => {
    const a = await hero({ done: ['JG_001'] })
    const b = await hero({ done: ['JG_001'] })
    const x = await hero({ gm: false })
    await gm(a.c, 'setlevel', a.name, '3')
    // b takes JG_002 (eight Mangyang) and will not hit anything
    await accept(b, 'NPC_CH_CHEF', 'JG_002')
    for (const h of [a, b]) await gm(h.c, 'tp', ...FIELD)
    await gm(a.c, 'summon', x.name)
    await a.c.next('spawn', (m) => m.entity.id === b.id, 5000).catch(() => undefined)

    expect(await act(a.c, { t: 'partyInvite', target: b.id })).toMatchObject({ ok: true })
    const inv = await b.c.next('partyInvited')
    expect(inv).toMatchObject({ inviter: a.id, name: a.name, exp: 'share', items: 'free' })
    expect(await act(b.c, { t: 'partyRespond', inviter: a.id, accept: true })).toMatchObject({ ok: true })
    for (const p of [a, b]) {
      const st = (await p.c.next('party')).party!
      expect(st).toMatchObject({ leader: a.ch.id, exp: 'share', items: 'free' })
      expect(st.members.map((m) => m.entity)).toEqual([a.id, b.id])
    }

    // a kills a Mangyang; b (level 1, no damage, within 60 m) shares the EXP by level and gets the quest credit
    const [id] = await spawn(a, MANG, 1)
    const mob = s.ctx.world.mobs.get(id)!
    const levels = [player(a.id).level, player(b.id).level]
    expect(levels).toEqual([3, 1])
    const want = levelShares(partyPool(killExp(mob).exp, 2), levels)
    await kill(a, [id])
    const ga = await a.c.next('statsDelta', (d) => d.gain?.from === id, 10_000)
    const gb = await b.c.next('statsDelta', (d) => d.gain?.from === id, 5000)
    expect([ga.gain!.exp, gb.gain!.exp]).toEqual(want)
    expect(await b.c.next('questUpdate', (m) => m.quest === 'JG_002' && m.event === 'progress')).toMatchObject({ progress: { counts: { mangyang: 1 } } })
    expect(x.c.log.some((d) => d.t === 'statsDelta' && d.gain?.from === id)).toBe(false)

    // `#hi` in the client is chat {channel: 'party'}: members only, the sender included
    x.c.queue.length = 0
    a.c.send({ t: 'chat', text: 'hi', channel: 'party' })
    expect(await b.c.next('chat', (l) => l.channel === 'party')).toMatchObject({ from: a.name, text: 'hi' })
    expect(await a.c.next('chat', (l) => l.channel === 'party')).toMatchObject({ text: 'hi' })
    await sleep(250)
    expect(x.c.log.some((l) => l.t === 'chat' && l.channel === 'party')).toBe(false)

    // b disconnects: offline for a; b relogs within the grace: party is the last frame of the enter sequence
    b.c.close()
    await b.c.closed
    expect(await a.c.next('partyEvent', (e) => e.event === 'offline')).toMatchObject({ name: b.name })
    const c2 = await Client.login(s.url, b.acc.token)
    const back = await enter(c2, b.ch.id)
    const again = await c2.next('party')
    expect(again.party!.members.map((m) => m.entity)).toEqual([a.id, back.id])
    expect(back.order()).toEqual(['worldEnter', 'stats', 'inventory', 'skills', 'quests', 'party'])
    expect(await a.c.next('partyEvent', (e) => e.event === 'online')).toMatchObject({ name: b.name })
    expect(await act(c2, { t: 'partyLeave' })).toMatchObject({ ok: true })
    await a.c.next('party', (p) => p.party === null)
    c2.close()
    await c2.closed
    await bye(a, x)
  }, 90_000)

  it('8. editors: /nest add MOB_CH_GYO 8 25 survives a restart and undoes; a quest PUT (count 3) readies a player at 3/8; a player gets 403', async () => {
    const g = await hero()
    await gm(g.c, 'tp', ...FIELD)
    await sleep(60)
    const r = await gm(g.c, 'nest', 'add', 'MOB_CH_GYO', '8', '25')
    const nestId = (r.data as { nest: { id: number } }).nest.id
    expect(nestId).toBeGreaterThanOrEqual(1_000_000)
    await until(() => (s.ctx.gameplay.spawner.nest(nestId)?.alive.size ?? 0) === 8, '8 weasels', 5000)
    await bye(g)

    // restart on the same DATA_DIR: the override is read back before the nests are placed
    const config = s.ctx.config
    const root = s.root
    await s.close()
    const restarted = await startServer({ ...config, port: 0 })
    s = {
      ...restarted,
      root,
      async stopAndClean() {
        await restarted.close()
        rmSync(root, { recursive: true, force: true })
      },
    }
    expect(s.ctx.data.nests.find((n) => n.id === nestId)).toMatchObject({ provenance: 'authored', mob: 'MOB_CH_GYO', count: 8 })
    expect(s.ctx.gameplay.spawner.nest(nestId)?.alive.size).toBe(8)
    const g2 = await hero()
    await gm(g2.c, 'nest', 'undo')
    expect(s.ctx.gameplay.spawner.nest(nestId)?.alive.size ?? 0).toBe(0)
    expect(s.ctx.data.nests.some((n) => n.id === nestId)).toBe(false)

    // a player at 3/8 on JG_002
    const p = await hero({ done: ['JG_001'], gm: false })
    const chief = npc('NPC_CH_CHEF')
    await gm(g2.c, 'tp', String(chief.pos[0] + 1.5), String(chief.pos[2]))
    await gm(g2.c, 'summon', p.name)
    await sleep(100)
    expect(await act(p.c, { t: 'questAccept', npc: chief.id, quest: 'JG_002' })).toMatchObject({ ok: true })
    await gm(g2.c, 'tp', ...FIELD)
    await gm(g2.c, 'summon', p.name)
    await sleep(100)
    const three = await spawn(g2, MANG, 3)
    for (const id of three) {
      expect(await act(p.c, { t: 'attack', target: id })).toMatchObject({ ok: true })
      await until(() => !s.ctx.world.mobs.get(id) || s.ctx.world.mobs.get(id)!.ai === 'dead', `mob ${id} dies`, 10_000)
    }
    await p.c.next('questUpdate', (m) => m.quest === 'JG_002' && m.progress?.counts.mangyang === 3, 10_000)

    const http = async (method: string, path: string, token: string, body?: unknown) => {
      const res = await fetch(s.url + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, json: text ? JSON.parse(text) : null }
    }
    const list = await http('GET', '/api/gm/quests', g2.acc.token)
    expect(list.status).toBe(200)
    const entry = list.json.quests.find((q: { id: string }) => q.id === 'JG_002')
    expect(entry).toMatchObject({ source: 'repo', disabled: false, issues: [] })
    const def = structuredClone(book().quest('JG_002')!) as QuestDef & { rev?: number; disabled?: boolean }
    delete def.rev
    delete def.disabled
    def.objectives = def.objectives.map((o) => (o.id === 'mangyang' ? { ...o, count: 3 } : o)) as QuestDef['objectives']

    // a player: 403 and a denied audit row
    const denied = await http('PUT', '/api/gm/quests/JG_002', p.acc.token, { quest: def, baseRev: entry.rev })
    expect(denied.status).toBe(403)
    expect(s.ctx.store.recentAudit(200).some((a) => a.command === 'questput' && a.ok === 0)).toBe(true)

    p.c.queue.length = 0
    const put = await http('PUT', '/api/gm/quests/JG_002', g2.acc.token, { quest: def, baseRev: entry.rev })
    expect(put.status, JSON.stringify(put.json)).toBe(200)
    expect(put.json).toMatchObject({ ok: true })
    expect(await p.c.next('contentChanged', (m) => m.kind === 'quests')).toMatchObject({ kind: 'quests' })
    const changed = await p.c.next('questUpdate', (m) => m.quest === 'JG_002' && m.event === 'changed')
    expect(changed.progress).toMatchObject({ status: 'ready', counts: { mangyang: 3 } })
    const turnIn = await near(g2.c, 'NPC_CH_CHEF')
    await gm(g2.c, 'summon', p.name)
    await sleep(100)
    expect(await act(p.c, { t: 'questTurnIn', npc: turnIn.id, quest: 'JG_002' })).toMatchObject({ ok: true })

    // revert to the repo version
    const del = await http('DELETE', '/api/gm/quests/JG_002', g2.acc.token)
    expect(del.status).toBe(200)
    expect(book().quest('JG_002')!.objectives[0]).toMatchObject({ count: 8 })
    await bye(g2, p)
  }, 180_000)

  it('9. abuse: extra keys on every wave-4 type -> bad_request; partyKick by a non-leader -> not_leader', async () => {
    const a = await hero()
    const b = await hero()
    await gm(b.c, 'tp', ...FIELD)
    await gm(a.c, 'tp', ...FIELD)
    await a.c.next('spawn', (m) => m.entity.id === b.id, 5000).catch(() => undefined)
    const frames: Record<string, unknown>[] = [
      { t: 'questAccept', npc: 1, quest: 'JG_001' },
      { t: 'questTurnIn', npc: 1, quest: 'JG_001', choice: 0 },
      { t: 'questAbandon', quest: 'JG_001' },
      { t: 'questTalk', npc: 1, quest: 'JG_004', objective: 'bun' },
      { t: 'questUseItem', quest: 'JG_025', objective: 'bell' },
      { t: 'partyInvite', target: b.id, exp: 'share', items: 'free' },
      { t: 'partyRespond', inviter: a.id, accept: true },
      { t: 'partyLeave' },
      { t: 'partyKick', member: 1 },
      { t: 'partyLeader', member: 1 },
      { t: 'partySettings', exp: 'free' },
    ]
    for (const f of frames) {
      a.c.queue.length = 0
      a.c.send({ ...f, extra: 1 })
      expect(await a.c.next('error'), String(f.t)).toMatchObject({ code: 'bad_request' })
    }
    // the connection survives the strikes (fewer than MAX_STRIKES)
    expect(a.c.isClosed).toBe(false)
    expect(await act(a.c, { t: 'partyInvite', target: b.id })).toMatchObject({ ok: true })
    await b.c.next('partyInvited')
    expect(await act(b.c, { t: 'partyRespond', inviter: a.id, accept: true })).toMatchObject({ ok: true })
    expect(await act(b.c, { t: 'partyKick', member: a.ch.id })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(await act(b.c, { t: 'partySettings', items: 'share' })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(await act(a.c, { t: 'partyKick', member: b.ch.id })).toMatchObject({ ok: true })
    await bye(a, b)
  }, 60_000)

  it('5. daily: JG_R01 turned in is refused until the 04:00 reset, then offered again (fake Date past the reset)', async () => {
    const h = await hero({ done: ['JG_001', 'JG_002'] })
    await gm(h.c, 'invis', 'on')
    await accept(h, 'NPC_CH_SOLDIER_EM2', 'JG_R01')
    await gm(h.c, 'tp', ...FIELD)
    await kill(h, await spawn(h, MANG, 20))
    await h.c.next('questUpdate', (m) => m.quest === 'JG_R01' && m.event === 'ready', 10_000)
    const fengil = await near(h.c, 'NPC_CH_SOLDIER_EM2')
    expect(await act(h.c, { t: 'questTurnIn', npc: fengil.id, quest: 'JG_R01' })).toMatchObject({ ok: true })
    const done = await h.c.next('questUpdate', (m) => m.quest === 'JG_R01' && m.event === 'completed')
    const lastAt = done.done!.lastAt
    const reset = nextDailyReset(lastAt, s.ctx.config.questDailyResetHour ?? 4)
    expect(done.done!.availableAt).toBe(reset)
    expect(await act(h.c, { t: 'questAccept', npc: fengil.id, quest: 'JG_R01' })).toMatchObject({ ok: false, reason: 'cooldown' })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      vi.setSystemTime(reset + 60_000)
      expect(await act(h.c, { t: 'questAccept', npc: fengil.id, quest: 'JG_R01' })).toMatchObject({ ok: true })
      expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_R01' && m.event === 'accepted')).toMatchObject({ progress: { counts: {} } })
    } finally {
      vi.useRealTimers()
    }
    await bye(h)
  }, 120_000)
})
