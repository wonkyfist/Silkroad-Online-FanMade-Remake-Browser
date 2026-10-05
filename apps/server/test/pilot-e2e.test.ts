/**
 * Play the Boss over real WebSockets (docs/PLAY_THE_BOSS.md §7 "Integration", layers 1 and 3): a real server on a
 * synthetic flat world with Tiger Girl's camps and rows, Client bots whose every frame passes the shared strict
 * validator. `/unique pilot attach`: the pilot's moveTo moves her for every viewer, its free chat is refused, a taunt
 * reaches the hunters, a claw hurts a bot, detach wakes the body. `/unique pilot <name>`: offer, accept, the hunt for
 * everyone, a GM stop. Layer 4: `/unique pilot start`, the call with each player's own `you`, `pilotVolunteer`, the
 * admin route behind a session. The play-time counter (migration 12) grows with the saves.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ITEMS, LEVELS, contentFiles, item, seeded, wrap } from './fixtures.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { resetSettings, saveSettings } from '../src/pilot/settings.ts'
import { CAMPS, MOBS, REAL_FILE, TG, TG_ROWS } from './pilot-harness.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const TOWN = { code: 'TOWN', name: 'Town', world: 'jangan', spawn: { x: 200, y: 0, z: 200 }, safeArea: { x: 200, z: 200, halfX: 10, halfZ: 10 } }
const LOOT = [
  ...['WEAPON', 'ARMOR', 'SHIELD', 'ACCESSARY'].map((k) => item(`ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_${k}_A`, { category: 'alchemy' })),
  item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', { category: 'alchemy', maxStack: 50 }),
  item('ITEM_ETC_HP_POTION_04', { category: 'potion', maxStack: 50 }),
  item('ITEM_ETC_MP_POTION_04', { category: 'potion', maxStack: 50 }),
]

let s: TestServer
let content: string
const logs: string[] = []

beforeAll(async () => {
  content = mkdtempSync(join(tmpdir(), 'sro-pilot-e2e-'))
  writeFileSync(join(content, 'uniques.json'), JSON.stringify(REAL_FILE))
  s = await startTestServer({
    logs,
    config: { tickHz: 20, viewRange: 120, rng: seeded(7), contentDir: content, uniques: true, mobLevelMax: 25 },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [200, 0, 200], bounds: { min: [-500, 0, -500], max: [500, 0, 500] }, places: { 'palace-steps': [200, 0, 205] } }),
      ...contentFiles({ mobs: MOBS, nests: CAMPS, items: [...ITEMS, ...LOOT], levels: LEVELS }),
      'out/data/skills.json': wrap('skills', TG_ROWS),
      'out/data/towns.json': JSON.stringify([TOWN]),
    },
  })
  expect(s.ctx.gameplay.pilot?.steerable()).toHaveLength(1)
})

afterAll(async () => {
  await s?.stopAndClean()
  rmSync(content, { recursive: true, force: true })
})

let n = 0
async function player(gmRole = false) {
  const acc = await newAccount(s.url, gmRole ? 'pgm' : 'pp')
  if (gmRole) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
  const c = await Client.login(s.url, acc.token)
  const name = `Boss${++n}`
  c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: ch.id })
  const enter = await c.next('worldEnter')
  return { c, name, id: enter.self.id, characterId: ch.id }
}

async function gm(c: Client, ...args: string[]): Promise<Msg<'gmResult'>> {
  c.send({ t: 'gm', cmd: 'unique', args })
  return c.next('gmResult', (m) => m.cmd === 'unique', 5000)
}

describe('Play the Boss end to end', () => {
  it('attach: steering, the chat mute, a taunt, a claw on a bot, detach', async () => {
    const g = await player(true)
    const pilot = await player()
    const hunter = await player()
    const spawn = await gm(g.c, 'spawn', 'tiger', 'camp', '5903')
    expect(spawn.ok, spawn.message).toBe(true)
    const her = [...s.ctx.world.mobs.values()].find((m) => m.def.code === TG)!
    const hp = s.ctx.world.players.get(hunter.id)!
    s.ctx.world.warp(hp, her.pos[0] + 3, 0, her.pos[2])
    await hunter.c.next('spawn', (m) => m.entity.id === her.id)
    const r = await gm(g.c, 'pilot', 'attach', pilot.name)
    expect(r.ok, r.message).toBe(true)
    const start = await pilot.c.next('pilotStart')
    expect(start.mob).toBe(her.id)
    expect(start.kit).toHaveLength(7)
    await pilot.c.next('entityUpdate', (m) => m.id === pilot.id && m.trance === true)
    // Her move reaches the hunter, at her speed.
    pilot.c.send({ t: 'moveTo', x: her.pos[0] + 2, z: her.pos[2] + 20 })
    const mv = await hunter.c.next('move', (m) => m.id === her.id)
    expect(mv.move.speed).toBe(9)
    // Free chat refused; the taunt goes out as a fixed line.
    pilot.c.send({ t: 'chat', text: 'go easy on me' })
    expect(await pilot.c.next('error', (m) => m.re === 'chat')).toMatchObject({ code: 'forbidden' })
    pilot.c.send({ t: 'pilotTaunt', line: 3 })
    expect(await hunter.c.next('huntTaunt')).toEqual({ t: 'huntTaunt', id: her.id, line: 3 })
    // A claw on the hunter (she walks back into reach first).
    pilot.c.send({ t: 'pilotAct', ability: 'claw', target: hunter.id })
    expect(await pilot.c.next('actionResult', (m) => m.re === 'pilotAct')).toMatchObject({ ok: true })
    const hit = await hunter.c.next('combat', (m) => m.attacker === her.id && m.target === hunter.id, 8000)
    expect(hit.skill).toBe('MSKILL_CH_TIGERWOMAN_ATTACK01')
    // The body's own requests are refused.
    pilot.c.send({ t: 'jump' })
    expect(await pilot.c.next('actionResult', (m) => m.re === 'jump')).toMatchObject({ ok: false, reason: 'piloting' })
    const d = await gm(g.c, 'pilot', 'detach')
    expect(d.ok).toBe(true)
    expect(await pilot.c.next('pilotEnd')).toMatchObject({ event: 0, reason: 'cancelled' })
    await pilot.c.next('entityUpdate', (m) => m.id === pilot.id && m.trance === false)
    for (const x of [g, pilot, hunter]) x.c.close()
  }, 20_000)

  it('a GM pick: offer, accept, the hunt for everyone, a GM stop', async () => {
    const g = await player(true)
    const pilot = await player()
    const hunter = await player()
    const r = await gm(g.c, 'pilot', pilot.name)
    expect(r.ok, r.message).toBe(true)
    const offer = await pilot.c.next('pilotOffer')
    expect((await hunter.c.next('huntEvent')).event).toMatchObject({ id: offer.event, phase: 'offer' })
    pilot.c.send({ t: 'pilotAnswer', event: offer.event, accept: true })
    expect(await pilot.c.next('actionResult', (m) => m.re === 'pilotAnswer')).toMatchObject({ ok: true })
    const start = await pilot.c.next('pilotStart')
    expect(start.event).toBe(offer.event)
    expect(start.huntEndsAt).toBeGreaterThan(Date.now() + 14 * 60_000)
    const hunt = await hunter.c.next('huntEvent', (m) => m.event.phase === 'hunt')
    expect(hunt.event.pilot).toBeUndefined()
    expect((await gm(g.c, 'pilot', 'status')).message).toMatch(/hunt/)
    expect((await gm(g.c, 'pilot', 'stop')).ok).toBe(true)
    expect(await pilot.c.next('pilotEnd')).toMatchObject({ event: offer.event, reason: 'cancelled' })
    expect((await hunter.c.next('huntEvent', (m) => m.event.phase === 'ended')).event).toMatchObject({ outcome: 'cancelled', pilot: pilot.name })
    for (const x of [g, pilot, hunter]) x.c.close()
  }, 20_000)

  it('layer 4: a call over the wire (huntEvent call with each own `you`, pilotVolunteer), the admin route needs a session', async () => {
    const conf = s.ctx.gameplay.pilot!.conf('')
    if (typeof conf === 'string') throw new Error(conf)
    // New characters are level 1 with no play time: open the lottery to them for this test.
    const saved = saveSettings(s.ctx.gameplay.pilot!.store, conf, conf.rev, { eligibility: { minLevel: 1, minPlayHours: 0 } }, null, Date.now(), s.ctx.config.levelCap)
    expect(saved.ok).toBe(true)
    const g = await player(true)
    const a = await player()
    const r = await gm(g.c, 'pilot', 'start', '2')
    expect(r.ok, r.message).toBe(true)
    const call = await a.c.next('huntEvent', (m) => m.event.phase === 'call')
    expect(call.event).toMatchObject({ volunteers: 0, minLevel: 1, you: { volunteered: false, eligible: true } })
    a.c.send({ t: 'pilotVolunteer', on: true })
    expect(await a.c.next('actionResult', (m) => m.re === 'pilotVolunteer')).toMatchObject({ ok: true })
    expect((await a.c.next('huntEvent', (m) => m.event.you?.volunteered === true)).event).toMatchObject({ volunteers: 1 })
    // The admin route: no session 401; an admin's session sees the call.
    const none = await fetch(`${s.url}/api/admin/boss`)
    expect(none.status).toBe(401)
    const admin = await newAccount(s.url, 'padm')
    s.ctx.store.setRole(s.ctx.store.accountByName(admin.username)!.id, 'admin')
    const login = await fetch(`${s.url}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: admin.username, password: 'password1' }) })
    expect(login.status).toBe(200)
    const token = ((await login.json()) as { token: string }).token
    const view = await fetch(`${s.url}/api/admin/boss`, { headers: { Authorization: `Bearer ${token}` } })
    expect(view.status).toBe(200)
    expect(((await view.json()) as { current: { phase: string; volunteers: number } }).current).toMatchObject({ phase: 'call', volunteers: 1 })
    const stop = await fetch(`${s.url}/api/admin/boss/stop`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })
    expect(stop.status).toBe(200)
    expect((await a.c.next('huntEvent', (m) => m.event.phase === 'ended')).event).toMatchObject({ outcome: 'cancelled' })
    resetSettings(s.ctx.gameplay.pilot!.store, conf, undefined, undefined, null, Date.now(), s.ctx.config.levelCap)
    for (const x of [g, a]) x.c.close()
  }, 20_000)

  it('played_ms (migration 12) grows with each save from the enter-world save on', async () => {
    const a = await player()
    const p = s.ctx.world.players.get(a.id)!
    const before = s.ctx.store.characterById(a.characterId)!.played_ms
    s.ctx.persist([p], Date.now() + 30_000)
    const after = s.ctx.store.characterById(a.characterId)!.played_ms
    expect(after - before).toBeGreaterThanOrEqual(29_000)
    expect(after - before).toBeLessThanOrEqual(31_000)
    a.c.close()
  })
})
