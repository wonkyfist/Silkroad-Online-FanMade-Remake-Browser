/**
 * Wave 12 integration (I-12, docs/WAVE_PLAN8.md §6.5, §6.6), the converter's side of the cross-item tests and the
 * delivery checks:
 *
 * - a planted tree: the editor's add of a species carrier (content/trees/library.json's `carrier`) runs through the
 *   placement passes (world edits, step 6, then the tree swap, step 7): it keeps the carrier model (Low draws the
 *   retail tree), the carrier carries `treeSwap` (Medium draws the species), it takes an editor uid, its walking
 *   footprint goes to the nav step as a put with the carrier's object id, and its baked ground shadow is cast by the
 *   species' LOD1 with the fit (D18);
 * - an empty edit layer (palette.json only, what wave 12 shipped, D37) makes no edits run, so every export file stays
 *   byte-identical (G7; X2 compared the real export against X1); the real layer folder holds the map edits made since
 *   (World Editor → Publish) and must always read back clean;
 * - delivery: the game never imports the editor (its API, its page or its tools), the mini PC builds only @sro/game,
 *   and the deploy sends neither the editor's staging exports nor the tree tool's work products.
 *
 * The world-render side (the swap, bands, overlay, preview, live switch, crowded rule, hero flip, paving bit) is
 * packages/world-render/test/w12-cross.test.ts.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  lowerPlacementEdits, placementNavEdits, regionIdOf, type WorldEditPlacementsFile,
} from '../../shared/src/world-edits/index.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { createWorldEdits, layerFiles, readWorldEditsLayers } from '../src/world/edits/index.ts'
import { EditLattice, emptyWorldEditsLayers } from '../src/world/edits/layers.ts'
import { createEditsPass } from '../src/world/edits/placements.ts'
import { casterOf } from '../src/world/edits/shadows.ts'
import type { WorldModel } from '../src/world/manifest.ts'
import { runWorldPasses, type WorldPassInput } from '../src/world/passes.ts'
import { EDITOR_UID_MAX, EDITOR_UID_MIN } from '../src/world/uids.ts'
import { model, ORIGIN, placement, regionEntry } from './world-edits-fixture.ts'

const A = regionIdOf(168, 97)

interface LibraryRow { id: string; carrier: string; scaleRange: [number, number] }
const library = JSON.parse(readFileSync(join(REPO_ROOT, 'content/trees/library.json'), 'utf8')) as { species: LibraryRow[] }
const swapRows = JSON.parse(readFileSync(join(REPO_ROOT, 'content/trees/swap.json'), 'utf8')) as { swaps: Record<string, { species: string }> }

const bare = (m: WorldModel): Omit<WorldModel, 'index' | 'staticVariant'> => {
  const { index: _i, ...rest } = m
  return rest
}

describe('I-12: a planted tree through the converter (D16, D18)', () => {
  const pine = library.species.find(s => s.id === 'pine07')!
  const HOUSE = 'res\\bldg\\china\\house.bsr'

  it('the library\'s carriers are swap sources: every species is planted as a retail model the swap replaces', () => {
    const norm = (s: string) => s.replace(/\//g, '\\').toLowerCase()
    const sources = new Map(Object.entries(swapRows.swaps).map(([src, r]) => [norm(src), r.species]))
    expect(library.species.length).toBe(35)
    for (const s of library.species) expect(sources.get(norm(s.carrier)), `${s.id}: ${s.carrier}`).toBe(s.id)
  })

  it('keeps the carrier (Low: retail), carries treeSwap (Medium: the species), takes an editor uid, a footprint and the species\' LOD1 shadow', async () => {
    expect(pine).toBeDefined()
    const models = [model(0, pine.carrier, { boundsMin: [-2, 0, -2], boundsMax: [2, 9, 2] }), model(1, HOUSE)]
    const input: WorldPassInput = {
      outDir: '/tmp/none', origin: ORIGIN, regions: [regionEntry(168, 97)], tiles: [], models,
      placements: [placement(A, 10, [0], pine.carrier, [20, 100, -20], 7), placement(A, 11, [1], HOUSE, [40, 100, -20], 500)],
      warnings: [],
    }
    const layers = emptyWorldEditsLayers('jangan-fields')
    const file: WorldEditPlacementsFile = {
      format: 'sro-world-edits-placements', version: 1, world: 'jangan-fields', move: [], drop: [],
      add: [{ id: 'ed-1', source: pine.carrier, position: [60, 100, -60], yaw: 0.4, scale: 1.1 }],
    }
    layers.placements = file
    const species = bare(model(0, 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', { boundsMin: [-3, 0, -3], boundsMax: [3, 10, 3] }))
    const out = await runWorldPasses(input, {
      worldEdits: createEditsPass({
        layers, lattice: new EditLattice(layers.height, layers.paint),
        isVegetation: s => /\\tree\\/i.test(s), footprint: objId => objId === 7 || objId === 500,
      }),
      treeSwap: () => ({ species: [species], swaps: [{ model: 0, species: 0, fit: [1.05, 0.95, 1.05], tint: 0 }] }),
    })
    const added = out.placements.find(p => p.region === A && p.uid >= EDITOR_UID_MIN && p.uid <= EDITOR_UID_MAX)!
    expect(added).toBeDefined()
    expect(added.uid).toBe(EDITOR_UID_MIN)
    // Low: the retail carrier model; the planted scale through S-SCALE (trees 0.85–1.15, D17)
    expect(added.models).toEqual([0])
    expect(added.scale).toBe(1.1)
    expect(added.objId).toBe(7)
    // Medium: the carrier's treeSwap names the species the swap appended
    const sp = out.models.findIndex(m => m.source.endsWith('pine07.bsr#species'))
    expect(sp).toBeGreaterThan(1)
    expect(out.models[0]!.treeSwap).toMatchObject({ model: sp, fit: [1.05, 0.95, 1.05] })
    expect(out.treesReport).toEqual({ species: 1, swapped: 1 })
    // the baked ground shadow: the species' LOD1 with the fit (D18), never the retail carrier's LOD0
    const caster = casterOf(added, out.models)!
    expect(caster.parts).toEqual([{ model: sp, tier: 1, fit: [1.05, 0.95, 1.05], min: [-3, 0, -3], max: [3, 10, 3] }])
    expect(caster.scale).toBe(1.1)
    // the walking footprint: the nav step's put for the editor uid with the carrier's object id (the same lowering as
    // the converter's nav step: shared lowerPlacementEdits + placementNavEdits)
    type P = { region: number; uid: number; source: string; position: [number, number, number]; rotation: [number, number, number, number]; yaw: number; scale?: number; objId: number }
    const objIdOf = (s: string) => (s === pine.carrier ? 7 : s === HOUSE ? 500 : -1)
    const lowered = lowerPlacementEdits<P>([], file, {
      originRegion: ORIGIN,
      create: (a, region, uid) => ({ region, uid, source: a.source, position: [...a.position] as [number, number, number], rotation: [0, 0, 0, 1], yaw: a.yaw, objId: objIdOf(a.source) }),
    })
    const nav = placementNavEdits<P>([], lowered, { originRegion: ORIGIN, footprint: p => p.objId === 7 || p.objId === 500 })
    expect(nav.remove).toEqual([])
    expect(nav.put).toHaveLength(1)
    expect(nav.put[0]).toMatchObject({ id: ((A & 0xffff) << 16 | EDITOR_UID_MIN) >>> 0, objId: 7 })
  })
})

describe('I-12: the edit layer (D37, G7)', () => {
  const dir = join(REPO_ROOT, 'content/world-edits/jangan-fields')

  it('palette.json only: no layer file, so the edits pass makes no run and the export stays byte-identical', async () => {
    expect(existsSync(join(dir, 'palette.json'))).toBe(true)
    const empty = mkdtempSync(join(tmpdir(), 'sro-i12-'))
    try {
      copyFileSync(join(dir, 'palette.json'), join(empty, 'palette.json'))
      expect(layerFiles(empty)).toEqual([])
      const warnings: string[] = []
      const run = await createWorldEdits({
        dir: empty, world: 'jangan-fields', outDir: join(REPO_ROOT, 'work/tmp/none-i12'), origin: ORIGIN, regions: [regionEntry(168, 97)], warnings, log: () => {},
      } as Parameters<typeof createWorldEdits>[0])
      expect(run).toBeNull()
      expect(warnings).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('the real layer folder (the published map edits of the editor) reads back without a problem', async () => {
    const r = await readWorldEditsLayers(dir, { world: 'jangan-fields' })
    expect(r.problems).toEqual([])
    expect(r.unknown).toEqual([])
  })
})

describe('I-12: delivery (WAVE_PLAN8 D32, §3.4)', () => {
  /** Every .ts file under a folder (no node_modules, no dist). */
  const tsFiles = (root: string): string[] => {
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        if (e === 'node_modules' || e === 'dist') continue
        const f = join(d, e)
        if (statSync(f).isDirectory()) walk(f)
        else if (/\.ts$/.test(e)) out.push(f)
      }
    }
    walk(root)
    return out
  }

  it('the game never imports the World Editor (its API, page or tools) nor the converter\'s edit pipeline', () => {
    const bad: string[] = []
    for (const f of tsFiles(join(REPO_ROOT, 'apps/game/src'))) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? ''
        if (/apps\/viewer|viewer\/src|editor-api|\/editor\/|world\/edits\/|world-edit/.test(spec) && !/world-edits\/index\.ts$|@sro\/shared/.test(spec)) {
          bad.push(`${relative(REPO_ROOT, f)}: ${spec}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('the mini PC builds only @sro/game; the deploy skips the editor\'s staging exports and the tree tool\'s work products', () => {
    const install = readFileSync(join(REPO_ROOT, 'deploy/remote/install.sh'), 'utf8')
    const builds = [...install.matchAll(/pnpm --filter (\S+) build/g)].map(m => m[1])
    expect([...new Set(builds)]).toEqual(['@sro/game'])
    const cfg = readFileSync(join(REPO_ROOT, 'deploy/config.sh'), 'utf8')
    const exclude = /DEPLOY_ASSET_EXCLUDE:=([^}"]+)/.exec(cfg)![1]!.split(',')
    for (const e of ['out:world/*-edit', 'out-opt:world/*-edit', 'out:trees', 'out-opt:trees']) expect(exclude, e).toContain(e)
    // the species the game reads live under the world export (models/trees), which ships
    expect(exclude.some(e => /world\/[^*]*models|models\/trees/.test(e))).toBe(false)
  })
})
