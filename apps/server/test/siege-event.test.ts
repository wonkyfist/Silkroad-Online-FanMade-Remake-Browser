/**
 * Siege of Jangan, layer 4: the siege event (docs/SIEGE.md §6, §11, §14).
 *
 * - pure rules: the scaling table of §6.4 (counts exact, the Warlord's HP within 1 %), the wave rosters, the rewards
 *   (won / lost / under minPoints / the title rule), the settings checker and the patch helpers, the gate wards;
 * - lanes validated against a walker (a blocked outer or inner leg, a wall the walk cannot reach, a gap that does not
 *   open: dropped);
 * - the event on a flat world with a stand-in wall (siege-event `configure`): warning (the Bell, wave 1 at the muster,
 *   the alarm), the march, raiders chipping the wall, a sapper's keg blowing (and one defused), waves early and on time,
 *   the Warlord (HP scaled by the defenders), won with rewards (gold, Seals, the title, siegeReward), lost on the Bell
 *   (a quarter of the gold, no Seals), lost on time, siege monsters dropping nothing at 50 % EXP, Bell repair hits, the
 *   ground around the Bell unsafe during a wave, the gate wards (monsters stop, players pass);
 * - the schedule: off by default, a slot skipped below minPlayers, a Night of the Tiger making it wait (then skipped),
 *   a Night due during a siege waiting;
 * - restarts: the warning resumes (≥ 3 min left), a wave ends `restart` with nothing paid;
 * - the admin routes: the role, the view, settings (409 stale, 422 issues, reset), start / stop, a wall set.
 */
import {
  SIEGE_EVENT_CODES,
  SIEGE_EVENT_DEFAULTS,
  SIEGE_HONOR,
  WALL_DEFAULTS,
  checkSiegeEventSettings,
  clipWalk,
  mergeSiegeEventSettings,
  mergeSiegePatch,
  pruneSiegePatch,
  scaledCount,
  siegeReward,
  siegeScale,
  unsetSiegePaths,
  wallOpen,
  wallStage,
  wardCrossing,
  warlordHp,
  waveRoster,
  type AdminSiegeView,
  type ServerMessage,
  type SiegeLanesContent,
  type WallSegView,
  type WallStage,
  type WallsExport,
  type XZ,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { GameContext } from '../src/game.ts'
import { GameData } from '../src/gamedata.ts'
import { Gameplay, killExp } from '../src/gameplay.ts'
import { routeAdminSiege } from '../src/siege/event-admin.ts'
import { RESUME_MIN_MS, type SiegeWalls } from '../src/siege/event.ts'
import { validateLanes, type ApproachLanes, type Lane, type LaneWalker } from '../src/siege/lanes.ts'
import type { WallEvent } from '../src/siege/walls.ts'
import type { Mob, Player } from '../src/world.ts'
import { mob } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const MIN = 60_000

// ---- pure rules -------------------------------------------------------------------------------------------------------

describe('scaling (§6.4)', () => {
  const a = SIEGE_EVENT_DEFAULTS.army
  it('the table: s, wave 1 raiders and sappers per approach, the Warlord within 1 %', () => {
    const rows: [number, number, number, number, number][] = [
      [1, 1, 12, 2, 60_000],
      [5, 1, 12, 2, 60_000],
      [10, 1.74, 21, 3, 98_600],
      [20, 3.03, 36, 6, 162_400],
      [30, 4.19, 50, 8, 218_600],
      [80, 4.19, 50, 8, 218_600],
    ]
    for (const [n, s, raiders, sappers, hp] of rows) {
      const sc = siegeScale(n, a)
      expect(sc, `N ${n}`).toBeCloseTo(s, 2)
      const r = waveRoster(1, sc, SIEGE_EVENT_DEFAULTS.waves)
      expect([r.raiders, r.sappers], `N ${n}`).toEqual([raiders, sappers])
      expect(Math.abs(warlordHp(sc, a) - hp) / hp, `N ${n}`).toBeLessThan(0.01)
    }
    expect(siegeScale(0, a)).toBe(1)
    expect(siegeScale(Number.NaN, a)).toBe(1)
  })

  it('the rosters: rams and the Warlord do not multiply; wave 3 elite raiders do', () => {
    const w = SIEGE_EVENT_DEFAULTS.waves
    expect(waveRoster(2, 2, w)).toEqual({ raiders: 28, archers: 12, sappers: 6, rams: 2, elite: 0, warlord: false })
    expect(waveRoster(3, 2, w, true)).toEqual({ raiders: 0, archers: 0, sappers: 0, rams: 2, elite: 20, warlord: true })
    expect(waveRoster(3, 2, w, false).warlord).toBe(false)
    expect(scaledCount(0, 4)).toBe(0)
  })
})

describe('rewards (§6.6)', () => {
  const r = SIEGE_EVENT_DEFAULTS.rewards
  it('won: 50 gold a point (≤ 30,000), a Seal per 50 points (≤ 10), the title to the top 3 and anyone ≥ 300', () => {
    expect(siegeReward(100, 1, 'won', r)).toEqual({ gold: 5000, seals: 2, title: true })
    expect(siegeReward(100, 4, 'won', r)).toEqual({ gold: 5000, seals: 2, title: false })
    expect(siegeReward(300, 9, 'won', r)).toEqual({ gold: 15_000, seals: 6, title: true })
    expect(siegeReward(5000, 1, 'won', r)).toEqual({ gold: 30_000, seals: 10, title: true })
  })
  it('lost: a quarter of the gold, no Seals, no title; under 20 points, cancelled or a restart: nothing', () => {
    expect(siegeReward(100, 1, 'lost_bell', r)).toEqual({ gold: 1250, seals: 0, title: false })
    expect(siegeReward(100, 1, 'lost_time', r)).toEqual({ gold: 1250, seals: 0, title: false })
    expect(siegeReward(19, 1, 'won', r)).toEqual({ gold: 0, seals: 0, title: false })
    expect(siegeReward(100, 1, 'cancelled', r)).toEqual({ gold: 0, seals: 0, title: false })
    expect(siegeReward(100, 1, 'restart', r)).toEqual({ gold: 0, seals: 0, title: false })
  })
})

describe('settings (§11.2)', () => {
  it('defaults: off, Sunday 20:00, the spec numbers', () => {
    expect(SIEGE_EVENT_DEFAULTS.enabled).toBe(false)
    expect(SIEGE_EVENT_DEFAULTS.schedule.slots).toEqual([{ weekday: 0, time: '20:00' }])
    expect(SIEGE_EVENT_DEFAULTS.timing).toMatchObject({ warningMin: 10, waveGapMin: 8, durationMin: 35, minPlayers: 5, approaches: 2, earlyPct: 80, tigerWaitMin: 30 })
    expect(SIEGE_EVENT_DEFAULTS.army).toMatchObject({ raiderIp: 40, ramIp: 300, sapperIp: 5000, warlordIp: 600, warlordHp: 60_000, scaleDiv: 5, scaleCap: 6, scaleExp: 0.8, expMul: 0.5 })
    expect(SIEGE_EVENT_DEFAULTS.bell.hp).toBe(30_000)
  })
  it('the checker: unknown keys, out of bounds, bad slots, a bad zone', () => {
    expect(checkSiegeEventSettings({ timing: { warningMin: 5 }, enabled: true, schedule: { slots: [{ weekday: 6, time: '21:30' }], tz: 'Europe/Berlin' } })).toEqual([])
    const paths = checkSiegeEventSettings({ timing: { warningMin: 0, nope: 1 }, bell: { hp: 'x' }, schedule: { slots: [{ weekday: 7, time: '25:00' }], tz: 'a b' }, enabled: 1, extra: {} }).map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining(['timing.warningMin', 'timing.nope', 'bell.hp', 'schedule.slots[0]', 'schedule.tz', 'enabled', 'extra']))
  })
  it('merge, patch merge, prune, unset', () => {
    const p = mergeSiegePatch({ timing: { warningMin: 5 } }, { timing: { waveGapMin: 6 }, enabled: true })
    expect(p).toEqual({ timing: { warningMin: 5, waveGapMin: 6 }, enabled: true })
    const s = mergeSiegeEventSettings(SIEGE_EVENT_DEFAULTS, p)
    expect(s.timing).toMatchObject({ warningMin: 5, waveGapMin: 6, durationMin: 35 })
    expect(pruneSiegePatch({ timing: { warningMin: 10, waveGapMin: 6 }, enabled: false }, SIEGE_EVENT_DEFAULTS)).toEqual({ timing: { waveGapMin: 6 } })
    expect(unsetSiegePaths(p, ['timing.warningMin', 'enabled'])).toEqual({ timing: { waveGapMin: 6 } })
    expect(unsetSiegePaths(p, ['timing'])).toEqual({ enabled: true })
  })
})

describe('gate wards (§4.3)', () => {
  const wards = [{ gate: 'W-gate', a: [-177, -220] as XZ, b: [-177, -160] as XZ }]
  it('a walk across the gate line stops short of it; one beside the gatehouse or along it does not', () => {
    expect(wardCrossing(-250, -190, -100, -190, wards)).toBeCloseTo(73 / 150, 6)
    const c = clipWalk(-250, -190, -100, -190, wards)!
    expect(c[0]).toBeCloseTo(-177.75, 6)
    expect(c[1]).toBeCloseTo(-190, 6)
    expect(clipWalk(-250, -100, -100, -100, wards)).toBeNull()
    expect(clipWalk(-250, -190, -180, -190, wards)).toBeNull()
  })
})

// ---- lanes (§6.3) -------------------------------------------------------------------------------------------------------

/** One north wall at z = -100 (outer face -104, inner -96), segments N1 (x -60..-20) and N2 (x -20..20). */
function wallsOf(): Pick<WallsExport, 'segments' | 'sides'> {
  const seg = (id: string, from: number) => {
    const third = (k: number) => {
      const a = from + (40 / 3) * k
      const mid = a + 20 / 3
      return { id: `${id}${'abc'[k]}`, from: a, to: a + 40 / 3, instances: [], tiles: [], assault: [mid, 0, -106] as [number, number, number], rally: [mid, 0, -86] as [number, number, number] }
    }
    return { id, side: 'N' as const, from, to: from + 40, thirds: [third(0), third(1), third(2)] as const }
  }
  return {
    sides: [{ side: 'N', axis: 'x', line: -100, outer: -104, inner: -96, out: -1, walkY: 20, placement: { region: 1, uid: 1, source: 'w', position: [0, 0, -100] }, retailInstance: 1, fixed: [{ id: 'N-gate', from: 20, to: 40, what: 'gate', instances: [] }] }],
    segments: [seg('N1', -60) as unknown as WallsExport['segments'][number], seg('N2', -20) as unknown as WallsExport['segments'][number]],
  }
}

/** A flat field with the wall at z -104..-96: walks stop at the wall unless `open` has the segment whose x it crosses. */
function walker(open: Set<string> = new Set(), blocked: [XZ, XZ][] = []): LaneWalker {
  const w: LaneWalker = {
    walk(a, b) {
      for (const [p, q] of blocked) if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 0.1 && Math.hypot(q[0] - b[0], q[1] - b[1]) < 0.1) return { ok: false, end: a }
      if ((a[1] < -104) !== (b[1] < -104) || (a[1] > -96) !== (b[1] > -96)) {
        const t = (-104 - a[1]) / (b[1] - a[1])
        const x = a[0] + (b[0] - a[0]) * t
        const seg = x >= -60 && x < -20 ? 'N1' : x >= -20 && x < 20 ? 'N2' : null
        if (!seg || !open.has(seg)) {
          const back = a[1] < -104 ? -104.5 : -95.5
          const tt = (back - a[1]) / (b[1] - a[1])
          return { ok: false, end: [a[0] + (b[0] - a[0]) * tt, back] }
        }
      }
      return { ok: true, end: b }
    },
    withStage(seg, stage, fn) {
      const was = open.has(seg)
      if (wallOpen(stage)) open.add(seg)
      try {
        return fn()
      } finally {
        if (!was) open.delete(seg)
      }
    },
  }
  return w
}

const CONTENT: SiegeLanesContent = {
  bell: [0, 0],
  approaches: {
    N: { name: 'the north fields', muster: [0, -250], lanes: { N1: { outer: [[-40, -150], [-40, -130]], inner: [[-40, -40]] }, N2: { outer: [[0, -150], [0, -130]], inner: [] } } },
  },
}

describe('lanes validated against the nav (§6.3)', () => {
  it('good lanes are kept with their foot of the wall and rally point', () => {
    const r = validateLanes(CONTENT, wallsOf(), walker())
    expect(r).toHaveLength(1)
    expect(r[0]!.lanes.map((l) => l.seg)).toEqual(['N1', 'N2'])
    expect(r[0]!.dropped).toEqual([])
    const l = r[0]!.lanes[0]!
    expect(l.foot).toEqual([-40, -106])
    expect(l.outer[0]).toEqual([0, -250])
    expect(l.rally).toEqual([-40, -86])
  })
  it('a blocked outer leg, a blocked inner leg, an unknown segment: dropped with why', () => {
    const c = structuredClone(CONTENT)
    c.approaches.N!.lanes.S9 = { outer: [[0, -130]], inner: [] }
    const r = validateLanes(c, wallsOf(), walker(new Set(), [[[-40, -150], [-40, -130]], [[0, -86], [0, 0]]]))
    const why = Object.fromEntries(r[0]!.dropped.map((d) => [d.seg, d.why]))
    expect(why.N1).toMatch(/outer leg 2/)
    expect(why.N2).toMatch(/inner leg 1/)
    expect(why.S9).toMatch(/no such segment/)
    expect(r[0]!.lanes).toEqual([])
  })
  it('a staging point whose walk stops far from the wall, or a gap that does not open: dropped', () => {
    const c = structuredClone(CONTENT)
    c.approaches.N!.lanes.N1!.outer = [[-40, -150], [-40, -130]]
    const far = validateLanes(c, wallsOf(), walker(new Set(), [[[-40, -130], [-40, -106]]]))
    expect(far[0]!.dropped.find((d) => d.seg === 'N1')?.why).toMatch(/stops/)
    const shut: LaneWalker = { ...walker(), withStage: (_s, _st, fn) => fn() }
    expect(validateLanes(CONTENT, wallsOf(), shut)[0]!.dropped.map((d) => d.why)).toEqual(['the way through the gap is blocked', 'the way through the gap is blocked'])
  })
})

// ---- the event on a flat world ------------------------------------------------------------------------------------------------

/** The walls the siege sees: integrity, stage (shared rules), events, extraUnsafe. */
class StandIn implements SiegeWalls {
  readonly on = true
  readonly walls = null
  readonly settings = { maxIp: WALL_DEFAULTS.maxIp }
  readonly ip = new Map<string, number>([['N1', 20_000], ['N2', 20_000], ['W1', 20_000]])
  readonly stage = new Map<string, WallStage>([['N1', 'intact'], ['N2', 'intact'], ['W1', 'intact']])
  readonly log: WallEvent[] = []
  private fns: ((e: WallEvent) => void)[] = []
  sieging = () => false
  extraUnsafe: ((x: number, z: number) => boolean) | null = null
  zones = 0
  stageOf(id: string): WallStage | null {
    return this.stage.get(id) ?? null
  }
  change(id: string, delta: number, cause: string, now: number, opts: { data?: Record<string, unknown> } = {}): unknown {
    return this.set(id, (this.ip.get(id) ?? 0) + delta, cause, now, null, opts.data ?? {})
  }
  set(id: string, ip: number, cause: string, now: number, characterId: number | null = null, data: Record<string, unknown> = {}): WallEvent {
    const before = this.ip.get(id)!
    const after = Math.max(-10_000, Math.min(20_000, Math.round(ip)))
    const stageBefore = this.stage.get(id)!
    const stage = wallStage(after, WALL_DEFAULTS, stageBefore)
    this.ip.set(id, after)
    this.stage.set(id, stage)
    const e: WallEvent = { id, cause, delta: after - before, stage, stageBefore, characterId, data, at: now }
    this.log.push(e)
    for (const f of this.fns) f(e)
    return e
  }
  note(id: string, cause: string, now: number, characterId: number, data: Record<string, unknown>): void {
    const s = this.stage.get(id)!
    for (const f of this.fns) f({ id, cause, delta: 0, stage: s, stageBefore: s, characterId, data, at: now })
  }
  onWallEvent(fn: (e: WallEvent) => void): () => void {
    this.fns.push(fn)
    return () => void (this.fns = this.fns.filter((f) => f !== fn))
  }
  refreshZones(): void {
    this.zones++
  }
  views(): WallSegView[] {
    return [...this.ip].map(([id, ip]) => ({ id, stage: this.stage.get(id)!, pct: ip / 200 }))
  }
}

/** The lanes on the flat world: N from the north to the N wall (z -100), W from the west to a W wall at x -100. */
function flatLanes(): ApproachLanes[] {
  const n = (seg: string, x: number): Lane => ({ approach: 'N', seg, outer: [[0, -260], [x, -140]], assault: [x, 0, -102], foot: [x, -102], rally: [x, -90], inner: [[x, -30]], axis: 'x', out: -1 })
  const w: Lane = { approach: 'W', seg: 'W1', outer: [[-260, 0], [-140, 0]], assault: [-102, 0, 0], foot: [-102, 0], rally: [-90, 0], inner: [], axis: 'z', out: -1 }
  return [
    { approach: 'N', name: 'the north fields', muster: [0, -260], lanes: [n('N1', -20), n('N2', 20)], dropped: [] },
    { approach: 'W', name: 'the west road', muster: [-260, 0], lanes: [w], dropped: [] },
  ]
}

const BASES = [
  mob('MOB_CH_BANDIT', { name: 'Bandit', level: 16, hp: 755, physAttack: [102, 123], attackRange: 0.4, attackIntervalMs: 1500, walkSpeed: 1.5, runSpeed: 5.5, aggressive: true }),
  mob('MOB_CH_TIGER', { name: 'Tiger', level: 14, hp: 509, physAttack: [87, 104], attackRange: 0.9, attackIntervalMs: 1500, radius: 1.5, runSpeed: 7.5, aggressive: true }),
  mob('MOB_CH_BANDITARCHER', { name: 'Bandit Archer', level: 12, hp: 324, attackRange: 13, attackIntervalMs: 2500, runSpeed: 7.5, aggressive: true }),
  mob('MOB_CH_STONEGHOST', { name: 'Stone Ghost', level: 9, hp: 194, attackIntervalMs: 2500, radius: 1, aggressive: true }),
]

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function siegeHarness(o: { patch?: Parameters<Gameplay['siege']['applyPatch']>[0]; uniques?: boolean; store?: ReturnType<typeof skillHarness>['store'] } = {}) {
  const data = new GameData({ mobs: BASES.map((m) => ({ ...m })), items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [{ ...SAFE_TOWN, safeArea: { x: 0, z: 0, halfX: 80, halfZ: 80 } }] })
  const h = skillHarness({ data, config: { uniques: o.uniques ?? false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  const walls = new StandIn()
  g.siege.configure({ walls, lanes: flatLanes(), bell: [0, 0], wards: [{ gate: 'N-gate', a: [40, -100], b: [80, -100] }] })
  // the first tick boots the module (the stored settings: none), then the test's numbers
  g.siege.tick(h.now)
  g.siege.applyPatch({ timing: { approaches: 2 }, ...(o.patch ?? {}) }, 0)
  const s = g.siege
  const tick = (ms: number) => h.runTo(h.now + ms)
  const foes = (role?: string) => [...h.world.mobs.values()].filter((m) => m.siege && m.ai !== 'dead' && m.siege.role !== 'bell' && (!role || m.siege.role === role))
  const bell = () => s.bellMob()
  /** A defender of level 20 at x/z with plenty of HP. */
  const defender = (x: number, z: number, name?: string) => {
    const r = h.hero({ pos: [x, 0, z], level: 20, ...(name ? { name } : {}) })
    r.p.maxHp = r.p.hp = 1_000_000
    return r
  }
  const kill = (p: Player, m: Mob) => g.dealHits(p, m, [{ outcome: 'hit', damage: Math.ceil(m.hp), hp: 0 }], {}, h.now)
  const last = <T extends ServerMessage['t']>(inbox: ServerMessage[], t: T) => h.all(inbox, t).at(-1)
  return { h, g, s, walls, tick, foes, bell, defender, kill, last }
}

describe('the siege event on a flat world (§6)', () => {
  it('warning: the Bell rises, wave 1 musters, the alarm and the countdown; off-phase ground stays safe', () => {
    const x = siegeHarness()
    const d = x.defender(0, 10, 'Aki')
    const r = x.s.start('gm', 2, x.h.now)
    expect(r.ok, r.ok ? '' : r.message).toBe(true)
    const ev = x.s.ev!
    expect(ev.phase).toBe('warning')
    expect(ev.approaches).toEqual(['W', 'N'].filter((a) => ev.approaches.includes(a as 'W' | 'N')).sort((a, b) => 'WSEN'.indexOf(a) - 'WSEN'.indexOf(b)))
    expect(x.bell()).not.toBeNull()
    expect(x.bell()!.maxHp).toBe(30_000)
    expect(x.bell()!.def.code).toBe(SIEGE_EVENT_CODES.bell)
    // wave 1 at the musters: 12 raiders and 2 sappers per approach, standing
    expect(x.foes('raider')).toHaveLength(24)
    expect(x.foes('sapper')).toHaveLength(4)
    expect(x.foes().every((m) => m.siege!.mode === 'muster')).toBe(true)
    expect(x.h.all(d.inbox, 'siegeNotice').at(-1)).toMatchObject({ event: 'phase', phase: 'warning' })
    expect(x.last(d.inbox, 'siegeEvent')).toMatchObject({ view: { phase: 'warning', bellPct: 100, nextAt: ev.wave1At } })
    expect(x.walls.sieging()).toBe(true)
    expect(x.walls.extraUnsafe).toBeNull()
    // a siege monster's EntityState says its role
    expect(x.h.world.state(x.foes('sapper')[0]!).siege).toBe('sapper')
    expect(x.h.world.state(x.bell()!).siege).toBe('bell')
    x.tick(70_000)
    expect(x.h.all(d.inbox, 'chat').some((m) => /in 1 minute/.test(m.text))).toBe(true)
    expect(x.s.start('gm', 1, x.h.now).ok).toBe(false)
  })

  it('wave 1 marches, raiders chip the wall, a sapper keg blows; the wall breaks, the army goes in, the ground near the Bell is unsafe', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 }, waves: { w1Raiders: 3, w1Sappers: 1 } } })
    const d = x.defender(150, 150, 'Aki')
    const casts: ServerMessage[] = []
    const about = x.h.world.broadcastAbout.bind(x.h.world)
    x.h.world.broadcastAbout = (e, m) => {
      if (m.t === 'cast') casts.push(m)
      return about(e, m)
    }
    x.s.start('gm', 0, x.h.now)
    x.tick(100)
    const ev = x.s.ev!
    expect(ev.phase).toBe('wave1')
    expect(x.foes().every((m) => m.siege!.mode === 'march')).toBe(true)
    const seg = ev.approaches[0] === 'N' ? ['N1', 'N2'] : ['W1']
    x.tick(90_000)
    // raiders at the foot hit the wall
    const hits = x.walls.log.filter((e) => e.cause === 'raider')
    expect(hits.length).toBeGreaterThan(5)
    expect(hits.every((e) => seg.includes(e.id) && e.delta === -40)).toBe(true)
    expect(casts.some((c) => c.t === 'cast' && c.skill === 'SIEGE_WALL_SWING' && c.clip === 'ATTACK1')).toBe(true)
    // the sapper planted and the keg blew (5,000 ip)
    expect(x.h.all(d.inbox, 'keg')).not.toHaveLength(0)
    expect(x.h.all(d.inbox, 'kegEnd').some((k) => k.how === 'blast')).toBe(true)
    expect(x.walls.log.some((e) => e.cause === 'sapper' && e.delta === -5000)).toBe(true)
    // break a target: the army goes in
    const target = x.foes('raider')[0]!.siege!.seg
    x.walls.set(target, -2000, 'gm', x.h.now)
    expect(ev.breaches.has(target)).toBe(true)
    expect(x.h.all(d.inbox, 'siegeNotice').some((n) => n.event === 'breach' && n.wall === target)).toBe(true)
    x.tick(1000)
    expect(x.foes('raider').filter((m) => m.siege!.seg === target).every((m) => m.siege!.mode === 'inside' || m.siege!.mode === 'bell' || m.siege!.mode === 'engage')).toBe(true)
    expect(x.walls.extraUnsafe!(0, 10)).toBe(true)
    expect(x.walls.extraUnsafe!(300, 300)).toBe(false)
    x.tick(120_000)
    expect(x.foes('raider').some((m) => m.siege!.mode === 'bell')).toBe(true)
    expect(x.bell()!.hp).toBeLessThan(x.bell()!.maxHp)
  })

  it('a defender defuses a keg (3 s within 3 m; moving breaks it): 30 points, no blast', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 }, waves: { w1Raiders: 0, w1Sappers: 1, w2Raiders: 0, w2Archers: 0, w2Sappers: 0, w2Rams: 0, w3Elite: 0, w3Rams: 0 }, army: { fuseSec: 60 } } })
    x.s.start('gm', 0, x.h.now)
    x.tick(120_000)
    const ev = x.s.ev!
    const k = [...ev.kegs.values()][0]!
    expect(k).toBeDefined()
    const d = x.defender(k.at[0] + 1, k.at[2], 'Defuser')
    const req = (id: number) => x.h.req(d.p, { t: 'kegDefuse', id })
    req(k.id)
    expect(x.h.result(d.inbox, 'kegDefuse')).toMatchObject({ ok: true })
    // moving breaks it
    x.h.world.moveTo(d.p, k.at[0] + 6, k.at[2], x.h.now)
    x.tick(500)
    expect(k.defuse).toBeNull()
    x.h.world.warp(d.p, k.at[0] + 1, 0, k.at[2], x.h.now)
    req(k.id)
    expect(x.h.result(d.inbox, "kegDefuse"), JSON.stringify(k)).toMatchObject({ ok: true })
    x.tick(1000)
    expect(k.defuse, JSON.stringify([k, x.h.world.positionAt(d.p, x.h.now), d.p.hp, d.p.dead])).not.toBeNull()
    x.tick(3100)
    expect(ev.kegs.size, JSON.stringify([k, x.h.now, x.h.world.positionAt(d.p, x.h.now), d.p.hp, x.s.ev?.phase])).toBe(0)
    expect(x.h.all(d.inbox, 'kegEnd').at(-1)).toMatchObject({ id: k.id, how: 'defused' })
    expect(ev.contrib.get(d.p.characterId)!.parts.defuse).toBe(30)
    // too far
    const far = x.defender(500 - 1, 0)
    x.h.req(far.p, { t: 'kegDefuse', id: 999 })
    expect(x.h.result(far.inbox, 'kegDefuse')).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('waves come on time, or early when 80 % of the last are dead; the Warlord HP scales with the defenders; won pays gold, Seals and the title', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1, waveGapMin: 3 }, waves: { w1Raiders: 5, w1Sappers: 0, w2Raiders: 4, w2Archers: 1, w2Sappers: 0, w2Rams: 1, w3Elite: 2, w3Rams: 0 } } })
    // ten defenders of level ≥ 10 near the town: s = 2^0.8
    const ds = Array.from({ length: 10 }, (_, i) => x.defender(100 + i, 100, `Def${i}`))
    x.s.start('gm', 0, x.h.now)
    x.tick(100)
    const ev = x.s.ev!
    expect(ev.defenders).toBe(10)
    expect(x.foes('raider')).toHaveLength(scaledCount(5, siegeScale(10, SIEGE_EVENT_DEFAULTS.army)))
    // kill 80 % of wave 1: wave 2 comes early
    const w1 = x.foes()
    for (const m of w1.slice(0, Math.ceil(w1.length * 0.8))) x.kill(ds[0]!.p, m)
    x.tick(300)
    expect(ev.phase).toBe('wave2')
    expect(x.foes('ram')).toHaveLength(1)
    expect(x.foes('ram')[0]!.variant).toBe('giant')
    expect(x.foes('archer')).toHaveLength(2)
    // wave 3 on time
    x.tick(3 * MIN)
    expect(ev.phase).toBe('wave3')
    const lord = x.foes('warlord')[0]!
    expect(lord.def.code).toBe(SIEGE_EVENT_CODES.warlord)
    expect(lord.maxHp).toBe(warlordHp(siegeScale(10, SIEGE_EVENT_DEFAULTS.army), SIEGE_EVENT_DEFAULTS.army))
    expect(x.foes('raider').filter((m) => m.variant === 'champion')).toHaveLength(scaledCount(2, ev.scale))
    // the Warlord falls to Def0: won
    x.kill(ds[0]!.p, lord)
    x.tick(300)
    expect(ev.phase).toBe('ended')
    expect(ev.outcome).toBe('won')
    const rw = x.last(ds[0]!.inbox, 'siegeReward')!.reward
    expect(rw).toMatchObject({ outcome: 'won', rank: 1 })
    expect(rw.points).toBeGreaterThanOrEqual(300)
    expect(rw.gold).toBe(Math.min(30_000, rw.points * 50))
    expect(rw.seals).toBe(Math.min(10, Math.floor(rw.points / 50)))
    expect(rw.title).toBe(SIEGE_HONOR)
    expect(x.h.store.loadInventory(ds[0]!.p.characterId).gold).toBeGreaterThanOrEqual(rw.gold)
    expect(x.h.store.loadInventory(ds[0]!.p.characterId).bag.some((it) => it?.code === SIEGE_EVENT_CODES.seal && it.count === rw.seals)).toBe(true)
    expect(x.h.world.state(ds[0]!.p).honor).toBe(SIEGE_HONOR)
    // the others did nothing: nothing for them
    expect(x.last(ds[1]!.inbox, 'siegeReward')).toBeUndefined()
    // the army flees and is gone within a minute; the Bell too
    expect(x.foes().every((m) => m.siege!.mode === 'flee')).toBe(true)
    x.tick(61_000)
    expect(x.foes()).toHaveLength(0)
    expect(x.s.ev).toBeNull()
    expect(x.s.store.contribOf(ev.id)[0]).toMatchObject({ character_id: ds[0]!.p.characterId, gold: rw.gold, seals: rw.seals })
    expect(x.s.store.get(ev.id)).toMatchObject({ phase: 'ended', outcome: 'won' })
  })

  it('lost on the Bell: a quarter of the gold, no Seals; siege monsters give 50 % EXP and no loot', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 }, waves: { w1Raiders: 2, w1Sappers: 0 } } })
    const d = x.defender(150, 150, 'Aki')
    x.s.start('gm', 0, x.h.now)
    x.tick(100)
    const ev = x.s.ev!
    // Aki kills one raider: half its EXP, no drops
    const r = x.foes('raider')[0]!
    expect(r.tuning?.expMul).toBe(0.5)
    expect(killExp(r).exp).toBe(Math.round(killExp({ ...r, tuning: undefined }).exp * 0.5))
    const items = x.h.world.items.size
    x.kill(d.p, r)
    expect(x.h.world.items.size).toBe(items)
    expect(ev.contrib.get(d.p.characterId)!.points).toBeGreaterThan(0)
    ev.contrib.get(d.p.characterId)!.points = 100
    // the Bell falls
    const bell = x.bell()!
    x.h.gameplay.dealHits(x.foes('raider')[0]!, bell, [{ outcome: 'hit', damage: bell.hp, hp: 0 }], {}, x.h.now)
    x.tick(300)
    expect(ev.outcome).toBe('lost_bell')
    expect(x.last(d.inbox, 'siegeReward')!.reward).toMatchObject({ outcome: 'lost_bell', gold: 1250, seals: 0 })
    expect(x.last(d.inbox, 'siegeReward')!.reward.title).toBeUndefined()
    expect(x.h.all(d.inbox, 'siegeNotice').at(-1)).toMatchObject({ event: 'phase', phase: 'ended', outcome: 'lost_bell' })
  })

  it('lost on time; a stop is cancelled with nothing paid', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1, durationMin: 15 }, waves: { w1Raiders: 1, w1Sappers: 0, w2Raiders: 0, w2Archers: 0, w2Sappers: 0, w2Rams: 0, w3Elite: 0, w3Rams: 0 }, army: { raiderIp: 0, warlordIp: 0 } } })
    x.s.start('gm', 0, x.h.now)
    x.tick(100)
    x.s.gm(null, ['wave', '3'], x.h.now)
    expect(x.s.ev!.phase).toBe('wave3')
    x.tick(15 * MIN)
    expect(x.s.store.list()[0]!.outcome).toBe('lost_time')
    const y = siegeHarness()
    y.s.start('gm', 1, y.h.now)
    expect(y.s.gm(null, ['stop'], y.h.now).ok).toBe(true)
    expect(y.s.store.list()[0]).toMatchObject({ outcome: 'cancelled' })
  })

  it("a defender's hit on the Bell repairs it (at most every 2 s; 15 points)", () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 }, waves: { w1Raiders: 0, w1Sappers: 0 } } })
    x.s.start('gm', 0, x.h.now)
    x.tick(100)
    const d = x.defender(2, 0, 'Bellringer')
    const bell = x.bell()!
    bell.hp = 10_000
    x.h.gameplay.dealHits(d.p, bell, [{ outcome: 'hit', damage: 500, hp: 0 }], {}, x.h.now)
    expect(bell.hp).toBe(10_000 + 150)
    x.h.gameplay.dealHits(d.p, bell, [{ outcome: 'hit', damage: 500, hp: 0 }], {}, x.h.now)
    expect(bell.hp).toBe(10_150)
    x.tick(2100)
    x.h.gameplay.dealHits(d.p, bell, [{ outcome: 'hit', damage: 500, hp: 0 }], {}, x.h.now)
    expect(bell.hp).toBe(10_300)
    expect(x.s.ev!.contrib.get(d.p.characterId)!.parts.bell).toBe(30)
  })

  it('kit repairs and donations during the siege are contributions (donations capped at 50)', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 }, waves: { w1Raiders: 0, w1Sappers: 0 } } })
    const d = x.defender(150, 150, 'Mason')
    x.s.start('gm', 0, x.h.now)
    x.walls.set('N1', 10_000, 'gm', x.h.now)
    x.walls.set('N1', 10_200, 'kit', x.h.now, d.p.characterId)
    x.walls.note('N1', 'donation', x.h.now, d.p.characterId, { gold: 50_000 })
    x.walls.note('N1', 'donation', x.h.now, d.p.characterId, { gold: 50_000 })
    const c = x.s.ev!.contrib.get(d.p.characterId)!
    expect(Math.round(c.parts.kit!)).toBe(10)
    expect(Math.round(c.parts.donation!)).toBe(50)
  })

  it('gate wards: a siege monster stops at the gate line; a player walks through', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 }, waves: { w1Raiders: 1, w1Sappers: 0 } } })
    x.s.start('gm', 5, x.h.now)
    const m = x.foes('raider')[0]!
    x.h.world.warp(m, 60, 0, -120, x.h.now)
    x.h.world.walkEntity(m, 60, -60, 5, x.h.now)
    expect(m.move!.to[2]).toBeCloseTo(-100.75, 3)
    const d = x.defender(60, -120)
    x.h.world.walkEntity(d.p, 60, -60, 5, x.h.now)
    expect(d.p.move!.to[2]).toBeCloseTo(-60, 3)
  })
})

// ---- the schedule (§6.7) --------------------------------------------------------------------------------------------------------

describe('the schedule (§6.7)', () => {
  /** Sunday 4 Oct 2026, 19:59 UTC. */
  const SUN = Date.UTC(2026, 9, 4, 19, 59)
  const at = (x: ReturnType<typeof siegeHarness>, t: number) => {
    x.h.now = t
    x.h.gameplay.now = t
  }

  it('off by default; on, it starts the warning at Sunday 20:00 server time with enough players', () => {
    const x = siegeHarness({ patch: { schedule: { tz: 'UTC' } } })
    at(x, SUN)
    x.tick(120_000)
    expect(x.s.ev).toBeNull()
    expect(x.s.next).toBeNull()
    x.s.applyPatch({ enabled: true, schedule: { tz: 'UTC' }, timing: { approaches: 1 } }, 1)
    for (let i = 0; i < 5; i++) x.defender(i, 50, `P${i}`)
    at(x, SUN)
    x.tick(100)
    expect(x.s.next).toBe(Date.UTC(2026, 9, 4, 20, 0))
    x.tick(61_000)
    expect(x.s.ev?.phase).toBe('warning')
    expect(x.s.ev?.origin).toBe('schedule')
    expect(x.s.next).toBe(Date.UTC(2026, 9, 11, 20, 0))
  })

  it('skipped with fewer than 5 eligible players online (a skipped row)', () => {
    const x = siegeHarness({ patch: { enabled: true, schedule: { tz: 'UTC' } } })
    for (let i = 0; i < 4; i++) x.defender(i, 50, `P${i}`)
    x.h.hero({ pos: [0, 0, 60], level: 5, name: 'Lowbie' })
    at(x, SUN)
    x.tick(61_000)
    expect(x.s.ev).toBeNull()
    expect(x.s.store.list()[0]).toMatchObject({ origin: 'schedule', outcome: 'skipped' })
    expect(x.h.logs.some((l) => /skipped: only 4 eligible players online/.test(l))).toBe(true)
  })

  it('a Night of the Tiger on: the siege waits 30 min (twice), then it is skipped', () => {
    const x = siegeHarness({ uniques: true, patch: { enabled: true, schedule: { tz: 'UTC' } } })
    for (let i = 0; i < 5; i++) x.defender(i, 50, `P${i}`)
    const pilot = x.g.pilot!
    pilot.event = { phase: 'hunt', id: 9 } as unknown as typeof pilot.event
    at(x, SUN)
    x.tick(61_000)
    expect(x.s.ev).toBeNull()
    expect(x.s.waitUntil).toBe(Date.UTC(2026, 9, 4, 20, 30, 0))
    x.tick(30 * MIN)
    expect(x.s.ev).toBeNull()
    // the Night ends: it starts at the next check
    pilot.event = null
    x.tick(31 * MIN)
    expect(x.s.ev?.phase).toBe('warning')
  })

  it('a Night of the Tiger due during a siege waits', () => {
    const x = siegeHarness({ uniques: true })
    expect(x.s.busyWhy()).toBeNull()
    x.s.start('gm', 5, x.h.now)
    expect(x.s.busyWhy()).toMatch(/Siege of Jangan/)
  })
})

// ---- restarts (§6.7) -----------------------------------------------------------------------------------------------------------

describe('restarts (§6.7)', () => {
  /** A second Gameplay over the same database: the server after a restart. */
  function restart(x: ReturnType<typeof siegeHarness>) {
    const g2 = new Gameplay({ world: x.h.world, data: x.h.data, store: x.h.store, config: x.h.config, setup: x.g.setup, nav: x.g.nav, rng: () => 0.5 })
    g2.siege.configure({ walls: new StandIn(), lanes: flatLanes(), bell: [0, 0] })
    g2.siege.applyPatch({ timing: { approaches: 1 } }, 0)
    return g2
  }

  it('the warning resumes after a restart with at least 3 min left; the Bell and wave 1 are back', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 } } })
    x.s.start('gm', 2, x.h.now)
    const id = x.s.ev!.id
    for (const m of [...x.h.world.mobs.values()]) x.h.world.removeEntity(m.id)
    const g2 = restart(x)
    g2.siege.tick(x.h.now + 1000)
    const ev = g2.siege.ev!
    expect(ev.id).toBe(id)
    expect(ev.phase).toBe('warning')
    expect(ev.wave1At).toBe(x.h.now + 1000 + RESUME_MIN_MS)
    expect(g2.siege.bellMob()).not.toBeNull()
    expect(g2.siege.foes()).toBeGreaterThan(0)
  })

  it('a wave found at boot ends `restart`: nothing paid, the walls as they were', () => {
    const x = siegeHarness({ patch: { timing: { approaches: 1 } } })
    x.s.start('gm', 0, x.h.now)
    x.tick(100)
    expect(x.s.ev!.phase).toBe('wave1')
    const id = x.s.ev!.id
    const g2 = restart(x)
    g2.siege.tick(x.h.now + 1000)
    expect(g2.siege.ev).toBeNull()
    expect(g2.siege.store.get(id)).toMatchObject({ phase: 'ended', outcome: 'restart' })
    expect(g2.siege.store.contribOf(id)).toEqual([])
  })
})

// ---- the admin routes (§11.3) -------------------------------------------------------------------------------------------------

describe('admin routes (§11.3)', () => {
  function admin() {
    const x = siegeHarness()
    const d = x.defender(0, 300, 'Root')
    const ctx = { gameplay: x.g, world: x.h.world, data: x.h.data, store: x.h.store, config: x.h.config } as unknown as GameContext
    const actor = { accountId: x.h.store.characterById(d.p.characterId)!.account_id, role: 'admin' as const, username: 'root' }
    const call = async <T = Record<string, unknown>>(method: string, sub: string, body?: unknown, role: 'admin' | 'gm' | 'player' = 'admin') =>
      (await routeAdminSiege(ctx, { method, path: `/api/admin/siege${sub}`, query: new URLSearchParams(''), body, actor: { ...actor, role } })) as { status: number; body: T }
    return { ...x, call }
  }

  it('admin accounts only, on every endpoint', async () => {
    const x = admin()
    for (const [m, sub] of [['GET', ''], ['PUT', '/settings'], ['POST', '/start'], ['POST', '/stop'], ['POST', '/wall'], ['GET', '/events']] as const) {
      expect((await x.call(m, sub, {}, 'gm')).status, `${m} ${sub}`).toBe(403)
      expect((await x.call(m, sub, {}, 'player')).status, `${m} ${sub}`).toBe(403)
    }
  })

  it('GET: walls, lanes, schedule, settings; start and stop; the event log with its timeline', async () => {
    const x = admin()
    const v = (await x.call<AdminSiegeView>('GET', '')).body
    expect(v.walls.map((w) => w.id)).toEqual(['N1', 'N2', 'W1'])
    expect(v.lanes.map((l) => l.approach)).toEqual(['N', 'W'])
    expect(v.settings).toMatchObject({ rev: 0, defaults: SIEGE_EVENT_DEFAULTS })
    expect(v.current).toBeNull()
    expect((await x.call('POST', '/start', { warningMin: 99 })).status).toBe(400)
    const st = await x.call<{ event: number }>('POST', '/start', { warningMin: 3 })
    expect(st.status).toBe(200)
    expect((await x.call<AdminSiegeView>('GET', '')).body.current).toMatchObject({ phase: 'warning', origin: 'admin', bellHp: 30_000 })
    expect((await x.call('POST', '/start', {})).status).toBe(409)
    expect((await x.call('POST', '/stop', {})).status).toBe(200)
    const list = (await x.call<{ events: { id: number; outcome: string }[] }>('GET', '/events')).body.events
    expect(list[0]).toMatchObject({ id: st.body.event, outcome: 'cancelled' })
    const one = (await x.call<{ log: { kind: string }[] }>('GET', `/events/${st.body.event}`)).body
    expect(one.log.map((l) => l.kind)).toEqual(['start', 'reward', 'end'])
    expect((await x.call('GET', '/events/999')).status).toBe(404)
  })

  it('settings: saved and applied, a stale rev 409, out of bounds 422 with issues, reset', async () => {
    const x = admin()
    const r = await x.call<{ rev: number; patch: unknown }>('PUT', '/settings', { baseRev: 0, patch: { enabled: true, timing: { warningMin: 10, waveGapMin: 6 } } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ rev: 1, patch: { enabled: true, timing: { waveGapMin: 6 } } })
    expect(x.s.settings.timing.waveGapMin).toBe(6)
    expect(x.s.store.settingsOf('jangan')).toMatchObject({ rev: 1 })
    expect((await x.call('PUT', '/settings', { baseRev: 0, patch: { bell: { hp: 9 } } })).status).toBe(409)
    const bad = await x.call<{ issues: { path: string }[] }>('PUT', '/settings', { baseRev: 1, patch: { bell: { hp: 9 }, nope: {} } })
    expect(bad.status).toBe(422)
    expect(bad.body.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['bell.hp', 'nope']))
    const reset = await x.call<{ patch: unknown }>('POST', '/settings/reset', { baseRev: 1, paths: ['timing'] })
    expect(reset.body.patch).toEqual({ enabled: true })
    // a reload reads the stored patch
    x.s.loadSettings()
    expect(x.s.patch).toEqual({ enabled: true })
    expect(x.s.rev).toBe(2)
  })

  it('the walls: off on a world without them', async () => {
    const x = admin()
    expect((await x.call('POST', '/wall', { seg: 'N1', pct: 50 })).status).toBe(409)
  })
})

