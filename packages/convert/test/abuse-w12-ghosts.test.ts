/**
 * H-12 lens "ghosts" (docs/WAVE_PLAN8.md §6.7 item 4; docs/WORLD_EDITOR.md §4.6, F8, D51): a moved or deleted object
 * must leave no ghost shadow in the terrain lightmaps and no ghost on the minimap.
 *
 * 1. touchedRegions() grows a placement edit by a fixed OBJECT_REACH_M box around the object's origin, but an object's
 *    baked shadow (height x 1.28 m, plus its crown) and its own footprint can reach further: a retail willow
 *    (tre_willow03, 80 m tall, crown about +-45 m) standing in the east half of its region shades the region to the
 *    west, which a delete never re-bakes (the live export: 24997:19463 leaves 164,97). The city gates (cj_n / cj_s /
 *    cj_e / cj_w, 278 m across) and the palace dam span regions the box never reaches: their minimap tiles and baked
 *    shadows stay after a delete or a move. Found with work/out/world/jangan-fields: 41 placements whose drop leaves an
 *    untouched region under their geometry or shadow.
 * 2. The minimap's dropped footprint is the bounds of the placement's first model only (`scene.models[p.models[0]]`),
 *    so deleting a compound (the cj_waterfall cpds, 4-5 parts, the first part 32 m of a 47 m whole) leaves the other
 *    parts' pixels on the minimap.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { regionIdOf, WORLD_EDITS_PLACEMENTS_FORMAT } from '../../shared/src/world-edits/index.ts'
import { dropFootprint } from '../src/world/coast/placements.ts'
import { readShadowCaster } from '../src/world/edits/glb.ts'
import { buildWorldEditsRun } from '../src/world/edits/index.ts'
import { emptyWorldEditsLayers, placementReach, touchedRegions, type WorldEditsLayers } from '../src/world/edits/layers.ts'
import { redrawMinimap } from '../src/world/edits/minimap.ts'
import { bakeEditedLightmap, type CasterInstance } from '../src/world/edits/shadows.ts'
import { boxMesh, model, ORIGIN, placement, regionEntry, writeGlb } from './world-edits-fixture.ts'

const tmp = mkdtempSync(join(tmpdir(), 'sro-h12-ghosts-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const W = 512
const HOME = regionIdOf(168, 97)
const WEST = regionIdOf(167, 97)

function dropLayers(source: string, position: [number, number, number], uid = 7): WorldEditsLayers {
  const layers = emptyWorldEditsLayers('jangan-fields')
  layers.placements = {
    format: WORLD_EDITS_PLACEMENTS_FORMAT, version: 1, world: 'jangan-fields', move: [], add: [],
    drop: [{ region: HOME, uid, source, from: { position, yaw: 0 } }],
  }
  return layers
}

/** A willow-like tree: a 0.6 m trunk and a 20 m crown from 60 to 80 m (the retail willow is 80 m tall, +-45 m wide). */
const WILLOW_GLB = writeGlb([{ mesh: boxMesh(-0.3, 0, -0.3, 0.3, 60, 0.3) }, { mesh: boxMesh(-10, 60, -10, 10, 80, 10) }])
const willowGeo = readShadowCaster(WILLOW_GLB)
const willow = (x: number, z: number): CasterInstance => ({
  key: `${HOME}:7`, parts: [{ model: 0, min: [-10, 0, -10], max: [10, 80, 10] }], position: [x, 10, z], yaw: 0, scale: 1,
})
const white = () => ({ width: W, height: W, rgba: new Uint8Array(W * W * 4).fill(255) })
const flat = () => 10

/** The darkest texel of a lightmap. */
const darkest = (img: { rgba: Uint8Array }) => {
  let m = 255
  for (let k = 0; k < W * W; k++) m = Math.min(m, img.rgba[k * 4]!)
  return m
}

describe('ghost shadows: the touched regions of a placement edit', () => {
  it('a deleted tall tree re-bakes every region its baked shadow falls in', () => {
    // the tree stands 100 m east of its region's west edge, mid-region north-south
    const pos: [number, number, number] = [100, 10, -96]
    // the retail lightmap of the region to the west holds the tip of its shadow (baked as a planted tree would be)
    const retailWest = bakeEditedLightmap({
      rx: 167, rz: 97, origin: regionEntry(167, 97).origin, image: white(), heightBefore: flat, heightAfter: flat,
      terrainChanged: false, maxHeightM: 40, gone: [], come: [willow(pos[0], pos[2])],
      scene: [willow(pos[0], pos[2])], load: () => willowGeo,
    })
    expect(retailWest).not.toBeNull()
    expect(darkest(retailWest!.image)).toBeLessThan(200)
    // deleting the tree must re-bake that region (else its shadow stays there for ever: a ghost on Low and at distance)
    const deleted = bakeEditedLightmap({
      rx: 167, rz: 97, origin: regionEntry(167, 97).origin, image: retailWest!.image, heightBefore: flat, heightAfter: flat,
      terrainChanged: false, maxHeightM: 40, gone: [willow(pos[0], pos[2])], come: [], scene: [], load: () => willowGeo,
    })
    expect(deleted).not.toBeNull()
    expect(darkest(deleted!.image)).toBe(255)
    // F-12: the reach comes from the export's models (the converter passes the pre-pass or the pass's placements and
    // models); a call without them cannot know an object's size and keeps the OBJECT_REACH_M floor
    const tree = model(0, 'res\\nature\\common\\tree\\tre_willow03.bsr', { boundsMin: [-10, 0, -10], boundsMax: [10, 80, 10] })
    const reach = placementReach([placement(HOME, 7, [0], tree.source, pos)], [tree])
    const touched = touchedRegions(dropLayers(tree.source, pos), ORIGIN, reach)
    expect(touched.has(HOME)).toBe(true)
    expect(touched.has(WEST)).toBe(true)
  })

  it('a deleted 278 m city gate redraws the minimap of every region it covers', () => {
    // cj_s / cj_n of the live export: bounds about -139..139 m east-west (278 m across)
    const gate = model(0, 'res\\bldg\\china\\jangan_enter\\cj_s.bsr', { boundsMin: [-139, 0, -6], boundsMax: [139, 15, 6] })
    const pos: [number, number, number] = [100, 10, -96]
    const p = placement(HOME, 7, [0], gate.source, pos)
    const fp = dropFootprint(p, gate, (gx, gz) => ({ x: ORIGIN.x + gx / 192, z: ORIGIN.z - gz / 192 }))
    // the west region's tile shows the gate (a dark band) and must be redrawn without it
    const S = 256
    const rgba = new Uint8Array(S * S * 4).fill(255)
    for (let r = 120; r < 136; r++) for (let c = 0; c < S; c++) rgba.set([30, 30, 30, 255], (r * S + c) * 4)
    const redrawn = redrawMinimap({
      rx: 167, rz: 97, current: { width: S, height: S, rgba }, heightBefore: flat, heightAfter: flat, wordBefore: () => 1,
      wordAfter: () => 1, tileColour: () => [100, 140, 70], dropped: [fp], added: [],
    })
    expect(redrawn).not.toBeNull()
    const touched = touchedRegions(dropLayers(gate.source, pos), ORIGIN, placementReach([p], [gate]))
    expect(touched.has(WEST)).toBe(true)
  })
})

describe('ghosts on the minimap: a deleted compound', () => {
  it('every part of a dropped compound placement leaves the minimap, not only its first model', () => {
    // a two-part compound (like cj_waterfall02.cpd): part 0 around the origin, part 1 30-40 m east of it
    const models = [
      model(0, 'res\\nature\\particle\\cj_waterfall02_01.bsr', { boundsMin: [-2, 0, -2], boundsMax: [2, 4, 2] }),
      model(1, 'res\\nature\\particle\\cj_waterfall02_02.bsr', { boundsMin: [30, 0, -2], boundsMax: [40, 4, 2] }),
    ]
    const source = 'compound\\particle\\cj_waterfall02.cpd'
    const pos: [number, number, number] = [96, 10, -96]
    const p = { ...placement(HOME, 7, [0, 1], source, pos), compound: true }
    const layers = dropLayers(source, pos)
    const warnings: string[] = []
    const outDir = join(tmp, 'compound')
    const run = buildWorldEditsRun(layers, {
      dir: join(tmp, 'layers'), world: 'jangan-fields', outDir, origin: ORIGIN, regions: [{ x: 168, z: 97 }], warnings, log: () => {},
      objects: { objIdOf: () => -1, footprint: () => null },
    })
    const region = regionEntry(168, 97)
    run.pass!({ outDir, origin: ORIGIN, regions: [region], tiles: [], models, placements: [p], warnings, log: () => {} })
    // the retail tile: both parts baked in as dark pixels (region-local metres east 94..98 and 126..136, north 94..98)
    const S = 256
    const rgba = new Uint8Array(S * S * 4)
    for (let k = 0; k < S * S; k++) rgba.set([90, 126, 63, 255], k * 4)
    const at = (e: number, n: number) => (Math.floor((192 - n) / 0.75) * S + Math.floor(e / 0.75)) * 4
    for (let n = 94; n <= 98; n += 0.5) for (let e = 94; e <= 98; e += 0.5) rgba.set([20, 20, 20, 255], at(e, n))
    for (let n = 94; n <= 98; n += 0.5) for (let e = 126; e <= 136; e += 0.5) rgba.set([20, 20, 20, 255], at(e, n))
    const img = run.minimap!(region, { width: S, height: S, rgba }, { outDir, origin: ORIGIN, placements: [], models })
    expect(img).not.toBeNull()
    // part 0's pixels are ground now; part 1's must be too
    expect(img!.rgba[at(96, 96)]).toBeGreaterThan(40)
    expect(img!.rgba[at(131, 96)]).toBeGreaterThan(40)
  })
})
