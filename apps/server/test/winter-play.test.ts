/**
 * The winter gameplay layer on the server (docs/WINTER.md §13; apps/server/src/winter-play/*): the season gate and the
 * `winterPlay` state; body warmth (rates by day, night and blizzard, fires and towns, the levels and their penalties,
 * no death from the cold alone, the warm drink); snowballs (the season and snow rule, never damage to a player, the
 * slow, the dodge, monsters, the stats and the board); snow spirits (season-only, refills, leaving); the Ice Yeti
 * (schedule, announcements, her kit, enrage, loot, respawn, retreat, the saved timer); gift boxes (drops and their
 * rates, opening, a full bag); the GM commands and the admin settings. Every message goes through the client's
 * validator. The weather is held clear, so the real-time schedule (a storm right now) never leaks in.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CALM_ENV,
  GIFT_TABLE,
  WINTER_CODES,
  WINTER_FIELDS,
  WINTER_PLAY,
  YETI_KIT,
  YETI_LAIRS,
  parseServerMessage,
  rollGift,
  warmthLossPerS,
  type ServerMessage,
  type TownDef,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { SETTINGS, checkSetting, SETTING_BY_KEY } from '../src/admin/settings.ts'
import type { ServerConfig } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { FireIndex, firesFromManifest } from '../src/winter-play/fires.ts'
import { winterKnobs } from '../src/winter-play/knobs.ts'
import { World, type Mob, type Player } from '../src/world.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, item, mob, seeded } from './fixtures.ts'

/** December 20th, noon UTC: in the default season (12-01..01-15, UTC below). */
const DEC = Date.UTC(2026, 11, 20, 12, 0, 0)
/** October: outside it. */
const OCT = Date.UTC(2026, 9, 5, 12, 0, 0)
const MIN = 60_000

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const TOWN: TownDef = { code: 'TOWN', name: 'Town', world: 'jangan', spawn: { x: 0, y: 0, z: 0 }, safeArea: { x: 0, z: 0, halfX: 40, halfZ: 40 } }
/** Outdoors, far from the town and every campfire. */
const FIELD: Vec3 = [600, 0, -600]

const GIFT_ITEMS = [
  item('ITEM_ETC_HP_POTION_02', { category: 'potion', maxStack: 50, use: { hp: 200 } }),
  item('ITEM_ETC_MP_POTION_02', { category: 'potion', maxStack: 50, use: { mp: 200 } }),
  item('ITEM_ETC_HP_POTION_03', { category: 'potion', maxStack: 50, use: { hp: 400 } }),
  item('ITEM_ETC_MP_POTION_03', { category: 'potion', maxStack: 50, use: { mp: 400 } }),
  item('ITEM_ETC_ALL_POTION_01', { category: 'potion', maxStack: 50, use: { hp: 100, mp: 100 } }),
  item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01', { category: 'alchemy', maxStack: 50 }),
  item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_02', { category: 'alchemy', maxStack: 50 }),
  item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', { category: 'alchemy', maxStack: 50 }),
  item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', { category: 'alchemy' }),
  item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A', { category: 'alchemy' }),
  item('ITEM_ETC_SCROLL_RETURN_01', { category: 'scroll', maxStack: 50 }),
]

type Harness = ReturnType<typeof harness>

function harness(over: Partial<ServerConfig> = {}, start = DEC) {
  const root = mkdtempSync(join(tmpdir(), 'sro-winterplay-'))
  const config: ServerConfig = {
    ...testConfig(root),
    rng: seeded(7),
    uniques: false,
    weather: 'clear',
    winterEnabled: true,
    winterStart: '12-01',
    winterEnd: '01-15',
    winterTz: 'UTC',
    // GM-free tests: no nest monsters besides the ones a test spawns
    ...over,
  }
  const store = openStore(config.dataDir)
  const bounds = { minX: -1500, minZ: -1500, maxX: 1500, maxZ: 1500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5.5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const TIGER = mob('MOB_CH_TIGER', { name: 'Tiger', level: 10, hp: 5000, physAttack: [10, 12] })
  const data = new GameData({ mobs: [MANGNYANG, TIGER], items: [...ITEMS, ...GIFT_ITEMS], levels: LEVELS, drops: DROPS, nests: [], towns: [TOWN], shops: [{ id: 'STORE_CH_POTION', npcs: ['NPC_CH_POTION'], tabs: [{ name: 'Potion', items: ['ITEM_ETC_HP_POTION_01'] }], provenance: 'client' }] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const g = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(7) })
  // a fixed day (the clock's night would change the cold); tests that want night say so
  let night = 0
  ;(g as unknown as { daylight: (now: number) => number }).daylight = () => 1 - night
  g.storm.pinned = true
  g.storm.env = { ...CALM_ENV }
  let n = 0
  const players: { p: Player; inbox: ServerMessage[] }[] = []
  const enter = (pos: Vec3, now = start) => {
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
    world.updateInterest(now)
    g.sendEnter(p, now)
    const h = { p, inbox }
    players.push(h)
    return h
  }
  let clock = start
  /** Runs Gameplay ticks every `step` ms up to `to` (the server's tick, so every module hook runs). */
  const run = (to: number, step = 100) => {
    for (let t = clock + step; t <= to; t += step) {
      world.updateInterest(t)
      g.tick(t)
    }
    clock = Math.max(clock, to)
    return clock
  }
  const req = (p: Player, inbox: ServerMessage[], msg: Parameters<Gameplay['request']>[1], now = clock) => {
    const from = inbox.length
    g.request(p, msg, now)
    return inbox.slice(from).find((m): m is Extract<ServerMessage, { t: 'actionResult' }> => m.t === 'actionResult')!
  }
  const of = <T extends ServerMessage['t']>(inbox: ServerMessage[], t: T) => inbox.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t)
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    g,
    play: g.winterPlay,
    world,
    data,
    store,
    config,
    enter,
    run,
    req,
    of,
    get now() {
      return clock
    },
    setNight: (v: number) => (night = v),
    players,
  }
}

/** Turns the layer on (one tick) and lays a full snow cover. */
function snowy(h: Harness): void {
  h.g.winter.gm(['cover', '1'], h.now)
  h.run(h.now + 1000)
}

const warmthOf = (inbox: ServerMessage[]) => inbox.filter((m): m is Extract<ServerMessage, { t: 'warmth' }> => m.t === 'warmth').at(-1)?.warmth

// ---- the gate ---------------------------------------------------------------------------------------------------

describe('the season gate (docs/WINTER.md §13)', () => {
  it('is off outside the season and with WINTER_PLAY off; on in the season and while a GM previews it', () => {
    const oct = harness({}, OCT)
    oct.run(OCT + 2000)
    expect(oct.play.isOn).toBe(false)
    oct.g.winter.gm(['preview', 'on'], oct.now)
    oct.run(oct.now + 1100)
    expect(oct.play.isOn).toBe(true)
    oct.g.winter.gm(['preview', 'off'], oct.now)
    oct.run(oct.now + 1100)
    expect(oct.play.isOn).toBe(false)

    const dec = harness()
    dec.run(DEC + 1100)
    expect(dec.play.isOn).toBe(true)
    const off = harness({ winterPlay: false })
    off.run(DEC + 1100)
    expect(off.play.isOn).toBe(false)
  })

  it('tells everyone when it turns on or off (with the campfires) and a late joiner on entering', () => {
    const h = harness({}, OCT)
    const a = h.enter(FIELD, OCT)
    expect(h.of(a.inbox, 'winterPlay')).toHaveLength(0)
    h.g.winter.gm(['preview', 'on'], h.now)
    h.run(h.now + 1100)
    const on = h.of(a.inbox, 'winterPlay').at(-1)!.play
    expect(on.on).toBe(true)
    expect(on.snowballs).toBe(true) // a preview draws full cover
    expect(on.fires!.length).toBeGreaterThan(3)
    expect(on.season).toBe('2026-27')
    const b = h.enter(FIELD, h.now)
    expect(h.of(b.inbox, 'winterPlay').at(-1)!.play.on).toBe(true)
    h.g.winter.gm(['preview', 'off'], h.now)
    h.run(h.now + 1100)
    expect(h.of(a.inbox, 'winterPlay').at(-1)!.play).toEqual({ on: false, snowballs: false })
  })

  it('the admin switch and knobs apply live; the Winter tab of the potion shop exists only while on', () => {
    const h = harness()
    h.run(DEC + 1100)
    expect(h.data.shops.get('STORE_CH_POTION')!.tabs.map((t) => t.name)).toEqual(['Potion', 'Winter'])
    expect(h.g.shops.goods('NPC_CH_POTION').has(WINTER_CODES.tea)).toBe(true)
    h.config.winterPlay = false
    h.play.refresh(h.now)
    expect(h.play.isOn).toBe(false)
    expect(h.data.shops.get('STORE_CH_POTION')!.tabs.map((t) => t.name)).toEqual(['Potion'])
    expect(h.g.shops.goods('NPC_CH_POTION').has(WINTER_CODES.tea)).toBe(false)
  })

  it('installs the winter content without replacing anything', () => {
    const h = harness()
    expect(h.data.mob(WINTER_CODES.yeti)).toMatchObject({ name: 'Ice Yeti', rarity: 'unique', scale: 260 })
    expect(h.data.mob(WINTER_CODES.spirit)).toMatchObject({ name: 'Snow Spirit', aggressive: true })
    expect(h.data.item(WINTER_CODES.gift)?.use?.gift).toBe(true)
    expect(h.data.item(WINTER_CODES.tea)?.use?.warmth).toBe(WINTER_PLAY.tea.warmth)
    expect(h.data.mob('MOB_CH_MANGNYANG')).toBe(MANGNYANG)
  })
})

// ---- warmth -------------------------------------------------------------------------------------------------------

describe('body warmth (docs/WINTER.md §13.1)', () => {
  it('outdoors by day it falls 6 a minute; at night 1.5 x; in a blizzard 2.5 x; the client hears value and rate', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.run(DEC + MIN)
    expect(h.play.warmth.value(a.p)).toBeCloseTo(100 - 6 * (MIN - 1000) / MIN, 0)
    const w = warmthOf(a.inbox)!
    expect(w.rate).toBeCloseTo(-0.1, 3)
    expect(w.level).toBe('warm')
    expect(warmthLossPerS({ night: 1, snow: 0, storm: 0 })).toBeCloseTo(0.15)
    expect(warmthLossPerS({ night: 0, snow: 1, storm: 1 })).toBeCloseTo(0.25)
    expect(warmthLossPerS({ night: 0, snow: 0.5, storm: 0 })).toBeCloseTo(0.125)
    h.g.storm.env = { ...CALM_ENV, snow: 1, storm: 1 }
    const before = h.play.warmth.value(a.p)
    h.run(h.now + 10_000)
    expect(before - h.play.warmth.value(a.p)).toBeCloseTo(2.5, 0)
    h.setNight(1)
    h.g.storm.env = { ...CALM_ENV }
    const b2 = h.play.warmth.value(a.p)
    h.run(h.now + 10_000)
    expect(b2 - h.play.warmth.value(a.p)).toBeCloseTo(1.5, 0)
  })

  it('a campfire warms within its reach; a town warms and never penalises; the sources are told', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.play.warmth.add(a.p, -60, DEC)
    // a campfire 3 m away
    h.play.fires.add({ kind: 'campfire', x: FIELD[0] + 3, y: 0, z: FIELD[2] })
    h.run(DEC + 5000)
    expect(h.play.warmth.value(a.p)).toBeGreaterThan(60)
    expect(warmthOf(a.inbox)).toMatchObject({ source: 'fire' })
    // a lamp only warms within 3.5 m
    const fires = new FireIndex([{ kind: 'lamp', x: 0, y: 0, z: 0 }])
    expect(fires.warmest(3, 0, 0)?.kind).toBe('lamp')
    expect(fires.warmest(4, 0, 0)).toBeNull()
    expect(fires.warmest(1, 10, 0)).toBeNull() // a lamp high on a wall
    // the town: no loss, a rise, and no penalty at any value
    const t = h.enter([5, 0, 5])
    h.play.warmth.add(t.p, -100, h.now)
    expect(h.play.warmth.level(t.p)).toBe('freezing')
    h.run(h.now + 1000)
    expect(h.play.warmth.level(t.p)).toBe('warm')
    expect(h.play.regenMul(t.p)).toBe(1)
    expect(h.play.slowPct(t.p)).toBe(0)
    expect(warmthOf(t.inbox)).toMatchObject({ safe: true, source: 'town', level: 'warm' })
  })

  it('the levels: chilly slows regen; cold and freezing slow running; the speed comes back when warm', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.run(DEC + 1000)
    const speed = a.p.speedMul
    h.play.warmth.add(a.p, -55, h.now)
    expect(h.play.warmth.level(a.p)).toBe('chilly')
    expect(h.play.regenMul(a.p)).toBe(0.75)
    expect(a.p.speedMul).toBeCloseTo(speed)
    h.play.warmth.add(a.p, -25, h.now)
    expect(h.play.warmth.level(a.p)).toBe('cold')
    expect(a.p.speedMul).toBeCloseTo(speed * 0.92)
    h.play.warmth.add(a.p, -100, h.now)
    expect(h.play.warmth.level(a.p)).toBe('freezing')
    expect(h.play.regenMul(a.p)).toBe(0)
    expect(a.p.speedMul).toBeCloseTo(speed * 0.88)
    h.play.warmth.add(a.p, 100, h.now)
    expect(a.p.speedMul).toBeCloseTo(speed)
  })

  it('freezing drains 1 % of max HP every 5 s but never below 10 %: the cold alone never kills', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.play.warmth.add(a.p, -100, DEC)
    h.run(DEC + 30 * MIN, 1000)
    expect(a.p.dead).toBe(false)
    expect(a.p.hp).toBe(Math.ceil(a.p.maxHp * 0.1))
    expect(h.of(a.inbox, 'warmth').some((m) => (m.warmth.drained ?? 0) > 0)).toBe(true)
    // a body already under the floor loses nothing
    a.p.hp = 5
    h.run(h.now + MIN, 1000)
    expect(a.p.hp).toBe(5)
    // COLD_DRAIN_PCT 0: no drain at all
    const z = harness({ coldDrainPct: 0 })
    const b = z.enter(FIELD)
    z.play.warmth.add(b.p, -100, DEC)
    z.run(DEC + 2 * MIN, 1000)
    expect(b.p.hp).toBe(b.p.maxHp)
  })

  it('Ginger Tea warms at once and slows the loss; out of the season it is refused and kept', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.run(DEC + 1000)
    h.play.warmth.add(a.p, -60, h.now)
    h.g.gmItem(a.p, h.data.item(WINTER_CODES.tea)!, WINTER_CODES.tea, 2)
    const bag = h.store.loadInventory(a.p.characterId).bag.findIndex((i) => i?.code === WINTER_CODES.tea)
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag })).toMatchObject({ ok: true })
    expect(h.play.warmth.value(a.p)).toBeCloseTo(40 + WINTER_PLAY.tea.warmth, 0)
    const before = h.play.warmth.value(a.p)
    h.run(h.now + 10_000)
    expect(before - h.play.warmth.value(a.p)).toBeCloseTo(0.5, 0) // the glow halves the 1 / 10 s loss
    expect(warmthOf(a.inbox)?.source).toBe('tea')

    const o = harness({}, OCT)
    const b = o.enter(FIELD, OCT)
    o.run(OCT + 1000)
    o.g.gmItem(b.p, o.data.item(WINTER_CODES.tea)!, WINTER_CODES.tea, 1)
    const slot = o.store.loadInventory(b.p.characterId).bag.findIndex((i) => i?.code === WINTER_CODES.tea)
    expect(o.req(b.p, b.inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(o.store.loadInventory(b.p.characterId).bag[slot]?.code).toBe(WINTER_CODES.tea)
  })

  it('is silent outside the season: nobody gets a warmth message, every penalty ends when it closes', () => {
    const h = harness({}, OCT)
    const a = h.enter(FIELD, OCT)
    h.run(OCT + 5 * MIN, 1000)
    expect(h.of(a.inbox, 'warmth')).toHaveLength(0)
    expect(h.play.warmth.level(a.p)).toBe('warm')
    h.g.winter.gm(['preview', 'on'], h.now)
    h.run(h.now + 2000)
    h.play.warmth.add(a.p, -100, h.now)
    const speed = a.p.speedMul
    h.g.winter.gm(['preview', 'off'], h.now)
    h.run(h.now + 2000)
    expect(h.play.warmth.level(a.p)).toBe('warm')
    expect(a.p.speedMul).toBeCloseTo(speed / 0.88)
  })
})

// ---- snowballs ------------------------------------------------------------------------------------------------------

describe('snowballs (docs/WINTER.md §13.2)', () => {
  it('only in the season and in deep enough snow; refused while riding is not tested here; the cooldown holds', () => {
    const o = harness({}, OCT)
    const a = o.enter(FIELD, OCT)
    const b = o.enter([FIELD[0] + 5, 0, FIELD[2]], OCT)
    o.run(OCT + 1000)
    expect(o.req(a.p, a.inbox, { t: 'snowball', target: b.p.id })).toMatchObject({ ok: false, reason: 'not_usable' })

    const h = harness()
    const c = h.enter(FIELD)
    const d = h.enter([FIELD[0] + 5, 0, FIELD[2]])
    h.run(DEC + 1000)
    // the season, but no snow on the ground yet
    expect(h.req(c.p, c.inbox, { t: 'snowball', target: d.p.id })).toMatchObject({ ok: false, reason: 'not_usable', message: expect.stringMatching(/snow/) })
    snowy(h)
    expect(h.req(c.p, c.inbox, { t: 'snowball', target: d.p.id })).toMatchObject({ ok: true })
    expect(h.req(c.p, c.inbox, { t: 'snowball', target: d.p.id })).toMatchObject({ ok: false, reason: 'cooldown' })
    // too far
    const far = h.enter([FIELD[0] + 30, 0, FIELD[2]])
    h.run(h.now + 1300)
    expect(h.req(c.p, c.inbox, { t: 'snowball', target: far.p.id })).toMatchObject({ ok: false, reason: 'too_far' })
  })

  it('a hit never hurts a player: a short slow, a Splat for everyone, the score for the thrower', () => {
    const h = harness()
    snowy(h)
    const a = h.enter(FIELD)
    const b = h.enter([FIELD[0] + 8, 0, FIELD[2]])
    h.run(h.now + 200)
    const hp = b.p.hp
    const speed = b.p.speedMul
    expect(h.req(a.p, a.inbox, { t: 'snowball', target: b.p.id })).toMatchObject({ ok: true })
    const fly = h.of(b.inbox, 'snowball').at(-1)!
    expect(fly).toMatchObject({ from: a.p.id, target: b.p.id })
    expect(fly.ms).toBeGreaterThan(500)
    h.run(h.now + fly.ms + 100)
    const splat = h.of(b.inbox, 'snowballSplat').at(-1)!
    expect(splat).toMatchObject({ id: fly.id, hit: b.p.id, slowMs: WINTER_PLAY.snowball.slowMs })
    expect(splat.score).toBeUndefined()
    expect(h.of(a.inbox, 'snowballSplat').at(-1)!.score).toBe(1)
    expect(b.p.hp).toBe(hp)
    expect(b.p.speedMul).toBeCloseTo(speed * 0.7)
    expect(h.of(b.inbox, 'combat')).toHaveLength(0)
    h.run(h.now + WINTER_PLAY.snowball.slowMs + 200)
    expect(b.p.speedMul).toBeCloseTo(speed)
    expect(h.play.snowballs.stats(a.p.characterId, h.now)).toMatchObject({ hits: 1, thrown: 1 })
    expect(h.play.snowballs.stats(b.p.characterId, h.now)).toMatchObject({ hit_by: 1 })
    expect(h.play.snowballs.inFlight).toBe(0)
  })

  it('a target that runs far enough dodges it; a ground throw splats whoever stands there; works in town', () => {
    const h = harness()
    snowy(h)
    const a = h.enter(FIELD)
    const b = h.enter([FIELD[0] + 15, 0, FIELD[2]])
    h.run(h.now + 200)
    h.req(a.p, a.inbox, { t: 'snowball', target: b.p.id })
    h.world.warp(b.p, FIELD[0] + 15, 0, FIELD[2] + 6, h.now)
    h.run(h.now + 2000)
    expect(h.of(a.inbox, 'snowballSplat').at(-1)!.hit).toBeUndefined()
    // ground throw at a point near b
    h.run(h.now + 1300)
    expect(h.req(a.p, a.inbox, { t: 'snowball', x: FIELD[0] + 15, z: FIELD[2] + 6.5 })).toMatchObject({ ok: true })
    h.run(h.now + 2000)
    expect(h.of(a.inbox, 'snowballSplat').at(-1)!.hit).toBe(b.p.id)
    // in town
    const t1 = h.enter([2, 0, 2])
    const t2 = h.enter([6, 0, 2])
    h.run(h.now + 200)
    expect(h.req(t1.p, t1.inbox, { t: 'snowball', target: t2.p.id })).toMatchObject({ ok: true })
    h.run(h.now + 1500)
    expect(h.of(t2.inbox, 'snowballSplat').at(-1)!.hit).toBe(t2.p.id)
  })

  it('a monster hit takes 1 damage and turns on the thrower (never from a town)', () => {
    const h = harness()
    snowy(h)
    const a = h.enter(FIELD)
    const m = h.g.createMob(MANGNYANG, 'normal', FIELD[0] + 6, FIELD[2], 0, null, h.now)
    m.hp = m.maxHp = 100
    h.run(h.now + 200)
    expect(h.req(a.p, a.inbox, { t: 'snowball', target: m.id })).toMatchObject({ ok: true })
    h.run(h.now + 1200)
    expect(m.hp).toBe(99)
    expect(m.damage.get(a.p.id)).toBe(1)
  })

  it('the board ranks this winter\'s hits; GM test, stats and reset', () => {
    const h = harness({}, OCT)
    const a = h.enter(FIELD, OCT)
    const b = h.enter([FIELD[0] + 5, 0, FIELD[2]], OCT)
    h.run(OCT + 1000)
    expect(h.play.snowballs.gm(a.p, ['test', '60'], h.now)).toMatchObject({ ok: true })
    h.run(h.now + 1100)
    expect(h.of(a.inbox, 'winterPlay').at(-1)!.play.snowballs).toBe(true)
    for (let i = 0; i < 3; i++) {
      expect(h.req(a.p, a.inbox, { t: 'snowball', target: b.p.id })).toMatchObject({ ok: true })
      h.run(h.now + 1300)
    }
    h.req(b.p, b.inbox, { t: 'snowball', target: a.p.id })
    h.run(h.now + 1300)
    h.req(a.p, a.inbox, { t: 'winterBoard' })
    const board = h.of(a.inbox, 'winterBoard').at(-1)!.board
    expect(board.top).toEqual([{ name: a.p.name, hits: 3 }, { name: b.p.name, hits: 1 }])
    expect(board.me).toEqual({ hits: 3, thrown: 3, hitBy: 1, rank: 1 })
    expect(board.season).toBe('2026-27')
    expect(h.play.snowballs.gm(a.p, ['stats', b.p.name], h.now).message).toMatch(/1 hits/)
    expect(h.play.snowballs.gm(a.p, ['reset'], h.now)).toMatchObject({ ok: true })
    expect(h.play.snowballs.board(a.p, h.now).top).toEqual([])
    expect(h.play.snowballs.gm(a.p, ['test', '0'], h.now)).toMatchObject({ ok: true })
    h.run(h.now + 1300)
    expect(h.req(a.p, a.inbox, { t: 'snowball', target: b.p.id })).toMatchObject({ ok: false })
  })
})

// ---- snow spirits ---------------------------------------------------------------------------------------------------

describe('snow spirits (docs/WINTER.md §13.3)', () => {
  const spirits = (h: Harness): Mob[] => [...h.world.mobs.values()].filter((m) => m.def.code === WINTER_CODES.sprite || m.def.code === WINTER_CODES.spirit)

  it('fill their fields in the season, refill after a death, and leave when it ends', () => {
    const h = harness({}, OCT)
    h.run(OCT + 6000)
    expect(spirits(h)).toHaveLength(0)
    h.g.winter.gm(['preview', 'on'], h.now)
    h.run(h.now + 6000)
    const want = WINTER_FIELDS.reduce((s, f) => s + f.count, 0)
    expect(spirits(h)).toHaveLength(want)
    const victim = spirits(h)[0]!
    h.g.mobDied(victim, h.now, true)
    h.run(h.now + 6000)
    expect(spirits(h).filter((m) => m.ai !== 'dead')).toHaveLength(want - 1)
    h.run(h.now + 95_000, 1000)
    expect(spirits(h).filter((m) => m.ai !== 'dead')).toHaveLength(want)
    h.g.winter.gm(['preview', 'off'], h.now)
    h.run(h.now + 3 * MIN, 1000)
    expect(spirits(h)).toHaveLength(0)
    expect(h.play.monsters.count).toBe(0)
  })

  it('SNOW_SPIRIT_SCALE scales the fields (0 = none)', () => {
    const h = harness({ snowSpiritScale: 0 })
    h.run(DEC + 6000)
    expect(spirits(h)).toHaveLength(0)
  })
})

// ---- the Ice Yeti ---------------------------------------------------------------------------------------------------

describe('the Ice Yeti (docs/WINTER.md §13.4)', () => {
  const yeti = (h: Harness) => h.play.yeti.live()

  it('spawns 10-30 min into the season at a lair, announced with her roar for those near; the timer is saved', () => {
    const h = harness()
    const far = h.enter(FIELD)
    const lair = YETI_LAIRS[0]!
    const near = h.enter([lair.x + 20, 0, lair.z])
    h.run(DEC + 2000)
    expect(yeti(h)).toBeNull()
    const due = h.play.yeti.dueAt
    expect(due - DEC).toBeGreaterThanOrEqual(10 * MIN - 2000)
    expect(due - DEC).toBeLessThanOrEqual(30 * MIN)
    h.run(due + 1000, 1000)
    const m = yeti(h)!
    expect(m).not.toBeNull()
    expect(m.variant).toBe('unique')
    expect(m.maxHp).toBe(30_000)
    const nf = h.of(far.inbox, 'uniqueNotice').at(-1)!
    expect(nf).toMatchObject({ event: 'appeared', mob: WINTER_CODES.yeti, name: 'Ice Yeti' })
    expect(nf.roar).toBeUndefined()
    // the lair nearest `near` may not be the one rolled; the roar goes to whoever is within 120 m of her
    const at = h.world.positionAt(m, h.now)
    const heard = Math.hypot(at[0] - near.p.pos[0], at[2] - near.p.pos[2]) <= 120
    expect(h.of(near.inbox, 'uniqueNotice').at(-1)!.roar === true).toBe(heard)
    const row = h.store.db.prepare('SELECT phase, spawns FROM uniques WHERE code = ?').get(WINTER_CODES.yeti)
    expect(row).toEqual({ phase: 'alive', spawns: 1 })
  })

  it('her kit: telegraphs first; the slam hits around her, the breath only in its cone, the roar chills; the barrage throws big snowballs', () => {
    const h = harness()
    h.run(DEC + 1100)
    const lair = YETI_LAIRS[0]!
    const m = h.play.yeti.spawn(h.now, { point: { x: lair.x, y: 0, z: lair.z, surface: null }, lair: 0 })!
    m.yaw = 0
    // she stays put unless the test winds her up (no aggro, no kit of her own)
    m.aggressive = false
    // feather-light blows: the test is about who is reached, not about surviving her
    m.combat = { ...m.combat, physAttack: [1, 1], magAttack: [0, 0] }
    const front = h.enter([lair.x, 0, lair.z + 5])
    const behind = h.enter([lair.x, 0, lair.z - 5])
    const out = h.enter([lair.x + 9, 0, lair.z])
    h.run(h.now + 200)
    // the slam: front and behind (5 m) hit, `out` (9 m) not
    h.play.yeti.windUp(m, 'slam', front.p, h.now)
    const tg = h.of(front.inbox, 'yetiSkill').at(-1)!
    expect(tg).toMatchObject({ skill: 'slam', castMs: YETI_KIT.slam.castMs, radiusM: YETI_KIT.slam.radiusM })
    expect(m.holdUntil).toBeGreaterThan(h.now)
    // her moves land as area hits (aoe); her basic swings may come meanwhile
    expect(h.of(front.inbox, 'combat').filter((c) => c.attacker === m.id && c.aoe)).toHaveLength(0)
    h.run(h.now + YETI_KIT.slam.castMs + 200)
    const hit = (x: { p: Player; inbox: ServerMessage[] }) => h.of(x.inbox, 'combat').some((c) => c.attacker === m.id && c.target === x.p.id && c.aoe)
    expect(hit(front)).toBe(true)
    expect(hit(behind)).toBe(true)
    expect(hit(out)).toBe(false)
    expect(m.holdUntil).toBeUndefined()
    // the breath faces `front`: `behind` is out of the cone
    const behindHits = () => h.of(behind.inbox, 'combat').filter((c) => c.target === behind.p.id && c.attacker === m.id && c.aoe).length
    const fb = behindHits()
    const ff = h.of(front.inbox, 'combat').filter((c) => c.aoe).length
    const warmFront = h.play.warmth.value(front.p)
    h.play.yeti.windUp(m, 'breath', front.p, h.now)
    expect(h.of(front.inbox, 'yetiSkill').at(-1)!.angleDeg).toBe(YETI_KIT.breath.angleDeg)
    h.run(h.now + YETI_KIT.breath.castMs + 200)
    expect(h.of(front.inbox, 'combat').filter((c) => c.aoe).length).toBeGreaterThan(ff)
    expect(behindHits()).toBe(fb)
    expect(h.play.warmth.value(front.p)).toBeLessThan(warmFront - 20)
    // the barrage: big snowballs flying from her to the players near
    h.play.yeti.windUp(m, 'barrage', front.p, h.now)
    h.run(h.now + YETI_KIT.barrage.castMs + 200)
    const balls = h.of(out.inbox, 'snowball').filter((s) => s.from === m.id)
    expect(balls.length).toBe(YETI_KIT.barrage.count)
    expect(balls.every((b) => b.big)).toBe(true)
    h.run(h.now + 4000)
    expect(h.play.snowballs.inFlight).toBe(0)
    // the roar chills `out` (within 16 m) without damage
    const w = h.play.warmth.value(out.p)
    const c0 = h.of(out.inbox, 'combat').filter((c) => c.target === out.p.id && c.aoe).length
    h.play.yeti.windUp(m, 'roar', front.p, h.now)
    h.run(h.now + YETI_KIT.roar.castMs + 200)
    expect(h.play.warmth.value(out.p)).toBeLessThanOrEqual(w - YETI_KIT.roar.chill + 0.5)
    expect(h.of(out.inbox, 'combat').filter((c) => c.target === out.p.id && c.aoe).length).toBe(c0)
  })

  it('enrages below 30 % and calls two snow spirits with her first roar below half HP; a reset clears both', () => {
    const h = harness({ snowSpiritScale: 0 })
    h.run(DEC + 1100)
    const lair = YETI_LAIRS[0]!
    const m = h.play.yeti.spawn(h.now, { point: { x: lair.x, y: 0, z: lair.z, surface: null }, lair: 0 })!
    m.combat = { ...m.combat, physAttack: [1, 1], magAttack: [0, 0] }
    const a = h.enter([lair.x + 4, 0, lair.z])
    h.run(h.now + 200)
    m.hp = m.maxHp * 0.45
    m.damage.set(a.p.id, 100)
    m.ai = 'chase'
    m.target = a.p.id
    h.play.yeti.windUp(m, 'roar', a.p, h.now)
    h.run(h.now + 1000)
    const adds = [...h.world.mobs.values()].filter((x) => x.def.code === WINTER_CODES.spirit && x.ai !== 'dead')
    expect(adds).toHaveLength(WINTER_PLAY.yeti.adds)
    m.hp = m.maxHp * 0.2
    h.run(h.now + 200)
    expect(m.damageMul).toBe(WINTER_PLAY.yeti.enrageDamageMul)
    // the leash reset: everyone gone, she runs home
    h.world.warp(a.p, FIELD[0], 0, FIELD[2], h.now)
    m.ai = 'return'
    m.target = null
    m.damage.clear()
    h.run(h.now + 200)
    expect(m.damageMul).toBeUndefined()
    expect([...h.world.mobs.values()].filter((x) => x.def.code === WINTER_CODES.spirit && x.ai !== 'dead' && adds.includes(x))).toHaveLength(0)
  })

  it('her death is announced with the loot owner; she drops gift boxes and gold; the respawn timer is about YETI_RESPAWN_MIN', () => {
    const h = harness({ yetiRespawnMin: 60 })
    h.run(DEC + 1100)
    const lair = YETI_LAIRS[1]!
    const m = h.play.yeti.spawn(h.now, { point: { x: lair.x, y: 0, z: lair.z, surface: null }, lair: 1 })!
    const a = h.enter([lair.x + 3, 0, lair.z])
    h.run(h.now + 200)
    m.damage.set(a.p.id, m.maxHp)
    h.g.mobDied(m, h.now, true)
    expect(h.of(a.inbox, 'uniqueNotice').at(-1)).toMatchObject({ event: 'defeated', mob: WINTER_CODES.yeti, by: a.p.name })
    const loot = [...h.world.items.values()]
    expect(loot.find((i) => i.code === WINTER_CODES.gift)?.count).toBe(WINTER_PLAY.gifts.yetiCount)
    expect(loot.filter((i) => /^ITEM_ETC_GOLD_/.test(i.code))).toHaveLength(3)
    const due = h.play.yeti.dueAt - h.now
    expect(due).toBeGreaterThanOrEqual(45 * MIN - 1000)
    expect(due).toBeLessThanOrEqual(75 * MIN + 1000)
    expect(h.store.db.prepare('SELECT phase, last_killer FROM uniques WHERE code = ?').get(WINTER_CODES.yeti)).toEqual({ phase: 'waiting', last_killer: a.p.name })
  })

  it('retreats (despawns) when the season ends, silently; a GM kill is silent too; GM spawn, timer and status', () => {
    const h = harness({}, OCT)
    const a = h.enter(FIELD, OCT)
    h.g.winter.gm(['preview', 'on'], h.now)
    h.run(OCT + 1100)
    expect(h.play.yeti.gm(a.p, ['spawn'], h.now)).toMatchObject({ ok: true })
    expect(h.play.yeti.live()).not.toBeNull()
    expect(h.play.yeti.gm(a.p, [], h.now).message).toMatch(/alive/)
    h.g.winter.gm(['preview', 'off'], h.now)
    h.run(h.now + 1100)
    expect(h.play.yeti.live()).toBeNull()
    expect(h.play.yeti.dueAt).toBe(0)
    expect(h.of(a.inbox, 'uniqueNotice').filter((n) => n.event === 'defeated')).toHaveLength(0)
    expect(h.play.yeti.gm(a.p, ['timer', '5'], h.now)).toMatchObject({ ok: true })
    expect(h.play.yeti.dueAt - h.now).toBe(5 * MIN)
    expect(h.play.yeti.gm(a.p, ['nonsense'], h.now)).toMatchObject({ ok: false })
  })

  it('a restart while she was alive brings her back 1-2 min after the boot', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-yeti-row-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const store = openStore(root)
    store.db.prepare("INSERT INTO uniques (code, phase, due_at, camp, spawns) VALUES (?, 'alive', 0, 1, 3)").run(WINTER_CODES.yeti)
    store.close()
    const h = harness({ dataDir: root })
    h.run(DEC + 1100)
    const due = h.play.yeti.dueAt - DEC
    expect(due).toBeGreaterThanOrEqual(MIN - 1000)
    expect(due).toBeLessThanOrEqual(2 * MIN + 1000)
  })
})

// ---- gift boxes -----------------------------------------------------------------------------------------------------

describe('gift boxes (docs/WINTER.md §13.5)', () => {
  const kill = (h: Harness, killer: Player) => {
    const m = h.g.createMob(MANGNYANG, 'normal', FIELD[0] + 2, FIELD[2], 0, null, h.now)
    m.damage.set(killer.id, m.maxHp)
    h.g.mobDied(m, h.now, true)
  }
  const boxes = (h: Harness) => [...h.world.items.values()].filter((i) => i.code === WINTER_CODES.gift).length

  it('drop from season kills at GIFT_DROP_PCT; never outside the season; never from a GM kill', () => {
    const h = harness({ giftDropPct: 100 })
    const a = h.enter(FIELD)
    h.run(DEC + 1100)
    kill(h, a.p)
    expect(boxes(h)).toBe(1)
    const m = h.g.createMob(MANGNYANG, 'normal', FIELD[0] + 2, FIELD[2], 0, null, h.now)
    h.g.gmKill(m, h.now)
    expect(boxes(h)).toBe(1)
    const none = harness({ giftDropPct: 0 })
    const b = none.enter(FIELD)
    none.run(DEC + 1100)
    for (let i = 0; i < 20; i++) kill(none, b.p)
    expect(boxes(none)).toBe(0)
    const oct = harness({ giftDropPct: 100 }, OCT)
    const c = oct.enter(FIELD, OCT)
    oct.run(OCT + 1100)
    kill(oct, c.p)
    expect(boxes(oct)).toBe(0)
  })

  it('the default rate is about 3 %', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.run(DEC + 1100)
    for (let i = 0; i < 2000; i++) kill(h, a.p)
    const pct = (boxes(h) / 2000) * 100
    expect(pct).toBeGreaterThan(1.8)
    expect(pct).toBeLessThan(4.4)
  })

  it('opening one: the box out and its rewards in (one transaction), the toast; a full bag refuses and keeps it', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.run(DEC + 1100)
    expect(h.g.winterPlay.gifts.gm(a.p, ['3'])).toMatchObject({ ok: true })
    const inv = () => h.store.loadInventory(a.p.characterId)
    const slot = inv().bag.findIndex((i) => i?.code === WINTER_CODES.gift)
    const gold = inv().gold
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    const opened = h.of(a.inbox, 'giftOpened').at(-1)!
    expect(opened.item).toBe(WINTER_CODES.gift)
    expect(opened.rewards.length + (opened.gold ? 1 : 0)).toBeGreaterThan(0)
    expect(inv().bag[slot]?.count).toBe(2)
    for (const r of opened.rewards) expect(inv().bag.some((i) => i?.code === r.code)).toBe(true)
    expect(inv().gold).toBe(gold + (opened.gold ?? 0))
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('a full bag refuses the opening and keeps the box', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.run(DEC + 1100)
    h.g.winterPlay.gifts.gm(a.p, ['10'])
    const inv = () => h.store.loadInventory(a.p.characterId)
    const slot = inv().bag.findIndex((i) => i?.code === WINTER_CODES.gift)
    const filler = item('ITEM_TEST_FILL', { maxStack: 1 })
    h.data.items.set(filler.code, filler)
    h.g.gmItem(a.p, filler, filler.code, inv().bag.filter((i) => i === null).length)
    // no reward has a stack to join: the first box with an item in it is refused (a gold-only box opens)
    let refused = false
    for (let i = 0; i < 10 && !refused; i++) {
      const r = h.req(a.p, a.inbox, { t: 'itemUse', bag: slot }, h.now + (i + 1) * 1000)
      if (!r.ok) {
        expect(r.reason).toBe('inventory_full')
        refused = true
      }
    }
    expect(refused).toBe(true)
    expect(inv().bag[slot]?.code).toBe(WINTER_CODES.gift)
  })

  it('rollGift: two rewards, a rare one at about GIFT_RARE_PCT, unknown items become gold', () => {
    const rng = seeded(11)
    let rare = 0
    const N = 4000
    for (let i = 0; i < N; i++) {
      const r = rollGift(rng, () => true, { rarePct: 10 })
      if (r.rare) rare++
      expect(r.items.length + (r.gold > 0 ? 1 : 0)).toBeGreaterThan(0)
    }
    expect(rare / N).toBeGreaterThan(0.08)
    expect(rare / N).toBeLessThan(0.12)
    const goldOnly = rollGift(seeded(2), () => false, { rarePct: 0 })
    expect(goldOnly.items).toEqual([])
    expect(goldOnly.gold).toBeGreaterThan(0)
    expect(GIFT_TABLE.filter((e) => e.tier === 'rare').length).toBeGreaterThan(2)
  })
})

// ---- the pieces -----------------------------------------------------------------------------------------------------

describe('fires, knobs and the admin panel', () => {
  it('finds the world fire placements by their source paths', () => {
    const f = firesFromManifest({
      placements: [
        { source: 'res\\bldg\\china\\jangan02\\cj_brazier_etc01.bsr', position: [1, 2, 3] },
        { source: 'res\\bldg\\china\\jangan_enter\\cj_enter_fire.bsr', position: [4, 5, 6] },
        { source: 'res\\artifact\\china\\jangan\\cj_field_lamp.bsr', position: [7, 8, 9] },
        { source: 'res\\bldg\\china\\dunhuang\\ruins\\w_cd_ firetower00.bsr', position: [0, 0, 0] },
        { source: 'res\\nature\\tree01\\tre_01.bsr', position: [0, 0, 0] },
      ],
    })
    expect(f.map((x) => x.kind)).toEqual(['brazier', 'brazier', 'lamp', 'brazier'])
  })

  it('the knobs default to WINTER_PLAY and the "Winter gameplay" settings check their bounds', () => {
    expect(winterKnobs({})).toMatchObject({ enabled: true, lossPerMin: 6, snowballCover: 0.35, giftDropPct: 3, giftYetiCount: 4, yetiRespawnMin: 120 })
    const keys = SETTINGS.filter((s) => s.group === 'Winter gameplay').map((s) => s.key)
    expect(keys).toEqual(['winterPlay', 'warmthLossPerMin', 'warmthBlizzardMul', 'warmthFireMul', 'coldDrainPct', 'snowballCover', 'snowballSlowPct', 'snowSpiritScale', 'yetiRespawnMin', 'yetiHpMul', 'giftDropPct', 'giftYetiCount', 'giftRarePct'])
    expect(checkSetting(SETTING_BY_KEY.get('giftDropPct')!, 101)).toHaveProperty('problem')
    expect(checkSetting(SETTING_BY_KEY.get('snowballCover')!, 0.5)).toEqual({ value: 0.5 })
  })

  it('GM warmth and gift', () => {
    const h = harness()
    const a = h.enter(FIELD)
    h.run(DEC + 1100)
    expect(h.play.warmth.gm(a.p, ['20'], h.now)).toMatchObject({ ok: true })
    expect(h.play.warmth.value(a.p)).toBe(20)
    expect(h.play.warmth.gm(a.p, ['200'], h.now)).toMatchObject({ ok: false })
    expect(h.play.warmth.gm(a.p, [], h.now).message).toMatch(/cold/)
    expect(h.play.gifts.gm(a.p, ['0'])).toMatchObject({ ok: false })
    expect(h.play.describe(h.now)).toMatch(/Winter gameplay on/)
  })
})
