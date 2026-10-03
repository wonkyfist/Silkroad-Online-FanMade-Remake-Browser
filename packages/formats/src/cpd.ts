/**
 * Compound object parser (JMXVCPD 0101): a named group of .bsr resources drawn at one origin.
 *
 * Specs: SilkroadDoc wiki JMXVCPD; openroad docs/formats/cpd-jmxvcpd.md (read as documentation only).
 * Checked against all 70 .cpd files of vSRO 1.188 (packages/convert/test/objects.corpus.test.ts).
 *
 *   signature  "JMXVCPD 0101" (12 bytes)
 *   header     u32 collisionOffset, u32 resourceOffset, 5 x u32 unknown (0 in every file)
 *   objInfo    u16 type, u16 category (3 = COMPOUND; SilkroadDoc reads the pair as one u32 ObjectType,
 *              0x30000 / 0x30002), lpString name, u32 unknown5, u32 unknown6
 *   collision  (at collisionOffset) lpString path of a .bsr whose collision mesh stands for the whole
 *              compound, '' for none
 *   resources  (at resourceOffset) u32 count, count x lpString .bsr path
 *
 * There are no per-child transforms: every child resource is placed at the compound's own origin
 * (a structure compound is the building plus its separately animated parts; none of their 172 child
 * BSRs names an attach bone). A character compound is a body plus its equipment: armour parts share
 * the body's frame, but 8 of its child BSRs are attachables (weapons and shields naming an attachBone
 * such as "Bip01 R HandMid", modelled at the origin) that hang from that bone of the body per the
 * socket rule in docs/CONVENTIONS.md, not at the origin.
 *
 * The sections follow each other with no gap; the parser throws if one does not end exactly where
 * the next begins, or if bytes follow the resource list.
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'
import { BSR_OBJECT_CATEGORY_NAMES, BSR_OBJECT_TYPE_NAMES } from './bsr.ts'

export const CPD_SIGNATURE = 'JMXVCPD 0101'

export interface CpdCompound {
  /** 'JMXVCPD 0101' */
  signature: string
  collisionOffset: number
  resourceOffset: number
  /** The five header u32s after the offsets (0 in every file). */
  headerUnknown: [number, number, number, number, number]
  /** ObjectGeneralType: 0 CHARACTER (character + equipment), 2 BUILDING (structure). */
  type: number
  typeName: string | undefined
  /** ObjectGeneralCategory: 3 COMPOUND in every file. */
  category: number
  categoryName: string | undefined
  /** Authoring name; often, but not always, the file's base name. */
  name: string
  unknown5: number
  unknown6: number
  /** .bsr whose collision is used for the compound, as stored; '' for none. */
  collisionPath: string
  /** Child .bsr paths, as stored (backslashes, relative to Data.pk2). */
  resourcePaths: string[]
}

function fail(message: string, offset: number): never {
  throw new Error(`CPD: ${message} at offset ${offset}`)
}

/** lpString; a NUL inside the stored length ends the string (C-string semantics). */
function str(r: BinaryReader): string {
  const at = r.offset
  const len = r.u32()
  if (len > r.remaining) fail(`string length ${len} exceeds the ${r.remaining} remaining bytes`, at)
  const raw = r.bytesView(len)
  const end = raw.indexOf(0)
  return eucKr.decode(end === -1 ? raw : raw.subarray(0, end))
}

function expectAt(r: BinaryReader, offset: number, what: string, start: number): void {
  if (r.offset !== offset) fail(`${what} ends at ${r.offset} but the next section starts at ${offset}`, start)
}

function parse(r: BinaryReader): CpdCompound {
  if (r.length < 12) fail(`file of ${r.length} bytes is too short for a signature`, 0)
  const signature = r.fixedString(12, latin1)
  if (signature !== CPD_SIGNATURE) fail(`bad signature ${JSON.stringify(signature)}`, 0)
  const collisionOffset = r.u32()
  const resourceOffset = r.u32()
  const headerUnknown: CpdCompound['headerUnknown'] = [r.u32(), r.u32(), r.u32(), r.u32(), r.u32()]
  for (const [what, offset] of [['collision', collisionOffset], ['resource', resourceOffset]] as const) {
    if (offset < 40 || offset > r.length) fail(`${what} offset ${offset} outside file of ${r.length} bytes`, 12)
  }
  if (resourceOffset < collisionOffset) fail(`resource offset ${resourceOffset} before collision offset ${collisionOffset}`, 16)

  const objInfoStart = r.offset
  const type = r.u16()
  const category = r.u16()
  const name = str(r)
  const unknown5 = r.u32()
  const unknown6 = r.u32()
  expectAt(r, collisionOffset, 'objInfo', objInfoStart)

  const collisionPath = str(r)
  expectAt(r, resourceOffset, 'collision section', collisionOffset)

  const countAt = r.offset
  const count = r.u32()
  if (count * 4 > r.remaining) fail(`resource count ${count} cannot fit in the ${r.remaining} remaining bytes`, countAt)
  const resourcePaths: string[] = []
  for (let i = 0; i < count; i++) resourcePaths.push(str(r))
  if (r.remaining !== 0) fail(`${r.remaining} unexpected bytes after the resource list`, r.offset)

  return {
    signature,
    collisionOffset,
    resourceOffset,
    headerUnknown,
    type,
    typeName: BSR_OBJECT_TYPE_NAMES[type],
    category,
    categoryName: BSR_OBJECT_CATEGORY_NAMES[category],
    name,
    unknown5,
    unknown6,
    collisionPath,
    resourcePaths,
  }
}

/** Parse a .cpd file. Throws an Error naming the file offset on malformed input. */
export function parseCpd(bytes: Uint8Array): CpdCompound {
  const r = new BinaryReader(bytes)
  try {
    return parse(r)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.startsWith('CPD: ')) throw e
    throw new Error(`CPD: ${message} (reading at offset ${r.offset})`)
  }
}

/** Every .bsr a compound references: the collision resource (if any) followed by the children. */
export function cpdReferencedPaths(cpd: CpdCompound): string[] {
  return cpd.collisionPath ? [cpd.collisionPath, ...cpd.resourcePaths] : cpd.resourcePaths.slice()
}
