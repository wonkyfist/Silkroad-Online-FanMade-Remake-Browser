/**
 * JMXVBAN skeletal animation (.ban).
 *
 * Specs: SilkroadDoc wiki JMXVBAN, openroad docs/formats/ban-jmxvban.md (GPL, read as documentation only) and the
 * srodevs GitBook jmxvban page; cross-checked with Lafa2K's MIT importer (parse_ban) and every .ban in vSRO 1.188.
 *
 * JMXVBAN 0102:
 *   i32 unknown0, i32 unknown1 (0 in every file), lpString name, i32 durationMs, i32 fps, i32 animationType,
 *   u32 keyCount, u32 keyTimes[keyCount] (ms), u32 trackCount, then per track:
 *   lpString boneName, u32 keyCount (always equal to the shared count), keyCount x { f32 rotation[4], f32 translation[3] }
 * JMXVBAN 0101: no unknown0/unknown1 and no shared key-time array. Each key is 36 bytes:
 *   { u32 timeMs, u32 unknown (equal to timeMs in every file), f32 rotation[4], f32 translation[3] }.
 *   SilkroadDoc only mentions the two missing ints; the real bytes follow openroad's per-key layout.
 * "BAN " (a single file, prim/ani/item/common/mob_select.ban): 4-byte magic, u32 version (101), then the 0101
 *   body, except that every string is followed by one NUL byte. The bytes show it keeps the u32 length prefix
 *   too; openroad's "NUL-terminated instead of length-prefixed" is wrong.
 *
 * No version stores events or scale keys: each key is exactly a rotation and a translation, and every client file
 * is consumed to its last byte. Rotations are stored x, y, z, w (w last; it is the ~1 component of near-identity
 * keys) and translations x, y, z, both bone-local (relative to the parent bone) in left-handed file space.
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'

/** `animationType` values per the spec. The field is returned raw, so other values pass through. */
export const BAN_ONE_SHOT = 0
export const BAN_CYCLIC = 1

export interface BanTrack {
  boneName: string
  /** Key times in ms, one per key. In 0102 files (and 0101 files whose tracks agree) this is `BanAnimation.keyTimes`. */
  keyTimes: Uint32Array
  /** `keyTimes / 1000`; the same object as `BanAnimation.keyTimesSeconds` whenever `keyTimes` is shared. */
  keyTimesSeconds: Float32Array
  /** 0101 and "BAN " only: the second u32 stored with each key (equal to the time in every known file). */
  unknownKeyTimes: Uint32Array | null
  /** 4 floats per key in stored order x, y, z, w. Bit-exact copies of the file (NaN payloads survive). */
  rotations: Float32Array
  /** 3 floats per key: x, y, z. Bit-exact copies of the file. */
  translations: Float32Array
}

export interface BanAnimation {
  /** 'JMXVBAN 0102', 'JMXVBAN 0101' or 'BAN '. */
  signature: string
  /** 102 or 101 (the "BAN " variant stores 101 as a u32). */
  version: number
  /** 0102 only: the two leading i32s (0 in every client file); null otherwise. */
  unknown0: number | null
  unknown1: number | null
  name: string
  /** Within 1 ms of the last key time in every client file (usually floor(frames * 1000 / fps)). */
  durationMs: number
  fps: number
  /** Raw i32: 0 = one-shot, 1 = cyclic. */
  animationType: number
  /**
   * The animation's key-time axis in ms. 0102 stores it once for all tracks. 0101 stores times per key; when every
   * track agrees (all client files) this is that shared array, otherwise it is the sorted union of all track times.
   */
  keyTimes: Uint32Array
  keyTimesSeconds: Float32Array
  /** True when every track's `keyTimes` is this `keyTimes` object. */
  sharedKeyTimes: boolean
  tracks: BanTrack[]
}

const KEY_BYTES = 28
const KEY_BYTES_PER_KEY_TIME = 36

export function parseBan(bytes: Uint8Array): BanAnimation {
  const r = new BinaryReader(bytes)
  try {
    return readBan(r)
  } catch (e) {
    if (e instanceof RangeError) throw new Error(`BAN: truncated at offset ${r.offset}: ${e.message}`)
    throw e
  }
}

function readBan(r: BinaryReader): BanAnimation {
  let signature: string
  let version: number
  let legacy = false
  if (r.length >= 4 && latin1.decode(r.bytes.subarray(0, 4)) === 'BAN ') {
    signature = latin1.decode(r.bytesView(4))
    legacy = true
    version = r.u32()
    if (version !== 101) throw new Error(`BAN: unsupported "BAN " version ${version} at offset 4`)
  } else {
    if (r.length < 12) throw new Error(`BAN: ${r.length}-byte file is too short for a signature`)
    signature = latin1.decode(r.bytesView(12))
    if (signature === 'JMXVBAN 0102') version = 102
    else if (signature === 'JMXVBAN 0101') version = 101
    else throw new Error(`BAN: unsupported signature ${JSON.stringify(signature)} at offset 0`)
  }

  const str = (): string => {
    const s = r.lpString(eucKr)
    if (legacy) {
      const at = r.offset
      if (r.u8() !== 0) throw new Error(`BAN: expected NUL after string at offset ${at}`)
    }
    return s
  }

  let unknown0: number | null = null
  let unknown1: number | null = null
  if (version === 102) {
    unknown0 = r.i32()
    unknown1 = r.i32()
  }
  const name = str()
  const durationMs = r.i32()
  const fps = r.i32()
  const animationType = r.i32()

  let stored: Uint32Array | null = null
  if (version === 102) {
    const at = r.offset
    const count = r.u32()
    ensure(r, count, 4, at, 'key times')
    stored = new Uint32Array(count)
    for (let i = 0; i < count; i++) stored[i] = r.u32()
  }
  const storedSeconds = stored && toSeconds(stored)

  const trackCountAt = r.offset
  const trackCount = r.u32()
  ensure(r, trackCount, legacy ? 9 : 8, trackCountAt, 'tracks')
  const tracks: BanTrack[] = []
  for (let t = 0; t < trackCount; t++) {
    const boneName = str()
    const at = r.offset
    const count = r.u32()
    if (stored && count !== stored.length) {
      throw new Error(`BAN: track ${JSON.stringify(boneName)} has ${count} keys but the file has ${stored.length} key times (offset ${at})`)
    }
    ensure(r, count, stored ? KEY_BYTES : KEY_BYTES_PER_KEY_TIME, at, `keys of track ${JSON.stringify(boneName)}`)
    const rotations = new Float32Array(count * 4)
    const translations = new Float32Array(count * 3)
    const rotationBits = new Uint32Array(rotations.buffer)
    const translationBits = new Uint32Array(translations.buffer)
    const keyTimes = stored ?? new Uint32Array(count)
    const unknownKeyTimes = stored ? null : new Uint32Array(count)
    const v = r.view
    let o = r.offset
    for (let k = 0; k < count; k++) {
      if (unknownKeyTimes) {
        keyTimes[k] = v.getUint32(o, true)
        unknownKeyTimes[k] = v.getUint32(o + 4, true)
        o += 8
      }
      for (let c = 0; c < 4; c++) rotationBits[k * 4 + c] = v.getUint32(o + c * 4, true)
      for (let c = 0; c < 3; c++) translationBits[k * 3 + c] = v.getUint32(o + 16 + c * 4, true)
      o += KEY_BYTES
    }
    r.seek(o)
    const keyTimesSeconds = storedSeconds ?? toSeconds(keyTimes)
    tracks.push({ boneName, keyTimes, keyTimesSeconds, unknownKeyTimes, rotations, translations })
  }
  if (r.remaining !== 0) throw new Error(`BAN: ${r.remaining} unexpected trailing bytes at offset ${r.offset}`)

  let keyTimes: Uint32Array
  let keyTimesSeconds: Float32Array
  let sharedKeyTimes = true
  if (stored && storedSeconds) {
    keyTimes = stored
    keyTimesSeconds = storedSeconds
  } else {
    const first = tracks[0]
    sharedKeyTimes = tracks.every(track => sameValues(track.keyTimes, first!.keyTimes))
    if (sharedKeyTimes && first) {
      keyTimes = first.keyTimes
      keyTimesSeconds = first.keyTimesSeconds
      for (const track of tracks) {
        track.keyTimes = keyTimes
        track.keyTimesSeconds = keyTimesSeconds
      }
    } else {
      keyTimes = Uint32Array.from(new Set(tracks.flatMap(track => Array.from(track.keyTimes)))).sort()
      keyTimesSeconds = toSeconds(keyTimes)
    }
  }

  return { signature, version, unknown0, unknown1, name, durationMs, fps, animationType, keyTimes, keyTimesSeconds, sharedKeyTimes, tracks }
}

function ensure(r: BinaryReader, count: number, stride: number, at: number, what: string): void {
  if (count * stride > r.remaining) {
    throw new Error(`BAN: ${count} ${what} (at least ${stride} bytes each) at offset ${at} overrun the ${r.length}-byte file`)
  }
}

function toSeconds(ms: Uint32Array): Float32Array {
  const out = new Float32Array(ms.length)
  for (let i = 0; i < ms.length; i++) out[i] = ms[i]! / 1000
  return out
}

function sameValues(a: Uint32Array, b: Uint32Array): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
