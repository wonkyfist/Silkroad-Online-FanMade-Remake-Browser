/**
 * KTX2 textures with the LOCAL transcoder (docs/TEXPIPE.md §6.7, docs/WAVE_PLAN3.md §7.1 lane TP-K): Babylon's
 * `KhronosTextureContainer2` transcodes UASTC / ETC1S in a worker, and every one of its ten `URLConfig` entries is
 * pointed at the files `packages/convert/src/tools/vendor-ktx2.ts` copies into `<out>/_decoders/ktx2/` (next to the
 * meshopt decoder). Babylon's defaults are on cdn.babylonjs.com: `jsDecoderModule` explicitly, and the nine wasm/js
 * entries through the decoder module's own built-in URLs when left null, so all ten are set here, never only one.
 *
 * Transcode targets (Babylon's decision tree, `babylonjs-ktx2decoder` transcodeDecisionTree): UASTC → ASTC 4×4 when
 * `caps.astc` (Apple GPUs, including Apple Silicon Macs and iOS), else BC7 when `caps.bptc` (desktop GPUs; WebGPU needs
 * the `texture-compression-bc` device feature, D10), else ETC2 when `caps.etc2`, else RGBA8. ETC1S → ETC2, then
 * BC7, then BC1/BC3, else RGBA8. `ktx2TranscodeFormat` mirrors this so a caller (the terrain arrays, TX-R) knows the
 * format before decoding; `decodeKtx2` returns the transcoded levels without creating a texture, for
 * texture-compressed.ts. Plain 2D `.ktx2` textures need nothing else: `new Texture('x.ktx2', scene)` goes through
 * Babylon's KTX texture loader once `installKtx2Decoder` has run.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import type { EngineCapabilities } from '@babylonjs/core/Engines/engineCapabilities.js'
import type { IDecodedData, IKTX2DecoderOptions } from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js'
import { _GetCompatibleTextureLoader } from '@babylonjs/core/Materials/Textures/Loaders/textureLoaderManager.js'
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js'
import { applyConfig } from '@babylonjs/core/Misc/khronosTextureContainer2Worker.js'

export type Ktx2UrlKey = keyof typeof KhronosTextureContainer2.URLConfig

/** Folder of the vendored files under the asset root (`<baseUrl>_decoders/ktx2/`). */
export const KTX2_DECODER_DIR = '_decoders/ktx2/'

/** The vendored file behind every `URLConfig` entry (names as in vendor-ktx2.ts `KTX2_VENDORED_FILES`). */
export const KTX2_DECODER_FILES: Readonly<Record<Ktx2UrlKey, string>> = {
  jsDecoderModule: 'babylon.ktx2Decoder.js',
  wasmUASTCToASTC: 'uastc_astc.wasm',
  wasmUASTCToBC7: 'uastc_bc7.wasm',
  wasmUASTCToRGBA_UNORM: 'uastc_rgba8_unorm_v2.wasm',
  wasmUASTCToRGBA_SRGB: 'uastc_rgba8_srgb_v2.wasm',
  wasmUASTCToR8_UNORM: 'uastc_r8_unorm.wasm',
  wasmUASTCToRG8_UNORM: 'uastc_rg8_unorm.wasm',
  jsMSCTranscoder: 'msc_basis_transcoder.js',
  wasmMSCTranscoder: 'msc_basis_transcoder.wasm',
  wasmZSTDDecoder: 'zstddec.wasm',
}

/** Resolves `baseUrl` ('/out-opt/', 'https://host/out/', a URL) against the document when there is one. */
function absoluteBase(baseUrl: string | URL): string {
  let s = String(baseUrl)
  if (!s.endsWith('/')) s += '/'
  const doc = (globalThis as { document?: { baseURI?: string } }).document
  if (doc?.baseURI) {
    try {
      return new URL(s, doc.baseURI).href
    } catch {
      return s
    }
  }
  return s
}

/** Every `URLConfig` entry for the vendored files under `baseUrl` (the asset root, as `LoadWorldOptions.baseUrl`). */
export function ktx2UrlConfig(baseUrl: string | URL): Record<Ktx2UrlKey, string> {
  const dir = absoluteBase(baseUrl) + KTX2_DECODER_DIR
  const out = {} as Record<Ktx2UrlKey, string>
  for (const key of Object.keys(KTX2_DECODER_FILES) as Ktx2UrlKey[]) out[key] = dir + KTX2_DECODER_FILES[key]
  return out
}

export interface Ktx2InstallOptions {
  /**
   * Transcoder workers (default: Babylon's, half the cores capped at 4). 0 decodes on the calling thread, which
   * needs `module` (there is no script tag to load the decoder with, e.g. headless).
   */
  numWorkers?: number
  /**
   * The decoder module itself (the `KTX2DECODER` namespace of babylon.ktx2Decoder.js), already loaded: used on the
   * calling thread instead of a worker; its transcoders still load from the vendored URLs.
   */
  module?: unknown
  /** Decoder defaults (Babylon's `KhronosTextureContainer2.DefaultDecoderOptions`). */
  decoderOptions?: { useRGBAIfASTCBC7NotAvailableWhenUASTC?: boolean; useRGBAIfOnlyBC1BC3AvailableWhenUASTC?: boolean }
}

let installedBase: string | undefined

/**
 * Points `KhronosTextureContainer2.URLConfig` at the vendored decoder under `baseUrl` (idempotent for the same base;
 * a different base replaces it, which only matters before the first KTX2 load: Babylon reads the URLs once) and
 * registers Babylon's `.ktx2` texture loader. Call before the first `.ktx2` texture, like `installMeshoptDecoder`.
 */
export function installKtx2Decoder(baseUrl: string | URL, opts: Ktx2InstallOptions = {}): void {
  const urls = ktx2UrlConfig(baseUrl)
  const cfg = KhronosTextureContainer2.URLConfig as Record<Ktx2UrlKey, string | null>
  for (const key of Object.keys(urls) as Ktx2UrlKey[]) cfg[key] = urls[key]
  if (opts.numWorkers !== undefined) KhronosTextureContainer2.DefaultNumWorkers = opts.numWorkers
  if (opts.decoderOptions) {
    const d = KhronosTextureContainer2.DefaultDecoderOptions
    if (opts.decoderOptions.useRGBAIfASTCBC7NotAvailableWhenUASTC !== undefined) {
      d.useRGBAIfASTCBC7NotAvailableWhenUASTC = opts.decoderOptions.useRGBAIfASTCBC7NotAvailableWhenUASTC
    }
    if (opts.decoderOptions.useRGBAIfOnlyBC1BC3AvailableWhenUASTC !== undefined) {
      d.useRGBAIfOnlyBC1BC3AvailableWhenUASTC = opts.decoderOptions.useRGBAIfOnlyBC1BC3AvailableWhenUASTC
    }
  }
  if (opts.module) {
    // Babylon takes a preloaded module from the global KTX2DECODER (its constructor) but then skips applying the URL
    // config to it, so the transcoder URLs are applied here, and the module loads its wasm on this thread.
    const mod = opts.module as { WASMMemoryManager?: { LoadBinariesFromCurrentThread: boolean }; MSCTranscoder?: { UseFromWorkerThread: boolean } }
    ;(globalThis as { KTX2DECODER?: unknown }).KTX2DECODER = mod
    applyConfig({ ...urls, wasmBaseUrl: '' }, { jsDecoderModule: mod } as Parameters<typeof applyConfig>[1])
    if (mod.WASMMemoryManager) mod.WASMMemoryManager.LoadBinariesFromCurrentThread = true
    if (mod.MSCTranscoder) mod.MSCTranscoder.UseFromWorkerThread = false
    KhronosTextureContainer2.DefaultNumWorkers = 0
  }
  // Registers '.ktx' and '.ktx2' with Babylon's loader manager now (it is otherwise lazy on the first load).
  void _GetCompatibleTextureLoader('.ktx2')
  installedBase = absoluteBase(baseUrl)
}

/** The asset root the decoder was installed for, or undefined. */
export function ktx2DecoderBase(): string | undefined {
  return installedBase
}

/** Every URLConfig value that would reach a CDN (tests and the lab assert this is empty after install). */
export function ktx2CdnUrls(): string[] {
  return Object.values(KhronosTextureContainer2.URLConfig).filter(v => v === null || /babylonjs\.com/i.test(v)).map(v => String(v))
}

/** WebGL enums of the formats the KTX2 decoder can hand back (Babylon's `EngineFormat`). */
export const KTX2_ENGINE_FORMAT = {
  astc4x4: 0x93b0,
  bc7: 0x8e8c,
  bc3: 0x83f3,
  bc1: 0x83f0,
  etc2Rgba: 0x9278,
  etc2Rgb: 0x9274,
  etc1: 0x8d64,
  pvrtcRgba: 0x8c02,
  pvrtcRgb: 0x8c00,
  rgba8: 0x8058,
  r8: 0x8229,
  rg8: 0x822b,
} as const

export type Ktx2Caps = Pick<EngineCapabilities, 'astc' | 'bptc' | 's3tc' | 'pvrtc' | 'etc2' | 'etc1'>

export interface Ktx2FormatQuery {
  source: 'UASTC' | 'ETC1S'
  hasAlpha: boolean
  isPowerOfTwo?: boolean
  forceRGBA?: boolean
  useRGBAIfASTCBC7NotAvailableWhenUASTC?: boolean
  /** Babylon's default is true: UASTC → BC1/BC3 is slow, so RGBA8 instead. */
  useRGBAIfOnlyBC1BC3AvailableWhenUASTC?: boolean
}

/**
 * The engine format Babylon's KTX2 decoder transcodes to for these caps (a mirror of its decision tree, 9.28), so the
 * caller can size a texture array before any layer is decoded. BC7 only with `caps.bptc`; ASTC first when offered.
 */
export function ktx2TranscodeFormat(caps: Partial<Ktx2Caps>, q: Ktx2FormatQuery): number {
  const F = KTX2_ENGINE_FORMAT
  if (q.forceRGBA) return F.rgba8
  const pot = q.isPowerOfTwo ?? true
  if (q.source === 'ETC1S') {
    if (caps.etc2) return q.hasAlpha ? F.etc2Rgba : F.etc2Rgb
    if (caps.etc1 && !q.hasAlpha) return F.etc1
    if (caps.bptc) return F.bc7
    if (caps.s3tc) return q.hasAlpha ? F.bc3 : F.bc1
    if (caps.pvrtc && pot) return q.hasAlpha ? F.pvrtcRgba : F.pvrtcRgb
    return F.rgba8
  }
  if (caps.astc) return F.astc4x4
  if (caps.bptc) return F.bc7
  if (q.useRGBAIfASTCBC7NotAvailableWhenUASTC) return F.rgba8
  if (caps.etc2) return q.hasAlpha ? F.etc2Rgba : F.etc2Rgb
  if (caps.etc1 && !q.hasAlpha) return F.etc1
  if (caps.s3tc) return (q.useRGBAIfOnlyBC1BC3AvailableWhenUASTC ?? true) ? F.rgba8 : q.hasAlpha ? F.bc3 : F.bc1
  if (caps.pvrtc && pot) return q.hasAlpha ? F.pvrtcRgba : F.pvrtcRgb
  return F.rgba8
}

/** A short name for a KTX2 engine format ('bc7', 'astc4x4', 'rgba8', …), for logs and the lab. */
export function ktx2FormatName(format: number): string {
  for (const [name, v] of Object.entries(KTX2_ENGINE_FORMAT)) if (v === format) return name
  return `0x${format.toString(16)}`
}

/** The 12-byte KTX2 identifier («KTX 20»\r\n\x1A\n). */
export function isKtx2(data: ArrayBufferView): boolean {
  return KhronosTextureContainer2.IsValid(data)
}

let container: KhronosTextureContainer2 | undefined
let containerEngine: AbstractEngine | undefined

/**
 * Transcodes a KTX2 file for this engine's caps without creating a texture: the levels (and layers) as the decoder
 * returns them (`mipmaps[i]` with `layerIndex`), `transcodedFormat` an engine format (KTX2_ENGINE_FORMAT). Uses the
 * same worker pool and URL config as Babylon's loader. Needs `installKtx2Decoder` first.
 */
export async function decodeKtx2(engine: AbstractEngine, data: ArrayBufferView, options?: IKTX2DecoderOptions): Promise<IDecodedData> {
  if (!installedBase) throw new Error('decodeKtx2: installKtx2Decoder was not called')
  if (!KhronosTextureContainer2.IsValid(data)) throw new Error('decodeKtx2: not a KTX2 file')
  if (!container || containerEngine !== engine) {
    container = new KhronosTextureContainer2(engine)
    containerEngine = engine
  }
  const decoded = await container._decodeAsync(data, options)
  if (decoded.errors) throw new Error(`decodeKtx2: ${decoded.errors}`)
  return decoded
}
