/**
 * TP-K encoder tests (docs/WAVE_PLAN3.md §7.1): the basisu command lines per map role, the KTX2 container reader
 * and the explicit-mip assembler, and a real round trip on synthetic images (skips without work/tools/basisu).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { PBR_FILES } from '../src/format.ts'
import {
  KHR_DF_MODEL_ETC1S, KHR_DF_MODEL_UASTC, KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB, KTX2_PROFILES, SUPERCOMPRESSION,
  basisuArgs, basisuPath, basisuVersion, checkKtx2, encodeKtx2, encodeKtx2Batch, hasBasisu, isKtx2File, parseKtx2, psnr,
  zstdAvailable,
} from '../src/ktx2.ts'

const HAVE = hasBasisu()
const tmp = mkdtempSync(join(tmpdir(), 'sro-ktx2-test-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A smooth, tileable-ish RGBA test picture (gradients + a soft disc), `alpha`: cutout disc or opaque. */
async function testPng(name: string, size: number, alpha: 'none' | 'cutout', seed = 0): Promise<string> {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const u = x / size
      const v = y / size
      buf[o] = Math.round(127 + 120 * Math.sin(2 * Math.PI * (u + seed * 0.1)))
      buf[o + 1] = Math.round(127 + 120 * Math.cos(2 * Math.PI * v))
      buf[o + 2] = Math.round(255 * u * v)
      const d = Math.hypot(u - 0.5, v - 0.5)
      buf[o + 3] = alpha === 'cutout' ? (d < 0.35 ? 255 : 0) : 255
    }
  }
  const file = join(tmp, name)
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toFile(file)
  return file
}

/** A tangent-space normal map (a bump), linear. */
async function normalPng(name: string, size: number): Promise<string> {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = 0.5 * Math.sin((2 * Math.PI * x) / size)
      const ny = 0.5 * Math.sin((2 * Math.PI * y) / size)
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
      const o = (y * size + x) * 4
      buf[o] = Math.round(127.5 + 127.5 * nx)
      buf[o + 1] = Math.round(127.5 + 127.5 * ny)
      buf[o + 2] = Math.round(127.5 + 127.5 * nz)
      buf[o + 3] = 255
    }
  }
  const file = join(tmp, name)
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toFile(file)
  return file
}

describe('profiles and command lines', () => {
  it('has a profile for every KTX2 map (PBR_FILES), UASTC for the maps that reach BC7 at full quality', () => {
    for (const m of PBR_FILES) expect(KTX2_PROFILES[m]).toBeDefined()
    expect(KTX2_PROFILES.albedo).toMatchObject({ codec: 'uastc', srgb: true })
    expect(KTX2_PROFILES.normal).toMatchObject({ codec: 'uastc', srgb: false, normalMap: true })
    expect(KTX2_PROFILES.ormh).toMatchObject({ codec: 'uastc', srgb: false })
  })

  it('albedo: UASTC + RDO + zstd, sRGB (no -linear), mips', () => {
    const a = basisuArgs('in.png', 'out.ktx2', { role: 'albedo' })
    expect(a.slice(0, 5)).toEqual(['-ktx2', '-file', 'in.png', '-output_file', 'out.ktx2'])
    expect(a).toContain('-uastc')
    expect(a).toContain('-uastc_rdo_l')
    expect(a).toContain('-ktx2_zstandard_level')
    expect(a).toContain('-mipmap')
    expect(a).not.toContain('-linear')
  })

  it('normal: -normal_map (linear), renormalised mips, no RDO', () => {
    const a = basisuArgs('n.png', 'n.ktx2', { role: 'normal' })
    expect(a).toContain('-normal_map')
    expect(a).toContain('-mip_renorm')
    expect(a).not.toContain('-uastc_rdo_l')
  })

  it('ormh: linear UASTC; emissive: ETC1S; no mips and no zstd on request', () => {
    expect(basisuArgs('o.png', 'o.ktx2', { role: 'ormh' })).toContain('-linear')
    const e = basisuArgs('e.png', 'e.ktx2', { role: 'emissive' })
    expect(e).not.toContain('-uastc')
    expect(e).toContain('-q')
    const n = basisuArgs('a.png', 'a.ktx2', { role: 'albedo', mips: false, zstd: false })
    expect(n).not.toContain('-mipmap')
    expect(n).toContain('-ktx2_no_zstandard')
  })

  it('finds the encoder under work/tools/basisu by default', () => {
    expect(basisuPath().replace(/\\/g, '/')).toMatch(/tools\/basisu\/basisu(\.exe)?$/)
  })

  it('psnr: identical is Infinity, a 1-level offset is about 48 dB', () => {
    const a = new Uint8Array(64).fill(100)
    expect(psnr(a, a)).toBe(Infinity)
    const b = a.map(v => v + 1)
    expect(psnr(a, b)).toBeCloseTo(48.13, 1)
  })

  it('isKtx2File rejects other data', () => {
    expect(isKtx2File(new Uint8Array(16))).toBe(false)
  })
})

describe.skipIf(!HAVE)('round trip through basisu (work/tools/basisu)', () => {
  it('reports its version', async () => {
    expect(await basisuVersion()).toMatch(/^1\.16/)
  })

  it('albedo 256² → UASTC KTX2 (sRGB, zstd, full chain) → BC7 within 38 dB', async () => {
    const src = await testPng('albedo.png', 256, 'none')
    const out = join(tmp, 'albedo.ktx2')
    const r = await encodeKtx2(src, out, { role: 'albedo' })
    expect(r).toMatchObject({ width: 256, height: 256, levels: 9, codec: 'uastc', srgb: true, supercompression: SUPERCOMPRESSION.zstd })
    const k = parseKtx2(readFileSync(out))
    expect(k.colorModel).toBe(KHR_DF_MODEL_UASTC)
    expect(k.transfer).toBe(KHR_DF_TRANSFER_SRGB)
    expect(k.levels[8]!.uncompressedByteLength).toBe(16)
    expect(k.levels[0]!.uncompressedByteLength).toBe((256 / 4) ** 2 * 16)
    const c = await checkKtx2(out, src)
    expect(c.psnrRgb).toBeGreaterThan(38)
    // Wire size: UASTC is 8 bpp before zstd; RDO + zstd must win on this smooth image.
    expect(r.bytes).toBeLessThan(256 * 256)
  })

  it('normal 128² (linear) and emissive 128² (ETC1S) encode with the right colour model and transfer', async () => {
    const n = await normalPng('normal.png', 128)
    const e = await testPng('emissive.png', 128, 'none', 3)
    const [rn, re] = await encodeKtx2Batch([
      { input: n, output: join(tmp, 'normal.ktx2'), role: 'normal' },
      { input: e, output: join(tmp, 'emissive.ktx2'), role: 'emissive' },
    ])
    expect(rn).toMatchObject({ codec: 'uastc', srgb: false, levels: 8 })
    expect(parseKtx2(readFileSync(rn!.output)).transfer).toBe(KHR_DF_TRANSFER_LINEAR)
    expect(re).toMatchObject({ codec: 'etc1s', srgb: true, supercompression: SUPERCOMPRESSION.basisLZ })
    expect(parseKtx2(readFileSync(re!.output)).colorModel).toBe(KHR_DF_MODEL_ETC1S)
    expect((await checkKtx2(rn!.output, n)).psnrRgb).toBeGreaterThan(40)
  })

  it('cutout albedo with explicit mips: every level kept (sizes, alpha), one valid KTX2', async () => {
    const dir = join(tmp, 'levels')
    mkdirSync(dir, { recursive: true })
    const levels: string[] = []
    for (let s = 64, i = 0; s >= 1; s >>= 1, i++) levels.push(await testPng(`levels/l${i}.png`, s, 'cutout', i))
    const out = join(tmp, 'cutout.ktx2')
    const r = await encodeKtx2(levels[0]!, out, { role: 'albedo', levels })
    expect(r.levels).toBe(7)
    expect(r.width).toBe(64)
    const k = parseKtx2(readFileSync(out))
    expect(k.colorModel).toBe(KHR_DF_MODEL_UASTC)
    expect(k.channelId).toBe(3) // RGBA: the cutout alpha survived
    expect(k.supercompression).toBe(zstdAvailable() ? SUPERCOMPRESSION.zstd : SUPERCOMPRESSION.none)
    k.levels.forEach((l, i) => expect(l.uncompressedByteLength).toBe(Math.ceil(Math.max(1, 64 >> i) / 4) ** 2 * 16))
    // basisu itself reads the assembled file back and transcodes it to BC7.
    const c = await checkKtx2(out, levels[0]!)
    expect(c.levels).toBe(7)
    expect(c.psnrRgb).toBeGreaterThan(36)
    expect(c.psnrAlpha).toBeGreaterThan(30)
  })

  it('rejects a level chain that does not halve', async () => {
    const a = await testPng('bad0.png', 32, 'none')
    const b = await testPng('bad1.png', 8, 'none')
    await expect(encodeKtx2(a, join(tmp, 'bad.ktx2'), { role: 'albedo', levels: [a, b] })).rejects.toThrow(/expected half/)
  })
})
