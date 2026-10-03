/**
 * CST-B: the coast's Blender round trip (docs/COAST.md §6, §3B.7, §12.2, §12.13; src/tools/coast-blender.ts and
 * tools/blender/*.py).
 * - the authored height layers: LA16 decodes exactly through sharp's grey16 path; a wrong format is refused;
 * - the validator on synthetic layers: a clean layer passes; an in-bounds edit, protected ground, a moved area border,
 *   a seam mismatch, a weighted edge with no neighbour file and a stale layer are rejected, naming the region file and
 *   the vertex; allowHeightPatches let an in-bounds edit through; the frozen rectangle is stream.playable;
 * - the protection mask (the frozen area, the 30 m line guard, the border ring, the fades);
 * - every path handed to Blender is absolute; the sessions' areas are disjoint, inside the coast domain, and name
 *   passes that exist;
 * - the bundle of the prototype area equals the one checked on 2026-09-29 byte for byte (until the export changes);
 * - with Blender (skipped when it is absent): an unsculpted area round-trips with no files; the scripted passes
 *   round-trip, never write under the mask or within 30 m outside the line, never move the area border, and are
 *   deterministic; the readback validates with 0 errors and matches the TypeScript twin; an in-bounds edit and a moved
 *   border in a .blend are rejected.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blenderVersion, relativePaths, runBlender } from '../src/blender.ts'
import { loadConfig, REPO_ROOT } from '../src/node-io.ts'
import { encodePng } from '../src/png.ts'
import {
  areaFromExport, areaLattice, authorLayers, BLENDER_TOOLS, buildBlend, buildRun, COAST_SESSIONS, decodeHeight, encodeLa16Png,
  GUARD, LA16, LINE_GUARD_M, mergeLayers, parseArea, passesRun, playableBlender, previewColors, protection, readBack, readbackRun,
  readHeightLayer, readHeightLayers, regionSha, regionWindow, renderRun, runPasses, UNWEIGHTED_TOLERANCE_M, validateHeightLayers,
  worldFrame, writeBundle, type AreaBase, type CoastArea, type CoastFrame, type HeightLayer, type RegionTruth,
} from '../src/tools/coast-blender.ts'
import { parseCoastConfig } from '../src/world/coast/config.ts'

const GRID = 97
const FRAME: CoastFrame = { originRegion: { x: 168, z: 97 }, playable: { x0: 160, x1: 165, z0: 89, z1: 95 } }
/** Two by two regions: the north row (z 89) inside the bounds, the south row outside (the line at z = 89). */
const AREA: CoastArea = { x0: 160, x1: 161, z0: 88, z1: 89 }
const SL = 5
const { nx: NX, nz: NZ } = areaLattice(AREA)
const LINE_J = 96

/** A lowered flank: 115 m on the line, falling at 0.6 (31 deg) to the sea, a little relief along x. */
function synthBase(): Float32Array {
  const h = new Float32Array(NX * NZ)
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const d = Math.max(0, (LINE_J - j) * 2)
      h[j * NX + i] = SL + Math.max(0, 110 - 0.6 * d) + 3 * Math.sin(i / 23) * Math.min(1, d / 60)
    }
  }
  return h
}

function synthArea(): AreaBase {
  const base = synthBase()
  const { mask, guard } = protection({ area: AREA, frame: FRAME })
  return { area: AREA, nx: NX, nz: NZ, base, tex: new Uint16Array(NX * NZ), mask, guard, colors: previewColors(base, NX, NZ, SL, undefined, guard) }
}

const truthOf = (b: AreaBase) => (x: number, z: number): RegionTruth | null =>
  x < AREA.x0 || x > AREA.x1 || z < AREA.z0 || z > AREA.z1 ? null : { base: regionWindow(b.base, AREA, x, z), guard: regionWindow(b.guard, AREA, x, z), sha: regionSha(b.base, AREA, x, z) }

/** A sculpt outside the bounds: a 4 m bump (50 m radius) 90 m south of the line, clear of the guard and the border. */
function bumped(base: Float32Array): Float32Array {
  const out = Float32Array.from(base)
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const r = Math.hypot(i - 96, j - (LINE_J - 45)) * 2
      out[j * NX + i] = base[j * NX + i]! + 4 * Math.max(0, 1 - (r / 50) ** 2) ** 2
    }
  }
  return out
}

const clone = (L: HeightLayer): HeightLayer => ({ ...L, L: Uint16Array.from(L.L), A: Uint16Array.from(L.A) })
const tmpRoot = mkdtempSync(join(tmpdir(), 'sro-coast-authored-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe('coast-authored: LA16 height layers', () => {
  it('an LA16 layer decodes exactly through sharp\'s grey16 path, with its sro-coast metadata', async () => {
    const L = new Uint16Array(GRID * GRID)
    const A = new Uint16Array(GRID * GRID)
    for (let k = 0; k < L.length; k++) {
      L[k] = (k * 7919) % 65536
      A[k] = (k * 104729) % 65536
    }
    const file = join(tmpRoot, '160_88.png')
    writeFileSync(file, await encodeLa16Png(L, A, { 'sro-coast': JSON.stringify({ base: 'abc', area: AREA }) }))
    const layer = await readHeightLayer(file)
    expect(layer.x).toBe(160)
    expect(layer.z).toBe(88)
    expect(Buffer.from(layer.L.buffer).equals(Buffer.from(L.buffer))).toBe(true)
    expect(Buffer.from(layer.A.buffer).equals(Buffer.from(A.buffer))).toBe(true)
    expect(layer.meta).toEqual({ base: 'abc', area: AREA })
    // the encoding: -100 .. +400 m in 7.6 mm steps
    expect(decodeHeight(0)).toBe(-100)
    expect(decodeHeight(65535)).toBeCloseTo(400, 9)
    expect(LA16.step * 1000).toBeCloseTo(7.63, 2)
  })

  it('refuses a layer that is not 97 x 97 LA16', async () => {
    const dir = join(tmpRoot, 'bad-format')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '160_88.png'), encodePng(GRID, GRID, new Uint8Array(GRID * GRID * 4)))
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    const r = await readHeightLayers(dir)
    expect(r.layers.size).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/160_88\.png: expected 97 x 97 16-bit grey \+ alpha \(LA16\)/)
  })
})

describe('coast-authored: the validator (docs/COAST.md §6.4)', () => {
  const b = synthArea()
  const layers = () => authorLayers(b.base, bumped(b.base), AREA, (x, z) => ({ base: regionSha(b.base, AREA, x, z), area: AREA }))
  const opts = { frame: FRAME, truth: truthOf(b), area: AREA, domain: { x: [150, 177] as [number, number], z: [86, 105] as [number, number] } }

  it('a sculpt outside the bounds validates with 0 errors, and merges back to the sculpted heights', () => {
    const ls = layers()
    expect([...ls.keys()].sort()).toEqual(['160_88', '161_88'])
    const v = validateHeightLayers(ls, opts)
    expect(v.errors).toEqual([])
    expect(v.weighted).toBeGreaterThan(1000)
    expect(v.quantMaxM).toBeLessThanOrEqual(UNWEIGHTED_TOLERANCE_M)
    const merged = mergeLayers(b.base, AREA, ls)
    const want = bumped(b.base)
    let worst = 0
    for (let k = 0; k < merged.length; k++) worst = Math.max(worst, Math.abs(merged[k]! - want[k]!))
    expect(worst).toBeLessThanOrEqual(LA16.step / 2 + 1e-4)
  })

  it('rejects an in-bounds edit, naming the region file and the vertex; allowHeightPatches let it through', () => {
    const ls = layers()
    const n = clone(ls.get('160_88')!)
    // region 160,89 lies inside the bounds: give it a weighted vertex at (gx 10, gz 40)
    const inside: HeightLayer = { x: 160, z: 89, L: new Uint16Array(GRID * GRID), A: new Uint16Array(GRID * GRID) }
    const win = regionWindow(b.base, AREA, 160, 89)
    for (let k = 0; k < win.length; k++) inside.L[k] = Math.round((win[k]! + 100) / LA16.step)
    const k = (96 - 40) * GRID + 10
    inside.A[k] = 65535
    inside.L[k] = inside.L[k]! + 400
    const set = new Map(ls)
    set.set('160_88', n)
    set.set('160_89', inside)
    const v = validateHeightLayers(set, opts)
    expect(v.errors.some(e => /^160_89\.png: vertex \(10,40\) at glTF \(-1516, 1456\) is inside the frozen playable area/.test(e))).toBe(true)
    const patched = validateHeightLayers(set, { ...opts, patches: [{ x: [160.0, 160.2], z: [89.3, 89.5] }] })
    expect(patched.errors.filter(e => /frozen/.test(e))).toEqual([])
  })

  it('reads the frozen rectangle from stream.playable, not the preset or manifest.bounds', () => {
    const work = join(tmpRoot, 'work')
    const world = join(work, 'out', 'world', 'jangan-fields')
    mkdirSync(world, { recursive: true })
    const cfg = { clientDir: 'x', pk2Key: 'x', workDir: work }
    expect(worldFrame('jangan-fields', cfg).frame.playable).toEqual({ x0: 156, x1: 174, z0: 90, z1: 102 })
    writeFileSync(join(world, 'manifest.json'), JSON.stringify({
      regions: [], bounds: { minX: -9999, maxX: 9999, minZ: -9999, maxZ: 9999 }, stream: { playable: { x0: 157, x1: 173, z0: 91, z1: 101 } },
    }))
    const f = worldFrame('jangan-fields', cfg).frame
    expect(f.playable).toEqual({ x0: 157, x1: 173, z0: 91, z1: 101 })
    expect(playableBlender(f)).toEqual({ minX: -2112, maxX: 1152, minY: -1152, maxY: 960 })
  })

  it('rejects weight on protected ground (the tomb keep, kept water, a land edge, the line guard)', () => {
    const guard = Uint8Array.from(b.guard)
    // mark a patch of region 160,88 as the tomb keep
    for (let j = 20; j < 50; j++) for (let i = 80; i < 110; i++) guard[j * NX + i] = guard[j * NX + i]! | GUARD.tombKeep
    const truth = (x: number, z: number) => {
      const t = truthOf(b)(x, z)
      return t && { ...t, guard: regionWindow(guard, AREA, x, z) }
    }
    const v = validateHeightLayers(layers(), { ...opts, truth })
    expect(v.errors.length).toBeGreaterThan(0)
    expect(v.errors[0]).toMatch(/^160_88\.png: vertex \(\d+,\d+\) at glTF .* is weighted on protected ground \(the tomb crest keep\)/)
  })

  it('rejects a moved area border, a missing neighbour file and a seam mismatch', () => {
    // the area border: the south edge of 160,88 (gz 0) is shared with 160,87, outside the area
    const ls = layers()
    const n = clone(ls.get('160_88')!)
    const k = 96 * GRID + 30
    n.A[k] = 65535
    const set = new Map(ls)
    set.set('160_88', n)
    const v = validateHeightLayers(set, opts)
    expect(v.errors.some(e => /^160_88\.png: vertex \(30,0\) .*the area border moved \(region 160,88\)/.test(e))).toBe(true)
    expect(v.errors.some(e => /^160_88\.png: weighted edge vertex \(30,0\), but 160_87\.png is missing/.test(e))).toBe(true)
    // a seam between the two files of the area: 160,88's east edge (gx 96) is 161,88's west edge (gx 0)
    const m = clone(ls.get('161_88')!)
    const e = (96 - 40) * GRID + 0
    m.L[e] = m.L[e]! + 3
    const seam = validateHeightLayers(new Map([...ls, ['161_88', m]]), opts)
    expect(seam.errors.some(s => /^seam: 160_88\.png \(96,40\) = \d+\/\d+ but 161_88\.png \(0,40\)/.test(s))).toBe(true)
  })

  it('flags a stale layer: unweighted vertices off the base, or a different recorded base', () => {
    const ls = layers()
    const moved = Float32Array.from(b.base, v => v + 0.02)
    const truth = (x: number, z: number) => {
      const t = truthOf(b)(x, z)
      return t && { ...t, base: regionWindow(moved, AREA, x, z), sha: regionSha(moved, AREA, x, z) }
    }
    const v = validateHeightLayers(ls, { ...opts, truth })
    expect(v.stale).toHaveLength(2)
    expect(v.errors.some(e => /^160_88\.png: \d+ unweighted vertex\(es\) differ from the current base/.test(e))).toBe(true)
    expect(v.errors.some(e => /^stale: 161_88\.png: authored on base [0-9a-f]{16}, the base is now [0-9a-f]{16}/.test(e))).toBe(true)
  })

  it('rejects a layer outside the coast domain', () => {
    const L = clone(layers().get('160_88')!)
    const v = validateHeightLayers(new Map([['140_88', { ...L, x: 140 }]]), { frame: FRAME, domain: opts.domain })
    expect(v.errors).toEqual(['140_88.png: region 140,88 is outside the coast domain'])
  })
})

describe('coast-authored: the protection mask', () => {
  const b = synthArea()
  const at = (i: number, j: number) => ({ guard: b.guard[j * NX + i]!, mask: b.mask[j * NX + i]! })

  it('freezes the playable area and the 30 m line guard, locks the border ring, and fades out by 90 m', () => {
    expect(at(96, LINE_J).guard & GUARD.frozen).toBeTruthy() // on the line
    expect(at(96, 150).guard & GUARD.frozen).toBeTruthy()
    expect(at(96, LINE_J - LINE_GUARD_M / 2).guard).toBe(GUARD.line)
    expect(at(96, LINE_J - LINE_GUARD_M / 2 - 1).guard).toBe(0)
    expect(at(0, 40).guard & GUARD.border).toBeTruthy()
    expect(at(NX - 1, 40).guard & GUARD.border).toBeTruthy()
    for (let k = 0; k < b.guard.length; k++) if (b.guard[k]) expect(b.mask[k]).toBe(1)
    expect(at(96, LINE_J - 30).mask).toBeCloseTo(0.5, 5) // 60 m past the line: halfway through the fade
    expect(at(96, LINE_J - 45).mask).toBe(0) // 90 m
    expect(at(10, 40).mask).toBeGreaterThan(0.5) // 20 m from the west border
  })

  it('fades out around the tomb keep and kept retail water', () => {
    const keep = new Uint8Array(NX * NZ)
    for (let j = 40; j < 50; j++) for (let i = 90; i < 100; i++) keep[j * NX + i] = 1
    const p = protection({ area: AREA, frame: FRAME, tombKeep: keep })
    expect(p.guard[45 * NX + 95]! & GUARD.tombKeep).toBeTruthy()
    expect(p.mask[45 * NX + 104]!).toBeGreaterThan(0.5) // 10 m away
    expect(p.mask[45 * NX + 119]!).toBe(0) // 40 m away (TOMB_FADE_M 30; clear of the line fade)
  })
})

describe('coast-authored: Blender runs and sessions', () => {
  it('hands Blender absolute paths only, and a bundle folder must be absolute', () => {
    const bundle = { dir: join(tmpRoot, 'b'), json: join(tmpRoot, 'b', 'bundle.json'), blend: join(tmpRoot, 'b', 'edge.blend'), meta: {} }
    const runs = [
      buildRun(bundle),
      passesRun(bundle, { spec: join(bundle.dir, 'passes.json'), blendIn: bundle.blend, blendOut: join(bundle.dir, 's.blend'), report: join(bundle.dir, 'r.json') }),
      passesRun(bundle, { spec: join(bundle.dir, 'passes.json'), blendIn: bundle.blend, blendOut: join(bundle.dir, 's.blend'), report: join(bundle.dir, 'r.json'), watch: true, quit: true }),
      readbackRun(bundle, bundle.blend, join(bundle.dir, 'rb'), join(bundle.dir, 'rb', 'r.json'), { session: 'a/b' }),
      renderRun(bundle, join(bundle.dir, 'bundle.base.f32'), join(bundle.dir, 'x.png'), { cam: [-1, -2, 3], target: [4, 5, 6], lens: 30 }),
    ]
    for (const r of runs) expect(relativePaths(r)).toEqual([])
    expect(BLENDER_TOOLS.startsWith(REPO_ROOT)).toBe(true)
    // The Blender scripts (packages/convert/tools/blender/*.py) are not part of the public release: check them only when present.
    if (existsSync(BLENDER_TOOLS)) {
      for (const f of ['build_edge.py', 'sculpt_edge.py', 'readback_edge.py', 'render_edge.py', 'coast_edge.py']) expect(existsSync(join(BLENDER_TOOLS, f)), f).toBe(true)
    }
    expect(() => writeBundle('work/coast/x', synthArea(), { world: 'w', from: 'fixture', frame: FRAME, seaLevelM: SL })).toThrow(/not absolute/)
  })

  it('the sessions: disjoint areas inside the coast domain, passes that exist, cameras over the sea', () => {
    const cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
    // Without the Blender scripts (not part of the public release) the sessions are checked against the known pass names.
    const passes = existsSync(join(BLENDER_TOOLS, 'passes'))
      ? new Set(readdirSync(join(BLENDER_TOOLS, 'passes')).filter(f => f.endsWith('.py') && f !== 'common.py').map(f => f.slice(0, -3)))
      : new Set(['cove', 'dunes', 'gullies', 'soften', 'spurs'])
    expect([...passes].sort()).toEqual(['cove', 'dunes', 'gullies', 'soften', 'spurs'])
    const areas = Object.entries(COAST_SESSIONS).map(([name, s]) => ({ name, a: parseArea(s.area), s }))
    const hotspots = new Set<number>()
    for (const { name, a, s } of areas) {
      expect(a.x0 >= cfg.domain.x[0] && a.x1 <= cfg.domain.x[1] && a.z0 >= cfg.domain.z[0] && a.z1 <= cfg.domain.z[1], name).toBe(true)
      for (const p of s.passes) expect(passes.has(p.name), `${name}: ${p.name}`).toBe(true)
      expect(s.cameras.length, name).toBeGreaterThan(0)
      s.hotspots.forEach(h => hotspots.add(h))
    }
    expect([...hotspots].sort()).toEqual([1, 2, 3, 4, 5, 6]) // COAST §3B.7's six hotspots
    for (let i = 0; i < areas.length; i++) {
      for (let j = i + 1; j < areas.length; j++) {
        const [p, q] = [areas[i]!.a, areas[j]!.a]
        const overlap = p.x0 <= q.x1 && q.x0 <= p.x1 && p.z0 <= q.z1 && q.z0 <= p.z1
        expect(overlap, `${areas[i]!.name} / ${areas[j]!.name}`).toBe(false)
      }
    }
  })

  it('the bundle of the prototype area equals the 2026-09-29 one byte for byte (while the export is retail)', () => {
    let sro
    try {
      sro = loadConfig()
    } catch {
      return
    }
    const world = join(sro.workDir, 'out', 'world', 'jangan-fields')
    const manifest = join(world, 'manifest.json')
    if (!existsSync(manifest) || 'coast' in (JSON.parse(readFileSync(manifest, 'utf8')) as object)) return // no export, or the coast is in it
    const { frame } = worldFrame('jangan-fields', sro)
    const b = areaFromExport(world, parseArea('173-175,89-91'), frame, SL)
    const sha = (a: ArrayBufferView) => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex')
    expect(sha(b.base)).toBe('d5f5a5c99d3fabe74bfd8892cf9bd867b494dc74d9fad946ff1d12dfcb81390a')
    expect(sha(b.tex)).toBe('afad55e0bdc70eb14604154070809968f7ba34d672a9375e6bdc5449f5cb0548')
  })
})

const BLENDER = blenderVersion()

// Skipped without Blender, or without the Blender scripts (packages/convert/tools/blender, not part of the public release).
describe.skipIf(!BLENDER || !existsSync(BLENDER_TOOLS))('coast-authored: the round trip in Blender', () => {
  const sro = { blenderExe: undefined }
  const b = synthArea()
  const dir = join(tmpRoot, 'rt')
  const specs = [{ name: 'spurs', seed: 11, params: { wavelength: 150 } }, { name: 'gullies', seed: 12, params: { spacing: 90 } }]
  let bundle: ReturnType<typeof writeBundle>
  let sculpted: string

  beforeAll(async () => {
    bundle = writeBundle(dir, b, { world: 'fixture', from: 'fixture', frame: FRAME, seaLevelM: SL })
    await buildBlend(sro, bundle)
    sculpted = (await runPasses(sro, bundle, specs)).blend
  }, 300_000)

  it('an unsculpted area round-trips with no files written', async () => {
    const out = join(dir, 'unsculpted')
    const r = await readBack(sro, bundle, bundle.blend, out)
    expect(r.written).toEqual([])
    expect(r.weighted).toBe(0)
    expect(r.method).toBe('vertices')
    expect(readdirSync(join(out, 'height'))).toEqual([])
  }, 120_000)

  it('the scripted passes round-trip: 0 errors, nothing under the mask or within 30 m of the line, the border kept', async () => {
    const out = join(dir, 'pass-a')
    const r = await readBack(sro, bundle, sculpted, out, { session: 'fixture' })
    expect(r.protectedWeighted).toBe(0)
    expect(r.weighted).toBeGreaterThan(5000)
    const { layers, errors } = await readHeightLayers(join(out, 'height'))
    expect(errors).toEqual([])
    const v = validateHeightLayers(layers, { frame: FRAME, truth: truthOf(b), area: AREA })
    expect(v.errors).toEqual([])
    // nothing weighted inside the bounds, within 30 m past the line, on the border ring or where the mask is 1
    const h = new Float32Array(new Uint8Array(readFileSync(join(out, 'sculpted.f32'))).buffer)
    const merged = mergeLayers(b.base, AREA, layers)
    let worst = 0
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i
        if (b.mask[k] === 1 || (LINE_J - j) * 2 <= LINE_GUARD_M || i === 0 || j === 0 || i === NX - 1 || j === NZ - 1) expect(h[k]).toBe(b.base[k])
        worst = Math.max(worst, Math.abs(merged[k]! - h[k]!))
      }
    }
    // lerp(base, L, A) gives the sculpted heights back to half a height step (the readback itself is exact: vertices)
    expect(worst).toBeLessThanOrEqual(LA16.step / 2 + 0.001)
    // the TypeScript twin writes the same pixels
    const twin = authorLayers(b.base, h, AREA)
    expect([...twin.keys()].sort()).toEqual([...layers.keys()].sort())
    for (const [k, L] of layers) {
      expect(Buffer.from(twin.get(k)!.L.buffer).equals(Buffer.from(L.L.buffer)), k).toBe(true)
      expect(Buffer.from(twin.get(k)!.A.buffer).equals(Buffer.from(L.A.buffer)), k).toBe(true)
    }
  }, 180_000)

  it('is deterministic: the same passes give byte-identical layers', async () => {
    const again = await runPasses(sro, bundle, specs, { blendOut: join(dir, 'sculpted-2.blend') })
    const a = join(dir, 'det-a')
    const c = join(dir, 'det-b')
    await readBack(sro, bundle, sculpted, a)
    await readBack(sro, bundle, again.blend, c)
    const files = readdirSync(join(a, 'height')).sort()
    expect(files.length).toBeGreaterThan(0)
    expect(readdirSync(join(c, 'height')).sort()).toEqual(files)
    for (const f of files) expect(readFileSync(join(c, 'height', f)).equals(readFileSync(join(a, 'height', f))), f).toBe(true)
  }, 240_000)

  it('rejects an in-bounds edit and a moved area border made in the .blend, naming the region and the vertex', async () => {
    const script = join(dir, 'illegal_edit.py')
    const edited = join(dir, 'illegal.blend')
    writeFileSync(script, [
      'import bpy, sys',
      'o = next(o for o in bpy.data.objects if o.name.startswith("Terrain_"))',
      `nx = ${NX}`,
      'o.data.vertices[150 * nx + 50].co.z += 3.0   # inside the bounds',
      'o.data.vertices[40 * nx + 0].co.z += 2.0     # the west border ring',
      `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(edited)})`,
    ].join('\n'))
    await runBlender(sro, { script, blend: sculpted, cwd: dir })
    const out = join(dir, 'illegal')
    const r = await readBack(sro, bundle, edited, out)
    expect(r.protectedWeighted).toBe(2)
    const { layers } = await readHeightLayers(join(out, 'height'))
    const v = validateHeightLayers(layers, { frame: FRAME, truth: truthOf(b), area: AREA })
    // (50, 150) = region 160,89 vertex (50, 54); (0, 40) = region 160,88 vertex (0, 40)
    expect(v.errors.some(e => /^160_89\.png: vertex \(50,54\) .* is inside the frozen playable area/.test(e))).toBe(true)
    expect(v.errors.some(e => /^160_88\.png: vertex \(0,40\) .*the area border moved \(region 160,88\)/.test(e))).toBe(true)
  }, 180_000)
})
