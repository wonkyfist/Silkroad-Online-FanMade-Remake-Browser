/**
 * S1's in-bounds link (docs/COAST.md §3.5, §9.3, G1; WAVE_PLAN6 D29): the walkable south beach must reach the town's
 * walkable component without leaving the playable rectangle, because the server clamps every move to it. Node-free.
 *
 * - `closeRing`: the clamp's view of a NavData: every terrain region outside the rectangle closed and every object
 *   instance outside it dropped (links remapped);
 * - `reachesBothWays`: a terrain point and the home position reach each other;
 * - `findInBoundsLink`: the cheapest set of retail-closed tiles inside the rectangle to open so a point joins the home
 *   component (Dial's search over 4-connected tiles: a step between open tiles of one walkable component costs 0,
 *   opening a closed tile costs 1 on gentle ground and more on steeper ground, up to a limit); the caller writes them
 *   as coast.json `openTiles` rectangles and verifies with `reachesBothWays`.
 *
 * Coordinates: world FILE space (1 unit = 1 dm; x east, z north; region r spans [1920 r, 1920 (r + 1))).
 */
import { NVM_TILE_SIZE, NVM_TILES } from '@sro/formats'
import { NavWorld, TERRAIN_SURFACE, type NavData } from '@sro/nav'
import type { Rect } from './config.ts'
import type { RegionRect } from './lattice.ts'

const REGION_UNITS = 1920

/** A copy of `data` as the clamp sees it: regions outside `playable` closed, instances outside it dropped. */
export function closeRing(data: NavData, playable: RegionRect): NavData {
  const inRect = (x: number, z: number) =>
    x >= playable.x0 * REGION_UNITS && x < (playable.x1 + 1) * REGION_UNITS && z >= playable.z0 * REGION_UNITS && z < (playable.z1 + 1) * REGION_UNITS
  const regions = data.regions.map(r => {
    const inside = r.rx >= playable.x0 && r.rx <= playable.x1 && r.rz >= playable.z0 && r.rz <= playable.z1
    return inside ? r : { ...r, openCellCount: 0 }
  })
  const keep = new Map<number, number>()
  data.instances.forEach((s, i) => {
    if (inRect(s.x, s.z)) keep.set(i, keep.size)
  })
  const instances = data.instances.filter((_, i) => keep.has(i)).map(s => ({
    ...s,
    links: s.links.filter(l => keep.has(l.target)).map(l => ({ ...l, target: keep.get(l.target)! })),
  }))
  return { version: data.version, regions, models: data.models, instances }
}

/** Whether a terrain point reaches the home position and back (false when either has no component). */
export function reachesBothWays(world: NavWorld, point: { x: number; z: number }, home: { x: number; z: number; y: number }): boolean {
  const hp = world.locate(home.x, home.z, home.y)
  if (!hp) return false
  const h = world.componentOf(hp)
  const c = world.componentOf({ x: point.x, z: point.z, surface: TERRAIN_SURFACE })
  return h >= 0 && c >= 0 && world.componentReaches(h, c) && world.componentReaches(c, h)
}

export interface LinkSearch {
  /** Closed tiles to open, global tile coordinates (tx = floor(x / 20)), in path order. */
  tiles: Array<{ tx: number; tz: number }>
  /** Where the path joins the home component (global tile). */
  joins: { tx: number; tz: number } | null
}

/** Opening a closed tile costs 1 up to GENTLE_SLOPE (rise over run across its corners), STEEP_COST up to maxSlope. */
export const GENTLE_SLOPE = 0.7
const STEEP_COST = 4

/**
 * The cheapest in-bounds link from `from` to the home component (see the header). `maxSlope`: the steepest closed
 * tile the search may open.
 */
export function findInBoundsLink(
  world: NavWorld, from: { x: number; z: number }, home: { x: number; z: number; y: number }, playable: RegionRect, maxSlope = 1.5,
): LinkSearch {
  const hp = world.locate(home.x, home.z, home.y)
  if (!hp) throw new Error('findInBoundsLink: the home position has no surface')
  const homeC = world.componentOf(hp)
  const tx0 = playable.x0 * NVM_TILES
  const tz0 = playable.z0 * NVM_TILES
  const W = (playable.x1 - playable.x0 + 1) * NVM_TILES
  const H = (playable.z1 - playable.z0 + 1) * NVM_TILES
  const T = NVM_TILE_SIZE
  const centre = (k: number) => ({ x: (tx0 + (k % W) + 0.5) * T, z: (tz0 + Math.floor(k / W) + 0.5) * T })
  const open = (k: number) => {
    const c = centre(k)
    return world.terrainOpen(c.x, c.z)
  }
  /** Cost of opening a closed tile: 1 on gentle ground, STEEP_COST up to maxSlope, -1 beyond. */
  const openCost = (k: number) => {
    const gx = (tx0 + (k % W)) * T
    const gz = (tz0 + Math.floor(k / W)) * T
    const h = [world.terrainHeight(gx, gz), world.terrainHeight(gx + T, gz), world.terrainHeight(gx, gz + T), world.terrainHeight(gx + T, gz + T)]
    if (h.some(v => !Number.isFinite(v))) return -1
    const slope = Math.max(Math.abs(h[0]! - h[1]!), Math.abs(h[2]! - h[3]!), Math.abs(h[0]! - h[2]!), Math.abs(h[1]! - h[3]!)) / T
    return slope <= GENTLE_SLOPE ? 1 : slope <= maxSlope ? STEEP_COST : -1
  }
  const compMemo = new Int32Array(W * H).fill(-2)
  const compOf = (k: number) => {
    if (compMemo[k] === -2) {
      const c = centre(k)
      compMemo[k] = world.componentOf({ x: c.x, z: c.z, surface: TERRAIN_SURFACE })
    }
    return compMemo[k]!
  }
  const reachMemo = new Map<number, boolean>()
  const inHome = (k: number) => {
    const comp = compOf(k)
    if (comp < 0) return false
    let r = reachMemo.get(comp)
    if (r === undefined) reachMemo.set(comp, (r = world.componentReaches(homeC, comp) && world.componentReaches(comp, homeC)))
    return r
  }
  const N = W * H
  const dist = new Int32Array(N).fill(0x3fffffff)
  const prev = new Int32Array(N).fill(-1)
  const sx = Math.floor(from.x / T) - tx0
  const sz = Math.floor(from.z / T) - tz0
  if (sx < 0 || sz < 0 || sx >= W || sz >= H) throw new Error('findInBoundsLink: the start lies outside the rectangle')
  const start = sz * W + sx
  dist[start] = 0
  // Dial's buckets: level d holds the tiles reached by opening d closed tiles
  const levels: number[][] = [[start]]
  let end = -1
  const openMemo = new Int8Array(N).fill(-1)
  const isOpen = (k: number) => (openMemo[k] === -1 ? (openMemo[k] = open(k) ? 1 : 0) : openMemo[k]) === 1
  for (let d = 0; d < levels.length && end < 0; d++) {
    const q = levels[d]
    if (!q) continue
    for (let qi = 0; qi < q.length && end < 0; qi++) {
      const k = q[qi]!
      if (dist[k] !== d) continue
      if (isOpen(k) && inHome(k)) {
        end = k
        break
      }
      const x = k % W
      const z = (k - x) / W
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue
        const n = nz * W + nx
        // open to open only within one walkable component (object footprints split the tiles); a closed tile opens
        // at a cost and joins whatever it touches
        let cost: number
        if (isOpen(n)) cost = !isOpen(k) || compOf(n) === compOf(k) ? 0 : -1
        else cost = openCost(n)
        if (cost < 0) continue
        const nd = d + cost
        if (nd >= dist[n]!) continue
        dist[n] = nd
        prev[n] = k
        ;(levels[nd] ??= []).push(n)
      }
    }
  }
  if (end < 0) return { tiles: [], joins: null }
  const tiles: Array<{ tx: number; tz: number }> = []
  for (let k = end; k >= 0; k = prev[k]!) if (!isOpen(k)) tiles.push({ tx: tx0 + (k % W), tz: tz0 + Math.floor(k / W) })
  tiles.reverse()
  return { tiles, joins: { tx: tx0 + (end % W), tz: tz0 + Math.floor(end / W) } }
}

/**
 * Widens a link to a band walkable with straight-line moves (the server walks straight lines and stops at a closed
 * tile): every closed tile inside the rectangle within `radius` tiles (Chebyshev) of a link tile, on ground no steeper
 * than `maxSlope`, joins the link. Returns the tiles sorted by row, then column.
 */
export function widenLink(
  world: NavWorld, tiles: ReadonlyArray<{ tx: number; tz: number }>, radius: number, playable: RegionRect, maxSlope = 1.5,
): Array<{ tx: number; tz: number }> {
  const T = NVM_TILE_SIZE
  const seen = new Set<number>()
  const out: Array<{ tx: number; tz: number }> = []
  const inside = (tx: number, tz: number) =>
    tx >= playable.x0 * NVM_TILES && tx < (playable.x1 + 1) * NVM_TILES && tz >= playable.z0 * NVM_TILES && tz < (playable.z1 + 1) * NVM_TILES
  for (const t of tiles) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = t.tx + dx
        const tz = t.tz + dz
        const key = tz * 65536 + tx
        if (seen.has(key) || !inside(tx, tz)) continue
        seen.add(key)
        const cx = (tx + 0.5) * T
        const cz = (tz + 0.5) * T
        if (world.terrainOpen(cx, cz)) continue
        const h = [world.terrainHeight(tx * T, tz * T), world.terrainHeight((tx + 1) * T, tz * T), world.terrainHeight(tx * T, (tz + 1) * T),
          world.terrainHeight((tx + 1) * T, (tz + 1) * T)]
        if (h.some(v => !Number.isFinite(v))) continue
        const slope = Math.max(Math.abs(h[0]! - h[1]!), Math.abs(h[2]! - h[3]!), Math.abs(h[0]! - h[2]!), Math.abs(h[1]! - h[3]!)) / T
        if (dx === 0 && dz === 0 ? false : slope > maxSlope) continue
        out.push({ tx, tz })
      }
    }
  }
  return out.sort((a, b) => a.tz - b.tz || a.tx - b.tx)
}

/** Row runs of tiles as rectangles (region units) for coast.json `openTiles`: one rectangle per run along a row. */
export function tilesToRowRects(tiles: ReadonlyArray<{ tx: number; tz: number }>, note?: string): Array<Rect & { note?: string }> {
  const r = (v: number) => Math.round(v * 1e6) / 1e6
  const sorted = [...tiles].sort((a, b) => a.tz - b.tz || a.tx - b.tx)
  const out: Array<Rect & { note?: string }> = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1]!.tz === sorted[i]!.tz && sorted[j + 1]!.tx === sorted[j]!.tx + 1) j++
    const a = sorted[i]!
    const b = sorted[j]!
    out.push({ x: [r(a.tx / NVM_TILES), r((b.tx + 1) / NVM_TILES)], z: [r(a.tz / NVM_TILES), r((a.tz + 1) / NVM_TILES)], ...(note ? { note } : {}) })
    i = j + 1
  }
  return out
}

/** Tile rectangles (region units, one per tile) for coast.json `openTiles`. */
export function tilesToRects(tiles: ReadonlyArray<{ tx: number; tz: number }>, note?: string): Array<Rect & { note?: string }> {
  const r = (v: number) => Math.round(v * 1e6) / 1e6
  return tiles.map(t => ({
    x: [r(t.tx / NVM_TILES), r((t.tx + 1) / NVM_TILES)],
    z: [r(t.tz / NVM_TILES), r((t.tz + 1) / NVM_TILES)],
    ...(note ? { note } : {}),
  }))
}

/** Whether global tile (tx, tz) lies in one of the rectangles (its centre inside). */
export function tileInRects(rects: ReadonlyArray<Rect>, tx: number, tz: number): boolean {
  const cx = (tx + 0.5) / NVM_TILES
  const cz = (tz + 0.5) / NVM_TILES
  return rects.some(q => cx >= q.x[0] && cx <= q.x[1] && cz >= q.z[0] && cz <= q.z[1])
}
