/**
 * TP-K compressed texture arrays (docs/WAVE_PLAN3.md §7.1): the format choice (BC7 only with caps.bptc, ASTC first
 * for Apple GPUs), the level checks, and the per-layer, per-level upload calls on WebGL2 (compressedTexSubImage3D
 * into immutable texStorage3D) and WebGPU (the texture manager's updateTexture with the layer as the z origin),
 * against recording fakes of the engine internals the module uses.
 */
import { NullEngine, Scene, type AbstractEngine } from '@babylonjs/core'
import type { IDecodedData } from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js'
import { afterEach, describe, expect, it } from 'vitest'
import { KTX2_ENGINE_FORMAT } from '../src/ktx2.ts'
import {
  ARRAY_GL_FORMAT, arrayBytes, arrayDecodeOptions, arrayFormatSupported, checkLevels, compressedArrayFormat,
  createCompressedTextureArray, decodedLevels, fullChain, levelBytes, uploadCompressedLayer, type ArrayFormat,
  type CompressedLevel,
} from '../src/texture-compressed.ts'

function chain(format: ArrayFormat, size: number): CompressedLevel[] {
  const out: CompressedLevel[] = []
  for (let s = size; ; s >>= 1) {
    out.push({ width: s, height: s, data: new Uint8Array(levelBytes(format, s, s)).fill(s) })
    if (s === 1) break
  }
  return out
}

describe('format choice', () => {
  it('BC7 only with caps.bptc; ASTC first when offered (Apple GPUs); RGBA8 otherwise', () => {
    expect(compressedArrayFormat({ bptc: {} })).toBe('bc7')
    expect(compressedArrayFormat({ bptc: null })).toBe('rgba8')
    expect(compressedArrayFormat({})).toBe('rgba8')
    expect(compressedArrayFormat({ astc: {}, bptc: {} })).toBe('astc4x4')
    expect(compressedArrayFormat({ etc2: {} })).toBe('rgba8')
    expect(arrayFormatSupported({}, 'bc7')).toBe(false)
    expect(arrayFormatSupported({ bptc: {} }, 'bc7')).toBe(true)
    expect(arrayFormatSupported({ bptc: {} }, 'astc4x4')).toBe(false)
    expect(arrayFormatSupported({}, 'rgba8')).toBe(true)
    expect(arrayDecodeOptions('rgba8')).toEqual({ forceRGBA: true })
    expect(arrayDecodeOptions('bc7')).toEqual({})
  })

  it('sizes: 1 byte per texel compressed (whole blocks), 4 uncompressed; BC7 is 4x smaller than RGBA8', () => {
    expect(levelBytes('bc7', 1024, 1024)).toBe(1024 * 1024)
    expect(levelBytes('bc7', 2, 2)).toBe(16)
    expect(levelBytes('astc4x4', 1, 1)).toBe(16)
    expect(levelBytes('rgba8', 2, 2)).toBe(16)
    expect(fullChain(1024)).toBe(11)
    expect(arrayBytes('rgba8', 1024, 48) / arrayBytes('bc7', 1024, 48)).toBeGreaterThan(3.9)
  })

  it('checkLevels names what is wrong', () => {
    expect(checkLevels('bc7', 8, 4, chain('bc7', 8))).toBeUndefined()
    expect(checkLevels('bc7', 8, 4, chain('bc7', 8).slice(0, 2))).toMatch(/2 levels/)
    expect(checkLevels('bc7', 16, 4, chain('bc7', 8))).toMatch(/level 0 is 8x8/)
    const short = chain('bc7', 8)
    short[1] = { ...short[1]!, data: new Uint8Array(4) }
    expect(checkLevels('bc7', 8, 4, short)).toMatch(/level 1 has 4 bytes/)
  })

  it('decodedLevels picks one layer of an array KTX2 and all levels of a single image', () => {
    const d = (layerCount: number): IDecodedData => ({
      width: 4, height: 4, transcodedFormat: KTX2_ENGINE_FORMAT.bc7, layerCount, isInGammaSpace: false, hasAlpha: false, transcoderName: 't',
      mipmaps: [
        { data: new Uint8Array(16).fill(1), width: 4, height: 4, layerIndex: 0 },
        { data: new Uint8Array(16).fill(2), width: 4, height: 4, layerIndex: 1 },
      ],
    })
    expect(decodedLevels(d(2), 1).map(l => l.data[0])).toEqual([2])
    expect(decodedLevels(d(1)).length).toBe(2)
  })
})

describe('NullEngine', () => {
  it('refuses BC7 without caps.bptc, gives a placeholder with it, and uploads are no-ops', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    expect(createCompressedTextureArray(scene, { size: 8, layers: 2, format: 'bc7', name: 'a' })).toBeNull()
    ;(engine.getCaps() as unknown as Record<string, unknown>).bptc = {}
    const tex = createCompressedTextureArray(scene, { size: 8, layers: 2, format: 'bc7', name: 'a' })
    expect(tex).not.toBeNull()
    expect(uploadCompressedLayer(scene, tex!, 0, chain('bc7', 8))).toBe(true)
    engine.dispose()
  })
})

// ---- recording fakes of the engine internals ----

interface Call { fn: string; args: unknown[] }

function fakeGl(calls: Call[]): WebGL2RenderingContext {
  const consts = {
    TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAX_LEVEL: 0x813d,
    LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
  }
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }) }
  return {
    ...consts,
    createTexture: () => ({}),
    texStorage3D: rec('texStorage3D'),
    texParameteri: rec('texParameteri'),
    compressedTexSubImage3D: rec('compressedTexSubImage3D'),
    texSubImage3D: rec('texSubImage3D'),
  } as unknown as WebGL2RenderingContext
}

let engines: NullEngine[] = []
afterEach(() => {
  engines.forEach(e => e.dispose())
  engines = []
})

/** A real Scene whose getEngine() returns a fake WebGL2 or WebGPU engine with the given caps. */
function fakeScene(kind: 'webgl2' | 'webgpu', caps: Record<string, unknown>, calls: Call[]): Scene {
  const host = new NullEngine()
  engines.push(host)
  const scene = new Scene(host)
  const gl = fakeGl(calls)
  const engine = {
    isWebGPU: kind === 'webgpu',
    getCaps: () => caps,
    _createHardwareTexture: () => (kind === 'webgl2' ? { underlyingResource: gl.createTexture(), release() {}, reset() {} } : { format: undefined, release() {}, reset() {} }),
    _releaseTexture: () => {},
    _gl: kind === 'webgl2' ? gl : undefined,
    _bindTextureDirectly: (target: number, tex: unknown) => { calls.push({ fn: 'bind', args: [target, tex === null ? null : 'tex'] }); return true },
    _unpackFlipY: (v: boolean) => { calls.push({ fn: 'unpackFlipY', args: [v] }) },
    _getSamplingParameters: () => ({ min: gl.LINEAR_MIPMAP_LINEAR, mag: gl.LINEAR }),
    _textureHelper: kind === 'webgpu'
      ? {
          createGPUTextureForInternalTexture(t: { _hardwareTexture: { format?: unknown }; format: number; _useSRGBBuffer: boolean }, w: number, h: number, d: number) {
            calls.push({ fn: 'createGPUTexture', args: [w, h, d, t.format, t._useSRGBBuffer] })
            t._hardwareTexture.format = t.format === KTX2_ENGINE_FORMAT.bc7 ? 'bc7-rgba-unorm' : 'x'
            return t._hardwareTexture
          },
          updateTexture(data: Uint8Array, _t: unknown, w: number, h: number, layers: number, format: unknown, face: number, level: number) {
            calls.push({ fn: 'updateTexture', args: [data.byteLength, w, h, layers, format, face, level] })
          },
        }
      : undefined,
  } as unknown as AbstractEngine
  scene.getEngine = () => engine as never
  return scene
}

describe('WebGL2 upload', () => {
  it('allocates immutable BC7 storage for the whole chain and writes each level of one layer', () => {
    const calls: Call[] = []
    const scene = fakeScene('webgl2', { bptc: {} }, calls)
    const tex = createCompressedTextureArray(scene, { size: 16, layers: 3, format: 'bc7', name: 'terrain-albedo' })!
    expect(tex).not.toBeNull()
    expect(calls.find(c => c.fn === 'texStorage3D')!.args).toEqual([0x8c1a, 5, ARRAY_GL_FORMAT.bc7.linear, 16, 16, 3])
    expect(calls.find(c => c.fn === 'texParameteri' && c.args[1] === 0x813d)!.args[2]).toBe(4)
    calls.length = 0
    expect(uploadCompressedLayer(scene, tex, 2, chain('bc7', 16), KTX2_ENGINE_FORMAT.bc7)).toBe(true)
    const writes = calls.filter(c => c.fn === 'compressedTexSubImage3D')
    expect(writes.map(c => c.args.slice(0, 8))).toEqual([16, 8, 4, 2, 1].map((s, level) => [0x8c1a, level, 0, 0, 2, s, s, 1]))
    expect(writes.map(c => c.args[8])).toEqual(new Array(5).fill(ARRAY_GL_FORMAT.bc7.linear))
    expect(writes.map(c => (c.args[9] as Uint8Array).byteLength)).toEqual([256, 64, 16, 16, 16])
    expect(calls.some(c => c.fn === 'unpackFlipY' && c.args[0] === false)).toBe(true)
  })

  it('sRGB arrays use the sRGB BPTC format; a layer of another format, out of range or short is refused', () => {
    const calls: Call[] = []
    const scene = fakeScene('webgl2', { bptc: {} }, calls)
    const tex = createCompressedTextureArray(scene, { size: 8, layers: 1, format: 'bc7', srgb: true, name: 'a' })!
    expect(calls.find(c => c.fn === 'texStorage3D')!.args[2]).toBe(ARRAY_GL_FORMAT.bc7.srgb)
    expect(uploadCompressedLayer(scene, tex, 0, chain('bc7', 8), KTX2_ENGINE_FORMAT.astc4x4)).toBe(false)
    expect(uploadCompressedLayer(scene, tex, 1, chain('bc7', 8))).toBe(false)
    expect(uploadCompressedLayer(scene, tex, 0, chain('bc7', 8).slice(0, 1))).toBe(false)
    calls.length = 0
    expect(uploadCompressedLayer(scene, tex, 0, chain('bc7', 8))).toBe(true)
    expect(calls.filter(c => c.fn === 'compressedTexSubImage3D').map(c => c.args[8])).toEqual(new Array(4).fill(ARRAY_GL_FORMAT.bc7.srgb))
  })

  it('BC7 is never allocated without caps.bptc (RGBA8 is, with texSubImage3D)', () => {
    const calls: Call[] = []
    const scene = fakeScene('webgl2', { astc: {} }, calls)
    expect(createCompressedTextureArray(scene, { size: 8, layers: 1, format: 'bc7', name: 'a' })).toBeNull()
    expect(calls.length).toBe(0)
    const rgba = createCompressedTextureArray(scene, { size: 4, layers: 1, format: 'rgba8', name: 'b' })!
    expect(uploadCompressedLayer(scene, rgba, 0, chain('rgba8', 4))).toBe(true)
    expect(calls.filter(c => c.fn === 'texSubImage3D').length).toBe(3)
  })
})

describe('WebGPU upload', () => {
  it('creates the texture with the BC7 format and writes each level with the layer as the z origin', () => {
    const calls: Call[] = []
    const scene = fakeScene('webgpu', { bptc: true }, calls)
    const tex = createCompressedTextureArray(scene, { size: 8, layers: 4, format: 'bc7', name: 'a' })!
    expect(calls.find(c => c.fn === 'createGPUTexture')!.args).toEqual([8, 8, 4, KTX2_ENGINE_FORMAT.bc7, false])
    calls.length = 0
    expect(uploadCompressedLayer(scene, tex, 3, chain('bc7', 8))).toBe(true)
    expect(calls.map(c => c.args)).toEqual([8, 4, 2, 1].map((s, level) => [levelBytes('bc7', s, s), s, s, 1, 'bc7-rgba-unorm', 3, level]))
  })
})
