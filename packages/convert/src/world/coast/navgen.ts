/**
 * Navigation of the regions the coast changes (docs/COAST.md §9.1, §9.4, §3.5 G1). Node-free.
 *
 * `@sro/nav` walks tiles: a tile is walkable when its cell index is below the region's openCellCount, and the walker
 * has no step or slope limit. So the coast rewrites a region's navigation in place:
 * - heights: the coast lattice (the same file units as the terrain, so all four copies agree: terrain/*.bin, the debug
 *   navmesh/*.bin, nav/<x>_<z>.bin and nav.bin);
 * - ring regions outside the bounds: a tile whose ground moved stays open only if it was open in retail, all four
 *   corners are at most 0.4 m under the sea level (knee-deep), none is more than 12 m above it, and its slope is at
 *   most 0.7; the rule never opens a retail-closed tile, so the beaches outside the bounds are open and the lowered
 *   flanks above them close (the clamp keeps players inside the bounds either way);
 * - `openTiles` (coast.json, inside the bounds): retail-closed tiles there open (S1's link to town, G1);
 * - inside the bounds, a height patch's sea more than knee-deep closes (`deep`, C7): S1's sea and the S2 river's
 *   former dry channel (./banks.ts) are not walkable;
 * - water planes over blocks whose water the coast removed are dropped (the ocean is not a nav plane);
 * - object navmesh instances outside the bounds standing on ground that moved are dropped (their placements are
 *   dropped or re-snapped by C9; nothing walks there).
 */
import { NVM_PLANE_TYPE, NVM_TILE_BLOCKED, NVM_TILES, type NvmCell, type NvmFile } from '@sro/formats'
import type { Rect } from './config.ts'
import { tileInRects } from './links.ts'

/** Knee-deep: open down to this far under the sea level (m), §9.1 / C7. */
export const NAV_KNEE_DEEP_M = 0.4
/** The beach band: open up to this far above the sea level (m). */
export const NAV_BEACH_BAND_M = 12
/** Steepest open tile (rise over run across a tile's corners), §9.1. */
export const NAV_MAX_SLOPE = 0.7
/** Tile edge (m). */
const TILE_M = 2

export interface NavRegionEdit {
  /** Region coordinates. */
  x: number
  z: number
  /** New heights (file units, 97 x 97, index gz * 97 + gx), or null to keep the retail heights. */
  heights: Float32Array | null
  /** Per vertex (97 x 97): the ground moved (the ring rule applies to tiles touching one). */
  moved: Uint8Array | null
  /** The region lies outside the playable rectangle (the ring rule applies). */
  ring: boolean
  seaLevelM: number
  /** coast.json openTiles (region units), applied inside the bounds. */
  openTiles: ReadonlyArray<Rect>
  /** Blocks (index bz * 6 + bx) whose water the coast removed. */
  removedWater: ReadonlySet<number>
  /** 97 x 97 (inside the bounds): a height patch's sea vertex more than NAV_KNEE_DEEP_M under the sea level; an open
   *  tile touching one closes (C7). */
  deep?: Uint8Array | null
  /** Whether an object instance (its position relative to this region, file units) must be dropped. */
  dropObject?: (localX: number, localZ: number) => boolean
}

export interface NavEditStats {
  opened: number
  closed: number
  planesDropped: number
  objectsDropped: number
}

/**
 * The region's navmesh after the coast (a new NvmFile; the retail one is not mutated). Returns the retail file itself
 * when nothing changes.
 */
export function editRegionNav(nvm: NvmFile, e: NavRegionEdit): { nvm: NvmFile; stats: NavEditStats } {
  const stats: NavEditStats = { opened: 0, closed: 0, planesDropped: 0, objectsDropped: 0 }
  const G = NVM_TILES + 1
  const heights = e.heights ?? nvm.heights
  const tileCells = Int32Array.from(nvm.tileCells)
  const tileFlags = Uint16Array.from(nvm.tileFlags)
  const cells: NvmCell[] = nvm.cells.slice()
  let closedCell = cells.length > nvm.openCellCount ? nvm.openCellCount : -1
  const close = (t: number) => {
    if (closedCell < 0) {
      closedCell = cells.length
      cells.push({ minX: 0, minZ: 0, maxX: 1920, maxZ: 1920, objects: [] })
    }
    tileCells[t] = closedCell
    tileFlags[t] = tileFlags[t]! | NVM_TILE_BLOCKED
    stats.closed++
  }
  const isOpen = (t: number) => tileCells[t]! >= 0 && tileCells[t]! < nvm.openCellCount

  if (e.ring && e.moved) {
    const SL10 = e.seaLevelM * 10
    const lo = SL10 - NAV_KNEE_DEEP_M * 10
    const hi = SL10 + NAV_BEACH_BAND_M * 10
    for (let tz = 0; tz < NVM_TILES; tz++) {
      for (let tx = 0; tx < NVM_TILES; tx++) {
        const t = tz * NVM_TILES + tx
        if (!isOpen(t)) continue
        const v = [tz * G + tx, tz * G + tx + 1, (tz + 1) * G + tx, (tz + 1) * G + tx + 1]
        if (!v.some(k => e.moved![k])) continue
        const h = v.map(k => heights[k]!)
        const rise = Math.max(Math.abs(h[0]! - h[1]!), Math.abs(h[2]! - h[3]!), Math.abs(h[0]! - h[2]!), Math.abs(h[1]! - h[3]!)) / 10
        const ok = h.every(y => y >= lo && y <= hi) && rise / TILE_M <= NAV_MAX_SLOPE
        if (!ok) close(t)
      }
    }
  }
  if (!e.ring && e.deep) {
    for (let tz = 0; tz < NVM_TILES; tz++) {
      for (let tx = 0; tx < NVM_TILES; tx++) {
        const t = tz * NVM_TILES + tx
        if (!isOpen(t)) continue
        const v = [tz * G + tx, tz * G + tx + 1, (tz + 1) * G + tx, (tz + 1) * G + tx + 1]
        if (v.some(k => e.deep![k])) close(t)
      }
    }
  }
  if (!e.ring && e.openTiles.length) {
    for (let tz = 0; tz < NVM_TILES; tz++) {
      for (let tx = 0; tx < NVM_TILES; tx++) {
        const t = tz * NVM_TILES + tx
        if (isOpen(t) || !tileInRects(e.openTiles, e.x * NVM_TILES + tx, e.z * NVM_TILES + tz)) continue
        const cell = openNeighbourCell(tileCells, nvm.openCellCount, tx, tz)
        if (cell < 0) continue
        tileCells[t] = cell
        tileFlags[t] = tileFlags[t]! & ~NVM_TILE_BLOCKED
        stats.opened++
      }
    }
  }

  let planeTypes = nvm.planeTypes
  let planeHeights = nvm.planeHeights
  if (planeTypes && planeHeights && e.removedWater.size) {
    planeTypes = Uint8Array.from(planeTypes)
    planeHeights = Float32Array.from(planeHeights)
    for (const b of e.removedWater) {
      if (planeTypes[b] === NVM_PLANE_TYPE.none) continue
      planeTypes[b] = NVM_PLANE_TYPE.none
      planeHeights[b] = 0
      stats.planesDropped++
    }
  }

  let objects = nvm.objects
  let outCells = cells
  if (e.dropObject) {
    const keep: number[] = []
    const remap = new Int32Array(nvm.objects.length).fill(-1)
    nvm.objects.forEach((o, i) => {
      if (e.dropObject!(o.position[0], o.position[2])) {
        stats.objectsDropped++
        return
      }
      remap[i] = keep.length
      keep.push(i)
    })
    if (stats.objectsDropped) {
      objects = keep.map(i => {
        const o = nvm.objects[i]!
        return { ...o, links: o.links.filter(l => l.linkedObject < 0 || remap[l.linkedObject]! >= 0).map(l => ({ ...l, linkedObject: l.linkedObject < 0 ? l.linkedObject : remap[l.linkedObject]! })) }
      })
      outCells = cells.map(c => ({ ...c, objects: c.objects.filter(o => remap[o]! >= 0).map(o => remap[o]!) }))
    }
  }

  const changed = e.heights !== null || stats.opened || stats.closed || stats.planesDropped || stats.objectsDropped
  if (!changed) return { nvm, stats }
  return {
    nvm: { ...nvm, heights, tileCells, tileFlags, cells: outCells, objects, ...(planeTypes ? { planeTypes } : {}), ...(planeHeights ? { planeHeights } : {}) },
    stats,
  }
}

/** The open cell of a 4-neighbour tile (the nearest along the row first), or 0 when the region has open cells. */
function openNeighbourCell(tileCells: Int32Array, openCellCount: number, tx: number, tz: number): number {
  const ok = (c: number) => c >= 0 && c < openCellCount
  for (let r = 1; r < NVM_TILES; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
      const x = tx + dx
      const z = tz + dz
      if (x < 0 || z < 0 || x >= NVM_TILES || z >= NVM_TILES) continue
      const c = tileCells[z * NVM_TILES + x]!
      if (ok(c)) return c
    }
  }
  return openCellCount > 0 ? 0 : -1
}

/** openTiles applied to a NavData region's tiles (the same rule as editRegionNav), for checks on a decoded nav.bin. */
export function openTilesInNavRegion(r: { rx: number; rz: number; openCellCount: number; tileCells: Int32Array }, rects: ReadonlyArray<Rect>): number {
  let n = 0
  for (let tz = 0; tz < NVM_TILES; tz++) {
    for (let tx = 0; tx < NVM_TILES; tx++) {
      const t = tz * NVM_TILES + tx
      const c = r.tileCells[t]!
      if ((c >= 0 && c < r.openCellCount) || !tileInRects(rects, r.rx * NVM_TILES + tx, r.rz * NVM_TILES + tz)) continue
      const cell = openNeighbourCell(r.tileCells, r.openCellCount, tx, tz)
      if (cell < 0) continue
      r.tileCells[t] = cell
      n++
    }
  }
  return n
}
