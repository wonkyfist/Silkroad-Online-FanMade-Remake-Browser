/**
 * Fixes for Babylon 9.28 behaviour the wave-9A lab and gate 2 found (work/tmp/w9a-lab-report.md §1): shader patches,
 * applied to the shader store once before the first material that needs them compiles, and the lamp falloff helper.
 *
 * - **Sheen × clustered lights.** The PBR clustered-light include (`pbrClusteredLightingFunctions`, WGSL and GLSL)
 *   calls `computeSheenLighting(preInfo, normalW, …)`, but inside `computeClusteredLighting` the normal is the
 *   parameter `N`. With a ClusteredLightContainer in the scene (NL, Medium+) every material with sheen (RND-M's cloth
 *   class) fails to compile; on WebGPU the invalid pipeline inside the prepass pass drops the whole command buffer, so
 *   every frame is black, at noon too.
 *
 * The store entries are wrapped in an accessor that patches whatever is written, so the fix holds whether Babylon's
 * include module registers itself before or after this runs (it is loaded lazily on the first PBR compile). Only
 * clustered PBR shaders read the patched include: the Classic path and the Low guard never see it.
 */
import { Effect, ShaderStore, type PBRMaterial } from '@babylonjs/core'

interface ShaderPatch {
  name: string
  from: string
  to: string
}

/** Every patch, both languages (the include text is identical in the two stores for these lines). */
export const SHADER_PATCHES: readonly ShaderPatch[] = [
  { name: 'pbrClusteredLightingFunctions', from: 'computeSheenLighting(preInfo,normalW', to: 'computeSheenLighting(preInfo,N' },
]

let installed = false

/** Applies a patch to one include's source (unchanged when the bug is not there, e.g. a fixed Babylon). */
export function patchShaderSource(src: string, p: Readonly<ShaderPatch>): string {
  return src.includes(p.from) ? src.split(p.from).join(p.to) : src
}

function wrap(store: Record<string, string>, p: Readonly<ShaderPatch>): void {
  let value: string | undefined = store[p.name] === undefined ? undefined : patchShaderSource(store[p.name], p)
  Object.defineProperty(store, p.name, {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (v: string) => { value = typeof v === 'string' ? patchShaderSource(v, p) : v },
  })
}

let effectFixInstalled = false

/**
 * W9F LEAK-2: the page engine keeps every compiled Effect (engine._compiledEffects) for the rest of the page, and a PBR
 * Effect keeps `_processCodeAfterIncludes`, the MaterialPluginManager's code-injection closure of the material that
 * first compiled it: manager → material → scene, and → plugins → their shared state (TerrainPbr → SharedUniforms →
 * TerrainRenderer → WorldRender → World). So every Modern visit that compiled a new variant stayed reachable after
 * World.dispose + Scene.dispose. Babylon reads that closure (and `_processFinalCode`) only while it processes the
 * source, before the first `_prepareEffect`; context restores and fallbacks rebuild from the processed source. So they
 * are dropped once the source is processed: a cached Effect then keeps only its code and program.
 *
 * WebGL only (W9F final gate): on WebGPU, dropping them made about a third of the PBR variants with the wetness,
 * shelter and surface plugins build a render pipeline whose bind-group layout did not match its WGSL (a vertex-stage
 * uniform buffer at a binding the layout had as a sampler: "Binding type in the shader (buffer) doesn't match the type
 * in the layout (sampler)"), so the prepass render encoder was invalid and High and Ultra drew a black frame. Until
 * the WebGPU path is understood the WebGPU Effects keep their closures (the LEAK-2 retention stays there).
 */
export function installEffectCacheFix(): void {
  if (effectFixInstalled) return
  effectFixInstalled = true
  const proto = Effect.prototype as unknown as {
    _prepareEffect(keepExistingPipelineContext?: boolean): void
    _processCodeAfterIncludes?: unknown
    _processFinalCode?: unknown
  }
  const prepare = proto._prepareEffect
  proto._prepareEffect = function (this: typeof proto & { _engine?: { isWebGPU?: boolean } }, keepExistingPipelineContext?: boolean) {
    if (!this._engine?.isWebGPU) {
      this._processCodeAfterIncludes = undefined
      this._processFinalCode = null
    }
    return prepare.call(this, keepExistingPipelineContext)
  }
}

/** Installs every patch into both shader stores; idempotent. */
export function installShaderFixes(): void {
  if (installed) return
  installed = true
  for (const p of SHADER_PATCHES) {
    wrap(ShaderStore.IncludesShadersStoreWGSL, p)
    wrap(ShaderStore.IncludesShadersStore, p)
  }
}

/**
 * Windowed (glTF) point-light falloff for a world PBR material (gate 2). PBR's default physical falloff (1 / d²) never
 * reaches 0, but a ClusteredLightContainer shades a light only in the screen tiles its range covers, so every lamp's
 * light stopped at a tile edge: lit screen-space rectangles on the ground at night. The glTF falloff is 1 / d² faded to
 * 0 at the range. The sun and the hemispheric fill are not point lights and do not change.
 */
export function useWindowedLightFalloff(m: PBRMaterial): PBRMaterial {
  m.useGLTFLightFalloff = true
  return m
}
