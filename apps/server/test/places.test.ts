/**
 * The GM teleport places (docs/PLAYTEST.md "Teleport places"): content/places.json merged after the manifest's places,
 * the startup check, `tp <place|alias>`, `tp npc <name>`, and every listed place on the real jangan-fields export.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { PLACE_GROUPS, manifestPlaces, mergePlaces, parsePlaceRows, readAuthoredPlaces, resolveWorld, withAuthoredPlaces, withTownSpawn, type Place, type WorldSetup } from '../src/content.ts'
import { GameData } from '../src/gamedata.ts'
import { MeshNav } from '../src/nav.ts'
import { checkPlaces, findNpcs, findPlace, placeProblem, placesText } from '../src/places.ts'
import { World, type Npc } from '../src/world.ts'
import { contentFiles } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const npc = (id: number, name: string, code: string, pos: [number, number, number] = [0, 0, 0], yaw = 0): Npc => ({ kind: 'npc', id, code, name, pos, yaw })

describe('places.json (units)', () => {
  it('reads kebab-case rows with a group, an optional height and aliases; bad rows are reported and skipped', () => {
    const r = parsePlaceRows([
      { name: 'plaza', group: 'town', x: 1, y: -3.26, z: 2 },
      { name: 'jangan-south-beach', group: 'coast', x: 3, z: 4, aliases: ['beach-south', 'Bad Alias'] },
      { name: 'tiger-camp-1', x: 5, z: 6 },
      { name: 'Plaza Two', group: 'town', x: 0, z: 0 },
      { name: 'under_score', x: 0, z: 0 },
      { name: 'nowhere', x: 'a', z: 0 },
      { name: 'wrong-group', group: 'dungeon', x: 0, z: 0 },
      { name: 'beach-south', x: 0, z: 0 },
      { name: 'plaza', x: 0, z: 0 },
      'junk',
    ])
    expect(r.places).toEqual([
      { name: 'plaza', x: 1, y: -3.26, z: 2, group: 'town' },
      { name: 'jangan-south-beach', x: 3, z: 4, group: 'coast', aliases: ['beach-south'] },
      { name: 'tiger-camp-1', x: 5, z: 6, group: 'other' },
    ])
    expect(r.problems).toHaveLength(8)
    expect(r.problems.join('\n')).toMatch(/Bad Alias|aliases/)
    expect(r.problems.join('\n')).toMatch(/beach-south is listed twice/)
  })

  it('merges after the manifest: same name replaces, an alias takes the manifest name over, the town spawn names stay', () => {
    const base: Place[] = [
      { name: 'jangan', x: 0, z: 0, group: 'town' },
      { name: 'spawn', x: 0, z: 0, group: 'town' },
      { name: 'grassland', x: 10, z: 10, group: 'fields' },
      { name: 'western-china-ferry', x: -1440, z: -480, group: 'fields' },
      { name: 'beach-south', x: 480, z: 1228.8, group: 'coast' },
    ]
    const authored: Place[] = [
      { name: 'plaza', x: 97, z: -63, group: 'town' },
      { name: 'western-china-ferry', x: -1419.8, z: -344.3, group: 'fields' },
      { name: 'jangan-south-beach', x: 480, z: 1276, group: 'coast', aliases: ['beach-south'] },
      { name: 'spawn', x: 1, z: 1, group: 'town' },
    ]
    const m = mergePlaces(base, authored, 'Jangan')
    expect(m.places.map((p) => p.name)).toEqual(['jangan', 'spawn', 'grassland', 'western-china-ferry', 'plaza', 'jangan-south-beach'])
    expect(m.places.find((p) => p.name === 'western-china-ferry')).toMatchObject({ x: -1419.8, z: -344.3 })
    expect(m.places.find((p) => p.name === 'spawn')).toMatchObject({ x: 0, z: 0 })
    expect(m.problems).toEqual(["places.json: spawn: spawn is the town spawn's name"])
    expect(findPlace(m.places, 'beach-south')?.name).toBe('jangan-south-beach')
    expect(findPlace(m.places, 'nowhere')).toBeUndefined()
  })

  it('groups the manifest places: its own group, coast for the coast design, else fields; keeps a given height', () => {
    const places = manifestPlaces({
      places: [
        { name: 'grassland', x: 1, y: 2, z: 3, source: 'client textzonename.txt "Grassland"' },
        { name: 'beach-south', x: 4, y: 8.9, z: 5, source: 'content/coast/coast.json places: snapped onto open terrain, above the sea level' },
        { name: 'camp', x: 6, z: 7, group: 'bosses' },
      ],
    })
    expect(places).toEqual([
      { name: 'grassland', x: 1, y: 2, z: 3, group: 'fields' },
      { name: 'beach-south', x: 4, y: 8.9, z: 5, group: 'coast' },
      { name: 'camp', x: 6, z: 7, group: 'bosses' },
    ])
  })

  it('reads the file leniently: none, broken, another world', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-places-'))
    try {
      expect(readAuthoredPlaces(undefined, 'jangan')).toEqual({ places: [], problems: [], file: null })
      expect(readAuthoredPlaces(dir, 'jangan')).toEqual({ places: [], problems: [], file: null })
      writeFileSync(join(dir, 'places.json'), '{ nope')
      expect(readAuthoredPlaces(dir, 'jangan').problems[0]).toMatch(/^places\.json: /)
      writeFileSync(join(dir, 'places.json'), JSON.stringify({ world: 'donwhang', places: [{ name: 'a', x: 0, z: 0 }] }))
      expect(readAuthoredPlaces(dir, 'jangan').places).toEqual([])
      writeFileSync(join(dir, 'places.json'), JSON.stringify({ world: 'jangan', places: [{ name: 'a', x: 0, z: 0, group: 'town' }] }))
      const logs: string[] = []
      const setup = withAuthoredPlaces(resolveWorld(join(dir, 'out'), 'jangan', null), dir, 'jangan', (m) => logs.push(m))
      expect(setup.places.map((p) => p.name)).toEqual(['jangan', 'spawn', 'a'])
      expect(logs).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists the places by group, aliases in brackets', () => {
    const text = placesText([
      { name: 'jangan', x: 0, z: 0, group: 'town' },
      { name: 'plaza', x: 0, z: 0, group: 'town' },
      { name: 'jangan-south-beach', x: 0, z: 0, group: 'coast', aliases: ['beach-south'] },
      { name: 'tiger-camp-1', x: 0, z: 0, group: 'bosses' },
    ])
    expect(text.split('\n')).toEqual(['4 places (tp <place>, tp npc <name>):', 'Town: jangan, plaza', 'Coast: jangan-south-beach (beach-south)', 'Bosses: tiger-camp-1'])
  })

  it('finds NPCs by whole name or code first, else by a part of the name, case-insensitive', () => {
    const npcs = [
      npc(1, 'Blacksmith Chulsan', 'NPC_CH_SMITH'),
      npc(2, 'Storage-keeper Wangu', 'NPC_CH_WAREHOUSE_M'),
      npc(3, 'Storage-keeper Sansan', 'NPC_CH_WAREHOUSE_W'),
      npc(4, 'Magic POP', 'NPC_CH_GACHA_MACHINE'),
      npc(5, 'Magic POP Guide Gori', 'NPC_CH_GACHA_OPERATOR'),
    ]
    expect(findNpcs(npcs, 'blacksmith').map((n) => n.id)).toEqual([1])
    expect(findNpcs(npcs, '  CHULSAN ').map((n) => n.id)).toEqual([1])
    expect(findNpcs(npcs, 'storage').map((n) => n.id)).toEqual([2, 3])
    expect(findNpcs(npcs, 'magic pop').map((n) => n.id)).toEqual([4])
    expect(findNpcs(npcs, 'npc_ch_warehouse_w').map((n) => n.id)).toEqual([3])
    expect(findNpcs(npcs, 'nobody')).toEqual([])
    expect(findNpcs(npcs, '   ')).toEqual([])
  })
})

// ---- tp on a server (flat world) ------------------------------------------------------------------------------

const SPAWN: [number, number, number] = [100, 2, -50]

describe('tp places and tp npc on a server', () => {
  let s: TestServer
  const logs: string[] = []
  const contentDir = mkdtempSync(join(tmpdir(), 'sro-places-content-'))

  beforeAll(async () => {
    writeFileSync(
      join(contentDir, 'places.json'),
      JSON.stringify({
        schema: 1,
        kind: 'places',
        world: 'jangan',
        places: [
          { name: 'plaza', group: 'town', x: 97, y: 2, z: -63 },
          { name: 'jangan-south-beach', group: 'coast', aliases: ['beach-south'], x: 150, z: -150 },
          { name: 'tiger-camp-1', group: 'bosses', x: 20, z: -20 },
          { name: 'West Gate', x: 0, z: 0 },
        ],
      }),
    )
    s = await startTestServer({
      logs,
      config: { moveSpeed: 20, tickHz: 20, contentDir },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({
          name: 'jangan',
          spawn: SPAWN,
          space: { originRegion: { x: 168, z: 97 } },
          bounds: { min: [0, 0, -192], max: [192, 0, 0] },
          places: [
            { name: 'grassland', x: 30, z: -30, source: 'client textzonename.txt' },
            { name: 'beach-south', x: 170, z: -170, source: 'content/coast/coast.json' },
          ],
        }),
        ...contentFiles({
          npcs: [
            { code: 'NPC_CH_SMITH', name: 'Blacksmith Chulsan', x: 40, z: -40, yaw: 0, world: 'jangan', model: null, provenance: 'client' },
            { code: 'NPC_CH_WAREHOUSE_M', name: 'Storage-keeper Wangu', x: 60, z: -60, yaw: Math.PI / 2, world: 'jangan', model: null, provenance: 'client' },
            { code: 'NPC_CH_WAREHOUSE_W', name: 'Storage-keeper Sansan', x: 62, z: -60, yaw: 0, world: 'jangan', model: null, provenance: 'client' },
          ],
        }),
      },
    })
  })

  afterAll(async () => {
    await s?.stopAndClean()
    rmSync(contentDir, { recursive: true, force: true })
  })

  async function gmPlayer() {
    const acc = await newAccount(s.url, 'tpgm')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Placer${Math.floor(Math.random() * 1e6)}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    return c
  }

  const gm = async (c: Client, ...args: string[]) => {
    c.send({ t: 'gm', cmd: 'tp', args })
    return c.next('gmResult')
  }

  it('logs the bad row; the list carries the groups and aliases, manifest first, beach-south folded into its alias', async () => {
    expect(logs.some((l) => /^places: places\.json places\[3\]: the name must be kebab-case/.test(l)), logs.join('\n')).toBe(true)
    const c = await gmPlayer()
    const list = await gm(c)
    expect(list.ok).toBe(true)
    expect((list.data as { presets: unknown[] }).presets).toEqual([
      { name: 'jangan', x: SPAWN[0], z: SPAWN[2], group: 'town' },
      { name: 'spawn', x: SPAWN[0], z: SPAWN[2], group: 'town' },
      { name: 'grassland', x: 30, z: -30, group: 'fields' },
      { name: 'plaza', x: 97, z: -63, group: 'town' },
      { name: 'jangan-south-beach', x: 150, z: -150, group: 'coast', aliases: ['beach-south'] },
      { name: 'tiger-camp-1', x: 20, z: -20, group: 'bosses' },
    ])
    expect(list.message).toContain('Coast: jangan-south-beach (beach-south)')
    c.close()
    await c.closed
  })

  it('tp <alias> lands on the authored place; tp npc finds by a part of the name and refuses an ambiguous one', async () => {
    const c = await gmPlayer()
    const beach = await gm(c, 'beach-south')
    expect(beach).toMatchObject({ ok: true, data: { pos: [150, expect.any(Number), -150], place: 'jangan-south-beach' } })
    const smith = await gm(c, 'npc', 'chulSAN')
    expect(smith.ok, smith.message).toBe(true)
    expect(smith.message).toMatch(/^Teleported next to Blacksmith Chulsan/)
    const pos = (smith.data as { pos: number[] }).pos
    // 2.5 m in front of it (yaw 0 faces +z)
    expect(pos[0]).toBeCloseTo(40, 3)
    expect(pos[2]).toBeCloseTo(-37.5, 3)
    const wangu = await gm(c, 'npc', 'storage-keeper', 'wangu')
    expect((wangu.data as { pos: number[] }).pos[0]).toBeCloseTo(62.5, 3)
    const both = await gm(c, 'npc', 'Storage')
    expect(both.ok).toBe(false)
    expect(both.message).toBe('"Storage" matches 2 NPCs: Storage-keeper Sansan, Storage-keeper Wangu. Type more of the name.')
    expect((await gm(c, 'npc', 'nobody')).message).toBe('No NPC named like "nobody".')
    expect((await gm(c, 'nowhere')).message).toMatch(/No place or online player named nowhere/)
    c.close()
    await c.closed
    await sleep(20)
  })
})

// ---- every listed place on the real jangan-fields export ---------------------------------------------------------

const OUT = join(REPO_ROOT, 'work/out')
const FIELDS_READY = existsSync(join(OUT, 'world/jangan-fields/manifest.json')) && existsSync(join(OUT, 'world/jangan-fields/nav.bin')) && existsSync(join(OUT, 'data/towns.json'))

describe.skipIf(!FIELDS_READY)('the teleport places on the real jangan-fields export', () => {
  const logs: string[] = []
  const contentDir = join(REPO_ROOT, 'content')
  let data: GameData
  let setup: WorldSetup
  let nav: MeshNav
  let world: World
  let kept: Place[]
  let authored: { places: (Place & { snap?: { area?: string; nest?: number } })[] }
  let seaLevel: number
  let home: number

  beforeAll(() => {
    data = GameData.load(OUT)
    const base = withTownSpawn(resolveWorld(OUT, 'jangan-fields', null, 'jangan'), 'jangan', data.town('jangan'))
    setup = withAuthoredPlaces(base, contentDir, 'jangan', (m) => logs.push(m))
    nav = MeshNav.load([OUT], 'jangan-fields').nav!
    world = new World('jangan', 5.5, 20, setup.bounds, nav)
    kept = checkPlaces(setup.places, world, nav, ['jangan', 'spawn'], (m) => logs.push(m))
    authored = JSON.parse(readFileSync(join(contentDir, 'places.json'), 'utf8'))
    seaLevel = (JSON.parse(readFileSync(join(OUT, 'world/jangan-fields/manifest.json'), 'utf8')) as { coast?: { seaLevelM?: number } }).coast?.seaLevelM ?? 5
    home = nav.componentOf(nav.locate(setup.spawn.x, setup.spawn.z, setup.spawnHintY ?? Infinity)!)
  }, 60_000)

  it('content/places.json reads without a problem and every listed place passes the startup check', () => {
    expect(logs.filter((l) => !/^places: \d+ GM teleport places/.test(l)), logs.join('\n')).toEqual([])
    expect(kept.map((p) => p.name)).toEqual(setup.places.map((p) => p.name))
    for (const g of PLACE_GROUPS.slice(0, 4)) expect(kept.some((p) => p.group === g), g).toBe(true)
  })

  it('has the town spots, the retail areas, the coast and the 11 Tiger Girl camps, beach-south as an alias', () => {
    const names = kept.map((p) => p.name)
    for (const n of ['plaza', 'palace-steps', 'south-gate', 'north-gate', 'east-gate', 'west-gate', 'market', 'smith', 'stable', 'pond', 'storage']) expect(names).toContain(n)
    // the 13 retail areas: Jangan itself is the town spawn (tp jangan), the other 12 are fields
    expect(kept.filter((p) => p.group === 'fields')).toHaveLength(12)
    for (let i = 1; i <= 11; i++) expect(names).toContain(`tiger-camp-${i}`)
    expect(names).toContain('jangan-south-beach')
    expect(names).not.toContain('beach-south')
    expect(findPlace(kept, 'beach-south')?.name).toBe('jangan-south-beach')
    expect(new Set(names).size).toBe(names.length)
  })

  it('each place resolves the way tp does: open ground in the town spawn walkable component, near the listed point', () => {
    for (const p of kept) {
      if (p.name === 'jangan' || p.name === 'spawn') continue
      expect(placeProblem(p, world, nav), p.name).toBeNull()
      const at = world.placeFor(p.x, p.z, p.y ?? Infinity)!
      expect(nav.componentOf(at), p.name).toBe(home)
      expect(Math.hypot(at.x - p.x, at.z - p.z), p.name).toBeLessThan(authored.places.some((a) => a.name === p.name) ? 0.5 : 10)
      if (p.y !== undefined && authored.places.some((a) => a.name === p.name)) expect(Math.abs(at.y - p.y), p.name).toBeLessThan(0.1)
    }
  })

  it('town spots are in Jangan, area places in their own area (western-china-ferry too), the coast above the sea, camps by their nests', () => {
    const origin = setup.regionOrigin
    for (const a of authored.places) {
      const zone = data.zoneName(a.x, a.z, origin)
      if (a.group === 'town') expect(zone, a.name).toBe('Jangan')
      if (a.snap?.area) expect(zone, a.name).toBe(a.snap.area)
      if (a.group === 'coast') expect(a.y!, a.name).toBeGreaterThan(seaLevel)
      if (a.snap?.nest !== undefined) {
        const nest = data.nests.find((n) => n.id === a.snap!.nest)!
        expect(nest.mob).toBe('MOB_CH_TIGERWOMAN')
        expect(Math.hypot(nest.x - a.x, nest.z - a.z), a.name).toBeLessThan(40)
      }
    }
    expect(authored.places.find((p) => p.name === 'western-china-ferry')?.snap?.area).toBe('Western China Ferry')
    // the camps are all of Tiger Girl's
    const camps = data.nests.filter((n) => n.mob === 'MOB_CH_TIGERWOMAN' && n.world === 'jangan').map((n) => n.id).sort()
    expect(authored.places.filter((p) => p.group === 'bosses').map((p) => p.snap!.nest).sort()).toEqual(camps)
  })
})
