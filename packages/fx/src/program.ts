/**
 * The exported effect program ("sro-fx-program" v1): one JSON file per .efp, written by
 * packages/convert/src/fx/compile.ts and interpreted by ./simulation.ts + ./renderer.ts.
 *
 * Space: glTF space (right-handed, +Y up, metres), produced only by packages/convert/src/gltf/space.ts.
 * Every length (positions, velocities, cone distances and speeds, sphere radii, BAN positions) is already
 * converted; velocities and forces are per 20 Hz frame. Matrices are column-major 3x3 (9 numbers) re-expressed
 * with the mirror (M R M). Scales are unitless multipliers of the geometry: the plate is FX_PLATE_SIZE metres
 * (one file unit) square, and meshes are the exported glb in metres.
 *
 * Time: element ages are integer frames at FX_FPS = 20 (one native update per crossed 50 ms step, per OpenSRO's
 * notes on the native process manager; read as documentation).
 */

export const FX_FORMAT = 'sro-fx-program'
export const FX_VERSION = 1
export const FX_FPS = 20
/** One Silkroad file unit (1 dm) in metres: the side of the unit plate. */
export const FX_PLATE_SIZE = 0.1

export type FxVec3 = [number, number, number]
/** Column-major 3x3. */
export type FxMat3 = [number, number, number, number, number, number, number, number, number]

/**
 * When a command runs, in element-age frames: frames first + trunc(i * period) for i < count.
 * count 0 means never. Derived from the stored (mode, start, period, end) by compile.ts.
 */
export type FxSchedule = [first: number, period: number, count: number]

/** Which frame a vector or matrix is expressed in. */
export type FxBasis = 'world' | 'self' | 'parent' | 'sibling'

export type FxCommand =
  /** SetPosition. base: where the offset starts; basis: how `v` is rotated first. */
  | { op: 'position'; base: 'self' | 'parent' | 'sibling'; basis: FxBasis; v: FxVec3; at: FxSchedule; flags: number }
  /** SetVelocity (set) and Force (add). */
  | { op: 'velocity' | 'force'; basis: FxBasis; v: FxVec3; at: FxSchedule; flags: number }
  /** SetSpherePos: random point in the ellipsoid of radii r around the base. */
  | { op: 'sphere'; base: 'self' | 'parent'; r: FxVec3; at: FxSchedule; flags: number }
  /** SetConePos (add to position), SetConeVel (set velocity), ConeForce (add to velocity): random vector about +Y. */
  | { op: 'conePos' | 'coneVel' | 'coneForce'; basis: FxBasis; min: number; max: number; angle: number; at: FxSchedule; flags: number }
  /** Attraction: velocity += k * (position - parent position) / distance (k < 0 pulls in). */
  | { op: 'attraction'; k: number; at: FxSchedule; flags: number }
  /** SetRotation / SetRotationAxis / SetRotationMat: element orientation = basis * m. */
  | { op: 'rotation'; basis: FxBasis; m: FxMat3; at: FxSchedule; flags: number }
  /** SetRVelocity / SetRVelocityAxis / SetRVelocityMat: per-frame orientation change (applied when link.localMotion). */
  | { op: 'angularVelocity'; m: FxMat3; at: FxSchedule; flags: number }
  /** SetShapeRot: geometry rotation inside the element frame. */
  | { op: 'shapeRotation'; m: FxMat3; at: FxSchedule; flags: number }
  /** SetShapeRotVel: per-frame geometry spin (applied when link.shapeMotion). */
  | { op: 'shapeSpin'; m: FxMat3; at: FxSchedule; flags: number }
  /** SetGraphRandomScale: scale = the node's random-scale graph sampled at a random time. */
  | { op: 'randomScale'; at: FxSchedule; flags: number }

export type FxCommandOp = FxCommand['op']

/**
 * A per-run table: the k-th scheduled run applies entry min(k, n - 1). The stored tables have exactly one row per run
 * (table length = schedule count on all but 19 of 35,909 tables of this client), so rows follow runs, not ages.
 */
export interface FxTable {
  at: FxSchedule
  /** `width` numbers per frame. */
  values: number[]
}

export interface FxEmit {
  /** Parent age (frames) at which emission starts. */
  start: number
  /** Frames of emission from `start`. */
  duration: number
  /** Frames between emissions (0: never). */
  period: number
  /** Live-element cap of one parent's group. */
  limit: number
  /** Elements per emission; fractions accumulate. */
  rate: number
}

export interface FxLink {
  /** Ancestor levels whose rotation the position follows (0 = none). */
  positionDepth: number
  /** Ancestor levels whose rotation the orientation follows; -1 = born with the identity orientation. */
  matrixDepth: number
  /** Ancestor levels whose rotation the velocity follows. */
  velocityDepth: number
  /** Ancestor levels whose translation the position follows. */
  followDepth: number
  /** Apply the angular velocity every frame. */
  localMotion: boolean
  /** Apply the shape spin every frame. */
  shapeMotion: boolean
  /** Stored flags whose runtime use is unknown (kept for comparison). */
  keepMatrix: boolean
  keepOrigin: boolean
}

export type FxRender = 'none' | 'plate' | 'mesh' | 'pipe' | 'dpipe' | 'linkobj'
export type FxView = 'none' | 'billboard' | 'vbillboard' | 'ybillboard'
/** Blend presets the renderer maps to engine blend states. */
export type FxBlend = 'add' | 'alpha' | 'oneone' | 'multiply' | 'screen'
/** Direct3D texture-stage colour/alpha operation, reduced to a multiplier on the vertex (diffuse) value. */
export type FxStageOp = 'texture' | 'diffuse' | 'modulate' | 'modulate2x' | 'modulate4x'

export interface FxMaterial {
  /** Index into FxEffect.textures, -1 for none. */
  texture: number
  /** Index into FxEffect.meshes, -1 for the unit plate. */
  mesh: number
  blend: FxBlend
  /** 'none' = two-sided; 'back' culls back faces (the usual); 'front' culls front faces. */
  cull: 'none' | 'back' | 'front'
  colorOp: FxStageOp
  alphaOp: FxStageOp
  /** Raw D3D values, for reference. */
  d3d: { srcBlend: number; dstBlend: number; cull: number; colorOp: number; alphaOp: number }
}

export interface FxNode {
  name: string
  /** Index of the parent node, -1 when the effect root emits it. Parents precede children. */
  parent: number
  /** Element lifetime in frames (>= 1). */
  frames: number
  /** 'extinct' dies at `frames`, 'loop' restarts its age, 'never' lives until the effect is stopped. */
  life: 'extinct' | 'loop' | 'never'
  emit: FxEmit | null
  link: FxLink
  render: FxRender
  view: FxView
  material: FxMaterial | null
  /** Commands in authored order. */
  commands: FxCommand[]
  /** SetGraphScale: 3 per frame (unitless). */
  scale?: FxTable
  /** SetGraphDiffuse: 4 per frame (r, g, b, a in 0..1). */
  color?: FxTable
  /** TextureSlide: 4 per frame (u, v, width, height of the texture window). */
  uv?: FxTable
  /** SetBANPos: 3 per frame, offset from the parent in the parent's frame. */
  banPosition?: FxTable
  /** SetBANRot: 9 per frame, absolute orientation. */
  banRotation?: FxTable
  /** BlendScaleGraph for SetGraphRandomScale: [t, x, y, z] knots, t in 0..1. */
  randomScale?: number[][]
}

export interface FxEffect {
  format: typeof FX_FORMAT
  version: typeof FX_VERSION
  /** Particles.pk2 path, lower case, forward slashes. */
  key: string
  fps: typeof FX_FPS
  /** EFP root scale (1 before version 0012). */
  scale: number
  /** Out-root-relative URLs (e.g. "fx/tex/textures/smoke3.png"); '' when the texture is missing from the client. */
  textures: string[]
  /** Out-root-relative URLs of glbs; '' when the mesh is missing from the client. */
  meshes: string[]
  nodes: FxNode[]
  /** Frames the effect needs to finish when nothing loops (upper bound), or null when something loops forever. */
  duration: number | null
  provenance: string
  warnings: string[]
}

/** Expands a schedule to a per-age mask over `frames` ages. */
export function scheduleMask(at: FxSchedule, frames: number): Uint8Array {
  const mask = new Uint8Array(Math.max(1, frames))
  const [first, period, count] = at
  for (let i = 0; i < count; i++) {
    const f = Math.trunc(first + i * period)
    if (f >= 0 && f < mask.length) mask[f] = 1
  }
  return mask
}

/** Per age: the index of the last run scheduled at that age, or -1. */
export function scheduleRuns(at: FxSchedule, frames: number): Int32Array {
  const runs = new Int32Array(Math.max(1, frames)).fill(-1)
  const [first, period, count] = at
  for (let i = 0; i < count; i++) {
    const f = Math.trunc(first + i * period)
    if (f >= 0 && f < runs.length) runs[f] = i
  }
  return runs
}

/** Structural check of a parsed program; returns the first problem or null. */
export function validateFxEffect(value: unknown): string | null {
  const e = value as Partial<FxEffect> | null
  if (!e || typeof e !== 'object') return 'not an object'
  if (e.format !== FX_FORMAT) return `format ${String(e.format)} != ${FX_FORMAT}`
  if (e.version !== FX_VERSION) return `version ${String(e.version)} != ${FX_VERSION}`
  if (e.fps !== FX_FPS) return `fps ${String(e.fps)} != ${FX_FPS}`
  if (!Array.isArray(e.nodes) || !Array.isArray(e.textures) || !Array.isArray(e.meshes)) return 'missing arrays'
  if (!(typeof e.scale === 'number' && e.scale > 0 && Number.isFinite(e.scale))) return 'bad scale'
  for (let i = 0; i < e.nodes.length; i++) {
    const n = e.nodes[i]!
    if (!(n.parent >= -1 && n.parent < i)) return `node ${i}: parent ${n.parent} must precede it`
    if (!(Number.isInteger(n.frames) && n.frames >= 1)) return `node ${i}: frames ${n.frames}`
    if (n.material) {
      if (n.material.texture >= e.textures.length || n.material.mesh >= e.meshes.length) return `node ${i}: resource index out of range`
    }
    for (const [name, t, w] of [['scale', n.scale, 3], ['color', n.color, 4], ['uv', n.uv, 4], ['banPosition', n.banPosition, 3], ['banRotation', n.banRotation, 9]] as const) {
      if (t && (t.values.length === 0 || t.values.length % w !== 0)) return `node ${i}: ${name} table length ${t.values.length}`
    }
  }
  return null
}
