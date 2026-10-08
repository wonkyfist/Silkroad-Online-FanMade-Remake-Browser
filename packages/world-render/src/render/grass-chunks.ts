/**
 * Renderer chunks for the grass shader (docs/WAVE_PLAN3.md §4.2, D1, D23, D29, D30; docs/RENDER.md §8.2) and
 * `RenderGrass`, the per-frame feed of their uniforms. Owned by RND-W. See shader-chunks.ts for the points and rules.
 *
 * Everything sits behind two defines RenderGrass sets on WorldScatter (never per frame: only when the material path or
 * the preset changes), so Low (Classic, no define) compiles to HEAD's shader and the Low guard holds:
 *
 * - SRO_HDR (the PBR path): the grass stops writing display colour and lights itself in scene-linear HDR like the PBR
 *   materials around it, so the post stack's exposure and tone map treat it alike (without it the exposure of 8 by day
 *   and ~24 at night blew the retail-bright cards out). Per vertex (`vertexLight`): a bent normal (up, leaning 0.6
 *   toward the card's side), the celestial light with a wrapped N·L (wrap 0.4) plus a back-lit translucency lobe
 *   `pow(saturate(V·−L), 4)` (the leaves glow when the sun is behind them), the L1 SH ambient (the RND-L SH at the
 *   environment intensity, so grass and terrain share one sky light), the height fog (RND-P's function and numbers)
 *   and the TAA jitter. Per pixel (`fragmentColor`, the last chunk of the point): sRGB → linear albedo × (sun × sunVis +
 *   ambient). sunVis is the baked root lightmap remapped like the PBR terrain (`(lm − 0.61) / 0.39`, D16's
 *   `mix(1, bakedVis, max(0.35, bakedWeight))`), handed over to the CSM tap inside the shadow range, × the cloud
 *   shadow the sky chunk computed (`vSkyCloud`) on High+.
 *   The chunks before this one (sky, weather, night) work on HEAD's display colour. Their effect is carried over as a
 *   ratio to HEAD's colour: whatever darkened it (wet grass, overcast) multiplies the HDR colour, whatever brightened
 *   it (the night-light splat, the wet sheen, the lightning flash) is display light added back at 1 / exposure (the
 *   night-lights lane's rule for lamp glow on PBR), so the lamps light the grass at night as they do on Low.
 * - SRO_GRASS_CSM (High+, `foliage.grassRootShadow`, with a PCF cascaded shadow map): one shadow tap per vertex at the
 *   plant's root + 0.3 m in the first cascade that holds it (`textureSampleCompareLevel`, legal in the vertex stage),
 *   so plants in a building's or a tree's shadow go dark with it. The map is bound as a depth texture at bind time
 *   (WorldScatter.setDepthTexture: Babylon's setDepthStencilTexture), never a black fallback (a 2D colour texture in a
 *   depth-array slot is a pipeline error), and the define is only on while a map exists.
 *
 * Uniforms (vec4 unless noted; declared only under SRO_HDR):
 *   rgSun      direction to the celestial light xyz, translucency strength (0 = off)
 *   rgSunColor celestial radiance / π rgb (colour × intensity), N·L wrap
 *   rgShA/Y/Z/X  the L1 SH as E(n) / π × environmentIntensity = A + Y n.y + Z n.z + X n.x (rgb)
 *   rgMisc     max(0.35, bakedWeight) (D16), CSM range m (0 = no tap), 1 / exposure, unused
 *   rgJitter   TAA jitter in clip units xy (WorldRender.taaJitter; 0 while TAA jitters the projection itself)
 *   sroFogA, sroFogColor, sroFogSun, sroFogSunColor   RND-P's HeightFog vectors (pbr/fog-plugin.ts), by reference
 *   rgCsm0..3  mat4, the cascades' world → light clip transforms (the generator's own matrices, by reference)
 *   rgCsmInfo  cascade count, unused, darkness, unused
 * Sampler: rgShadowMap (depth 2D array + comparison sampler; vertex stage).
 */
import { Matrix, Vector2, Vector4, type Camera, type RenderTargetTexture, type Scene } from '@babylonjs/core'
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_WGSL, heightFogOf } from '../pbr/fog-plugin.ts'
import { MATERIAL_CLASS_PARAMS } from '../pbr/classes.ts'
import type { SharedUniforms, WorldShaderChunks } from '../shader-chunks.ts'
import { BAKED_LIGHT_DIR, type SkyState } from '../sky/types.ts'
import { WorldLighting, addConstantSH, flashExposureScale, skyStateSH, SH_L1_FLOATS } from './lighting.ts'
import type { RenderPart } from './index.ts'
import type { RenderPath, RenderQuality } from './quality.ts'
import type { RenderWeather } from './weather.ts'

/** The two switches (WorldScatter.setDefine). */
export const GRASS_HDR_DEFINE = 'SRO_HDR'
export const GRASS_CSM_DEFINE = 'SRO_GRASS_CSM'
/** The depth sampler of the CSM tap (bound by WorldScatter.setDepthTexture, never with a colour fallback). */
export const GRASS_SHADOW_SAMPLER = 'rgShadowMap'
/** Cascades the tap looks through (Ultra has 4). */
export const GRASS_CSM_MAX = 4
/** N·L wrap of the bent normal (RENDER §8.2). */
export const GRASS_WRAP = 0.4
/** The CSM tap height above the root (m): clear of the ground's own depth. */
export const GRASS_CSM_LIFT_M = 0.3

const VEC_UNIFORMS = ['rgSun', 'rgSunColor', 'rgShA', 'rgShY', 'rgShZ', 'rgShX', 'rgMisc', 'rgJitter', 'rgCsmInfo'] as const
const FOG_UNIFORMS = ['sroFogA', 'sroFogColor', 'sroFogSun', 'sroFogSunColor'] as const
const CSM_UNIFORMS = Array.from({ length: GRASS_CSM_MAX }, (_, i) => `rgCsm${i}`)
/** Every uniform the chunks declare (ShaderMaterial names). */
export const GRASS_RENDER_UNIFORMS: readonly string[] = [...VEC_UNIFORMS, ...FOG_UNIFORMS, ...CSM_UNIFORMS]

/**
 * The terrain lightmap floor (pbr/terrain-plugin.ts TERRAIN_LIGHTMAP_FLOOR, RENDER §3.4): the grass reads the terrain's
 * own lightmap at its root. A copy, not an import: this file is part of the shader-chunk graph (shaders.ts), which the
 * terrain plugin's imports lead back into; the test checks the two agree.
 */
export const GRASS_LIGHTMAP_FLOOR = 0.61
/** D16's floor of the baked-shadow share (pbr/surface-plugin.ts BAKED_MIN; the test checks they agree). */
export const GRASS_BAKED_MIN = 0.35

const f = (v: number) => v.toFixed(4)
const BAKE_FLOOR = f(GRASS_LIGHTMAP_FLOOR)
const BAKE_RANGE = f(1 - GRASS_LIGHTMAP_FLOOR)

/** D16: max(0.35, saturate(dot(dirToLight, bakeDir) × 2 − 0.6)) (the surface plugin's bakedWeight). */
export function grassBakedWeight(dir: { x: number; y: number; z: number }): number {
  const d = dir.x * BAKED_LIGHT_DIR.x + dir.y * BAKED_LIGHT_DIR.y + dir.z * BAKED_LIGHT_DIR.z
  return Math.max(GRASS_BAKED_MIN, Math.min(1, Math.max(0, d * 2 - 0.6)))
}

// ---- WGSL ---------------------------------------------------------------------------------------------------------

const UNIFORMS_WGSL = `#ifdef SRO_HDR
${VEC_UNIFORMS.map(n => `uniform ${n}: vec4f;\n`).join('')}${FOG_UNIFORMS.map(n => `uniform ${n}: vec4f;\n`).join('')}${CSM_UNIFORMS.map(n => `uniform ${n}: mat4x4f;\n`).join('')}#endif
`
const VARYINGS_WGSL = '#ifdef SRO_HDR\nvarying vRgSun: vec4f;\nvarying vRgAmb: vec4f;\nvarying vRgFog: vec4f;\n#endif\n'

// One tap per cascade candidate: the first cascade whose clip square holds the point answers (Babylon's own CSM order).
const csmTapsWGSL = () => CSM_UNIFORMS.map((m, i) => `  if (!rgDone && n > ${i}) {
    let t = rgCsmTap(uniforms.${m}, ${i}, p);
    if (t.y > 0.5) {
      vis = t.x;
      rgDone = true;
    }
  }
`).join('')

const DECL_WGSL = `#ifdef SRO_HDR
${HEIGHT_FOG_WGSL}
#ifdef SRO_GRASS_CSM
var rgShadowMap: texture_depth_2d_array;
var rgShadowMapSampler: sampler_comparison;
fn rgCsmTap(m: mat4x4f, layer: i32, p: vec3f) -> vec2f {
  let c = m * vec4f(p, 1.0);
  let s = c.xyz / c.w;
  let uv = vec2f(0.5) + 0.5 * s.xy;
  let z = clamp(s.z, 0.0, 0.9999999);
  let v = textureSampleCompareLevel(rgShadowMap, rgShadowMapSampler, uv, layer, z);
  return vec2f(v, select(0.0, 1.0, abs(s.x) < 0.98 && abs(s.y) < 0.98));
}
fn rgCsm(p: vec3f) -> f32 {
  let n = i32(uniforms.rgCsmInfo.x + 0.5);
  var vis = 1.0;
  var rgDone = false;
${csmTapsWGSL()}  return mix(uniforms.rgCsmInfo.z, 1.0, vis);
}
#endif
#endif
`

const LIGHT_WGSL = /* wgsl */ `#ifdef SRO_HDR
  {
    let rgOff = p - root;
    let rgN = normalize(vec3f(rgOff.x, 0.0, rgOff.z) * 0.6 + vec3f(0.0, 1.0, 0.0));
    let rgL = uniforms.rgSun.xyz;
    let rgV = normalize(uniforms.scCamera.xyz - p);
    let rgW = uniforms.rgSunColor.w;
    let rgNl = max((dot(rgN, rgL) + rgW) / (1.0 + rgW), 0.0);
    let rgTr = uniforms.rgSun.w * pow(clamp(dot(rgV, -rgL), 0.0, 1.0), 4.0) * 0.5 * clamp(h / 0.5, 0.2, 1.0);
    let rgAmb = max(uniforms.rgShA.rgb + uniforms.rgShY.rgb * rgN.y + uniforms.rgShZ.rgb * rgN.z + uniforms.rgShX.rgb * rgN.x, vec3f(0.0));
    var rgVis = 1.0;
    var rgFade = 0.0;
#ifdef SRO_GRASS_CSM
    let rgR = uniforms.rgMisc.y;
    if (rgR > 0.0) {
      rgVis = rgCsm(root + vec3f(0.0, ${GRASS_CSM_LIFT_M.toFixed(2)}, 0.0));
      rgFade = 1.0 - smoothstep(rgR * 0.8, rgR, abs((uniforms.view * vec4f(root, 1.0)).z));
    }
#endif
    vertexOutputs.vRgSun = vec4f(uniforms.rgSunColor.rgb * (rgNl + rgTr), rgVis);
    vertexOutputs.vRgAmb = vec4f(rgAmb, rgFade);
    let rgDir = normalize(p - uniforms.scCamera.xyz);
    let rgFogAmt = sroHeightFogAmount(p, uniforms.scCamera.xyz, uniforms.sroFogA);
    vertexOutputs.vRgFog = vec4f(sroHeightFogTint(rgDir, uniforms.sroFogColor.rgb, uniforms.sroFogSun, uniforms.sroFogSunColor.rgb), rgFogAmt);
    vertexOutputs.position = vec4f(vertexOutputs.position.xy + uniforms.rgJitter.xy * vertexOutputs.position.w, vertexOutputs.position.zw);
  }
#endif
`

const COLOR_WGSL = /* wgsl */ `#ifdef SRO_HDR
  {
    var rgLmK = lm;
#ifdef SRO_CLOUDSHADOW
    rgLmK = min(lm, vec3f(0.61)) + max(lm - vec3f(0.61), vec3f(0.0)) * fragmentInputs.vSkyCloud;
#endif
    let rgBase = c.rgb * uniforms.scTint.rgb * fragmentInputs.vShade;
    let rgRef = rgBase * clamp(rgLmK + uniforms.scShadow.rgb, vec3f(0.0), vec3f(1.0));
    let rgMul = min(rgb, rgRef) / max(rgRef, vec3f(0.0001));
    let rgAdd = max(rgb - rgRef, vec3f(0.0));
    let rgBaked = mix(1.0, clamp((dot(lm, vec3f(0.33333334)) - ${BAKE_FLOOR}) / ${BAKE_RANGE}, 0.0, 1.0), uniforms.rgMisc.x);
    var rgVis = mix(rgBaked, fragmentInputs.vRgSun.w, fragmentInputs.vRgAmb.w);
#ifdef SRO_CLOUDSHADOW
    rgVis = rgVis * fragmentInputs.vSkyCloud;
#endif
    let rgAlb = pow(clamp(rgBase, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
    rgb = rgAlb * (fragmentInputs.vRgSun.rgb * rgVis + fragmentInputs.vRgAmb.rgb) * rgMul + pow(rgAdd, vec3f(2.2)) * uniforms.rgMisc.z;
    rgb = mix(rgb, fragmentInputs.vRgFog.rgb, clamp(fragmentInputs.vRgFog.a, 0.0, 1.0));
  }
#endif
`

// ---- GLSL ---------------------------------------------------------------------------------------------------------

const UNIFORMS_GLSL = `#ifdef SRO_HDR
${VEC_UNIFORMS.map(n => `uniform vec4 ${n};\n`).join('')}${FOG_UNIFORMS.map(n => `uniform vec4 ${n};\n`).join('')}${CSM_UNIFORMS.map(n => `uniform mat4 ${n};\n`).join('')}#endif
`
const VARYINGS_GLSL = '#ifdef SRO_HDR\nvarying vec4 vRgSun;\nvarying vec4 vRgAmb;\nvarying vec4 vRgFog;\n#endif\n'

const csmTapsGLSL = () => CSM_UNIFORMS.map((m, i) => `  if (!rgDone && n > ${i}) {
    vec2 t = rgCsmTap(${m}, ${i}.0, p);
    if (t.y > 0.5) {
      vis = t.x;
      rgDone = true;
    }
  }
`).join('')

// WebGL2's clip z is −1..1: the stored depth is 0.5 z + 0.5 (Babylon's ZINCLIP).
const DECL_GLSL = `#ifdef SRO_HDR
${HEIGHT_FOG_GLSL}
#ifdef SRO_GRASS_CSM
uniform highp sampler2DArrayShadow rgShadowMap;
vec2 rgCsmTap(mat4 m, float layer, vec3 p) {
  vec4 c = m * vec4(p, 1.0);
  vec3 s = c.xyz / c.w;
  vec2 uv = vec2(0.5) + 0.5 * s.xy;
  float z = clamp(0.5 * s.z + 0.5, 0.0, 0.9999999);
  float v = texture(rgShadowMap, vec4(uv, layer, z));
  return vec2(v, abs(s.x) < 0.98 && abs(s.y) < 0.98 ? 1.0 : 0.0);
}
float rgCsm(vec3 p) {
  int n = int(rgCsmInfo.x + 0.5);
  float vis = 1.0;
  bool rgDone = false;
${csmTapsGLSL()}  return mix(rgCsmInfo.z, 1.0, vis);
}
#endif
#endif
`

const LIGHT_GLSL = /* glsl */ `#ifdef SRO_HDR
  {
    vec3 rgOff = p - root;
    vec3 rgN = normalize(vec3(rgOff.x, 0.0, rgOff.z) * 0.6 + vec3(0.0, 1.0, 0.0));
    vec3 rgL = rgSun.xyz;
    vec3 rgV = normalize(scCamera.xyz - p);
    float rgW = rgSunColor.w;
    float rgNl = max((dot(rgN, rgL) + rgW) / (1.0 + rgW), 0.0);
    float rgTr = rgSun.w * pow(clamp(dot(rgV, -rgL), 0.0, 1.0), 4.0) * 0.5 * clamp(h / 0.5, 0.2, 1.0);
    vec3 rgAmb = max(rgShA.rgb + rgShY.rgb * rgN.y + rgShZ.rgb * rgN.z + rgShX.rgb * rgN.x, vec3(0.0));
    float rgVis = 1.0;
    float rgFade = 0.0;
#ifdef SRO_GRASS_CSM
    float rgR = rgMisc.y;
    if (rgR > 0.0) {
      rgVis = rgCsm(root + vec3(0.0, ${GRASS_CSM_LIFT_M.toFixed(2)}, 0.0));
      rgFade = 1.0 - smoothstep(rgR * 0.8, rgR, abs((view * vec4(root, 1.0)).z));
    }
#endif
    vRgSun = vec4(rgSunColor.rgb * (rgNl + rgTr), rgVis);
    vRgAmb = vec4(rgAmb, rgFade);
    vec3 rgDir = normalize(p - scCamera.xyz);
    float rgFogAmt = sroHeightFogAmount(p, scCamera.xyz, sroFogA);
    vRgFog = vec4(sroHeightFogTint(rgDir, sroFogColor.rgb, sroFogSun, sroFogSunColor.rgb), rgFogAmt);
    gl_Position.xy += rgJitter.xy * gl_Position.w;
  }
#endif
`

const COLOR_GLSL = /* glsl */ `#ifdef SRO_HDR
  {
    vec3 rgLmK = lm;
#ifdef SRO_CLOUDSHADOW
    rgLmK = min(lm, vec3(0.61)) + max(lm - vec3(0.61), vec3(0.0)) * vSkyCloud;
#endif
    vec3 rgBase = c.rgb * scTint.rgb * vShade;
    vec3 rgRef = rgBase * clamp(rgLmK + scShadow.rgb, 0.0, 1.0);
    vec3 rgMul = min(rgb, rgRef) / max(rgRef, vec3(0.0001));
    vec3 rgAdd = max(rgb - rgRef, vec3(0.0));
    float rgBaked = mix(1.0, clamp((dot(lm, vec3(0.33333334)) - ${BAKE_FLOOR}) / ${BAKE_RANGE}, 0.0, 1.0), rgMisc.x);
    float rgVis = mix(rgBaked, vRgSun.w, vRgAmb.w);
#ifdef SRO_CLOUDSHADOW
    rgVis *= vSkyCloud;
#endif
    vec3 rgAlb = pow(clamp(rgBase, 0.0, 1.0), vec3(2.2));
    rgb = rgAlb * (vRgSun.rgb * rgVis + vRgAmb.rgb) * rgMul + pow(rgAdd, vec3(2.2)) * rgMisc.z;
    rgb = mix(rgb, vRgFog.rgb, clamp(vRgFog.a, 0.0, 1.0));
  }
#endif
`

export const RENDER_GRASS_CHUNKS: WorldShaderChunks = {
  grass: {
    uniforms: GRASS_RENDER_UNIFORMS,
    samplers: [GRASS_SHADOW_SAMPLER],
    wgsl: {
      uniforms: UNIFORMS_WGSL,
      varyings: VARYINGS_WGSL,
      vertexDecl: DECL_WGSL,
      vertexLight: LIGHT_WGSL,
      fragmentColor: COLOR_WGSL,
    },
    glsl: {
      uniforms: UNIFORMS_GLSL,
      varyings: VARYINGS_GLSL,
      vertexDecl: DECL_GLSL,
      vertexLight: LIGHT_GLSL,
      fragmentColor: COLOR_GLSL,
    },
  },
}

// ---- the uniform feed ----------------------------------------------------------------------------------------------

/** Real SH basis constants (render/lighting.ts): Y00 and Y1. */
const Y00 = 0.28209479177387814
const Y1 = 0.4886025119029199
/** Lightning colour of the SH flash (render/lighting.ts FLASH_RGB). */
const FLASH_RGB = [0.82, 0.88, 1] as const

/**
 * The SH ambient as the grass reads it: E(n) / π × env = A + Y n.y + Z n.z + X n.x, from an L1 radiance SH in the
 * SkyState layout ([c00, c1−1 (y), c10 (z), c11 (x)] × RGB). `out` = [A, Y, Z, X] rgb triples.
 */
export function grassSH(sh: ArrayLike<number>, env: number, out: Float32Array = new Float32Array(12)): Float32Array {
  const k1 = (2 / 3) * Y1 * env
  for (let c = 0; c < 3; c++) {
    out[c] = Y00 * sh[c]! * env
    out[3 + c] = k1 * sh[3 + c]!
    out[6 + c] = k1 * sh[6 + c]!
    out[9 + c] = k1 * sh[9 + c]!
  }
  return out
}

/** The wrapped N·L the vertex chunk uses (tests; the shader has the same formula). */
export function wrappedNdotL(nDotL: number, wrap = GRASS_WRAP): number {
  return Math.max(0, (nDotL + wrap) / (1 + wrap))
}

/**
 * The per-pixel HDR composition of the fragment chunk, in TS (tests): `rgb` is the display colour the earlier chunks
 * left, `ref` HEAD's display colour, `base` the unlit display albedo; `light` = sun × sunVis + ambient; `invExposure`
 * 1 / exposure. Per channel.
 */
export function grassHdr(rgb: number, ref: number, base: number, light: number, invExposure: number): number {
  const mul = Math.min(rgb, ref) / Math.max(ref, 1e-4)
  const add = Math.max(rgb - ref, 0)
  return Math.pow(Math.min(1, Math.max(0, base)), 2.2) * light * mul + Math.pow(add, 2.2) * invExposure
}

/** What the grass writes to (WorldScatter). */
export interface GrassTarget {
  readonly sharedUniforms: SharedUniforms
  setDefine(name: string, on: boolean): void
  /** Binds a depth texture at bind time (null: stop). */
  setDepthTexture(name: string, get: (() => RenderTargetTexture | null) | null): void
  /** Switches HEAD's linear fog off (the HDR chunk fogs the grass itself). */
  setOwnFog(off: boolean): void
}

/** The CSM of the renderer's shadow part (RND-L WorldShadows), as far as the tap needs it. */
interface CsmLike {
  numCascades: number
  shadowMaxZ: number
  usePercentageCloserFiltering: boolean
  useContactHardeningShadow?: boolean
  getShadowMap(): RenderTargetTexture | null
  getCascadeTransformMatrix(i: number): Matrix | null
  getDarkness(): number
}

/** What RenderGrass reads (World: its WorldRender and SkySystem). */
export interface GrassRenderSource {
  readonly render: {
    readonly mode: RenderPath
    readonly quality: Readonly<RenderQuality>
    readonly weather: Readonly<RenderWeather>
    readonly taaJitter: Vector2
    readonly lighting: RenderPart | null
    readonly shadows: RenderPart | null
    readonly post: RenderPart | null
    readonly scene: Scene
  }
  readonly sky: { readonly state: Readonly<SkyState> }
}

/**
 * RND-W's grass feed (WorldScatter.follow): the defines on a path or preset change, the uniforms every frame (one
 * write reaches every grass material: they are bound by reference through the scatter's sharedUniforms).
 */
export class RenderGrass {
  readonly sun = new Vector4(0, 1, 0, 0)
  readonly sunColor = new Vector4(0, 0, 0, GRASS_WRAP)
  readonly shA = new Vector4()
  readonly shY = new Vector4()
  readonly shZ = new Vector4()
  readonly shX = new Vector4()
  readonly misc = new Vector4(1, 0, 1, 0)
  readonly jitter = new Vector4()
  readonly csmInfo = new Vector4()
  /** Fog vectors used while the post stack has no HeightFog (amount 0: no fog). */
  private readonly noFog = { a: new Vector4(0, 0, 0, 0), color: new Vector4(), sun: new Vector4(), sunColor: new Vector4() }
  private readonly identity = Matrix.Identity()
  private readonly sh = new Float32Array(SH_L1_FLOATS)
  private readonly shOut = new Float32Array(12)
  private hdr = false
  private csm: CsmLike | null = null
  private readonly boundCsm: (Matrix | null)[] = new Array<Matrix | null>(GRASS_CSM_MAX).fill(null)
  private fogBound: object | null = null
  private disposed = false

  constructor(private readonly target: GrassTarget, private readonly source: GrassRenderSource) {
    const u = target.sharedUniforms
    u.set('rgSun', this.sun)
    u.set('rgSunColor', this.sunColor)
    u.set('rgShA', this.shA)
    u.set('rgShY', this.shY)
    u.set('rgShZ', this.shZ)
    u.set('rgShX', this.shX)
    u.set('rgMisc', this.misc)
    u.set('rgJitter', this.jitter)
    u.set('rgCsmInfo', this.csmInfo)
    for (let i = 0; i < GRASS_CSM_MAX; i++) u.set(CSM_UNIFORMS[i]!, this.identity)
    this.bindFog()
  }

  /** Whether the HDR chunk is on (the PBR path). */
  get active(): boolean {
    return this.hdr
  }

  /** The cascaded shadow map the tap reads (null: none). */
  get shadowTap(): boolean {
    return this.csm !== null
  }

  /** Per frame (WorldScatter.update, after World's render update). */
  update(_camera?: Camera | null): void {
    if (this.disposed) return
    const r = this.source.render
    const pbr = r.mode === 'pbr'
    if (pbr !== this.hdr) {
      this.hdr = pbr
      this.target.setDefine(GRASS_HDR_DEFINE, pbr)
      this.target.setOwnFog(pbr)
    }
    this.syncCsm(pbr ? csmOf(r.shadows, r.quality) : null)
    if (!pbr) return
    this.bindFog()
    const sky = this.source.sky.state
    const q = r.quality
    const lighting = r.lighting instanceof WorldLighting ? r.lighting : null
    // The celestial light as the PBR materials see it (RND-L), else the sky's key light.
    let dx: number, dy: number, dz: number, cr: number, cg: number, cb: number
    if (lighting) {
      const d = lighting.celestial.direction
      const l = d.length() || 1
      dx = -d.x / l
      dy = -d.y / l
      dz = -d.z / l
      const c = lighting.celestial.diffuse
      const i = lighting.celestial.intensity
      cr = c.r * i
      cg = c.g * i
      cb = c.b * i
    } else {
      const k = sky.keyLight
      const l = k.dir.length() || 1
      dx = k.dir.x / l
      dy = k.dir.y / l
      dz = k.dir.z / l
      cr = k.color[0] * k.intensity
      cg = k.color[1] * k.intensity
      cb = k.color[2] * k.intensity
    }
    const translucency = q.foliage.translucency ? MATERIAL_CLASS_PARAMS.foliage.translucency : 0
    this.sun.set(dx, dy, dz, translucency)
    this.sunColor.set(cr / Math.PI, cg / Math.PI, cb / Math.PI, GRASS_WRAP)
    // Ambient: the lighting's SH (+ the flash) at the environment intensity.
    skyStateSH(sky, this.sh)
    const flash = Math.min(1, Math.max(0, r.weather.flash || 0)) * flashExposureScale(sky.exposure)
    if (flash > 0 && lighting) addConstantSH(this.sh, FLASH_RGB, flash * lighting.calibration.flashAmbient)
    const env = lighting ? r.scene.environmentIntensity : 1
    const s = grassSH(this.sh, env, this.shOut)
    this.shA.set(s[0]!, s[1]!, s[2]!, 0)
    this.shY.set(s[3]!, s[4]!, s[5]!, 0)
    this.shZ.set(s[6]!, s[7]!, s[8]!, 0)
    this.shX.set(s[9]!, s[10]!, s[11]!, 0)
    const trim = (r.post as { exposureTrim?: number } | null)?.exposureTrim ?? 1
    const exposure = Math.max(1e-3, (sky.exposure > 0 ? sky.exposure : 1) * trim)
    this.misc.set(grassBakedWeight({ x: dx, y: dy, z: dz }), this.csm ? this.csm.shadowMaxZ : 0, 1 / exposure, 0)
    this.jitter.set(r.taaJitter.x, r.taaJitter.y, 0, 0)
    const csm = this.csm
    if (csm) {
      const n = Math.min(GRASS_CSM_MAX, csm.numCascades)
      this.csmInfo.set(n, 0, csm.getDarkness(), 0)
      // The generator's own matrices, by reference: the shadow pass updates them before the grass binds.
      for (let i = 0; i < GRASS_CSM_MAX; i++) {
        const m = (i < n ? csm.getCascadeTransformMatrix(i) : null) ?? this.identity
        if (m !== this.boundCsm[i]) {
          this.boundCsm[i] = m
          this.target.sharedUniforms.set(CSM_UNIFORMS[i]!, m)
        }
      }
    }
  }

  /** The define and the depth binding follow whether a PCF CSM exists (a preset change, the first shadow frame). */
  private syncCsm(csm: CsmLike | null): void {
    if (csm === this.csm) return
    const had = this.csm !== null
    this.csm = csm
    if (!csm) this.csmInfo.set(0, 0, 0, 0)
    if ((csm !== null) === had) return
    // The depth binding exists only while the tap does (the Classic path never gets a bind observer).
    this.target.setDepthTexture(GRASS_SHADOW_SAMPLER, csm ? () => this.csm?.getShadowMap() ?? null : null)
    this.target.setDefine(GRASS_CSM_DEFINE, csm !== null)
  }

  /** Binds RND-P's HeightFog vectors by reference (or the no-fog set while the post stack has none). */
  private bindFog(): void {
    const fog = heightFogOf(this.source.render.scene)
    const src = fog ?? this.noFog
    if (src === this.fogBound) return
    this.fogBound = src
    const u = this.target.sharedUniforms
    u.set('sroFogA', src.a)
    u.set('sroFogColor', src.color)
    u.set('sroFogSun', src.sun)
    u.set('sroFogSunColor', src.sunColor)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.csm) this.target.setDepthTexture(GRASS_SHADOW_SAMPLER, null)
    if (this.hdr) {
      this.target.setDefine(GRASS_HDR_DEFINE, false)
      this.target.setOwnFog(false)
    }
    if (this.csm) this.target.setDefine(GRASS_CSM_DEFINE, false)
    this.csm = null
    const u = this.target.sharedUniforms
    for (const n of GRASS_RENDER_UNIFORMS) u.delete(n)
  }
}

/** The shadow part's CSM when the preset asks for the root tap and it is a PCF map (else null). */
function csmOf(shadows: RenderPart | null, q: Readonly<RenderQuality>): CsmLike | null {
  if (!q.foliage.grassRootShadow || !shadows) return null
  const g = (shadows as { generator?: CsmLike | null }).generator ?? null
  // PCF or PCSS: both keep the comparison depth map the tap reads.
  if (!g || !(g.usePercentageCloserFiltering || g.useContactHardeningShadow) || !g.getShadowMap()) return null
  return g
}
