/**
 * Sun shafts, "godrays" (wave 12; the user: "There should also be godrays in the game especially from trees from the
 * sun"). Real shafts from the sun's cascaded shadow map, in the PBR presets' HDR post chain (render/post.ts stage
 * 'shafts', after TAA and before the default pipeline's bloom and tone map):
 *
 *   march (½ or ¼ res) ──► resolve (same res, temporal) ──► composite (full res, + scene)
 *
 * - **Where the light is.** The march reconstructs each pixel's world position from the scene's own hardware depth
 *   (the depth-stencil texture of the target the camera renders into: the first post-process's input, or the prepass
 *   MRT on High; made sampleable here on WebGL2, where it is a renderbuffer). It walks the view ray from the eye to the
 *   surface, at most to the shadow distance, reading the CSM once per step: a beam starts at every gap in a tree crown,
 *   a roof or a gate arch that the shadow map holds, whether the sun is on screen or not, and stops at the first wall
 *   behind it. Steps are spaced quadratically (dense near the eye, where beams read) and jittered per pixel
 *   (interleaved gradient noise) with a per-frame golden-ratio offset, and weighted towards the eye (exp(−3t / the
 *   longest ray): the shafts are a near-field effect, the far haze is the height fog's); the resolve blurs 3 × 3 with
 *   depth weights and blends 12–15 % of each new frame into a reprojected, neighbourhood-clamped history (ping-pong
 *   targets), so 16–24 steps look like a few hundred. The composite upsamples with depth weights, so shafts never bleed
 *   over a trunk in front of them.
 * - **An MSAA scene target** (High and Ultra in town, the town's TAA → MSAA ×4 override): WebGL2 blits its depth after
 *   the draw (`resolveMSAADepth`); WebGPU resolves sample 0 into an R32F copy each frame (`resolveDepthCopy`), because
 *   Babylon 9.28's own WebGPU depth resolve renders into the depth texture as a colour attachment (invalid).
 * - **What the shadow map does not hold** (mode 'hybrid'; 'screen' without shadows): Medium's CSM has no tree casters
 *   (foliageM 0; casting them cost +0.85 ms of GPU in the Yeoha forest on the dev GPU, and would change Medium's
 *   shadows), so on Medium the march (buildings, walls, gates, characters) gets the classic screen-space beams beside
 *   it: the march pass writes a sky mask (open sky near the sun's screen position, four depth taps per texel) and the
 *   resolve walks from each texel towards the sun over it with bilinear taps. The trees throw beams whenever the sun is
 *   on or near the screen; near pixels fade (little air in front of them), and the beams only light air the march
 *   finds in the sun (the pixel's lit share), so they never glow over a wall in its own shadow. Their history is not
 *   clamped (it has no neighbourhood to clamp to) and blends at half the rate. High and Ultra cast their trees (60 m),
 *   so the march alone does it there.
 * - **How strong** (`shaftLook`, pure): the key light's colour and irradiance as the PBR surfaces receive it (the
 *   lighting calibration's `sun`, without the lightning fill), leaning 30 % towards the sky's aerial haze colour; a
 *   forward Henyey–Greenstein phase (g 0.6, capped at 4), so beams glow towards the light and fade looking away;
 *   strongest with a low sun and gentle at noon (×0.35 above 60°); the moon's shafts at half strength at night (the key
 *   light is the moon then: dim and cold, and they cost nothing extra); denser in mist and in the humid air after rain
 *   (σ × 2 / × 1.6), weaker under overcast and in rain. **Beams, not haze** (the resolve): the march keeps only
 *   what a pixel's air has lit above 90 % of its region's lit share, so an open field or the sunlit air in front of a
 *   shaded wall adds nothing while a beam between shadows keeps its contrast (mist and the humid air after rain lower
 *   that baseline: they glow as a whole); where lit and shadowed air mix (a forest, an alley, a gate: the camera
 *   inside a forest) the dapple boost lifts them by up to 80 %. The radial walk drops by up to 90 % where its path
 *   is all open sky (no milky glow round the sun).
 * - **Presets** (render/quality.ts `lightShafts`): Low off (the Low guard: nothing is built), Medium 'low' (¼ res, 16
 *   steps ≤ 60 m, 32 radial taps), High/Ultra 'high' (½ res, 24 steps ≤ 100 m). A quality change rebuilds the post
 *   stack; time and weather only move uniforms (H9A hitch rules). Lane GODRAYS.
 */
import {
  ClusteredLightContainer,
  Constants,
  Matrix,
  PointLight,
  PostProcess,
  RawTexture,
  RenderTargetTexture,
  ShaderLanguage,
  ShaderStore,
  Texture,
  Vector3,
  Vector4,
  type Camera,
  type Effect,
  type InternalTexture,
  type Nullable,
  type Observer,
  type RenderTargetWrapper,
  type Scene,
} from '@babylonjs/core'
import type { RGB } from '../../environment.ts'
import { addWarmupHook } from '../../warmup-hooks.ts'
import type { SkyState } from '../../sky/types.ts'
import { lightShaftLevel, type LightShaftLevel, type RenderQuality } from '../quality.ts'
import type { RenderWeather } from '../weather.ts'
import { SHAFT_GLOW_LIGHTS, SHAFT_MARCH_DEFINE, SHAFT_MAX_CASCADES, SHAFT_RADIAL_DEFINE, SHAFT_SHADERS, type ShaftShaderSource } from './shaft-shaders.ts'

/**
 * 'march': the shadow-map march only (the CSM holds the trees: High, Ultra); 'hybrid': the march plus the radial walk
 * for the trees the CSM does not hold (Medium); 'screen': the radial walk only (no shadow map).
 */
export type ShaftMode = 'march' | 'hybrid' | 'screen'

/** Whether a mode runs the shadow-map march / the radial walk. */
export const shaftMarches = (m: ShaftMode) => m !== 'screen'
export const shaftRadial = (m: ShaftMode) => m !== 'march'

export interface ShaftSettings {
  /** The march's (and the history's) size as a fraction of the render size, per axis. */
  ratio: number
  /** Shadow-map steps per ray. */
  steps: number
  /** Radial samples per pixel (hybrid and screen modes). */
  radialSteps: number
  /** The longest ray (m), also capped by the shadow distance. */
  maxDistanceM: number
  /** The temporal blend: the weight of the new frame. */
  blend: number
}

/** Per level: 'low' is Medium's, 'high' High's and Ultra's. */
export const SHAFT_SETTINGS: Readonly<Record<Exclude<LightShaftLevel, 'off'>, Readonly<ShaftSettings>>> = {
  low: { ratio: 0.25, steps: 16, radialSteps: 32, maxDistanceM: 60, blend: 0.15 },
  high: { ratio: 0.5, steps: 24, radialSteps: 48, maxDistanceM: 100, blend: 0.12 },
}

export interface ShaftPlan extends ShaftSettings {
  level: Exclude<LightShaftLevel, 'off'>
  mode: ShaftMode
}

export interface ShaftPlanOptions {
  /**
   * 'auto' (default): 'march' where the CSM holds the trees (shadows.foliageM > 0), 'hybrid' where it has shadows
   * without them, 'screen' without shadows. A forced mode that needs a shadow map falls back to 'screen' without one.
   */
  mode?: 'auto' | ShaftMode
}

/** What a render block's shafts are (null: none). Pure: the post plan and the tests read it. */
export function planShafts(q: Readonly<RenderQuality>, o: ShaftPlanOptions = {}): ShaftPlan | null {
  const level = lightShaftLevel(q)
  if (level === 'off') return null
  const auto: ShaftMode = !q.shadows ? 'screen' : q.shadows.foliageM > 0 ? 'march' : 'hybrid'
  const mode = !o.mode || o.mode === 'auto' ? auto : !q.shadows ? 'screen' : o.mode
  return { level, mode, ...SHAFT_SETTINGS[level] }
}

// ---- the look (pure) -----------------------------------------------------------------------------------------------

/** The look's constants (tuned on the Jangan road, the Yeoha forest, the gate and the plaza; see the module comment). */
export const SHAFT_TUNING: Readonly<ShaftTuning> = {
  /** The added light per unit lit in-scatter, as a multiple of single scattering (pass 2: 4 → 4.5, all day). */
  gain: 4.5,
  /** In-scatter coefficient of clear air (1/m), before mist and humidity. */
  sigma: 0.005,
  /** The share of the scene fog's density that scatters into the shafts (only the part of the fog within reach). */
  fogShare: 0.35,
  /** Mist (the weather's fog) and the humid air after rain: × (1 + gain) on the light, × (1 + sigma) on σ at full. */
  mistGain: 0.1,
  mistSigma: 1,
  humidGain: 0.15,
  humidSigma: 0.6,
  /** The factor at a high sun (≥ 60°), against 1 at ≤ 10° (pass 2: 0.35 → 0.85: beams all day, not only at dawn). */
  noon: 0.85,
  /** The moon's shafts at night (the key light is the moon). */
  moon: 0.5,
  /** Henyey–Greenstein anisotropy and its share of the phase (the rest isotropic). */
  g: 0.6,
  phaseMix: 0.9,
  /** The phase towards the light at most (the forward lobe would otherwise bleach the crown around the sun). */
  phaseCap: 4,
  /** The radial walk: its weight against the march, the sun's source radius (uv), its decay per sample, near fade (1/m). */
  radialGain: 1.5,
  radialRadius: 0.35,
  radialDecay: 0.97,
  radialNear: 0.05,
  /**
   * The baseline: the march keeps only the in-scatter above `open` × the region's lit share (an open field, the lit air
   * in front of a shaded wall: the same everywhere, nothing; a beam: what it has more than the air beside it), and
   * the radial walk drops by 1 − open · (its open share)^openPower; the dapple boost where half the air is lit.
   */
  open: 0.8,
  openPower: 2,
  dapple: 0.8,
  /** Mist and the humid air after rain glow as a whole: the baseline drops by these shares at full. */
  mistOpen: 0.15,
  humidOpen: 0.15,
  /** The shafts' colour leans this far towards the sky's haze colour. */
  hazeTint: 0.3,
  /** The lantern glow's in-scatter: σ × this (the night air round a lamp reads a little hazier than the beams). */
  glow: 0.8,
}

/** The tuning before lighting pass 2 (the A/B's "before": LIGHT_LOOK.atmosphere off): dawn and dusk only. */
export const SHAFT_TUNING_V1: Readonly<ShaftTuning> = { ...SHAFT_TUNING, gain: 4, noon: 0.35, open: 0.9 }

export interface ShaftTuning {
  gain: number
  sigma: number
  fogShare: number
  mistGain: number
  mistSigma: number
  humidGain: number
  humidSigma: number
  noon: number
  moon: number
  g: number
  phaseMix: number
  phaseCap: number
  radialGain: number
  radialRadius: number
  radialDecay: number
  radialNear: number
  open: number
  openPower: number
  dapple: number
  mistOpen: number
  humidOpen: number
  hazeTint: number
  glow: number
}

export interface ShaftLookInput {
  sunElevationDeg: number
  /** The key light (SkyState.keyLight: the sun by day, the moon by night): colour and intensity in keyLight units. */
  keyColor: Readonly<RGB>
  keyIntensity: number
  /** keyLight units → the celestial light's scene-linear irradiance (WorldLighting.calibration.sun). */
  sunScale: number
  /** The sky's haze colour (SkyState.fogColor, LDR display). */
  fogColor: Readonly<RGB>
  weather: Readonly<RenderWeather>
  /** The scene's fog density (1/m; 0 without fog) and where it starts (m): only fog within 100 m adds to the shafts. */
  fogDensity: number
  fogStartM: number
}

export interface ShaftLook {
  /** Anything to add this frame (false: the passes early-out). */
  on: boolean
  /** In-scatter coefficient σ (1/m). */
  sigma: number
  /** The light added per unit in-scatter (scene-linear RGB, before the phase). */
  color: [number, number, number]
  g: number
  phaseMix: number
  phaseCap: number
  /** The radial walk (see SHAFT_TUNING). */
  radial: { gain: number; radius: number; decay: number; near: number }
  /** The baseline share (SHAFT_TUNING.open, lower in mist and after rain), its power for the radial walk, the boost. */
  open: number
  openPower: number
  dapple: number
  /** The lantern glow's σ multiple (SHAFT_TUNING.glow). */
  glow: number
  /** The factors, for the overlay and the tests: sun height, weather, mist, after-rain humidity. */
  factors: { sun: number; weather: number; mist: number; humidity: number }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** The haze tint: the fog colour in linear light, scaled to luminance 1 (a grey haze is (1, 1, 1)). */
export function hazeTint(fog: Readonly<RGB>): [number, number, number] {
  const r = Math.pow(Math.max(0, fog[0]), 2.2)
  const g = Math.pow(Math.max(0, fog[1]), 2.2)
  const b = Math.pow(Math.max(0, fog[2]), 2.2)
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (!(y > 1e-4)) return [1, 1, 1]
  return [Math.min(3, r / y), Math.min(3, g / y), Math.min(3, b / y)]
}

/** How strong and what colour the shafts are now (see the module comment). */
export function shaftLook(i: Readonly<ShaftLookInput>, t: Readonly<ShaftTuning> = SHAFT_TUNING): ShaftLook {
  const e = i.sunElevationDeg
  // The key light is the sun above −1° and the moon below −4° (sky/types.ts keyLight).
  const day = smoothstep(-4, -1, e)
  const sun = day * (1 - (1 - t.noon) * smoothstep(10, 60, e)) + (1 - day) * t.moon
  const w = i.weather
  const mist = clamp01((w.fogMul - 1) / 1.25)
  const humidity = clamp01(w.wetness - w.rain)
  const weather = (1 - 0.75 * smoothstep(0.55, 0.95, w.cloud)) * (1 - 0.85 * clamp01(w.rain)) * (1 + t.mistGain * mist + t.humidGain * humidity)
  const nearFog = Math.max(0, i.fogDensity) * clamp01(1 - Math.max(0, i.fogStartM) / 100)
  const sigma = t.sigma * (1 + t.mistSigma * mist + t.humidSigma * humidity) + t.fogShare * nearFog
  const tint = hazeTint(i.fogColor)
  // Single scattering: E · σ ∫T·V dt · p(θ), p normalised to 4π (the composite's phase is 1 for isotropic).
  const k = (t.gain * sun * weather * Math.max(0, i.keyIntensity) * Math.max(0, i.sunScale)) / (4 * Math.PI)
  const color: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) color[c] = Math.max(0, i.keyColor[c]!) * (1 + (tint[c]! - 1) * t.hazeTint) * k
  const on = Math.max(color[0], color[1], color[2]) > 1e-7 && sigma > 0
  return { on, sigma, color, g: t.g, phaseMix: t.phaseMix, phaseCap: t.phaseCap,
    radial: { gain: t.radialGain, radius: t.radialRadius, decay: t.radialDecay, near: t.radialNear },
    open: t.open * clamp01(1 - t.mistOpen * mist - t.humidOpen * humidity), openPower: t.openPower, dapple: t.dapple, glow: t.glow, factors: { sun, weather, mist, humidity } }
}

// ---- the passes ------------------------------------------------------------------------------------------------------

/** The CSM fields the march reads (Babylon 9.28 CascadedShadowGenerator; `_viewSpaceFrustumsZ` is private). */
export interface ShaftShadowSource {
  numCascades: number
  getShadowMap(): Nullable<RenderTargetTexture>
  getCascadeTransformMatrix(cascadeIndex: number): Nullable<Matrix>
}

export interface LightShaftsOptions {
  /** The sun's CSM now (null before the shadow part exists: the march then runs at strength 0). */
  shadows: () => ShaftShadowSource | null
  /** MSAA samples of the march pass's input: set where it is the camera's first post-process (the scene target). */
  samples?: number
  /** The eye adaptation the composite applies (docs/LIGHTING.md §2; null: none). */
  adapt?: () => { bindApply(e: Effect, name: string): void } | null
}

/** Babylon 9.28 PostProcess internals the depth hookup reads. */
interface PostProcessInternals {
  _forcedOutputTexture: Nullable<RenderTargetWrapper>
  _textures: { data: RenderTargetWrapper[]; length: number }
}

/** Babylon 9.28 Camera internals: the first live post-process (the scene renders into its input). */
interface CameraInternals {
  _getFirstPostProcess(): Nullable<PostProcess>
}

/** Babylon 9.28 WebGPU engine internals the MSAA depth copy uses. */
interface WebGpuInternals {
  _textureHelper?: { resolveMSAADepthTexture?(msaa: unknown, out: unknown, encoder: unknown): void }
  _renderEncoder?: unknown
  _currentRenderPass?: unknown
}

/** The private split distances of Babylon's CSM (view-space z of each cascade's far end). */
interface CsmSplits {
  _viewSpaceFrustumsZ?: ArrayLike<number>
}

const GOLDEN = 0.6180339887498949

/** The shader store entries, both languages, once per page. */
function registerShaders(): void {
  for (const s of Object.values(SHAFT_SHADERS) as ShaftShaderSource[]) {
    const key = `${s.name}FragmentShader`
    if (ShaderStore.ShadersStore[key] !== s.glsl) ShaderStore.ShadersStore[key] = s.glsl
    if (ShaderStore.ShadersStoreWGSL[key] !== s.wgsl) ShaderStore.ShadersStoreWGSL[key] = s.wgsl
  }
}

/**
 * The three post-processes on one camera (attached in order when built; RenderPost builds them between TAA and the
 * default pipeline). Per frame, RenderPost calls `setFrame` with the look and the light; everything else (the
 * matrices, the CSM, the scene depth) is read when each pass binds, so it is this frame's.
 */
export class LightShafts {
  readonly march: PostProcess
  readonly resolve: PostProcess
  readonly composite: PostProcess
  look: ShaftLook | null = null
  /** Whether the scene depth was found and bound at the last march (false: the dummy depth, nothing marched). */
  depthBound = false
  /** Whether the last march read a real shadow map. */
  shadowBound = false
  private readonly sunDir = new Vector3(0, 1, 0)
  private readonly fwd = new Vector3(0, 0, 1)
  private readonly localFwd: Vector3
  private readonly vp = new Matrix()
  private readonly invVP = new Matrix()
  private readonly prevVP = new Matrix()
  private readonly prevEye = new Vector3(NaN, NaN, NaN)
  private readonly prevFwd = new Vector3(0, 0, 1)
  private readonly tmp = new Vector3()
  private readonly splits = new Vector4(1e9, 1e9, 1e9, 1e9)
  private readonly identity = Matrix.Identity()
  private ping: RenderTargetWrapper | null = null
  private pong: RenderTargetWrapper | null = null
  /** The history pair: `read` holds last frame's resolve, `write` takes this frame's (swapHistory). */
  private read: RenderTargetWrapper | null = null
  private write: RenderTargetWrapper | null = null
  private historyValid = false
  private frame = 0
  private dummyDepth: RawTexture | null = null
  private dummyZero: RawTexture | null = null
  private dummyShadow: RenderTargetTexture | null = null
  private depthTarget: RenderTargetWrapper | null = null
  /** WebGPU MSAA: this frame's R32F copy of the scene depth (resolveDepthCopy). */
  private depthTexture: InternalTexture | null = null
  private depthCopy: RenderTargetWrapper | null = null
  private readonly observers: Array<() => void> = []
  private readonly sizeHooked = new WeakSet<PostProcess>()
  private disposed = false
  private readonly glow: GlowLight[] = Array.from({ length: SHAFT_GLOW_LIGHTS }, () => ({ x: 0, y: 0, z: 0, range: 0, r: 0, g: 0, b: 0, score: 0 }))
  /** The lantern glow (LIGHT_LOOK-style A/B; on by default). */
  glowOn = true

  constructor(readonly scene: Scene, readonly camera: Camera, readonly plan: ShaftPlan, private readonly opts: LightShaftsOptions) {
    registerShaders()
    const engine = scene.getEngine()
    const wgsl = engine.isWebGPU
    const lang = wgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL
    const half = Constants.TEXTURETYPE_HALF_FLOAT
    const defines = [shaftMarches(plan.mode) ? `#define ${SHAFT_MARCH_DEFINE}` : '', shaftRadial(plan.mode) ? `#define ${SHAFT_RADIAL_DEFINE}` : ''].filter(Boolean).join('\n')
    this.localFwd = new Vector3(0, 0, scene.useRightHandedSystem ? -1 : 1)
    const make = (s: ShaftShaderSource, size: number, defines: string) =>
      new PostProcess(s.name, s.name, {
        uniforms: [...s.uniforms],
        samplers: [...s.samplers],
        size,
        camera,
        engine,
        samplingMode: Texture.BILINEAR_SAMPLINGMODE,
        textureType: half,
        defines,
        shaderLanguage: lang,
      })
    // The march's input is the scene colour at full size (the composite reads it through setTextureFromPostProcess);
    // its output (the resolve's input) is the reduced march, and so is the resolve's (the forced history target).
    this.march = make(SHAFT_SHADERS.march, 1, defines)
    this.resolve = make(SHAFT_SHADERS.resolve, plan.ratio, defines)
    this.composite = make(SHAFT_SHADERS.composite, plan.ratio, defines)
    this.march.samples = Math.max(1, opts.samples ?? 1)
    // The resolve overwrites every texel of its input and of the history target: no clears there. The march keeps
    // Babylon's clear (as the first pass, its input is the scene target).
    this.resolve.autoClear = false
    this.composite.autoClear = false

    const on = <T>(o: { add(cb: (v: T) => void): Nullable<Observer<T>>; remove(o: Nullable<Observer<T>>): boolean }, cb: (v: T) => void) => {
      const ob = o.add(cb)
      this.observers.push(() => o.remove(ob))
    }
    on(this.march.onApplyObservable, (e: Effect) => this.bindMarch(e))
    on(this.resolve.onActivateObservable, () => this.swapHistory())
    on(this.resolve.onApplyObservable, (e: Effect) => this.bindResolve(e))
    on(this.resolve.onAfterRenderObservable, () => {
      this.historyValid = true
    })
    on(this.composite.onApplyObservable, (e: Effect) => this.bindComposite(e))
    on(this.composite.onAfterRenderObservable, () => this.endFrame())
    // The scene target gets its sampleable depth before the camera draws into it.
    on(scene.onBeforeCameraRenderObservable, (c: Camera) => {
      if (c === this.camera) this.ensureSceneDepth()
    })
    this.observers.push(addWarmupHook(scene, () => this.disposed || this.isReady()))
  }

  /** Every pass compiled (the game's warm-up waits for it). */
  isReady(): boolean {
    return this.march.isReady() && this.resolve.isReady() && this.composite.isReady()
  }

  /** The passes in chain order. */
  get postProcesses(): readonly PostProcess[] {
    return [this.march, this.resolve, this.composite]
  }

  /** Per frame (RenderPost.update): the look and the direction to the key light. */
  setFrame(look: ShaftLook, sky: Readonly<SkyState>): void {
    this.look = look
    const d = sky.keyLight.dir
    const l = Math.hypot(d.x, d.y, d.z) || 1
    this.sunDir.set(d.x / l, d.y / l, d.z / l)
  }

  /** Drops the history (a teleport, a cut): the next frame starts from its own march. */
  resetHistory(): void {
    this.historyValid = false
  }

  // ---- the scene depth -----------------------------------------------------------------------------------------------

  /** The render target the camera draws the scene into (the prepass MRT when one is linked, else the first input). */
  private sceneTargets(): RenderTargetWrapper[] {
    const first = (this.camera as unknown as CameraInternals)._getFirstPostProcess?.()
    if (!first) return []
    const pp = first as unknown as PostProcessInternals
    if (pp._forcedOutputTexture) return [pp._forcedOutputTexture]
    if (!this.sizeHooked.has(first)) {
      // The first pass makes new targets on a resize: they get their depth texture before the next draw.
      this.sizeHooked.add(first)
      const ob = first.onSizeChangedObservable.add(() => this.ensureSceneDepth())
      this.observers.push(() => first.onSizeChangedObservable.remove(ob))
    }
    const out: RenderTargetWrapper[] = []
    for (let i = 0; i < pp._textures.length; i++) if (pp._textures.data[i]) out.push(pp._textures.data[i]!)
    return out
  }

  /**
   * Gives the scene target a sampleable depth-stencil texture (WebGPU targets have one already). An MSAA target on
   * WebGL2 blits its depth into it after the draw (`resolveMSAADepth`); on WebGPU Babylon 9.28's own depth resolve
   * renders into the depth texture as a colour attachment (invalid), so `resolveDepthCopy` resolves into a copy.
   */
  ensureSceneDepth(): void {
    if (this.disposed) return
    const engine = this.scene.getEngine()
    const stencil = engine.isStencilEnable
    for (const rt of this.sceneTargets()) {
      if (!rt.depthStencilTexture) {
        try {
          rt.createDepthStencilTexture(0, false, stencil, rt.samples, stencil ? Constants.TEXTUREFORMAT_DEPTH24_STENCIL8 : Constants.TEXTUREFORMAT_DEPTH32_FLOAT, 'sroShaftsSceneDepth')
        } catch (err) {
          console.warn('[shafts] no sampleable scene depth:', err)
          continue
        }
      }
      if (rt.samples > 1 && !engine.isWebGPU) rt.resolveMSAADepth = true
    }
  }

  /** The target whose depth this frame holds (as the first pass binds it), or null. */
  private currentDepthTarget(): RenderTargetWrapper | null {
    const first = (this.camera as unknown as CameraInternals)._getFirstPostProcess?.()
    if (!first) return null
    const pp = first as unknown as PostProcessInternals
    const rt = pp._forcedOutputTexture ?? first.inputTexture ?? null
    return rt?.depthStencilTexture ? rt : null
  }

  /**
   * WebGPU, an MSAA scene target: sample 0 of its depth into an R32F copy (Babylon's resolve pipeline, the way WebGL2's
   * blit takes the first sample), encoded when no render pass is open: the march's apply, after its target is bound
   * (Babylon begins the pass at the draw). Null when that is not possible (the march then reads the dummy: no shafts).
   */
  private resolveDepthCopy(rt: RenderTargetWrapper): InternalTexture | null {
    const engine = this.scene.getEngine() as unknown as WebGpuInternals
    const depth = rt.depthStencilTexture as unknown as { _hardwareTexture?: { getMSAATexture?(samples: number): unknown } } | null
    const msaa = depth?._hardwareTexture?.getMSAATexture?.(rt.samples)
    const helper = engine._textureHelper
    if (!msaa || !helper?.resolveMSAADepthTexture || !engine._renderEncoder || engine._currentRenderPass) return null
    const w = rt.width
    const h = rt.height
    if (!this.depthCopy || this.depthCopy.width !== w || this.depthCopy.height !== h) {
      this.depthCopy?.dispose()
      this.depthCopy = this.scene.getEngine().createRenderTargetTexture({ width: w, height: h }, {
        generateMipMaps: false,
        generateDepthBuffer: false,
        generateStencilBuffer: false,
        type: Constants.TEXTURETYPE_FLOAT,
        format: Constants.TEXTUREFORMAT_R,
        samplingMode: Texture.NEAREST_SAMPLINGMODE,
        label: 'sroShaftsDepthCopy',
      })
    }
    const out = (this.depthCopy.texture as unknown as { _hardwareTexture?: { underlyingResource?: unknown } } | null)?._hardwareTexture?.underlyingResource
    if (!out) return null
    try {
      helper.resolveMSAADepthTexture(msaa, out, engine._renderEncoder)
    } catch {
      return null
    }
    return this.depthCopy.texture
  }

  /** Picks this frame's depth source (the march's apply): the target's depth texture, or the WebGPU MSAA copy. */
  private pickDepth(): void {
    const rt = this.currentDepthTarget()
    this.depthTarget = rt
    this.depthTexture = null
    if (rt && rt.samples > 1 && this.scene.getEngine().isWebGPU) {
      this.depthTexture = this.resolveDepthCopy(rt)
      if (!this.depthTexture) this.depthTarget = null
    }
  }

  private bindDepth(e: Effect): boolean {
    if (this.depthTexture) {
      e._bindTexture('sroDepth', this.depthTexture)
      return true
    }
    const rt = this.depthTarget
    if (rt) {
      e.setDepthStencilTexture('sroDepth', rt as unknown as RenderTargetTexture)
      return true
    }
    e.setTexture('sroDepth', this.depthDummy())
    return false
  }

  /** A 1 × 1 zero (no eye adaptation: 2^0). */
  private zeroDummy(): RawTexture {
    if (!this.dummyZero) {
      this.dummyZero = RawTexture.CreateRGBATexture(new Float32Array(4), 1, 1, this.scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT)
      this.dummyZero.name = 'sroShaftsNoAdapt'
    }
    return this.dummyZero
  }

  private depthDummy(): RawTexture {
    if (!this.dummyDepth) {
      this.dummyDepth = RawTexture.CreateRGBATexture(new Float32Array([1, 1, 1, 1]), 1, 1, this.scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT)
      this.dummyDepth.name = 'sroShaftsNoDepth'
    }
    return this.dummyDepth
  }

  /** A 1 × 1, one-layer comparison depth array: the march's shadow map before the CSM exists. */
  private shadowDummy(): RenderTargetTexture | null {
    if (!this.dummyShadow) {
      try {
        const t = new RenderTargetTexture('sroShaftsNoShadow', { width: 1, height: 1, layers: 1 }, this.scene, { generateMipMaps: false, generateDepthBuffer: false, type: Constants.TEXTURETYPE_UNSIGNED_BYTE })
        t.createDepthStencilTexture(Constants.LESS, true, false, 1, Constants.TEXTUREFORMAT_DEPTH32_FLOAT)
        this.dummyShadow = t
      } catch {
        return null
      }
    }
    return this.dummyShadow
  }

  // ---- per pass ------------------------------------------------------------------------------------------------------

  private viewState(): Vector3 {
    this.vp.copyFrom(this.scene.getTransformMatrix())
    this.vp.invertToRef(this.invVP)
    this.camera.getDirectionToRef(this.localFwd, this.fwd)
    return this.camera.globalPosition
  }

  private bindMarch(e: Effect): void {
    const look = this.look
    const plan = this.plan
    const eye = this.viewState()
    this.pickDepth()
    this.depthBound = this.bindDepth(e)
    const shadows = this.opts.shadows()
    const map = shadows?.getShadowMap() ?? null
    let cascades = 0
    if (shaftMarches(plan.mode)) {
      const csm = shadows as unknown as CsmSplits | null
      const z = csm?._viewSpaceFrustumsZ
      cascades = map && z ? Math.min(SHAFT_MAX_CASCADES, shadows!.numCascades, z.length) : 0
      if (cascades > 0) {
        e.setDepthStencilTexture('sroShadowMap', map)
        for (let i = 0; i < SHAFT_MAX_CASCADES; i++) {
          const m = shadows!.getCascadeTransformMatrix(Math.min(i, cascades - 1))
          e.setMatrix(`sroLightMat${i}`, m ?? this.identity)
        }
        const s = this.splits
        s.set(z![0] ?? 1e9, cascades > 1 ? z![1]! : 1e9, cascades > 2 ? z![2]! : 1e9, cascades > 3 ? z![3]! : 1e9)
      } else {
        const d = this.shadowDummy()
        if (d) e.setDepthStencilTexture('sroShadowMap', d)
        for (let i = 0; i < SHAFT_MAX_CASCADES; i++) e.setMatrix(`sroLightMat${i}`, this.identity)
        this.splits.set(1e9, 1e9, 1e9, 1e9)
      }
      this.shadowBound = cascades > 0
    }
    // The march waits for the CSM (its first frames); the radial walk does not need it.
    const live = !!look?.on && this.depthBound && (shaftRadial(plan.mode) || cascades > 0)
    e.setMatrix('sroInvViewProj', this.invVP)
    e.setFloat4('sroEye', eye.x, eye.y, eye.z, plan.maxDistanceM)
    e.setFloat4('sroFwd', this.fwd.x, this.fwd.y, this.fwd.z, plan.steps)
    e.setFloat4('sroCam', this.camera.minZ, this.camera.maxZ || 1e6, (this.frame * GOLDEN) % 1, live ? 1 : 0)
    e.setVector4('sroSplits', this.splits)
    // No CSM yet (the hybrid's first frames): σ 0, so the march adds nothing and leaves the radial walk ungated.
    e.setFloat4('sroMarch', cascades > 0 ? look?.sigma ?? 0 : 0, Math.max(1, cascades), Math.max(1, this.resolve.width), Math.max(1, this.resolve.height))
    this.bindSun(e, eye)
  }

  /**
   * The radial walk's sun: its uv, how on screen it is (fading out 0.9 → 1.6 NDC from the centre; 0 behind the camera),
   * the decay per sample; the source's 1 / radius² in aspect-corrected uv, the aspect, the near fade, the samples.
   */
  private bindSun(e: Effect, eye: Vector3): void {
    if (!shaftRadial(this.plan.mode)) {
      e.setFloat4('sroSun', 0, 0, 0, 0)
      e.setFloat4('sroRadial', 0, 1, 0, 1)
      return
    }
    const r = this.look?.radial
    const p = this.tmp.copyFrom(this.sunDir).scaleInPlace(1000).addInPlace(eye)
    const m = this.vp.m
    const x = m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!
    const y = m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!
    const w = m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!
    const aspect = Math.max(1, this.march.width) / Math.max(1, this.march.height)
    const radius = Math.max(0.01, r?.radius ?? 0.3)
    e.setFloat4('sroRadial', 1 / (radius * radius), aspect, r?.near ?? 0.05, this.plan.radialSteps)
    if (!(w > 1e-3)) {
      e.setFloat4('sroSun', 0.5, 0.5, 0, 0.96)
      return
    }
    const nx = x / w
    const ny = y / w
    const edge = Math.max(Math.abs(nx), Math.abs(ny))
    const weight = 1 - smoothstep(0.9, 1.6, edge)
    e.setFloat4('sroSun', nx * 0.5 + 0.5, ny * 0.5 + 0.5, weight, r?.decay ?? 0.96)
  }

  /**
   * Before the resolve draws (once per frame): last frame's output becomes this frame's history, the other target this
   * frame's output (the composite's input).
   */
  private swapHistory(): void {
    const w = Math.max(1, this.resolve.width)
    const h = Math.max(1, this.resolve.height)
    if (!this.ping || !this.pong || this.ping.width !== w || this.ping.height !== h) this.makeHistory(w, h)
    this.read = this.write
    this.write = this.read === this.ping ? this.pong : this.ping
    this.composite.inputTexture = this.write!
  }

  private makeHistory(w: number, h: number): void {
    this.ping?.dispose()
    this.pong?.dispose()
    const engine = this.scene.getEngine()
    const opts = (label: string) => ({
      generateMipMaps: false,
      generateDepthBuffer: false,
      generateStencilBuffer: false,
      type: Constants.TEXTURETYPE_HALF_FLOAT,
      format: Constants.TEXTUREFORMAT_RGBA,
      samplingMode: Texture.BILINEAR_SAMPLINGMODE,
      label,
    })
    this.ping = engine.createRenderTargetTexture({ width: w, height: h }, opts('sroShaftsHistoryA'))
    this.pong = engine.createRenderTargetTexture({ width: w, height: h }, opts('sroShaftsHistoryB'))
    this.write = this.pong
    this.read = null
    this.historyValid = false
  }

  private bindResolve(e: Effect): void {
    const eye = this.viewState()
    const cut = !(Vector3.DistanceSquared(eye, this.prevEye) < 25) || Vector3.Dot(this.fwd, this.prevFwd) < 0.8
    const reset = !this.historyValid || cut
    if (this.read?.texture) e._bindTexture('sroHistory', this.read.texture)
    e.setMatrix('sroInvViewProj', this.invVP)
    e.setMatrix('sroPrevViewProj', reset ? this.vp : this.prevVP)
    e.setFloat4('sroEye', eye.x, eye.y, eye.z, 0)
    e.setFloat4('sroFwd', this.fwd.x, this.fwd.y, this.fwd.z, 0)
    e.setFloat4('sroResolve', this.plan.blend, reset ? 1 : 0, 0.15, (this.frame * GOLDEN) % 1)
    const look = this.look
    // The regional window's ring radius in texels: the same ~16 px of the render on every level.
    e.setFloat4('sroShape', look?.open ?? 0, look?.dapple ?? 0, Math.max(0.5, look?.openPower ?? 2), Math.max(2, Math.round(16 * this.plan.ratio)))
    this.bindSun(e, eye)
  }

  private bindComposite(e: Effect): void {
    const look = this.look
    const eye = this.viewState()
    e.setTextureFromPostProcess('sroScene', this.march)
    const adapt = this.opts.adapt?.() ?? null
    if (adapt) adapt.bindApply(e, 'sroAdaptTex')
    else e.setTexture('sroAdaptTex', this.zeroDummy())
    this.bindDepth(e)
    const live = !!look?.on && this.depthBound
    e.setMatrix('sroInvViewProj', this.invVP)
    e.setFloat4('sroEye', eye.x, eye.y, eye.z, 0)
    e.setFloat4('sroFwd', this.fwd.x, this.fwd.y, this.fwd.z, 0)
    e.setFloat4('sroCam', this.camera.minZ, this.camera.maxZ || 1e6, look?.radial.gain ?? 0, live ? 1 : 0)
    e.setFloat4('sroSunDir', this.sunDir.x, this.sunDir.y, this.sunDir.z, 0)
    const c = look?.color ?? [0, 0, 0]
    e.setFloat4('sroShaftColor', c[0], c[1], c[2], 0)
    e.setFloat4('sroPhase', look?.g ?? 0, look?.phaseMix ?? 0, look?.phaseCap ?? 1, 0)
    this.bindGlow(e, eye)
  }

  /** Lantern glow (docs/LIGHTING.md §3): the strongest lit point lights near the eye, as the composite's uniforms. */
  private bindGlow(e: Effect, eye: Vector3): void {
    const n = this.depthBound && this.glowOn ? pickGlowLights(this.scene, eye, this.glow) : 0
    const k = ((this.look?.sigma ?? SHAFT_TUNING.sigma) * (this.look?.glow ?? SHAFT_TUNING.glow)) / (4 * Math.PI)
    e.setFloat4('sroGlow', n, k, 0, 0)
    for (let i = 0; i < SHAFT_GLOW_LIGHTS; i++) {
      const g = this.glow[i]!
      e.setFloat4(`sroGlowP${i}`, g.x, g.y, g.z, g.range)
      e.setFloat4(`sroGlowC${i}`, g.r, g.g, g.b, 0)
    }
  }

  private endFrame(): void {
    this.prevVP.copyFrom(this.vp)
    this.prevEye.copyFrom(this.camera.globalPosition)
    this.prevFwd.copyFrom(this.fwd)
    this.frame++
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.observers.splice(0)) off()
    this.composite.restoreDefaultInputTexture()
    this.march.dispose(this.camera)
    this.resolve.dispose(this.camera)
    this.composite.dispose(this.camera)
    this.ping?.dispose()
    this.pong?.dispose()
    this.ping = this.pong = this.read = this.write = null
    this.dummyDepth?.dispose()
    this.dummyZero?.dispose()
    this.dummyZero = null
    this.dummyShadow?.dispose()
    this.dummyDepth = null
    this.dummyShadow = null
    this.depthTarget = null
    this.depthTexture = null
    this.depthCopy?.dispose()
    this.depthCopy = null
  }
}

/** One lantern-glow light (world position, range, scene-linear colour × intensity, its pick score). */
export interface GlowLight { x: number; y: number; z: number; range: number; r: number; g: number; b: number; score: number }

/**
 * The lights that glow in the air: the night lamps and fires (night-lights.ts 'nl:') and the town's lanterns
 * (town/props.ts). Hit flashes and spell lights do not (a white fog ball on every hit).
 */
export const GLOW_SOURCE = /^(nl:|town:lantern)/

/** Lights farther than this from the eye never glow (m). */
export const GLOW_MAX_M = 80

/**
 * Fills `out` with the lit point lights that matter most to the eye (intensity / (d² + range²), within GLOW_MAX_M):
 * the scene's PointLights and those of its clustered containers (the night lights, the hit flashes). Returns the count.
 */
export function pickGlowLights(scene: Scene, eye: { x: number; y: number; z: number }, out: GlowLight[]): number {
  let n = 0
  const consider = (l: PointLight) => {
    if (!(l.intensity > 0) || !(l.range > 0.5) || !GLOW_SOURCE.test(l.name) || !l.isEnabled()) return
    const p = l.getAbsolutePosition()
    const dx = p.x - eye.x
    const dy = p.y - eye.y
    const dz = p.z - eye.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 > GLOW_MAX_M * GLOW_MAX_M) return
    const range = Math.min(l.range, 30)
    const score = l.intensity / (d2 + range * range)
    let i: number
    if (n < out.length) i = n++
    else if (out[n - 1]!.score >= score) return
    else i = n - 1
    while (i > 0 && out[i - 1]!.score < score) {
      Object.assign(out[i]!, out[i - 1]!)
      i--
    }
    const g = out[i]!
    g.x = p.x
    g.y = p.y
    g.z = p.z
    g.range = range
    g.r = l.diffuse.r * l.intensity
    g.g = l.diffuse.g * l.intensity
    g.b = l.diffuse.b * l.intensity
    g.score = score
  }
  for (const l of scene.lights) {
    if (l instanceof PointLight) consider(l)
    else if (l instanceof ClusteredLightContainer) for (const c of l.lights) if (c instanceof PointLight) consider(c)
  }
  return n
}

/** For the perf overlay and the lab: what the shafts drew from last frame. */
export function shaftsState(s: LightShafts | null): { mode: ShaftMode | 'off'; level: LightShaftLevel; depth: boolean; shadow: boolean; on: boolean } {
  if (!s) return { mode: 'off', level: 'off', depth: false, shadow: false, on: false }
  return { mode: s.plan.mode, level: s.plan.level, depth: s.depthBound, shadow: s.shadowBound, on: !!s.look?.on }
}

