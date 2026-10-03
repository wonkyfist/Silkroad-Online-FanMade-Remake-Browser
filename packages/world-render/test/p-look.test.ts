/**
 * P-LOOK (wave 10 polish) regressions on the real export and the real art (each case skips when work/out lacks it):
 *
 * - (4) the white haze blob over the Lake Forest lake in the High meadow shot and (5) the sky-coloured band across the
 *   palace wall behind the south-gate dragon were both the ocean drawn at the sea level (+5 m) over retail water that
 *   keeps its own plane (the lake at about −9 m, the dragon fountain's basin and the ponds in town): the coast field
 *   marks those texels with G = 0, which the client's repack once read as "at the shoreline", so the swash rule drew a
 *   sheet of sea there (a pale shallow-water sheet on the lake seen from the meadow; seen edge-on from the plaza, a
 *   horizontal band across the wall). I-10R's repack (ocean/field.ts: G 0 off the sea reads as far inland) fixed it
 *   before HEAD f56d175; the overview's shots were taken before it. This pins it on the real field.
 * - (6) BT-T's white leaf quads on tre_frie01 were atlas mip bleed (H-BT lens 8: a cut-out leaf cell sampled at the
 *   page's coarse levels read its opaque neighbour), fixed by RA-1 / BT-L8's per-cell gradient clamp (abuse-w10r-
 *   batching-spec covers the clamp). This pins the leaf cell itself: its coverage holds on every level the clamp allows.
 * - (2) the open sea, (3) the wet band: the code paths the look fix added (both languages) and their numbers.
 * - WebGL2: given mip levels of a texture-array layer are uploaded (textures.ts uploadTextureLayer): Babylon leaves
 *   `mipLevelCount` at 1 on a WebGL2 RawTexture2DArray, which skipped them, so the terrain's ORMH array sampled black
 *   past level 0 (black hills and wet sand, a navy sea over a black sea bed on WebGL2 Medium).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { ATLAS_LEVELS, ATLAS_PAGE } from '../src/batch/atlas.ts'
import { COAST_WET_GLSL, COAST_WET_WGSL } from '../src/coast/chunks.ts'
import { OCEAN_UNIFORMS, OceanPbrState, oceanCode } from '../src/ocean/ocean-plugin.ts'
import { BAND_FACTOR, GPU_TILES_M, HS_MAX_M, MIN_TEXELS_PER_WAVE, WORKER_TILES_M, buildH0, cascadesFor } from '../src/ocean/spectrum.ts'
import { CALM_SEA_WIND_MS, seaParams } from '../src/ocean/weather.ts'
import { SHORE_FRAGMENT, SHORE_VERTEX } from '../src/shore/chunks.ts'
import { CUSP_SHARE } from '../src/shore/swash.ts'
import { CoastField, decodePng, drawsWater, joinBlocks, type FieldSample } from '../src/ocean/field.ts'
import { atlasMaxLod, cellShape, coverage, runCellJob, type CellDecoders, type Level } from '../src/pbr/decode-core.ts'
import { uploadTextureLayer } from '../src/textures.ts'

const ROOT = join(import.meta.dirname, '../../..')
const WORLD = join(ROOT, 'work/out/world/jangan-fields')
const MANIFEST = join(WORLD, 'manifest.json')
const FIELD = join(WORLD, 'coast/field.png')
const TREE = join(WORLD, 'models/nature/common/tree/tre_frie01.static.glb')

/** glTF boxes (x0, x1, z0, z1) of retail water that keeps its own plane, where the old repack drew the sea. */
const OWN_WATER: Record<string, [number, number, number, number]> = {
  'the Lake Forest lake (haze blob)': [220, 324, 404, 544],
  'the plaza fountain and ponds behind the south-gate dragon (wall band)': [40, 170, -230, 80],
}

describe.skipIf(!existsSync(MANIFEST) || !existsSync(FIELD))('P-LOOK (4)(5): no sea over retail water with its own plane (real field)', () => {
  const load = async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as WorldManifest
    const coast = manifest.coast!
    const image = await decodePng(new Uint8Array(readFileSync(FIELD)))
    return { manifest, coast, image, field: new CoastField(coast, image, joinBlocks(manifest, coast.seaLevelM)) }
  }

  it('the lake and the town draw no ocean, and no CDLOD node covers them; S1\'s sea still draws', async () => {
    const { field } = await load()
    const s: FieldSample = { sea: 0, distanceM: 0, elevationM: 0, join: 0 }
    for (const [name, [x0, x1, z0, z1]] of Object.entries(OWN_WATER)) {
      let wet = 0
      for (let x = x0; x <= x1; x += 4) for (let z = z0; z <= z1; z += 4) if (drawsWater(field.sample(x, z, s))) wet++
      expect(wet, name).toBe(0)
      for (let x = x0; x < x1; x += 32) for (let z = z0; z < z1; z += 32) expect(field.nodeHasWater(x, z, 32), `${name} node ${x},${z}`).toBe(false)
    }
    expect(drawsWater(field.sample(480, 1320, s))).toBe(true)
    expect(field.nodeHasWater(472, 1312, 16)).toBe(true)
  })

  it('those boxes do hold G = 0 retail-water texels (the case the old repack got wrong)', async () => {
    const { coast, image } = await load()
    const f = coast.field
    for (const [name, [x0, x1, z0, z1]] of Object.entries(OWN_WATER)) {
      let g0 = 0
      for (let x = x0; x <= x1; x += 4) {
        for (let z = z0; z <= z1; z += 4) {
          const i = Math.floor((x - f.x0) / f.metresPerTexel), j = Math.floor((z - f.z0) / f.metresPerTexel)
          const o = (j * f.width + i) * 4
          if (image.data[o]! < 128 && image.data[o + 1] === 0) g0++
        }
      }
      expect(g0, name).toBeGreaterThan(0)
    }
  })
})

/** The embedded PNG of a glb's image by name. */
function glbImage(file: string, name: string): Uint8Array {
  const b = readFileSync(file)
  const jsonLen = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8')) as {
    images: { name?: string; bufferView: number }[]
    bufferViews: { byteOffset?: number; byteLength: number }[]
  }
  const bin = 20 + jsonLen + 8
  const img = json.images.find(i => i.name === name)!
  const bv = json.bufferViews[img.bufferView]!
  return new Uint8Array(b.subarray(bin + (bv.byteOffset ?? 0), bin + (bv.byteOffset ?? 0) + bv.byteLength))
}

describe.skipIf(!existsSync(TREE))('P-LOOK (6): tre_frie01\'s leaf cell keeps its holes on every level the clamp allows', () => {
  it('coverage stays the level-0 share (no solid card) from level 0 to atlasMaxLod', async () => {
    const png = await decodePng(glbImage(TREE, 'tre_frie_leaf'))
    const src: Level = { width: png.width, height: png.height, data: png.data as Uint8Array<ArrayBuffer> }
    const dec: CellDecoders = { url: async () => src, bytes: async () => src }
    const shape = cellShape(src.width, src.height, ATLAS_PAGE, ATLAS_LEVELS)
    const res = await runCellJob({ kind: 'cell-albedo', shape, page: ATLAS_PAGE, levels: ATLAS_LEVELS, image: { kind: 'pixels', level: src }, alpha: 'cutout', cutoff: 0.5 }, dec)
    const c0 = coverage(res.levels[0]!, 0.5)
    expect(c0).toBeGreaterThan(0.1)
    expect(c0).toBeLessThan(0.4)
    for (let l = 1; l <= atlasMaxLod(shape) && l < res.levels.length; l++) {
      const c = coverage(res.levels[l]!, 0.5)
      expect(Math.abs(c - c0), `level ${l}`).toBeLessThan(0.06)
    }
  })
})

describe('WebGL2: a texture-array layer\'s given levels are uploaded (textures.ts uploadTextureLayer)', () => {
  /** A WebGL2-like engine that records the uploads (Babylon's RawTexture2DArray: mipLevelCount 1, mips generated). */
  function fake(generateMipMaps: boolean) {
    const calls: Array<{ level: number; w: number }> = []
    let mips = 0
    const gl = {
      TEXTURE_2D_ARRAY: 1, RGBA: 2, UNSIGNED_BYTE: 3,
      texSubImage3D: (_t: number, level: number, _x: number, _y: number, _z: number, w: number) => void calls.push({ level, w }),
      generateMipmap: () => void mips++,
    }
    const engine = { isWebGPU: false, _gl: gl, _bindTextureDirectly: () => {}, _unpackFlipY: () => {} }
    const scene = { getEngine: () => engine } as never
    const internal = { depth: 4, width: 8, mipLevelCount: 1, generateMipMaps }
    const tex = { getInternalTexture: () => internal } as never
    return { scene, tex, calls, mips: () => mips }
  }

  it('uploads level 0 and every given level (8² → 4², 2², 1²), with no whole-array generateMipmap', () => {
    const f = fake(true)
    const levels = [new Uint8Array(4 * 4 * 4), new Uint8Array(2 * 2 * 4), new Uint8Array(4)]
    expect(uploadTextureLayer(f.scene, f.tex, 2, new Uint8Array(8 * 8 * 4), 8, levels)).toBe(true)
    expect(f.calls).toEqual([{ level: 0, w: 8 }, { level: 1, w: 4 }, { level: 2, w: 2 }, { level: 3, w: 1 }])
    expect(f.mips()).toBe(0)
  })

  it('without given levels the GPU makes them; an unmipped array gets level 0 only', () => {
    const a = fake(true)
    expect(uploadTextureLayer(a.scene, a.tex, 0, new Uint8Array(8 * 8 * 4), 8)).toBe(true)
    expect(a.calls).toEqual([{ level: 0, w: 8 }])
    expect(a.mips()).toBe(1)
    const b = fake(false)
    expect(uploadTextureLayer(b.scene, b.tex, 0, new Uint8Array(8 * 8 * 4), 8, [new Uint8Array(64)])).toBe(true)
    expect(b.calls).toEqual([{ level: 0, w: 8 }])
  })
})

describe('P-LOOK (2): the open sea reads at noon (ocean)', () => {
  it('Medium\'s worker cascades split where the coarse one still resolves its waves; the GPU FFT\'s split is unchanged', () => {
    const w = cascadesFor(WORKER_TILES_M, 64)
    // The 400 m cascade keeps only waves of ≥ MIN_TEXELS_PER_WAVE texels; the calm wind sea's ≈ 16–26 m peak goes to
    // the 110 m cascade (≥ 7 texels per wavelength there).
    expect((2 * Math.PI) / w[0]!.kMax).toBeGreaterThanOrEqual((MIN_TEXELS_PER_WAVE * WORKER_TILES_M[0]) / 64 - 1e-9)
    expect(w[1]!.kMin).toBeCloseTo(w[0]!.kMax, 12)
    expect(WORKER_TILES_M[1] / 64).toBeLessThan(26 / 7)
    const g = cascadesFor(GPU_TILES_M, 128)
    for (let c = 0; c + 1 < GPU_TILES_M.length; c++) expect(g[c]!.kMax).toBeCloseTo((2 * Math.PI * BAND_FACTOR) / GPU_TILES_M[c + 1]!, 12)
  })

  it('a clear day builds a gentle breeze\'s sea (Hs ≈ 0.9 m); the storm still reaches the gameplay clamp', () => {
    expect(CALM_SEA_WIND_MS).toBe(5)
    const p = (windMs: number, storm: number) => seaParams({ windMs, windDirRad: 0, storm, swellFromDeg: 150 })
    const clear = buildH0(cascadesFor(WORKER_TILES_M, 64), p(2, 0)).hs
    expect(clear).toBeGreaterThan(0.75)
    expect(clear).toBeLessThan(1.1)
    expect(buildH0(cascadesFor(GPU_TILES_M, 128), p(13, 1)).hs).toBeCloseTo(HS_MAX_M, 6)
  })

  it('the sky\'s reflection has a gradient (sroOcZenith) and the blend weights the background by the Fresnel, in both languages', () => {
    expect(OCEAN_UNIFORMS).toContain('sroOcZenith')
    for (const lang of ['wgsl', 'glsl'] as const) {
      const f = oceanCode('fragment', lang)
      expect(f.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('sroOcZenith')
      expect(f.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('sroOcFr =')
      const b = f.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION!
      expect(b).toContain('alpha = sroB1;')
      expect(b).toContain('finalRadianceScaled = finalRadianceScaled * sroKr;')
      expect(b).toContain('finalDiffuse = finalDiffuse * sroKd;')
    }
    const s = new OceanPbrState()
    expect([s.zenith.x, s.zenith.y, s.zenith.z, s.zenith.w]).toEqual([0, 0, 0, 0])
  })

  it('the blend is exact: background × (1 − F)(1 − α), the reflection at full strength, the column × α (1 − F)', () => {
    // CPU mirror of blendCode for one channel: out = C · α' + bg (1 − α').
    for (const [a, F] of [[0.1, 0.6], [0.5, 0.05], [0.9, 0.3], [0, 1]] as const) {
      const scat = 0.3, refl = 0.4, bg = 0.7
      const a1 = Math.max(a + F * (1 - a), 0.001)
      const c = scat * (a * (1 - F)) / a1 + refl / a1
      const out = c * a1 + bg * (1 - a1)
      expect(out).toBeCloseTo(scat * a * (1 - F) + refl + bg * (1 - a) * (1 - F), 9)
    }
  })
})

describe('P-LOOK (3): the wet band and the swash share scalloped, ragged edges', () => {
  it('both languages carry the cusps (sheet and wet band) and the wet band\'s jitter and feather', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      expect(SHORE_VERTEX[lang].main).toContain('sroShCusp(sroOcRest')
      expect(SHORE_FRAGMENT[lang].main).toContain('sroShCusp(sroOcRest')
    }
    for (const src of [COAST_WET_WGSL, COAST_WET_GLSL]) {
      expect(src).toContain('cusp = 1.0 - ')
      expect(src).toContain('he = h +')
      expect(src).toContain('cover')
    }
    expect(CUSP_SHARE).toBeGreaterThan(0)
  })
})
