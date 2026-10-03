/**
 * F-12 (H12-PS-3, NT4): the converter's read of the edit layers is matched against the export it converts: a move or
 * drop of an object that changed or moved since the edit, or an unknown placement, is a problem (the whole layer set is
 * refused, never a silent per-edit skip that the nav step would not mirror), and the scale classes are enforced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { regionIdOf, WORLD_EDITS_PLACEMENTS_FORMAT } from '../../shared/src/world-edits/index.ts'
import { createWorldEdits, editsExportContext, modelKindOf, readWorldEditsLayers } from '../src/world/edits/index.ts'
import { model, ORIGIN, placement } from './world-edits-fixture.ts'

const tmp = mkdtempSync(join(tmpdir(), 'sro-f12-edits-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const HOME = regionIdOf(168, 97)
const TREE = 'res\\nature\\common\\tree\\tre_pine07_04.bsr'
const STONE = 'res\\nature\\common\\stone_field03.bsr'

function layerDir(name: string, file: object): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'placements.json'), JSON.stringify({ format: WORLD_EDITS_PLACEMENTS_FORMAT, version: 1, world: 'jangan-fields', move: [], drop: [], add: [], ...file }))
  return dir
}

const prePass = {
  placements: [placement(HOME, 7, [0], TREE, [10, 5, -10]), placement(HOME, 8, [1], STONE, [20, 5, -20])],
  models: [model(0, TREE), model(1, STONE)],
}

describe('F-12: the edit layers against the export', () => {
  it('a move of an object that moved since the edit refuses the layers (H12-PS-3)', async () => {
    const dir = layerDir('moved', { move: [{ region: HOME, uid: 7, source: TREE, from: { position: [12, 5, -10], yaw: 0 }, to: { position: [14, 5, -10], yaw: 0 } }] })
    const warnings: string[] = []
    const run = await createWorldEdits({ dir, world: 'jangan-fields', outDir: join(tmp, 'out'), origin: ORIGIN, regions: [{ x: 168, z: 97 }], warnings, log: () => {}, prePass })
    expect(run).toBeNull()
    expect(warnings.join('\n')).toMatch(/moved under the edit/)
  })

  it('a drop of a placement the export does not have, or whose object changed, is a problem', async () => {
    const ctx = editsExportContext(prePass)
    const dir = layerDir('unknown', { drop: [
      { region: HOME, uid: 99, source: TREE, from: { position: [10, 5, -10], yaw: 0 } },
      { region: HOME, uid: 8, source: TREE, from: { position: [20, 5, -20], yaw: 0 } },
    ] })
    const r = await readWorldEditsLayers(dir, { world: 'jangan-fields', origin: ORIGIN, placement: ctx.placement, modelKind: ctx.modelKind })
    expect(r.problems.join('\n')).toMatch(/unknown placement/)
    expect(r.problems.join('\n')).toMatch(/changed under the edit/)
  })

  it("the live export's re-snapped y is the reference where the object still stands at the same spot", () => {
    const ctx = editsExportContext({ placements: prePass.placements, live: [{ ...prePass.placements[0]!, position: [10, 7.5, -10] }] })
    expect(ctx.placement(HOME, 7)!.position).toEqual([10, 7.5, -10])
    expect(ctx.placement(HOME, 8)!.position).toEqual([20, 5, -20])
  })

  it('a kept edit (the live export holds its own move) is not the reference of the next publish (publish 11)', async () => {
    // a kept publish moved HOME:7 down onto flattened ground (the editor's follow: same x/z) and HOME:8, which the coast
    // had re-snapped 5 -> 7.5, 5 m east; the live export holds both at their `to` and its report lists them as edits
    const live = [{ ...prePass.placements[0]!, position: [10, -20, -10] }, { ...prePass.placements[1]!, position: [25, 7.5, -20] }]
    const refs = [{ region: HOME, uid: 7 }, { region: HOME, uid: 8 }]
    const liveReport = {
      edits: { placements: { dropped: refs, added: refs, resnapped: [] }, models: 0, staticVariants: 0 },
      coast: { placements: { dropped: [], resnapped: [{ region: HOME, uid: 8, fromY: 5, toY: 7.5 }], added: [] } },
    }
    const kept = layerDir('kept', { move: [
      { region: HOME, uid: 7, source: TREE, from: { position: [10, 5, -10], yaw: 0 }, to: { position: [10, -20, -10], yaw: 0 } },
      { region: HOME, uid: 8, source: STONE, from: { position: [20, 7.5, -20], yaw: 0 }, to: { position: [25, 7.5, -20], yaw: 0 } },
    ] })
    // without the report the kept vertical move is taken for a coast re-snap and refuses the same layers again
    const old = editsExportContext({ placements: prePass.placements, live })
    const before = await readWorldEditsLayers(kept, { world: 'jangan-fields', origin: ORIGIN, placement: old.placement, modelKind: old.modelKind })
    expect(before.problems.join('\n')).toMatch(/move\[0\]\.from: the object moved under the edit \(25\.000 m\)/)
    // the export without the layers: the pre-pass position, with the coast's y
    const ctx = editsExportContext({ placements: prePass.placements, live, liveReport })
    expect(ctx.placement(HOME, 7)!.position).toEqual([10, 5, -10])
    expect(ctx.placement(HOME, 8)!.position).toEqual([20, 7.5, -20])
    // the nav step lowers against the same list (placements), so it applies what the pass applies
    expect(ctx.placements.map(p => p.position[1])).toEqual([5, 7.5])
    const r = await readWorldEditsLayers(kept, { world: 'jangan-fields', origin: ORIGIN, placement: ctx.placement, modelKind: ctx.modelKind })
    expect(r.problems).toEqual([])
    // an object that really moved since the edit is still refused
    const stale = layerDir('kept-stale', { move: [{ region: HOME, uid: 7, source: TREE, from: { position: [10, 30, -10], yaw: 0 }, to: { position: [10, -20, -10], yaw: 0 } }] })
    const r2 = await readWorldEditsLayers(stale, { world: 'jangan-fields', origin: ORIGIN, placement: ctx.placement, modelKind: ctx.modelKind })
    expect(r2.problems.join('\n')).toMatch(/moved under the edit \(25\.000 m\)/)
  })

  it('the scale classes hold with and without the export (NT4)', async () => {
    expect(modelKindOf(TREE)).toBe('tree')
    expect(modelKindOf('res\\bldg\\china\\jangan\\cj_house01.bsr')).toBe('blocker')
    expect(modelKindOf(STONE)).toBe('prop')
    const ctx = editsExportContext(prePass)
    expect(ctx.modelKind('res\\nature\\common\\nothing.bsr')).toBeUndefined()
    const dir = layerDir('scale', { add: [{ id: 'ed-1', source: TREE, position: [30, 5, -30], yaw: 0, scale: 0.5 }] })
    const r = await readWorldEditsLayers(dir, { world: 'jangan-fields', origin: ORIGIN, placement: ctx.placement, modelKind: ctx.modelKind })
    expect(r.problems.filter(p => /scale/.test(p))).toHaveLength(1)
  })
})
