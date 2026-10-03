/**
 * Block-compressed 2D texture arrays with per-layer, per-level uploads (docs/TEXPIPE.md §6.7, docs/WAVE_PLAN3.md
 * §7.1 lane TP-K): the terrain arrays (tile-atlas.ts, wired by TX-R) filled layer by layer from KTX2 files that
 * ktx2.ts `decodeKtx2` transcoded for this GPU.
 *
 * Why not Babylon's raw-array API: on WebGL2 `updateRawTexture2DArray` uploads level 0 only, names the compressed
 * format through `caps.s3tc[…]` (so BPTC/ASTC cannot be named) and then calls `generateMipmap`, which is invalid on
 * a compressed format; on WebGPU it writes all layers of a level from one buffer. So this module allocates the array
 * itself (WebGL2: immutable `texStorage3D` with the whole chain; WebGPU: Babylon's texture manager with the compressed
 * format) and writes each layer's levels: WebGL2 `compressedTexSubImage3D` / `texSubImage3D`, WebGPU the texture
 * manager's `updateTexture(…, layer, level)` (the same internal API `textures.ts` `uploadTextureLayer` uses; it pads
 * extents to whole 4×4 blocks and computes block row pitches).
 *
 * Formats: 'astc4x4' and 'bc7' (16 bytes per 4×4 block, 1 byte per texel), and 'rgba8' (the fallback: the decoder
 * is asked for RGBA with `forceRGBA`). `compressedArrayFormat` picks the one the KTX2 decoder would pick for a UASTC
 * source (ASTC first, then BC7; Apple GPUs get ASTC), so every layer transcodes to the array's format. BC7 is used
 * only with `caps.bptc`, ASTC only with `caps.astc`; ETC2 is not used for arrays (its UASTC target depends on each
 * layer's alpha), and such GPUs get 'rgba8'.
 *
 * The arrays are not in the engine's context-lost rebuild list (Babylon would rebuild them as RGBA from a missing
 * buffer); after a lost context the owner re-creates them.
 */
import { Constants } from '@babylonjs/core/Engines/constants.js'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js'
import { InternalTexture, InternalTextureSource } from '@babylonjs/core/Materials/Textures/internalTexture.js'
import type { IDecodedData, IKTX2DecoderOptions } from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { KTX2_ENGINE_FORMAT, type Ktx2Caps } from './ktx2.ts'

export type ArrayFormat = 'astc4x4' | 'bc7' | 'rgba8'

/** WebGL internal formats (linear, sRGB) per array format. */
export const ARRAY_GL_FORMAT: Readonly<Record<ArrayFormat, { linear: number; srgb: number }>> = {
  astc4x4: { linear: KTX2_ENGINE_FORMAT.astc4x4, srgb: 0x93d0 },
  bc7: { linear: KTX2_ENGINE_FORMAT.bc7, srgb: 0x8e8d },
  rgba8: { linear: 0x8058, srgb: 0x8c43 },
}

/** The KTX2 engine format each array format expects from the decoder. */
export const ARRAY_TRANSCODED_FORMAT: Readonly<Record<ArrayFormat, number>> = {
  astc4x4: KTX2_ENGINE_FORMAT.astc4x4,
  bc7: KTX2_ENGINE_FORMAT.bc7,
  rgba8: KTX2_ENGINE_FORMAT.rgba8,
}

/** True when the engine can sample this format (BC7 needs caps.bptc, ASTC caps.astc; RGBA8 always). */
export function arrayFormatSupported(caps: Partial<Ktx2Caps>, format: ArrayFormat): boolean {
  if (format === 'bc7') return !!caps.bptc
  if (format === 'astc4x4') return !!caps.astc
  return true
}

/** The array format for UASTC layers on this GPU: the KTX2 decoder's own order (ASTC, then BC7), else RGBA8. */
export function compressedArrayFormat(caps: Partial<Ktx2Caps>): ArrayFormat {
  if (caps.astc) return 'astc4x4'
  if (caps.bptc) return 'bc7'
  return 'rgba8'
}

/** Decoder options that make every layer transcode to `format` (RGBA8 is forced; the compressed ones are the default). */
export function arrayDecodeOptions(format: ArrayFormat): IKTX2DecoderOptions {
  return format === 'rgba8' ? { forceRGBA: true } : {}
}

/** Bytes of one w×h level (whole 4×4 blocks for the compressed formats). */
export function levelBytes(format: ArrayFormat, width: number, height: number): number {
  if (format === 'rgba8') return width * height * 4
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 16
}

/** Levels of a full chain for a size×size texture (size, size / 2, …, 1). */
export function fullChain(size: number): number {
  return Math.floor(Math.log2(Math.max(1, size))) + 1
}

export interface CompressedLevel {
  data: Uint8Array
  width: number
  height: number
}

/** One layer's levels out of a decoded KTX2 (a single-image file: all its levels; an array file: `layer`'s). */
export function decodedLevels(decoded: IDecodedData, layer = 0): CompressedLevel[] {
  const out: CompressedLevel[] = []
  const multi = (decoded.layerCount ?? 1) > 1
  for (const m of decoded.mipmaps) {
    if (multi && (m.layerIndex ?? 0) !== layer) continue
    if (!m.data) throw new Error('decodedLevels: a level has no data')
    out.push({ data: m.data, width: m.width, height: m.height })
  }
  return out
}

/** Why a layer's levels do not fit an array of `size` with `levels` levels in `format` (undefined when they fit). */
export function checkLevels(format: ArrayFormat, size: number, levels: number, given: readonly CompressedLevel[]): string | undefined {
  if (given.length < levels) return `${given.length} levels, the array has ${levels}`
  for (let i = 0; i < levels; i++) {
    const want = Math.max(1, size >> i)
    const l = given[i]!
    if (l.width !== want || l.height !== want) return `level ${i} is ${l.width}x${l.height}, expected ${want}x${want}`
    const bytes = levelBytes(format, want, want)
    if (l.data.byteLength < bytes) return `level ${i} has ${l.data.byteLength} bytes, expected ${bytes}`
  }
  return undefined
}

export interface CompressedArrayOptions {
  /** Layer width = height (a power of two). */
  size: number
  layers: number
  format: ArrayFormat
  /** Full mip chain (default) or level 0 only. */
  mips?: boolean
  /** Sample as sRGB (albedo); the terrain shader's current arrays are linear, so the default is false. */
  srgb?: boolean
  name: string
}

interface WebGLInternals {
  _gl?: WebGL2RenderingContext
  _bindTextureDirectly?: (target: number, texture: InternalTexture | null, forTextureDataUpdate?: boolean, force?: boolean) => boolean
  _createHardwareTexture?: () => unknown
  _unpackFlipY?: (value: boolean) => void
  _getSamplingParameters?: (samplingMode: number, generateMipMaps: boolean) => { min: number; mag: number }
}

interface WebGPUInternals {
  _textureHelper?: {
    createGPUTextureForInternalTexture(texture: InternalTexture, width?: number, height?: number, depth?: number, creationFlags?: number): { format: unknown }
    updateTexture(data: Uint8Array, texture: InternalTexture, width: number, height: number, layers: number, format: unknown,
      faceIndex: number, mipLevel: number, invertY: boolean, premultiplyAlpha: boolean, offsetX: number, offsetY: number): void
  }
}

const levelsOf = new WeakMap<InternalTexture, { format: ArrayFormat; levels: number; size: number }>()

function capsOf(engine: AbstractEngine): Partial<Ktx2Caps> {
  return engine.getCaps() as Partial<Ktx2Caps>
}

/**
 * An empty `layers`-deep array of `format`, filled with `uploadCompressedLayer`. Null when the engine cannot sample
 * the format (BC7 without caps.bptc, ASTC without caps.astc) or cannot allocate it; the caller then uses the RGBA8
 * arrays of textures.ts. Headless (NullEngine) it is a 1×1 placeholder, as in `createEmptyTextureArray`.
 */
export function createCompressedTextureArray(scene: Scene, opts: CompressedArrayOptions): BaseTexture | null {
  const engine = scene.getEngine()
  if (!arrayFormatSupported(capsOf(engine), opts.format)) return null
  const size = opts.size
  if (size < 1 || (size & (size - 1)) !== 0 || opts.layers < 1) throw new Error(`createCompressedTextureArray: bad size ${size} x ${opts.layers}`)
  if (engine instanceof NullEngine) {
    const tex = new RawTexture(new Uint8Array(4).fill(128), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false)
    tex.name = opts.name
    return tex
  }
  const mips = opts.mips ?? true
  const levels = mips ? fullChain(size) : 1
  const gl = ARRAY_GL_FORMAT[opts.format]
  const internal = new InternalTexture(engine, InternalTextureSource.Raw2DArray)
  internal.baseWidth = internal.width = size
  internal.baseHeight = internal.height = size
  internal.baseDepth = internal.depth = opts.layers
  internal.is2DArray = true
  internal.type = Constants.TEXTURETYPE_UNSIGNED_BYTE
  internal.format = opts.format === 'rgba8' ? Constants.TEXTUREFORMAT_RGBA : gl.linear
  internal.generateMipMaps = mips
  internal.samplingMode = mips ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE
  internal._useSRGBBuffer = !!opts.srgb
  internal.invertY = false
  internal.label = opts.name
  try {
    if (engine.isWebGPU) {
      const helper = (engine as unknown as WebGPUInternals)._textureHelper
      if (!helper) return null
      helper.createGPUTextureForInternalTexture(internal, size, size, opts.layers, 0)
    } else {
      const e = engine as unknown as WebGLInternals
      const ctx = e._gl
      if (!ctx || typeof ctx.texStorage3D !== 'function' || !e._createHardwareTexture || !e._bindTextureDirectly) return null
      // InternalTexture's constructor already made the GL texture (engine._createHardwareTexture).
      internal._hardwareTexture ??= e._createHardwareTexture() as InternalTexture['_hardwareTexture']
      e._bindTextureDirectly(ctx.TEXTURE_2D_ARRAY, internal, true)
      ctx.texStorage3D(ctx.TEXTURE_2D_ARRAY, levels, opts.srgb ? gl.srgb : gl.linear, size, size, opts.layers)
      const f = e._getSamplingParameters?.(internal.samplingMode, mips)
      ctx.texParameteri(ctx.TEXTURE_2D_ARRAY, ctx.TEXTURE_MAG_FILTER, f?.mag ?? ctx.LINEAR)
      ctx.texParameteri(ctx.TEXTURE_2D_ARRAY, ctx.TEXTURE_MIN_FILTER, f?.min ?? (mips ? ctx.LINEAR_MIPMAP_LINEAR : ctx.LINEAR))
      ctx.texParameteri(ctx.TEXTURE_2D_ARRAY, ctx.TEXTURE_MAX_LEVEL, levels - 1)
      e._bindTextureDirectly(ctx.TEXTURE_2D_ARRAY, null)
    }
  } catch (err) {
    console.warn(`[world] ${opts.format} texture array not available:`, err)
    internal.dispose()
    return null
  }
  internal.isReady = true
  levelsOf.set(internal, { format: opts.format, levels, size })
  const tex = new BaseTexture(scene, internal)
  tex.name = opts.name
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}

/**
 * Writes one layer's levels (level 0 first, as `decodedLevels` returns them) into an array made by
 * `createCompressedTextureArray`. Levels past the array's chain are ignored; missing or mis-sized levels, or data of
 * another format, return false (the caller keeps the layer's previous content or falls back). Headless (NullEngine)
 * it does nothing and returns true.
 */
export function uploadCompressedLayer(scene: Scene, tex: BaseTexture, layer: number, levels: readonly CompressedLevel[], transcodedFormat?: number): boolean {
  const engine = scene.getEngine()
  if (engine instanceof NullEngine) return true
  const internal = tex.getInternalTexture()
  const meta = internal && levelsOf.get(internal)
  if (!internal || !meta || layer < 0 || layer >= internal.depth) return false
  if (transcodedFormat !== undefined && transcodedFormat !== ARRAY_TRANSCODED_FORMAT[meta.format]) return false
  const bad = checkLevels(meta.format, meta.size, meta.levels, levels)
  if (bad) {
    console.warn(`[world] compressed layer ${layer} rejected: ${bad}`)
    return false
  }
  try {
    if (engine.isWebGPU) {
      const helper = (engine as unknown as WebGPUInternals)._textureHelper
      const format = (internal._hardwareTexture as unknown as { format?: unknown } | null)?.format
      if (!helper || format === undefined) return false
      for (let i = 0; i < meta.levels; i++) {
        const l = levels[i]!
        const bytes = levelBytes(meta.format, l.width, l.height)
        helper.updateTexture(l.data.subarray(0, bytes), internal, l.width, l.height, 1, format, layer, i, false, false, 0, 0)
      }
      return true
    }
    const e = engine as unknown as WebGLInternals
    const gl = e._gl
    if (!gl || !e._bindTextureDirectly) return false
    const glFormat = internal._useSRGBBuffer ? ARRAY_GL_FORMAT[meta.format].srgb : ARRAY_GL_FORMAT[meta.format].linear
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, internal, true)
    e._unpackFlipY?.(false)
    for (let i = 0; i < meta.levels; i++) {
      const l = levels[i]!
      const bytes = levelBytes(meta.format, l.width, l.height)
      const data = l.data.subarray(0, bytes)
      if (meta.format === 'rgba8') gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, i, 0, 0, layer, l.width, l.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, data)
      else gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, i, 0, 0, layer, l.width, l.height, 1, glFormat, data)
    }
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null)
    return true
  } catch (err) {
    console.warn(`[world] compressed layer ${layer} upload failed:`, err)
    return false
  }
}

/** Resident bytes of an array (all layers and levels), for the VRAM line of the perf overlay. */
export function arrayBytes(format: ArrayFormat, size: number, layers: number, mips = true): number {
  let total = 0
  for (let i = 0; i < (mips ? fullChain(size) : 1); i++) total += levelBytes(format, Math.max(1, size >> i), Math.max(1, size >> i))
  return total * layers
}
