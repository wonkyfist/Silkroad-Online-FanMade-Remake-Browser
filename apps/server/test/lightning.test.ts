import {
  STRIKE_RADIUS_M,
  STRIKE_TELEGRAPH_MS,
  mulberry32,
  parseServerMessage,
  type LightningStrike,
  type Role,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STRIKE_DAMAGE, STRIKE_STUN_MS, strikeDamage } from '../src/lightning/damage.ts'
import { RodIndex, rodsFromManifest, type Rod, type RodManifest } from '../src/lightning/rods.ts'
import { CLOSE_M, NEAR_M, heightWeight, pickFar, pickNear, pickSky, strikeClass, type Body } from '../src/lightning/select.ts'
import { LightningService, type LightningHost, type StrikeEvent } from '../src/lightning/service.ts'
import { WeatherService } from '../src/weather.ts'
import type { Mob, Player } from '../src/world.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)

// ---- rods ------------------------------------------------------------------------------------------------------

describe('lightning rods from the world manifest', () => {
  const yaw90: number[] = [0, Math.SQRT1_2, 0, Math.SQRT1_2] // +90° about +Y: model +X becomes glTF -Z
  const m: RodManifest = {
    models: [
      { boundsMin: [-5, 0, -5], boundsMax: [5, 30, 5] }, // 0 a tall tree
      { boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1] }, // 1 a bush in a tree folder
      { boundsMin: [-100, 0, -8], boundsMax: [100, 20, 8] }, // 2 a long wall along model X
      { boundsMin: [-4, 0, -4], boundsMax: [4, 50, 4] }, // 3 a tower
      { boundsMin: [-30, 0, -30], boundsMax: [30, 25, 30] }, // 4 a wide hall (not a tower)
    ],
    placements: [
      { source: 'res\\nature\\common\\tree\\tre_pine10.bsr', models: [0], position: [10, 2, 20], rotation: [0, 0, 0, 1] },
      { source: 'res\\nature\\common\\tree\\tre_bush.bsr', models: [1], position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      { source: 'res\\nature\\common\\tree\\tre_pine10.bsr', models: [0], position: [50, 0, 0], rotation: [0, 0, 0, 1], scale: 0.5 },
      { source: 'res\\bldg\\china\\jangan_enter\\cj_s.bsr', models: [2], position: [0, 0, 100], rotation: yaw90 },
      { source: 'res\\artifact\\china\\jangan\\cj_jang_tower.bsr', models: [3], position: [-50, 1, -50], rotation: [0, 0, 0, 1] },
      { source: 'res\\bldg\\china\\jangan01\\cj_hall.bsr', models: [4], position: [200, 0, 200], rotation: [0, 0, 0, 1] },
    ],
  }
  // the navmesh has a wall walk at 19.5 m on the wall's line (x ≈ 0 after the 90° turn), nothing elsewhere
  const topAt = (x: number, _z: number) => (Math.abs(x) < 1 ? 19.5 : null)
  const rods = rodsFromManifest(m, topAt)

  it('classifies trees (crown top over the foot), wall walks (navmesh top, sampled along the turned wall) and towers', () => {
    const trees = rods.filter((r) => r.kind === 'tree')
    expect(trees).toEqual([
      { kind: 'tree', x: 10, y: 32, z: 20, ground: 2 },
      { kind: 'tree', x: 50, y: 15, z: 0, ground: 0 },
    ])
    const walls = rods.filter((r) => r.kind === 'wall')
    expect(walls.length).toBeGreaterThanOrEqual(15)
    for (const w of walls) {
      expect(w.x).toBeCloseTo(0, 6)
      expect(w.y).toBe(19.5)
      expect(Math.abs(w.z - 100)).toBeLessThanOrEqual(100)
    }
    expect(rods.filter((r) => r.kind === 'tower')).toEqual([{ kind: 'tower', x: -50, y: 51, z: -50, ground: 1 }])
  })

  it('drops wall samples without a navmesh top (no guessed heights)', () => {
    expect(rodsFromManifest(m, () => null).filter((r) => r.kind === 'wall')).toEqual([])
  })

  it('indexes rods on a grid: near and nearest', () => {
    const idx = new RodIndex(rods)
    expect(idx.counts.tree).toBe(2)
    expect(idx.near(10, 20, 1).map((r) => r.kind)).toEqual(['tree'])
    expect(idx.nearest(0, 0, 500, 'tower')).toMatchObject({ x: -50, z: -50 })
    expect(idx.nearest(0, 0, 10, 'tower')).toBeNull()
  })
})

// ---- selection -----------------------------------------------------------------------------------------------

describe('strike selection', () => {
  const flat = () => 0
  const never = () => false
  const count = (n: number, f: (rng: () => number) => string | undefined) => {
    const rng = mulberry32(42)
    const out: Record<string, number> = {}
    for (let i = 0; i < n; i++) {
      const k = f(rng) ?? 'none'
      out[k] = (out[k] ?? 0) + 1
    }
    return out
  }

  it('prefers tall things: a 25 m tree near a player is hit far more often than any one ground point', () => {
    const tree: Rod = { kind: 'tree', x: 20, y: 25, z: 0, ground: 0 }
    const c = count(4000, (rng) => pickNear({ anchor: { x: 0, z: 0 }, rods: [tree], bodies: [], ground: flat, safe: never, rng })?.kind)
    // weight 12.25 against 12 ground samples of weight 1
    expect(c.tree! / 4000).toBeGreaterThan(0.45)
    expect(c.tree! / 4000).toBeLessThan(0.56)
    expect(heightWeight(25)).toBeGreaterThan(12 * heightWeight(0))
  })

  it('a body on high ground draws more strikes than the same body in a valley', () => {
    const body = (prominence: number): Body => ({ id: 7, x: 10, y: prominence, z: 10, height: 1.8, prominence })
    const hits = (b: Body) => count(4000, (rng) => pickNear({ anchor: { x: 0, z: 0 }, rods: [], bodies: [b], ground: flat, safe: never, rng })?.kind).entity ?? 0
    const valley = hits(body(0))
    const hill = hits(body(12))
    expect(hill).toBeGreaterThan(2.5 * valley)
  })

  it('stays near the anchor: everything picked lies within the radius (close calls within CLOSE_M)', () => {
    const rng = mulberry32(3)
    const far: Rod = { kind: 'tower', x: 500, y: 60, z: 0, ground: 0 }
    for (let i = 0; i < 500; i++) {
      const within = i % 2 ? NEAR_M : CLOSE_M
      const t = pickNear({ anchor: { x: 100, z: -40 }, rods: [far], bodies: [], ground: flat, safe: never, rng, within })!
      expect(Math.hypot(t.x - 100, t.z + 40)).toBeLessThanOrEqual(within + 1e-9)
    }
  })

  it('safe areas: never the plaza, a tree or a body inside; the outer wall walk still is', () => {
    const safe = (x: number, _z: number) => x < 50 // the town is x < 50
    const inTree: Rod = { kind: 'tree', x: 10, y: 20, z: 0, ground: 0 }
    const wall: Rod = { kind: 'wall', x: 40, y: 19.5, z: 0, ground: 0 }
    const b: Body = { id: 1, x: 5, y: 0, z: 0, height: 1.8, prominence: 0 }
    const c = count(2000, (rng) => {
      const t = pickNear({ anchor: { x: 0, z: 0 }, rods: [inTree, wall], bodies: [b], ground: flat, safe, rng, within: 45 })
      if (t && t.kind !== 'wall' && safe(t.x, t.z)) return 'unsafe'
      return t?.kind
    })
    expect(c.unsafe).toBeUndefined()
    expect(c.wall).toBeGreaterThan(1500)
    expect(c.tree).toBeUndefined()
    expect(c.entity).toBeUndefined()
    // a player deep inside the town with no wall around: nothing may be struck (the service flashes the sky instead)
    expect(pickNear({ anchor: { x: 0, z: 0 }, rods: [inTree], bodies: [b], ground: flat, safe: () => true, rng: mulberry32(1) })).toBeNull()
  })

  it('far strikes land 300-1800 m away (or exactly the GM distance), never in a safe area; sky flashes are high and harmless', () => {
    const rng = mulberry32(9)
    const clamp = (x: number, z: number): [number, number] => [x, z]
    let none = 0
    for (let i = 0; i < 200; i++) {
      // half the plane is a town: a few tries may all land in it (the service then flashes the sky)
      const t = pickFar({ anchor: { x: 0, z: 0 }, ground: flat, safe: (x) => x > 0, rng, clamp })
      if (!t) {
        none++
        continue
      }
      const d = Math.hypot(t.x, t.z)
      expect(d).toBeGreaterThanOrEqual(300)
      expect(d).toBeLessThanOrEqual(1800)
      expect(t.x).toBeLessThanOrEqual(0)
    }
    expect(none).toBeLessThan(10)
    expect(Math.hypot(pickFar({ anchor: { x: 0, z: 0 }, ground: flat, safe: never, rng, clamp }, 1200)!.x, 0)).toBeLessThanOrEqual(1200)
    const sky = pickSky({ x: 0, y: 10, z: 0 }, rng)
    expect(sky).toMatchObject({ kind: 'sky', radiusM: 0 })
    expect(sky.y).toBeGreaterThanOrEqual(310)
    expect([0.1, 0.5, 0.95].map(strikeClass)).toEqual(['sky', 'near', 'far'])
  })
})

// ---- damage --------------------------------------------------------------------------------------------------

describe('strike damage', () => {
  const player = { kind: 'player' as const, hp: 1000, maxHp: 1000, level: 30 }
  it('a big hit by max HP: 38 % at the centre, 22 % at the edge, never a kill from full', () => {
    expect(strikeDamage(player, 0, 4)).toEqual({ damage: 380, stun: true })
    expect(strikeDamage(player, 4, 4).damage).toBe(220)
    expect(strikeDamage(player, 2, 4).damage).toBe(300)
    for (const maxHp of [50, 333, 12_000]) expect(strikeDamage({ ...player, hp: maxHp, maxHp }, 0, 4).damage).toBeLessThan(maxHp)
  })
  it('scales: newbies less, strong monsters less, bosses 3 % and never killed', () => {
    expect(strikeDamage({ ...player, level: 5 }, 0, 4).damage).toBe(Math.round(1000 * STRIKE_DAMAGE.centrePct * STRIKE_DAMAGE.newbieMul))
    expect(strikeDamage({ kind: 'mob', hp: 1000, maxHp: 1000, level: 20, variant: 'champion' }, 0, 4).damage).toBe(228)
    expect(strikeDamage({ kind: 'mob', hp: 1000, maxHp: 1000, level: 20, variant: 'normal' }, 0, 4).damage).toBe(380)
    expect(strikeDamage({ kind: 'mob', hp: 100_000, maxHp: 100_000, level: 40, variant: 'unique' }, 0, 4)).toEqual({ damage: 3000, stun: false })
    expect(strikeDamage({ kind: 'mob', hp: 10, maxHp: 100_000, level: 40, variant: 'unique' }, 0, 4).damage).toBe(9)
    expect(strikeDamage({ kind: 'mob', hp: 50, maxHp: 100, level: 40, variant: 'normal', piloted: true }, 0, 4)).toEqual({ damage: 3, stun: false })
  })
})

// ---- the service on a stand-in host -------------------------------------------------------------------------

interface FakeBody {
  id: number
  pos: Vec3
  hp: number
  maxHp: number
  level: number
  radius: number
}

function harness(opts: { safe?: (x: number, z: number) => boolean; rods?: Rod[] } = {}) {
  const players = new Map<number, Player>()
  const mobs = new Map<number, Mob>()
  const inbox = new Map<number, ServerMessage[]>()
  const hazard: { id: number; damage: number; strike?: number }[] = []
  const stuns: { id: number; ms: number }[] = []
  const events: StrikeEvent[] = []
  const addPlayer = (b: Partial<FakeBody> & { id: number; pos: Vec3 }, name = `P${b.id}`): Player => {
    const p = { kind: 'player', name, hp: 1000, maxHp: 1000, level: 30, radius: 0.5, dead: false, invisible: false, move: null, ...b } as unknown as Player
    const box: ServerMessage[] = []
    inbox.set(p.id, box)
    p.send = (m: ServerMessage) => {
      const r = parseServerMessage(JSON.stringify(m))
      if (!r.ok) throw new Error(`the client would reject ${JSON.stringify(m)}: ${r.error}`)
      box.push(m)
    }
    players.set(p.id, p)
    return p
  }
  const addMob = (b: Partial<FakeBody> & { id: number; pos: Vec3 }, variant = 'normal'): Mob => {
    const m = { kind: 'mob', hp: 500, maxHp: 500, level: 20, radius: 1, ai: 'idle', variant, damage: new Map(), move: null, ...b } as unknown as Mob
    mobs.set(m.id, m)
    return m
  }
  const host: LightningHost = {
    config: { world: 'jangan', outDir: '', log: () => {} },
    world: {
      players,
      mobs,
      positionAt: (p) => p.pos,
      clamp: (x, z) => [x, z],
      byName: (n) => [...players.values()].find((p) => p.name.toLowerCase() === n.toLowerCase()) ?? null,
    },
    nav: { kind: 'flat', heightAt: () => null },
    data: { inSafeArea: (_w, x, z) => opts.safe?.(x, z) ?? false },
    rng: mulberry32(7),
    hazardHit(t, damage, _cause, _now, strike) {
      const dealt = Math.min(damage, Math.ceil(t.hp))
      t.hp -= dealt
      hazard.push({ id: t.id, damage: dealt, strike })
      return { dealt, killed: t.hp <= 0 }
    },
    skills: { applyHazardStatus: (t, _s, ms) => void stuns.push({ id: t.id, ms }) },
  }
  const svc = new LightningService(host, { rods: new RodIndex(opts.rods ?? []) })
  svc.onStrike((e) => events.push(e))
  const of = <T extends ServerMessage['t']>(id: number, t: T) => (inbox.get(id) ?? []).filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[]
  return { svc, host, addPlayer, addMob, hazard, stuns, events, of }
}

describe('LightningService', () => {
  it('telegraphs 1.2-1.8 s before it lands; damage lands at `at`, not before; then a short stun', () => {
    const h = harness()
    const gm = h.addPlayer({ id: 1, pos: [0, 0, 0] })
    const r = h.svc.gm(['here'], gm, T0)
    expect(r.ok).toBe(true)
    const [{ strike: s }] = h.of(1, 'strike')
    expect(s).toMatchObject({ kind: 'entity', warnAt: T0, pos: [0, 0, 0], radiusM: STRIKE_RADIUS_M.entity, target: 1 })
    expect(s.at - T0).toBeGreaterThanOrEqual(STRIKE_TELEGRAPH_MS[0])
    expect(s.at - T0).toBeLessThanOrEqual(STRIKE_TELEGRAPH_MS[1])
    // the old flash, with the strike's id, for older clients
    expect(h.of(1, 'lightning')).toEqual([{ t: 'lightning', at: s.at, distM: 100, bearing: expect.any(Number), strike: s.id }])
    expect(h.events.map((e) => e.phase)).toEqual(['warn'])
    h.svc.tick(s.at - 1)
    expect(h.hazard).toEqual([])
    h.svc.tick(s.at)
    expect(h.hazard).toEqual([{ id: 1, damage: 380, strike: s.id }])
    expect(h.stuns).toEqual([{ id: 1, ms: STRIKE_STUN_MS }])
    expect(h.events[1]).toMatchObject({ phase: 'land', hits: [{ id: 1, kind: 'player', damage: 380, killed: false }] })
    expect(gm.hp).toBe(620)
  })

  it('whoever stepped out of the radius during the telegraph is not hit; a monster in it is', () => {
    const h = harness()
    const a = h.addPlayer({ id: 1, pos: [0, 0, 0] })
    const b = h.addPlayer({ id: 2, pos: [1, 0, 0] })
    const m = h.addMob({ id: 3, pos: [-2, 0, 1] })
    h.svc.gm(['here'], a, T0)
    const s = h.svc.pendingStrikes[0]!
    a.pos = [8, 0, 0] // ran
    h.svc.tick(s.at)
    expect(h.hazard.map((x) => x.id).sort()).toEqual([2, 3])
    expect(b.hp).toBeLessThan(1000)
    expect(m.hp).toBeLessThan(500)
    expect(a.hp).toBe(1000)
  })

  it('no damage in a safe area: a strike on the plaza is harmless, and a body inside is never hit', () => {
    const h = harness({ safe: (x) => x < 0 })
    const a = h.addPlayer({ id: 1, pos: [-5, 0, 0] })
    h.svc.gm(['here'], a, T0)
    const s = h.svc.pendingStrikes[0]!
    expect(s.radiusM).toBe(0)
    h.svc.tick(s.at)
    expect(h.hazard).toEqual([])
    // a strike just outside the town: the player standing inside, within the radius, is still safe
    const b = h.addPlayer({ id: 2, pos: [1, 0, 0] })
    h.svc.gm(['at', '1.5', '0'], b, T0 + 5000)
    const s2 = h.svc.pendingStrikes[0]!
    a.pos = [-0.5, 0, 0]
    h.svc.tick(s2.at)
    expect(h.hazard.map((x) => x.id)).toEqual([2])
  })

  it('bodies above or below the strike are not in it (a wall walk, a bridge)', () => {
    const h = harness()
    const a = h.addPlayer({ id: 1, pos: [0, 0, 0] })
    const b = h.addPlayer({ id: 2, pos: [0.5, 10, 0] })
    h.svc.gm(['here'], a, T0)
    h.svc.tick(T0 + 5000)
    expect(h.hazard.map((x) => x.id)).toEqual([1])
    expect(b.hp).toBe(1000)
  })

  it('a strike on a tree hits around its foot; on a wall only who stands on the wall walk', () => {
    const rods: Rod[] = [
      { kind: 'tree', x: 30, y: 40, z: 0, ground: 0 },
      { kind: 'wall', x: -30, y: 19.5, z: 0, ground: 0 },
    ]
    const h = harness({ rods })
    const gm = h.addPlayer({ id: 1, pos: [0, 0, 0] })
    const under = h.addPlayer({ id: 2, pos: [31, 0, 1] })
    const onWall = h.addPlayer({ id: 3, pos: [-30.5, 19.5, 0] })
    const belowWall = h.addPlayer({ id: 4, pos: [-30, 0, 0] })
    expect(h.svc.gm(['tree'], gm, T0).ok).toBe(true)
    expect(h.of(1, 'strike')[0]!.strike).toMatchObject({ kind: 'tree', pos: [30, 40, 0], groundY: 0, radiusM: STRIKE_RADIUS_M.tree })
    h.svc.tick(T0 + 5000)
    expect(h.svc.gm(['wall'], gm, T0 + 5000).ok).toBe(true)
    h.svc.tick(T0 + 10_000)
    expect(h.hazard.map((x) => x.id)).toEqual([2, 3])
    expect(under.hp).toBeLessThan(1000)
    expect(onWall.hp).toBeLessThan(1000)
    expect(belowWall.hp).toBe(1000)
  })

  it('a boss is grazed, never killed nor stunned; a weak monster can die of it', () => {
    const h = harness()
    const gm = h.addPlayer({ id: 1, pos: [50, 0, 0] })
    const boss = h.addMob({ id: 2, pos: [0, 0, 0], hp: 10, maxHp: 100_000 }, 'unique')
    const weak = h.addMob({ id: 3, pos: [0.5, 0, 0], hp: 20, maxHp: 500 })
    h.svc.gm(['at', '0', '0'], gm, T0)
    h.svc.tick(T0 + 5000)
    expect(boss.hp).toBe(1)
    expect(weak.hp).toBeLessThanOrEqual(0)
    expect(h.stuns).toEqual([])
    expect(h.events.at(-1)!.hits).toEqual([
      { id: 2, kind: 'mob', damage: 9, killed: false },
      { id: 3, kind: 'mob', damage: 20, killed: true },
    ])
  })

  it('a player entering during a telegraph is sent the pending strike', () => {
    const h = harness()
    const a = h.addPlayer({ id: 1, pos: [0, 0, 0] })
    h.svc.gm([], a, T0)
    const late = h.addPlayer({ id: 2, pos: [0, 0, 0] })
    const pending = h.svc.pendingStrikes.length
    h.svc.enter(late, T0 + 100)
    expect(h.of(2, 'strike')).toHaveLength(pending)
  })

  it('GM: a player by name, a spot, a distance, the sky; bad arguments refused', () => {
    const h = harness()
    const gm = h.addPlayer({ id: 1, pos: [0, 0, 0] }, 'Gm')
    h.addPlayer({ id: 2, pos: [40, 0, 40] }, 'Victim')
    expect(h.svc.gm(['victim'], gm, T0)).toMatchObject({ ok: true, data: { kind: 'entity', target: 2, pos: [40, 0, 40] } })
    expect(h.svc.gm(['at', '12', '-7'], gm, T0)).toMatchObject({ ok: true, data: { kind: 'ground', pos: [12, 0, -7] } })
    const far = h.svc.gm(['900'], gm, T0).data as LightningStrike
    expect(Math.hypot(far.pos[0], far.pos[2])).toBeCloseTo(900, 0)
    expect(h.svc.gm(['sky'], gm, T0)).toMatchObject({ ok: true, data: { kind: 'sky', radiusM: 0 } })
    expect(h.svc.gm(['nobody'], gm, T0).ok).toBe(false)
    expect(h.svc.gm(['50'], gm, T0).ok).toBe(false)
    expect(h.svc.gm(['at', 'x', '1'], gm, T0).ok).toBe(false)
    expect(h.svc.gm(['tree'], gm, T0).ok).toBe(false) // no rods
    expect(h.svc.gm(['here'], null, T0).ok).toBe(false)
    // the sky flash lands at once and hurts nobody
    expect(h.events.filter((e) => e.strike.kind === 'sky').map((e) => e.phase)).toEqual(['warn', 'land'])
  })

  it('rolls anchor on living players; nobody in the world: no strike', () => {
    const h = harness()
    expect(h.svc.roll(T0)).toBe(false)
    h.addPlayer({ id: 1, pos: [0, 0, 0] })
    for (let i = 0; i < 50; i++) expect(h.svc.roll(T0 + i * 5000)).toBe(true)
    const strikes = h.of(1, 'strike').map((m) => m.strike)
    expect(strikes).toHaveLength(50)
    const kinds = new Set(strikes.map((s) => s.kind))
    expect(kinds.has('sky')).toBe(true)
    expect(kinds.has('ground') || kinds.has('entity')).toBe(true)
    for (const s of strikes) {
      if (s.kind === 'sky') expect(s.warnAt).toBeUndefined()
      else expect(s.at - s.warnAt!).toBeGreaterThanOrEqual(STRIKE_TELEGRAPH_MS[0])
    }
    expect(h.svc.rateScale()).toBe(1)
  })
})

describe('WeatherService with the strike sink', () => {
  it('storms place strikes through the sink, at least 4 s apart, scaled by the players in the world', () => {
    const sent: ServerMessage[] = []
    const w = new WeatherService({ config: { weather: 'storm', weatherSeed: 1, weatherRainScale: 1, log: () => {} }, world: { broadcast: (m) => void sent.push(m) } }, T0)
    const rolls: number[] = []
    let prepared = 0
    w.strikes = { rateScale: () => 3, prepare: () => void prepared++, roll: (now) => (rolls.push(now), true), gm: () => ({ ok: true, message: '' }) }
    for (let t = T0; t <= T0 + 10 * 60_000; t += 1000) w.tick(t)
    expect(prepared).toBeGreaterThan(0)
    expect(sent.filter((m) => m.t === 'lightning')).toEqual([]) // no old cosmetic flashes
    // 5 a minute × 3 for ten minutes, minus the 4 s gap: well above the unscaled ~50
    expect(rolls.length).toBeGreaterThan(70)
    for (let i = 1; i < rolls.length; i++) expect(rolls[i]! - rolls[i - 1]!).toBeGreaterThanOrEqual(4000)
  })
})

// ---- over the wire (a real server) ---------------------------------------------------------------------------

describe('lightning over the wire', () => {
  let s: TestServer
  let counter = 0
  beforeAll(async () => {
    s = await startTestServer({ config: { weather: 'auto' } })
  })
  afterAll(async () => {
    await s.stopAndClean()
  })

  async function player(role: Role = 'player') {
    const acc = await newAccount(s.url, role === 'player' ? 'lt' : 'ltgm')
    if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Bolt${++counter}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    return { c, enter: await c.next('worldEnter') }
  }

  it('`weather strike here`: the telegraph reaches everyone, then the GM is hit through the combat path and stunned', async () => {
    const gm = await player('gm')
    const p = await player()
    const maxHp = gm.enter.self.maxHp!
    gm.c.send({ t: 'gm', cmd: 'weather', args: ['strike', 'here'] })
    expect(await gm.c.next('gmResult')).toMatchObject({ ok: true, cmd: 'weather' })
    const warn = (await gm.c.next('strike')).strike
    expect((await p.c.next('strike')).strike).toEqual(warn)
    expect(warn).toMatchObject({ kind: 'entity', target: gm.enter.self.id })
    const hit = await gm.c.next('combat', (m) => m.cause === 'lightning', 4000)
    expect(Date.now()).toBeGreaterThanOrEqual(warn.at - 50)
    expect(hit).toMatchObject({ attacker: 0, target: gm.enter.self.id, strike: warn.id })
    expect(hit.hits[0]!.damage).toBe(Math.round(maxHp * 0.38 * (gm.enter.self.level! < 10 ? 0.6 : 1)))
    expect((await gm.c.next('effectAdd', (m) => m.effect.status === 'stun')).effect.remainingMs).toBeLessThanOrEqual(STRIKE_STUN_MS)
    expect((await gm.c.next('statsDelta', (m) => m.stats.hp !== undefined)).stats.hp).toBe(hit.hits[0]!.hp)
    // the other player saw the hit too
    expect(await p.c.next('combat', (m) => m.cause === 'lightning')).toMatchObject({ target: gm.enter.self.id })
    // a second GM strike within 4 s is refused
    gm.c.send({ t: 'gm', cmd: 'weather', args: ['strike'] })
    expect((await gm.c.next('gmResult')).ok).toBe(false)
    for (const c of [gm.c, p.c]) c.close()
    await sleep(20)
  })
})
