/**
 * Siege of Jangan, layer 1 on the server (docs/SIEGE.md §2, §4, §5, §12, §14):
 * - synthetic: one wall of one segment (three nav pieces) over a flat region with a closed rim of tiles in front: the
 *   stages and their nav (a GM breach opens the middle third and its tiles, rubble all three, a repair closes it and
 *   puts a body standing in the gap back on open ground), the safe-area seam (a breach zone is unsafe), the hysteresis,
 *   lightning and tornado wear stopping at the 35 % floor, a downed rod skipped, natural repair, persistence across a
 *   restart, the messages, and the GM command;
 * - the real jangan-fields export (skipped without it): GM `wall break W3`, a player walks through the gap from the
 *   field into town while a client-side nav fed the same `walls` / `wallUpdate` messages predicts the same walk; the
 *   ground behind is no longer safe; a restart keeps the breach; a repair closes it again.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NavGltf, NavWorld, buildNavData, decodeNavData, navPiecePuts, type NavData, type NavMeshInput } from '@sro/nav'
/** Tiles per region side (@sro/formats NVM_TILES). */
const NVM_TILES = 96
import { WallNavState, type LightningStrike, type ServerMessage, type TornadoState, type Vec3, type WallStage, type WallsExport } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { openStore } from '../src/db.ts'
import type { StrikeEvent } from '../src/lightning/service.ts'
import { MeshNav } from '../src/nav.ts'
import { NATURAL_STEP_MS, TORNADO_STEP_MS, WallService, type WallsHost } from '../src/siege/walls.ts'
import type { TornadoEvent } from '../src/storm/tornado.ts'
import type { Mob, Player } from '../src/world.ts'
import { flatRegion, grid, mesh, placement } from '../../../packages/nav/test/synthetic.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { seeded } from './fixtures.ts'

// ---- the synthetic wall -----------------------------------------------------------------------------------------------

/** Region (100, 100) = the glTF origin region: glTF x = (fileX - 192000) / 10, z = -(fileZ - 192000) / 10. */
const RX = 100, RZ = 100, REGION = (RZ << 8) | RX
const ORIGIN = { x: RX, z: RZ }
const RETAIL_ID = ((REGION << 16) | 0x8001) >>> 0
const pieceId = (k: number) => ((REGION << 16) | (0xf000 | k)) >>> 0
/** The wall: glTF x 51..141 at z -96 (body z -104..-88, the north face outside), raised, nobody stands on it. */
const slab = (x0: number, x1: number): NavMeshInput => {
  const g = grid(x0, x1, -80, 80, 3, 1, () => 200)
  return mesh(g.vertices, g.triangles, () => 3).nav
}
/** A closed rim of tiles just north of the wall (glTF z -110..-108), under the middle third only (x 81..111). */
const rimTiles: [number, number][] = []
for (let tx = 41; tx < 55; tx++) rimTiles.push([REGION, 55 * NVM_TILES + tx])

function navData(): NavData {
  const closed = (tx: number, tz: number) => tz === 55 && tx >= 41 && tx < 55
  const nvm = { ...flatRegion(0, closed), objects: [placement(0, 0x8001, 960, 0, 960)] }
  nvm.objects[0]!.regionId = REGION
  return buildNavData({ regions: [{ id: REGION, nvm: { ...nvm, objects: nvm.objects } }], objectNavMesh: () => ({ key: 'wall', navMesh: slab(-450, 450) }) })
}

function pieces(): NavData {
  const spans: [number, number][] = [[-450, -150], [-150, 150], [150, 450]]
  return {
    version: 1, regions: [],
    models: spans.map(([a, b], k) => ({ ...modelOf(slab(a, b)), key: `wall#${k}` })),
    instances: spans.map((_, k) => ({ id: pieceId(k), objId: 1, model: k, x: 1920 * RX + 960, y: 0, z: 1920 * RZ + 960, yaw: 0, links: [] })),
  }
}

function modelOf(m: NavMeshInput) {
  const e = (x: NavMeshInput['outlineEdges']) => ({ vertices: Uint16Array.from(x.vertices), cells: Uint16Array.from(x.cells), flags: Uint8Array.from(x.flags) })
  return { key: '', vertices: Float32Array.from(m.vertices), cells: Uint16Array.from(m.cells), outline: e(m.outlineEdges), inline: e(m.inlineEdges), events: [] as string[] }
}

function wallsExport(): WallsExport {
  const third = (k: number) => ({
    id: `N1${'abc'[k]}`, from: 51 + 30 * k, to: 81 + 30 * k, instances: [pieceId(k)], tiles: k === 1 ? rimTiles : [],
    assault: [66 + 30 * k, 0, -106] as Vec3, rally: [66 + 30 * k, 0, -78] as Vec3,
  })
  return {
    version: 1, world: 'test', plan: { file: 'content/siege/jangan.json', hash: 'test' }, navFile: 'siege/walls-nav.bin',
    sides: [{ side: 'N', axis: 'x', line: -96, outer: -104, inner: -88, out: -1, walkY: 20, placement: { region: REGION, uid: 0x8001, source: 'wall', position: [96, 0, -96] }, retailInstance: RETAIL_ID, fixed: [] }],
    segments: [{ id: 'N1', side: 'N', from: 51, to: 141, thirds: [third(0), third(1), third(2)] }],
  }
}

interface Harness {
  walls: WallService
  nav: MeshNav
  sent: ServerMessage[]
  player: Player
  strike(s: Partial<LightningStrike>): void
  tornado(e: TornadoEvent): void
  host: WallsHost
  dir: string
  close(): void
}

const dirs: string[] = []
const stores: { close(): void; open?: boolean }[] = []
afterEach(() => {
  for (const st of stores.splice(0)) {
    try {
      st.close()
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(now: number, dir = mkdtempSync(join(tmpdir(), 'sro-walls-'))): Harness {
  if (!dirs.includes(dir)) dirs.push(dir)
  const nav = new MeshNav(navData(), ORIGIN, 'synthetic')
  const store = openStore(dir)
  stores.push(store)
  const sent: ServerMessage[] = []
  const player = { kind: 'player', id: 7, name: 'P', dead: false, pos: [96, 0, -70] as Vec3, move: null, surface: null, send: (m: ServerMessage) => sent.push(m) } as unknown as Player
  const strikes = new Set<(e: StrikeEvent) => void>()
  const tornadoes = new Set<(e: TornadoEvent) => void>()
  const lightning = { onStrike: (fn: (e: StrikeEvent) => void) => (strikes.add(fn), () => strikes.delete(fn)), wallRodUp: null as ((x: number, z: number) => boolean) | null }
  const host: WallsHost = {
    config: { world: 'jangan', log: () => {} },
    world: {
      players: new Map([[player.id, player]]),
      mobs: new Map<number, Mob>(),
      positionAt: (p) => p.pos,
      warp: (p, x, y, z) => {
        p.pos = [x, y, z]
        return p.pos
      },
    },
    nav,
    data: { unsafeAt: null },
    store,
    lightning,
    tornado: { onTornado: (fn) => (tornadoes.add(fn), () => tornadoes.delete(fn)) },
  }
  const walls = new WallService(host, { walls: wallsExport(), pieces: pieces(), now })
  return {
    walls, nav, sent, player, host, dir,
    strike: (s) => {
      const strike: LightningStrike = { id: 1, at: now, kind: 'wall', pos: [96, 20, -96], radiusM: 3, seed: 1234, ...s }
      for (const fn of strikes) fn({ phase: 'land', strike, hits: [] })
    },
    tornado: (e) => { for (const fn of tornadoes) fn(e) },
    close: () => {
      if (store.db.open) store.close()
    },
  }
}

/** A straight walk on the server's nav from (x0, z0) to (x1, z1) (glTF). */
const walk = (nav: MeshNav, x0: number, z0: number, x1: number, z1: number) => nav.walk(nav.place(x0, z0, Infinity, 2)!, x1, z1)!
const safe = (h: Harness, x: number, z: number) => !(h.host.data.unsafeAt?.('jangan', x, z) ?? false)
const pct = (h: Harness, id: string) => h.walls.view(id)!.pct

describe('walls on a synthetic wall', () => {
  it('starts intact; the pieces replace the retail wall, which still blocks', () => {
    const h = harness(1000)
    expect(h.walls.on).toBe(true)
    expect(h.walls.stageOf('N1')).toBe('intact')
    expect(walk(h.nav, 96, -70, 96, -130).blocked).toBe(true)
    // the retail instance is off, the three pieces on
    expect(h.nav.world.isInstanceEnabled(0)).toBe(false)
    for (let k = 0; k < 3; k++) expect(h.nav.world.isInstanceEnabled(h.nav.instanceIndex(pieceId(k))!)).toBe(true)
    h.close()
  })

  it('GM break: the middle third and its rim tiles open, the ground behind is unsafe; rubble opens all three; repair closes and rescues', () => {
    const h = harness(1000)
    expect(h.walls.gm(['break', 'n1'], 2000).ok).toBe(true)
    expect(h.walls.stageOf('N1')).toBe('breached')
    // through the middle third, across the closed rim
    const through = walk(h.nav, 96, -70, 96, -130)
    expect(through.blocked).toBe(false)
    // the outer thirds still stand
    expect(walk(h.nav, 60, -70, 60, -130).blocked).toBe(true)
    expect(walk(h.nav, 130, -70, 130, -130).blocked).toBe(true)
    // the breach zone: 50 m around a point 10 m inside the gap
    expect(safe(h, 96, -78)).toBe(false)
    expect(safe(h, 96, -27)).toBe(true)
    expect(h.walls.breachZones()).toEqual([{ seg: 'N1', x: 96, z: -78, r: 50 }])
    // messages: the stage at once, and a breach puff
    expect(h.sent).toContainEqual({ t: 'wallUpdate', id: 'N1', stage: 'breached', pct: -10, at: 2000 })
    expect(h.sent.some((m) => m.t === 'wallFx' && m.kind === 'breach')).toBe(true)

    h.walls.gm(['N1', 'rubble'], 3000)
    expect(h.walls.stageOf('N1')).toBe('rubble')
    expect(walk(h.nav, 60, -70, 60, -125).blocked).toBe(false)
    // a rubble gap is the whole segment (90 m here): the circle grows by half the extra width
    expect(h.walls.breachZones()[0]!.r).toBe(80)

    // a body standing in the gap when it closes is put back on open ground
    h.player.pos = [96, 0, -96]
    expect(h.walls.gm(['repair', 'N1'], 4000).ok).toBe(true)
    expect(h.walls.stageOf('N1')).toBe('intact')
    expect(walk(h.nav, 96, -70, 96, -130).blocked).toBe(true)
    expect(h.nav.insideSolid(h.player.pos[0], h.player.pos[2], h.player.pos[1])).toBe(false)
    expect(Math.hypot(h.player.pos[0] - 96, h.player.pos[2] + 96)).toBeLessThanOrEqual(10)
    expect(safe(h, 96, -78)).toBe(true)
    expect(h.walls.breachZones()).toEqual([])
    h.close()
  })

  it('the +5 % hysteresis: a breached wall stays open until it climbs above 5 %', () => {
    const h = harness(1000)
    h.walls.gm(['N1', '-1'], 2000)
    expect(h.walls.stageOf('N1')).toBe('breached')
    h.walls.gm(['N1', '4'], 3000)
    expect(h.walls.stageOf('N1')).toBe('breached')
    expect(walk(h.nav, 96, -70, 96, -130).blocked).toBe(false)
    h.walls.gm(['N1', '6'], 4000)
    expect(h.walls.stageOf('N1')).toBe('cracked')
    expect(walk(h.nav, 96, -70, 96, -130).blocked).toBe(true)
    // going down it breaks at 0
    h.walls.gm(['N1', '1'], 5000)
    expect(h.walls.stageOf('N1')).toBe('cracked')
    h.walls.gm(['N1', '0'], 6000)
    expect(h.walls.stageOf('N1')).toBe('breached')
    h.close()
  })

  it('lightning chips 3-5 % a strike and stops at the 35 % floor: cracks, never a breach', () => {
    const h = harness(1000)
    h.strike({ seed: 0 })
    expect(pct(h, 'N1')).toBe(97)
    expect(h.sent.some((m) => m.t === 'wallFx' && m.kind === 'chip')).toBe(true)
    for (let i = 0; i < 60; i++) h.strike({ id: i + 2, seed: i * 7919 })
    expect(pct(h, 'N1')).toBe(35)
    expect(h.walls.stageOf('N1')).toBe('cracked')
    // a strike away from the wall, or one that is not a wall strike, does nothing
    h.walls.gm(['N1', '90'], 2000)
    h.strike({ pos: [96, 0, -40] })
    h.strike({ kind: 'ground' })
    expect(pct(h, 'N1')).toBe(90)
    h.close()
  })

  it('a downed third has no wall-walk rod (the strike lands as ground)', () => {
    const h = harness(1000)
    const rodUp = h.host.lightning!.wallRodUp!
    expect(rodUp(96, -96)).toBe(true)
    h.walls.gm(['break', 'N1'], 2000)
    expect(rodUp(96, -96)).toBe(false)
    expect(rodUp(60, -96)).toBe(true)
    h.walls.gm(['N1', 'rubble'], 3000)
    expect(rodUp(60, -96)).toBe(false)
    h.close()
  })

  it('a tornado within 120 m wears 1 % per 10 s down to the floor; farther away it does not', () => {
    const t0 = 100_000
    const h = harness(t0)
    const tornado = (id: number, x: number, z: number): TornadoState => ({
      id, seed: 1, warnAt: t0, touchAt: t0, endAt: t0 + 60 * 60_000, path: [[x, 0, z], [x + 1, 0, z]], speedMs: 0.001, pullM: 30, coreM: 8, strength: 1,
    })
    h.tornado({ phase: 'warn', tornado: tornado(1, 96, -300) })
    for (let k = 1; k <= 3; k++) h.walls.tick(t0 + k * TORNADO_STEP_MS)
    expect(pct(h, 'N1')).toBe(100)
    h.tornado({ phase: 'end', tornado: tornado(1, 96, -300) })
    h.tornado({ phase: 'warn', tornado: tornado(2, 96, -200) })
    for (let k = 4; k <= 6; k++) h.walls.tick(t0 + k * TORNADO_STEP_MS)
    expect(pct(h, 'N1')).toBe(97)
    for (let k = 7; k <= 100; k++) h.walls.tick(t0 + k * TORNADO_STEP_MS)
    expect(pct(h, 'N1')).toBe(35)
    expect(h.walls.stageOf('N1')).toBe('cracked')
    h.close()
  })

  it('repairs itself by 1 % per 10 min', () => {
    const t0 = 100_000
    const h = harness(t0)
    h.walls.gm(['N1', '50'], t0)
    h.walls.tick(t0 + NATURAL_STEP_MS - 1)
    expect(pct(h, 'N1')).toBe(50)
    h.walls.tick(t0 + NATURAL_STEP_MS)
    expect(pct(h, 'N1')).toBe(51)
    h.walls.tick(t0 + 2 * NATURAL_STEP_MS)
    expect(pct(h, 'N1')).toBe(52)
    h.close()
  })

  it('a restart keeps the stage, the integrity and the gap', () => {
    const h = harness(1000)
    h.walls.gm(['N1', '-20'], 2000)
    h.walls.flush(3000)
    h.close()
    const again = harness(5000, h.dir)
    expect(again.walls.stageOf('N1')).toBe('breached')
    expect(pct(again, 'N1')).toBe(-20)
    expect(walk(again.nav, 96, -70, 96, -130).blocked).toBe(false)
    // on enter: all segments
    again.walls.enter(again.player)
    expect(again.sent.at(-1)).toMatchObject({ t: 'walls', segs: [{ id: 'N1', stage: 'breached', pct: -20 }] })
    again.close()
  })

  it('throttles integrity updates to one a second per segment', () => {
    const h = harness(1000)
    h.walls.gm(['damage', 'N1', '5'], 2000)
    h.walls.tick(2000)
    const first = h.sent.filter((m) => m.t === 'wallUpdate').length
    h.walls.gm(['damage', 'N1', '5'], 2100)
    h.walls.tick(2100)
    expect(h.sent.filter((m) => m.t === 'wallUpdate').length).toBe(first)
    h.walls.tick(3100)
    expect(h.sent.filter((m) => m.t === 'wallUpdate').at(-1)).toEqual({ t: 'wallUpdate', id: 'N1', stage: 'intact', pct: 90, at: 3100 })
    h.close()
  })

  it('GM: status, one segment with its log, bad input refused, reset', () => {
    const h = harness(1000)
    expect(h.walls.gm([], 1000).message).toMatch(/^Walls \(1 segments/)
    h.walls.gm(['damage', 'N1', '40'], 2000)
    const one = h.walls.gm(['N1'], 3000)
    expect(one.ok).toBe(true)
    expect(one.message).toMatch(/North wall \(N1\): cracked 60%/)
    expect(one.message).toMatch(/gm -40%/)
    expect(h.walls.gm(['X9'], 1).ok).toBe(false)
    expect(h.walls.gm(['N1', '120'], 1).ok).toBe(false)
    expect(h.walls.gm(['damage', 'N1', 'lots'], 1).ok).toBe(false)
    expect(h.walls.gm(['reset'], 4000).ok).toBe(true)
    expect(pct(h, 'N1')).toBe(100)
    expect(h.sent.at(-1)).toMatchObject({ t: 'walls', segs: [{ id: 'N1', stage: 'intact', pct: 100 }] })
    h.close()
  })

  it('is inert without walls.json or a mesh nav', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-walls-'))
    dirs.push(dir)
    const store = openStore(dir)
    stores.push(store)
    const h = harness(1000)
    const off = new WallService({ ...h.host, store }, { walls: null })
    expect(off.on).toBe(false)
    expect(off.gm([], 1).ok).toBe(false)
    const flat = new WallService({ ...h.host, store, nav: { kind: 'flat' } as unknown as WallsHost['nav'] }, { walls: wallsExport(), pieces: pieces() })
    expect(flat.on).toBe(false)
    expect(flat.problem).toBe('no mesh nav')
  })
})

// ---- the real jangan-fields export ------------------------------------------------------------------------------------

const OUT = join(REPO_ROOT, 'work/out')
const FIELDS = join(OUT, 'world/jangan-fields')
const HAVE = ['siege/walls.json', 'nav.bin', 'manifest.json'].every((f) => existsSync(join(FIELDS, f))) && existsSync(join(OUT, 'data/towns.json'))

describe.skipIf(!HAVE)('walls on the real jangan-fields export', () => {
  let s: TestServer
  const logs: string[] = []
  const dataDir = HAVE ? mkdtempSync(join(tmpdir(), 'sro-walls-real-')) : ''
  const config = { outDir: OUT, dataDir, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(31), worldExport: 'jangan-fields', spawnMobs: false }
  const walls = HAVE ? (JSON.parse(readFileSync(join(FIELDS, 'siege/walls.json'), 'utf8')) as WallsExport) : null

  /** The client's nav (nav.bin as the game streams it, the pieces, the same WallNavState), fed the server's messages. */
  const clientNav = () => {
    const manifest = JSON.parse(readFileSync(join(FIELDS, 'manifest.json'), 'utf8')) as { space: { originRegion: { x: number; z: number } } }
    const nav = new NavGltf(new NavWorld(decodeNavData(new Uint8Array(readFileSync(join(FIELDS, 'nav.bin'))))), manifest.space.originRegion)
    nav.world.editInstances({ put: navPiecePuts(decodeNavData(new Uint8Array(readFileSync(join(FIELDS, walls!.navFile))))) })
    const indexOf = new Map<number, number>()
    nav.world.data.instances.forEach((inst, i) => indexOf.set(inst.id >>> 0, i))
    for (const side of walls!.sides) nav.world.setInstanceEnabled(indexOf.get(side.retailInstance)!, false)
    const state = new WallNavState(walls!, indexOf)
    const stages = new Map<string, WallStage>()
    return {
      nav,
      feed(m: ServerMessage) {
        if (m.t === 'walls') for (const g of m.segs) stages.set(g.id, g.stage)
        else if (m.t === 'wallUpdate') stages.set(m.id, m.stage)
        else return
        state.apply(nav.world, stages)
      },
    }
  }

  beforeAll(async () => {
    s = await startTestServer({ logs, config })
  }, 120_000)
  afterAll(async () => {
    await s?.stopAndClean()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('GM breaks W3: a player walks in through the gap, the client predicts the same walk, the ground behind is unsafe; restart keeps it', async () => {
    expect(s.ctx.gameplay.walls.on).toBe(true)
    expect(logs.some((l) => /^walls: 33 segments, \d+ nav pieces/.test(l))).toBe(true)
    const acc = await newAccount(s.url, 'wallgm')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: 'WallGm', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    const first = await c.next('walls')
    expect(first.segs).toHaveLength(33)
    const client = clientNav()
    client.feed(first)

    const seg = walls!.segments.find((g) => g.id === 'W3')!
    const side = walls!.sides.find((x) => x.side === 'W')!
    const b = seg.thirds[1]
    // the field outside the middle third, and a point inside town behind it (W3's middle has the west camp right
    // behind it: the line that clears it once the third is down, as the converter's probe found)
    const lines = [0, -3, 3, -6, 6].map((off) => (b.from + b.to) / 2 + off)
    const outAt = (along: number): [number, number] => [side.outer + side.out * 25, along]
    const inAt = (along: number): [number, number] => [side.inner - side.out * 4, along]
    for (const along of lines) {
      const o = outAt(along)
      expect(s.ctx.nav.walk(s.ctx.nav.place(o[0], o[1], Infinity, 3)!, inAt(along)[0], inAt(along)[1])!.blocked).toBe(true)
    }
    expect(s.ctx.data.inSafeArea('jangan', inAt(lines[0]!)[0], inAt(lines[0]!)[1])).toBe(true)

    c.send({ t: 'gm', cmd: 'wall', args: ['break', 'W3'] })
    const r = await c.next('gmResult')
    expect(r.ok).toBe(true)
    const upd = await c.next('wallUpdate', (m) => m.id === 'W3')
    expect(upd.stage).toBe('breached')
    client.feed(upd)
    expect(s.ctx.data.inSafeArea('jangan', inAt(lines[0]!)[0], inAt(lines[0]!)[1])).toBe(false)

    // the server's walk and the client's prediction agree, and get through
    const along = lines.find((a) => {
      const o = outAt(a)
      return !s.ctx.nav.walk(s.ctx.nav.place(o[0], o[1], Infinity, 3)!, inAt(a)[0], inAt(a)[1])!.blocked
    })
    expect(along).toBeDefined()
    const out = outAt(along!)
    const inside = inAt(along!)
    const start = s.ctx.nav.place(out[0], out[1], Infinity, 3)!
    const srv = s.ctx.nav.walk(start, inside[0], inside[1])!
    const pred = client.nav.moveStraight({ x: start.x, y: start.y, z: start.z, surface: start.surface! }, inside[0], inside[1])
    expect(srv.blocked).toBe(false)
    expect(pred.blocked).toBe(false)
    expect(Math.hypot(pred.end.x - srv.end.x, pred.end.z - srv.end.z)).toBeLessThan(0.05)

    // a real player through it: teleport outside, walk in
    c.send({ t: 'gm', cmd: 'tp', args: [String(start.x), String(start.z)] })
    await c.next('gmResult')
    await sleep(100)
    c.send({ t: 'moveTo', x: inside[0], z: inside[1] })
    await sleep(2500)
    const self = [...s.ctx.world.players.values()].find((p) => p.name === 'WallGm')!
    const pos = s.ctx.world.positionAt(self, Date.now())
    expect(Math.hypot(pos[0] - inside[0], pos[2] - inside[1])).toBeLessThan(1)
    c.close()

    // restart: the breach (and the gap) is still there
    await s.stopAndClean()
    s = await startTestServer({ logs, config })
    expect(s.ctx.gameplay.walls.stageOf('W3')).toBe('breached')
    expect(s.ctx.nav.walk(s.ctx.nav.place(out[0], out[1], Infinity, 3)!, inside[0], inside[1])!.blocked).toBe(false)
    s.ctx.gameplay.walls.repair('W3', 'gm', Date.now())
    expect(s.ctx.nav.walk(s.ctx.nav.place(out[0], out[1], Infinity, 3)!, inside[0], inside[1])!.blocked).toBe(true)
    expect(s.ctx.data.inSafeArea('jangan', inside[0], inside[1])).toBe(true)
  }, 120_000)
})
