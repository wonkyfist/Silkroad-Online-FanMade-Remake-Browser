/**
 * The coast as a region-source overlay for ../convert-world.ts (docs/COAST.md §5.4): what the converter reads for a
 * region's terrain, for the normals' global heights and for the region's navmesh once the coast pass has run. Node-free.
 *
 * - `terrain(x, z, retail)`: an exported region the coast changes comes back as a new MapMFile (heights, texture words,
 *   water blocks) with its assembled grid; one it leaves alone comes back as the retail object itself; an emitted
 *   synthetic region (land or shallow water beyond the retail export) is built from scratch, its blocks taking the
 *   environment profile of the nearest exported block and no water (the ocean draws the sea), except a look-only one
 *   (`isLookOnly`: it overlaps Option A's corridor, the retail land bridge toward Donwhang, and has retail terrain),
 *   which is built like a changed exported region from its retail .m: retail where the coast leaves it alone (the
 *   corridor is frozen), its retail water outside the sea, and convert-world keeps its retail lightmap and minimap;
 * - `height(ggx, ggz)`: the global lattice height in file units for buildNormals (the overlay's, so the lighting has no
 *   seam where a changed region meets an unchanged one); undefined outside the coast domain (the caller reads retail);
 * - `navEdit(x, z)`: what ./navgen.ts needs to rewrite the region's navmesh consistently with its terrain.
 *
 * A drowned region (./drown.ts) takes the ring's rules wherever it lies (its water blocks in the sea go, the nav's ring
 * rule, objects on moved ground dropped) and is never look-only.
 *
 * A vertex the coast leaves alone (within 0.1 mm) keeps its retail file units bit for bit, so the frozen playable set,
 * the tomb keep and the land edges are byte-identical in every copy.
 */
import {
  assembleRegionGrid, MAPM_BLOCK_TILES, MAPM_BLOCK_VERTICES, MAPM_BLOCKS, MAPM_TEXTURE_ID_MASK, MAPM_WATER, MAPM_WATER_NONE,
  type MapMBlock, type MapMFile, type RegionGrid,
} from '@sro/formats'
import { BANK_FILL_M } from './banks.ts'
import type { EmittedRegion } from './census.ts'
import type { CoastConfig } from './config.ts'
import { drownedRegions } from './drown.ts'
import type { SeaMasks } from './field.ts'
import { CELLS_PER_REGION, latticeIndex } from './lattice.ts'
import { NAV_KNEE_DEEP_M, type NavRegionEdit } from './navgen.ts'
import type { CoastPaint } from './paint.ts'
import type { CoastResult } from './pass.ts'
import { regionKey, type RetailLattice, type RetailRegion } from './retail.ts'

/** A vertex within this of its retail height (m) is unchanged: it keeps its retail file units. */
export const UNCHANGED_M = 1e-4
const G = CELLS_PER_REGION + 1

export interface RegionTerrain {
  mapm: MapMFile
  grid: RegionGrid
  synthetic: boolean
}

interface Overlay {
  terrain: RegionTerrain
  /** New file-unit heights when they changed, else null. */
  heights: Float32Array | null
  /** 97 x 97: the ground moved by more than placements.dropMovedM (or has no retail height). */
  moved: Uint8Array
  removedWater: Set<number>
  changed: boolean
}

export interface CoastSourceOptions {
  cfg: CoastConfig
  retail: RetailLattice
  result: CoastResult
  paint: CoastPaint
  masks: SeaMasks
  /** The exported regions (the preset's rectangle; the active ones have retail terrain). */
  exportRegions: ReadonlyArray<{ x: number; z: number }>
  /** The synthetic regions to emit (./census.ts emitCensus). */
  emitted: ReadonlyArray<EmittedRegion>
  /** Lattice vertices ./banks.ts filled beside in-bounds sea-level water: a ring block over one gets water at SL. */
  bankFilled?: Uint8Array
}

export class CoastSource {
  readonly synthetic: ReadonlyArray<{ x: number; z: number }>
  private readonly syn: Set<number>
  private readonly overlays = new Map<number, Overlay | null>()
  private readonly envBlocks: Array<{ x: number; z: number; env: number }> = []
  /** Drowned regions (./drown.ts): open sea, so the ring's rules apply to them wherever they lie. */
  private readonly drowned: Set<number>

  constructor(private readonly o: CoastSourceOptions) {
    this.synthetic = o.emitted.map(e => ({ x: e.x, z: e.z })).sort((a, b) => a.z - b.z || a.x - b.x)
    this.syn = new Set(this.synthetic.map(r => regionKey(r.x, r.z)))
    this.drowned = drownedRegions(o.result)
    for (const { x, z } of o.exportRegions) {
      const reg = o.retail.regions.get(regionKey(x, z))
      if (!reg) continue
      for (const b of reg.mapm.blocks) this.envBlocks.push({ x: x + (b.bx + 0.5) / MAPM_BLOCKS, z: z + (b.bz + 0.5) / MAPM_BLOCKS, env: b.environmentId })
    }
  }

  isSynthetic(x: number, z: number): boolean {
    return this.syn.has(regionKey(x, z))
  }

  /**
   * Whether an emitted region is look-only retail land: it overlaps the corridor (Option A's land bridge, COAST §4) and
   * has retail terrain, so it is built from its retail .m (see the header) while staying synthetic (no navigation,
   * outside the playable rectangle).
   */
  isLookOnly(x: number, z: number): boolean {
    const c = this.o.cfg.corridor
    if (!c || !this.syn.has(regionKey(x, z)) || !this.o.retail.regions.has(regionKey(x, z)) || this.drowned.has(regionKey(x, z))) return false
    return x + 1 > c.x[0] && x < c.x[1] && z + 1 > c.z[0] && z < c.z[1]
  }

  /** File units of lattice vertex k: retail as stored where the coast left it, else the coast height. */
  fileUnits(k: number): number {
    const r = this.o.result
    const h = r.h[k]!
    const H = this.o.retail.heights[k]!
    if (r.masks.have[k] && Math.abs(h - H) <= UNCHANGED_M) return this.o.retail.fileUnits[k]!
    return Math.fround(h * 10)
  }

  /** Global lattice height (file units) for the normals; undefined outside the coast domain. */
  height(ggx: number, ggz: number): number | undefined {
    const k = latticeIndex(this.o.result.shape, ggx, ggz)
    return k < 0 ? undefined : this.fileUnits(k)
  }

  /** The region's terrain after the coast (see the header); null when the region has none. */
  terrain(x: number, z: number, retail: RetailRegion | null): RegionTerrain | null {
    return this.overlay(x, z, retail)?.terrain ?? (retail ? { ...retail, synthetic: false } : null)
  }

  /** Whether the coast changed the region's terrain (heights, paint or water). */
  changed(x: number, z: number, retail: RetailRegion | null): boolean {
    return this.overlay(x, z, retail)?.changed ?? false
  }

  /** What ./navgen.ts needs for the region (null: the coast leaves its navigation alone). */
  navEdit(x: number, z: number, retail: RetailRegion | null): NavRegionEdit | null {
    const ov = this.overlay(x, z, retail)
    const cfg = this.o.cfg
    const p = this.o.result.playable
    const ring = x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1 || this.drowned.has(regionKey(x, z))
    const opens = !ring && cfg.openTiles.some(q => q.x[1] >= x && q.x[0] <= x + 1 && q.z[1] >= z && q.z[0] <= z + 1)
    if (!ov?.changed && !opens && !ring) return null
    const moved = ov?.moved ?? null
    return {
      x, z, heights: ov?.heights ?? null, moved, ring, seaLevelM: cfg.seaLevelM, openTiles: cfg.openTiles,
      deep: ring ? null : this.deepIn(x, z),
      removedWater: ov?.removedWater ?? new Set(),
      dropObject: ring ? (lx, lz) => this.movedAt(x + lx / 1920, z + lz / 1920) : undefined,
    }
  }

  /** Region (x, z)'s height-patch sea vertices more than knee-deep (./navgen.ts `deep`, C7), or null when none. */
  private deepIn(x: number, z: number): Uint8Array | null {
    const r = this.o.result
    const lo = this.o.cfg.seaLevelM - NAV_KNEE_DEEP_M
    let out: Uint8Array | null = null
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const k = this.k(x, z, gx, gz)
        if (!r.masks.patch[k] || !r.masks.waterSurface[k] || !(r.h[k]! < lo)) continue
        out ??= new Uint8Array(G * G)
        out[gz * G + gx] = 1
      }
    }
    return out
  }

  /** Whether the ground at region coordinates (x, z) moved by more than dropMovedM. */
  movedAt(x: number, z: number): boolean {
    const r = this.o.result
    const { cols, x0, z1 } = r.shape
    const c = Math.round((x - x0) * CELLS_PER_REGION)
    const row = Math.round((z1 + 1 - z) * CELLS_PER_REGION)
    if (c < 0 || row < 0 || c >= cols || row >= r.shape.rows) return false
    const k = row * cols + c
    const H = this.o.retail.heights[k]!
    return !Number.isNaN(H) && Math.abs(r.h[k]! - H) > this.o.cfg.placements.dropMovedM
  }

  private overlay(x: number, z: number, retail: RetailRegion | null): Overlay | null {
    const key = regionKey(x, z)
    if (this.overlays.has(key)) return this.overlays.get(key)!
    const l = this.o.result.shape
    let ov: Overlay | null = null
    if (x >= l.x0 && x <= l.x1 && z >= l.z0 && z <= l.z1) {
      if (this.syn.has(key)) ov = retail && this.isLookOnly(x, z) ? this.buildChanged(x, z, retail, true) : this.buildSynthetic(x, z)
      else if (retail) ov = this.buildChanged(x, z, retail, false)
    }
    this.overlays.set(key, ov)
    return ov
  }

  /** Lattice index of region vertex (gx, gz). */
  private k(x: number, z: number, gx: number, gz: number): number {
    const l = this.o.result.shape
    return ((l.z1 - z) * CELLS_PER_REGION + CELLS_PER_REGION - gz) * l.cols + (x - l.x0) * CELLS_PER_REGION + gx
  }

  private buildChanged(x: number, z: number, retail: RetailRegion, synthetic: boolean): Overlay {
    const { result: r, paint, masks, cfg } = this.o
    const fu = new Float32Array(G * G)
    const words = new Uint16Array(G * G)
    const moved = new Uint8Array(G * G)
    const sea = new Uint8Array(G * G)
    let hChanged = false
    let wChanged = false
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const k = this.k(x, z, gx, gz)
        const g = gz * G + gx
        fu[g] = this.fileUnits(k)
        if (fu[g] !== retail.grid.heights[g]) hChanged = true
        words[g] = paint.words[k]!
        if (words[g] !== retail.grid.textures[g]) wChanged = true
        const H = this.o.retail.heights[k]!
        moved[g] = !r.masks.have[k] || Number.isNaN(H) || Math.abs(r.h[k]! - H) > cfg.placements.dropMovedM ? 1 : 0
        sea[g] = masks.sea[k]!
      }
    }
    const p = r.playable
    const ring = x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1 || this.drowned.has(regionKey(x, z))
    const removedWater = new Set<number>()
    if (ring) {
      for (const b of retail.mapm.blocks) {
        if (b.waterType === MAPM_WATER_NONE) continue
        let hit = false
        for (let vz = 0; vz < MAPM_BLOCK_VERTICES && !hit; vz++) {
          for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
            const g = (b.bz * MAPM_BLOCK_TILES + vz) * G + b.bx * MAPM_BLOCK_TILES + vx
            if (sea[g] || moved[g]) {
              hit = true
              break
            }
          }
        }
        if (hit) removedWater.add(b.index)
      }
    } else if (r.masks.opened) {
      // the opened water (./drown.ts drown.openWater): its blocks go, the ocean draws them
      for (const b of retail.mapm.blocks) {
        if (b.waterType === MAPM_WATER_NONE) continue
        let hit = false
        for (let vz = 0; vz < MAPM_BLOCK_VERTICES && !hit; vz++) {
          for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
            if (r.masks.opened[this.k(x, z, b.bx * MAPM_BLOCK_TILES + vx, b.bz * MAPM_BLOCK_TILES + vz)]) {
              hit = true
              break
            }
          }
        }
        if (hit) removedWater.add(b.index)
      }
    }
    // W10R CST-H1 (./banks.ts): a dry ring block over a filled bank takes water at the sea level, so the in-bounds
    // plane continues into the berm (buried BANK_FILL_M under it) and never ends over the slot down to the retail bed at
    // the line; never where the ocean draws (no double water layer)
    const addedWater = new Set<number>()
    const filled = this.o.bankFilled
    if (ring && filled) {
      for (const b of retail.mapm.blocks) {
        if (b.waterType !== MAPM_WATER_NONE) continue
        // only where the plane stays buried on every vertex but the in-bounds retail water's (the same plane carries on
        // there): its own edges then never show over a lower ground. The bank's own vertices stand at least BANK_FILL_M
        // above SL (no depth fighting with the bank's ramp just above it, P-DATA); other ground at or above SL, as in
        // W10R (the polish gate: a vertex of retail ground 0.1 m above SL beside the line must not leave the block dry)
        let bank = false
        let ok = true
        for (let vz = 0; vz < MAPM_BLOCK_VERTICES && ok; vz++) {
          for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
            const k = this.k(x, z, b.bx * MAPM_BLOCK_TILES + vx, b.bz * MAPM_BLOCK_TILES + vz)
            if (masks.ocean[k] || (!(r.masks.inPlay[k] && r.masks.waterLow[k]) && !(r.h[k]! >= cfg.seaLevelM + (filled[k] ? BANK_FILL_M - 0.01 : 0)))) {
              ok = false
              break
            }
            if (filled[k]) bank = true
          }
        }
        if (bank && ok) addedWater.add(b.index)
      }
    }
    const changed = hChanged || wChanged || removedWater.size > 0 || addedWater.size > 0
    if (!changed) return { terrain: { ...retail, synthetic }, heights: null, moved, removedWater, changed }
    const waterAt = Math.round(cfg.seaLevelM * 10)
    const blocks = retail.mapm.blocks.map(b => {
      const nb = rebuildBlock(b, fu, words, removedWater.has(b.index))
      return addedWater.has(b.index) ? { ...nb, waterType: MAPM_WATER, waterWaveType: 0, waterHeight: waterAt } : nb
    })
    const mapm: MapMFile = { signature: retail.mapm.signature, blocks }
    return { terrain: { mapm, grid: assembleRegionGrid(mapm), synthetic }, heights: hChanged ? fu : null, moved, removedWater, changed }
  }

  private buildSynthetic(x: number, z: number): Overlay {
    const fu = new Float32Array(G * G)
    const words = new Uint16Array(G * G)
    const moved = new Uint8Array(G * G).fill(1)
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const k = this.k(x, z, gx, gz)
        fu[gz * G + gx] = this.fileUnits(k)
        words[gz * G + gx] = this.o.paint.words[k]!
      }
    }
    const blocks: MapMBlock[] = []
    for (let bz = 0; bz < MAPM_BLOCKS; bz++) {
      for (let bx = 0; bx < MAPM_BLOCKS; bx++) {
        const env = this.nearestEnv(x + (bx + 0.5) / MAPM_BLOCKS, z + (bz + 0.5) / MAPM_BLOCKS)
        const n = MAPM_BLOCK_VERTICES * MAPM_BLOCK_VERTICES
        const base: MapMBlock = {
          index: bz * MAPM_BLOCKS + bx, bx, bz, flag: 0, environmentId: env,
          heights: new Float32Array(n), textures: new Uint16Array(n), textureIds: new Uint16Array(n), textureHighBits: new Uint8Array(n),
          brightness: new Uint8Array(n), waterType: MAPM_WATER_NONE, waterWaveType: 0, waterHeight: 0,
          tileFlags: new Uint16Array(MAPM_BLOCK_TILES * MAPM_BLOCK_TILES), heightMax: 0, heightMin: 0, unknown: new Uint8Array(20),
        }
        blocks.push(rebuildBlock(base, fu, words, true))
      }
    }
    const mapm: MapMFile = { signature: 'JMXVMAPM1000', blocks }
    return { terrain: { mapm, grid: assembleRegionGrid(mapm), synthetic: true }, heights: fu, moved, removedWater: new Set(), changed: true }
  }

  private nearestEnv(x: number, z: number): number {
    let best = Infinity
    let env = 0
    for (const b of this.envBlocks) {
      const d = (b.x - x) ** 2 + (b.z - z) ** 2
      if (d < best) {
        best = d
        env = b.env
      }
    }
    return env
  }
}

/** A block with its 17 x 17 heights and texture words from the region's 97 x 97 arrays; `dry` removes its water. */
function rebuildBlock(b: MapMBlock, fu: Float32Array, words: Uint16Array, dry: boolean): MapMBlock {
  const n = MAPM_BLOCK_VERTICES * MAPM_BLOCK_VERTICES
  const heights = new Float32Array(n)
  const textures = new Uint16Array(n)
  const textureIds = new Uint16Array(n)
  const textureHighBits = new Uint8Array(n)
  let hMax = -Infinity
  let hMin = Infinity
  for (let vz = 0; vz < MAPM_BLOCK_VERTICES; vz++) {
    for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
      const g = (b.bz * MAPM_BLOCK_TILES + vz) * G + b.bx * MAPM_BLOCK_TILES + vx
      const s = vz * MAPM_BLOCK_VERTICES + vx
      heights[s] = fu[g]!
      textures[s] = words[g]!
      textureIds[s] = words[g]! & MAPM_TEXTURE_ID_MASK
      textureHighBits[s] = words[g]! >>> 10
      hMax = Math.max(hMax, fu[g]!)
      hMin = Math.min(hMin, fu[g]!)
    }
  }
  return {
    ...b, heights, textures, textureIds, textureHighBits, heightMax: hMax, heightMin: hMin,
    ...(dry ? { waterType: MAPM_WATER_NONE, waterWaveType: 0, waterHeight: 0 } : {}),
  }
}
