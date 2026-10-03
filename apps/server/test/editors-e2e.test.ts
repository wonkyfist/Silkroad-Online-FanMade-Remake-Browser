/**
 * GM content editors end to end (docs/QUESTS.md §5, §7 lane E; WAVE_PLAN §5.4 point 8; lane ED-S): a real server with
 * synthetic content (test/fixtures.ts), driven over real WebSockets and HTTP.
 * - `nest`: add at the GM's position -> mobs spawn; set/remove/restore; undo; a restart keeps the override; exported
 *   nests are patched or hidden, never edited in nests.json.
 * - `npc`: an authored NPCX_* wears its base NPC's model (`model` + `npc` in EntityState); rename/shop/remove/restore.
 * - a player gets `forbidden` (a strike) and an audit row; EDITOR_ROLE=admin locks a gm out; `contentChanged` reaches a
 *   player socket.
 * - /api/gm/quests: 401 without a token, 403 + audit row as a player, PUT/validate/disable/enable/DELETE as a GM, 409 on a
 *   stale baseRev, 422 with issues, 413 over 32 KB, 429 over the rate limit.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateQuestFile, type EntityState, type GmNestInfo, type GmNpcInfo, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AUTHORED_NEST_ID_MIN } from '../src/editors/overrides.ts'
import { startServer, type GameServer } from '../src/game.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, TIGER, contentFiles, nest, seeded } from './fixtures.ts'

const SPAWN: [number, number, number] = [50, 0, -50]
const BOUNDS = { min: [0, 0, -400], max: [400, 0, 0] }
const FAR_NEST = nest(7, MANGNYANG.code, 300, -300, { count: 2 })
const NEAR_NEST = nest(8, MANGNYANG.code, 60, -60, { count: 3, radius: 4, spawnRadius: 3 })

const QUEST = {
  id: 'TQ_001',
  title: 'Pests',
  kind: 'side',
  level: 1,
  giver: 'NPC_CH_POTION',
  turnIn: 'NPC_CH_POTION',
  summary: 'Thin out the mangnyang.',
  objectives: [{ id: 'mang', type: 'kill', mobs: ['MOB_CH_MANGNYANG'], count: 8 }],
  rewards: { exp: 100, sp: 1, gold: 10 },
  dialog: { offer: 'Kill eight.', progress: 'Keep at it.', complete: 'Thanks.' },
}
const QUEST_FILE = { schema: 1, kind: 'quests', id: 'test', title: 'Test line', world: 'jangan', items: [], locations: [], quests: [QUEST] }

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

let s: TestServer
let server: GameServer
let contentDir: string
const logs: string[] = []
let n = 0

function url(): string {
  return server.url
}

beforeAll(async () => {
  contentDir = mkdtempSync(join(tmpdir(), 'sro-editors-content-'))
  mkdirSync(join(contentDir, 'quests'), { recursive: true })
  writeFileSync(join(contentDir, 'quests', 'test.json'), JSON.stringify(QUEST_FILE))
  s = await startTestServer({
    logs,
    config: { moveSpeed: 30, tickHz: 20, viewRange: 80, rng: seeded(11), mobLevelMax: 25, contentDir },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: BOUNDS }),
      ...contentFiles({ mobs: [MANGNYANG, TIGER], nests: [FAR_NEST, NEAR_NEST], items: ITEMS, levels: LEVELS, npcs: NPCS, shops: SHOPS }),
    },
  })
  server = s
})

afterAll(async () => {
  await server.close()
  rmSync(s.root, { recursive: true, force: true })
  rmSync(contentDir, { recursive: true, force: true })
})

async function player(opts: { role?: 'gm' | 'admin' } = {}) {
  const acc = await newAccount(url(), opts.role ? 'edgm' : 'edp')
  if (opts.role) server.ctx.store.setRole(server.ctx.store.accountByName(acc.username)!.id, opts.role)
  const c = await Client.login(url(), acc.token)
  c.send({ t: 'charCreate', name: `Editor${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: ch.id })
  const enter = await c.next('worldEnter')
  return { c, acc, enter }
}

async function gm(c: Client, cmd: string, ...args: string[]): Promise<Msg<'gmResult'>> {
  c.send({ t: 'gm', cmd, args })
  return c.next('gmResult', () => true, 4000)
}

async function http(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url() + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

function mobsOf(nestId: number): number {
  return server.ctx.gameplay.spawner.nest(nestId)?.alive.size ?? 0
}

function audit(command: string) {
  return server.ctx.store.recentAudit(200).filter((r) => r.command === command)
}

describe('spawn editor (nest)', () => {
  let nestId = 0

  it('the quest fixture is valid (precondition)', () => {
    expect(validateQuestFile(QUEST_FILE).issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('nest add spawns mobs around the GM at once, and a player socket gets contentChanged', async () => {
    const g = await player({ role: 'gm' })
    const watcher = await player()
    const r = await gm(g.c, 'nest', 'add', 'mob_ch_mangnyang', '4', '10', '20-40')
    expect(r.ok).toBe(true)
    const info = (r.data as { nest: GmNestInfo }).nest
    expect(info).toMatchObject({ mob: MANGNYANG.code, count: 4, alive: 4, radius: 10, spawnRadius: 10, respawnSec: [20, 40], source: 'authored', enabled: true })
    expect(info.id).toBe(AUTHORED_NEST_ID_MIN)
    nestId = info.id
    // the GM's client sees them spawn near it
    const seen: EntityState[] = []
    for (let i = 0; i < 4; i++) seen.push((await g.c.next('spawn', (m) => m.entity.kind === 'mob' && m.entity.model === MANGNYANG.code && Math.hypot(m.entity.pos[0] - SPAWN[0], m.entity.pos[2] - SPAWN[2]) <= 11)).entity)
    expect(seen).toHaveLength(4)
    expect(await watcher.c.next('contentChanged', (m) => m.kind === 'nests')).toMatchObject({ kind: 'nests', rev: 1 })
    // saved to DATA_DIR/content, never to the export
    const file = JSON.parse(readFileSync(join(server.ctx.config.dataDir, 'content', 'nests.override.json'), 'utf8'))
    expect(file).toMatchObject({ schema: 1, kind: 'nests-override', world: 'jangan', rev: 1 })
    expect(file.add[0]).toMatchObject({ id: nestId, provenance: 'authored', source: { file: 'nests.override.json', by: g.acc.username } })
    expect(readFileSync(join(server.ctx.config.outDir, 'data', 'nests.json'), 'utf8')).not.toContain(String(AUTHORED_NEST_ID_MIN))
    // audited like every GM command
    expect(audit('nest').some((a) => a.ok === 1 && JSON.parse(a.args)[0] === 'add')).toBe(true)
    g.c.close()
    watcher.c.close()
  })

  it('near lists nests with their source; set changes count and fields live; bad input is refused', async () => {
    const g = await player({ role: 'gm' })
    const near = await gm(g.c, 'nest', 'near')
    const list = (near.data as { nests: GmNestInfo[] }).nests
    expect(list.map((x) => x.id)).toContain(nestId)
    expect(list.map((x) => x.id)).toContain(NEAR_NEST.id)
    expect(list.map((x) => x.id)).not.toContain(FAR_NEST.id)
    expect(list.find((x) => x.id === NEAR_NEST.id)!.source).toBe('export')
    const set = await gm(g.c, 'nest', 'set', String(nestId), 'count', '2')
    expect(set.ok).toBe(true)
    expect(mobsOf(nestId)).toBe(2)
    expect((await gm(g.c, 'nest', 'set', `#${nestId}`, 'aggressive', 'on')).ok).toBe(true)
    const nestMobs = [...server.ctx.gameplay.spawner.nest(nestId)!.alive].map((id) => server.ctx.world.mobs.get(id)!)
    expect(nestMobs.every((m) => m.aggressive)).toBe(true)
    expect((await gm(g.c, 'nest', 'set', String(nestId), 'count', '99')).ok).toBe(false)
    expect((await gm(g.c, 'nest', 'set', String(nestId), 'mob', 'MOB_NOPE')).ok).toBe(false)
    expect((await gm(g.c, 'nest', 'add', 'MOB_NOPE')).ok).toBe(false)
    expect((await gm(g.c, 'nest', 'frobnicate')).message).toMatch(/^Usage: nest/)
    // exported nest: a patch, not an edit of nests.json
    expect((await gm(g.c, 'nest', 'set', String(NEAR_NEST.id), 'count', '1')).ok).toBe(true)
    expect(mobsOf(NEAR_NEST.id)).toBe(1)
    const near2 = await gm(g.c, 'nest', 'near', '40')
    expect((near2.data as { nests: GmNestInfo[] }).nests.find((x) => x.id === NEAR_NEST.id)!.source).toBe('patched')
    g.c.close()
  })

  it('undo restores the previous version; remove and restore', async () => {
    const g = await player({ role: 'gm' })
    // undo the exported patch, then the aggressive flag
    expect((await gm(g.c, 'nest', 'undo')).ok).toBe(true)
    expect(mobsOf(NEAR_NEST.id)).toBe(3)
    expect((await gm(g.c, 'nest', 'undo')).ok).toBe(true)
    expect(server.ctx.data.nests.find((x) => x.id === nestId)!.tactics.aggressive).toBe(false)
    expect(mobsOf(nestId)).toBe(2)
    // hide an exported nest, then bring it back
    const rm = await gm(g.c, 'nest', 'remove', String(NEAR_NEST.id))
    expect(rm.ok).toBe(true)
    expect(mobsOf(NEAR_NEST.id)).toBe(0)
    expect(server.ctx.gameplay.spawner.nest(NEAR_NEST.id)).toBeUndefined()
    expect((await gm(g.c, 'nest', 'set', String(NEAR_NEST.id), 'count', '2')).ok).toBe(false)
    expect((await gm(g.c, 'nest', 'restore', String(NEAR_NEST.id))).ok).toBe(true)
    expect(mobsOf(NEAR_NEST.id)).toBe(3)
    g.c.close()
  })

  it('a restart keeps the authored nest and its mobs', async () => {
    const config = server.ctx.config
    await server.close()
    server = await startServer({ ...config, port: 0 })
    expect(server.ctx.data.nests.find((x) => x.id === nestId)).toMatchObject({ provenance: 'authored', count: 2 })
    expect(mobsOf(nestId)).toBe(2)
    expect(logs.some((l) => /content overrides .*nests rev \d+/.test(l))).toBe(true)
    // and undo still works across the restart (the history is on disk)
    const g = await player({ role: 'gm' })
    expect((await gm(g.c, 'nest', 'undo')).ok).toBe(true)
    const r = await gm(g.c, 'nest', 'remove', String(nestId))
    expect(r.ok).toBe(true)
    expect(mobsOf(nestId)).toBe(0)
    expect(server.ctx.data.nests.some((x) => x.id === nestId)).toBe(false)
    g.c.close()
  })
})

describe('NPC editor (npc)', () => {
  it('npc add places an NPCX_* that wears the base model; rename, shop, remove, restore; a restart keeps it', async () => {
    const g = await player({ role: 'gm' })
    const add = await gm(g.c, 'npc', 'add', 'npc_ch_potion', 'Old', 'Smith', 'Bo')
    expect(add.ok).toBe(true)
    const info = (add.data as { npc: GmNpcInfo }).npc
    expect(info).toMatchObject({ base: 'NPC_CH_POTION', name: 'Old Smith Bo', source: 'authored' })
    expect(info.code).toMatch(/^NPCX_\d+$/)
    expect(info.entity).not.toBeNull()
    const spawn = await g.c.next('spawn', (m) => m.entity.kind === 'npc' && m.entity.npc === info.code)
    expect(spawn.entity).toMatchObject({ model: 'NPC_CH_POTION', npc: info.code, name: 'Old Smith Bo' })

    const renamed = await gm(g.c, 'npc', 'rename', info.code, 'Smith', 'Bo')
    expect(renamed.ok).toBe(true)
    expect((await g.c.next('spawn', (m) => m.entity.npc === info.code)).entity.name).toBe('Smith Bo')
    expect((await gm(g.c, 'npc', 'shop', info.code, 'store_ch_potion')).ok).toBe(true)
    expect(server.ctx.data.shopOf(info.code)?.id).toBe('STORE_CH_POTION')
    expect(server.ctx.gameplay.shops.goods(info.code).size).toBeGreaterThan(0)
    expect((await gm(g.c, 'npc', 'shop', info.code, 'NO_SUCH_SHOP')).ok).toBe(false)

    // an exported NPC: hidden (with a quest-use warning), then restored
    const exported = [...server.ctx.world.npcs.values()].find((e) => e.code === 'NPC_CH_POTION')!
    const rm = await gm(g.c, 'npc', 'remove', 'NPC_CH_POTION')
    expect(rm.ok).toBe(true)
    expect(rm.message).toMatch(/TQ_001/)
    await g.c.next('despawn', (m) => m.id === exported.id)
    expect([...server.ctx.world.npcs.values()].some((e) => e.code === 'NPC_CH_POTION')).toBe(false)
    const near = await gm(g.c, 'npc', 'near', '100')
    expect((near.data as { npcs: GmNpcInfo[] }).npcs.find((x) => x.code === 'NPC_CH_POTION')).toMatchObject({ hidden: true, entity: null })
    expect((await gm(g.c, 'npc', 'restore', 'NPC_CH_POTION')).ok).toBe(true)
    expect([...server.ctx.world.npcs.values()].some((e) => e.code === 'NPC_CH_POTION')).toBe(true)
    g.c.close()

    const config = server.ctx.config
    await server.close()
    server = await startServer({ ...config, port: 0 })
    const again = [...server.ctx.world.npcs.values()].find((e) => e.code === info.code)
    expect(again).toMatchObject({ model: 'NPC_CH_POTION', name: 'Smith Bo' })
    expect(server.ctx.data.shopOf(info.code)?.id).toBe('STORE_CH_POTION')
    const g2 = await player({ role: 'gm' })
    expect((await gm(g2.c, 'npc', 'remove', info.code)).ok).toBe(true)
    expect([...server.ctx.world.npcs.values()].some((e) => e.code === info.code)).toBe(false)
    expect((await gm(g2.c, 'npc', 'undo')).ok).toBe(true)
    expect([...server.ctx.world.npcs.values()].some((e) => e.code === info.code)).toBe(true)
    g2.c.close()
  })
})

describe('roles', () => {
  it('a player gets forbidden (and an audit row); EDITOR_ROLE=admin locks a gm out; content status works', async () => {
    const p = await player()
    p.c.send({ t: 'gm', cmd: 'nest', args: ['add', MANGNYANG.code] })
    const e = await p.c.next('error')
    expect(e.code).toBe('forbidden')
    expect(audit('nest').some((a) => a.ok === 0 && a.result.startsWith('denied'))).toBe(true)
    p.c.close()

    const g = await player({ role: 'gm' })
    server.ctx.config.editorRole = 'admin'
    try {
      const r = await gm(g.c, 'nest', 'near')
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/EDITOR_ROLE/)
      expect(server.ctx.store.accountRole(server.ctx.store.accountByName(g.acc.username)!.id)).toBe('gm')
    } finally {
      server.ctx.config.editorRole = 'gm'
    }
    const st = await gm(g.c, 'content', 'status')
    expect(st.ok).toBe(true)
    expect(st.message).toMatch(/nests rev \d+/)
    const reload = await gm(g.c, 'content', 'reload', 'nests')
    expect(reload.ok).toBe(true)
    g.c.close()
  })
})

describe('quest editor HTTP (/api/gm/quests)', () => {
  let gmToken = ''
  let playerToken = ''
  const put = (quest: unknown, extra: Record<string, unknown> = {}) => ({ quest, ...extra })

  // A fresh GM per test: each account has its own rate-limit bucket (burst 10).
  beforeEach(async () => {
    const g = await newAccount(url(), 'qgm')
    server.ctx.store.setRole(server.ctx.store.accountByName(g.username)!.id, 'gm')
    gmToken = g.token
    playerToken = (await newAccount(url(), 'qp')).token
  })

  it('401 without a token, 403 and an audit row as a player', async () => {
    expect((await http('GET', '/api/gm/quests')).status).toBe(401)
    const denied = await http('PUT', '/api/gm/quests/TQ_001', playerToken, put({ ...QUEST, title: 'Hacked' }))
    expect(denied.status).toBe(403)
    expect(denied.json.error).toBe('forbidden')
    expect((await http('GET', '/api/gm/quests', playerToken)).status).toBe(403)
    expect(audit('questput').some((a) => a.ok === 0 && a.result.startsWith('denied'))).toBe(true)
    expect(existsSync(join(server.ctx.config.dataDir, 'content', 'quests', 'TQ_001.json'))).toBe(false)
  })

  it('lists the repo quests; validate; PUT writes the override, reloads and tells the players', async () => {
    const list = await http('GET', '/api/gm/quests', gmToken)
    expect(list.status).toBe(200)
    expect(list.json.quests.find((q: { id: string }) => q.id === 'TQ_001')).toMatchObject({ source: 'repo', rev: 0, disabled: false, file: 'test.json', issues: [] })

    const bad = { ...QUEST, objectives: [{ id: 'mang', type: 'kill', mobs: ['MOB_CH_NOPE'], count: 3 }] }
    const check = await http('POST', '/api/gm/quests/validate', gmToken, put(bad))
    expect(check.status).toBe(200)
    expect(check.json.ok).toBe(false)
    expect(check.json.issues.some((i: { path: string; severity: string }) => i.severity === 'error' && i.path.includes('objectives'))).toBe(true)
    expect((await http('PUT', '/api/gm/quests/TQ_001', gmToken, put(bad))).status).toBe(422)
    expect((await http('PUT', '/api/gm/quests/TQ_002', gmToken, put(QUEST))).status).toBe(422)
    expect((await http('PUT', '/api/gm/quests/TQ_001', gmToken, { quest: QUEST, junk: 1 })).status).toBe(400)
    expect((await http('PUT', '/api/gm/quests/not-an-id', gmToken, put(QUEST))).status).toBe(400)

    const watcher = await player()
    const three = { ...QUEST, objectives: [{ id: 'mang', type: 'kill', mobs: ['MOB_CH_MANGNYANG'], count: 3 }] }
    const ok = await http('PUT', '/api/gm/quests/TQ_001', gmToken, put(three, { baseRev: 0 }))
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ ok: true, rev: 1 })
    await watcher.c.next('contentChanged', (m) => m.kind === 'quests')
    watcher.c.close()
    const file = JSON.parse(readFileSync(join(server.ctx.config.dataDir, 'content', 'quests', 'TQ_001.json'), 'utf8'))
    expect(file).toMatchObject({ schema: 1, kind: 'quests', id: 'TQ_001', rev: 1, quests: [{ id: 'TQ_001', rev: 1, objectives: [{ count: 3 }] }] })
    expect(audit('questput').some((a) => a.ok === 1 && a.args === JSON.stringify(['TQ_001', '1']))).toBe(true)
    const after = await http('GET', '/api/gm/quests', gmToken)
    expect(after.json.quests.find((q: { id: string }) => q.id === 'TQ_001')).toMatchObject({ source: 'override', rev: 1 })

    // a stale base revision is refused
    const stale = await http('PUT', '/api/gm/quests/TQ_001', gmToken, put(QUEST, { baseRev: 0 }))
    expect(stale.status).toBe(409)
    expect(stale.json).toMatchObject({ ok: false, rev: 1 })
  })

  it('disable / enable / DELETE (revert to repo) keep the revision rising', async () => {
    const off = await http('POST', '/api/gm/quests/TQ_001/disable', gmToken)
    expect(off.json).toMatchObject({ ok: true, rev: 2 })
    expect((await http('GET', '/api/gm/quests', gmToken)).json.quests.find((q: { id: string }) => q.id === 'TQ_001').disabled).toBe(true)
    expect((await http('POST', '/api/gm/quests/TQ_001/enable', gmToken)).json).toMatchObject({ ok: true, rev: 3 })
    const del = await http('DELETE', '/api/gm/quests/TQ_001', gmToken)
    expect(del.status).toBe(200)
    expect(existsSync(join(server.ctx.config.dataDir, 'content', 'quests', 'TQ_001.json'))).toBe(false)
    expect((await http('GET', '/api/gm/quests', gmToken)).json.quests.find((q: { id: string }) => q.id === 'TQ_001')).toMatchObject({ source: 'repo', rev: 0 })
    expect((await http('DELETE', '/api/gm/quests/TQ_001', gmToken)).status).toBe(404)
    // a new override after the revert still gets a higher revision (players' logs see the change)
    const again = await http('PUT', '/api/gm/quests/TQ_001', gmToken, put(QUEST))
    expect(again.json.rev).toBeGreaterThan(3)
    expect(audit('questdel').some((a) => a.ok === 1)).toBe(true)
    expect(audit('questoff').some((a) => a.ok === 1)).toBe(true)
    // disabling a quest that exists only in the repo creates the override
    expect((await http('POST', '/api/gm/quests/NOPE_1/disable', gmToken)).status).toBe(404)
  })

  it('bodies over 32 KB get 413; more than the burst gets 429', async () => {
    const huge = { quest: { ...QUEST, summary: 'x'.repeat(40_000) } }
    expect((await http('PUT', '/api/gm/quests/TQ_001', gmToken, huge)).status).toBe(413)
    const g = await newAccount(url(), 'qrate')
    server.ctx.store.setRole(server.ctx.store.accountByName(g.username)!.id, 'gm')
    const codes: number[] = []
    for (let i = 0; i < 14; i++) codes.push((await http('GET', '/api/gm/quests', g.token)).status)
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
    expect(codes).toContain(429)
    await sleep(10)
  })
})
