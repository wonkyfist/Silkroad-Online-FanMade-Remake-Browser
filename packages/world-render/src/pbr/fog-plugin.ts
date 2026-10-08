/**
 * Height fog on the PBR path (docs/RENDER.md §5.5, docs/WAVE_PLAN3.md D18): `SroFogPlugin` replaces Babylon's linear
 * fog on every PBR material with an exponential height fog, computed at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` on
 * `finalColor` (the PBR fragment has no `CUSTOM_FRAGMENT_BEFORE_FOG`). That point comes after
 * `pbrBlockImageProcessing`, which is only correct because every PBR preset applies image processing in post
 * (`imageProcessingConfiguration.applyByPostProcess = true`, set by render/post.ts), so the fog is added in linear
 * HDR before the prepass copy (SSR/SSAO see fogged colour). The material's own fog is switched off while the plugin is
 * active, so there is one fog term.
 *
 * The model (scene metres):
 *
 *   amount = 1 − exp(−density × max(0, dist − start) × F(h)),  F(h) = (exp(k·h) − 1) / (k·h),  h = max(eyeY − y, 0)
 *
 * - `density = −ln(0.05) / (end − start)`: 95% at the fog end the world already applies (retail G10/G11 × 250 m, ×
 *   the weather's fog scale: World.applyEnv writes scene.fogStart/fogEnd). The retail start is kept, so the near field
 *   is as clear as on the Classic path and the far fog still bounds the draw distance (FIELDS.md §3.2).
 * - F is the exact integral of a density that grows by e per `heightFalloffM` going down from the eye: valleys below
 *   the camera are mistier, and a point above the eye gets the uniform fog (h = 0, F = 1), never thinner, so hills
 *   cannot pop out of the fog at the streaming edge. (RENDER §5.5 wrote `(1 − e^(−kh))/(kh)`, which thins the fog
 *   downward; the sign is corrected here.) F → 1 as h → 0: the uniform exponential fog.
 * - colour = mix(horizon, sunColour, strength × max(0, dot(viewDir, sunDir))^8); horizon = SkyState.fogColor, or the
 *   64 × 1 `horizonRing` sampled at the view azimuth on High+ (`SRO_FOG_RING`). The fog colour is an LDR display
 *   colour the sky designed; it is turned into scene-linear HDR by the exact inverse of the post stack's display
 *   transform (render/display.ts: gamma and tone curve) and ÷ exposure, so it shows as designed after the post's one
 *   tone curve (W9 finish D4: sRGB → linear alone ran it through a second curve). The ring holds that inverse already
 *   (exposed linear, SkySystem), so the shader only divides by the exposure.
 *
 * `HeightFog` holds the shared numbers (four Vector4s the grass and water chunks can bind too, D18) and the
 * WGSL/GLSL functions. The plugin is registered globally, but its factory attaches only to PBR materials of a scene
 * whose HeightFog is active, so the Classic path (Low) never gets it. Lane RND-P.
 */
import {
  PBRBaseMaterial,
  MaterialPluginBase,
  RegisterMaterialPlugin,
  Scene,
  ShaderLanguage,
  Vector4,
  type AbstractEngine,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { displayToExposed } from '../render/display.ts'
import type { ToneMap } from '../render/quality.ts'
import type { SkyState } from '../sky/types.ts'

export const FOG_PLUGIN_NAME = 'SroFog'
/** −ln(0.05): the fog reaches 95% at the fog end. */
export const FOG_95 = -Math.log(0.05)
/** The metres over which the fog density grows by e going down from the eye. */
export const DEFAULT_HEIGHT_FALLOFF_M = 80
/** kh is clamped here (F ≈ 373): a deep valley seen from a peak saturates instead of overflowing. */
const MAX_KH = 8

/** Fog density (1/m) for a fog that starts at `startM` and reaches 95% at `endM`. */
export function fogDensity(startM: number, endM: number): number {
  return FOG_95 / Math.max(1, endM - startM)
}

/** The height factor F(h) (h = eyeY − pointY, clamped ≥ 0; k = 1/falloff). */
export function heightFactor(h: number, k: number): number {
  const kh = Math.min(MAX_KH, Math.max(0, h) * k)
  return kh < 1e-4 ? 1 + kh / 2 : (Math.exp(kh) - 1) / kh
}

/** The fog amount of the shader, in TS (tests, the CPU side of the grass and water). */
export function heightFogAmount(distM: number, eyeY: number, pointY: number, p: { density: number; startM: number; falloffM: number }): number {
  const d = Math.max(0, distM - p.startM)
  return 1 - Math.exp(-p.density * d * heightFactor(eyeY - pointY, 1 / p.falloffM))
}

/** The horizon-ring u of a view direction: the world azimuth atan2(x, z) mapped to 0..1 (SKY-B writes the ring so). */
export function fogRingU(dir: { x: number; z: number }): number {
  return Math.atan2(dir.x, dir.z) / (2 * Math.PI) + 0.5
}

/**
 * The shared height-fog numbers of one scene. Uniforms (vec4):
 * - `sroFogA`: density (1/m), k = 1/falloff (1/m), start (m), amount (0 = fog off);
 * - `sroFogColor`: horizon colour (scene-linear), 1/exposure;
 * - `sroFogSun`: direction to the sun, scatter strength;
 * - `sroFogSunColor`: sun scatter colour (scene-linear), unused.
 */
export class HeightFog {
  readonly a = new Vector4(0, 1 / DEFAULT_HEIGHT_FALLOFF_M, 0, 0)
  readonly color = new Vector4(0.5, 0.6, 0.7, 1)
  readonly sun = new Vector4(0, 1, 0, 0)
  readonly sunColor = new Vector4(1, 0.9, 0.7, 0)
  /** The metres over which the density grows by e going down. */
  heightFalloffM = DEFAULT_HEIGHT_FALLOFF_M
  /** The scatter towards the sun (0 = none). */
  sunScatter = 0.5
  /** Lighting pass 2 (render/atmosphere.ts): × the retail density and start (RenderPost sets them per frame). */
  densityScale = 1
  startScale = 1
  /** The horizon ring bound on High+ (null: fogColor only). */
  ring: BaseTexture | null = null
  private activeValue = false
  private readonly lin: [number, number, number] = [0, 0, 0]
  private ringValue = false
  /** Plugins created against this state (for define refreshes). */
  readonly plugins = new Set<SroFogPlugin>()

  constructor(readonly scene: Scene) {}

  get active(): boolean {
    return this.activeValue
  }

  /** Whether the ring define is on (High+ and a ring texture). */
  get ringActive(): boolean {
    return this.ringValue
  }

  /**
   * Switches the height fog on the PBR materials of this scene (a define change: only on a mode or preset change).
   * On: registers the plugin factory and attaches the plugin to the PBR materials that exist.
   */
  setActive(on: boolean, ring = false): void {
    if (on === this.activeValue && (on && ring) === this.ringValue) return
    this.activeValue = on
    this.ringValue = on && ring
    if (on) {
      ensureFogPlugin()
      STATES.set(this.scene, this)
      for (const m of this.scene.materials) attachFogPlugin(m, this)
    }
    for (const p of this.plugins) p.refresh()
  }

  /**
   * Per frame, after World.applyEnv: the fog range and on/off come from the scene fog the world set (start/end are the
   * retail distances × the weather's fog scale), the colour and sun from the SkyState.
   */
  update(sky: Readonly<SkyState>, exposure: number, toneMap: ToneMap = 'neutral'): void {
    const s = this.scene
    const on = s.fogMode !== Scene.FOGMODE_NONE
    const start0 = Math.max(0, s.fogStart)
    const end = Math.max(start0 + 1, s.fogEnd)
    const start = start0 * this.startScale
    this.a.set(fogDensity(start0, end) * this.densityScale, 1 / Math.max(1, this.heightFalloffM), start, on ? 1 : 0)
    const inv = 1 / Math.max(1e-3, exposure)
    // The fog colour shows as designed after the post's single tone curve (D4).
    const f = displayToExposed(sky.fogColor, toneMap, this.lin)
    this.color.set(f[0]! * inv, f[1]! * inv, f[2]! * inv, inv)
    const d = sky.sunDir
    const up = Math.max(0, Math.min(1, (sky.sunElevationDeg + 4) / 8))
    this.sun.set(d.x, d.y, d.z, this.sunScatter * up)
    const k = sky.keyLight.color
    // The glow around the sun: the fog colour tinted by the key light (1.6× so the halo reads against the horizon).
    this.sunColor.set(this.color.x * k[0] * 1.6, this.color.y * k[1] * 1.6, this.color.z * k[2] * 1.6, 0)
    this.ring = sky.horizonRing
  }

  dispose(): void {
    this.setActive(false)
    if (STATES.get(this.scene) === this) STATES.delete(this.scene)
    this.plugins.clear()
  }
}

// ---- shader code ------------------------------------------------------------------------------------------------

/** WGSL: the fog amount and colour (the grass and water chunks can include these too). */
export const HEIGHT_FOG_WGSL = `
fn sroHeightFogAmount(posW: vec3f, eye: vec3f, a: vec4f) -> f32 {
  let dist = length(posW - eye);
  let d = max(dist - a.z, 0.0);
  let kh = clamp((eye.y - posW.y) * a.y, 0.0, ${MAX_KH.toFixed(1)});
  let f = select((exp(kh) - 1.0) / max(kh, 1e-4), 1.0 + kh * 0.5, kh < 1e-4);
  return (1.0 - exp(-a.x * d * f)) * a.w;
}
fn sroHeightFogTint(dir: vec3f, horizon: vec3f, sun: vec4f, sunColor: vec3f) -> vec3f {
  let s = pow(max(dot(dir, sun.xyz), 0.0), 8.0) * sun.w;
  return mix(horizon, sunColor, s);
}
fn sroFogRingU(dir: vec3f) -> f32 {
  return atan2(dir.x, dir.z) * 0.15915494 + 0.5;
}
`

/** GLSL twin of HEIGHT_FOG_WGSL. */
export const HEIGHT_FOG_GLSL = `
float sroHeightFogAmount(vec3 posW, vec3 eye, vec4 a) {
  float dist = length(posW - eye);
  float d = max(dist - a.z, 0.0);
  float kh = clamp((eye.y - posW.y) * a.y, 0.0, ${MAX_KH.toFixed(1)});
  float f = kh < 1e-4 ? 1.0 + kh * 0.5 : (exp(kh) - 1.0) / kh;
  return (1.0 - exp(-a.x * d * f)) * a.w;
}
vec3 sroHeightFogTint(vec3 dir, vec3 horizon, vec4 sun, vec3 sunColor) {
  float s = pow(max(dot(dir, sun.xyz), 0.0), 8.0) * sun.w;
  return mix(horizon, sunColor, s);
}
float sroFogRingU(vec3 dir) {
  return atan(dir.x, dir.z) * 0.15915494 + 0.5;
}
`

const WGSL_DEFINITIONS = `
#ifdef SRO_HEIGHTFOG
#ifdef SRO_FOG_RING
var sroFogRingSampler: sampler;
var sroFogRing: texture_2d<f32>;
#endif
${HEIGHT_FOG_WGSL}
#endif
`

// textureSampleLevel: no implicit derivatives, so it is valid anywhere (WGSL uniformity, WAVE_PLAN3 §4.2).
const WGSL_APPLY = `
#ifdef SRO_HEIGHTFOG
{
  let sroEye = scene.vEyePosition.xyz;
  let sroPos = fragmentInputs.vPositionW;
  let sroDir = normalize(sroPos - sroEye);
  var sroHorizon = uniforms.sroFogColor.rgb;
#ifdef SRO_FOG_RING
  let sroRing = textureSampleLevel(sroFogRing, sroFogRingSampler, vec2f(sroFogRingU(sroDir), 0.5), 0.0).rgb;
  sroHorizon = max(sroRing, vec3f(0.0)) * uniforms.sroFogColor.w;
#endif
  let sroAmt = sroHeightFogAmount(sroPos, sroEye, uniforms.sroFogA);
  let sroCol = sroHeightFogTint(sroDir, sroHorizon, uniforms.sroFogSun, uniforms.sroFogSunColor.rgb);
  finalColor = vec4f(mix(finalColor.rgb, sroCol, sroAmt), finalColor.a);
}
#endif
`

const GLSL_DEFINITIONS = `
#ifdef SRO_HEIGHTFOG
#ifdef SRO_FOG_RING
uniform sampler2D sroFogRing;
#endif
${HEIGHT_FOG_GLSL}
#endif
`

const GLSL_APPLY = `
#ifdef SRO_HEIGHTFOG
{
  vec3 sroEye = vEyePosition.xyz;
  vec3 sroDir = normalize(vPositionW - sroEye);
  vec3 sroHorizon = sroFogColor.rgb;
#ifdef SRO_FOG_RING
  vec3 sroRing = textureLod(sroFogRing, vec2(sroFogRingU(sroDir), 0.5), 0.0).rgb;
  sroHorizon = max(sroRing, vec3(0.0)) * sroFogColor.w;
#endif
  float sroAmt = sroHeightFogAmount(vPositionW, sroEye, sroFogA);
  vec3 sroCol = sroHeightFogTint(sroDir, sroHorizon, sroFogSun, sroFogSunColor.rgb);
  finalColor = vec4(mix(finalColor.rgb, sroCol, sroAmt), finalColor.a);
}
#endif
`

/** The fragment code per language (same keys in both: the plugin test checks it). */
export function fogPluginCode(language: ShaderLanguage): Record<string, string> {
  return language === ShaderLanguage.WGSL
    ? { CUSTOM_FRAGMENT_DEFINITIONS: WGSL_DEFINITIONS, CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: WGSL_APPLY }
    : { CUSTOM_FRAGMENT_DEFINITIONS: GLSL_DEFINITIONS, CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: GLSL_APPLY }
}

const FOG_UBO = [
  { name: 'sroFogA', size: 4, type: 'vec4' },
  { name: 'sroFogColor', size: 4, type: 'vec4' },
  { name: 'sroFogSun', size: 4, type: 'vec4' },
  { name: 'sroFogSunColor', size: 4, type: 'vec4' },
]

/** The height fog on one PBR material (see the file comment). */
export class SroFogPlugin extends MaterialPluginBase {
  private readonly materialFog: boolean

  constructor(material: Material, readonly state: HeightFog) {
    super(material, FOG_PLUGIN_NAME, 300, { SRO_HEIGHTFOG: false, SRO_FOG_RING: false }, true, true)
    this.materialFog = material.fogEnabled
    state.plugins.add(this)
    this.syncMaterialFog()
  }

  override getClassName(): string {
    return 'SroFogPlugin'
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.WGSL || language === ShaderLanguage.GLSL
  }

  /** The state changed (active / ring): new defines, and the material's own fog off while this one is on. */
  refresh(): void {
    this.syncMaterialFog()
    this.markAllDefinesAsDirty()
  }

  private syncMaterialFog(): void {
    this._material.fogEnabled = this.state.active ? false : this.materialFog
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['SRO_HEIGHTFOG'] = this.state.active
    defines['SRO_FOG_RING'] = this.state.active && this.state.ringActive
  }

  override getUniforms(): { ubo: typeof FOG_UBO; fragment: string } {
    return {
      ubo: FOG_UBO,
      fragment: '#ifdef SRO_HEIGHTFOG\nuniform vec4 sroFogA;\nuniform vec4 sroFogColor;\nuniform vec4 sroFogSun;\nuniform vec4 sroFogSunColor;\n#endif\n',
    }
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('sroFogRing')
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state
    if (!s.active) return
    ubo.updateFloat4('sroFogA', s.a.x, s.a.y, s.a.z, s.a.w)
    ubo.updateFloat4('sroFogColor', s.color.x, s.color.y, s.color.z, s.color.w)
    ubo.updateFloat4('sroFogSun', s.sun.x, s.sun.y, s.sun.z, s.sun.w)
    ubo.updateFloat4('sroFogSunColor', s.sunColor.x, s.sunColor.y, s.sunColor.z, s.sunColor.w)
    if (s.ringActive && s.ring) ubo.setTexture('sroFogRing', s.ring)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    return shaderType === 'fragment' ? fogPluginCode(language) : null
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.state.plugins.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

const STATES = new WeakMap<Scene, HeightFog>()
let registered = false

function ensureFogPlugin(): void {
  if (registered) return
  registered = true
  RegisterMaterialPlugin(FOG_PLUGIN_NAME, material => {
    const state = STATES.get(material.getScene())
    return state?.active && material instanceof PBRBaseMaterial ? new SroFogPlugin(material, state) : null
  })
}

/** Attaches the plugin to one material when it is a PBR material without it (idempotent). */
export function attachFogPlugin(material: Material, state: HeightFog): SroFogPlugin | null {
  if (!(material instanceof PBRBaseMaterial)) return null
  const existing = material.pluginManager?.getPlugin<SroFogPlugin>(FOG_PLUGIN_NAME)
  if (existing) return existing
  return new SroFogPlugin(material, state)
}

/** The scene's height-fog state, if the post stack made one. */
export function heightFogOf(scene: Scene): HeightFog | null {
  return STATES.get(scene) ?? null
}
