/**
 * BSR resource parser (JMXVRES 0109, plus the legacy 0108 and 0107 layouts).
 *
 * Specs: SilkroadDoc wiki JMXVRES, ModData and ResourceAnimationType; openroad
 * docs/formats/bsr-jmxvres.md (read as documentation only); Lafa2K importer parse_bsr (MIT).
 * ModData payloads, ResAttachable and the object/slot enums follow JMX-File-Editor
 * (MIT, (c) 2021 Engels Quintero, github.com/JellyBitz/JMX-File-Editor, Silkroad/Data/JMXVRES),
 * ported with attribution. Every layout below was checked against the vSRO 1.188 bytes.
 *
 *   signature  "JMXVRES 0109" (12 bytes)
 *   header     13 x u32: offsets of material, mesh, skeleton, animation, primMeshGroup,
 *              primAniGroup, modPalette and collision; primMeshFlag, modDataFlag, 3 x reserved
 *   objInfo    u16 type, u16 category, lpString name, u32 unknown0, u32 unknown1, 40 reserved bytes
 *   collision  lpString mesh (.bms), 2 x AABB (f32 min[3], max[3]), u32 hasMatrix, [f32[16]]
 *   material   u32 count, { u32 id (0..4, the TextureType), lpString path (.bmt) }
 *   mesh       u32 count, { lpString path (.bms), u32 flag if primMeshFlag & 1 }
 *   animation  u32 typeVersion (0x1000), u32 userDefine (0), u32 count, lpString path (.ban)
 *   skeleton   u32 hasSkeleton, [lpString path (.bsk), lpString attachBone]
 *   meshGroup  u32 count, { lpString name, u32 count, u32 meshIndex }
 *   aniGroup   u32 count, { lpString name, u32 count, { u32 type, i32 fileIndex (-1 = none),
 *              u32 eventCount, { u32 timeMs, u32 type, i32 p1, i32 p2 }, u32 walkPointCount,
 *              f32 walkLength, f32[2] walkPoint } }
 *   palette    u32 count, systemSet; u32 count, aniSet. Set: u32 type, i32 animationType, lpString
 *              name, u32 count, { u32 tag, IModData (f32, 5 x i32, 4 bytes), payload by tag }
 *   attachable (Character and Item always; some NPCs) i32 kind, i32 attachPoint, u32 attachMethod,
 *              u32 count, { u32 slot, u32 meshIndex }, u32 comboNum (all but Item, when present)
 *
 * Legacy layouts, taken from the only four legacy files of this client:
 *   0108  collision holds ONE bounding box; the material section is a single lpString path
 *         (no count, no id). The rest is 0109.
 *   0107  as 0108, and: every animation-list entry carries its own events + walk graph,
 *         aniGroup entries are just { u32 type, i32 fileIndex }, and the palette is a single
 *         list of sets holding only { name, mods } (no set type, animation type or ani list).
 *         Only res/npc/npc/tt.bsr uses it; see `legacyTimelines`. Its bytes also fit "empty ani
 *         list + attachable without kind"; this reading keeps the attachable identical to 0108/0109.
 * All 5,563 .bsr files of vSRO 1.188 parse to EOF (packages/convert/test/bsr.corpus.test.ts).
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'

export const BSR_SIGNATURE_PREFIX = 'JMXVRES '
export const BSR_SUPPORTED_VERSIONS: readonly number[] = [107, 108, 109]

// ObjectGeneralType / ObjectGeneralCategory (JMX-File-Editor, MIT).
export const BSR_OBJECT_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'CHARACTER',
  1: 'NPC',
  2: 'BUILDING',
  3: 'ARTIFACT',
  4: 'NATURE',
  5: 'ITEM',
  6: 'OTHER',
  7: 'SIMPLE',
}
export const BSR_OBJECT_TYPE_CHARACTER = 0
export const BSR_OBJECT_TYPE_ITEM = 5

export const BSR_OBJECT_CATEGORY_NAMES: Readonly<Record<number, string>> = {
  0: 'NONE',
  1: 'PRIMITIVE',
  2: 'RESOURCE',
  3: 'COMPOUND',
  4: 'DUNGEON',
}

/** SilkroadDoc ResourceAnimationType, plus 0x08 (commented out there, OBSOLETE_STAND2 in JMX-File-Editor). */
export const RESOURCE_ANIMATION_TYPE_NAMES: Readonly<Record<number, string>> = (() => {
  const t: Record<number, string> = {
    0x3c: 'POSE', 0x00: 'STAND1', 0x08: 'OBSOLETE_STAND2', 0x7a: 'STAND2', 0x3d: 'STAND3', 0x51: 'STAND4',
    0x06: 'ATTREADY', 0x18: 'TURN_L', 0x19: 'TURN_R', 0x0d: 'SIT_DOWN', 0x0e: 'SIT', 0x0f: 'STAND_UP',
    0x16: 'DEFENCE', 0x01: 'WALK', 0x17: 'WALK_BACK', 0x07: 'RUN',
    0x02: 'ATTACK1', 0x05: 'ATTACK2', 0x10: 'ATTACK3', 0x11: 'ATTACK4', 0xb7: 'ATTACK5', 0xb8: 'ATTACK6',
    0xb9: 'ATTACK7', 0xba: 'ATTACK8', 0xbe: 'ATTACK9', 0xc0: 'ATTACK10', 0xc1: 'ATTACK11', 0xc2: 'ATTACK12',
    0xc3: 'ATTACK13', 0xc4: 'ATTACK14', 0xc5: 'ATTACK15', 0xc6: 'ATTACK16', 0x27: 'REVOLUTION',
    0x28: 'READY01', 0x29: 'READY02', 0x2a: 'READY03', 0x2b: 'READY04', 0x2c: 'READY05',
    0x5b: 'WAIT01', 0x5c: 'WAIT02', 0x5d: 'WAIT03', 0x5e: 'WAIT04', 0x5f: 'WAIT05',
    0xbb: 'HAMMER', 0xbc: 'HANDLOOF', 0xbd: 'TROW', 0x13: 'MG_SSELF', 0x14: 'MG_SOTHER',
    0x03: 'DAMAGE1', 0x09: 'DAMAGE2', 0x43: 'HELP', 0x4e: 'FIND', 0x4f: 'STUN',
    0x04: 'DIE1', 0x24: 'DIE1_RM', 0x12: 'DIE2', 0x25: 'DIE2_RM', 0x79: 'REVIVAL',
    0x3e: 'DOWN', 0x3f: 'DOWN_RM', 0x40: 'DOWN_DAMAGE', 0x41: 'DOWN_UP', 0x42: 'DOWN_DIE',
    0x26: 'PICK', 0x0a: 'CLICK', 0x0b: 'CB_YEONHWAN', 0x0c: 'CB_2', 0x15: 'ET_BYE',
    0x50: 'VENDOR01', 0xbf: 'SHOT',
  }
  // SKILL_1..100 and EMOTION01..10 occupy these contiguous runs.
  const runs: Array<[first: number, start: number, end: number]> = [
    [1, 0x1a, 0x23], [11, 0x44, 0x4d], [21, 0x65, 0x78], [41, 0x7b, 0xb6],
  ]
  for (const [first, start, end] of runs) {
    for (let v = start; v <= end; v++) t[v] = `SKILL_${first + v - start}`
  }
  for (let i = 0; i < 10; i++) t[0x32 + i] = `EMOTION${String(i + 1).padStart(2, '0')}`
  return t
})()

export function resourceAnimationTypeName(type: number): string | undefined {
  return RESOURCE_ANIMATION_TYPE_NAMES[type]
}

/** ModDataType tags: `type << 16 | variant`. */
export const BSR_MOD_DATA_TYPE = {
  mtrl: 0x00000000,
  texAni: 0x00010000,
  multiTex: 0x00010001,
  multiTexRev: 0x00010002,
  particle: 0x00030000,
  envMap: 0x00040000,
  bumpEnv: 0x00040001,
  sound: 0x00050000,
  dyVertex: 0x00060000,
  dyJoint: 0x00060001,
  dyLattice: 0x00060002,
  progEquipPow: 0x00070000,
} as const
export type BsrModDataKind = keyof typeof BSR_MOD_DATA_TYPE

const MOD_KIND_BY_TAG = new Map<number, BsrModDataKind>(
  Object.entries(BSR_MOD_DATA_TYPE).map(([k, v]) => [v, k as BsrModDataKind]),
)

/** CModDataSet type (SilkroadDoc). */
export const BSR_MOD_SET_TYPE_NAMES: Readonly<Record<number, string>> = { 0: 'LOCOMOTION', 1: 'SIMPLE', 2: 'AMBIENT' }
/** ResAttachable kind (first u32). -1 and 2 also occur and have no known name. */
export const BSR_ATTACH_KIND_NAMES: Readonly<Record<number, string>> = { 0: 'CHAR', 1: 'ITEM' }
export const BSR_ATTACH_METHOD_NAMES: Readonly<Record<number, string>> = { 0: 'BASE', 1: 'REPLACE', 2: 'ADD' }
/** ResAttachable attach point (second u32, SilkroadDoc). */
export const BSR_ATTACH_POINT_NAMES: Readonly<Record<number, string>> = {
  [-1]: 'NONE', 0: '_ha', 1: '_ba', 2: '_la', 3: '_fa', 4: '_sa', 5: '_aa',
  6: 'LEFT_HAND', 7: 'RIGHT_HAND', 13: 'CHAR', 16: 'ATTACH',
}
export const BSR_SLOT_NAMES: Readonly<Record<number, string>> = {
  0: 'HAIR', 1: 'FACE', 2: 'TORSO_UPPER', 3: 'TORSO_LOWER', 4: 'OVERRIDE', 5: 'ARM_UPPER', 6: 'ARM_LOWER',
  7: 'LEFT_HAND', 9: 'RIGHT_HAND', 10: 'SPEAR', 11: 'PELVIS', 12: 'THIGH', 13: 'CALF', 14: 'ATTACH_CAPE',
}

export type BsrVec2 = [number, number]
export type BsrVec3 = [number, number, number]

export interface BsrHeader {
  materialOffset: number
  meshOffset: number
  skeletonOffset: number
  animationOffset: number
  primMeshGroupOffset: number
  primAniGroupOffset: number
  modPaletteOffset: number
  collisionOffset: number
  /** Bit 0: every mesh entry carries an extra u32 (`BsrMesh.flag`). */
  primMeshFlag: number
  modDataFlag: number
  /** header.Int2..Int4, 0 in every file of this client. */
  reserved: [number, number, number]
}

export interface BsrBoundingBox {
  min: BsrVec3
  max: BsrVec3
}

export interface BsrCollision {
  /** Collision .bms path, '' for none. */
  meshPath: string
  /** Two boxes in 0109, one in 0107/0108. Raw file-space values. */
  boundingBoxes: BsrBoundingBox[]
  /** Raw requireCollisionMatrix u32. */
  hasMatrix: number
  /** 16 floats in stored (row-major D3D) order, or null. */
  matrix: number[] | null
}

export interface BsrMaterialSet {
  /** 0..4, selected by _RefObjChar.TextureType; null for 0107/0108 (single, id-less path). */
  id: number | null
  /** .bmt path as stored (backslashes, relative to Data.pk2). */
  path: string
}

export interface BsrMesh {
  /** .bms path as stored. */
  path: string
  /** The extra per-mesh u32 present when header.primMeshFlag & 1, else null. */
  flag: number | null
}

export interface BsrSkeleton {
  /** Raw hasSkeleton u32 (non-zero). */
  hasSkeleton: number
  /** .bsk path as stored. */
  path: string
  /** Bone of the parent skeleton this resource attaches to ('' for none), e.g. 'Bip01 R HandMid'. */
  attachBone: string
}

export interface BsrMeshGroup {
  name: string
  meshIndices: number[]
}

export interface BsrAnimEvent {
  timeMs: number
  /** 1 = hit, 2 = footstep; 4 also occurs. */
  type: number
  p1: number
  p2: number
}

export interface BsrAnimTimeline {
  /** Exactly as stored. */
  events: BsrAnimEvent[]
  /** Copy of `events`, stable-sorted by timeMs. */
  eventsSorted: BsrAnimEvent[]
  /** Distance covered per loop; non-zero only on locomotion types (WALK, RUN, WALK_BACK, ...). */
  walkLength: number
  /** Stored Vector2 points; (0,0),(1,1) on non-locomotion entries. */
  walkGraph: BsrVec2[]
}

export interface BsrAnimation extends BsrAnimTimeline {
  /** ResourceAnimationType, raw. */
  type: number
  typeName: string | undefined
  /** Index into `animationPaths`; -1 = no clip. */
  fileIndex: number
  /** animationPaths[fileIndex], or null when the index is -1 / out of range. */
  path: string | null
}

export interface BsrAniGroup {
  /** Stance selector: 'default', 'spear', 'bow', 'cart', ... */
  name: string
  animations: BsrAnimation[]
}

/** Generic IModData header that follows every tag. */
export interface BsrModDataBase {
  kind: BsrModDataKind
  tag: number
  /** File offset of the tag. */
  offset: number
  /** 0.5 almost everywhere; for Particle it scales the spawned effect (openroad). */
  float0: number
  int0: number
  int1: number
  /** JMXVBMT material index, -1 = every material. */
  mtrlIndex: number
  int3: number
  int4: number
  bytes: [number, number, number, number]
}

export interface BsrColorKey {
  timeMs: number
  /** Color4 as stored (r, g, b, a). */
  color: [number, number, number, number]
}

export interface BsrModDataMtrl extends BsrModDataBase {
  kind: 'mtrl'
  durationMs: number
  /** Bit 2 (4): a curve key list follows the gradient. */
  flag: number
  unknown0: number
  gradientKeys: BsrColorKey[]
  curveKeys: Array<{ timeMs: number; value: number }> | null
  unknown1: [number, number, number, number]
  /** D3D render-state bytes: [0] SRCBLEND, [1] DESTBLEND, [2..7] texture-stage values,
   * [8] ALPHAREF, [9] ALPHAFUNC (D3DCMP), [10..11] constants (openroad). */
  renderStates: number[]
  unknownFloat: number
  unknown2: number
}

export interface BsrModDataTexAni extends BsrModDataBase {
  kind: 'texAni'
  /** UnkUInt06..10; [0] = 1 when the transform drives the MultiTex stage (openroad). */
  unknown: [number, number, number, number, number]
  /** Per-second D3D texture transform, 16 floats as stored (row-major; [8],[9] = U/V scroll). */
  matrix: number[]
}

export interface BsrModDataMultiTex extends BsrModDataBase {
  kind: 'multiTex' | 'multiTexRev'
  unknown0: number
  /** .ddj path. */
  texture: string
  unknown1: number
}

export interface BsrParticle {
  /** IsEnabled (JMX-File-Editor) / IsRelativeToOrigin (SilkroadDoc); raw u32. */
  flag: number
  /** .efp path. */
  path: string
  /** Anchor bone, '' for the resource origin. */
  bone: string
  position: BsrVec3
  birthTimeMs: number
  /** [1] = 1: night only. [3] = 1: `extraVector` follows. */
  bytes: [number, number, number, number]
  extraVector: BsrVec3 | null
}

export interface BsrModDataParticle extends BsrModDataBase {
  kind: 'particle'
  particles: BsrParticle[]
}

export interface BsrModDataEnvMap extends BsrModDataBase {
  kind: 'envMap'
  unknown: [number, number, number, number]
}

export interface BsrModDataBumpEnv extends BsrModDataBase {
  kind: 'bumpEnv'
  /** The ModDataEnvMap part. */
  unknown: [number, number, number, number]
  floats: [number, number, number, number, number, number]
  /** .ddj paths; null where the has-value byte is 0. */
  textures: Array<string | null>
}

export interface BsrSoundConfig {
  /** DSBCAPS-style flags. */
  flags: number
  int6: number
  int7: number
  float0: number
  float1: number
  int8: number
  int9: number
  int10: number
  int11: number
  int12: number
  int13: number
}

export interface BsrSoundTrack {
  /** .wav path as stored (some carry a stray 'sound\' prefix). */
  path: string
  keyTimeMs: number
  event: string
}

export interface BsrSoundSet {
  name: string
  /** One slot per stored track; null where hasValue is 0. */
  tracks: Array<BsrSoundTrack | null>
}

export interface BsrModDataSound extends BsrModDataBase {
  kind: 'sound'
  /** Raw nSndSetNum (i32); config and sets are only present when > 0. */
  setCount: number
  config: BsrSoundConfig | null
  sets: BsrSoundSet[]
}

export interface BsrModDataEmpty extends BsrModDataBase {
  kind: 'dyVertex' | 'dyJoint' | 'dyLattice' | 'progEquipPow'
}

export type BsrModData =
  | BsrModDataMtrl
  | BsrModDataTexAni
  | BsrModDataMultiTex
  | BsrModDataParticle
  | BsrModDataEnvMap
  | BsrModDataBumpEnv
  | BsrModDataSound
  | BsrModDataEmpty

export interface BsrModDataSet {
  /** 0 LOCOMOTION, 1 SIMPLE, 2 AMBIENT; null in 0107. */
  type: number | null
  typeName: string | undefined
  /** ResourceAnimationType the set is bound to, -1 = none; null in 0107. */
  animationType: number | null
  animationTypeName: string | undefined
  /** 'ambient', a status/effect name, or the aniGroup name for animation-linked sets. */
  name: string
  mods: BsrModData[]
}

export interface BsrModPalette {
  /** System sets (0107: the single set list). */
  systemSets: BsrModDataSet[]
  /** Animation-linked sets ([] in 0107). */
  aniSets: BsrModDataSet[]
}

export interface BsrAttachSlot {
  slot: number
  slotName: string | undefined
  meshIndex: number
}

export interface BsrAttachable {
  /** 0 = CHAR, 1 = ITEM; -1 and 2 also occur. */
  kind: number
  /** -1 none, 0 _ha .. 5 _aa, 6 left hand, 7 right hand, 13 char, 16 attach. */
  attachPoint: number
  attachPointName: string | undefined
  /** 0 BASE, 1 REPLACE, 2 ADD. */
  attachMethod: number
  attachMethodName: string | undefined
  slots: BsrAttachSlot[]
  /** nComboNum (0 in every file); present for Character and NPC resources, null for Item. */
  comboNum: number | null
}

export interface BsrResource {
  /** 'JMXVRES 0109' */
  signature: string
  /** 109, 108 or 107 */
  version: number
  header: BsrHeader
  /** ObjectGeneralType: 0 CHARACTER, 1 NPC, 2 BUILDING, 3 ARTIFACT, 4 NATURE, 5 ITEM, 6 OTHER. */
  type: number
  typeName: string | undefined
  /** ObjectGeneralCategory (2 = RESOURCE in every file). */
  category: number
  categoryName: string | undefined
  name: string
  /** objInfo.unkUInt0 / unkUInt1. */
  objectInfoUnknown: [number, number]
  /** The 40 reserved bytes after objInfo. */
  reserved: Uint8Array
  collision: BsrCollision
  materials: BsrMaterialSet[]
  meshes: BsrMesh[]
  /** ANIMATION_TOOL_VERSION, 0x1000. */
  animationTypeVersion: number
  animationTypeUserDefine: number
  /** CPrimAnimation list (.ban paths as stored); aniGroup entries index into it. */
  animationPaths: string[]
  /** 0107 only: the per-file events/walk graph stored next to each animation path. */
  legacyTimelines: BsrAnimTimeline[] | null
  skeleton: BsrSkeleton | null
  meshGroups: BsrMeshGroup[]
  aniGroups: BsrAniGroup[]
  modPalette: BsrModPalette
  attachable: BsrAttachable | null
  /** Bytes after the last known structure; empty in every file of this client. */
  trailing: Uint8Array
}

function fail(message: string, offset: number): never {
  throw new Error(`BSR: ${message} at offset ${offset}`)
}

function str(r: BinaryReader): string {
  const at = r.offset
  const len = r.u32()
  if (len > r.remaining) fail(`string length ${len} exceeds the ${r.remaining} remaining bytes`, at)
  return eucKr.decode(r.bytesView(len))
}

/** u32 element count, bounded by what the remaining bytes could possibly hold. */
function count(r: BinaryReader, minItemSize: number, what: string): number {
  const at = r.offset
  const n = r.u32()
  if (n * minItemSize > r.remaining) fail(`${what} count ${n} cannot fit in the ${r.remaining} remaining bytes`, at)
  return n
}

function vec2(r: BinaryReader): BsrVec2 {
  return [r.f32(), r.f32()]
}

function vec3(r: BinaryReader): BsrVec3 {
  return [r.f32(), r.f32(), r.f32()]
}

function floats(r: BinaryReader, n: number): number[] {
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) out[i] = r.f32()
  return out
}

function seekSection(r: BinaryReader, offset: number, what: string): void {
  if (offset < 12 || offset > r.length) fail(`${what} section offset ${offset} outside file of ${r.length} bytes`, 12)
  r.seek(offset)
}

/**
 * The client seeks to each section, so a wrong field size inside one section would go unnoticed.
 * Require every section (and objInfo) to end exactly where the next one in file order begins; the
 * last section runs on into the attachable and is checked by `trailing` instead.
 */
function endSection(r: BinaryReader, starts: readonly number[], start: number, what: string): void {
  let next = r.length
  for (const s of starts) if (s > start && s < next) next = s
  if (next !== r.length && r.offset !== next) {
    fail(`${what} section ends at ${r.offset} but the next section starts at ${next}`, start)
  }
}

function sortEvents(events: BsrAnimEvent[]): BsrAnimEvent[] {
  return events.map(e => ({ ...e })).sort((a, b) => a.timeMs - b.timeMs)
}

function readTimeline(r: BinaryReader): BsrAnimTimeline {
  const eventCount = count(r, 16, 'animation event')
  const events: BsrAnimEvent[] = []
  for (let i = 0; i < eventCount; i++) {
    events.push({ timeMs: r.u32(), type: r.u32(), p1: r.i32(), p2: r.i32() })
  }
  const walkCount = count(r, 8, 'walk graph point')
  const walkLength = r.f32()
  const walkGraph: BsrVec2[] = []
  for (let i = 0; i < walkCount; i++) walkGraph.push(vec2(r))
  return { events, eventsSorted: sortEvents(events), walkLength, walkGraph }
}

function emptyTimeline(): BsrAnimTimeline {
  return { events: [], eventsSorted: [], walkLength: 0, walkGraph: [] }
}

function readModData(r: BinaryReader): BsrModData {
  const offset = r.offset
  const tag = r.u32()
  const kind = MOD_KIND_BY_TAG.get(tag)
  if (kind === undefined) fail(`unknown ModData tag 0x${tag.toString(16).padStart(8, '0')}`, offset)
  const base = {
    tag,
    offset,
    float0: r.f32(),
    int0: r.i32(),
    int1: r.i32(),
    mtrlIndex: r.i32(),
    int3: r.i32(),
    int4: r.i32(),
    bytes: [r.u8(), r.u8(), r.u8(), r.u8()] as [number, number, number, number],
  }
  switch (kind) {
    case 'mtrl': {
      const durationMs = r.u32()
      const flag = r.u32()
      const unknown0 = r.u32()
      const gradientKeys: BsrColorKey[] = []
      const gradientCount = count(r, 20, 'gradient key')
      for (let i = 0; i < gradientCount; i++) {
        gradientKeys.push({ timeMs: r.u32(), color: [r.f32(), r.f32(), r.f32(), r.f32()] })
      }
      let curveKeys: Array<{ timeMs: number; value: number }> | null = null
      if (flag & 4) {
        curveKeys = []
        const curveCount = count(r, 8, 'curve key')
        for (let i = 0; i < curveCount; i++) curveKeys.push({ timeMs: r.u32(), value: r.f32() })
      }
      const unknown1: [number, number, number, number] = [r.u32(), r.u32(), r.u32(), r.u32()]
      const renderStates = Array.from(r.bytesView(12))
      return { ...base, kind, durationMs, flag, unknown0, gradientKeys, curveKeys, unknown1, renderStates, unknownFloat: r.f32(), unknown2: r.u32() }
    }
    case 'texAni': {
      const unknown: [number, number, number, number, number] = [r.u32(), r.u32(), r.u32(), r.u32(), r.u32()]
      return { ...base, kind, unknown, matrix: floats(r, 16) }
    }
    case 'multiTex':
    case 'multiTexRev':
      return { ...base, kind, unknown0: r.u32(), texture: str(r), unknown1: r.u32() }
    case 'particle': {
      const particles: BsrParticle[] = []
      const n = count(r, 32, 'particle')
      for (let i = 0; i < n; i++) {
        const flag = r.u32()
        const path = str(r)
        const bone = str(r)
        const position = vec3(r)
        const birthTimeMs = r.u32()
        const bytes: [number, number, number, number] = [r.u8(), r.u8(), r.u8(), r.u8()]
        const extraVector = bytes[3] === 1 ? vec3(r) : null
        particles.push({ flag, path, bone, position, birthTimeMs, bytes, extraVector })
      }
      return { ...base, kind, particles }
    }
    case 'envMap':
      return { ...base, kind, unknown: [r.u32(), r.u32(), r.u32(), r.u32()] }
    case 'bumpEnv': {
      const unknown: [number, number, number, number] = [r.u32(), r.u32(), r.u32(), r.u32()]
      const f: [number, number, number, number, number, number] = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()]
      const textures: Array<string | null> = []
      const n = count(r, 1, 'bump texture')
      for (let i = 0; i < n; i++) textures.push(r.u8() !== 0 ? str(r) : null)
      return { ...base, kind, unknown, floats: f, textures }
    }
    case 'sound': {
      const setCount = r.i32()
      if (setCount <= 0) return { ...base, kind, setCount, config: null, sets: [] }
      const config: BsrSoundConfig = {
        flags: r.u32(), int6: r.i32(), int7: r.i32(), float0: r.f32(), float1: r.f32(), int8: r.i32(),
        int9: r.i32(), int10: r.i32(), int11: r.i32(), int12: r.i32(), int13: r.i32(),
      }
      if (setCount * 8 > r.remaining) fail(`sound set count ${setCount} cannot fit`, offset + 32)
      const sets: BsrSoundSet[] = []
      for (let i = 0; i < setCount; i++) {
        const name = str(r)
        const trackCount = count(r, 4, 'sound track')
        const tracks: Array<BsrSoundTrack | null> = []
        for (let j = 0; j < trackCount; j++) {
          if (r.u32() === 0) {
            tracks.push(null)
            continue
          }
          tracks.push({ path: str(r), keyTimeMs: r.i32(), event: str(r) })
        }
        sets.push({ name, tracks })
      }
      return { ...base, kind, setCount, config, sets }
    }
    case 'dyVertex':
    case 'dyJoint':
    case 'dyLattice':
    case 'progEquipPow':
      return { ...base, kind }
  }
}

function readModSets(r: BinaryReader, typed: boolean): BsrModDataSet[] {
  const sets: BsrModDataSet[] = []
  const n = count(r, typed ? 16 : 8, 'mod set')
  for (let i = 0; i < n; i++) {
    const type = typed ? r.u32() : null
    const animationType = typed ? r.i32() : null
    const name = str(r)
    const modCount = count(r, 32, 'mod data')
    const mods: BsrModData[] = []
    for (let j = 0; j < modCount; j++) mods.push(readModData(r))
    sets.push({
      type,
      typeName: type === null ? undefined : BSR_MOD_SET_TYPE_NAMES[type],
      animationType,
      animationTypeName: animationType === null ? undefined : RESOURCE_ANIMATION_TYPE_NAMES[animationType],
      name,
      mods,
    })
  }
  return sets
}

function parse(r: BinaryReader): BsrResource {
  if (r.length < 12 + 52) fail(`file of ${r.length} bytes is too short`, 0)
  const signature = r.fixedString(12, latin1)
  if (!signature.startsWith(BSR_SIGNATURE_PREFIX)) fail(`bad signature ${JSON.stringify(signature)}`, 0)
  const version = /^\d{4}$/.test(signature.slice(8)) ? Number(signature.slice(8)) : Number.NaN
  if (!BSR_SUPPORTED_VERSIONS.includes(version)) fail(`unsupported version ${JSON.stringify(signature)}`, 8)

  const header: BsrHeader = {
    materialOffset: r.u32(),
    meshOffset: r.u32(),
    skeletonOffset: r.u32(),
    animationOffset: r.u32(),
    primMeshGroupOffset: r.u32(),
    primAniGroupOffset: r.u32(),
    modPaletteOffset: r.u32(),
    collisionOffset: r.u32(),
    primMeshFlag: r.u32(),
    modDataFlag: r.u32(),
    reserved: [r.u32(), r.u32(), r.u32()],
  }

  const type = r.u16()
  const category = r.u16()
  const name = str(r)
  const objectInfoUnknown: [number, number] = [r.u32(), r.u32()]
  const reserved = r.bytesView(40).slice()
  const starts = [
    header.materialOffset, header.meshOffset, header.skeletonOffset, header.animationOffset,
    header.primMeshGroupOffset, header.primAniGroupOffset, header.modPaletteOffset, header.collisionOffset,
  ]
  endSection(r, starts, 12, 'objInfo')

  seekSection(r, header.collisionOffset, 'collision')
  const meshPath = str(r)
  const boundingBoxes: BsrBoundingBox[] = []
  for (let i = version >= 109 ? 2 : 1; i > 0; i--) boundingBoxes.push({ min: vec3(r), max: vec3(r) })
  const hasMatrix = r.u32()
  const collision: BsrCollision = { meshPath, boundingBoxes, hasMatrix, matrix: hasMatrix !== 0 ? floats(r, 16) : null }
  endSection(r, starts, header.collisionOffset, 'collision')

  seekSection(r, header.materialOffset, 'material')
  const materials: BsrMaterialSet[] = []
  if (version >= 109) {
    const n = count(r, 8, 'material set')
    for (let i = 0; i < n; i++) materials.push({ id: r.u32(), path: str(r) })
  } else {
    materials.push({ id: null, path: str(r) })
  }
  endSection(r, starts, header.materialOffset, 'material')

  seekSection(r, header.meshOffset, 'mesh')
  const meshes: BsrMesh[] = []
  const meshCount = count(r, 4, 'mesh')
  for (let i = 0; i < meshCount; i++) {
    const path = str(r)
    meshes.push({ path, flag: header.primMeshFlag & 1 ? r.u32() : null })
  }
  endSection(r, starts, header.meshOffset, 'mesh')

  seekSection(r, header.animationOffset, 'animation')
  const animationTypeVersion = r.u32()
  const animationTypeUserDefine = r.u32()
  const animationPaths: string[] = []
  const legacyTimelines: BsrAnimTimeline[] | null = version <= 107 ? [] : null
  const animationCount = count(r, 4, 'animation')
  for (let i = 0; i < animationCount; i++) {
    animationPaths.push(str(r))
    legacyTimelines?.push(readTimeline(r))
  }
  endSection(r, starts, header.animationOffset, 'animation')

  seekSection(r, header.skeletonOffset, 'skeleton')
  const hasSkeleton = r.u32()
  const skeleton: BsrSkeleton | null = hasSkeleton !== 0 ? { hasSkeleton, path: str(r), attachBone: str(r) } : null
  endSection(r, starts, header.skeletonOffset, 'skeleton')

  seekSection(r, header.primMeshGroupOffset, 'primMeshGroup')
  const meshGroups: BsrMeshGroup[] = []
  const meshGroupCount = count(r, 8, 'mesh group')
  for (let i = 0; i < meshGroupCount; i++) {
    const groupName = str(r)
    const n = count(r, 4, 'mesh group index')
    const meshIndices: number[] = []
    for (let j = 0; j < n; j++) meshIndices.push(r.u32())
    meshGroups.push({ name: groupName, meshIndices })
  }
  endSection(r, starts, header.primMeshGroupOffset, 'primMeshGroup')

  seekSection(r, header.primAniGroupOffset, 'primAniGroup')
  const aniGroups: BsrAniGroup[] = []
  const aniGroupCount = count(r, 8, 'animation group')
  for (let i = 0; i < aniGroupCount; i++) {
    const groupName = str(r)
    const n = count(r, 8, 'animation group entry')
    const animations: BsrAnimation[] = []
    for (let j = 0; j < n; j++) {
      const aniType = r.u32()
      const fileIndex = r.i32()
      const inRange = fileIndex >= 0 && fileIndex < animationPaths.length
      const timeline = legacyTimelines
        ? (inRange ? legacyTimelines[fileIndex]! : emptyTimeline())
        : readTimeline(r)
      animations.push({
        type: aniType,
        typeName: RESOURCE_ANIMATION_TYPE_NAMES[aniType],
        fileIndex,
        path: inRange ? animationPaths[fileIndex]! : null,
        ...timeline,
      })
    }
    aniGroups.push({ name: groupName, animations })
  }
  endSection(r, starts, header.primAniGroupOffset, 'primAniGroup')

  seekSection(r, header.modPaletteOffset, 'modPalette')
  const typedSets = version >= 108
  const modPalette: BsrModPalette = {
    systemSets: readModSets(r, typedSets),
    aniSets: typedSets ? readModSets(r, true) : [],
  }

  let attachable: BsrAttachable | null = null
  if (type === BSR_OBJECT_TYPE_CHARACTER || type === BSR_OBJECT_TYPE_ITEM || r.remaining > 0) {
    const kind = r.i32()
    const attachPoint = r.i32()
    const attachMethod = r.u32()
    const slots: BsrAttachSlot[] = []
    const n = count(r, 8, 'attach slot')
    for (let i = 0; i < n; i++) {
      const slot = r.u32()
      slots.push({ slot, slotName: BSR_SLOT_NAMES[slot], meshIndex: r.u32() })
    }
    const hasCombo = type === BSR_OBJECT_TYPE_CHARACTER || (type !== BSR_OBJECT_TYPE_ITEM && r.remaining >= 4)
    attachable = {
      kind,
      attachPoint,
      attachPointName: BSR_ATTACH_POINT_NAMES[attachPoint],
      attachMethod,
      attachMethodName: BSR_ATTACH_METHOD_NAMES[attachMethod],
      slots,
      comboNum: hasCombo ? r.u32() : null,
    }
  }

  return {
    signature,
    version,
    header,
    type,
    typeName: BSR_OBJECT_TYPE_NAMES[type],
    category,
    categoryName: BSR_OBJECT_CATEGORY_NAMES[category],
    name,
    objectInfoUnknown,
    reserved,
    collision,
    materials,
    meshes,
    animationTypeVersion,
    animationTypeUserDefine,
    animationPaths,
    legacyTimelines,
    skeleton,
    meshGroups,
    aniGroups,
    modPalette,
    attachable,
    trailing: r.bytesView(r.remaining).slice(),
  }
}

/** Parse a .bsr file. Throws an Error naming the file offset on malformed input. */
export function parseBsr(bytes: Uint8Array): BsrResource {
  const r = new BinaryReader(bytes)
  try {
    return parse(r)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.startsWith('BSR: ')) throw e
    throw new Error(`BSR: ${message} (reading at offset ${r.offset})`)
  }
}

/** Every resource path a BSR references, by kind (as stored; resolve with normalizePk2Path). */
export function bsrReferencedPaths(res: BsrResource): { bms: string[]; bmt: string[]; bsk: string[]; ban: string[] } {
  const bms = res.meshes.map(m => m.path)
  if (res.collision.meshPath) bms.push(res.collision.meshPath)
  return {
    bms,
    bmt: res.materials.map(m => m.path).filter(p => p !== ''),
    bsk: res.skeleton && res.skeleton.path ? [res.skeleton.path] : [],
    ban: res.animationPaths.slice(),
  }
}

const hex = (n: number) => `0x${n.toString(16)}`
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toPrecision(5))
const vec = (v: readonly number[]) => `(${v.map(num).join(', ')})`
const named = (v: number | null, name: string | undefined) => (v === null ? '-' : name ? `${name}(${v})` : String(v))

function formatMod(m: BsrModData): string[] {
  const head = `${m.kind} mtrl=${m.mtrlIndex} f0=${num(m.float0)} ints=[${m.int0}, ${hex(m.int1)}, ${m.int3}, ${m.int4}]`
  switch (m.kind) {
    case 'mtrl':
      return [`${head} dur=${m.durationMs}ms flag=${m.flag} keys=${m.gradientKeys.length} curve=${m.curveKeys?.length ?? '-'} rs=[${m.renderStates.join(',')}]`]
    case 'texAni':
      return [`${head} unk=[${m.unknown.join(',')}] uvScroll=${vec([m.matrix[8]!, m.matrix[9]!])}`]
    case 'multiTex':
    case 'multiTexRev':
      return [`${head} tex=${m.texture}`]
    case 'particle':
      return [head, ...m.particles.map(p =>
        `    efp ${p.path} bone='${p.bone}' pos=${vec(p.position)} birth=${p.birthTimeMs}ms flag=${p.flag} bytes=[${p.bytes.join(',')}]`)]
    case 'envMap':
      return [`${head} unk=[${m.unknown.map(hex).join(',')}]`]
    case 'bumpEnv':
      return [`${head} textures=[${m.textures.map(t => t ?? '-').join(', ')}]`]
    case 'sound':
      return [head, ...m.sets.flatMap(s => s.tracks.map(t =>
        t ? `    snd[${s.name}] ${t.keyTimeMs}ms ${t.path} '${t.event}'` : `    snd[${s.name}] (empty slot)`))]
    default:
      return [head]
  }
}

export interface FormatBsrOptions {
  /** Print every ModData entry (particles, sound tracks, ...); false prints one line per set. Default true. */
  modDetail?: boolean
}

/** Human-readable multi-line dump (debugging and corpus reports). */
export function formatBsr(res: BsrResource, { modDetail = true }: FormatBsrOptions = {}): string {
  const options = { modDetail }
  const out: string[] = []
  const h = res.header
  out.push(`${res.signature}  name='${res.name}'  type=${named(res.type, res.typeName)}  category=${named(res.category, res.categoryName)}  objInfoUnk=[${res.objectInfoUnknown.join(', ')}]`)
  out.push(`  header: material@${hex(h.materialOffset)} mesh@${hex(h.meshOffset)} skeleton@${hex(h.skeletonOffset)} animation@${hex(h.animationOffset)} meshGroup@${hex(h.primMeshGroupOffset)} aniGroup@${hex(h.primAniGroupOffset)} palette@${hex(h.modPaletteOffset)} collision@${hex(h.collisionOffset)} primMeshFlag=${h.primMeshFlag} modDataFlag=${h.modDataFlag} reserved=[${h.reserved.join(',')}]`)
  const c = res.collision
  out.push(`  collision: mesh='${c.meshPath}' boxes=${c.boundingBoxes.map(b => `${vec(b.min)}..${vec(b.max)}`).join(' ')} matrix=${c.matrix ? 'yes' : 'no'}`)
  for (const m of res.materials) out.push(`  material[${m.id ?? '-'}] ${m.path}`)
  res.meshes.forEach((m, i) => out.push(`  mesh[${i}] ${m.path}${m.flag === null ? '' : ` flag=${m.flag}`}`))
  out.push(`  skeleton: ${res.skeleton ? `${res.skeleton.path} attachBone='${res.skeleton.attachBone}'` : 'none'}`)
  out.push(`  animation files: ${res.animationPaths.length} (typeVersion ${hex(res.animationTypeVersion)}, userDefine ${res.animationTypeUserDefine})`)
  for (const g of res.meshGroups) out.push(`  meshGroup '${g.name}': [${g.meshIndices.join(', ')}]`)
  for (const g of res.aniGroups) {
    out.push(`  aniGroup '${g.name}' (${g.animations.length} entries)`)
    for (const a of g.animations) {
      const walk = a.walkLength !== 0 || a.walkGraph.length !== 2 ? ` walk=${num(a.walkLength)} graph=${a.walkGraph.map(p => vec(p)).join(' ')}` : ''
      out.push(`    ${named(a.type, a.typeName)} -> ${a.path ?? `(none, index ${a.fileIndex})`}${walk}`)
      if (a.eventsSorted.length) {
        out.push(`      events: ${a.eventsSorted.map(e => `${e.timeMs}ms type=${e.type} p=(${e.p1},${e.p2})`).join('; ')}`)
      }
    }
  }
  const sets: Array<[string, BsrModDataSet[]]> = [['system', res.modPalette.systemSets], ['ani', res.modPalette.aniSets]]
  for (const [label, list] of sets) {
    for (const s of list) {
      const kinds = options.modDetail ? '' : `: ${s.mods.map(m => m.kind).join(', ')}`
      out.push(`  ${label}Set ${named(s.type, s.typeName)} anim=${named(s.animationType, s.animationTypeName)} '${s.name}' (${s.mods.length} mods)${kinds}`)
      if (options.modDetail) for (const m of s.mods) for (const line of formatMod(m)) out.push(`    ${line}`)
    }
  }
  const a = res.attachable
  if (a) {
    out.push(`  attachable: kind=${named(a.kind, BSR_ATTACH_KIND_NAMES[a.kind])} point=${named(a.attachPoint, a.attachPointName)} method=${named(a.attachMethod, a.attachMethodName)} combo=${a.comboNum ?? '-'} slots=[${a.slots.map(s => `${named(s.slot, s.slotName)}->mesh ${s.meshIndex}`).join(', ')}]`)
  }
  if (res.trailing.length) out.push(`  trailing: ${res.trailing.length} bytes`)
  return out.join('\n')
}
