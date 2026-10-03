/**
 * Skill points (docs/PLAYTEST.md §3, docs/BALANCE.md §4): SP comes only from SP-EXP (kills, quests), every 400 SP-EXP
 * is 1 SP, and a level-up alone gives none. End to end on a real server with EXP_RATE = SP_RATE = 3: the kill share is
 * rated, rolls over into SP at 400, statsDelta carries it and it is saved. GM setlevel grants the stat points and the
 * typical SP of the levels it raises (progression.ts TYPICAL_SP_BY_LEVEL), keeps SP when lowering, and audits both.
 */
import { CHARACTER_RULES, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeSetLevel, setLevel, TYPICAL_SP_BY_LEVEL, typicalSp } from '../src/progression.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, contentFiles, mob, nest, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

describe('typical SP by level (BALANCE.md §4)', () => {
  it('matches the balance table and grows past it with the kill SP-EXP of each level', () => {
    expect(TYPICAL_SP_BY_LEVEL).toHaveLength(20)
    // The rows BALANCE.md §4 prints.
    for (const [level, sp] of [[5, 10], [6, 16], [7, 28], [8, 48], [10, 118], [12, 250], [14, 499], [16, 894], [20, 2530]])
      expect(typicalSp(level), `level ${level}`).toBe(sp)
    for (let l = 2; l <= 20; l++) expect(typicalSp(l)).toBeGreaterThanOrEqual(typicalSp(l - 1))
    expect(typicalSp(1)).toBe(0)
    expect(typicalSp(22)).toBe(2530)
    expect(typicalSp(22, (l) => (l === 20 ? 4000 : l === 21 ? 801 : 0))).toBe(2530 + 10 + 2)
  })

  it('setLevel: raising grants growth and SP, lowering takes back only unspent points and never SP', () => {
    const p = { level: 1, exp: 10, sp: 5, spExp: 192, str: 20, int: 20, statPoints: 0 }
    expect(setLevel(p, 12)).toEqual({ from: 1, to: 12, str: 11, int: 11, statPoints: 33, spentKept: 0, sp: 250 })
    expect(p).toEqual({ level: 12, exp: 0, sp: 255, spExp: 192, str: 31, int: 31, statPoints: 33 })
    // spend 30 of the 33 points, then lower by 5 levels: 15 points to take back, only 3 left unspent
    p.str += 30
    p.statPoints = 3
    const down = setLevel(p, 7)
    expect(down).toEqual({ from: 12, to: 7, str: -5, int: -5, statPoints: -3, spentKept: 12, sp: 0 })
    expect(p).toMatchObject({ level: 7, sp: 255, spExp: 192, str: 56, int: 26, statPoints: 0 })
    expect(describeSetLevel(down)).toBe('STR -5, INT -5, stat points -3, 12 spent stat points kept, SP kept (+0)')
    // raising again grants the SP of those levels again (documented; the GM audit shows it)
    expect(setLevel(p, 8).sp).toBe(48 - 28)
    expect(describeSetLevel(setLevel(p, 8))).toBe('STR +0, INT +0, stat points +0, SP +0')
  })
})

describe('SP end to end (EXP_RATE = SP_RATE = 3)', () => {
  const SPAWN: [number, number, number] = [50, 0, -50]
  /** One kill = 10 EXP and 150 SP-EXP at rate 1; 30 EXP and 450 SP-EXP at rate 3. */
  const SPMOB = mob('MOB_CH_SPTEST', { name: 'Sp Test', exp: 10, spExp: 150, hp: 20 })
  let s: TestServer
  let n = 0

  beforeAll(async () => {
    s = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, viewRange: 60, rng: seeded(7), expRate: 3, spRate: 3 },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ mobs: [SPMOB], nests: [nest(1, SPMOB.code, 56, -50, { count: 2, radius: 1, spawnRadius: 1, respawnSec: [600, 600] })], items: ITEMS, levels: LEVELS }),
      },
    })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  async function player(gm = false) {
    const acc = await newAccount(s.url, gm ? 'spgm' : 'spp')
    if (gm) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    const name = `${gm ? 'Keeper' : 'Learner'}${++n}`
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    const stats = (await c.next('stats')).stats
    return { c, ch, enter, stats, name, id: enter.self.id }
  }

  async function killIt(c: Client, target: number): Promise<void> {
    c.send({ t: 'attack', target })
    expect(await c.next('actionResult', (m) => m.re === 'attack')).toMatchObject({ ok: true })
    const deadline = Date.now() + 15_000
    for (;;) {
      const m = await c.next('combat', (x) => x.target === target, Math.max(1, deadline - Date.now()))
      if (m.killed) return
    }
  }

  it('kills give rated SP-EXP that rolls over into SP at 400, is sent in statsDelta and saved', async () => {
    const p = await player()
    expect(p.stats).toMatchObject({ level: 1, sp: 0, spExp: 0 })
    const mobs = p.enter.entities.filter((e) => e.kind === 'mob' && e.model === SPMOB.code)
    expect(mobs).toHaveLength(2)

    await killIt(p.c, mobs[0]!.id)
    const d1: Msg<'statsDelta'> = await p.c.next('statsDelta', (m) => m.gain !== undefined)
    expect(d1.gain).toMatchObject({ exp: 30, spExp: 450, from: mobs[0]!.id })
    expect(d1.stats).toMatchObject({ sp: 1, spExp: 50 })
    // 30 EXP is exactly level 1 -> 2 (fixture LEVELS): the level-up brings full stats, still with the kill's SP only
    expect((await p.c.next('stats')).stats).toMatchObject({ level: 2, sp: 1, spExp: 50, statPoints: 3 })

    await killIt(p.c, mobs[1]!.id)
    const d2: Msg<'statsDelta'> = await p.c.next('statsDelta', (m) => m.gain !== undefined)
    expect(d2.gain).toMatchObject({ spExp: 450 })
    expect(d2.stats).toMatchObject({ sp: 2, spExp: 100 })
    expect(2 * 450).toBe(2 * CHARACTER_RULES.spExpPerSp + 100)

    // saved at once, and back after a re-enter
    expect(s.ctx.store.characterByName(p.name)).toMatchObject({ sp: 2, sp_exp: 100 })
    p.c.send({ t: 'leaveWorld' })
    await p.c.next('worldLeft')
    p.c.send({ t: 'enterWorld', id: p.ch.id })
    await p.c.next('worldEnter')
    expect((await p.c.next('stats')).stats).toMatchObject({ sp: 2, spExp: 100 })
    p.c.close()
    await p.c.closed
  })

  it('GM setlevel grants stat points and typical SP when raising, keeps SP when lowering, and audits it', async () => {
    const g = await player(true)
    const p = await player()
    g.c.send({ t: 'gm', cmd: 'setlevel', args: [p.name, '12'] })
    const up = await g.c.next('gmResult')
    expect(up).toMatchObject({ ok: true, data: { level: 12, from: 1, sp: 250, statPoints: 33, online: true } })
    expect(up.message).toBe(`${p.name} is now level 12 (STR +11, INT +11, stat points +33, SP +250).`)
    expect(s.ctx.store.recentAudit(1)[0]).toMatchObject({ command: 'setlevel', ok: 1, result: up.message })
    expect((await p.c.next('stats')).stats).toMatchObject({ level: 12, sp: 250, statPoints: 33, str: 31, int: 31 })

    g.c.send({ t: 'gm', cmd: 'setlevel', args: [p.name, '5'] })
    const down = await g.c.next('gmResult')
    expect(down).toMatchObject({ ok: true, data: { level: 5, from: 12, sp: 0, statPoints: -21 } })
    expect(down.message).toContain('SP kept')
    expect((await p.c.next('stats')).stats).toMatchObject({ level: 5, sp: 250, statPoints: 12, str: 24 })

    // offline: raising 5 -> 10 adds typicalSp(10) - typicalSp(5) = 108
    p.c.send({ t: 'leaveWorld' })
    await p.c.next('worldLeft')
    g.c.send({ t: 'gm', cmd: 'setlevel', args: [p.name, '10'] })
    expect(await g.c.next('gmResult')).toMatchObject({ ok: true, data: { online: false, sp: 108 } })
    expect(s.ctx.store.characterByName(p.name)).toMatchObject({ level: 10, sp: 358, stat_points: 27 })
    expect(s.ctx.store.recentAudit(1)[0]!.result).toContain('SP +108')
    for (const c of [g.c, p.c]) {
      c.close()
      await c.closed
    }
    await sleep(20)
  })
})
