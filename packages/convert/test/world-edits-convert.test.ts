/**
 * WE-D (docs/WAVE_PLAN8.md §6.2, D26 G7; docs/WORLD_EDITOR.md §3.1, §3.6, §6.2): the layer folder read by the
 * converter (sharp, as the editor API writes it), validated all-or-nothing, and a real convert of region 168,97 with a
 * layer set: the edited terrain, paint and water, a moved tree and a planted one, a grass mask, a light point and a
 * sound zone land in the export; the touched lightmap and minimap are redrawn; two converts give the same bytes
 * (skips without sro.config.json).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import {
  emptyGrassLayer, emptyHeightLayer, emptyPaintLayer, emptyWalkLayer, encodeGrassLayer, encodeHeightLayer, encodePaintLayer,
  encodeWalkLayer, paintWord, regionIdOf, WE_WALK, WORLD_EDITS_FORMAT, WORLD_EDITS_PLACEMENTS_FORMAT,
} from '../../shared/src/world-edits/index.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { convertWorld } from '../src/world/convert-world.ts'
import { decodeTerrainBin } from '../src/world/format.ts'
import { createWorldEdits, readWorldEditsLayers, validateWorldEdits } from '../src/world/edits/index.ts'
import { SOUND_ZONES_FILE } from '../src/world/edits/layers.ts'
import { validateWorldManifest, type WorldManifest } from '../src/world/manifest.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const tmp = mkdtempSync(join(tmpdir(), 'sro-wed-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const R = { x: 168, z: 97 }
const RID = regionIdOf(R.x, R.z)

async function writeLayers(dir: string, opts: { placements?: object; base?: string; tile?: number } = {}): Promise<void> {
  for (const k of ['height', 'paint', 'grass']) mkdirSync(join(dir, k), { recursive: true })
  // a 6 m mound around (100 m east, 100 m north), on the 1/256 m grid
  const h = emptyHeightLayer()
  for (let gz = 40; gz <= 60; gz++) for (let gx = 40; gx <= 60; gx++) {
    const d = Math.max(0, 6 - Math.hypot(gx - 50, gz - 50) * 0.6)
    if (d > 0) {
      h.mask[gz * 97 + gx] = 1
      h.delta[gz * 97 + gx] = Math.round(d * 256) / 256
    }
  }
  await sharp(encodeHeightLayer(h), { raw: { width: 97, height: 97, channels: 2 } }).toColourspace('grey16').png().toFile(join(dir, 'height', `${R.x}_${R.z}.png`))
  const p = emptyPaintLayer()
  for (let gz = 10; gz <= 20; gz++) for (let gx = 10; gx <= 20; gx++) {
    p.mask[gz * 97 + gx] = 1
    p.words[gz * 97 + gx] = paintWord(opts.tile ?? 1, 0)
  }
  await sharp(Buffer.from(encodePaintLayer(p)), { raw: { width: 97, height: 97, channels: 4 } }).png().toFile(join(dir, 'paint', `${R.x}_${R.z}.png`))
  const g = emptyGrassLayer()
  for (let i = 0; i < 400; i++) {
    g.mask[i] = 1
    g.density[i] = 40
  }
  await sharp(Buffer.from(encodeGrassLayer(g)), { raw: { width: 192, height: 192, channels: 4 } }).png().toFile(join(dir, 'grass', `${R.x}_${R.z}.png`))
  const json = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v, null, 1))
  if (opts.base) json('edits.json', { format: WORLD_EDITS_FORMAT, version: 1, world: 'jangan-fields', regions: [{ x: R.x, z: R.z, base: opts.base, layers: ['height', 'paint', 'grass'] }] })
  if (opts.placements) json('placements.json', opts.placements)
  json('water.json', [{ id: 'w1', region: RID, blocks: [[0, 5]], heightM: 3 }])
  json('lights.json', [{ id: 'l1', x: 60, y: 4, z: -60, kind: 'lantern', colour: [1, 0.7, 0.4], intensity: 1, radiusM: 8 }])
  json('zones.json', [{ id: 'z1', name: 'Brook', shape: { circle: { x: 50, z: -50, r: 20 } }, sound: 'amb_water', gainDb: -6, fadeM: 10, when: 'always' }])
  writeFileSync(join(dir, 'palette.json'), '[]')
}

describe('reading the layer folder', () => {
  it('reads sharp-written PNGs exactly and validates all-or-nothing', async () => {
    const dir = join(tmp, 'read')
    await writeLayers(dir, { placements: { format: WORLD_EDITS_PLACEMENTS_FORMAT, version: 1, world: 'jangan-fields', move: [], drop: [], add: [] } })
    const r = await readWorldEditsLayers(dir, { world: 'jangan-fields', origin: R, regions: [R] })
    expect(r.problems).toEqual([])
    expect(r.layers.height.get(RID)!.delta[50 * 97 + 50]).toBe(6)
    expect(r.layers.paint.get(RID)!.words[15 * 97 + 15]).toBe(paintWord(1, 0))
    expect(r.layers.grass.get(RID)!.density[0]).toBe(40)
    expect(r.layers.lights).toHaveLength(1)
    // a one-channel walk PNG reads as one code per tile, not three (sharp's default raw output is RGB)
    const walk = emptyWalkLayer()
    walk.codes[10 * 96 + 12] = WE_WALK.open
    walk.codes[70 * 96 + 5] = WE_WALK.closed
    mkdirSync(join(dir, 'walk'), { recursive: true })
    await sharp(Buffer.from(encodeWalkLayer(walk)), { raw: { width: 96, height: 96, channels: 1 } }).toColourspace('b-w').png().toFile(join(dir, 'walk', `${R.x}_${R.z}.png`))
    expect((await sharp(join(dir, 'walk', `${R.x}_${R.z}.png`)).metadata()).channels).toBe(1)
    const rw = await readWorldEditsLayers(dir, { world: 'jangan-fields', origin: R, regions: [R] })
    expect(rw.problems).toEqual([])
    expect(Array.from(rw.layers.walk.get(RID)!.codes)).toEqual(Array.from(walk.codes))
    rmSync(join(dir, 'walk'), { recursive: true })
    // the staging export reads its world's layers; another world's are refused
    expect((await readWorldEditsLayers(dir, { world: 'jangan-fields-edit' })).problems).toEqual([])
    expect((await readWorldEditsLayers(dir, { world: 'other' })).problems.join()).toContain("expected 'other'")
    expect((await validateWorldEdits(dir)).ok).toBe(false) // the folder's name is not the world's
    // a layer outside the export, or one broken file: nothing is applied
    const warnings: string[] = []
    const run = await createWorldEdits({ dir, world: 'jangan-fields', outDir: join(tmp, 'o1'), origin: R, regions: [{ x: 169, z: 97 }], warnings, log: () => {} })
    expect(run).toBeNull()
    expect(warnings.join()).toContain('nothing applied')
    writeFileSync(join(dir, 'water.json'), '{ broken')
    expect((await readWorldEditsLayers(dir, { world: 'jangan-fields' })).problems.join()).toContain('water.json')
  })
})

/** Every file under `dir` (relative path -> bytes). */
function files(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      if (statSync(f).isDirectory()) walk(f)
      else out.set(relative(dir, f).split('\\').join('/'), readFileSync(f))
    }
  }
  walk(dir)
  return out
}

/** The manifest without its run-dependent fields (time, creation date, and the manifest's own size, which holds them). */
function stable(m: WorldManifest): unknown {
  const c = JSON.parse(JSON.stringify(m)) as WorldManifest
  c.createdAt = ''
  c.report.timeMs = { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0 } as WorldManifest['report']['timeMs']
  c.report.sizes.totalBytes = 0
  delete c.report.sizes.byCategory.manifest
  return c
}

describe.skipIf(!hasConfig)('convertWorld with a layer set (region 168,97)', () => {
  const base = { regions: [R], origin: R, objects: true, navmesh: true, passes: { grass: null } }
  let plain: WorldManifest

  it('applies the layers, re-bakes the touched lightmap and minimap, and two converts give the same bytes', async () => {
    plain = (await convertWorld({ ...base, name: 'jangan-fields', outDir: join(tmp, 'plain') })).manifest
    const before = files(join(tmp, 'plain'))
    // a tree of the region to move, and its source to plant a second one
    const trees = plain.placements.filter(p => p.region === RID && /\\tree\\/i.test(p.source) && p.uid < 0xe000)
    expect(trees.length).toBeGreaterThan(1)
    const t = trees[0]!
    const heights = decodeTerrainBin(new Uint8Array(before.get(`terrain/${R.x}_${R.z}.bin`)!)).heights
    const baseHash = createHash('sha256').update(new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength)).digest('hex')
    const placements = {
      format: WORLD_EDITS_PLACEMENTS_FORMAT, version: 1, world: 'jangan-fields', drop: [],
      move: [{ region: RID, uid: t.uid, source: t.source, from: { position: t.position, yaw: t.yaw }, to: { position: [150, t.position[1], -150], yaw: 0.4 } }],
      add: [{ id: 'ed-1', source: t.source, position: [30, t.position[1], -170], yaw: 1, scale: 1.1 }],
    }
    const dir = join(tmp, 'layers')
    await writeLayers(dir, { placements, base: baseHash, tile: plain.regions[0]!.terrain.tileIds[0] })
    const a = await convertWorld({ ...base, name: 'jangan-fields', outDir: join(tmp, 'a'), edits: dir })
    const b = await convertWorld({ ...base, name: 'jangan-fields', outDir: join(tmp, 'b'), edits: dir })
    expect(validateWorldManifest(a.manifest)).toEqual([])
    const fa = files(join(tmp, 'a'))
    const fb = files(join(tmp, 'b'))
    expect([...fa.keys()].sort()).toEqual([...fb.keys()].sort())
    for (const [k, v] of fa) if (k !== 'manifest.json') expect(fb.get(k)!.equals(v), k).toBe(true)
    expect(stable(a.manifest)).toEqual(stable(b.manifest))
    expect(a.manifest.warnings.filter(w => /ground under the edit changed|nothing applied|edits: /.test(w))).toEqual([])

    const region = a.manifest.regions.find(r => r.id === RID)!
    // terrain: the mound and the water
    const ha = decodeTerrainBin(new Uint8Array(fa.get(`terrain/${R.x}_${R.z}.bin`)!)).heights
    expect(ha[50 * 97 + 50]! - heights[50 * 97 + 50]!).toBeCloseTo(6, 4)
    expect(ha[0]).toBe(heights[0])
    expect(region.blocks.find(bl => bl.bx === 0 && bl.bz === 5)!.water).toMatchObject({ kind: 'water', heightM: 3 })
    // the moved tree keeps its key at the new spot; the planted one has an editor uid and its scale
    const moved = a.manifest.placements.find(p => p.region === RID && p.uid === t.uid)!
    expect(moved.position).toEqual([150, t.position[1], -150])
    expect(a.manifest.placements.find(p => p.region === RID && p.uid === 0xe000)).toMatchObject({ source: t.source, scale: 1.1 })
    // lightmap and minimap redrawn; grass mask, light point and zones written
    expect(fa.get(region.lightmap!.file)!.equals(before.get(region.lightmap!.file)!)).toBe(false)
    expect(fa.get(region.minimap!)!.equals(before.get(region.minimap!)!)).toBe(false)
    expect(region.grassMask).toBe(`grass/${R.x}_${R.z}.png`)
    expect(fa.has(region.grassMask!)).toBe(true)
    expect(region.lightPoints).toBe(1)
    expect(JSON.parse(fa.get('ambient.json')!.toString()).points).toEqual([
      { id: 'l1', x: 60, y: 4, z: -60, kind: 'lantern', colour: [1, 0.7, 0.4], intensity: 1, radiusM: 8 },
    ])
    expect(JSON.parse(fa.get(SOUND_ZONES_FILE)!.toString()).zones[0].id).toBe('z1')
    const rep = a.manifest.report.edits as unknown as { lightmaps: { rebaked: number }; minimaps: number; nav?: { problems: string[] }; bases: Record<string, string> }
    expect(rep.lightmaps.rebaked).toBeGreaterThan(0)
    expect(rep.minimaps).toBeGreaterThan(0)
    // edits.json's base = the SHA-256 of the region's exported heights (terrain bin, float32) before its first edit
    expect(rep.bases[`${R.x}_${R.z}`]).toBe(baseHash)
    // the nav step (WE-N's nav edit, wired here) and the pass agree on the moved and planted trees' footprints
    expect(rep.nav?.problems).toEqual([])
    expect(a.manifest.report.edits!.footprintProblems).toBe(0)
    expect(before.has(SOUND_ZONES_FILE)).toBe(false)
  }, 600_000)
})
