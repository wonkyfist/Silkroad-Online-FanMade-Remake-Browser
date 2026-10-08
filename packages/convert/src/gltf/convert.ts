/**
 * BSR resource -> glTF 2.0 document (+ sidecar metadata).
 *
 * Reads the resource's meshes (BMS), first material set (BMT), skeleton (BSK) and animations (BAN) through a
 * `read` callback (paths as stored in the BSR, relative to Data.pk2). Every coordinate goes through ./space.ts.
 *
 *   skinned  a skeleton that attaches to nothing (characters, monsters): one joint node per bone with the
 *            toParent rest pose, one Skin, skinned mesh nodes at the scene root, one animation per aniGroup entry.
 *   static   no skeleton, or a skeleton that attaches to a parent bone (weapons, equipment: BSR attachBone set):
 *            one root node holding the meshes in the resource's model space plus the item bones as plain nodes.
 *            The model space is the parent bone's space (see docs/CONVENTIONS.md), so attach it at identity.
 */
import { Document, type Accessor, type Buffer as GltfBuffer, type Material, type Node, type Skin, type Texture } from '@gltf-transform/core'
import {
  BMS_NO_BONE,
  BMT_FLAG,
  bskWorldTransforms,
  decodeDds,
  parseBan,
  parseBms,
  parseBmt,
  parseBsk,
  parseBsr,
  parseDdj,
  resolveBmtTexturePath,
  type BanAnimation,
  type BanTrack,
  type BmsMesh,
  type BmtFile,
  type BmtMaterial,
  type BskSkeleton,
  type BskTransform,
  type BsrResource,
} from '@sro/formats'
import { modelParticles, tidyVec, type ModelParticle } from '../fx/model-fx.ts'
import { encodePng } from '../png.ts'
import {
  mat4Multiply,
  rigidCompose,
  rigidInverse,
  rigidToMat4,
  toGltfDirections,
  toGltfIndices,
  toGltfPositions,
  toGltfQuats,
  toGltfTransform,
  UNIT_SCALE,
  type Quat,
  type Vec3,
} from './space.ts'

/** Reads a file by its Data.pk2-relative path (backslashes allowed); throws when missing. */
export type ReadFile = (path: string) => Uint8Array

export interface ConvertOptions {
  read: ReadFile
  /** Alpha cutoff used for alpha-tested materials. */
  alphaCutoff?: number
  /**
   * Object lightmaps (BMS vertex flag 0x400). When set, a mesh with uv1 and a lightmap path gets TEXCOORD_1 and its
   * own material variant whose extras carry LIGHTMAP_EXTRAS_KEY: { path, uri, texCoord: 1 }. `uri(path)` returns where
   * the caller wrote (or will write) the decoded lightmap image, or null to leave it out. Without this option meshes
   * are written exactly as before (no TEXCOORD_1).
   */
  lightmaps?: { uri: (ddjPath: string) => string | null }
  /**
   * Is this Particles.pk2 effect key ('system/item_drop_money.efp') present? Mod-palette particles whose .efp is
   * missing are dropped from the sidecar with a warning (docs/EFFECTS.md §5.2). Without it every particle is kept.
   */
  particleExists?: (efpKey: string) => boolean
}

/** Key of the material extras entry that describes an object lightmap (see ConvertOptions.lightmaps). */
export const LIGHTMAP_EXTRAS_KEY = 'sroLightmap'

/** Material extras written for a lightmapped mesh. */
export interface LightmapExtras {
  /** Lightmap .ddj as stored in the BMS (backslashes, relative to Data.pk2). */
  path: string
  /** Where the decoded image lives, as returned by ConvertOptions.lightmaps.uri (null: not exported). */
  uri: string | null
  /** Always 1: the lightmap is sampled with TEXCOORD_1 (BMS uv1). */
  texCoord: 1
}

export interface SidecarEvent {
  timeMs: number
  /** 1 = hit, 2 = footstep, 4 = unknown. */
  type: number
  p1: number
  p2: number
}

export interface SidecarAnimation {
  /** glTF animation name (unique within the file). */
  name: string
  /** aniGroup (stance) the entry belongs to: 'default', 'sword', ... */
  group: string
  type: number
  typeName: string
  /** .ban path as stored in the BSR. */
  ban: string
  /** Name stored inside the .ban. */
  banName: string
  durationMs: number
  fps: number
  /** BAN animationType 1 (cyclic). */
  cyclic: boolean
  keys: number
  walkLength: number
  events: SidecarEvent[]
  /** BAN tracks whose bone is not in this skeleton (e.g. avatar wing bones). */
  skippedTracks?: string[]
  /** Tracks replaced by the rest pose because their keys were not finite. */
  invalidTracks?: string[]
  /** Skeleton joints the BAN animates (a track with at least one key). */
  trackedJoints: number
  /**
   * An overlay clip (hit flinch, shield block, upper-body idle): it animates fewer than PARTIAL_CLIP_FRACTION of the
   * joints the resource's fullest clip animates. Only its tracked joints get channels, so it layers over the current
   * pose instead of snapping every other bone to the bind pose (a T-pose for characters).
   */
  partial?: true
}

/** See SidecarAnimation.partial. Full clips miss at most a few anchor bones (HandMid, Spine_Base): 37 of 43. */
export const PARTIAL_CLIP_FRACTION = 0.8

export interface SidecarMaterial {
  name: string
  bmt: string
  flags: number
  flagNames: string[]
  texture: string | null
  textureFormat?: string
  textureSize?: [number, number]
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND'
  alphaCutoff?: number
  alphaReason: string
  doubleSided: boolean
  /** Set on the material variant of a lightmapped mesh (ConvertOptions.lightmaps). */
  lightmap?: LightmapExtras
  diffuse: number[]
  ambient: number[]
  specular: number[]
  emissive: number[]
  power: number
  /**
   * Wave 12 (UV scroll, additive): the retail texture scroll, texture repeats per second along [U, V] in glTF UV space
   * (the BSR's always-on `texAni` ModData: its per-second D3D texture transform's translation, matrix[8] / matrix[9],
   * on the diffuse stage). The renderer adds fract(seconds × rate) to the UV (world-render uv-scroll.ts). Absent: a
   * still texture (every material that does not scroll, and every export before wave 12).
   */
  uvScroll?: [number, number]
}

/** |rate| above this (texture repeats per second) is not a retail scroll: dropped with a warning (UV_SCROLL_MAX). */
export const UV_SCROLL_LIMIT = 16

/** One always-on texture scroll of a resource (`textureScrolls`). */
export interface TextureScroll {
  /** The BMT material index it drives; -1 = every material. */
  mtrlIndex: number
  /** Texture repeats per second along U and V (the transform's translation rate, matrix[8] / matrix[9]). */
  u: number
  v: number
  /**
   * 'diffuse': stage 0, the material's own texture (exported). 'multiTex': the transform drives the second texture
   * stage (`unknown[0] === 1`, a MultiTex ModData's texture), which the renderer does not draw: not exported.
   */
  stage: 'diffuse' | 'multiTex'
}

/**
 * The always-on texture scrolls of a resource: the `texAni` ModData of its AMBIENT system sets (status and
 * animation-linked sets are conditional, never exported). Only the translation rate is read; a rate matrix with any
 * other non-zero entry (rotation, scale) is reported in `warnings` and its translation kept. Non-finite or
 * out-of-range (|rate| > UV_SCROLL_LIMIT) rates are dropped with a warning; a zero rate is no scroll.
 */
export function textureScrolls(bsr: Pick<BsrResource, 'modPalette'>, warnings: string[] = []): TextureScroll[] {
  const out: TextureScroll[] = []
  for (const set of bsr.modPalette.systemSets) {
    if (set.typeName !== 'AMBIENT' && set.name.toLowerCase() !== 'ambient') continue
    for (const mod of set.mods) {
      if (mod.kind !== 'texAni') continue
      const m = mod.matrix
      const u = m[8] ?? NaN
      const v = m[9] ?? NaN
      const where = `texAni (set ${JSON.stringify(set.name)}, material ${mod.mtrlIndex})`
      if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u) > UV_SCROLL_LIMIT || Math.abs(v) > UV_SCROLL_LIMIT) {
        warnings.push(`${where}: scroll (${u}, ${v}) is not a texture scroll; dropped`)
        continue
      }
      if (u === 0 && v === 0) continue
      if (m.some((x, i) => i !== 8 && i !== 9 && x !== 0)) warnings.push(`${where}: only the transform's translation is exported`)
      out.push({ mtrlIndex: mod.mtrlIndex, u: tidyRate(u), v: tidyRate(v), stage: mod.unknown[0] === 1 ? 'multiTex' : 'diffuse' })
    }
  }
  return out
}

/** A float32 rate as its shortest decimal (-0.82 rather than -0.8199999928474426); +0 for -0. */
function tidyRate(x: number): number {
  return Number(Math.fround(x).toPrecision(7)) + 0
}

/**
 * The scroll of one material (its index in the BMT): the first diffuse-stage scroll that names it or every material
 * (-1); null when none. A second one is reported in `warnings` (the first is kept).
 */
export function materialScroll(scrolls: readonly TextureScroll[], index: number, warnings: string[] = []): [number, number] | null {
  const hits = scrolls.filter(s => s.stage === 'diffuse' && (s.mtrlIndex === -1 || s.mtrlIndex === index))
  if (hits.length > 1) warnings.push(`material ${index}: ${hits.length} texture scrolls; the first is exported`)
  return hits.length ? [hits[0]!.u, hits[0]!.v] : null
}

export interface SidecarMesh {
  name: string
  bms: string
  material: string
  vertices: number
  triangles: number
  skinned: boolean
  bones: string[]
  /** Present when the mesh was written with TEXCOORD_1 and a lightmap material (ConvertOptions.lightmaps). */
  lightmap?: LightmapExtras
}

export interface SidecarStats {
  vertices: number
  triangles: number
  joints: number
  meshes: number
  animations: number
  textures: number
  /** Bind-pose height (max Y - min Y) in metres. */
  heightM: number
  boundsMin: Vec3
  boundsMax: Vec3
}

export interface Sidecar {
  source: string
  /** BSR signature, e.g. 'JMXVRES 0109'. */
  version: string
  generator: string
  name: string
  type: string
  units: { metresPerUnit: number; sourceUnit: string; handedness: string; up: string; forward: string }
  skeleton: { bsk: string; joints: string[]; bindCheck: BindCheck } | null
  /**
   * Static resources with a skeleton (weapons, shields, arrows): each bone's model-space position in glTF metres
   * (`ai_start` / `ai_end` = the weapon-trail edge, `Bone01` = the enchant glow anchor; docs/EFFECTS.md §5.2).
   */
  dummies?: Record<string, [number, number, number]>
  /** Mod-palette particles (drop sparkles, mob status sets, clip-bound smoke): fx/model-fx.ts. */
  particles?: ModelParticle[]
  /** Bone of the parent skeleton this resource attaches to (weapons), or null. */
  attachBone: string | null
  attachable: {
    kind: number
    attachPoint: number
    attachPointName: string | null
    attachMethod: number
    attachMethodName: string | null
    slots: Array<{ slot: number; slotName: string | null; mesh: string | null }>
  } | null
  materials: SidecarMaterial[]
  meshes: SidecarMesh[]
  animations: SidecarAnimation[]
  stats: SidecarStats
  warnings: string[]
  validation?: { errors: number; warnings: number; infos: number; issues: string[] }
}

export interface BindCheck {
  /** max |(bindWorld * inverseBind) - I| over all joints and matrix entries. */
  maxIdentityError: number
  /** max |nodeWorld - convert(bskWorldTransforms)| (checks that the handedness change commutes with composition). */
  maxHierarchyError: number
  /** Joints whose stored toLocal (inverse bind cache) differs from the inverse of the toParent chain by > 1e-3. */
  staleToLocal: string[]
}

export interface ConvertResult {
  document: Document
  sidecar: Sidecar
}

const GENERATOR = 'silkroad-web convert (packages/convert/src/gltf)'

function fileBase(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  return name.replace(/\.[^.]*$/, '')
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`
  used.add(name)
  return name
}

function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!))
  return m
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

interface MeshGeometry {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint16Array | Uint32Array
  triangles: number
}

/** BMS uv1 with non-finite components replaced by 0 (glTF TEXCOORD_1). */
function buildUv1(bms: BmsMesh, warnings: string[]): Float32Array | null {
  if (!bms.uv1) return null
  const uvs = new Float32Array(bms.uv1)
  let bad = 0
  for (let i = 0; i < uvs.length; i++) {
    if (!Number.isFinite(uvs[i]!)) {
      uvs[i] = 0
      bad++
    }
  }
  if (bad) warnings.push(`${bms.name}: replaced ${bad} non-finite uv1 component(s) by 0`)
  return uvs
}

/** Positions, normals (unit length; zero normals rebuilt from faces), uvs (non-finite -> 0), mirrored winding. */
function buildGeometry(bms: BmsMesh, warnings: string[]): MeshGeometry {
  const n = bms.vertexCount
  const positions = toGltfPositions(bms.positions)
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i]!)) {
      warnings.push(`${bms.name}: non-finite position component(s) replaced by 0`)
      for (let j = i; j < positions.length; j++) if (!Number.isFinite(positions[j]!)) positions[j] = 0
      break
    }
  }
  const all = toGltfIndices(bms.indices)
  const kept: number[] = []
  let dropped = 0
  for (let i = 0; i + 2 < all.length; i += 3) {
    const a = all[i]!
    const b = all[i + 1]!
    const c = all[i + 2]!
    if (a >= n || b >= n || c >= n) dropped++
    else kept.push(a, b, c)
  }
  if (dropped) warnings.push(`${bms.name}: dropped ${dropped} triangle(s) with out-of-range indices`)

  const normals = toGltfDirections(bms.normals)
  let rebuilt = 0
  const faceSum = new Float32Array(n * 3)
  let faceSumReady = false
  for (let v = 0; v < n; v++) {
    const o = v * 3
    let len = Math.hypot(normals[o]!, normals[o + 1]!, normals[o + 2]!)
    if (!(len > 1e-6) || !Number.isFinite(len)) {
      if (!faceSumReady) {
        // Area-weighted face normals, in glTF space with the glTF (counter-clockwise) winding.
        for (let t = 0; t < kept.length; t += 3) {
          const [a, b, c] = [kept[t]! * 3, kept[t + 1]! * 3, kept[t + 2]! * 3]
          const e1 = [positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!]
          const e2 = [positions[c]! - positions[a]!, positions[c + 1]! - positions[a + 1]!, positions[c + 2]! - positions[a + 2]!]
          const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!
          const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!
          const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!
          for (const k of [a, b, c]) {
            faceSum[k] += cx
            faceSum[k + 1] += cy
            faceSum[k + 2] += cz
          }
        }
        faceSumReady = true
      }
      normals[o] = faceSum[o]!
      normals[o + 1] = faceSum[o + 1]!
      normals[o + 2] = faceSum[o + 2]!
      len = Math.hypot(normals[o]!, normals[o + 1]!, normals[o + 2]!)
      if (!(len > 1e-12)) {
        normals[o] = 0
        normals[o + 1] = 1
        normals[o + 2] = 0
        len = 1
      }
      rebuilt++
    }
    normals[o] = normals[o]! / len
    normals[o + 1] = normals[o + 1]! / len
    normals[o + 2] = normals[o + 2]! / len
  }
  if (rebuilt) warnings.push(`${bms.name}: rebuilt ${rebuilt} zero/non-finite normal(s) from faces`)

  const uvs = new Float32Array(bms.uv0)
  let badUv = 0
  for (let i = 0; i < uvs.length; i++) {
    if (!Number.isFinite(uvs[i]!)) {
      uvs[i] = 0
      badUv++
    }
  }
  if (badUv) warnings.push(`${bms.name}: replaced ${badUv} non-finite uv component(s) by 0`)
  return { positions, normals, uvs, indices: new Uint16Array(kept), triangles: kept.length / 3 }
}

interface SkinAttributes {
  joints: Uint16Array
  weights: Float32Array
  fallbackVertices: number
}

/**
 * Maps a mesh's local bone palette to skeleton joint indices by name and normalizes the weights.
 * Influences to the same joint are merged, the four largest kept, unused slots point at joint 0 with weight 0.
 */
function buildSkinAttributes(bms: BmsMesh, jointIndexByName: Map<string, number>, fallbackJoint: number,
  warnings: string[]): SkinAttributes {
  const palette = bms.boneNames.map(name => {
    const j = jointIndexByName.get(name)
    if (j === undefined) warnings.push(`${bms.name}: bone ${JSON.stringify(name)} is not in the skeleton; mapped to the root`)
    return j ?? fallbackJoint
  })
  const n = bms.vertexCount
  const joints = new Uint16Array(n * 4)
  const weights = new Float32Array(n * 4)
  const k = bms.influencesPerVertex
  let fallbackVertices = 0
  const acc = new Map<number, number>()
  for (let v = 0; v < n; v++) {
    acc.clear()
    for (let s = 0; s < k; s++) {
      const bone = bms.skinBones![v * k + s]!
      const w = bms.skinWeights![v * k + s]! / 65535
      if (bone === BMS_NO_BONE || !(w > 0) || bone >= palette.length) continue
      const j = palette[bone]!
      acc.set(j, (acc.get(j) ?? 0) + w)
    }
    let pairs = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4)
    let sum = pairs.reduce((s, p) => s + p[1], 0)
    if (!(sum > 0)) {
      pairs = [[palette[0] ?? fallbackJoint, 1]]
      sum = 1
      fallbackVertices++
    }
    for (let s = 0; s < 4; s++) {
      const p = pairs[s]
      joints[v * 4 + s] = p ? p[0] : 0
      weights[v * 4 + s] = p ? p[1] / sum : 0
    }
  }
  if (fallbackVertices) warnings.push(`${bms.name}: ${fallbackVertices} vertex(es) without influences bound to ${bms.boneNames[0] ?? 'the root'}`)
  return { joints, weights, fallbackVertices }
}

/** A weapon or shield resource (`item\<race>\weapon|shield\...`): its texture alpha is a mask, never coverage. */
export function isWeaponPath(path: string): boolean {
  return /(^|[\\/])item[\\/][^\\/]+[\\/](weapon|shield)[\\/]/i.test(path)
}

interface AlphaDecision {
  mode: 'OPAQUE' | 'MASK' | 'BLEND'
  reason: string
}

/**
 * BMT has a single alpha bit (0x200) and no test/blend distinction, so the texture decides: alpha-tested
 * cut-outs (hair, fur) are mostly 0 or 255, true translucency is mostly in between.
 */
function decideAlpha(material: BmtMaterial, rgba: Uint8Array | null, weapon = false): AlphaDecision {
  if (!(material.flags & BMT_FLAG.alpha)) {
    return { mode: 'OPAQUE', reason: 'no BMT alpha flag (0x200); texture alpha, if any, is a specular/env mask' }
  }
  if (!rgba) return { mode: 'MASK', reason: 'BMT alpha flag, no texture to inspect' }
  let zero = 0
  let partial = 0
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i]!
    if (a === 0) zero++
    else if (a < 255) partial++
  }
  const total = rgba.length / 4
  const pct = (x: number) => ((x / total) * 100).toFixed(1)
  if (zero + partial === 0) return { mode: 'OPAQUE', reason: 'BMT alpha flag but the texture is fully opaque' }
  if (partial > 2 * zero) {
    // A weapon's or shield's partial alpha is its specular/env mask (sword1_2_3, spear_1_5, tblade_1_5, bow_1_5,
    // Shield_04: 79-94 % partial), not coverage: drawn as coverage the blade went see-through in the middle
    // (docs/RARITY.md §5.8). They stay opaque; the mask stays in the texture's alpha.
    if (weapon) return { mode: 'OPAQUE', reason: `weapon/shield: texture alpha is a specular/env mask (${pct(partial)}% partial, ${pct(zero)}% zero)` }
    return { mode: 'BLEND', reason: `BMT alpha flag; texture alpha mostly partial (${pct(partial)}% partial, ${pct(zero)}% zero)` }
  }
  return { mode: 'MASK', reason: `BMT alpha flag; texture alpha mostly binary (${pct(zero)}% zero, ${pct(partial)}% partial)` }
}

interface TrackKeys {
  times: Float32Array
  rotations: Float32Array
  translations: Float32Array
}

/** Converted keys of one BAN track, or null when a key is not finite. Duplicate times are dropped. */
function convertTrack(track: BanTrack): TrackKeys | null {
  const n = track.keyTimes.length
  if (n === 0) return null
  const keep: number[] = []
  let last = -Infinity
  for (let i = 0; i < n; i++) {
    const t = track.keyTimes[i]!
    if (t > last) {
      keep.push(i)
      last = t
    }
  }
  const rot = toGltfQuats(track.rotations)
  const pos = toGltfPositions(track.translations)
  const times = new Float32Array(keep.length)
  const rotations = new Float32Array(keep.length * 4)
  const translations = new Float32Array(keep.length * 3)
  let prev: Quat | null = null
  for (let o = 0; o < keep.length; o++) {
    const i = keep[o]!
    times[o] = track.keyTimes[i]! / 1000
    let q: Quat = [rot[i * 4]!, rot[i * 4 + 1]!, rot[i * 4 + 2]!, rot[i * 4 + 3]!]
    const len = Math.hypot(...q)
    if (!Number.isFinite(len) || len < 1e-6) return null
    q = q.map(c => c / len) as Quat
    // Keep consecutive keys in one hemisphere so LINEAR (slerp) takes the short way.
    if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map(c => -c) as Quat
    rotations.set(q, o * 4)
    prev = q
    for (let c = 0; c < 3; c++) {
      const v = pos[i * 3 + c]!
      if (!Number.isFinite(v)) return null
      translations[o * 3 + c] = v
    }
  }
  return { times, rotations, translations }
}

class Builder {
  readonly doc = new Document()
  readonly buffer: GltfBuffer
  constructor() {
    this.doc.getRoot().getAsset().generator = GENERATOR
    this.buffer = this.doc.createBuffer()
  }

  accessor(type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4', array: Float32Array | Uint16Array | Uint32Array): Accessor {
    return this.doc.createAccessor().setType(type).setArray(array).setBuffer(this.buffer)
  }
}

function chooseMaterialSet(bsr: BsrResource): BsrResource['materials'][number] | undefined {
  return bsr.materials.find(m => m.id === 0) ?? bsr.materials[0]
}

export function convertResource(bsrPath: string, options: ConvertOptions): ConvertResult {
  const { read } = options
  const alphaCutoff = options.alphaCutoff ?? 0.5
  const warnings: string[] = []
  const bsr = parseBsr(read(bsrPath))
  const b = new Builder()
  const { doc } = b
  const scene = doc.createScene(bsr.name || fileBase(bsrPath))
  doc.getRoot().setDefaultScene(scene)

  // --- skeleton -------------------------------------------------------------------------------------------------
  let bsk: BskSkeleton | null = null
  if (bsr.skeleton) {
    try {
      bsk = parseBsk(read(bsr.skeleton.path))
      if (bsk.bones.length === 0) bsk = null
    } catch (e) {
      warnings.push(`skeleton ${bsr.skeleton.path}: ${(e as Error).message}`)
    }
  }
  const attachBone = bsr.skeleton?.attachBone || null

  // --- meshes (parse first; skinning depends on them) -----------------------------------------------------------
  const parsedMeshes: Array<{ path: string; bms: BmsMesh }> = []
  for (const m of bsr.meshes) {
    try {
      parsedMeshes.push({ path: m.path, bms: parseBms(read(m.path)) })
    } catch (e) {
      warnings.push(`mesh ${m.path}: ${(e as Error).message}`)
    }
  }
  const skinned = bsk !== null && attachBone === null && parsedMeshes.some(m => m.bms.boneNames.length > 0)

  // --- bone nodes -------------------------------------------------------------------------------------------------
  const boneNodes: Node[] = []
  const jointIndexByName = new Map<string, number>()
  let bindCheck: BindCheck | null = null
  let skin: Skin | null = null
  let staticRoot: Node | null = null
  if (!skinned) {
    staticRoot = doc.createNode(bsr.name || fileBase(bsrPath))
    scene.addChild(staticRoot)
  }
  if (bsk) {
    const bones = bsk.bones
    const locals = bones.map(bone => toGltfTransform(bone.toParent))
    bones.forEach((bone, i) => {
      const t = locals[i]!
      boneNodes.push(doc.createNode(bone.name).setRotation(t.rotation as Quat).setTranslation(t.translation as Vec3))
      jointIndexByName.set(bone.name, i)
    })
    const roots: Node[] = []
    bones.forEach((bone, i) => {
      if (bone.parentIndex >= 0 && bone.parentIndex !== i) boneNodes[bone.parentIndex]!.addChild(boneNodes[i]!)
      else roots.push(boneNodes[i]!)
    })
    let skeletonRoot: Node
    if (roots.length === 1) skeletonRoot = roots[0]!
    else {
      skeletonRoot = doc.createNode(`${fileBase(bsr.skeleton!.path)}_roots`)
      for (const r of roots) skeletonRoot.addChild(r)
    }
    if (staticRoot) staticRoot.addChild(skeletonRoot)
    else scene.addChild(skeletonRoot)

    if (skinned) {
      // Node-hierarchy world transforms in glTF space (the same composition the viewer will perform).
      const world: BskTransform[] = []
      const visit = (i: number): BskTransform => {
        if (world[i]) return world[i]!
        const p = bones[i]!.parentIndex
        world[i] = p >= 0 && p !== i ? rigidCompose(visit(p), locals[i]!) : locals[i]!
        return world[i]!
      }
      bones.forEach((_, i) => visit(i))
      const fileWorld = bskWorldTransforms(bsk).map(t => toGltfTransform(t))
      const ibm = new Float32Array(16 * bones.length)
      let maxIdentityError = 0
      let maxHierarchyError = 0
      const staleToLocal: string[] = []
      bones.forEach((bone, i) => {
        const bindWorld = rigidToMat4(world[i]!)
        const inverseBind = rigidToMat4(rigidInverse(world[i]!))
        ibm.set(inverseBind, i * 16)
        maxIdentityError = Math.max(maxIdentityError, maxAbsDiff(mat4Multiply(bindWorld, inverseBind), IDENTITY))
        maxHierarchyError = Math.max(maxHierarchyError, maxAbsDiff(bindWorld, rigidToMat4(fileWorld[i]!)))
        const stored = rigidToMat4(toGltfTransform(bone.toLocal))
        if (maxAbsDiff(stored, inverseBind) > 1e-3) staleToLocal.push(bone.name)
      })
      if (maxIdentityError > 1e-4) throw new Error(`bind check failed: bindWorld * inverseBind deviates from I by ${maxIdentityError}`)
      if (maxHierarchyError > 1e-4) throw new Error(`bind check failed: node hierarchy deviates from BSK world by ${maxHierarchyError}`)
      if (staleToLocal.length) {
        warnings.push(`${staleToLocal.length} joint(s) with a stale stored toLocal; inverse binds use the toParent chain`)
      }
      bindCheck = { maxIdentityError, maxHierarchyError, staleToLocal }
      skin = doc.createSkin(fileBase(bsr.skeleton!.path)).setSkeleton(skeletonRoot)
        .setInverseBindMatrices(b.accessor('MAT4', ibm))
      for (const node of boneNodes) skin.addJoint(node)
    }
  }
  const rootJoint = bsk ? Math.max(0, bsk.bones.findIndex(bone => bone.parentIndex < 0)) : 0

  // --- materials --------------------------------------------------------------------------------------------------
  const materialSet = chooseMaterialSet(bsr)
  let bmt: BmtFile | null = null
  if (materialSet) {
    try {
      bmt = parseBmt(read(materialSet.path))
    } catch (e) {
      warnings.push(`material set ${materialSet.path}: ${(e as Error).message}`)
    }
  } else warnings.push('resource has no material set')
  const sidecarMaterials: SidecarMaterial[] = []
  // Wave 12 (UV scroll): the resource's always-on texture scrolls (a multi-texture stage's is reported, not exported).
  const scrolls = textureScrolls(bsr, warnings)
  for (const s of scrolls) {
    if (s.stage === 'multiTex') warnings.push(`texAni on material ${s.mtrlIndex} drives the multi-texture stage (not drawn): scroll (${s.u}, ${s.v}) not exported`)
  }
  const materialCache = new Map<string, Material>()
  const textureCache = new Map<string, { texture: Texture | null; rgba: Uint8Array | null; format?: string; size?: [number, number] }>()
  const loadTexture = (path: string) => {
    const key = path.toLowerCase()
    let entry = textureCache.get(key)
    if (!entry) {
      try {
        const img = decodeDds(parseDdj(read(path)).dds)
        const png = encodePng(img.width, img.height, img.rgba)
        const texture = doc.createTexture(fileBase(path)).setImage(new Uint8Array(png)).setMimeType('image/png')
        entry = { texture, rgba: img.rgba, format: img.format, size: [img.width, img.height] }
      } catch (e) {
        warnings.push(`texture ${path}: ${(e as Error).message}`)
        entry = { texture: null, rgba: null }
      }
      textureCache.set(key, entry)
    }
    return entry
  }
  const materialFor = (name: string, lightmap?: LightmapExtras): Material => {
    const key = lightmap ? `${name.toLowerCase()}|${lightmap.path.toLowerCase()}` : name.toLowerCase()
    const cached = materialCache.get(key)
    if (cached) return cached
    const src = bmt?.materials.find(m => m.name.toLowerCase() === name.toLowerCase())
    const material = doc.createMaterial(name || 'default').setMetallicFactor(0).setRoughnessFactor(1)
    if (lightmap) material.setExtras({ [LIGHTMAP_EXTRAS_KEY]: lightmap })
    materialCache.set(key, material)
    if (!src) {
      warnings.push(`material ${JSON.stringify(name)} not found in ${materialSet?.path ?? '(no material set)'}`)
      return material
    }
    const scroll = materialScroll(scrolls, bmt!.materials.indexOf(src), warnings)
    const texPath = src.diffuseMap.path ? resolveBmtTexturePath(materialSet!.path, src.diffuseMap) : ''
    const tex = texPath ? loadTexture(texPath) : null
    const alpha = decideAlpha(src, tex?.rgba ?? null, isWeaponPath(bsrPath))
    const doubleSided = (src.flags & BMT_FLAG.twoSided) !== 0
    material.setAlphaMode(alpha.mode).setDoubleSided(doubleSided)
    if (alpha.mode === 'MASK') material.setAlphaCutoff(alphaCutoff)
    const emissive = src.emissive.slice(0, 3).map(c => Math.min(1, Math.max(0, c))) as Vec3
    if (emissive.some(c => c > 0)) material.setEmissiveFactor(emissive)
    if (tex?.texture) {
      material.setBaseColorTexture(tex.texture)
      material.getBaseColorTextureInfo()!.setMinFilter(9987).setMagFilter(9729) // LINEAR_MIPMAP_LINEAR, LINEAR
    } else {
      material.setBaseColorFactor([...src.diffuse.slice(0, 3), 1] as Quat)
    }
    sidecarMaterials.push({
      name: src.name,
      bmt: materialSet!.path,
      flags: src.flags,
      flagNames: src.flagNames,
      texture: texPath || null,
      ...(tex?.format ? { textureFormat: tex.format, textureSize: tex.size } : {}),
      alphaMode: alpha.mode,
      ...(alpha.mode === 'MASK' ? { alphaCutoff } : {}),
      alphaReason: alpha.reason,
      doubleSided,
      ...(lightmap ? { lightmap } : {}),
      diffuse: src.diffuse,
      ambient: src.ambient,
      specular: src.specular,
      emissive: src.emissive,
      power: src.power,
      ...(scroll ? { uvScroll: scroll } : {}),
    })
    return material
  }

  // --- mesh nodes -------------------------------------------------------------------------------------------------
  const usedNodeNames = new Set(bsk?.bones.map(bone => bone.name) ?? [])
  const sidecarMeshes: SidecarMesh[] = []
  let vertices = 0
  let triangles = 0
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const { path, bms } of parsedMeshes) {
    const geo = buildGeometry(bms, warnings)
    if (geo.triangles === 0) {
      warnings.push(`${bms.name}: no triangles, skipped`)
      continue
    }
    let lightmap: LightmapExtras | undefined
    const uv1 = options.lightmaps && bms.lightmapPath ? buildUv1(bms, warnings) : null
    if (uv1 && bms.lightmapPath) {
      lightmap = { path: bms.lightmapPath, uri: options.lightmaps!.uri(bms.lightmapPath), texCoord: 1 }
    }
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', b.accessor('VEC3', geo.positions))
      .setAttribute('NORMAL', b.accessor('VEC3', geo.normals))
      .setAttribute('TEXCOORD_0', b.accessor('VEC2', geo.uvs))
      .setIndices(b.accessor('SCALAR', geo.indices))
      .setMaterial(materialFor(bms.materialName, lightmap))
    if (uv1) prim.setAttribute('TEXCOORD_1', b.accessor('VEC2', uv1))
    const meshSkinned = skin !== null && bms.boneNames.length > 0 && bms.skinBones !== undefined
    if (meshSkinned) {
      const attrs = buildSkinAttributes(bms, jointIndexByName, rootJoint, warnings)
      prim.setAttribute('JOINTS_0', b.accessor('VEC4', attrs.joints))
        .setAttribute('WEIGHTS_0', b.accessor('VEC4', attrs.weights))
    } else if (skin) {
      warnings.push(`${bms.name}: no skin data; left static at the model origin`)
    }
    const nodeName = uniqueName(bms.name || fileBase(path), usedNodeNames)
    const node = doc.createNode(nodeName).setMesh(doc.createMesh(nodeName).addPrimitive(prim))
    if (meshSkinned) {
      node.setSkin(skin!)
      scene.addChild(node)
    } else if (staticRoot) staticRoot.addChild(node)
    else scene.addChild(node)

    for (let i = 0; i < geo.positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c]!, geo.positions[i + c]!)
        max[c] = Math.max(max[c]!, geo.positions[i + c]!)
      }
    }
    vertices += bms.vertexCount
    triangles += geo.triangles
    sidecarMeshes.push({
      name: nodeName,
      bms: path,
      material: bms.materialName,
      vertices: bms.vertexCount,
      triangles: geo.triangles,
      skinned: meshSkinned,
      bones: bms.boneNames,
      ...(lightmap ? { lightmap } : {}),
    })
  }

  // --- animations -------------------------------------------------------------------------------------------------
  const sidecarAnimations: SidecarAnimation[] = []
  if (skin && bsk) {
    const bones = bsk.bones
    const banCache = new Map<string, BanAnimation | null>()
    const trackCache = new Map<string, { input: Accessor; rot: Accessor; pos: Accessor } | null>()
    const restCache = new Map<number, { input: Accessor; rot: Accessor; pos: Accessor }>()
    let restInput: Accessor | null = null
    const restFor = (i: number) => {
      let r = restCache.get(i)
      if (!r) {
        restInput ??= b.accessor('SCALAR', new Float32Array([0]))
        const node = boneNodes[i]!
        r = {
          input: restInput,
          rot: b.accessor('VEC4', new Float32Array(node.getRotation())),
          pos: b.accessor('VEC3', new Float32Array(node.getTranslation())),
        }
        restCache.set(i, r)
      }
      return r
    }
    const loadBan = (path: string): BanAnimation | null => {
      const key = path.toLowerCase()
      let ban = banCache.get(key)
      if (ban === undefined) {
        try {
          ban = parseBan(read(path))
        } catch (e) {
          warnings.push(`animation ${path}: ${(e as Error).message}`)
          ban = null
        }
        banCache.set(key, ban)
      }
      return ban
    }
    const trackedCount = (ban: BanAnimation) =>
      ban.tracks.filter(t => jointIndexByName.has(t.boneName) && t.keyTimes.length > 0).length
    let maxTracked = 0
    for (const group of bsr.aniGroups) {
      for (const entry of group.animations) {
        const ban = entry.path ? loadBan(entry.path) : null
        if (ban) maxTracked = Math.max(maxTracked, trackedCount(ban))
      }
    }
    const usedNames = new Set<string>()
    // 'default' first so the plain type names belong to the default stance.
    const groups = [...bsr.aniGroups].sort((x, y) => Number(y.name === 'default') - Number(x.name === 'default'))
    let noClip = 0
    for (const group of groups) {
      for (const entry of group.animations) {
        if (!entry.path) {
          noClip++
          continue
        }
        const banKey = entry.path.toLowerCase()
        const ban = loadBan(entry.path)
        if (!ban) continue
        const trackedJoints = trackedCount(ban)
        const partial = trackedJoints < PARTIAL_CLIP_FRACTION * maxTracked
        const typeName = entry.typeName ?? `TYPE_0x${entry.type.toString(16)}`
        let name = typeName
        if (usedNames.has(name)) name = `${typeName}_${fileBase(entry.path)}`
        name = uniqueName(name, usedNames)
        const anim = doc.createAnimation(name)
        const byBone = new Map(ban.tracks.map(t => [t.boneName, t]))
        const invalidTracks: string[] = []
        bones.forEach((bone, i) => {
          const track = byBone.get(bone.name)
          let acc: { input: Accessor; rot: Accessor; pos: Accessor } | null = null
          if (track) {
            const key = `${banKey}|${bone.name}`
            acc = trackCache.get(key) ?? null
            if (!trackCache.has(key)) {
              const keys = convertTrack(track)
              if (keys) {
                acc = {
                  input: b.accessor('SCALAR', keys.times),
                  rot: b.accessor('VEC4', keys.rotations),
                  pos: b.accessor('VEC3', keys.translations),
                }
              }
              trackCache.set(key, acc)
            }
            if (!acc) invalidTracks.push(bone.name)
          } else if (partial) return
          acc ??= restFor(i)
          for (const [path, output] of [['rotation', acc.rot], ['translation', acc.pos]] as const) {
            const sampler = doc.createAnimationSampler().setInput(acc.input).setOutput(output).setInterpolation('LINEAR')
            anim.addSampler(sampler)
              .addChannel(doc.createAnimationChannel().setTargetNode(boneNodes[i]!).setTargetPath(path).setSampler(sampler))
          }
        })
        const skippedTracks = ban.tracks.filter(t => !jointIndexByName.has(t.boneName)).map(t => t.boneName)
        sidecarAnimations.push({
          name,
          group: group.name,
          type: entry.type,
          typeName,
          ban: entry.path,
          banName: ban.name,
          durationMs: ban.durationMs,
          fps: ban.fps,
          cyclic: ban.animationType === 1,
          keys: ban.keyTimes.length,
          walkLength: entry.walkLength,
          events: entry.eventsSorted.map(e => ({ timeMs: e.timeMs, type: e.type, p1: e.p1, p2: e.p2 })),
          ...(skippedTracks.length ? { skippedTracks } : {}),
          ...(invalidTracks.length ? { invalidTracks } : {}),
          trackedJoints,
          ...(partial ? { partial: true as const } : {}),
        })
      }
    }
    if (noClip) warnings.push(`${noClip} aniGroup entr${noClip === 1 ? 'y has' : 'ies have'} no clip (fileIndex -1)`)
  }

  // --- sidecar ----------------------------------------------------------------------------------------------------
  const empty = !Number.isFinite(min[0])
  const meshNameByIndex = (i: number) => {
    const p = bsr.meshes[i]?.path
    return p ? (sidecarMeshes.find(m => m.bms === p)?.name ?? fileBase(p)) : null
  }
  // Effects bound to the model (docs/EFFECTS.md §5.2): bone positions of static skeletons, mod-palette particles.
  let dummies: Record<string, [number, number, number]> | undefined
  if (bsk && !skin) {
    const bones = bsk.bones
    const locals = bones.map(bone => toGltfTransform(bone.toParent))
    const world: BskTransform[] = []
    const visit = (i: number): BskTransform => {
      if (world[i]) return world[i]!
      const p = bones[i]!.parentIndex
      world[i] = p >= 0 && p !== i ? rigidCompose(visit(p), locals[i]!) : locals[i]!
      return world[i]!
    }
    dummies = {}
    bones.forEach((bone, i) => (dummies![bone.name] = tidyVec(visit(i).translation as Vec3)))
  }
  const fx = modelParticles(bsr, options.particleExists)
  warnings.push(...fx.warnings)
  const sidecar: Sidecar = {
    source: bsrPath.replace(/\\/g, '/'),
    version: bsr.signature,
    generator: GENERATOR,
    name: bsr.name,
    type: bsr.typeName ?? String(bsr.type),
    units: {
      metresPerUnit: UNIT_SCALE,
      sourceUnit: 'decimetre',
      handedness: 'right-handed (Silkroad left-handed file space mirrored on Z)',
      up: '+Y',
      forward: '+Z',
    },
    skeleton: bsk && bsr.skeleton
      ? { bsk: bsr.skeleton.path, joints: skin ? bsk.bones.map(bone => bone.name) : [], bindCheck: bindCheck ?? { maxIdentityError: 0, maxHierarchyError: 0, staleToLocal: [] } }
      : null,
    ...(dummies ? { dummies } : {}),
    ...(fx.particles.length ? { particles: fx.particles } : {}),
    attachBone,
    attachable: bsr.attachable
      ? {
          kind: bsr.attachable.kind,
          attachPoint: bsr.attachable.attachPoint,
          attachPointName: bsr.attachable.attachPointName ?? null,
          attachMethod: bsr.attachable.attachMethod,
          attachMethodName: bsr.attachable.attachMethodName ?? null,
          slots: bsr.attachable.slots.map(s => ({ slot: s.slot, slotName: s.slotName ?? null, mesh: meshNameByIndex(s.meshIndex) })),
        }
      : null,
    materials: sidecarMaterials,
    meshes: sidecarMeshes,
    animations: sidecarAnimations,
    stats: {
      vertices,
      triangles,
      joints: skin ? skin.listJoints().length : 0,
      meshes: sidecarMeshes.length,
      animations: sidecarAnimations.length,
      textures: doc.getRoot().listTextures().length,
      heightM: empty ? 0 : max[1] - min[1],
      boundsMin: empty ? [0, 0, 0] : min,
      boundsMax: empty ? [0, 0, 0] : max,
    },
    warnings,
  }
  return { document: doc, sidecar }
}
