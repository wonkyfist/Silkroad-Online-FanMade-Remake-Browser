/**
 * The face light (docs/CHARACTERS.md §16.1, §16.5): a portrait key and fill on the licensed bodies near the camera, so
 * a face is always softly lit and readable whatever the sun does (noon overhead, dusk behind, night, rain, shade),
 * with the sun only adding direction on top. Two directional lights, camera-relative, on those bodies only
 * (`includedOnlyMeshes`):
 * - the key: from the camera's side, ≈ 20° above the line of sight and 25° to the right (slightly above eye level, off
 *   to one side, the artist's portrait key; the stage's StageKeyLight does the same on the character screens), on the
 *   whole body. Its intensity is a share of the celestial light (so it follows day, dusk, night and a storm's dimming)
 *   plus a floor that is a share of the sky's own ambient: the face is lit in proportion to how bright the world is,
 *   so it never goes black under a top-down sun and never glows at night;
 * - the fill: from the other side, a little below eye level (the ground's bounce), a share of the key, no specular,
 *   on the skin (head and body) and the eyes: it lifts the sockets, under the nose and the shadow side of the cheeks.
 *   It was on the head alone: the head's neck then read brighter than the body's below it, a band around the neck
 *   where the two meshes meet (worst at night, where the key's floor carries most of the light).
 * The skin's wrap diffuse (three/licensed-materials.ts SkinWrapPlugin) softens the sun's terminator on top.
 *
 * - PBR path only: without the celestial light (Classic / Low) both stay at 0 and touch nothing.
 * - Babylon reads an empty `includedOnlyMeshes` as every mesh: the lists always hold a geometry-less anchor.
 * - Created once and never removed (a light added or removed recompiles the materials it touches); the bodies' meshes
 *   are re-read every SCAN_MS (a re-dress makes new meshes).
 * - `__sroPerf.charLook` turns it all off, `__sroPerf.faceLight` the floor, the fill and the other bodies (A/B).
 */
import { Color3, DirectionalLight, Mesh, PBRMaterial, Vector3, type AbstractMesh, type Camera, type Light } from '@babylonjs/core'
import { sceneExposure } from '@sro/world-render'
import { licensedMaterialRole } from '../../three/licensed-materials.ts'
import { PERF } from '../perf.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

/** The key's intensity as a share of the celestial light's. */
export const SELF_KEY_SHARE = 0.1 // §16.7: 0.42 while the key lit the back of the head; on the face it blew the noon cheeks
/** Its specular share (a soft highlight, not a second sun glint). */
export const SELF_KEY_SPECULAR = 0.15 // §16.3: was 0.35
export const SELF_KEY_UP = 0.36 // ≈ 20° above the line of sight (§16.5: was 0.7, 35°: the brows shaded the sockets)
export const SELF_KEY_RIGHT = 0.47 // ≈ 25° to the camera's right
/** §16.5: the key's floor as a share of the sky's ambient irradiance (night, shade, rain: the face keeps its modelling). */
export const FACE_FLOOR = 0.5 // §16.7: was 2 (see SELF_KEY_SHARE)
/** §16.5: the fill as a share of the key, from the other side (left ≈ 40°, ≈ 10° from below). */
export const FACE_FILL = { share: 0.35, left: 0.84, down: 0.18 } // §16.7: 0.7 → 0.35, the face keeps its modelling
/** §16.5: the other licensed bodies that take the face light: the nearest this many within this distance (m). */
export const FACE_CLOSE = { count: 6, range: 14 }
/**
 * §16.6: the face's absolute minimum, display-referred: key intensity ≥ exposure / sceneExposure (the post's exposure,
 * ≈ 11 at noon, ≈ 70 at dusk and night), so the cheek keeps a readable mid-tone (measured, cheek luma at 22 with fill 0.7: see §16.6;
 * at 20 / fill 0.5 the dusk cheek was 0.34); `tint`: how far the key's
 * colour leans to the celestial light's (the moon's cool blue at night) when the minimum carries it.
 */
export const FACE_MIN = { exposure: 5, tint: 0.5 } // §16.7: 22 → 5 (cheek luma: §16.7)
/** The key's minimum intensity at the scene's post exposure. */
export function faceMinIntensity(sceneExp: number, min = SELF_KEY.min): number {
  return min / Math.max(1e-3, sceneExp)
}
/**
 * §16.7: the key's share of the minimum once the celestial light is counted: what the sun (or moon) puts on a face
 * looking at the camera (its intensity × the cosine between its travel and the view) already lights it.
 */
export function faceKeyNeed(minIntensity: number, celestialIntensity: number, celestialDir: Vector3, viewDir: Vector3): number {
  const l = celestialDir.length() || 1
  const facing = Math.max(0, Vector3.Dot(celestialDir, viewDir) / l)
  return Math.max(0, minIntensity - celestialIntensity * facing)
}
/** The live values (look lab: `__sroSelfKey`). */
export const SELF_KEY = { up: SELF_KEY_UP, right: SELF_KEY_RIGHT, share: SELF_KEY_SHARE, specular: SELF_KEY_SPECULAR, floor: FACE_FLOOR, fill: FACE_FILL.share, min: FACE_MIN.exposure, tint: FACE_MIN.tint,
  /** The floor's colour: a neutral, faintly warm white (the sky's own blue made the faces lavender, §16.4). */
  color: [1, 0.97, 0.92] as [number, number, number] }
;(globalThis as { __sroSelfKey?: unknown }).__sroSelfKey = SELF_KEY
const SCAN_MS = 500

/**
 * The camera's view direction and screen-right axis in world space. §16.7: the world scene is right-handed, where a
 * camera looks down its local −z: `Vector3.Forward()` (+z) gave the camera's BACKWARD axis, so key and fill travelled
 * towards the camera and lit the back of the head (measured in game: key · view = −0.875), a rim light that left the face
 * front to the environment and drew hard lit stripes down the nose and the cheek edges.
 */
export function cameraAxes(cam: Camera, rightHanded: boolean, fwd: Vector3, right: Vector3): void {
  cam.getDirectionToRef(Vector3.Forward(rightHanded), fwd)
  cam.getDirectionToRef(Vector3.Right(), right)
}

/** The key's direction (the way the light travels) from the camera's forward and right axes. */
export function selfKeyDirection(forward: Vector3, right: Vector3, out = new Vector3()): Vector3 {
  return out.copyFrom(forward).addInPlaceFromFloats(0, -SELF_KEY.up, 0).subtractInPlace(right.scale(SELF_KEY.right)).normalize()
}

/** The fill's direction (the way it travels): from the camera's left, a little from below. */
export function faceFillDirection(forward: Vector3, right: Vector3, out = new Vector3()): Vector3 {
  return out.copyFrom(forward).addInPlaceFromFloats(0, FACE_FILL.down, 0).addInPlace(right.scale(FACE_FILL.left)).normalize()
}

/**
 * The key's floor (a directional intensity): `share` × the sky's ambient on a surface facing it. A light's PBR diffuse
 * is albedo/π · I, the environment's albedo · (E/π) (the polynomial's constant term a): I = π · share · a.
 */
export function faceFloorIntensity(ambientLuma: number, envIntensity: number, share = SELF_KEY.floor): number {
  return Math.PI * share * Math.max(0, ambientLuma) * envIntensity
}

/** The fill's meshes: the skin, head and body alike (no light seam where they meet at the neck), and the eyes. */
export const isFillMesh = (m: AbstractMesh): boolean => {
  const mat = m.material
  if (!(mat instanceof PBRMaterial)) return false
  const role = licensedMaterialRole(mat.name)
  return role === 'skin' || role === 'eye'
}
const isLicensed = (meshes: readonly AbstractMesh[]): boolean =>
  meshes.some(m => m.material instanceof PBRMaterial && licensedMaterialRole(m.material.name) === 'skin')

export function selfKeyFeature(ctx: WorldFeatureContext): WorldFeature {
  const scene = ctx.scene
  const key = new DirectionalLight('selfKey', new Vector3(0, -1, 0), scene)
  key.intensity = 0
  const fill = new DirectionalLight('faceFill', new Vector3(0, -1, 0), scene)
  fill.intensity = 0
  fill.specular.set(0, 0, 0)
  const anchor = new Mesh('selfKey:anchor', scene)
  anchor.isPickable = false
  anchor.setEnabled(false)
  key.includedOnlyMeshes = [anchor]
  fill.includedOnlyMeshes = [anchor]
  let celestial: Light | null = null
  let lastScan = -Infinity
  let lastMeshes: AbstractMesh[] = []
  const fwd = new Vector3(), right = new Vector3()
  const col = new Color3()
  const near: { d: number; meshes: AbstractMesh[] }[] = []
  const same = (a: readonly AbstractMesh[], b: readonly AbstractMesh[]) => a.length === b.length && a.every((m, i) => m === b[i])
  return {
    onFrame(now) {
      celestial ??= scene.lights.find(l => l.name === 'celestial') ?? null
      if (now - lastScan > SCAN_MS) {
        lastScan = now
        const id = ctx.selfId()
        const self = id === null || id === undefined ? null : ctx.view(id)
        const own = self?.actor ? self.actor.root.getChildMeshes(false) : []
        for (const m of own) if (m.name.endsWith('_soft')) m.setEnabled(PERF.charLook)
        let meshes = own
        if (PERF.faceLight) {
          // the close licensed bodies (the own one always)
          near.length = 0
          const cam = ctx.camera.globalPosition
          for (const v of ctx.views()) {
            if (v === self || !v.actor) continue
            const d = Vector3.Distance(v.actor.root.getAbsolutePosition(), cam)
            if (d > FACE_CLOSE.range) continue
            const ms = v.actor.root.getChildMeshes(false)
            if (isLicensed(ms)) near.push({ d, meshes: ms })
          }
          near.sort((a, b) => a.d - b.d)
          meshes = [...own]
          for (const n of near.slice(0, FACE_CLOSE.count)) meshes.push(...n.meshes)
        }
        if (!same(meshes, lastMeshes)) {
          lastMeshes = meshes
          key.includedOnlyMeshes = [anchor, ...meshes]
          fill.includedOnlyMeshes = [anchor, ...meshes.filter(isFillMesh)]
        }
      }
      const on = !!celestial && PERF.charLook && lastMeshes.length > 0
      if (!on) {
        key.intensity = 0
        fill.intensity = 0
        return
      }
      const c = celestial!
      // the key's colour × intensity: the sun's share + the sky floor (neutral)
      const sun = c.intensity * SELF_KEY.share
      let floor = 0

      const poly = PERF.faceLight ? scene.environmentTexture?.sphericalPolynomial : null
      if (poly) {
        const ar = (poly.xx.x + poly.yy.x + poly.zz.x) / 3, ag = (poly.xx.y + poly.yy.y + poly.zz.y) / 3, ab = (poly.xx.z + poly.yy.z + poly.zz.z) / 3
        floor = faceFloorIntensity(0.2126 * ar + 0.7152 * ag + 0.0722 * ab, scene.environmentIntensity)
      }
      col.set(c.diffuse.r * sun + SELF_KEY.color[0] * floor, c.diffuse.g * sun + SELF_KEY.color[1] * floor, c.diffuse.b * sun + SELF_KEY.color[2] * floor)
      let total = Math.max(col.r, col.g, col.b)
      if (total > 0) key.diffuse.set(col.r / total, col.g / total, col.b / total)
      else key.diffuse.set(...SELF_KEY.color)
      // §16.6: the absolute minimum: a display-referred exposure of the face (the post's exposure grows from noon to
      // night, so the key needs min / exposure), the colour leaning to the celestial light's
      // §16.7: less what the celestial light already puts on a face turned to the camera (the noon sun: the face key
      // on top of it blew the cheeks, red clipped at 254)
      const cam = ctx.camera
      cameraAxes(cam, scene.useRightHandedSystem, fwd, right)
      const need = PERF.faceLight ? faceKeyNeed(faceMinIntensity(sceneExposure(scene)), c.intensity, (c as DirectionalLight).direction, fwd) : 0
      if (need > total) {
        const lift = 1 - total / need
        // towards the celestial light's colour: white at noon, warm at dusk, the moon's cool blue at night (the sky's
        // own SH reads teal at night: a green face)
        const d = c.diffuse, dm = Math.max(d.r, d.g, d.b, 1e-6)
        const t = SELF_KEY.tint * lift
        key.diffuse.set(key.diffuse.r + (d.r / dm - key.diffuse.r) * t, key.diffuse.g + (d.g / dm - key.diffuse.g) * t, key.diffuse.b + (d.b / dm - key.diffuse.b) * t)
        total = need
      }
      key.intensity = total
      key.specular.copyFrom(key.diffuse).scaleInPlace(SELF_KEY.specular)
      fill.intensity = PERF.faceLight ? total * SELF_KEY.fill : 0
      fill.diffuse.copyFrom(key.diffuse)
      selfKeyDirection(fwd, right, key.direction)
      faceFillDirection(fwd, right, fill.direction)
    },
    dispose() {
      key.dispose()
      fill.dispose()
      anchor.dispose()
    },
  }
}
