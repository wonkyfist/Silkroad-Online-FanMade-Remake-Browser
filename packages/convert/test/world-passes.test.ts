/**
 * W10-CV (docs/WAVE_PLAN6.md §4.4, D6, D19): the converter's placement passes and the manifest's additive wave-10
 * fields.
 * - a manifest with every new optional field absent (an old export) still validates, also after a JSON round trip,
 *   and so do the exports on disk;
 * - the new fields (coast, synthetic, staticVariant, tiles[].grass, report.coast) validate when right and are named when
 *   wrong;
 * - the pipeline order: a fixture where the coast's C9 drops a uid: the static-variant and grass passes never see it,
 *   a re-snapped placement reaches them with its new y, and a variant of a model only the dropped uid used is refused
 *   (S-DRAW);
 * - with the default passes and no coast the export is unchanged (the fixture has no tile images, so GL-C's grass pass
 *   gives no entries and says so in one warning; grass-palette.test.ts covers the pass itself);
 * - convertWorld runs the injected passes and writes their results (skips without sro.config.json).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { createCoastPass } from '../src/world/coast/hook.ts'
import { convertWorld } from '../src/world/convert-world.ts'
import { grassPalettePass } from '../src/world/grass.ts'
import {
  validateWorldManifest, type TileTexture, type WorldCoast, type WorldManifest, type WorldModel, type WorldPlacement, type WorldRegion,
} from '../src/world/manifest.ts'
import { applyPlacementEdits, runWorldPasses, type WorldPassContext, type WorldPassInput } from '../src/world/passes.ts'
import { staticVariantPass } from '../src/world/static-variants.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

const region = (x: number, z: number): WorldRegion => ({
  x, z, id: (z << 8) | x,
  origin: [192 * (x - 168), 0, 192 * (97 - z)],
  bounds: { min: [192 * (x - 168), 0, 192 * (97 - z) - 192], max: [192 * (x - 168) + 192, 10, 192 * (97 - z)] },
  terrain: { file: `terrain/${x}_${z}.bin`, bytes: 1, heightMinM: 0, heightMaxM: 10, layerCount: 1, tileIds: [1, 2] },
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

const placement = (regionId: number, uid: number, models: number[], y = 1): WorldPlacement => ({
  objId: 100 + uid, source: `res\\obj${uid}.bsr`, models, compound: false,
  position: [uid, y, -uid], rotation: [0, 0, 0, 1], yaw: 0,
  flags: { static: true, big: false, struct: false }, staticFlag: 0xffff,
  uid, region: regionId, group: 3, inConvertedRegion: true,
})

/** A static variant's model (its index is assigned by the pipeline). */
function variantModel(source: string): Omit<WorldModel, 'index' | 'staticVariant'> {
  const { index: _index, ...rest } = model(0, 'static', source)
  return rest
}

const tile = (id: number, name: string): TileTexture =>
  ({ id, source: `${name}.ddj`, file: `tiles/${name}.png`, width: 256, height: 256, typeName: null, category: 'field' })

/** Owner region ids: the origin region (168, 97) and its east neighbour (169, 97). */
const OWNER = (97 << 8) | 168
const R = (97 << 8) | 169

/** An old-style export: none of the wave-10 fields. */
function oldManifest(): WorldManifest {
  const models = [model(0, 'skinned', 'res\\tree_a.bsr'), model(1, 'skinned', 'res\\tree_b.bsr'), model(2, 'static', 'res\\house.bsr')]
  const placements = [placement(OWNER, 1, [0]), placement(OWNER, 2, [1]), placement(OWNER, 3, [2]), placement(R, 1, [0])]
  return {
    format: 'sro-world', version: 1, name: 'fixture', generator: 'test', createdAt: '2026-09-30T00:00:00.000Z',
    space: {
      units: 'metre', metresPerUnit: 0.1, handedness: 'right-handed, +Y up (glTF)',
      axes: { east: [1, 0, 0], north: [0, 0, -1], up: [0, 1, 0] },
      originRegion: { x: 168, z: 97, id: OWNER }, originCorner: 'south-west', regionSizeM: 192, cellSizeM: 2,
      regionOffsetRule: 'rule', localToWorldRule: 'rule',
    },
    regions: [region(168, 97), region(169, 97)],
    tiles: [tile(1, 'c_grass_fld_01'), tile(2, 'asiaminor_sand_01')],
    water: { frames: ['water/water101.png'], frameMs: 100, ice: null, waves: [] },
    environment: { file: 'environment.json', profileIds: [0] },
    models,
    placements,
    warnings: [],
    report: {
      regions: 2, regionsSkipped: [], placementRecords: 4, placements: placements.length, dedupeConflicts: 0,
      uniqueObjectIds: 4, compoundPlacements: 0, uniqueModels: 3, modelsConverted: 3, failedModels: [], lightmapTextures: 0,
      tileTextures: 2, validatorErrors: 0, sizes: { totalBytes: 0, byCategory: {} },
      timeMs: { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0 },
    },
  }
}

const COAST: WorldCoast = {
  seaLevelM: 5,
  field: { file: 'coast/field.png', x0: -2880, z0: -1536, metresPerTexel: 4, width: 1200, height: 912 },
  mapColor: '#2a5d7c',
  sourceHash: 'sha256:0123',
}

/** Every wave-10 field present and valid. */
function newManifest(): WorldManifest {
  const m = oldManifest()
  m.coast = roundTrip(COAST)
  m.regions.push({ ...region(170, 97), synthetic: true })
  m.models.push({ ...model(3, 'static', 'res\\tree_a.bsr#static') })
  m.models[0] = { ...m.models[0]!, staticVariant: 3 }
  m.tiles[0] = { ...m.tiles[0]!, grass: { weight: 1, base: [0.13, 0.22, 0.05], tip: [0.42, 0.52, 0.17] } }
  m.tiles[1] = { ...m.tiles[1]!, grass: { weight: 0, base: [0, 0, 0], tip: [0, 0, 0] } }
  m.report.coast = { placements: { dropped: [{ region: OWNER, uid: 9 }], resnapped: [], added: [] }, emittedRegions: 1 }
  return m
}

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('manifest: the wave-10 fields are additive', () => {
  it('an old export (every new field absent) validates, before and after a JSON round trip', () => {
    const m = oldManifest()
    expect(validateWorldManifest(m)).toEqual([])
    expect(validateWorldManifest(roundTrip(m))).toEqual([])
    for (const k of ['coast'] as const) expect(k in m).toBe(false)
    expect(m.models.some(x => 'staticVariant' in x) || m.tiles.some(t => 'grass' in t) || m.regions.some(r => 'synthetic' in r)).toBe(false)
  })

  it('the exports on disk still validate', () => {
    const root = join(REPO_ROOT, 'work', 'out', 'world')
    const names = existsSync(root) ? readdirSync(root).filter(n => existsSync(join(root, n, 'manifest.json'))) : []
    for (const name of names) {
      const m = JSON.parse(readFileSync(join(root, name, 'manifest.json'), 'utf8')) as unknown
      expect(validateWorldManifest(m), name).toEqual([])
    }
  })

  it('every new field validates when right, and survives a JSON round trip', () => {
    const m = newManifest()
    expect(validateWorldManifest(m)).toEqual([])
    const back = roundTrip(m)
    expect(back).toEqual(m)
    expect(validateWorldManifest(back)).toEqual([])
  })

  it('names a wrong new field', () => {
    const bad = (edit: (m: WorldManifest) => void, what: string) => {
      const m = newManifest()
      edit(m)
      expect(validateWorldManifest(m).join('\n')).toContain(what)
    }
    bad(m => (m.models[0]!.staticVariant = 9), 'models[0].staticVariant')
    bad(m => (m.models[0]!.staticVariant = 1), 'is not static')
    bad(m => (m.models[0]!.staticVariant = 0), 'models[0].staticVariant')
    bad(m => (m.models[2]!.staticVariant = 3), 'only a skinned model')
    bad(m => ((m.regions[2] as { synthetic?: unknown }).synthetic = false), 'regions[2].synthetic')
    bad(m => (m.tiles[0]!.grass!.weight = 1.5), 'tiles[0].grass')
    bad(m => (m.tiles[1]!.grass!.tip = [0, 0, 255]), 'tiles[1].grass')
    bad(m => (m.coast = { ...COAST, mapColor: 'blue' }), 'coast.mapColor')
    bad(m => (m.coast = { ...COAST, field: { ...COAST.field, file: '../field.png' } }), 'coast.field')
    bad(m => (m.coast = { ...COAST, field: { ...COAST.field, metresPerTexel: 0 } }), 'coast.field')
    bad(m => (m.coast = { ...COAST, sourceHash: '' }), 'coast.sourceHash')
    bad(m => ((m.coast as unknown as { seaLevelM: unknown }).seaLevelM = '5'), 'coast.seaLevelM')
    bad(m => ((m.report as { coast?: unknown }).coast = { placements: { dropped: [{ region: 1 }], resnapped: [], added: [] } }), 'report.coast')
  })
})

function passInput(m: WorldManifest): WorldPassInput {
  return { outDir: '/tmp/x', origin: { x: 168, z: 97 }, regions: m.regions, tiles: m.tiles, models: m.models, placements: m.placements, warnings: [] }
}

const refs = (ps: readonly WorldPlacement[]) => ps.map(p => `${p.region}:${p.uid}`)

describe('placement passes: coast (C9) -> static variants -> grass palettes', () => {
  it('a uid the coast drops is never seen by the later passes (S-DRAW); a re-snapped one carries its new y', async () => {
    const m = oldManifest()
    const input = passInput(m)
    const before = roundTrip(input.placements)
    const order: string[] = []
    const seen: Record<string, WorldPassContext['placements']> = {}
    const added = placement(OWNER, 50, [2], 7)
    const result = await runWorldPasses(input, {
      coast: {
        placementEdits: ctx => {
          order.push('coast')
          seen.coast = ctx.placements.slice()
          return { drop: [{ region: OWNER, uid: 2 }], resnap: [{ region: OWNER, uid: 1, y: 4.25 }], add: [added] }
        },
        manifestCoast: () => COAST,
        report: () => ({ emittedRegions: 3, placements: 'ignored' }),
      },
      staticVariants: ctx => {
        order.push('static')
        seen.static = ctx.placements.slice()
        // model 1 is used only by the dropped uid 2: its variant must be refused
        return [
          { of: 0, model: variantModel('res\\tree_a.bsr#static') },
          { of: 1, model: variantModel('res\\tree_b.bsr#static') },
        ]
      },
      grass: ctx => {
        order.push('grass')
        seen.grass = ctx.placements.slice()
        expect(ctx.models.find(x => x.index === 0)!.staticVariant).toBe(3)
        return [{ id: 1, grass: { weight: 1, base: [0.1, 0.2, 0.05], tip: [0.4, 0.5, 0.2] } }, { id: 77, grass: { weight: 1, base: [0, 0, 0], tip: [0, 0, 0] } }]
      },
    })
    expect(order).toEqual(['coast', 'static', 'grass'])
    expect(refs(seen.coast!)).toContain(`${OWNER}:2`)
    for (const k of ['static', 'grass'] as const) {
      expect(refs(seen[k]!)).not.toContain(`${OWNER}:2`)
      expect(seen[k]!.find(p => p.region === OWNER && p.uid === 1)!.position[1]).toBe(4.25)
      expect(refs(seen[k]!)).toContain(`${OWNER}:50`)
    }
    expect(refs(result.placements)).toEqual([`${OWNER}:1`, `${OWNER}:3`, `${OWNER}:50`, `${R}:1`])
    // the input is untouched
    expect(input.placements).toEqual(before)
    // S-DRAW: only the variant of a model a remaining placement uses
    expect(result.models.map(x => x.index)).toEqual([0, 1, 2, 3])
    expect(result.models[0]!.staticVariant).toBe(3)
    expect(result.models[1]!.staticVariant).toBeUndefined()
    expect(result.models[3]).toMatchObject({ index: 3, kind: 'static', source: 'res\\tree_a.bsr#static' })
    expect(input.warnings.join('\n')).toContain('no placement uses the model')
    // grass: known tiles only
    expect(result.tiles[0]!.grass!.weight).toBe(1)
    expect(result.tiles[1]!.grass).toBeUndefined()
    expect(input.warnings.join('\n')).toContain('unknown tile 77')
    // coast manifest and report; the pipeline's placement report wins
    expect(result.coast).toEqual(COAST)
    expect(result.coastReport!.emittedRegions).toBe(3)
    expect(result.coastReport!.placements).toEqual({
      dropped: [{ region: OWNER, uid: 2 }], resnapped: [{ region: OWNER, uid: 1, fromY: 1, toY: 4.25 }], added: [{ region: OWNER, uid: 50 }],
    })
    // the result is a valid manifest
    const out: WorldManifest = {
      ...m, placements: result.placements, models: result.models, tiles: result.tiles, coast: result.coast!,
      report: { ...m.report, placements: result.placements.length, coast: result.coastReport! },
    }
    expect(validateWorldManifest(out)).toEqual([])
  })

  it('with the default passes and no coast, the export is unchanged', async () => {
    const m = oldManifest()
    const input = passInput(m)
    const result = await runWorldPasses(input, { coast: null, staticVariants: staticVariantPass, grass: grassPalettePass })
    expect(result.placements).toEqual(m.placements)
    expect(result.models).toEqual(m.models)
    expect(result.tiles).toEqual(m.tiles)
    expect('coast' in result || 'coastReport' in result).toBe(false)
    // no tile images under outDir: the grass pass leaves the tiles to the runtime's rule, in one warning
    expect(input.warnings).toHaveLength(1)
    expect(input.warnings[0]).toMatch(/^grass palettes: 2 tile image\(s\) unreadable/)
  })

  it('applyPlacementEdits: unknown refs, re-snaps of dropped ones and colliding adds are warnings', () => {
    const m = oldManifest()
    const warnings: string[] = []
    const r = applyPlacementEdits(m.placements, {
      drop: [{ region: OWNER, uid: 3 }, { region: OWNER, uid: 3 }, { region: OWNER, uid: 99 }],
      resnap: [{ region: OWNER, uid: 3, y: 2 }, { region: 1, uid: 1, y: 2 }, { region: R, uid: 1, y: Number.NaN }],
      add: [placement(OWNER, 1, [0]), placement(OWNER, 60, [9]), placement(OWNER, 0, [2])],
    }, m.models.length, warnings)
    expect(refs(r.placements)).toEqual([`${OWNER}:0`, `${OWNER}:1`, `${OWNER}:2`, `${R}:1`])
    expect(r.report.dropped).toEqual([{ region: OWNER, uid: 3 }])
    expect(r.report.resnapped).toEqual([])
    expect(r.report.added).toEqual([{ region: OWNER, uid: 0 }])
    expect(warnings).toHaveLength(6)
  })

  it('the coast hook reads its config first (CST-C landed it: a missing config fails before any archive is opened)', async () => {
    await expect(createCoastPass({ configFile: '/x/coast.json', outDir: '/x', origin: { x: 168, z: 97 }, regions: [], warnings: [], log: () => {} }))
      .rejects.toThrow(/coast\.json/)
  })
})

describe.skipIf(!hasConfig)('convertWorld runs the placement passes', () => {
  let tmp: string | undefined
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('writes manifest.coast, report.coast and tiles[].grass from injected passes', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'sro-passes-'))
    const order: string[] = []
    const { manifest } = await convertWorld({
      name: 'passes', regions: [{ x: 168, z: 97 }], origin: { x: 168, z: 97 }, outDir: tmp, objects: false, navmesh: false,
      passes: {
        coast: { placementEdits: () => (order.push('coast'), { drop: [], resnap: [], add: [] }), manifestCoast: () => COAST },
        staticVariants: () => (order.push('static'), []),
        grass: ctx => (order.push('grass'), [{ id: ctx.tiles[0]!.id, grass: { weight: 0.5, base: [0.1, 0.1, 0.1], tip: [0.5, 0.5, 0.5] } }]),
      },
    })
    expect(order).toEqual(['coast', 'static', 'grass'])
    const written = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8')) as WorldManifest
    expect(validateWorldManifest(written)).toEqual([])
    expect(written.coast).toEqual(COAST)
    expect(written.report.coast!.placements).toEqual({ dropped: [], resnapped: [], added: [] })
    expect(written.tiles[0]!.grass!.weight).toBe(0.5)
    expect(manifest.tiles.slice(1).every(t => t.grass === undefined)).toBe(true)
  }, 120_000)
})
