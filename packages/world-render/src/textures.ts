import {
  Constants,
  NullEngine,
  RawTexture,
  RawTexture2DArray,
  Texture,
  type BaseTexture,
  type InternalTexture,
  type Scene,
} from '@babylonjs/core'
import { downsample, type Level } from './pbr/decode-core.ts'

// The box filter every CPU mip level is made with lives with the decode worker's core, so the worker's precomputed
// levels (D42) and this module's chain are the same function (pbr/decode-core.ts).
export { downsample } from './pbr/decode-core.ts'

/**
 * RGBA8 2D texture array with a full mip chain, rows uploaded as given (invertY false: v = 0 samples row 0).
 *
 * WebGL2 builds the mips with gl.generateMipmap, which covers every layer. Babylon 9's WebGPU path generates mips for
 * layer 0 only (thinWebGPUEngine._generateMipmaps passes faceIndex 0 for Raw2DArray), so there the chain is computed
 * on the CPU and uploaded level by level.
 */
export function createTextureArray(scene: Scene, layers: readonly Uint8Array[], size: number, name: string): BaseTexture {
  if (scene.getEngine() instanceof NullEngine) {
    // Headless (tests): NullEngine has no 2D-array textures; a plain texture keeps the materials valid.
    const tex = new RawTexture(layers[0]?.slice(0, size * size * 4) ?? new Uint8Array(4), size, size, Constants.TEXTUREFORMAT_RGBA, scene, false)
    tex.name = name
    return tex
  }
  const depth = layers.length
  const layerBytes = size * size * 4
  const data = new Uint8Array(layerBytes * depth)
  layers.forEach((l, i) => data.set(l.subarray(0, layerBytes), i * layerBytes))
  const isWebGPU = scene.getEngine().isWebGPU
  const levels = mipLevels(size)
  const tex = new RawTexture2DArray(data, size, size, depth, Constants.TEXTUREFORMAT_RGBA, scene, true, false,
    Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined, isWebGPU ? levels : undefined)
  tex.name = name
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  if (isWebGPU) {
    let cur = layers.map(l => ({ data: l, w: size, h: size }))
    for (let level = 1; level < levels; level++) {
      cur = cur.map(l => downsample(l.data, l.w, l.h))
      const w = cur[0]!.w
      const h = cur[0]!.h
      const levelData = new Uint8Array(w * h * 4 * depth)
      cur.forEach((l, i) => levelData.set(l.data, i * w * h * 4))
      tex.updateMipLevel(levelData, level)
    }
  }
  return tex
}

/** Mip levels of a size x size texture (size, size / 2, ..., 1). */
export function mipLevels(size: number): number {
  return Math.floor(Math.log2(size)) + 1
}

/**
 * An RGBA8 2D texture array of `depth` layers with nothing uploaded yet (region streaming, tile-atlas.ts): layers are
 * filled one by one with uploadTextureLayer. Headless (NullEngine) it is a plain placeholder texture, as in
 * createTextureArray.
 */
export function createEmptyTextureArray(scene: Scene, size: number, depth: number, name: string): BaseTexture {
  if (scene.getEngine() instanceof NullEngine) {
    const tex = new RawTexture(new Uint8Array(4).fill(128), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false)
    tex.name = name
    return tex
  }
  const isWebGPU = scene.getEngine().isWebGPU
  const tex = new RawTexture2DArray(null, size, size, depth, Constants.TEXTUREFORMAT_RGBA, scene, true, false,
    Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined, isWebGPU ? mipLevels(size) : undefined)
  tex.name = name
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}

interface WebGLEngineInternals {
  _gl?: WebGL2RenderingContext
  _bindTextureDirectly?: (target: number, texture: InternalTexture | null, forTextureDataUpdate?: boolean, force?: boolean) => boolean
  _unpackFlipY?: (value: boolean) => void
}

interface WebGPUEngineInternals {
  _textureHelper?: {
    updateTexture(data: Uint8Array, texture: InternalTexture, width: number, height: number, layers: number, format: unknown,
      faceIndex: number, mipLevel: number, invertY: boolean, premultiplyAlpha: boolean, offsetX: number, offsetY: number): void
  }
}

/**
 * Uploads one layer (RGBA8, size x size, rows as given) of a texture array made by createEmptyTextureArray or
 * createTextureArray, with its mips. `levels` (TX-R, D42): the precomputed mip levels 1..n of this layer (the decode
 * worker's chain, pbr/decode-core.ts `mipChain`); each is written as given on both engines (WebGL2 texSubImage3D per
 * level, no generateMipmap over the whole array; WebGPU a write per level). Without them: WebGL2 texSubImage3D +
 * generateMipmap; WebGPU a write per mip level (mips built on the CPU for this layer only, see createTextureArray).
 * Returns false when the engine gives no way to do it (then the caller rebuilds the whole array). Headless
 * (NullEngine) it does nothing and returns true.
 */
export function uploadTextureLayer(scene: Scene, tex: BaseTexture, layer: number, rgba: Uint8Array, size: number, levels?: readonly Uint8Array[]): boolean {
  const engine = scene.getEngine()
  if (engine instanceof NullEngine) return true
  const internal = tex.getInternalTexture()
  if (!internal || layer < 0 || layer >= internal.depth || internal.width !== size) return false
  // P-LOOK (wave 10 polish): Babylon leaves `mipLevelCount` at 1 on a WebGL2 RawTexture2DArray (its levels come from
  // generateMipmap), so the given levels were skipped there and, given levels being present, generateMipmap was too:
  // the map planes' levels stayed as allocated (zero), the arrays sampled black past level 0 (ORMH: AO 0, roughness 0;
  // black hills and wet sand, a navy sea over a black sea bed on WebGL2). A mipped WebGL2 array has the full chain.
  const full = mipLevels(size)
  const chain = engine.isWebGPU ? Math.min(internal.mipLevelCount || full, full) : internal.generateMipMaps ? full : 1
  const given = levels && levels.length >= chain - 1 && levels.every((l, i) => l.byteLength >= Math.max(1, size >> (i + 1)) ** 2 * 4) ? levels : null
  try {
    if (engine.isWebGPU) {
      const helper = (engine as unknown as WebGPUEngineInternals)._textureHelper
      const format = (internal._hardwareTexture as unknown as { format?: unknown } | null)?.format
      if (!helper || format === undefined) return false
      let cur = { data: rgba.subarray(0, size * size * 4), w: size, h: size }
      const count = Math.min(internal.mipLevelCount || 1, mipLevels(size))
      for (let level = 0; level < count; level++) {
        if (level > 0) {
          const s = Math.max(1, size >> level)
          cur = given ? { data: given[level - 1]!.subarray(0, s * s * 4), w: s, h: s } : downsample(cur.data, cur.w, cur.h)
        }
        helper.updateTexture(cur.data, internal, cur.w, cur.h, 1, format, layer, level, false, false, 0, 0)
      }
      return true
    }
    const e = engine as unknown as WebGLEngineInternals
    const gl = e._gl
    if (!gl || !e._bindTextureDirectly || typeof gl.texSubImage3D !== 'function') return false
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, internal, true)
    e._unpackFlipY?.(false)
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba, 0)
    if (given) {
      for (let level = 1; level < chain; level++) {
        const s = Math.max(1, size >> level)
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, s, s, 1, gl.RGBA, gl.UNSIGNED_BYTE, given[level - 1]!, 0)
      }
    } else gl.generateMipmap(gl.TEXTURE_2D_ARRAY)
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null)
    return true
  } catch (err) {
    console.warn('[world] texture layer upload failed; rebuilding the array instead:', err)
    return false
  }
}

// ---- 2D textures with given levels (TX-R: the map sets' uploads) ------------------------------------------------

/** One upload step of a mipped 2D texture: a band of rows of one level, or "make the rest of the mips on the GPU". */
export type LevelUploadStep =
  | { kind: 'rows'; level: number; y: number; height: number; width: number; data: Uint8Array }
  | { kind: 'mips' }

/**
 * Splits a texture's levels into upload steps of about `maxBytes` each (level 0 in bands of whole rows, smaller levels
 * grouped), then a GPU mip step when only level 0 is given. A 1024² map (4 MiB level 0) is one job at the default; a
 * 2048² one is four row bands plus the rest, so no main-thread job goes past the frame budget.
 */
export function planLevelUpload(levels: readonly Level[], maxBytes = 6 * 1048576): LevelUploadStep[][] {
  const jobs: LevelUploadStep[][] = []
  let cur: LevelUploadStep[] = []
  let bytes = 0
  const flush = () => {
    if (cur.length) jobs.push(cur)
    cur = []
    bytes = 0
  }
  levels.forEach((l, level) => {
    const row = l.width * 4
    const size = row * l.height
    if (bytes + size > maxBytes) flush()
    if (size <= maxBytes) {
      cur.push({ kind: 'rows', level, y: 0, height: l.height, width: l.width, data: l.data.subarray(0, size) })
      bytes += size
      return
    }
    // Larger than one job: bands of whole rows, each its own job; the last band may share with the smaller levels.
    const rows = Math.max(1, Math.floor(maxBytes / row))
    for (let y = 0; y < l.height; y += rows) {
      const h = Math.min(rows, l.height - y)
      cur.push({ kind: 'rows', level, y, height: h, width: l.width, data: l.data.subarray(y * row, (y + h) * row) })
      bytes += h * row
      if (y + h < l.height) flush()
    }
  })
  if (levels.length === 1) cur.push({ kind: 'mips' })
  flush()
  return jobs
}

interface TextureDataEngine {
  updateTextureData?: (texture: InternalTexture, data: ArrayBufferView, x: number, y: number, w: number, h: number, face?: number, lod?: number, mips?: boolean) => void
  generateMipmaps?: (texture: InternalTexture) => void
  _gl?: WebGL2RenderingContext
  _bindTextureDirectly?: (target: number, texture: InternalTexture | null, forTextureDataUpdate?: boolean, force?: boolean) => boolean
}

/**
 * An RGBA8 2D texture of `width` × `height` with its whole mip chain allocated and nothing uploaded yet (filled with
 * `uploadLevelSteps`): trilinear, repeat, no Y flip (rows as given, like the glTF loader's textures). `gammaSpace`
 * stays false (the caller sets it: albedo true). Headless (NullEngine) it is a 1 × 1 placeholder.
 */
export function createMippedTexture(scene: Scene, width: number, height: number, name: string): RawTexture {
  const engine = scene.getEngine()
  let tex: RawTexture
  if (engine instanceof NullEngine) tex = new RawTexture(new Uint8Array(4).fill(128), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false)
  else {
    tex = new RawTexture(null, width, height, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined, false, false, engine.isWebGPU ? levelsOf(width, height) : undefined)
  }
  tex.name = name
  tex.gammaSpace = false
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}

function levelsOf(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1
}

/**
 * Runs one job of `planLevelUpload` on a texture made by `createMippedTexture` (both engines through
 * `engine.updateTextureData`, texSubImage2D / queue.writeTexture). Returns false when the engine cannot (the caller
 * drops the texture and keeps the retail one). Headless it does nothing.
 */
export function uploadLevelSteps(scene: Scene, tex: BaseTexture, steps: readonly LevelUploadStep[]): boolean {
  const engine = scene.getEngine()
  if (engine instanceof NullEngine) return true
  const internal = tex.getInternalTexture()
  const e = engine as unknown as TextureDataEngine
  if (!internal || typeof e.updateTextureData !== 'function') return false
  try {
    for (const s of steps) {
      if (s.kind === 'rows') e.updateTextureData.call(engine, internal, s.data, 0, s.y, s.width, s.height, 0, s.level, false)
      else if (typeof e.generateMipmaps === 'function' && engine.isWebGPU) e.generateMipmaps.call(engine, internal)
      else if (e._gl && e._bindTextureDirectly) {
        e._bindTextureDirectly.call(engine, e._gl.TEXTURE_2D, internal, true)
        e._gl.generateMipmap(e._gl.TEXTURE_2D)
        e._bindTextureDirectly.call(engine, e._gl.TEXTURE_2D, null)
      } else return false
    }
    internal.isReady = true
    return true
  } catch (err) {
    console.warn('[world] texture upload failed:', err)
    return false
  }
}

// ---- batch atlases (BT-A; docs/BATCHING.md §3.2): arrays with a set mip count, sub-rectangle writes, growth -------

/**
 * An RGBA8 2D texture array of `depth` square layers with exactly `levels` mip levels and nothing uploaded yet (the
 * batch atlas pages and the lightmap array, filled cell by cell with `uploadArrayRect`). WebGPU allocates `levels`
 * levels; WebGL2 allocates the whole chain and samples only the first `levels` (TEXTURE_MAX_LEVEL), so a cell never
 * reads a level nobody wrote. Trilinear, repeat (the shader wraps inside each cell with `fract()`). Headless
 * (NullEngine) it is a 1 × 1 placeholder, as in createEmptyTextureArray.
 */
export function createArrayTexture(scene: Scene, size: number, depth: number, levels: number, name: string): BaseTexture {
  const engine = scene.getEngine()
  if (engine instanceof NullEngine) {
    const tex = new RawTexture(new Uint8Array(4).fill(128), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false)
    tex.name = name
    // Uploaded synchronously; the NullEngine never flags it (a table material waits for its textures to be ready).
    const internal = tex.getInternalTexture()
    if (internal) internal.isReady = true
    return tex
  }
  const count = Math.max(1, Math.min(levels, mipLevels(size)))
  const tex = new RawTexture2DArray(null, size, size, Math.max(1, depth), Constants.TEXTUREFORMAT_RGBA, scene, count > 1, false,
    count > 1 ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined,
    engine.isWebGPU ? count : undefined)
  tex.name = name
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  const internal = tex.getInternalTexture()
  if (internal) internal.label = name
  if (!engine.isWebGPU) {
    const e = engine as unknown as WebGLEngineInternals
    const gl = e._gl
    if (gl && e._bindTextureDirectly && internal) {
      e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, internal, true)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BASE_LEVEL, 0)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, count - 1)
      e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null)
    }
  }
  return tex
}

/** One rectangle write into an array layer: `width` × `height` texels of mip `level` at (x, y), rows as given. */
export interface ArrayRectStep {
  level: number
  x: number
  y: number
  width: number
  height: number
  data: Uint8Array
}

/**
 * Plans a cell's upload: its levels (level 0 first, each the half of the previous) written at texel (x, y) of level 0
 * (so at (x >> k, y >> k) of level k), in jobs of about `maxBytes` (level 0 in bands of whole rows, the smaller levels
 * grouped), so no main-thread job goes past its slice of the frame budget (BATCHING §5: ≤ 0.5 ms a job).
 */
export function planArrayRect(levels: readonly Level[], x: number, y: number, maxBytes = 256 * 1024): ArrayRectStep[][] {
  const jobs: ArrayRectStep[][] = []
  for (const steps of planLevelUpload(levels, maxBytes)) {
    const out: ArrayRectStep[] = []
    for (const s of steps) {
      if (s.kind !== 'rows') continue
      out.push({ level: s.level, x: x >> s.level, y: (y >> s.level) + s.y, width: s.width, height: s.height, data: s.data })
    }
    if (out.length) jobs.push(out)
  }
  return jobs
}

/**
 * Writes rectangles into one layer of an array made by createArrayTexture (WebGPU `writeTexture` with an origin,
 * WebGL2 `texSubImage3D`). Returns false when the engine cannot (the caller then marks the cell failed). Headless it
 * does nothing and returns true.
 */
export function uploadArrayRect(scene: Scene, tex: BaseTexture, layer: number, steps: readonly ArrayRectStep[]): boolean {
  const engine = scene.getEngine()
  if (engine instanceof NullEngine) return true
  const internal = tex.getInternalTexture()
  if (!internal || layer < 0 || layer >= internal.depth) return false
  try {
    if (engine.isWebGPU) {
      const helper = (engine as unknown as WebGPUEngineInternals)._textureHelper
      const format = (internal._hardwareTexture as unknown as { format?: unknown } | null)?.format
      if (!helper || format === undefined) return false
      for (const s of steps) {
        helper.updateTexture(s.data.subarray(0, s.width * s.height * 4), internal, s.width, s.height, 1, format, layer, s.level, false, false, s.x, s.y)
      }
      return true
    }
    const e = engine as unknown as WebGLEngineInternals
    const gl = e._gl
    if (!gl || !e._bindTextureDirectly || typeof gl.texSubImage3D !== 'function') return false
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, internal, true)
    e._unpackFlipY?.(false)
    for (const s of steps) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, s.level, s.x, s.y, layer, s.width, s.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, s.data, 0)
    }
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null)
    return true
  } catch (err) {
    console.warn('[world] atlas cell upload failed:', err)
    return false
  }
}

interface GpuDeviceLike {
  createCommandEncoder(desc?: object): {
    copyTextureToTexture(src: object, dst: object, size: object): void
    finish(): unknown
  }
  queue: { submit(buffers: unknown[]): void }
}

/**
 * Copies the first `layers` layers (every level up to `levels`) of one array into another of the same size and format
 * (an atlas growing its layer count: the new, deeper array takes the old one's cells on the GPU). WebGPU:
 * copyTextureToTexture; WebGL2: copyTexSubImage3D per layer and level from a read framebuffer. Returns false when the
 * engine cannot (the caller re-uploads its cells instead). Headless it does nothing and returns true.
 */
export function copyArrayLayers(scene: Scene, from: BaseTexture, to: BaseTexture, layers: number, levels: number): boolean {
  const engine = scene.getEngine()
  if (engine instanceof NullEngine) return true
  const src = from.getInternalTexture()
  const dst = to.getInternalTexture()
  if (!src || !dst || src.width !== dst.width || layers > dst.depth || layers > src.depth) return false
  const size = src.width
  const count = Math.max(1, Math.min(levels, mipLevels(size)))
  if (layers <= 0) return true
  try {
    if (engine.isWebGPU) {
      const device = (engine as unknown as { _device?: GpuDeviceLike })._device
      const a = src._hardwareTexture?.underlyingResource
      const b = dst._hardwareTexture?.underlyingResource
      if (!device || !a || !b) return false
      const enc = device.createCommandEncoder({})
      for (let level = 0; level < count; level++) {
        const s = Math.max(1, size >> level)
        enc.copyTextureToTexture({ texture: a, mipLevel: level, origin: { x: 0, y: 0, z: 0 } }, { texture: b, mipLevel: level, origin: { x: 0, y: 0, z: 0 } },
          { width: s, height: s, depthOrArrayLayers: layers })
      }
      device.queue.submit([enc.finish()])
      return true
    }
    const e = engine as unknown as WebGLEngineInternals
    const gl = e._gl
    const glSrc = src._hardwareTexture?.underlyingResource as WebGLTexture | undefined
    if (!gl || !e._bindTextureDirectly || !glSrc) return false
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb)
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, dst, true)
    for (let level = 0; level < count; level++) {
      const s = Math.max(1, size >> level)
      for (let layer = 0; layer < layers; layer++) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, glSrc, level, layer)
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, 0, 0, s, s)
      }
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead)
    gl.deleteFramebuffer(fb)
    e._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null)
    return true
  } catch (err) {
    console.warn('[world] atlas layer copy failed; re-uploading the cells instead:', err)
    return false
  }
}

/**
 * An RGBA16F 2D texture of `width` × `height` texels (the batch material table, BATCHING §3.2: one row per slot),
 * nearest, clamped, from `data` (half floats, rows as given). Headless it keeps the data in a placeholder of the
 * same size.
 */
export function createHalfTexture(scene: Scene, data: Uint16Array, width: number, height: number, name: string): RawTexture {
  const tex = new RawTexture(data, width, height, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_HALF_FLOAT)
  tex.name = name
  tex.wrapU = Texture.CLAMP_ADDRESSMODE
  tex.wrapV = Texture.CLAMP_ADDRESSMODE
  tex.anisotropicFilteringLevel = 1
  const internal = tex.getInternalTexture()
  if (internal && scene.getEngine() instanceof NullEngine) internal.isReady = true
  return tex
}

/**
 * Writes rows [y, y + rows) of a texture made by createHalfTexture from `data` (the whole table's half floats, row
 * width `width`): one sub-rectangle upload (the table update, ≤ 0.05 ms). Returns false when the engine cannot.
 */
export function uploadHalfRows(scene: Scene, tex: BaseTexture, data: Uint16Array, width: number, y: number, rows: number): boolean {
  const engine = scene.getEngine()
  if (engine instanceof NullEngine) return true
  const internal = tex.getInternalTexture()
  const e = engine as unknown as TextureDataEngine
  if (!internal || typeof e.updateTextureData !== 'function' || rows <= 0) return false
  try {
    e.updateTextureData.call(engine, internal, data.subarray(y * width * 4, (y + rows) * width * 4), 0, y, width, rows, 0, 0, false)
    return true
  } catch (err) {
    console.warn('[world] material table upload failed:', err)
    return false
  }
}

/** 1 x 1 RGBA texture (fallback lightmap etc.). */
export function solidTexture(scene: Scene, rgba: [number, number, number, number], name: string): RawTexture {
  const tex = RawTexture.CreateRGBATexture(new Uint8Array(rgba), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE)
  tex.name = name
  return tex
}
