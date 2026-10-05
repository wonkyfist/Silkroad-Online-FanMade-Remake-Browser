/**
 * Wave-1 integration review: the abuse cases and invariants the authoritative server must hold. Speed (rapid
 * moveTo), reach (no hit from out of range), interest management (nothing about unseen entities), inventory
 * races, stat points, the level cap, leash kiting, fighting from a safe area, potion cooldowns, the return scroll,
 * unique nests, loot priority across a relog, and the v2 -> v3 migration of an existing database.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MAX_COORD, type ItemDef, type ServerMessage, type TownDef, type Vec3 } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken } from '../src/auth.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { Spawner } from '../src/spawner.ts'
import { World, type Player } from '../src/world.ts'
import { Client, newAccount, sleep, startTestServer, testConfig, type TestServer } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, TIGER, contentFiles, item, nest, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const POTION_NO_CD = item('ITEM_ETC_HP_POTION_02', { category: 'potion', maxStack: 50, use: { hp: 50, cooldownGroup: 'hp' } })
const RETURN_SCROLL = item('ITEM_ETC_SCROLL_RETURN_01', { category: 'scroll', maxStack: 10, use: { returnToTown: true, castMs: 30_000 } })

// ---- in-process harness (no sockets): one world, one gameplay, a temp database ----------------------------------

function harness(opts: { items?: ItemDef[]; towns?: TownDef[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-review-'))
  const config = { ...testConfig(root), rng: seeded(3) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG, TIGER], items: [...ITEMS, ...(opts.items ?? [])], levels: LEVELS, drops: DROPS, towns: opts.towns ?? [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(3) })
  let n = 0
  /** A fresh character in the world (starter kit worn), or `characterId` re-entering. */
  const enter = (pos: Vec3, characterId?: number) => {
    let id = characterId
    if (id === undefined) {
      const acc = store.createAccount(`acc${++n}`, 'x')!
      const row = store.createCharacter(acc, `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
      if (typeof row === 'string') throw new Error(row)
      gameplay.grantStarterKit(row.id, row.weapon, row.model)
      id = row.id
    }
    const row = store.characterById(id)!
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: row.level, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    return { p, inbox, characterId: row.id }
  }
  const results = (inbox: ServerMessage[], re: string) => inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === re)
  return {
    store,
    world,
    gameplay,
    data,
    enter,
    results,
    close() {
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('rules (in-process)', () => {
  it('a mob running home after its leash evades every hit (no leash kiting) and is restored at home', () => {
    const h = harness()
    const now = Date.now()
    const { p, inbox } = h.enter([0, 0, 0])
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, now)
    m.hp = 5
    m.ai = 'return'
    h.gameplay.attack(p, m, now)
    const c = inbox.find((x): x is Msg<'combat'> => x.t === 'combat')!
    expect(c.hits).toEqual([{ outcome: 'miss', damage: 0, hp: 5 }])
    expect(m.hp).toBe(5)
    expect(m.damage.size).toBe(0)
    expect(m.ai).toBe('return')
    h.close()
  })

  it('a player standing in a town safe area cannot swing at a mob outside it (mobs cannot hit back there)', () => {
    const h = harness({ towns: [{ code: 'T', name: 'Town', world: 'jangan', spawn: { x: 0, y: 0, z: 0 }, safeArea: { x: 0, z: 0, halfX: 10, halfZ: 10 } }] })
    const now = Date.now()
    const { p, inbox } = h.enter([9.5, 0, 0])
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 11, 0, 0, null, now)
    h.world.updateInterest(now)
    expect(p.known.has(m.id)).toBe(true)
    // the request itself is refused from inside...
    h.gameplay.request(p, { t: 'attack', target: m.id }, now)
    expect(h.results(inbox, 'attack')[0]).toMatchObject({ ok: false, reason: 'safe_zone' })
    // ...and an attack carried in from outside ends at the first swing inside
    p.action = { kind: 'attack', target: m.id, chaseAt: 0, chaseTo: null }
    h.gameplay.tick(now + 50)
    expect(p.action).toBeNull()
    expect(inbox.some((x) => x.t === 'combat')).toBe(false)
    expect(m.hp).toBe(m.maxHp)
    h.close()
  })

  it('potions without a cooldown in items.json get the server default; the return scroll casts, even in combat', () => {
    const h = harness({ items: [POTION_NO_CD, RETURN_SCROLL] })
    const now = Date.now()
    const { p, inbox, characterId } = h.enter([50, 0, 50])
    expect(h.gameplay.gmItem(p, POTION_NO_CD, POTION_NO_CD.code, 5).ok).toBe(true)
    expect(h.gameplay.gmItem(p, RETURN_SCROLL, RETURN_SCROLL.code, 2).ok).toBe(true)
    const slot = (code: string) => h.store.loadInventory(characterId).bag.findIndex((i) => i?.code === code)
    p.hp = 10
    h.gameplay.request(p, { t: 'itemUse', bag: slot(POTION_NO_CD.code) }, now)
    h.gameplay.request(p, { t: 'itemUse', bag: slot(POTION_NO_CD.code) }, now + 100)
    h.gameplay.request(p, { t: 'itemUse', bag: slot(POTION_NO_CD.code) }, now + 1100)
    expect(h.results(inbox, 'itemUse').map((r) => r.reason ?? 'ok')).toEqual(['ok', 'cooldown', 'ok'])
    expect(h.store.loadInventory(characterId).bag[slot(POTION_NO_CD.code)]?.count).toBe(3)
    // return scroll (docs/SHOPS.md §4.3): allowed while fighting; a 30 s cast, then the warp, and only then the scroll goes
    inbox.length = 0
    p.lastCombatAt = now + 1000
    h.gameplay.request(p, { t: 'itemUse', bag: slot(RETURN_SCROLL.code) }, now + 2000)
    expect(h.results(inbox, 'itemUse')[0]).toMatchObject({ ok: true })
    h.world.tick(now + 2000 + 29_000)
    expect(inbox.some((x) => x.t === 'warp')).toBe(false)
    expect(h.store.loadInventory(characterId).bag[slot(RETURN_SCROLL.code)]?.count).toBe(2)
    h.world.tick(now + 2000 + 30_000)
    const warp = inbox.find((x): x is Msg<'warp'> => x.t === 'warp')!
    expect([warp.pos[0], warp.pos[2]]).toEqual([0, 0])
    expect(h.store.loadInventory(characterId).bag[slot(RETURN_SCROLL.code)]?.count).toBe(1)
    h.close()
  })

  it('loot priority belongs to the character: it survives a relog, others still wait', () => {
    const h = harness()
    const now = Date.now()
    const a = h.enter([0, 0, 0])
    const b = h.enter([1, 0, 0])
    const loot = h.gameplay.spawnGroundItem('ITEM_CH_BLADE_02_A', 1, 0, [0.5, 0, 0], a.p, now)
    expect(h.world.state(loot)).toMatchObject({ owner: a.p.id })
    h.world.remove(a.p.id, now)
    const again = h.enter([0, 0, 0], a.characterId)
    expect(again.p.id).not.toBe(a.p.id)
    h.world.updateInterest(now)
    h.gameplay.request(b.p, { t: 'pickup', id: loot.id }, now)
    expect(h.results(b.inbox, 'pickup')[0]).toMatchObject({ ok: false, reason: 'not_owner' })
    h.gameplay.request(again.p, { t: 'pickup', id: loot.id }, now)
    expect(h.results(again.inbox, 'pickup')[0]).toMatchObject({ ok: true })
    expect(h.store.loadInventory(a.characterId).bag.some((i) => i?.code === 'ITEM_CH_BLADE_02_A')).toBe(true)
    h.close()
  })

  it('a dead player that gets a kill share levels up but stays dead; EXP stops at the level cap', () => {
    const h = harness()
    const now = Date.now()
    const { p } = h.enter([0, 0, 0])
    h.gameplay.playerDied(p, now)
    h.gameplay.reward(p, 35, 0)
    expect(p.progress.level).toBe(2)
    expect(p.dead).toBe(true)
    expect(p.hp).toBe(0)
    h.gameplay.gmSetLevel(p, 5)
    expect(p.hp).toBe(0)
    // the fixture level table ends at 5 -> 6; LEVEL_CAP is 20 but levels past the table cannot be reached
    h.gameplay.gmHeal(p)
    h.gameplay.gmSetLevel(p, 20)
    h.gameplay.reward(p, 1e9, 0)
    expect(p.progress).toMatchObject({ level: 20, exp: 0 })
    expect(h.store.characterById(p.characterId)).toMatchObject({ level: 20, exp: 0 })
    h.close()
  })
})

describe('unique nests', () => {
  it('nests sharing a uniqueGroup hold one mob between them and respawn it at a random nest of the group', () => {
    const defs = [1, 2, 3, 4, 5].map((id) => nest(id, TIGER.code, id * 10, -10, { uniqueGroup: TIGER.code, respawnSec: [10, 10] }))
    const other = nest(9, MANGNYANG.code, 0, 0, { count: 3 })
    const sp = new Spawner([...defs, other], (c) => (c === TIGER.code ? TIGER : c === MANGNYANG.code ? MANGNYANG : undefined), { world: 'jangan', mobLevelMax: 0, rng: seeded(7) })
    let next = 1
    const where: number[] = []
    const spawn = (n: { def: { id: number } }) => {
      where.push(n.def.id)
      return next++
    }
    expect(sp.fill(spawn)).toBe(1 + 3)
    expect(sp.capacity).toBe(1 + 3)
    const tigersAlive = () => sp.nests.filter((n) => n.def.mob === TIGER.code).reduce((s, n) => s + n.alive.size, 0)
    expect(tigersAlive()).toBe(1)
    let t = 0
    for (let i = 0; i < 20; i++) {
      const alive = sp.nests.find((n) => n.def.mob === TIGER.code && n.alive.size > 0)!
      sp.died([...alive.alive][0], t)
      expect(tigersAlive()).toBe(0)
      expect(sp.tick(t + 9_000, spawn)).toBe(0)
      expect(sp.tick(t + 10_000, spawn)).toBe(1)
      expect(tigersAlive()).toBe(1)
      t += 10_000
    }
    expect(new Set(where.filter((id) => id <= 5)).size).toBeGreaterThan(2)
  })
})

// ---- over the wire ------------------------------------------------------------------------------------

const SPAWN: [number, number, number] = [50, 0, -50]
const VIEW = 60

describe('abuse over the wire', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({
      config: { moveSpeed: 5.5, tickHz: 20, viewRange: VIEW, rng: seeded(11) },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({
          mobs: [MANGNYANG, TIGER],
          nests: [nest(1, MANGNYANG.code, 62, -50, { count: 3, radius: 1, spawnRadius: 1 }), nest(2, MANGNYANG.code, 300, -300, { count: 5 })],
          items: ITEMS,
          levels: LEVELS,
          drops: DROPS,
          npcs: NPCS,
          shops: SHOPS,
        }),
      },
    })
  })
  afterAll(async () => {
    await s.stopAndClean()
  })

  let names = 0
  async function player(gm = false) {
    const acc = await newAccount(s.url, gm ? 'rgm' : 'rp')
    if (gm) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Probe${++names}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    await c.next('inventory')
    const self = s.ctx.world.players.get(enter.self.id)!
    return { c, ch, enter, id: enter.self.id, self }
  }
  async function act(c: Client, msg: Record<string, unknown> & { t: string }) {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t)
  }
  const bye = async (...cs: Client[]) => {
    for (const c of cs) {
      c.close()
      await c.closed
    }
    await sleep(30)
  }

  /** Every message about an entity refers to one the client has spawned (or itself). */
  function assertInterest(c: Client, selfId: number, initial: number[]) {
    const known = new Set(initial)
    for (const m of c.log) {
      if (m.t === 'spawn') known.add(m.entity.id)
      else if (m.t === 'despawn') {
        expect(known.has(m.id), `despawn of unknown ${m.id}`).toBe(true)
        known.delete(m.id)
      } else if (m.t === 'move' || m.t === 'stop' || m.t === 'warp' || m.t === 'entityUpdate' || m.t === 'levelUp' || m.t === 'appearance') {
        expect(m.id === selfId || known.has(m.id), `${m.t} about unseen entity ${m.id}`).toBe(true)
      } else if (m.t === 'combat') {
        expect([m.attacker, m.target].some((id) => id === selfId || known.has(id)), `combat about unseen ${m.attacker}->${m.target}`).toBe(true)
      }
    }
  }

  it('rapid moveTo never beats the move speed', async () => {
    const p = await player()
    const start = s.ctx.world.positionAt(p.self, Date.now())
    const t0 = Date.now()
    const targets = [
      [390, -50],
      [50, -390],
      [390, -390],
      [5, -5],
    ]
    for (let i = 0; i < 30; i++) {
      const [x, z] = targets[i % targets.length]
      p.c.send({ t: 'moveTo', x, z })
      await sleep(20)
    }
    await sleep(300)
    const now = Date.now()
    const pos = s.ctx.world.positionAt(p.self, now)
    const moved = Math.hypot(pos[0] - start[0], pos[2] - start[2])
    expect(moved).toBeLessThanOrEqual(5.5 * ((now - t0) / 1000) + 0.1)
    // a far-off-the-map target is clamped (validator: |x| <= MAX_COORD; the world: its bounds)
    p.c.send({ t: 'moveTo', x: MAX_COORD, z: MAX_COORD })
    const mv = await p.c.next('move', (m) => m.id === p.id && m.move.to[0] === 400)
    expect(mv.move.to[2]).toBe(0)
    await bye(p.c)
  })

  it('auto-attack only lands within reach, never on a corpse; interest never leaks', async () => {
    const p = await player()
    const reachOf = (id: number) => {
      const m = s.ctx.world.mobs.get(id)!
      return p.self.combat.range + p.self.radius + m.radius
    }
    const swings: { d: number; reach: number }[] = []
    const gp = s.ctx.gameplay
    const orig = gp.attack.bind(gp)
    gp.attack = (a, t, now) => {
      if (a.kind === 'player' && a.id === p.id) swings.push({ d: s.ctx.world.distance(a, t, now), reach: reachOf(t.id) })
      orig(a, t, now)
    }
    try {
      const target = p.enter.entities.find((e) => e.kind === 'mob' && e.model === MANGNYANG.code)!
      expect(await act(p.c, { t: 'attack', target: target.id })).toMatchObject({ ok: true })
      await p.c.next('combat', (m) => m.target === target.id && m.killed === true, 15_000)
      expect(swings.length).toBeGreaterThan(0)
      for (const w of swings) expect(w.d).toBeLessThanOrEqual(w.reach + 1e-6)
      // the corpse stays for a moment: attacking it is refused
      expect(await act(p.c, { t: 'attack', target: target.id })).toMatchObject({ ok: false, reason: 'target_dead' })
      // the far nest is out of view: its mobs are unknown (no attack, no pickup, no messages)
      const far = [...s.ctx.world.mobs.values()].find((m) => m.nest?.id === 2)!
      expect(await act(p.c, { t: 'attack', target: far.id })).toMatchObject({ ok: false, reason: 'not_found' })
      await sleep(500)
      assertInterest(p.c, p.id, p.enter.entities.map((e) => e.id))
      // server side: after an interest pass every player knows exactly what is in range
      const now = Date.now()
      s.ctx.world.updateInterest(now)
      for (const v of s.ctx.world.players.values()) {
        for (const e of s.ctx.world.allEntities()) {
          if (e.id === v.id) continue
          const inView = s.ctx.world.inRange(v, e, now, false)
          if (inView) expect(v.known.has(e.id)).toBe(true)
          if (v.known.has(e.id)) expect(s.ctx.world.inRange(v, e, now, true)).toBe(true)
        }
      }
    } finally {
      gp.attack = orig
    }
    await bye(p.c)
  }, 25_000)

  it('inventory races: a burst of equip/drop/move on one item, and repeated pickups, never duplicate or lose it', async () => {
    const p = await player()
    // loot of earlier tests lying around is not ours
    const before = new Set(s.ctx.world.items.keys())
    const blade = s.ctx.data.item('ITEM_CH_BLADE_02_A')!
    const r = s.ctx.gameplay.gmItem(p.self, blade, blade.code, 1)
    expect(r.ok).toBe(true)
    const slot = r.ok ? r.value.bag[0].slot : -1
    const burst = [
      { t: 'itemEquip', bag: slot },
      { t: 'itemEquip', bag: slot },
      { t: 'itemDrop', bag: slot },
      { t: 'itemMove', from: slot, to: 20 },
      { t: 'itemUnequip', slot: 'weapon' },
      { t: 'itemDrop', bag: slot },
    ]
    for (const m of burst) p.c.send(m)
    for (const m of burst) await p.c.next('actionResult', (x) => x.re === m.t)
    const count = (code: string) => {
      const inv = s.ctx.store.loadInventory(p.ch.id)
      const held = [...inv.bag, ...Object.values(inv.equip)].reduce((n, i) => n + (i?.code === code ? i.count : 0), 0)
      const ground = [...s.ctx.world.items.values()].reduce((n, i) => n + (i.code === code && !before.has(i.id) ? i.count : 0), 0)
      return held + ground
    }
    expect(count('ITEM_CH_BLADE_02_A')).toBe(1)
    expect(count('ITEM_CH_BLADE_01_A_DEF')).toBe(1)
    // whatever is on the ground now: five pickups in one burst take it once
    for (const it of [...s.ctx.world.items.values()].filter((i) => !before.has(i.id))) {
      for (let i = 0; i < 5; i++) p.c.send({ t: 'pickup', id: it.id })
      const res = [] as Msg<'actionResult'>[]
      for (let i = 0; i < 5; i++) res.push(await p.c.next('actionResult', (x) => x.re === 'pickup'))
      await sleep(300)
      expect(res.filter((x) => x.ok).length).toBeGreaterThanOrEqual(1)
      expect(s.ctx.world.items.has(it.id)).toBe(false)
    }
    expect(count('ITEM_CH_BLADE_02_A')).toBe(1)
    expect(count('ITEM_CH_BLADE_01_A_DEF')).toBe(1)
    await bye(p.c)
  }, 15_000)

  it('stat points cannot be spent twice; odd numbers are rejected by the validator', async () => {
    const p = await player()
    s.ctx.gameplay.gmSetLevel(p.self, 2)
    await p.c.next('stats', (m) => m.stats.level === 2)
    for (let i = 0; i < 6; i++) p.c.send({ t: 'statUp', stat: 'str', points: 1 })
    const res: Msg<'actionResult'>[] = []
    for (let i = 0; i < 6; i++) res.push(await p.c.next('actionResult', (m) => m.re === 'statUp'))
    expect(res.filter((r) => r.ok)).toHaveLength(3)
    expect(res.filter((r) => r.reason === 'no_points')).toHaveLength(3)
    expect(s.ctx.store.characterById(p.ch.id)).toMatchObject({ level: 2, strength: 24, stat_points: 0 })
    for (const bad of [
      { t: 'itemSplit', from: 0, to: 1, count: -1 },
      { t: 'shopBuy', npc: 1, item: 'ITEM_ETC_HP_POTION_01', count: 1e9 },
      { t: 'statUp', stat: 'str', points: 1.5 },
      { t: 'statUp', stat: 'str', points: 0 },
      { t: 'attack', target: 1e300 },
      { t: 'itemDrop', bag: 0, count: 0 },
      { t: 'moveTo', x: 1e308, z: 0 },
      { t: 'itemEquip', bag: -1 },
    ]) {
      p.c.send(bad)
      expect((await p.c.next('error')).code, JSON.stringify(bad)).toBe('bad_request')
    }
    await bye(p.c)
  })

  it('GM spawn/item/kill/heal work and every GM command is audited (a player attempt too)', async () => {
    const g = await player(true)
    const q = await player()
    const gm = async (cmd: string, ...args: string[]) => {
      g.c.send({ t: 'gm', cmd, args })
      return g.c.next('gmResult')
    }
    const spawned = await gm('spawn', MANGNYANG.code, '2')
    expect(spawned.ok).toBe(true)
    const ids = (spawned.data as { ids: number[] }).ids
    expect(await gm('item', 'ITEM_ETC_HP_POTION_01', '3')).toMatchObject({ ok: true })
    expect(await gm('kill', String(ids[0]))).toMatchObject({ ok: true })
    expect(await gm('kill', String(ids[1]))).toMatchObject({ ok: true })
    expect(await gm('heal', q.enter.self.name)).toMatchObject({ ok: true })
    q.c.send({ t: 'gm', cmd: 'item', args: ['ITEM_ETC_GOLD_01', '1000'] })
    expect((await q.c.next('error')).code).toBe('forbidden')
    const audit = s.ctx.store.recentAudit(20)
    const mine = audit.filter((a) => a.username === s.ctx.store.accountById(s.ctx.store.characterById(g.ch.id)!.account_id)!.username)
    expect(mine.map((a) => `${a.command}:${a.ok}`).reverse()).toEqual(['spawn:1', 'item:1', 'kill:1', 'kill:1', 'heal:1'])
    expect(audit.some((a) => a.command === 'item' && a.ok === 0 && a.result.startsWith('denied'))).toBe(true)
    expect(s.ctx.store.characterById(q.ch.id)!.gold).toBe(0)
    await bye(g.c, q.c)
  })
})

// ---- migration of an existing (v2) database --------------------------------------------------------------

describe('existing database (schema v2)', () => {
  let s: TestServer
  const TOKEN = 'veteran-session-token'
  beforeAll(async () => {
    s = await startTestServer({
      config: { tickHz: 20, rng: seeded(2) },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ items: ITEMS, levels: LEVELS }),
      },
      prepare(root) {
        mkdirSync(join(root, 'data'), { recursive: true })
        const db = new Database(join(root, 'data', 'game.db'))
        db.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_login INTEGER);
          CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
          CREATE TABLE characters (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), name TEXT NOT NULL COLLATE NOCASE, model TEXT NOT NULL, weapon TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, exp INTEGER NOT NULL DEFAULT 0, x REAL, y REAL, z REAL, yaw REAL NOT NULL DEFAULT 0, world TEXT NOT NULL, created_at INTEGER NOT NULL, last_played INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
          CREATE UNIQUE INDEX characters_name_live ON characters(name COLLATE NOCASE) WHERE deleted_at IS NULL;
          ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'gm', 'admin'));
          CREATE TABLE gm_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id), character_id INTEGER, command TEXT NOT NULL, args TEXT NOT NULL, result TEXT NOT NULL, ok INTEGER NOT NULL);
          INSERT INTO accounts (id, username, password_hash, created_at) VALUES (1, 'veteran', 'x', 1);
          INSERT INTO characters (id, account_id, name, model, weapon, level, x, y, z, world, created_at) VALUES
            (1, 1, 'Ryu', 'CHAR_CH_MAN_ADVENTURER', 'spear', 1, 60, 0, -60, 'jangan', 1),
            (2, 1, 'Mei', 'CHAR_CH_WOMAN_ADVENTURER', 'sword', 5, 70, 0, -70, 'jangan', 1);
          PRAGMA user_version = 2;`)
        db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, 1, 1, ?)').run(hashToken(TOKEN), Date.now() + 3_600_000)
        db.close()
      },
    })
  })
  afterAll(async () => {
    await s.stopAndClean()
  })

  it('upgrades to v3: starter stats (with per-level growth), then the starter kit and full HP at the next entry', async () => {
    expect(s.ctx.store.schemaVersion).toBe(15)
    expect(s.ctx.store.characterById(1)).toMatchObject({ level: 1, strength: 20, intellect: 20, stat_points: 0, gold: 0, hp: null, dead: 0, bag_size: 48, starter_kit: 0 })
    expect(s.ctx.store.characterById(2)).toMatchObject({ level: 5, strength: 24, intellect: 24, stat_points: 12, starter_kit: 0 })
    // v4: default appearance, no saved navmesh surface
    expect(s.ctx.store.characterById(1)).toMatchObject({ height: 2, volume: 2, outfit: 'clothes', nav_surface: null })
    const c = await Client.login(s.url, TOKEN)
    c.send({ t: 'charList' })
    expect((await c.next('charList')).characters.map((ch) => ch.name)).toEqual(['Ryu', 'Mei'])
    c.send({ t: 'enterWorld', id: 2 })
    const enter = await c.next('worldEnter')
    expect(enter.self).toMatchObject({ name: 'Mei', level: 5, pos: [70, 0, -70], height: 2, volume: 2, equip: { weapon: 'ITEM_CH_SWORD_01_A_DEF', chest: 'ITEM_CH_W_CLOTHES_01_BA_A_DEF' } })
    const stats = (await c.next('stats')).stats
    expect(stats).toMatchObject({ level: 5, str: 24, int: 24, statPoints: 12 })
    expect(stats.hp).toBe(stats.maxHp)
    const inv = (await c.next('inventory')).inventory
    expect(Object.keys(inv.equip).sort()).toEqual(['chest', 'feet', 'legs', 'weapon'])
    expect(s.ctx.store.characterById(2)!.starter_kit).toBe(1)
    // leaving and entering again does not hand the kit out twice
    c.send({ t: 'leaveWorld' })
    await c.next('worldLeft')
    c.send({ t: 'enterWorld', id: 2 })
    await c.next('worldEnter')
    const again = (await c.next('inventory')).inventory
    expect(again.bag.filter(Boolean)).toHaveLength(0)
    c.close()
    await c.closed
  })
})
