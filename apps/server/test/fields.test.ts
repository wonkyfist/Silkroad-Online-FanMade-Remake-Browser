/**
 * The server on the fields exports (docs/FIELDS.md §4 and §7 lane 3; docs/WAVE_PLAN.md §4.10 FLD-S, decision 45):
 * WORLD_EXPORT picks the export FOLDER (work/out/world/jangan-fields, 307 regions) while the world ID stays 'jangan'
 * (nests, NPCs, towns, saves, `tp jangan`). The real-export suites are skipped without the exports.
 *
 * Thresholds come from the real export: about 91 nests (861 monsters) in the Western China fields north-west of town
 * sit across the river with no ferry teleport yet, so the placement rule refuses them (logged once at startup);
 * about 700 nests and 6,090 monsters remain.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION, type MobDef, type NestDef, type ServerMessage, type ZoneDef } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT, loadConfig } from '../src/config.ts'
import { resolveWorld, withTownSpawn } from '../src/content.ts'
import { GameData, parseZones } from '../src/gamedata.ts'
import { MeshNav, type NavPoint } from '../src/nav.ts'
import { Spawner } from '../src/spawner.ts'
import { seeded } from './fixtures.ts'
import { Client, api, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const DATA_FILES = ['data/mobs.json', 'data/nests.json', 'data/items.json', 'data/towns.json', 'data/npcs.json'].map((f) => join(OUT, f))
const exportReady = (folder: string) => {
  const file = join(OUT, 'world', folder, 'manifest.json')
  if (!existsSync(file) || !DATA_FILES.every((f) => existsSync(f))) return null
  const m = JSON.parse(readFileSync(file, 'utf8')) as { nav?: { file?: string; instances?: number }; spawn?: { x: number; y: number; z: number }; places?: { name: string; x: number; z: number }[] }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world', folder, m.nav.file)) ? m : null
}
const FIELDS = exportReady('jangan-fields')
const NEAR = exportReady('jangan-near')
const JANGAN = exportReady('jangan')

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** GATE_CH, the town return point (teleportdata.txt; the manifests' spawn). */
const GATE_CH = { x: 96.9, y: -3.2609, z: -136.9 }

// ---- units (no export needed) ---------------------------------------------------------------------

describe('world export selection (units)', () => {
  it('WORLD_EXPORT defaults to the fields when OUT_DIR has them (W3-I), else to the world id; an explicit one wins', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sro-noexport-'))
    try {
      expect(loadConfig({ OUT_DIR: empty }).worldExport).toBe('jangan')
      expect(loadConfig({ OUT_DIR: empty, WORLD: 'other' }).worldExport).toBe('other')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
    expect(loadConfig({}).worldExport).toBe(existsSync(join(OUT, 'world/jangan-fields/manifest.json')) ? 'jangan-fields' : 'jangan')
    expect(loadConfig({ WORLD_EXPORT: 'jangan' }).worldExport).toBe('jangan')
    expect(loadConfig({ WORLD_EXPORT: 'jangan-fields' })).toMatchObject({ world: 'jangan', worldExport: 'jangan-fields' })
  })

  it('resolveWorld reads the export folder but names the world and its first place by the id', () => {
    const out = mkdtempSync(join(tmpdir(), 'sro-fields-'))
    try {
      const w = resolveWorld(out, 'jangan-fields', null, 'jangan')
      expect(w.displayName).toBe('Jangan')
      expect(w.places.map((p) => p.name)).toEqual(['jangan', 'spawn'])
      // without an id the folder names everything (the old behaviour)
      expect(resolveWorld(out, 'jangan', null).places[0].name).toBe('jangan')
      expect(withTownSpawn(w, 'jangan', { name: 'Jangan', spawn: { x: 1, y: 2, z: 3 } }).places[0]).toEqual({ name: 'jangan', x: 1, z: 3, group: 'town' })
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('reads zones.json leniently and names the region under a position', () => {
    const zones: ZoneDef[] = [
      { region: (97 << 8) | 168, rx: 168, rz: 97, name: 'Jangan', area: 'Town_Jangan', continent: 'CHINA', town: 'JANGAN' },
      { region: (96 << 8) | 167, rx: 167, rz: 96, name: 'Grassland', area: null, continent: 'CHINA' },
      { region: (96 << 8) | 168, rx: 168, rz: 96, name: '', area: null, continent: null },
    ]
    const text = JSON.stringify({ schema: 1, kind: 'zones', entries: [...zones, { region: 1, rx: 2, rz: 3, name: 'bad', area: null, continent: null }, 'junk'] })
    const parsed = parseZones(text)
    expect(parsed).toEqual(zones)
    expect(parseZones('not json')).toEqual([])
    expect(parseZones(null)).toEqual([])
    const data = new GameData({ zones: parsed })
    const origin = { ox: 168, oz: 97 }
    // region (168, 97) spans x 0..192 and z -192..0; (167, 96) x -192..0 and z 0..192 (glTF z runs south)
    expect(data.zoneAt(96.9, -136.9, origin)?.name).toBe('Jangan')
    expect(data.zoneName(-10, 10, origin)).toBe('Grassland')
    // a nameless region takes the named neighbour nearest to the point, as the client's HUD does (P-DATA): (10, 10)
    // is 10 m from both (167, 96) and (168, 97); the first in the client's scan order wins
    expect(data.zoneName(10, 10, origin)).toBe('Grassland')
    expect(data.zoneName(150, 20, origin)).toBe('Jangan')
    expect(data.zoneName(5000, 0, origin)).toBe('')
    expect(data.zoneName(96.9, -136.9, null)).toBe('')
    expect(data.summary().at(-1)).toBe('content zones.json: 3 regions, 2 area names')
    expect(new GameData().summary().some((l) => l.includes('zones.json'))).toBe(false)
  })

  it('NEST_COUNT_SCALE scales every plain nest to max(1, round(count x scale)); unique groups keep one', () => {
    const mob = { code: 'MOB_A', level: 1 } as MobDef
    const nest = (id: number, count: number, uniqueGroup?: string) =>
      ({ id, world: 'jangan', mob: 'MOB_A', x: 0, z: 0, count, radius: 10, spawnRadius: 10, respawnSec: [10, 20], ...(uniqueGroup ? { uniqueGroup } : {}) }) as NestDef
    const defs = [nest(1, 10), nest(2, 3), nest(3, 1), nest(4, 1, 'U'), nest(5, 1, 'U')]
    const run = (countScale?: number) => {
      const sp = new Spawner(defs, () => mob, { world: 'jangan', mobLevelMax: 0, rng: seeded(1), countScale })
      let id = 0
      const n = sp.fill(() => ++id)
      return { n, capacity: sp.capacity, counts: sp.nests.map((r) => r.alive.size) }
    }
    expect(run()).toEqual({ n: 15, capacity: 15, counts: expect.any(Array) })
    const half = run(0.5)
    expect(half.n).toBe(5 + 2 + 1 + 1)
    expect(half.capacity).toBe(9)
    expect(run(0.1).n).toBe(1 + 1 + 1 + 1)
  })
})

// ---- the real jangan-fields export ----------------------------------------------------------------

describe.skipIf(!FIELDS || !JANGAN)('WORLD_EXPORT=jangan-fields on the real export', () => {
  let s: TestServer
  let nav: MeshNav
  const logs: string[] = []
  const dataDir = mkdtempSync(join(tmpdir(), 'sro-fields-db-'))
  /** Characters saved by a server on the default 'jangan' export before the fields server starts. */
  const saved: { name: string; token: string; id: number; pos: [number, number, number]; surface: string | null }[] = []
  let names = 0

  const fieldsConfig = { outDir: OUT, dataDir, serveStatic: false, moveSpeed: 30, tickHz: 10, rng: seeded(45), worldExport: 'jangan-fields' }

  beforeAll(async () => {
    // 1. the default 'jangan' export: two characters leave the world on the plaza (an object surface) and in the
    //    Grassland north of the gate (terrain)
    const j = await startTestServer({ config: { outDir: OUT, dataDir, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(44) } })
    try {
      expect(j.ctx.nav.kind).toBe('mesh')
      for (const [name, at] of [
        ['Plazakeeper', ['100.84', '-3.261', '-71.5']],
        ['Grasskeeper', ['-20', '60']],
      ] as const) {
        const acc = await newAccount(j.url, 'keep')
        j.ctx.store.setRole(j.ctx.store.accountByName(acc.username)!.id, 'gm')
        const c = await Client.login(j.url, acc.token)
        c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
        const ch = (await c.next('charCreated')).character
        c.send({ t: 'enterWorld', id: ch.id })
        const e = await c.next('worldEnter')
        expect(e.world.name).toBe('jangan')
        c.send({ t: 'gm', cmd: 'tp', args: [...at] })
        expect((await c.next('gmResult')).ok).toBe(true)
        c.send({ t: 'leaveWorld' })
        await c.next('worldLeft')
        const row = j.ctx.store.characterById(ch.id)!
        expect(row.world).toBe('jangan')
        saved.push({ name, token: acc.token, id: ch.id, pos: [row.x!, row.y!, row.z!], surface: row.nav_surface })
        c.close()
        await c.closed
      }
    } finally {
      await j.stopAndClean()
    }
    expect(saved[0].surface).toMatch(/^o:\d+:\d+$/)
    expect(saved[1].surface).toBe('t')

    // 2. the fields server on the same database
    s = await startTestServer({ logs, config: fieldsConfig })
    expect(s.ctx.nav.kind).toBe('mesh')
    nav = s.ctx.nav as MeshNav
  }, 120_000)

  afterAll(async () => {
    await s?.stopAndClean()
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function enter(opts: { gm?: boolean; prefix?: string } = {}) {
    const acc = await newAccount(s.url, opts.prefix ?? 'field')
    if (opts.gm !== false) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Fielder${++names}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const e = await c.next('worldEnter')
    await c.next('inventory')
    return { c, ch, e, token: acc.token, id: e.self.id, player: () => s.ctx.world.players.get(e.self.id)! }
  }

  const gm = async (c: Client, cmd: string, ...args: string[]) => {
    c.send({ t: 'gm', cmd, args })
    const r = await c.next('gmResult')
    expect(r.ok, r.message).toBe(true)
    return r
  }

  /** A position a walker may hold: on its surface, on open ground, in the town spawn's walkable component. */
  const onMesh = (p: NavPoint) => {
    expect(p.surface).toBeTruthy()
    expect(nav.heightOn(p.surface!, p.x, p.z)).toBeCloseTo(p.y, 3)
    if (p.surface!.kind === 'terrain') expect(nav.terrainOpen(p.x, p.z)).toBe(true)
  }

  it('loads 307 regions and 2,233 objects (X2: coast phase 2 drops 48 object navmeshes outside the bounds on moved ground), about 700 nests and 6,000 monsters, and logs the unreachable nests once', () => {
    // 2,233 retail objects (packages/convert/test/world-stream.test.ts pins them); kept World Editor adds and drops
    // change the total, which the server must load whole (the manifest's nav.instances)
    const navLine = logs.map((l) => /^navigation: .*jangan-fields.*nav\.bin \(307 regions, (\d+) objects/.exec(l)).find(Boolean)
    expect(navLine, logs.join('\n')).toBeTruthy()
    expect(Number(navLine![1])).toBe(FIELDS!.nav!.instances)
    const line = logs.find((l) => l.startsWith('world content:'))!
    const m = /world content: (\d+) NPCs, (\d+) nests \((\d+) skipped\), (\d+) monsters spawned/.exec(line)
    expect(m, line).not.toBeNull()
    const [npcs, nests, , monsters] = m!.slice(1).map(Number)
    expect(npcs).toBeGreaterThanOrEqual(41)
    // wave 11: UNIQUES=on (the default) gives Tiger Girl's 11 camps to the uniques module (Spawner refusal): 690 - 11
    expect(nests).toBeGreaterThanOrEqual(679)
    expect(monsters).toBeGreaterThan(5500)
    expect(s.ctx.world.mobs.size).toBeGreaterThan(5500)
    // the placement rule refuses the Western China nests across the river: one line, not one per nest
    const unplaced = logs.filter((l) => l.startsWith('nests not spawned:'))
    expect(unplaced).toHaveLength(1)
    const u = /(\d+) unreachable on foot from town \((\d+) monsters; regions (\d+)-(\d+) x (\d+)-(\d+)/.exec(unplaced[0])
    expect(u, unplaced[0]).not.toBeNull()
    const [count, mobs, x0, x1, z0, z1] = u!.slice(1).map(Number)
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(150)
    expect(mobs).toBeGreaterThan(0)
    expect([x0, x1, z0, z1].every((v, i) => (i < 2 ? v >= 155 && v <= 175 : v >= 89 && v <= 103))).toBe(true)
    expect(logs.some((l) => /listening on .*\(world jangan from export jangan-fields/.test(l))).toBe(true)
    // zones.json lists every region of the export: the 307 retail ones and, since P-DATA's re-export, the coast's 107
    // synthetic ones (named by their coast section)
    expect(logs.some((l) => /^content zones\.json: (307|414) regions/.test(l))).toBe(true)
    // every spawned monster stands on the town's walkable mesh
    let checked = 0
    for (const mob of s.ctx.world.mobs.values()) {
      if (checked++ % 50 !== 0) continue
      const pos = s.ctx.world.livePoint(mob, Date.now())
      expect(nav.place(pos.x, pos.z, pos.y, 3)).not.toBeNull()
    }
  })

  it('tells the client the export folder (servers list, welcome, worldEnter); the world id stays jangan', async () => {
    const list = await api(s.url, '/api/servers')
    expect(list.json).toEqual([{ id: 'jangan', name: 'Jangan', status: 'online', online: expect.any(Number), capacity: 50, world: 'jangan-fields', clock: expect.any(Object), weather: expect.any(Object) }])
    const acc = await newAccount(s.url, 'wel')
    const c = await Client.connect(s.url)
    c.send({ t: 'hello', version: PROTOCOL_VERSION, token: acc.token })
    // Client parses every frame with parseServerMessage: `world` survives the strict validator
    const w = await c.next('welcome')
    expect(w.server).toMatchObject({ id: 'jangan', name: 'Jangan', world: 'jangan-fields' })
    c.send({ t: 'charCreate', name: 'Welcomer', model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    expect(ch.location).toBe('Jangan')
    c.send({ t: 'enterWorld', id: ch.id })
    const e = await c.next('worldEnter')
    expect(e.world.name).toBe('jangan-fields')
    expect(e.self.pos[0]).toBeCloseTo(GATE_CH.x, 3)
    expect(e.self.pos[2]).toBeCloseTo(GATE_CH.z, 3)
    expect(e.self.pos[1]).toBeCloseTo(GATE_CH.y, 3)
    c.send({ t: 'leaveWorld' })
    await c.next('worldLeft')
    expect(s.ctx.store.characterById(ch.id)!.world).toBe('jangan')
    c.close()
    await c.closed
  })

  it('GM tp: named field places work, tp jangan lands at the town spawn, far coordinates clamp to the bounds', async () => {
    const a = await enter()
    const list = await gm(a.c, 'tp')
    const places = (list.data as { presets: { name: string }[] }).presets.map((p) => p.name)
    expect(places.slice(0, 2)).toEqual(['jangan', 'spawn'])
    expect(places).not.toContain('jangan-fields')
    for (const name of ['north-tiger-mt', 'grassland', 'south-tiger-mt', 'bandits-mountain-stronghold']) expect(places).toContain(name)

    const tiger = FIELDS!.places!.find((p) => p.name === 'north-tiger-mt')!
    const r = await gm(a.c, 'tp', 'north-tiger-mt')
    const pos = (r.data as { pos: [number, number, number] }).pos
    expect(Math.hypot(pos[0] - tiger.x, pos[2] - tiger.z)).toBeLessThan(5)
    onMesh(s.ctx.world.livePoint(a.player(), Date.now()))
    const where = await gm(a.c, 'where')
    expect(where.message).toMatch(/ in North-Tiger Mt\., region \d+x\d+/)
    // the tiger mountain is full of monsters in view
    await sleep(400)
    expect(a.player().known.size).toBeGreaterThan(5)

    const home = await gm(a.c, 'tp', 'jangan')
    const at = (home.data as { pos: [number, number, number] }).pos
    expect(at[0]).toBeCloseTo(GATE_CH.x, 3)
    expect(at[2]).toBeCloseTo(GATE_CH.z, 3)
    expect(at[1]).toBeCloseTo(GATE_CH.y, 3)
    expect(s.ctx.data.inSafeArea('jangan', at[0], at[2])).toBe(true)

    const far = await gm(a.c, 'tp', '-3000', '0')
    expect(far.message).toMatch(/clamped/)
    expect((far.data as { pos: number[] }).pos[0]).toBeGreaterThanOrEqual(-2304)
    a.c.close()
    await a.c.closed
  })

  it('death in the fields respawns at GATE_CH in town', async () => {
    const a = await enter()
    await gm(a.c, 'tp', 'grassland')
    const p = a.player()
    expect(s.ctx.data.inSafeArea('jangan', p.pos[0], p.pos[2])).toBe(false)
    s.ctx.gameplay.gmKill(p)
    await a.c.next('entityUpdate', (m) => m.id === a.id && m.state === 'dead')
    a.c.queue.length = 0 // the tp's own warp
    a.c.send({ t: 'respawn' })
    expect(await a.c.next('actionResult', (m) => m.re === 'respawn')).toMatchObject({ ok: true })
    const warp = await a.c.next('warp', (m) => m.id === a.id)
    expect(warp.pos[0]).toBeCloseTo(GATE_CH.x, 3)
    expect(warp.pos[2]).toBeCloseTo(GATE_CH.z, 3)
    expect(warp.pos[1]).toBeCloseTo(GATE_CH.y, 3)
    expect(s.ctx.data.inSafeArea('jangan', warp.pos[0], warp.pos[2])).toBe(true)
    a.c.close()
    await a.c.closed
  })

  it('characters saved on the jangan export load unchanged (same world id, same frame, same surfaces)', async () => {
    for (const k of saved) {
      const c = await Client.login(s.url, k.token)
      c.send({ t: 'charList' })
      const listed = (await c.next('charList')).characters.find((x) => x.id === k.id)!
      expect(listed.pos).toEqual(k.pos)
      expect(listed.location).toBe(k.name === 'Plazakeeper' ? 'Jangan' : 'Grassland')
      c.send({ t: 'enterWorld', id: k.id })
      const e = await c.next('worldEnter')
      for (let i = 0; i < 3; i++) expect(e.self.pos[i]).toBeCloseTo(k.pos[i], 3)
      const p = s.ctx.world.players.get(e.self.id)!
      expect(nav.surfaceKey(s.ctx.world.livePoint(p, Date.now()).surface)).toBe(k.surface)
      expect(logs.some((l) => l.includes(`${k.name}: saved position`))).toBe(false)
      c.close()
      await c.closed
    }
  })

  it('10 idle and 2 fighting clients for 10 s: mean tick < 10 ms', async () => {
    const idle = []
    for (let i = 0; i < 10; i++) idle.push(await enter({ gm: false, prefix: 'idle' }))
    const fighters = [await enter(), await enter()]
    for (const f of fighters) {
      await gm(f.c, 'setlevel', f.ch.name, '20')
      await gm(f.c, 'tp', 'grassland')
    }
    await sleep(500)

    const world = s.ctx.world
    const samples: number[] = []
    const timed = world.timedTick.bind(world)
    world.timedTick = (now: number) => {
      const ms = timed(now)
      samples.push(ms)
      return ms
    }
    let kills = 0
    const until = Date.now() + 10_000
    const fight = async (f: (typeof fighters)[number]) => {
      while (Date.now() < until) {
        const me = f.player()
        if (me.dead) {
          f.c.send({ t: 'respawn' })
          await f.c.next('warp', (m) => m.id === f.id).catch(() => null)
          await gm(f.c, 'tp', 'grassland')
          continue
        }
        const target = [...world.mobs.values()]
          .filter((m) => m.ai !== 'dead' && me.known.has(m.id))
          .sort((x, y) => world.distance(x, me, Date.now()) - world.distance(y, me, Date.now()))[0]
        if (!target) {
          await sleep(200)
          continue
        }
        f.c.send({ t: 'attack', target: target.id })
        const res = await f.c.next('actionResult', (m) => m.re === 'attack')
        if (!res.ok) {
          await sleep(100)
          continue
        }
        const hit = await f.c.next('combat', (m) => m.target === target.id && m.killed === true, Math.max(100, until - Date.now())).catch(() => null)
        if (hit) kills++
        f.c.queue.length = 0
      }
    }
    await Promise.all(fighters.map(fight))
    world.timedTick = timed
    for (const c of [...idle, ...fighters]) c.c.queue.length = 0

    const sorted = [...samples].sort((a, b) => a - b)
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]
    const max = sorted.at(-1)!
    console.log(`fields perf: ${samples.length} ticks, mean ${mean.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${max.toFixed(2)} ms, ${kills} kills, ${world.mobs.size} mobs, 12 players`)
    expect(samples.length).toBeGreaterThan(50)
    expect(kills).toBeGreaterThan(0)
    expect(mean).toBeLessThan(10)
    for (const c of [...idle, ...fighters]) c.c.close()
    await Promise.all([...idle, ...fighters].map((c) => c.c.closed))
  }, 60_000)

  it('switching back to the jangan export is safe: a character saved on Tiger Mountain enters at the edge of the town map', async () => {
    const a = await enter()
    await gm(a.c, 'tp', 'north-tiger-mt')
    a.c.send({ t: 'leaveWorld' })
    await a.c.next('worldLeft')
    a.c.close()
    await a.c.closed
    await s.close()
    const logs2: string[] = []
    const j = await startTestServer({ logs: logs2, config: { outDir: OUT, dataDir, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(47) } })
    try {
      const b = j.ctx.setup.bounds!
      expect(j.ctx.store.characterById(a.ch.id)!.x!).toBeLessThan(b.minX)
      // the session lives in the shared database
      const c2 = await Client.login(j.url, a.token)
      c2.send({ t: 'enterWorld', id: a.ch.id })
      const e = await c2.next('worldEnter')
      expect(e.world.name).toBe('jangan')
      expect(e.self.pos[0]).toBeGreaterThanOrEqual(b.minX)
      expect(e.self.pos[2]).toBeLessThanOrEqual(b.maxZ)
      const p = j.ctx.world.players.get(e.self.id)!
      expect(j.ctx.nav.kind).toBe('mesh')
      expect((j.ctx.nav as MeshNav).place(p.pos[0], p.pos[2], p.pos[1], 1)).not.toBeNull()
      c2.close()
      await c2.closed
    } finally {
      await j.stopAndClean()
    }
  })
})

// ---- the real jangan-near export (the cut-plan fallback) --------------------------------------------

describe.skipIf(!NEAR)('WORLD_EXPORT=jangan-near on the real export', () => {
  let s: TestServer
  const logs: string[] = []
  beforeAll(async () => {
    s = await startTestServer({ logs, config: { outDir: OUT, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(46), worldExport: 'jangan-near' } })
  }, 60_000)
  afterAll(async () => {
    await s?.stopAndClean()
  })

  it('loads 25 regions, spawns the near fields and serves the folder name', async () => {
    expect(s.ctx.nav.kind).toBe('mesh')
    expect(logs.some((l) => /^navigation: .*jangan-near.*nav\.bin \(25 regions, 715 objects/.test(l)), logs.join('\n')).toBe(true)
    const m = /world content: \d+ NPCs, (\d+) nests \(\d+ skipped\), (\d+) monsters spawned/.exec(logs.find((l) => l.startsWith('world content:'))!)!
    expect(Number(m[1])).toBeGreaterThanOrEqual(85)
    expect(Number(m[2])).toBeGreaterThan(1000)
    expect(s.ctx.setup.displayName).toBe('Jangan')
    expect(s.ctx.setup.places.map((p) => p.name)).toEqual(expect.arrayContaining(['jangan', 'spawn', 'grassland', 'swamp-area']))
    expect((await api(s.url, '/api/servers')).json[0]).toMatchObject({ id: 'jangan', world: 'jangan-near' })

    const acc = await newAccount(s.url, 'near')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: 'Neighbour', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const e: Msg<'worldEnter'> = await c.next('worldEnter')
    expect(e.world.name).toBe('jangan-near')
    expect(e.self.pos[0]).toBeCloseTo(GATE_CH.x, 3)
    c.send({ t: 'gm', cmd: 'tp', args: ['swamp-area'] })
    const r = await c.next('gmResult')
    expect(r.ok, r.message).toBe(true)
    c.send({ t: 'gm', cmd: 'tp', args: ['jangan'] })
    const home = await c.next('gmResult')
    expect((home.data as { pos: number[] }).pos[2]).toBeCloseTo(GATE_CH.z, 3)
    c.close()
    await c.closed
  })
})
