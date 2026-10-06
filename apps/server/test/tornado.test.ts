/**
 * The lightning tornado (docs/WEATHER.md §13): the shared maths (timeline, pull, throw arc and damage, the per-storm
 * roll), the path planner on synthetic worlds (towns, water, bounds, dead ends), and the module on a Gameplay with a
 * walled flat navmesh: natural and GM spawns, the pull (a walker at the edge escapes, a body by the core is drawn in),
 * the throw (a valid landing on the navmesh: never through the wall, never into water, a town or out of the world), the
 * loss of control, the never-a-kill cap, its telegraphed non-lethal bolts, the immunities, and the protocol messages
 * every client would accept.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIFT_MS,
  TORNADO_TABLE,
  parseServerMessage,
  pathLength,
  pullVelocity,
  throwArc,
  throwDamage,
  tornadoAt,
  tornadoPhase,
  tornadoRoll,
  type ServerMessage,
  type TornadoState,
  type TownDef,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav, type NavPoint, type NavWalk } from '../src/nav.ts'
import { goodLeg, goodPoint, pickStart, planPath, rectDist, type PathWorld } from '../src/storm/tornado-path.ts'
import { WaterIndex } from '../src/storm/water.ts'
import { World, type Mob } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, mob, seeded } from './fixtures.ts'
import { testConfig } from './helpers.ts'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)
const T = TORNADO_TABLE
/** A throw reaching this share of its distance is taken at once (storm/tornado.ts FAR_ENOUGH). */
const FAR = 0.75

// ---- the shared maths ----------------------------------------------------------------------------------------

describe('tornado maths (packages/shared tornado.ts)', () => {
  const state = (over: Partial<TornadoState> = {}): TornadoState => ({
    id: 1,
    seed: 1,
    warnAt: T0,
    touchAt: T0 + 20_000,
    endAt: T0 + 80_000,
    path: [
      [0, 0, 0],
      [100, 0, 0],
      [100, 0, 100],
    ],
    speedMs: 2,
    pullM: 30,
    coreM: 5,
    strength: 1,
    ...over,
  })

  it('walks its path from touchdown at its speed, lowers during the warning, rises after the lift, then is gone', () => {
    const s = state()
    expect(tornadoAt(s, T0)).toMatchObject({ pos: [0, 0, 0], phase: 'warning', presence: 0 })
    expect(tornadoAt(s, T0 + 10_000).presence).toBeCloseTo(0.5, 9)
    expect(tornadoAt(s, T0 + 30_000)).toMatchObject({ pos: [20, 0, 0], phase: 'active', presence: 1 })
    expect(tornadoAt(s, T0 + 80_000).pos).toEqual([100, 0, 20])
    expect(tornadoAt(s, T0 + 80_000 + LIFT_MS / 2)).toMatchObject({ phase: 'lifting', presence: 0.5, pos: [100, 0, 20] })
    expect(tornadoPhase(s, T0 + 80_000 + LIFT_MS)).toBe('gone')
    // an early lift stops it where it was
    const l = state({ liftAt: T0 + 40_000 })
    expect(tornadoAt(l, T0 + 42_000)).toMatchObject({ pos: [40, 0, 0], phase: 'lifting' })
    expect(pathLength(s.path)).toBe(200)
  })

  it('pulls nothing outside its radius, slowly at the edge, faster than a run by the core, with a swirl', () => {
    expect(pullVelocity(T.pullM + 1, 0, 1)).toEqual([0, 0])
    expect(pullVelocity(10, 0, 0)).toEqual([0, 0])
    const edge = Math.hypot(...pullVelocity(T.pullM - 1, 0, 1))
    const core = Math.hypot(...pullVelocity(4, 0, 1))
    expect(edge).toBeLessThan(1.2)
    expect(core).toBeGreaterThan(5.5)
    const [vx, vz] = pullVelocity(20, 0, 1)
    expect(vx).toBeLessThan(0) // toward the funnel ...
    expect(Math.abs(vz)).toBeGreaterThan(0.1) // ... and around it
    expect(Math.hypot(...pullVelocity(20, 0, 2))).toBeCloseTo(2 * Math.hypot(vx, vz), 9)
  })

  it('throw damage: a share of max HP, capped per throw and per tornado, scaled by the strength; lethal or not', () => {
    expect(throwDamage(1000, 1000, 1)).toBe(220)
    expect(throwDamage(1000, 1000, 1.5)).toBe(330)
    expect(throwDamage(1000, 1000, 5)).toBe(350) // the per-throw cap
    expect(throwDamage(1000, 1000, 1, T, { taken: 440 })).toBe(110) // what is left of the 55 % per tornado
    expect(throwDamage(1000, 1000, 1, T, { taken: 550 })).toBe(0)
    expect(throwDamage(1000, 1000, 0)).toBe(0)
    // not lethal: never down to 0 HP
    expect(throwDamage(50, 1000, 1)).toBe(49)
    expect(throwDamage(1, 1000, 1)).toBe(0)
    for (let hp = 1; hp < 300; hp += 7) expect(hp - throwDamage(hp, 1000, 2)).toBeGreaterThanOrEqual(1)
    // lethal: takes the last HP of a body already low, but a healthy one survives a whole tornado
    expect(throwDamage(50, 1000, 1, T, { lethal: true })).toBe(50)
    let hp = 1000
    let taken = 0
    for (let i = 0; i < 10; i++) {
      const d = throwDamage(hp, 1000, 2, T, { taken, lethal: true })
      hp -= d
      taken += d
    }
    expect(hp).toBe(1000 - Math.round(1000 * T.damageTotalPct))
  })

  it('the arc rises to its apex at mid-flight and lands on the line', () => {
    expect(throwArc(0, 8)).toBe(0)
    expect(throwArc(0.5, 8)).toBe(8)
    expect(throwArc(1, 8)).toBe(0)
    expect(throwArc(0.25, 8)).toBeCloseTo(6, 9)
  })

  it('rolls once per storm (seeded), about `chance` of them, at a share of the storm within stormFrac', () => {
    expect(tornadoRoll(42, 0.3)).toEqual(tornadoRoll(42, 0.3))
    let n = 0
    for (let s = 0; s < 2000; s++) {
      const r = tornadoRoll(s * 7919, 0.3)
      if (r.spawn) n++
      expect(r.frac).toBeGreaterThanOrEqual(T.stormFrac[0])
      expect(r.frac).toBeLessThanOrEqual(T.stormFrac[1])
    }
    expect(n / 2000).toBeGreaterThan(0.25)
    expect(n / 2000).toBeLessThan(0.35)
    expect(tornadoRoll(5, 0).spawn).toBe(false)
    expect(tornadoRoll(5, 1).spawn).toBe(true)
  })
})

// ---- the path ---------------------------------------------------------------------------------------------------

const TOWN_RECT = { x: -300, z: -300, halfX: 50, halfZ: 50 }

/** A flat world 1 km wide with a town in its south-west, a lake in the east and a cliff (closed ground) in the north. */
function fieldWorld(): PathWorld {
  return {
    ground: (x, z) => ((x - 300) ** 2 + z ** 2 < 80 ** 2 ? null : z < -420 ? null : 0),
    townDist: (x, z) => rectDist(x, z, TOWN_RECT),
    bounds: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 },
  }
}

describe('tornado path (storm/tornado-path.ts)', () => {
  it('every point of every leg is open ground, away from the town, off the lake, inside the bounds', () => {
    const w = fieldWorld()
    for (let seed = 1; seed <= 40; seed++) {
      const rng = seeded(seed)
      const start = pickStart(w, { x: -150, z: -150 }, rng)
      expect(start).not.toBeNull()
      const path = planPath(w, start!, 700, rng)
      expect(path.length).toBeGreaterThan(3)
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!
        const b = path[i]!
        for (let f = 0; f <= 1; f += 0.05) {
          const x = a[0] + (b[0] - a[0]) * f
          const z = a[2] + (b[2] - a[2]) * f
          expect(rectDist(x, z, TOWN_RECT)).toBeGreaterThanOrEqual(T.townMarginM - 1)
          expect((x - 300) ** 2 + z ** 2).toBeGreaterThan(78 ** 2)
          expect(Math.abs(x)).toBeLessThanOrEqual(500 - T.edgeMarginM + 0.01)
          expect(Math.abs(z)).toBeLessThanOrEqual(500 - T.edgeMarginM + 0.01)
          expect(z).toBeGreaterThan(-421)
        }
      }
    }
  })

  it('goodPoint / goodLeg refuse the town margin, the bounds and closed ground', () => {
    const w = fieldWorld()
    expect(goodPoint(w, 0, 0)).toBe(0)
    expect(goodPoint(w, -300, -300)).toBeNull()
    expect(goodPoint(w, -300, -300 + 50 + T.townMarginM - 1)).toBeNull()
    expect(goodPoint(w, 490, 0)).toBeNull()
    expect(goodPoint(w, 300, 0)).toBeNull()
    expect(goodLeg(w, 100, 0, 250, 0)).toBeNull() // runs into the lake
    expect(goodLeg(w, 0, 0, 40, 0)).toBe(0)
  })

  it('ends early in a dead end; no start at all where nothing is open', () => {
    const box: PathWorld = { ground: (x, z) => (Math.abs(x) < 20 && Math.abs(z) < 20 ? 0 : null), townDist: () => Infinity, bounds: null }
    const path = planPath(box, { pos: [0, 0, 0], heading: 0 }, 500, seeded(3))
    expect(path).toEqual([[0, 0, 0]])
    const none: PathWorld = { ground: () => null, townDist: () => Infinity, bounds: null }
    expect(pickStart(none, { x: 0, z: 0 }, seeded(1))).toBeNull()
  })
})

// ---- the module on a Gameplay -------------------------------------------------------------------------------

/** A flat navmesh with a wall along x = 60 (z -40..40): a walk across it stops just short of it. */
class WallNav extends FlatNav {
  static readonly WALL_X = 60
  override walk(from: NavPoint, x: number, z: number): NavWalk | null {
    const w = super.walk(from, x, z)
    if (!w) return null
    const X = WallNav.WALL_X
    if ((from.x - X) * (x - X) < 0) {
      const f = (X - from.x) / (x - from.x)
      const cz = from.z + (z - from.z) * f
      if (Math.abs(cz) <= 40) {
        const g = Math.max(0, f - 0.3 / Math.max(1e-6, Math.abs(x - from.x)))
        return { end: { x: from.x + (x - from.x) * g, y: from.y, z: from.z + (z - from.z) * g, surface: null }, blocked: true, legs: [] }
      }
    }
    return w
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const GIRL = mob('MOB_CH_TIGERWOMAN', { name: 'Tiger Girl', level: 20, hp: 50_000, rarity: 'unique', aggressive: false })
const WOLF = mob('MOB_CH_WOLF', { name: 'Wolf', level: 9, hp: 1000 })
const TOWN: TownDef = { code: 'TOWN', name: 'Town', world: 'jangan', spawn: { x: -300, y: 0, z: -300 }, safeArea: { ...TOWN_RECT } }

function harness(over: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-tornado-'))
  const logs: string[] = []
  const config = { ...testConfig(root, logs), rng: seeded(9), uniques: false, weather: 'auto' as const, spawnMobs: false, ...over }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new WallNav(bounds)
  const world = new World('jangan', 5.5, 20, bounds, nav)
  const data = new GameData({ mobs: [MANGNYANG, GIRL, WOLF], items: ITEMS, levels: LEVELS, drops: DROPS, nests: [], towns: [TOWN] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const g = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(9) })
  const tor = g.tornado
  // a pond (water plane 1 m over the ground) in the block x 0..32, z -32..0
  const blocks = Array.from({ length: 36 }, (_, i) => ({ water: i === 0 ? { heightM: 1 } : null }))
  tor.setWater(new WaterIndex({ regions: [{ origin: [0, 0, 0], blocks }] }))
  let n = 0
  const all: ServerMessage[] = []
  const enter = (pos: Vec3) => {
    const acc = store.createAccount(`acc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const inbox: ServerMessage[] = []
    const send = (m: ServerMessage) => {
      const r = parseServerMessage(JSON.stringify(m))
      if (!r.ok) throw new Error(`the client would reject ${JSON.stringify(m)}: ${r.error}`)
      inbox.push(m)
      all.push(m)
    }
    const p = world.add({ ...g.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 30, weapon: row.weapon, pos, yaw: 0, send })
    world.updateInterest(T0)
    p.hp = p.maxHp = 10_000
    return { p, inbox }
  }
  const spawn = (def: typeof WOLF, x: number, z: number, variant: Mob['variant'] = 'normal') => g.createMob(def, variant, x, z, 0, null, T0)
  /** A tornado standing still at (x, z), touched down at T0 (a one-point path). */
  const place = (x: number, z: number, over: Partial<TornadoState> = {}) => {
    const s = tor.spawn({ x: 0, z: 150 }, T0 - T.warnMs, { dist: 0, gm: true, lifeMs: 120_000 })
    if (!s) throw new Error('no tornado')
    Object.assign(s, { path: [[x, 0, z]], speedMs: 0, endAt: T0 + 120_000 }, over)
    return s
  }
  const run = (from: number, to: number, step = 50) => {
    for (let t = from; t <= to; t += step) {
      g.now = t
      world.tick(t)
    }
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { g, tor, world, data, nav, enter, spawn, place, run, all, logs }
}

const dist2 = (a: Vec3, x: number, z: number) => Math.hypot(a[0] - x, a[2] - z)

describe('the tornado module (storm/tornado.ts)', () => {
  it('GM: storm tornado near a player is announced to everyone, its path keeps off the town; stop lifts it, then it ends', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    const b = h.enter([200, 0, 200])
    const r = h.g.storm.gm(['tornado'], T0, a.p)
    expect(r.ok).toBe(true)
    const s = h.tor.current!
    const p0 = s.path[0]!
    expect(dist2([0, 0, 0], p0[0], p0[2])).toBeGreaterThanOrEqual(T.spawnM[0] - 0.01)
    expect(dist2([0, 0, 0], p0[0], p0[2])).toBeLessThanOrEqual(T.spawnM[1] + 0.01)
    for (const q of s.path) expect(rectDist(q[0], q[2], TOWN_RECT)).toBeGreaterThanOrEqual(T.townMarginM)
    expect(s.touchAt - s.warnAt).toBe(T.warnMs)
    for (const x of [a, b]) expect(x.inbox.some((m) => m.t === 'tornado' && m.tornado.id === s.id)).toBe(true)
    expect(h.g.storm.gm(['tornado'], T0, a.p).ok).toBe(false) // one at a time
    // a player entering meanwhile hears of it
    const c = h.enter([10, 0, 10])
    h.tor.enter(c.p)
    expect(c.inbox.some((m) => m.t === 'tornado')).toBe(true)
    expect(h.g.storm.gm(['tornado', 'stop'], T0 + 30_000, a.p).ok).toBe(true)
    expect(h.tor.current!.liftAt).toBe(T0 + 30_000)
    h.tor.tick(T0 + 30_000 + LIFT_MS + 1)
    expect(h.tor.current).toBeNull()
    expect(a.inbox.some((m) => m.t === 'tornadoEnd' && m.id === s.id)).toBe(true)
  })

  it('GM: refuses in a town, with nobody, and with the weather off', () => {
    const h = harness()
    const inTown = h.enter([-300, 0, -300])
    expect(h.g.storm.gm(['tornado', 'here'], T0, inTown.p).ok).toBe(false)
    expect(h.g.storm.gm(['tornado', 'Nobody'], T0, inTown.p).ok).toBe(false)
    const off = harness({ weather: 'off' })
    const p = off.enter([0, 0, 0])
    expect(off.g.storm.gm(['tornado'], T0, p.p).ok).toBe(false)
  })

  it('natural: once per storm event with the chance, near a player out in the fields; lifts when the storm ends', () => {
    const h = harness({ tornadoChance: 1 })
    h.enter([0, 0, 0])
    const ev = h.g.storm.plan.startGm(T0, 20 * 60_000, 0, 77)
    const due = Math.ceil(ev.start + tornadoRoll(ev.seed, 1).frac * (ev.end - ev.start))
    h.tor.tick(due - 1000)
    expect(h.tor.current).toBeNull()
    h.tor.tick(due + 10)
    const s = h.tor.current!
    expect(s).not.toBeNull()
    expect(s.gm).toBeUndefined()
    expect(h.logs.some((l) => /tornado 1: warning/.test(l))).toBe(true)
    h.g.storm.plan.stop(due + 60_000)
    h.tor.tick(due + 60_001)
    expect(h.tor.current!.liftAt).toBe(due + 60_001)
    // that storm never brings a second one
    h.tor.tick(due + 60_001 + LIFT_MS)
    h.tor.tick(due + 70_000)
    expect(h.tor.current).toBeNull()
    const none = harness({ tornadoChance: 0 })
    none.enter([0, 0, 0])
    const e2 = none.g.storm.plan.startGm(T0, 20 * 60_000, 0, 77)
    for (let t = e2.start; t < e2.end; t += 5000) none.tor.tick(t)
    expect(none.tor.current).toBeNull()
  })

  it('pull: a body standing near the core is drawn in (sliding), a walker at the edge runs out of it', () => {
    const h = harness()
    const near = h.enter([-180, 0, 116])
    const edgeZ = 100 + T.pullM - 2
    const edge = h.enter([-180, 0, edgeZ])
    h.place(-180, 100)
    h.world.moveTo(edge.p, -180, 300, T0)
    const d0 = dist2(h.world.positionAt(near.p, T0), -180, 100)
    h.tor.tick(T0)
    h.tor.tick(T0 + 500)
    h.tor.tick(T0 + 1000)
    const t1 = T0 + 1000
    expect(dist2(h.world.positionAt(near.p, t1), -180, 100)).toBeLessThan(d0 - 1)
    expect(near.inbox.some((m) => m.t === 'displace' && m.kind === 'pull' && m.id === near.p.id)).toBe(true)
    // the walker keeps walking away (more slowly than alone) and leaves the pull
    for (let t = T0 + 1500; t <= T0 + 8000; t += 500) h.tor.tick(t)
    const e = h.world.positionAt(edge.p, T0 + 8000)
    expect(dist2(e, -180, 100)).toBeGreaterThan(T.pullM)
    expect(e[2]).toBeLessThan(edgeZ + 5.5 * 8) // slowed by the pull
    expect(edge.inbox.some((m) => m.t === 'displace' && m.id === edge.p.id)).toBe(false) // it walked: a plain move
  })

  it('throw: a body in the core flies far out along the navmesh, lands on open ground, is hurt, and has no control meanwhile', () => {
    const h = harness()
    const v = h.enter([-180, 0, 102])
    h.place(-180, 100)
    h.tor.tick(T0)
    const msg = v.inbox.find((m): m is Extract<ServerMessage, { t: 'displace' }> => m.t === 'displace' && m.kind === 'throw')!
    expect(msg).toBeDefined()
    const flown = Math.hypot(msg.to[0] - msg.from[0], msg.to[2] - msg.from[2])
    expect(flown).toBeGreaterThanOrEqual(T.throwM[0] * FAR)
    expect(dist2(msg.to, -180, 100)).toBeGreaterThan(T.coreM + 3)
    expect(msg.ms).toBeGreaterThanOrEqual(T.throwMs[0])
    expect(msg.peakM).toBeGreaterThan(0)
    expect(h.g.skills.held(v.p, T0 + 10)).toBe(true)
    expect(h.g.onMoveTo(v.p, T0 + 200)).toBe(false) // the gate: no control in the air
    h.tor.tick(T0 + msg.ms + 1)
    expect(v.p.hp).toBe(10_000 - Math.round(10_000 * T.damagePct))
    expect(v.p.dead).toBe(false)
    expect(v.inbox.some((m) => m.t === 'combat' && m.cause === 'tornado' && m.target === v.p.id)).toBe(true)
    const end = h.world.positionAt(v.p, T0 + msg.ms + 1)
    expect(end).toEqual(msg.to)
    expect(h.g.nav.canWalk(end[0], end[2])).toBe(true)
    h.tor.tick(T0 + msg.ms + T.lockMs + 1)
    expect(h.g.onMoveTo(v.p, T0 + msg.ms + T.lockMs + 2)).toBe(true)
    // immune for a while: not caught again at once
    h.world.warp(v.p, -180, 0, 101, T0 + msg.ms + T.lockMs + 10)
    h.tor.tick(T0 + msg.ms + T.lockMs + 200)
    expect(v.inbox.filter((m) => m.t === 'displace' && m.kind === 'throw')).toHaveLength(1)
  })

  /** Throws the body `v` out of a tornado at (-180, 100) `n` times (warped back into the core each time). */
  const throwAgain = (h: ReturnType<typeof harness>, v: ReturnType<ReturnType<typeof harness>['enter']>, n: number) => {
    let t = T0
    for (let i = 0; i < n; i++) {
      h.world.warp(v.p, -180, 0, 101, t)
      h.tor.tick(t)
      t += T.throwMs[1] + T.immuneMs + 100
      h.tor.tick(t)
    }
  }

  it('a healthy body survives a whole tornado: thrown again and again at strength 2, it loses at most damageTotalPct', () => {
    const h = harness({ tornadoStrength: 2 })
    const v = h.enter([-180, 0, 101])
    v.p.hp = v.p.maxHp = 500
    h.place(-180, 100, { strength: 2 })
    throwAgain(h, v, 8)
    expect(v.p.dead).toBe(false)
    expect(v.p.hp).toBe(500 - Math.round(500 * T.damageTotalPct))
    const hits = v.inbox.filter((m): m is Extract<ServerMessage, { t: 'combat' }> => m.t === 'combat' && m.cause === 'tornado')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    for (const c of hits) expect(c.hits[0]!.damage).toBeLessThanOrEqual(Math.round(500 * T.damageCapPct))
  })

  it('kills a body already low on HP (TORNADO_LETHAL, on by default): the normal death, nobody gets the kill', () => {
    const h = harness()
    const v = h.enter([-180, 0, 102])
    const watcher = h.enter([-150, 0, 100])
    v.p.hp = 300 // of 10,000: one throw takes 2,200
    const wolf = h.spawn(WOLF, -181, 101)
    wolf.hp = 5
    h.place(-180, 100)
    h.tor.tick(T0)
    const msg = v.inbox.find((m): m is Extract<ServerMessage, { t: 'displace' }> => m.t === 'displace' && m.kind === 'throw' && m.id === v.p.id)!
    h.tor.tick(T0 + T.throwMs[1] + 1)
    expect(v.p.hp).toBe(0)
    expect(v.p.dead).toBe(true)
    const death = watcher.inbox.find((m): m is Extract<ServerMessage, { t: 'combat' }> => m.t === 'combat' && m.target === v.p.id)!
    expect(death).toMatchObject({ attacker: 0, cause: 'tornado', killed: true })
    expect(h.world.positionAt(v.p, T0 + msg.ms + 1)).toEqual(msg.to)
    // a monster too (no attacker: no rewards)
    expect(wolf.ai).toBe('dead')
    // off: never below 1 HP
    const off = harness({ tornadoLethal: false })
    const w = off.enter([-180, 0, 102])
    w.p.hp = 2
    off.place(-180, 100)
    off.tor.tick(T0)
    off.tor.tick(T0 + T.throwMs[1] + 1)
    expect(w.p.hp).toBe(1)
    expect(w.p.dead).toBe(false)
  })

  it('landings respect the navmesh: never through the wall, never into the pond, never out of the world', () => {
    const h = harness()
    const s = h.place(50, 0)
    const c: Vec3 = [50, 0, 0]
    let landed = 0
    let far = 0
    for (let i = 0; i < 300; i++) {
      const a = (i / 300) * Math.PI * 2
      const from: NavPoint = { x: 50 + Math.cos(a) * 3, y: 0, z: Math.sin(a) * 3, surface: null }
      const end = h.tor.landing(s, from, c)
      if (!end) continue
      landed++
      if (Math.hypot(end.x - from.x, end.z - from.z) >= T.throwM[0] * FAR) far++
      // the wall (x 60, z -40..40) is never crossed: a landing past x 60 went round its end
      if (end.x >= WallNav.WALL_X) expect(Math.abs(from.z + ((end.z - from.z) * (WallNav.WALL_X - from.x)) / (end.x - from.x))).toBeGreaterThan(40)
      expect(end.x >= 0 && end.x <= 32 && end.z >= -32 && end.z <= 0).toBe(false) // the pond
      expect(Math.hypot(end.x - from.x, end.z - from.z)).toBeGreaterThanOrEqual(T.throwMinM)
    }
    // by the wall and the pond, every body still lands somewhere, nearly all of them far out
    expect(landed).toBe(300)
    expect(far).toBeGreaterThan(280)
    // at the world's edge: never outside it (in the corner: the farthest fit point of a shortened throw)
    const e = h.place(480, 480)
    for (let i = 0; i < 100; i++) {
      const end = h.tor.landing(e, { x: 481, y: 0, z: 481, surface: null }, [480, 0, 480])
      expect(end).not.toBeNull()
      expect(end!.x).toBeLessThanOrEqual(500)
      expect(end!.z).toBeLessThanOrEqual(500)
    }
    // a pond in the way: a throw that would come down in the water lands short of it, on the shore
    const p = h.place(-30, -16)
    for (let i = 0; i < 50; i++) {
      const end = h.tor.landing(p, { x: -22, y: 0, z: -16, surface: null }, [-30, 0, -16])
      if (end) expect(end.x >= 0 && end.x <= 32 && end.z >= -32 && end.z <= 0).toBe(false)
    }
    // a town: a body at its edge is never thrown into it
    const t = h.place(-300, -230)
    for (let i = 0; i < 100; i++) {
      const end = h.tor.landing(t, { x: -300, y: 0, z: -233, surface: null }, [-300, 0, -230])
      if (end) expect(h.data.inSafeArea('jangan', end.x, end.z)).toBe(false)
    }
  })

  it('monsters are pulled and thrown too; Tiger Girl, the Play the Boss body, a trance body and a town are left alone', () => {
    const h = harness()
    const wolf = h.spawn(WOLF, -180, 101)
    const girl = h.spawn(GIRL, -181, 100, 'unique')
    const boss = h.spawn(WOLF, -179, 100)
    boss.pilot = { player: null, steering: 'ai' }
    const trance = h.enter([-180, 0, 99])
    trance.p.trance = true
    const watcher = h.enter([-150, 0, 100])
    h.place(-180, 100)
    h.tor.tick(T0)
    const thrown = new Set(watcher.inbox.filter((m) => m.t === 'displace' && m.kind === 'throw').map((m) => (m as { id: number }).id))
    expect(thrown.has(wolf.id)).toBe(true)
    expect(thrown.has(girl.id)).toBe(false)
    expect(thrown.has(boss.id)).toBe(false)
    expect(thrown.has(trance.p.id)).toBe(false)
    expect(h.tor.exempt(girl)).toBe(true)
    // a tornado by a town (a GM's doing) never touches who stands inside it
    const t = harness()
    const safe = t.enter([-300, 0, -251])
    t.place(-300, -246)
    for (let k = 0; k < 10; k++) t.tor.tick(T0 + k * 100)
    expect(safe.inbox.some((m) => m.t === 'displace')).toBe(false)
    expect(t.world.positionAt(safe.p, T0 + 1000)).toEqual([-300, 0, -251])
  })

  it('its lightning: telegraphed strikes around it (source tornado) that hurt but never kill', () => {
    const h = harness({ tornadoLethal: false }) // its throws could kill this body; its bolts never do
    const v = h.enter([-160, 0, 100])
    v.p.hp = 3
    h.place(-180, 100)
    let strikes = 0
    for (let t = T0; t <= T0 + 60_000; t += 100) {
      h.g.now = t
      h.tor.tick(t)
      h.g.lightning.tick(t)
    }
    for (const m of v.inbox) {
      if (m.t !== 'strike') continue
      strikes++
      expect(m.strike.source).toBe('tornado')
      expect(m.strike.warnAt).toBeDefined()
      expect(m.strike.at - m.strike.warnAt!).toBeGreaterThanOrEqual(1200)
      expect(dist2(m.strike.pos, -180, 100)).toBeLessThanOrEqual(T.boltRingM[1] + 1)
    }
    expect(strikes).toBeGreaterThan(8)
    expect(v.p.dead).toBe(false)
    expect(v.p.hp).toBeGreaterThanOrEqual(1)
  })
})
