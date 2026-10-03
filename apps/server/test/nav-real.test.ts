/**
 * Server navigation on the REAL Jangan export (work/out: world/jangan/manifest.json + nav.bin, data/*.json), end to end
 * over WebSockets plus an in-process 5-minute simulation. Skipped without the export. Coordinates are glTF metres of
 * the world manifest frame (docs/NAVIGATION.md §8: plaza test point, fountain, south gate).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { MeshNav, type NavPoint } from '../src/nav.ts'
import type { Mob, Player } from '../src/world.ts'
import { seeded } from './fixtures.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const MANIFEST = join(OUT, 'world/jangan/manifest.json')
const manifest = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { nav?: { file?: string }; spawn?: { x: number; y: number; z: number } }) : null
const HAVE =
  manifest !== null &&
  typeof manifest.nav?.file === 'string' &&
  existsSync(join(OUT, 'world/jangan', manifest.nav.file)) &&
  ['data/mobs.json', 'data/nests.json', 'data/items.json', 'data/towns.json'].every((f) => existsSync(join(OUT, f)))

/** The lead's plaza test point (cj_jang_gate06 cell 85, -3.261 m; the terrain under it is -4.79 m). */
const PLAZA: [number, number] = [100.84, -71.5]
/** The fountain centre; its rim (blocked octagon) is about 10 m out. */
const FOUNTAIN: [number, number] = [97.9, -85.6]
const PLAZA_Y = -3.261
const SPEED = 30

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

describe.skipIf(!HAVE)('navigation on the real Jangan navmesh', () => {
  let s: TestServer
  let nav: MeshNav
  const logs: string[] = []
  let names = 0
  /** The server's rng; the simulation reseeds it (the real-time ticks of the earlier tests draw from it a load-dependent number of times). */
  let roll: () => number = seeded(7)

  beforeAll(async () => {
    s = await startTestServer({ logs, config: { outDir: OUT, serveStatic: false, moveSpeed: SPEED, tickHz: 20, rng: () => roll() } })
    expect(s.ctx.nav.kind).toBe('mesh')
    nav = s.ctx.nav as MeshNav
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  const modelOf = (p: { surface?: NavPoint['surface'] }) =>
    p.surface?.kind === 'object' ? nav.world.instanceInfo(p.surface.instance).model.split('/').pop()! : (p.surface?.kind ?? 'none')

  /** A position a walker may hold: an open terrain cell not inside a house, or inside its object cell; y on the surface. */
  function valid(p: NavPoint): string | null {
    if (!p.surface) return 'no surface'
    if (![p.x, p.y, p.z].every(Number.isFinite)) return 'not finite'
    const h = nav.heightOn(p.surface, p.x, p.z)
    if (Math.abs(h - p.y) > 1e-3) return `y ${p.y} is not the surface height ${h}`
    if (p.surface.kind === 'terrain') {
      if (!nav.terrainOpen(p.x, p.z)) return 'closed terrain cell'
      if (nav.insideSolid(p.x, p.z, p.y)) return 'inside a solid object'
      return null
    }
    if (nav.isSolid(p.surface.instance)) return `on solid ${modelOf(p)}`
    const settled = nav.g.settle(p.surface, p.x, p.z)
    if (!settled || Math.hypot(settled.x - p.x, settled.z - p.z) > 1e-6) return `outside its cell on ${modelOf(p)}`
    return null
  }

  async function enter(gm = true) {
    const acc = await newAccount(s.url, 'nav')
    if (gm) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Walker${++names}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const e = await c.next('worldEnter')
    await c.next('inventory')
    return { c, ch, e, id: e.self.id, player: () => s.ctx.world.players.get(e.self.id)! }
  }

  const gm = async (c: Client, cmd: string, ...args: string[]) => {
    c.send({ t: 'gm', cmd, args })
    const r = await c.next('gmResult')
    expect(r.ok, r.message).toBe(true)
    return r
  }

  /** moveTo, then the server's `move` for it and the `stop` at its end. */
  async function walk(c: Client, id: number, x: number, z: number): Promise<{ move: Msg<'move'>; stop: Msg<'stop'> }> {
    c.send({ t: 'moveTo', x, z })
    const move = await c.next('move', (m) => m.id === id)
    const stop = await c.next('stop', (m) => m.id === id, 10_000)
    return { move, stop }
  }

  it('loads the exported navmesh', () => {
    expect(logs.some((l) => /^navigation: .*nav\.bin \(9 regions, 547 objects/.test(l)), logs.join('\n')).toBe(true)
  })

  it('new characters and respawns land on the plaza (not the terrain under it), on open ground in the safe area', async () => {
    const a = await enter(false)
    const sp = manifest!.spawn!
    expect(a.e.self.pos[0]).toBeCloseTo(sp.x, 3)
    expect(a.e.self.pos[2]).toBeCloseTo(sp.z, 3)
    expect(a.e.self.pos[1]).toBeCloseTo(sp.y, 3)
    const p = a.player()
    expect(valid(s.ctx.world.livePoint(p, Date.now()))).toBeNull()
    expect(modelOf(p)).toBe('cj_jang_gate06.bms')
    expect(s.ctx.data.inSafeArea('jangan', p.pos[0], p.pos[2])).toBe(true)
    // die and respawn: back on the same surface
    s.ctx.gameplay.gmKill(p)
    await a.c.next('entityUpdate', (m) => m.id === a.id && m.state === 'dead')
    a.c.send({ t: 'respawn' })
    const warp = await a.c.next('warp', (m) => m.id === a.id)
    expect(warp.pos[1]).toBeCloseTo(sp.y, 3)
    expect(valid(s.ctx.world.livePoint(p, Date.now()))).toBeNull()
    expect(modelOf(p)).toBe('cj_jang_gate06.bms')
    expect(s.ctx.data.inSafeArea('jangan', warp.pos[0], warp.pos[2])).toBe(true)
    a.c.close()
  })

  it('walking into the fountain from the south stops at the rim, y = the plaza; a relog keeps the plaza', async () => {
    const a = await enter()
    const tp = await gm(a.c, 'tp', String(PLAZA[0]), String(PLAZA[1]))
    const warp = await a.c.next('warp', (m) => m.id === a.id)
    expect(warp.pos[1]).toBeCloseTo(PLAZA_Y, 2) // the plaza, not the terrain 1.5 m below
    expect(tp.data).toMatchObject({ pos: warp.pos })
    const { move, stop } = await walk(a.c, a.id, ...FOUNTAIN)
    expect(move.move.from[1]).toBeCloseTo(PLAZA_Y, 2)
    expect(move.move.to[1]).toBeCloseTo(PLAZA_Y, 1)
    const rim = Math.hypot(move.move.to[0] - FOUNTAIN[0], move.move.to[2] - FOUNTAIN[1])
    expect(rim).toBeGreaterThan(9)
    expect(rim).toBeLessThan(11)
    // NAVIGATION.md §8: stop at region-local (999.6, 757.3) = glTF (99.96, -75.73)
    expect(move.move.to[0]).toBeCloseTo(99.96, 1)
    expect(move.move.to[2]).toBeCloseTo(-75.73, 1)
    expect(stop.pos).toEqual(move.move.to)
    const p = a.player()
    expect(modelOf(p)).toBe('cj_jang_gate06.bms')
    expect(valid(s.ctx.world.livePoint(p, Date.now()))).toBeNull()

    // The hazard point (NAVIGATION verification): the terrain hides 6 cm under the paving. A plain tp picks the plaza,
    // and after a relog the saved surface (not a re-guess from y) keeps the walker out of the basin.
    await gm(a.c, 'tp', '92.2', '-71.7')
    const w2 = await a.c.next('warp', (m) => m.id === a.id)
    expect(modelOf(a.player())).toBe('cj_jang_gate06.bms')
    expect(w2.pos[1]).toBeCloseTo(PLAZA_Y, 2)
    a.c.send({ t: 'leaveWorld' })
    await a.c.next('worldLeft')
    const row = s.ctx.store.characterById(a.ch.id)!
    expect(row.nav_surface).toMatch(/^o:\d+:\d+$/)
    a.c.send({ t: 'enterWorld', id: a.ch.id })
    const again = await a.c.next('worldEnter')
    expect(again.self.pos[0]).toBeCloseTo(w2.pos[0], 6)
    expect(again.self.pos[1]).toBeCloseTo(w2.pos[1], 6)
    expect(again.self.pos[2]).toBeCloseTo(w2.pos[2], 6)
    const q = s.ctx.world.players.get(again.self.id)!
    expect(modelOf(q)).toBe('cj_jang_gate06.bms')
    const r = await walk(a.c, again.self.id, ...FOUNTAIN)
    expect(Math.hypot(r.move.move.to[0] - FOUNTAIN[0], r.move.move.to[2] - FOUNTAIN[1])).toBeGreaterThan(9)
    expect(r.move.move.to[1]).toBeCloseTo(PLAZA_Y, 1)
    a.c.close()
  })

  it('a legacy save inside the fountain basin (terrain) comes back on the plaza; a GM tp into the basin lands on the plaza', async () => {
    // Characters saved under the old terrain-only nav could stand on the basin floor (open terrain walled in by the
    // plaza rim). docs/NAVIGATION.md §11: placements must lie in the town spawn's walkable component.
    const a = await enter()
    a.c.send({ t: 'leaveWorld' })
    await a.c.next('worldLeft')
    const BASIN = { x: 91.98856, y: -5.43942, z: -88.56615 }
    s.ctx.store.saveCharacters([{ id: a.ch.id, ...BASIN, yaw: 0, world: 'jangan', lastPlayed: Date.now(), hp: 200, mp: 200, dead: false, surface: 't' }])
    a.c.send({ t: 'enterWorld', id: a.ch.id })
    const e = await a.c.next('worldEnter')
    const p = s.ctx.world.players.get(e.self.id)!
    expect(modelOf(p)).toBe('cj_jang_gate06.bms')
    expect(e.self.pos[1]).toBeCloseTo(PLAZA_Y, 2)
    expect(Math.hypot(e.self.pos[0] - BASIN.x, e.self.pos[2] - BASIN.z)).toBeLessThan(10.5)
    expect(valid(s.ctx.world.livePoint(p, Date.now()))).toBeNull()
    await gm(a.c, 'tp', String(BASIN.x), String(BASIN.z))
    const w = await a.c.next('warp', (m) => m.id === e.self.id)
    expect(w.pos[1]).toBeCloseTo(PLAZA_Y, 2)
    expect(modelOf(s.ctx.world.players.get(e.self.id)!)).toBe('cj_jang_gate06.bms')
    a.c.close()
  })

  it('the south gate: through the arches, stopped by the piers', async () => {
    const a = await enter()
    await gm(a.c, 'speed', '5')
    for (const x of [84, 98, 114]) {
      await gm(a.c, 'tp', String(x), '-10')
      await a.c.next('warp', (m) => m.id === a.id)
      const { move } = await walk(a.c, a.id, x, 60)
      expect(move.move.to[0]).toBeCloseTo(x, 3)
      expect(move.move.to[2]).toBeCloseTo(60, 3)
      expect(valid(s.ctx.world.livePoint(a.player(), Date.now()))).toBeNull()
    }
    for (const x of [90, 106]) {
      await gm(a.c, 'tp', String(x), '-10')
      const w = await a.c.next('warp', (m) => m.id === a.id)
      const { move, stop } = await walk(a.c, a.id, x, 60)
      expect(move.move.to[2]).toBeLessThan(10) // stopped at the pier, far short of z 60
      expect(move.move.to[2]).toBeGreaterThan(w.pos[2])
      expect(stop.pos).toEqual(move.move.to)
      expect(valid(s.ctx.world.livePoint(a.player(), Date.now()))).toBeNull()
    }
    a.c.close()
  })

  it('moves toward the world edge end on loaded, open ground', async () => {
    const a = await enter()
    await gm(a.c, 'speed', '5')
    const b = s.ctx.world.bounds!
    for (const [fx, fz, tx, tz] of [[b.maxX - 20, -300, 5000, -300], [b.maxX - 20, -300, b.maxX + 50, -340], [300, b.minZ + 20, 300, -5000]]) {
      await gm(a.c, 'tp', String(fx), String(fz))
      await a.c.next('warp', (m) => m.id === a.id)
      const { stop } = await walk(a.c, a.id, tx, tz)
      expect(valid(s.ctx.world.livePoint(a.player(), Date.now())), `${stop.pos}`).toBeNull()
      expect(stop.pos[0]).toBeLessThan(b.maxX)
      expect(stop.pos[2]).toBeGreaterThan(b.minZ)
    }
    a.c.close()
  })

  it('5 simulated minutes: every real nest (>= 120 Mangnyang) + 10 players; nobody stands in blocked cells; worst tick reported', () => {
    const { world, gameplay, store } = s.ctx
    world.stop() // drive the ticks by hand, with simulated time
    roll = seeded(7)
    const rng = seeded(99)
    const mang = [...world.mobs.values()].filter((m) => m.def.code === 'MOB_CH_MANGNYANG' && m.nest)
    expect(mang.length).toBe(gameplay.spawner.nests.filter((n) => n.mob.code === 'MOB_CH_MANGNYANG').reduce((n, x) => n + x.def.count, 0))
    expect(mang.length).toBeGreaterThanOrEqual(120)
    // every nest mob spawned on open ground inside its nest circle
    for (const m of mang) {
      expect(valid(world.livePoint(m, Date.now())), `mob ${m.id} at spawn`).toBeNull()
      expect(Math.hypot(m.pos[0] - m.nest!.x, m.pos[2] - m.nest!.z)).toBeLessThanOrEqual(Math.max(m.nest!.spawnRadius, m.nest!.radius) + 0.05)
    }
    // 10 players near the Mangnyang nests
    const nests = gameplay.spawner.nests.filter((n) => n.mob.code === 'MOB_CH_MANGNYANG')
    const players: Player[] = []
    for (let i = 0; i < 10; i++) {
      const nest = nests[i % nests.length]!.def
      const acc = store.createAccount(`sim${i}_${Date.now() % 100000}`, 'x')!
      const row = store.createCharacter(acc, `Sim${i}x${names++}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
      if (typeof row === 'string') throw new Error(row)
      gameplay.grantStarterKit(row.id, row.weapon, row.model, 'light')
      const at = nav.place(nest.x + 8, nest.z, nest.y ?? NaN, 20)!
      expect(at).not.toBeNull()
      players.push(world.add({
        ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon,
        pos: [at.x, at.y, at.z], surface: at.surface, yaw: 0, send: (m) => void JSON.stringify(m),
      }))
    }
    const t0 = Date.now()
    const TICK = 50
    const STEPS = (5 * 60 * 1000) / TICK
    let worst = 0
    let total = 0
    const times: number[] = []
    let checks = 0
    let moving = 0
    const problems: string[] = []
    for (let i = 1; i <= STEPS; i++) {
      const now = t0 + i * TICK
      // players: wander every ~4 s, attack the nearest Mangnyang they see every ~10 s, respawn when dead
      if (i % 20 === 0) {
        for (const p of players) {
          if (p.dead) {
            gameplay.request(p, { t: 'respawn' }, now)
            continue
          }
          const r = rng()
          if (r < 0.2) {
            const target = [...world.mobs.values()].filter((m) => m.ai !== 'dead' && p.known.has(m.id))
              .sort((a, b) => world.distance(a, p, now) - world.distance(b, p, now))[0]
            if (target) gameplay.request(p, { t: 'attack', target: target.id }, now)
          } else if (r < 0.45 && !p.action) {
            const q = world.positionAt(p, now)
            const a = rng() * 2 * Math.PI
            if (gameplay.onMoveTo(p)) world.moveTo(p, q[0] + Math.sin(a) * 30, q[2] + Math.cos(a) * 30, now)
          }
        }
      }
      const ms = world.timedTick(now)
      total += ms
      if (i > 20) {
        worst = Math.max(worst, ms)
        times.push(ms)
      }
      if (i % 20 === 0) {
        for (const m of world.mobs.values()) {
          if (m.ai === 'dead') continue
          const q = world.livePoint(m, now)
          const bad = valid(q)
          if (bad) problems.push(`t+${i * TICK / 1000}s mob ${m.id} (${m.ai}) at ${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}: ${bad}`)
          checks++
          if (m.move) moving++
        }
        for (const p of players) {
          const q = world.livePoint(p, now)
          const bad = valid(q)
          if (bad) problems.push(`t+${i * TICK / 1000}s player ${p.name} at ${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)}: ${bad}`)
        }
        for (const it of world.items.values()) {
          const l = nav.locate(it.pos[0], it.pos[2], it.pos[1])
          if (!l || Math.abs(l.y - it.pos[1]) > 1e-3) problems.push(`item ${it.code} off the ground at ${it.pos.join(',')}`)
        }
      }
    }
    // Every mob's walk ends on valid ground (clipped walks included).
    for (const m of world.mobs.values()) {
      if (m.ai === 'dead') continue
      if (m.path && m.move) {
        const end: NavPoint = { x: m.move.to[0], y: m.move.to[1], z: m.move.to[2], surface: m.path.end }
        const bad = valid(end)
        if (bad) problems.push(`mob ${m.id} walk end: ${bad}`)
      }
    }
    const nestMobs = [...world.mobs.values()].filter((m: Mob) => m.nest).length
    times.sort((a, b) => a - b)
    const p99 = times[Math.floor(times.length * 0.99)]!
    console.log(`nav sim: ${mang.length} Mangnyang + ${players.length} players, ${STEPS} ticks (5 simulated min): worst tick ` +
      `${worst.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, mean ${(total / STEPS).toFixed(3)} ms; ${checks} mob checks (${moving} mid-move), ` +
      `${world.items.size} ground items, ${nestMobs} nest mobs at the end; problems ${problems.length}`)
    expect(problems.slice(0, 10)).toEqual([])
    expect(moving).toBeGreaterThan(50)
    // Ticks must fit easily in the 50 ms (20 Hz) budget. The single worst tick is wall-clock time and picks up GC
    // pauses and CPU contention when the whole suite runs in parallel, so the gate is the 99th percentile.
    expect(p99).toBeLessThan(10)
    expect(worst).toBeLessThan(500)
    for (const p of players) world.remove(p.id)
    world.start()
  }, 240_000)
})
