/**
 * BSK skeleton parser (JMXVBSK 0101).
 *
 * Specs: SilkroadDoc wiki JMXVBSK, openroad docs/formats/bsk-jmxvbsk.md (GPL, read as documentation only);
 * cross-checked with Lafa2K's MIT importer (parse_bsk, no code ported) and every .bsk in vSRO 1.188.
 *
 *   header  "JMXVBSK 0101" (12 bytes)
 *   u32     boneCount
 *   bone    u8 type (0 CPrimBone, 1 CPrimDummy), lpString name, lpString parentName ('' for a root),
 *           3 x { f32 rotation[4] (x, y, z, w), f32 translation[3] }: toParent, toOrigin, toLocal,
 *           u32 childCount, lpString childNames[childCount]
 *   footer  u32 unknown0, u32 unknown1 (0 in every client file); nothing follows.
 * "BSK " (one file, prim/skel/item/common/mob_select.bsk): 4-byte magic, u32 version (101), then the same body,
 *   except that every non-empty string is followed by one NUL byte (not counted in its length).
 *
 * Conventions, measured on all 808 client skeletons (22,820 bones; packages/convert/test/bsk.corpus.test.ts):
 * - Rotations are unit quaternions stored x, y, z, w (max ||q| - 1| = 7.8e-8). A transform T maps a point from
 *   the bone's space to the named space: T(p) = rotate(q, p) + t.
 * - toOrigin (bone -> model space) = rigidCompose(parent.toOrigin, toParent): column-vector P * L, Direct3D
 *   row-vector L * P, quaternion qParent * qLocal (Hamilton). Roots: toOrigin = toParent. 94.9% of bones match
 *   to <= 2.7e-7 rad / 9.6e-5 relative translation; every alternative order or reading matches < 0.5%.
 * - toLocal (model -> bone space, the inverse bind pose) = rigidInverse(toOrigin) for 97.2% of bones.
 * - The rest are stale caches: 394 inserted "Spine_Base" bones keep an identity toOrigin (their toLocal is right),
 *   ~580 weapon/prop bones (Bone02, ai_start, ai_end, ...) disagree with toParent by >= 3e-4 (relative), and the
 *   synthetic "[root]" super-roots hold garbage translations. toParent is the authoritative bind pose;
 *   bskWorldTransforms() recomputes model space from it.
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'
import { rigidCompose, type RigidTransform } from './math.ts'

export * as bskMath from './math.ts'

export type BskTransform = RigidTransform

export const BSK_BONE_TYPE_BONE = 0
export const BSK_BONE_TYPE_DUMMY = 1

export interface BskBone {
  /** 0 = CPrimBone, 1 = CPrimDummy; kept raw. */
  type: number
  name: string
  /** '' for a root, as stored. */
  parentName: string
  /** Index into `bones`, -1 when parentName is '' or names no bone in this file. */
  parentIndex: number
  /** As stored. A synthetic '[root]' bone (51 files) lists the real roots here, which keep parentName ''. */
  childNames: string[]
  /** Index of each child name in `bones`, -1 when it names no bone in this file. */
  childIndices: number[]
  /** Bind pose relative to the parent bone (bone space -> parent space). */
  toParent: BskTransform
  /** Bind pose relative to the skeleton origin (bone space -> model space); a cache of the toParent chain. */
  toOrigin: BskTransform
  /** Model space -> bone space (inverse bind pose); a cache of inverse(toOrigin). */
  toLocal: BskTransform
}

export interface BskSkeleton {
  /** 'JMXVBSK 0101', or 'BSK ' for the legacy header. */
  signature: string
  /** 101 for both header forms. */
  version: number
  bones: BskBone[]
  unknown0: number
  unknown1: number
}

const JMXV_SIGNATURE = 'JMXVBSK '
const LEGACY_SIGNATURE = 'BSK '
const SUPPORTED_VERSION = 101
/** Smallest bone record: type + two empty strings + 3 transforms + child count. */
const MIN_BONE_SIZE = 1 + 4 + 4 + 3 * 28 + 4

function fail(r: BinaryReader, what: string): never {
  throw new Error(`BSK: ${what} at offset ${r.offset}`)
}

function need(r: BinaryReader, count: number, what: string): void {
  if (r.remaining < count) fail(r, `truncated ${what} (need ${count} bytes, ${r.remaining} left)`)
}

/** Legacy files also write a NUL after each non-empty string (not counted in the length). */
function readString(r: BinaryReader, what: string, legacy: boolean): string {
  need(r, 4, `${what} length`)
  const len = r.view.getUint32(r.offset, true)
  if (len + (legacy && len > 0 ? 1 : 0) > r.remaining - 4) fail(r, `${what} length ${len} overruns file`)
  const s = r.lpString(eucKr)
  if (legacy && len > 0 && r.u8() !== 0) fail(r, `${what} missing NUL terminator`)
  return s
}

function readTransform(r: BinaryReader, what: string): BskTransform {
  need(r, 28, what)
  const rotation: BskTransform['rotation'] = [r.f32(), r.f32(), r.f32(), r.f32()]
  const translation: BskTransform['translation'] = [r.f32(), r.f32(), r.f32()]
  return { rotation, translation }
}

function readHeader(r: BinaryReader): { signature: string; version: number } {
  need(r, 8, 'header')
  if (latin1.decode(r.bytes.subarray(0, 4)) === LEGACY_SIGNATURE) {
    const version = r.view.getUint32(4, true)
    if (version !== SUPPORTED_VERSION) fail(r.seek(4), `unsupported "BSK " version ${version}`)
    r.seek(8)
    return { signature: LEGACY_SIGNATURE, version }
  }
  need(r, 12, 'header')
  const signature = latin1.decode(r.bytes.subarray(0, 12))
  if (!signature.startsWith(JMXV_SIGNATURE)) fail(r, `bad signature ${JSON.stringify(signature)}`)
  const version = Number(signature.slice(JMXV_SIGNATURE.length))
  if (version !== SUPPORTED_VERSION) fail(r, `unsupported version ${JSON.stringify(signature)}`)
  r.seek(12)
  return { signature, version }
}

export function parseBsk(bytes: Uint8Array): BskSkeleton {
  const r = new BinaryReader(bytes)
  const { signature, version } = readHeader(r)
  const legacy = signature === LEGACY_SIGNATURE
  need(r, 4, 'bone count')
  const boneCount = r.u32()
  if (boneCount * MIN_BONE_SIZE > r.remaining) fail(r, `bone count ${boneCount} does not fit in file`)

  const bones: BskBone[] = []
  for (let i = 0; i < boneCount; i++) {
    need(r, 1, `bone ${i} type`)
    const type = r.u8()
    const name = readString(r, `bone ${i} name`, legacy)
    const parentName = readString(r, `bone ${i} parent name`, legacy)
    const toParent = readTransform(r, `bone ${i} toParent`)
    const toOrigin = readTransform(r, `bone ${i} toOrigin`)
    const toLocal = readTransform(r, `bone ${i} toLocal`)
    need(r, 4, `bone ${i} child count`)
    const childCount = r.u32()
    if (childCount * 4 > r.remaining) fail(r, `bone ${i} child count ${childCount} overruns file`)
    const childNames: string[] = []
    for (let c = 0; c < childCount; c++) childNames.push(readString(r, `bone ${i} child ${c} name`, legacy))
    bones.push({ type, name, parentName, parentIndex: -1, childNames, childIndices: [], toParent, toOrigin, toLocal })
  }
  need(r, 8, 'footer')
  const unknown0 = r.u32()
  const unknown1 = r.u32()
  if (r.remaining !== 0) fail(r, `${r.remaining} unexpected trailing bytes`)

  const indexByName = new Map<string, number>()
  bones.forEach((bone, i) => {
    if (!indexByName.has(bone.name)) indexByName.set(bone.name, i)
  })
  for (const bone of bones) {
    bone.parentIndex = bone.parentName === '' ? -1 : (indexByName.get(bone.parentName) ?? -1)
    bone.childIndices = bone.childNames.map(n => indexByName.get(n) ?? -1)
  }
  return { signature, version, bones, unknown0, unknown1 }
}

/**
 * Bone -> model space for every bone, recomputed from toParent (the authoritative bind pose) by walking
 * parents: world = rigidCompose(parentWorld, toParent). Throws on a parent cycle.
 */
export function bskWorldTransforms(skeleton: BskSkeleton): BskTransform[] {
  const { bones } = skeleton
  const world: Array<BskTransform | undefined> = new Array(bones.length)
  const state = new Uint8Array(bones.length) // 0 todo, 1 in progress, 2 done
  const visit = (i: number): BskTransform => {
    if (state[i] === 2) return world[i]!
    if (state[i] === 1) throw new Error(`BSK: parent cycle through bone ${JSON.stringify(bones[i]!.name)}`)
    state[i] = 1
    const bone = bones[i]!
    const local = bone.toParent
    const t: BskTransform =
      bone.parentIndex < 0
        ? { rotation: [...local.rotation], translation: [...local.translation] }
        : rigidCompose(visit(bone.parentIndex), local)
    world[i] = t
    state[i] = 2
    return t
  }
  return bones.map((_, i) => visit(i))
}
