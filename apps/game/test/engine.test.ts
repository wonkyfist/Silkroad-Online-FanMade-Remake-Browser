/**
 * The WebGPU device request (docs/WAVE_PLAN3.md D10, docs/RENDER.md §3.5), game and viewer: the adapter's full limits
 * (setMaximumLimits; the 16-varying black-frame fix) unless `?gpuLimits=default`, and only the wanted optional features
 * the adapter has; EngineResult.gpu from the engine (gpuInfoFromEngine).
 */
import { NullEngine, type AbstractEngine } from '@babylonjs/core'
import { WEBGPU_DEFAULT_LIMITS, gpuInfoFromEngine } from '@sro/world-render'
import { describe, expect, it } from 'vitest'
import * as viewer from '../../viewer/src/engine.ts'
import * as game from '../src/engine.ts'

const adapter = (features: string[], info: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean } = {}) => ({ features: new Set(features), info })

for (const [app, m] of [['game', game], ['viewer', viewer]] as const) {
  describe(`${app} engine options`, () => {
    it('requests the full limits by default; ?gpuLimits=default keeps WebGPU\'s', () => {
      expect(m.gpuLimitsParam('')).toBe('max')
      expect(m.gpuLimitsParam('?engine=webgpu')).toBe('max')
      expect(m.gpuLimitsParam('?gpuLimits=default')).toBe('default')
      expect(m.gpuLimitsParam('?x=1&gpuLimits=default')).toBe('default')
      expect(m.webgpuEngineOptions(null, 'max').setMaximumLimits).toBe(true)
      const def = m.webgpuEngineOptions(null, 'default')
      expect('setMaximumLimits' in def).toBe(false)
      // HEAD's options stay.
      expect(def).toMatchObject({ antialias: true, adaptToDeviceRatio: true })
    })

    it('required features ⊆ the adapter features ∩ the wanted list', () => {
      const cases: string[][] = [
        [],
        ['texture-compression-bc'],
        ['timestamp-query', 'depth-clip-control'],
        ['texture-compression-bc', 'timestamp-query', 'shader-f16', 'float32-filterable'],
      ]
      for (const have of cases) {
        const req = [...(m.webgpuEngineOptions(adapter(have), 'max').deviceDescriptor?.requiredFeatures ?? [])] as string[]
        for (const f of req) {
          expect(have, `${f} offered`).toContain(f)
          expect(m.WANTED_GPU_FEATURES as readonly string[]).toContain(f)
        }
        expect(req.sort()).toEqual(have.filter(f => (m.WANTED_GPU_FEATURES as readonly string[]).includes(f)).sort())
      }
      // Without a pre-queried adapter nothing is required (Babylon's default device).
      expect(m.webgpuEngineOptions(null, 'max').deviceDescriptor).toBeUndefined()
    })

    it('asks for ASTC and ETC2 on an Apple adapter without BC, and BC alone on a PC adapter (KTX2 targets)', () => {
      const apple = ['texture-compression-astc', 'texture-compression-etc2', 'timestamp-query', 'float32-filterable']
      const req = (have: string[]) => [...(m.webgpuEngineOptions(adapter(have), 'max').deviceDescriptor?.requiredFeatures ?? [])].sort()
      expect(req(apple)).toEqual(['texture-compression-astc', 'texture-compression-etc2', 'timestamp-query'])
      expect(req(['texture-compression-bc', 'texture-compression-bc-sliced-3d'])).toEqual(['texture-compression-bc'])
      expect(req(['texture-compression-astc-hdr'])).toEqual([])
    })

    it('requests the high-performance GPU on both paths (dual-GPU laptops)', () => {
      expect(m.GPU_POWER_PREFERENCE).toBe('high-performance')
      expect(m.webgpuEngineOptions(null, 'max').powerPreference).toBe('high-performance')
      expect(m.webgpuEngineOptions(adapter([]), 'default').powerPreference).toBe('high-performance')
      // WebGL2: HEAD's options plus the context attribute.
      expect(m.webglEngineOptions()).toEqual({ stencil: true, adaptToDeviceRatio: true, powerPreference: 'high-performance' })
    })
  })
}

describe('gpuInfoFromEngine (EngineResult.gpu)', () => {
  it('WebGL / NullEngine: the caps, no features', () => {
    const e = new NullEngine()
    const g = gpuInfoFromEngine(e)
    expect(g.features).toEqual([])
    expect(g.isFallbackAdapter).toBe(false)
    expect(Number.isFinite(g.maxInterStageShaderVariables)).toBe(true)
    expect(g.maxSampledTexturesPerShaderStage).toBeGreaterThan(0)
    e.dispose()
  })

  it('WebGPU: the device limits and the enabled wanted features; the adapter facts override', () => {
    const fake = {
      isWebGPU: true,
      currentLimits: { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 48 },
      enabledExtensions: ['texture-compression-bc', 'shader-f16'],
      getInfo: () => ({ vendor: 'amd', renderer: 'rdna-4' }),
      getCaps: () => ({}),
    } as unknown as AbstractEngine
    expect(gpuInfoFromEngine(fake)).toEqual({
      maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 48, features: ['texture-compression-bc'],
      vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false,
    })
    const mac = { ...(fake as object), enabledExtensions: ['texture-compression-astc', 'texture-compression-etc2', 'timestamp-query', 'float32-filterable'] } as unknown as AbstractEngine
    expect(gpuInfoFromEngine(mac).features).toEqual(['texture-compression-astc', 'texture-compression-etc2', 'timestamp-query'])
    const def = { ...(fake as object), currentLimits: {} } as unknown as AbstractEngine
    expect(gpuInfoFromEngine(def, { isFallbackAdapter: true, architecture: 'gen-12lp' })).toMatchObject({
      maxInterStageShaderVariables: WEBGPU_DEFAULT_LIMITS.maxInterStageShaderVariables, isFallbackAdapter: true, architecture: 'gen-12lp',
    })
  })
})
