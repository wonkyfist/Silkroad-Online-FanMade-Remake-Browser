/**
 * Storms change everything (docs/WEATHER.md §12): the storm events and their forecast (storm/schedule.ts, weather.ts),
 * and every hook of the storm module (storm/service.ts) on a Gameplay with a pinned weather: monster sight, leash, roam
 * and speed; element, wind and monster damage modifiers; thunder panic; storm-charged monsters (gain, effects, arcs,
 * loot, cleared after the storm and on death); nest counts; mud; the status and the GM command. Uniques and the Play
 * the Boss body stay untouched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALM_ENV, STORM_TABLE, WeatherSchedule, parseServerMessage, type LightningStrike, type ServerMessage, type StormEnv, type TownDef, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { thinkMob } from '../src/ai.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { DAY_MS, StormPlan, stormDay, stormFrequency, stormsOfDay } from '../src/storm/schedule.ts'
import { WeatherService } from '../src/weather.ts'
import { World, type Mob } from '../src/world.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, mob, nest, seeded } from './fixtures.ts'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)

// ---- the storm events --------------------------------------------------------------------------------------

describe('storm events (storm/schedule.ts)', () => {
  const f = stormFrequency({})

  it('lays 3 storms a day by default, 10-20 min long, each forecast 5 min before, inside the day and apart', () => {
    const day = stormDay(T0)
    const list = stormsOfDay(1, day, f)
    expect(list).toHaveLength(3)
    expect(stormsOfDay(1, day, f)).toEqual(list) // deterministic: a restart lands on the same storms
    for (const [i, e] of list.entries()) {
      expect(e.start - e.forecastAt).toBe(5 * 60_000)
      expect(e.end - e.start).toBeGreaterThanOrEqual(10 * 60_000 - 1000)
      expect(e.end - e.start).toBeLessThanOrEqual(20 * 60_000 + 1000)
      if (i > 0) expect(e.forecastAt).toBeGreaterThanOrEqual(list[i - 1]!.end)
    }
    expect(stormsOfDay(2, day, f)).not.toEqual(list)
  })

  it('follows the knobs: none at 0 a day, about 1.5 a day at 1.5, a longer forecast', () => {
    expect(stormsOfDay(1, 100, { ...f, perDay: 0 })).toEqual([])
    let n = 0
    for (let d = 0; d < 400; d++) n += stormsOfDay(1, d, { ...f, perDay: 1.5 }).length
    expect(n / 400).toBeGreaterThan(1.35)
    expect(n / 400).toBeLessThan(1.65)
    const [e] = stormsOfDay(1, 7, { ...f, forecastMin: 8 })
    expect(e!.start - e!.forecastAt).toBe(8 * 60_000)
  })

  it('StormPlan: nothing before the forecast, the event through forecast and storm, nothing after; next()', () => {
    const plan = new StormPlan({ weatherSeed: 1 })
    const e = stormsOfDay(1, stormDay(T0), f)[1]!
    expect(plan.event(e.forecastAt - 1000)).toBeNull()
    expect(plan.next(e.forecastAt - 1000)).toEqual(e)
    expect(plan.event(e.forecastAt)).toEqual(e)
    expect(plan.event(e.start + 1000)).toEqual(e)
    expect(plan.event(e.end)).toBeNull()
  })

  it('a storm in progress keeps its times when the knobs change; a stopped one stays stopped', () => {
    const config = { weatherSeed: 1, stormsPerDay: 3 }
    const plan = new StormPlan(config)
    const e = stormsOfDay(1, stormDay(T0), f)[0]!
    expect(plan.event(e.start)).toEqual(e)
    config.stormsPerDay = 7
    expect(plan.event(e.start + 1000)).toEqual(e)
    config.stormsPerDay = 3
    expect(plan.stop(e.start + 2000)).toBe(true)
    expect(plan.event(e.start + 3000)).toBeNull()
    expect(plan.stop(e.start + 3000)).toBe(false)
  })

  it('GM storms: start now (with or without a forecast), win over the schedule, stop; only GM storms when not scheduled', () => {
    const plan = new StormPlan({ weatherSeed: 1 }, () => false)
    const quiet = stormsOfDay(1, stormDay(T0), f)[0]!
    expect(plan.event(quiet.start)).toBeNull()
    const g = plan.startGm(T0, 10 * 60_000, 2 * 60_000, 7)
    expect(g).toMatchObject({ forecastAt: T0, start: T0 + 120_000, end: T0 + 720_000, gm: true })
    expect(plan.event(T0 + 1000)).toBe(g)
    expect(plan.stop(T0 + 2000)).toBe(true)
    expect(plan.event(T0 + 3000)).toBeNull()
    expect(DAY_MS).toBe(86_400_000)
  })
})

describe('WeatherService with storm events (forecast timing)', () => {
  function service(mode: 'auto' | 'clear' = 'auto', now = T0) {
    const sent: ServerMessage[] = []
    const host = {
      config: { weather: mode, weatherSeed: 1, weatherRainScale: 1, log: () => {} },
      world: {
        broadcast(msg: ServerMessage) {
          const r = parseServerMessage(JSON.stringify(msg))
          if (!r.ok) throw new Error(`the client would reject ${JSON.stringify(msg)}: ${r.error}`)
          sent.push(msg)
        },
      },
    }
    const w = new WeatherService(host, now)
    w.storms = new StormPlan(host.config, () => w.mode === 'auto')
    const weather = () => sent.filter((m): m is Extract<ServerMessage, { t: 'weather' }> => m.t === 'weather').map((m) => m.weather)
    return { w, weather, run: (from: number, to: number) => { for (let t = from; t <= to; t += 1000) w.tick(t) } }
  }

  it('5 minutes before a storm the sky darkens and the wind rises over the whole forecast; then the storm; then the schedule', () => {
    const e = stormsOfDay(1, stormDay(T0), stormFrequency({}))[1]!
    const { w, weather, run } = service('auto', e.forecastAt - 10_000)
    run(e.forecastAt - 9000, e.forecastAt + 2000)
    const fc = weather().find((s) => s.start >= e.forecastAt)!
    expect(fc).toBeDefined()
    expect(['overcast', 'rain']).toContain(fc.to)
    expect(fc.windMs).toBe(STORM_TABLE.forecastWindMs)
    expect(fc.start + fc.dur).toBeGreaterThanOrEqual(e.start - 2000) // the darkening lasts the whole forecast
    expect(w.params(e.start - 1000).windMs).toBe(STORM_TABLE.forecastWindMs)
    run(e.forecastAt + 3000, e.start + 2000)
    const storm = weather().at(-1)!
    expect(storm).toMatchObject({ to: 'storm', start: e.start, until: e.end })
    run(e.start + 3000, e.end + 2000)
    expect(weather().at(-1)!.to).not.toBe('storm')
  })

  it("the schedule's own storms become heavy rain once storm events run (and stay storms without them)", () => {
    const sch = new WeatherSchedule(1)
    let seg = sch.at(T0)
    while (seg.kind !== 'storm') seg = sch.next(seg)
    const mid = seg.start + 200_000
    const plain = new WeatherService({ config: { weather: 'auto', weatherSeed: 1, weatherRainScale: 1, log: () => {} }, world: { broadcast: () => {} } }, mid)
    expect(plain.sync(mid).to).toBe('storm')
    const { w, run } = service('auto', mid)
    // no storm event right then (the plan's storms are elsewhere)
    expect(w.storms!.event(mid)).toBeNull()
    run(mid, mid + 2000)
    expect(w.sync(mid + 2000)).toMatchObject({ to: 'rain', intensity: 1 })
  })

  it('a fixed weather has no scheduled storms, but a GM storm still comes', () => {
    const { w, weather, run } = service('clear', T0)
    const e = stormsOfDay(1, stormDay(T0), stormFrequency({}))
    for (const x of e) expect(w.storms!.event(x.start)).toBeNull()
    w.storms!.startGm(T0 + 1000, 600_000, 0, 3)
    run(T0 + 1000, T0 + 3000)
    expect(weather().at(-1)).toMatchObject({ to: 'storm' })
  })
})

// ---- the storm module on a Gameplay ------------------------------------------------------------------------

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const GHOST = mob('MOB_CH_STONEGHOST', { name: 'Stone Ghost', level: 9, hp: 1000, aggressive: true })
const BANDIT = mob('MOB_CH_BANDIT', { name: 'Bandit', level: 16, hp: 1000, aggressive: true })
const TIGER = mob('MOB_CH_TIGER', { name: 'Tiger', level: 14, hp: 1000, aggressive: true, runSpeed: 6 })
const WATER = mob('MOB_CH_WATERGHOST', { name: 'Water Ghost', level: 7, hp: 1000 })
const GIRL = mob('MOB_CH_TIGERWOMAN', { name: 'Tiger Girl', level: 20, hp: 50_000, rarity: 'unique', aggressive: true })
const MANG = { ...MANGNYANG, hp: 1000 }
const TOWN: TownDef = { code: 'TOWN', name: 'Town', world: 'jangan', spawn: { x: 0, y: 0, z: 0 }, safeArea: { x: -300, z: -300, halfX: 50, halfZ: 50 } }

function harness(opts: { nests?: ReturnType<typeof nest>[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-storm-'))
  const config = { ...testConfig(root), weather: 'auto' as const, stormsPerDay: undefined, rng: seeded(5), uniques: false }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANG, GHOST, BANDIT, TIGER, WATER, GIRL], items: ITEMS, levels: LEVELS, drops: [...DROPS, { ...DROPS[0]!, mob: TIGER.code }], nests: opts.nests ?? [], towns: [TOWN] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const g = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(5) })
  const storm = g.storm
  storm.pinned = true
  let n = 0
  const enter = (pos: Vec3) => {
    const acc = store.createAccount(`acc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const inbox: ServerMessage[] = []
    const send = (m: ServerMessage) => {
      const r = parseServerMessage(JSON.stringify(m))
      if (!r.ok) throw new Error(`the client would reject ${JSON.stringify(m)}: ${r.error}`)
      inbox.push(m)
    }
    const p = world.add({ ...g.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send })
    world.updateInterest(T0)
    p.hp = p.maxHp = 100_000
    return { p, inbox }
  }
  const spawn = (def: typeof GHOST, x: number, z: number, variant: Mob['variant'] = 'normal') => g.createMob(def, variant, x, z, 0, null, T0)
  const setEnv = (e: Partial<StormEnv>) => {
    storm.env = { ...CALM_ENV, ...e }
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { g, storm, world, data, enter, spawn, setEnv }
}

const RAIN: Partial<StormEnv> = { rain: 1, wet: 1 }
const STORM: Partial<StormEnv> = { rain: 1, storm: 1, windMs: 13, wet: 1 }

function strike(at: Vec3, hits: { id: number; kind: 'player' | 'mob'; damage: number; killed: boolean }[] = []) {
  const s: LightningStrike = { id: 1, at: T0, kind: 'ground', pos: at, radiusM: 4, seed: 1 }
  return { phase: 'land' as const, strike: s, hits }
}

describe('storm AI hooks (docs/WEATHER.md §12.2)', () => {
  it('rain cuts monster sight; a night storm cuts it more; calm leaves it; uniques and the steered boss keep theirs', () => {
    const h = harness()
    const ghost = h.spawn(GHOST, 50, 50)
    const girl = h.spawn(GIRL, 60, 60, 'unique')
    const boss = h.spawn(TIGER, 70, 70)
    boss.pilot = { player: null, steering: 'ai' }
    const base = ghost.sightRange
    h.setEnv({})
    expect(h.storm.sight(ghost)).toBe(base)
    h.setEnv(RAIN)
    expect(h.storm.sight(ghost)).toBeCloseTo(base * 0.6, 9)
    h.setEnv({ ...STORM, night: 1 })
    expect(h.storm.sight(ghost)).toBeCloseTo(base * 0.45, 9)
    expect(h.storm.sight(girl)).toBe(girl.sightRange)
    expect(h.storm.sight(boss)).toBe(boss.sightRange)
    expect(h.storm.speed(boss, 5)).toBe(5)
  })

  it('sneaking works: an aggressive monster misses a player at 7 m in a downpour and spots it when calm', () => {
    const h = harness()
    const ghost = h.spawn(GHOST, 100, 100)
    ghost.sightRange = 10
    const { p } = h.enter([107, 0, 100])
    h.g.now = T0 + 10
    h.setEnv(RAIN)
    thinkMob(ghost, h.g)
    expect(ghost.ai).toBe('idle')
    h.setEnv({})
    thinkMob(ghost, h.g)
    expect(ghost).toMatchObject({ ai: 'chase', target: p.id })
  })

  it('undead run faster only in a storm; bandits pull back (leash, roam) only in a storm', () => {
    const h = harness()
    const ghost = h.spawn(GHOST, 50, 50)
    const bandit = h.spawn(BANDIT, 80, 80)
    h.setEnv(RAIN)
    expect(h.storm.speed(ghost, 4)).toBe(4)
    expect(h.storm.leash(bandit)).toBe(bandit.leashRange)
    h.setEnv(STORM)
    expect(h.storm.speed(ghost, 4)).toBeCloseTo(5, 9)
    expect(h.storm.speed(bandit, 4)).toBe(4)
    expect(h.storm.leash(bandit)).toBeCloseTo(Math.max(10, bandit.leashRange * 0.5), 9)
    expect(h.storm.roam(bandit)).toBeCloseTo(bandit.roamRadius * 0.4, 9)
    expect(h.storm.leash(ghost)).toBe(ghost.leashRange)
  })
})

describe('storm combat hooks', () => {
  it('fire is weaker and lightning / cold stronger in the rain; no change when calm or at strength 0', () => {
    const h = harness()
    h.setEnv(RAIN)
    expect(h.storm.elementMul({ mastery: 'FIRE' })).toBeCloseTo(0.75, 9)
    expect(h.storm.elementMul({ mastery: 'LIGHTNING' })).toBeCloseTo(1.25, 9)
    expect(h.storm.elementMul({ mastery: 'COLD' })).toBeCloseTo(1.15, 9)
    expect(h.storm.elementMul({ mastery: 'BICHEON' })).toBe(1)
    h.setEnv({ ...RAIN, strength: 0 })
    expect(h.storm.elementMul({ mastery: 'FIRE' })).toBe(1)
    h.setEnv({})
    expect(h.storm.elementMul({ mastery: 'LIGHTNING' })).toBe(1)
  })

  it('undead hit 25% harder in a storm (dealHits), not in plain rain; a unique not at all', () => {
    const h = harness()
    const { p } = h.enter([0, 0, 0])
    const ghost = h.spawn(GHOST, 1, 0)
    const girl = h.spawn(GIRL, 2, 0, 'unique')
    const hit = () => [{ outcome: 'hit' as const, damage: 100, hp: 0 }]
    h.setEnv(RAIN)
    expect(h.g.dealHits(ghost, p, hit(), {}, T0).dealt).toBe(100)
    h.setEnv(STORM)
    expect(h.g.dealHits(ghost, p, hit(), {}, T0).dealt).toBe(125)
    expect(h.g.dealHits(girl, p, hit(), {}, T0).dealt).toBe(100)
  })

  it('strong wind spreads ranged attacks (bows), never melee, never in calm air', () => {
    const h = harness()
    const { p } = h.enter([0, 0, 0])
    const target = h.spawn(MANG, 5, 0)
    target.hp = target.maxHp = 1e9
    const misses = () => {
      let n = 0
      for (let i = 0; i < 400; i++) n += h.g.dealHits(p, target, [{ outcome: 'hit', damage: 1, hp: 0 }], {}, T0).hits[0]!.outcome === 'miss' ? 1 : 0
      return n
    }
    h.setEnv(STORM)
    expect(misses()).toBe(0) // a blade
    p.combat = { ...p.combat, weapon: 'bow' }
    const windy = misses()
    expect(windy).toBeGreaterThan(40)
    expect(windy).toBeLessThan(130)
    h.setEnv(RAIN)
    expect(misses()).toBe(0)
  })

  it('a wet player takes 20% more from lightning; dry, as before', () => {
    const h = harness()
    const { p } = h.enter([0, 0, 0])
    h.setEnv(RAIN)
    expect(h.g.hazardHit(p, 100, 'lightning', T0).dealt).toBe(120)
    h.setEnv({})
    expect(h.g.hazardHit(p, 100, 'lightning', T0).dealt).toBe(100)
  })
})

describe('thunder panic (docs/WEATHER.md §12.3)', () => {
  it('a strike near beasts drops their aggro and sends them running away; undead and far ones stay; they think again after', () => {
    const h = harness()
    const { p } = h.enter([0, 0, 0])
    const mang = h.spawn(MANG, 10, 0)
    const tiger = h.spawn(TIGER, 0, 12)
    const ghost = h.spawn(GHOST, -10, 0)
    const far = h.spawn(MANG, 100, 100)
    for (const m of [mang, tiger, ghost, far]) {
      m.ai = 'chase'
      m.target = p.id
    }
    h.setEnv(RAIN)
    h.g.now = T0
    h.storm['onStrike'](strike([0, 0, 0]))
    for (const m of [mang, tiger]) {
      expect(m).toMatchObject({ ai: 'idle', target: null })
      expect(h.storm.panicking(m, T0 + 1000)).toBe(true)
      expect(h.storm.sight(m)).toBe(0)
      const to = m.move!.to
      const from = h.world.positionAt(m, T0)
      expect(Math.hypot(to[0], to[2])).toBeGreaterThan(Math.hypot(from[0], from[2]) + 5)
    }
    expect(ghost).toMatchObject({ ai: 'chase', target: p.id })
    expect(far).toMatchObject({ ai: 'chase', target: p.id })
    expect(h.storm.panicking(mang, T0 + STORM_TABLE.panicMs[1] + 1)).toBe(false)
  })

  it('a sky flash panics nobody; a unique never panics', () => {
    const h = harness()
    const girl = h.spawn(GIRL, 5, 0, 'unique')
    const mang = h.spawn(MANG, 6, 0)
    h.setEnv(STORM)
    const e = strike([0, 0, 0])
    h.storm['onStrike']({ ...e, strike: { ...e.strike, kind: 'sky' } })
    expect(h.storm.panicking(mang, T0)).toBe(false)
    h.storm['onStrike'](e)
    expect(h.storm.panicking(mang, T0)).toBe(true)
    expect(h.storm.panicking(girl, T0)).toBe(false)
  })
})

describe('storm-charged monsters (docs/WEATHER.md §12.4)', () => {
  it('gains the charge by surviving a strike in a storm (not in plain rain, not if killed, never a unique) and shows it', () => {
    const h = harness()
    const { inbox } = h.enter([0, 0, 0])
    const tiger = h.spawn(TIGER, 30, 0)
    const dead = h.spawn(TIGER, 31, 0)
    const girl = h.spawn(GIRL, 32, 0, 'unique')
    h.world.updateInterest(T0)
    const hits = [
      { id: tiger.id, kind: 'mob' as const, damage: 10, killed: false },
      { id: dead.id, kind: 'mob' as const, damage: 10, killed: true },
      { id: girl.id, kind: 'mob' as const, damage: 10, killed: false },
    ]
    h.setEnv(RAIN)
    h.storm['onStrike'](strike([30, 0, 0], hits))
    expect(h.storm.isCharged(tiger)).toBe(false)
    h.setEnv(STORM)
    h.storm['onStrike'](strike([30, 0, 0], hits))
    expect(h.storm.isCharged(tiger)).toBe(true)
    expect(h.storm.isCharged(dead)).toBe(false)
    expect(h.storm.isCharged(girl)).toBe(false)
    expect(inbox.some((m) => m.t === 'entityUpdate' && m.id === tiger.id && m.charged === true)).toBe(true)
    expect(h.world.state(tiger).charged).toBe(true)
    expect(h.world.state(girl).charged).toBeUndefined()
  })

  it('hits harder and arcs to the nearest other player (once per cooldown, never into a town); a wet target takes more', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    const b = h.enter([4, 0, 0])
    const c = h.enter([-260, 0, -260]) // in town, far anyway
    const tiger = h.spawn(TIGER, 1, 0)
    h.setEnv(STORM)
    h.storm.charge(tiger, T0)
    const hp = b.p.hp
    const r = h.g.dealHits(tiger, a.p, [{ outcome: 'hit', damage: 100, hp: 0 }], {}, T0)
    expect(r.dealt).toBe(130)
    // 30% of the hit, wet: x1.2
    expect(hp - b.p.hp).toBe(Math.round(Math.round(130 * STORM_TABLE.chargedArcPct) * 1.2))
    const arc = b.inbox.find((m) => m.t === 'stormArc')
    expect(arc).toMatchObject({ t: 'stormArc', from: a.p.id, to: b.p.id, mob: tiger.id })
    expect(b.inbox.some((m) => m.t === 'combat' && m.cause === 'arc' && m.target === b.p.id && m.attacker === 0)).toBe(true)
    const hp2 = b.p.hp
    h.g.dealHits(tiger, a.p, [{ outcome: 'hit', damage: 100, hp: 0 }], {}, T0 + 1000)
    expect(b.p.hp).toBe(hp2) // cooldown
    h.g.dealHits(tiger, a.p, [{ outcome: 'hit', damage: 100, hp: 0 }], {}, T0 + STORM_TABLE.chargedArcCooldownMs + 1)
    expect(b.p.hp).toBeLessThan(hp2)
    expect(c.inbox.some((m) => m.t === 'stormArc')).toBe(false)
  })

  it('never arcs into a town: the only player near the target stands in the safe area', () => {
    const h = harness()
    const a = h.enter([-245, 0, -300]) // just outside the town (half extent 50 around -300)
    const b = h.enter([-251, 0, -300]) // 6 m away, inside it
    const tiger = h.spawn(TIGER, -244, -300)
    h.setEnv(STORM)
    h.storm.charge(tiger, T0)
    const hp = b.p.hp
    h.g.dealHits(tiger, a.p, [{ outcome: 'hit', damage: 100, hp: 0 }], {}, T0)
    expect(b.p.hp).toBe(hp)
    expect(b.inbox.some((m) => m.t === 'stormArc')).toBe(false)
  })

  it('drops better loot: twice the item chances, more gold, a chance of +1 on gear; an ordinary kill unchanged', () => {
    const h = harness()
    const tiger = h.spawn(TIGER, 1, 0)
    h.setEnv(STORM)
    expect(h.storm.lootBonus(tiger)).toEqual({ drop: 1, gold: 1 })
    h.storm.charge(tiger, T0)
    expect(h.storm.lootBonus(tiger)).toEqual({ drop: STORM_TABLE.chargedDropMul, gold: STORM_TABLE.chargedGoldMul })
    let plus = 0
    for (let i = 0; i < 400; i++) {
      const out = h.storm.plusLoot(tiger, [{ code: 'ITEM_CH_BLADE_02_A', count: 1 }, { code: 'ITEM_ETC_GOLD_01', count: 50, gold: true }, { code: 'ITEM_ETC_HP_POTION_01', count: 1 }])
      plus += out[0]!.plus ?? 0
      expect(out[1]!.plus).toBeUndefined()
      expect(out[2]!.plus).toBeUndefined()
    }
    expect(plus / 400).toBeGreaterThan(0.25)
    expect(plus / 400).toBeLessThan(0.45)
  })

  it('is cleared when the storm ends (told to the viewers) and when it dies', () => {
    const h = harness()
    const { inbox } = h.enter([0, 0, 0])
    const a = h.spawn(TIGER, 3, 0)
    const b = h.spawn(TIGER, 5, 0)
    h.world.updateInterest(T0)
    h.setEnv(STORM)
    h.storm.charge(a, T0)
    h.storm.charge(b, T0)
    h.g.mobDied(b, T0, true)
    expect(h.storm.isCharged(b)).toBe(false)
    h.storm.tick(T0)
    expect(h.storm.isCharged(a)).toBe(true)
    h.setEnv(RAIN)
    h.storm.tick(T0 + 2000)
    expect(h.storm.isCharged(a)).toBe(false)
    expect(inbox.some((m) => m.t === 'entityUpdate' && m.id === a.id && m.charged === false)).toBe(true)
    expect(h.storm.gm(['charge', String(a.id)], T0 + 3000).ok).toBe(false) // only during a storm
  })
})

describe('storm spawns, mud and the status', () => {
  it('water spirits rise, small animals hide, tigers come in bigger packs; all back after the storm', () => {
    const N = (id: number, code: string, count: number) => nest(id, code, 100 * id, 0, { count, radius: 5, spawnRadius: 3, respawnSec: [1, 1] })
    const h = harness({ nests: [N(1, MANG.code, 10), N(2, WATER.code, 5), N(3, TIGER.code, 4), N(4, GHOST.code, 5)] })
    h.g.start(T0)
    const alive = (id: number) => h.g.spawner.nest(id)!.alive.size
    expect([1, 2, 3, 4].map(alive)).toEqual([10, 5, 4, 5])
    h.setEnv(STORM)
    for (let i = 0; i < 6; i++) h.storm.reconcile(T0 + i * 5000)
    expect([1, 2, 3, 4].map(alive)).toEqual([4, 8, 6, 5])
    h.setEnv({})
    for (let i = 0; i < 6; i++) h.storm.reconcile(T0 + 60_000 + i * 5000)
    expect([1, 2, 3, 4].map(alive)).toEqual([10, 5, 4, 5])
  })

  it('a tiger on the chase calls its idle pack-mates in a storm (not otherwise)', () => {
    const h = harness({ nests: [nest(1, TIGER.code, 0, 0, { count: 3, radius: 3, spawnRadius: 2 })] })
    h.g.start(T0)
    const { p } = h.enter([10, 0, 0])
    const [first, ...rest] = [...h.g.spawner.nest(1)!.alive].map((id) => h.world.mobs.get(id)!)
    first!.ai = 'chase'
    first!.target = p.id
    h.setEnv(RAIN)
    h.storm['packs'](T0)
    expect(rest.every((m) => m.ai === 'idle')).toBe(true)
    h.setEnv(STORM)
    h.storm['packs'](T0)
    expect(rest.every((m) => m.ai === 'chase' && m.target === p.id)).toBe(true)
  })

  it('mud slows running on a soaked ground outside towns only, and lets go when it dries', () => {
    const h = harness()
    const field = h.enter([0, 0, 0])
    const town = h.enter([-300, 0, -300])
    h.setEnv({ rain: 1, wet: 0.9 })
    h.storm.tick(T0)
    expect(field.p.speedMul).toBeCloseTo(0.9, 9)
    expect(town.p.speedMul).toBe(1)
    expect(field.inbox.some((m) => m.t === 'stats')).toBe(true)
    h.setEnv({ wet: 0.3 })
    h.storm.tick(T0 + 2000)
    expect(field.p.speedMul).toBe(1)
  })

  it('sends the status when it changes (valid on the wire), to a late joiner unless calm; the GM command starts and stops storms', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    h.setEnv({ ...STORM, night: 1 })
    h.storm.tick(T0)
    const st = a.inbox.filter((m) => m.t === 'storm')
    expect(st).toHaveLength(1)
    expect(st[0]).toMatchObject({ storm: { phase: 'storm' } })
    h.storm.tick(T0 + 1500)
    expect(a.inbox.filter((m) => m.t === 'storm')).toHaveLength(1) // unchanged: not resent
    const late = h.enter([5, 0, 0])
    h.storm.enter(late.p)
    expect(late.inbox.some((m) => m.t === 'storm')).toBe(true)

    h.storm.pinned = false
    const start = h.storm.gm(['start', '12', '3'], T0 + 10_000)
    expect(start.ok).toBe(true)
    expect(h.storm.event(T0 + 11_000)).toMatchObject({ start: T0 + 10_000 + 180_000, end: T0 + 10_000 + 180_000 + 720_000, gm: true })
    expect(h.storm.gm(['stop'], T0 + 12_000).ok).toBe(true)
    expect(h.storm.event(T0 + 13_000)).toBeNull()
    expect(h.storm.gm(['preview'], T0).message).toMatch(/undead \+25%/)
    expect(h.storm.gm(['bogus'], T0).ok).toBe(false)
    expect(h.storm.gm([], T0).message).toMatch(/^Storm: /)
  })
})
