/**
 * Siege of Jangan, layer 3 on the server (docs/SIEGE.md §2.4, §2.5, §7, §12, §14): a real Gameplay over a synthetic
 * world (one region, one wall segment N1 of three nav pieces, written as the export's siege/walls.json) with Master Mason
 * Ko placed by the test:
 * - Ko: his dialog offers the shop and the `mason` service; his shop sells the Mason's Kit and the Stone Block;
 * - donations: gold and Stone Blocks queue work at 2,000 gold / 2 blocks per 1 %, only what the queue can take is
 *   charged, the builders apply it at 1 %/min (`repairing` while they work), and enough of it closes a breach;
 * - abuse: no gold, more gold or blocks than carried, too far from Ko, an unknown segment, a full queue (nothing charged),
 *   a negative amount past the validator, a kit bought with a full bag;
 * - the Mason's Kit: a 10 s channel at the wall adds 1 % and takes one kit, goes on while kits last, is refused far
 *   from the wall or at a whole wall, and is interrupted by moving and by damage;
 * - looters: 3 Bandits at an open gap, back 5 minutes after a death, gone when the wall closes, none during a siege;
 * - persistence: the queued work survives a restart; GM `mason`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNavData, encodeNavData, type NavData, type NavMeshInput } from '@sro/nav'
import { SIEGE_CODES, masonNpc, type ItemDef, type ServerMessage, type Vec3, type WallsExport } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay, type GameplayMessage } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import type { InvDraft } from '../src/inventory.ts'
import { MeshNav } from '../src/nav.ts'
import { BUILDER_STEP_MS } from '../src/siege/repair.ts'
import { LOOTER_PASS_MS } from '../src/siege/looters.ts'
import { World, type Player } from '../src/world.ts'
import { flatRegion, grid, mesh, placement } from '../../../packages/nav/test/synthetic.ts'
import { ITEMS, LEVELS, mob, seeded } from './fixtures.ts'
import { testConfig } from './helpers.ts'

// ---- the synthetic wall (as siege-walls.test.ts) ---------------------------------------------------------------------

const NVM_TILES = 96
const RX = 100, RZ = 100, REGION = (RZ << 8) | RX
const ORIGIN = { x: RX, z: RZ }
const RETAIL_ID = ((REGION << 16) | 0x8001) >>> 0
const pieceId = (k: number) => ((REGION << 16) | (0xf000 | k)) >>> 0
const slab = (x0: number, x1: number): NavMeshInput => {
  const g = grid(x0, x1, -80, 80, 3, 1, () => 200)
  return mesh(g.vertices, g.triangles, () => 3).nav
}
const rimTiles: [number, number][] = []
for (let tx = 41; tx < 55; tx++) rimTiles.push([REGION, 55 * NVM_TILES + tx])

function navData(): NavData {
  const closed = (tx: number, tz: number) => tz === 55 && tx >= 41 && tx < 55
  const nvm = { ...flatRegion(0, closed), objects: [placement(0, 0x8001, 960, 0, 960)] }
  nvm.objects[0]!.regionId = REGION
  return buildNavData({ regions: [{ id: REGION, nvm: { ...nvm, objects: nvm.objects } }], objectNavMesh: () => ({ key: 'wall', navMesh: slab(-450, 450) }) })
}

function modelOf(m: NavMeshInput) {
  const e = (x: NavMeshInput['outlineEdges']) => ({ vertices: Uint16Array.from(x.vertices), cells: Uint16Array.from(x.cells), flags: Uint8Array.from(x.flags) })
  return { key: '', vertices: Float32Array.from(m.vertices), cells: Uint16Array.from(m.cells), outline: e(m.outlineEdges), inline: e(m.inlineEdges), events: [] as string[] }
}

function pieces(): NavData {
  const spans: [number, number][] = [[-450, -150], [-150, 150], [150, 450]]
  return {
    version: 1, regions: [],
    models: spans.map(([a, b], k) => ({ ...modelOf(slab(a, b)), key: `wall#${k}` })),
    instances: spans.map((_, k) => ({ id: pieceId(k), objId: 1, model: k, x: 1920 * RX + 960, y: 0, z: 1920 * RZ + 960, yaw: 0, links: [] })),
  }
}

function wallsExport(): WallsExport {
  const third = (k: number) => ({
    id: `N1${'abc'[k]}`, from: 51 + 30 * k, to: 81 + 30 * k, instances: [pieceId(k)], tiles: k === 1 ? rimTiles : [],
    assault: [66 + 30 * k, 0, -106] as Vec3, rally: [66 + 30 * k, 0, -78] as Vec3,
  })
  return {
    version: 1, world: 'jangan', plan: { file: 'content/siege/jangan.json', hash: 'test' }, navFile: 'siege/walls-nav.bin',
    sides: [{ side: 'N', axis: 'x', line: -96, outer: -104, inner: -88, out: -1, walkY: 20, placement: { region: REGION, uid: 0x8001, source: 'wall', position: [96, 0, -96] }, retailInstance: RETAIL_ID, fixed: [] }],
    segments: [{ id: 'N1', side: 'N', from: 51, to: 141, thirds: [third(0), third(1), third(2)] }],
  }
}

// ---- the harness -------------------------------------------------------------------------------------------------------

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>
const T0 = 1_000_000
/** Ko stands well inside the town (south of the wall), away from the gap. */
const KO: Vec3 = [20, 0, -40]
const NEAR_KO: Vec3 = [22, 0, -40]
/** 6 m inside the wall's inner face (z -88), at the middle third. */
const AT_WALL: Vec3 = [96, 0, -82]
const BANDIT = mob('MOB_CH_BANDIT', { name: 'Bandit', level: 16, hp: 400, aggressive: true })
const GHOST = mob('MOB_CH_STONEGHOST', { name: 'Stone Ghost', level: 9 })

const roots: string[] = []
const open: { close(): void }[] = []
afterEach(() => {
  for (const h of open.splice(0)) h.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function harness(opts: { root?: string; config?: Partial<ServerConfig>; at?: number } = {}) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'sro-repair-'))
  if (!roots.includes(root)) roots.push(root)
  const logs: string[] = []
  const config: ServerConfig = { ...testConfig(root, logs), rng: seeded(11), ...opts.config }
  const siege = join(config.outDir, 'world', 'jangan', 'siege')
  mkdirSync(siege, { recursive: true })
  writeFileSync(join(siege, 'walls.json'), JSON.stringify(wallsExport()))
  writeFileSync(join(siege, 'walls-nav.bin'), encodeNavData(pieces()))
  const store = openStore(config.dataDir)
  const nav = new MeshNav(navData(), ORIGIN, 'synthetic')
  const bounds = { minX: 0, minZ: -192, maxX: 192, maxZ: 0 }
  const world = new World('jangan', 5, 20, bounds, nav)
  const ko = { ...masonNpc('jangan'), x: KO[0], z: KO[2], y: 0 }
  const ghostDrops = { mob: GHOST.code, groups: [], provenance: 'client' as const }
  const data = new GameData({ mobs: [BANDIT, GHOST], items: ITEMS, levels: LEVELS, drops: [ghostDrops], npcs: [ko], shops: [], towns: [] })
  const setup: WorldSetup = { spawn: { x: 30, y: 0, z: -40 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(11) })
  let clock = opts.at ?? T0
  gameplay.start(clock)
  let n = 0
  let closed = false

  const enter = (pos: Vec3, gold = 0) => {
    const acc = store.createAccount(`mason${Date.now() % 100000}${++n}${Math.floor(Math.random() * 1e6)}`, 'x')!
    const row = store.createCharacter(acc, `Mason${n}${Math.floor(Math.random() * 1e4)}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    gameplay.grantStarterKit(row.id, 'blade', row.model)
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 10, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    world.snapshotFor(p, clock)
    if (gold) setGold(p, gold)
    return { p, inbox }
  }
  const edit = (p: Player, fn: (d: InvDraft) => void) => {
    const { draft } = store.inventoryTx(p.characterId, (d) => {
      fn(d)
      return { ok: true, value: undefined }
    })
    p.gold = draft.gold
  }
  const setGold = (p: Player, gold: number) => edit(p, (d) => d.setGold(gold))
  const give = (p: Player, code: string, count = 1) => edit(p, (d) => d.setBag(d.firstFree(), { code, count, plus: 0, durability: null }))
  const bag = (p: Player) => store.loadInventory(p.characterId).bag
  const countOf = (p: Player, code: string) => bag(p).reduce((s, i) => s + (i?.code === code ? i.count : 0), 0)
  const gold = (p: Player) => store.loadInventory(p.characterId).gold
  const req = (p: Player, inbox: ServerMessage[], msg: GameplayMessage) => {
    const before = inbox.length
    gameplay.request(p, msg, clock)
    const r = inbox.slice(before).find((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === msg.t)
    if (!r) throw new Error(`no actionResult for ${msg.t}`)
    return r
  }
  const of = <T extends ServerMessage['t']>(inbox: ServerMessage[], t: T) => inbox.filter((m): m is Msg<T> => m.t === t)
  const advance = (ms: number, step = 50) => {
    const end = clock + ms
    while (clock < end) {
      clock = Math.min(end, clock + step)
      world.tick(clock)
    }
  }
  const koNpc = () => [...world.npcs.values()].find((x) => x.code === SIEGE_CODES.mason)!
  const walls = gameplay.walls
  const pctOf = (id = 'N1') => walls.view(id)!.pct
  const queuedPct = (id = 'N1') => (walls.queuedOf(id) / walls.settings.maxIp) * 100
  const looters = () => [...world.mobs.values()].filter((m) => m.def.code === BANDIT.code)
  const close = () => {
    if (closed) return
    closed = true
    walls.flush(clock)
    store.close()
  }
  open.push({ close })
  return { root, config, logs, store, world, gameplay, data, walls, enter, edit, setGold, give, bag, countOf, gold, req, of, advance, koNpc, pctOf, queuedPct, looters, now: () => clock, close }
}

const donate = (npc: number, extra: { seg?: string; gold?: number; blocks?: number }): GameplayMessage => ({ t: 'wallDonate', npc, ...extra }) as GameplayMessage

// ---- the tests ---------------------------------------------------------------------------------------------------------

describe('Master Mason Ko', () => {
  it('stands in the world with his shop and the mason service; sells the kit and the block', () => {
    const h = harness()
    expect(h.walls.on).toBe(true)
    const ko = h.koNpc()
    expect(ko).toBeDefined()
    expect(ko.name).toBe('Master Mason Ko')
    expect(ko.model).toBe(SIEGE_CODES.masonBase)
    const { p, inbox } = h.enter(NEAR_KO, 10_000)
    expect(h.req(p, inbox, { t: 'npcTalk', npc: ko.id }).ok).toBe(true)
    const dialog = h.of(inbox, 'npcDialog').at(-1)!
    expect(dialog.services).toEqual(['shop', 'mason'])
    expect(h.req(p, inbox, { t: 'shopBuy', npc: ko.id, item: SIEGE_CODES.kit, count: 2 }).ok).toBe(true)
    expect(h.req(p, inbox, { t: 'shopBuy', npc: ko.id, item: SIEGE_CODES.block, count: 1 }).ok).toBe(true)
    expect(h.countOf(p, SIEGE_CODES.kit)).toBe(2)
    expect(h.countOf(p, SIEGE_CODES.block)).toBe(1)
    expect(h.gold(p)).toBe(10_000 - 3000 - 1200)
    // the Stone Ghost drops Stone Blocks
    expect(h.data.drops.get('MOB_CH_STONEGHOST')!.groups).toContainEqual({ chance: 0.08, entries: [{ item: SIEGE_CODES.block, weight: 1 }] })
    // enter-world: the repair numbers come with `walls`
    h.walls.enter(p)
    expect(h.of(inbox, 'walls').at(-1)!.repair).toMatchObject({ goldPerPct: 2000, blocksPerPct: 2, kitPrice: 1500 })
  })

  it('the admin panel changes the numbers live: the kit price follows and everyone hears it', () => {
    const h = harness()
    const { p, inbox } = h.enter(NEAR_KO, 10_000)
    h.config.wallKitPrice = 2500
    h.config.wallGoldPerPct = 4000
    h.gameplay.wallRepair.refresh()
    expect(h.of(inbox, 'walls').at(-1)!.repair).toMatchObject({ goldPerPct: 4000, kitPrice: 2500 })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: h.koNpc().id, item: SIEGE_CODES.kit, count: 1 }).ok).toBe(true)
    expect(h.gold(p)).toBe(7500)
  })
})

describe('donations and the builders', () => {
  it('gold queues work, the builders apply 1 %/min and show `repairing` while they work', () => {
    const h = harness()
    h.walls.setIp('N1', 10_000, 'gm', h.now()) // 50 %
    const { p, inbox } = h.enter(NEAR_KO, 10_000)
    const r = h.req(p, inbox, donate(h.koNpc().id, { seg: 'N1', gold: 4000 }))
    expect(r.ok).toBe(true)
    expect(h.gold(p)).toBe(6000)
    expect(h.queuedPct()).toBe(2)
    expect(h.of(inbox, 'chat').at(-1)!.text).toMatch(/Master Mason Ko takes your 4,000 gold: 2 % of repair work for the North wall \(N1\)/)
    // the row is saved at once
    expect(h.store.db.prepare('SELECT queued FROM wall_segments WHERE id = ?').get('N1')).toEqual({ queued: 400 })
    // one step: +0.25 %, the queue down by as much, and the segment shows repairing
    h.advance(BUILDER_STEP_MS + 100)
    expect(h.pctOf()).toBeCloseTo(50.25, 0) // 10,050 ip, shown with one decimal
    expect(h.walls.ipOf('N1')).toBe(10_050)
    expect(h.walls.queuedOf('N1')).toBe(350)
    expect(h.walls.view('N1')).toMatchObject({ repairing: true, queued: 1.8 })
    h.advance(1100)
    expect(h.of(inbox, 'wallUpdate').some((m) => m.repairing === true)).toBe(true)
    // 2 % at 1 %/min: done in 2 minutes; one more step finds nothing and takes the scaffolding down
    h.advance(2 * 60_000)
    expect(h.walls.ipOf('N1')).toBe(10_400)
    expect(h.walls.queuedOf('N1')).toBe(0)
    h.advance(BUILDER_STEP_MS + 1100)
    expect(h.walls.view('N1')!.repairing).toBeUndefined()
    expect(h.of(inbox, 'wallUpdate').at(-1)!.repairing).toBeUndefined()
    // the log has the donation and the builders
    const causes = (h.store.db.prepare("SELECT cause FROM wall_log WHERE seg = 'N1'").all() as { cause: string }[]).map((x) => x.cause)
    expect(causes).toContain('donation')
    expect(causes).toContain('builders')
  })

  it('Stone Blocks: 2 per 1 %, taken from the bag; work beyond a full repair waits, capped at 50 %', () => {
    const h = harness()
    h.walls.setIp('N1', 19_900, 'gm', h.now()) // 99.5 %
    const { p, inbox } = h.enter(NEAR_KO)
    h.give(p, SIEGE_CODES.block, 30)
    h.give(p, SIEGE_CODES.block, 30)
    expect(h.req(p, inbox, donate(h.koNpc().id, { seg: 'N1', blocks: 40 })).ok).toBe(true)
    expect(h.countOf(p, SIEGE_CODES.block)).toBe(20)
    expect(h.queuedPct()).toBe(20)
    // the builders top it up to 100 % and keep the rest for the next damage
    h.advance(BUILDER_STEP_MS * 3)
    expect(h.walls.ipOf('N1')).toBe(20_000)
    expect(h.queuedPct()).toBe(19.5)
    // the queue stops at 50 %: of 100 more blocks (50 %) only 61 are taken (30.5 %, the last block rounding up)
    h.give(p, SIEGE_CODES.block, 50)
    h.give(p, SIEGE_CODES.block, 50)
    expect(h.req(p, inbox, donate(h.koNpc().id, { blocks: 100 })).ok).toBe(true)
    expect(h.countOf(p, SIEGE_CODES.block)).toBe(120 - 61)
    expect(h.queuedPct()).toBe(50)
    expect(h.of(inbox, 'chat').at(-1)!.text).toMatch(/only what the builders can use now was taken/)
    // full: refused, nothing taken
    const full = h.req(p, inbox, donate(h.koNpc().id, { seg: 'N1', blocks: 2 }))
    expect(full).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.countOf(p, SIEGE_CODES.block)).toBe(59)
  })

  it('enough donations close a breach; the gap shuts and the looters leave', () => {
    const h = harness()
    expect(h.walls.gm(['break', 'N1'], h.now()).ok).toBe(true) // -10 %
    h.advance(LOOTER_PASS_MS + 100)
    expect(h.looters()).toHaveLength(3)
    const { p, inbox } = h.enter(NEAR_KO, 60_000)
    // where it is needed: the only damaged segment takes it all (20 % = 40,000 gold)
    expect(h.req(p, inbox, donate(h.koNpc().id, { gold: 40_000 })).ok).toBe(true)
    expect(h.gold(p)).toBe(20_000)
    expect(h.queuedPct()).toBe(20)
    // -10 % -> +5 % closes it: 15 % at 1 %/min
    h.advance(15 * 60_000 + BUILDER_STEP_MS)
    expect(h.walls.stageOf('N1')).toBe('cracked')
    h.advance(LOOTER_PASS_MS + 100)
    expect(h.looters()).toHaveLength(0)
  })
})

describe('abuse', () => {
  it('no gold, more than carried, no blocks, too far, unknown segment, negative amounts: refused, nothing taken', () => {
    const h = harness()
    h.walls.setIp('N1', 0, 'gm', h.now())
    const ko = h.koNpc().id
    const { p, inbox } = h.enter(NEAR_KO, 0)
    expect(h.req(p, inbox, donate(ko, { gold: 2000 }))).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    h.setGold(p, 1000)
    expect(h.req(p, inbox, donate(ko, { gold: 2000 }))).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(h.req(p, inbox, donate(ko, { blocks: 2 }))).toMatchObject({ ok: false, reason: 'invalid_count', message: 'You have no Stone Blocks.' })
    expect(h.req(p, inbox, donate(ko, { gold: 5 }))).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.req(p, inbox, donate(ko, { gold: -500 }))).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(h.req(p, inbox, donate(ko, { seg: 'W9', gold: 100 }))).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(p, inbox, donate(12345, { gold: 100 }))).toMatchObject({ ok: false, reason: 'not_found' })
    const far = h.enter([60, 0, -40], 5000)
    expect(h.req(far.p, far.inbox, donate(ko, { gold: 2000 }))).toMatchObject({ ok: false, reason: 'too_far' })
    expect(h.gold(p)).toBe(1000)
    expect(h.gold(far.p)).toBe(5000)
    expect(h.walls.queuedOf('N1')).toBe(0)
  })

  it('a full bag cannot buy a kit (gold kept); a donation of blocks needs no room', () => {
    const h = harness()
    h.walls.setIp('N1', 0, 'gm', h.now())
    const ko = h.koNpc().id
    const { p, inbox } = h.enter(NEAR_KO, 10_000)
    h.give(p, SIEGE_CODES.block, 4)
    h.edit(p, (d) => {
      for (let i = 0; i < d.bagSize; i++) if (!d.bag[i]) d.setBag(i, { code: 'ITEM_CH_SWORD_01_A_DEF', count: 1, plus: 0, durability: null })
    })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: ko, item: SIEGE_CODES.kit, count: 1 })).toMatchObject({ ok: false, reason: 'inventory_full' })
    expect(h.gold(p)).toBe(10_000)
    expect(h.req(p, inbox, donate(ko, { blocks: 4 })).ok).toBe(true)
    expect(h.countOf(p, SIEGE_CODES.block)).toBe(0)
    expect(h.queuedPct()).toBe(2)
  })
})

describe("the Mason's Kit", () => {
  const kitBag = (h: ReturnType<typeof harness>, p: Player) => h.bag(p).findIndex((i) => i?.code === SIEGE_CODES.kit)

  it('a 10 s channel at the wall adds 1 % per kit and goes on while kits last', () => {
    const h = harness()
    h.walls.setIp('N1', 10_000, 'gm', h.now())
    const { p, inbox } = h.enter(AT_WALL)
    h.give(p, SIEGE_CODES.kit, 2)
    expect(h.req(p, inbox, { t: 'itemUse', bag: kitBag(h, p) }).ok).toBe(true)
    expect(h.of(inbox, 'itemCast').at(-1)).toMatchObject({ id: p.id, item: SIEGE_CODES.kit, castMs: 10_000 })
    expect(h.gameplay.wallRepair.channelOf(p)?.seg).toBe('N1')
    expect(h.walls.view('N1')!.repairing).toBe(true)
    h.advance(10_100)
    expect(h.walls.ipOf('N1')).toBe(10_200)
    expect(h.countOf(p, SIEGE_CODES.kit)).toBe(1)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'done' })
    // the next kit goes at once
    expect(h.gameplay.wallRepair.channelOf(p)).not.toBeNull()
    h.advance(10_100)
    expect(h.walls.ipOf('N1')).toBe(10_400)
    expect(h.countOf(p, SIEGE_CODES.kit)).toBe(0)
    expect(h.gameplay.wallRepair.channelOf(p)).toBeNull()
    expect(h.walls.view('N1')!.repairing).toBeUndefined()
    const kit = (h.store.db.prepare("SELECT COUNT(*) AS n FROM wall_log WHERE seg = 'N1' AND cause = 'kit' AND character_id = ?").get(p.characterId) as { n: number }).n
    expect(kit).toBe(2)
  })

  it('refused far from the wall, at a whole wall, without a kit; interrupted by moving and by damage', () => {
    const h = harness()
    const far = h.enter(NEAR_KO)
    h.give(far.p, SIEGE_CODES.kit, 3)
    h.walls.setIp('N1', 10_000, 'gm', h.now())
    expect(h.req(far.p, far.inbox, { t: 'itemUse', bag: kitBag(h, far.p) })).toMatchObject({ ok: false, reason: 'too_far' })
    expect(h.req(far.p, far.inbox, { t: 'wallRepair', seg: 'N1' })).toMatchObject({ ok: false, reason: 'too_far' })
    const { p, inbox } = h.enter(AT_WALL)
    expect(h.req(p, inbox, { t: 'wallRepair', seg: 'N1' })).toMatchObject({ ok: false, reason: 'not_found' })
    h.give(p, SIEGE_CODES.kit, 3)
    h.walls.setIp('N1', 20_000, 'gm', h.now())
    expect(h.req(p, inbox, { t: 'wallRepair', seg: 'N1' })).toMatchObject({ ok: false, reason: 'nothing_to_repair' })
    h.walls.setIp('N1', 10_000, 'gm', h.now())
    // moving
    expect(h.req(p, inbox, { t: 'wallRepair', seg: 'N1' }).ok).toBe(true)
    expect(h.req(p, inbox, { t: 'wallRepair', seg: 'N1' })).toMatchObject({ ok: false, reason: 'busy' })
    h.advance(2000)
    h.world.moveEntity(p, 100, -80, 5, h.now())
    h.advance(100)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    expect(h.gameplay.wallRepair.channelOf(p)).toBeNull()
    h.advance(3000)
    // damage
    expect(h.req(p, inbox, { t: 'wallRepair', seg: 'N1' }).ok).toBe(true)
    h.advance(2000)
    p.hp -= 10
    h.advance(100)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    expect(h.walls.ipOf('N1')).toBe(10_000)
    expect(h.countOf(p, SIEGE_CODES.kit)).toBe(3)
  })
})

describe('looters at the gaps', () => {
  it('3 Bandits at an open gap, back 5 minutes after a death, gone when it closes, none during a siege', () => {
    const h = harness()
    h.walls.gm(['break', 'N1'], h.now())
    h.advance(LOOTER_PASS_MS + 100)
    const first = h.looters()
    expect(first).toHaveLength(3)
    // inside the breach zone (50 m around 96, -78)
    for (const m of first) expect(Math.hypot(m.pos[0] - 96, m.pos[2] + 78)).toBeLessThan(10)
    // one dies (taken out of the world, as a GM kill): back after 5 minutes, not before
    h.world.removeEntity(first[0]!.id)
    h.advance(4 * 60_000)
    expect(h.looters()).toHaveLength(2)
    h.advance(60_000 + LOOTER_PASS_MS + 100)
    expect(h.looters()).toHaveLength(3)
    // a real kill goes through mobDied
    const m = h.looters()[0]!
    h.gameplay.wallLooters.mobDied(m, h.now())
    h.world.removeEntity(m.id)
    h.advance(LOOTER_PASS_MS + 100)
    expect(h.looters()).toHaveLength(2)
    // repaired: they leave at once (no corpses)
    h.walls.repair('N1', 'gm', h.now())
    h.advance(LOOTER_PASS_MS + 100)
    expect(h.looters()).toHaveLength(0)
    expect(h.gameplay.wallLooters.count).toBe(0)
    // a siege: the gap stays empty
    h.walls.sieging = () => true
    h.walls.gm(['break', 'N1'], h.now())
    h.advance(LOOTER_PASS_MS * 2)
    expect(h.looters()).toHaveLength(0)
    h.walls.sieging = () => false
    h.advance(LOOTER_PASS_MS + 100)
    expect(h.looters()).toHaveLength(3)
    // the admin's count
    h.config.wallLooters = 1
    h.advance(LOOTER_PASS_MS + 100)
    expect(h.looters()).toHaveLength(1)
  })
})

describe('persistence and GM', () => {
  it('queued work survives a restart; the breach and its looters come back', () => {
    const h = harness()
    h.walls.gm(['break', 'N1'], h.now())
    const { p, inbox } = h.enter(NEAR_KO, 20_000)
    expect(h.req(p, inbox, donate(h.koNpc().id, { seg: 'N1', gold: 12_000 })).ok).toBe(true)
    const root = h.root
    h.close()
    const again = harness({ root, at: T0 + 1000 })
    expect(again.walls.stageOf('N1')).toBe('breached')
    expect(again.queuedPct()).toBe(6)
    again.advance(LOOTER_PASS_MS + 100)
    expect(again.looters()).toHaveLength(3)
    again.advance(BUILDER_STEP_MS)
    expect(again.walls.ipOf('N1')).toBe(-2000 + 50)
  })

  it('GM mason: status, queue, clear, build, looters', () => {
    const h = harness()
    const gm = (...a: string[]) => h.gameplay.wallRepair.gm(a, h.now())
    expect(gm().message).toMatch(/^Repair: 2000 gold or 2 Stone Blocks per 1 %/)
    h.walls.setIp('N1', 10_000, 'gm', h.now())
    expect(gm('queue', 'N1', '3').message).toBe('Queued (free): N1 +3%.')
    expect(gm('queue', 'any', '1').ok).toBe(true)
    expect(h.queuedPct()).toBe(4)
    expect(gm('build', '4').message).toMatch(/1 % of wall repaired/)
    expect(h.walls.ipOf('N1')).toBe(10_200)
    expect(gm('status').message).toMatch(/N1 51%: queued 3%, repairing/)
    expect(gm('clear', 'all').ok).toBe(true)
    expect(h.walls.queuedOf('N1')).toBe(0)
    expect(gm('queue', 'X9', '3').ok).toBe(false)
    expect(gm('build', '0').ok).toBe(false)
    h.walls.gm(['break', 'N1'], h.now())
    expect(gm('looters', 'spawn').message).toMatch(/N1 3\/3/)
    expect(gm('looters', 'clear').message).toMatch(/^3 looters left/)
    expect(gm('nonsense').ok).toBe(false)
  })
})

// keep ItemDef imported for the fixture typing
export type _Items = ItemDef
