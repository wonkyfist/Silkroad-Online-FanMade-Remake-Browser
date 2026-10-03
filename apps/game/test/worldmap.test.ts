/**
 * Lane FLD-C (docs/FIELDS.md §7 lane 4): the world map transform, zone lookup and labels, hunting clusters and their
 * level colours, and a headless check (NullEngine, like packages/world-render/test/load.test.ts) that the game's
 * loader streams jangan-fields from work/out-opt around the town spawn and becomes ready, while the 3 x 3 'jangan'
 * export still loads whole. The export-backed checks skip when the export is absent.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NullEngine, Scene, type AbstractMesh } from '@babylonjs/core'
import type { WorldIO } from '@sro/world-render'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadJangan, type JanganGround } from '../src/world/jangan/ground.ts'
import { markerKind, streamStatsText } from '../src/world/features/map.ts'
import { EntityHeights } from '../src/world/jangan/heights.ts'
import { LEVEL_BAND_COLOR } from '../src/world/level-band.ts'
import { CLUSTER_LINK_M, huntColor, huntingClusters, linkage, type HuntMob, type HuntNest } from '../src/world/map/hunting.ts'
import { MAP_FILL, MapTransform, clampZoom, isOpenSea, mapFill, mapGeometry, medianHex, type WorldMapGeometry } from '../src/world/map/worldmap.ts'
import { ZoneIndex, loadZones, parseZones, regionCentre, regionOf, resetZones, zoneAt, zoneIndex, type ZoneEntry } from '../src/world/map/zones.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** jangan-fields' manifest.stream.worldMap (work/tmp/w3c-report.md, FLD-X). */
const FIELDS_MAP: WorldMapGeometry = { file: 'worldmap.webp', pxPerRegion: 64, x0: 155, x1: 175, z0: 89, z1: 103, width: 1344, height: 960 }
const ORIGIN = { x: 168, z: 97 }

describe('world map transform', () => {
  it('round-trips the four corners of stream.worldMap between map pixels and glTF metres', () => {
    const T = new MapTransform(FIELDS_MAP, ORIGIN)
    expect(T.mPerPx).toBe(3)
    const corners = [
      { px: 0, py: 0, x: (155 - 168) * 192, z: -(103 - 97 + 1) * 192 }, // north-west of region (155, 103)
      { px: 1344, py: 0, x: (176 - 168) * 192, z: -(103 - 97 + 1) * 192 },
      { px: 0, py: 960, x: (155 - 168) * 192, z: -(89 - 97) * 192 }, // south-west of region (155, 89)
      { px: 1344, py: 960, x: (176 - 168) * 192, z: -(89 - 97) * 192 },
    ]
    for (const c of corners) {
      const w = T.pxToWorld(c.px, c.py)
      expect(w.x).toBeCloseTo(c.x, 9)
      expect(w.z).toBeCloseTo(c.z, 9)
      const p = T.worldToPx(w.x, w.z)
      expect(p.px).toBeCloseTo(c.px, 9)
      expect(p.py).toBeCloseTo(c.py, 9)
    }
    expect(T.bounds).toEqual({ minX: -2496, minZ: -1344, maxX: 1536, maxZ: 1536 })
    // Region (x, z) sits at column (x − x0)·64, row (z1 − z)·64: the town spawn is in the origin region (168, 97).
    const spawn = T.worldToPx(96.9, -136.9)
    expect(Math.floor(spawn.px / 64)).toBe(168 - 155)
    expect(Math.floor(spawn.py / 64)).toBe(103 - 97)
    expect(T.regionAtPx(spawn.px, spawn.py)).toEqual({ rx: 168, rz: 97 })
    expect(T.regionAtPx(0.5, 0.5)).toEqual({ rx: 155, rz: 103 })
    expect(T.regionAtPx(1343.5, 959.5)).toEqual({ rx: 175, rz: 89 })
  })

  it('uses the manifest world map, or the span of the regions at 64 px per region', () => {
    expect(mapGeometry({ regions: [], stream: { worldMap: { ...FIELDS_MAP, file: 'worldmap.webp' } } })).toEqual(FIELDS_MAP)
    const regions = [167, 168, 169].flatMap(x => [96, 97, 98].map(z => ({ x, z, minimap: `minimap/${x}x${z}.webp` })))
    const g = mapGeometry({ regions })
    expect(g).toEqual({ file: null, pxPerRegion: 64, x0: 167, x1: 169, z0: 96, z1: 98, width: 192, height: 192 })
    const T = new MapTransform(g, ORIGIN)
    expect(T.bounds).toEqual({ minX: -192, minZ: -384, maxX: 384, maxZ: 192 })
    expect(clampZoom(0.1)).toBe(0.5)
    expect(clampZoom(9)).toBe(4)
    expect(clampZoom(1.25)).toBe(1.25)
  })

  it('fills around the image with the sea colour when the export has a coast (docs/COAST.md §11)', () => {
    expect(mapFill({ regions: [] })).toBe(MAP_FILL)
    expect(mapFill({ regions: [], coast: null })).toBe(MAP_FILL)
    expect(mapFill({ regions: [], coast: { mapColor: 'url(x)' } })).toBe(MAP_FILL)
    // The deep-water tone of mapColor (x 0.75), the colour the export's sea tiles reach at the map's edge.
    expect(mapFill({ regions: [], coast: { mapColor: '#2a5d7c' } })).toBe('#20465d')
    // Once the image is loaded, its border's median colour continues the sea past the image.
    expect(medianHex([[33, 74, 99, 255, 38, 84, 113, 255], [35, 78, 104, 255]])).toBe('#234e68')
    expect(medianHex([])).toBe(null)
    // Land, sand and the retail teal on the border are skipped.
    expect([isOpenSea(33, 74, 99), isOpenSea(70, 90, 40), isOpenSea(150, 140, 110), isOpenSea(84, 141, 137)]).toEqual([true, false, false, false])
    expect(medianHex([[70, 90, 40, 255, 33, 74, 99, 255, 150, 140, 110, 255]], isOpenSea)).toBe('#214a63')
  })

  it('the jangan-fields export covers the coast domain at 64 px per region, with a sea fill', () => {
    const file = join(REPO, 'work/out/world/jangan-fields/manifest.json')
    if (!existsSync(file)) return
    const m = JSON.parse(readFileSync(file, 'utf8')) as Parameters<typeof mapGeometry>[0]
    const g = mapGeometry(m)
    if (!m.coast) return
    expect(g.width).toBe((g.x1 - g.x0 + 1) * 64)
    expect(g.height).toBe((g.z1 - g.z0 + 1) * 64)
    for (const r of m.regions) {
      expect(r.x >= g.x0 && r.x <= g.x1 && r.z >= g.z0 && r.z <= g.z1).toBe(true)
    }
    expect(mapFill(m)).toMatch(/^#[0-9a-f]{6}$/i)
    expect(mapFill(m)).not.toBe(MAP_FILL)
  })
})

describe('zones', () => {
  const rows: ZoneEntry[] = [
    { region: (97 << 8) | 168, rx: 168, rz: 97, name: 'Jangan', area: 'Town_Jangan', continent: 'CHINA', town: 'JANGAN' },
    { region: (97 << 8) | 169, rx: 169, rz: 97, name: 'Jangan', area: 'Town_Jangan', continent: 'CHINA', town: 'JANGAN' },
    { region: (97 << 8) | 167, rx: 167, rz: 97, name: '', area: null, continent: null },
    { region: (97 << 8) | 166, rx: 166, rz: 97, name: '', area: null, continent: null },
    { region: (98 << 8) | 165, rx: 165, rz: 98, name: 'North-Tiger Mt.', area: null, continent: 'CHINA' },
    { region: (99 << 8) | 165, rx: 165, rz: 99, name: 'North-Tiger Mt.', area: null, continent: 'CHINA' },
  ]

  beforeEach(() => resetZones())

  it('maps glTF metres to regions (north is −z)', () => {
    expect(regionOf(96.9, -136.9)).toEqual({ rx: 168, rz: 97 })
    expect(regionOf(-0.1, 0.1)).toEqual({ rx: 167, rz: 96 })
    expect(regionOf(191.9, -191.9)).toEqual({ rx: 168, rz: 97 })
    expect(regionOf(192, -192)).toEqual({ rx: 169, rz: 98 })
    expect(regionCentre(168, 97)).toEqual({ x: 96, z: -96 })
    const c = regionCentre(158, 101)
    expect(regionOf(c.x, c.z)).toEqual({ rx: 158, rz: 101 })
  })

  it('names a region, an unnamed one after its nearest named neighbour, and nothing far away', () => {
    const z = new ZoneIndex(parseZones({ schema: 1, kind: 'zones', entries: rows }))
    expect(z.size).toBe(6)
    expect(z.nameAt(96.9, -136.9)).toBe('Jangan')
    // (167, 97) is unnamed; of its neighbours only Jangan (168, 97) has a name.
    expect(z.nameAt(-5, -96)).toBe('Jangan')
    expect(z.nameAt(-190, -190)).toBe('Jangan')
    // (166, 97): the named (165, 98) touches its north-west.
    expect(z.nameAt(-380, -180)).toBe('North-Tiger Mt.')
    // Outside the file.
    expect(z.nameAt(5000, 5000)).toBeNull()
  })

  it('puts one label per zone at the mean of its region centres', () => {
    const labels = new ZoneIndex(parseZones(rows)).labels()
    expect(labels.map(l => l.name)).toEqual(['Jangan', 'North-Tiger Mt.'])
    const jangan = labels[0]!
    expect(jangan).toMatchObject({ regions: 2, town: true })
    expect(jangan.x).toBeCloseTo((96 + 288) / 2, 9)
    expect(jangan.z).toBeCloseTo(-96, 9)
    const tiger = labels[1]!
    expect(tiger).toMatchObject({ regions: 2, town: false })
    expect(tiger.x).toBeCloseTo((165 - 168 + 0.5) * 192, 9)
    expect(tiger.z).toBeCloseTo(-((98 - 97 + 0.5) * 192 + (99 - 97 + 0.5) * 192) / 2, 9)
  })

  it('skips malformed rows', () => {
    const got = parseZones([{ rx: 1, rz: 2, region: 999, name: 'bad id' }, { rx: 1.5, rz: 2 }, null, { rx: 3, rz: 4, name: 7 }])
    expect(got).toEqual([{ region: (4 << 8) | 3, rx: 3, rz: 4, name: '', area: null, continent: null }])
    expect(parseZones('nope')).toEqual([])
  })

  it('zoneAt loads zones.json lazily and answers null until then', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/out/')) return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response(JSON.stringify({ schema: 1, kind: 'zones', entries: rows }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    expect(zoneIndex()).toBeNull()
    const idx = await loadZones(fetchFn)
    expect(idx?.size).toBe(6)
    expect(zoneAt(96.9, -136.9)).toBe('Jangan')
    resetZones()
    const none = await loadZones((async () => new Response('', { status: 404 })) as unknown as typeof fetch)
    expect(none).toBeNull()
    expect(zoneAt(96.9, -136.9)).toBeNull()
  })

  const zonesFile = join(REPO, 'work', 'out', 'data', 'zones.json')
  it.skipIf(!existsSync(zonesFile))('reads the exported zones.json: Jangan at the spawn, the named fields and beaches around it', () => {
    const z = new ZoneIndex(parseZones(JSON.parse(readFileSync(zonesFile, 'utf8'))))
    // every region of the export: the 307 retail ones and the coast's 107 synthetic ones (P-DATA, wave 10r polish)
    expect(z.size).toBe(414)
    expect(z.nameAt(96.9, -136.9)).toBe('Jangan')
    const labels = z.labels()
    expect(labels.length).toBe(34)
    // the playable town; the client also names the synthetic ring regions where retail Donwhang would be (153, 102)
    expect(labels.filter(l => l.town).map(l => l.name)).toEqual(['Jangan', 'Western China Donwhang'])
    expect(labels.map(l => l.name)).toContain('North-Tiger Mt.')
    // the coast's own area names for the regions the client has no name for (content/coast/coast.json)
    expect(labels.find(l => l.name === 'Jangan South Beach')?.regions).toBe(20)
    // 'Chinese tomb' (2 regions) and 'Chinese Tomb' (9) are one zone, shown in the majority spelling.
    expect(labels.find(l => l.name.toLowerCase() === 'chinese tomb')).toMatchObject({ name: 'Chinese Tomb', regions: 11 })
  })
})

describe('hunting clusters', () => {
  const mobs = new Map<string, HuntMob>([
    ['MOB_CH_TIGER', { code: 'MOB_CH_TIGER', name: 'Tiger', level: 14, rarity: 'normal' }],
    ['MOB_CH_BANDIT', { code: 'MOB_CH_BANDIT', name: 'Bandit', level: 16, rarity: 'normal' }],
    ['MOB_CH_TIGERWOMAN', { code: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', level: 20, rarity: 'unique' }],
    ['MOB_WC_EARTHKING', { code: 'MOB_WC_EARTHKING', name: 'Earth Taoist', level: 30, rarity: 'normal' }],
  ])
  const nest = (mob: string, x: number, z: number, extra: Partial<HuntNest> = {}): HuntNest => ({ mob, x, z, count: 5, ...extra })

  it('links nests of the same mob within 200 m (chains too) into one label each', () => {
    const nests = [
      nest('MOB_CH_TIGER', 0, 0),
      nest('MOB_CH_TIGER', 150, 0),
      nest('MOB_CH_TIGER', 300, 0), // 150 m from the previous one: same chain
      nest('MOB_CH_TIGER', 900, 0), // alone
      nest('MOB_CH_BANDIT', 10, 10), // other mob, own label even when close
    ]
    const got = huntingClusters(nests, c => mobs.get(c))
    expect(got.map(h => [h.name, h.level, h.nests, h.mobs])).toEqual([
      ['Tiger', 14, 3, 15],
      ['Tiger', 14, 1, 5],
      ['Bandit', 16, 1, 5],
    ])
    expect(got[0]!.x).toBeCloseTo(150, 9)
    expect(got[0]!.z).toBeCloseTo(0, 9)
    expect(CLUSTER_LINK_M).toBe(200)
    expect(linkage([{ x: 0, z: 0 }, { x: 0, z: 200 }, { x: 0, z: 401 }], 200).map(g => g.length)).toEqual([2, 1])
  })

  it('merges the 11 Tiger Girl camps into one unique label at their mean', () => {
    const camps = Array.from({ length: 11 }, (_, i) => nest('MOB_CH_TIGERWOMAN', -1400 + i * 120, 900 + (i % 3) * 300, { uniqueGroup: 'MOB_CH_TIGERWOMAN', count: 1 }))
    const got = huntingClusters([...camps, nest('MOB_CH_TIGER', -1400, 900)], c => mobs.get(c))
    const girl = got.filter(h => h.unique)
    expect(girl).toHaveLength(1)
    expect(girl[0]).toMatchObject({ name: 'Tiger Girl', level: 20, nests: 11, mobs: 11 })
    expect(girl[0]!.x).toBeCloseTo(camps.reduce((s, n) => s + n.x, 0) / 11, 9)
    expect(girl[0]!.z).toBeCloseTo(camps.reduce((s, n) => s + n.z, 0) / 11, 9)
    expect(got.filter(h => !h.unique).map(h => h.name)).toEqual(['Tiger'])
  })

  it('leaves out disabled nests, nests above the level limit and nests outside the map', () => {
    const nests = [
      nest('MOB_CH_TIGER', 0, 0, { enabled: false }),
      nest('MOB_WC_EARTHKING', 0, 0),
      nest('MOB_CH_BANDIT', 5000, 0),
      nest('MOB_CH_BANDIT', 100, 100),
      nest('MOB_UNKNOWN', 0, 0), // no mob row and no level copy
      nest('MOB_UNKNOWN2', 0, 0, { level: 3 }), // no mob row: the nest's level copy and the code as name
    ]
    const got = huntingClusters(nests, c => mobs.get(c), { maxLevel: 25, bounds: { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 } })
    expect(got.map(h => `${h.name} ${h.level}`)).toEqual(['MOB_UNKNOWN2 3', 'Bandit 16'])
  })

  it('colours labels by the shared level band at player levels 1, 10 and 20', () => {
    // Tiger Lv 14.
    expect(huntColor(14, 1)).toBe(LEVEL_BAND_COLOR.strong2)
    expect(huntColor(14, 10)).toBe(LEVEL_BAND_COLOR.strong1)
    expect(huntColor(14, 20)).toBe(LEVEL_BAND_COLOR.weak2)
    // Bandit Lv 16.
    expect(huntColor(16, 1)).toBe(LEVEL_BAND_COLOR.strong2)
    expect(huntColor(16, 10)).toBe(LEVEL_BAND_COLOR.strong2)
    expect(huntColor(16, 20)).toBe(LEVEL_BAND_COLOR.weak1)
    // Mangyang Lv 1 and a same-level mob.
    expect(huntColor(1, 1)).toBe(LEVEL_BAND_COLOR.normal)
    expect(huntColor(1, 10)).toBe(LEVEL_BAND_COLOR.weak2)
    expect(huntColor(20, 20)).toBe(LEVEL_BAND_COLOR.normal)
  })

  const nestsFile = join(REPO, 'work', 'out', 'data', 'nests.json')
  const mobsFile = join(REPO, 'work', 'out', 'data', 'mobs.json')
  it.skipIf(!existsSync(nestsFile) || !existsSync(mobsFile))('clusters the exported nests of the fields into a readable number of labels', () => {
    const nests = (JSON.parse(readFileSync(nestsFile, 'utf8')) as { entries: HuntNest[] }).entries
    const mobRows = (JSON.parse(readFileSync(mobsFile, 'utf8')) as { entries: HuntMob[] }).entries
    const byCode = new Map(mobRows.map(m => [m.code, m]))
    const T = new MapTransform(FIELDS_MAP, ORIGIN)
    const got = huntingClusters(nests, c => byCode.get(c), { maxLevel: 25, bounds: T.bounds })
    const girl = got.filter(h => h.unique)
    expect(girl.map(h => h.name)).toEqual(['Tiger Girl'])
    expect(girl[0]!.nests).toBe(11)
    expect(got.some(h => h.name === 'Tiger' && h.level === 14)).toBe(true)
    expect(got.some(h => h.name === 'Bandit' && h.level === 16)).toBe(true)
    expect(got.every(h => h.level <= 25)).toBe(true)
    expect(got.length).toBeGreaterThan(30)
    expect(got.length).toBeLessThan(400)
  })
})

describe('map feature helpers', () => {
  it('names NPC markers by service and formats the streaming line', () => {
    expect(markerKind({ roles: ['teleport'] })).toBe('teleport')
    expect(markerKind({ roles: ['storage'] })).toBe('storage')
    expect(markerKind({ shop: 'STORE_CH_SMITH', roles: ['shop'] })).toBe('shop')
    expect(markerKind({})).toBe('npc')
    expect(streamStatsText({ ready: 21, wanted: 23, bytes: 36 * 1048576, lastFrameMs: 3.04, worstFrameMs: 11.26 })).toBe('Regions 21/23  |  36.0 MB  |  stream 3.0/11.3 ms')
  })
})

// ---- headless: the game's loader on the real exports ------------------------------------------------------

const io: WorldIO = {
  async bytes(url) {
    const buf = await readFile(fileURLToPath(url))
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  },
  async decodeImage(_bytes, _mime, size) {
    const s = size ?? 4
    return { width: s, height: s, data: new Uint8Array(s * s * 4).fill(128) }
  },
}

async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

const OUT_OPT = join(REPO, 'work', 'out-opt')
const hasFields = existsSync(join(OUT_OPT, 'world', 'jangan-fields', 'manifest.json')) && existsSync(join(OUT_OPT, 'world', 'jangan-fields', 'nav-objects.bin'))
const hasJangan = existsSync(join(OUT_OPT, 'world', 'jangan', 'manifest.json'))

describe.skipIf(!hasFields && !hasJangan)('loadJangan (NullEngine, work/out-opt)', () => {
  const engines: NullEngine[] = []
  const grounds: JanganGround[] = []
  const scene = (): Scene => {
    const engine = new NullEngine()
    engines.push(engine)
    const s = new Scene(engine)
    s.useRightHandedSystem = true
    return s
  }
  const roots = [pathToFileURL(OUT_OPT + '/').href]

  afterAll(() => {
    for (const g of grounds) g.dispose()
    for (const e of engines) e.dispose()
  })

  it.skipIf(!hasFields)('streams jangan-fields around the town spawn, becomes ready and keeps picking and heights live', async () => {
    const t0 = performance.now()
    const g = await loadJangan(scene(), { world: 'jangan-fields', focus: { x: 96.9, z: -136.9 }, quality: 'medium', roots, io, minimap: false })
    grounds.push(g)
    const ms = performance.now() - t0
    const s = g.world.stream!
    expect(s).not.toBeNull()
    expect(g.folder).toBe('jangan-fields')
    expect(g.world.navSource).toBe('stream')
    console.log(`[game] jangan-fields town streamed in ${(ms / 1000).toFixed(1)} s: ${JSON.stringify(s.stats)}`)
    expect(s.stats.wanted).toBeGreaterThanOrEqual(20)
    expect(s.state(168, 97)).toBe('ready')
    expect(g.world.objects.errors).toEqual([])
    // The GATE_CH plaza, as in the 3 x 3 export.
    expect(g.heightAt(100.84, -71.5)).toBeCloseTo(-3.261, 2)
    await g.ready(96.9, -136.9)
    // Live isGround: every terrain mesh counts, including the ones streamed in after the load.
    expect(g.world.terrain.meshes.length).toBeGreaterThan(0)
    for (const m of g.world.terrain.meshes) expect(g.isGround(m as AbstractMesh)).toBe(true)
    expect(g.isGround(g.world.sky.mesh as AbstractMesh)).toBe(false)

    // Self prediction: a move into a region that is not loaded is taken from the server unchanged.
    const heights = new EntityHeights(g, g.world)
    heights.selfId = 1
    heights.placeSelf([96.9, -3.26, -136.9])
    const far = { from: [96.9, -3.26, -136.9] as [number, number, number], to: [-1900, 60, 900] as [number, number, number], speed: 5, startedAt: 0 }
    expect(s.navCovers(96.9, -136.9, -1900, 900)).toBe(false)
    expect(heights.selfMove(far as never)).toBe(far)
    // Unsettled: the height comes from the ground (the server's y where nothing is loaded).
    expect(heights.heightOf(1, -1900, 900, 61.5)).toBe(61.5)
    // A stop in the loaded town places the track again.
    heights.selfStop([100.84, -3.26, -71.5])
    expect(heights.heightOf(1, 100.84, -71.5, -3.26)).toBeCloseTo(-3.261, 2)

    // A warp far west (GM tp): the loading-screen wait re-centres the streamer and resolves once that area is in.
    const west = { x: -1300, z: 600 }
    await g.ready(west.x, west.z)
    const r = { rx: 168 + Math.floor(west.x / 192), rz: 97 + Math.floor(-west.z / 192) }
    expect(s.state(r.rx, r.rz)).toBe('ready')
    expect(s.navCovers(west.x, west.z, west.x, west.z)).toBe(true)
    expect(Number.isFinite(g.heightAt(west.x, west.z))).toBe(true)
    await until(() => {
      s.update(west, null)
      return s.stats.jobs === 0 && s.stats.fetching === 0
    })
    expect(s.stats.failed).toBe(0)
    for (const m of g.world.terrain.meshes) expect(g.isGround(m as AbstractMesh)).toBe(true)
  })

  it.skipIf(!hasJangan)('still loads the 3 x 3 jangan export whole (the server default)', async () => {
    const g = await loadJangan(scene(), { world: 'jangan', focus: { x: 96.9, z: -136.9 }, quality: 'medium', roots, io, minimap: false })
    grounds.push(g)
    expect(g.world.stream).toBeNull()
    expect(g.folder).toBe('jangan')
    expect(g.world.terrain.meshes).toHaveLength(9)
    for (const m of g.world.terrain.meshes) expect(g.isGround(m as AbstractMesh)).toBe(true)
    expect(g.heightAt(100.84, -71.5)).toBeCloseTo(-3.261, 2)
    await g.ready(96.9, -136.9) // immediate without streaming
    const heights = new EntityHeights(g, g.world)
    heights.selfId = 1
    heights.placeSelf([96.9, -3.26, -136.9])
    const move = { from: [96.9, -3.26, -136.9] as [number, number, number], to: [97.9, -3.26, -135.9] as [number, number, number], speed: 5, startedAt: 0 }
    expect(heights.selfMove(move as never).to).toEqual(move.to)
  })
})
