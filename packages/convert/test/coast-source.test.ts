/**
 * CST-C phase 1 (docs/COAST.md §5.4, §9, §12.1, §12.13; WAVE_PLAN6 §6.1): the coast wired into the converter, on a
 * synthetic world built as retail .m regions (no client needed):
 * - the region overlay: frozen regions untouched (the retail object itself), every seam bit-equal across changed,
 *   unchanged and synthetic regions, the normals' heights from the overlay, synthetic regions decodable with the
 *   nearest exported block's environment and no water, ring water over the sea removed and water in the bounds kept;
 * - paint: sand within 12 m of every sea shore, grass on the lowered flank;
 * - navigation: the ring rule (knee-deep .. SL + 12 m, slope 0.7, never opening a retail-closed tile), openTiles inside
 *   the bounds, heights equal to the terrain, nav objects on moved ground outside the bounds dropped;
 * - C9 and S-DRAW through the pass pipeline; the field; the lightmap bake; the S1 link search; determinism;
 * - CST-C phase 2: Option A's corridor (retail scenery west of the bounds) frozen bit for bit, its faces checked as
 *   lines, its emitted regions built from their retail .m (look-only), and no authored weight on it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  assembleRegionGrid, MAPM_BLOCK_TILES, MAPM_BLOCK_VERTICES, MAPM_BLOCKS, MAPM_WATER, MAPM_WATER_NONE, NVM_TILES,
  type MapMBlock, type MapMFile, type NvmCell, type NvmFile, type NvmObject,
} from '@sro/formats'
import { buildNavData, NavWorld } from '@sro/nav'
import { REPO_ROOT } from '../src/node-io.ts'
import { emitCensus } from '../src/world/coast/census.ts'
import * as checks from '../src/world/coast/checks.ts'
import { parseCoastConfig, type CoastConfig } from '../src/world/coast/config.ts'
import { coastField, distanceTo, seaMasks } from '../src/world/coast/field.ts'
import { CELLS_PER_REGION, colX, latticeShape, rowZ } from '../src/world/coast/lattice.ts'
import { bakeRegionLightmap, LIGHTMAP_LIT, LIGHTMAP_SHADOW } from '../src/world/coast/lightmap.ts'
import { closeRing, findInBoundsLink, reachesBothWays, tilesToRowRects, widenLink } from '../src/world/coast/links.ts'
import { editRegionNav, NAV_BEACH_BAND_M } from '../src/world/coast/navgen.ts'
import { paintCoast, textureWord } from '../src/world/coast/paint.ts'
import { COAST_CLASS, runCoastPass, type CoastResult } from '../src/world/coast/pass.ts'
import { placementEdits } from '../src/world/coast/placements.ts'
import { readRetailLattice, regionKey, type RetailLattice, type RetailRegion } from '../src/world/coast/retail.ts'
import { CoastSource } from '../src/world/coast/source.ts'
import { mergeAuthoredHeights } from '../src/world/coast/authored.ts'
import { decodeTerrainBin, encodeTerrainBin } from '../src/world/format.ts'
import type { WorldModel, WorldPlacement } from '../src/world/manifest.ts'
import { runWorldPasses } from '../src/world/passes.ts'
import { buildLayers, buildNormals, heightsToMetres } from '../src/world/terrain.ts'

const PLAY = { x0: 13, x1: 15, z0: 13, z1: 15 }
const EXPORT = { x0: 12, x1: 16, z0: 12, z1: 16 }
const G = CELLS_PER_REGION + 1
const GRASS = 7
const DIRT = 4
/** A retail water block in the south ring (sea side) and one inside the bounds. */
const RING_WATER = { x: 14, z: 12, bx: 2, bz: 0, h: 5 }
const PLAY_WATER = { x: 14, z: 14, bx: 3, bz: 3, h: 12 }
/** A pond above the sea level in the corridor, on its Donwhang side beyond the export (CST-C phase 2). */
const CORRIDOR_WATER = { x: 11, z: 14, bx: 2, bz: 2, h: 12 }

function synthConfig(): CoastConfig {
  const cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
  return {
    ...cfg,
    option: 'B', phase: 1, domain: { x: [10, 18], z: [10, 18] }, emit: { x: [10, 18], z: [10, 18], depthM: 8 }, corridor: null,
    cornerBelowZ: 12,
    sections: [
      { code: 'N', side: 'north', from: 13, to: 15, corners: [[16, 16]], kind: 'wide', c0: 150, amp: 30, phase: 1 },
      { code: 'E', side: 'east', from: 13, to: 15, corners: [[16, 13]], kind: 'bay', c0: 95, amp: 30, phase: 1 },
      { code: 'SW', side: 'south', from: 13, to: 13, corners: [[13, 13]], kind: 'mountain', c0: 120, amp: 30, phase: 1 },
      { code: 'SB', side: 'south', from: 14, to: 15, kind: 'walk', c0: -62, amp: 22, phase: 1 },
      { code: 'W', side: 'west', from: 13, to: 15, kind: 'strait', c0: 90, amp: 20, phase: 2 },
    ],
    tombKeep: { ...cfg.tombKeep, x: [14, 15] },
    allowHeightPatches: [{ name: 'SB', x: [14.3, 16], z: [13, 13.5], maxHeightM: 6, feather: 'inward' }],
    openTiles: [], hotspots: [], places: [],
  }
}

/** Retail heights (m) at region coordinates: the synthetic world of coast-pass.test.ts. */
function retailHeight(x: number, z: number): number {
  let h = 10 + 2 * Math.sin(x * 7.1) * Math.cos(z * 5.3)
  if (x > 14.3 && z < 13.5 && z >= 13) h = Math.min(h, Math.max(0, (z - 13.35) * 192 * 0.35))
  if (x < 14 && z < 13.4) {
    const d = (13 - z) * 192
    const across = Math.min(1, (14 - x) * 2.5)
    const m = d < 0 ? 150 + 0.2 * d : d < 50 ? 150 + 1.2 * d : Math.max(0, 210 - 0.9 * (d - 50))
    h = Math.max(h, m * across)
  }
  if (x > 13.9 && x < 15.1 && z > 15.8) {
    const d = (z - 16) * 192
    h = Math.max(h, d < 30 ? 50 + d : Math.max(-2, 80 - 1.4 * (d - 30)))
  }
  return h
}

/** A retail region (.m) of the synthetic world: file-unit heights, grass or dirt words, environment id x + 100 z. */
function retailRegion(x: number, z: number): RetailRegion {
  const blocks: MapMBlock[] = []
  const n = MAPM_BLOCK_VERTICES * MAPM_BLOCK_VERTICES
  for (let bz = 0; bz < MAPM_BLOCKS; bz++) {
    for (let bx = 0; bx < MAPM_BLOCKS; bx++) {
      const heights = new Float32Array(n)
      const textures = new Uint16Array(n)
      for (let vz = 0; vz < MAPM_BLOCK_VERTICES; vz++) {
        for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
          const gx = bx * MAPM_BLOCK_TILES + vx
          const gz = bz * MAPM_BLOCK_TILES + vz
          heights[vz * MAPM_BLOCK_VERTICES + vx] = Math.fround(retailHeight(x + gx / CELLS_PER_REGION, z + gz / CELLS_PER_REGION) * 10)
          // by global lattice coordinates, so a vertex shared by two regions has one word (as in retail)
          textures[vz * MAPM_BLOCK_VERTICES + vx] = (x * 96 + gx + z * 96 + gz) % 7 ? GRASS : DIRT
        }
      }
      const water = (x === RING_WATER.x && z === RING_WATER.z && bx === RING_WATER.bx && bz === RING_WATER.bz) ? RING_WATER
        : (x === PLAY_WATER.x && z === PLAY_WATER.z && bx === PLAY_WATER.bx && bz === PLAY_WATER.bz) ? PLAY_WATER
        : (x === CORRIDOR_WATER.x && z === CORRIDOR_WATER.z && bx === CORRIDOR_WATER.bx && bz === CORRIDOR_WATER.bz) ? CORRIDOR_WATER : null
      blocks.push({
        index: bz * MAPM_BLOCKS + bx, bx, bz, flag: 0, environmentId: x + 100 * z, heights, textures,
        textureIds: Uint16Array.from(textures, w => w & 0x3ff), textureHighBits: Uint8Array.from(textures, w => w >>> 10),
        brightness: new Uint8Array(n), waterType: water ? MAPM_WATER : MAPM_WATER_NONE, waterWaveType: 0, waterHeight: water ? water.h * 10 : 0,
        tileFlags: new Uint16Array(MAPM_BLOCK_TILES * MAPM_BLOCK_TILES), heightMax: 0, heightMin: 0, unknown: new Uint8Array(20),
      })
    }
  }
  const mapm: MapMFile = { signature: 'JMXVMAPM1000', blocks }
  return { mapm, grid: assembleRegionGrid(mapm) }
}

interface World {
  cfg: CoastConfig
  retail: RetailLattice
  regions: Map<number, RetailRegion>
  result: CoastResult
  source: CoastSource
  paint: ReturnType<typeof paintCoast>
  masks: ReturnType<typeof seaMasks>
  exportRegions: Array<{ x: number; z: number }>
}

/** `beyond`: retail regions outside the export (active, not exported: the corridor's Donwhang side). */
function buildWorld(cfg = synthConfig(), beyond: ReadonlyArray<{ x: number; z: number }> = []): World {
  const regions = new Map<number, RetailRegion>()
  const exportRegions: Array<{ x: number; z: number }> = []
  for (let z = EXPORT.z0; z <= EXPORT.z1; z++) {
    for (let x = EXPORT.x0; x <= EXPORT.x1; x++) {
      regions.set(regionKey(x, z), retailRegion(x, z))
      exportRegions.push({ x, z })
    }
  }
  for (const { x, z } of beyond) regions.set(regionKey(x, z), retailRegion(x, z))
  const retail = readRetailLattice(cfg.domain, (x, z) => regions.get(regionKey(x, z)) ?? null)
  const inExport = (x: number, z: number) => x >= EXPORT.x0 && x <= EXPORT.x1 && z >= EXPORT.z0 && z <= EXPORT.z1
  const active = (x: number, z: number) => inExport(x, z) || regions.has(regionKey(x, z))
  const result = runCoastPass({ heights: retail.heights, water: retail.water, active, playable: PLAY, exportRect: EXPORT }, cfg)
  const paint = paintCoast(result, cfg, { words: retail.words, heights: retail.heights, isGrass: id => id === GRASS })
  const masks = seaMasks(result)
  const census = emitCensus(result, cfg, EXPORT, active)
  const source = new CoastSource({ cfg, retail, result, paint, masks, exportRegions, emitted: census.emitted })
  return { cfg, retail, regions, result, source, paint, masks, exportRegions }
}

let W: World

beforeAll(() => {
  W = buildWorld()
}, 120_000)

const terrainOf = (x: number, z: number) => W.source.terrain(x, z, W.regions.get(regionKey(x, z)) ?? null)
const allRegions = () => [...W.exportRegions, ...W.source.synthetic]

describe('the coast region overlay (./coast/source.ts)', () => {
  it('reads the retail lattice as the prototype mosaic does (file units kept, heights f32(fu / 10), water from water blocks)', () => {
    const l = W.retail.shape
    const k = ((l.z1 - 14) * CELLS_PER_REGION + CELLS_PER_REGION - 5) * l.cols + (14 - l.x0) * CELLS_PER_REGION + 7
    const reg = W.regions.get(regionKey(14, 14))!
    expect(W.retail.fileUnits[k]).toBe(reg.grid.heights[5 * G + 7])
    expect(W.retail.heights[k]).toBe(Math.fround(reg.grid.heights[5 * G + 7]! / 10))
    const w = ((l.z1 - PLAY_WATER.z) * CELLS_PER_REGION + CELLS_PER_REGION - (PLAY_WATER.bz * 16 + 3)) * l.cols + (PLAY_WATER.x - l.x0) * CELLS_PER_REGION + PLAY_WATER.bx * 16 + 3
    expect(W.retail.water[w]).toBe(PLAY_WATER.h)
  })

  it('returns the retail object for a region the coast leaves alone, and keeps the frozen file units bit for bit', () => {
    const reg = W.regions.get(regionKey(14, 14))!
    const t = terrainOf(14, 14)!
    expect(t.mapm).toBe(reg.mapm)
    expect(t.synthetic).toBe(false)
    // every playable vertex outside the patch keeps its retail file units in every region
    for (let z = PLAY.z0; z <= PLAY.z1; z++) {
      for (let x = PLAY.x0; x <= PLAY.x1; x++) {
        const grid = terrainOf(x, z)!.grid
        const src = W.regions.get(regionKey(x, z))!.grid
        const l = W.result.shape
        for (let gz = 0; gz < G; gz++) {
          for (let gx = 0; gx < G; gx++) {
            const k = ((l.z1 - z) * CELLS_PER_REGION + CELLS_PER_REGION - gz) * l.cols + (x - l.x0) * CELLS_PER_REGION + gx
            if (W.result.masks.patch[k]) continue
            expect(grid.heights[gz * G + gx]).toBe(src.heights[gz * G + gx])
          }
        }
      }
    }
  })

  it('changes the ring, the patch and synthesises regions beyond the export', () => {
    expect(W.source.changed(13, 12, W.regions.get(regionKey(13, 12))!)).toBe(true)
    expect(W.source.changed(15, 13, W.regions.get(regionKey(15, 13))!)).toBe(true)
    expect(W.source.synthetic.length).toBeGreaterThan(5)
    for (const r of W.source.synthetic) {
      expect(r.x >= EXPORT.x0 && r.x <= EXPORT.x1 && r.z >= EXPORT.z0 && r.z <= EXPORT.z1).toBe(false)
      expect(terrainOf(r.x, r.z)!.synthetic).toBe(true)
    }
  })

  it('keeps every seam bit-equal across changed, unchanged and synthetic regions', () => {
    const grids = new Map(allRegions().map(r => [regionKey(r.x, r.z), terrainOf(r.x, r.z)!.grid]))
    let seams = 0
    for (const r of allRegions()) {
      const a = grids.get(regionKey(r.x, r.z))!.heights
      const east = grids.get(regionKey(r.x + 1, r.z))
      const north = grids.get(regionKey(r.x, r.z + 1))
      if (east) {
        seams++
        for (let gz = 0; gz < G; gz++) expect(a[gz * G + 96]).toBe(east.heights[gz * G])
      }
      if (north) {
        seams++
        for (let gx = 0; gx < G; gx++) expect(a[96 * G + gx]).toBe(north.heights[gx])
      }
    }
    expect(seams).toBeGreaterThan(40)
  })

  it('gives the normals the overlay heights (so a changed/unchanged seam lights without a step)', () => {
    for (const r of [{ x: 13, z: 12 }, { x: 14, z: 13 }, W.source.synthetic[0]!]) {
      const grid = terrainOf(r.x, r.z)!.grid
      for (const [gx, gz] of [[0, 0], [48, 13], [96, 96], [5, 96]] as const) {
        expect(W.source.height(r.x * 96 + gx, r.z * 96 + gz)).toBe(grid.heights[gz * G + gx])
      }
    }
    expect(W.source.height(0, 0)).toBeUndefined()
    const normals = buildNormals(13, 12, (a, b) => W.source.height(a, b))
    expect(normals.length).toBe(G * G * 4)
  })

  it('builds synthetic regions that encode and decode, with the nearest exported environment and no water', () => {
    for (const r of W.source.synthetic) {
      const t = terrainOf(r.x, r.z)!
      const layers = buildLayers(t.mapm)
      const bin = encodeTerrainBin({
        layerCount: layers.layerCount, heights: heightsToMetres(t.grid.heights), normals: buildNormals(r.x, r.z, (a, b) => W.source.height(a, b)),
        textures: t.grid.textures, layers: layers.layers,
      })
      const dec = decodeTerrainBin(bin)
      expect(dec.heights.length).toBe(G * G)
      for (const b of t.mapm.blocks) {
        expect(b.waterType).toBe(MAPM_WATER_NONE)
        // the environment of the nearest exported block: an export region's id pattern x + 100 z, from a neighbour
        const ex = Math.min(Math.max(r.x, EXPORT.x0), EXPORT.x1)
        const ez = Math.min(Math.max(r.z, EXPORT.z0), EXPORT.z1)
        expect(b.environmentId).toBe(ex + 100 * ez)
      }
    }
  })

  it('removes ring water over the sea and keeps water inside the bounds', () => {
    const ring = terrainOf(RING_WATER.x, RING_WATER.z)!
    expect(ring.mapm.blocks[RING_WATER.bz * 6 + RING_WATER.bx]!.waterType).toBe(MAPM_WATER_NONE)
    const inside = terrainOf(PLAY_WATER.x, PLAY_WATER.z)!
    expect(inside.mapm.blocks[PLAY_WATER.bz * 6 + PLAY_WATER.bx]!.waterType).toBe(MAPM_WATER)
  })

  it('is deterministic', () => {
    const again = buildWorld()
    expect(Buffer.from(again.paint.words.buffer).equals(Buffer.from(W.paint.words.buffer))).toBe(true)
    for (const r of allRegions()) {
      const a = terrainOf(r.x, r.z)!.grid
      const b = again.source.terrain(r.x, r.z, again.regions.get(regionKey(r.x, r.z)) ?? null)!.grid
      expect(Buffer.from(b.heights.buffer).equals(Buffer.from(a.heights.buffer))).toBe(true)
      expect(Buffer.from(b.textures.buffer).equals(Buffer.from(a.textures.buffer))).toBe(true)
    }
  }, 120_000)
})

describe('coast paint and checks (./coast/paint.ts, ./coast/checks.ts)', () => {
  it('puts sand within 12 m of every sea shore outside the bounds', () => {
    const sand = checks.sandCoverage(W.result, W.cfg, W.masks, W.paint.words)
    expect(sand.shore).toBeGreaterThan(500)
    expect(sand.gaps.map(g => `${g.x.toFixed(2)},${g.z.toFixed(2)}`)).toEqual([])
  })

  it('paints the lowered flank below grassMaxDeg with grass, rock above rockFromDeg, the sea bed as seabed', () => {
    const f = checks.flankGrassShare(W.result, W.cfg, W.retail.heights, W.paint.words, id => id === GRASS || id === 7)
    expect(f.flank).toBeGreaterThan(1000)
    expect(f.share).toBeGreaterThanOrEqual(checks.FLANK_GRASS_SHARE)
    const rock = W.cfg.paint.palette.find(p => p.name === 'rock')!
    const seabed = W.cfg.paint.palette.find(p => p.name === 'seabed')!
    let steepRock = 0
    let steep = 0
    let deep = 0
    let deepSeabed = 0
    for (let i = 0; i < W.result.h.length; i++) {
      if (!W.paint.painted[i] || W.result.landFade[i]! >= 0.5) continue
      if (W.result.cls[i] === COAST_CLASS.land && W.result.slope[i]! > W.cfg.paint.rockFromDeg + 1) {
        steep++
        if (W.paint.words[i] === textureWord(rock.tile, rock.code)) steepRock++
      }
      if (W.result.cls[i] === COAST_CLASS.sea && W.result.h[i]! < W.cfg.seaLevelM - 1) {
        deep++
        if (W.paint.words[i] === textureWord(seabed.tile, seabed.code)) deepSeabed++
      }
    }
    expect(steepRock).toBe(steep)
    expect(deep).toBeGreaterThan(0)
    expect(deepSeabed).toBe(deep)
  })

  it('never paints the frozen playable set outside the patch, the tomb keep or a land edge', () => {
    const m = W.result.masks
    for (let i = 0; i < W.result.h.length; i++) {
      if (!W.paint.painted[i]) continue
      expect(m.tombKeep[i]).toBe(0)
      if (m.inPlay[i]) expect(m.patch[i]).toBe(1)
      if (m.have[i]) expect(W.result.landFade[i]!).toBeLessThan(0.5)
    }
  })

  it('reports no crease or new bench along the bounds line and the tomb keep line of the synthetic world', () => {
    expect(checks.lineCreases(W.result, W.retail.heights, W.cfg).findings.filter(f => f.added > 1)).toEqual([])
    expect(checks.keepLineCreases(W.result, W.retail.heights, W.cfg).findings).toEqual([])
    expect(checks.newBenches(W.result, W.retail.heights, W.cfg).findings).toEqual([])
    expect(checks.riverMouthFills(W.result, W.retail.heights).filled).toEqual([])
  })
})

/** A region navmesh: every tile in cell 0 (open), plus `closed` tiles in cell 1 (closed); heights from the grid. */
function nvmOf(heights: Float32Array, closed: (tx: number, tz: number) => boolean, objects: NvmObject[] = []): NvmFile {
  const tileCells = new Int32Array(NVM_TILES * NVM_TILES)
  const tileFlags = new Uint16Array(NVM_TILES * NVM_TILES)
  for (let tz = 0; tz < NVM_TILES; tz++) {
    for (let tx = 0; tx < NVM_TILES; tx++) {
      if (!closed(tx, tz)) continue
      tileCells[tz * NVM_TILES + tx] = 1
      tileFlags[tz * NVM_TILES + tx] = 1
    }
  }
  const cells: NvmCell[] = [{ minX: 0, minZ: 0, maxX: 1920, maxZ: 1920, objects: [] }, { minX: 0, minZ: 0, maxX: 20, maxZ: 20, objects: [] }]
  return {
    signature: 'JMXVNVM 1000', objects, cells, openCellCount: 1, globalEdges: [], internalEdges: [], tileRecordSize: 8,
    tileCells, tileFlags, heights: Float32Array.from(heights),
    planeTypes: new Uint8Array(36), planeHeights: new Float32Array(36),
  }
}

const navObject = (localUid: number, x: number, z: number): NvmObject => ({
  objId: 1, position: [x, 0, z], type: -1, yaw: 0, localUid, unknownShort0: 0, isBig: false, isStruct: false, regionId: 0, links: [],
})

describe('coast navigation (./coast/navgen.ts)', () => {
  it('leaves an untouched region alone (the same object)', () => {
    const reg = W.regions.get(regionKey(14, 14))!
    const nvm = nvmOf(reg.grid.heights, () => false)
    expect(W.source.navEdit(14, 14, reg)).toBeNull()
    const e = { x: 14, z: 14, heights: null, moved: null, ring: false, seaLevelM: 5, openTiles: [], removedWater: new Set<number>() }
    expect(editRegionNav(nvm, e).nvm).toBe(nvm)
  })

  it('rewrites a ring region: heights equal the terrain, flanks above the beach band close, retail-closed tiles stay closed', () => {
    const reg = W.regions.get(regionKey(13, 12))!
    const retailClosed = (tx: number, tz: number) => tx === 40 && tz === 90
    const edit = W.source.navEdit(13, 12, reg)!
    expect(edit.ring).toBe(true)
    const { nvm, stats } = editRegionNav(nvmOf(reg.grid.heights, retailClosed), edit)
    const grid = terrainOf(13, 12)!.grid
    expect(Buffer.from(nvm.heights.buffer).equals(Buffer.from(grid.heights.buffer))).toBe(true)
    expect(stats.closed).toBeGreaterThan(100)
    expect(stats.opened).toBe(0)
    expect(nvm.tileCells[90 * NVM_TILES + 40]! >= nvm.openCellCount).toBe(true)
    const SL = W.cfg.seaLevelM
    for (let tz = 0; tz < NVM_TILES; tz++) {
      for (let tx = 0; tx < NVM_TILES; tx++) {
        const open = nvm.tileCells[tz * NVM_TILES + tx]! < nvm.openCellCount
        const h = [grid.heights[tz * G + tx]!, grid.heights[tz * G + tx + 1]!, grid.heights[(tz + 1) * G + tx]!, grid.heights[(tz + 1) * G + tx + 1]!]
        // an open tile touching moved ground lies in the knee-deep .. beach band
        if (open && [0, 1, G, G + 1].some(o => edit.moved![tz * G + tx + o])) {
          for (const v of h) {
            expect(v / 10).toBeGreaterThanOrEqual(SL - 0.4 - 1e-4)
            expect(v / 10).toBeLessThanOrEqual(SL + NAV_BEACH_BAND_M + 1e-4)
          }
        }
        if (!open) expect(nvm.tileFlags[tz * NVM_TILES + tx]! & 1).toBe(1)
      }
    }
  })

  it('opens the openTiles rectangles inside the bounds and nothing else', () => {
    const reg = W.regions.get(regionKey(14, 14))!
    const wall = (tx: number, tz: number) => tz >= 40 && tz <= 42
    const rects = tilesToRowRects([{ tx: 14 * 96 + 10, tz: 14 * 96 + 40 }, { tx: 14 * 96 + 10, tz: 14 * 96 + 41 }, { tx: 14 * 96 + 10, tz: 14 * 96 + 42 }])
    const { nvm, stats } = editRegionNav(nvmOf(reg.grid.heights, wall), {
      x: 14, z: 14, heights: null, moved: null, ring: false, seaLevelM: 5, openTiles: rects, removedWater: new Set(),
    })
    expect(stats.opened).toBe(3)
    for (let tz = 40; tz <= 42; tz++) {
      expect(nvm.tileCells[tz * NVM_TILES + 10]! < nvm.openCellCount).toBe(true)
      expect(nvm.tileFlags[tz * NVM_TILES + 10]! & 1).toBe(0)
      expect(nvm.tileCells[tz * NVM_TILES + 11]! < nvm.openCellCount).toBe(false)
    }
  })

  it('drops water planes where the water went and nav objects on moved ground outside the bounds', () => {
    const reg = W.regions.get(regionKey(RING_WATER.x, RING_WATER.z))!
    const edit = W.source.navEdit(RING_WATER.x, RING_WATER.z, reg)!
    expect(edit.removedWater.has(RING_WATER.bz * 6 + RING_WATER.bx)).toBe(true)
    // an object on moved ground and one on ground the coast left alone
    let movedAt: [number, number] | null = null
    let stillAt: [number, number] | null = null
    for (let g = 0; g < G * G && !(movedAt && stillAt); g++) {
      const at: [number, number] = [(g % G) * 20, Math.floor(g / G) * 20]
      if (edit.moved![g] && !movedAt) movedAt = at
      if (!edit.moved![g] && !stillAt) stillAt = at
    }
    expect(movedAt && stillAt).toBeTruthy()
    const src = nvmOf(reg.grid.heights, () => false, [navObject(1, movedAt![0], movedAt![1]), navObject(2, stillAt![0], stillAt![1])])
    src.planeTypes![RING_WATER.bz * 6 + RING_WATER.bx] = 1
    src.objects[0]!.links = [{ linkedObject: 1, linkedObjectEdge: 0, edge: 0 }]
    src.objects[1]!.links = [{ linkedObject: 0, linkedObjectEdge: 0, edge: 1 }]
    src.cells[0]!.objects = [0, 1]
    const { nvm, stats } = editRegionNav(src, edit)
    expect(stats.planesDropped).toBe(1)
    expect(nvm.planeTypes![RING_WATER.bz * 6 + RING_WATER.bx]).toBe(0)
    expect(stats.objectsDropped).toBe(1)
    expect(nvm.objects.map(o => o.localUid)).toEqual([2])
    expect(nvm.objects[0]!.links).toEqual([])
    expect(nvm.cells[0]!.objects).toEqual([0])
  })
})

const model = (index: number, source: string, size = 2): WorldModel => ({
  index, source, glb: `models/${index}.glb`, sidecar: `models/${index}.json`, kind: 'static', animations: [], defaultClip: null,
  lightmappedMeshes: 0, boundsMin: [-size, 0, -size], boundsMax: [size, 5, size], bytes: 1, validatorErrors: 0,
})

/** A placement at region coordinates (x, z), glTF metres relative to region (14, 14)'s south-west corner. */
const placementAt = (uid: number, x: number, z: number, y: number, models: number[], source: string): WorldPlacement => ({
  objId: uid, source, models, compound: false, position: [192 * (x - 14), y, -192 * (z - 14)], rotation: [0, 0, 0, 1], yaw: 0,
  flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid, region: (Math.floor(z) << 8) | Math.floor(x), group: 3,
  inConvertedRegion: true,
})

describe('C9 and S-DRAW (./coast/placements.ts through ../passes.ts)', () => {
  it('drops a rock on moved ground, re-snaps a tree above the sea, lists big footprints, and no later pass sees a dropped uid', async () => {
    const models = [model(0, 'res\\rock01.bsr'), model(1, 'res\\tree01.bsr'), model(2, 'res\\big_wall.bsr', 400)]
    // find moved ground above the sea on the south flank, and moved ground in the sea
    const r = W.result
    let dryMoved: [number, number] | null = null
    let wetMoved: [number, number] | null = null
    for (let i = 0; i < r.h.length && !(dryMoved && wetMoved); i++) {
      if (r.masks.inPlay[i] || !r.masks.have[i]) continue
      const d = Math.abs(r.h[i]! - W.retail.heights[i]!)
      if (d < 3) continue
      const c = i % r.shape.cols
      const at: [number, number] = [colX(r.shape, c), rowZ(r.shape, (i - c) / r.shape.cols)]
      if (r.h[i]! > W.cfg.seaLevelM + 2 && !dryMoved) dryMoved = at
      if (r.h[i]! < W.cfg.seaLevelM - 2 && !wetMoved) wetMoved = at
    }
    expect(dryMoved && wetMoved).toBeTruthy()
    const placements = [
      placementAt(1, dryMoved![0], dryMoved![1], 50, [0], 'res\\rock01.bsr'),
      placementAt(2, dryMoved![0], dryMoved![1], 50, [1], 'res\\tree01.bsr'),
      placementAt(3, wetMoved![0], wetMoved![1], 50, [1], 'res\\tree01.bsr'),
      placementAt(4, 14.5, 14.5, 10, [2], 'res\\big_wall.bsr'),
    ]
    const c9 = placementEdits(W.result, W.cfg, W.retail.heights, { x: 14, z: 14 }, placements, models)
    expect(c9.edits.drop.map(d => d.uid).sort()).toEqual([1, 3])
    expect(c9.listed.map(d => d.uid)).toEqual([1])
    expect(c9.edits.resnap.map(d => d.uid)).toEqual([2])
    expect(c9.footprints.map(f => f.uid)).toEqual([4])
    // the pipeline: the static-variant and grass passes never see the dropped uids
    const seen: number[][] = []
    const passed = await runWorldPasses({ outDir: '/x', origin: { x: 14, z: 14 }, regions: [], tiles: [], models, placements, warnings: [] }, {
      coast: { placementEdits: () => c9.edits },
      staticVariants: ctx => (seen.push(ctx.placements.map(p => p.uid)), []),
      grass: ctx => (seen.push(ctx.placements.map(p => p.uid)), []),
    })
    expect(passed.placements.map(p => p.uid)).toEqual([2, 4])
    expect(seen).toEqual([[2, 4], [2, 4]])
    expect(passed.coastReport!.placements.dropped.map(d => d.uid).sort()).toEqual([1, 3])
  })
})

describe('the coast field (./coast/field.ts)', () => {
  it('marks the sea (never the frozen playable ground), the distance to the shore and the depth or height', () => {
    const f = coastField(W.result, W.cfg, W.masks)
    const l = W.result.shape
    expect(f.width).toBe(Math.floor((l.cols - 1) / 2))
    expect(f.height).toBe(Math.floor((l.rows - 1) / 2))
    let sea = 0
    let land = 0
    for (let tz = 0; tz < f.height; tz++) {
      for (let tx = 0; tx < f.width; tx++) {
        const k = Math.min(l.rows - 1, tz * 2 + 1) * l.cols + Math.min(l.cols - 1, tx * 2 + 1)
        const o = (tz * f.width + tx) * 4
        if (W.masks.ocean[k]) {
          sea++
          expect(f.rgba[o + 2]).toBe(Math.max(0, Math.min(255, Math.round((W.cfg.seaLevelM - W.result.h[k]!) / 0.2))))
        } else {
          if (W.result.masks.inPlay[k] && !W.result.masks.patch[k] && !W.result.masks.wetR[k]) expect(W.masks.sea[k]).toBe(0)
          if (!W.result.masks.waterSurface[k]) land++
        }
        expect(f.rgba[o + 3]).toBe(0)
      }
    }
    expect(sea).toBeGreaterThan(1000)
    expect(land).toBeGreaterThan(1000)
  })

  it('computes exact Euclidean distances', () => {
    const m = new Uint8Array(25)
    m[12] = 1
    const d = distanceTo(m, 5, 5)
    expect(d[12]).toBe(0)
    expect(d[0]).toBeCloseTo(Math.SQRT2 * 2, 6)
    expect(d[14]).toBe(2)
    expect(distanceTo(new Uint8Array(4), 2, 2)[0]).toBe(Infinity)
  })
})

describe('the lightmap bake (./coast/lightmap.ts)', () => {
  it('leaves an unmoved region alone and re-bakes moved ground to the retail levels, keeping the texels outside', () => {
    expect(bakeRegionLightmap(W.result, W.retail.heights, 14, 14, null, 64)).toBeNull()
    const base = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4).fill(200) }
    const img = bakeRegionLightmap(W.result, W.retail.heights, 15, 13, base, 64)!
    let baked = 0
    let kept = 0
    for (let j = 0; j < 64; j++) {
      for (let i = 0; i < 64; i++) {
        const v = img.rgba[(j * 64 + i) * 4]!
        if (v === 200) kept++
        else {
          baked++
          expect(v).toBeGreaterThanOrEqual(LIGHTMAP_SHADOW - 50)
          expect(v).toBeLessThanOrEqual(LIGHTMAP_LIT)
        }
      }
    }
    expect(baked).toBeGreaterThan(100)
    expect(kept).toBeGreaterThan(0)
  })
})

describe('S1 link search (./coast/links.ts)', () => {
  /** Region (100, 50): a wall of closed tiles across z 40-42 splits it (home south, the beach north); the open region
   *  east of it, outside the rectangle, joins the halves. */
  function wallWorld(): { data: ReturnType<typeof buildNavData>; home: { x: number; y: number; z: number }; beach: { x: number; z: number } } {
    const heights = new Float32Array(G * G)
    const nvm = nvmOf(heights, (_tx, tz) => tz >= 40 && tz <= 42)
    const outside = nvmOf(heights, () => false)
    const data = buildNavData({ regions: [{ id: (50 << 8) | 100, nvm }, { id: (50 << 8) | 101, nvm: outside }], objectNavMesh: () => null })
    return { data, home: { x: 100 * 1920 + 500, y: 0, z: 50 * 1920 + 200 }, beach: { x: 100 * 1920 + 500, z: 50 * 1920 + 1500 } }
  }
  const rect = { x0: 100, x1: 100, z0: 50, z1: 50 }

  it('finds the cheapest in-bounds tiles when the only open route runs outside the rectangle, and they verify', () => {
    const { data, home, beach } = wallWorld()
    expect(reachesBothWays(new NavWorld(data), beach, home)).toBe(true)
    const closed = closeRing(data, rect)
    const world = new NavWorld(closed)
    expect(reachesBothWays(world, beach, home)).toBe(false)
    const link = findInBoundsLink(world, beach, home, rect)
    expect(link.tiles.length).toBe(3)
    const band = widenLink(world, link.tiles, 1, rect)
    expect(band.length).toBeGreaterThanOrEqual(3)
    const rects = tilesToRowRects(band)
    for (const r of closed.regions) {
      for (let t = 0; t < NVM_TILES * NVM_TILES; t++) {
        const tx = r.rx * NVM_TILES + (t % NVM_TILES)
        const tz = r.rz * NVM_TILES + Math.floor(t / NVM_TILES)
        if (rects.some(q => (tx + 0.5) / 96 >= q.x[0] && (tx + 0.5) / 96 <= q.x[1] && (tz + 0.5) / 96 >= q.z[0] && (tz + 0.5) / 96 <= q.z[1])) r.tileCells[t] = 0
      }
    }
    expect(reachesBothWays(new NavWorld(closed), beach, home)).toBe(true)
  })
})

describe('the Option A corridor, phase 2 (CST-C2; COAST §4, C12)', () => {
  /** The synthetic world with a land bridge west of the bounds, retail land beyond the export on its Donwhang side. */
  const CORR = { x: [8, 13] as [number, number], z: [13.6, 14.6] as [number, number] }
  const BEYOND = [{ x: 10, z: 13 }, { x: 11, z: 13 }, { x: 10, z: 14 }, { x: 11, z: 14 }]
  let C: World
  beforeAll(() => {
    const base = synthConfig()
    C = buildWorld({
      ...base, option: 'A', phase: 2, corridor: { x: CORR.x, z: CORR.z },
      sections: [
        ...base.sections,
        { code: 'CS', side: 'corridor-south', from: 10, to: 12, kind: 'mountain', c0: 70, amp: 20, phase: 2 },
        { code: 'CN', side: 'corridor-north', from: 10, to: 12, kind: 'wide', c0: 95, amp: 20, phase: 2 },
      ],
    }, BEYOND)
  }, 120_000)

  it('keeps the corridor retail bit for bit (dry ground never sea or sand) and blends the ring from its faces', () => {
    const r = C.result
    let n = 0
    for (let i = 0; i < r.h.length; i++) {
      if (!r.masks.inCorr[i] || !r.masks.have[i]) continue
      n++
      expect(r.h[i]).toBe(C.retail.heights[i])
      if (!r.masks.wetR[i]) expect(r.cls[i]).toBe(COAST_CLASS.land)
    }
    expect(n).toBeGreaterThan(20_000)
    // the faces: no crease the retail did not have (lineCreases now walks them too)
    const faces = checks.seaLineVertices(r, C.cfg.corridor).filter(v => v.side === 'corridor-south' || v.side === 'corridor-north')
    expect(faces.length).toBeGreaterThan(2 * 2 * CELLS_PER_REGION)
    for (const v of faces) {
      expect(r.masks.inCorr[v.i]).toBe(1)
      expect(r.masks.inCorr[v.i + v.dr * r.shape.cols]).toBe(0)
    }
    const line = checks.lineCreases(r, C.retail.heights, C.cfg)
    expect(line.findings.filter(f => f.side.startsWith('corridor'))).toEqual([])
    // the playable line next to the corridor is no sea side
    expect(checks.seaLineVertices(r, C.cfg.corridor).filter(v => v.side === 'west' && v.z > CORR.z[0] + 0.25 && v.z < CORR.z[1] - 0.25)).toEqual([])
  })

  it('builds an emitted region over the corridor from its retail .m: synthetic, its water, environment and file units', () => {
    expect(C.source.isLookOnly(11, 14)).toBe(true)
    expect(C.source.isLookOnly(11, 12)).toBe(false)
    expect(C.source.isLookOnly(14, 14)).toBe(false)
    const reg = C.regions.get(regionKey(11, 14))!
    const t = C.source.terrain(11, 14, reg)!
    expect(t.synthetic).toBe(true)
    const pond = t.mapm.blocks.find(b => b.bx === CORRIDOR_WATER.bx && b.bz === CORRIDOR_WATER.bz)!
    expect(pond.waterType).toBe(MAPM_WATER)
    expect(pond.waterHeight).toBe(CORRIDOR_WATER.h * 10)
    expect(t.mapm.blocks.every(b => b.environmentId === 11 + 100 * 14)).toBe(true)
    // the corridor's rows (z <= 14.6) keep the retail file units and texture words
    for (let gz = 0; gz <= Math.floor(0.6 * CELLS_PER_REGION); gz++) {
      for (let gx = 0; gx < G; gx++) {
        expect(t.grid.heights[gz * G + gx]).toBe(reg.grid.heights[gz * G + gx])
        expect(t.grid.textures[gz * G + gx]).toBe(reg.grid.textures[gz * G + gx])
      }
    }
    // a made-up synthetic region elsewhere still has no water and the nearest exported environment
    const sea = C.source.synthetic.find(q => !C.source.isLookOnly(q.x, q.z))!
    expect(C.source.terrain(sea.x, sea.z, C.regions.get(regionKey(sea.x, sea.z)) ?? null)!.mapm.blocks.every(b => b.waterType === MAPM_WATER_NONE)).toBe(true)
  })

  it('refuses an authored layer with weight on the corridor', () => {
    const h = new Float32Array(G * G).fill(50)
    const w = new Float32Array(G * G)
    w[48 * G + 48] = 1
    const before = C.result.h.slice()
    const errors: string[] = []
    const m = mergeAuthoredHeights(C.result, [{ x: 11, z: 14, h, w, file: '11_14.png' }], errors)
    expect(m.layers).toBe(0)
    expect(errors.join()).toMatch(/corridor/)
    expect(C.result.h).toEqual(before)
  })
})
