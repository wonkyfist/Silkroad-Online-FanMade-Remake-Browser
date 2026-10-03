/**
 * Sky chunks for the Classic shaders (docs/WAVE_PLAN3.md §4.2, D1, D28; docs/SKY.md §5.5, §8 T1/S1), owned by SKY-B.
 * See shader-chunks.ts for the points and rules. Everything sits behind two defines the SkySystem sets from the
 * Options (never per frame), so Low + classic sky has no define and renders as HEAD:
 *
 * - SRO_SKY_LIGHT (modern sky on the Classic path): the day/night light of the Classic ground. The terrain and grass
 *   are unlit (colour × saturate(lightmap + shadow colour)); the lightmap's ambient part (≤ 0.61) is scaled by
 *   `skyGround` and its baked-sun part by `skyGroundSun` (both 1 at a clear noon: the retail image).
 * - SRO_CLOUDSHADOW (cloud shadows on, High+): the baked-sun part × `sroCloudShadow(worldPos)`, one cloud-noise tap
 *   along the key light to the cloud shell (terrain `lightTerm`; the grass once per plant in `vertexLight`, handed to
 *   the fragment as `vSkyCloud`, which a later grass chunk may reuse on its own direct term).
 *
 * Uniforms: skyGround (rgb ambient scale), skyGroundSun (rgb sun scale), skyCloudShadow (xy uv offset, z 1 / scale
 * per metre, w strength), skyCloudProj (xy key light xz / y, z shell height in metres, w cover); sampler cloudNoise.
 * SkyState carries the same values (ground, cloudShadow, cloudShadowProj, cloudNoise).
 *
 * `SKY_CLOUD_SHADOW_WGSL` / `_GLSL` are the same function for the PBR plugins (D28: RND-T, RND-M call it inside
 * their CUSTOM_LIGHT0_COLOR code under SRO_CLOUDSHADOW): `sroCloudShadow(worldPos: vec3) -> f32`, 1 = no cloud. They
 * declare the `cloudNoise` texture; the plugin adds `SKY_CLOUD_SHADOW_UBO` to its uniforms (WGSL reads them as
 * `uniforms.skyCloudShadow`) and `SKY_CLOUD_SHADOW_SAMPLERS` to its samplers.
 */
import type { WorldShaderChunks } from '../shader-chunks.ts'

/** The uniforms the chunks and the PBR function read (ShaderMaterial names; UBO entries for a MaterialPlugin). */
export const SKY_CHUNK_UNIFORMS = ['skyGround', 'skyGroundSun', 'skyCloudShadow', 'skyCloudProj'] as const
export const SKY_CLOUD_SHADOW_UBO: ReadonlyArray<{ name: string; size: number; type: string }> = [
  { name: 'skyCloudShadow', size: 4, type: 'vec4' },
  { name: 'skyCloudProj', size: 4, type: 'vec4' },
]
export const SKY_CLOUD_SHADOW_SAMPLERS = ['cloudNoise'] as const
/** GLSL uniform declarations for a plugin that declares its own (non-UBO path). */
export const SKY_CLOUD_SHADOW_UNIFORMS_GLSL = 'uniform vec4 skyCloudShadow;\nuniform vec4 skyCloudProj;\n'

const TEX_WGSL = 'var cloudNoise: texture_2d<f32>;\nvar cloudNoiseSampler: sampler;\n'
const TEX_GLSL = 'uniform sampler2D cloudNoise;\n'

/** The shadow function body (textureSampleLevel: legal in any stage and any branch). */
const FN_WGSL = `fn sroCloudShadow(p: vec3f) -> f32 {
  let s = uniforms.skyCloudShadow;
  let q = uniforms.skyCloudProj;
  let uv = (p.xz + q.xy * (q.z - p.y)) * s.z + s.xy;
  let low = textureSampleLevel(cloudNoise, cloudNoiseSampler, uv * 0.25, 0.0).a;
  let cov = clamp(q.w + (low - 0.5) * 0.3 * (1.0 - q.w), 0.001, 1.0);
  let r = textureSampleLevel(cloudNoise, cloudNoiseSampler, uv, 1.0).r;
  let d = clamp((r - (1.0 - cov)) / cov, 0.0, 1.0);
  return 1.0 - s.w * (1.0 - exp(-d * 9.0));
}
`
const FN_GLSL = `float sroCloudShadow(vec3 p) {
  vec4 s = skyCloudShadow;
  vec4 q = skyCloudProj;
  vec2 uv = (p.xz + q.xy * (q.z - p.y)) * s.z + s.xy;
  float low = textureLod(cloudNoise, uv * 0.25, 0.0).a;
  float cov = clamp(q.w + (low - 0.5) * 0.3 * (1.0 - q.w), 0.001, 1.0);
  float r = textureLod(cloudNoise, uv, 1.0).r;
  float d = clamp((r - (1.0 - cov)) / cov, 0.0, 1.0);
  return 1.0 - s.w * (1.0 - exp(-d * 9.0));
}
`

export const SKY_CLOUD_SHADOW_WGSL = TEX_WGSL + FN_WGSL
export const SKY_CLOUD_SHADOW_GLSL = TEX_GLSL + FN_GLSL

const ANY = '#if defined(SRO_SKY_LIGHT) || defined(SRO_CLOUDSHADOW)\n'

const UNIFORMS_WGSL = `${ANY}uniform skyGround: vec4f;
uniform skyGroundSun: vec4f;
uniform skyCloudShadow: vec4f;
uniform skyCloudProj: vec4f;
#endif
`
const UNIFORMS_GLSL = `${ANY}uniform vec4 skyGround;
uniform vec4 skyGroundSun;
uniform vec4 skyCloudShadow;
uniform vec4 skyCloudProj;
#endif
`
const SHADOW_DECL_WGSL = `#ifdef SRO_CLOUDSHADOW\n${TEX_WGSL}${FN_WGSL}#endif\n`
const SHADOW_DECL_GLSL = `#ifdef SRO_CLOUDSHADOW\n${TEX_GLSL}${FN_GLSL}#endif\n`

/** The light split of the lightmap `lm` (a vec3 expression) into `out` (WGSL / GLSL statements). */
const splitWGSL = (lm: string, out: string, cloud: string) => `    var skySunK = vec3f(1.0);
    var skyAmbK = vec3f(1.0);
#ifdef SRO_SKY_LIGHT
    skySunK = uniforms.skyGroundSun.rgb;
    skyAmbK = uniforms.skyGround.rgb;
#endif
#ifdef SRO_CLOUDSHADOW
    skySunK = skySunK * ${cloud};
#endif
    ${out} = min(${lm}, vec3f(0.61)) * skyAmbK + max(${lm} - vec3f(0.61), vec3f(0.0)) * skySunK;
`
const splitGLSL = (lm: string, out: string, cloud: string) => `    vec3 skySunK = vec3(1.0);
    vec3 skyAmbK = vec3(1.0);
#ifdef SRO_SKY_LIGHT
    skySunK = skyGroundSun.rgb;
    skyAmbK = skyGround.rgb;
#endif
#ifdef SRO_CLOUDSHADOW
    skySunK *= ${cloud};
#endif
    ${out} = min(${lm}, vec3(0.61)) * skyAmbK + max(${lm} - vec3(0.61), vec3(0.0)) * skySunK;
`

export const SKY_CHUNKS: WorldShaderChunks = {
  terrain: {
    uniforms: SKY_CHUNK_UNIFORMS,
    samplers: SKY_CLOUD_SHADOW_SAMPLERS,
    vWorld: true,
    wgsl: {
      uniforms: UNIFORMS_WGSL,
      samplers: SHADOW_DECL_WGSL,
      lightTerm: `${ANY}${splitWGSL('lmT', 'lmT', 'sroCloudShadow(fragmentInputs.vWorld)')}#endif\n`,
    },
    glsl: {
      uniforms: UNIFORMS_GLSL,
      samplers: SHADOW_DECL_GLSL,
      lightTerm: `${ANY}${splitGLSL('lmT', 'lmT', 'sroCloudShadow(vWorld)')}#endif\n`,
    },
  },
  grass: {
    uniforms: SKY_CHUNK_UNIFORMS,
    samplers: SKY_CLOUD_SHADOW_SAMPLERS,
    wgsl: {
      uniforms: UNIFORMS_WGSL,
      varyings: '#ifdef SRO_CLOUDSHADOW\nvarying vSkyCloud: f32;\n#endif\n',
      vertexDecl: SHADOW_DECL_WGSL,
      vertexLight: '#ifdef SRO_CLOUDSHADOW\n  vertexOutputs.vSkyCloud = sroCloudShadow(root + vec3f(0.0, 0.3, 0.0));\n#endif\n',
      fragmentColor: `${ANY}  {
${splitWGSL('lm', 'let skyLm', 'fragmentInputs.vSkyCloud')}    rgb = c.rgb * uniforms.scTint.rgb * clamp(skyLm + uniforms.scShadow.rgb, vec3f(0.0), vec3f(1.0)) * fragmentInputs.vShade;
  }
#endif
`,
    },
    glsl: {
      uniforms: UNIFORMS_GLSL,
      varyings: '#ifdef SRO_CLOUDSHADOW\nvarying float vSkyCloud;\n#endif\n',
      vertexDecl: SHADOW_DECL_GLSL,
      vertexLight: '#ifdef SRO_CLOUDSHADOW\n  vSkyCloud = sroCloudShadow(root + vec3(0.0, 0.3, 0.0));\n#endif\n',
      fragmentColor: `${ANY}  {
${splitGLSL('lm', 'vec3 skyLm', 'vSkyCloud')}    rgb = c.rgb * scTint.rgb * clamp(skyLm + scShadow.rgb, 0.0, 1.0) * vShade;
  }
#endif
`,
    },
  },
}
