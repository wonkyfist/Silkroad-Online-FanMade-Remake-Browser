/**
 * BMT material-set parser (JMXVBMT 0102).
 *
 * Specs: SilkroadDoc wiki JMXVBMT, openroad docs/formats/bmt-jmxvbmt.md (read as documentation),
 * cross-checked against the Lafa2K importer (MIT) and the vSRO 1.188 bytes.
 *
 *   header    "JMXVBMT 0102" (12 bytes)
 *   u32       materialCount
 *   material  lpString name
 *             f32[4] diffuse, f32[4] ambient, f32[4] specular, f32[4] emissive (r, g, b, a)
 *             f32    power (Direct3D specular exponent; only meaningful with flag 0x4)
 *             u32    flags
 *             lpString diffuseMap path ('' when the material has no texture)
 *             f32    unknownFloat (1.0 in every material of this client)
 *             u8     unknownByte0, u8 unknownByte1
 *             u8     isAbsolute (bool)
 *             if flags & 0x2000: lpString normalMap path, u32 unknown
 *
 * Findings on all 3,133 files / 12,227 materials of this client (packages/convert/test/bmt.corpus.test.ts):
 * - isAbsolute: the wiki calls this byte IsAbsolute, openroad IsRelative with the opposite polarity.
 *   The bytes side with the wiki: every path stored with 1 is a full Data.pk2 path (prim\mtrl\...),
 *   every non-empty path stored with 0 is a bare file name inside the BMT's own folder.
 * - Normal map: the wiki and openroad gate the block on 0x2000 (bit 14, 1-based); Lafa2K tests
 *   1 << 14 = 0x4000. Neither bit is set anywhere in 1.188, so we follow the two specs.
 * - The diffuse-map path is always serialized, even without flag 0x100 (36 materials carry a path
 *   with flags 0x40 only).
 * - unknownByte0/1 are 24/0 on materials without flag 0x200, 32/8 with it, or 0/0; they read like the
 *   exporter's colour/alpha bit depths and do not track the actual DDS format of the texture.
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'

export type BmtColor4 = [r: number, g: number, b: number, a: number]

/** Known flag bits. Evidence from this client is noted per bit; unlisted bits are never set in 1.188. */
export const BMT_FLAG = {
  /** Culling disabled. 3,212 materials; every material named *2sid* / *2side* has it. */
  twoSided: 0x0001,
  /** Specular highlights (D3D SPECULARENABLE) using `power`. 19 materials, power 0..170. */
  specular: 0x0004,
  /** Unlit / self-illuminated. 104 materials: lit windows, lamps, crystals, dropped gold. */
  selfIlluminated: 0x0008,
  /** Wiki: "ColorTint (possibly)"; openroad: always-present marker. Set on all 12,227 materials. */
  colorTint: 0x0040,
  /** Diffuse texture enabled. */
  diffuseMap: 0x0100,
  /** Texture alpha channel used (openroad: alpha test, reference 128). */
  alpha: 0x0200,
  /** Normal-map block follows the diffuse map. Never set in 1.188. */
  normalMap: 0x2000,
} as const

export type BmtFlagName = keyof typeof BMT_FLAG

export const BMT_KNOWN_FLAGS: number = Object.values(BMT_FLAG).reduce((a, b) => a | b, 0)

export interface BmtDiffuseMap {
  /** As stored (backslashes, CP949). Resolve with resolveBmtTexturePath(). */
  path: string
  /** true: path is relative to the Data.pk2 root; false: relative to the BMT file's folder. */
  isAbsolute: boolean
  unknownFloat: number
  unknownByte0: number
  unknownByte1: number
}

export interface BmtNormalMap {
  path: string
  unknown: number
}

export interface BmtMaterial {
  name: string
  diffuse: BmtColor4
  ambient: BmtColor4
  specular: BmtColor4
  emissive: BmtColor4
  power: number
  /** Raw flag word. */
  flags: number
  /** Names of the known bits set in `flags`, in bit order. */
  flagNames: BmtFlagName[]
  /** Bits of `flags` not covered by BMT_FLAG. */
  unknownFlags: number
  diffuseMap: BmtDiffuseMap
  /** Present only when flags & 0x2000. */
  normalMap: BmtNormalMap | null
}

export interface BmtFile {
  /** 'JMXVBMT 0102' */
  signature: string
  /** 102 */
  version: number
  materials: BmtMaterial[]
}

const JMXV_SIGNATURE = 'JMXVBMT '
const SUPPORTED_VERSION = 102
/** Smallest material record: empty name + 4 colours + power + flags + empty path + float + 3 bytes. */
const MIN_MATERIAL_SIZE = 4 + 64 + 4 + 4 + 4 + 4 + 3

function fail(r: BinaryReader, what: string): never {
  throw new Error(`BMT: ${what} at offset ${r.offset}`)
}

function need(r: BinaryReader, count: number, what: string): void {
  if (r.remaining < count) fail(r, `truncated ${what} (need ${count} bytes, ${r.remaining} left)`)
}

function readString(r: BinaryReader, what: string): string {
  need(r, 4, `${what} length`)
  const len = r.view.getUint32(r.offset, true)
  if (len > r.remaining - 4) fail(r, `${what} length ${len} overruns file`)
  return r.lpString(eucKr)
}

function readColor(r: BinaryReader): BmtColor4 {
  return [r.f32(), r.f32(), r.f32(), r.f32()]
}

export function bmtFlagNames(flags: number): BmtFlagName[] {
  return (Object.keys(BMT_FLAG) as BmtFlagName[]).filter(name => (flags & BMT_FLAG[name]) !== 0)
}

function readMaterial(r: BinaryReader, i: number): BmtMaterial {
  const name = readString(r, `material ${i} name`)
  need(r, 64 + 8, `material ${i} colours`)
  const diffuse = readColor(r)
  const ambient = readColor(r)
  const specular = readColor(r)
  const emissive = readColor(r)
  const power = r.f32()
  const flags = r.u32()
  const path = readString(r, `material ${i} diffuse map path`)
  need(r, 7, `material ${i} diffuse map`)
  const unknownFloat = r.f32()
  const unknownByte0 = r.u8()
  const unknownByte1 = r.u8()
  const absoluteAt = r.offset
  const absolute = r.u8()
  if (absolute > 1) throw new Error(`BMT: material ${i} isAbsolute byte ${absolute} is not a bool at offset ${absoluteAt}`)
  let normalMap: BmtNormalMap | null = null
  if (flags & BMT_FLAG.normalMap) {
    const nPath = readString(r, `material ${i} normal map path`)
    need(r, 4, `material ${i} normal map`)
    normalMap = { path: nPath, unknown: r.u32() }
  }
  return {
    name,
    diffuse,
    ambient,
    specular,
    emissive,
    power,
    flags,
    flagNames: bmtFlagNames(flags),
    unknownFlags: (flags & ~BMT_KNOWN_FLAGS) >>> 0,
    diffuseMap: { path, isAbsolute: absolute === 1, unknownFloat, unknownByte0, unknownByte1 },
    normalMap,
  }
}

export function parseBmt(bytes: Uint8Array): BmtFile {
  const r = new BinaryReader(bytes)
  need(r, 12, 'header')
  const signature = latin1.decode(r.bytesView(12))
  if (!signature.startsWith(JMXV_SIGNATURE)) fail(r, `bad signature ${JSON.stringify(signature)}`)
  const version = Number(signature.slice(JMXV_SIGNATURE.length))
  if (version !== SUPPORTED_VERSION) fail(r, `unsupported version ${JSON.stringify(signature)}`)
  need(r, 4, 'material count')
  const count = r.u32()
  if (count * MIN_MATERIAL_SIZE > r.remaining) fail(r, `material count ${count} does not fit in file`)
  const materials: BmtMaterial[] = []
  for (let i = 0; i < count; i++) materials.push(readMaterial(r, i))
  if (r.remaining !== 0) fail(r, `${r.remaining} unexpected trailing bytes`)
  return { signature, version, materials }
}

/**
 * Data.pk2 path of a texture referenced by a BMT: absolute paths as stored, relative ones joined to the
 * folder of `bmtPath` (itself a Data.pk2 path). Returns '' for an empty texture path. Uses backslashes
 * like in-file paths; look it up with normalizePk2Path() / Pk2Archive.get().
 * This rule resolves 99.8% of the diffuse maps of vSRO 1.188 (the rest are missing from the client).
 */
export function resolveBmtTexturePath(bmtPath: string, texture: { path: string; isAbsolute: boolean }): string {
  if (texture.path === '') return ''
  if (texture.isAbsolute) return texture.path.replace(/\//g, '\\').replace(/^\\+/, '')
  const bmt = bmtPath.replace(/\//g, '\\').replace(/^\\+/, '')
  const slash = bmt.lastIndexOf('\\')
  const file = texture.path.replace(/\//g, '\\')
  return slash === -1 ? file : `${bmt.slice(0, slash)}\\${file}`
}
