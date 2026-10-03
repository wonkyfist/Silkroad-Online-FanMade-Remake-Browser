/**
 * Wave 7B end to end (docs/WAVE_PLAN2.md §5.14, the I7B headless flows) on the REAL jangan-fields export: the real
 * server (temp DATA_DIR, work/out + work/out-opt) driven over WebSockets by helpers.ts clients, every frame checked by
 * the strict shared parser.
 *
 *  1. a player kills a GM-spawned Mangnyang: its gold / item `spawn` frames carry `droppedAt` (the kill tick, +-1) and
 *     `dropFrom` (the corpse point)
 *  2. an HP potion: a second client in view gets `itemEffect {id, item}`, a third out of view does not
 *  3. `sit {on: true}` -> `entityUpdate posture 'sit'` to a viewer; `moveTo` -> `posture 'stand'`; `sit` while moving
 *     -> `busy`; `emote 'hi'` -> `emote` to viewers; the 4th emote within 1 s -> `rate_limited`
 *  4. a late joiner sees `posture: 'sit'` in its worldEnter snapshot
 *  5. abuse: `sit` / `emote` with an extra key (or a bad value) -> `bad_request` + a strike; the 20th strike closes
 *
 * Skipped without the export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSE_CODE, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'npcs', 'shops', 'skills', 'masteries'].map((f) => join(OUT, `data/${f}.json`))
const hasExport = (folder: string) => {
  const man = join(OUT, 'world', folder, 'manifest.json')
  if (!existsSync(man) || !DATA.every((f) => existsSync(f))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world', folder, m.nav.file))
}
const HAVE_FIELDS = hasExport('jangan') && hasExport('jangan-fields')

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** The Mangnyang field south of the town gate (wave3-e2e), outside the safe area; ~257 m from the town spawn. */
const FIELD = ['108.97', '120']
const MANG = 'MOB_CH_MANGNYANG'
const HP_POTION = 'ITEM_ETC_HP_POTION_01'

describe.skipIf(!HAVE_FIELDS)('wave 7B flows on WORLD_EXPORT=jangan-fields', () => {
  let s: TestServer
  let roll: () => number = seeded(71)
  let names = 0
  beforeAll(async () => {
    s = await startTestServer({
      config: { outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, moveSpeed: 30, tickHz: 20, rolePollMs: 50, rng: () => roll(), worldExport: 'jangan-fields' },
    })
    expect(s.ctx.nav.kind).toBe('mesh')
  }, 120_000)
  afterAll(async () => {
    await s?.stopAndClean()
  })

  const player = (id: number) => s.ctx.world.players.get(id)!

  async function hero(opts: { gm?: boolean; prefix?: string } = {}) {
    const acc = await newAccount(s.url, opts.prefix ?? 'w7b')
    if (opts.gm) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    const name = `W7b${(Date.now() % 1e4).toString(36)}${++names}`.slice(0, 12)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const w = await c.next('worldEnter')
    await c.next('inventory')
    await c.next('skills')
    return { c, name, ch, w, id: w.self.id }
  }
  type Hero = Awaited<ReturnType<typeof hero>>

  const gm = async (c: Client, cmd: string, ...args: string[]) => {
    c.send({ t: 'gm', cmd, args })
    const r = await c.next('gmResult', (m) => m.cmd === cmd)
    expect(r.ok, `${cmd} ${args.join(' ')}: ${r.message}`).toBe(true)
    return r
  }
  const act = async (c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> => {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
  }
  const bye = async (...heroes: Hero[]) => {
    for (const x of heroes) x.c.close()
    await Promise.all(heroes.map((x) => x.c.closed))
  }
  const slotOf = (characterId: number, code: string) => s.ctx.store.loadInventory(characterId).bag.findIndex((i) => i?.code === code)

  it('1. a kill tosses its loot: every drop spawn carries droppedAt (the kill tick +-1) and dropFrom (the corpse point)', async () => {
    const a = await hero({ gm: true })
    await gm(a.c, 'setlevel', a.name, '20')
    await gm(a.c, 'tp', ...FIELD)
    await a.c.next('warp', (m) => m.id === a.id)
    const r = await gm(a.c, 'spawn', MANG, '1')
    const id = (r.data as { ids: number[] }).ids[0]!
    const mob = s.ctx.world.mobs.get(id)!
    mob.hp = 1 // one landed hit kills it
    // High rolls land every swing; at the death the rolls drop low so every drop row drops (gold and the groups).
    const g = s.ctx.gameplay
    const died = g.mobDied.bind(g)
    g.mobDied = (m, now, rewards) => {
      if (m.id === id) roll = () => 0.001
      died(m, now, rewards)
    }
    roll = () => 0.999
    try {
      expect(await act(a.c, { t: 'attack', target: id })).toMatchObject({ ok: true })
      const kill = await a.c.next('combat', (m) => m.target === id && m.killed === true, 10_000)
      expect(kill.attacker).toBe(a.id)
    } finally {
      g.mobDied = died
      roll = seeded(72)
    }
    const spawns = await (async () => {
      const deadline = Date.now() + 3000
      for (;;) {
        const got = a.c.log.filter((m): m is Msg<'spawn'> => m.t === 'spawn' && m.entity.kind === 'item' && m.entity.dropFrom !== undefined)
        if (got.length || Date.now() > deadline) return got
        await sleep(20)
      }
    })()
    expect(spawns.length).toBeGreaterThan(0)
    const corpse = s.ctx.world.mobs.get(id) ?? mob
    expect(corpse.ai).toBe('dead')
    for (const sp of spawns) {
      expect(Number.isInteger(sp.entity.droppedAt)).toBe(true)
      expect(Math.abs(sp.entity.droppedAt! - Math.round(corpse.diedAt))).toBeLessThanOrEqual(1)
      expect(sp.entity.dropFrom![0]).toBeCloseTo(corpse.pos[0], 3)
      expect(sp.entity.dropFrom![1]).toBeCloseTo(corpse.pos[1], 3)
      expect(sp.entity.dropFrom![2]).toBeCloseTo(corpse.pos[2], 3)
      // the item lands beside the corpse, not on it
      expect(Math.hypot(sp.entity.pos[0] - corpse.pos[0], sp.entity.pos[2] - corpse.pos[2])).toBeGreaterThan(0.2)
    }
    await bye(a)
  }, 30_000)

  it('2. an HP potion: the drinker and a viewer get itemEffect {id, item}; a client out of view does not', async () => {
    const a = await hero({ gm: true })
    const b = await hero()
    const far = await hero({ gm: true })
    await gm(far.c, 'tp', ...FIELD)
    await far.c.next('warp', (m) => m.id === far.id)
    await gm(a.c, 'item', HP_POTION, '3')
    player(a.id).hp = 10 // a potion on a hurt player
    for (const x of [a, b, far]) x.c.queue.length = 0
    expect(await act(a.c, { t: 'itemUse', bag: slotOf(a.ch.id, HP_POTION) })).toMatchObject({ ok: true })
    const want = { t: 'itemEffect', id: a.id, item: HP_POTION }
    expect(await a.c.next('itemEffect')).toEqual(want)
    expect(await b.c.next('itemEffect')).toEqual(want)
    await far.c.none('itemEffect', 300)
    await bye(a, b, far)
  }, 30_000)

  it('3+4. sit / stand / emote reach viewers; sit while moving is busy; the 4th emote in 1 s is rate_limited; a late joiner sees the sitter seated', async () => {
    const a = await hero()
    const b = await hero()
    b.c.queue.length = 0
    // 3. sit: the viewer is told
    expect(await act(a.c, { t: 'sit', on: true })).toMatchObject({ ok: true })
    expect(await b.c.next('entityUpdate', (m) => m.id === a.id && m.posture !== undefined)).toMatchObject({ posture: 'sit' })
    expect(await a.c.next('entityUpdate', (m) => m.id === a.id && m.posture !== undefined)).toMatchObject({ posture: 'sit' })

    // 4. a late joiner: the worldEnter snapshot shows the sitter seated
    const late = await hero()
    const seen = late.w.entities.find((e) => e.id === a.id)
    expect(seen, 'the sitter is in the late joiner snapshot').toBeDefined()
    expect(seen!.posture).toBe('sit')

    // moveTo stands the sitter up (viewers get 'stand' with the move)
    const here = player(a.id).pos
    a.c.send({ t: 'moveTo', x: here[0] + 40, z: here[2] })
    expect(await b.c.next('entityUpdate', (m) => m.id === a.id && m.posture !== undefined)).toMatchObject({ posture: 'stand' })
    expect(await late.c.next('entityUpdate', (m) => m.id === a.id && m.posture !== undefined)).toMatchObject({ posture: 'stand' })
    await b.c.next('move', (m) => m.id === a.id)
    // sit while moving: busy (40 m at 30 m/s is 1.3 s)
    expect(await act(a.c, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'busy' })
    await a.c.next('stop', (m) => m.id === a.id, 5000)
    // emote 'hi' reaches the viewers (the sender too)
    b.c.queue.length = 0
    const results: Msg<'actionResult'>[] = []
    for (let i = 0; i < 4; i++) a.c.send({ t: 'emote', emote: 'hi' })
    for (let i = 0; i < 4; i++) results.push(await a.c.next('actionResult', (m) => m.re === 'emote'))
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['ok', 'ok', 'ok', 'rate_limited'])
    expect(await b.c.next('emote', (m) => m.id === a.id)).toEqual({ t: 'emote', id: a.id, emote: 'hi' })
    expect(a.c.isClosed).toBe(false) // a mashed key is refused, never a strike
    await bye(a, b, late)
  }, 30_000)

  it('5. abuse: sit / emote with an extra key or a bad value are bad_request + a strike (none reach the module); the 20th strike closes', async () => {
    const p = await hero({ prefix: 'bad' })
    p.c.queue.length = 0
    let strikes = 0
    const bad = async (frame: Record<string, unknown>) => {
      p.c.send(frame)
      const err = await p.c.next('error', () => true)
      expect(err.code, JSON.stringify(frame)).toBe('bad_request')
      strikes++
    }
    await bad({ t: 'sit', on: true, x: 1 })
    await bad({ t: 'emote', emote: 'hi', x: 1 })
    await bad({ t: 'sit', on: 'yes' })
    await bad({ t: 'sit' })
    await bad({ t: 'emote', emote: 'dance' })
    await bad({ t: 'emote' })
    expect(p.c.queue.find((m) => m.t === 'actionResult')).toBeUndefined()
    expect(s.ctx.gameplay.posture.isSitting(player(p.id))).toBe(false)
    while (strikes < 19) await bad({ t: 'sit', on: true, spam: 1 })
    expect(p.c.isClosed).toBe(false)
    p.c.send({ t: 'emote', emote: 'hi', spam: 1 })
    expect(await p.c.closed).toMatchObject({ code: CLOSE_CODE.abuse })
  }, 30_000)
})
