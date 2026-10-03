/**
 * The GPU FFT (docs/COAST.md §8.3): High and Ultra on WebGPU, 4 cascades of 128² / 256². CST-O's spike took §8.3's
 * mip route 1 and extended it to the whole FFT: raw WebGPU compute on Babylon's own device (pinned to Babylon 9.28's
 * `WebGPUEngine._device` and `wrapWebGPUTexture`, see the test), because
 * - Babylon writes a storage texture through a level-0 view only, so the mip kernels need per-level views of the same
 *   texture anyway, and its per-layer mip generation (route 2) is 2 × C × 8 render passes a frame (0.3–1 ms of CPU);
 * - the whole frame is then one small command buffer (2 FFT dispatches + one per mip level), submitted from the
 *   ocean's update, before Babylon submits the frame that samples it (queue order).
 *
 * The output is one rgba16float 2D-array texture (N × N × 2C, full mip chain; layer c = displacement + foam, layer
 * C + c = derivatives), wrapped for Babylon (`BaseTexture`) and sampled by SroOceanPlugin exactly like the worker
 * tile's array (no `SRO_OCEAN_LERP`: it is evaluated at the frame's time). h0 is built in a worker from the same
 * spectrum (fft-worker.ts `'h0'`, ~20–100 ms of spectrum evaluation off the main thread per rebuild, at most once a
 * second) and uploaded with `queue.writeBuffer`. It is made only when `getCaps().supportComputeShaders` (and never on
 * WebGL2 or Low); a failure falls back to the worker tile.
 */
import { BaseTexture, Constants, Texture, type AbstractEngine, type InternalTexture, type Scene } from '@babylonjs/core'
import { OceanTileJob, type OceanWorkerIn, type OceanWorkerOut } from './fft-worker.ts'
import { FFT_PARAMS_FLOATS, MIP_WGSL, colsWgsl, rowsWgsl } from './fft-wgsl.ts'
import { DEFAULT_TILE_PARAMS, FOAM_DECAY, FOAM_GAIN, type TileParams } from './fft-core.ts'
import type { Cascade, SpectrumParams } from './spectrum.ts'

// ---- the few WebGPU shapes used here (the DOM lib has no WebGPU types) -----------------------------------------------

interface GpuBuffer {
  destroy(): void
}
interface GpuTextureView {
  readonly label?: string
}
interface GpuTexture {
  readonly width: number
  readonly height: number
  readonly depthOrArrayLayers: number
  readonly mipLevelCount: number
  readonly format: string
  createView(d?: Record<string, unknown>): GpuTextureView
  destroy(): void
}
interface GpuPipeline {
  getBindGroupLayout(i: number): unknown
}
interface GpuPass {
  setPipeline(p: GpuPipeline): void
  setBindGroup(i: number, g: unknown): void
  dispatchWorkgroups(x: number, y?: number, z?: number): void
  end(): void
}
interface GpuEncoder {
  beginComputePass(d?: Record<string, unknown>): GpuPass
  finish(): unknown
}
interface GpuQueue {
  writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView): void
  submit(cbs: unknown[]): void
}
interface GpuDevice {
  readonly queue: GpuQueue
  createBuffer(d: { size: number; usage: number; label?: string }): GpuBuffer
  createTexture(d: Record<string, unknown>): GpuTexture
  createShaderModule(d: { code: string; label?: string }): unknown
  createComputePipeline(d: Record<string, unknown>): GpuPipeline
  createBindGroup(d: Record<string, unknown>): unknown
  createCommandEncoder(d?: Record<string, unknown>): GpuEncoder
}

/** GPUBufferUsage / GPUTextureUsage bits. */
const BUF = { COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 }
const TEX = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8 }

type WebGpuEngineLike = AbstractEngine & {
  _device?: GpuDevice
  wrapWebGPUTexture?(t: GpuTexture): InternalTexture
}

/** Whether this engine can run the GPU FFT (WebGPU with compute, and the 9.28 internals the helper uses). */
export function gpuFftSupported(engine: AbstractEngine): boolean {
  const e = engine as WebGpuEngineLike
  return !!engine.isWebGPU && !!engine.getCaps().supportComputeShaders && !!e._device && typeof e.wrapWebGPUTexture === 'function'
}

export class GpuFft {
  readonly texture: BaseTexture
  readonly n: number
  hs = 0
  private readonly device: GpuDevice
  private readonly gpuTexture: GpuTexture
  private readonly params = new Float32Array(FFT_PARAMS_FLOATS)
  private readonly paramsBuf: GpuBuffer
  private readonly h0Buf: GpuBuffer
  private readonly omegaBuf: GpuBuffer
  private readonly scratch: GpuBuffer
  private readonly foam: GpuBuffer
  private readonly rows: GpuPipeline
  private readonly cols: GpuPipeline
  private readonly mip: GpuPipeline
  private readonly rowsGroup: unknown
  private readonly colsGroup: unknown
  private readonly mipGroups: unknown[] = []
  private readonly job: { post(msg: OceanWorkerIn, transfer?: ArrayBuffer[]): void; dispose(): void }
  private sent: SpectrumParams | null = null
  private pendingId = 0
  private h0Ready = false
  private lastT: number | null = null
  private knobs: TileParams = DEFAULT_TILE_PARAMS
  private disposed = false
  /** Dispatch frames encoded (tests, the bench). */
  frames = 0

  constructor(readonly scene: Scene, readonly cascades: readonly Cascade[], useWorker = true) {
    const engine = scene.getEngine() as WebGpuEngineLike
    if (!gpuFftSupported(engine)) throw new Error('no WebGPU compute')
    const n = cascades[0]!.size
    if (cascades.length > 4 || cascades.some(c => c.size !== n) || n > 256 || (n & (n - 1)) !== 0) throw new Error('unsupported cascade set')
    this.n = n
    const c = cascades.length
    const device = engine._device!
    this.device = device
    const layers = 2 * c
    const levels = Math.log2(n) + 1
    this.gpuTexture = device.createTexture({
      label: 'sroOcWavesGpu', size: [n, n, layers], format: 'rgba16float', dimension: '2d', mipLevelCount: levels,
      // COPY_SRC: the browser bench reads probe texels back (the WGSL-vs-TypeScript parity check, COAST §12.4).
      usage: TEX.TEXTURE_BINDING | TEX.STORAGE_BINDING | TEX.COPY_DST | TEX.COPY_SRC,
    })
    this.texture = wrapArray(scene, engine, this.gpuTexture, n, layers)
    const count = c * n * n
    this.paramsBuf = device.createBuffer({ label: 'sroOcFftParams', size: FFT_PARAMS_FLOATS * 4, usage: BUF.UNIFORM | BUF.COPY_DST })
    this.h0Buf = device.createBuffer({ label: 'sroOcH0', size: count * 16, usage: BUF.STORAGE | BUF.COPY_DST })
    this.omegaBuf = device.createBuffer({ label: 'sroOcOmega', size: count * 4, usage: BUF.STORAGE | BUF.COPY_DST })
    this.scratch = device.createBuffer({ label: 'sroOcScratch', size: count * 32, usage: BUF.STORAGE })
    this.foam = device.createBuffer({ label: 'sroOcFoam', size: count * 4, usage: BUF.STORAGE | BUF.COPY_DST })
    const pipe = (code: string, label: string) => device.createComputePipeline({
      label, layout: 'auto', compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' },
    })
    this.rows = pipe(rowsWgsl(n), 'sroOcFftRows')
    this.cols = pipe(colsWgsl(n), 'sroOcFftCols')
    this.mip = pipe(MIP_WGSL, 'sroOcFftMip')
    this.rowsGroup = device.createBindGroup({
      layout: this.rows.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.h0Buf } },
        { binding: 2, resource: { buffer: this.omegaBuf } },
        { binding: 3, resource: { buffer: this.scratch } },
      ],
    })
    this.colsGroup = device.createBindGroup({
      layout: this.cols.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.scratch } },
        { binding: 2, resource: { buffer: this.foam } },
        { binding: 3, resource: this.gpuTexture.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    })
    for (let m = 1; m < levels; m++) {
      this.mipGroups.push(device.createBindGroup({
        layout: this.mip.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.gpuTexture.createView({ dimension: '2d-array', baseMipLevel: m - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.gpuTexture.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 }) },
        ],
      }))
    }
    this.job = openJob(useWorker, out => this.receive(out))
  }

  /** Whether h0 is on the GPU (the ocean draws once it is). */
  get ready(): boolean {
    return this.h0Ready && this.frames > 0
  }

  /** New spectrum parameters (a rebuild, in the worker) and this frame's knobs. */
  setParams(p: SpectrumParams, knobs: TileParams): void {
    this.knobs = knobs
    if (p === this.sent) return
    this.sent = p
    this.pendingId++
    this.job.post({ type: 'h0', id: this.pendingId, cascades: this.cascades.map(c => ({ ...c })), params: p })
  }

  /** Evaluates the cascades at t (s, mod 3,600) and fills the mips: one command buffer, submitted now. */
  update(t: number): void {
    if (this.disposed || !this.h0Ready) return
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(1, t - this.lastT))
    this.lastT = t
    const c = this.cascades.length
    const p = this.params
    p[0] = t
    p[1] = dt
    p[2] = this.knobs.choppiness
    p[3] = this.knobs.foamBias
    p[4] = this.n
    p[5] = c
    p[6] = FOAM_DECAY
    p[7] = FOAM_GAIN
    for (let i = 0; i < 4; i++) {
      p[8 + i] = this.cascades[i]?.tileM ?? 1
      p[12 + i] = this.knobs.gains[i] ?? 1
    }
    const device = this.device
    device.queue.writeBuffer(this.paramsBuf, 0, p)
    const enc = device.createCommandEncoder({ label: 'sroOcFft' })
    const pass = enc.beginComputePass({ label: 'sroOcFft' })
    pass.setPipeline(this.rows)
    pass.setBindGroup(0, this.rowsGroup)
    pass.dispatchWorkgroups(this.n, c)
    pass.setPipeline(this.cols)
    pass.setBindGroup(0, this.colsGroup)
    pass.dispatchWorkgroups(this.n, c)
    pass.setPipeline(this.mip)
    for (let m = 0; m < this.mipGroups.length; m++) {
      const size = Math.max(1, this.n >> (m + 1))
      pass.setBindGroup(0, this.mipGroups[m])
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 2 * c)
    }
    pass.end()
    device.queue.submit([enc.finish()])
    this.frames++
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.job.dispose()
    this.texture.dispose()
    this.gpuTexture.destroy()
    for (const b of [this.paramsBuf, this.h0Buf, this.omegaBuf, this.scratch, this.foam]) b.destroy()
  }

  private receive(out: OceanWorkerOut): void {
    if (this.disposed) return
    if (out.type === 'error') {
      console.warn('[ocean] GPU FFT h0:', out.error)
      return
    }
    if (out.type !== 'h0' || out.id !== this.pendingId) return
    const n = this.n
    const count = n * n
    const packed = new Float32Array(this.cascades.length * count * 4)
    const omega = new Float32Array(this.cascades.length * count)
    out.h0.forEach((h, c) => {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const idx = j * n + i
          const neg = i === 0 || j === 0 ? idx : (n - j) * n + (n - i)
          const o = (c * count + idx) * 4
          packed[o] = h[idx * 2]!
          packed[o + 1] = h[idx * 2 + 1]!
          packed[o + 2] = h[neg * 2]!
          packed[o + 3] = h[neg * 2 + 1]!
        }
      }
      omega.set(out.omega[c]!, c * count)
    })
    this.device.queue.writeBuffer(this.h0Buf, 0, packed)
    this.device.queue.writeBuffer(this.omegaBuf, 0, omega)
    this.hs = out.hs
    this.h0Ready = true
  }
}

/** Wraps the GPU texture for Babylon: a 2D array with its full mip chain, sampled like the worker tile's array. */
function wrapArray(scene: Scene, engine: WebGpuEngineLike, tex: GpuTexture, n: number, layers: number): BaseTexture {
  const internal = engine.wrapWebGPUTexture!(tex)
  internal.is2DArray = true
  internal.baseDepth = layers
  internal.depth = layers
  internal.format = Constants.TEXTUREFORMAT_RGBA
  internal.type = Constants.TEXTURETYPE_HALF_FLOAT
  internal.generateMipMaps = true
  internal.useMipMaps = true
  internal.samplingMode = Constants.TEXTURE_TRILINEAR_SAMPLINGMODE
  const hw = internal._hardwareTexture as unknown as { setUsage(src: number, mips: boolean, arr: boolean, cube: boolean, is3D: boolean, w: number, h: number, d: number): void } | null
  hw?.setUsage(15, true, true, false, false, n, n, layers)
  const t = new BaseTexture(scene, internal)
  t.name = 'sroOcWaves'
  t.wrapU = Texture.WRAP_ADDRESSMODE
  t.wrapV = Texture.WRAP_ADDRESSMODE
  t.anisotropicFilteringLevel = 4
  return t
}

/** The h0 job: in a worker, or on this thread (answers on the next microtask). */
function openJob(useWorker: boolean, receive: (out: OceanWorkerOut) => void): { post(msg: OceanWorkerIn, transfer?: ArrayBuffer[]): void; dispose(): void } {
  if (useWorker && typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('./fft-worker.ts', import.meta.url), { type: 'module', name: 'sro-ocean-h0' })
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as OceanWorkerOut | { ready: true }
        if (!('ready' in m)) receive(m)
      }
      return { post: (msg, transfer) => w.postMessage(msg, transfer ?? []), dispose: () => w.terminate() }
    } catch (err) {
      console.warn('[ocean] no h0 worker; building h0 on the main thread:', err)
    }
  }
  const job = new OceanTileJob()
  let live = true
  return {
    post: msg => {
      const r = job.handle(msg)
      if (r) void Promise.resolve().then(() => live && receive(r.out))
    },
    dispose: () => {
      live = false
    },
  }
}
