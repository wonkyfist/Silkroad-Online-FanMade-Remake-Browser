/**
 * H-10R, lens "double draw" (WAVE_PLAN6 §6.5 lens 4): a C9-dropped placement must not still be drawn. The 3D world is
 * clean (S-DRAW: the dropped uid is gone from manifest.placements), but the minimap / world-map tile of a changed ring
 * region keeps the retail pixels (which have the retail objects baked in) wherever the ground moved less than
 * RETAIL_FADE_M[1] = 2.5 m, while C9 drops every non-vegetation placement whose ground moved more than
 * placements.dropMovedM = 0.5 m. Between the two thresholds the object is gone in 3D and still painted on the map.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../src/world/manifest.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { parseCoastConfig } from '../src/world/coast/config.ts'
import { colX, latticeShape, rowZ } from '../src/world/coast/lattice.ts'
import { coastMinimapOptions, coastMinimapTile, MINIMAP_SIZE, type CoastMinimapField } from '../src/world/coast/minimap.ts'
import type { CoastResult } from '../src/world/coast/pass.ts'
import { placementEdits } from '../src/world/coast/placements.ts'
import type { RgbaImage } from '../src/world/worldmap.ts'

const S = MINIMAP_SIZE
const coast = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))

describe('H-10R doubledraw: a C9-dropped placement on the minimap', () => {
  it('ground lowered 0.8 m under a ruin wall: C9 drops the wall, and the minimap no longer paints it', () => {
    // region (11, 11) of a 3 x 3 lattice lowered by 0.8 m (land, not sand: only the height moved), retail at 20 m
    const shape = latticeShape({ x: [10, 12], z: [10, 12] })
    const n = shape.rows * shape.cols
    const h = new Float64Array(n).fill(20)
    const retail = new Float64Array(n).fill(20)
    for (let r = 0; r < shape.rows; r++) {
      for (let c = 0; c < shape.cols; c++) {
        const x = colX(shape, c), z = rowZ(shape, r)
        if (x >= 11 && x <= 12 && z >= 11 && z <= 12) h[r * shape.cols + c] = 19.2
      }
    }
    const field: CoastMinimapField = { shape, h, cls: new Uint8Array(n), masks: { inPlay: new Uint8Array(n) } }

    // A ruin wall at the region's centre (glTF metres from region (11, 11)'s south-west corner).
    const model = { index: 0, source: 'res\bldg\china\dunhuang\ruins\w_cd_castle_wall02.bsr', kind: 'static', boundsMin: [-3, 0, -1], boundsMax: [3, 4, 1] } as unknown as WorldModel
    const wall = {
      objId: 1, source: model.source, models: [0], compound: false, position: [96, 19.2, -96], rotation: [0, 0, 0, 1], yaw: 0,
      flags: { static: true, big: false, struct: false }, staticFlag: 0, uid: 7, region: (11 << 8) | 11, group: 2, inConvertedRegion: true,
    } as unknown as WorldPlacement
    const c9 = placementEdits({ shape, h } as unknown as CoastResult, coast, retail, { x: 11, z: 11 }, [wall], [model])
    expect(c9.edits.drop).toEqual([{ region: wall.region, uid: 7 }])

    // The retail minimap has the wall baked in: a 12 x 6 px block of pure red at the centre (0.75 m per pixel).
    const base: RgbaImage = { width: S, height: S, rgba: new Uint8Array(S * S * 4) }
    for (let p = 0; p < S * S; p++) base.rgba.set([90, 110, 70, 255], p * 4)
    for (let r = 125; r < 131; r++) for (let c = 120; c < 136; c++) base.rgba.set([255, 0, 0, 255], (r * S + c) * 4)
    // convert-world passes C9's drop footprints to the minimap (CoastMinimapOptions.dropped; the fix of this finding)
    const t = coastMinimapTile(field, retail, 11, 11, base, coastMinimapOptions(coast, { dropped: c9.dropFootprints }))!
    expect(t.kind).toBe('composite')
    const at = (r: number, c: number) => [...t.rgba.subarray((r * S + c) * 4, (r * S + c) * 4 + 3)]
    // The wall's pixel: once the wall is dropped it must read as ground (green over red), not the retail wall.
    const [red, green] = at(128, 128)
    expect(red!, `minimap pixel at the dropped wall: ${at(128, 128).join(',')}`).toBeLessThan(green! + 40)
  })
})
