/**
 * WE-D (docs/WAVE_PLAN8.md §6.2; docs/WORLD_EDITOR.md §3.2, §3.6, §4.1, §4.8): the world edits applied in the
 * converter: the terrain overlay (heights in file units as the nav rule adds them, paint, water, unchanged blocks and
 * regions kept as objects), the global lattice across region seams, the touched regions, and the placement pass (a
 * move as a drop + an add of the same key, a move out of its region under a fresh editor uid, adds by source, props on
 * moved ground snapped or listed), all deterministic.
 */
import { describe, expect, it } from 'vitest'
import { emptyHeightLayer, emptyPaintLayer, navHeightsAfter, paintWord, regionIdOf, type WorldEditPlacementsFile } from '../../shared/src/world-edits/index.ts'
import {
  applyTerrainEdits, EditLattice, editedFileHeight, emptyWorldEditsLayers, touchedRegions, vertexHolders, type WorldEditsLayers,
} from '../src/world/edits/layers.ts'
import { buildWorldEditsRun } from '../src/world/edits/index.ts'
import { createEditsPass, editsPassResult } from '../src/world/edits/placements.ts'
import { runWorldPasses, type WorldPassInput } from '../src/world/passes.ts'
import { model, ORIGIN, placement, regionEntry, regionTerrain } from './world-edits-fixture.ts'

const A = regionIdOf(168, 97)
const B = regionIdOf(169, 97)
const ground = (ggx: number, ggz: number) => 100 + ((ggx * 7 + ggz * 13) % 17) * 0.37

function heightEdit(vertices: Array<[number, number, number]>) {
  const l = emptyHeightLayer()
  for (const [gx, gz, d] of vertices) {
    l.mask[gz * 97 + gx] = 1
    l.delta[gz * 97 + gx] = d
  }
  return l
}

describe('the terrain overlay', () => {
  it('adds delta x 10 in float32 file units (the nav rule\'s arithmetic); untouched vertices keep their bits', () => {
    const base = regionTerrain(168, 97, ground)
    const layers = emptyWorldEditsLayers('jangan-fields')
    layers.height.set(A, heightEdit([[10, 10, 2.5], [11, 10, -0.00390625], [12, 10, 0]]))
    const lattice = new EditLattice(layers.height, layers.paint)
    const r = applyTerrainEdits(168, 97, base, lattice, [])
    expect(r.changed).toBe(true)
    expect(r.heightVertices).toBe(2)
    const g = r.terrain!.grid.heights
    const nav = navHeightsAfter(base.grid.heights, layers.height.get(A))
    for (let i = 0; i < g.length; i++) expect(g[i]).toBe(nav[i])
    expect(g[10 * 97 + 10]).toBe(editedFileHeight(base.grid.heights[10 * 97 + 10]!, 2.5))
    expect(g[10 * 97 + 12]).toBe(base.grid.heights[10 * 97 + 12])
    // only the block holding the edit is rebuilt; every other block is the base object
    const rebuilt = r.terrain!.mapm.blocks.filter((b, k) => b !== base.mapm.blocks[k])
    expect(rebuilt.map(b => b.index)).toEqual([0])
    expect(r.terrain!.mapm.blocks[0]!.heightMax).toBe(Math.max(...r.terrain!.mapm.blocks[0]!.heights))
  })

  it('a region the edits leave alone comes back as the base object (byte-identical export)', () => {
    const base = regionTerrain(168, 97, ground)
    const layers = emptyWorldEditsLayers('jangan-fields')
    layers.height.set(A, heightEdit([[5, 5, 0]]))
    const r = applyTerrainEdits(168, 97, base, new EditLattice(layers.height, layers.paint), [])
    expect(r.changed).toBe(false)
    expect(r.terrain).toBe(base)
    expect(applyTerrainEdits(168, 97, null, new EditLattice(layers.height, layers.paint), []).terrain).toBeNull()
  })

  it('a block edge vertex rebuilds both blocks (no stale copy can win the assembly)', () => {
    const base = regionTerrain(168, 97, ground)
    const layers = emptyWorldEditsLayers('jangan-fields')
    layers.height.set(A, heightEdit([[16, 16, 1]]))
    const r = applyTerrainEdits(168, 97, base, new EditLattice(layers.height, layers.paint), [])
    const rebuilt = r.terrain!.mapm.blocks.filter((b, k) => b !== base.mapm.blocks[k]).map(b => b.index)
    expect(rebuilt).toEqual([0, 1, 6, 7])
    expect(r.terrain!.grid.edgeConflicts).toEqual([])
    expect(r.terrain!.grid.heights[16 * 97 + 16]).toBe(editedFileHeight(base.grid.heights[16 * 97 + 16]!, 1))
  })

  it('paints texture words and sets water blocks (kind water, wave kept where the block had water)', () => {
    const base = regionTerrain(168, 97, ground, () => 1, (bx, bz) => (bx === 2 && bz === 2 ? { type: 0, height: 950 } : null))
    const layers = emptyWorldEditsLayers('jangan-fields')
    const paint = emptyPaintLayer()
    paint.mask[20 * 97 + 20] = 1
    paint.words[20 * 97 + 20] = paintWord(37, 2)
    layers.paint.set(A, paint)
    layers.water = [{ id: 'w1', region: A, blocks: [[0, 0], [2, 2]], heightM: 101.25 }]
    const r = applyTerrainEdits(168, 97, base, new EditLattice(layers.height, layers.paint), layers.water)
    expect(r.paintVertices).toBe(1)
    expect(r.waterBlocks).toBe(2)
    const t = r.terrain!
    expect(t.grid.textures[20 * 97 + 20]).toBe(paintWord(37, 2))
    expect(t.grid.textureIds[20 * 97 + 20]).toBe(37)
    const b0 = t.mapm.blocks[0]!
    expect([b0.waterType, b0.waterWaveType, b0.waterHeight]).toEqual([0, 0, Math.fround(1012.5)])
    const b22 = t.mapm.blocks[14]!
    expect([b22.waterType, b22.waterWaveType, b22.waterHeight]).toEqual([0, 2, Math.fround(1012.5)])
  })

  it('a seam vertex gets the same edit in every holder, even when only one holder\'s file carries it', () => {
    const layers = emptyWorldEditsLayers('jangan-fields')
    // region A's east column (gx 96) is region B's west column (gx 0); only A's file has the stroke
    layers.height.set(A, heightEdit([[96, 40, 3], [95, 40, 2]]))
    const lattice = new EditLattice(layers.height, layers.paint)
    const a = applyTerrainEdits(168, 97, regionTerrain(168, 97, ground), lattice, [])
    const b = applyTerrainEdits(169, 97, regionTerrain(169, 97, ground), lattice, [])
    expect(b.changed).toBe(true)
    expect(b.terrain!.grid.heights[40 * 97]).toBe(a.terrain!.grid.heights[40 * 97 + 96])
    expect(lattice.seamProblems().join()).toContain('height/168_97: 1 seam vertex')
    expect(vertexHolders(169 * 96, 97 * 96 + 40).map(h => `${h.rx},${h.rz}`)).toEqual(['169,97', '168,97'])
  })

  it('the run\'s height() gives the edited file units of a vertex once a holder region was built', () => {
    const layers = emptyWorldEditsLayers('jangan-fields')
    layers.height.set(A, heightEdit([[96, 40, 3]]))
    const run = buildWorldEditsRun(layers, { dir: '', world: 'jangan-fields', outDir: '/nonexistent', origin: ORIGIN, regions: [{ x: 168, z: 97 }], warnings: [], log: () => {} })
    const ggx = 169 * 96
    const ggz = 97 * 96 + 40
    expect(run.height!(ggx, ggz)).toBeUndefined()
    const t = run.terrain!(168, 97, regionTerrain(168, 97, ground))!
    expect(run.height!(ggx, ggz)).toBe(t.grid.heights[40 * 97 + 96])
    expect(run.height!(ggx + 1, ggz)).toBeUndefined()
  })
})

describe('the touched regions', () => {
  it('edited ground, paint and water, plus every region a shadow can reach', () => {
    const layers = emptyWorldEditsLayers('jangan-fields')
    layers.height.set(A, heightEdit([[48, 48, 1]]))
    expect([...touchedRegions(layers, ORIGIN)]).toEqual([A])
    // a 60 m hill near the west border reaches the west neighbour
    layers.height.set(A, heightEdit([[4, 48, 60]]))
    expect([...touchedRegions(layers, ORIGIN)].sort()).toEqual([regionIdOf(167, 97), A].sort())
    const l2 = emptyWorldEditsLayers('jangan-fields')
    l2.water = [{ id: 'w', region: B, blocks: [[0, 0]], heightM: 1 }]
    expect([...touchedRegions(l2, ORIGIN)]).toEqual([B])
    // an add 10 m from the region's south-east corner: the four regions around it
    l2.water = []
    l2.placements = { format: 'sro-world-edits-placements', version: 1, world: 'jangan-fields', move: [], drop: [], add: [{ id: 'ed-1', source: 's', position: [182, 0, -10], yaw: 0 }] }
    expect([...touchedRegions(l2, ORIGIN)].sort((a, b) => a - b)).toEqual(
      [regionIdOf(168, 96), regionIdOf(169, 96), regionIdOf(168, 97), regionIdOf(169, 97)].sort((a, b) => a - b))
  })
})

// --- the placement pass -----------------------------------------------------------------------------------------------

const TREE = 'res\\nature\\china\\jangan\\tree\\tre_a.bsr'
const HOUSE = 'res\\bldg\\china\\house.bsr'
const ROCK = 'res\\nature\\china\\jangan\\stone01.bsr'

function passFixture(): WorldPassInput {
  const models = [model(0, TREE), model(1, HOUSE), model(2, ROCK)]
  const placements = [
    placement(A, 10, [0], TREE, [20, 100, -20]),
    placement(A, 11, [1], HOUSE, [40, 100, -20], 500),
    placement(A, 12, [2], ROCK, [60, 100, -20], 600),
    placement(A, 13, [0], TREE, [100, 100, -100]),
  ]
  return { outDir: '/tmp/none', origin: ORIGIN, regions: [regionEntry(168, 97), regionEntry(169, 97)], tiles: [], models, placements, warnings: [] }
}

function editsFile(e: Partial<WorldEditPlacementsFile>): WorldEditPlacementsFile {
  return { format: 'sro-world-edits-placements', version: 1, world: 'jangan-fields', move: [], drop: [], add: [], ...e }
}

const passOpts = (layers: WorldEditsLayers) => ({
  layers, lattice: new EditLattice(layers.height, layers.paint),
  isVegetation: (s: string) => /\\tree\\/i.test(s), footprint: (objId: number) => objId === 500,
})

describe('the placement pass', () => {
  it('a move is a drop + an add of the same key; a move out of the region and an add take editor uids', async () => {
    const input = passFixture()
    const layers = emptyWorldEditsLayers('jangan-fields')
    layers.placements = editsFile({
      move: [
        { region: A, uid: 10, source: TREE, from: { position: [20, 100, -20], yaw: 0 }, to: { position: [25, 101, -22], yaw: 0.5, scale: 1.1 } },
        { region: A, uid: 12, source: ROCK, from: { position: [60, 100, -20], yaw: 0 }, to: { position: [200, 100, -20], yaw: 0 } },
      ],
      drop: [{ region: A, uid: 13, source: TREE, from: { position: [100, 100, -100], yaw: 0 } }],
      add: [{ id: 'ed-1', source: HOUSE, position: [50, 100, -50], yaw: 1 }, { id: 'ed-2', source: 'res\\unknown.bsr', position: [5, 0, -5], yaw: 0 }],
    })
    const out = await runWorldPasses(input, { worldEdits: createEditsPass(passOpts(layers)) })
    const byKey = new Map(out.placements.map(p => [`${p.region}:${p.uid}`, p]))
    expect(byKey.get(`${A}:10`)).toMatchObject({ position: [25, 101, -22], yaw: 0.5, scale: 1.1, objId: 110 })
    expect(byKey.get(`${A}:12`)).toBeUndefined()
    expect(byKey.get(`${B}:${0xe000}`)).toMatchObject({ source: ROCK, objId: 600, position: [200, 100, -20], inConvertedRegion: true })
    expect(byKey.get(`${A}:13`)).toBeUndefined()
    expect(byKey.get(`${A}:${0xe000}`)).toMatchObject({ source: HOUSE, objId: 500, models: [1], yaw: 1 })
    expect(byKey.get(`${A}:${0xe000}`)!.scale).toBeUndefined()
    expect(input.warnings.join()).toContain('add ed-2: unknown model source')
    expect(out.editsReport!.placements.dropped.map(d => d.uid).sort()).toEqual([10, 12, 13])
    expect(out.editsReport!.placements.added.map(d => d.uid).sort()).toEqual([10, 0xe000, 0xe000])
  })

  it('objects on moved ground: vegetation and footprint-free props follow it, footprint objects are listed', () => {
    const input = passFixture()
    const layers = emptyWorldEditsLayers('jangan-fields')
    // raise the ground under the tree (20, -20), the house (40, -20) and the rock (60, -20) by 2 m: vertices around them
    const l = emptyHeightLayer()
    for (let gz = 5; gz <= 15; gz++) for (let gx = 5; gx <= 35; gx++) {
      l.mask[gz * 97 + gx] = 1
      l.delta[gz * 97 + gx] = 2
    }
    layers.height.set(A, l)
    const r = editsPassResult({ ...input, log: () => {} }, passOpts(layers))
    expect(r.edits.resnap.map(s => [s.uid, s.y])).toEqual([[10, 102], [12, 102]])
    expect(r.listed).toEqual([{ region: A, uid: 11, source: HOUSE, deltaM: 2 }])
    expect([...r.resnapped].sort()).toEqual([`${A}:10`, `${A}:12`])
  })

  it('is deterministic: the same layers give the same placements twice', async () => {
    const run = async () => {
      const input = passFixture()
      const layers = emptyWorldEditsLayers('jangan-fields')
      layers.placements = editsFile({ add: [{ id: 'ed-3', source: TREE, position: [30, 100, -30], yaw: 0.25, scale: 0.9 }] })
      return JSON.stringify((await runWorldPasses(input, { worldEdits: createEditsPass(passOpts(layers)) })).placements)
    }
    expect(await run()).toBe(await run())
  })
})
