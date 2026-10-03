/**
 * Night-light chunks for the Classic shaders (docs/WAVE_PLAN3.md §4.2, D1, D12, D29; docs/SKY.md §7.3): the per-region
 * light splat on the terrain (`postLight`, Low/Medium) and the grass (`fragmentColor`), plus the plugin-side function
 * RND-T calls under `SRO_NIGHT_SPLAT`. The splat texture is bound per region with
 * `TerrainRenderer.setRegionTexture(region, 'nightSplat', tex)`. Created empty by W9A-S; owned by NL. See
 * shader-chunks.ts for the points and rules.
 *
 * Both features sit behind a define that night-lights.ts sets once per preset (never at dusk): `SRO_NIGHT_SPLAT` on the
 * terrain, `SRO_NIGHT_GRASS` on the grass. Without them (and at noon, where `nlNight.x` is 0) the output is HEAD's.
 *
 *   nlNight        vec4, x = SkyState.night × NIGHT_SPLAT_MAX (the splat's decode scale; 0 by day)
 *   nightSplat     per terrain region, 192 × 192 RGBA8 at 1 m per texel over the region (row j = file-z metre j, the
 *                  layer-map convention), rgb = light / NIGHT_SPLAT_MAX; sampled at `lp / 1920`
 *   nlGrass        vec4, (x0, z0, 1 / size, 0): the camera-centred grass window in glTF metres (row v = z0 + v)
 *   nlGrassSplat   that window (the region splats copied around the camera; the grass has no per-region texture)
 *
 * The grass fragment has no world position: the root's region-local file position comes back from the lightmap uv
 * (`vLm = (0.5 + l × 511 / 1920) / 512`, scatter-assets.ts) and the region origin from `scRegion`, so no varying is
 * added. Every tap is `textureSampleLevel` (WGSL uniformity).
 */
import type { WorldShaderChunks } from './shader-chunks.ts'

/** The splat's decode scale: a texel of 1 adds this much albedo at full night (night-lights.ts encodes with it). */
export const NIGHT_SPLAT_MAX = 2
/** Terrain splat define (Low and Medium, D29) and grass define (every preset but Off). */
export const NIGHT_TERRAIN_DEFINE = 'SRO_NIGHT_SPLAT'
export const NIGHT_GRASS_DEFINE = 'SRO_NIGHT_GRASS'
/** Names the chunks declare (bound by night-lights.ts through the renderers' sharedUniforms / setRegionTexture). */
export const NIGHT_UNIFORM = 'nlNight'
export const NIGHT_SPLAT_SAMPLER = 'nightSplat'
export const NIGHT_GRASS_UNIFORM = 'nlGrass'
export const NIGHT_GRASS_SAMPLER = 'nlGrassSplat'

export const NIGHT_CHUNKS: WorldShaderChunks = {
  terrain: {
    uniforms: [NIGHT_UNIFORM],
    samplers: [NIGHT_SPLAT_SAMPLER],
    wgsl: {
      uniforms: 'uniform nlNight: vec4f;\n',
      samplers: 'var nightSplat: texture_2d<f32>;\nvar nightSplatSampler: sampler;\n',
      postLight: `#ifdef SRO_NIGHT_SPLAT
  color = color + albedo * textureSampleLevel(nightSplat, nightSplatSampler, lp / 1920.0, 0.0).rgb * uniforms.nlNight.x;
#endif
`,
    },
    glsl: {
      uniforms: 'uniform vec4 nlNight;\n',
      samplers: 'uniform sampler2D nightSplat;\n',
      postLight: `#ifdef SRO_NIGHT_SPLAT
  color += albedo * textureLod(nightSplat, lp / 1920.0, 0.0).rgb * nlNight.x;
#endif
`,
    },
  },
  grass: {
    uniforms: [NIGHT_UNIFORM, NIGHT_GRASS_UNIFORM],
    samplers: [NIGHT_GRASS_SAMPLER],
    wgsl: {
      uniforms: 'uniform nlNight: vec4f;\nuniform nlGrass: vec4f;\n',
      samplers: 'var nlGrassSplat: texture_2d<f32>;\nvar nlGrassSplatSampler: sampler;\n',
      fragmentColor: `#ifdef SRO_NIGHT_GRASS
  let nlL = (fragmentInputs.vLm * 512.0 - vec2f(0.5)) * (1920.0 / 511.0);
  let nlUv = (vec2f(uniforms.scRegion.x + nlL.x * 0.1, uniforms.scRegion.z - nlL.y * 0.1) - uniforms.nlGrass.xy) * uniforms.nlGrass.z;
  rgb = rgb + c.rgb * uniforms.scTint.rgb * fragmentInputs.vShade * textureSampleLevel(nlGrassSplat, nlGrassSplatSampler, nlUv, 0.0).rgb * uniforms.nlNight.x;
#endif
`,
    },
    glsl: {
      uniforms: 'uniform vec4 nlNight;\nuniform vec4 nlGrass;\n',
      samplers: 'uniform sampler2D nlGrassSplat;\n',
      fragmentColor: `#ifdef SRO_NIGHT_GRASS
  vec2 nlL = (vLm * 512.0 - vec2(0.5)) * (1920.0 / 511.0);
  vec2 nlUv = (vec2(scRegion.x + nlL.x * 0.1, scRegion.z - nlL.y * 0.1) - nlGrass.xy) * nlGrass.z;
  rgb += c.rgb * scTint.rgb * vShade * textureLod(nlGrassSplat, nlUv, 0.0).rgb * nlNight.x;
#endif
`,
    },
  },
}

/**
 * `sroNightSplat(tex, smp, lp, night)` for the PBR terrain plugin (RND-T, under SRO_NIGHT_SPLAT on Low/Medium, D29):
 * the region's splat light at region-local file position `lp` (0..1920), times `night` (= nlNight.x). The plugin binds
 * `TerrainRegionGpu.textures.nightSplat` and multiplies the result by its albedo (added after the lit colour).
 */
export const NIGHT_SPLAT_WGSL = `fn sroNightSplat(tex: texture_2d<f32>, smp: sampler, lp: vec2f, night: f32) -> vec3f {
  return textureSampleLevel(tex, smp, lp / 1920.0, 0.0).rgb * night;
}
`
export const NIGHT_SPLAT_GLSL = `vec3 sroNightSplat(sampler2D tex, vec2 lp, float night) {
  return textureLod(tex, lp / 1920.0, 0.0).rgb * night;
}
`
