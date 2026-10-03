/**
 * Retail UV scroll (the BSR's per-second texture transform, `texAni` ModData; docs/RENDER.md §19): waterfalls
 * and other retail sheets whose texture flows. The converter writes the scroll on the sidecar material
 * (`SidecarMaterial.uvScroll` = [u, v] texture repeats per second, the D3D transform's translation rate, glTF UV space)
 * and ObjectMaterials puts this plugin on the converted material, on both paths (Classic StandardMaterial and PBR).
 *
 * The plugin adds the scroll to Babylon's `uvUpdated` in the vertex shader (`CUSTOM_VERTEX_UPDATE_WORLDPOS`, after
 * `uvUpdated = uv` and before `vMainUV1 = uvUpdated`), so every UV1 texture of the material (albedo, TX-R's maps, the
 * cut-out mask) moves together, as the retail stage-0 transform does. Why not Babylon's `uOffset` / `vOffset`: a
 * texture matrix gives the texture its own varying (`vAlbedoUV`, ...), and the lightmapped CSM receivers are at the
 * 16 inter-stage limit already (material-budgets.test.ts). This adds no varying, no sampler and one vec4 uniform.
 *
 * Time is the world clock (World hands its `serverNow`, the session's synced server time), so every client shows the
 * same phase. The phase is `fract(seconds × speed)` computed in doubles on the CPU, so the GPU never sees a large time.
 *
 * Batching (docs/BATCHING.md §3.7): a scrolling material is `separate` (batchClass): the table's atlas cells have no
 * scroll, so it keeps its converted material (a region batch's material group, or today's per-model chunk) and the
 * plugin runs. It never casts a cut-out shadow (the shadow pass alpha-tests without the plugin: the mask would stand
 * still under a moving sheet).
 */
import {
  MaterialPluginBase,
  ShaderLanguage,
  type AbstractEngine,
  type Material,
  type MaterialDefines,
  type Observer,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'

export const SRO_UV_SCROLL_PLUGIN = 'SroUvScrollPlugin'
export const UV_SCROLL_UNIFORM = 'sroUvScroll'
/** The define the plugin's code is under. */
export const UV_SCROLL_DEFINE = 'SRO_UVSCROLL'
/** Larger rates (texture repeats per second) are not a retail scroll: the sidecar value is ignored. */
export const UV_SCROLL_MAX = 16

/** A material's scroll: texture repeats per second along U and V (glTF UV space, the D3D transform's translation rate). */
export type UvScroll = readonly [number, number]

/**
 * The scroll of a sidecar material, validated: two finite numbers, |rate| ≤ UV_SCROLL_MAX, not both 0. Anything else
 * (absent, malformed) is null: no plugin, today's material.
 */
export function uvScrollOf(side: { uvScroll?: unknown } | null | undefined): UvScroll | null {
  const s = side?.uvScroll
  if (!Array.isArray(s) || s.length !== 2) return null
  const [u, v] = s as unknown[]
  if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v)) return null
  if (Math.abs(u) > UV_SCROLL_MAX || Math.abs(v) > UV_SCROLL_MAX || (u === 0 && v === 0)) return null
  return [u, v]
}

/** The UV offset at `seconds` for a rate: fract(seconds × rate) in [0, 1) (doubles; the texture wraps, so 1 = 0). */
export function uvScrollPhase(rate: number, seconds: number): number {
  const x = rate * seconds
  if (!Number.isFinite(x)) return 0
  return x - Math.floor(x)
}

const VERTEX_GLSL = /* glsl */ `
#ifdef ${UV_SCROLL_DEFINE}
#ifdef UV1
  uvUpdated += ${UV_SCROLL_UNIFORM}.xy;
#endif
#endif
`

const VERTEX_WGSL = /* wgsl */ `
#ifdef ${UV_SCROLL_DEFINE}
#ifdef UV1
  uvUpdated += uniforms.${UV_SCROLL_UNIFORM}.xy;
#endif
#endif
`

/** The vertex code of the plugin in one language (exported for the parity test). */
export function uvScrollVertexCode(language: 'glsl' | 'wgsl'): string {
  return language === 'wgsl' ? VERTEX_WGSL : VERTEX_GLSL
}

/** The world's scroll clock and the plugins it drives (one per ObjectMaterials). */
export class UvScrollShared {
  /** Seconds on the world clock, set once per frame by `tick` (0 until the first frame). */
  seconds = 0
  /** Epoch milliseconds: World hands its server clock (`serverNow`); default the local clock. */
  clock: () => number = () => Date.now()
  readonly plugins = new Set<SroUvScrollPlugin>()
  private observer: Observer<Scene> | null = null

  constructor(readonly scene: Scene) {}

  /** Reads the clock (a throwing or non-finite clock keeps the last time). */
  tick(): void {
    let ms: number
    try {
      ms = this.clock()
    } catch {
      return
    }
    if (Number.isFinite(ms)) this.seconds = ms / 1000
  }

  /** Puts the scroll on a converted material (both paths). Returns the plugin. */
  attach(mat: Material, scroll: UvScroll): SroUvScrollPlugin {
    const p = new SroUvScrollPlugin(mat, this, scroll)
    if (!this.observer) {
      this.tick()
      this.observer = this.scene.onBeforeRenderObservable.add(() => this.tick())
    }
    return p
  }

  /** Called by a plugin's dispose: the frame hook goes with the last plugin. */
  remove(p: SroUvScrollPlugin): void {
    this.plugins.delete(p)
    if (!this.plugins.size && this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer)
      this.observer = null
    }
  }

  dispose(): void {
    for (const p of [...this.plugins]) p.dispose()
    if (this.observer) this.scene.onBeforeRenderObservable.remove(this.observer)
    this.observer = null
  }
}

export class SroUvScrollPlugin extends MaterialPluginBase {
  readonly u: number
  readonly v: number

  constructor(material: Material, readonly shared: UvScrollShared, scroll: UvScroll) {
    super(material, SRO_UV_SCROLL_PLUGIN, 280, { [UV_SCROLL_DEFINE]: false }, true, true)
    this.u = scroll[0]
    this.v = scroll[1]
    shared.plugins.add(this)
  }

  override getClassName(): string {
    return 'SroUvScrollPlugin'
  }

  /** WGSL and GLSL both (the base class says GLSL only). */
  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines): void {
    ;(defines as unknown as Record<string, boolean>)[UV_SCROLL_DEFINE] = true
  }

  /** The UV offset now: [fract(t × u), fract(t × v)]. */
  offset(seconds = this.shared.seconds): [number, number] {
    return [uvScrollPhase(this.u, seconds), uvScrollPhase(this.v, seconds)]
  }

  override getUniforms(language: ShaderLanguage = ShaderLanguage.GLSL) {
    const ubo = [{ name: UV_SCROLL_UNIFORM, size: 4, type: 'vec4' }]
    if (language === ShaderLanguage.WGSL) return { ubo }
    // GLSL without uniform buffers only (the UBO path ignores this).
    return { ubo, vertex: `#ifdef ${UV_SCROLL_DEFINE}\nuniform vec4 ${UV_SCROLL_UNIFORM};\n#endif` }
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.shared.seconds
    ubo.updateFloat4(UV_SCROLL_UNIFORM, uvScrollPhase(this.u, s), uvScrollPhase(this.v, s), 0, 0)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'vertex') return null
    return { CUSTOM_VERTEX_UPDATE_WORLDPOS: uvScrollVertexCode(language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.shared.remove(this)
    super.dispose(forceDisposeTextures)
  }
}

/** The scroll plugin of a material, if it has one. */
export function uvScrollPluginOf(mat: Material | null | undefined): SroUvScrollPlugin | null {
  const p = mat?.pluginManager?.getPlugin(SRO_UV_SCROLL_PLUGIN)
  return p instanceof SroUvScrollPlugin ? p : null
}
