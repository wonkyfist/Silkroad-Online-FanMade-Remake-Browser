/**
 * The grass field's shaders (docs/GRASS_LIFE.md §2.1, §3.3–§3.7, §4.1; lane GL-S), WGSL for WebGPU and GLSL ES 3.0 for
 * WebGL2, and the skeleton the wildlife shares (life/shaders.ts). Ported from the prototype
 * (work/tmp/grass-life/lab/grass-shaders.ts).
 *
 * The skeleton keeps the retail grass shader's chunk contract (scatter-assets.ts `scatterShaders`, shader-chunks.ts
 * GrassPoint): the same names in the vertex main (`finalWorld`, `root`, `wp`, `h`, `s`, `ph`, `t`, `sway`, `bend`, `p`)
 * and in the fragment (`c`, `lm`, `rgb`), the same `scCamera` / `scFade` / `scRegion` / `scTint` / `scShadow` / fog
 * uniforms, the `vLm` / `vShade` / `vDepth` varyings and the same chunk points in the same places. So the sky, weather,
 * night-light and RND-W chunks light the new grass with no edit to any of them. `vCol` (vec3) takes the place of the
 * retail `vUV` (vec2): the varying count is the retail grass's.
 *
 * GPU-procedural patches: one shared mesh per LOD tier holds every blade of one 8 m cell (grass/patch.ts); the thin
 * instance is only the cell's south-west corner (`finalWorld[3].xz`); each blade reads, from the camera-centred 256 m
 * field window (grass/window.ts), its density (R), the meadow mask (G), the palette slot (B) and the ground height
 * (the terrain's own triangulation, rebuilt from four texels of the 2 m height grid).
 *
 * Uniforms (vec4 unless noted):
 *   grField  x0, z0 (the window's south-west corner, glTF m), hMin, hRange (the height grid's 16-bit span)
 *   grLod0   tier-2 fade start, end; tier-1 fade start, end (m from the camera, 2D)
 *   grLod1   tier-0 cut-off min, max (m); density scale; height scale
 *   grStyle  blade width (m), camera-facing share (0.55), flower range (m), blades per clump
 *   grPal    vec4[GRASS_PALETTE_SLOTS × 2]: per palette slot (base, tip), display sRGB 0..1
 *   grPlayer the local player's position xyz and the push radius (m)
 *   grView   pixel size per metre of distance (2 tan(fov / 2) / render height), the minimum blade width (px), the band
 *            noise (m: GRASS_FAR pulls the tier-0 cut-off inward by up to this much, `GRASS_BAND_FREQ` value noise), 0
 * Vertex textures (read with textureLoad / texelFetch: no filtering, no sampler state):
 *   grFieldA RGBA8 256 × 256 at 1 m: R density, G meadow, B palette slot, A baked light (1 = none)
 *   grFieldH RGBA8 129 × 129 at 2 m: the height, 16 bits in R (high) and G (low) over [hMin, hMin + hRange]
 * Fragment texture:
 *   scLightmap the field window again (its A channel, bilinear): the baked terrain light at the root; `scRegion.y`
 *              switches it (0: lm = 1), `scRegion` = (x0, lightmap on, z0 + 256, 0) plays the region origin's role for
 *              the root position the night chunk decodes from `vLm`.
 */
import { ShaderStore } from '@babylonjs/core'
import { ChunkSet, type GrassPoint, type WorldShaderChunks } from '../shader-chunks.ts'
import { WORLD_SHADER_CHUNKS, vWorldParts, type Both, type ShaderSources } from '../shaders.ts'
import { SCATTER_BASE_UNIFORMS } from '../scatter-assets.ts'

/** The window's size (m, 1 m per texel) and the height grid (2 m vertices). */
export const GRASS_WINDOW_M = 256
export const GRASS_HEIGHT_GRID = GRASS_WINDOW_M / 2 + 1
/** The patch cell (m). */
export const GRASS_CELL_M = 8
/** Palette slots in grPal (each a base and a tip colour). */
export const GRASS_PALETTE_SLOTS = 16
/** Each blade is at least this wide at its mid-height (px, GRASS_LIFE §3.4 fact-check). */
export const GRASS_MIN_BLADE_PX = 1
/** The camera-facing share of each blade's yaw (GRASS_LIFE §2.1, the user's "make them face you"). */
export const GRASS_FACE_CAMERA = 0.55
/** The player's push radius (m). */
export const GRASS_PUSH_M = 0.9
/**
 * GRASS_FAR's band noise (docs/GRASS_FAR.md §2.3): value noise at this frequency (1/m, ≈ 37 m blobs) pulls the near
 * ring's tier-0 cut-off, the meadow ring's fade-in and the terrain tint's ramp inward by up to the level's `band` m, all
 * by the same amount at a point, so the hand-over between the rings wanders instead of drawing a circle.
 */
export const GRASS_BAND_FREQ = '0.027'
/** Half the blade width at mid-height over the base half width: (1 − 0.5)^0.7. */
export const GRASS_MID_WIDTH = Math.pow(0.5, 0.7)

export const GRASS_FIELD_SAMPLER = 'grFieldA'
export const GRASS_HEIGHT_SAMPLER = 'grFieldH'
export const GRASS_SHADER = 'sroGrassField'
/** Vertex attributes of the patch meshes (grass/patch.ts). */
export const GRASS_ATTRIBUTES: readonly string[] = ['position', 'bladeA', 'bladeB']

type Decl = { name: string; wgsl: string; glsl: string }

/** What a body adds to the skeleton. */
export interface GrassSkeletonParts {
  /** Extra vertex attributes (read as vertexInputs.x / x). */
  attributes: readonly Decl[]
  /** Extra uniforms; a GLSL array type is written `vec4[N]`. */
  uniforms: readonly Decl[]
  /** Vertex-stage textures, read with textureLoad (WGSL) / texelFetch (GLSL). */
  vertexTextures: readonly string[]
  /** Extra varyings. */
  varyings: readonly Decl[]
  /** Vertex helper functions (after grHash12 / grNoise). */
  vertexFns: Both
  /** Defines `root` (vec3), `var p` (vec3), `wp` (vec3), `h` (f32), `s` (f32); writes vCol and vShade. */
  vertexBody: Both
  /** Defines `c` (vec4, display albedo); may discard. */
  fragmentBody: Both
  /** Insert the vertexSway point (the weather wind): the grass does, the animals do not. */
  sway: boolean
}

const HASH_WGSL = /* wgsl */ `fn grHash12(q: vec2f) -> f32 {
  let r = fract(q * vec2f(0.1031, 0.1030));
  let d = r + dot(r, r.yx + 33.33);
  return fract((d.x + d.y) * d.x);
}
fn grNoise(q: vec2f) -> f32 {
  let i = floor(q);
  let f = fract(q);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(grHash12(i), grHash12(i + vec2f(1.0, 0.0)), u.x), mix(grHash12(i + vec2f(0.0, 1.0)), grHash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}
`
const HASH_GLSL = /* glsl */ `float grHash12(vec2 q) {
  vec2 r = fract(q * vec2(0.1031, 0.1030));
  vec2 d = r + dot(r, r.yx + 33.33);
  return fract((d.x + d.y) * d.x);
}
float grNoise(vec2 q) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(grHash12(i), grHash12(i + vec2(1.0, 0.0)), u.x), mix(grHash12(i + vec2(0.0, 1.0)), grHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`

/**
 * A height function over a window's height grid (`fn <name>(fp) -> f32`, fp = the window-relative position in m): the
 * terrain's triangulation from four texels of the 2 m grid `tex` (grid × grid), decoded over `uniform`.zw. The near
 * window's is GRASS_HEIGHT_WGSL / GRASS_HEIGHT_GLSL; the meadow ring's reads its own window (grass/ring-shaders.ts).
 */
export function grassHeightFn(name: string, tex: string, uniform: string, grid: number): Both {
  const wgsl = /* wgsl */ `fn ${name}(fp: vec2f) -> f32 {
  let g = fp * 0.5;
  let i = clamp(vec2i(floor(g)), vec2i(0), vec2i(${grid - 2}));
  let f = clamp(g - vec2f(i), vec2f(0.0), vec2f(1.0));
  let k = vec2f(65280.0 / 65535.0, 255.0 / 65535.0);
  let h01 = dot(textureLoad(${tex}, i, 0).rg, k);
  let h11 = dot(textureLoad(${tex}, i + vec2i(1, 0), 0).rg, k);
  let h00 = dot(textureLoad(${tex}, i + vec2i(0, 1), 0).rg, k);
  let h10 = dot(textureLoad(${tex}, i + vec2i(1, 1), 0).rg, k);
  let fx = f.x;
  let fz = 1.0 - f.y;
  var hv = h00 + (h01 - h00) * fz + (h11 - h01) * fx;
  if (fx >= fz) {
    hv = h00 + (h10 - h00) * fx + (h11 - h10) * fz;
  }
  return uniforms.${uniform}.z + hv * uniforms.${uniform}.w;
}
`
  const glsl = /* glsl */ `float ${name}(vec2 fp) {
  vec2 g = fp * 0.5;
  ivec2 i = clamp(ivec2(floor(g)), ivec2(0), ivec2(${grid - 2}));
  vec2 f = clamp(g - vec2(i), vec2(0.0), vec2(1.0));
  vec2 k = vec2(65280.0 / 65535.0, 255.0 / 65535.0);
  float h01 = dot(texelFetch(${tex}, i, 0).rg, k);
  float h11 = dot(texelFetch(${tex}, i + ivec2(1, 0), 0).rg, k);
  float h00 = dot(texelFetch(${tex}, i + ivec2(0, 1), 0).rg, k);
  float h10 = dot(texelFetch(${tex}, i + ivec2(1, 1), 0).rg, k);
  float fx = f.x;
  float fz = 1.0 - f.y;
  float hv = fx >= fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h01 - h00) * fz + (h11 - h01) * fx;
  return ${uniform}.z + hv * ${uniform}.w;
}
`
  return { wgsl, glsl }
}

/**
 * The field window's height at a window-relative position `fp` (m): the terrain's triangulation (format.ts
 * terrainHeightAt: split along (gx, gz)–(gx+1, gz+1), file z north = −glTF z), from four texels of the 2 m grid.
 * Texel row j is the vertex row at z0 + 2 j, so the file cell's south-west corner (gx, gz) is row j + 1.
 */
const NEAR_HEIGHT = grassHeightFn('grHeightAt', 'grFieldH', 'grField', GRASS_HEIGHT_GRID)
export const GRASS_HEIGHT_WGSL = NEAR_HEIGHT.wgsl
export const GRASS_HEIGHT_GLSL = NEAR_HEIGHT.glsl

/**
 * Builds a shader pair on the grass skeleton with `lanes`' chunks (default WORLD_SHADER_CHUNKS). With every chunk
 * empty the skeleton is the retail grass's minus its texture: the same points, uniforms and varyings (vCol for vUV).
 * `windowM`: the side (m) of the window whose A channel `scLightmap` is (GRASS_FAR: the meadow ring's is 832 m).
 */
export function grassSkeleton(parts: GrassSkeletonParts, lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS, windowM = GRASS_WINDOW_M): ShaderSources {
  const c: ChunkSet<GrassPoint> = ChunkSet.of(lanes, 'grass')
  const { vwDecl, vwOut } = vWorldParts(c.vWorld, { wgsl: '  vertexOutputs.vWorld = p;\n', glsl: '  vWorld = p;\n' })
  const sway: Both = parts.sway
    ? { wgsl: c.at('wgsl', 'vertexSway') || '  p = p + vec3f(0.8, 0.0, 0.6) * (bend * s);\n', glsl: c.at('glsl', 'vertexSway') || '  p += vec3(0.8, 0.0, 0.6) * (bend * s);\n' }
    : { wgsl: '', glsl: '' }
  const attrW = parts.attributes.map(a => `attribute ${a.name}: ${a.wgsl};\n`).join('')
  const attrG = parts.attributes.map(a => `attribute ${a.glsl} ${a.name};\n`).join('')
  const uniW = parts.uniforms.map(u => `uniform ${u.name}: ${u.wgsl};\n`).join('')
  const uniG = parts.uniforms.map(u => {
    const m = /^(\w+)\[(\d+)\]$/.exec(u.glsl)
    return m ? `uniform ${m[1]} ${u.name}[${m[2]}];\n` : `uniform ${u.glsl} ${u.name};\n`
  }).join('')
  const texW = parts.vertexTextures.map(t => `var ${t}: texture_2d<f32>;\nvar ${t}Sampler: sampler;\n`).join('')
  const texG = parts.vertexTextures.map(t => `uniform highp sampler2D ${t};\n`).join('')
  const varW = parts.varyings.map(v => `varying ${v.name}: ${v.wgsl};\n`).join('')
  const varG = parts.varyings.map(v => `varying ${v.glsl} ${v.name};\n`).join('')

  const vertexWGSL = /* wgsl */ `
attribute position: vec3f;
${attrW}#ifdef INSTANCES
attribute world0: vec4f;
attribute world1: vec4f;
attribute world2: vec4f;
attribute world3: vec4f;
#endif
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform viewProjection: mat4x4f;
uniform scCamera: vec4f;
uniform scFade: vec4f;
uniform scRegion: vec4f;
${uniW}${c.at('wgsl', 'uniforms')}${texW}varying vCol: vec3f;
varying vLm: vec2f;
varying vShade: f32;
varying vDepth: f32;
${varW}${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'vertexDecl')}
${HASH_WGSL}${parts.vertexFns.wgsl}
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
#ifdef INSTANCES
  let finalWorld = mat4x4f(vertexInputs.world0, vertexInputs.world1, vertexInputs.world2, vertexInputs.world3);
#else
  let finalWorld = uniforms.world;
#endif
  let t = uniforms.scCamera.w;
${parts.vertexBody.wgsl}
  let ph = dot(root.xz, vec2f(0.21, 0.17));
  let sway = sin(t * 1.9 + ph) * 0.65 + sin(t * 3.3 + ph * 1.7) * 0.35;
  let bend = uniforms.scFade.z * h * clamp(h, 0.3, 1.0) * sway;
${sway.wgsl}  vertexOutputs.position = uniforms.viewProjection * vec4f(p, 1.0);
  let grL = vec2f(root.x - uniforms.scRegion.x, uniforms.scRegion.z - root.z) * 10.0;
  vertexOutputs.vLm = (vec2f(0.5) + grL * (511.0 / 1920.0)) / 512.0;
  vertexOutputs.vDepth = abs((uniforms.view * vec4f(p, 1.0)).z);
${vwOut.wgsl}${c.at('wgsl', 'vertexLight')}}
`
  const fragmentWGSL = /* wgsl */ `
var scLightmap: texture_2d<f32>;
var scLightmapSampler: sampler;
uniform scRegion: vec4f;
uniform scTint: vec4f;
uniform scShadow: vec4f;
uniform fogParams: vec4f;
uniform fogColor: vec4f;
${c.at('wgsl', 'uniforms')}varying vCol: vec3f;
varying vLm: vec2f;
varying vShade: f32;
varying vDepth: f32;
${varW}${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'samplers')}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let grLf = (fragmentInputs.vLm * 512.0 - vec2f(0.5)) * (1920.0 / 511.0);
  let grLmUv = vec2f(grLf.x, ${windowM * 10}.0 - grLf.y) / ${windowM * 10}.0;
  let lmRaw = vec3f(textureSample(scLightmap, scLightmapSampler, grLmUv).a);
${parts.fragmentBody.wgsl}
  let lm = mix(vec3f(1.0), lmRaw, uniforms.scRegion.y);
  var rgb = c.rgb * uniforms.scTint.rgb * clamp(lm + uniforms.scShadow.rgb, vec3f(0.0), vec3f(1.0)) * fragmentInputs.vShade;
${c.at('wgsl', 'fragmentColor')}  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(rgb, 1.0);
}
`
  const vertexGLSL = /* glsl */ `
precision highp float;
precision highp int;
attribute vec3 position;
${attrG}#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec4 scCamera;
uniform vec4 scFade;
uniform vec4 scRegion;
${uniG}${c.at('glsl', 'uniforms')}${texG}varying vec3 vCol;
varying vec2 vLm;
varying float vShade;
varying float vDepth;
${varG}${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'vertexDecl')}
${HASH_GLSL}${parts.vertexFns.glsl}
void main(void) {
#ifdef INSTANCES
  mat4 finalWorld = mat4(world0, world1, world2, world3);
#else
  mat4 finalWorld = world;
#endif
  float t = scCamera.w;
${parts.vertexBody.glsl}
  float ph = dot(root.xz, vec2(0.21, 0.17));
  float sway = sin(t * 1.9 + ph) * 0.65 + sin(t * 3.3 + ph * 1.7) * 0.35;
  float bend = scFade.z * h * clamp(h, 0.3, 1.0) * sway;
${sway.glsl}  gl_Position = viewProjection * vec4(p, 1.0);
  vec2 grL = vec2(root.x - scRegion.x, scRegion.z - root.z) * 10.0;
  vLm = (vec2(0.5) + grL * (511.0 / 1920.0)) / 512.0;
  vDepth = abs((view * vec4(p, 1.0)).z);
${vwOut.glsl}${c.at('glsl', 'vertexLight')}}
`
  const fragmentGLSL = /* glsl */ `
precision highp float;
uniform sampler2D scLightmap;
uniform vec4 scRegion;
uniform vec4 scTint;
uniform vec4 scShadow;
uniform vec4 fogParams;
uniform vec4 fogColor;
${c.at('glsl', 'uniforms')}varying vec3 vCol;
varying vec2 vLm;
varying float vShade;
varying float vDepth;
${varG}${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'samplers')}
void main(void) {
  vec2 grLf = (vLm * 512.0 - vec2(0.5)) * (1920.0 / 511.0);
  vec2 grLmUv = vec2(grLf.x, ${windowM * 10}.0 - grLf.y) / ${windowM * 10}.0;
  vec3 lmRaw = vec3(texture(scLightmap, grLmUv).a);
${parts.fragmentBody.glsl}
  vec3 lm = mix(vec3(1.0), lmRaw, scRegion.y);
  vec3 rgb = c.rgb * scTint.rgb * clamp(lm + scShadow.rgb, 0.0, 1.0) * vShade;
${c.at('glsl', 'fragmentColor')}  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(rgb, 1.0);
}
`
  return {
    vertexWGSL, fragmentWGSL, vertexGLSL, fragmentGLSL,
    uniforms: c.uniforms([...SCATTER_BASE_UNIFORMS, ...parts.uniforms.map(u => u.name)]),
    samplers: c.samplers(['scLightmap', ...parts.vertexTextures]),
    chunkSamplers: c.extraSamplers,
  }
}

// ---- the grass body -------------------------------------------------------------------------------------------------
//
// Vertex layout (grass/patch.ts): position = (side −1 | 0 | 1, t 0..1 up the blade, kind: 0 blade, 1 flower head (xy
// = disc coordinates), 2 flower stem); bladeA = (x, z in the 8 m cell, the clump's random value, tier); bladeB =
// (height, yaw, curve, colour randoms). Instance: world3.xz = the cell's south-west corner (min x, min z).
//
// Per blade: the cell's variant (4 rotations × a mirror, from a hash of the corner, so the 8 m repetition does not
// show), the window's density (a clump grows where density > its random value, shortening toward the edge: soft road
// edges), the tier fades with Tidewater's coverage compensation, 55 % of the yaw turned toward the camera, a quadratic
// lean, the pixel-width floor, the player's push, the palette with two octaves of painted hue patches and 1.5 % dry
// straw blades; flowers in the meadow mask within the flower range, their heads turned toward the camera.

export const GRASS_UNIFORMS: readonly Decl[] = [
  { name: 'grField', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grLod0', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grLod1', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grStyle', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grPal', wgsl: `array<vec4f, ${GRASS_PALETTE_SLOTS * 2}>`, glsl: `vec4[${GRASS_PALETTE_SLOTS * 2}]` },
  { name: 'grPlayer', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grView', wgsl: 'vec4f', glsl: 'vec4' },
]

const MID = (1 / (2 * GRASS_MID_WIDTH)).toFixed(6)

const GRASS_BODY_WGSL = /* wgsl */ `
  let cell = finalWorld[3].xz;
  let cellH = grHash12(cell * 0.173 + vec2f(3.1, 7.7));
  var lp = vertexInputs.bladeA.xy - vec2f(${GRASS_CELL_M / 2}.0);
  if (cellH > 0.5) {
    lp = vec2f(-lp.x, lp.y);
  }
  let rq = floor(fract(cellH * 7.31) * 4.0);
  if (rq > 2.5) {
    lp = vec2f(lp.y, -lp.x);
  } else if (rq > 1.5) {
    lp = -lp;
  } else if (rq > 0.5) {
    lp = vec2f(-lp.y, lp.x);
  }
  let rxz = cell + vec2f(${GRASS_CELL_M / 2}.0) + lp;
  let fp = rxz - uniforms.grField.xy;
  let fa = textureLoad(grFieldA, clamp(vec2i(floor(fp)), vec2i(0), vec2i(${GRASS_WINDOW_M - 1})), 0);
  let dens = fa.r * uniforms.grLod1.z;
  let crand = vertexInputs.bladeA.z;
  let tier = vertexInputs.bladeA.w;
  let kind = vertexInputs.position.z;
  let root = vec3f(rxz.x, grHeightAt(fp), rxz.y);
  let camD = distance(uniforms.scCamera.xz, rxz);
  let f2 = 1.0 - smoothstep(uniforms.grLod0.x, uniforms.grLod0.y, camD);
  let f1 = 1.0 - smoothstep(uniforms.grLod0.z, uniforms.grLod0.w, camD);
  let cut0 = mix(uniforms.grLod1.x, uniforms.grLod1.y, fract(crand * 13.7)) - grNoise(rxz * ${GRASS_BAND_FREQ}) * uniforms.grView.z;
  let f0 = 1.0 - smoothstep(cut0 - 6.0, cut0, camD);
  var fade = f0;
  if (tier > 1.5) {
    fade = f2;
  } else if (tier > 0.5) {
    fade = f1;
  }
  let comp = uniforms.grStyle.w / max(1.0, 1.0 + 2.0 * f1 + (uniforms.grStyle.w - 3.0) * f2);
  let edge = smoothstep(0.0, 0.3, dens - crand * 0.999);
  let bt = vertexInputs.position.y;
  let side = vertexInputs.position.x;
  let r1 = vertexInputs.bladeB.x;
  let yaw = vertexInputs.bladeB.y * 6.2831853;
  let toCam = normalize(uniforms.scCamera.xz - rxz + vec2f(0.0001));
  let pi = min(i32(fa.b * 255.0 + 0.5), ${GRASS_PALETTE_SLOTS - 1});
  let n1 = grNoise(rxz * 0.075);
  let n2 = grNoise(rxz * 0.021 + vec2f(17.0, 3.0));
  var base = uniforms.grPal[pi * 2].rgb;
  var tip = uniforms.grPal[pi * 2 + 1].rgb;
  let hue = mix(vec3f(0.86, 1.02, 1.08), vec3f(1.12, 1.06, 0.78), smoothstep(0.25, 0.75, n1 * 0.6 + n2 * 0.4));
  tip = tip * hue * (0.92 + 0.16 * vertexInputs.bladeB.w);
  base = base * mix(vec3f(1.0), hue, 0.5);
  if (vertexInputs.bladeB.w > 0.985) {
    tip = vec3f(0.62, 0.55, 0.30);
    base = vec3f(0.36, 0.32, 0.16);
  }
  var p = root;
  var wp = root;
  var h = 0.0;
  let s = 1.0;
  if (kind < 0.5) {
    let H = mix(0.30, 0.72, r1) * mix(0.55, 1.0, fa.r) * edge * fade * uniforms.grLod1.w;
    let grPx = distance(uniforms.scCamera.xyz, root) * uniforms.grView.x;
    let W = max(uniforms.grStyle.x * (0.75 + 0.5 * vertexInputs.bladeB.w) * comp, grPx * uniforms.grView.y * ${MID});
    let fdir = normalize(mix(vec2f(cos(yaw), sin(yaw)), toCam, uniforms.grStyle.y) + vec2f(0.0001));
    let sd = vec2f(-fdir.y, fdir.x);
    let ldir = vec2f(cos(yaw + 1.3), sin(yaw + 1.3));
    let lean = (0.12 + 0.38 * vertexInputs.bladeB.z) * H * bt * bt;
    let w = W * pow(1.0 - bt, 0.7) * side;
    p = root + vec3f(sd.x * w + ldir.x * lean, bt * H, sd.y * w + ldir.y * lean);
    let away = rxz - uniforms.grPlayer.xz;
    let pd = length(away);
    let push = (1.0 - smoothstep(0.2, uniforms.grPlayer.w, pd)) * bt * bt * H * 0.9;
    p = p + vec3f(away.x, 0.0, away.y) / max(pd, 0.001) * push - vec3f(0.0, push * 0.5, 0.0);
    vertexOutputs.vCol = mix(base, tip, pow(bt, 0.8));
    vertexOutputs.vShade = mix(0.5, 1.0, pow(bt, 0.6));
  } else {
    let fl = step(crand, fa.g * 1.4) * (1.0 - smoothstep(uniforms.grStyle.z * 0.7, uniforms.grStyle.z, camD)) * step(0.001, fa.r);
    let HF = mix(0.38, 0.62, r1) * fl * uniforms.grLod1.w;
    let ldir = vec2f(cos(yaw), sin(yaw)) * 0.1 * HF;
    let top = root + vec3f(ldir.x, HF, ldir.y);
    let fcol = floor(fract(vertexInputs.bladeB.w * 7.3) * 5.0);
    var petal = vec3f(0.95, 0.93, 0.86);
    if (fcol > 3.5) {
      petal = vec3f(0.86, 0.22, 0.16);
    } else if (fcol > 2.5) {
      petal = vec3f(0.95, 0.55, 0.66);
    } else if (fcol > 1.5) {
      petal = vec3f(0.66, 0.50, 0.86);
    } else if (fcol > 0.5) {
      petal = vec3f(0.98, 0.80, 0.22);
    }
    if (kind < 1.5) {
      let n = normalize(vec3f(toCam.x, 1.4, toCam.y));
      let u = normalize(cross(n, vec3f(0.3, 0.0, 1.0)));
      let v = cross(n, u);
      let R = mix(0.07, 0.11, vertexInputs.bladeB.z) * fl;
      p = top + (u * side + v * bt) * R;
      let centre = step(length(vec2f(side, bt)), 0.01);
      vertexOutputs.vCol = mix(petal, vec3f(0.95, 0.75, 0.15), centre);
      vertexOutputs.vShade = 1.0;
    } else {
      let w = 0.008 * (1.0 - bt) * side * fl;
      let sd = vec2f(-toCam.y, toCam.x);
      p = mix(root, top, bt) + vec3f(sd.x * w, 0.0, sd.y * w);
      vertexOutputs.vCol = mix(base, tip * 0.8, bt);
      vertexOutputs.vShade = mix(0.55, 0.9, bt);
    }
  }
  wp = p;
  h = max(p.y - root.y, 0.0);
`

const GRASS_BODY_GLSL = /* glsl */ `
  vec2 cell = finalWorld[3].xz;
  float cellH = grHash12(cell * 0.173 + vec2(3.1, 7.7));
  vec2 lp = bladeA.xy - vec2(${GRASS_CELL_M / 2}.0);
  if (cellH > 0.5) lp = vec2(-lp.x, lp.y);
  float rq = floor(fract(cellH * 7.31) * 4.0);
  if (rq > 2.5) lp = vec2(lp.y, -lp.x);
  else if (rq > 1.5) lp = -lp;
  else if (rq > 0.5) lp = vec2(-lp.y, lp.x);
  vec2 rxz = cell + vec2(${GRASS_CELL_M / 2}.0) + lp;
  vec2 fp = rxz - grField.xy;
  vec4 fa = texelFetch(grFieldA, clamp(ivec2(floor(fp)), ivec2(0), ivec2(${GRASS_WINDOW_M - 1})), 0);
  float dens = fa.r * grLod1.z;
  float crand = bladeA.z;
  float tier = bladeA.w;
  float kind = position.z;
  vec3 root = vec3(rxz.x, grHeightAt(fp), rxz.y);
  float camD = distance(scCamera.xz, rxz);
  float f2 = 1.0 - smoothstep(grLod0.x, grLod0.y, camD);
  float f1 = 1.0 - smoothstep(grLod0.z, grLod0.w, camD);
  float cut0 = mix(grLod1.x, grLod1.y, fract(crand * 13.7)) - grNoise(rxz * ${GRASS_BAND_FREQ}) * grView.z;
  float f0 = 1.0 - smoothstep(cut0 - 6.0, cut0, camD);
  float fade = tier > 1.5 ? f2 : tier > 0.5 ? f1 : f0;
  float comp = grStyle.w / max(1.0, 1.0 + 2.0 * f1 + (grStyle.w - 3.0) * f2);
  float edge = smoothstep(0.0, 0.3, dens - crand * 0.999);
  float bt = position.y;
  float side = position.x;
  float r1 = bladeB.x;
  float yaw = bladeB.y * 6.2831853;
  vec2 toCam = normalize(scCamera.xz - rxz + vec2(0.0001));
  int pi = min(int(fa.b * 255.0 + 0.5), ${GRASS_PALETTE_SLOTS - 1});
  float n1 = grNoise(rxz * 0.075);
  float n2 = grNoise(rxz * 0.021 + vec2(17.0, 3.0));
  vec3 base = grPal[pi * 2].rgb;
  vec3 tip = grPal[pi * 2 + 1].rgb;
  vec3 hue = mix(vec3(0.86, 1.02, 1.08), vec3(1.12, 1.06, 0.78), smoothstep(0.25, 0.75, n1 * 0.6 + n2 * 0.4));
  tip *= hue * (0.92 + 0.16 * bladeB.w);
  base *= mix(vec3(1.0), hue, 0.5);
  if (bladeB.w > 0.985) {
    tip = vec3(0.62, 0.55, 0.30);
    base = vec3(0.36, 0.32, 0.16);
  }
  vec3 p = root;
  vec3 wp = root;
  float h = 0.0;
  float s = 1.0;
  if (kind < 0.5) {
    float H = mix(0.30, 0.72, r1) * mix(0.55, 1.0, fa.r) * edge * fade * grLod1.w;
    float grPx = distance(scCamera.xyz, root) * grView.x;
    float W = max(grStyle.x * (0.75 + 0.5 * bladeB.w) * comp, grPx * grView.y * ${MID});
    vec2 fdir = normalize(mix(vec2(cos(yaw), sin(yaw)), toCam, grStyle.y) + vec2(0.0001));
    vec2 sd = vec2(-fdir.y, fdir.x);
    vec2 ldir = vec2(cos(yaw + 1.3), sin(yaw + 1.3));
    float lean = (0.12 + 0.38 * bladeB.z) * H * bt * bt;
    float w = W * pow(1.0 - bt, 0.7) * side;
    p = root + vec3(sd.x * w + ldir.x * lean, bt * H, sd.y * w + ldir.y * lean);
    vec2 away = rxz - grPlayer.xz;
    float pd = length(away);
    float push = (1.0 - smoothstep(0.2, grPlayer.w, pd)) * bt * bt * H * 0.9;
    p += vec3(away.x, 0.0, away.y) / max(pd, 0.001) * push - vec3(0.0, push * 0.5, 0.0);
    vCol = mix(base, tip, pow(bt, 0.8));
    vShade = mix(0.5, 1.0, pow(bt, 0.6));
  } else {
    float fl = step(crand, fa.g * 1.4) * (1.0 - smoothstep(grStyle.z * 0.7, grStyle.z, camD)) * step(0.001, fa.r);
    float HF = mix(0.38, 0.62, r1) * fl * grLod1.w;
    vec2 ldir = vec2(cos(yaw), sin(yaw)) * 0.1 * HF;
    vec3 top = root + vec3(ldir.x, HF, ldir.y);
    float fcol = floor(fract(bladeB.w * 7.3) * 5.0);
    vec3 petal = fcol > 3.5 ? vec3(0.86, 0.22, 0.16) : fcol > 2.5 ? vec3(0.95, 0.55, 0.66) : fcol > 1.5 ? vec3(0.66, 0.50, 0.86) : fcol > 0.5 ? vec3(0.98, 0.80, 0.22) : vec3(0.95, 0.93, 0.86);
    if (kind < 1.5) {
      vec3 n = normalize(vec3(toCam.x, 1.4, toCam.y));
      vec3 u = normalize(cross(n, vec3(0.3, 0.0, 1.0)));
      vec3 v = cross(n, u);
      float R = mix(0.07, 0.11, bladeB.z) * fl;
      p = top + (u * side + v * bt) * R;
      float centre = step(length(vec2(side, bt)), 0.01);
      vCol = mix(petal, vec3(0.95, 0.75, 0.15), centre);
      vShade = 1.0;
    } else {
      float w = 0.008 * (1.0 - bt) * side * fl;
      vec2 sd = vec2(-toCam.y, toCam.x);
      p = mix(root, top, bt) + vec3(sd.x * w, 0.0, sd.y * w);
      vCol = mix(base, tip * 0.8, bt);
      vShade = mix(0.55, 0.9, bt);
    }
  }
  wp = p;
  h = max(p.y - root.y, 0.0);
`

export const GRASS_PARTS: GrassSkeletonParts = {
  attributes: [
    { name: 'bladeA', wgsl: 'vec4f', glsl: 'vec4' },
    { name: 'bladeB', wgsl: 'vec4f', glsl: 'vec4' },
  ],
  uniforms: GRASS_UNIFORMS,
  vertexTextures: [GRASS_FIELD_SAMPLER, GRASS_HEIGHT_SAMPLER],
  varyings: [],
  sway: true,
  vertexFns: { wgsl: GRASS_HEIGHT_WGSL, glsl: GRASS_HEIGHT_GLSL },
  vertexBody: { wgsl: GRASS_BODY_WGSL, glsl: GRASS_BODY_GLSL },
  fragmentBody: {
    wgsl: '  let c = vec4f(fragmentInputs.vCol, 1.0);\n',
    glsl: '  vec4 c = vec4(vCol, 1.0);\n',
  },
}

/** The grass field's shaders with `lanes`' chunks (tests pass their own; the field uses WORLD_SHADER_CHUNKS). */
export function grassShaders(lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS): ShaderSources {
  return grassSkeleton(GRASS_PARTS, lanes)
}

/** Registers a shader pair in Babylon's stores under `name` (both languages; the first registration of a name wins). */
const registered = new Set<string>()
export function registerSkeletonShader(name: string, src: ShaderSources): void {
  if (registered.has(name)) return
  registered.add(name)
  ShaderStore.ShadersStoreWGSL[`${name}VertexShader`] = src.vertexWGSL
  ShaderStore.ShadersStoreWGSL[`${name}FragmentShader`] = src.fragmentWGSL
  ShaderStore.ShadersStore[`${name}VertexShader`] = src.vertexGLSL
  ShaderStore.ShadersStore[`${name}FragmentShader`] = src.fragmentGLSL
}

// ---- TS twins (tests; the life's CPU queries) ------------------------------------------------------------------------

/** The height grid as the window stores it: 16 bits over [hMin, hMin + hRange] in R (high) and G (low). */
export function encodeGrassHeight(h: number, hMin: number, hRange: number): [number, number] {
  const v = Math.max(0, Math.min(65535, Math.round(((h - hMin) / Math.max(1e-6, hRange)) * 65535)))
  return [v >> 8, v & 255]
}

/**
 * grHeightAt in TS: the height at glTF (x, z) from the window's height bytes (N² RGBA8, default GRASS_HEIGHT_GRID; row j =
 * the vertex row at z0 + 2 j), exactly as the vertex shader decodes it (tests compare it with format.ts terrainHeightAt).
 */
export function grassHeightAt(bytes: ArrayLike<number>, x0: number, z0: number, hMin: number, hRange: number, x: number, z: number, N = GRASS_HEIGHT_GRID): number {
  const gx = (x - x0) * 0.5
  const gz = (z - z0) * 0.5
  const i = Math.min(Math.max(Math.floor(gx), 0), N - 2)
  const j = Math.min(Math.max(Math.floor(gz), 0), N - 2)
  const fx = Math.min(Math.max(gx - i, 0), 1)
  const fy = Math.min(Math.max(gz - j, 0), 1)
  const at = (ii: number, jj: number) => {
    const o = (jj * N + ii) * 4
    return (bytes[o]! * 256 + bytes[o + 1]!) / 65535
  }
  const h01 = at(i, j), h11 = at(i + 1, j), h00 = at(i, j + 1), h10 = at(i + 1, j + 1)
  const fz = 1 - fy
  const hv = fx >= fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h01 - h00) * fz + (h11 - h01) * fx
  return hMin + hv * hRange
}

/** The pixel size per metre of distance for a vertical field of view `fovY` (rad) over `renderHeightPx` pixels. */
export function grassPixelPerMetre(fovY: number, renderHeightPx: number): number {
  return (2 * Math.tan(fovY / 2)) / Math.max(1, renderHeightPx)
}

/**
 * The blade's base half width as the vertex shader computes it (the pixel-width floor included): `width` (grStyle.x),
 * the colour random `r4`, the tier coverage compensation `comp`, the distance `d` (m) and the pixel size per metre.
 */
export function grassBladeHalfWidth(width: number, r4: number, comp: number, d: number, pxPerM: number, minPx = GRASS_MIN_BLADE_PX): number {
  return Math.max(width * (0.75 + 0.5 * r4) * comp, d * pxPerM * minPx / (2 * GRASS_MID_WIDTH))
}

/** Tidewater's coverage compensation for the tier fades f1 (tier 1) and f2 (tier 2), `blades` per clump. */
export function grassCoverage(blades: number, f1: number, f2: number): number {
  return blades / Math.max(1, 1 + 2 * f1 + (blades - 3) * f2)
}

/**
 * The cell's variant (GRASS_LIFE §2.2: 4 rotations × a mirror, from a hash of the cell corner), as the shader picks
 * it: 0..7 = rotation (0..3) + 4 × mirror. The hash is evaluated in doubles here, so a corner whose hash sits on a
 * boundary may pick a neighbour variant; the set and the distribution are what the tests check.
 */
export function grassCellVariant(cellX: number, cellZ: number): number {
  const h = grHash12(cellX * 0.173 + 3.1, cellZ * 0.173 + 7.7)
  const rq = Math.floor(fract(h * 7.31) * 4)
  return rq + (h > 0.5 ? 4 : 0)
}

/** Applies a variant to a clump position relative to the cell centre (the shader's order: mirror, then rotate). */
export function grassApplyVariant(variant: number, x: number, z: number): [number, number] {
  let a = variant >= 4 ? -x : x
  let b = z
  const rq = variant & 3
  if (rq === 3) [a, b] = [b, -a]
  else if (rq === 2) [a, b] = [-a, -b]
  else if (rq === 1) [a, b] = [-b, a]
  return [a, b]
}

function fract(v: number): number {
  return v - Math.floor(v)
}

function grHash12(x: number, y: number): number {
  const rx = fract(x * 0.1031), ry = fract(y * 0.103)
  const dot = rx * (ry + 33.33) + ry * (rx + 33.33)
  const dx = rx + dot, dy = ry + dot
  return fract((dx + dy) * dx)
}
