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
 *   sky dome itself on High+ (`SRO_FOG_RING`: SkySystem's 64² sky probe read in the view direction, so a fogged crown matches
 *   the sky behind it); on Medium the flat horizon colour, leaning to SkyState.fogColorUp above the horizon. The fog colour is an LDR display
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
/**
 * Item 16 (the AAA lighting pass): the fog's ground reference. `sroFogA.w` packs, besides on/off, the ground height
 * under the camera (½ m steps from −GROUND_OFFSET m) and the ground-mist density (8 bits of MIST_MAX):
 * `w = 0` off; `1` the plain height fog; `1 + 256·(gq) + mq` with `gq = 1 + round((groundY + GROUND_OFFSET)·2)`.
 * Every reader of `a.w` treats > 0.5 as on.
 */
const GROUND_OFFSET = 2000
/** The camera's usual height over the character (m): above it, rays toward the ground thin to the ground's density. */
export const CAMERA_HEIGHT_M = 14
/** The ground mist: densest at the ground (1/m at a full level), its e-folding height, where it starts from the eye. */
export const MIST_MAX = 0.016
export const MIST_H_M = 7
export const MIST_START_M = 6
/** Metres of fog start added per metre the eye is above its usual height (for the rays down toward the ground). */
export const ALT_START_K = 1.2
/** Item 16: the most a surface short of the fog end is fogged (it keeps its shading under the haze). */
export const FOG_CAP = 0.82
/**
 * The haze's ramp (2026-10-12, the flat cream trees): the fog's depth grows with d² over its first HAZE_RAMP × 3/density
 * metres past its start, then with d. The exponential haze was half done 23 % of the way to its end, so every tree crown
 * 100–150 m out (and the hills behind) became a flat silhouette in the fog colour, cream toward a low sun; with the
 * ramp it is 15 % there and still 95 % at the fog end.
 */
export const HAZE_RAMP = 1
/**
 * The brightest in-scatter (exposed luminance) a surface short of the fog's end is blended toward (2026-10-12). The
 * horizon toward a low sun is a display colour near white; undone through the tone curve it is several times the
 * exposure's white, so even a third of it bleached a tree crown cream. Capped (hue kept) up to the fog's last fifth,
 * where the full colour comes back so the fog end still meets the sky.
 */
export const FOG_SURFACE_MAX = 0.8
/**
 * Above the horizon the fog colour leans to the sky FOG_UP_DEG up (2026-10-12): a far tree crown or hill seen against
 * the sky fades into the sky behind it. With the horizon colour alone a fogged crown was a flat cut-out in the horizon
 * band's colour, glowing white against the dark dusk sky and cream toward a low sun. The sky system's ring has a second
 * row there (High+) and SkyState.fogColorUp is the flat colour (Medium); level ground and everything below the eye
 * keep the horizon colour.
 */
export const FOG_UP_DEG = 8
/** The sky probe (High+) is read at least this far up (sine of ≈ 1°: the dome below the horizon is the flat fog). */
export const FOG_SKY_MIN_SIN = 0.0175
/** …at this mip (the 64² probe's 16² level): smooth, so the clouds' march noise and the sun disc spread out. */
export const FOG_SKY_LOD = 2
/** Trees fade into the fog from TREE_FADE_START × their draw distance to the draw distance + TREE_FADE_PAST_M. */
export const TREE_FADE_START = 0.85
export const TREE_FADE_PAST_M = 10

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
  const ramp = Math.min(1, (d * p.density) / (FOG_95 * HAZE_RAMP))
  return 1 - Math.exp(-p.density * d * heightFactor(eyeY - pointY, 1 / p.falloffM) * ramp)
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
  /** The sky FOG_UP_DEG above the horizon (scene-linear, like `color`), sin(FOG_UP_DEG). */
  readonly up = new Vector4(0.5, 0.6, 0.7, Math.sin((FOG_UP_DEG * Math.PI) / 180))
  /** The trees' draw distance (m; World sets it from the objects' range × their range scale). */
  treeRangeM = 202
  /** The metres over which the density grows by e going down. */
  heightFalloffM = DEFAULT_HEIGHT_FALLOFF_M
  /** The scatter towards the sun (0 = none). */
  sunScatter = 0.5
  /** Lighting pass 2 (render/atmosphere.ts): × the retail density and start (RenderPost sets them per frame). */
  densityScale = 1
  startScale = 1
  /** The horizon ring bound on High+ (null: fogColor only). */
  ring: BaseTexture | null = null
  /** Item 16: the ground under the camera (the character's feet; null: none, the eye-anchored fog alone). */
  groundY: number | null = null
  /** Item 16: the ground mist level 0..1 (× MIST_MAX; render/atmosphere.ts mistLevel). */
  mist = 0
  /** Item 16: how far the fog colour greys toward a cool neutral (rain and overcast: grey air, gold only toward the sun). */
  desaturate = 0
  private activeValue = false
  private readonly lin: [number, number, number] = [0, 0, 0]
  private readonly linUp: [number, number, number] = [0, 0, 0]
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
    // Item 16: the density spans the nearer start to the retail end (95% there, ÷ the density scale), so the aerial haze
    // is a long gentle ramp: a city wall 150 m out keeps its shape instead of fogging out at 177 m.
    this.a.set(fogDensity(start, end) * this.densityScale, 1 / Math.max(1, this.heightFalloffM), start, on ? packFogW(this.groundY, this.mist) : 0)
    const inv = 1 / Math.max(1e-3, exposure)
    // The fog colour shows as designed after the post's single tone curve (D4).
    const f = displayToExposed(sky.fogColor, toneMap, this.lin)
    const g = Math.min(1, Math.max(0, this.desaturate))
    const y = 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!
    const cool = [0.96, 1.0, 1.06] as const
    for (let c = 0; c < 3; c++) f[c] = f[c]! + (y * cool[c]! - f[c]!) * g
    this.color.set(f[0]! * inv, f[1]! * inv, f[2]! * inv, inv)
    const u = displayToExposed(sky.fogColorUp ?? sky.fogColor, toneMap, this.linUp)
    const yu = 0.2126 * u[0]! + 0.7152 * u[1]! + 0.0722 * u[2]!
    for (let c = 0; c < 3; c++) u[c] = u[c]! + (yu * cool[c]! - u[c]!) * g
    this.up.set(u[0]! * inv, u[1]! * inv, u[2]! * inv, this.up.w)
    const d = sky.sunDir
    const up = Math.max(0, Math.min(1, (sky.sunElevationDeg + 4) / 8))
    this.sun.set(d.x, d.y, d.z, this.sunScatter * up)
    const k = sky.keyLight.color
    // The glow around the sun: the fog colour tinted by the key light (1.6× so the halo reads against the horizon).
    this.sunColor.set(this.color.x * k[0] * 1.6, this.color.y * k[1] * 1.6, this.color.z * k[2] * 1.6, g)
    this.ring = sky.horizonRing
  }

  dispose(): void {
    this.setActive(false)
    if (STATES.get(this.scene) === this) STATES.delete(this.scene)
    this.plugins.clear()
  }
}

/** `sroFogA.w` when the fog is on (see GROUND_OFFSET). */
export function packFogW(groundY: number | null, mist: number): number {
  if (groundY === null || !Number.isFinite(groundY)) return 1
  const gq = 1 + Math.round(Math.min(Math.max(groundY + GROUND_OFFSET, 0), 2 * GROUND_OFFSET) * 2)
  const mq = Math.round(Math.min(Math.max(mist, 0), 1) * 255)
  return 1 + gq * 256 + mq
}

// ---- shader code ------------------------------------------------------------------------------------------------

/** WGSL: the fog amount and colour (the grass and water chunks can include these too). */
export const HEIGHT_FOG_WGSL = `
fn sroHeightFogAmount(posW: vec3f, eye: vec3f, a: vec4f) -> f32 {
  let dist = length(posW - eye);
  var d = max(dist - a.z, 0.0);
  let h = eye.y - posW.y;
  let kh = clamp(h * a.y, 0.0, ${MAX_KH.toFixed(1)});
  var f = select((exp(kh) - 1.0) / max(kh, 1e-4), 1.0 + kh * 0.5, kh < 1e-4);
  // item 16: a.w packs on/off, the ground under the camera and the ground mist (HeightFog.packW)
  let pk = max(a.w - 1.0, 0.0);
  let gq = floor(pk / 256.0);
  var mist = 0.0;
  if (gq > 0.5) {
    let g = (gq - 1.0) * 0.5 - ${GROUND_OFFSET.toFixed(1)};
    // the eye above its usual height: rays down toward the ground see the density of the ground, not of the eye's
    // altitude grown by e per falloff (the heavy ground fog seen from flying height)
    let above = max(eye.y - g - ${CAMERA_HEIGHT_M.toFixed(1)}, 0.0);
    let share = clamp(h / max(above, 1.0), 0.0, 1.0);
    f = f * mix(1.0, exp(-min(above * a.y, ${MAX_KH.toFixed(1)})), share);
    // and the first stretch of such a ray is the clear air above the haze: the start moves out with the height
    d = max(dist - a.z - ${ALT_START_K.toFixed(2)} * above * share, 0.0);
    // ground mist: density md·e^(−(y − g)/H), integrated exactly along the ray (valleys below the ground pool it)
    let md = (pk - gq * 256.0) * ${(MIST_MAX / 255).toExponential(6)};
    let e0 = exp(-clamp((eye.y - g) / ${MIST_H_M.toFixed(1)}, -3.0, 30.0));
    let e1 = exp(-clamp((posW.y - g) / ${MIST_H_M.toFixed(1)}, -3.0, 30.0));
    let avg = select((e1 - e0) * ${MIST_H_M.toFixed(1)} / h, 0.5 * (e0 + e1), abs(h) < 0.05);
    mist = md * max(dist - ${MIST_START_M.toFixed(1)}, 0.0) * avg;
  }
  // item 16: aerial haze keeps some shape — capped at FOG_CAP until the fog's own end (3/density past its start), where
  // it reaches 1 (the streaming edge stays hidden); a far wall no longer flattens into a solid fog-coloured box
  let fEnd = 3.0 / max(a.x, 1e-6);
  let cap = mix(${FOG_CAP.toFixed(2)}, 1.0, smoothstep(0.8 * fEnd, fEnd, dist - a.z));
  // the haze builds up over its first HAZE_RAMP × fEnd metres (its depth grows with d², not d): trees and walls a third
  // of the way in keep their shading instead of turning into flat haze-coloured shapes; the fog end is as thick as before
  let ramp = clamp(d / (${HAZE_RAMP.toFixed(2)} * fEnd), 0.0, 1.0);
  return min(1.0 - exp(-a.x * d * f * ramp - mist), cap) * step(0.5, a.w);
}
fn sroHeightFogTint(dir: vec3f, horizon: vec3f, sun: vec4f, sunColor: vec3f) -> vec3f {
  let s = pow(max(dot(dir, sun.xyz), 0.0), 8.0) * sun.w;
  return mix(horizon, sunColor, s);
}
fn sroFogRingU(dir: vec3f) -> f32 {
  return atan2(dir.x, dir.z) * 0.15915494 + 0.5;
}
fn sroFogCapped(col: vec3f, invExposure: f32, edge: f32) -> vec3f {
  let y = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  return mix(col * min(1.0, ${FOG_SURFACE_MAX.toFixed(2)} * invExposure / max(y, 1e-6)), col, edge);
}
fn sroFogEdge(posW: vec3f, eye: vec3f, a: vec4f) -> f32 {
  let fEnd = 3.0 / max(a.x, 1e-6);
  return smoothstep(0.8 * fEnd, fEnd, length(posW - eye) - a.z);
}
`

/** GLSL twin of HEIGHT_FOG_WGSL. */
export const HEIGHT_FOG_GLSL = `
float sroHeightFogAmount(vec3 posW, vec3 eye, vec4 a) {
  float dist = length(posW - eye);
  float d = max(dist - a.z, 0.0);
  float h = eye.y - posW.y;
  float kh = clamp(h * a.y, 0.0, ${MAX_KH.toFixed(1)});
  float f = kh < 1e-4 ? 1.0 + kh * 0.5 : (exp(kh) - 1.0) / kh;
  float pk = max(a.w - 1.0, 0.0);
  float gq = floor(pk / 256.0);
  float mist = 0.0;
  if (gq > 0.5) {
    float g = (gq - 1.0) * 0.5 - ${GROUND_OFFSET.toFixed(1)};
    float above = max(eye.y - g - ${CAMERA_HEIGHT_M.toFixed(1)}, 0.0);
    float share = clamp(h / max(above, 1.0), 0.0, 1.0);
    f *= mix(1.0, exp(-min(above * a.y, ${MAX_KH.toFixed(1)})), share);
    d = max(dist - a.z - ${ALT_START_K.toFixed(2)} * above * share, 0.0);
    float md = (pk - gq * 256.0) * ${(MIST_MAX / 255).toExponential(6)};
    float e0 = exp(-clamp((eye.y - g) / ${MIST_H_M.toFixed(1)}, -3.0, 30.0));
    float e1 = exp(-clamp((posW.y - g) / ${MIST_H_M.toFixed(1)}, -3.0, 30.0));
    float avg = abs(h) < 0.05 ? 0.5 * (e0 + e1) : (e1 - e0) * ${MIST_H_M.toFixed(1)} / h;
    mist = md * max(dist - ${MIST_START_M.toFixed(1)}, 0.0) * avg;
  }
  float fEnd = 3.0 / max(a.x, 1e-6);
  float cap = mix(${FOG_CAP.toFixed(2)}, 1.0, smoothstep(0.8 * fEnd, fEnd, dist - a.z));
  float ramp = clamp(d / (${HAZE_RAMP.toFixed(2)} * fEnd), 0.0, 1.0);
  return min(1.0 - exp(-a.x * d * f * ramp - mist), cap) * step(0.5, a.w);
}
vec3 sroHeightFogTint(vec3 dir, vec3 horizon, vec4 sun, vec3 sunColor) {
  float s = pow(max(dot(dir, sun.xyz), 0.0), 8.0) * sun.w;
  return mix(horizon, sunColor, s);
}
float sroFogRingU(vec3 dir) {
  return atan(dir.x, dir.z) * 0.15915494 + 0.5;
}
vec3 sroFogCapped(vec3 col, float invExposure, float edge) {
  float y = dot(col, vec3(0.2126, 0.7152, 0.0722));
  return mix(col * min(1.0, ${FOG_SURFACE_MAX.toFixed(2)} * invExposure / max(y, 1e-6)), col, edge);
}
float sroFogEdge(vec3 posW, vec3 eye, vec4 a) {
  float fEnd = 3.0 / max(a.x, 1e-6);
  return smoothstep(0.8 * fEnd, fEnd, length(posW - eye) - a.z);
}
`

const WGSL_DEFINITIONS = `
#ifdef SRO_HEIGHTFOG
#ifdef SRO_FOG_RING
var sroFogRingSampler: sampler;
var sroFogRing: texture_cube<f32>;
#endif
${HEIGHT_FOG_WGSL}
#endif
`

// textureSampleLevel: no implicit derivatives, so it is valid anywhere (WGSL uniformity, WAVE_PLAN3 §4.2).
// SRO_FOG_RING (High+): the fog colour is the sky dome itself in the view direction (SkySystem's sky probe, a small
// cube of the dome: clouds, sun glow and all; read at least FOG_SKY_MIN_SIN up, so the ground takes the horizon), so a
// fogged crown matches the sky behind it. Else (Medium) the flat horizon colour leaning to the flat colour FOG_UP_DEG up.
const WGSL_APPLY = `
#ifdef SRO_HEIGHTFOG
{
  let sroEye = scene.vEyePosition.xyz;
  let sroPos = fragmentInputs.vPositionW;
  let sroDir = normalize(sroPos - sroEye);
  var sroAmt = sroHeightFogAmount(sroPos, sroEye, uniforms.sroFogA);
  var sroEdge = sroFogEdge(sroPos, sroEye, uniforms.sroFogA);
#ifdef SRO_FOG_TREE
  // trees near their draw distance go over into the fog (the sky behind them) instead of standing as fog-coloured blobs
  let sroTree = smoothstep(uniforms.sroFogTree.x, uniforms.sroFogTree.y, length(sroPos - sroEye)) * step(0.5, uniforms.sroFogA.w);
  sroAmt = max(sroAmt, sroTree);
  sroEdge = max(sroEdge, sroTree);
#endif
#ifdef SRO_FOG_RING
  let sroSkyDir = normalize(vec3f(sroDir.x, max(sroDir.y, ${FOG_SKY_MIN_SIN.toFixed(4)}), sroDir.z));
  let sroSky = max(textureSampleLevel(sroFogRing, sroFogRingSampler, sroSkyDir, ${FOG_SKY_LOD.toFixed(1)}).rgb, vec3f(0.0));
  let sroCol = sroFogCapped(sroSky, uniforms.sroFogColor.w, sroEdge);
#else
  let sroHorizon = mix(uniforms.sroFogColor.rgb, uniforms.sroFogUp.rgb, smoothstep(0.0, uniforms.sroFogUp.w, sroDir.y));
  let sroCol = sroFogCapped(sroHeightFogTint(sroDir, sroHorizon, uniforms.sroFogSun, uniforms.sroFogSunColor.rgb), uniforms.sroFogColor.w, sroEdge);
#endif
  finalColor = vec4f(mix(finalColor.rgb, sroCol, sroAmt), finalColor.a);
}
#endif
`

const GLSL_DEFINITIONS = `
#ifdef SRO_HEIGHTFOG
#ifdef SRO_FOG_RING
uniform samplerCube sroFogRing;
#endif
${HEIGHT_FOG_GLSL}
#endif
`

const GLSL_APPLY = `
#ifdef SRO_HEIGHTFOG
{
  vec3 sroEye = vEyePosition.xyz;
  vec3 sroDir = normalize(vPositionW - sroEye);
  float sroAmt = sroHeightFogAmount(vPositionW, sroEye, sroFogA);
  float sroEdge = sroFogEdge(vPositionW, sroEye, sroFogA);
#ifdef SRO_FOG_TREE
  float sroTree = smoothstep(sroFogTree.x, sroFogTree.y, length(vPositionW - sroEye)) * step(0.5, sroFogA.w);
  sroAmt = max(sroAmt, sroTree);
  sroEdge = max(sroEdge, sroTree);
#endif
#ifdef SRO_FOG_RING
  vec3 sroSkyDir = normalize(vec3(sroDir.x, max(sroDir.y, ${FOG_SKY_MIN_SIN.toFixed(4)}), sroDir.z));
  vec3 sroCol = sroFogCapped(max(textureLod(sroFogRing, sroSkyDir, ${FOG_SKY_LOD.toFixed(1)}).rgb, vec3(0.0)), sroFogColor.w, sroEdge);
#else
  vec3 sroHorizon = mix(sroFogColor.rgb, sroFogUp.rgb, smoothstep(0.0, sroFogUp.w, sroDir.y));
  vec3 sroCol = sroFogCapped(sroHeightFogTint(sroDir, sroHorizon, sroFogSun, sroFogSunColor.rgb), sroFogColor.w, sroEdge);
#endif
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
  { name: 'sroFogUp', size: 4, type: 'vec4' },
  { name: 'sroFogTree', size: 4, type: 'vec4' },
]

/** The height fog on one PBR material (see the file comment). */
export class SroFogPlugin extends MaterialPluginBase {
  private readonly materialFog: boolean

  constructor(material: Material, readonly state: HeightFog) {
    super(material, FOG_PLUGIN_NAME, 300, { SRO_HEIGHTFOG: false, SRO_FOG_RING: false, SRO_FOG_TREE: false }, true, true)
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
    // the region batch's merged tree groups (the foliage plugin's tree flag; by name: no import cycle)
    const fol = this._material.pluginManager?.getPlugin('SroFoliagePlugin') as { tree?: boolean } | null | undefined
    defines['SRO_FOG_TREE'] = this.state.active && !!fol?.tree
  }

  override getUniforms(): { ubo: typeof FOG_UBO; fragment: string } {
    return {
      ubo: FOG_UBO,
      fragment: '#ifdef SRO_HEIGHTFOG\nuniform vec4 sroFogA;\nuniform vec4 sroFogColor;\nuniform vec4 sroFogSun;\nuniform vec4 sroFogSunColor;\nuniform vec4 sroFogUp;\nuniform vec4 sroFogTree;\n#endif\n',
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
    ubo.updateFloat4('sroFogUp', s.up.x, s.up.y, s.up.z, s.up.w)
    ubo.updateFloat4('sroFogTree', TREE_FADE_START * s.treeRangeM, s.treeRangeM + TREE_FADE_PAST_M, 0, 0)
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
