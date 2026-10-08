/**
 * The post stack of the PBR presets (docs/RENDER.md §5, docs/WAVE_PLAN3.md §6.13, D17, D18, D26, D30, D31): HDR,
 * tone mapping (KHR PBR Neutral by default, ACES "filmic" as a live option), exposure from the SkyState, the LUT grade,
 * bloom, SSAO, SSR, TAA, the sun shafts (wave 12, render/volumetrics), FSR1, and the height fog's per-frame numbers. `RenderPost` is WorldRender's
 * `post` part (`installRenderPost`): it builds the stack on setMode / setQuality / attachCamera and tears it down
 * before each rebuild. Low (the Classic path) builds nothing and leaves the scene's image processing as it was.
 *
 * The stack, in attach order (Babylon applies attached post-processes in that order):
 *
 *   [FSR1 upscale + sharpen]  render scale < 1, only without prepass stages (below)
 *   [SSAO2, prepass]          High (half res, 8 samples), Ultra (full res, 16)
 *   [SSR, prepass]            Ultra always; High gated on puddles > 0.1 (below)
 *   [TAA]                     High, Ultra (D30; reprojection is off by default, see below)
 *   [shafts]                  Medium ('low': ¼ res), High/Ultra ('high': ½ res): march → resolve → composite, in HDR
 *   Default: bloom → image processing (exposure, tone map, contrast, LUT, dither) → FXAA (Medium) → sharpen (TAA)
 *
 * Deviation from RENDER §5.1's order, forced by Babylon 9.28:
 * - FSR1 goes **first**: its upscale pass is sized 1/scale, and the camera renders into the first post-process's input,
 *   so only as the first stage does the scene render at the reduced size. Behind a prepass stage it would upscale an
 *   already full-size image, so with SSAO/SSR/TAA on it is skipped (render scale < 1 is a Medium-on-iGPU default).
 *
 * Wave 12 (GODRAYS): the shafts replace the Ultra-only VolumetricLightScatteringPostProcess, which never ran on WebGPU
 * (it threw in createBindGroup every frame, gate 2) and drew after the tone map in RGBA8. They run in HDR before the
 * default pipeline, so bloom and the tone map see them like any light. They read the scene's hardware depth, so the
 * scene target gets a sampleable depth texture (shafts.ts `ensureSceneDepth`); when the shafts are the first stage
 * (Medium), they take the plan's MSAA samples in place of the default pipeline.
 *
 * TAA reprojection (D30: `disableOnCameraMove = false` + `reprojectHistory` + the prepass velocity) is behind
 * `RenderPostOptions.taaReprojection`, off by default: on WebGPU with our thin-instanced world objects it produced an
 * invalid render pipeline and a black frame (Babylon 9.28: "Vertex attribute slot 11 … is not present in the
 * VertexState", the previous-world instance matrices of the velocity pass; measured in the RND-P harness). Without
 * it TAA jitters the projection matrix (so the grass ShaderMaterial is jittered too and `taaJitter` stays 0) and
 * keeps Babylon's `disableOnCameraMove = true`: no ghosting, but no anti-aliasing while the camera moves.
 * LAB decides D30 once reprojection renders; the scope-cut fallback is MSAA ×4.
 *
 * Wave 11 (W11-S, docs/WAVE_PLAN7.md D4; TOWN_LIFE G5-11): `setTemporalOverride(owner, 'msaa4')` swaps a TAA preset's
 * TAA for MSAA ×4 while any owner asks (the town's walking crowd smears under TAA without reprojection); 'none' takes
 * the owner's request back. No owner: today's plan. A preset without TAA is unchanged either way. The requests live on
 * this RenderPost: a path switch makes a new one, and the owner (the town part, made again too) asks again.
 *
 * Hitch rules (H9A lens 7): weather and time never change a define here. SSR on High stays attached and is gated by
 * its reflectivity threshold and strength (uniforms), because detaching it would drop the prepass reflectivity target
 * and recompile every material. The image processing of the post stack uses its own ImageProcessingConfiguration, not
 * the scene's: the scene configuration is observed by every material, and an exposure change on it would mark ~2,000
 * materials dirty each frame. The scene configuration only gets `applyByPostProcess = true` (D18) on PBR presets.
 * Lane RND-P.
 */
import {
  Color3,
  Constants,
  DefaultRenderingPipeline,
  FSR1RenderingPipeline,
  ImageProcessingConfiguration,
  PassPostProcess,
  SSAO2RenderingPipeline,
  SSRRenderingPipeline,
  TAARenderingPipeline,
  type AbstractMesh,
  type Camera,
  type CubeTexture,
  type Nullable,
  type Observer,
  type Scene,
} from '@babylonjs/core'
import { HeightFog } from '../pbr/fog-plugin.ts'
import type { SkyState } from '../sky/types.ts'
import type { GpuInfo } from './gpu.ts'
import { EXPOSURE_TRIM, setSceneDisplay } from './display.ts'
import { GradeMixer, loadLutStrips } from './grade.ts'
import type { RenderPart, WorldRender } from './index.ts'
import { BLOOM_WEIGHT, lightShaftLevel, type AntiAliasing, type RenderPath, type RenderQuality, type ToneMap } from './quality.ts'
import { CLEAR_RENDER_WEATHER, type RenderWeather } from './weather.ts'
import { LightShafts, SHAFT_TUNING, SHAFT_TUNING_V1, planShafts, shaftLook, type ShaftMode, type ShaftPlan, type ShaftShadowSource, type ShaftTuning } from './volumetrics/shafts.ts'
import { EyeAdaptation } from './adaptation.ts'
import { LIGHT_LOOK } from './look.ts'
import { atmosphereLook } from './atmosphere.ts'
import { DEFAULT_HEIGHT_FALLOFF_M } from '../pbr/fog-plugin.ts'

export type PostStage = 'fsr' | 'ssao' | 'ssr' | 'taa' | 'shafts' | 'adapt' | 'default'

/** The fixed stage order (see the file comment; 'adapt' = eye adaptation, render/adaptation.ts). */
export const POST_STAGE_ORDER: readonly PostStage[] = ['fsr', 'ssao', 'ssr', 'taa', 'shafts', 'adapt', 'default']

/**
 * Prepass stages (SSAO, SSR, TAA reprojection) need more than WebGPU's default 16 inter-stage variables (RENDER §3.5).
 * Chrome counts the built-in `front_facing` (every PBR fragment reads it), `sample_index` and an input `sample_mask`
 * on top of the user varyings: a lit PBR CSM receiver is 15 + front_facing = 16 at Medium (Babylon's WGSL light
 * declaration always unrolls 4 cascades), and the prepass adds vViewPos (17). Treat 16 as full: on a 16-varying
 * adapter no lit PBR material may gain a varying (vertex colours, Babylon fog next to the height fog, tangents, clip
 * planes), or the pipeline is invalid and WebGPU drops the whole frame (W9F BF-2; gpu-guards.ts checks it in dev).
 */
export const MIN_PREPASS_VARYINGS = 17

/** RenderPost.repairPrepass: re-reads in a row before it leaves a prepass that will not come back on alone. */
export const PREPASS_REPAIRS_MAX = 3

/** What the stack of one preset is, before any GPU object exists (pure: the post test checks it). */
export interface PostPlan {
  /** The stages in attach order; empty = nothing is built (Low, or no HDR). */
  stages: PostStage[]
  /** Any prepass stage (SSAO, SSR, TAA). */
  prepass: boolean
  /** The AA actually used (TAA falls back to MSAA ×4 without a prepass, D30). */
  aa: AntiAliasing
  /** MSAA samples of the scene target (1 = off). */
  msaa: number
  fxaa: boolean
  /** The sharpen pass (with TAA). */
  sharpen: boolean
  /** TAA reprojects its history with the prepass velocity (moving camera kept). */
  taaReprojection: boolean
  /** Bloom scale (0 = off). */
  bloom: number
  /** Where bloom starts (RenderQuality.bloomThreshold; null = the shipped rule, see bloomCutoff). */
  bloomThreshold: number | null
  bloomWeight: number
  toneMap: ToneMap
  lutGrade: boolean
  ssao: { ratio: number; samples: number } | null
  ssr: 'off' | 'puddles' | 'always'
  /** FSR1 scale factor (1 / render scale), 0 = no FSR. */
  fsrScale: number
  /** The sun shafts (render/volumetrics/shafts.ts), null = none. */
  shafts: ShaftPlan | null
  /** Eye adaptation (render/adaptation.ts): the bounded auto exposure after the shafts. */
  adapt: boolean
  /** Why a stage the preset asks for was dropped (for the perf overlay and logs). */
  dropped: string[]
}

export interface PlanOptions {
  /** Render scale (default the preset's). */
  renderScale?: number
  /** W11-S (D4): 'msaa4' swaps the preset's TAA for MSAA ×4 (RenderPost.setTemporalOverride); absent or null: none. */
  temporal?: 'msaa4' | null
  /** The Options tone map (null: the preset's). */
  toneMap?: ToneMap | null
  /** TAA with reprojection (a prepass stage); default false (see the file comment). */
  taaReprojection?: boolean
  /** SSAO where the preset asks for it (default true here; RenderPost passes its `ssao` option, default false). */
  ssao?: boolean
  /** Sun shafts where the block asks for them (default true; false drops them: the lab's A/B, RenderPostOptions). */
  lightShafts?: boolean
  /** The shafts' path: 'auto' (volumetrics/shafts.ts planShafts: march, hybrid or screen), or forced (the lab). */
  shaftsMode?: 'auto' | ShaftMode
  /** Eye adaptation where the block asks for it (default true; false: the A/B, LIGHT_LOOK.eyeAdaptation). */
  eyeAdaptation?: boolean
}

/** The stack of a preset on this GPU (see the file comment for the rules). */
export function planPost(mode: RenderPath, q: Readonly<RenderQuality>, gpu: Readonly<GpuInfo>, o: PlanOptions = {}): PostPlan {
  const plan: PostPlan = {
    stages: [], prepass: false, aa: q.aa, msaa: 1, fxaa: false, sharpen: false, taaReprojection: false, bloom: 0, bloomThreshold: null,
    bloomWeight: BLOOM_WEIGHT, toneMap: 'none',
    lutGrade: false, ssao: null, ssr: 'off', fsrScale: 0, shafts: null, adapt: false, dropped: [],
  }
  if (mode !== 'pbr' || !q.hdr) return plan
  const prepassOk = gpu.maxInterStageShaderVariables >= MIN_PREPASS_VARYINGS
  const why = `prepass needs ${MIN_PREPASS_VARYINGS} inter-stage variables (GPU: ${gpu.maxInterStageShaderVariables})`
  const scale0 = o.renderScale ?? q.renderScale
  if (q.ssao?.optional && scale0 < 1) plan.dropped.push('ssao: optional, render scale < 1 keeps FSR')
  else if (q.ssao && o.ssao === false) plan.dropped.push('ssao: off (RenderPostOptions.ssao)')
  else if (q.ssao) {
    if (prepassOk) plan.ssao = { ratio: q.ssao.halfRes ? 0.5 : 1, samples: q.ssao.samples }
    else plan.dropped.push(`ssao: ${why}`)
  }
  if (q.ssr !== 'off') {
    if (prepassOk) plan.ssr = q.ssr
    else plan.dropped.push(`ssr: ${why}`)
  }
  const reproject = o.taaReprojection ?? false
  // W11-S (D4): an owner's temporal override replaces TAA with MSAA x4 (before the reprojection rule reads plan.aa).
  if (q.aa === 'taa' && o.temporal === 'msaa4') {
    plan.aa = 'msaa'
    plan.dropped.push('taa → msaa x4: temporal override')
  }
  if (plan.aa === 'taa' && reproject && !prepassOk) {
    plan.aa = 'msaa'
    plan.dropped.push(`taa → msaa x4: ${why}`)
  }
  plan.taaReprojection = plan.aa === 'taa' && reproject
  plan.prepass = plan.ssao !== null || plan.ssr !== 'off' || plan.taaReprojection
  const scale = o.renderScale ?? q.renderScale
  if (scale < 1) {
    if (plan.prepass) plan.dropped.push('fsr: the scene renders into the prepass at full size (render scale ignored)')
    else plan.fsrScale = 1 / Math.max(0.25, scale)
  }
  plan.msaa = plan.aa === 'msaa' ? 4 : 1
  plan.fxaa = plan.aa === 'fxaa'
  plan.sharpen = plan.aa === 'taa'
  plan.bloom = q.bloom
  plan.bloomThreshold = q.bloomThreshold ?? null
  plan.bloomWeight = q.bloomWeight ?? BLOOM_WEIGHT
  const tm = o.toneMap ?? q.toneMap
  plan.toneMap = tm
  plan.lutGrade = q.lutGrade
  if (lightShaftLevel(q) !== 'off') {
    if (o.lightShafts === false) plan.dropped.push('shafts: off (RenderPostOptions.lightShafts)')
    else plan.shafts = planShafts(q, { mode: o.shaftsMode })
  }
  if (q.eyeAdaptation) {
    if (o.eyeAdaptation === false) plan.dropped.push('adapt: off (LIGHT_LOOK.eyeAdaptation)')
    else plan.adapt = true
  }
  const has: Record<PostStage, boolean> = {
    fsr: plan.fsrScale > 0, ssao: plan.ssao !== null, ssr: plan.ssr !== 'off', taa: plan.aa === 'taa', shafts: plan.shafts !== null, adapt: plan.adapt, default: true,
  }
  plan.stages = POST_STAGE_ORDER.filter(s => has[s])
  return plan
}

/** W11-S (D4): a temporal override request: 'msaa4' while the owner's content smears under TAA, 'none' to take it back. */
export type TemporalOverride = 'none' | 'msaa4'

/** The display-luminance threshold the presets shipped with (see bloomCutoff). */
export const LEGACY_BLOOM_THRESHOLD = 0.9

/**
 * The DefaultRenderingPipeline bloomThreshold for a plan's threshold at this exposure. Babylon 9.28's highlight pass
 * compares the scene-linear luminance (before our exposure) with pow(bloomThreshold, 1 / 2.2), so:
 * - a RenderQuality.bloomThreshold T (tone-map input luminance) becomes pow(T / exposure, 2.2): the cutoff is T after
 *   the exposure, by day and by night alike;
 * - null keeps the rule the presets shipped with (Options → Bloom → Strong): 0.9 / exposure, which that gamma turns
 *   into a cutoff of 0.9^0.45 × exposure^0.55 after the exposure (≈ 3.5 at noon, ≈ 12 at night).
 */
export function bloomCutoff(threshold: number | null, exposure: number): number {
  const e = Math.max(1e-3, exposure)
  return threshold === null ? LEGACY_BLOOM_THRESHOLD / e : Math.pow(threshold / e, 2.2)
}

/** Babylon's tone-map constant for ours. */
export function toneMappingType(t: ToneMap): number {
  return t === 'filmic' ? ImageProcessingConfiguration.TONEMAPPING_ACES : ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL
}

/** The SSR setup of RENDER §5.4 (the prepass path; masked by the surface/terrain plugins, D31). */
export const SSR_SETTINGS = {
  ssrDownsample: 1, blurDownsample: 1, maxSteps: 48, step: 2, maxDistance: 60, thickness: 0.3, reflectivityThreshold: 0.05,
} as const
/** SSR "off" on High while dry: every pixel under the threshold is skipped (reflectivity is RGBA8 ≤ 1). */
export const SSR_GATED_THRESHOLD = 1
/** Puddle hysteresis for SSR on High (on above, off below). */
export const SSR_PUDDLES_ON = 0.1
export const SSR_PUDDLES_OFF = 0.08

export interface RenderPostOptions {
  /** Where edited LUT strips live (`<key>.png`, e.g. 'render/luts/'); default: the built-in keys only. */
  lutUrl?: string | null
  /** TAA reprojection (D30); default false until it renders on WebGPU (see the file comment). */
  taaReprojection?: boolean
  /**
   * SSAO from its own geometry pass instead of the prepass (RENDER §5.3 wants the prepass; + ~0.6 ms CPU). In the
   * RND-P harness the prepass SSAO drew some retail StandardMaterial objects black while the geometry-buffer SSAO
   * rendered them right. Gate 1 (WebGPU, High, modern sky): next to the prepass SSR this mode fails on WebGPU
   * (createBindGroup with an undefined resource, every frame).
   */
  ssaoGeometryBuffer?: boolean
  /**
   * SSAO where the preset asks for it (High, Ultra; default true since W9 LOOK). It was off from gate 1 to W9: the
   * prepass leaves every ShaderMaterial (the sky dome, the grass, the Classic water) at its clear values, depth 0 and
   * normal (0, 0, 0), which SSAO2 read as geometry at the eye with a NaN normal and drew black. clearPrepassForSsao
   * clears them to a far depth and a valid normal instead (see there); Babylon 9.28's geometry-buffer fallback is still
   * not used (an invalid WebGPU pipeline: a depth16unorm colour target).
   */
  ssao?: boolean
  /**
   * The sun shafts where the preset asks for them (default true since wave 12: render/volumetrics/shafts.ts; false
   * is the lab's A/B). The gate-2 VolumetricLightScatteringPostProcess they replace never ran on WebGPU.
   */
  lightShafts?: boolean
  /** The shafts' path (default 'auto'; the lab forces 'march', 'hybrid' or 'screen'). */
  shaftsMode?: 'auto' | ShaftMode
}

interface Built {
  camera: Camera
  fsr: FSR1RenderingPipeline | null
  ssao: SSAO2RenderingPipeline | null
  ssr: SSRRenderingPipeline | null
  taa: TAARenderingPipeline | null
  dp: DefaultRenderingPipeline
  shafts: LightShafts | null
  adapt: EyeAdaptation | null
  stages: PostStage[]
}

/** The render-side exposure trim (RENDER §5.2); defined in render/display.ts next to the display transform. */
export { EXPOSURE_TRIM }

// ---- exposure-aware overlays (the hover / target highlight) ---------------------------------------------------------

/** The game's highlight tint and opacity (display colour, as the Classic path draws it). */
export const HIGHLIGHT_COLOR: Readonly<Color3> = new Color3(1, 0.92, 0.7)
export const HIGHLIGHT_ALPHA = 0.28
/**
 * On the HDR path the overlay blends in linear light, where the Classic path blended display values: the tint is
 * linearised and scaled by this so a dark and a mid-grey surface both lift about as much as on Classic.
 */
export const HIGHLIGHT_LINEAR_K = 0.45

/**
 * The overlayColor that shows `base` like the Classic highlight on a stack that multiplies the scene by `exposure`
 * (1 = the Classic path: `base` as is). Babylon's renderOverlay writes overlayColor straight into the scene target;
 * on the PBR presets that target is scene-linear HDR, so a (1, 0.92, 0.7) × 0.28 overlay became 2.2 after an exposure
 * of 8 (24–40 at night) and tone-mapped to a solid white silhouette (W9 hotfix verifier).
 */
export function highlightOverlayColor(base: Readonly<Color3>, exposure: number, out = new Color3()): Color3 {
  if (!(exposure > 0) || exposure === 1) return out.copyFrom(base)
  const k = HIGHLIGHT_LINEAR_K / exposure
  return out.set(Math.pow(base.r, 2.2) * k, Math.pow(base.g, 2.2) * k, Math.pow(base.b, 2.2) * k)
}

const POSTS = new WeakMap<Scene, RenderPost>()
const OVERLAYS = new WeakMap<Scene, Map<AbstractMesh, Color3>>()
/** The base colour of every mesh that ever had an overlay (its dispose observer is registered with it, once). */
const BASES = new WeakMap<AbstractMesh, Color3>()

/** The exposure the scene's post stack applies now (1 without one, or on the Classic path). */
export function sceneExposure(scene: Scene): number {
  return POSTS.get(scene)?.appliedExposure ?? 1
}

/**
 * Turns a mesh's highlight overlay on (`color`) or off (null), exposure-aware (highlightOverlayColor). While on, the
 * scene's RenderPost re-scales it whenever the exposure moves (a few meshes: the hovered and the targeted entity), and
 * a path switch re-applies it. models.ts `CharacterActor.setHighlight` and drops.ts use it for every entity mesh.
 */
export function setHighlightOverlay(mesh: AbstractMesh, color: Readonly<Color3> | null, alpha = HIGHLIGHT_ALPHA): void {
  const scene = mesh.getScene()
  let map = OVERLAYS.get(scene)
  if (!color) {
    mesh.renderOverlay = false
    map?.delete(mesh)
    return
  }
  if (!map) OVERLAYS.set(scene, (map = new Map()))
  let base = BASES.get(mesh)
  if (!base) {
    // Once per mesh, not per hover (W9F-CPU-3): a colour of its own, re-scaled in place every frame (callers used to
    // share one Color3 across meshes), its base colour, and one dispose observer.
    mesh.overlayColor = new Color3()
    BASES.set(mesh, (base = new Color3()))
    mesh.onDisposeObservable.addOnce(() => OVERLAYS.get(scene)?.delete(mesh))
  }
  map.set(mesh, base.copyFrom(color))
  mesh.overlayAlpha = alpha
  highlightOverlayColor(color, sceneExposure(scene), mesh.overlayColor)
  mesh.renderOverlay = true
}

/** Meshes with an exposure-aware overlay on in `scene` (tests, the console). */
export function highlightOverlayCount(scene: Scene): number {
  return OVERLAYS.get(scene)?.size ?? 0
}

function refreshOverlays(scene: Scene, exposure: number): void {
  const map = OVERLAYS.get(scene)
  if (!map?.size) return
  for (const [mesh, base] of map) highlightOverlayColor(base, exposure, mesh.overlayColor)
}

// ---- SSAO on the prepass -------------------------------------------------------------------------------------------

/** The prepass depth of pixels no prepass material wrote: beyond any camera's maxZ (SSR reads a 0 as this, too). */
export const PREPASS_FAR_DEPTH = 1e8
/** The clear of the prepass's other targets: a valid normal (0, 0, 1) after normalising; 0 in the RGBA8 reflectivity. */
export const PREPASS_CLEAR_NORMAL_Z = 1e-4

/** Private prepass fields (Babylon 9.28): the clear colours of the depth target and of the other non-colour targets. */
interface PrePassClears {
  useSpecificClearForDepthTexture: boolean
  _clearDepthColor?: { set(r: number, g: number, b: number, a: number): unknown }
  _clearColor?: { set(r: number, g: number, b: number, a: number): unknown }
}

/**
 * I-10R: Babylon gives SSAO2's thin SSAO pass its camera only in the original-colour pass's onBeforeRender. In the
 * first frames after the page's first SSAO build (a fresh page on Low switched straight to High), that pass's effect
 * could still be compiling while the SSAO effect was ready: the SSAO pass then bound with no camera, skipped
 * `randomSampler`, and on WebGPU `createBindGroup` threw inside the render loop, which stopped (a frozen frame). The
 * camera is set at build, so the bind never runs without it.
 */
export function seedSsaoCamera(pipeline: SSAO2RenderingPipeline, camera: Camera): void {
  const thin = (pipeline as unknown as { _thinSSAORenderingPipeline?: { _ssaoPostProcess?: { camera: Camera | null } } })._thinSSAORenderingPipeline?._ssaoPostProcess
  if (thin && !thin.camera) thin.camera = camera
}

/**
 * W9 LOOK: the prepass clears its depth target to 0 and its normal target to (0, 0, 0) ("an invalid value": no
 * material writes 0). The sky dome, the grass and the Classic water are ShaderMaterials that do not write the prepass,
 * so their pixels keep those values; SSR reads a depth of 0 as 1e8, but SSAO2 took them for geometry at the eye with
 * a NaN normal and drew them black on WebGPU (the reason SSAO was off since gate 1). Cleared to a far depth (SSAO2
 * fades its occlusion out past maxZ) and a valid normal, they get no occlusion, and the reflectivity target (which
 * shares the colour clear) stays at 0, under SSR's threshold.
 */
export function clearPrepassForSsao(scene: Scene): void {
  const pr = scene.prePassRenderer as unknown as PrePassClears | null
  if (!pr) return
  pr.useSpecificClearForDepthTexture = true
  pr._clearDepthColor?.set(PREPASS_FAR_DEPTH, 0, 0, 1)
  pr._clearColor?.set(0, 0, PREPASS_CLEAR_NORMAL_Z, 0)
}

/** The private parts of Babylon 9.28's TAA pipeline hdrTaaPass replaces. */
interface TaaPassInternals {
  _scene: Scene
  _textureType: number
  _ping: unknown
  _passPostProcess: PassPostProcess | null
  _createPassPostProcess(): void
  _buildPipeline(): void
}

/**
 * Babylon 9.28's TAARenderingPipeline copies its result through a PassPostProcess ('TAAPass') created without a
 * texture type, so RGBA8, whatever type the pipeline was given. On the PBR presets TAA runs on the scene-linear HDR
 * image before the exposure (×8 by day, ×30 at night) and the tone map: the pass clamped everything to [0, 1] and
 * quantised it to 8 bits, so the exposure blew the quantisation up into bands that TAA's jitter turned into a
 * diamond / checker pattern across the sky (W9F TEX-5, seen on WebGL2 at High), and every highlight above 1 clipped
 * before the bloom. The pass is made with the pipeline's own type (half float) and the pipeline rebuilt (before the
 * default pipeline is attached, so the stage order holds).
 */
function hdrTaaPass(t: TAARenderingPipeline): void {
  const p = t as unknown as TaaPassInternals
  if (typeof p._createPassPostProcess !== 'function' || typeof p._buildPipeline !== 'function') return
  p._createPassPostProcess = function (this: TaaPassInternals) {
    const engine = this._scene.getEngine()
    this._passPostProcess = new PassPostProcess('TAAPass', 1, null, 1, engine, false, this._textureType)
    ;(this._passPostProcess as unknown as { inputTexture: unknown }).inputTexture = this._ping
    this._passPostProcess.autoClear = false
  }
  p._buildPipeline()
}

/** Private Babylon fields read for the TAA jitter (9.28). */
interface TaaInternals { _taaThinPostProcess?: { _taaMaterialManager?: { jitter: { x: number; y: number } } } }

/**
 * WorldRender's post part (docs/WAVE_PLAN3.md §6.13). Build: `installRenderPost(world.render)`.
 */
export class RenderPost implements RenderPart {
  /** The height-fog numbers every PBR material reads (pbr/fog-plugin.ts). */
  readonly fog: HeightFog
  /** The LUT blend (PBR presets with lutGrade; created on first use). */
  grade: GradeMixer | null = null
  /** The post stack's own image-processing settings (see the file comment). */
  readonly imageProcessing = new ImageProcessingConfiguration()
  /** Render-side exposure trim (RENDER §5.2: SkyState.exposure × trim); EXPOSURE_TRIM by default. */
  exposureTrim = EXPOSURE_TRIM
  /** The sun shafts' look constants (volumetrics/shafts.ts SHAFT_TUNING; the lab tunes a copy live). */
  shaftTuning: Readonly<ShaftTuning> = SHAFT_TUNING
  /** The plan of the current build. */
  plan: PostPlan
  private mode: RenderPath
  private quality: Readonly<RenderQuality>
  private camera: Camera | null
  private weather: Readonly<RenderWeather> = CLEAR_RENDER_WEATHER
  private toneMapOverride: ToneMap | null = null
  private renderScaleOverride: number | null = null
  private built: Built | null = null
  private sceneApplyByPost: boolean | null = null
  private jitterObserver: Nullable<Observer<Scene>> = null
  /** settlePrepass before the frame's render targets, repairPrepass after them (see build). */
  private readonly prepassObservers: Array<Nullable<Observer<Scene>>> = []
  /** repairPrepass's tries in a row without the prepass coming back on (reset by every build). */
  private prepassRepairs = 0
  private ssrOn = false
  private exposure = 1
  private readonly lutUrl: string | null
  private readonly taaReprojection: boolean
  private readonly ssaoGeometryBuffer: boolean
  private readonly ssao: boolean
  private readonly lightShafts: boolean
  private readonly shaftsMode: 'auto' | ShaftMode
  private lutLoad: Promise<void> | null = null
  private gradeFailed = false
  /** W11-S (D4): the owners asking for MSAA ×4 in place of TAA. */
  private readonly temporal = new Map<string, Exclude<TemporalOverride, 'none'>>()
  private disposed = false

  constructor(readonly render: WorldRender, opts: RenderPostOptions = {}) {
    this.fog = new HeightFog(render.scene)
    this.mode = render.mode
    this.quality = render.quality
    this.camera = render.activeCamera
    this.weather = render.weather
    this.lutUrl = opts.lutUrl ?? null
    this.taaReprojection = opts.taaReprojection ?? false
    this.ssaoGeometryBuffer = opts.ssaoGeometryBuffer ?? false
    this.ssao = opts.ssao ?? true
    this.lightShafts = opts.lightShafts ?? true
    this.shaftsMode = opts.shaftsMode ?? 'auto'
    POSTS.set(render.scene, this)
    this.plan = this.makePlan()
    // D2/D4: display colours meant to show as designed (the classic dome, the fog colour) invert this transform.
    setSceneDisplay(render.scene, () => ({ toneMap: this.plan.toneMap, exposure: this.built ? this.exposure : 0 }))
    this.rebuild()
  }

  get scene(): Scene {
    return this.render.scene
  }

  /** The stages that are built now (attach order). */
  get stages(): readonly PostStage[] {
    return this.built?.stages ?? []
  }

  /** The default pipeline (null when nothing is built). */
  get pipeline(): DefaultRenderingPipeline | null {
    return this.built?.dp ?? null
  }

  /**
   * The exposure the post stack multiplies the scene by now (1 when nothing is built). Display-referred colours drawn
   * into the HDR target (rain streaks, lamp glow) are divided by it so they read the same after the tone map.
   */
  get appliedExposure(): number {
    return this.built ? this.exposure : 1
  }

  /** Whether SSR currently marches (High: puddles; Ultra: always). */
  get ssrActive(): boolean {
    return this.built?.ssr ? this.ssrOn : false
  }

  setMode(mode: RenderPath): void {
    if (mode === this.mode) return
    this.mode = mode
    this.rebuild()
  }

  setQuality(q: Readonly<RenderQuality>): void {
    this.quality = q
    this.rebuild()
  }

  attachCamera(camera: Camera): void {
    this.camera = camera
    this.rebuild()
  }

  setWeather(w: Readonly<RenderWeather>): void {
    this.weather = w
  }

  /** Options → Tone mapping (live: a uniform-level change of the post stack, no rebuild). null = the preset's. */
  setToneMap(t: ToneMap | null): void {
    this.toneMapOverride = t
    this.plan = this.makePlan()
    this.applyImageProcessing()
  }

  /** The render scale (GAME's applyGraphics; < 1 uses FSR1 where the plan allows). null = the preset's. */
  setRenderScale(scale: number | null): void {
    if (scale === this.renderScaleOverride) return
    this.renderScaleOverride = scale
    this.rebuild()
  }

  /**
   * W11-S (D4; TOWN_LIFE G5-11): `owner` asks for MSAA ×4 in place of TAA ('msaa4') or takes its request back ('none').
   * The stack is rebuilt only when the effective override changes on a TAA preset; 'none' from an owner that asked
   * nothing is a no-op.
   */
  setTemporalOverride(owner: string, mode: TemporalOverride): void {
    const before = this.temporal.size > 0
    if (mode === 'none') {
      if (!this.temporal.delete(owner)) return
    } else {
      if (this.temporal.get(owner) === mode) return
      this.temporal.set(owner, mode)
    }
    if (this.temporal.size > 0 === before || this.disposed) return
    if (this.quality.aa === 'taa') this.rebuild()
    else this.plan = this.makePlan()
  }

  /** W11-S: the effective temporal override ('none' while no owner asks). */
  get temporalOverride(): TemporalOverride {
    return this.temporal.size > 0 ? 'msaa4' : 'none'
  }

  private makePlan(): PostPlan {
    return planPost(this.mode, this.quality, this.render.gpu, {
      temporal: this.temporal.size > 0 ? 'msaa4' : null,
      renderScale: this.renderScaleOverride ?? undefined,
      toneMap: this.toneMapOverride,
      taaReprojection: this.taaReprojection,
      ssao: this.ssao,
      lightShafts: this.lightShafts,
      shaftsMode: this.shaftsMode,
      eyeAdaptation: LIGHT_LOOK.eyeAdaptation,
    })
  }

  /** Tears the stack down and builds the current plan (mode, preset, camera, render scale). */
  rebuild(): void {
    if (this.disposed) return
    this.teardown()
    this.plan = this.makePlan()
    const pbr = this.mode === 'pbr'
    this.fog.setActive(pbr && this.quality.fog === 'height', this.fog.ringActive && this.quality.horizonRingFog)
    if (this.plan.stages.length === 0) {
      this.restoreSceneImageProcessing()
      refreshOverlays(this.scene, this.appliedExposure)
      return
    }
    // D18: PBR materials leave image processing to the post stack (the height fog runs after the material's IP point).
    const sceneIp = this.scene.imageProcessingConfiguration
    if (this.sceneApplyByPost === null) this.sceneApplyByPost = sceneIp.applyByPostProcess
    sceneIp.applyByPostProcess = true
    if (this.plan.lutGrade) this.ensureGrade()
    this.applyImageProcessing()
    if (this.camera) this.built = this.build(this.camera)
    refreshOverlays(this.scene, this.appliedExposure)
  }

  private ensureGrade(): void {
    if (this.grade || this.gradeFailed) return
    try {
      this.grade = new GradeMixer(this.scene)
    } catch (err) {
      // No 3D textures (NullEngine, an old device): the stack runs without the LUT grade.
      this.gradeFailed = true
      console.warn('[post] LUT grade not built:', err)
      return
    }
    if (this.lutUrl && !this.lutLoad) {
      const grade = this.grade
      this.lutLoad = loadLutStrips(this.lutUrl).then(strips => {
        for (const [key, strip] of Object.entries(strips)) if (strip) grade.setStrip(key as never, strip)
      })
    }
  }

  private applyImageProcessing(): void {
    const ip = this.imageProcessing
    const p = this.plan
    ip.isEnabled = true
    ip.toneMappingEnabled = p.toneMap !== 'none'
    ip.toneMappingType = toneMappingType(p.toneMap)
    ip.contrast = 1.05
    ip.ditheringEnabled = true
    ip.vignetteEnabled = false
    ip.colorCurvesEnabled = false
    const lut = p.lutGrade && this.grade ? this.grade.texture : null
    ip.colorGradingEnabled = lut !== null
    ip.colorGradingTexture = lut
  }

  private build(camera: Camera): Built {
    const scene = this.scene
    const engine = scene.getEngine()
    const p = this.plan
    const half = Constants.TEXTURETYPE_HALF_FLOAT
    const stages: PostStage[] = []
    const first = p.stages[0]
    let fsr: FSR1RenderingPipeline | null = null
    let ssao: SSAO2RenderingPipeline | null = null
    let ssr: SSRRenderingPipeline | null = null
    let taa: TAARenderingPipeline | null = null
    let shafts: LightShafts | null = null
    let adapt: EyeAdaptation | null = null
    // An unsupported pipeline was never attached; its dispose may throw on the half-built parts.
    const drop = (dispose: () => void): null => {
      try {
        dispose()
      } catch {
        // Nothing was built.
      }
      return null
    }
    const tryBuild = <T>(stage: PostStage, make: () => T | null): T | null => {
      try {
        const out = make()
        if (out) stages.push(stage)
        return out
      } catch (err) {
        console.warn(`[post] ${stage} not built:`, err)
        return null
      }
    }

    if (p.fsrScale > 0) {
      fsr = tryBuild('fsr', () => {
        const f = new FSR1RenderingPipeline('sroFsr', scene, [camera])
        if (!f.isSupported) return drop(() => f.dispose())
        f.scaleFactor = p.fsrScale
        f.samples = first === 'fsr' ? p.msaa : 1
        return f
      })
    }
    if (p.ssao) {
      const s = p.ssao
      ssao = tryBuild('ssao', () => {
        const a = new SSAO2RenderingPipeline('sroSsao', scene, { ssaoRatio: s.ratio, blurRatio: s.ratio }, [camera], this.ssaoGeometryBuffer, half)
        if (!a.isSupported) return drop(() => a.dispose(false))
        a.samples = s.samples
        // Lighting pass 2: wider and stronger contact darkening (grounding of feet, walls, props).
        a.radius = 2
        a.totalStrength = 1.35
        a.expensiveBlur = true
        seedSsaoCamera(a, camera)
        return a
      })
      if (ssao && !this.ssaoGeometryBuffer) clearPrepassForSsao(scene)
    }
    if (p.ssr !== 'off') {
      ssr = tryBuild('ssr', () => {
        const r = new SSRRenderingPipeline('sroSsr', scene, [camera], false, half)
        if (!r.isSupported) return drop(() => r.dispose(false))
        r.ssrDownsample = SSR_SETTINGS.ssrDownsample
        r.blurDownsample = SSR_SETTINGS.blurDownsample
        r.maxSteps = SSR_SETTINGS.maxSteps
        r.step = SSR_SETTINGS.step
        r.maxDistance = SSR_SETTINGS.maxDistance
        r.thickness = SSR_SETTINGS.thickness
        r.attenuateScreenBorders = true
        r.attenuateFacingCamera = true
        // The scene target is linear HDR (before exposure), not gamma: with Babylon's defaults (both true) every pixel
        // over the reflectivity threshold came out as pow(c, 1 / 2.2) (a wet plaza read as white ice after the exposure).
        // Set before the first render: changing these later rebuilds the effects and binds null prepass textures.
        r.inputTextureColorIsInGammaSpace = false
        r.generateOutputInGammaSpace = false
        r.strength = 1
        r.reflectivityThreshold = SSR_SETTINGS.reflectivityThreshold
        return r
      })
      this.ssrOn = true
      if (ssr) this.gateSsr(ssr, p.ssr === 'always' || this.weather.puddles > SSR_PUDDLES_ON)
    }
    if (p.aa === 'taa') {
      taa = tryBuild('taa', () => {
        const t = new TAARenderingPipeline('sroTaa', scene, [camera], half)
        if (!t.isSupported) return drop(() => t.dispose())
        hdrTaaPass(t)
        t.samples = 8
        // Every setter here rebuilds and re-attaches TAA, so all of them run before the default pipeline exists.
        t.reprojectHistory = p.taaReprojection
        t.disableOnCameraMove = !p.taaReprojection
        t.clampHistory = true
        return t
      })
      if (taa && p.taaReprojection) this.jitterObserver = scene.onBeforeDrawPhaseObservable.add(() => this.copyJitter())
    }
    if (p.msaa > 1 && p.prepass && scene.prePassRenderer) scene.prePassRenderer.samples = p.msaa
    // Babylon 9.28 re-reads the prepass renderer's state inside a render target's draw whenever the prepass is dirty,
    // and on the first draw of any target not flagged noPrePassRenderer. With the target's own camera active there
    // are no post-processes, so the prepass turned itself off, and SSR then bound prepass textures at index -1 (a
    // TypeError that stopped the render loop; the weather shelter map did it). Every attach and detach of a
    // post-process dirties it, so: settle it against the stack's camera before the frame's render targets, and if a
    // target still turned it off, have the camera read it again (a no-op without a prepass renderer: Medium).
    const needsPrepass = !!(ssao || ssr || (taa && p.taaReprojection))
    this.prepassRepairs = 0
    this.prepassObservers.push(
      scene.onBeforeRenderTargetsRenderObservable.add(() => this.settlePrepass()),
      scene.onAfterRenderTargetsRenderObservable.add(() => this.repairPrepass(needsPrepass)),
    )

    // Wave 12: the sun shafts, in HDR between TAA and the default pipeline (their three passes attach here, in order).
    // As the first stage they take the scene's MSAA samples.
    if (p.shafts) {
      const sp = p.shafts
      shafts = tryBuild('shafts', () => {
        if (!engine.getCaps().textureHalfFloatRender) throw new Error('no half-float render target')
        if (engine.useReverseDepthBuffer) throw new Error('reverse depth buffer')
        return new LightShafts(scene, camera, sp, { shadows: () => this.shadowSource(), samples: first === 'shafts' ? p.msaa : 1, adapt: () => adapt })
      })
    }

    // Eye adaptation (docs/LIGHTING.md §2): metered off the chain; the shafts' composite applies it, or without shafts a
    // pass of its own after them (they read the scene depth from the first pass: never in front of them). The scene
    // renders into the first pass built: it takes the plan's MSAA samples there.
    const sceneFirst = (s: PostStage) => stages.length === 0 && (first === 'default' || first === 'shafts' || first === s)
    if (p.adapt) {
      adapt = tryBuild('adapt', () => {
        if (!engine.getCaps().textureHalfFloatRender) throw new Error('no half-float render target')
        return new EyeAdaptation(scene, camera, { applyPass: !shafts, samples: sceneFirst('adapt') ? p.msaa : 1 })
      })
    }

    // TAA unsupported on this device: FXAA instead, and no sharpen.
    const noTaa = p.aa === 'taa' && !taa
    const dp = new DefaultRenderingPipeline('sroPost', true, scene, [camera], false)
    dp.samples = sceneFirst('adapt') ? p.msaa : 1
    dp.fxaaEnabled = p.fxaa || noTaa
    dp.bloomEnabled = p.bloom > 0
    if (p.bloom > 0) {
      dp.bloomScale = p.bloom
      dp.bloomKernel = 64
      dp.bloomWeight = p.bloomWeight
      dp.bloomThreshold = bloomCutoff(p.bloomThreshold, this.exposure)
    }
    dp.sharpenEnabled = p.sharpen && !noTaa
    if (dp.sharpenEnabled) dp.sharpen.edgeAmount = 0.3
    dp.imageProcessingEnabled = true
    // Every (re)build makes a new image-processing post-process on the scene configuration: point it at ours.
    dp.onBuildObservable.add(() => {
      if (dp.imageProcessing) dp.imageProcessing.imageProcessingConfiguration = this.imageProcessing
    })
    dp.prepare()
    stages.push('default')
    // Without half-float render targets the pipeline falls back to LDR and hands image processing back to the materials.
    if (engine.getCaps().textureHalfFloatRender) scene.imageProcessingConfiguration.applyByPostProcess = true
    else console.warn('[post] no half-float render target: LDR post, image processing stays in the materials')

    // The shafts were pushed before 'default': keep the fixed order whatever was built.
    stages.sort((a, b) => POST_STAGE_ORDER.indexOf(a) - POST_STAGE_ORDER.indexOf(b))
    return { camera, fsr, ssao, ssr, taa, dp, shafts, adapt, stages }
  }

  /** The sun's CSM the shafts march through (the shadow part's generator; null before it exists). */
  private shadowSource(): ShaftShadowSource | null {
    const sh = this.render.shadows as { generator?: ShaftShadowSource | null } | null
    return sh?.generator ?? null
  }

  private teardown(): void {
    const b = this.built
    this.built = null
    if (this.jitterObserver) {
      this.scene.onBeforeDrawPhaseObservable.remove(this.jitterObserver)
      this.jitterObserver = null
    }
    const [before, after] = this.prepassObservers.splice(0)
    if (before) this.scene.onBeforeRenderTargetsRenderObservable.remove(before)
    if (after) this.scene.onAfterRenderTargetsRenderObservable.remove(after)
    this.render.taaJitter.set(0, 0)
    if (!b) return
    b.dp.dispose()
    b.adapt?.dispose()
    b.shafts?.dispose()
    b.taa?.dispose()
    b.ssr?.dispose(false)
    b.ssao?.dispose(this.ssaoGeometryBuffer)
    b.fsr?.dispose()
    if (b.ssao || b.ssr || (b.taa && this.plan.taaReprojection)) this.scene.disablePrePassRenderer()
  }

  private restoreSceneImageProcessing(): void {
    if (this.sceneApplyByPost === null) return
    this.scene.imageProcessingConfiguration.applyByPostProcess = this.sceneApplyByPost
    this.sceneApplyByPost = null
  }

  /** A dirty prepass renderer takes its state from the camera the stack is on (see build), never a render target's. */
  settlePrepass(): void {
    const pr = this.scene.prePassRenderer
    if (pr && this.onStackCamera()) pr.update()
  }

  /**
   * After the render targets: a stack with a prepass stage whose prepass a target turned off is dirtied again, so the
   * camera's clear re-reads it with the camera's post-processes (Babylon's own step, before the first draw of it).
   */
  repairPrepass(needsPrepass: boolean): void {
    const pr = this.scene.prePassRenderer
    if (!pr || !needsPrepass || !this.onStackCamera()) return
    if (pr.enabled) {
      this.prepassRepairs = 0
      return
    }
    // A prepass the camera cannot turn on either is left alone after a few tries: each re-read dirties every material.
    if (this.prepassRepairs >= PREPASS_REPAIRS_MAX) return
    this.prepassRepairs++
    pr.markAsDirty()
  }

  /** The camera the prepass reads now is the one the stack is on. */
  private onStackCamera(): boolean {
    const b = this.built
    if (!b) return false
    const scene = this.scene
    const camera = scene.activeCameras?.length ? scene.activeCameras[0] : scene.activeCamera
    return camera === b.camera
  }

  private copyJitter(): void {
    const t = this.built?.taa as unknown as TaaInternals | null | undefined
    const j = t?._taaThinPostProcess?._taaMaterialManager?.jitter
    if (j) this.render.taaJitter.set(j.x, j.y)
  }

  private gateSsr(ssr: SSRRenderingPipeline, on: boolean): void {
    if (on === this.ssrOn) return
    this.ssrOn = on
    ssr.reflectivityThreshold = on ? SSR_SETTINGS.reflectivityThreshold : SSR_GATED_THRESHOLD
    ssr.strength = on ? 1 : 0
  }

  /** Per frame (last in World.update): exposure, bloom threshold, grade, fog numbers, SSR gate, light shafts. */
  update(_camera: Camera | null, sky: Readonly<SkyState>): void {
    if (this.mode !== 'pbr') return
    const exposure = Math.max(1e-3, sky.exposure * this.exposureTrim)
    const moved = Math.abs(exposure - this.exposure) > 0.002 * this.exposure
    if (moved) this.exposure = exposure
    if (this.fog.active) {
      // Lighting pass 2: the all-day atmosphere (aerial haze, morning mist in the hollows, evening haze).
      const atm = atmosphereLook(sky.sunElevationDeg, sky.t, LIGHT_LOOK.atmosphere ? 1 : 0)
      this.fog.densityScale = atm.density
      this.fog.startScale = atm.start
      this.fog.heightFalloffM = LIGHT_LOOK.atmosphere ? atm.falloffM : DEFAULT_HEIGHT_FALLOFF_M
      this.fog.update(sky, this.exposure, this.plan.toneMap)
      const ring = this.quality.horizonRingFog && sky.horizonRing !== null
      if (ring !== this.fog.ringActive) this.fog.setActive(true, ring)
    }
    const b = this.built
    if (!b) return
    // Babylon re-evaluates the prepass when a render target with its own camera renders while it is dirty (the rain's
    // shelter map, the first time rain materials appear). That camera has no post-processes, so the prepass switches
    // itself off and image processing goes back into the materials: SSR stops, PBR tone-maps twice, and a rebuild then
    // throws in SSR every frame (LAB report §1.2). Marking it dirty from here (the main camera's turn) re-arms both.
    if (b.ssao || b.ssr || (b.taa && this.plan.taaReprojection)) {
      const pp = this.scene.prePassRenderer
      if (pp && !pp.enabled) pp.markAsDirty()
    }
    if (moved) {
      this.imageProcessing.exposure = this.exposure
      if (this.plan.bloom > 0) b.dp.bloomThreshold = bloomCutoff(this.plan.bloomThreshold, this.exposure)
      refreshOverlays(this.scene, this.exposure)
    }
    if (this.grade) this.grade.setLegacy(!LIGHT_LOOK.cinematicGrade)
    if (this.grade && this.plan.lutGrade) this.grade.update({ sunElevationDeg: sky.sunElevationDeg, t: sky.t, cloud: this.weather.cloud, rain: this.weather.rain, winter: this.weather.winter ?? 0 })
    if (b.ssr) {
      if (this.plan.ssr === 'puddles') {
        const pud = this.weather.puddles
        if (!this.ssrOn && pud > SSR_PUDDLES_ON) this.gateSsr(b.ssr, true)
        else if (this.ssrOn && pud < SSR_PUDDLES_OFF) this.gateSsr(b.ssr, false)
      }
      const env = this.scene.environmentTexture
      if (env && env.isCube && b.ssr.environmentTexture !== env) b.ssr.environmentTexture = env as CubeTexture
    }
    if (b.shafts) this.updateShafts(b.shafts, sky)
    if (b.adapt) b.adapt.setFrame(this.exposure, sky.sunElevationDeg, this.weather)
  }

  /** The eye adaptation built now (null: none; the lab reads its state). */
  get adaptation(): EyeAdaptation | null {
    return this.built?.adapt ?? null
  }

  /** The shafts' look this frame: the key light as the surfaces get it, the haze colour, the weather, the fog. */
  private updateShafts(shafts: LightShafts, sky: Readonly<SkyState>): void {
    shafts.glowOn = LIGHT_LOOK.lanternGlow
    const cal = (this.render.lighting as { calibration?: { sun: number } } | null)?.calibration
    const fog = this.fog.active ? this.fog.a.x * this.fog.a.w : 0
    const start = this.fog.a.z
    const k = sky.keyLight
    shafts.setFrame(shaftLook({
      sunElevationDeg: sky.sunElevationDeg,
      keyColor: k.color,
      keyIntensity: k.intensity,
      sunScale: cal?.sun ?? 1,
      fogColor: sky.fogColor,
      weather: this.weather,
      fogDensity: fog,
      fogStartM: start,
    }, LIGHT_LOOK.atmosphere ? this.shaftTuning : SHAFT_TUNING_V1), sky)
  }

  /** The shafts built now (null: none; the lab and the perf overlay read them). */
  get shafts(): LightShafts | null {
    return this.built?.shafts ?? null
  }

  dispose(): void {
    if (this.disposed) return
    this.teardown()
    this.restoreSceneImageProcessing()
    this.fog.dispose()
    this.grade?.dispose()
    this.grade = null
    this.disposed = true
    if (POSTS.get(this.scene) === this) {
      POSTS.delete(this.scene)
      setSceneDisplay(this.scene, null)
    }
    refreshOverlays(this.scene, 1)
    if (this.render.post === this) this.render.post = null
  }
}

/** W11-S: the scene's live post part (null on the Classic path, before the PBR path builds one, or headless). */
export function renderPostOf(scene: Scene): RenderPost | null {
  return POSTS.get(scene) ?? null
}

/** Creates the post part and plugs it into `render` (WorldRender.post). */
export function installRenderPost(render: WorldRender, opts: RenderPostOptions = {}): RenderPost {
  render.post?.dispose?.()
  const post = new RenderPost(render, opts)
  render.post = post
  return post
}
