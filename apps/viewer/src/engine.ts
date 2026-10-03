import { Engine, WebGPUEngine, type AbstractEngine } from '@babylonjs/core'
import { gpuInfoFromEngine, installGlErrorProbe, installLinkSettle, installVaryingBudgetCheck, type GpuInfo } from '@sro/world-render'

export type EngineKind = 'WebGPU' | 'WebGL2' | 'WebGL1'

export interface EngineResult {
  engine: AbstractEngine
  kind: EngineKind
  canvas: HTMLCanvasElement
  /** Why WebGPU was not used, if it was not. */
  note?: string
  /** Wave 9 (docs/WAVE_PLAN3.md D10): the device's limits and features and the adapter's identity. */
  gpu: GpuInfo
}

/** 'max' = the adapter's full limits (setMaximumLimits); 'default' = WebGPU's defaults (`?gpuLimits=default`). */
export type GpuLimitsMode = 'max' | 'default'

/** Optional device features used when the adapter has them (BC, ASTC and ETC2 for KTX2; timers), as the game's. */
export const WANTED_GPU_FEATURES = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2', 'timestamp-query'] as const

/** The discrete GPU on dual-GPU laptops (WebGPU requestAdapter and the WebGL2 context), as the game's. */
export const GPU_POWER_PREFERENCE = 'high-performance' as const

/** The WebGL2 fallback's engine options: HEAD's plus the high-performance GPU request. */
export function webglEngineOptions(): { stencil: boolean; adaptToDeviceRatio: boolean; powerPreference: WebGLPowerPreference } {
  return { stencil: true, adaptToDeviceRatio: true, powerPreference: GPU_POWER_PREFERENCE }
}

interface AdapterLike {
  readonly features: Iterable<string>
  readonly info?: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean }
  readonly isFallbackAdapter?: boolean
}

type WebGPUOptions = NonNullable<ConstructorParameters<typeof WebGPUEngine>[1]>
type FeatureList = NonNullable<NonNullable<WebGPUOptions['deviceDescriptor']>['requiredFeatures']>

/** The WebGPU engine options: the high-performance adapter, the limits mode and the wanted features the adapter has (as apps/game/src/engine.ts). */
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
 * Wave 9: the WebGPU device gets the adapter's full limits (unless `?gpuLimits=default`) and the wanted features.
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
        // Dev: a shader over the device's inter-stage budget drops the whole WebGPU frame (W9F BF-2).
        if (import.meta.env.DEV) installVaryingBudgetCheck(engine)
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
  // Settle each new program's link before its first draw (W9F BF-1).
  installLinkSettle()
  const engine = new Engine(canvas, true, webglEngineOptions(), true)
  // Dev: `?glprobe=1` counts the draws that raise a GL error (past Chrome's console cap): window.__sroGl.
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('glprobe') === '1') {
    Object.assign(window, { __sroGl: installGlErrorProbe(engine).stats })
  }
  return { engine, kind: engine.webGLVersion >= 2 ? 'WebGL2' : 'WebGL1', canvas, note, gpu: gpuInfoFromEngine(engine) }
}
