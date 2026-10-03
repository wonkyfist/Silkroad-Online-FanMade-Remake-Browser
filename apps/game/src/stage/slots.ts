/**
 * Where the stage camera stands and where the characters stand (docs/SCREENS.md §0B.2, lane SCR-R): pure maths on
 * plain {x, y, z} points, so stages.test.ts checks the framing without a GPU.
 *
 * - Headings: `yaw` is the camera's LOOK heading (0 = looking +Z, south; π = looking −Z, north). The view's right is
 *   `L × up` in the glTF (right-handed, +Y up) frame: looking +Z the right-hand side is −X.
 * - The fit rule (select, §0B.2): `dist = max(3.0, E / (2 tan(fov/2) (1 − 2b)), (1.5 × 1.3 + 0.45) / (tan(fov/2) ×
 *   aspect))` with E = 2.5 m (the feet −0.15 m to the name tag 2.35 m) and b the retail bar fraction (style.css
 *   `--bar-h: min(100vw × 172/1600, 16vh)`): 3.94 m at 16:9, 16:10 and 21:9, 3.86 m at 4:3. It uses the FOUR-slot row
 *   whatever n is: deleting or creating a character re-centres the row, never moves the camera.
 * - Select slots: slot i of n at `spot + right × (i − (n−1)/2) × 1.3 m`, pulled toward the camera by
 *   `0.2 m × (offset / 1.95 m)²` (a shallow arc), the selected one 0.3 m further but at most 0.4 m in front of the row's
 *   line (an outer slot steps 0.2 m: at 0.5 m its feet reach the bottom bar); each turns to the camera. Slot 0 is
 *   the leftmost on screen. Create: one character on the spot, facing the stage's `facing`.
 * - The camera is an ArcRotateCamera on a target (§0B.2): `arcPose` turns a position and target into alpha, beta and
 *   radius, so the select ↔ create orbit is an alpha tween and the warm-up's two views visit both headings.
 */
import type { StageDef, StageFixedCamera } from './types.ts'
import { SELECT_MAX_PULL_M, SELECT_STEP_M, SLOT_ARC_M, SLOT_SPACING_M } from './stages.ts'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** The select framing's body band (m): the feet (−0.15) to the name tag (2.35). */
export const FIT_BAND_M = 2.5
/** The closest select distance (m). */
export const FIT_MIN_M = 3.0
/** Half a character's shoulder width beyond the outer slot centre (m). */
export const FIT_SHOULDER_M = 0.45
/** Slots the fit rule frames (MAX_CHARACTER_SLOTS; the camera never moves with n). */
export const FIT_SLOTS = 4

/** The retail bars' height as a fraction of the canvas height (style.css `--bar-h`, charselect.ts `topBar()`). */
export function barFraction(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0.16
  return Math.min((width * 172) / 1600, height * 0.16) / height
}

/** The select camera distance for a vertical fov (radians) and an aspect (SCREENS §0B.2 fit rule). */
export function selectFitDistance(fovRad: number, aspect: number, bar: number): number {
  const tan = Math.tan(fovRad / 2)
  const band = FIT_BAND_M / (2 * tan * Math.max(0.05, 1 - 2 * bar))
  const rowHalf = ((FIT_SLOTS - 1) / 2) * SLOT_SPACING_M + FIT_SHOULDER_M
  const across = rowHalf / (tan * Math.max(0.1, aspect))
  return Math.max(FIT_MIN_M, band, across)
}

/** The look direction and the view's right on the ground plane for a look heading. */
export function headingAxes(yaw: number): { look: Vec3; right: Vec3 } {
  const look = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }
  // L × up (0, 1, 0) = (−Lz, 0, Lx): looking +Z, the right is −X (glTF, right-handed).
  return { look, right: { x: -look.z, y: 0, z: look.x } }
}

export interface CameraPose {
  position: Vec3
  target: Vec3
  fovRad: number
}

export interface PoseInput {
  /** The spot and its ground height (nav-snapped). */
  spot: { x: number; z: number }
  ground: number
  /** Canvas width / height (px): the fit rule and the bars. */
  width: number
  height: number
  /** Create's zoom blend, 0 = full body .. 1 = the face key. */
  zoom?: number
  /** Sideways drift (m, along the view's right; the select idle life). */
  driftM?: number
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f

/** The camera's keys at a zoom blend (the face key where the stage has one). */
function keysAt(cam: StageFixedCamera, zoom: number): { distM: number; heightM: number; targetHeightM: number; truckM: number } {
  const z = cam.zoom ? Math.max(0, Math.min(1, zoom)) : 0
  const face = cam.zoom
  return {
    distM: face ? lerp(cam.distM, face.distM, z) : cam.distM,
    heightM: face ? lerp(cam.heightM, face.heightM, z) : cam.heightM,
    targetHeightM: face ? lerp(cam.targetHeightM, face.targetHeightM, z) : cam.targetHeightM,
    truckM: face ? lerp(cam.truckM ?? 0, face.truckM ?? cam.truckM ?? 0, z) : (cam.truckM ?? 0),
  }
}

/** The fixed camera of a stage (SCREENS §0B.2): position and target in glTF metres. */
export function stagePose(def: Pick<StageDef, 'id' | 'camera'>, p: PoseInput): CameraPose {
  const cam = def.camera
  const fovRad = (cam.fovDeg * Math.PI) / 180
  const k = keysAt(cam, p.zoom ?? 0)
  const dist = def.id === 'select' ? selectFitDistance(fovRad, p.width / Math.max(1, p.height), barFraction(p.width, p.height)) : k.distM
  const { look, right } = headingAxes(cam.yaw)
  const side = k.truckM + (p.driftM ?? 0)
  return {
    position: { x: p.spot.x - look.x * dist + right.x * side, y: p.ground + k.heightM, z: p.spot.z - look.z * dist + right.z * side },
    target: { x: p.spot.x + right.x * side, y: p.ground + k.targetHeightM, z: p.spot.z + right.z * side },
    fovRad,
  }
}

/** An ArcRotateCamera's alpha, beta and radius for a position around a target (Babylon's spherical convention). */
export function arcPose(position: Vec3, target: Vec3): { alpha: number; beta: number; radius: number } {
  const dx = position.x - target.x
  const dy = position.y - target.y
  const dz = position.z - target.z
  const radius = Math.max(1e-4, Math.hypot(dx, dy, dz))
  return { alpha: Math.atan2(dz, dx), beta: Math.acos(Math.max(-1, Math.min(1, dy / radius))), radius }
}

export interface SlotPoint {
  x: number
  z: number
  /** Facing heading (radians, 0 = +Z; CharacterActor.setYaw). */
  yaw: number
}

/**
 * The standing points (x, z) of n characters and their facing (SCREENS §0B.2). `selected` steps 0.3 m toward the
 * camera; `camera` is the stage's camera position without drift (the characters turn to it). y is the host's nav snap.
 */
export function slotPoints(def: Pick<StageDef, 'id' | 'camera' | 'facing'>, spot: { x: number; z: number }, n: number, camera: Vec3, selected = -1): SlotPoint[] {
  const count = Math.max(0, Math.floor(n))
  if (def.id !== 'select') return Array.from({ length: count }, () => ({ x: spot.x, z: spot.z, yaw: def.facing }))
  const { look, right } = headingAxes(def.camera.yaw)
  const outer = ((FIT_SLOTS - 1) / 2) * SLOT_SPACING_M
  const out: SlotPoint[] = []
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * SLOT_SPACING_M
    const arc = SLOT_ARC_M * (off / outer) ** 2
    // The selected one steps 0.3 m, but never past SELECT_MAX_PULL_M in front of the row's line: an outer slot (already
    // 0.2 m closer) would put its feet into the bottom bar at 0.5 m (§0B.2).
    const pull = i === selected ? Math.min(arc + SELECT_STEP_M, Math.max(arc, SELECT_MAX_PULL_M)) : arc
    const x = spot.x + right.x * off - look.x * pull
    const z = spot.z + right.z * off - look.z * pull
    out.push({ x, z, yaw: Math.atan2(camera.x - x, camera.z - z) })
  }
  return out
}

/**
 * Where a point lands on the canvas for a pose (x, y in 0..1 from the top-left; `depth` along the view, m): a pinhole
 * with the vertical fov, as Babylon's perspective projection (stages.test.ts checks the framing with it).
 */
export function projectPoint(pose: CameraPose, aspect: number, p: Vec3): { x: number; y: number; depth: number } {
  const f = normalize(sub(pose.target, pose.position))
  const r = normalize(cross(f, { x: 0, y: 1, z: 0 }))
  const u = cross(r, f)
  const d = sub(p, pose.position)
  const depth = dot(d, f)
  const tan = Math.tan(pose.fovRad / 2)
  const nx = dot(d, r) / (depth * tan * aspect)
  const ny = dot(d, u) / (depth * tan)
  return { x: (nx + 1) / 2, y: (1 - ny) / 2, depth }
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}
