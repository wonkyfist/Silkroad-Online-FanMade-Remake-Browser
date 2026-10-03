import { describe, expect, it } from 'vitest'
import { BAN_CYCLIC, parseBan } from '../src/ban.ts'

/** Little-endian byte builder for synthetic BAN files. */
class Writer {
  private readonly out: number[] = []
  ascii(s: string): this {
    for (const c of s) this.out.push(c.charCodeAt(0))
    return this
  }
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.out.push(bytes[i]!)
    return this
  }
  u8(v: number): this {
    this.out.push(v & 0xff)
    return this
  }
  u32(v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, true)
    return this.raw(b)
  }
  i32(v: number): this {
    return this.u32(v | 0)
  }
  f32(...vs: number[]): this {
    for (const v of vs) {
      const b = new Uint8Array(4)
      new DataView(b.buffer).setFloat32(0, v, true)
      this.raw(b)
    }
    return this
  }
  str(s: string): this {
    return this.u32(s.length).ascii(s)
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

interface Key {
  q: [number, number, number, number]
  t: [number, number, number]
}

const keysA: Key[] = [
  { q: [0, 0, 0, 1], t: [1, 2, 3] },
  { q: [0.5, -0.5, 0.5, 0.5], t: [-4, 5.5, 0] },
]
const keysB: Key[] = [
  { q: [0, 0.6, 0, 0.8], t: [0, 0, 0] },
  { q: [0, 0, 0.8, 0.6], t: [7, 8, 9] },
]

function ban0102(tracks: Array<[string, Key[]]>, times = [0, 33], trailer: number[] = []): Uint8Array {
  const w = new Writer().ascii('JMXVBAN 0102').i32(0).i32(0).str('test_walk').i32(33).i32(30).i32(1)
  w.u32(times.length)
  for (const t of times) w.u32(t)
  w.u32(tracks.length)
  for (const [bone, keys] of tracks) {
    w.str(bone).u32(keys.length)
    for (const k of keys) w.f32(...k.q, ...k.t)
  }
  return w.raw(trailer).bytes()
}

function ban0101(tracks: Array<[string, Key[], number[]]>, legacy = false): Uint8Array {
  const w = legacy ? new Writer().ascii('BAN ').u32(101) : new Writer().ascii('JMXVBAN 0101')
  const str = (s: string) => (legacy ? w.str(s).u8(0) : w.str(s))
  str('old_anim')
  w.i32(1000).i32(20).i32(0).u32(tracks.length)
  for (const [bone, keys, times] of tracks) {
    str(bone)
    w.u32(keys.length)
    keys.forEach((k, i) => w.u32(times[i]!).u32(times[i]! + 7).f32(...k.q, ...k.t))
  }
  return w.bytes()
}

describe('parseBan 0102', () => {
  const anim = parseBan(ban0102([['Bip01', keysA], ['Bip01 Pelvis', keysB]]))

  it('reads the header raw', () => {
    expect(anim).toMatchObject({
      signature: 'JMXVBAN 0102',
      version: 102,
      unknown0: 0,
      unknown1: 0,
      name: 'test_walk',
      durationMs: 33,
      fps: 30,
      animationType: BAN_CYCLIC,
      sharedKeyTimes: true,
    })
    expect(Array.from(anim.keyTimes)).toEqual([0, 33])
    expect(anim.keyTimesSeconds[1]).toBeCloseTo(0.033, 6)
  })

  it('shares one key-time array across tracks and keeps x, y, z, w order', () => {
    expect(anim.tracks.map(t => t.boneName)).toEqual(['Bip01', 'Bip01 Pelvis'])
    for (const t of anim.tracks) {
      expect(t.keyTimes).toBe(anim.keyTimes)
      expect(t.keyTimesSeconds).toBe(anim.keyTimesSeconds)
      expect(t.unknownKeyTimes).toBeNull()
    }
    expect(Array.from(anim.tracks[0]!.rotations)).toEqual([0, 0, 0, 1, 0.5, -0.5, 0.5, 0.5])
    expect(Array.from(anim.tracks[0]!.translations)).toEqual([1, 2, 3, -4, 5.5, 0])
    expect(Array.from(anim.tracks[1]!.rotations)).toEqual(Array.from(new Float32Array([0, 0.6, 0, 0.8, 0, 0, 0.8, 0.6])))
  })

  it('copies NaN payloads bit-exactly', () => {
    const w = new Writer().ascii('JMXVBAN 0102').i32(0).i32(0).str('n').i32(0).i32(30).i32(0).u32(1).u32(0)
    w.u32(1).str('Bip01 L Finger0').u32(1).f32(-Math.SQRT1_2, 0, 0, 0).u32(0xffc00000).u32(0x7fc00001).u32(0x7f800000)
    const track = parseBan(w.bytes()).tracks[0]!
    expect(Array.from(new Uint32Array(track.translations.buffer))).toEqual([0xffc00000, 0x7fc00001, 0x7f800000])
    expect(track.rotations[0]).toBeCloseTo(-Math.SQRT1_2, 6)
  })

  it('decodes names as EUC-KR', () => {
    const name = [0xb3, 0xb2, 0xc0, 0xda] // "남자"
    const w = new Writer().ascii('JMXVBAN 0102').i32(0).i32(0).u32(name.length).raw(name).i32(0).i32(30).i32(0).u32(0).u32(0)
    expect(parseBan(w.bytes()).name).toBe('남자')
  })

  it('accepts files with no tracks or keys', () => {
    const anim = parseBan(ban0102([], []))
    expect(anim.tracks).toEqual([])
    expect(anim.keyTimes.length).toBe(0)
  })
})

describe('parseBan 0101 and "BAN "', () => {
  it('reads per-key times and collapses them when every track agrees', () => {
    const anim = parseBan(ban0101([['Bip01', keysA, [0, 50]], ['Bip01 Pelvis', keysB, [0, 50]]]))
    expect(anim).toMatchObject({ signature: 'JMXVBAN 0101', version: 101, unknown0: null, unknown1: null, name: 'old_anim', durationMs: 1000, fps: 20, animationType: 0, sharedKeyTimes: true })
    expect(Array.from(anim.keyTimes)).toEqual([0, 50])
    for (const t of anim.tracks) {
      expect(t.keyTimes).toBe(anim.keyTimes)
      expect(Array.from(t.unknownKeyTimes!)).toEqual([7, 57])
    }
    expect(Array.from(anim.tracks[1]!.translations)).toEqual([0, 0, 0, 7, 8, 9])
  })

  it('keeps per-track times and exposes their union when tracks disagree', () => {
    const anim = parseBan(ban0101([['a', keysA, [0, 50]], ['b', keysB, [10, 50]]]))
    expect(anim.sharedKeyTimes).toBe(false)
    expect(Array.from(anim.keyTimes)).toEqual([0, 10, 50])
    expect(Array.from(anim.tracks[1]!.keyTimes)).toEqual([10, 50])
    expect(anim.tracks[1]!.keyTimesSeconds[0]).toBeCloseTo(0.01, 6)
  })

  it('reads the legacy "BAN " variant with NUL-terminated strings', () => {
    const anim = parseBan(ban0101([['Bone01', keysA, [0, 1000]]], true))
    expect(anim).toMatchObject({ signature: 'BAN ', version: 101, name: 'old_anim', sharedKeyTimes: true })
    expect(anim.tracks[0]!.boneName).toBe('Bone01')
    expect(Array.from(anim.tracks[0]!.rotations)).toEqual([0, 0, 0, 1, 0.5, -0.5, 0.5, 0.5])
  })
})

describe('parseBan errors', () => {
  it('rejects other signatures', () => {
    expect(() => parseBan(new Writer().ascii('JMXVBSK 0101').u32(0).bytes())).toThrow(/signature "JMXVBSK 0101" at offset 0/)
    expect(() => parseBan(new Uint8Array(3))).toThrow(/too short/)
    expect(() => parseBan(new Writer().ascii('BAN ').u32(102).bytes())).toThrow(/version 102 at offset 4/)
  })

  it('reports the offset of truncated data', () => {
    const full = ban0102([['Bip01', keysA]])
    expect(() => parseBan(full.subarray(0, 30))).toThrow(/truncated at offset/)
    expect(() => parseBan(full.subarray(0, full.length - 1))).toThrow(/2 keys of track "Bip01" .* at offset \d+ overrun/)
  })

  it('rejects a track whose key count differs from the shared key times', () => {
    expect(() => parseBan(ban0102([['Bip01', keysA.slice(0, 1)]]))).toThrow(/"Bip01" has 1 keys but the file has 2 key times \(offset \d+\)/)
  })

  it('rejects absurd counts before allocating', () => {
    const w = new Writer().ascii('JMXVBAN 0102').i32(0).i32(0).str('x').i32(0).i32(30).i32(0).u32(0xffffffff)
    expect(() => parseBan(w.bytes())).toThrow(/4294967295 key times .* at offset 37/)
    const tracks = new Writer().ascii('JMXVBAN 0101').str('x').i32(0).i32(30).i32(0).u32(0x10000000)
    expect(() => parseBan(tracks.bytes())).toThrow(/268435456 tracks .* at offset 29/)
  })

  it('sizes 0101 keys at 36 bytes (time, second u32, rotation, translation)', () => {
    const full = ban0101([['Bip01', keysA, [0, 50]]])
    expect(full.length).toBe(12 + 4 + 'old_anim'.length + 12 + 4 + 4 + 'Bip01'.length + 4 + 2 * 36)
    expect(() => parseBan(full.subarray(0, full.length - 1))).toThrow(/2 keys of track "Bip01" \(at least 36 bytes each\)/)
  })

  it('rejects trailing bytes and a missing NUL in "BAN " strings', () => {
    expect(() => parseBan(ban0102([['Bip01', keysA]], [0, 33], [1, 2]))).toThrow(/2 unexpected trailing bytes/)
    const bad = ban0101([['Bone01', keysA, [0, 1]]], true)
    bad[4 + 4 + 4 + 'old_anim'.length] = 0x41
    expect(() => parseBan(bad)).toThrow(/expected NUL after string at offset 20/)
  })
})
