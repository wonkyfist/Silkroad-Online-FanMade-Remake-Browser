/**
 * What the renderer knows about the GPU (docs/WAVE_PLAN3.md D10, docs/RENDER.md §3.5, §10): the limits that decide
 * the prepass (inter-stage variables) and the texture budget, the optional features we requested, and the adapter's
 * identity for the first-run preset. The apps' engine.ts fill it from their adapter pre-query (EngineResult.gpu) and
 * pass it as LoadWorldOptions.gpu; otherwise it is read back from the engine. Written by W9A-S.
 */
import type { AbstractEngine } from '@babylonjs/core'

export interface GpuInfo {
  /** WebGPU `maxInterStageShaderVariables` of the device (16 = the default: no prepass with PBR + CSM). WebGL: varying vectors. */
  maxInterStageShaderVariables: number
  /** Textures one shader stage may sample (WebGPU limit; WebGL: texture image units). */
  maxSampledTexturesPerShaderStage: number
  /** Optional device features enabled (a subset of GPU_REPORTED_FEATURES); [] on WebGL. */
  features: string[]
  vendor: string
  architecture: string
  /** A software / fallback adapter (a first-run hint: stay Low). */
  isFallbackAdapter: boolean
}

/** WebGPU's default limits (what a device gets without setMaximumLimits). */
export const WEBGPU_DEFAULT_LIMITS = { maxInterStageShaderVariables: 16, maxSampledTexturesPerShaderStage: 16 } as const

/** The optional device features GpuInfo reports: the KTX2 transcode targets (BC, ASTC, ETC2) and GPU timers. */
export const GPU_REPORTED_FEATURES: readonly string[] = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2', 'timestamp-query']

/** The GpuInfo of a created engine (WebGPU: its device limits and features; WebGL: its caps). */
export function gpuInfoFromEngine(engine: AbstractEngine, extra: Partial<GpuInfo> = {}): GpuInfo {
  const e = engine as AbstractEngine & {
    isWebGPU?: boolean
    currentLimits?: Record<string, number>
    enabledExtensions?: string[]
    getInfo?: () => { vendor: string; renderer: string }
    getGlInfo?: () => { vendor: string; renderer: string }
  }
  let info: GpuInfo
  if (e.isWebGPU && e.currentLimits) {
    const l = e.currentLimits
    const i = e.getInfo?.() ?? { vendor: '', renderer: '' }
    info = {
      maxInterStageShaderVariables: l.maxInterStageShaderVariables ?? WEBGPU_DEFAULT_LIMITS.maxInterStageShaderVariables,
      maxSampledTexturesPerShaderStage: l.maxSampledTexturesPerShaderStage ?? WEBGPU_DEFAULT_LIMITS.maxSampledTexturesPerShaderStage,
      features: [...(e.enabledExtensions ?? [])].filter(f => GPU_REPORTED_FEATURES.includes(f)),
      vendor: i.vendor,
      architecture: i.renderer,
      isFallbackAdapter: false,
    }
  } else {
    const caps = engine.getCaps()
    const i = e.getGlInfo?.() ?? { vendor: '', renderer: '' }
    info = {
      maxInterStageShaderVariables: caps.maxVaryingVectors ?? 0,
      maxSampledTexturesPerShaderStage: caps.maxTexturesImageUnits ?? 16,
      features: [],
      vendor: i.vendor ?? '',
      architecture: i.renderer ?? '',
      isFallbackAdapter: false,
    }
  }
  return { ...info, ...extra }
}
