/**
 * W12-CV (docs/WAVE_PLAN8.md §4.4, D6; docs/WORLD_EDITOR.md §3.6, F15, F17; docs/TREES.md WF11): the converter spine.
 * - the pass order coast -> town dressing -> cloth -> static variants -> grass palettes -> world edits -> tree swap, on a
 *   fixture where C9 drops a uid, the dressing adds one and the edits move one: every later pass sees the right set,
 *   never a dropped uid; a skinned model only an edit's add uses gets its static variant late;
 * - S-UID: the ranges are disjoint, an authored add outside its range or on a held key throws, a move keeps its key;
 * - the tree-swap step: species appended as models, `treeSwap` on the retail model and its static variant, bad rows
 *   are warnings; the result validates;
 * - the manifest's wave-12 fields are additive (an old manifest validates) and named when wrong;
 * - the nav step and the edits pass agree on every edited footprint (editedFootprintProblems);
 * - the pre-pass cache round trip; the convert lock;
 * - convertWorld: an empty edits layer gives byte-identical files, and so do pass-through hooks; a lightmap hook's
 *   image is written (skips without sro.config.json).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { acquireConvertLock, isStaleOwner, tryConvertLock, withConvertLock } from '../src/world/convert-lock.ts'
import { convertWorld } from '../src/world/convert-world.ts'
import { createWorldEdits, layerFiles } from '../src/world/edits/index.ts'
import { encodePrePassCache, parsePrePassCache, type WorldEditsRun } from '../src/world/edits-hook.ts'
import {
  validateWorldManifest, type TileTexture, type WorldManifest, type WorldModel, type WorldPlacement, type WorldRegion,
} from '../src/world/manifest.ts'
import { editedFootprintProblems, runWorldPasses, type WorldPassInput } from '../src/world/passes.ts'
import { TOWN_UID_BASE } from '../src/world/town/dressing.ts'
import {
  DRESSING_UID_BASE, EDITOR_UID_MAX, EDITOR_UID_MIN, nextEditorUid, UID_RANGES, uidRangeOverlaps, UidRegistry, UidRegistryError, uidSourceOf,
} from '../src/world/uids.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

const region = (x: number, z: number): WorldRegion => ({
  x, z, id: (z << 8) | x,
  origin: [192 * (x - 168), 0, 192 * (97 - z)],
  bounds: { min: [192 * (x - 168), 0, 192 * (97 - z) - 192], max: [192 * (x - 168) + 192, 10, 192 * (97 - z)] },
  terrain: { file: `terrain/${x}_${z}.bin`, bytes: 1, heightMinM: 0, heightMaxM: 10, layerCount: 1, tileIds: [1] },
  lightmap: null,
  minimap: null,
  blocks: Array.from({ length: 36 }, (_, k) => ({ bx: k % 6, bz: Math.floor(k / 6), flag: 0, environmentId: 0, water: null })),
  navmesh: null,
})

const model = (index: number, kind: WorldModel['kind'], source: string): WorldModel => ({
  index, source, glb: `models/${index}.glb`, sidecar: `models/${index}.json`, kind,
  animations: kind === 'skinned' ? ['sway'] : [], defaultClip: kind === 'skinned' ? 'sway' : null,
  lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 5, 1], bytes: 100, validatorErrors: 0,
})
const bare = (m: WorldModel): Omit<WorldModel, 'index' | 'staticVariant'> => {
  const { index: _i, ...rest } = m
  return rest
}

const placement = (regionId: number, uid: number, models: number[], objId = 100 + uid): WorldPlacement => ({
  objId, source: `res\\obj${uid}.bsr`, models, compound: false,
  position: [uid, 1, -uid], rotation: [0, 0, 0, 1], yaw: 0,
  flags: { static: true, big: false, struct: false }, staticFlag: 0xffff,
  uid, region: regionId, group: 3, inConvertedRegion: true,
})

const tile = (id: number, name: string): TileTexture =>
  ({ id, source: `${name}.ddj`, file: `tiles/${name}.png`, width: 256, height: 256, typeName: null, category: 'field' })

const OWNER = (97 << 8) | 168

/** Models: 0 skinned tree (used), 1 skinned tree (used only by the edits' add), 2 static house. */
function fixture(): WorldPassInput {
  const models = [model(0, 'skinned', 'res\\nature\\china\\x\\tree\\a.bsr'), model(1, 'skinned', 'res\\nature\\china\\x\\tree\\b.bsr'),
    model(2, 'static', 'res\\house.bsr')]
  const placements = [placement(OWNER, 1, [0]), placement(OWNER, 2, [2]), placement(OWNER, 3, [2]), placement(OWNER, 4, [0])]
  return { outDir: '/tmp/x', origin: { x: 168, z: 97 }, regions: [region(168, 97)], tiles: [tile(1, 'grass')], models, placements, warnings: [] }
}

const refs = (ps: readonly WorldPlacement[]) => ps.map(p => `${p.region}:${p.uid}`).sort()
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('S-UID: the authored-uid registry', () => {
  it('the ranges are disjoint, the editor and coast ranges stay 16-bit, and the dressing base is the dressing\'s', () => {
    expect(uidRangeOverlaps()).toEqual([])
    expect(uidRangeOverlaps({ a: { lo: 0, hi: 10 }, b: { lo: 10, hi: 20 } })).toEqual(['a and b overlap'])
    expect(UID_RANGES.editor).toEqual({ lo: 0xe000, hi: 0xefff })
    expect(UID_RANGES.coast.hi).toBeLessThanOrEqual(0xffff)
    expect(DRESSING_UID_BASE).toBe(TOWN_UID_BASE)
    expect(uidSourceOf(0xb41d)).toBe('retail')
    expect(uidSourceOf(EDITOR_UID_MIN)).toBe('editor')
    expect(uidSourceOf(TOWN_UID_BASE + 7)).toBe('dressing')
    expect(nextEditorUid([EDITOR_UID_MIN, EDITOR_UID_MIN + 1])).toBe(EDITOR_UID_MIN + 2)
    expect(nextEditorUid(Array.from({ length: EDITOR_UID_MAX - EDITOR_UID_MIN + 1 }, (_, k) => EDITOR_UID_MIN + k))).toBeNull()
  })

  it('a collision or an add outside its range throws; a move keeps its key', () => {
    const reg = new UidRegistry()
    reg.input([{ region: 1, uid: 5 }, { region: 1, uid: 0xe100 }, { region: 1, uid: 0xe200 }])
    expect(reg.holder(1, 5)).toBe('retail')
    expect(reg.holder(1, 0xe200)).toBe('editor')
    expect(() => reg.claim('editor', [{ region: 1, uid: 0xe100 }])).toThrow(UidRegistryError)
    expect(() => reg.claim('editor', [{ region: 1, uid: 7 }])).toThrow(/outside editor's range/)
    expect(() => reg.claim('editor', [{ region: 2, uid: 0xe001 }, { region: 2, uid: 0xe001 }])).toThrow(/twice/)
    expect(() => reg.claim('editor', [{ region: 1, uid: 0xe200 }])).toThrow(/collides with a placement of the editor source/)
    reg.note('dressing', [{ region: 9, uid: TOWN_UID_BASE }])
    expect(() => reg.claim('editor', [{ region: 9, uid: TOWN_UID_BASE }])).toThrow(/outside editor's range/)
    expect(() => reg.note('coast', [{ region: 9, uid: EDITOR_UID_MIN }])).toThrow(/lies in the editor's range/)
    reg.release([{ region: 1, uid: 5 }])
    reg.claim('editor', [{ region: 1, uid: 5 }], [{ region: 1, uid: 5 }])
    expect(reg.holder(1, 5)).toBe('editor')
    reg.claim('editor', [{ region: 2, uid: 0xe001 }])
    expect(() => reg.claim('coast', [{ region: 2, uid: 0xe001 }])).toThrow(/outside coast's range/)
    reg.note('coast', [{ region: 3, uid: 50 }])
    expect(reg.holder(3, 50)).toBe('coast')
  })
})

describe('placement passes: coast -> dressing -> cloth -> static variants -> grass -> world edits -> tree swap', () => {
  it('every pass sees the right set, never a dropped uid; the edits move and add; the late static variant', async () => {
    const input = fixture()
    const seen: Record<string, string[]> = {}
    const order: string[] = []
    const DRESS = TOWN_UID_BASE
    const NEW = EDITOR_UID_MIN
    const out = await runWorldPasses(input, {
      coast: { placementEdits: ctx => (order.push('coast'), (seen.coast = refs(ctx.placements)), { drop: [{ region: OWNER, uid: 3 }], resnap: [], add: [] }) },
      townDressing: ctx => {
        order.push('town')
        seen.town = refs(ctx.placements)
        return { drop: [], resnap: [], add: [placement(OWNER, DRESS, [2])] }
      },
      cloth: ctx => (order.push('cloth'), (seen.cloth = refs(ctx.placements)), []),
      staticVariants: ctx => {
        order.push(`static ${refs(ctx.placements).join(' ')}`)
        const used = new Set(ctx.placements.flatMap(p => p.models))
        return ctx.models.filter(m => m.kind === 'skinned' && used.has(m.index))
          .map(m => ({ of: m.index, model: bare(model(0, 'static', m.source + '#static')) }))
      },
      grass: ctx => (order.push('grass'), (seen.grass = refs(ctx.placements)), []),
      worldEdits: ctx => {
        order.push('edits')
        seen.edits = refs(ctx.placements)
        // a move of retail uid 1 (drop + add of the same key), a drop of uid 4, a new tree of model 1 at an editor uid
        const moved = { ...placement(OWNER, 1, [0]), position: [50, 2, -60] as [number, number, number], yaw: 1.25 }
        return { drop: [{ region: OWNER, uid: 1 }, { region: OWNER, uid: 4 }], resnap: [], add: [moved, placement(OWNER, NEW, [1])] }
      },
      treeSwap: ctx => {
        order.push('trees')
        seen.trees = refs(ctx.placements)
        return { species: [], swaps: [] }
      },
    })
    const k = (uid: number) => `${OWNER}:${uid}`
    expect(order).toEqual(['coast', 'town', 'cloth', `static ${[k(1), k(2), k(4), k(DRESS)].sort().join(' ')}`, 'grass', 'edits',
      `static ${k(NEW)}`, 'trees'])
    expect(seen.coast).toEqual([k(1), k(2), k(3), k(4)].sort())
    for (const pass of ['cloth', 'grass', 'edits']) expect(seen[pass], pass).toEqual([k(1), k(2), k(4), k(DRESS)].sort())
    expect(seen.trees).toEqual([k(1), k(2), k(DRESS), k(NEW)].sort())
    expect(refs(out.placements)).toEqual(seen.trees)
    const moved = out.placements.find(p => p.uid === 1)!
    expect(moved.position).toEqual([50, 2, -60])
    expect(moved.yaw).toBe(1.25)
    // model 0 got its variant in step 4, model 1 (only the edits' add uses it) in step 6
    expect(out.models[0]!.staticVariant).toBe(3)
    expect(out.models[1]!.staticVariant).toBe(4)
    expect(out.editsReport).toEqual({
      placements: { dropped: [{ region: OWNER, uid: 1 }, { region: OWNER, uid: 4 }], resnapped: [], added: [{ region: OWNER, uid: 1 }, { region: OWNER, uid: NEW }] },
      models: 0, staticVariants: 1,
    })
    expect(out.treesReport).toEqual({ species: 0, swapped: 0 })
    expect(input.warnings).toEqual([])
  })

  it('without the wave-12 steps the result is the wave-11 one (no edits or trees report)', async () => {
    const out = await runWorldPasses(fixture(), {})
    expect(out.editsReport).toBeUndefined()
    expect(out.treesReport).toBeUndefined()
    expect(refs(out.placements)).toEqual(refs(fixture().placements))
  })

  it('an edits add on a retail uid, a coast-dropped key or a dressing key throws (S-UID)', async () => {
    const run = (add: WorldPlacement, coastDrop = false) => runWorldPasses(fixture(), {
      coast: { placementEdits: () => ({ drop: coastDrop ? [{ region: OWNER, uid: 3 }] : [], resnap: [], add: [] }) },
      townDressing: () => ({ drop: [], resnap: [], add: [placement(OWNER, TOWN_UID_BASE, [2])] }),
      worldEdits: () => ({ drop: [], resnap: [], add: [add] }),
    })
    await expect(run(placement(OWNER, 2, [2]))).rejects.toThrow(UidRegistryError)
    await expect(run(placement(OWNER, 3, [2]), true)).rejects.toThrow(/outside editor's range/)
    await expect(run(placement(OWNER, TOWN_UID_BASE, [2]))).rejects.toThrow(/outside editor's range/)
    await expect(run(placement(OWNER, EDITOR_UID_MIN, [2]))).resolves.toBeTruthy()
  })

  it('the tree swap appends the species and writes treeSwap (also on the static variant); bad rows are warnings', async () => {
    const input = fixture()
    const species = bare(model(0, 'static', 'trees/maple/far.glb'))
    const out = await runWorldPasses(input, {
      staticVariants: ctx => ctx.models.filter(m => m.kind === 'skinned' && ctx.placements.some(p => p.models.includes(m.index)))
        .map(m => ({ of: m.index, model: bare(model(0, 'static', m.source + '#static')) })),
      treeSwap: ctx => ({
        species: [species, bare(model(0, 'skinned', 'trees/bad/far.glb'))],
        swaps: [
          { model: 0, species: 0, fit: [1.1, 0.9, 1.1], tint: 0.5, offset: [0.1, 0, -0.2] },
          { model: 0, species: 0, fit: [1, 1, 1], tint: 0 },
          { model: 2, species: 1, fit: [1, 1, 1], tint: 0 },
          { model: 1, species: 7, fit: [1, 1, 1], tint: 0 },
          { model: 1, species: 0, fit: [1, 0, 1], tint: 0 },
          { model: ctx.models.length, species: 0, fit: [1, 1, 1], tint: 0 },
        ],
      }),
    })
    const sp = out.models.findIndex(m => m.source === 'trees/maple/far.glb')
    expect(sp).toBe(4)
    expect(out.models[0]!.treeSwap).toEqual({ model: sp, fit: [1.1, 0.9, 1.1], tint: 0.5, offset: [0.1, 0, -0.2] })
    expect(out.models[out.models[0]!.staticVariant!]!.treeSwap).toEqual(out.models[0]!.treeSwap)
    expect(out.models[1]!.treeSwap).toBeUndefined()
    expect(out.models[2]!.treeSwap).toBeUndefined()
    expect(out.treesReport).toEqual({ species: 2, swapped: 1 })
    const w = input.warnings.join('\n')
    expect(w).toContain(': duplicate')
    expect(w).toContain('is not a converted static model')
    expect(w).toContain('unknown species 7')
    expect(w).toContain('expected fit')
    expect(w).toContain('unknown retail model 4')
  })
})

/** A manifest with none of the wave-12 fields. */
function oldManifest(): WorldManifest {
  const f = fixture()
  return {
    format: 'sro-world', version: 1, name: 'fixture', generator: 'test', createdAt: '2026-10-02T00:00:00.000Z',
    space: {
      units: 'metre', metresPerUnit: 0.1, handedness: 'right-handed, +Y up (glTF)',
      axes: { east: [1, 0, 0], north: [0, 0, -1], up: [0, 1, 0] },
      originRegion: { x: 168, z: 97, id: OWNER }, originCorner: 'south-west', regionSizeM: 192, cellSizeM: 2,
      regionOffsetRule: 'rule', localToWorldRule: 'rule',
    },
    regions: f.regions, tiles: f.tiles,
    water: { frames: ['water/water101.png'], frameMs: 100, ice: null, waves: [] },
    environment: { file: 'environment.json', profileIds: [0] },
    models: f.models, placements: f.placements, warnings: [],
    report: {
      regions: 1, regionsSkipped: [], placementRecords: 4, placements: f.placements.length, dedupeConflicts: 0, uniqueObjectIds: 4,
      compoundPlacements: 0, uniqueModels: 3, modelsConverted: 3, failedModels: [], lightmapTextures: 0, tileTextures: 1, validatorErrors: 0,
      sizes: { totalBytes: 0, byCategory: {} }, timeMs: { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0 },
    },
  }
}

function newManifest(): WorldManifest {
  const m = oldManifest()
  m.models.push(model(3, 'static', 'trees/maple/far.glb'))
  m.models[0] = { ...m.models[0]!, treeSwap: { model: 3, fit: [1, 1.05, 1], tint: 0.2 } }
  m.placements[0] = { ...m.placements[0]!, scale: 1.15 }
  m.regions[0] = { ...m.regions[0]!, grassMask: 'grass-mask/168_97.png', lightPoints: 2 }
  m.report.edits = { placements: { dropped: [], resnapped: [], added: [{ region: OWNER, uid: EDITOR_UID_MIN }] }, models: 0, staticVariants: 0, footprintProblems: 0 }
  m.report.trees = { species: 1, swapped: 1 }
  return m
}

describe('manifest: the wave-12 fields are additive', () => {
  it('an old manifest validates (also after a JSON round trip); the new fields validate and round-trip', () => {
    expect(validateWorldManifest(oldManifest())).toEqual([])
    expect(validateWorldManifest(roundTrip(oldManifest()))).toEqual([])
    const m = newManifest()
    expect(validateWorldManifest(m)).toEqual([])
    expect(roundTrip(m)).toEqual(m)
  })

  it('names a wrong new field', () => {
    const bad = (edit: (m: WorldManifest) => void, what: string) => {
      const m = newManifest()
      edit(m)
      expect(validateWorldManifest(m).join('\n')).toContain(what)
    }
    bad(m => (m.placements[0]!.scale = 3), 'placements[0].scale')
    bad(m => (m.placements[0]!.scale = 0), 'placements[0].scale')
    bad(m => (m.models[0]!.treeSwap = { model: 0, fit: [1, 1, 1], tint: 0 }), 'models[0].treeSwap.model')
    bad(m => (m.models[0]!.treeSwap = { model: 1, fit: [1, 1, 1], tint: 0 }), 'is not static')
    bad(m => (m.models[0]!.treeSwap = { model: 3, fit: [1, 0, 1], tint: 0 }), 'models[0].treeSwap')
    bad(m => (m.models[0]!.treeSwap = { model: 3, fit: [1, 1, 1], tint: 0, offset: [0, 0] as unknown as [number, number, number] }), 'models[0].treeSwap')
    bad(m => {
      m.models[3]!.treeSwap = { model: 2, fit: [1, 1, 1], tint: 0 }
    }, 'is itself swapped')
    bad(m => (m.regions[0]!.grassMask = '../mask.png'), 'regions[0].grassMask')
    bad(m => (m.regions[0]!.lightPoints = -1), 'regions[0].lightPoints')
    bad(m => ((m.report.edits as { models: unknown }).models = 'x'), 'report.edits')
    bad(m => ((m.report as { trees?: unknown }).trees = { species: 1 }), 'report.trees')
  })
})

describe('the nav step and the edits pass agree on every edited footprint', () => {
  const origin = { x: 168, z: 97 }
  const at = (p: WorldPlacement) => ({ x: origin.x * 1920 + p.position[0] * 10, z: origin.z * 1920 - p.position[2] * 10 })
  const inst = (region: number, uid: number, objId: number, x: number, z: number, yaw = 0) =>
    ({ id: ((region << 16) | uid) >>> 0, objId, model: 0, x, y: 0, z, yaw, links: [] })

  it('agrees when the moved instance sits at the new transform, the dropped one is gone, and the footprint-free add is ignored', () => {
    const moved = { ...placement(OWNER, 1, [0], 501), position: [50, 2, -60] as [number, number, number], yaw: 1.25 }
    const free = placement(OWNER, EDITOR_UID_MIN, [1], 777)
    const report = { dropped: [{ region: OWNER, uid: 1 }, { region: OWNER, uid: 4 }], resnapped: [], added: [{ region: OWNER, uid: 1 }, { region: OWNER, uid: EDITOR_UID_MIN }] }
    const good = { instances: [inst(OWNER, 1, 501, at(moved).x, at(moved).z, 1.25), inst(OWNER, 2, 501, 0, 0)] }
    expect(editedFootprintProblems(good, report, [moved, free], origin)).toEqual([])

    const stale = { instances: [inst(OWNER, 1, 501, 0, 0, 0), inst(OWNER, 4, 502, 0, 0)] }
    const problems = editedFootprintProblems(stale, report, [moved, free], origin)
    expect(problems.join('\n')).toContain(`dropped ${OWNER}:4 still has 1 nav instance`)
    expect(problems.join('\n')).toContain(`${OWNER}:1 (res\\obj1.bsr) nav instance at`)
    const twice = { instances: [...good.instances, inst(OWNER, 1, 501, at(moved).x, at(moved).z, 1.25)] }
    expect(editedFootprintProblems(twice, report, [moved, free], origin).join()).toContain('has 2 nav instances, expected 1')
  })
})

describe('the pre-pass cache and the convert lock', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sro-w12cv-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('the pre-pass cache round-trips and refuses another export', () => {
    const f = fixture()
    const text = encodePrePassCache({ name: 'jangan-fields', origin: f.origin, tiles: f.tiles, models: f.models, placements: f.placements })
    const back = parsePrePassCache(text, 'jangan-fields')
    expect(back.placements).toEqual(f.placements)
    expect(back.models).toEqual(f.models)
    expect(() => parsePrePassCache(text, 'jangan')).toThrow(/expected 'jangan'/)
    expect(() => parsePrePassCache('{"format":"x"}')).toThrow(/sro-world-prepass/)
  })

  it('one holder at a time; only the holder releases; a dead owner on this host is stale', async () => {
    const dir = join(tmp, 'out', '.convert.lock')
    const a = tryConvertLock(dir, 'lane A')
    expect('heldBy' in a).toBe(false)
    const b = tryConvertLock(dir, 'lane B')
    expect('heldBy' in b && b.heldBy).toContain('lane_A pid=')
    await expect(acquireConvertLock(dir, 'lane B', { waitMs: 50, pollMs: 10 })).rejects.toThrow(/is held by lane_A/)
    if (!('heldBy' in a)) a.release()
    expect(existsSync(dir)).toBe(false)
    expect(await withConvertLock(dir, 'lane C', async () => existsSync(dir))).toBe(true)
    expect(existsSync(dir)).toBe(false)
    const host = 'pc1'
    expect(isStaleOwner(`x pid=42 host=${host} t`, host, () => false)).toBe(true)
    expect(isStaleOwner(`x pid=42 host=${host} t`, host, () => true)).toBe(false)
    expect(isStaleOwner(`x pid=42 host=other t`, host, () => false)).toBe(false)
    expect(isStaleOwner(null, host, () => false)).toBe(false)
  })

  it('the edits stub: no layer files (palette.json only) gives no run; layer files give a warning, never a half apply', async () => {
    const dir = join(tmp, 'edits')
    mkdirSync(join(dir, 'height'), { recursive: true })
    writeFileSync(join(dir, 'palette.json'), '[]')
    const warnings: string[] = []
    const opts = { dir, world: 'w', outDir: tmp, origin: { x: 0, z: 0 }, regions: [], warnings, log: () => {} }
    expect(layerFiles(dir)).toEqual([])
    expect(await createWorldEdits(opts)).toBeNull()
    expect(warnings).toEqual([])
    writeFileSync(join(dir, 'height', '168_97.png'), 'x')
    expect(layerFiles(dir)).toEqual(['height/168_97.png'])
    expect(await createWorldEdits(opts)).toBeNull()
    expect(warnings.join()).toContain('ignored')
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
  const c = roundTrip(m)
  c.createdAt = ''
  c.report.timeMs = { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0 }
  c.report.sizes.totalBytes = 0
  delete c.report.sizes.byCategory.manifest
  return c
}

describe.skipIf(!hasConfig)('convertWorld: the edits hooks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sro-w12cv-world-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  const base = { regions: [{ x: 168, z: 97 }], origin: { x: 168, z: 97 }, objects: false, navmesh: true, passes: { grass: null } }

  it('an empty layer and pass-through hooks give byte-identical files; a lightmap hook\'s image is written', async () => {
    const none = await convertWorld({ ...base, name: 'w12', outDir: join(tmp, 'none') })
    const emptyDir = join(tmp, 'layer')
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(emptyDir, 'palette.json'), '[]')
    const empty = await convertWorld({ ...base, name: 'w12', outDir: join(tmp, 'empty'), edits: emptyDir })
    const a = files(join(tmp, 'none'))
    const b = files(join(tmp, 'empty'))
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
    for (const [k, v] of a) if (k !== 'manifest.json') expect(b.get(k)!.equals(v), k).toBe(true)
    expect(stable(empty.manifest)).toEqual(stable(none.manifest))

    // pass-through hooks on the touched region: same bytes; the run's report lands in report.edits
    const id = (97 << 8) | 168
    const calls: string[] = []
    const passThrough: WorldEditsRun = {
      touched: new Set([id]),
      terrain: (x, z, t) => (calls.push(`terrain ${x},${z}`), t),
      height: () => undefined,
      navEdit: rid => (calls.push(`nav ${rid}`), null),
      pass: () => (calls.push('pass'), { drop: [], resnap: [], add: [] }),
      lightmap: () => (calls.push('lightmap'), null),
      minimap: () => (calls.push('minimap'), null),
      regionExtras: () => null,
      ambientPoints: () => [],
      report: () => ({ touchedRegions: 1 }),
    }
    const hooked = await convertWorld({ ...base, name: 'w12', outDir: join(tmp, 'hooked'), editsRun: passThrough })
    expect(calls).toEqual(['terrain 168,97', `nav ${id}`, 'pass', 'lightmap', 'minimap'])
    const c = files(join(tmp, 'hooked'))
    for (const [k, v] of a) if (k !== 'manifest.json') expect(c.get(k)!.equals(v), k).toBe(true)
    expect(hooked.manifest.report.edits).toEqual({
      touchedRegions: 1, placements: { dropped: [], resnapped: [], added: [] }, models: 0, staticVariants: 0, footprintProblems: 0,
    })
    expect(validateWorldManifest(hooked.manifest)).toEqual([])

    // a re-baked lightmap and the region extras are written
    const baked: WorldEditsRun = {
      ...passThrough,
      lightmap: (_r, cur) => ({ width: cur.width, height: cur.height, rgba: new Uint8Array(cur.rgba.length).fill(200) }),
      regionExtras: r => (r.id === id ? { lightPoints: 3 } : null),
    }
    const out = await convertWorld({ ...base, name: 'w12', outDir: join(tmp, 'baked'), editsRun: baked })
    const lm = none.manifest.regions[0]!.lightmap!.file
    expect(files(join(tmp, 'baked')).get(lm)!.equals(a.get(lm)!)).toBe(false)
    expect(out.manifest.regions[0]!.lightPoints).toBe(3)
    expect(validateWorldManifest(out.manifest)).toEqual([])
  }, 240_000)
})
