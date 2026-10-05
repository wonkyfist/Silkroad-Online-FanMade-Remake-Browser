/**
 * Admin panel, layers 2-3 (docs/ADMIN.md §1, §3, §5): the dashboard and live players (kick, send to town, notice),
 * characters (progress, gold, items, storage; online through the gameplay code, offline in the database), the item and
 * drop override layers (files in DATA_DIR/content, the export untouched, the merged items.json for the client), the
 * GM editors driven from the panel (nests, NPCs, quests) and the uniques view. A real server, real sockets.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOSE_CODE, type AdminCharacterDetail, type AdminLoginResponse } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTHORED_NEST_ID_MIN } from '../src/editors/overrides.ts'
import { startServer, type GameServer } from '../src/game.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, TIGER, contentFiles, nest, seeded } from './fixtures.ts'

const SPAWN: [number, number, number] = [50, 0, -50]
const NEAR_NEST = nest(8, MANGNYANG.code, 60, -60, { count: 3, radius: 4, spawnRadius: 3 })
const QUEST = {
  id: 'TQ_001', title: 'Pests', kind: 'side', level: 1, giver: 'NPC_CH_POTION', turnIn: 'NPC_CH_POTION', summary: 'Thin out the mangnyang.',
  objectives: [{ id: 'mang', type: 'kill', mobs: ['MOB_CH_MANGNYANG'], count: 8 }], rewards: { exp: 100, sp: 1, gold: 10 },
  dialog: { offer: 'Kill eight.', progress: 'Keep at it.', complete: 'Thanks.' },
}

let s: TestServer
let server: GameServer
let contentDir: string
let token = ''
let adminName = ''
let n = 0

beforeAll(async () => {
  contentDir = mkdtempSync(join(tmpdir(), 'sro-admin-content-'))
  mkdirSync(join(contentDir, 'quests'), { recursive: true })
  writeFileSync(join(contentDir, 'quests', 'test.json'), JSON.stringify({ schema: 1, kind: 'quests', id: 'test', title: 'Test line', world: 'jangan', items: [], locations: [], quests: [QUEST] }))
  s = await startTestServer({
    config: { moveSpeed: 30, viewRange: 80, rng: seeded(5), mobLevelMax: 25, contentDir },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
      ...contentFiles({ mobs: [MANGNYANG, TIGER], nests: [NEAR_NEST], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS }),
      // icons: the icon export's index (OUT_DIR) and one rank icon only in the slim copy (OUT_OPT_DIR = out-opt beside out)
      'out/icons/index.json': JSON.stringify({ version: 1, items: { ITEM_CH_BLADE_02_A: 'icons/item/china/weapon/blade_02.png', ITEM_ETC_HP_POTION_01: 'icons/item/etc/missing.png' } }),
      'out/icons/item/china/weapon/blade_02.png': 'PNG-BLADE',
      'out-opt/ui/targetwindow/tw_icon_normal.png': 'PNG-RANK',
      'out/secret.png': 'NOT AN ICON',
    },
  })
  server = s
  const acc = await newAccount(server.url, 'boss')
  server.ctx.store.setRole(server.ctx.store.accountByName(acc.username)!.id, 'admin')
  adminName = acc.username
  const r = await http('POST', '/api/admin/login', { username: acc.username, password: 'password1' })
  token = (r.json as AdminLoginResponse).token
})

afterAll(async () => {
  await server.close()
  rmSync(s.root, { recursive: true, force: true })
  rmSync(contentDir, { recursive: true, force: true })
})

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(server.url + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json, headers: res.headers }
}

/** A player with a character; `enter` puts it in the world. */
async function player(enter = true) {
  const acc = await newAccount(server.url, 'ap')
  const c = await Client.login(server.url, acc.token)
  c.send({ t: 'charCreate', name: `Admined${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  if (enter) {
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    await c.next('inventory')
  }
  return { c, acc, ch, accountId: server.ctx.store.accountByName(acc.username)!.id }
}

const detail = async (id: number): Promise<AdminCharacterDetail> => (await http('GET', `/api/admin/characters/${id}`)).json

describe('dashboard and live players', () => {
  it('shows the server and who is on, in the world and in the lobby', async () => {
    const p = await player()
    const lobby = await player(false)
    const r = await http('GET', '/api/admin/dashboard')
    expect(r.status).toBe(200)
    expect(r.json.server).toMatchObject({ world: 'jangan', release: expect.any(String), registration: 'open', restart: false, capacity: 50, nav: 'flat' })
    expect(r.json.server.schema).toBeGreaterThanOrEqual(10)
    expect(r.json.server.dbBytes).toBeGreaterThan(0)
    expect(r.json.players.find((x: { name: string }) => x.name === p.ch.name)).toMatchObject({ characterId: p.ch.id, account: p.acc.username, level: 1, dead: false })
    expect(r.json.lobby.map((x: { account: string }) => x.account)).toContain(lobby.acc.username)
    p.c.close()
    lobby.c.close()
  })

  it('kicks a character (4010 with the reason), sends one to town, and broadcasts a notice', async () => {
    const p = await player()
    const q = await player()
    const note = await http('POST', '/api/admin/notice', { text: 'Maintenance at 22:00' })
    expect(note.json.recipients).toBeGreaterThanOrEqual(2)
    expect(await q.c.next('notice')).toEqual({ t: 'notice', text: 'Maintenance at 22:00', from: adminName })
    expect((await http('POST', '/api/admin/notice', { text: 'x'.repeat(301) })).status).toBe(400)
    const qp = [...server.ctx.world.players.values()].find((x) => x.characterId === q.ch.id)!
    server.ctx.world.warp(qp, 200, 0, -200)
    const town = await http('POST', `/api/admin/players/${q.ch.id}/town`)
    expect(town.status).toBe(200)
    expect(Math.hypot(town.json.position.x - SPAWN[0], town.json.position.z - SPAWN[2])).toBeLessThan(1)
    const kick = await http('POST', `/api/admin/players/${p.ch.id}/kick`, { reason: 'AFK in the gate' })
    expect(kick.json).toEqual({ kicked: true })
    const closed = await p.c.closed
    expect(closed).toMatchObject({ code: CLOSE_CODE.kicked, reason: 'kicked: AFK in the gate' })
    expect((await http('POST', `/api/admin/players/${p.ch.id}/kick`, {})).status).toBe(409)
    q.c.close()
  })
})

describe('characters', () => {
  it('lists and searches characters (online filter), with a detail view', async () => {
    const p = await player()
    const list = await http('GET', `/api/admin/characters?q=${p.ch.name}`)
    expect(list.json.rows).toEqual([expect.objectContaining({ id: p.ch.id, name: p.ch.name, account: p.acc.username, online: true })])
    const online = await http('GET', '/api/admin/characters?online=1&size=200')
    expect(online.json.rows.every((x: { online: boolean }) => x.online)).toBe(true)
    const d = await detail(p.ch.id)
    expect(d).toMatchObject({ name: p.ch.name, online: true, level: 1, gold: 0, levelCap: 20, progress: { level: 1, exp: 0, expToNext: 30 } })
    expect(d.equip.map((e) => e.slot)).toContain('weapon')
    expect(d.storage).toMatchObject({ size: 150, gold: 0, items: [] })
    expect((await http('GET', '/api/admin/characters/999999')).status).toBe(404)
    p.c.close()
  })

  it('changes level, EXP, SP and gold of an online character; the client hears it at once', async () => {
    const p = await player()
    const r = await http('POST', `/api/admin/characters/${p.ch.id}/progress`, { level: 3, sp: 40 })
    expect(r.status).toBe(200)
    expect(r.json.progress).toMatchObject({ level: 3, sp: 40 })
    expect((await p.c.next('stats', (m) => m.stats.level === 3 && m.stats.sp === 40)).stats.level).toBe(3)
    expect((await http('POST', `/api/admin/characters/${p.ch.id}/progress`, { exp: 500 })).status).toBe(400)
    expect((await http('POST', `/api/admin/characters/${p.ch.id}/progress`, { level: 21 })).status).toBe(400)
    expect((await http('POST', `/api/admin/characters/${p.ch.id}/progress`, { exp: 150 })).json.progress.exp).toBe(150)
    const g = await http('POST', `/api/admin/characters/${p.ch.id}/gold`, { gold: 12345 })
    expect(g.json.gold).toBe(12345)
    expect(await p.c.next('statsDelta', (m) => m.stats.gold === 12345)).toBeTruthy()
    expect(server.ctx.store.characterById(p.ch.id)).toMatchObject({ level: 3, exp: 150, sp: 40, gold: 12345 })
    const rows = server.ctx.store.db.prepare("SELECT before, after FROM admin_audit WHERE action = 'character.gold' AND target = ?").all(`character:${p.ch.id}`) as { before: string; after: string }[]
    expect(rows.map((x) => [JSON.parse(x.before), JSON.parse(x.after)])).toEqual([[{ gold: 0 }, { gold: 12345 }]])
    p.c.close()
  })

  it('gives and removes items (+ on equipment only) online and offline, and sends an offline character to town', async () => {
    const p = await player()
    const give = await http('POST', `/api/admin/characters/${p.ch.id}/items`, { code: 'item_ch_blade_02_a', count: 1, plus: 5 })
    expect(give.status).toBe(200)
    const blade = give.json.bag.items.find((x: { code: string }) => x.code === 'ITEM_CH_BLADE_02_A')
    expect(blade).toMatchObject({ plus: 5, count: 1 })
    expect(await p.c.next('inventoryUpdate', (m) => !!m.bag?.some((b) => b.item?.code === 'ITEM_CH_BLADE_02_A' && b.item.plus === 5))).toBeTruthy()
    expect((await http('POST', `/api/admin/characters/${p.ch.id}/items`, { code: 'ITEM_ETC_HP_POTION_01', count: 5, plus: 1 })).status).toBe(400)
    expect((await http('POST', `/api/admin/characters/${p.ch.id}/items`, { code: 'ITEM_NOPE', count: 1 })).status).toBe(400)
    const pots = await http('POST', `/api/admin/characters/${p.ch.id}/items`, { code: 'ITEM_ETC_HP_POTION_01', count: 70 })
    const potSlots = pots.json.bag.items.filter((x: { code: string }) => x.code === 'ITEM_ETC_HP_POTION_01')
    expect(potSlots.map((x: { count: number }) => x.count).sort()).toEqual([20, 50])
    const rm = await http('POST', `/api/admin/characters/${p.ch.id}/items/remove`, { where: 'bag', slot: potSlots[0].slot, count: 10 })
    expect(rm.json.bag.items.find((x: { slot: number }) => x.slot === potSlots[0].slot).count).toBe(potSlots[0].count - 10)
    const unequip = await http('POST', `/api/admin/characters/${p.ch.id}/items/remove`, { where: 'equip', slot: 'weapon' })
    expect(unequip.json.equip.some((x: { slot: string }) => x.slot === 'weapon')).toBe(false)
    expect(await p.c.next('inventoryUpdate', (m) => !!m.equip?.some((e) => e.slot === 'weapon' && e.item === null))).toBeTruthy()
    expect((await http('POST', `/api/admin/characters/${p.ch.id}/items/remove`, { where: 'equip', slot: 'weapon' })).status).toBe(409)
    // offline: straight to the database
    p.c.close()
    await p.c.closed
    await new Promise((r) => setTimeout(r, 50))
    expect((await http('POST', `/api/admin/characters/${p.ch.id}/items`, { code: 'ITEM_CH_RING_01_A', count: 1 })).json.online).toBe(false)
    expect(server.ctx.store.loadInventory(p.ch.id).bag.some((x) => x?.code === 'ITEM_CH_RING_01_A')).toBe(true)
    expect((await detail(p.ch.id)).position).not.toBeNull()
    const town = await http('POST', `/api/admin/characters/${p.ch.id}/town`)
    expect(town.json.position).toBeNull()
    expect(server.ctx.store.characterById(p.ch.id)!.x).toBeNull()
    const lvl = await http('POST', `/api/admin/characters/${p.ch.id}/progress`, { level: 4 })
    expect(lvl.json.progress).toMatchObject({ level: 4, statPoints: 9 })
  })

  it('edits the account storage: give, remove, gold; the player in the world gets storageUpdate', async () => {
    const p = await player()
    const give = await http('POST', `/api/admin/accounts/${p.accountId}/storage`, { code: 'ITEM_ETC_HP_POTION_01', count: 60 })
    expect(give.json.items.map((x: { count: number }) => x.count).sort()).toEqual([10, 50])
    expect(await p.c.next('storageUpdate')).toBeTruthy()
    const slot = give.json.items[0].slot
    const rm = await http('POST', `/api/admin/accounts/${p.accountId}/storage/remove`, { slot, count: give.json.items[0].count })
    expect(rm.json.items.some((x: { slot: number }) => x.slot === slot)).toBe(false)
    expect((await http('POST', `/api/admin/accounts/${p.accountId}/storage/gold`, { gold: 777 })).json.gold).toBe(777)
    expect((await http('GET', `/api/admin/accounts/${p.accountId}`)).json.storage.gold).toBe(777)
    expect((await http('POST', `/api/admin/accounts/${p.accountId}/storage/remove`, { slot: 149 })).status).toBe(409)
    p.c.close()
  })
})

describe('icons', () => {
  it('lists item and monster icons that exist (out, else out-opt) and serves only those under /admin/out/', async () => {
    const items = await http('GET', '/api/admin/items?q=ITEM_CH_BLADE_02_A')
    expect(items.json.rows[0].icon).toBe('/admin/out/icons/item/china/weapon/blade_02.png')
    const potion = await http('GET', '/api/admin/items/ITEM_ETC_HP_POTION_01')
    expect(potion.json.icon).toBeNull()
    expect((await http('GET', `/api/admin/drops/${MANGNYANG.code}`)).json).toMatchObject({ icon: '/admin/out/ui/targetwindow/tw_icon_normal.png', items: { ITEM_CH_BLADE_02_A: { icon: '/admin/out/icons/item/china/weapon/blade_02.png' } } })
    expect((await http('GET', '/api/admin/mobs?q=mangnyang')).json.rows[0].icon).toBe('/admin/out/ui/targetwindow/tw_icon_normal.png')
    const png = await fetch(`${server.url}/admin/out/icons/item/china/weapon/blade_02.png`)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(await png.text()).toBe('PNG-BLADE')
    expect(await (await fetch(`${server.url}/admin/out/ui/targetwindow/tw_icon_normal.png`)).text()).toBe('PNG-RANK')
    for (const bad of ['/admin/out/secret.png', '/admin/out/data/items.json', '/admin/out/icons/../secret.png', '/admin/out/icons/%2e%2e/secret.png']) {
      expect([bad, (await fetch(`${server.url}${bad}`)).status]).toEqual([bad, 404])
    }
  })
})

describe('item and drop overrides', () => {
  it('patches an item in DATA_DIR/content (never the export), live for the server and the client file', async () => {
    const list = await http('GET', '/api/admin/items?q=blade_02')
    expect(list.json.rows).toEqual([expect.objectContaining({ code: 'ITEM_CH_BLADE_02_A', overridden: false, price: 500 })])
    const bad1 = await http('PUT', '/api/admin/items/ITEM_CH_BLADE_02_A', { patch: { maxStack: 5 } })
    expect(bad1.status).toBe(400)
    expect((await http('PUT', '/api/admin/items/ITEM_CH_BLADE_02_A', { patch: { model: 'x' } })).status).toBe(400)
    expect((await http('PUT', '/api/admin/items/ITEM_CH_BLADE_02_A', { patch: { stats: { physAttack: [50, 40] } } })).status).toBe(400)
    expect((await http('PUT', '/api/admin/items/ITEM_CH_BLADE_02_A', { patch: { use: { hp: 1 } } })).status).toBe(400)
    const put = await http('PUT', '/api/admin/items/ITEM_CH_BLADE_02_A', { patch: { name: 'Admin Blade', price: 900, stats: { physAttack: [60, 66] } } })
    expect(put.status).toBe(200)
    expect(put.json.effective).toMatchObject({ name: 'Admin Blade', price: 900, stats: { physAttack: [60, 66] }, reqLevel: 1 })
    expect(put.json.base).toMatchObject({ name: 'ITEM_CH_BLADE_02_A', price: 500 })
    expect(server.ctx.data.item('ITEM_CH_BLADE_02_A')).toMatchObject({ name: 'Admin Blade', price: 900 })
    const file = JSON.parse(readFileSync(join(server.ctx.config.dataDir, 'content', 'items.override.json'), 'utf8'))
    expect(file).toMatchObject({ schema: 1, kind: 'items-override', rev: 1, patch: [{ code: 'ITEM_CH_BLADE_02_A', name: 'Admin Blade', price: 900 }] })
    expect(readFileSync(join(server.ctx.config.outDir, 'data', 'items.json'), 'utf8')).not.toContain('Admin Blade')
    // the client's items.json is served merged (gzip or not), the rest of the file as it is
    const served = await fetch(`${server.url}/out/data/items.json`)
    const json = (await served.json()) as { entries: { code: string; name: string }[] }
    expect(json.entries.find((e) => e.code === 'ITEM_CH_BLADE_02_A')!.name).toBe('Admin Blade')
    expect(json.entries).toHaveLength(ITEMS.length)
    const etag = served.headers.get('etag')!
    expect((await fetch(`${server.url}/out/data/items.json`, { headers: { 'If-None-Match': etag } })).status).toBe(304)
    // a worn copy: the player's stats follow at once
    const p = await player()
    await http('POST', `/api/admin/characters/${p.ch.id}/items`, { code: 'ITEM_CH_BLADE_02_A', count: 1 })
    const slot = (await detail(p.ch.id)).bag.items.find((x) => x.code === 'ITEM_CH_BLADE_02_A')!.slot as number
    p.c.send({ t: 'itemEquip', bag: slot })
    const st = await p.c.next('stats', (m) => m.stats.physAttack[1] >= 66)
    expect(st.stats.physAttack[1]).toBeGreaterThanOrEqual(66)
    await http('PUT', '/api/admin/items/ITEM_CH_BLADE_02_A', { patch: { stats: { physAttack: [100, 110] } } })
    expect((await p.c.next('stats', (m) => m.stats.physAttack[1] >= 110)).stats.physAttack[1]).toBeGreaterThanOrEqual(110)
    p.c.close()
  })

  it('keeps item overrides across a restart and reverts one with DELETE', async () => {
    const config = { ...server.ctx.config, port: 0 }
    await server.close()
    server = await startServer(config)
    expect(server.ctx.data.item('ITEM_CH_BLADE_02_A')).toMatchObject({ name: 'ITEM_CH_BLADE_02_A', price: 500, stats: { physAttack: [100, 110] } })
    const r = await http('POST', '/api/admin/login', { username: adminName, password: 'password1' })
    token = r.json.token
    const del = await http('DELETE', '/api/admin/items/ITEM_CH_BLADE_02_A')
    expect(del.json).toMatchObject({ patch: null, effective: { price: 500, stats: { physAttack: [40, 44] } } })
    expect((await http('DELETE', '/api/admin/items/ITEM_CH_BLADE_02_A')).status).toBe(404)
    expect(existsSync(join(server.ctx.config.dataDir, 'content', 'history'))).toBe(true)
  })

  it('replaces a drop table (known items only) and reverts it', async () => {
    const d = await http('GET', `/api/admin/drops/${MANGNYANG.code}`)
    expect(d.json).toMatchObject({ mob: MANGNYANG.code, overridden: false, note: null })
    const bad = await http('PUT', `/api/admin/drops/${MANGNYANG.code}`, { table: { groups: [{ chance: 0.5, entries: [{ item: 'ITEM_NOPE', weight: 1 }] }] } })
    expect(bad.status).toBe(400)
    expect(bad.json.message).toMatch(/no item ITEM_NOPE/)
    const table = { gold: { chance: 0.5, amount: [1, 2] }, groups: [{ chance: 1, entries: [{ item: 'ITEM_ETC_HP_POTION_01', weight: 3, count: [1, 2] }] }] }
    const put = await http('PUT', `/api/admin/drops/${MANGNYANG.code}`, { table })
    expect(put.json).toMatchObject({ overridden: true, effective: { mob: MANGNYANG.code, provenance: 'authored', ...table } })
    expect(server.ctx.data.drops.get(MANGNYANG.code)!.groups[0].entries[0].item).toBe('ITEM_ETC_HP_POTION_01')
    expect((await http('GET', '/api/admin/drops?overridden=1')).json.rows.map((x: { mob: string }) => x.mob)).toEqual([MANGNYANG.code])
    const del = await http('DELETE', `/api/admin/drops/${MANGNYANG.code}`)
    expect(del.json.overridden).toBe(false)
    expect(server.ctx.data.drops.get(MANGNYANG.code)!.groups[0].entries[0].item).toBe('ITEM_CH_BLADE_02_A')
    expect((await http('GET', '/api/admin/drops/MOB_NOPE')).status).toBe(404)
  })
})

describe('world content through the GM editors', () => {
  it('nests: list, add at coordinates (mobs spawn), change, move, remove, restore, undo', async () => {
    const list = await http('GET', '/api/admin/nests?q=mangnyang')
    expect(list.json.rows.map((x: { id: number }) => x.id)).toEqual([NEAR_NEST.id])
    const add = await http('POST', '/api/admin/nests', { mob: 'mob_ch_mangnyang', x: 120, z: -120, count: 2, radius: 8, respawnSec: [20, 40] })
    expect(add.status).toBe(201)
    const id = add.json.data.nest.id
    expect(id).toBe(AUTHORED_NEST_ID_MIN)
    expect(add.json.data.nest).toMatchObject({ count: 2, alive: 2, x: 120, z: -120, source: 'authored' })
    const nf = JSON.parse(readFileSync(join(server.ctx.config.dataDir, 'content', 'nests.override.json'), 'utf8'))
    expect(nf.add[0].source.by).toBe(adminName)
    expect((await http('POST', `/api/admin/nests/${id}`, { count: 3, aggressive: true })).json.data.nest).toMatchObject({ count: 3, alive: 3, aggressive: true })
    expect((await http('POST', `/api/admin/nests/${id}`, { count: 99 })).status).toBe(400)
    expect((await http('POST', `/api/admin/nests/${id}/move`, { x: 150, z: -150 })).json.data.nest).toMatchObject({ x: 150, z: -150 })
    expect((await http('POST', `/api/admin/nests/${NEAR_NEST.id}/remove`)).status).toBe(200)
    expect((await http('GET', '/api/admin/nests?source=removed')).json.rows).toEqual([expect.objectContaining({ id: NEAR_NEST.id, removed: true })])
    expect((await http('POST', `/api/admin/nests/${NEAR_NEST.id}/restore`)).json.data.nest).toMatchObject({ id: NEAR_NEST.id, alive: 3 })
    expect((await http('POST', '/api/admin/nests/undo')).status).toBe(200)
    expect(server.ctx.data.nests.some((x) => x.id === NEAR_NEST.id)).toBe(false)
    expect((await http('POST', '/api/admin/nests', { mob: 'MOB_NOPE', x: 1, z: -1 })).status).toBe(409)
    const audited = server.ctx.store.db.prepare("SELECT action FROM admin_audit WHERE action LIKE 'nest.%' ORDER BY id").all() as { action: string }[]
    expect(audited.map((x) => x.action)).toEqual(expect.arrayContaining(['nest.add', 'nest.set', 'nest.move', 'nest.remove', 'nest.restore', 'nest.undo']))
  })

  it('NPCs: add an authored NPC wearing a base model, rename it, set its shop, move and remove it', async () => {
    const add = await http('POST', '/api/admin/npcs', { base: 'NPC_CH_POTION', name: 'Helper  Wang', x: 70, z: -70, yaw: 1.5 })
    expect(add.status).toBe(201)
    const code = add.json.data.npc.code
    expect(code).toMatch(/^NPCX_\d+$/)
    expect(add.json.data.npc).toMatchObject({ name: 'Helper Wang', base: 'NPC_CH_POTION', yaw: 1.5, source: 'authored' })
    expect((await http('POST', `/api/admin/npcs/${code}`, { name: 'Old Wang', shop: 'STORE_CH_POTION' })).json.data.npc).toMatchObject({ name: 'Old Wang', shop: 'STORE_CH_POTION' })
    expect((await http('POST', `/api/admin/npcs/${code}`, { shop: 'STORE_NOPE' })).status).toBe(409)
    expect((await http('POST', `/api/admin/npcs/${code}/move`, { x: 75, z: -75 })).json.data.npc).toMatchObject({ x: 75, z: -75 })
    const list = await http('GET', '/api/admin/npcs?q=wang')
    expect(list.json.rows.map((x: { code: string }) => x.code)).toEqual([code])
    expect((await http('POST', `/api/admin/npcs/${code}/remove`)).status).toBe(200)
    expect(server.ctx.data.npcs.some((x) => x.code === code)).toBe(false)
    expect((await http('POST', '/api/admin/npcs/NPC_CH_POTION', { name: 'Renamed Merchant' })).json.data.npc).toMatchObject({ source: 'patched', name: 'Renamed Merchant' })
    expect((await http('POST', '/api/admin/npcs/NPC_CH_POTION/restore')).json.data.npc.name).toBe('Potion Merchant')
  })

  it('quests: list, detail, disable / enable, and a bad edit answers 422 with its issues', async () => {
    const list = await http('GET', '/api/admin/quests')
    expect(list.json.rows).toEqual([expect.objectContaining({ id: 'TQ_001', title: 'Pests', source: 'repo', disabled: false })])
    const d = await http('GET', '/api/admin/quests/TQ_001')
    expect(d.json.quest).toMatchObject({ id: 'TQ_001', giver: 'NPC_CH_POTION' })
    expect((await http('POST', '/api/admin/quests/TQ_001/disable')).json).toMatchObject({ ok: true })
    expect((await http('GET', '/api/admin/quests')).json.rows[0]).toMatchObject({ disabled: true, source: 'override' })
    expect((await http('POST', '/api/admin/quests/TQ_001/enable')).json.ok).toBe(true)
    const bad = await http('PUT', '/api/admin/quests/TQ_001', { quest: { ...QUEST, giver: 'NPC_NOBODY' } })
    expect(bad.status).toBe(422)
    expect(bad.json.issues.some((i: { message: string }) => /NPC_NOBODY/.test(i.message))).toBe(true)
    expect((await http('DELETE', '/api/admin/quests/TQ_001')).json.ok).toBe(true)
    expect((await http('GET', '/api/admin/quests/NOPE_1')).status).toBe(404)
    // the quest editor wrote its own gm_audit rows as the admin
    const gm = server.ctx.store.recentAudit(50).filter((r) => r.username === adminName).map((r) => r.command)
    expect(gm).toEqual(expect.arrayContaining(['questoff', 'queston', 'questput', 'questdel']))
  })

  it('uniques: the view without uniques.json is empty; an unknown unique is a 404', async () => {
    const r = await http('GET', '/api/admin/uniques')
    expect(r.json).toEqual({ enabled: true, uniques: [] })
    expect((await http('POST', '/api/admin/uniques/MOB_CH_TIGERWOMAN/spawn')).status).toBe(404)
    expect((await http('GET', '/api/admin/mobs?q=tiger')).json.rows.map((x: { code: string }) => x.code)).toEqual([TIGER.code])
    expect((await http('GET', '/api/admin/shops')).json.shops[0]).toMatchObject({ id: 'STORE_CH_POTION', items: 2 })
  })
})
