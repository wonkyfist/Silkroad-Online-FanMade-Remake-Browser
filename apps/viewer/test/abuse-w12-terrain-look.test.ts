// H-12 hunt, lens "terrain look" (WAVE_PLAN8 §6.7 item 8): a B3c tile painted large without maps. The test fails on
// 95d49e2 and passes once the fix lands (F-12).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CELLS, GRID, encodeTerrainBin } from '../../../packages/convert/src/world/format.ts'
import type { WorldManifest } from '../../../packages/convert/src/world/manifest.ts'
import { heroCandidates } from '../editor-api/publish.ts'

/** A terrain bin whose first `painted` vertices carry `tile`, the rest tile 0. */
function bin(tile: number, painted: number): Uint8Array {
  const n = GRID * GRID
  const textures = new Uint16Array(n)
  for (let i = 0; i < painted; i++) textures[i] = tile
  return encodeTerrainBin({ layerCount: 1, heights: new Float32Array(n), normals: new Int8Array(n * 4), textures, layers: new Uint8Array(CELLS * CELLS * 4) })
}

describe('H-12 terrain look: a B3c tile painted large keeps no maps', () => {
  // D19 / TERRAIN_TEX §5.3: "Painting a B3c (non-hero) tile over a large area would show it with albedo only", so
  // Publish flips `hero` for a painted tile past 0.1 % cover. publish.ts heroCandidates measures that cover over the
  // whole export (307 non-synthetic regions x 97 x 97 = 2.89 M vertices), so 0.1 % is ~2,900 vertices = ~11,600 m^2
  // (a 108 m square, 31 % of a region). B3's own split (content/texpipe/b3-terrain.json "split") put the 0.1 % line on
  // the MAX cover over the fields, the town 3x3 and the near ring (<= 5 regions): by that rule a tile covering 2,000
  // vertices (8,000 m^2, a 90 m square) of the town region is 2.4 % of the town 3x3, a B3a-level hero. Here the user
  // paints a 90 m paved courtyard with c_marble_jang_10 (a B3c paving set, every map encoded) in town: Publish
  // switches nothing on, and Medium / High draw the courtyard albedo-only (no AO, roughness or normals) beside the
  // hero paving around it.
  it('a 90 m paved courtyard painted in the town region (0.07 % of the export, 2.4 % of the town 3x3) gets its maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h12-hero-'))
    try {
      mkdirSync(join(dir, 'terrain'))
      writeFileSync(join(dir, 'terrain/base.bin'), bin(172, 0))
      writeFileSync(join(dir, 'terrain/town.bin'), bin(172, 2000))
      const regions = Array.from({ length: 307 }, (_, i) => ({
        x: 150 + (i % 20), z: 85 + Math.floor(i / 20), id: i, synthetic: false,
        terrain: { file: i === 153 ? 'terrain/town.bin' : 'terrain/base.bin' },
      }))
      const man = {
        regions,
        tiles: [{ id: 0, source: 'c_dust_fld_01.ddj', file: 'tiles/c_dust_fld_01.png' }, { id: 172, source: 'c_marble_jang_10.ddj', file: 'tiles/c_marble_jang_10.png' }],
      } as unknown as WorldManifest
      const index = { sets: { 'tile2d:c_marble_jang_10': { hero: false }, 'tile2d:c_dust_fld_01': { hero: true } } }
      const area = 2000 * 4
      expect(area).toBe(8000)
      const out = heroCandidates(dir, man, new Set([172]), index)
      expect(out.map(h => h.tile)).toEqual(['c_marble_jang_10'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
