/**
 * TT-B: the terrain review's spot finder (docs/TERRAIN_TEX.md §2.4; terrain-spots.ts, ported from the prototype's
 * spots.ts): share, dry ground, relief, ranking, the glTF frame of `/tp x z`; and the real export when present.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TerrainBlock } from '../../convert/src/world/manifest.ts'
import { defaultOutDir } from '../src/inventory.ts'
import { findTerrainSpots, rankSpots, REGION_GRID, spotsInRegion, type TerrainSpot } from '../src/terrain-spots.ts'

const G = REGION_GRID

function grid(tile: number, fill: (gx: number, gz: number) => boolean, height: (gx: number, gz: number) => number = () => 10) {
  const textures = new Uint16Array(G * G)
  const heights = new Float32Array(G * G)
  for (let gz = 0; gz < G; gz++) for (let gx = 0; gx < G; gx++) {
    textures[gz * G + gx] = fill(gx, gz) ? tile | 0x400 : 5 // high bits are not the tile id
    heights[gz * G + gx] = height(gx, gz)
  }
  return { textures, heights }
}

const blocks = (water: number | null): TerrainBlock[] => Array.from({ length: 36 }, (_, i) => ({
  bx: i % 6, bz: Math.floor(i / 6), flag: 0, environmentId: 0, water: water === null ? null : { kind: 'water', type: 0, wave: 0, heightM: water },
}))

describe('spotsInRegion', () => {
  it('finds the patch where the tile covers ≥ 50 % of the vertices, in /tp metres from the town region', () => {
    const { textures, heights } = grid(51, (gx, gz) => gx >= 40 && gx < 60 && gz >= 20 && gz < 40)
    const spots = spotsInRegion({ x: 169, z: 97, blocks: blocks(null) }, textures, heights, 51)
    expect(spots.length).toBeGreaterThan(0)
    const best = rankSpots(spots)[0]!
    expect(best.share).toBe(1)
    // gx 40..59 → centre gx 50 → x = 192 + 2 × 50; gz 20..39 → centre gz 30 → z = −2 × 30
    expect(best.x).toBe(192 + 100)
    expect(best.z).toBe(-60)
    expect(best.dry).toBeNull()
  })

  it('skips wet ground (lowest vertex < water + 0.7 m) and steep patches (relief ≥ 12 m)', () => {
    const { textures, heights } = grid(9, () => true)
    expect(spotsInRegion({ x: 168, z: 97, blocks: blocks(9.5) }, textures, heights, 9)).toHaveLength(0)
    expect(spotsInRegion({ x: 168, z: 97, blocks: blocks(9.2) }, textures, heights, 9).length).toBeGreaterThan(0)
    const steep = grid(9, () => true, gx => gx)
    expect(spotsInRegion({ x: 168, z: 97, blocks: blocks(null) }, steep.textures, steep.heights, 9)).toHaveLength(0)
  })

  it('ranks by share, then distance', () => {
    const s = (share: number, dist: number) => ({ share, dist }) as TerrainSpot
    expect(rankSpots([s(0.6, 10), s(0.9, 900), s(0.9, 100)], 2).map(x => x.dist)).toEqual([100, 900])
  })
})

const W = join(defaultOutDir(), 'world', 'jangan-fields')
describe.skipIf(!existsSync(join(W, 'manifest.json')))('on the export', () => {
  it("the prototype's road spot: c_marble_jang_07_1 has a dry, flat patch within 9 regions of town", () => {
    const found = findTerrainSpots(W, ['c_marble_jang_07_1'])
    const spots = found.get('tile2d:c_marble_jang_07_1')!
    expect(spots.length).toBeGreaterThan(0)
    expect(spots[0]!.share).toBeGreaterThanOrEqual(0.5)
    expect(spots[0]!.relief).toBeLessThan(12)
    expect(() => findTerrainSpots(W, ['no_such_tile'])).toThrow(/not a tile/)
  })
})
