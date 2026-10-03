/**
 * The stage's face key light (docs/SCREENS.md §0B.3, §4.4; lane SCR-R): the row faces north, so by day it is backlit
 * and from 17:00 it stands in the western buildings' shade; one soft directional light on the actors carries the faces.
 *
 * - One `DirectionalLight` with `includedOnlyMeshes` = the stage actors, from the camera side 30° up and 25° to the
 *   right, intensity 0.5 on the PBR path, warm white, specular 0.3 (the first lever for dark metals at the sunset hold).
 * - It is created once, in `enter()`, before the actors' materials compile, and never removed (intensity 0 when
 *   unused): adding or removing a light marks every affected material dirty, and it takes the one free slot of the
 *   6-light character budget on PBR (world/graphics.ts PBR_CHARACTER_LIGHTS).
 * - Babylon reads an EMPTY `includedOnlyMeshes` as "every mesh", so the list always holds a geometry-less anchor: with
 *   no actor the light touches nothing, never the world.
 * - Classic (Low) gets none: the actors are not in the list there (the hemi light lights them, as in the world), so
 *   their Classic shaders stay exactly the world's.
 */
import { Color3, DirectionalLight, Mesh, Vector3, type AbstractMesh, type Camera, type Scene, type TransformNode } from '@babylonjs/core'

/** Intensity on the PBR path (measured on renders, §0B.3). */
export const KEY_LIGHT_INTENSITY = 0.5
/** Elevation above the camera's line of sight and the turn to its right (radians). */
export const KEY_LIGHT_UP = Math.PI / 6
export const KEY_LIGHT_RIGHT = (25 * Math.PI) / 180
/** The actors' meshes are re-read this often (ms): a re-dressed actor gets new meshes. */
export const KEY_LIGHT_SCAN_MS = 500

export class StageKeyLight {
  readonly light: DirectionalLight
  /** Keeps `includedOnlyMeshes` non-empty (Babylon: empty = all meshes). */
  private readonly anchor: Mesh
  private readonly roots = new Set<TransformNode>()
  private pbr = false
  private members: AbstractMesh[] = []
  private nextScan = -Infinity
  private readonly fwd = new Vector3()
  private readonly dir = new Vector3()
  /** The camera's local forward (right-handed scenes look down −Z). */
  private readonly axis: Vector3

  constructor(readonly scene: Scene) {
    this.axis = new Vector3(0, 0, scene.useRightHandedSystem ? -1 : 1)
    this.anchor = new Mesh('stageKeyAnchor', scene)
    this.anchor.isVisible = false
    this.anchor.isPickable = false
    this.anchor.setEnabled(false)
    this.light = new DirectionalLight('stageKey', new Vector3(0, -0.5, 1).normalize(), scene)
    this.light.intensity = 0
    this.light.diffuse = new Color3(1, 0.96, 0.9)
    this.light.specular = new Color3(0.3, 0.3, 0.3)
    this.light.includedOnlyMeshes = [this.anchor]
  }

  /** The meshes it lights now (the anchor first). */
  get included(): readonly AbstractMesh[] {
    return this.light.includedOnlyMeshes
  }

  /** The material path: PBR lights the actors at KEY_LIGHT_INTENSITY; Classic lights nothing. */
  setPath(pbr: boolean): void {
    if (pbr === this.pbr) return
    this.pbr = pbr
    this.light.intensity = pbr ? KEY_LIGHT_INTENSITY : 0
    this.sync(true)
  }

  add(root: TransformNode): void {
    if (this.roots.has(root)) return
    this.roots.add(root)
    this.sync(true)
  }

  remove(root: TransformNode): void {
    if (!this.roots.delete(root)) return
    this.sync(true)
  }

  /** Per frame: aims from the camera side and re-reads the actors' meshes now and then. */
  update(camera: Camera | null, now: number): void {
    if (camera) {
      camera.getDirectionToRef(this.axis, this.fwd)
      // The camera's look heading on the ground plane.
      const fx = this.fwd.x
      const fz = this.fwd.z
      const l = Math.hypot(fx, fz) || 1
      const lx = fx / l
      const lz = fz / l
      // The view's right on the ground: L × up = (−Lz, 0, Lx) (right-handed; stage/slots.ts headingAxes).
      const rx = -lz
      const rz = lx
      const cu = Math.cos(KEY_LIGHT_UP)
      const cr = Math.cos(KEY_LIGHT_RIGHT)
      const sr = Math.sin(KEY_LIGHT_RIGHT)
      // From the actors toward the light: back toward the camera, to its right, up. The light's direction is the reverse.
      const from = this.dir.set(-lx * cu * cr + rx * cu * sr, Math.sin(KEY_LIGHT_UP), -lz * cu * cr + rz * cu * sr)
      this.light.direction.set(-from.x, -from.y, -from.z)
    }
    if (now >= this.nextScan) {
      this.nextScan = now + KEY_LIGHT_SCAN_MS
      this.sync(false)
    }
  }

  /** Sets the included list when it changed (or `force`). */
  private sync(force: boolean): void {
    const want: AbstractMesh[] = []
    if (this.pbr) {
      for (const r of this.roots) {
        if (r.isDisposed()) {
          this.roots.delete(r)
          continue
        }
        for (const m of r.getChildMeshes(false)) want.push(m)
      }
    }
    if (!force && want.length === this.members.length && want.every((m, i) => m === this.members[i])) return
    this.members = want
    this.light.includedOnlyMeshes = [this.anchor, ...want]
  }

  dispose(): void {
    this.roots.clear()
    this.members = []
    this.light.dispose()
    this.anchor.dispose()
  }
}
