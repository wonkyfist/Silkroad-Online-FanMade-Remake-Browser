/**
 * WE-I (docs/WAVE_PLAN8.md §6.2, G7; docs/WORLD_EDITOR.md §6.2 step 2, F14, F17, D53): the incremental world convert.
 * - the work set: `--only` parsing, the 1-ring inside the export;
 * - the staging export: links, temp + rename writes never touch the live file, unchanged bytes keep the link, a write
 *   through a link is an error, the changed / new / removed lists;
 * - the coast snapshot: typed arrays and .nvm diffs round-trip; the live warnings are attributed to their steps;
 * - on the retail archives (skips without sro.config.json), a small streamed world: the incremental convert of an edit
 *   (every hook of the contract: terrain, heights across the ring, navigation, a moved and an added placement, lightmap,
 *   minimap, extras, light points) gives the full convert's bytes for every file and its manifest (G7's comparison); an
 *   empty run changes only the manifest; a revert through the record gives the unedited export back.
 * The whole jangan-fields export (the coast run and its snapshot replay) is checked at X2 (work/tmp/we-i/exp-jf.ts).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NvmFile } from '@sro/formats'
import { REPO_ROOT } from '../src/node-io.ts'
import {
  applyNvmDiff, comparableManifest, convertRegions, diffNvm, encodeCoastSnapshot, listFiles, parseCoastSnapshot, parseOnly, ringOf,
  Staging, warningSource, COAST_SNAPSHOT_FORMAT, COAST_SNAPSHOT_VERSION, type CoastSnapshot,
} from '../src/tools/convert-region.ts'
import { convertWorld, regionRange, type WorldPreset } from '../src/world/convert-world.ts'
import type { WorldEditsRun } from '../src/world/edits-hook.ts'
import { decodeTerrainBin } from '../src/world/format.ts'
import type { WorldManifest } from '../src/world/manifest.ts'
import { EDITOR_UID_MIN } from '../src/world/uids.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const tmp = mkdtempSync(join(tmpdir(), 'sro-wei-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const id = (x: number, z: number) => (z << 8) | x

describe('the work set', () => {
  it('parses --only items and rings them inside the export', () => {
    expect(parseOnly(['171,97', '168-169,96-97;170,90'])).toEqual([
      { x: 171, z: 97 }, { x: 168, z: 96 }, { x: 169, z: 96 }, { x: 168, z: 97 }, { x: 169, z: 97 }, { x: 170, z: 90 },
    ])
    expect(() => parseOnly(['171'])).toThrow(/bad --regions/)
    const within = new Set([id(10, 10), id(11, 10), id(12, 10), id(10, 11), id(11, 11), id(12, 11)])
    expect([...ringOf(new Set([id(10, 10)]), within)].sort((a, b) => a - b)).toEqual([id(11, 10), id(10, 11), id(11, 11)].sort((a, b) => a - b))
    expect(ringOf(new Set(within), within).size).toBe(0)
  })

  it('attributes the live warnings to the steps it repeats', () => {
    expect(warningSource('region 171,97: 2 cell(s) exceed 8 layers')).toBe(id(171, 97))
    expect(warningSource('97/171.t: missing (render the region unlit / white lightmap)')).toBe(id(171, 97))
    expect(warningSource('minimap/171x97.ddj: bad')).toBe(id(171, 97))
    expect(warningSource('places: x: no open terrain')).toBe('regen')
    expect(warningSource('nav: object 12: no navmesh')).toBe('regen')
    expect(warningSource('coast check: S1 does not reach')).toBe('regen')
    expect(warningSource('87/154.o2: missing (no objects)')).toBe('keep')
    expect(warningSource('model res\\a.bsr: failed')).toBe('keep')
  })
})

describe('the staging export', () => {
  const live = join(tmp, 'live')
  const stage = join(tmp, 'stage')
  beforeAll(() => {
    mkdirSync(join(live, 'terrain'), { recursive: true })
    mkdirSync(join(live, 'coast'), { recursive: true })
    writeFileSync(join(live, 'terrain', 'a.bin'), 'aaaa')
    writeFileSync(join(live, 'terrain', 'b.bin'), 'bbbb')
    writeFileSync(join(live, 'town.json'), '{}')
    writeFileSync(join(live, 'coast', 'field.png'), 'field')
  })

  it('links the live files, writes by temp + rename, keeps links for equal bytes, lists changed, new and removed files', () => {
    const s = new Staging(live, stage)
    s.init()
    expect(listFiles(stage)).toEqual(['terrain/a.bin', 'terrain/b.bin', 'town.json'])
    s.put('terrain/a.bin', 'AAAA')
    expect(readFileSync(join(live, 'terrain', 'a.bin'), 'utf8')).toBe('aaaa')
    s.emit('terrain/b.bin', 'bbbb')
    expect(s.written.has('terrain/b.bin')).toBe(false)
    s.emit('terrain/c.bin', 'cccc')
    s.remove('town.json')
    const r = s.finish()
    expect(r).toEqual({ changed: ['terrain/a.bin', 'terrain/c.bin'], removed: ['town.json'] })
    // the coast folder is linked in at the end (nothing rewrote it)
    expect(readFileSync(join(stage, 'coast', 'field.png'), 'utf8')).toBe('field')
    expect(existsSync(join(stage, 'town.json'))).toBe(false)
  })

  it('refuses the live export as its staging folder, and a write through a link is an error', () => {
    expect(() => new Staging(live, live).init()).toThrow(/is the live export/)
    const s = new Staging(live, stage)
    s.init()
    writeFileSync(join(stage, 'terrain', 'b.bin'), 'through the link')
    expect(readFileSync(join(live, 'terrain', 'b.bin'), 'utf8')).toBe('through the link')
    expect(() => s.finish()).toThrow(/changed while hard-linked/)
    writeFileSync(join(live, 'terrain', 'b.bin'), 'bbbb')
  })
})

describe('the coast snapshot', () => {
  const nvm = (): NvmFile => ({
    signature: 'JMXVNVM 1000', objects: [], cells: [{ minX: 0, minZ: 0, maxX: 1920, maxZ: 1920, objects: [] } as never], openCellCount: 1,
    globalEdges: [], internalEdges: [], tileRecordSize: 8, tileCells: new Int32Array(96 * 96), tileFlags: new Uint16Array(96 * 96),
    heights: new Float32Array(97 * 97).fill(12.5),
  })

  it('keeps only the .nvm keys the coast changed, and they round-trip with their typed arrays', () => {
    const retail = nvm()
    const edited = { ...retail, tileCells: Int32Array.from(retail.tileCells).fill(1, 0, 10), heights: Float32Array.from(retail.heights).fill(-3, 5, 9) }
    const diff = diffNvm(edited, retail)
    expect(Object.keys(diff).sort()).toEqual(['heights', 'tileCells'])
    const snap: CoastSnapshot = {
      format: COAST_SNAPSHOT_FORMAT, version: COAST_SNAPSHOT_VERSION, key: 'k', name: 'w', synthetic: [1], changed: [2], dropRedrawn: [],
      nav: { [id(170, 90)]: diff }, c9: { drop: [{ region: 1, uid: 2 }], resnap: [], add: [] }, c9Warnings: ['coast: x'], manifestCoast: null,
      report: { nav: { opened: 3 } }, createWarnings: [], typeNames: [[7, 'Sand']], places: [], seaLevelM: 5,
    }
    const back = parseCoastSnapshot(encodeCoastSnapshot(snap))
    const restored = applyNvmDiff(retail, back.nav[id(170, 90)]!)
    expect(restored.tileCells).toBeInstanceOf(Int32Array)
    expect(restored.heights).toBeInstanceOf(Float32Array)
    expect([...restored.tileCells]).toEqual([...edited.tileCells])
    expect([...restored.heights]).toEqual([...edited.heights])
    expect(restored.tileFlags).toBe(retail.tileFlags)
    expect(back.c9).toEqual(snap.c9)
    expect(() => parseCoastSnapshot('{"format":"x"}')).toThrow(/expected sro-coast-snapshot/)
  })
})

/** An edit of region (rx, rz) through every hook (a plateau near its west border changes the ring's normals). */
function syntheticEdits(rx: number, rz: number): WorldEditsRun {
  const rid = id(rx, rz)
  const inPatch = (gx: number, gz: number) => gx >= 1 && gx < 13 && gz >= 40 && gz < 52
  const PLATEAU = 640
  return {
    touched: new Set([rid]),
    terrain(x, z, base) {
      if (!base || x !== rx || z !== rz) return base
      const heights = Float32Array.from(base.grid.heights)
      for (let gz = 0; gz < 97; gz++) for (let gx = 0; gx < 97; gx++) if (inPatch(gx, gz)) heights[gz * 97 + gx] = PLATEAU
      return { ...base, grid: { ...base.grid, heights } }
    },
    height: (ggx, ggz) => (inPatch(ggx - rx * 96, ggz - rz * 96) ? PLATEAU : undefined),
    navEdit(regionId, nvm) {
      if (regionId !== rid || nvm.cells.length <= nvm.openCellCount) return null
      const tileCells = Int32Array.from(nvm.tileCells)
      let n = 0
      for (let t = 0; t < tileCells.length && n < 40; t++) if (tileCells[t]! >= 0 && tileCells[t]! < nvm.openCellCount) (tileCells[t] = nvm.openCellCount, n++)
      // an object footprint moved 5 m east: nav-objects.bin changes
      const objects = nvm.objects.map((o, i) => (i === 0 ? { ...o, position: [o.position[0] + 50, o.position[1], o.position[2]] as typeof o.position } : o))
      return { ...nvm, tileCells, objects }
    },
    pass(ctx) {
      const p = ctx.placements.find(q => q.region === rid && q.uid < EDITOR_UID_MIN)
      if (!p) return { drop: [], resnap: [], add: [] }
      return {
        drop: [{ region: rid, uid: p.uid }], resnap: [],
        add: [{ ...p, position: [p.position[0] + 3, p.position[1], p.position[2]] }, { ...p, uid: EDITOR_UID_MIN + 1, position: [p.position[0] - 4, p.position[1], p.position[2] + 2] }],
      }
    },
    lightmap(_r, cur) {
      const rgba = cur.rgba.slice()
      for (let y = 100; y < 140; y++) for (let x = 100; x < 140; x++) rgba[(y * cur.width + x) * 4] = 40
      return { width: cur.width, height: cur.height, rgba }
    },
    minimap(_r, cur) {
      if (!cur) return null
      const rgba = cur.rgba.slice()
      for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) rgba[(y * cur.width + x) * 4 + 1] = 255
      return { width: cur.width, height: cur.height, rgba }
    },
    regionExtras: r => (r.id === rid ? { lightPoints: 2 } : null),
    ambientPoints: () => [{ x: 1, y: 2, z: 3, radius: 8, colour: [1, 0.8, 0.6] }],
    report: () => ({ touchedRegions: 1 }),
  }
}

/**
 * Height edits in two neighbours on their shared border (171,98 | 172,98), with the real edits' load-order rule: height()
 * knows a region's edited lattice only once its terrain() ran (edits/index.ts afterFu). A fresh run per convert.
 */
function borderEdits(): WorldEditsRun {
  const after = new Map<number, Float32Array>()
  const inBand = (ggx: number) => ggx >= 172 * 96 - 3 && ggx <= 172 * 96 + 3
  const inRows = (ggz: number) => ggz > 98 * 96 && ggz < 99 * 96
  return {
    touched: new Set([id(171, 98), id(172, 98)]),
    terrain(x, z, base) {
      if (!base || z !== 98 || (x !== 171 && x !== 172)) return base
      const heights = Float32Array.from(base.grid.heights)
      for (let gz = 0; gz < 97; gz++) for (let gx = 0; gx < 97; gx++) if (inRows(z * 96 + gz) && inBand(x * 96 + gx)) heights[gz * 97 + gx]! -= 300
      after.set(id(x, z), heights)
      return { ...base, grid: { ...base.grid, heights } }
    },
    height(ggx, ggz) {
      if (!inBand(ggx) || !inRows(ggz)) return undefined
      for (const rx of [Math.floor(ggx / 96), Math.floor((ggx - 1) / 96)]) {
        const h = after.get(id(rx, 98))
        if (h) return h[(ggz - 98 * 96) * 97 + (ggx - rx * 96)]
      }
      return undefined // its region did not load yet: the caller falls back to the unedited ground
    },
    pass: () => ({ drop: [], resnap: [], add: [] }),
  }
}

/** Every file of `b` equals `a`'s (the manifest by G7's comparison); returns the differences. */
function differences(a: string, b: string): string[] {
  const out: string[] = []
  const fa = listFiles(a)
  const fb = listFiles(b)
  if (fa.join('\n') !== fb.join('\n')) out.push(`file lists differ: ${fa.filter(f => !fb.includes(f)).concat(fb.filter(f => !fa.includes(f))).join(', ')}`)
  for (const f of fa) {
    if (!fb.includes(f) || f === 'manifest.json') continue
    if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f)))) out.push(f)
  }
  const ma = comparableManifest(JSON.parse(readFileSync(join(a, 'manifest.json'), 'utf8')) as WorldManifest)
  const mb = comparableManifest(JSON.parse(readFileSync(join(b, 'manifest.json'), 'utf8')) as WorldManifest)
  if (JSON.stringify(ma, null, 1) !== JSON.stringify(mb, null, 1)) out.push('manifest.json')
  return out
}

describe.skipIf(!hasConfig)('convertRegions on the retail archives: incremental = full (G7)', () => {
  const root = join(tmp, 'world')
  const name = 'wei-test'
  const preset: WorldPreset = { x0: 171, x1: 172, z0: 98, z1: 99, centre: { x: 171, z: 98 }, stream: true }
  const full = {
    name, regions: regionRange(preset.x0, preset.x1, preset.z0, preset.z1), origin: preset.centre, objects: true, navmesh: true, validate: false,
    stream: true, log: () => {},
  }
  const prePassCache = join(root, 'cache', 'prepass.json')
  const record = join(root, 'cache', 'incremental.json')
  const base = { world: name, preset, prePassCache, snapshot: null, log: () => {} }
  beforeAll(async () => {
    await convertWorld({ ...full, outDir: join(root, 'live'), prePassCache })
    await convertWorld({ ...full, outDir: join(root, 'expect'), editsRun: syntheticEdits(171, 98) })
  }, 240_000)

  it('an edit through every hook gives the full convert\'s bytes', async () => {
    const r = await convertRegions({ ...base, only: [{ x: 171, z: 98 }], liveDir: join(root, 'live'), stagingDir: join(root, 'stage'), record, editsRun: syntheticEdits(171, 98) })
    expect(differences(join(root, 'expect'), join(root, 'stage'))).toEqual([])
    expect(r.coast).toBe('none')
    expect(r.drift).toEqual([])
    expect(r.regions.core).toEqual([id(171, 98)])
    expect(r.regions.ring).toEqual([id(172, 98), id(171, 99), id(172, 99)])
    expect(r.regions.nav).toEqual([id(171, 98)])
    expect(r.changed).toEqual(expect.arrayContaining([
      'ambient.json', 'manifest.json', 'minimap/171x98.png', 'nav-objects.bin', 'nav.bin', 'nav/171_98.bin', 'navmesh/171_98.bin',
      'terrain/171_98.bin', 'terrain/171_98_lightmap.png', 'worldmap.png',
    ]))
    // the live export is untouched, and the stage's unchanged files are links to it
    expect(differences(join(root, 'live'), join(root, 'expect')).length).toBeGreaterThan(5)
  }, 240_000)

  it('an empty run changes only the manifest, and its manifest is the live one (G7)', async () => {
    const r = await convertRegions({ ...base, only: [], liveDir: join(root, 'live'), stagingDir: join(root, 'stage-empty'), record: null, editsRun: null })
    expect(r.changed).toEqual(['manifest.json'])
    expect(differences(join(root, 'live'), join(root, 'stage-empty'))).toEqual([])
  }, 240_000)

  it('a revert after a publish gives the unedited export back (the record carries the published regions)', async () => {
    // "publish" the first run: its staging export becomes the live one (copied: the old live keeps its own files)
    const live2 = join(root, 'live2')
    cpSync(join(root, 'stage'), live2, { recursive: true })
    const r = await convertRegions({ ...base, only: [], liveDir: live2, stagingDir: join(root, 'stage2'), record, editsRun: null })
    expect(r.regions.core).toEqual([id(171, 98)])
    expect(differences(join(root, 'live'), join(root, 'stage2'))).toEqual([])
  }, 240_000)

  it('height edits on both sides of a border give the full convert\'s normals (the edited regions load first)', async () => {
    await convertWorld({ ...full, outDir: join(root, 'expect-border'), editsRun: borderEdits() })
    await convertRegions({ ...base, only: [], liveDir: join(root, 'live'), stagingDir: join(root, 'stage-border'), record: null, editsRun: borderEdits() })
    const file = (dir: string, x: number, z: number) => readFileSync(join(root, dir, 'terrain', `${x}_${z}.bin`))
    for (const [x, z] of [[171, 98], [172, 98], [171, 99], [172, 99]] as const) {
      expect(file('stage-border', x, z).equals(file('expect-border', x, z)), `terrain/${x}_${z}.bin`).toBe(true)
    }
    // the shared column's normals agree (the w9f invariant): 171_98 gx 96 == 172_98 gx 0
    const w = decodeTerrainBin(new Uint8Array(file('stage-border', 171, 98)))
    const e = decodeTerrainBin(new Uint8Array(file('stage-border', 172, 98)))
    for (let k = 0; k < 97; k++) {
      expect([...w.normals.subarray((k * 97 + 96) * 4, (k * 97 + 96) * 4 + 3)], `row ${k}`).toEqual([...e.normals.subarray(k * 97 * 4, k * 97 * 4 + 3)])
    }
  }, 240_000)

  it('refuses a region outside the export, a missing pre-pass cache and another export\'s cache', async () => {
    await expect(convertRegions({ ...base, only: [{ x: 160, z: 98 }], liveDir: join(root, 'live'), stagingDir: join(root, 'stage3'), record: null }))
      .rejects.toThrow(/not in the export/)
    await expect(convertRegions({ ...base, only: [], prePassCache: join(root, 'none.json'), liveDir: join(root, 'live'), stagingDir: join(root, 'stage3'), record: null }))
      .rejects.toThrow(/no pre-pass cache/)
    const other = join(root, 'cache', 'other.json')
    writeFileSync(other, readFileSync(prePassCache, 'utf8').replace(`"name":"${name}"`, '"name":"other"'))
    await expect(convertRegions({ ...base, only: [], prePassCache: other, liveDir: join(root, 'live'), stagingDir: join(root, 'stage3'), record: null }))
      .rejects.toThrow(/pre-pass cache: for 'other'/)
  }, 240_000)
})
