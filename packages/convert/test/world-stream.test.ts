/**
 * Streamed world exports (docs/FIELDS.md §3.9, §4.6, §5.3, §6.2; lane 1 tests):
 * - pure: placeSlug, stitchWorldMap, buildZones on synthetic rows;
 * - corpus (skips without sro.config.json): a 2 x 2 streamed conversion (167-168 x 96-97) into a temp dir, checked
 *   against its own nav.bin (per-region chunks bit-equal, nav-objects.bin in order), bounds, the world map size,
 *   validateWorldManifest and the places; zone names from the client's textzonename.txt;
 * - output (skips without work/out/world/jangan-fields): the fact-checked numbers of the full export.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadTextdataTable } from '@sro/formats'
import { decodeNavData, encodeNavData, NavGltf, NavWorld, type NavData } from '@sro/nav'
import { WE_EDITOR_UID_MAX, WE_EDITOR_UID_MIN } from '../../shared/src/world-edits/index.ts'
import { buildZones, checkZones, zoneNameIndex } from '../src/data/zones.ts'
import { textdataReader } from '../src/data/textdata-source.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { convertWorld, rectBounds, regionRange, WORLD_PRESETS } from '../src/world/convert-world.ts'
import { parseCoastConfig } from '../src/world/coast/config.ts'
import { configDrowns } from '../src/world/coast/drown.ts'
import { validateWorldManifest, type WorldManifest } from '../src/world/manifest.ts'
import { navRegionFile } from '../src/world/nav.ts'
import { placeSlug } from '../src/world/places.ts'
import { boxDownsample, stitchWorldMap, WORLD_MAP_FILL } from '../src/world/worldmap.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const FIELDS = join(REPO_ROOT, 'work', 'out', 'world', 'jangan-fields')
const hasFields = existsSync(join(FIELDS, 'manifest.json'))
/** The export with no world edits applied (X2): 7,161 placements, 2,233 object navmeshes. */
const PRISTINE = { placements: 7161, navInstances: 2233 }
/** A World Editor add (kept by a publish) carries an editor uid; its nav id is regionId << 16 | uid. */
const editorUid = (uid: number) => uid >= WE_EDITOR_UID_MIN && uid <= WE_EDITOR_UID_MAX

/** PNG IHDR width/height. */
const pngSize = (bytes: Uint8Array) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

describe('placeSlug (FIELDS §4.6)', () => {
  it('lower-cases, drops apostrophes and dots, dashes the rest', () => {
    expect(placeSlug('North-Tiger Mt.')).toBe('north-tiger-mt')
    expect(placeSlug("Bandit's Mountain Stronghold")).toBe('bandits-mountain-stronghold')
    expect(placeSlug('Enterance of Qin-Shi Tomb')).toBe('enterance-of-qin-shi-tomb')
    expect(placeSlug('Chinese tomb')).toBe(placeSlug('Chinese Tomb'))
    expect(placeSlug("Yeoha's Forest")).toBe('yeohas-forest')
    expect(placeSlug('Entrance-Western China Donwhang')).toBe('entrance-western-china-donwhang')
    expect(placeSlug('Entrance-Western China Donwhang')!.length).toBe(31)
    expect(placeSlug('  ?? ')).toBeNull()
    expect(placeSlug('x'.repeat(33))).toBeNull()
  })
})

describe('stitchWorldMap (FIELDS §5.3)', () => {
  it('box-filters 4 x 4 blocks and places region (x, z1) at the top left, north up', () => {
    const tile = (r: number, g: number) => {
      const rgba = new Uint8Array(8 * 8 * 4)
      for (let i = 0; i < 64; i++) rgba.set([r, i < 32 ? g : 0, 0, 7], i * 4) // top half green g, bottom half 0
      return { width: 8, height: 8, rgba }
    }
    expect([...boxDownsample(tile(10, 200), 2)]).toEqual([10, 200, 0, 255, 10, 200, 0, 255, 10, 0, 0, 255, 10, 0, 0, 255])
    // Regions x 5..6, z 1..2: only (5, 2) (north-west) and (6, 1) (south-east) have tiles.
    const img = stitchWorldMap({ x0: 5, x1: 6, z0: 1, z1: 2 }, (x, z) => (x === 5 && z === 2 ? tile(50, 60) : x === 6 && z === 1 ? tile(90, 80) : null), 2)
    expect(img).toMatchObject({ width: 4, height: 4, tiles: 2 })
    const px = (x: number, y: number) => [...img.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)]
    expect(px(0, 0)).toEqual([50, 60, 0, 255])
    expect(px(1, 1)).toEqual([50, 0, 0, 255])
    expect(px(3, 2)).toEqual([90, 80, 0, 255])
    expect(px(3, 0)).toEqual([...WORLD_MAP_FILL, 255])
    expect(px(0, 3)).toEqual([...WORLD_MAP_FILL, 255])
  })
})

describe('buildZones (FIELDS §6.2)', () => {
  const header = ['Service', 'CodeName128', 'Korean', '?', 'Chinese Traditional', 'Chinese Simplified', 'Deutch', 'Japan', 'English', 'Vietnam']
  const row = (id: number, en: string, service = '1') => [service, String(id), '장안', '', '長安', '', '长安', '', en, 'x']
  it('joins textzonename (English column), refregion and towns per export region', () => {
    const zones = buildZones({
      regions: [{ x: 168, z: 97 }, { x: 158, z: 95 }, { x: 170, z: 103 }],
      zoneNames: [row(25000, 'Jangan'), row(25000, 'Other'), row(24478, 'North-Tiger Mt.'), row(26538, 'Hidden', '0')],
      zoneHeader: header,
      refregion: [['25000', '168', '97', 'CHINA', 'Town_Jangan'], ['24478', '158', '95', 'CHINA', '??? ??']],
      towns: [{ code: 'JANGAN', regions: [25000] }],
    })
    expect(zones).toEqual([
      { region: 25000, rx: 168, rz: 97, name: 'Jangan', area: 'Town_Jangan', continent: 'CHINA', town: 'JANGAN' },
      { region: 24478, rx: 158, rz: 95, name: 'North-Tiger Mt.', area: null, continent: 'CHINA' },
      { region: 26538, rx: 170, rz: 103, name: '', area: null, continent: null },
    ])
    expect(checkZones(zones)).toEqual([])
    expect(checkZones([{ ...zones[0]!, region: 1 }, { ...zones[1]!, area: '??' }])).toHaveLength(2)
  })
  it('falls back to field 8 without a header', () => {
    expect(zoneNameIndex([row(25000, 'Jangan')]).get(25000)).toBe('Jangan')
  })
})

describe.skipIf(!hasConfig)('streamed conversion, 2 x 2 regions 167-168 x 96-97 (corpus)', () => {
  let dir: string
  let m: WorldManifest
  let nav: NavData

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sro-world-stream-'))
    const rect = { x0: 167, x1: 168, z0: 96, z1: 97 }
    ;({ manifest: m } = await convertWorld({
      name: 'stream-test', regions: regionRange(rect.x0, rect.x1, rect.z0, rect.z1), origin: { x: 168, z: 97 }, outDir: dir,
      objects: false, validate: false, spawnTeleport: 'GATE_CH', playable: rect, stream: true, places: true, displayName: 'Jangan',
    }))
    nav = decodeNavData(new Uint8Array(readFileSync(join(dir, m.nav!.file))))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('validates, with bounds inside the regions', () => {
    expect(validateWorldManifest(m)).toEqual([])
    expect(validateWorldManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))).toEqual([])
    expect(m.bounds).toEqual({ minX: -192, maxX: 192, minZ: -192, maxZ: 192 })
    expect(m.displayName).toBe('Jangan')
    expect(m.stream).toMatchObject({ playable: { x0: 167, x1: 168, z0: 96, z1: 97 }, loadRadiusM: 400, unloadRadiusM: 560 })
    // A playable region outside the export and a bounds rectangle past it are refused.
    expect(validateWorldManifest({ ...m, bounds: { ...m.bounds!, maxX: 400 } })).toContain('bounds: not inside the union of the regions')
    expect(validateWorldManifest({ ...m, stream: { ...m.stream!, playable: { x0: 167, x1: 169, z0: 96, z1: 97 } } }).join()).toContain('169,96')
    expect(validateWorldManifest({ ...m, stream: { ...m.stream!, navObjects: { file: '../x.bin', bytes: 1 } } }).join()).toContain('stream.navObjects')
  })

  it('writes one nav chunk per region, bit-equal to nav.bin\'s region', () => {
    expect(nav.regions.map(r => r.id).sort()).toEqual(m.regions.map(r => r.id).sort())
    const files = readdirSync(join(dir, m.stream!.navRegions.dir)).sort()
    expect(files).toEqual(nav.regions.map(r => navRegionFile(r.id).split('/')[1]).sort())
    let total = 0
    for (const r of nav.regions) {
      const bytes = new Uint8Array(readFileSync(join(dir, navRegionFile(r.id))))
      total += bytes.byteLength
      expect(navRegionFile(r.id)).toBe(`${m.stream!.navRegions.dir}/${r.rx}_${r.rz}.bin`)
      const chunk = decodeNavData(bytes)
      expect(chunk.models).toEqual([])
      expect(chunk.instances).toEqual([])
      expect(chunk.regions).toEqual([r])
      expect(Buffer.compare(bytes, encodeNavData({ version: nav.version, regions: [r], models: [], instances: [] }))).toBe(0)
    }
    expect(m.stream!.navRegions.bytes).toBe(total)
  })

  it('writes nav-objects.bin with every model and instance of nav.bin, in order', () => {
    const bytes = new Uint8Array(readFileSync(join(dir, m.stream!.navObjects.file)))
    expect(m.stream!.navObjects.bytes).toBe(bytes.byteLength)
    const objects = decodeNavData(bytes)
    expect(objects.regions).toEqual([])
    expect(objects.models).toEqual(nav.models)
    expect(objects.instances).toEqual(nav.instances)
    expect(objects.instances.length).toBe(m.nav!.instances)
    // Objects + chunks together are nav.bin again.
    const joined = { version: nav.version, regions: nav.regions, models: objects.models, instances: objects.instances }
    expect(Buffer.compare(encodeNavData(joined), readFileSync(join(dir, m.nav!.file)))).toBe(0)
  })

  it('stitches a 128 x 128 world map', () => {
    expect(m.stream!.worldMap).toEqual({ file: 'worldmap.png', pxPerRegion: 64, x0: 167, x1: 168, z0: 96, z1: 97, width: 128, height: 128 })
    expect(pngSize(new Uint8Array(readFileSync(join(dir, 'worldmap.png'))))).toEqual({ width: 128, height: 128 })
  })

  it('writes places on the navigation, in the spawn\'s component', () => {
    const g = new NavGltf(new NavWorld(nav), m.space.originRegion)
    expect(m.places!.length).toBeGreaterThan(0)
    expect(m.places!.map(p => p.name)).toContain('jangan')
    const spawn = g.locate(m.spawn!.x, m.spawn!.z, m.spawn!.y)!
    for (const p of m.places!) {
      const at = g.locate(p.x, p.z, p.y)
      expect(at, p.name).not.toBeNull()
      expect(Math.abs(at!.y - p.y)).toBeLessThan(0.01)
      expect(g.sameComponent(at!, spawn), p.name).toBe(true)
      expect(p.x >= m.bounds!.minX && p.x <= m.bounds!.maxX && p.z >= m.bounds!.minZ && p.z <= m.bounds!.maxZ).toBe(true)
    }
  })

  it('reads the zone names from the client (25000 Jangan, 24478 North-Tiger Mt.)', () => {
    const t = loadTextdataTable('textzonename.txt', textdataReader(openArchive('Media')))
    const names = zoneNameIndex(t.rows.map(r => r.cells), t.header)
    expect(names.get(25000)).toBe('Jangan')
    expect(names.get(0x5f9e)).toBe('North-Tiger Mt.')
  })
})

describe.skipIf(!hasFields)('work/out/world/jangan-fields (the full export)', () => {
  let m: WorldManifest
  let objects: NavData
  beforeAll(() => {
    m = JSON.parse(readFileSync(join(FIELDS, 'manifest.json'), 'utf8')) as WorldManifest
    objects = decodeNavData(new Uint8Array(readFileSync(join(FIELDS, m.stream!.navObjects.file))))
  })

  it('has the fact-checked numbers and the FIELDS §3.9 blocks', () => {
    const p = WORLD_PRESETS['jangan-fields']!
    expect(validateWorldManifest(m)).toEqual([])
    expect(m.name).toBe('jangan-fields')
    expect(m.space.originRegion).toEqual({ x: 168, z: 97, id: 25000 })
    // the coast (docs/COAST.md, CST-C) adds synthetic sea and beach regions beyond the retail ones
    expect(m.regions.filter(r => !r.synthetic)).toHaveLength(307)
    if (m.coast) expect(m.regions.filter(r => r.synthetic).length).toBeGreaterThan(50)
    else expect(m.regions).toHaveLength(307)
    expect(m.report.regionsSkipped.length).toBeLessThanOrEqual(8)
    // X2: coast phase 2 drops 48 object navmeshes outside the bounds on moved ground (coast/navgen.ts; 2,281 at X1).
    // Kept World Editor edits add instances under editor uids and may drop retail ones: the retail part stays 2,233
    // (exact while no edit drops a placement), and every editor instance belongs to an added placement.
    expect(m.nav!.instances).toBe(objects.instances.length)
    const retail = m.placements.filter(x => !editorUid(x.uid)).length
    const dropped = PRISTINE.placements - retail
    expect(dropped).toBeGreaterThanOrEqual(0)
    const added = new Set(m.placements.filter(x => editorUid(x.uid)).map(x => `${x.region}:${x.uid}`))
    const editNav = objects.instances.filter(i => editorUid((i.id >>> 0) & 0xffff))
    for (const i of editNav) expect(added.has(`${(i.id >>> 0) >>> 16}:${(i.id >>> 0) & 0xffff}`), `nav instance ${i.id >>> 0}`).toBe(true)
    const retailNav = m.nav!.instances - editNav.length
    if (dropped === 0) expect(retailNav).toBe(PRISTINE.navInstances)
    else {
      expect(retailNav).toBeGreaterThanOrEqual(PRISTINE.navInstances - dropped)
      expect(retailNav).toBeLessThanOrEqual(PRISTINE.navInstances)
    }
    expect(m.nav!.regions).toHaveLength(307)
    expect(m.bounds).toEqual({ minX: -2304, maxX: 1344, minZ: -1152, maxZ: 1344 })
    expect(m.bounds).toEqual(rectBounds(p.playable!, p.centre))
    expect(m.stream!.playable).toEqual({ x0: 156, x1: 174, z0: 90, z1: 102 })
    // with the coast the world map covers the island and a region of sea round it, in the coast domain (docs/COAST.md §11,
    // CST-M): the drowned Western China side (§4.1) is not on it
    const wm = m.coast ? { x0: 152, x1: 176, z0: 86, z1: 105, width: 1600, height: 1280 } : { x0: 155, x1: 175, z0: 89, z1: 103, width: 1344, height: 960 }
    expect(m.stream!.worldMap).toMatchObject({ pxPerRegion: 64, ...wm })
    expect(pngSize(new Uint8Array(readFileSync(join(FIELDS, m.stream!.worldMap!.file))))).toEqual({ width: wm.width, height: wm.height })
    expect(m.spawn).toMatchObject({ x: 96.9, z: -136.9 })
    const names = m.places!.map(x => x.name)
    for (const n of ['jangan', 'grassland', 'north-tiger-mt', 'south-tiger-mt', 'bandits-mountain-stronghold', 'chinese-tomb']) expect(names).toContain(n)
  })

  it('has no Western China or Donwhang left: no place, no placement in the drowned area, which is open sea (COAST §4.1)', () => {
    if (!m.coast) return
    const cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
    expect(cfg.drown).toBeDefined()
    expect(m.places!.map(x => x.name).filter(n => /western-china|donwhang|okmungwan|earth-ghost/.test(n))).toEqual([])
    const o = m.space.originRegion
    const regionOf = (x: number, z: number) => ({ x: o.x + Math.floor(x / 192), z: o.z + Math.floor(-z / 192) })
    const inDrowned = m.placements.filter(p => {
      const r = regionOf(p.position[0], p.position[2])
      return configDrowns(cfg, r.x, r.z)
    })
    expect(inDrowned.map(p => `${p.region}:${p.uid} ${p.source}`)).toEqual([])
    // the report lists the drowned regions: every West_China region of the old export among them (Donwhang town 153,102)
    const drowned = new Set((m.report.coast as { drown?: { regions: string[] } } | undefined)?.drown?.regions ?? [])
    for (const r of ['153,102', '153,103', '156,101', '158,99', '160,102', '161,100']) expect(drowned.has(r), r).toBe(true)
    // and no retail water block is left in a region the config drowns: the ocean draws the sea there (a soft border
    // region keeps the blocks over Jangan's own shore)
    for (const r of m.regions) {
      if (!drowned.has(`${r.x},${r.z}`) || !configDrowns(cfg, r.x, r.z)) continue
      expect(r.blocks.filter(b => b.water).length, `${r.x},${r.z}`).toBe(0)
    }
  })

  it('has every nav chunk and nav-objects.bin on disk with the stated sizes', () => {
    let total = 0
    for (const id of m.nav!.regions) total += statSync(join(FIELDS, navRegionFile(id))).size
    expect(total).toBe(m.stream!.navRegions.bytes)
    expect(statSync(join(FIELDS, m.stream!.navObjects.file)).size).toBe(m.stream!.navObjects.bytes)
    expect(objects.instances).toHaveLength(m.nav!.instances)
  })
})
