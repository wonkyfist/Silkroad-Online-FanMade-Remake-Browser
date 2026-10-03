/**
 * Gameplay end to end on the REAL exported content (work/out/data + the jangan world manifest), over real
 * WebSockets. Skipped when the export is not there. Expectations are derived from the data files themselves
 * (nests, mobs, towns), so the test keeps working when the exporter or the world bounds change.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentEntries, type EntityState, type MobDef, type NestDef, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { seeded } from './fixtures.ts'

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = ['data/mobs.json', 'data/nests.json', 'data/items.json', 'data/towns.json', 'data/drops.json', 'world/jangan/manifest.json'].every((f) => existsSync(join(OUT, f)))

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>
const read = <T,>(f: string): T[] => contentEntries<T>(JSON.parse(readFileSync(join(OUT, 'data', f), 'utf8')))

describe.skipIf(!HAVE)('real Jangan data', () => {
  let s: TestServer
  const logs: string[] = []
  beforeAll(async () => {
    s = await startTestServer({ logs, config: { outDir: OUT, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(20) } })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  it('spawns every in-world nest with the right monster, at the right place and count', () => {
    const nests = read<NestDef>('nests.json')
    const mobs = new Map(read<MobDef>('mobs.json').map((m) => [m.code, m]))
    const sp = s.ctx.gameplay.spawner
    expect(sp.nests.length + sp.skipped.length).toBe(nests.length)
    expect(sp.nests.length).toBeGreaterThan(0)
    const line = logs.find((l) => l.startsWith('world content:'))!
    expect(line).toMatch(new RegExp(`${sp.nests.length} nests \\(${sp.skipped.length} skipped\\), \\d+ monsters spawned`))
    const byCode = new Map<string, number>()
    for (const n of sp.nests) {
      const def = nests.find((d) => d.id === n.def.id)!
      expect(n.mob.code).toBe(def.mob)
      expect(n.mob.level).toBe(mobs.get(def.mob)!.level)
      expect(n.alive.size).toBe(n.def.uniqueGroup ? n.alive.size : def.count)
      for (const id of n.alive) {
        const m = s.ctx.world.mobs.get(id)!
        expect(m.def.code).toBe(def.mob)
        expect(m.home).toEqual([def.x, def.z])
        // spawned inside the spawn radius, and never wandered beyond the roam radius
        const pos = s.ctx.world.positionAt(m, Date.now())
        expect(Math.hypot(pos[0] - def.x, pos[2] - def.z)).toBeLessThanOrEqual(Math.max(def.spawnRadius, def.radius) + 0.01)
        expect(m.maxHp).toBe(Math.round(m.def.hp * (m.variant === 'champion' ? 2 : m.variant === 'giant' ? 20 : 1)))
        byCode.set(m.def.code, (byCode.get(m.def.code) ?? 0) + 1)
      }
    }
    expect(byCode.get('MOB_CH_MANGNYANG')).toBeGreaterThan(0)
    // content summary lines
    for (const f of ['mobs', 'nests', 'items', 'levels', 'drops', 'npcs', 'shops']) expect(logs.some((l) => new RegExp(`content ${f}\\.json: \\d+ loaded`).test(l)), f).toBe(true)
    expect(logs.some((l) => /content towns\.json: Jangan \(jangan, safe area\)/.test(l))).toBe(true)
  })

  it('Jangan: new characters land in town; a player kills a Mangnyang, gets its EXP and loot (priority), dies to a tiger and respawns in town', async () => {
    const town = s.ctx.data.town('jangan')!
    expect(town).toBeDefined()
    // A: a GM that helps; B: a normal player
    const accA = await newAccount(s.url, 'realgm')
    s.ctx.store.setRole(s.ctx.store.accountByName(accA.username)!.id, 'gm')
    const accB = await newAccount(s.url, 'realp')
    const enter = async (token: string, name: string, weapon: 'sword' | 'glaive', model: string) => {
      const c = await Client.login(s.url, token)
      c.send({ t: 'charCreate', name, model, weapon })
      const ch = (await c.next('charCreated')).character
      c.send({ t: 'enterWorld', id: ch.id })
      const e = await c.next('worldEnter')
      const stats = (await c.next('stats')).stats
      const inv = (await c.next('inventory')).inventory
      return { c, ch, e, stats, inv, id: e.self.id }
    }
    const a = await enter(accA.token, 'RealGm', 'sword', 'CHAR_CH_MAN_ADVENTURER')
    const b = await enter(accB.token, 'RealHero', 'glaive', 'CHAR_CH_WOMAN_ADVENTURER')
    // both start at the Jangan return point, inside the town's safe area, wearing the client's default kit
    for (const p of [a, b]) {
      expect(p.e.self.pos[0]).toBeCloseTo(s.ctx.setup.spawn.x, 3)
      expect(p.e.self.pos[2]).toBeCloseTo(s.ctx.setup.spawn.z, 3)
      expect(s.ctx.data.inSafeArea('jangan', p.e.self.pos[0], p.e.self.pos[2])).toBe(true)
      expect(p.inv.equip.weapon?.code).toMatch(/^ITEM_CH_(SWORD|TBLADE)_01_A_DEF$/)
      expect(p.e.entities.some((x) => x.kind === 'npc')).toBe(true)
    }
    expect(Math.hypot(town.spawn.x - s.ctx.setup.spawn.x, town.spawn.z - s.ctx.setup.spawn.z)).toBeLessThan(1)
    const gm = async (cmd: string, ...args: string[]) => {
      a.c.send({ t: 'gm', cmd, args })
      return a.c.next('gmResult')
    }

    // A teleports next to a Mangnyang nest and summons B
    const nest = s.ctx.gameplay.spawner.nests.find((n) => n.mob.code === 'MOB_CH_MANGNYANG')!
    expect((await gm('tp', String(nest.def.x + 3), String(nest.def.z + 3))).ok).toBe(true)
    expect((await gm('invis', 'on')).ok).toBe(true)
    expect((await gm('summon', 'RealHero')).ok).toBe(true)
    await b.c.next('warp', (m) => m.id === b.id)
    await sleep(300)
    const seen = new Map<number, EntityState>()
    for (const m of b.c.log) if (m.t === 'spawn') seen.set(m.entity.id, m.entity)

    // B kills normal Mangnyangs until one drops something
    let exp = 0
    let loot: EntityState | null = null
    for (let kill = 0; kill < 5 && !loot; kill++) {
      const target = [...s.ctx.world.mobs.values()]
        .filter((m) => m.def.code === 'MOB_CH_MANGNYANG' && m.ai === 'idle' && m.variant === 'normal' && s.ctx.world.players.get(b.id)!.known.has(m.id))
        .sort((x, y) => s.ctx.world.distance(x, s.ctx.world.players.get(b.id)!, Date.now()) - s.ctx.world.distance(y, s.ctx.world.players.get(b.id)!, Date.now()))[0]
      expect(target, 'a Mangnyang in view').toBeDefined()
      b.c.send({ t: 'attack', target: target.id })
      expect(await b.c.next('actionResult', (m) => m.re === 'attack')).toMatchObject({ ok: true })
      await b.c.next('combat', (m) => m.target === target.id && m.killed === true, 40_000)
      const gain = await b.c.next('statsDelta', (m) => m.gain?.from === target.id)
      expect(gain.gain).toEqual({ exp: target.def.exp, spExp: target.def.spExp ?? target.def.exp, from: target.id })
      exp += target.def.exp
      await sleep(200)
      const drop = b.c.queue.find((m): m is Msg<'spawn'> => m.t === 'spawn' && m.entity.kind === 'item' && m.entity.owner === b.id)
      if (drop) loot = drop.entity
    }
    expect(loot, 'something dropped in 5 kills (gold chance 70% each)').not.toBeNull()
    // priority: A (even a GM) cannot take B's loot during the owner window; B can
    expect(await (async () => {
      a.c.send({ t: 'pickup', id: loot!.id })
      return a.c.next('actionResult', (m) => m.re === 'pickup')
    })()).toMatchObject({ ok: false, reason: 'not_owner' })
    b.c.send({ t: 'pickup', id: loot!.id })
    expect(await b.c.next('actionResult', (m) => m.re === 'pickup')).toMatchObject({ ok: true })
    await b.c.next('inventoryUpdate', () => true, 5000)
    await b.c.next('despawn', (m) => m.id === loot!.id, 5000)
    const row = s.ctx.store.characterById(b.ch.id)!
    expect(row.exp + (row.level > 1 ? 118 : 0)).toBe(exp)

    // A equips a real weapon: stats follow
    expect((await gm('setlevel', 'RealGm', '5')).ok).toBe(true)
    const lv5 = (await a.c.next('stats', (m) => m.stats.level === 5)).stats
    const added = await gm('item', 'ITEM_CH_SWORD_01_C')
    expect(added.ok).toBe(true)
    const slot = (added.data as { bag: { slot: number }[] }).bag[0].slot
    a.c.send({ t: 'itemEquip', bag: slot })
    expect(await a.c.next('actionResult', (m) => m.re === 'itemEquip')).toMatchObject({ ok: true })
    const armed = (await a.c.next('stats', (m) => m.stats.physAttack[0] !== lv5.physAttack[0])).stats
    expect(armed.physAttack[0]).toBeGreaterThan(lv5.physAttack[0])

    // three White Tigers appear next to B (A is invisible and joins B first, so they only see B): B dies, then
    // respawns in Jangan
    expect((await gm('tp', '@RealHero')).ok).toBe(true)
    const tigers = await gm('spawn', 'MOB_CH_WHITETIGER', '3')
    expect(tigers.ok).toBe(true)
    await b.c.next('entityUpdate', (m) => m.id === b.id && m.state === 'dead', 60_000)
    b.c.send({ t: 'respawn' })
    expect(await b.c.next('actionResult', (m) => m.re === 'respawn')).toMatchObject({ ok: true })
    const warp = await b.c.next('warp', (m) => m.id === b.id)
    expect(warp.pos[0]).toBeCloseTo(s.ctx.setup.spawn.x, 3)
    expect(warp.pos[2]).toBeCloseTo(s.ctx.setup.spawn.z, 3)
    expect(s.ctx.data.inSafeArea('jangan', warp.pos[0], warp.pos[2])).toBe(true)
    for (const id of (tigers.data as { ids: number[] }).ids) expect((await gm('kill', String(id))).ok).toBe(true)
    a.c.close()
    b.c.close()
    await Promise.all([a.c.closed, b.c.closed])
  }, 150_000)
})
