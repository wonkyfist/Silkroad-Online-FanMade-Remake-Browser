/**
 * NavWorld in the world viewer's glTF frame (packages/convert/src/world/manifest.ts WorldSpace): right-handed, +Y up,
 * metres, origin = the south-west corner (file-space region-local (0, 0, 0)) of `originRegion`.
 *
 * The mapping is packages/convert/src/gltf/space.ts toGltfPosition (file (x, y, z) -> 0.1 (x, y, -z)), applied to
 * the file-space world offset from the origin region, restated here because @sro/nav must not import the Node
 * converter (the nav tests check it against space.ts):
 *   glTF x = 0.1 (fileX - 1920 originX), y = 0.1 fileY, z = -0.1 (fileZ - 1920 originZ)
 * Surfaces are frame-independent and pass through unchanged. File-space constants (0.2-unit contact back-off, 5-unit
 * arrival radius) keep their native values: 2 cm and 0.5 m.
 */
import { NVM_REGION_SIZE } from '@sro/formats'
import type { NavHit, NavLeg, NavMoveResult, NavPosition, NavSurface, NavWorld } from './world.ts'

/** Metres per file unit (space.ts UNIT_SCALE). */
export const NAV_UNIT_M = 0.1

export class NavGltf {
  private readonly ox: number
  private readonly oz: number

  constructor(readonly world: NavWorld, readonly originRegion: { x: number; z: number }) {
    this.ox = NVM_REGION_SIZE * originRegion.x
    this.oz = NVM_REGION_SIZE * originRegion.z
  }

  fileX(x: number): number { return this.ox + x / NAV_UNIT_M }
  fileZ(z: number): number { return this.oz - z / NAV_UNIT_M }
  gltfX(fx: number): number { return (fx - this.ox) * NAV_UNIT_M }
  gltfZ(fz: number): number { return -(fz - this.oz) * NAV_UNIT_M }

  /** File-space position -> glTF (same surface). */
  toGltf(p: NavPosition): NavPosition {
    return { x: this.gltfX(p.x), y: p.y * NAV_UNIT_M, z: this.gltfZ(p.z), surface: p.surface }
  }

  /** glTF position -> file space (same surface). */
  toFile(p: NavPosition): NavPosition {
    return { x: this.fileX(p.x), y: p.y / NAV_UNIT_M, z: this.fileZ(p.z), surface: p.surface }
  }

  locate(x: number, z: number, yHint: number): NavPosition | null {
    const p = this.world.locate(this.fileX(x), this.fileZ(z), yHint / NAV_UNIT_M)
    return p && this.toGltf(p)
  }

  heightAt(x: number, z: number, yHint: number): number | null {
    const y = this.world.heightAt(this.fileX(x), this.fileZ(z), yHint / NAV_UNIT_M)
    return y === null ? null : y * NAV_UNIT_M
  }

  /** Height (m) of a retained surface at a glTF point; NaN if unknown. For per-frame height along NavLegs. */
  heightOn(surface: NavSurface, x: number, z: number): number {
    return this.world.heightOn(surface, this.fileX(x), this.fileZ(z)) * NAV_UNIT_M
  }

  /** NavWorld.locateIn in metres: the surface nearest yHint at x/z among those of one walkable component. */
  locateIn(x: number, z: number, yHint: number, component: number): NavPosition | null {
    const p = this.world.locateIn(this.fileX(x), this.fileZ(z), yHint / NAV_UNIT_M, component)
    return p && this.toGltf(p)
  }

  /** NavWorld.componentOf for a glTF position with its surface. */
  componentOf(p: { x: number; z: number; surface: NavSurface }): number {
    return this.world.componentOf({ x: this.fileX(p.x), z: this.fileZ(p.z), surface: p.surface })
  }

  sameComponent(a: { x: number; z: number; surface: NavSurface }, b: { x: number; z: number; surface: NavSurface }): boolean {
    const c = this.componentOf(a)
    return c >= 0 && c === this.componentOf(b)
  }

  /** A component's sample point (NavWorld.componentSample) in metres. */
  componentSample(id: number): NavPosition | null {
    const p = this.world.componentSample(id)
    return p && this.toGltf(p)
  }

  canStand(x: number, z: number, y: number, toleranceM = 1): boolean {
    return this.world.canStand(this.fileX(x), this.fileZ(z), y / NAV_UNIT_M, toleranceM / NAV_UNIT_M)
  }

  settle(surface: NavSurface, x: number, z: number): NavPosition | null {
    const p = this.world.settle(surface, this.fileX(x), this.fileZ(z))
    return p && this.toGltf(p)
  }

  moveStraight(from: NavPosition, toX: number, toZ: number): NavMoveResult {
    const r = this.world.moveStraight(this.toFile(from), this.fileX(toX), this.fileZ(toZ))
    const legs: NavLeg[] = r.legs.map(l => ({
      x0: this.gltfX(l.x0), z0: this.gltfZ(l.z0), x1: this.gltfX(l.x1), z1: this.gltfZ(l.z1), surface: l.surface,
    }))
    const hit: NavHit | null = r.hit && { ...r.hit, x: this.gltfX(r.hit.x), z: this.gltfZ(r.hit.z) }
    return { end: this.toGltf(r.end), blocked: r.blocked, hit, distance: r.distance * NAV_UNIT_M, legs }
  }
}
