/**
 * Skills end to end over real WebSockets (docs/WAVE_PLAN.md §4.3 skills-e2e): the enter-world `skills` message after
 * `inventory`, the GM `skill` command through the normal role check and audit, a skill cast on a spawned monster
 * (actionResult -> cast -> combat {instance, skill}), the hotbar across a relog, and the useSkill rate limit. Every
 * frame the clients receive passes the strict shared validator (helpers.ts Client).
 */
import type { ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { contentFiles, wrap } from './fixtures.ts'
import { DUMMY, MASTERIES, SKILLS, SKILL_ITEMS, SKILL_LEVELS } from './skills-fixtures.ts'

const SPAWN: [number, number, number] = [50, 0, -50]
const BOUNDS = { min: [0, 0, -400], max: [400, 0, 0] }

let s: TestServer
const logs: string[] = []

beforeAll(async () => {
  s = await startTestServer({
    logs,
    config: { moveSpeed: 10, tickHz: 20, viewRange: 60, rng: () => 0.5, spawnMobs: false },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: BOUNDS }),
      'out/data/skills.json': wrap('skills', SKILLS),
      'out/data/masteries.json': wrap('masteries', MASTERIES),
      ...contentFiles({ mobs: [DUMMY], items: SKILL_ITEMS, levels: SKILL_LEVELS }),
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>
let n = 0

async function enter(c: Client, id: number) {
  c.send({ t: 'enterWorld', id })
  const w = await c.next('worldEnter')
  const order: string[] = []
  const stats = await c.next('stats')
  order.push(stats.t)
  order.push((await c.next('inventory')).t)
  const skills = await c.next('skills')
  order.push(skills.t)
  return { w, skills, order, self: w.self.id }
}

async function hero(opts: { gm?: boolean } = {}) {
  const acc = await newAccount(s.url, opts.gm ? 'skgm' : 'skp')
  if (opts.gm) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
  const c = await Client.login(s.url, acc.token)
  c.send({ t: 'charCreate', name: `Caster${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
  const ch = (await c.next('charCreated')).character
  return { c, acc, ch, ...(await enter(c, ch.id)) }
}

async function act(c: Client, msg: Record<string, unknown> & { t: string }): Promise<Msg<'actionResult'>> {
  c.send(msg)
  return c.next('actionResult', (m) => m.re === msg.t)
}

async function slash(c: Client, text: string) {
  c.send({ t: 'chat', text })
  return c.next('gmResult')
}

describe('skills over the wire', () => {
  it('logs the skills export', () => {
    expect(logs.some((l) => /content skills\.json: \d+ rows, \d+ skill lines, 7 masteries/.test(l))).toBe(true)
  })

  it('enter -> skills after inventory; GM /skill all -> skillsUpdate; cast on a spawned monster; hotbar across a relog', async () => {
    const g = await hero({ gm: true })
    expect(g.order).toEqual(['stats', 'inventory', 'skills'])
    expect(g.skills.hotbar).toHaveLength(40)
    expect(g.skills.skills).toEqual([])
    const r = await slash(g.c, '/skill all 5')
    expect(r).toMatchObject({ ok: true, cmd: 'skill' })
    const up = await g.c.next('skillsUpdate')
    expect(up.masteries).toMatchObject({ BICHEON: 5 })
    expect(up.learned).toContain('SKILL_CH_SWORD_SMASH_A_03')
    // audited like every GM command
    const audit = s.ctx.store.recentAudit(5).find((a) => a.command === 'skill')
    expect(audit).toMatchObject({ ok: 1 })
    // a monster to hit, 3 m away
    expect(await slash(g.c, `/spawn ${DUMMY.code} 1`)).toMatchObject({ ok: true })
    const spawn = await g.c.next('spawn', (m) => m.entity.kind === 'mob')
    expect(await act(g.c, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_03', target: spawn.entity.id })).toMatchObject({ ok: true })
    const cast = await g.c.next('cast')
    expect(cast).toMatchObject({ id: g.self, skill: 'SKILL_CH_SWORD_SMASH_A_03', target: spawn.entity.id, castMs: 400, actionMs: 1000 })
    const combat = await g.c.next('combat', (m) => m.instance === cast.instance)
    expect(combat).toMatchObject({ attacker: g.self, target: spawn.entity.id, skill: 'SKILL_CH_SWORD_SMASH_A_03' })
    // a second use within the 3 s cooldown
    expect(await act(g.c, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_03', target: spawn.entity.id })).toMatchObject({ ok: false, reason: 'cooldown' })
    // hotbar, then relog
    expect(await act(g.c, { t: 'hotbarSet', slot: 0, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } })).toMatchObject({ ok: true })
    g.c.send({ t: 'leaveWorld' })
    await g.c.next('worldLeft')
    const again = await enter(g.c, g.ch.id)
    expect(again.skills.hotbar[0]).toEqual({ kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' })
    expect(again.skills.skills).toContain('SKILL_CH_SWORD_SMASH_A_03')
    expect(again.skills.cooldowns?.[0]?.group).toBe('SKILL_CH_SWORD_SMASH_A')
    g.c.close()
    await g.c.closed
  })

  it('a player cannot run /skill (forbidden, audited as denied)', async () => {
    const p = await hero()
    p.c.send({ t: 'chat', text: '/skill all' })
    const err = await p.c.next('error')
    expect(err).toMatchObject({ code: 'forbidden' })
    expect(s.ctx.store.recentAudit(5).find((a) => a.command === 'skill' && a.ok === 0)).toBeTruthy()
    p.c.close()
    await p.c.closed
  })

  it('11 useSkill back to back -> the 11th is rate_limited', async () => {
    const p = await hero()
    for (let i = 0; i < 11; i++) p.c.send({ t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01' })
    const results: Msg<'actionResult'>[] = []
    for (let i = 0; i < 11; i++) results.push(await p.c.next('actionResult', (m) => m.re === 'useSkill'))
    expect(results.slice(0, 10).every((r) => r.reason === 'not_learned')).toBe(true)
    expect(results[10]).toMatchObject({ ok: false, reason: 'rate_limited' })
    p.c.close()
    await p.c.closed
    await sleep(20)
  })
})
