/**
 * Blowfish (Schneier 1993), plus the Joymax variant used by PK2 archives:
 * blocks are read as two LITTLE-endian 32-bit words (standard Blowfish is big-endian).
 *
 * The initial P-array and S-boxes are the hex digits of pi. Instead of embedding
 * 1042 constants we compute them once with BigInt (Machin's formula); tests pin the
 * result against published Blowfish vectors.
 */

let piWordsCache: Uint32Array | undefined

/** First `count` 32-bit words of the fractional hex expansion of pi (0x243F6A88, 0x85A308D3, ...). */
export function piFractionWords(count: number): Uint32Array {
  const bits = BigInt(count * 32)
  const guard = 64n
  const scale = 1n << (bits + guard)
  const arctanInv = (x: bigint): bigint => {
    const x2 = x * x
    let term = scale / x
    let sum = 0n
    let n = 1n
    let positive = true
    while (term !== 0n) {
      sum += positive ? term / n : -(term / n)
      term /= x2
      n += 2n
      positive = !positive
    }
    return sum
  }
  const pi = 16n * arctanInv(5n) - 4n * arctanInv(239n)
  const fraction = (pi - 3n * scale) >> guard
  const words = new Uint32Array(count)
  for (let i = 0; i < count; i++) {
    words[i] = Number((fraction >> (bits - BigInt((i + 1) * 32))) & 0xffffffffn)
  }
  return words
}

function initialState(): Uint32Array {
  piWordsCache ??= piFractionWords(18 + 4 * 256)
  return piWordsCache
}

export class Blowfish {
  private readonly p: Uint32Array
  private readonly s0: Uint32Array
  private readonly s1: Uint32Array
  private readonly s2: Uint32Array
  private readonly s3: Uint32Array
  private l = 0
  private r = 0

  constructor(key: Uint8Array) {
    if (key.length < 1 || key.length > 56) throw new RangeError(`Blowfish key must be 1-56 bytes, got ${key.length}`)
    const init = initialState()
    this.p = init.slice(0, 18)
    this.s0 = init.slice(18, 274)
    this.s1 = init.slice(274, 530)
    this.s2 = init.slice(530, 786)
    this.s3 = init.slice(786, 1042)

    let k = 0
    for (let i = 0; i < 18; i++) {
      let word = 0
      for (let j = 0; j < 4; j++) {
        word = ((word << 8) | key[k]!) >>> 0
        k = (k + 1) % key.length
      }
      this.p[i]! ^= word
    }

    this.l = 0
    this.r = 0
    for (let i = 0; i < 18; i += 2) {
      this.encipher()
      this.p[i] = this.l
      this.p[i + 1] = this.r
    }
    for (const box of [this.s0, this.s1, this.s2, this.s3]) {
      for (let i = 0; i < 256; i += 2) {
        this.encipher()
        box[i] = this.l
        box[i + 1] = this.r
      }
    }
  }

  private f(x: number): number {
    return (((this.s0[x >>> 24]! + this.s1[(x >>> 16) & 0xff]!) ^ this.s2[(x >>> 8) & 0xff]!) + this.s3[x & 0xff]!) >>> 0
  }

  private encipher(): void {
    let l = this.l
    let r = this.r
    for (let i = 0; i < 16; i++) {
      l = (l ^ this.p[i]!) >>> 0
      r = (r ^ this.f(l)) >>> 0
      const t = l
      l = r
      r = t
    }
    const t = l
    l = r
    r = t
    r = (r ^ this.p[16]!) >>> 0
    l = (l ^ this.p[17]!) >>> 0
    this.l = l
    this.r = r
  }

  private decipher(): void {
    let l = this.l
    let r = this.r
    for (let i = 17; i > 1; i--) {
      l = (l ^ this.p[i]!) >>> 0
      r = (r ^ this.f(l)) >>> 0
      const t = l
      l = r
      r = t
    }
    const t = l
    l = r
    r = t
    r = (r ^ this.p[1]!) >>> 0
    l = (l ^ this.p[0]!) >>> 0
    this.l = l
    this.r = r
  }

  private process(data: Uint8Array, littleEndian: boolean, encrypt: boolean): void {
    if (data.length % 8 !== 0) throw new RangeError(`Blowfish ECB needs a multiple of 8 bytes, got ${data.length}`)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    for (let o = 0; o < data.length; o += 8) {
      this.l = view.getUint32(o, littleEndian)
      this.r = view.getUint32(o + 4, littleEndian)
      if (encrypt) this.encipher()
      else this.decipher()
      view.setUint32(o, this.l, littleEndian)
      view.setUint32(o + 4, this.r, littleEndian)
    }
  }

  /** Standard (big-endian word) ECB, in place. */
  encryptEcb(data: Uint8Array): void {
    this.process(data, false, true)
  }

  decryptEcb(data: Uint8Array): void {
    this.process(data, false, false)
  }

  /** Joymax (little-endian word) ECB, in place. */
  encryptJoymax(data: Uint8Array): void {
    this.process(data, true, true)
  }

  decryptJoymax(data: Uint8Array): void {
    this.process(data, true, false)
  }
}
