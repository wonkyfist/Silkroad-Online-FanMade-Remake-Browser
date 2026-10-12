/**
 * docs/SERVER_ARCHITECTURE.md phase P0: the monster pass's player grid (MOB_GRID), the recipient index (WATCHERS),
 * encode-once (ENCODE_ONCE) and the interest pass's quick path (AOI_FAST) change no decision and no message. Two worlds
 * run the same seeded script in lockstep, one with every switch on and one with all of them off (the paths from before
 * P0): after every tick the monsters' states and every client's known set match, and at the end every client's whole
 * message stream (each recipient's own order included). Unit checks pin the grid, the scans and the index.
 *
 * Phase P1b (AOI_JOBS): the same lockstep with the interest pass's per-viewer work on worker threads (aoi/) against the
 * tick thread's own pass: the same known sets, crowds and streams.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage, Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL_M, PlayerGrid, SCAN_MARGIN_M, cellX, cellZ } from '../src/cells.ts'
import { loadConfig } from '../src/config.ts'
import { REGION_SIZE_M, regionAt, type WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { encodeStats, type Encoded } from '../src/encode.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { KnownSet } from '../src/known.ts'
import { FlatNav } from '../src/nav.ts'
import { World, firstSorted, type Player } from '../src/world.ts'
import { perfTile } from '../src/admin/api.ts'
import { PH, PHASES, PhaseTimers } from '../src/phases.ts'
import { AoiPool } from '../src/aoi/pool.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, mob, seeded } from './fixtures.ts'
import { startTestServer, testConfig } from './helpers.ts'

/** An aggressive mob that fights a level-1 character for a while (deaths, retargets and leashes all happen). */
const WOLF = mob('MOB_CH_WOLF', { name: 'Wolf', level: 3, hp: 400, physAttack: [6, 9], hitRate: 60, attackRange: 1.5, attackIntervalMs: 900, radius: 0.8, walkSpeed: 2, runSpeed: 6, aggressive: true })

interface Switches {
  mobGrid: boolean
  watchers: boolean
  encodeOnce: boolean
  aoiFast: boolean
  /** P1b: the interest pass on these worker threads (every pass, however few players). */
  aoiJobs?: AoiPool
}
const ON: Switches = { mobGrid: true, watchers: true, encodeOnce: true, aoiFast: true }
const OFF: Switches = { mobGrid: false, watchers: false, encodeOnce: false, aoiFast: false }

const cleanups: (() => void)[] = []
const servers: { stopAndClean(): Promise<void> }[] = []
afterEach(async () => {
  while (cleanups.length) cleanups.pop()!()
  for (const s of servers.splice(0)) await s.stopAndClean()
})

function sim(sw: Switches) {
  const root = mkdtempSync(join(tmpdir(), 'sro-p0-'))
  const config = { ...testConfig(root), rng: seeded(11) }
  const store = openStore(config.dataDir)
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  world.mobGrid = sw.mobGrid
  world.useWatchers = sw.watchers
  world.encodeOnce = sw.encodeOnce
  world.aoiFast = sw.aoiFast
  if (sw.aoiJobs) {
    world.aoiJobs = sw.aoiJobs
    world.aoiJobsMin = 0
  }
  // the crowd cap in play: groups of 7+ players see at most 5 of each other
  world.maxVisiblePlayers = 5
  world.crowdRepickPasses = 2
  const data = new GameData({ mobs: [WOLF, MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(11) })
  const inbox = new Map<number, string[]>()
  const badEnc: string[] = []
  let n = 0
  const enter = (pos: Vec3, dead = false): Player => {
    const acc = store.createAccount(`acc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const box: string[] = []
    const send = (m: ServerMessage, enc?: Encoded) => {
      const json = JSON.stringify(m)
      if (enc && enc.msg === m && enc.buf.toString('utf8') !== json) badEnc.push(json)
      box.push(json)
    }
    const p = world.add({ ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, dead, send })
    if (!dead) world.snapshotFor(p)
    inbox.set(p.id, box)
    return p
  }
  return { world, gameplay, inbox, enter, badEnc }
}

type Sim = ReturnType<typeof sim>

/** Group centres: on a corner where four cells meet, on cell edges, inside cells. */
const GROUPS: [number, number][] = [
  [0, 0],
  [CELL_M + 3, 10],
  [-CELL_M - 2, -CELL_M + 4],
  [300, 300],
  [-350, 120],
  [100, -300],
]

/** One step of the seeded script, applied to a sim (both sims draw the same numbers from their own copy of the rng). */
function setupWorld(s: Sim, r: () => number, now: number): void {
  for (const [gx, gz] of GROUPS) {
    for (let k = 0; k < 8; k++) s.enter([gx + (r() - 0.5) * 30, 0, gz + (r() - 0.5) * 30], k === 7)
    for (let k = 0; k < 12; k++) {
      const a = r() * Math.PI * 2
      const d = 12 + r() * 50
      const m = s.gameplay.createMob(r() < 0.8 ? WOLF : MANGNYANG, 'normal', gx + Math.sin(a) * d, gz + Math.cos(a) * d, 0, null, now)
      m.sightRange = 8 + r() * 25
      m.leashRange = 30 + r() * 40
      m.roamRadius = 4 + r() * 8
    }
  }
  // the rest of the map: dormant monsters far from everyone
  for (let k = 0; k < 60; k++) s.gameplay.createMob(WOLF, 'normal', (r() - 0.5) * 980, (r() - 0.5) * 980, 0, null, now)
  // parties (the crowd cap's must-see by party: World.alsoMustSee / alsoMustSeeKeys)
  const ps = [...s.world.players.values()]
  for (let g = 0; g < GROUPS.length; g++) {
    const members = ps.slice(g * 8, g * 8 + 8).filter((p) => !p.dead)
    const leader = members[0]!
    for (const q of members.slice(1, 4)) {
      if (!leader.known.has(q.id)) continue
      s.gameplay.request(leader, { t: 'partyInvite', target: q.id }, now)
      s.gameplay.request(q, { t: 'partyRespond', inviter: leader.id, accept: true }, now)
    }
  }
  // interest special cases: staff viewers, a veiled boss (Play the Boss, Stalk) and a player viewing from it
  s.world.setStaff(ps[2]!, true, now)
  s.world.setStaff(ps[17]!, true, now)
  const boss = s.gameplay.createMob(WOLF, 'normal', GROUPS[1]![0] + 20, GROUPS[1]![1], 0, null, now)
  boss.veil = 15
  boss.pilot = { player: ps[9]!.id, steering: 'ai' }
  ps[9]!.viewFrom = boss.id
}

function step(s: Sim, r: () => number, now: number, t: number): void {
  const players = [...s.world.players.values()]
  const pick = () => players[Math.floor(r() * players.length)]!
  const group = () => GROUPS[Math.floor(r() * GROUPS.length)]!
  if (players.length && r() < 0.5) {
    const p = pick()
    const [gx, gz] = group()
    if (!p.dead) s.world.moveTo(p, gx + (r() - 0.5) * 80, gz + (r() - 0.5) * 80, now)
  }
  if (players.length && r() < 0.04) {
    const [gx, gz] = group()
    s.world.warp(pick(), gx + (r() - 0.5) * 10, 0, gz + (r() - 0.5) * 10, now)
  }
  if (players.length > 20 && r() < 0.02) {
    const p = pick()
    s.world.remove(p.id, now)
    s.gameplay.forget(p)
  }
  if (r() < 0.03) {
    const [gx, gz] = group()
    s.enter([gx + (r() - 0.5) * 20, 0, gz + (r() - 0.5) * 20])
  }
  if (players.length && r() < 0.05) {
    const p = pick()
    s.world.sayLocal(p, { t: 'chat', channel: 'local', fromId: p.id, from: p.name, text: `line ${t}` }, now)
  }
  if (players.length && r() < 0.02) {
    const p = pick()
    s.world.setInvisible(p, !p.invisible, now)
  }
  if (players.length && r() < 0.01) {
    const p = pick()
    if (!p.dead) s.gameplay.playerDied(p, now)
  }
  // a player fight: both always see each other for a while, crowd or not (World.mustSee)
  if (players.length > 1 && r() < 0.05) s.world.noteFoes(pick(), pick(), now)
  // players fight monsters they see (combat to both sides' viewers, kills, drops)
  if (players.length && r() < 0.15) {
    const p = pick()
    const mobs = [...p.known].filter((id) => s.world.mobs.has(id))
    if (mobs.length) s.gameplay.request(p, { t: 'attack', target: mobs[Math.floor(r() * mobs.length)]! }, now)
  }
  s.world.tick(now)
}

const mobsOf = (s: Sim) => [...s.world.mobs.values()].map((m) => `${m.id}:${m.ai}:${m.target}:${m.hp}:${m.pos.join(',')}:${m.move ? m.move.to.join(',') : '-'}`)
const playersOf = (s: Sim) => [...s.world.players.values()].map((p) => `${p.id}:${p.hp}:${p.dead}:${[...p.known].sort((a, b) => a - b).join(',')}`)
/** Each player's crowd in its own order (null / undefined as such). */
const crowdsOf = (s: Sim) => [...s.world.players.values()].map((p) => `${p.id}:${p.crowd === undefined ? 'u' : p.crowd === null ? 'n' : [...p.crowd].join(',')}`)

describe('P0 changes no decision and no message (lockstep, every switch on vs off)', () => {
  it('monsters, known sets and every message stream are identical over 300 ticks', () => {
    const a = sim(ON)
    const b = sim(OFF)
    const ra = seeded(99)
    const rb = seeded(99)
    const t0 = Date.now() + 60_000
    // both worlds see the same clock wherever the code reads Date.now() itself (no real-time skew between them)
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    cleanups.push(() => vi.useRealTimers())
    setupWorld(a, ra, t0)
    setupWorld(b, rb, t0)
    let fights = 0
    for (let t = 1; t <= 300; t++) {
      const now = t0 + t * 50
      vi.setSystemTime(now)
      step(a, ra, now, t)
      step(b, rb, now, t)
      expect(mobsOf(a), `monsters after tick ${t}`).toEqual(mobsOf(b))
      expect(playersOf(a), `players after tick ${t}`).toEqual(playersOf(b))
      fights += [...a.world.mobs.values()].filter((m) => m.ai === 'chase').length
    }
    // the script really exercised the AI: chases, kills and corpses
    expect(fights).toBeGreaterThan(100)
    expect(a.inbox.size).toBe(b.inbox.size)
    let total = 0
    for (const [id, box] of a.inbox) {
      expect(box, `messages of player ${id}`).toEqual(b.inbox.get(id))
      total += box.length
    }
    expect(total).toBeGreaterThan(2000)
    expect(a.badEnc).toEqual([])
    // gameplay's must-see rule and its keys form agree on every pair (parties formed above)
    const w = a.world
    const ps = [...w.players.values()]
    let together = 0
    for (const v of ps) {
      for (const o of ps) {
        const kv = w.alsoMustSeeKeys!(v)
        const ko = w.alsoMustSeeKeys!(o)
        const byKeys = kv.some((k, i) => k != null && k === ko[i])
        expect(byKeys, `${v.name} / ${o.name}`).toBe(w.alsoMustSee!(v, o))
        if (byKeys && v !== o) together++
      }
    }
    expect(together).toBeGreaterThan(10)
  })
})

describe('P1b: AOI_JOBS changes no decision and no message (lockstep, worker threads vs the tick thread)', () => {
  async function readyPool(n: number): Promise<AoiPool> {
    const logs: string[] = []
    const pool = new AoiPool(n, (l) => logs.push(l))
    cleanups.push(() => void pool.close())
    const end = Date.now() + 10_000
    while (!pool.ready) {
      if (Date.now() > end) throw new Error(`no aoi worker ready: ${logs.join('; ')}`)
      await new Promise((r) => setTimeout(r, 20))
    }
    return pool
  }

  it('known sets, crowds and every message stream are identical over 300 ticks', async () => {
    const pool = await readyPool(2)
    const a = sim({ ...ON, aoiJobs: pool })
    const b = sim(ON)
    const ra = seeded(99)
    const rb = seeded(99)
    const t0 = Date.now() + 60_000
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    cleanups.push(() => vi.useRealTimers())
    setupWorld(a, ra, t0)
    setupWorld(b, rb, t0)
    for (let t = 1; t <= 300; t++) {
      const now = t0 + t * 50
      vi.setSystemTime(now)
      step(a, ra, now, t)
      step(b, rb, now, t)
      expect(playersOf(a), `players after tick ${t}`).toEqual(playersOf(b))
      expect(crowdsOf(a), `crowds after tick ${t}`).toEqual(crowdsOf(b))
      expect(mobsOf(a), `monsters after tick ${t}`).toEqual(mobsOf(b))
    }
    let total = 0
    for (const [id, box] of a.inbox) {
      expect(box, `messages of player ${id}`).toEqual(b.inbox.get(id))
      total += box.length
    }
    expect(total).toBeGreaterThan(2000)
    // the workers really did the slices (a 50 ms wait covers any slice of this world)
    const st = pool.snapshot()
    expect(st.passes).toBeGreaterThan(50)
    expect(st.workerSliceMs).toBeGreaterThan(0)
    expect(st.fallbacks).toBeLessThan(st.passes)
    // crowds were really in force (groups of 7+ see at most 5 of each other)
    expect([...a.world.players.values()].some((p) => p.crowd && p.crowd.size > 0)).toBe(true)
  }, 60_000)

  it('a dead worker costs nothing but speed: its slice is computed on the tick thread, and it is started again', async () => {
    const pool = await readyPool(1)
    const a = sim({ ...ON, aoiJobs: pool })
    const b = sim(ON)
    const ra = seeded(5)
    const rb = seeded(5)
    const t0 = Date.now() + 60_000
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    cleanups.push(() => vi.useRealTimers())
    setupWorld(a, ra, t0)
    setupWorld(b, rb, t0)
    for (let t = 1; t <= 80; t++) {
      if (t === 20) pool.crash(0)
      const now = t0 + t * 50
      vi.setSystemTime(now)
      step(a, ra, now, t)
      step(b, rb, now, t)
      expect(playersOf(a), `players after tick ${t}`).toEqual(playersOf(b))
      expect(crowdsOf(a), `crowds after tick ${t}`).toEqual(crowdsOf(b))
    }
    for (const [id, box] of a.inbox) expect(box, `messages of player ${id}`).toEqual(b.inbox.get(id))
    vi.useRealTimers()
    const end = Date.now() + 10_000
    while (pool.snapshot().restarts < 1 || !pool.ready) {
      if (Date.now() > end) throw new Error('the worker was not started again')
      await new Promise((r) => setTimeout(r, 50))
    }
  }, 60_000)
})

describe('the monster pass player grid (cells.ts)', () => {
  it('cells are the navmesh regions (192 m, regionAt axes)', () => {
    expect(CELL_M).toBe(REGION_SIZE_M)
    const origin = { ox: 100, oz: 100 }
    for (const [x, z] of [[0, 0], [191.9, -0.1], [-0.1, 0.1], [500, -700], [-384.5, 384.5]] as const) {
      const r = regionAt(origin, x, z)!
      expect([cellX(x), cellZ(z)]).toEqual([r.rx - origin.ox, r.rz - origin.oz])
    }
  })

  it('the wake check answers exactly like the full scan of the alive players', () => {
    const r = seeded(3)
    const players = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, dead: r() < 0.2, pos: [(r() - 0.5) * 3000, 0, (r() - 0.5) * 3000] as Vec3 }) as unknown as Player)
    const grid = new PlayerGrid(players, players.length, (p) => p.pos, 0, 0)
    const active = players.filter((p) => !p.dead).map((p) => p.pos)
    for (let k = 0; k < 4000; k++) {
      const pos: Vec3 = [(r() - 0.5) * 3200, 0, (r() - 0.5) * 3200]
      // radii around the cell size, and exact cell edges
      if (k % 7 === 0) pos[0] = Math.round(pos[0] / CELL_M) * CELL_M
      const wake = (40 + r() * 200) ** 2
      expect(grid.anyAliveWithin(pos[0], pos[2], wake)).toBe(active.some((q) => (q[0] - pos[0]) ** 2 + (q[2] - pos[2]) ** 2 <= wake))
    }
  })

  it('candidates hold every player in range (with the margin) in world.players order', () => {
    const r = seeded(4)
    const players = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, dead: false, pos: [(r() - 0.5) * 2000, 0, (r() - 0.5) * 2000] as Vec3 }) as unknown as Player)
    const grid = new PlayerGrid(players, players.length, (p) => p.pos, 0, 0)
    for (let k = 0; k < 2000; k++) {
      const x = (r() - 0.5) * 2100
      const z = (r() - 0.5) * 2100
      const range = k % 50 === 0 ? 1e9 : r() * 260
      const want = players.filter((p) => (p.pos[0] - x) ** 2 + (p.pos[2] - z) ** 2 <= (range + SCAN_MARGIN_M) ** 2)
      expect(grid.candidates(x, z, range)).toEqual(want)
    }
  })
})

describe('World.playersNear inside the monster pass', () => {
  function world() {
    const w = new World('jangan', 5, 20, null)
    const r = seeded(8)
    const now = Date.now()
    for (let i = 0; i < 120; i++) {
      const p = w.add({ characterId: i + 1, name: `P${i}`, model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [(r() - 0.5) * 900, 0, (r() - 0.5) * 900], yaw: 0, send: () => {} })
      // some walk: their live position is along the segment
      if (i % 3 === 0) w.moveTo(p, p.pos[0] + 30, p.pos[2] - 20, now - 2000)
      if (i % 11 === 0) p.dead = true
    }
    return { w, r, now }
  }

  it('gives the full scan result, in the same order, also after teleports, logins and logouts in the pass', () => {
    const { w, r, now } = world()
    const full = (x: number, z: number, range: number) => {
      const out: Player[] = []
      for (const p of w.players.values()) {
        const q = w.positionAt(p, now)
        if ((q[0] - x) ** 2 + (q[2] - z) ** 2 <= range * range) out.push(p)
      }
      return out
    }
    expect(w.beginPlayerScan(now)).not.toBeNull()
    const check = () => {
      for (let k = 0; k < 300; k++) {
        const x = (r() - 0.5) * 950
        const z = (r() - 0.5) * 950
        const range = r() * 220
        expect(w.playersNear(x, z, range, now)).toEqual(full(x, z, range))
      }
    }
    check()
    const ps = [...w.players.values()]
    w.warp(ps[5]!, 400, 0, 400, now)
    w.warp(ps[9]!, -10, 0, 3, now)
    check()
    w.remove(ps[20]!.id, now)
    w.add({ characterId: 999, name: 'Late', model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [1, 0, 1], yaw: 0, send: () => {} })
    check()
    w.endPlayerScan()
    // outside the pass (another `now`): the full scan itself
    expect(w.playersNear(0, 0, 200, now + 1)).toEqual([...w.players.values()].filter((p) => {
      const q = w.positionAt(p, now + 1)
      return q[0] ** 2 + q[2] ** 2 <= 200 * 200
    }))
  })

  it('MOB_GRID off: no grid', () => {
    const { w, now } = world()
    w.mobGrid = false
    expect(w.beginPlayerScan(now)).toBeNull()
  })
})

describe('AOI_FAST crowd picks', () => {
  it('firstSorted gives the head of the stable sort, ties included', () => {
    const r = seeded(12)
    for (let k = 0; k < 400; k++) {
      const list = Array.from({ length: Math.floor(r() * 60) }, (_, pos) => ({ id: pos + 1, d: Math.floor(r() * 8) - 2, shown: r() < 0.5, pos }))
      const n = Math.floor(r() * 20)
      expect(firstSorted(list, n)).toEqual(list.slice().sort((x, y) => x.d - y.d).slice(0, n))
    }
  })

  it('crowds of players on a lattice (many equal distances) are the same as pickCrowd picks, pass after pass', () => {
    const make = (fast: boolean) => {
      const w = new World('jangan', 5, 20, null)
      w.aoiFast = fast
      w.maxVisiblePlayers = 7
      w.crowdRepickPasses = 1
      const boxes = new Map<number, string[]>()
      for (let i = 0; i < 60; i++) {
        const box: string[] = []
        const p = w.add({ characterId: i + 1, name: `P${i}`, model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [(i % 8) * 4, 0, Math.floor(i / 8) * 4], yaw: 0, send: (m) => box.push(JSON.stringify(m)) })
        boxes.set(p.id, box)
      }
      return { w, boxes }
    }
    const a = make(true)
    const b = make(false)
    const ra = seeded(21)
    const rb = seeded(21)
    let now = Date.now() + 10_000
    const crowds = (w: World) => [...w.players.values()].map((p) => `${p.id}:${p.crowd ? [...p.crowd].sort((x, y) => x - y).join(',') : '-'}:${[...p.known].sort((x, y) => x - y).join(',')}`)
    for (let pass = 0; pass < 60; pass++) {
      now += 200
      for (const [s, r] of [[a, ra], [b, rb]] as const) {
        const ps = [...s.w.players.values()]
        // jumps on the 4 m lattice keep distances equal; fights make must-see players
        for (let j = 0; j < 6; j++) ps[Math.floor(r() * ps.length)]!.pos = [Math.floor(r() * 8) * 4, 0, Math.floor(r() * 8) * 4]
        if (r() < 0.3) s.w.noteFoes(ps[Math.floor(r() * ps.length)]!, ps[Math.floor(r() * ps.length)]!, now)
        s.w.updateInterest(now)
      }
      expect(crowds(a.w), `pass ${pass}`).toEqual(crowds(b.w))
    }
    for (const [id, box] of a.boxes) expect(box).toEqual(b.boxes.get(id))
  })
})

describe('the recipient index (known.ts) and encode-once', () => {
  it('watchers stay the exact inverse of every known set, whoever edits them', () => {
    const w = new World('jangan', 5, 20, null)
    const r = seeded(5)
    const ps = Array.from({ length: 30 }, (_, i) => w.add({ characterId: i + 1, name: `P${i}`, model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [i * 3, 0, 0], yaw: 0, send: () => {} }))
    expect(ps.every((p) => p.known instanceof KnownSet)).toBe(true)
    for (let k = 0; k < 3000; k++) {
      const p = ps[Math.floor(r() * ps.length)]!
      const id = 1 + Math.floor(r() * 60)
      const op = r()
      if (op < 0.5) p.known.add(id)
      else if (op < 0.95) p.known.delete(id)
      else p.known.clear()
    }
    for (let id = 1; id <= 60; id++) {
      const want = ps.filter((p) => w.players.has(p.id) && p.known.has(id)).map((p) => p.id).sort((a, b) => a - b)
      expect([...w.watchersOf(id)].map((p) => p.id).sort((a, b) => a - b)).toEqual(want)
    }
    // a player that left stops being a recipient; its own set keeps what it had
    const gone = ps[3]!
    gone.known.add(ps[4]!.id)
    w.remove(gone.id)
    expect([...w.watchersOf(ps[4]!.id)]).not.toContain(gone)
    expect(gone.known.has(ps[4]!.id)).toBe(true)
  })

  it('a broadcast to many is encoded once, and each recipient gets it once', () => {
    const w = new World('jangan', 5, 20, null)
    const got = new Map<number, number>()
    const mk = (i: number, x: number) => {
      const p = w.add({ characterId: i, name: `P${i}`, model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [x, 0, 0], yaw: 0, send: (m: ServerMessage, enc?: Encoded) => {
        if (m.t !== 'move') return
        got.set(p.id, (got.get(p.id) ?? 0) + 1)
        if (enc?.msg === m) void enc.buf
      } })
      return p
    }
    const mover = mk(1, 0)
    for (let i = 2; i <= 12; i++) mk(i, i)
    w.updateInterest(Date.now())
    const before = encodeStats.n
    w.moveTo(mover, 50, 50)
    expect(encodeStats.n - before).toBe(1)
    expect([...got.values()]).toEqual(Array(12).fill(1))
  })
})

describe('the tick timers (phases.ts) and the performance tile', () => {
  it('phases add up per tick interval; modules are timed one by one; reset clears', () => {
    const t = new PhaseTimers()
    t.add(PH.mobs, 4)
    t.add(PH.interest, 2)
    t.module('weather', 0.5)
    t.module('storm', 1.5)
    t.interval()
    t.add(PH.mobs, 8)
    t.interval()
    const s = t.snapshot()
    expect(s.intervals).toBe(2)
    expect(s.phases.mobs).toEqual({ avgMs: 6, p95Ms: 8, maxMs: 8 })
    expect(s.phases.interest.avgMs).toBe(1)
    expect(s.phases.modules.avgMs).toBe(1)
    expect(s.busyMs).toBe(8)
    expect(s.modules.map((m) => m.name)).toEqual(['storm', 'weather'])
    t.reset()
    expect(t.snapshot().intervals).toBe(0)
    // switched off: nothing is recorded
    const off = new PhaseTimers(false)
    off.add(PH.mobs, 5)
    off.interval()
    expect(off.now()).toBe(0)
    expect(off.snapshot().intervals).toBe(0)
  })

  it('a running server reports its phases, rates, backlog, event loop, switches and memory split', async () => {
    const s = await startTestServer()
    servers.push(s)
    const deadline = Date.now() + 5000
    while (s.ctx.world.ticks < 25 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const snap = s.ctx.net.snapshot()
    expect(snap.phases!.intervals).toBeGreaterThan(10)
    expect(Object.keys(snap.phases!.phases).sort()).toEqual([...PHASES].sort())
    expect(snap.phases!.modules.length).toBeGreaterThan(5)
    expect(snap.switches).toEqual({ tickTimers: true, mobGrid: true, watchers: true, encodeOnce: true, aoiFast: true, gateways: !!process.env.SRO_TEST_GATEWAYS, aoiJobs: !!process.env.SRO_TEST_AOI_JOBS })
    expect(snap.queue).toEqual({ sockets: 0, bufferedBytes: 0, maxBufferedBytes: 0 })
    expect(snap.memory!.map((m) => m.stage)).toEqual(['start', 'content', 'navmesh', 'modules', 'world'])
    const tile = perfTile(snap)
    expect(tile.tick.budgetMs).toBe(50)
    expect(tile.phases!.length).toBe(PHASES.length)
    expect(tile.switches).toEqual(snap.switches)
  })

  it('TICK_TIMERS off: no phases, the rest as before', async () => {
    const s = await startTestServer({ config: { tickTimers: false, mobGrid: false, watchers: false, encodeOnce: false, aoiFast: false } })
    servers.push(s)
    const deadline = Date.now() + 5000
    while (s.ctx.world.ticks < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const snap = s.ctx.net.snapshot()
    expect(snap.phases).toBeUndefined()
    expect(snap.switches).toEqual({ tickTimers: false, mobGrid: false, watchers: false, encodeOnce: false, aoiFast: false, gateways: !!process.env.SRO_TEST_GATEWAYS, aoiJobs: false })
    expect(s.ctx.world.mobGrid || s.ctx.world.useWatchers || s.ctx.world.encodeOnce || s.ctx.world.aoiFast).toBe(false)
    expect(snap.tick.n).toBeGreaterThan(0)
  })
})

describe('switches', () => {
  it('each P0 change has its own off switch, on by default', () => {
    const on = loadConfig({})
    expect([on.tickTimers, on.mobGrid, on.watchers, on.encodeOnce, on.aoiFast]).toEqual([true, true, true, true, true])
    const off = loadConfig({ TICK_TIMERS: 'off', MOB_GRID: 'off', WATCHERS: '0', ENCODE_ONCE: 'false', AOI_FAST: 'no' })
    expect([off.tickTimers, off.mobGrid, off.watchers, off.encodeOnce, off.aoiFast]).toEqual([false, false, false, false, false])
  })
})
