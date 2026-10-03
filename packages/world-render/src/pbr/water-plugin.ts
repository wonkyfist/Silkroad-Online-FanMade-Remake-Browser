/**
 * `SroWaterPlugin`: the water on the PBR presets (docs/RENDER.md §7, docs/WAVE_PLAN3.md §6.14, D21, D24). Owned by
 * RND-W; water.ts builds the material (`createPbrWater`) and feeds `WaterPbrState` each frame. The Classic water
 * (ShaderMaterial, WX-R's chunk) is untouched.
 *
 * One PBRMaterial per world: alpha blend, no depth write, metallic 0, roughness 0.04 (0.15 in rain), so the sky cube
 * (RND-L's `scene.environmentTexture`) gives the Fresnel sky reflection and the celestial light a sun glint; the
 * reflection stays visible where the water is thin (`useRadianceOverAlpha`, `useSpecularOverAlpha`). The fog is the
 * PBR height fog (RND-P's SroFogPlugin joins every PBR material). The plugin, in both languages at the same points:
 *
 * - `CUSTOM_FRAGMENT_MAIN_BEGIN`: everything is computed once, in the fragment's uniform control flow (so every tap is
 *   a plain textureSample): the retail frame (the 30-frame animation of the Classic water, 8 m per repeat, from the
 *   world position: the PBR water has no uv) × the water colour stays the albedo (the scattering colour) at 60 %,
 *   darker with depth (× the deep colour); the normal from our own tileable normal map sampled twice, scrolling at
 *   (0.03, 0.01) m/s with a 6 m period and (−0.02, 0.025) m/s with a 17 m period, × the block's wave type (0.5 / 0.8 /
 *   1.0 / 1.3); in rain, WX-R's ripple texture (D21: one ripple source) as expanding rings, two layers.
 * - `CUSTOM_FRAGMENT_UPDATE_ALBEDO` / `_ALPHA` / `_METALLICROUGHNESS`: the albedo, the alpha and the normal, the
 *   roughness.
 * - Alpha: SRO_WATER_SHORE (High+, `waterDepthShore`) = saturate(depth / 1.5 m) with a foam band under 0.3 m. The depth
 *   is the water height minus the terrain height per vertex; the water grid is the terrain's 2 m grid, so across a cell
 *   the interpolated depth is the water's real depth over the terrain surface, and the shore line lands where the
 *   water meets the ground without a depth pass (RENDER §7's depth renderer would draw every opaque mesh again: the
 *   game is CPU-bound). Without it (Medium) the retail per-vertex alpha (full at 3 m) stays.
 *
 * Vertex colour of the PBR water meshes: r = (depth + 1) / 9 (−1..8 m), g = wave amplitude / 2, b = 0, a = the retail
 * alpha. The plugin overwrites Babylon's vertex-colour multiply on the albedo and the alpha.
 */
import {
  Color3,
  Constants,
  MaterialPluginBase,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Texture,
  Vector4,
  type AbstractEngine,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { useWindowedLightFalloff } from '../render/babylon-fixes.ts'
import { rainRingCode, ringTaps } from '../weather/ripples.ts'

export const SRO_WATER_PLUGIN = 'SroWaterPlugin'
/** Retail frame repeat (m): 4 repeats per 32 m block, as the Classic water. */
export const WATER_FRAME_REPEAT_M = 8
/** The two normal-map layers: scroll (m/s) and period (m) (RENDER §7). */
export const WATER_NORMAL_LAYERS = [
  { scroll: [0.03, 0.01], periodM: 6 },
  { scroll: [-0.02, 0.025], periodM: 17 },
] as const
/** Wave-type amplitude (the block's `water.wave`, 0..3; RENDER §7). */
export const WATER_WAVE_AMPLITUDE = [0.5, 0.8, 1, 1.3] as const
/** The shore alpha reaches 1 at this depth (m) and the foam band ends here (High+). */
export const WATER_SHORE_M = 1.5
export const WATER_FOAM_M = 0.3
/**
 * Roughness dry and in full rain. Wave 12 (RAIN-P): 0.15 → 0.07 in rain, so the rain rings stay sharp in the sky's
 * reflection (the rings are what rain on water looks like; a blurred reflection hid them).
 */
export const WATER_ROUGHNESS: readonly [number, number] = [0.04, 0.07]
/**
 * Rain rings on the water (wave 12 RAIN-P; weather/ripples.ts `rainRingCode`): ripple-texture repeats per metre (a
 * 2.9 m tile, rings up to 26 cm: a pond is seen from farther than the paving), the normal gain at full strength, the
 * camera distance (m) over which they fade (the taps are two mips sharper, RAIN_RING_LOD_BIAS: the aliasing would show
 * beyond), and the linear grey a drop's impact crown lifts the albedo toward.
 */
export const WATER_RING_SCALE = 0.35
export const WATER_RING_GAIN = 1.1
export const WATER_RING_FADE_M: readonly [number, number] = [30, 70]
export const WATER_CROWN_ALBEDO = 0.5
/**
 * The rings' glint: a ring's crests and a drop's crown add this × the sky the surface mirrors (Babylon's environment
 * radiance, scene-linear) on top of the tilted normal's own reflection. Seen from above (a small Fresnel) the tilt
 * alone left the rings invisible on the town's dark pond.
 */
export const WATER_RING_GLINT = 0.8
/**
 * The ring lines: a crest lifts the water's albedo toward this linear grey by up to WATER_RING_LINE × its height, and
 * raises the alpha with it (the shallow pond is nearly transparent, so a surface feature needs its own opacity). After
 * the town plugin's profile (UPDATE_ALBEDO / UPDATE_ALPHA), so the turbid pond keeps its lines.
 */
export const WATER_RING_LINE = 0.55
export const WATER_RING_LINE_ALBEDO = 0.32
/** The albedo weight of the retail colour (RENDER §7: 60 %). */
export const WATER_ALBEDO_WEIGHT = 0.6
/** Deep water: the albedo × this at 4 m. */
export const WATER_DEEP: readonly [number, number, number] = [0.35, 0.5, 0.55]

/** Amplitude of a block's wave type (unknown types: 1). */
export function waveAmplitude(wave: number): number {
  return WATER_WAVE_AMPLITUDE[wave as 0 | 1 | 2 | 3] ?? 1
}

/** The High+ shore alpha at a water depth (m): the shader's `saturate(depth / 1.5)`. */
export function shoreAlpha(depthM: number): number {
  return Math.min(1, Math.max(0, depthM / WATER_SHORE_M))
}

/** The foam weight of the shader at a depth (m): 0 on dry ground, 1 at the water line, 0 from 0.3 m. */
export function foamAmount(depthM: number): number {
  const s = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  return s(-0.05, 0.02, depthM) * (1 - s(0.05, WATER_FOAM_M, depthM))
}

/** Vertex colour r of a depth (m): (depth + 1) / 9, clamped (the shader decodes r × 9 − 1). */
export function encodeWaterDepth(depthM: number): number {
  return Math.min(1, Math.max(0, (depthM + 1) / 9))
}

/** The water colour's hue at its noon brightness: the PBR light carries the time of day, not the retail palette. */
export function waterHue(c: readonly [number, number, number], level = 0.69): [number, number, number] {
  const m = Math.max(c[0], c[1], c[2])
  if (!(m > 1e-4)) return [level * 0.52, level, level * 0.9]
  return [(c[0] / m) * level, (c[1] / m) * level, (c[2] / m) * level]
}

// ---- the normal map -----------------------------------------------------------------------------------------------

/**
 * A tileable tangent-space normal map (+Z up, green up): height = Σ a·sin(2π(k·p) + φ) with integer wave vectors,
 * amplitudes falling with frequency; the normal is the analytic gradient. Our own art (the same method as
 * tools/make-render-textures.ts `water-normal.png`, built here in memory so no asset URL is needed).
 */
export function waterNormalPixels(size = 128, seed = 7, waves = 28, strength = 0.8): Uint8Array<ArrayBuffer> {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const list: Array<{ kx: number; ky: number; a: number; ph: number }> = []
  for (let i = 0; i < waves; i++) {
    const f = 1 + Math.floor(Math.pow(rand(), 1.6) * 10)
    const ang = rand() * Math.PI * 2
    const kx = Math.round(Math.cos(ang) * f), ky = Math.round(Math.sin(ang) * f)
    if (kx === 0 && ky === 0) continue
    list.push({ kx, ky, a: 1 / Math.pow(Math.hypot(kx, ky), 1.3), ph: rand() * Math.PI * 2 })
  }
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size
      let gx = 0, gy = 0
      for (const w of list) {
        const c = Math.cos(2 * Math.PI * (w.kx * u + w.ky * v) + w.ph) * w.a * 2 * Math.PI
        gx += c * w.kx
        gy += c * w.ky
      }
      const sx = (-gx * strength / size) * 8, sy = (-gy * strength / size) * 8
      const l = Math.hypot(sx, sy, 1)
      const o = (y * size + x) * 4
      out[o] = Math.round((sx / l * 0.5 + 0.5) * 255)
      out[o + 1] = Math.round((-sy / l * 0.5 + 0.5) * 255)
      out[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255)
      out[o + 3] = 255
    }
  }
  return out
}

// ---- shader code --------------------------------------------------------------------------------------------------

const FOAM = `(1.0 - smoothstep(0.05, ${WATER_FOAM_M.toFixed(2)}, sroWD)) * smoothstep(-0.05, 0.02, sroWD)`
const L0 = WATER_NORMAL_LAYERS[0], L1 = WATER_NORMAL_LAYERS[1]
const v2 = (lang: 'wgsl' | 'glsl', x: number, y: number) => `${lang === 'wgsl' ? 'vec2f' : 'vec2'}(${x.toFixed(3)}, ${y.toFixed(3)})`

const WGSL: Record<string, string> = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef SRO_WATER
var sroWaterFrames: texture_2d_array<f32>;
var sroWaterFramesSampler: sampler;
var sroWaterNormal: texture_2d<f32>;
var sroWaterNormalSampler: sampler;
#ifdef SRO_WATER_RIPPLE
var sroWaterRipple: texture_2d<f32>;
var sroWaterRippleSampler: sampler;
var<private> sroWGlint: f32;
var<private> sroWCrown: f32;
var<private> sroWLine: f32;
${rainRingCode('wgsl', 'sroWRing')}#endif
var<private> sroWAlb: vec3f;
var<private> sroWAlpha: f32;
var<private> sroWN: vec3f;
#endif
`,
  CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef SRO_WATER
{
  let sroWP = fragmentInputs.vPositionW.xz;
  let sroWT = uniforms.sroWaterA.y;
  let sroWF = textureSample(sroWaterFrames, sroWaterFramesSampler, sroWP / ${WATER_FRAME_REPEAT_M.toFixed(1)}, i32(uniforms.sroWaterA.x + 0.5)).rgb;
  let sroWD = fragmentInputs.vColor.r * 9.0 - 1.0;
  let sroWAmp = fragmentInputs.vColor.g * 2.0 * uniforms.sroWaterC.w;
  let sroN0 = textureSample(sroWaterNormal, sroWaterNormalSampler, (sroWP + sroWT * ${v2('wgsl', L0.scroll[0], L0.scroll[1])}) / ${L0.periodM.toFixed(1)}).xy * 2.0 - vec2f(1.0);
  let sroN1 = textureSample(sroWaterNormal, sroWaterNormalSampler, (sroWP + sroWT * ${v2('wgsl', L1.scroll[0], L1.scroll[1])}) / ${L1.periodM.toFixed(1)}).xy * 2.0 - vec2f(1.0);
  var sroSlope = (sroN0 + sroN1 * 0.7) * (0.35 * sroWAmp);
#ifdef SRO_WATER_RIPPLE
  let sroRu = sroWP * ${WATER_RING_SCALE.toFixed(3)};
  let sroRr = clamp(uniforms.sroWaterA.z, 0.0, 1.0);
${ringTaps('wgsl', 'sroWRing', 'sroWaterRipple', 'sroRu', null, null, 'uniforms.sroWaterA.w', 'sroRr', 'sroR')}  let sroRa = smoothstep(0.0, 0.15, sroRr) * (1.0 - smoothstep(${WATER_RING_FADE_M[0].toFixed(1)}, ${WATER_RING_FADE_M[1].toFixed(1)}, distance(scene.vEyePosition.xyz, fragmentInputs.vPositionW)));
  sroSlope = sroSlope + vec2f(sroR.x, -sroR.y) * (${WATER_RING_GAIN.toFixed(2)} * sroRa);
  sroWCrown = clamp(sroR.z * sroRa, 0.0, 1.0);
  sroWLine = clamp(max(sroR.w, 0.0) * sroRa * ${WATER_RING_LINE.toFixed(2)}, 0.0, 1.0);
  sroWGlint = (max(sroR.w, 0.0) + sroR.z) * sroRa;
#endif
  sroWN = normalize(vec3f(sroSlope.x, 1.0, -sroSlope.y));
  let sroShallow = pow(clamp(sroWF * uniforms.sroWaterB.rgb, vec3f(0.0), vec3f(1.0)), vec3f(2.2)) * ${WATER_ALBEDO_WEIGHT.toFixed(2)};
#ifdef SRO_WATER_SHORE
  let sroDeep = clamp(sroWD / 4.0, 0.0, 1.0);
  let sroFoam = ${FOAM} * clamp(0.6 + sroN0.x, 0.0, 1.0);
  sroWAlpha = max(clamp(sroWD / ${WATER_SHORE_M.toFixed(2)}, 0.0, 1.0), sroFoam * 0.7);
  sroWAlb = mix(mix(sroShallow, sroShallow * uniforms.sroWaterC.rgb, sroDeep), vec3f(0.55), sroFoam);
#else
  let sroDeep = clamp(fragmentInputs.vColor.a, 0.0, 1.0);
  sroWAlpha = clamp(fragmentInputs.vColor.a, 0.0, 1.0);
  sroWAlb = mix(sroShallow, sroShallow * uniforms.sroWaterC.rgb, sroDeep);
#endif
}
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALBEDO: `#ifdef SRO_WATER
surfaceAlbedo = sroWAlb;
#ifdef SRO_WATER_RIPPLE
surfaceAlbedo = mix(mix(surfaceAlbedo, vec3f(${WATER_RING_LINE_ALBEDO.toFixed(2)}), sroWLine), vec3f(${WATER_CROWN_ALBEDO.toFixed(2)}), sroWCrown * 0.8);
#endif
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `#ifdef SRO_WATER
alpha = sroWAlpha;
#ifdef SRO_WATER_RIPPLE
alpha = max(alpha, max(sroWCrown * 0.85, sroWLine * 1.5));
#endif
normalW = sroWN;
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `#ifdef SRO_WATER
metallicRoughness = vec2f(0.0, uniforms.sroWaterB.w);
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `#ifdef SRO_WATER
#ifdef SRO_WATER_RIPPLE
#ifdef REFLECTION
finalEmissive = finalEmissive + reflectionOut.environmentRadiance.rgb * (uniforms.vLightingIntensity.z * ${WATER_RING_GLINT.toFixed(2)} * sroWGlint);
#endif
#endif
#endif
`,
}

const GLSL: Record<string, string> = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef SRO_WATER
uniform highp sampler2DArray sroWaterFrames;
uniform sampler2D sroWaterNormal;
#ifdef SRO_WATER_RIPPLE
uniform sampler2D sroWaterRipple;
float sroWGlint;
float sroWCrown;
float sroWLine;
${rainRingCode('glsl', 'sroWRing')}#endif
vec3 sroWAlb;
float sroWAlpha;
vec3 sroWN;
#endif
`,
  CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef SRO_WATER
{
  vec2 sroWP = vPositionW.xz;
  float sroWT = sroWaterA.y;
  vec3 sroWF = texture(sroWaterFrames, vec3(sroWP / ${WATER_FRAME_REPEAT_M.toFixed(1)}, floor(sroWaterA.x + 0.5))).rgb;
  float sroWD = vColor.r * 9.0 - 1.0;
  float sroWAmp = vColor.g * 2.0 * sroWaterC.w;
  vec2 sroN0 = texture(sroWaterNormal, (sroWP + sroWT * ${v2('glsl', L0.scroll[0], L0.scroll[1])}) / ${L0.periodM.toFixed(1)}).xy * 2.0 - vec2(1.0);
  vec2 sroN1 = texture(sroWaterNormal, (sroWP + sroWT * ${v2('glsl', L1.scroll[0], L1.scroll[1])}) / ${L1.periodM.toFixed(1)}).xy * 2.0 - vec2(1.0);
  vec2 sroSlope = (sroN0 + sroN1 * 0.7) * (0.35 * sroWAmp);
#ifdef SRO_WATER_RIPPLE
  vec2 sroRu = sroWP * ${WATER_RING_SCALE.toFixed(3)};
  float sroRr = clamp(sroWaterA.z, 0.0, 1.0);
${ringTaps('glsl', 'sroWRing', 'sroWaterRipple', 'sroRu', null, null, 'sroWaterA.w', 'sroRr', 'sroR')}  float sroRa = smoothstep(0.0, 0.15, sroRr) * (1.0 - smoothstep(${WATER_RING_FADE_M[0].toFixed(1)}, ${WATER_RING_FADE_M[1].toFixed(1)}, distance(vEyePosition.xyz, vPositionW)));
  sroSlope += vec2(sroR.x, -sroR.y) * (${WATER_RING_GAIN.toFixed(2)} * sroRa);
  sroWCrown = clamp(sroR.z * sroRa, 0.0, 1.0);
  sroWLine = clamp(max(sroR.w, 0.0) * sroRa * ${WATER_RING_LINE.toFixed(2)}, 0.0, 1.0);
  sroWGlint = (max(sroR.w, 0.0) + sroR.z) * sroRa;
#endif
  sroWN = normalize(vec3(sroSlope.x, 1.0, -sroSlope.y));
  vec3 sroShallow = pow(clamp(sroWF * sroWaterB.rgb, 0.0, 1.0), vec3(2.2)) * ${WATER_ALBEDO_WEIGHT.toFixed(2)};
#ifdef SRO_WATER_SHORE
  float sroDeep = clamp(sroWD / 4.0, 0.0, 1.0);
  float sroFoam = ${FOAM} * clamp(0.6 + sroN0.x, 0.0, 1.0);
  sroWAlpha = max(clamp(sroWD / ${WATER_SHORE_M.toFixed(2)}, 0.0, 1.0), sroFoam * 0.7);
  sroWAlb = mix(mix(sroShallow, sroShallow * sroWaterC.rgb, sroDeep), vec3(0.55), sroFoam);
#else
  float sroDeep = clamp(vColor.a, 0.0, 1.0);
  sroWAlpha = clamp(vColor.a, 0.0, 1.0);
  sroWAlb = mix(sroShallow, sroShallow * sroWaterC.rgb, sroDeep);
#endif
}
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALBEDO: `#ifdef SRO_WATER
surfaceAlbedo = sroWAlb;
#ifdef SRO_WATER_RIPPLE
surfaceAlbedo = mix(mix(surfaceAlbedo, vec3(${WATER_RING_LINE_ALBEDO.toFixed(2)}), sroWLine), vec3(${WATER_CROWN_ALBEDO.toFixed(2)}), sroWCrown * 0.8);
#endif
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `#ifdef SRO_WATER
alpha = sroWAlpha;
#ifdef SRO_WATER_RIPPLE
alpha = max(alpha, max(sroWCrown * 0.85, sroWLine * 1.5));
#endif
normalW = sroWN;
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `#ifdef SRO_WATER
metallicRoughness = vec2(0.0, sroWaterB.w);
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `#ifdef SRO_WATER
#ifdef SRO_WATER_RIPPLE
#ifdef REFLECTION
finalEmissive += reflectionOut.environmentRadiance.rgb * (vLightingIntensity.z * ${WATER_RING_GLINT.toFixed(2)} * sroWGlint);
#endif
#endif
#endif
`,
}

/** The fragment injection points per language (the same keys in both; test/water-pbr.test.ts). */
export function waterFragmentCode(lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  return lang === 'wgsl' ? WGSL : GLSL
}

const UBO = ['sroWaterA', 'sroWaterB', 'sroWaterC'] as const
export const WATER_PLUGIN_SAMPLERS = ['sroWaterFrames', 'sroWaterNormal', 'sroWaterRipple'] as const

// ---- state and plugin -----------------------------------------------------------------------------------------------

/**
 * What the water material binds (water.ts writes it each frame):
 *   a  frame index, animation time (s), rain 0..1 (ripple strength), ripple time (the weather clock, s)
 *   b  water colour rgb (display, noon level), roughness
 *   c  deep multiplier rgb, wave amplitude scale
 */
export class WaterPbrState {
  readonly a = new Vector4(0, 0, 0, 0)
  readonly b = new Vector4(0.25, 0.69, 0.62, WATER_ROUGHNESS[0])
  readonly c = new Vector4(WATER_DEEP[0], WATER_DEEP[1], WATER_DEEP[2], 1)
  frames: BaseTexture | null = null
  normal: BaseTexture | null = null
  ripple: BaseTexture | null = null
  /** Depth shore (High+): the per-vertex depth alpha and the foam band. */
  shore = false
  readonly plugins = new Set<SroWaterPlugin>()

  /** Switches that change defines (a preset or weather-level change; never per frame). */
  setSwitches(shore: boolean, ripple: BaseTexture | null): void {
    const changed = shore !== this.shore || (ripple !== null) !== (this.ripple !== null)
    this.shore = shore
    this.ripple = ripple
    if (changed) for (const p of this.plugins) p.markAllDefinesAsDirty()
  }
}

export class SroWaterPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly state: WaterPbrState) {
    super(material, SRO_WATER_PLUGIN, 240, { SRO_WATER: false, SRO_WATER_SHORE: false, SRO_WATER_RIPPLE: false }, true, true)
    state.plugins.add(this)
  }

  override getClassName(): string {
    return 'SroWaterPlugin'
  }

  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines): void {
    const s = this.state
    const on = s.frames !== null && s.normal !== null
    defines['SRO_WATER'] = on
    defines['SRO_WATER_SHORE'] = on && s.shore
    defines['SRO_WATER_RIPPLE'] = on && s.ripple !== null
  }

  override getUniforms(language: ShaderLanguage = ShaderLanguage.GLSL) {
    const ubo = UBO.map(name => ({ name, size: 4, type: 'vec4' }))
    if (language === ShaderLanguage.WGSL) return { ubo }
    return { ubo, fragment: `#ifdef SRO_WATER\n${UBO.map(n => `uniform vec4 ${n};`).join('\n')}\n#endif` }
  }

  override getSamplers(samplers: string[]): void {
    samplers.push(...WATER_PLUGIN_SAMPLERS)
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state
    if (!s.frames || !s.normal) return
    ubo.updateVector4('sroWaterA', s.a)
    ubo.updateVector4('sroWaterB', s.b)
    ubo.updateVector4('sroWaterC', s.c)
    ubo.setTexture('sroWaterFrames', s.frames)
    ubo.setTexture('sroWaterNormal', s.normal)
    if (s.ripple) ubo.setTexture('sroWaterRipple', s.ripple)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return { ...waterFragmentCode(language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.state.plugins.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

/** The water normal map texture (tiling, mipmapped). */
export function createWaterNormalTexture(scene: Scene, size = 128): RawTexture {
  const tex = new RawTexture(waterNormalPixels(size), size, size, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  tex.name = 'sroWaterNormal'
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}

/** The PBR water material with its plugin (water.ts; one per world). */
export function createPbrWater(scene: Scene, state: WaterPbrState): { material: PBRMaterial; plugin: SroWaterPlugin } {
  const m = useWindowedLightFalloff(new PBRMaterial('waterPbr', scene))
  m.metallic = 0
  m.roughness = WATER_ROUGHNESS[0]
  m.albedoColor = Color3.White()
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
  m.disableDepthWrite = true
  m.backFaceCulling = false
  m.useRadianceOverAlpha = true
  m.useSpecularOverAlpha = true
  const plugin = new SroWaterPlugin(m, state)
  return { material: m, plugin }
}

/** The PBR ice (RENDER §7: roughness 0.2, stone-like, no plugin). */
export function createPbrIce(scene: Scene, texture: BaseTexture | null): PBRMaterial {
  const m = useWindowedLightFalloff(new PBRMaterial('icePbr', scene))
  m.metallic = 0
  m.roughness = 0.2
  if (texture) m.albedoTexture = texture
  return m
}
