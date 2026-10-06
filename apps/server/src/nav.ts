import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NavGltf, NavWorld, TERRAIN_SURFACE, decodeNavData, navPiecePuts, type NavData, type NavLeg, type NavSurface } from '@sro/nav'
import type { Vec3 } from '@sro/shared'
import type { Bounds } from './content.ts'

/**
 * Where entities may stand and walk (docs/NAVIGATION.md). Positions are world metres in the glTF frame of the world
 * manifest (Y up). Every entity keeps its surface (terrain, or one cell of one object instance) next to its position,
 * so heights come from the surface it walked onto and never from a re-guess (§5.1). Only positions without a retained
 * surface (spawn, teleport, relog without a saved surface) are located from a height hint (§5.2).
 *
 * Two providers:
 * - MeshNav: the @sro/nav terrain + object navmeshes exported with the world (manifest `nav`, nav.bin). Moves are one
 *   straight chord that stops at the first blocking edge (walls, railings, the fountain rim), no slide (§6).
 * - FlatNav: no navmesh (synthetic test worlds, or a world exported before nav.bin): the world bounds, flat.
 *
 * Reachability (docs/NAVIGATION.md §11): MeshNav can pin every placement (relog, teleport, respawn, nests) to one
 * walkable component, the town spawn's (setHome; load() uses the manifest spawn), so nobody is put where the walker
 * could never leave or reach (the fountain basin, courtyards, the terrain under houses).
 */

/** A position with the surface it stands on (null: unknown / flat world). */
export interface NavPoint {
  x: number
  y: number
  z: number
  surface: NavSurface | null
}

export interface NavWalk {
  /** Where the straight walk ends (the destination, or the stop point before a blocking edge), with its surface. */
  end: NavPoint
  /** True when a blocker clipped the walk short of the destination. */
  blocked: boolean
  /** The straight pieces with their surfaces (glTF metres), for the exact height along the move; [] when flat. */
  legs: NavLeg[]
}

export interface NavProvider {
  readonly kind: 'flat' | 'mesh'
  /** Human-readable origin (startup log). */
  readonly source: string
  /** Ground height at x/z near yHint (default: the highest surface), or null when unknown. */
  heightAt(x: number, z: number, yHint?: number): number | null
  /** Whether an entity may be placed at x/z: a standable surface that is not inside a solid object (a house). */
  canWalk(x: number, z: number): boolean
  /** Legacy straight-line mover on bare points (the end point, or null to refuse). */
  moveStraight(from: Vec3, to: Vec3): Vec3 | null
  /** §5.2: the surface nearest yHint at x/z (+Infinity: the highest), or null when nobody can stand there. */
  locate(x: number, z: number, yHint: number): NavPoint | null
  /**
   * A placement (spawn, teleport, relog, loot): the surface at x/z nearest yHint (NaN or +Infinity: the highest,
   * -Infinity: the lowest) that is open ground (not a solid object, not under one). With `searchRadius`,
   * the nearest such point within it (rings of 1 m). null when there is none.
   */
  place(x: number, z: number, yHint: number, searchRadius?: number): NavPoint | null
  /** §6: straight walk from a positioned entity toward x/z; null refuses the move (outside the world). */
  walk(from: NavPoint, x: number, z: number): NavWalk | null
  /** Height of a surface at x/z (NaN when unknown). */
  heightOn(surface: NavSurface | null, x: number, z: number): number
  /** Stable text form of a surface for the database ('t', or 'o:<instance world id>:<cell>'). */
  surfaceKey(surface: NavSurface | null): string | null
  /** A saved surface back at x/z (the same cell, a neighbour, or clamped into it), or null when it no longer exists. */
  restore(key: string | null, x: number, z: number): NavPoint | null
}

/**
 * Terrain-free fallback: everything inside the world bounds is walkable and flat (height unknown).
 * Without bounds the whole plane is open.
 */
export class FlatNav implements NavProvider {
  readonly kind = 'flat'
  readonly source = 'flat (world bounds, no navmesh)'

  constructor(readonly bounds: Bounds | null) {}

  heightAt(): number | null {
    return null
  }

  canWalk(x: number, z: number): boolean {
    const b = this.bounds
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false
    return !b || (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)
  }

  moveStraight(from: Vec3, to: Vec3): Vec3 | null {
    if (!this.canWalk(to[0], to[2])) return null
    return [to[0], from[1], to[2]]
  }

  locate(x: number, z: number, yHint: number): NavPoint | null {
    return this.canWalk(x, z) ? { x, y: Number.isFinite(yHint) ? yHint : 0, z, surface: null } : null
  }

  place(x: number, z: number, yHint: number): NavPoint | null {
    return this.locate(x, z, yHint)
  }

  walk(from: NavPoint, x: number, z: number): NavWalk | null {
    const to = this.moveStraight([from.x, from.y, from.z], [x, from.y, z])
    return to && { end: { x: to[0], y: to[1], z: to[2], surface: null }, blocked: false, legs: [] }
  }

  heightOn(_surface?: NavSurface | null, _x?: number, _z?: number): number {
    return NaN
  }

  surfaceKey(_surface?: NavSurface | null): string | null {
    return null
  }

  restore(_key?: string | null, _x?: number, _z?: number): NavPoint | null {
    return null
  }
}

/** A MoveValidator-style function as a flat provider (tests that clip moves by hand). */
export class ValidatorNav extends FlatNav {
  constructor(readonly validate: (from: Vec3, to: Vec3) => Vec3 | null) {
    super(null)
  }

  override moveStraight(from: Vec3, to: Vec3): Vec3 | null {
    return this.validate(from, to)
  }
}

/** Solid-object footprints are checked this far below / above the chosen surface (metres). */
const SOLID_BELOW_M = 3
const SOLID_ABOVE_M = 10
/** Broad-phase bucket edge of the solid-object index (metres). */
const SOLID_BUCKET_M = 16
/** A walk refused at an exit into a solid object stops this far before the edge (metres; the walker's 0.2-unit back-off). */
const EXIT_BACKOFF_M = 0.02

/**
 * Object instances nobody can walk onto: every outline edge blocks and no link leads in (house and prop collision
 * footprints, wall bodies). A point inside one is "under a house": terrain there may be open, but a character placed
 * there stands inside the building. Triangles in glTF metres, bucketed.
 */
class SolidIndex {
  private readonly tris: Float64Array[] = []
  /** Per solid: its instance index (a switched-off instance stops covering: docs/SIEGE.md §4.1). */
  private readonly instanceOf: number[] = []
  private readonly buckets = new Map<number, number[]>()
  readonly solid: Uint8Array

  constructor(data: NavData, g: NavGltf, private readonly enabled: (instance: number) => boolean = () => true) {
    this.solid = new Uint8Array(data.instances.length)
    data.instances.forEach((inst, i) => {
      const model = data.models[inst.model]!
      if (inst.links.length > 0 || model.outline.flags.some((f) => f === 0)) return
      this.solid[i] = 1
      const c = Math.cos(inst.yaw)
      const s = Math.sin(inst.yaw)
      const v = model.vertices
      const n = model.cells.length / 3
      // Per triangle: 3 x (x, z) in glTF metres, then y = a x + b z + d (plane through the 3 vertices).
      const t = new Float64Array(n * 9)
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
      for (let k = 0; k < n; k++) {
        const p: number[] = []
        for (let j = 0; j < 3; j++) {
          const vi = model.cells[k * 3 + j]! * 3
          const lx = v[vi]!, ly = v[vi + 1]!, lz = v[vi + 2]!
          const x = g.gltfX(inst.x + c * lx - s * lz)
          const z = g.gltfZ(inst.z + s * lx + c * lz)
          p.push(x, (inst.y + ly) / 10, z)
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minZ = Math.min(minZ, z)
          maxZ = Math.max(maxZ, z)
        }
        t.set([p[0]!, p[2]!, p[3]!, p[5]!, p[6]!, p[8]!, p[1]!, p[4]!, p[7]!], k * 9)
      }
      const index = this.tris.length
      this.tris.push(t)
      this.instanceOf.push(i)
      for (let bz = Math.floor(minZ / SOLID_BUCKET_M); bz <= Math.floor(maxZ / SOLID_BUCKET_M); bz++) {
        for (let bx = Math.floor(minX / SOLID_BUCKET_M); bx <= Math.floor(maxX / SOLID_BUCKET_M); bx++) {
          const key = bx * 65536 + bz
          const list = this.buckets.get(key)
          if (list) list.push(index)
          else this.buckets.set(key, [index])
        }
      }
    })
  }

  /** Whether a solid footprint covers x/z at a height within [y - below, y + above]. */
  covers(x: number, z: number, y: number): boolean {
    const list = this.buckets.get(Math.floor(x / SOLID_BUCKET_M) * 65536 + Math.floor(z / SOLID_BUCKET_M))
    if (!list) return false
    for (const i of list) {
      if (!this.enabled(this.instanceOf[i]!)) continue
      const t = this.tris[i]!
      for (let k = 0; k < t.length; k += 9) {
        const ax = t[k]!, az = t[k + 1]!, bx = t[k + 2]!, bz = t[k + 3]!, cx = t[k + 4]!, cz = t[k + 5]!
        const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
        if (Math.abs(det) < 1e-12) continue
        const u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det
        const w = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det
        if (u < -1e-6 || w < -1e-6 || u + w > 1 + 1e-6) continue
        const h = t[k + 6]! + u * (t[k + 7]! - t[k + 6]!) + w * (t[k + 8]! - t[k + 6]!)
        if (h >= y - SOLID_BELOW_M && h <= y + SOLID_ABOVE_M) return true
      }
    }
    return false
  }
}

/** The @sro/nav navmeshes of one world (glTF metres; NavGltf does the file-space conversion). */
export class MeshNav implements NavProvider {
  readonly kind = 'mesh'
  readonly g: NavGltf
  private solids: SolidIndex
  /** Instance world id (regionId << 16 | localUid) -> index, for saved surfaces. */
  private readonly byWorldId = new Map<number, number>()
  /**
   * The walkable component placements must lie in (the town spawn's), or -1: no constraint. Component ids change when
   * the components are rebuilt (a wall third switched off or on), so the anchor is kept and the id found again after
   * every switch (`homeId`).
   */
  private home = -1
  private homeAnchor: { x: number; z: number; yHint: number } | null = null
  private homeGen = 0
  /** Bumped by every runtime switch (pieces installed, an instance or a tile switched). */
  private gen = 0

  constructor(
    data: NavData,
    originRegion: { x: number; z: number },
    readonly source: string,
  ) {
    this.g = new NavGltf(new NavWorld(data), originRegion)
    this.solids = new SolidIndex(data, this.g, (i) => this.world.isInstanceEnabled(i))
    data.instances.forEach((inst, i) => this.byWorldId.set(inst.id >>> 0, i))
  }

  get world(): NavWorld {
    return this.g.world
  }

  /** The nav data (after installPieces: with the pieces). */
  get data(): NavData {
    return this.world.data
  }

  // ---- runtime switches (docs/SIEGE.md §4: the walls that break) ------------------------------------------------

  /**
   * Adds extra collision instances (the Siege of Jangan's wall pieces, `siege/walls-nav.bin`) by id: appended, or
   * replaced in their slot when already there (installing twice changes nothing). No other index moves. Returns
   * id -> instance index of the pieces.
   */
  installPieces(pieces: NavData): Map<number, number> {
    this.world.editInstances({ put: navPiecePuts(pieces) })
    this.solids = new SolidIndex(this.world.data, this.g, (i) => this.world.isInstanceEnabled(i))
    this.byWorldId.clear()
    this.world.data.instances.forEach((inst, i) => this.byWorldId.set(inst.id >>> 0, i))
    this.gen++
    const out = new Map<number, number>()
    for (const inst of pieces.instances) {
      const i = this.byWorldId.get(inst.id >>> 0)
      if (i !== undefined) out.set(inst.id >>> 0, i)
    }
    return out
  }

  /** The index of an instance by its world id, or undefined. */
  instanceIndex(id: number): number | undefined {
    return this.byWorldId.get(id >>> 0)
  }

  /** NavWorld.setInstanceEnabled; a switched-off solid also stops covering (insideSolid, place). */
  setInstanceEnabled(index: number, on: boolean): boolean {
    const changed = this.world.setInstanceEnabled(index, on)
    if (changed) this.gen++
    return changed
  }

  /** NavWorld.setTileOverride. */
  setTileOverride(regionId: number, tile: number, mode: 'open' | 'closed' | null): boolean {
    const changed = this.world.setTileOverride(regionId, tile, mode)
    if (changed) this.gen++
    return changed
  }

  /** The home component now (found again from its anchor after a switch). */
  private homeId(): number {
    if (this.homeGen !== this.gen && this.homeAnchor) {
      this.homeGen = this.gen
      const a = this.homeAnchor
      this.home = -1
      const p = this.locate(a.x, a.z, a.yHint)
      this.home = p?.surface ? this.componentOf(p) : -1
    }
    return this.home
  }

  /** Terrain height (m) at x/z, NaN outside the loaded regions. */
  terrainHeight(x: number, z: number): number {
    return this.world.terrainHeight(this.g.fileX(x), this.g.fileZ(z)) / 10
  }

  terrainOpen(x: number, z: number): boolean {
    return this.world.terrainOpen(this.g.fileX(x), this.g.fileZ(z))
  }

  /** Whether a solid object's footprint covers x/z near height y (inside or under a house). */
  insideSolid(x: number, z: number, y: number): boolean {
    return this.solids.covers(x, z, y)
  }

  /** Whether an object instance is solid (a footprint nobody can walk onto). */
  isSolid(instance: number): boolean {
    return this.solids.solid[instance] === 1
  }

  /**
   * Pins placements (place, restore) to the walkable component of the surface at x/z nearest yHint, normally the
   * town spawn. Returns that component, or -1 (no constraint) when there is no surface there.
   */
  setHome(x: number, z: number, yHint: number): number {
    const hint = Number.isNaN(yHint) ? Infinity : yHint
    const p = this.locate(x, z, hint)
    this.home = p?.surface ? this.componentOf(p) : -1
    this.homeAnchor = { x, z, yHint: hint }
    this.homeGen = this.gen
    return this.home
  }

  /** The walkable component of a positioned point (-1: none, e.g. a closed terrain cell or no surface). */
  componentOf(p: NavPoint): number {
    return p.surface ? this.g.componentOf({ x: p.x, z: p.z, surface: p.surface }) : -1
  }

  /** Whether a positioned point may be placed: in the home component (anywhere with a surface without one). */
  inHome(p: NavPoint): boolean {
    const home = this.homeId()
    return p.surface !== null && (home < 0 || this.componentOf(p) === home)
  }

  heightAt(x: number, z: number, yHint = Infinity): number | null {
    return this.locate(x, z, Number.isNaN(yHint) ? Infinity : yHint)?.y ?? null
  }

  canWalk(x: number, z: number): boolean {
    return this.place(x, z, NaN) !== null
  }

  moveStraight(from: Vec3, to: Vec3): Vec3 | null {
    const start = this.locate(from[0], from[2], from[1])
    const r = start && this.walk(start, to[0], to[2])
    return r ? [r.end.x, r.end.y, r.end.z] : null
  }

  locate(x: number, z: number, yHint: number): NavPoint | null {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Number.isNaN(yHint)) return null
    return this.g.locate(x, z, yHint)
  }

  /** The placement rule at exactly x/z (see NavProvider.place). */
  private standAt(x: number, z: number, yHint: number): NavPoint | null {
    const hint = Number.isNaN(yHint) ? Infinity : yHint
    // Only surfaces of the home component count (the nearest to the hint among them).
    const home = this.homeId()
    let p = home >= 0 ? this.g.locateIn(x, z, hint, home) : this.locate(x, z, hint)
    if (!p) return null
    if (p.surface?.kind === 'object' && this.isSolid(p.surface.instance)) {
      // On a solid footprint: the open terrain under it is no better (inside the building), so refuse unless the
      // footprint lies far above (e.g. a wall walkway over an arch).
      if (!this.terrainOpen(x, z)) return null
      p = this.locate(x, z, this.terrainHeight(x, z))
      if (!p) return null
    }
    if (this.solids.covers(x, z, p.y)) return null
    return p
  }

  place(x: number, z: number, yHint: number, searchRadius = 0): NavPoint | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    const here = this.standAt(x, z, yHint)
    if (here || searchRadius <= 0) return here
    // Moving away from x/z: the highest home surface. The terrain under a walkable floor can belong to the home
    // component (the corner-exit quirk, docs/NAVIGATION.md §11.3), and a rescue from the fountain basin with the
    // basin's y as the hint would otherwise pick the terrain 1.5 m under the plaza.
    const ringHint = this.homeId() >= 0 ? Infinity : yHint
    for (let r = 1; r <= searchRadius; r++) {
      const n = Math.max(8, Math.round(2 * Math.PI * r))
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI
        const p = this.standAt(x + Math.sin(a) * r, z + Math.cos(a) * r, ringHint)
        if (p) return p
      }
    }
    return null
  }

  walk(from: NavPoint, x: number, z: number): NavWalk | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    let start: NavPoint | null = from.surface ? from : this.locate(from.x, from.z, from.y)
    if (!start) {
      // No surface here (a closed cell, e.g. after a GM teleport into a wall): the terrain walker may always step out.
      const t = this.terrainHeight(from.x, from.z)
      if (!Number.isFinite(t)) return null
      start = { x: from.x, y: t, z: from.z, surface: TERRAIN_SURFACE }
    }
    const r = this.g.moveStraight({ x: start.x, y: start.y, z: start.z, surface: start.surface! }, x, z)
    const exit = this.solidExit(r.legs, r.end)
    if (exit) return exit
    const end: NavPoint = { x: r.end.x, y: r.end.y, z: r.end.z, surface: r.end.surface }
    let blocked = r.blocked
    const last = r.legs[r.legs.length - 1]
    if (end.surface?.kind === 'terrain' && last && !this.terrainOpen(end.x, end.z)) {
      // The chord ended exactly on a tile border whose far side is closed or not loaded (a target on the world edge):
      // step back along the last leg onto the open tile (or, walking along the border itself, to where the leg began).
      const len = Math.hypot(last.x1 - last.x0, last.z1 - last.z0)
      let f = 0
      for (let k = 1; k <= 10 && len > 0; k++) {
        const g = Math.max(0, 1 - (0.005 * k) / len)
        if (this.terrainOpen(last.x0 + (last.x1 - last.x0) * g, last.z0 + (last.z1 - last.z0) * g)) {
          f = g
          break
        }
      }
      last.x1 = last.x0 + (last.x1 - last.x0) * f
      last.z1 = last.z0 + (last.z1 - last.z0) * f
      end.x = last.x1
      end.z = last.z1
      end.y = this.terrainHeight(end.x, end.z)
      blocked = true
    }
    return { end, blocked, legs: r.legs }
  }

  /**
   * The walker leaves a walkable object onto the terrain across any open outline edge without consulting other objects
   * (§6.3), so where two props overlap (a rock whose edge lies inside a fence's footprint on the Jangan export) the exit
   * lands inside a solid object and the walker crosses it. Such a walk stops on the object instead, just short of the
   * edge (the walker's contact back-off), and counts as blocked. null when the legs never exit into a solid.
   *
   * The exit can also be the walk's very end: a walk whose target lies a few centimetres past the object's edge ends
   * on the terrain without a terrain leg (the last leg is still the object's), so `end` is checked like a final leg
   * (I7B: nav-real's 5-minute simulation, "mob inside a solid object", same rock and fence; work/tmp/i7b/walk-fuzz.ts).
   */
  private solidExit(legs: NavLeg[], end: { x: number; z: number; surface: NavSurface | null }): NavWalk | null {
    const stopOn = (i: number): NavWalk => {
      const prev = legs[i - 1]!
      const len = Math.hypot(prev.x1 - prev.x0, prev.z1 - prev.z0)
      const f = len > 0 ? Math.max(0, 1 - Math.min(EXIT_BACKOFF_M, len) / len) : 0
      const kept = legs.slice(0, i)
      const stop = kept[kept.length - 1]!
      stop.x1 = prev.x0 + (prev.x1 - prev.x0) * f
      stop.z1 = prev.z0 + (prev.z1 - prev.z0) * f
      const y = this.g.heightOn(prev.surface, stop.x1, stop.z1)
      return { end: { x: stop.x1, y, z: stop.z1, surface: prev.surface }, blocked: true, legs: kept }
    }
    for (let i = 1; i < legs.length; i++) {
      const leg = legs[i]!
      const prev = legs[i - 1]!
      if (leg.surface.kind !== 'terrain' || prev.surface.kind !== 'object') continue
      if (!this.solids.covers(leg.x0, leg.z0, this.terrainHeight(leg.x0, leg.z0))) continue
      return stopOn(i)
    }
    const last = legs[legs.length - 1]
    if (last && last.surface.kind === 'object' && end.surface?.kind === 'terrain' && this.solids.covers(end.x, end.z, this.terrainHeight(end.x, end.z))) {
      return stopOn(legs.length)
    }
    return null
  }

  heightOn(surface: NavSurface | null, x: number, z: number): number {
    return surface ? this.g.heightOn(surface, x, z) : NaN
  }

  surfaceKey(surface: NavSurface | null): string | null {
    if (!surface) return null
    if (surface.kind === 'terrain') return 't'
    const inst = this.data.instances[surface.instance]
    return inst ? `o:${inst.id >>> 0}:${surface.cell}` : null
  }

  restore(key: string | null, x: number, z: number): NavPoint | null {
    if (!key) return null
    let surface: NavSurface
    if (key === 't') surface = TERRAIN_SURFACE
    else {
      const m = /^o:(\d+):(\d+)$/.exec(key)
      const index = m ? this.byWorldId.get(Number(m[1])) : undefined
      if (!m || index === undefined) return null
      surface = { kind: 'object', instance: index, cell: Number(m[2]) }
    }
    if (surface.kind === 'terrain' && !this.terrainOpen(x, z)) return null
    const p = this.g.settle(surface, x, z)
    if (!p || !Number.isFinite(p.y)) return null
    const point: NavPoint = { x: p.x, y: p.y, z: p.z, surface: p.surface }
    // A saved surface outside the home component (the fountain basin, a courtyard) is not restored: place() moves it.
    return this.inHome(point) ? point : null
  }

  /**
   * Loads OUT_DIR/world/<world>/<manifest.nav.file> (SRNV, written with the world export). null when the manifest or
   * the file is missing or unreadable (`problem` says why).
   */
  static load(dirs: string[], world: string): { nav: MeshNav | null; problem: string } {
    let problem = 'no world manifest'
    for (const dir of dirs) {
      const base = join(dir, 'world', world)
      const manifestFile = join(base, 'manifest.json')
      if (!existsSync(manifestFile)) continue
      try {
        const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
          nav?: unknown; navData?: unknown; space?: { originRegion?: { x?: unknown; z?: unknown } }; spawn?: { x?: unknown; y?: unknown; z?: unknown }
        }
        const entry = m.nav ?? m.navData
        const file = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as { file?: unknown }).file === 'string' ? (entry as { file: string }).file : null
        const origin = m.space?.originRegion
        if (!file) {
          problem = `${manifestFile} has no nav entry`
          continue
        }
        if (!origin || typeof origin.x !== 'number' || typeof origin.z !== 'number') {
          problem = `${manifestFile} has no space.originRegion`
          continue
        }
        if (/(^|[\\/])\.\.([\\/]|$)/.test(file)) {
          problem = `${manifestFile}: bad nav path ${file}`
          continue
        }
        const path = join(base, file)
        const bytes = readFileSync(path)
        const data = decodeNavData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        const nav = new MeshNav(data, { x: origin.x, z: origin.z }, `${path} (${data.regions.length} regions, ${data.instances.length} objects, ${bytes.length} bytes)`)
        // Placements stay in the manifest spawn's walkable component (the server may re-pin it with setHome).
        const s = m.spawn
        if (s && typeof s.x === 'number' && typeof s.z === 'number') nav.setHome(s.x, s.z, typeof s.y === 'number' ? s.y : Infinity)
        return { nav, problem: '' }
      } catch (e) {
        problem = `${manifestFile}: ${(e as Error).message}`
      }
    }
    return { nav: null, problem }
  }
}

/** A point along a move's legs at distance `d` (metres) from its start, with the surface there and its height. */
export function pointOnLegs(nav: NavProvider, legs: readonly NavLeg[], d: number): NavPoint | null {
  let left = d
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]!
    const len = Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
    if (left <= len || i === legs.length - 1) {
      const f = len > 0 ? Math.min(1, Math.max(0, left / len)) : 1
      const x = l.x0 + (l.x1 - l.x0) * f
      const z = l.z0 + (l.z1 - l.z0) * f
      return { x, y: nav.heightOn(l.surface, x, z), z, surface: l.surface }
    }
    left -= len
  }
  return null
}

/** Total XZ length of legs (metres). */
export function legsLength(legs: readonly NavLeg[]): number {
  let n = 0
  for (const l of legs) n += Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
  return n
}
