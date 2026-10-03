/**
 * W11-CV (docs/WAVE_PLAN7.md §4.5, D13, D15): the converter's wave-11 world seams.
 * - the pipeline order coast → town dressing → cloth → static variants → grass: a fixture where C9 drops a uid and the
 *   dressing adds one (with a new model): the cloth, static-variant and grass passes see the dressing's placement and
 *   never the dropped uid; a variant of the dressing's skinned model is accepted; cloth on an unused model is refused;
 * - the manifest: an export with no town files (every old export) validates before and after a JSON round trip;
 *   `town`, `models[].cloth` and `report.town` validate when right and are named when wrong;
 * - ambient.json (./ambient.ts): the models' ambient rows by final index, the dressing's lamps by base name or path,
 *   a lamp naming no model is a warning, no duplicate rows;
 * - the town content: a missing file is skipped with a log line, an invalid or wrong-kind file is a warning and is not
 *   copied, a valid one is copied (convertWorld writes town.json / town-dressing.json and manifest.town; skips without
 *   sro.config.json).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TOWN_FILE_SCHEMA, type TownDressingFile } from '../../shared/src/town.ts'
import type { ModelParticle } from '../src/fx/model-fx.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { buildAmbientIndex, lampMatches, modelKey, TOWN_LAMP_SET } from '../src/world/ambient.ts'
import { convertWorld, JANGAN_TOWN, loadTownContent, TOWN_DRESSING_FILE, WORLD_PRESETS } from '../src/world/convert-world.ts'
import { validateWorldManifest, type WorldManifest, type WorldModel, type WorldPlacement, type WorldRegion } from '../src/world/manifest.ts'
import { runWorldPasses, type WorldPassContext, type WorldPassInput } from '../src/world/passes.ts'
import { createClothPass } from '../src/world/town/cloth.ts'
import { createTownDressingPass } from '../src/world/town/dressing.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const OWNER = (97 << 8) | 168

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

const placement = (uid: number, models: number[]): WorldPlacement => ({
  objId: 100 + uid, source: `res\\obj${uid}.bsr`, models, compound: false,
  position: [uid, 1, -uid], rotation: [0, 0, 0, 1], yaw: 0,
  flags: { static: true, big: false, struct: false }, staticFlag: 0xffff,
  uid, region: OWNER, group: 3, inConvertedRegion: true,
})

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Models: 0 a tree (skinned), 1 the stall (static), 2 a house only the dropped uid 3 uses. */
function input(): WorldPassInput {
  return {
    outDir: tmpdir(), origin: { x: 168, z: 97 }, regions: [region(168, 97)],
    tiles: [{ id: 1, source: 'g.ddj', file: 'tiles/g.png', width: 256, height: 256, typeName: null, category: 'field' }],
    models: [model(0, 'skinned', 'res\\nature\\tre_a.bsr'), model(1, 'static', 'res\\bldg\\china\\jangan01\\cj_streetstall_02.bsr'), model(2, 'static', 'res\\house.bsr')],
    placements: [placement(1, [0]), placement(2, [1]), placement(3, [2])],
    warnings: [],
  }
}

describe('the pass order with the town dressing and the cloth reclass', () => {
  it('C9 drops uid 3, the dressing adds uid 50 with a new model: later passes see 50, never 3', async () => {
    const inp = input()
    const order: string[] = []
    const seen: Record<string, number[]> = {}
    const uids = (ctx: WorldPassContext) => ctx.placements.map(p => p.uid)
    const res = await runWorldPasses(inp, {
      coast: { placementEdits: ctx => (order.push('coast'), seen.coast = uids(ctx), { drop: [{ region: OWNER, uid: 3 }], resnap: [], add: [] }) },
      townDressing: ctx => {
        order.push('dressing')
        seen.dressing = uids(ctx)
        const { index: _i, ...banner } = model(0, 'skinned', 'out/town/props/banner01.glb')
        return { drop: [], resnap: [], add: [{ ...placement(50, [ctx.models.length]), source: 'out/town/props/banner01.glb' }], models: [banner] }
      },
      cloth: ctx => {
        order.push('cloth')
        seen.cloth = uids(ctx)
        return [
          { model: 1, cloth: [{ material: 'cj_streetstall_02', kind: 'awning' }] },
          { model: 3, cloth: [{ material: 'banner', kind: 'hanging', pinY: 4, height: 2 }] },
          { model: 2, cloth: [{ material: 'roof', kind: 'tent' }] },
        ]
      },
      staticVariants: ctx => {
        order.push('static')
        seen.static = uids(ctx)
        const { index: _i, ...v } = model(0, 'static', 'out/town/props/banner01.glb#static')
        return [{ of: 3, model: v }]
      },
      grass: ctx => (order.push('grass'), seen.grass = uids(ctx), []),
    })
    expect(order).toEqual(['coast', 'dressing', 'cloth', 'static', 'grass'])
    expect(seen.coast).toEqual([1, 2, 3])
    for (const k of ['dressing']) expect(seen[k]).toEqual([1, 2])
    for (const k of ['cloth', 'static', 'grass']) expect(seen[k], k).toEqual([1, 2, 50])
    expect(res.placements.map(p => p.uid)).toEqual([1, 2, 50])
    // the dressing's model is appended at index 3, its static variant at 4
    expect(res.models).toHaveLength(5)
    expect(res.models[3]).toMatchObject({ index: 3, source: 'out/town/props/banner01.glb', staticVariant: 4 })
    expect(res.models[4]).toMatchObject({ index: 4, kind: 'static' })
    // cloth on the stall and the banner; the house (only the dropped uid used it) is refused
    expect(res.models[1]!.cloth).toEqual([{ material: 'cj_streetstall_02', kind: 'awning' }])
    expect(res.models[3]!.cloth).toEqual([{ material: 'banner', kind: 'hanging', pinY: 4, height: 2 }])
    expect(res.models[2]!.cloth).toBeUndefined()
    expect(inp.warnings.some(w => /cloth: res\\house\.bsr: no placement uses the model/.test(w))).toBe(true)
    expect(res.townReport).toEqual({ placements: { dropped: [], resnapped: [], added: [{ region: OWNER, uid: 50 }] }, models: 1, clothModels: 2 })
    // the input is not mutated
    expect(input().models).toEqual(inp.models)
    expect(inp.placements.map(p => p.uid)).toEqual([1, 2, 3])
  })

  it('a dressing placement indexing no model, or colliding with a uid, is refused with a "town:" warning', async () => {
    const inp = input()
    const res = await runWorldPasses(inp, {
      townDressing: () => ({ drop: [], resnap: [], add: [placement(60, [9]), placement(2, [1])] }),
    })
    expect(res.placements.map(p => p.uid)).toEqual([1, 2, 3])
    expect(inp.warnings).toEqual([
      `town: added placement ${OWNER}:60 has a model index out of range`,
      `town: added placement ${OWNER}:2 collides with an existing (region, uid)`,
    ])
  })

  it('bad cloth entries are refused (unknown model, bad kind, empty list, duplicate)', async () => {
    const inp = input()
    const res = await runWorldPasses(inp, {
      cloth: () => [
        { model: 9, cloth: [{ material: 'x', kind: 'hanging' }] },
        { model: 1, cloth: [{ material: 'x', kind: 'flag' as never }] },
        { model: 0, cloth: [] },
        { model: 1, cloth: [{ material: 'ok', kind: 'tent' }] },
        { model: 1, cloth: [{ material: 'again', kind: 'tent' }] },
      ],
    })
    expect(res.models[1]!.cloth).toEqual([{ material: 'ok', kind: 'tent' }])
    expect(res.models[0]!.cloth).toBeUndefined()
    expect(inp.warnings).toHaveLength(4)
    expect(res.townReport?.clothModels).toBe(1)
  })

  it('the W11-CV stubs change nothing; the cloth pass applies a rule list by base name', async () => {
    const dressing: TownDressingFile = { schema: TOWN_FILE_SCHEMA, kind: 'townDressing', world: 'w', town: 'jangan', props: [], banners: [], lamps: [], decals: [], crackBands: [] }
    const stub = await runWorldPasses(input(), { townDressing: createTownDressingPass(dressing), cloth: createClothPass() })
    expect(stub.placements).toEqual(input().placements)
    expect(stub.models).toEqual(input().models)
    const ruled = await runWorldPasses(input(), { cloth: createClothPass([{ model: 'cj_streetstall_02', material: 'awning_mat', kind: 'awning' }, { model: 'house', material: 'm', kind: 'tent' }]) })
    expect(ruled.models[1]!.cloth).toEqual([{ material: 'awning_mat', kind: 'awning' }])
    // the house model is placed (uid 3), so it gets its rule too
    expect(ruled.models[2]!.cloth).toEqual([{ material: 'm', kind: 'tent' }])
  })

  it('jangan-fields takes the town content; the other presets do not', () => {
    expect(WORLD_PRESETS['jangan-fields']!.town).toEqual(JANGAN_TOWN)
    expect(JANGAN_TOWN).toEqual({ file: 'content/town/jangan.json', dressing: 'content/town/jangan-dressing.json' })
    expect(WORLD_PRESETS.jangan!.town).toBeUndefined()
    expect(WORLD_PRESETS['jangan-near']!.town).toBeUndefined()
  })
})

/** An old-style manifest (no wave-10 or wave-11 field). */
function oldManifest(): WorldManifest {
  const inp = input()
  return {
    format: 'sro-world', version: 1, name: 'fixture', generator: 'test', createdAt: '2026-10-01T00:00:00.000Z',
    space: {
      units: 'metre', metresPerUnit: 0.1, handedness: 'right-handed, +Y up (glTF)',
      axes: { east: [1, 0, 0], north: [0, 0, -1], up: [0, 1, 0] },
      originRegion: { x: 168, z: 97, id: OWNER }, originCorner: 'south-west', regionSizeM: 192, cellSizeM: 2,
      regionOffsetRule: 'rule', localToWorldRule: 'rule',
    },
    regions: inp.regions,
    tiles: inp.tiles,
    water: { frames: ['water/water101.png'], frameMs: 100, ice: null, waves: [] },
    environment: { file: 'environment.json', profileIds: [0] },
    models: inp.models,
    placements: inp.placements,
    warnings: [],
    report: {
      regions: 1, regionsSkipped: [], placementRecords: 3, placements: 3, dedupeConflicts: 0,
      uniqueObjectIds: 3, compoundPlacements: 0, uniqueModels: 3, modelsConverted: 3, failedModels: [], lightmapTextures: 0,
      tileTextures: 1, validatorErrors: 0, sizes: { totalBytes: 0, byCategory: {} },
      timeMs: { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0 },
    },
  }
}

describe('manifest: the wave-11 fields are additive', () => {
  it('an export with no town files validates, before and after a JSON round trip', () => {
    const m = oldManifest()
    expect(validateWorldManifest(m)).toEqual([])
    expect(validateWorldManifest(roundTrip(m))).toEqual([])
    expect('town' in m || 'town' in m.report || m.models.some(x => 'cloth' in x)).toBe(false)
  })

  it('town, models[].cloth and report.town validate when right and survive a round trip', () => {
    const m = oldManifest()
    m.town = { file: 'town.json', dressing: 'town-dressing.json' }
    m.models[1] = { ...m.models[1]!, cloth: [{ material: 'cj_streetstall_02', kind: 'awning' }, { material: 'b', kind: 'hanging', pinY: 3.5, height: 1.2 }] }
    m.report.town = { placements: { dropped: [], resnapped: [], added: [{ region: OWNER, uid: 50 }] }, models: 1, clothModels: 1, lampRows: 4 }
    expect(validateWorldManifest(m)).toEqual([])
    expect(validateWorldManifest(roundTrip(m))).toEqual([])
    const half = oldManifest()
    half.town = { file: null, dressing: 'town-dressing.json' }
    expect(validateWorldManifest(half)).toEqual([])
  })

  it('names a wrong town, cloth or report.town', () => {
    const bad = (f: (m: WorldManifest & Record<string, unknown>) => void) => {
      const m = oldManifest() as WorldManifest & Record<string, unknown>
      f(m)
      return validateWorldManifest(m).map(e => e.split(':')[0])
    }
    expect(bad(m => (m.town = { file: null, dressing: null }))).toEqual(['town'])
    expect(bad(m => (m.town = { file: '../town.json', dressing: null }))).toEqual(['town'])
    expect(bad(m => (m.town = { file: 'town.json' } as never))).toEqual(['town'])
    expect(bad(m => (m.models[1] = { ...m.models[1]!, cloth: [{ material: 'x', kind: 'flag' as never }] }))).toEqual(['models[1].cloth'])
    expect(bad(m => (m.models[1] = { ...m.models[1]!, cloth: [] }))).toEqual(['models[1].cloth'])
    expect(bad(m => (m.models[1] = { ...m.models[1]!, cloth: [{ material: 'x', kind: 'tent', height: 0 }] }))).toEqual(['models[1].cloth'])
    expect(bad(m => (m.report.town = { placements: { dropped: [], resnapped: [] }, models: 0, clothModels: 0 } as never))).toEqual(['report.town'])
  })
})

const particle = (efp: string, over: Partial<ModelParticle> = {}): ModelParticle =>
  ({ set: 'ambient', kind: 'ambient', efp, bone: null, position: [0, 5, 0], birthMs: 0, night: true, ...over })

describe('ambient.json', () => {
  const models = [
    model(0, 'static', 'res\\bldg\\china\\jangan01\\cj_luxu_light.bsr'),
    model(1, 'static', 'res\\artifact\\china\\jangan\\cj_field_lamp.bsr'),
    model(2, 'failed', 'res\\broken.bsr'),
    model(3, 'static', 'res\\nature\\tre_a.bsr#static'),
    model(4, 'static', 'res\\bldg\\china\\jangan01\\cj_weapon.bsr'),
  ]
  const parts: Record<number, ModelParticle[]> = {
    0: [particle('map/cj_pal_lamp_red_b.efp'), particle('monster/status_bad_burn.efp', { kind: 'status', set: 'status_bad_burn' })],
    4: [particle('map/oas_hot_etc_b.efp', { night: false, position: [1, 9, 2] })],
  }
  const of = (m: WorldModel) => parts[m.index] ?? null

  it('keys rows by the final model index, ambient rows only, in model order', () => {
    const w: string[] = []
    const r = buildAmbientIndex(models, of, [], w)
    expect(Object.keys(r.index.models)).toEqual(['0', '4'])
    expect(r.index.models['0']).toEqual([particle('map/cj_pal_lamp_red_b.efp')])
    expect(r.index).toMatchObject({ format: 'sro-world-ambient', version: 1 })
    expect(r.retailRows).toBe(2)
    expect(r.lampRows).toBe(0)
    expect(w).toEqual([])
  })

  it('adds the dressing lamps by base name or path, night-only, once; a lamp naming no model is a warning', () => {
    const w: string[] = []
    const r = buildAmbientIndex(models, of, [
      { model: 'cj_field_lamp', efp: 'Map\\cj_pal_lamp_light.efp', offset: [0, 3.2, 0] },
      { model: 'res/artifact/china/jangan/cj_field_lamp.bsr', efp: 'map/cj_pal_lamp_light.efp', offset: [0, 3.2, 0] },
      { model: 'bldg/china/jangan01/cj_luxu_light', efp: 'map/light.efp' },
      { model: 'cj_nowhere', efp: 'map/light.efp' },
      { model: 'tre_a', efp: 'map/light.efp' },
      { model: 'broken', efp: 'map/light.efp' },
    ], w)
    expect(r.index.models['1']).toEqual([{ set: TOWN_LAMP_SET, kind: 'ambient', efp: 'map/cj_pal_lamp_light.efp', bone: null, position: [0, 3.2, 0], birthMs: 0, night: true }])
    expect(r.index.models['0']!.map(p => p.efp)).toEqual(['map/cj_pal_lamp_red_b.efp', 'map/light.efp'])
    expect(Object.keys(r.index.models)).toEqual(['0', '1', '4'])
    expect(r.lampRows).toBe(2)
    expect(r.lampModels).toBe(2)
    expect(w).toEqual([
      'ambient: town lamp 3 (cj_nowhere) names no model of the export',
      'ambient: town lamp 4 (tre_a) names no model of the export',
      'ambient: town lamp 5 (broken) names no model of the export',
    ])
  })

  it('matches model names the way the dressing file writes them', () => {
    expect(modelKey('res\\Artifact\\china\\jangan\\CJ_Field_Lamp.bsr')).toBe('artifact/china/jangan/cj_field_lamp')
    expect(modelKey('/out/town/props/post.glb')).toBe('town/props/post')
    expect(lampMatches('cj_field_lamp', 'res\\artifact\\china\\jangan\\cj_field_lamp.bsr')).toBe(true)
    expect(lampMatches('cj_field_lamp', 'res\\artifact\\china\\jangan\\cj_field_lamp02.bsr')).toBe(false)
    expect(lampMatches('/out/town/props/post.glb', 'out/town/props/post.glb')).toBe(true)
    expect(lampMatches('jangan/cj_field_lamp', 'res\\artifact\\china\\jangan\\cj_field_lamp.bsr')).toBe(true)
  })
})

describe('the town content files', () => {
  let tmp: string | undefined
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })
  const dressing = (over: Record<string, unknown> = {}) => JSON.stringify({
    schema: TOWN_FILE_SCHEMA, kind: 'townDressing', world: 'passes', town: 'jangan', props: [], banners: [],
    lamps: [{ model: 'cj_field_lamp', efp: 'map/cj_pal_lamp_light.efp', offset: [0, 3, 0] }], decals: [], crackBands: [], ...over,
  })

  it('skips a missing file with a log line, warns on an invalid or wrong-kind one, loads a valid one', () => {
    tmp ??= mkdtempSync(join(tmpdir(), 'sro-w11-town-'))
    writeFileSync(join(tmp, 'ok.json'), dressing())
    writeFileSync(join(tmp, 'bad.json'), dressing({ lamps: [{ model: 'x', efp: 'not-an-efp' }] }))
    writeFileSync(join(tmp, 'broken.json'), '{ nope')
    const w: string[] = []
    const logs: string[] = []
    const none = loadTownContent({ file: join(tmp, 'missing.json'), dressing: join(tmp, 'missing2.json') }, 'passes', w, l => logs.push(l))
    expect(none).toEqual({ town: null, dressing: null })
    expect(w).toEqual([])
    expect(logs.filter(l => /not found/.test(l))).toHaveLength(2)
    const ok = loadTownContent({ dressing: join(tmp, 'ok.json') }, 'passes', w, () => {})
    expect(ok.dressing?.file.lamps).toHaveLength(1)
    expect(ok.dressing?.text).toBe(dressing())
    expect(w).toEqual([])
    expect(loadTownContent({ dressing: join(tmp, 'bad.json') }, 'passes', w, () => {}).dressing).toBeNull()
    expect(loadTownContent({ dressing: join(tmp, 'broken.json') }, 'passes', w, () => {}).dressing).toBeNull()
    expect(loadTownContent({ file: join(tmp, 'ok.json') }, 'passes', w, () => {}).town).toBeNull()
    expect(w).toHaveLength(3)
    expect(w[0]).toMatch(/bad\.json: 1 problem/)
    expect(w[2]).toMatch(/kind 'townDressing', expected 'town'/)
    const other: string[] = []
    expect(loadTownContent({ dressing: join(tmp, 'ok.json') }, 'jangan-fields', other, () => {}).dressing).not.toBeNull()
    expect(other).toEqual([`town: ${join(tmp, 'ok.json')} is for world 'passes', copied into 'jangan-fields'`])
  })

  it.skipIf(!hasConfig)('convertWorld copies the dressing into the export and writes manifest.town (objects off: no ambient.json)', async () => {
    tmp ??= mkdtempSync(join(tmpdir(), 'sro-w11-town-'))
    const out = join(tmp, 'world')
    writeFileSync(join(tmp, 'dressing.json'), dressing())
    // a town.json left from an earlier run is removed when its source is gone
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'town.json'), '{}')
    const order: string[] = []
    const { manifest } = await convertWorld({
      name: 'passes', regions: [{ x: 168, z: 97 }], origin: { x: 168, z: 97 }, outDir: out, objects: false, navmesh: false,
      town: { file: join(tmp, 'no-town.json'), dressing: join(tmp, 'dressing.json') },
      passes: { townDressing: () => (order.push('dressing'), { drop: [], resnap: [], add: [] }), cloth: () => (order.push('cloth'), []), staticVariants: null, grass: null },
    })
    expect(order).toEqual(['dressing', 'cloth'])
    expect(manifest.town).toEqual({ file: null, dressing: TOWN_DRESSING_FILE })
    expect(readFileSync(join(out, TOWN_DRESSING_FILE), 'utf8')).toBe(dressing())
    expect(existsSync(join(out, 'town.json'))).toBe(false)
    expect(existsSync(join(out, 'ambient.json'))).toBe(false)
    const written = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as WorldManifest
    expect(validateWorldManifest(written)).toEqual([])
    expect(written.report.town).toEqual({ placements: { dropped: [], resnapped: [], added: [] }, models: 0, clothModels: 0 })
  }, 120_000)
})
