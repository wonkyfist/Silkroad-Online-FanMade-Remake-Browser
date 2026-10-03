/**
 * Wave 10r adversarial hunt, the GRASS_LIFE.md H-GL lenses (docs/GRASS_LIFE.md §8.4 H-GL): each test states what the
 * spec promises and fails while the product breaks it.
 *
 * - Lens 12 / 4 (the field's instances on the GPU follow the cull): GrassField.commit uploads a tier's instance matrices
 *   only when its count or a 32-bit hash of the cells' corners changed. The hash `h = h × 31 + 7 x + 13 z` is blind to a
 *   rigid move of every cell by (104, −56) m (7 × 104 − 13 × 56 = 0), so a camera that lands exactly there over an even
 *   meadow (a teleport, a recall) keeps drawing the old cells: no grass around the player, a patch of it 118 m away,
 *   until the camera moves again.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fieldRig, region, type FieldRig } from './grass-fixture.ts'

const rigs: FieldRig[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
})

describe('H-GL lens 12: the drawn instances always follow the cull', () => {
  it('a camera that jumps by (104, −56) m over an even meadow uploads the new cells', () => {
    const r = fieldRig({ sliceMs: 50, urgentSliceMs: 50 })
    rigs.push(r)
    // 3 × 3 regions of even grass (x 0 … 576 east, z 0 … −576), flat.
    let id = 1
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) r.field.addRegion(region({ id: id++, ox: 192 * a, oz: -192 * b }))
    const P = { x: 200, y: 11.7, z: -300 }
    for (let f = 0; f < 200 && r.field.stats.pending > 0; f++) r.field.update(P)
    expect(r.field.stats.pending).toBe(0)
    r.field.update(P)
    const near = r.field.meshes()[0]!
    expect(r.field.stats.cells[0]).toBeGreaterThan(0)
    const uploads = r.field.stats.uploads
    // The same spot relative to the 8 m cell grid, 118 m away: the same tier pattern, every cell moved.
    const Q = { x: P.x + 104, y: P.y, z: P.z - 56 }
    r.field.update(Q)
    // The CPU buffer holds Q's cells (cullGrass writes the mesh's own array) …
    const buf = (near as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })._thinInstanceDataStorage.matrixData
    const firstX = buf[12]!, firstZ = buf[14]!
    expect(Math.hypot(firstX + 4 - Q.x, firstZ + 4 - Q.z)).toBeLessThan(20)
    // … but the GPU only sees it if the tier was uploaded again.
    expect(r.field.stats.uploads).toBeGreaterThan(uploads)
  })
})
