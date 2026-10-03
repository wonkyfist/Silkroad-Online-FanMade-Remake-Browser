/**
 * Wave 11 integration (I-11, docs/WAVE_PLAN7.md §6.4), the server's side of the cross-item tests:
 *
 * - `uniqueNotice` reaches world sockets only: a GM's `/unique spawn tiger here` on the real export sends `appeared`
 *   to a player in the world and nothing to a socket in the lobby (logged in, no character entered), and the defeat
 *   by the generic `/kill` stays silent everywhere (UNIQUES §3.3);
 * - a unique fight never happens in the town's range (D20): every camp of every unique, plus her leash and the widest
 *   crowd range (Ultra 120 m), is at least 1 km from every node of the town graph (content/town/jangan.json), asserted
 *   on the camp coordinates so a future camp or town edit trips it.
 *
 * Skipped without the export (work/out/world/jangan-fields with its nav, work/out/data).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentEntries, type NestDef, type ServerMessage, type TownFile, type UniquesFile } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const CONTENT = join(REPO_ROOT, 'content')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'npcs', 'shops', 'skills', 'masteries'].map((f) => join(OUT, `data/${f}.json`))
const HAVE_FIELDS = (() => {
  const man = join(OUT, 'world/jangan-fields/manifest.json')
  if (!existsSync(man) || !DATA.every((f) => existsSync(f)) || !existsSync(join(CONTENT, 'uniques.json'))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world/jangan-fields', m.nav.file))
})()

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** Her leash from the camp (UNIQUES §3.6) and the widest town crowd range (TOWN_LIFE §8.1, Ultra). */
const LEASH_M = 50
const CROWD_RANGE_MAX_M = 120

describe('a unique camp is never in the town\'s range (WAVE_PLAN7 D20)', () => {
  const uniques = JSON.parse(readFileSync(join(CONTENT, 'uniques.json'), 'utf8')) as UniquesFile
  const town = JSON.parse(readFileSync(join(CONTENT, 'town/jangan.json'), 'utf8')) as TownFile
  const nestsFile = join(OUT, 'data/nests.json')

  it.skipIf(!existsSync(nestsFile))('every camp is ≥ 1 km from every town node, with her leash and the crowd\'s range to spare', () => {
    const nests = contentEntries<NestDef>(JSON.parse(readFileSync(nestsFile, 'utf8')))
    let checked = 0
    for (const u of uniques.uniques) {
      const camps = u.camps === 'uniqueGroup' ? nests.filter((n) => n.uniqueGroup && n.world === u.world && n.mob === u.mob) : nests.filter((n) => (u.camps as number[]).includes(n.id))
      expect(camps.length, u.mob).toBeGreaterThan(0)
      for (const c of camps) {
        let near = Infinity
        for (const n of town.graph.nodes) near = Math.min(near, Math.hypot(n.x - c.x, n.z - c.z))
        for (const p of town.places) near = Math.min(near, Math.hypot(p.x - c.x, p.z - c.z))
        expect(near, `camp ${c.id} of ${u.mob}`).toBeGreaterThanOrEqual(1000)
        expect(near - (c.radius ?? 0) - LEASH_M - CROWD_RANGE_MAX_M, `camp ${c.id}`).toBeGreaterThan(0)
        checked++
      }
    }
    expect(checked).toBe(11)
  })
})

describe.skipIf(!HAVE_FIELDS)('uniqueNotice on the real export: world sockets only', () => {
  let s: TestServer
  const logs: string[] = []

  beforeAll(async () => {
    s = await startTestServer({
      logs,
      config: { outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, tickHz: 20, rolePollMs: 50, worldExport: 'jangan-fields', contentDir: CONTENT, uniques: true },
    })
    expect(s.ctx.gameplay.uniques).toBeTruthy()
  }, 120_000)
  afterAll(async () => {
    await s?.stopAndClean()
  })

  const gm = async (c: Client, cmd: string, ...args: string[]): Promise<Msg<'gmResult'>> => {
    c.send({ t: 'gm', cmd, args })
    return c.next('gmResult', (m) => m.cmd === cmd, 5000)
  }

  it('a GM spawn: one `appeared` to each world socket, none to the lobby; the generic /kill is silent', async () => {
    // A socket in the lobby: logged in, a character made, never entered.
    const lobbyAcc = await newAccount(s.url, 'w11lobby')
    const lobby = await Client.login(s.url, lobbyAcc.token)
    lobby.send({ t: 'charCreate', name: `Lob${Date.now() % 1e5}`.slice(0, 12), model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    await lobby.next('charCreated')
    // A GM and a player in the world.
    const enter = async (prefix: string, role?: 'gm') => {
      const acc = await newAccount(s.url, prefix)
      if (role) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
      const c = await Client.login(s.url, acc.token)
      c.send({ t: 'charCreate', name: `${prefix.slice(0, 4)}${Date.now() % 1e5}`.slice(0, 12), model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
      const ch = (await c.next('charCreated')).character
      c.send({ t: 'enterWorld', id: ch.id })
      const w = await c.next('worldEnter')
      return { c, id: w.self.id }
    }
    const g = await enter('w11gm', 'gm')
    const p = await enter('w11pl')
    await new Promise((r) => setTimeout(r, 200)) // rolePollMs
    const r = await gm(g.c, 'unique', 'spawn', 'tiger', 'here')
    expect(r.ok, r.message).toBe(true)
    const seen = await p.c.next('uniqueNotice', () => true, 5000)
    expect(seen).toMatchObject({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' })
    await p.c.none('uniqueNotice', 300)
    expect(lobby.log.filter((m) => m.t === 'uniqueNotice')).toEqual([])
    // The generic /kill: silent (a GM kill), noticed by the tick, the timer runs.
    const her = [...s.ctx.world.mobs.values()].find((m) => m.def.code === 'MOB_CH_TIGERWOMAN' && m.ai !== 'dead')!
    expect(her).toBeTruthy()
    const k = await gm(g.c, 'kill', String(her.id))
    expect(k.ok, k.message).toBe(true)
    await new Promise((r) => setTimeout(r, 600))
    expect(p.c.log.filter((m) => m.t === 'uniqueNotice' && m.event === 'defeated')).toEqual([])
    expect(lobby.log.filter((m) => m.t === 'uniqueNotice')).toEqual([])
    const row = s.ctx.store.db.prepare('SELECT * FROM uniques').all() as Array<{ code: string; phase: string; due_at: number }>
    const tg = row.find((x) => x.code === 'MOB_CH_TIGERWOMAN')!
    expect(tg.phase).toBe('waiting')
    expect(tg.due_at - Date.now()).toBeGreaterThan(179 * 60_000)
    expect(tg.due_at - Date.now()).toBeLessThanOrEqual(360 * 60_000)
    lobby.close()
    g.c.close()
    p.c.close()
  }, 30_000)
})
