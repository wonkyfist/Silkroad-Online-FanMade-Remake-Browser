/**
 * TP-K runtime tests (docs/WAVE_PLAN3.md §7.1): the KTX2 URL config never reaches babylonjs.com, it names exactly the
 * files vendor-ktx2.ts vendors, the transcode-format mirror matches Babylon's decision tree, and the NullEngine
 * loader path: Babylon's own `.ktx2` texture loader decodes a real basisu file through the vendored decoder and
 * wasm transcoders (served from work/out/_decoders/ktx2 by a stubbed fetch). The last part skips without the
 * vendored files (`pnpm tsx packages/convert/src/tools/vendor-ktx2.ts`) or the encoder (work/tools/basisu).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { NullEngine, Scene } from '@babylonjs/core'
import { InternalTexture, InternalTextureSource } from '@babylonjs/core/Materials/Textures/internalTexture.js'
import { _GetCompatibleTextureLoader } from '@babylonjs/core/Materials/Textures/Loaders/textureLoaderManager.js'
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js'
import { afterAll, describe, expect, it } from 'vitest'
import { encodePng } from '../../convert/src/png.ts'
import { KTX2_VENDORED_FILES, checkVendored } from '../../convert/src/tools/vendor-ktx2.ts'
import {
  KTX2_DECODER_DIR, KTX2_DECODER_FILES, KTX2_ENGINE_FORMAT, decodeKtx2, installKtx2Decoder, isKtx2, ktx2CdnUrls,
  ktx2DecoderBase, ktx2FormatName, ktx2TranscodeFormat, ktx2UrlConfig, type Ktx2UrlKey,
} from '../src/ktx2.ts'
import { decodedLevels } from '../src/texture-compressed.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const VENDORED = join(REPO, 'work', 'out', KTX2_DECODER_DIR)
const BASE = 'http://sro.test/out-opt/'

describe('URL config', () => {
  it('covers every KhronosTextureContainer2.URLConfig entry', () => {
    expect(Object.keys(KTX2_DECODER_FILES).sort()).toEqual(Object.keys(KhronosTextureContainer2.URLConfig).sort())
  })

  it('names exactly the files vendor-ktx2.ts vendors', () => {
    const vendored = new Set(KTX2_VENDORED_FILES.map(f => f.name))
    for (const name of Object.values(KTX2_DECODER_FILES)) expect(vendored.has(name), name).toBe(true)
  })

  it('puts every file under <base>_decoders/ktx2/', () => {
    const urls = ktx2UrlConfig('/out-opt')
    for (const [key, url] of Object.entries(urls)) expect(url).toBe(`/out-opt/_decoders/ktx2/${KTX2_DECODER_FILES[key as Ktx2UrlKey]}`)
  })

  it('after install no entry is null or on babylonjs.com, and .ktx2 has a loader', async () => {
    expect(ktx2CdnUrls().length).toBeGreaterThan(0) // Babylon's defaults: the CDN and nulls
    installKtx2Decoder(BASE)
    expect(ktx2CdnUrls()).toEqual([])
    for (const v of Object.values(KhronosTextureContainer2.URLConfig)) {
      expect(v).not.toBeNull()
      expect(v).not.toMatch(/babylonjs\.com/)
      expect(v!.startsWith(`${BASE}_decoders/ktx2/`)).toBe(true)
    }
    expect(ktx2DecoderBase()).toBe(BASE)
    const loader = await _GetCompatibleTextureLoader('.ktx2')
    expect(loader?.constructor.name).toBe('_KTXTextureLoader')
  })
})

describe('transcode format (mirror of Babylon 9.28 decision tree)', () => {
  const F = KTX2_ENGINE_FORMAT
  const uastc = { source: 'UASTC' as const, hasAlpha: false }
  it('BC7 only with caps.bptc', () => {
    expect(ktx2TranscodeFormat({ bptc: {} }, uastc)).toBe(F.bc7)
    expect(ktx2TranscodeFormat({ bptc: null, s3tc: {} as never }, uastc)).not.toBe(F.bc7)
    expect(ktx2TranscodeFormat({}, uastc)).toBe(F.rgba8)
  })
  it('Apple GPUs: ASTC first (also when BC is offered), ETC2 without either', () => {
    expect(ktx2TranscodeFormat({ astc: {}, bptc: {} }, uastc)).toBe(F.astc4x4)
    expect(ktx2TranscodeFormat({ astc: {} }, uastc)).toBe(F.astc4x4)
    expect(ktx2TranscodeFormat({ etc2: {} }, { ...uastc, hasAlpha: true })).toBe(F.etc2Rgba)
    expect(ktx2TranscodeFormat({ etc2: {} }, uastc)).toBe(F.etc2Rgb)
  })
  it('UASTC with only BC1/BC3 goes RGBA8 (Babylon default); ETC1S prefers ETC2, then BC7', () => {
    expect(ktx2TranscodeFormat({ s3tc: {} as never }, uastc)).toBe(F.rgba8)
    expect(ktx2TranscodeFormat({ s3tc: {} as never }, { ...uastc, useRGBAIfOnlyBC1BC3AvailableWhenUASTC: false })).toBe(F.bc1)
    expect(ktx2TranscodeFormat({ etc2: {}, bptc: {} }, { source: 'ETC1S', hasAlpha: false })).toBe(F.etc2Rgb)
    expect(ktx2TranscodeFormat({ bptc: {} }, { source: 'ETC1S', hasAlpha: true })).toBe(F.bc7)
    expect(ktx2FormatName(F.bc7)).toBe('bc7')
  })
})

// ---- the real decoder, headless ----

const texpipe = await import('../../texpipe/src/ktx2.ts').catch(() => undefined)
const HAVE = !!texpipe?.hasBasisu() && existsSync(VENDORED) && checkVendored(VENDORED).length === 0

describe.skipIf(!HAVE)('NullEngine loader path with the vendored decoder', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sro-ktx2-rt-'))
  const realFetch = globalThis.fetch
  const fetched: string[] = []
  afterAll(() => {
    globalThis.fetch = realFetch
    rmSync(tmp, { recursive: true, force: true })
  })

  async function fixture(): Promise<{ bytes: Uint8Array; rgba: Uint8Array; size: number }> {
    const size = 64
    const rgba = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4
        rgba[o] = x * 4
        rgba[o + 1] = y * 4
        rgba[o + 2] = 128
        rgba[o + 3] = 255
      }
    }
    const png = join(tmp, 'grad.png')
    writeFileSync(png, encodePng(size, size, rgba))
    const out = join(tmp, 'grad.ktx2')
    // ORMH profile: linear, so the RGBA8 transcode can be compared byte for byte with the source.
    await texpipe!.encodeKtx2(png, out, { role: 'ormh' })
    return { bytes: new Uint8Array(readFileSync(out)), rgba, size }
  }

  function setup(): { engine: NullEngine; scene: Scene } {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      fetched.push(url)
      if (!url.startsWith(`${BASE}${KTX2_DECODER_DIR}`)) return new Response(null, { status: 404 })
      const file = join(VENDORED, url.slice(`${BASE}${KTX2_DECODER_DIR}`.length))
      if (!existsSync(file)) return new Response(null, { status: 404 })
      return new Response(readFileSync(file), { status: 200, headers: { 'content-type': 'application/wasm' } })
    }) as typeof fetch
    // The decoder module itself, run as a classic script the way the worker's importScripts runs it (it defines the
    // global KTX2DECODER); its transcoders then load through the vendored URLs (fetch above).
    const g = globalThis as { KTX2DECODER?: unknown }
    if (!g.KTX2DECODER) runInThisContext(readFileSync(join(VENDORED, 'babylon.ktx2Decoder.js'), 'utf8'), { filename: 'babylon.ktx2Decoder.js' })
    const mod = g.KTX2DECODER
    expect(Object.keys(mod as object)).toContain('KTX2Decoder')
    installKtx2Decoder(BASE, { module: mod })
    const engine = new NullEngine()
    return { engine, scene: new Scene(engine) }
  }

  it("Babylon's .ktx2 loader decodes a basisu UASTC file on the NullEngine (as BC7 with caps.bptc)", async () => {
    const { bytes } = await fixture()
    expect(isKtx2(bytes)).toBe(true)
    const { engine } = setup()
    // A desktop GPU. (Without any compressed caps Babylon's loader uploads RGBA8 levels and leaves the texture's
    // width/height at the last level's size, a Babylon 9.28 quirk; decodeKtx2 below covers the RGBA8 data.)
    ;(engine.getCaps() as unknown as Record<string, unknown>).bptc = {}
    const loader = (await _GetCompatibleTextureLoader('.ktx2'))!
    const tex = new InternalTexture(engine, InternalTextureSource.Url)
    const res = await new Promise<{ w: number; h: number; failed: boolean }>(ok => {
      loader.loadData(bytes, tex, (w, h, _mips, _full, _done, failed) => ok({ w, h, failed: !!failed }), {})
    })
    expect(res).toEqual({ w: 64, h: 64, failed: false })
    expect(tex.isReady).toBe(true)
    expect(tex.format).toBe(KTX2_ENGINE_FORMAT.bc7)
    expect(fetched.length).toBeGreaterThan(0)
    for (const u of fetched) expect(u).not.toMatch(/babylonjs\.com/)
    expect(fetched.some(u => u.endsWith('zstddec.wasm'))).toBe(true)
    engine.dispose()
  })

  it('decodeKtx2: RGBA8 matches the source; BC7 only with caps.bptc; ASTC when offered; levels as predicted', async () => {
    const { bytes, rgba, size } = await fixture()
    const { engine } = setup()
    const caps = engine.getCaps() as unknown as Record<string, unknown>

    const plain = await decodeKtx2(engine, bytes)
    expect(plain.transcodedFormat).toBe(KTX2_ENGINE_FORMAT.rgba8)
    expect(plain.transcodedFormat).toBe(ktx2TranscodeFormat(caps, { source: 'UASTC', hasAlpha: plain.hasAlpha }))
    const l0 = decodedLevels(plain)[0]!
    expect([l0.width, l0.height]).toEqual([size, size])
    let maxErr = 0
    for (let i = 0; i < rgba.length; i++) maxErr = Math.max(maxErr, Math.abs(l0.data[i]! - rgba[i]!))
    expect(maxErr).toBeLessThanOrEqual(12)

    caps.bptc = {}
    const bc7 = await decodeKtx2(engine, bytes)
    expect(bc7.transcodedFormat).toBe(KTX2_ENGINE_FORMAT.bc7)
    const levels = decodedLevels(bc7)
    expect(levels.length).toBe(7)
    levels.forEach((l, i) => {
      const s = Math.max(1, size >> i)
      expect([l.width, l.height]).toEqual([s, s])
      expect(l.data.byteLength).toBe(Math.ceil(s / 4) ** 2 * 16)
    })

    caps.astc = {}
    const astc = await decodeKtx2(engine, bytes)
    expect(astc.transcodedFormat).toBe(KTX2_ENGINE_FORMAT.astc4x4)
    expect(ktx2TranscodeFormat(caps, { source: 'UASTC', hasAlpha: astc.hasAlpha })).toBe(KTX2_ENGINE_FORMAT.astc4x4)
    for (const u of fetched) expect(u).not.toMatch(/babylonjs\.com/)
    engine.dispose()
  })

  it("texpipe's explicit-mip KTX2 (cutout albedo, levels assembled + zstd) decodes level by level", async () => {
    const levels: string[] = []
    for (let s = 32, i = 0; s >= 1; s >>= 1, i++) {
      const px = new Uint8Array(s * s * 4)
      for (let k = 0; k < s * s; k++) px.set([200, 40 * i, 90, (k % s) < s / 2 ? 255 : 0], k * 4)
      const f = join(tmp, `lvl${i}.png`)
      writeFileSync(f, encodePng(s, s, px))
      levels.push(f)
    }
    const out = join(tmp, 'cutout.ktx2')
    await texpipe!.encodeKtx2(levels[0]!, out, { role: 'albedo', levels })
    const { engine } = setup()
    ;(engine.getCaps() as unknown as Record<string, unknown>).bptc = {}
    const d = await decodeKtx2(engine, new Uint8Array(readFileSync(out)))
    expect(d.transcodedFormat).toBe(KTX2_ENGINE_FORMAT.bc7)
    expect(d.isInGammaSpace).toBe(true)
    expect(d.hasAlpha).toBe(true)
    expect(decodedLevels(d).map(l => l.width)).toEqual([32, 16, 8, 4, 2, 1])
    ;(engine.getCaps() as unknown as Record<string, unknown>).bptc = null
    const rgba = decodedLevels(await decodeKtx2(engine, new Uint8Array(readFileSync(out))))
    // Level 3 (4x4) keeps its own green (40 x 3) and its left-half alpha: the explicit chain, not a filtered one.
    const l3 = rgba[3]!.data
    expect(Math.abs(l3[1]! - 120)).toBeLessThanOrEqual(8)
    expect(l3[3]).toBeGreaterThan(200)
    expect(l3[3 * 4 + 3]).toBeLessThan(55)
    engine.dispose()
  })
})
