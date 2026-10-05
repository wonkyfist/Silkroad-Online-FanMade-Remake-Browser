/**
 * "The Tiger's Shadow" on the real data (docs/QUESTS.md §7 lane B, decision 46): content/quests/jangan.json loads into
 * the server's QuestBook against work/out/data with 0 errors, and on the jangan-fields export the real server plays
 * it: every quest NPC stands in the world; Act I (JG_001 Fengil -> Hwangno, JG_002 eight Mangyang) over WebSockets;
 * the JG_025 finale's Binding Bell at the Tiger Mountain Shrine summons the Tiger Girl with hpMul HP, a second ring
 * answers cooldown, and GM spawns are unaffected. Skipped without the exports.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { VARIANT_RULES } from '../src/formulas.ts'
import { GameData } from '../src/gamedata.ts'
import { QuestBook } from '../src/quests/book.ts'
import { questRefs } from '../src/quests/engine.ts'
import { seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const CONTENT = join(REPO_ROOT, 'content')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'npcs', 'shops'].map((f) => join(OUT, `data/${f}.json`))
const HAVE_DATA = DATA.every((f) => existsSync(f)) && existsSync(join(CONTENT, 'quests/jangan.json'))
const HAVE_FIELDS = (() => {
  const man = join(OUT, 'world/jangan-fields/manifest.json')
  if (!HAVE_DATA || !existsSync(man)) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world/jangan-fields', m.nav.file))
})()

/** The Mangnyang field south of the town gate, outside the safe area (wave3-e2e's FIELD). */
const FIELD = ['108.97', '120']

describe.skipIf(!HAVE_DATA)('jangan.json against the export', () => {
  it('loads into the QuestBook with 0 errors; every giver and turn-in is a Jangan NPC', () => {
    const data = GameData.load(OUT)
    const logs: string[] = []
    const book = QuestBook.load({ contentDir: CONTENT, refs: questRefs({ data, config: { levelCap: 20 } as never }), log: (m) => logs.push(m) })
    const errors = book.files.flatMap((f) => f.issues.filter((i) => i.severity === 'error').map((i) => `${f.name} ${i.path}: ${i.message}`))
    expect(errors).toEqual([])
    expect(book.problems).toEqual([])
    expect(book.quests.size).toBeGreaterThanOrEqual(34)
    const npcs = new Set(data.npcs.filter((n) => n.world === 'jangan').map((n) => n.code))
    for (const q of book.quests.values()) {
      expect(npcs.has(q.giver), `${q.id} giver ${q.giver}`).toBe(true)
      expect(npcs.has(q.turnIn), `${q.id} turnIn ${q.turnIn}`).toBe(true)
    }
    expect(logs[0]).toMatch(/content quests: \d+ quests, \d+ quest items, \d+ locations from 1 files; 0 errors/)
    // the catalog carries every quest once
    const ids = book.catalog().files.flatMap((f) => f.quests.map((q) => q.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(book.quests.size)
  })
})

describe.skipIf(!HAVE_FIELDS)('The Tiger\'s Shadow on jangan-fields', () => {
  let s: TestServer
  const logs: string[] = []
  let names = 0

  beforeAll(async () => {
    s = await startTestServer({
      logs,
      config: { outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(11), worldExport: 'jangan-fields', contentDir: CONTENT },
    })
    expect(s.ctx.nav.kind).toBe('mesh')
  }, 120_000)
  afterAll(async () => s?.stopAndClean())

  const npc = (code: string) => {
    const n = [...s.ctx.world.npcs.values()].find((x) => x.code === code)
    if (!n) throw new Error(`no NPC ${code}`)
    return n
  }
  const act = async (c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> => {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
  }
  const gm = async (c: Client, cmd: string, ...args: string[]) => {
    c.send({ t: 'gm', cmd, args })
    const r = await c.next('gmResult', (m) => m.cmd === cmd)
    expect(r.ok, `${cmd} ${args.join(' ')}: ${r.message}`).toBe(true)
    return r
  }
  /** A GM hero in the world; `done` quests are recorded before it enters. */
  const hero = async (done: string[] = []) => {
    const acc = await newAccount(s.url, 'qc')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    const name = `Qc${(Date.now() % 1e5).toString(36)}${++names}`.slice(0, 12)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    const ins = s.ctx.store.db.prepare('INSERT INTO quest_done (character_id, quest, times, last_at) VALUES (?, ?, 1, ?)')
    for (const q of done) ins.run(ch.id, q, Date.now() - 1000)
    c.send({ t: 'enterWorld', id: ch.id })
    const w = await c.next('worldEnter')
    const quests = await c.next('quests')
    return { c, ch, name, id: w.self.id, quests }
  }
  /** Teleports next to an NPC (inside the 8 m interact range). */
  const near = async (c: Client, code: string) => {
    const n = npc(code)
    await gm(c, 'tp', String(n.pos[0] + 1.5), String(n.pos[2]))
    await sleep(60)
    return n
  }

  it('every quest giver and turn-in NPC stands in the world (Miaoryeong included)', () => {
    const book = s.ctx.gameplay.quests.book
    expect(book.quests.size).toBeGreaterThanOrEqual(34)
    const placed = new Set([...s.ctx.world.npcs.values()].map((n) => n.code))
    const missing = [...book.quests.values()].flatMap((q) => [q.giver, q.turnIn]).filter((c) => !placed.has(c))
    expect([...new Set(missing)]).toEqual([])
    expect(logs.some((l) => /content quests: \d+ quests/.test(l))).toBe(true)
  })

  it('Act I: JG_001 at Soldier Fengil -> Chief Hwangno (5 herbs, gain.quest), JG_002 eight Mangyang -> turn in', async () => {
    const h = await hero()
    expect(h.quests).toMatchObject({ active: [], done: [] })
    const fengil = await near(h.c, 'NPC_CH_SOLDIER_EM2')
    expect(await act(h.c, { t: 'npcTalk', npc: fengil.id })).toMatchObject({ ok: true })
    expect((await h.c.next('npcDialog', (m) => m.npc === fengil.id)).services).toContain('quest')
    expect(await act(h.c, { t: 'questAccept', npc: fengil.id, quest: 'JG_001' })).toMatchObject({ ok: true })
    expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_001')).toMatchObject({ event: 'accepted', progress: { status: 'ready' } })
    const chief = await near(h.c, 'NPC_CH_CHEF')
    expect(await act(h.c, { t: 'questTurnIn', npc: chief.id, quest: 'JG_001' })).toMatchObject({ ok: true })
    expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_001')).toMatchObject({ event: 'completed', progress: null })
    expect((await h.c.next('statsDelta', (m) => m.gain?.quest === 'JG_001')).gain).toEqual({ exp: 60, spExp: 400, quest: 'JG_001' })
    const bag = s.ctx.store.loadInventory(h.ch.id).bag
    expect(bag.filter((i) => i?.code === 'ITEM_ETC_HP_POTION_01').reduce((n, i) => n + i!.count, 0)).toBe(5)

    expect(await act(h.c, { t: 'questAccept', npc: chief.id, quest: 'JG_002' })).toMatchObject({ ok: true })
    await h.c.next('questUpdate', (m) => m.quest === 'JG_002' && m.event === 'accepted')
    await gm(h.c, 'tp', ...FIELD)
    await gm(h.c, 'invis', 'on')
    const r = await gm(h.c, 'spawn', 'MOB_CH_MANGNYANG', '8')
    const ids = (r.data as { ids: number[] }).ids
    expect(ids).toHaveLength(8)
    for (const id of ids) {
      const m = s.ctx.world.mobs.get(id)!
      m.hp = 1
      m.nextRegenAt = Date.now() + 1e9
    }
    let last: Msg<'questUpdate'> | null = null
    for (const id of ids) {
      expect(await act(h.c, { t: 'attack', target: id })).toMatchObject({ ok: true })
      last = await h.c.next('questUpdate', (m) => m.quest === 'JG_002' && m.event !== 'accepted', 10_000)
    }
    expect(last).toMatchObject({ event: 'ready', progress: { counts: { mangyang: 8 }, status: 'ready' } })
    await near(h.c, 'NPC_CH_CHEF')
    expect(await act(h.c, { t: 'questTurnIn', npc: chief.id, quest: 'JG_002' })).toMatchObject({ ok: true })
    expect((await h.c.next('statsDelta', (m) => m.gain?.quest === 'JG_002')).gain).toMatchObject({ exp: 120, quest: 'JG_002' })
    h.c.close()
    await h.c.closed
  }, 60_000)

  it('PACE: JG_S05 Fengil -> Mrs Jang -> Chulsan (300 gold); JG_004 gives 2 Return Scrolls; Miaoryeong at the river bridge', async () => {
    const miao = npc('NPC_CH_SHAMAN')
    // On the river bridge's town end (content/npcs.override.json rev 2): the old spot by the bank (-410, -300) ended up
    // inside a bush after wave 12's plants. Still 60 m beyond every aggressive roam circle.
    expect(Math.hypot(miao.pos[0] + 419, miao.pos[2] + 314)).toBeLessThan(1)
    expect(logs.some((l) => /repo content npcs .*1 patched/.test(l))).toBe(true)
    const h = await hero(['JG_001', 'JG_002'])
    await gm(h.c, 'invis', 'on')
    const fengil = await near(h.c, 'NPC_CH_SOLDIER_EM2')
    expect(await act(h.c, { t: 'questAccept', npc: fengil.id, quest: 'JG_S05' })).toMatchObject({ ok: true })
    await h.c.next('questUpdate', (m) => m.quest === 'JG_S05' && m.event === 'accepted')
    const smith = await near(h.c, 'NPC_CH_SMITH')
    expect(await act(h.c, { t: 'questTurnIn', npc: smith.id, quest: 'JG_S05' })).toMatchObject({ ok: false, reason: 'not_complete' })
    const jang = await near(h.c, 'NPC_CH_ARMOR')
    expect(await act(h.c, { t: 'questTalk', npc: jang.id, quest: 'JG_S05', objective: 'armour' })).toMatchObject({ ok: true })
    expect(await h.c.next('questUpdate', (m) => m.quest === 'JG_S05' && m.event === 'ready')).toMatchObject({ progress: { counts: { armour: 1 } } })
    await near(h.c, 'NPC_CH_SMITH')
    const gold0 = s.ctx.store.loadInventory(h.ch.id).gold
    expect(await act(h.c, { t: 'questTurnIn', npc: smith.id, quest: 'JG_S05' })).toMatchObject({ ok: true })
    expect((await h.c.next('statsDelta', (m) => m.gain?.quest === 'JG_S05')).gain).toMatchObject({ exp: 40, quest: 'JG_S05' })
    expect(s.ctx.store.loadInventory(h.ch.id).gold - gold0).toBe(300)
    // JG_004 (level 2): the bun to Sochil, then two Return Scrolls from the Chief
    await gm(h.c, 'setlevel', h.name, '2')
    const chief = await near(h.c, 'NPC_CH_CHEF')
    expect(await act(h.c, { t: 'questAccept', npc: chief.id, quest: 'JG_004' })).toMatchObject({ ok: true })
    await h.c.next('questUpdate', (m) => m.quest === 'JG_004' && m.event === 'accepted')
    const boy = await near(h.c, 'NPC_CH_BEGGARBOY')
    expect(await act(h.c, { t: 'questTalk', npc: boy.id, quest: 'JG_004', objective: 'bun' })).toMatchObject({ ok: true })
    await h.c.next('questUpdate', (m) => m.quest === 'JG_004' && m.event === 'ready')
    await near(h.c, 'NPC_CH_CHEF')
    expect(await act(h.c, { t: 'questTurnIn', npc: chief.id, quest: 'JG_004' })).toMatchObject({ ok: true })
    await h.c.next('questUpdate', (m) => m.quest === 'JG_004' && m.event === 'completed')
    const bag = s.ctx.store.loadInventory(h.ch.id).bag
    expect(bag.filter((i) => i?.code === 'ITEM_ETC_SCROLL_RETURN_01').reduce((n, i) => n + i!.count, 0)).toBe(2)
    h.c.close()
    await h.c.closed
  }, 60_000)

  it('JG_025: the Binding Bell at the Tiger Mountain Shrine summons the Tiger Girl (hpMul), once per group; GM spawn unaffected', async () => {
    const book = s.ctx.gameplay.quests.book
    const chain = [...book.quests.values()].filter((q) => q.kind === 'main' && q.id < 'JG_025').map((q) => q.id)
    const h = await hero(chain)
    await gm(h.c, 'setlevel', h.name, '19')
    await gm(h.c, 'invis', 'on')
    const smith = await near(h.c, 'NPC_CH_SMITH')
    expect(await act(h.c, { t: 'questAccept', npc: smith.id, quest: 'JG_025' })).toMatchObject({ ok: true })
    const acc = await h.c.next('questUpdate', (m) => m.quest === 'JG_025')
    expect(acc.progress!.items).toEqual([{ code: 'QITEM_BINDING_BELL', count: 1 }])
    // not here
    expect(await act(h.c, { t: 'questUseItem', quest: 'JG_025', objective: 'bell' })).toMatchObject({ ok: false, reason: 'wrong_place' })
    const shrine = book.location('LOC_TIGER_SHRINE')!
    await gm(h.c, 'tp', String(shrine.x), String(shrine.z))
    await sleep(60)
    expect(await act(h.c, { t: 'questUseItem', quest: 'JG_025', objective: 'bell' })).toMatchObject({ ok: true })
    const up = await h.c.next('questUpdate', (m) => m.quest === 'JG_025' && m.event === 'objective')
    expect(up).toMatchObject({ objective: 'bell', progress: { counts: { bell: 1, tigergirl: 0, seal: 0 } } })
    expect(up.progress!.encounterUntil).toBeGreaterThan(Date.now() + 590_000)
    const girls = [...s.ctx.world.mobs.values()].filter((m) => m.encounter?.quest === 'JG_025')
    expect(girls).toHaveLength(1)
    const girl = girls[0]
    expect(girl.def.code).toBe('MOB_CH_TIGERWOMAN')
    expect(girl.maxHp).toBe(Math.round(girl.def.hp * VARIANT_RULES[girl.variant].hp * 0.05))
    const me = s.ctx.world.players.get(h.id)!
    expect(Math.hypot(girl.pos[0] - me.pos[0], girl.pos[2] - me.pos[2])).toBeLessThanOrEqual(8.5)
    expect(await act(h.c, { t: 'questUseItem', quest: 'JG_025', objective: 'bell' })).toMatchObject({ ok: false, reason: 'cooldown' })
    await gm(h.c, 'spawn', 'MOB_CH_MANGNYANG', '1')
    // she counts once killed: the kill and the Jade Seal (100 %) complete the quest
    girl.hp = 1
    girl.nextRegenAt = Date.now() + 1e9
    expect(await act(h.c, { t: 'attack', target: girl.id })).toMatchObject({ ok: true })
    const done = await h.c.next('questUpdate', (m) => m.quest === 'JG_025' && m.event === 'ready', 10_000)
    expect(done.progress).toMatchObject({ counts: { bell: 1, tigergirl: 1, seal: 1 }, items: expect.arrayContaining([{ code: 'QITEM_JADE_SEAL', count: 1 }]) })
    expect(s.ctx.gameplay.quests.encounters.all()).toHaveLength(0)
    h.c.close()
    await h.c.closed
  }, 60_000)
})
