/** Little-endian cursor over a byte buffer. All Joymax formats are little-endian. */
export class BinaryReader {
  readonly view: DataView
  offset = 0

  constructor(readonly bytes: Uint8Array, offset = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = offset
  }

  get length(): number {
    return this.bytes.byteLength
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset
  }

  seek(offset: number): this {
    if (offset < 0 || offset > this.bytes.byteLength) {
      throw new RangeError(`seek ${offset} outside buffer of ${this.bytes.byteLength}`)
    }
    this.offset = offset
    return this
  }

  skip(count: number): this {
    return this.seek(this.offset + count)
  }

  u8(): number {
    const v = this.view.getUint8(this.offset)
    this.offset += 1
    return v
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true)
    this.offset += 4
    return v
  }

  /** u64 as a JS number; throws if it exceeds 2^53. */
  u64(): number {
    const v = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`u64 ${v} exceeds safe integer range`)
    return Number(v)
  }

  u64big(): bigint {
    const v = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return v
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return v
  }

  bytesView(count: number): Uint8Array {
    if (count < 0 || this.offset + count > this.bytes.byteLength) {
      throw new RangeError(`read of ${count} bytes at ${this.offset} overruns buffer of ${this.bytes.byteLength}`)
    }
    const v = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return v
  }

  /** Fixed-width, NUL-padded string. */
  fixedString(width: number, decoder: TextDecoder = latin1): string {
    const raw = this.bytesView(width)
    const end = raw.indexOf(0)
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end))
  }

  /** Joymax length-prefixed string: u32 byte length followed by the bytes (no terminator). */
  lpString(decoder: TextDecoder = latin1): string {
    const len = this.u32()
    return decoder.decode(this.bytesView(len))
  }
}

export const latin1 = new TextDecoder('latin1')
/** Korean code page used for PK2 entry names and many resource paths. */
export const eucKr = new TextDecoder('euc-kr')
