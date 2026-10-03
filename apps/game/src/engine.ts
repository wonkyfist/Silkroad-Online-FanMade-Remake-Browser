import { Engine, WebGPUEngine, type AbstractEngine } from '@babylonjs/core'
import { gpuInfoFromEngine, type GpuInfo } from '@sro/world-render'

export type EngineKind = 'WebGPU' | 'WebGL2' | 'WebGL1'

export interface EngineResult {
  engine: AbstractEngine
  kind: EngineKind
  canvas: HTMLCanvasElement
  /** Why WebGPU was not used, if it was not. */
  note?: string
  /**
   * Wave 9 (docs/WAVE_PLAN3.md D10): the device's limits and features and the adapter's identity, for the first-run
   * preset (GAME) and World (LoadWorldOptions.gpu).
   */
  gpu: GpuInfo
}

/**
 * How the WebGPU device's limits are requested: 'max' copies every adapter limit (setMaximumLimits; the one that
 * matters is maxInterStageShaderVariables, 16 → 28 on the dev GPU: PBR + CSM + the SSAO prepass need 17, and with 16
 * the frame goes black), 'default' keeps WebGPU's defaults (the `?gpuLimits=default` debug flag, to test the 16-varying
 * fallback on a strong GPU).
 */
export type GpuLimitsMode = 'max' | 'default'

/**
 * Optional device features used when the adapter has them: the compressed-texture families KTX2 transcodes to (BC on
 * PC GPUs; ASTC and ETC2 on Apple silicon, where BC may be missing: the friends' Macs, the 9B handoff) and GPU timers
 * (perf overlay).
 */
export const WANTED_GPU_FEATURES = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2', 'timestamp-query'] as const

/**
 * Ask for the discrete GPU on dual-GPU laptops (the friends play on gaming laptops; the coast doc's handoff). WebGPU:
 * requestAdapter's powerPreference (also passed to Babylon, which requests the engine's own adapter with its options);
 * WebGL2: the context attribute. Chrome on Windows ignores it for WebGPU and says so once in the console (it picks the
 * high-performance adapter by the OS's per-app setting); it is harmless there.
 */
export const GPU_POWER_PREFERENCE = 'high-performance' as const

/** The WebGL2 fallback's engine options: HEAD's plus the high-performance GPU request. */
export function webglEngineOptions(): { stencil: boolean; adaptToDeviceRatio: boolean; powerPreference: WebGLPowerPreference } {
  return { stencil: true, adaptToDeviceRatio: true, powerPreference: GPU_POWER_PREFERENCE }
}

/** The part of a GPUAdapter the options read (tests pass a fake). */
export interface AdapterLike {
  readonly features: Iterable<string>
  readonly info?: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean }
  /** Older spelling of info.isFallbackAdapter. */
  readonly isFallbackAdapter?: boolean
}

type WebGPUOptions = NonNullable<ConstructorParameters<typeof WebGPUEngine>[1]>
type FeatureList = NonNullable<NonNullable<WebGPUOptions['deviceDescriptor']>['requiredFeatures']>

/** The WebGPU engine options: HEAD's plus the high-performance adapter, the limits mode and the wanted features the adapter has. */
export function webgpuEngineOptions(adapter: AdapterLike | null, limits: GpuLimitsMode): WebGPUOptions {
  const opts: WebGPUOptions = { antialias: true, adaptToDeviceRatio: true, powerPreference: GPU_POWER_PREFERENCE }
  if (limits === 'max') opts.setMaximumLimits = true
  if (adapter) {
    const have = new Set(adapter.features)
    opts.deviceDescriptor = { requiredFeatures: WANTED_GPU_FEATURES.filter(f => have.has(f)) as unknown as FeatureList }
  }
  return opts
}

/** `?gpuLimits=default` → 'default', anything else → 'max'. */
export function gpuLimitsParam(search: string = typeof location === 'undefined' ? '' : location.search): GpuLimitsMode {
  return new URLSearchParams(search).get('gpuLimits') === 'default' ? 'default' : 'max'
}

/** The adapter the engine will get (Babylon requests one with the same powerPreference); null when unavailable. */
async function preQueryAdapter(): Promise<AdapterLike | null> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: { powerPreference?: string }): Promise<AdapterLike | null> } }).gpu
    return (await gpu?.requestAdapter({ powerPreference: GPU_POWER_PREFERENCE })) ?? null
  } catch {
    return null
  }
}

/**
 * Prefers WebGPU and falls back to WebGL2 (a canvas that already handed out a WebGPU context is replaced first).
 * Same logic as apps/viewer/src/engine.ts, kept separate so the two apps evolve independently. Wave 9: the WebGPU
 * device gets the adapter's full limits (unless `?gpuLimits=default`) and the wanted optional features it offers.
 */
export async function createEngine(canvas: HTMLCanvasElement, preferWebGPU = true, gpuLimits: GpuLimitsMode = gpuLimitsParam()): Promise<EngineResult> {
  let note: string | undefined
  if (!preferWebGPU) {
    note = 'WebGPU disabled by ?engine=webgl'
  } else {
    let engine: WebGPUEngine | undefined
    try {
      if (await WebGPUEngine.IsSupportedAsync) {
        const adapter = await preQueryAdapter()
        engine = new WebGPUEngine(canvas, webgpuEngineOptions(adapter, gpuLimits))
        await engine.initAsync()
        const gpu = gpuInfoFromEngine(engine, {
          isFallbackAdapter: !!(adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter),
          ...(adapter?.info?.vendor ? { vendor: adapter.info.vendor } : {}),
          ...(adapter?.info?.architecture ? { architecture: adapter.info.architecture } : {}),
        })
        return { engine, kind: 'WebGPU', canvas, gpu }
      }
      note = 'WebGPU is not available in this browser'
    } catch (err) {
      note = `WebGPU init failed: ${err instanceof Error ? err.message : String(err)}`
      try {
        engine?.dispose()
      } catch {
        // ignore: the engine never finished initialising
      }
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement
      canvas.replaceWith(fresh)
      canvas = fresh
    }
  }
  const engine = new Engine(canvas, true, webglEngineOptions(), true)
  return { engine, kind: engine.webGLVersion >= 2 ? 'WebGL2' : 'WebGL1', canvas, note, gpu: gpuInfoFromEngine(engine) }
}
