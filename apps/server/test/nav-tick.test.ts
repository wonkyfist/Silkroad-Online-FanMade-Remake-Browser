/**
 * Navigation correctness must not depend on tick timing (the wave-4 fixer's lead: nav-real.test.ts's 5-minute
 * simulation once reported a player and a mob "inside a solid object" while the machine was loaded, worst tick 518 ms).
 *
 * Findings (SOAK): no move is integrated over dt. A move is a straight walker chord fixed when it starts (MeshNav.walk
 * legs), positions are read along those legs at any `now`, and every warp (respawn, leash reset, GM tp, return scroll)
 * goes through nav.place, so a long tick cannot step anything through a wall. The load only changed WHICH walks the
 * simulation made: the server's seeded rng is shared with the real-time ticker that runs during the earlier tests, so a
 * slower machine enters the simulation with a different random state. The failing walk itself was a walker quirk:
 * leaving a walkable object onto the terrain ignores other objects (docs/NAVIGATION.md §6.3), and on the Jangan
 * export a rock (oas_kara_obj02) reaches into a fence's footprint (w_earthgst_sfence) right in the Mangnyang field, so
 * a wandering mob stepped off the rock into the fence. MeshNav.walk now stops such a walk on the object (solidExit).
 *
 * Skipped without the export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { MeshNav, type NavPoint } from '../src/nav.ts'
import type { Player } from '../src/world.ts'
import { seeded } from './fixtures.ts'
import { startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const MANIFEST = join(OUT, 'world/jangan/manifest.json')
const manifest = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { nav?: { file?: string } }) : null
const HAVE =
  manifest !== null &&
  typeof manifest.nav?.file === 'string' &&
  existsSync(join(OUT, 'world/jangan', manifest.nav.file)) &&
  ['data/mobs.json', 'data/nests.json', 'data/items.json', 'data/towns.json'].every((f) => existsSync(join(OUT, f)))

/** The walk that failed: a Mangnyang wandering west over the rock into the fence (terrain -> rock cells -> terrain). */
const ROCK_WALK = { from: { x: 10.46144602787681, y: -4.39954042601671, z: 135.57032946811816 }, to: { x: -29.883567322028103, z: 174.8253684860567 } }

describe.skipIf(!HAVE)('navigation does not depend on tick timing (real Jangan navmesh)', () => {
  let nav: MeshNav

  /** Why a point may not be held (null: fine): open terrain outside every solid footprint, or a non-solid object cell. */
  function problem(p: NavPoint): string | null {
    if (!p.surface) return 'no surface'
    if (![p.x, p.y, p.z].every(Number.isFinite)) return 'not finite'
    if (Math.abs(nav.heightOn(p.surface, p.x, p.z) - p.y) > 1e-3) return 'off its surface'
    if (p.surface.kind === 'terrain') {
      if (!nav.terrainOpen(p.x, p.z)) return 'closed terrain cell'
      if (nav.insideSolid(p.x, p.z, p.y)) return 'inside a solid object'
      return null
    }
    if (nav.isSolid(p.surface.instance)) return 'on a solid object'
    const settled = nav.g.settle(p.surface, p.x, p.z)
    return settled && Math.hypot(settled.x - p.x, settled.z - p.z) <= 1e-6 ? null : 'outside its cell'
  }

  /** Every point of a walk's legs, 5 cm apart. */
  function along(legs: { x0: number; z0: number; x1: number; z1: number; surface: NavPoint['surface'] }[]): NavPoint[] {
    const out: NavPoint[] = []
    for (const l of legs) {
      const n = Math.max(1, Math.ceil(Math.hypot(l.x1 - l.x0, l.z1 - l.z0) / 0.05))
      for (let k = 0; k <= n; k++) {
        const x = l.x0 + ((l.x1 - l.x0) * k) / n
        const z = l.z0 + ((l.z1 - l.z0) * k) / n
        out.push({ x, y: nav.heightOn(l.surface, x, z), z, surface: l.surface })
      }
    }
    return out
  }

  beforeAll(() => {
    const loaded = MeshNav.load([OUT], 'jangan')
    if (!loaded.nav) throw new Error(loaded.problem)
    nav = loaded.nav
  })

  it('a walk that leaves the rock into the fence footprint stops on the rock, blocked (it used to cross the fence)', () => {
    const from = nav.locate(ROCK_WALK.from.x, ROCK_WALK.from.z, ROCK_WALK.from.y)!
    expect(from.surface?.kind).toBe('terrain')
    // the data quirk: the unguarded walker's chord exits the rock inside the fence
    const raw = nav.g.moveStraight({ ...from, surface: from.surface! }, ROCK_WALK.to.x, ROCK_WALK.to.z)
    expect(along(raw.legs).some((p) => problem(p) === 'inside a solid object')).toBe(true)
    const w = nav.walk(from, ROCK_WALK.to.x, ROCK_WALK.to.z)!
    expect(w.blocked).toBe(true)
    expect(w.end.surface).toMatchObject({ kind: 'object' })
    expect(nav.world.instanceInfo((w.end.surface as { instance: number }).instance).model).toMatch(/oas_kara_obj02\.bms$/)
    expect(problem(w.end)).toBeNull()
    expect(along(w.legs).map(problem).filter(Boolean)).toEqual([])
    expect(w.legs.at(-1)).toMatchObject({ x1: w.end.x, z1: w.end.z })
  })

  it('no walk around the Mangnyang field ever exits an object into a solid (3000 seeded walks)', () => {
    const rng = seeded(11)
    let exits = 0
    const bad: string[] = []
    for (let i = 0; i < 3000; i++) {
      const from = nav.place(-25 + (rng() * 2 - 1) * 40, 170 + (rng() * 2 - 1) * 40, NaN, 5)
      if (!from) continue
      const a = rng() * 2 * Math.PI
      const d = 5 + rng() * 50
      const w = nav.walk(from, from.x + Math.sin(a) * d, from.z + Math.cos(a) * d)
      if (!w) continue
      exits += w.legs.filter((l, k) => k > 0 && l.surface.kind === 'terrain' && w.legs[k - 1]!.surface.kind === 'object').length
      const p = along(w.legs).find((q) => problem(q) !== null)
      if (p) bad.push(`walk ${i} from ${from.x.toFixed(2)},${from.z.toFixed(2)}: ${problem(p)} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`)
      if (problem(w.end)) bad.push(`walk ${i} ends ${problem(w.end)}`)
    }
    expect(exits).toBeGreaterThan(20) // the walks do cross the rocks
    expect(bad.slice(0, 10)).toEqual([])
  })

  // I7B: nav-real's simulation still failed now and then ("mob 143 inside a solid object" after 175 simulated s). The
  // remaining cause: a walk whose target lies just past the rock's edge ends on the terrain inside the fence WITHOUT a
  // terrain leg (the last leg is still the rock's), so solidExit, which looked only at terrain legs, let it through.
  // Found with seeded walk chains (work/tmp/i7b/walk-fuzz.ts seed 1: 1 bad walk in 60,000; 0 in 1.2 million after).
  const END_EXIT = { from: { x: -24.768297123798405, y: -5.426034072914204, z: 171.49775360841306 }, to: { x: -25.551431074740275, z: 170.73013630235297 } }

  it('a walk whose END steps off the rock into the fence stops on the rock (no terrain leg after the rock)', () => {
    const from: NavPoint = { ...END_EXIT.from, surface: { kind: 'terrain' } }
    const raw = nav.g.moveStraight({ ...from, surface: from.surface! }, END_EXIT.to.x, END_EXIT.to.z)
    expect(raw.legs.at(-1)?.surface.kind).toBe('object')
    expect(raw.end.surface?.kind).toBe('terrain')
    expect(problem({ ...raw.end, surface: raw.end.surface ?? null })).toBe('inside a solid object')
    const w = nav.walk(from, END_EXIT.to.x, END_EXIT.to.z)!
    expect(w.blocked).toBe(true)
    expect(nav.world.instanceInfo((w.end.surface as { instance: number }).instance).model).toMatch(/oas_kara_obj02\.bms$/)
    expect(problem(w.end)).toBeNull()
    expect(along(w.legs).map(problem).filter(Boolean)).toEqual([])
    expect(w.legs.at(-1)).toMatchObject({ x1: w.end.x, z1: w.end.z })
  })

  it('mob-like walk chains (re-targeted part-way) around every nest never end or pass inside a solid (8000 seeded walks)', () => {
    const rng = seeded(1)
    const nests = (JSON.parse(readFileSync(join(OUT, 'data/nests.json'), 'utf8')) as { entries: { x: number; z: number; y?: number; radius: number }[] }).entries
      .filter((n) => nav.place(n.x, n.z, n.y ?? NaN, 10) !== null)
    expect(nests.length).toBeGreaterThan(5)
    const bad: string[] = []
    let walks = 0
    for (let c = 0; c < 200 && walks < 8000; c++) {
      const nest = nests[Math.floor(rng() * nests.length)]!
      let at = nav.place(nest.x + (rng() * 2 - 1) * nest.radius, nest.z + (rng() * 2 - 1) * nest.radius, nest.y ?? NaN, 10)
      for (let s = 0; s < 40 && at; s++) {
        const a = rng() * 2 * Math.PI
        const d = 1 + rng() * 40
        const w = nav.walk(at, at.x + Math.sin(a) * d, at.z + Math.cos(a) * d)
        walks++
        if (!w) break
        const p = along(w.legs).find((q) => problem(q) !== null)
        if (p) bad.push(`chain ${c} step ${s}: ${problem(p)} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`)
        if (problem(w.end)) bad.push(`chain ${c} step ${s}: ends ${problem(w.end)}`)
        const len = w.legs.reduce((n, l) => n + Math.hypot(l.x1 - l.x0, l.z1 - l.z0), 0)
        const f = rng() < 0.5 ? 1 : rng()
        at = f >= 1 || !w.legs.length ? w.end : (along(w.legs)[Math.floor(f * (len / 0.05))] ?? w.end)
      }
    }
    expect(walks).toBeGreaterThan(4000)
    expect(bad.slice(0, 10)).toEqual([])
  })

  describe('on a real server', () => {
    let s: TestServer
    let roll: () => number = seeded(3)

    beforeAll(async () => {
      s = await startTestServer({ config: { outDir: OUT, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: () => roll() } })
      s.ctx.world.stop() // every tick below is driven by hand with simulated time
      expect(s.ctx.nav.kind).toBe('mesh')
    })
    afterAll(async () => {
      await s?.stopAndClean()
    })

    function addPlayers(n: number, name: string): Player[] {
      const { world, gameplay, store } = s.ctx
      const nests = gameplay.spawner.nests.filter((x) => x.mob.code === 'MOB_CH_MANGNYANG')
      const players: Player[] = []
      for (let i = 0; i < n; i++) {
        const nest = nests[i % nests.length]!.def
        const acc = store.createAccount(`${name}${i}`, 'x')!
        const row = store.createCharacter(acc, `${name}${i}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
        if (typeof row === 'string') throw new Error(row)
        gameplay.grantStarterKit(row.id, row.weapon, row.model, 'light')
        const at = (s.ctx.nav as MeshNav).place(nest.x + 8, nest.z, nest.y ?? NaN, 20)!
        players.push(world.add({
          ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon,
          pos: [at.x, at.y, at.z], surface: at.surface, yaw: 0, send: () => {},
        }))
      }
      return players
    }

    it('a player walk ends in the same place with 50 ms and 500 ms ticks (positions come from the move, not from dt)', () => {
      const { world } = s.ctx
      const [p] = addPlayers(1, 'Tick')
      const home = world.livePoint(p!, Date.now())
      const orders = [[40, 30], [-35, 55], [10, -60], [70, 5]].map(([dx, dz], k) => ({ at: k * 3000, x: home.x + dx!, z: home.z + dz! }))
      const run = (tick: number) => {
        world.warp(p!, home.x, home.y, home.z, Date.now(), home)
        const t0 = Date.now() + 1000
        const seen: string[] = []
        for (let t = 0; t <= 16_000; t += tick) {
          for (const o of orders) if (o.at > t - tick && o.at <= t) world.moveTo(p!, o.x, o.z, t0 + o.at)
          world.timedTick(t0 + t)
          if (t % 1000 === 0) {
            const q = world.livePoint(p!, t0 + t)
            expect(problem(q), `t ${t} with ${tick} ms ticks`).toBeNull()
            seen.push(`${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)}`)
          }
        }
        return seen
      }
      const fine = run(50)
      expect(run(500)).toEqual(fine)
      expect(run(1000)).toEqual(fine)
      world.remove(p!.id)
    })

    it('10 simulated minutes of 500 ms ticks: every nest + 10 players; nobody ever stands in a blocked cell or a solid', () => {
      const { world, gameplay } = s.ctx
      roll = seeded(2) // the same walks every run, whatever ran before
      const players = addPlayers(10, 'Slow')
      const rng = seeded(3)
      const TICK = 500
      const t0 = Date.now()
      const problems: string[] = []
      let checks = 0
      let moving = 0
      for (let i = 1; i <= (10 * 60 * 1000) / TICK; i++) {
        const now = t0 + i * TICK
        if (i % 2 === 0) {
          for (const p of players) {
            if (p.dead) {
              gameplay.request(p, { t: 'respawn' }, now)
              continue
            }
            const r = rng()
            if (r < 0.25) {
              const target = [...world.mobs.values()].filter((m) => m.ai !== 'dead' && p.known.has(m.id))
                .sort((a, b) => world.distance(a, p, now) - world.distance(b, p, now))[0]
              if (target) gameplay.request(p, { t: 'attack', target: target.id }, now)
            } else if (r < 0.5 && !p.action) {
              const q = world.positionAt(p, now)
              const a = rng() * 2 * Math.PI
              if (gameplay.onMoveTo(p, now)) world.moveTo(p, q[0] + Math.sin(a) * 30, q[2] + Math.cos(a) * 30, now)
            }
          }
        }
        world.timedTick(now)
        // every tick, every entity: with 500 ms ticks a walker covers up to 15 m between two of them
        for (const e of [...world.mobs.values(), ...players]) {
          if (e.kind === 'mob' && e.ai === 'dead') continue
          const q = world.livePoint(e, now)
          const bad = problem(q)
          checks++
          if (e.move) moving++
          if (bad && problems.length < 10) problems.push(`t+${(i * TICK) / 1000}s ${e.kind} ${e.id} at ${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}: ${bad}`)
        }
      }
      expect(problems).toEqual([])
      expect(checks).toBeGreaterThan(100_000)
      expect(moving).toBeGreaterThan(1000)
      for (const p of players) world.remove(p.id)
    }, 120_000)
  })
})
