/**
 * The winter gameplay layer's shared half (packages/shared/src/winter-play.ts; docs/WINTER.md §13): the wire (client
 * and server messages through the validators, additive to protocol v1), the pure rules (warmth levels and loss, the
 * snowball arc, the frost cone, the season label) and the content derivation (monsters from retail bases, items, the
 * shop tab), plus the gift roll's tiers.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIENT_RATE_LIMITS,
  GAMEPLAY_REQUESTS,
  WINTER_CODES,
  WINTER_MOBS,
  WINTER_PLAY,
  WINTER_REQUESTS,
  fireKindOf,
  inCone,
  installWinterContent,
  isWinterMob,
  parseClientMessage,
  parseServerMessage,
  rollGift,
  setWinterShopTab,
  snowballArc,
  snowballFlightMs,
  warmthLevel,
  warmthLossPerS,
  winterSeasonKey,
  type DropTable,
  type ItemDef,
  type MobDef,
  type ServerMessage,
  type ShopDef,
} from '../src/index.ts'

const ok = (m: unknown) => parseServerMessage(JSON.stringify(m))

describe('the winter wire (docs/WINTER.md §13; protocol v1, additive)', () => {
  it('snowball: a target or a point, never both or neither; winterBoard has no fields; both are rate-limited requests', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'snowball', target: 12 }))).toEqual({ ok: true, msg: { t: 'snowball', target: 12 } })
    expect(parseClientMessage(JSON.stringify({ t: 'snowball', x: 1.5, z: -3 }))).toEqual({ ok: true, msg: { t: 'snowball', x: 1.5, z: -3 } })
    expect(parseClientMessage(JSON.stringify({ t: 'snowball' })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ t: 'snowball', target: 1, x: 1, z: 1 })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ t: 'snowball', x: 1 })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ t: 'snowball', target: 0 })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ t: 'winterBoard' }))).toEqual({ ok: true, msg: { t: 'winterBoard' } })
    expect(parseClientMessage(JSON.stringify({ t: 'winterBoard', all: true })).ok).toBe(false)
    for (const r of WINTER_REQUESTS) {
      expect(GAMEPLAY_REQUESTS).toContain(r)
      expect(CLIENT_RATE_LIMITS[r]).toBeDefined()
    }
  })

  it('every server message validates; bad fields are rejected', () => {
    const good: ServerMessage[] = [
      { t: 'warmth', warmth: { value: 42.5, max: 100, rate: -0.1, level: 'chilly', at: 1, source: 'tea' } },
      { t: 'warmth', warmth: { value: 0, max: 100, rate: 0, level: 'freezing', at: 1, drained: 3 } },
      { t: 'winterPlay', play: { on: true, snowballs: true, fires: [[1, 2, 3]], season: '2026-27' } },
      { t: 'winterPlay', play: { on: false, snowballs: false } },
      { t: 'snowball', id: 1, from: 5, fromPos: [0, 1.6, 0], to: [4, 1, 0], at: 100, ms: 400, peakM: 1.1, target: 6 },
      { t: 'snowball', id: 2, from: 9, fromPos: [0, 3, 0], to: [4, 1, 0], at: 100, ms: 900, peakM: 2, big: true },
      { t: 'snowballSplat', id: 1, pos: [4, 1, 0], hit: 6, slowMs: 1500, score: 3 },
      { t: 'snowballSplat', id: 2, pos: [4, 0, 0] },
      { t: 'winterBoard', board: { season: '2026-27', top: [{ name: 'Mei', hits: 4 }], me: { hits: 4, thrown: 9, hitBy: 1, rank: 1 } } },
      { t: 'giftOpened', item: WINTER_CODES.gift, rewards: [{ code: 'ITEM_ETC_HP_POTION_02', count: 4 }], gold: 900, rare: true },
      { t: 'yetiSkill', id: 7, skill: 'breath', at: 5, castMs: 900, pos: [1, 2, 3], yaw: 1.2, radiusM: 10, angleDeg: 70 },
    ]
    for (const m of good) expect(ok(m)).toEqual({ ok: true, msg: m })
    const bad: unknown[] = [
      { t: 'warmth', warmth: { value: 120, max: 100, rate: 0, level: 'warm', at: 1 } },
      { t: 'warmth', warmth: { value: 10, max: 100, rate: 0, level: 'toasty', at: 1 } },
      { t: 'winterPlay', play: { on: 'yes', snowballs: false } },
      { t: 'snowball', id: 1, from: 5, fromPos: [0, 1], to: [4, 1, 0], at: 100, ms: 400, peakM: 1 },
      { t: 'snowball', id: 1, from: 5, fromPos: [0, 1, 0], to: [4, 1, 0], at: 100, ms: 0, peakM: 1 },
      { t: 'snowballSplat', id: 0, pos: [0, 0, 0] },
      { t: 'winterBoard', board: { season: '2026-27', top: Array.from({ length: 30 }, () => ({ name: 'a', hits: 1 })), me: { hits: 0, thrown: 0, hitBy: 0 } } },
      { t: 'giftOpened', item: 'lower case', rewards: [] },
      { t: 'yetiSkill', id: 7, skill: 'dance', at: 5, castMs: 900, pos: [1, 2, 3], yaw: 0, radiusM: 10 },
    ]
    for (const m of bad) expect(ok(m).ok).toBe(false)
    // unknown extra keys are dropped, as for every server message
    expect(ok({ t: 'snowballSplat', id: 3, pos: [0, 0, 0], extra: 1 })).toEqual({ ok: true, msg: { t: 'snowballSplat', id: 3, pos: [0, 0, 0] } })
  })
})

describe('the rules', () => {
  it('warmth levels and the loss by day, night, snow and blizzard', () => {
    expect(warmthLevel(100)).toBe('warm')
    expect(warmthLevel(50)).toBe('warm')
    expect(warmthLevel(49.9)).toBe('chilly')
    expect(warmthLevel(24.9)).toBe('cold')
    expect(warmthLevel(0)).toBe('freezing')
    expect(warmthLossPerS({ night: 0, snow: 0, storm: 0 }) * 60).toBeCloseTo(WINTER_PLAY.warmth.lossPerMin)
    expect(warmthLossPerS({ night: 1, snow: 0, storm: 1 }) * 60).toBeCloseTo(9) // a storm without snow is no blizzard
    expect(warmthLossPerS({ night: 1, snow: 1, storm: 1 }) * 60).toBeCloseTo(6 * 1.5 * 2.5)
    expect(warmthLossPerS({ night: 0, snow: 0, storm: 0 }, { lossPerMin: 0, nightMul: 1.5, snowMul: 1.5, blizzardMul: 2.5 })).toBe(0)
  })

  it('the snowball flies an arc that starts and ends where it should; longer throws take longer', () => {
    const from: [number, number, number] = [0, 1.6, 0]
    const to: [number, number, number] = [10, 1, 0]
    expect(snowballArc(from, to, 2, 0)).toEqual(from)
    expect(snowballArc(from, to, 2, 1)).toEqual(to)
    expect(snowballArc(from, to, 2, 0.5)[1]).toBeCloseTo(1.3 + 2)
    expect(snowballFlightMs(20)).toBeGreaterThan(snowballFlightMs(5))
  })

  it('the frost cone: in front within the angle, not behind or beside, not past the radius', () => {
    const o = { x: 0, z: 0 }
    expect(inCone(o, 0, { x: 0, z: 5 }, 10, 70)).toBe(true)
    expect(inCone(o, 0, { x: 3, z: 5 }, 10, 70)).toBe(true)
    expect(inCone(o, 0, { x: 5, z: 3 }, 10, 70)).toBe(false)
    expect(inCone(o, 0, { x: 0, z: -5 }, 10, 70)).toBe(false)
    expect(inCone(o, 0, { x: 0, z: 11 }, 10, 70)).toBe(false)
    expect(inCone(o, Math.PI / 2, { x: 5, z: 0 }, 10, 70)).toBe(true)
  })

  it('the season label follows the winter that wraps the new year', () => {
    const d = { start: '12-01', end: '01-15', timeZone: 'UTC' }
    expect(winterSeasonKey(Date.UTC(2026, 11, 20), d)).toBe('2026-27')
    expect(winterSeasonKey(Date.UTC(2027, 0, 10), d)).toBe('2026-27')
    expect(winterSeasonKey(Date.UTC(2027, 11, 2), d)).toBe('2027-28')
    expect(winterSeasonKey(Date.UTC(2027, 5, 1), { start: '03-01', end: '06-30', timeZone: 'UTC' })).toBe('2027')
  })

  it('fire sources by their placement path', () => {
    expect(fireKindOf('res\\bldg\\china\\jangan02\\cj_brazier_etc01.bsr')).toBe('brazier')
    expect(fireKindOf('res\\bldg\\china\\jangan_enter\\cj_enter_fire.bsr')).toBe('brazier')
    expect(fireKindOf('res\\artifact\\china\\jangan\\cj_pal_lamp.bsr')).toBe('lamp')
    expect(fireKindOf('res\\bldg\\china\\jangan02\\cj_pub01_light02.bsr')).toBe('lamp')
    expect(fireKindOf('res\\nature\\tree01\\tre_01.bsr')).toBeNull()
  })

  it('a gift always holds something; the rare tier only with its chance', () => {
    for (let s = 1; s < 50; s++) {
      let i = s
      const rng = () => ((i = (i * 16807) % 2147483647) / 2147483647)
      const r = rollGift(rng, () => true, { rarePct: 0 })
      expect(r.rare).toBe(false)
      expect(r.items.length + (r.gold > 0 ? 1 : 0)).toBeGreaterThan(0)
    }
    expect(rollGift(() => 0, () => true, { rarePct: 100 }).rare).toBe(true)
  })
})

describe('the winter content', () => {
  const base = (code: string, model = true): MobDef => ({
    code, id: 1, name: code, typeId: [1, 2, 1, 1], rarity: 'normal', level: 3, hp: 85, mp: 0, physAttack: [1, 2], magAttack: [0, 0], physDefence: 1, magDefence: 1,
    hitRate: 1, parryRate: 1, attackRange: 1, attackIntervalMs: 1000, radius: 0.6, walkSpeed: 1, runSpeed: 4, aggressive: false, exp: 1, scale: 100,
    model: model ? { bsr: `res/mob/${code}.bsr`, glb: `/out/mob/${code}.glb`, sidecar: `/out/mob/${code}.json` } : null, skills: ['MSKILL_X'],
  })

  it('derives the monsters from their retail bases (model and skills), never replaces a row, and is idempotent', () => {
    const mobs = new Map<string, MobDef>(WINTER_MOBS.map((s) => [s.base, base(s.base)]))
    const items = new Map<string, ItemDef>()
    const drops = new Map<string, DropTable>([['MOB_CH_WATERGHOST', { mob: 'MOB_CH_WATERGHOST', groups: [], gold: { chance: 1, amount: [1, 2] }, provenance: 'client' }]])
    expect(installWinterContent({ mobs, items, drops })).toEqual({ mobs: 3, items: 2, drops: 1 })
    expect(installWinterContent({ mobs, items, drops })).toEqual({ mobs: 0, items: 0, drops: 0 })
    const yeti = mobs.get(WINTER_CODES.yeti)!
    expect(yeti.model?.glb).toBe('/out/mob/MOB_CH_YEOHA.glb')
    expect(yeti).toMatchObject({ name: 'Ice Yeti', rarity: 'unique', scale: 260, skills: ['MSKILL_X'] })
    expect(drops.get(WINTER_CODES.spirit)?.gold).toEqual({ chance: 1, amount: [1, 2] })
    expect(isWinterMob(WINTER_CODES.sprite)).toBe(true)
    expect(isWinterMob('MOB_CH_YEOHA')).toBe(false)
    // no base in the export: still a monster (drawn as a placeholder)
    const bare = new Map<string, MobDef>()
    installWinterContent({ mobs: bare, items: new Map(), drops: new Map() })
    expect(bare.get(WINTER_CODES.spirit)?.model).toBeNull()
  })

  it('the Winter tab of the potion shop comes and goes', () => {
    const shops = new Map<string, ShopDef>([[WINTER_CODES.shop, { id: WINTER_CODES.shop, npcs: ['NPC_CH_POTION'], tabs: [{ name: 'Potion', items: ['A'] }], provenance: 'client' }]])
    expect(setWinterShopTab(shops, true)).toBe(true)
    expect(setWinterShopTab(shops, true)).toBe(false)
    expect(shops.get(WINTER_CODES.shop)!.tabs.map((t) => t.name)).toEqual(['Potion', 'Winter'])
    expect(setWinterShopTab(shops, false)).toBe(true)
    expect(shops.get(WINTER_CODES.shop)!.tabs.map((t) => t.name)).toEqual(['Potion'])
  })
})
