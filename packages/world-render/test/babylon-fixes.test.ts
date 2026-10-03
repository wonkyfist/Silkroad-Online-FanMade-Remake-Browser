import { NullEngine, PBRMaterial, Scene, ShaderStore } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { installShaderFixes, patchShaderSource, SHADER_PATCHES, useWindowedLightFalloff } from '../src/render/babylon-fixes.ts'
import { createPbrIce } from '../src/pbr/water-plugin.ts'

const CLUSTER = 'pbrClusteredLightingFunctions'

describe('Babylon 9.28 shader fixes (gate 2; LAB report §1.1)', () => {
  it('the clustered include of this Babylon has the sheen bug in both languages, and the patch removes it', async () => {
    await import('@babylonjs/core/ShadersWGSL/ShadersInclude/pbrClusteredLightingFunctions.js')
    await import('@babylonjs/core/Shaders/ShadersInclude/pbrClusteredLightingFunctions.js')
    installShaderFixes()
    for (const store of [ShaderStore.IncludesShadersStoreWGSL, ShaderStore.IncludesShadersStore]) {
      const src = store[CLUSTER]
      expect(src).toContain('computeClusteredLighting')
      expect(src).not.toContain('computeSheenLighting(preInfo,normalW')
      expect(src).toContain('computeSheenLighting(preInfo,N,')
    }
  })

  it('patches a source registered after the install, and leaves fixed sources alone', () => {
    installShaderFixes()
    const p = SHADER_PATCHES[0]
    const store = ShaderStore.IncludesShadersStoreWGSL
    const before = store[CLUSTER]
    store[CLUSTER] = 'x computeSheenLighting(preInfo,normalW,y) z'
    expect(store[CLUSTER]).toBe('x computeSheenLighting(preInfo,N,y) z')
    store[CLUSTER] = before
    expect(patchShaderSource('fine', p)).toBe('fine')
  })
})

describe('lamp falloff (gate 2)', () => {
  it('world PBR materials fade point lights to 0 at their range (no clustered tile-edge rectangles)', () => {
    const scene = new Scene(new NullEngine())
    const m = useWindowedLightFalloff(new PBRMaterial('m', scene))
    expect(m.useGLTFLightFalloff).toBe(true)
    expect(m.usePhysicalLightFalloff).toBe(false)
    expect(createPbrIce(scene, null).useGLTFLightFalloff).toBe(true)
    scene.getEngine().dispose()
  })
})
