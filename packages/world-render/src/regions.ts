import {
  GRID,
  decodeNavmeshBin,
  decodeTerrainBin,
  terrainHeightAt,
  type NavmeshBin,
  type TerrainBin,
} from '../../convert/src/world/format.ts'
import type { WorldManifest, WorldRegion } from '../../convert/src/world/manifest.ts'
import { mapLimit, type Assets } from './assets.ts'

export interface RegionData {
  region: WorldRegion
  terrain: TerrainBin
  navmesh: NavmeshBin | null
}

/**
 * Loaded region binaries (terrain + navmesh bins) plus the render-grid height query. The whole-world load fills it
 * once (load); region streaming adds and removes regions as they come and go (add / remove).
 */
export class WorldRegions {
  readonly regions: RegionData[] = []
  private readonly byId = new Map<number, RegionData>()
  private readonly ox: number
  private readonly oz: number

  constructor(readonly manifest: WorldManifest) {
    this.ox = manifest.space.originRegion.x
    this.oz = manifest.space.originRegion.z
  }

  async load(assets: Assets, onProgress: (done: number) => void): Promise<void> {
    let done = 0
    const loaded = await mapLimit(this.manifest.regions, 6, async region => {
      const terrain = decodeTerrainBin(await assets.bytesOf(region.terrain.file))
      let navmesh: NavmeshBin | null = null
      if (region.navmesh) {
        try {
          navmesh = decodeNavmeshBin(await assets.bytesOf(region.navmesh.file))
        } catch (err) {
          console.warn(`[world] navmesh ${region.navmesh.file}:`, err)
        }
      }
      onProgress(++done)
      return { region, terrain, navmesh }
    })
    for (const data of loaded) this.add(data)
  }

  /** Adds (or replaces) a region (region streaming). */
  add(data: RegionData): void {
    const old = this.byId.get(data.region.id)
    if (old) this.regions.splice(this.regions.indexOf(old), 1)
    this.byId.set(data.region.id, data)
    this.regions.push(data)
  }

  /** Removes a region; returns it, or null when it was not loaded. */
  remove(id: number): RegionData | null {
    const data = this.byId.get(id)
    if (!data) return null
    this.byId.delete(id)
    this.regions.splice(this.regions.indexOf(data), 1)
    return data
  }

  get(id: number): RegionData | null {
    return this.byId.get(id) ?? null
  }

  /**
   * Region containing glTF (x, z), with region-local file units (lx east, lz north). O(1): the region index follows
   * from the origin region (rx = ox + floor(x / 192), rz = oz + floor(-z / 192)). A point on a shared border belongs to
   * the loaded region first in (z, x) order, as the manifest orders them.
   */
  locate(x: number, z: number): { data: RegionData; lx: number; lz: number } | null {
    const fx = x / 192
    const fz = -z / 192
    const rx = this.ox + Math.floor(fx)
    const rz = this.oz + Math.floor(fz)
    const onWest = fx === Math.floor(fx)
    const onSouth = fz === Math.floor(fz)
    // Candidates in (z, x) order: the southern / western neighbour owns its north / east border too.
    for (const dz of onSouth ? [-1, 0] : [0]) {
      for (const dx of onWest ? [-1, 0] : [0]) {
        const data = this.byId.get(((rz + dz) << 8) | (rx + dx))
        if (!data) continue
        const o = data.region.origin
        const lx = (x - o[0]) * 10
        const lz = (o[2] - z) * 10
        if (lx >= 0 && lx <= 1920 && lz >= 0 && lz <= 1920) return { data, lx, lz }
      }
    }
    return null
  }

  /**
   * Ground height (m) at glTF (x, z) from the navmesh height grid (equal to the .m terrain, TERRAIN.md 1.2), else the
   * terrain grid; the cell split matches the rendered triangles. null outside the loaded regions.
   */
  heightAt(x: number, z: number): number | null {
    const hit = this.locate(x, z)
    if (!hit) return null
    return terrainHeightAt(hit.data.navmesh?.heights ?? hit.data.terrain.heights, hit.lx, hit.lz)
  }

  /** Terrain vertex height (m) of region data at grid (gx, gz). */
  static vertexHeight(data: RegionData, gx: number, gz: number): number {
    return data.terrain.heights[gz * GRID + gx]!
  }

  /** The block (bx, bz) record under glTF (x, z). */
  blockAt(x: number, z: number): { region: WorldRegion; block: WorldRegion['blocks'][number] } | null {
    const hit = this.locate(x, z)
    if (!hit) return null
    const bx = Math.min(5, Math.floor(hit.lx / 320))
    const bz = Math.min(5, Math.floor(hit.lz / 320))
    const block = hit.data.region.blocks[bz * 6 + bx]
    return block ? { region: hit.data.region, block } : null
  }

  /** glTF bounds of the loaded regions (x east, z south). */
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const { region } of this.regions) {
      minX = Math.min(minX, region.origin[0])
      maxX = Math.max(maxX, region.origin[0] + 192)
      minZ = Math.min(minZ, region.origin[2] - 192)
      maxZ = Math.max(maxZ, region.origin[2])
    }
    return { minX, maxX, minZ, maxZ }
  }
}
