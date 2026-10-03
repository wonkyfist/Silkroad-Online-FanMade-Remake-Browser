import { describe, expect, it } from 'vitest'
import { Blowfish, piFractionWords } from '../src/blowfish.ts'
import { derivePk2Key, pk2CheckBytes } from '../src/pk2.ts'

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)))

describe('pi constants', () => {
  it('matches the published Blowfish P-array and S-box endpoints', () => {
    const w = piFractionWords(18 + 1024)
    expect(w[0]).toBe(0x243f6a88)
    expect(w[1]).toBe(0x85a308d3)
    expect(w[17]).toBe(0x8979fb1b) // P[17]
    expect(w[18]).toBe(0xd1310ba6) // S0[0]
    expect(w[18 + 1023]).toBe(0x3ac372e6) // S3[255]
  })
})

describe('Blowfish', () => {
  // Eric Young's test vectors (big-endian words)
  const vectors: Array<[string, string, string]> = [
    ['0000000000000000', '0000000000000000', '4ef997456198dd78'],
    ['ffffffffffffffff', 'ffffffffffffffff', '51866fd5b85ecb8a'],
    ['0123456789abcdef', '1111111111111111', '61f9c3802281b096'],
    ['fedcba9876543210', '0123456789abcdef', '0aceab0fc6a0a28d'],
  ]
  it.each(vectors)('key %s encrypts %s -> %s and back', (key, plain, cipher) => {
    const bf = new Blowfish(bytes(key))
    const data = bytes(plain)
    bf.encryptEcb(data)
    expect(hex(data)).toBe(cipher)
    bf.decryptEcb(data)
    expect(hex(data)).toBe(plain)
  })
})

describe('PK2 key derivation', () => {
  it('XORs the password with the Joymax salt', () => {
    expect(hex(derivePk2Key('169841'))).toBe('32cedd7cbca8')
  })
  it('produces the D8 DA 30 header check for the default vSRO/iSRO key', () => {
    const check = pk2CheckBytes(new Blowfish(derivePk2Key('169841')))
    expect(hex(check.subarray(0, 3))).toBe('d8da30')
  })
})
