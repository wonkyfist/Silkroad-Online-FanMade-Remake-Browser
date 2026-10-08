// Outfits from gear (docs/CHARACTERS.md §16.9), the Babylon part: applying an outfit (three/licensed-outfit.ts) to a
// licensed Waterbender body. The body's glb carries every piece of its gender at every LOD (waterbender-export.py);
// here the worn ones are shown, the body slices they cover hidden, and the cloth recoloured:
// - LOD0 / LOD1: one material per palette (class, degree, grade, seal), shared by every body wearing it: the clothes'
//   shade map as albedo and ClothDyePlugin, which colours the regions from the dye map and adds the degree's and the
//   seal's effects in the cloth itself (lit albedo changes; only the Sun seal adds a faint emissive thread);
// - LOD2 and the crowd tier: one material per outfit (the pieces + palettes), its albedo a 256² colour bake on the CPU
//   (bakeOutfit) so the crowd's atlas copies the right colours; no plugin, no effects at that distance.
// The materials are reference counted (an outfit change or a disposed body lets go). A server without the pack, or a
// body built before §16.9 (no `licensed.wardrobe` in its sidecar), keeps its glb's own outfit: applyOutfit is a no-op.
import {
  Constants,
  MaterialPluginBase,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Texture,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { sceneExposure } from '@sro/world-render'
import { cloneUndecorated, licensedLodOf, TEXTURE_ANISOTROPY } from './licensed-materials.ts'
import {
  DYE_REGIONS,
  WEAR_LEVELS,
  bakeOutfit,
  clothFxOf,
  farPaletteLinear,
  hiddenSlices,
  outfitKey,
  paletteKey,
  paletteLinear,
  wearKey,
  type ClothWear,
  type GearPiece,
  type Outfit,
  type PieceKey,
  type WardrobeCoverage,
} from './licensed-outfit.ts'
import { EMBLEM_COL, EMBLEM_COLOURS, EMBLEM_M_RANGE, EMBLEM_PIECES, EMBLEM_SPOTS, emblemAnchor, writeEmblem, type EmblemAnchor, type EmblemAnchors, type EmblemSide } from './job-look.ts'
import { exposureScale } from './weapon-glow.ts'

export { outfitFromGear } from './licensed-outfit.ts'

/** The sidecar's wardrobe (licensed-char.ts): pieces, slice coverage, the dye files next to the glb. */
export interface WardrobeSidecar extends WardrobeCoverage {
  /** `wear`: the dirt / blood map (sidecars before it name none: the converter's default file name is tried). */
  dye: { shade: string; dye: string; lo: string; wear?: string }
}
/** The wear map's file when the sidecar names none (a converter run before the wear masks; the file may be there). */
export const CLOTH_WEAR_FILE = 'clothes_wear.jpg'

export function wardrobeOf(sidecar: Record<string, unknown> | null | undefined): WardrobeSidecar | null {
  const w = (sidecar?.licensed as { wardrobe?: WardrobeSidecar } | undefined)?.wardrobe
  return w && Array.isArray(w.pieces) && w.slices && w.dye ? w : null
}

// ---- the plugin --------------------------------------------------------------------------------------------------------

export const CLOTH_PLUGIN = 'SroClothDye'
/**
 * sroClothK: x the glow's exposure scale, y the seal clock (s), z 1 = the static cheap seal (Low / Classic), w 0;
 * sroClothW: x the dirt (0..1), y the blood (0..1), the material's wear level (§16.9). The colours and effects per piece
 * come from the outfit's strip texture.
 */
export const CLOTH_UNIFORMS = ['sroClothK', 'sroClothW'] as const
/**
 * The outfit strip (one per outfit, STRIP_W × STRIP_H RGBA8, nearest): row = the owner piece's index + 1 in the body's
 * piece list (row 0: no piece), columns 0..4 the region colours (linear, stored ^(1/2.2)), column 5 the effects
 * (sheen / 2, weave / 2, seal / 3, seal amount), column 6 (jewel: 1 = the earring's sparkle, 0, 0, 0), columns 7-11 the
 * job emblem of a piece in job mode (three/job-look.ts writeEmblem: the front and back anchors, the job and level).
 */
export const STRIP_W = 12
export const STRIP_H = 32
/**
 * The seals' glow strengths (display-relative, × the exposure scale like the weapons' glow): Star's star points and
 * constellation lines, Moon's travelling silver shimmer, Sun's ember veins and the heat along the trim, the jewel's
 * sparkle. Small bright points and thin lines, never a wash.
 */
export const CLOTH_SEAL = { star: 2.2, line: 0.5, moon: 0.55, vein: 0.9, heat: 0.35, jewel: 2.2 }

/** The seal clock and mode of a scene (licensed-cloth-fx.ts advances it; the plugin reads it at every draw). */
export interface ClothClock {
  seconds: number
  /** Low / Classic: the static cheap seal look (the clock stops, the lines and threads are left out). */
  lite: boolean
  /** LAB: the seal looks off (the bench's A/B; the strip still says which piece is sealed). */
  off: boolean
}
const clocks = new WeakMap<Scene, ClothClock>()
export function clothClockOf(scene: Scene): ClothClock {
  let c = clocks.get(scene)
  if (!c) clocks.set(scene, (c = { seconds: 0, lite: false, off: false }))
  return c
}

const NOISE_GLSL = `
float sroH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sroN(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sroH(i), sroH(i + vec2(1.0, 0.0)), f.x), mix(sroH(i + vec2(0.0, 1.0)), sroH(i + vec2(1.0, 1.0)), f.x), f.y); }
float sroSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a; vec2 ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
vec2 sroPt(vec2 c) { return c + 0.5 + (vec2(sroH(c + 0.37), sroH(c + 5.11)) - 0.5) * 0.5; }
float sroLink(vec2 a, vec2 b, vec2 q) { return mix(9.0, sroSeg(q, sroPt(a), sroPt(b)), step(0.58, sroH(a * 1.7 + b * 0.31 + 2.0))); }
`
const NOISE_WGSL = `
fn sroH(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn sroN(p: vec2f) -> f32 { let i = floor(p); var f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sroH(i), sroH(i + vec2f(1.0, 0.0)), f.x), mix(sroH(i + vec2f(0.0, 1.0)), sroH(i + vec2f(1.0, 1.0)), f.x), f.y); }
fn sroSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
fn sroPt(c: vec2f) -> vec2f { return c + 0.5 + (vec2f(sroH(c + 0.37), sroH(c + 5.11)) - 0.5) * 0.5; }
fn sroLink(a: vec2f, b: vec2f, q: vec2f) -> f32 { return mix(9.0, sroSeg(q, sroPt(a), sroPt(b)), step(0.58, sroH(a * 1.7 + b * 0.31 + 2.0))); }
`

const lin3 = (hex: string, w: boolean) => {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.pow(v / 255, 2.2).toFixed(4))
  return `${w ? 'vec3f' : 'vec3'}(${c.join(', ')})`
}

/**
 * The job emblem (docs/JOBS.md §3.3; three/job-look.ts): p in emblem units (1 = its edge; body x, y up), job 1-3, level
 * 1-7, px a pixel in those units; returns the embroidered colour (linear) and its coverage. Trader: a gold cash coin
 * with its square hole; Bounty Hunter: a blue arrowhead on silver; Thief: three claw slashes on blood red. The level's
 * pips arc over the top.
 */
function emblemCode(lang: 'glsl' | 'wgsl'): string {
  const w = lang === 'wgsl'
  const v2 = w ? 'vec2f' : 'vec2'
  const v3 = w ? 'vec3f' : 'vec3'
  const L = w ? 'let' : 'float'
  const LV2 = w ? 'let' : 'vec2'
  const VV3 = w ? 'var' : 'vec3'
  const VF = w ? 'var' : 'float'
  const T = EMBLEM_COLOURS
  const col = (k: 'ground' | 'rim' | 'symbol' | 'pip') => `
  if (job < 1.5) { c${k} = ${lin3(T.trader[k], w)}; } else if (job < 2.5) { c${k} = ${lin3(T.hunter[k], w)}; } else { c${k} = ${lin3(T.thief[k], w)}; }`
  const head = w ? 'fn sroEmblem(p: vec2f, job: f32, lv: f32, px: f32) -> vec4f {' : 'vec4 sroEmblem(vec2 p, float job, float lv, float px) {'
  const box = (name: string, c: string, b: string) => `${LV2} ${name}D = abs(p - ${c}) - ${b};
    ${L} ${name} = length(max(${name}D, ${v2}(0.0))) + min(max(${name}D.x, ${name}D.y), 0.0);`
  return `
${head}
  ${L} r = length(p);
  ${VV3} cground = ${v3}(0.0);
  ${VV3} crim = ${v3}(0.0);
  ${VV3} csymbol = ${v3}(0.0);
  ${VV3} cpip = ${v3}(0.0);${col('ground')}${col('rim')}${col('symbol')}${col('pip')}
  ${L} disc = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);
  ${L} rim = smoothstep(0.8 - px, 0.8 + px, r);
  ${VF} sym = 0.0;
  if (job < 1.5) {
    ${L} ring = 1.0 - smoothstep(0.04 - px, 0.04 + px, abs(r - 0.58));
    ${box('hole', `${v2}(0.0)`, `${v2}(0.22)`)}
    sym = max(ring, 1.0 - smoothstep(-px, px, hole));
  } else if (job < 2.5) {
    ${L} tri = max(-(p.y + 0.02), (abs(p.x) * 1.4762 + p.y - 0.62) * 0.5609);
    ${box('shaft', `${v2}(0.0, -0.3)`, `${v2}(0.09, 0.3)`)}
    sym = 1.0 - smoothstep(-px, px, min(tri, shaft));
  } else {
    ${L} sl = min(min(sroSeg(p, ${v2}(-0.62, 0.4), ${v2}(-0.08, -0.5)), sroSeg(p, ${v2}(-0.28, 0.56), ${v2}(0.28, -0.56))), sroSeg(p, ${v2}(0.08, 0.5), ${v2}(0.62, -0.4)));
    sym = (1.0 - smoothstep(0.08 - px, 0.08 + px, sl)) * (1.0 - rim);
  }
  ${VV3} c = mix(mix(cground, csymbol, sym), crim, rim);
  // the level's pips: the nearest of lv dots on an arc over the emblem
  ${L} an = ${w ? 'atan2' : 'atan'}(p.y, p.x) - 1.5708;
  ${L} k = clamp(floor(an / 0.36 + (lv - 1.0) * 0.5 + 0.5), 0.0, max(lv - 1.0, 0.0));
  ${L} pa = 1.5708 + (k - (lv - 1.0) * 0.5) * 0.36;
  ${L} pd = length(p - 1.3 * ${v2}(cos(pa), sin(pa)));
  ${L} pip = (1.0 - smoothstep(0.12 - px, 0.12 + px, pd)) * step(0.5, lv);
  ${L} pipEdge = (1.0 - smoothstep(0.17 - px, 0.17 + px, pd)) * step(0.5, lv);
  c = mix(c, crim, pipEdge * (1.0 - disc));
  c = mix(c, cpip, pip);
  return ${w ? 'vec4f' : 'vec4'}(c, max(disc, pipEdge));
}
`
}

const DEFS_GLSL = `
#ifdef SROCLOTH
uniform sampler2D sroDye;
uniform sampler2D sroOwner;
uniform sampler2D sroStrip;
#ifdef SROWEAR
uniform sampler2D sroWear;
#endif
${NOISE_GLSL}
#ifdef SROJOB
${emblemCode('glsl')}
#endif
#endif
`
const DEFS_WGSL = `
#ifdef SROCLOTH
var sroDyeSampler: sampler;
var sroDye: texture_2d<f32>;
var sroOwnerSampler: sampler;
var sroOwner: texture_2d<f32>;
var sroStripSampler: sampler;
var sroStrip: texture_2d<f32>;
#ifdef SROWEAR
var sroWearSampler: sampler;
var sroWear: texture_2d<f32>;
#endif
${NOISE_WGSL}
#ifdef SROJOB
${emblemCode('wgsl')}
#endif
#endif
`

/** One side's emblem in the albedo code (strip columns EMBLEM_COL + off and + off + 1, its side bit). */
function emblemSide(lang: 'glsl' | 'wgsl', side: EmblemSide, off: number): string {
  const w = lang === 'wgsl'
  const v2 = w ? 'vec2f' : 'vec2'
  const L = w ? 'let' : 'float'
  const LV2 = w ? 'let' : 'vec2'
  const LV4 = w ? 'let' : 'vec4'
  const uv = w ? 'fragmentInputs.vAlbedoUV' : 'vAlbedoUV'
  const at = (col: number) => `${v2}((${col}.0 + 0.5) / ${STRIP_W}.0, (cdRow + 0.5) / ${STRIP_H}.0)`
  const strip = (col: number) => (w ? `textureSampleLevel(sroStrip, sroStripSampler, ${at(col)}, 0.0)` : `texture2D(sroStrip, ${at(col)})`)
  const bit = side === 'front' ? '(jbSd - 2.0 * floor(jbSd / 2.0)) > 0.5' : 'jbSd > 1.5'
  const n = side === 'front' ? 'jbf' : 'jbb'
  const R = EMBLEM_SPOTS[side].radius.toFixed(4)
  return `    if (${bit}) {
      ${LV4} ${n}A = ${strip(EMBLEM_COL + off)} * 255.0;
      ${LV4} ${n}M = (${strip(EMBLEM_COL + off + 1)} * 2.0 - 1.0) * ${EMBLEM_M_RANGE.toFixed(1)};
      ${LV2} ${n}D = ${uv} - ${v2}((${n}A.r * 256.0 + ${n}A.g) / 65535.0, (${n}A.b * 256.0 + ${n}A.a) / 65535.0);
      ${LV2} ${n}Q = ${v2}(${n}M.r * ${n}D.x + ${n}M.g * ${n}D.y, ${n}M.b * ${n}D.x + ${n}M.a * ${n}D.y) / ${R};
      ${L} ${n}Px = max(cdFw * max(length(${n}M.rb), length(${n}M.ga)) / ${R}, 0.02);
      if (dot(${n}Q, ${n}Q) < 2.6) {
        ${LV4} ${n}E = sroEmblem(${n}Q, jbJob, jbLv, ${n}Px);
        cdC = mix(cdC, ${n}E.rgb, ${n}E.a);
      }
    }`
}

// one source for both languages: U the uniform prefix, v2/v3 the vector types, L/LV2/LV3/VV3/VF the declarations
function albedoCode(lang: 'glsl' | 'wgsl'): string {
  const w = lang === 'wgsl'
  const U = w ? 'uniforms.' : ''
  const v2 = w ? 'vec2f' : 'vec2'
  const v3 = w ? 'vec3f' : 'vec3'
  const L = w ? 'let' : 'float'
  const VF = w ? 'var' : 'float'
  const LV2 = w ? 'let' : 'vec2'
  const LV3 = w ? 'let' : 'vec3'
  const VV3 = w ? 'var' : 'vec3'
  const uv = w ? 'fragmentInputs.vAlbedoUV' : 'vAlbedoUV'
  const tex = w ? `textureSample(sroDye, sroDyeSampler, ${uv}).rgb` : `texture2D(sroDye, ${uv}).rgb`
  const wear = w ? `textureSample(sroWear, sroWearSampler, ${uv}).rgb` : `texture2D(sroWear, ${uv}).rgb`
  // nearest samplers without mips: the owner piece of this texel, then its row of the strip
  const own = w ? `textureSampleLevel(sroOwner, sroOwnerSampler, ${uv}, 0.0).b` : `texture2D(sroOwner, ${uv}).b`
  const strip = (col: number) => {
    const at = `${v2}((${col}.0 + 0.5) / ${STRIP_W}.0, (cdRow + 0.5) / ${STRIP_H}.0)`
    return w ? `textureSampleLevel(sroStrip, sroStripSampler, ${at}, 0.0)` : `texture2D(sroStrip, ${at})`
  }
  const lin = (col: number) => `pow(${strip(col)}.rgb, ${v3}(2.2))`
  const K = `${U}sroClothK`
  const f3 = (n: number) => n.toFixed(3)
  return `
#ifdef SROCLOTH
${VV3} sroClothGlow = ${v3}(0.0);
#ifdef ALBEDO
{
  ${LV3} cdW = ${tex};
  ${L} cdShade = surfaceAlbedo.r * 4.0;
  ${L} cdLea = surfaceAlbedo.g;
  ${L} cdRest = clamp(1.0 - cdW.r - cdW.g - cdW.b - cdLea, 0.0, 1.0);
  ${L} cdRow = floor(${own} * 255.0 + 0.5);
  ${w ? 'let' : 'vec4'} cdFx = ${strip(5)} * ${w ? 'vec4f' : 'vec4'}(2.0, 2.0, 3.0, 1.0);
  ${VV3} cdC = ${lin(0)} * cdW.r + ${lin(1)} * cdW.g + ${lin(2)} * cdW.b + ${lin(3)} * cdLea + ${lin(4)} * cdRest;
  ${L} cdNdV = clamp(abs(dot(normalW, viewDirectionW)), 0.0, 1.0);
  ${L} cdF = pow(1.0 - cdNdV, 3.0);
  // derivatives only in uniform control flow (WGSL), so before any branch: the uv footprint of a pixel
  ${L} cdFw = max(max(fwidth(${uv}.x), fwidth(${uv}.y)), 1e-5);
  ${L} cdAa = 1.0 - smoothstep(0.35, 0.7, cdFw * 600.0);
#ifdef SROWEAR
  ${LV3} cdWr = ${wear};
#endif
  // D3+: a silk sheen on the trim (brighter towards the grazing angles; lit, so it never glows in the dark)
  cdC = cdC * (1.0 + cdFx.x * cdW.b * (0.3 + 1.7 * cdF));
  // D4: a fine twill in the cloth that shifts with the view angle (faded out where it would alias)
  if (cdFx.y > 0.0) {
    ${LV2} cdQ = ${uv} * 600.0;
    ${L} cdTw = sin(cdQ.x + cdQ.y + cdNdV * 9.0) * sin((cdQ.x - cdQ.y) * 0.5);
    ${L} cdCl0 = cdW.r + cdW.g;
    cdC = cdC * (1.0 + cdFx.y * (cdCl0 * (0.16 * cdTw * cdAa + 0.12 * cdF) + cdW.b * 0.35 * cdF));
  }
#ifdef SROJOB
  // the job emblem (JOBS.md §3.3), embroidered into the piece that carries it: the front from tier I, the back from II
  ${w ? 'let' : 'vec4'} jbF = ${strip(EMBLEM_COL + 4)};
  ${L} jbJob = floor(jbF.r * 3.0 + 0.5);
  ${L} jbSd = floor(jbF.b * 3.0 + 0.5);
  ${L} jbLv = floor(jbF.g * 7.0 + 0.5);
  if (jbJob > 0.5) {
${emblemSide(lang, 'front', 0)}
${emblemSide(lang, 'back', 2)}
  }
#endif
#ifdef SROSEAL
  // the seal of the piece's item, in the cloth itself (§16.9), animated by the seal clock (static on Low / Classic):
  // Star a deep violet nebula drifting through the dyed cloth with twinkling stars and faint constellation lines; Moon a
  // pearly moonstone sheen that turns with the view and a slow silver filigree with a travelling shimmer; Sun gold veins
  // that glow and pulse like embers and a heat shimmer running along the gold trim
  ${L} cdA = cdFx.w * (1.0 - ${K}.w);
  ${L} cdT = ${K}.y;
  ${L} cdLive = 1.0 - ${K}.z;
  ${L} cdLum = max(dot(cdC, ${v3}(0.2126, 0.7152, 0.0722)), 0.02);
  ${L} cdCl = clamp(cdW.r + cdW.g, 0.0, 1.0);
  if (cdFx.z > 0.5 && cdFx.z < 1.5 && cdA > 0.0) {
    ${LV2} cdP = ${uv} * 7.0 + ${v2}(cdT * 0.012, cdT * 0.007);
    ${L} cdNb = sroN(cdP) * 0.5 + sroN(cdP * 2.1 + ${v2}(5.2, 1.3) - cdT * 0.02) * 0.3 + sroN(cdP * 4.3 + ${v2}(1.7, 9.2)) * 0.2;
    ${LV3} cdCloud = mix(${v3}(0.2, 0.05, 0.32), ${v3}(0.05, 0.08, 0.3), sroN(cdP * 0.6 + ${v2}(3.0, 7.0)));
    ${LV3} cdNeb = mix(${v3}(0.012, 0.005, 0.045), cdCloud, smoothstep(0.45, 0.85, cdNb));
    cdC = mix(cdC, cdNeb, cdA * cdCl);
    // twinkling star points (cells of the uv; they fade to nothing where a cell is smaller than a pixel or two)
    ${LV2} cdG = ${uv} * 55.0;
    ${LV2} cdCe = floor(cdG);
    ${L} cdHs = sroH(cdCe);
    ${LV2} cdO = (${v2}(sroH(cdCe + 3.1), sroH(cdCe + 7.7)) - 0.5) * 0.6;
    ${L} cdD = length(fract(cdG) - 0.5 - cdO);
    ${L} cdR = 0.05 + 0.08 * sroH(cdCe + 1.9);
    ${L} cdTw2 = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(cdT * (1.3 + 2.4 * cdHs) + cdHs * 40.0), 3.0);
    ${L} cdPx = cdFw * 55.0;
    ${VF} cdSt = step(0.84, cdHs) * (1.0 - smoothstep(cdR * 0.25, cdR + cdPx, cdD)) * cdTw2 * (1.0 - smoothstep(0.35, 0.9, cdPx));
    // faint constellation lines between the nodes of a coarser grid, their nodes a little brighter (Medium and up)
    if (cdLive > 0.5) {
      ${LV2} cdQ2 = ${uv} * 16.0;
      ${LV2} cdC2 = floor(cdQ2);
      ${VF} cdLd = sroLink(cdC2, cdC2 + ${v2}(1.0, 0.0), cdQ2);
      cdLd = min(cdLd, sroLink(cdC2, cdC2 + ${v2}(0.0, 1.0), cdQ2));
      cdLd = min(cdLd, sroLink(cdC2 - ${v2}(1.0, 0.0), cdC2, cdQ2));
      cdLd = min(cdLd, sroLink(cdC2 - ${v2}(0.0, 1.0), cdC2, cdQ2));
      ${L} cdPx2 = cdFw * 16.0;
      ${L} cdLw = 0.025;
      ${L} cdLn = (1.0 - smoothstep(cdLw, cdLw + cdPx2 * 1.5, cdLd)) * min(1.0, cdLw * 2.0 / cdPx2) * (0.55 + 0.45 * sin(cdT * 0.7 + sroH(cdC2) * 6.28));
      ${L} cdNode = 1.0 - smoothstep(0.06, 0.06 + cdPx2 * 1.5, length(cdQ2 - sroPt(cdC2)));
      cdC = cdC + ${v3}(0.18, 0.15, 0.35) * (cdLn * cdA * cdCl);
      sroClothGlow = sroClothGlow + ${v3}(0.55, 0.5, 1.0) * (cdLn * ${f3(CLOTH_SEAL.line)} + cdNode * ${f3(CLOTH_SEAL.star * 0.5)}) * cdA * cdCl * ${K}.x;
    }
    sroClothGlow = sroClothGlow + ${v3}(0.85, 0.78, 1.0) * (cdSt * cdA * cdCl * ${f3(CLOTH_SEAL.star)} * ${K}.x);
  } else if (cdFx.z > 1.5 && cdFx.z < 2.5 && cdA > 0.0) {
    // moonstone: the cloth cooled toward a blue-grey stone (its own brightness kept), then the pearl's colours turn with
    // the view angle (lit: brightest at the grazing angles)
    ${L} cdMm = clamp(cdCl + cdRest * 0.5 + cdW.b * 0.6, 0.0, 1.0);
    ${LV3} cdStone = ${v3}(0.16, 0.19, 0.3) * (0.55 + cdLum * 2.2);
    cdC = mix(cdC, cdStone, cdA * 0.6 * cdCl);
    ${L} cdPh = cdNdV * 2.2 + sroN(${uv} * 5.0 + cdT * 0.03) * 1.5 + cdT * 0.05;
    ${LV3} cdIr = ${v3}(0.5) + ${v3}(0.5) * cos(6.2832 * (${v3}(cdPh) + ${v3}(0.0, 0.33, 0.67)));
    ${LV3} cdPearl = ${v3}(0.55, 0.6, 0.72) + (cdIr - ${v3}(0.5)) * 0.5;
    cdC = cdC + cdPearl * ((0.06 + 0.4 * cdF) * cdA * cdMm);
    // the silver filigree: curling threads (the zero set of two crossed waves) drifting slowly
    ${LV2} cdQ3 = ${uv} * 70.0;
    ${L} cdV = sin(cdQ3.x + 2.2 * sin(cdQ3.y * 0.7 + cdT * 0.25 * cdLive)) * sin(cdQ3.y + 2.2 * sin(cdQ3.x * 0.7 - cdT * 0.2 * cdLive));
    ${L} cdPx3 = cdFw * 70.0 * 2.2;
    ${L} cdFil = (1.0 - smoothstep(0.035, 0.035 + cdPx3 * 1.5, abs(cdV))) * min(1.0, 0.1 / cdPx3);
    cdC = mix(cdC, ${v3}(0.55, 0.6, 0.7) * (0.7 + 0.8 * cdF), cdFil * 0.55 * cdA * cdCl);
    // a shimmer travelling along the threads (Medium and up)
    ${L} cdSh = pow(0.5 + 0.5 * sin(dot(${uv}, ${v2}(9.0, 23.0)) - cdT * 1.2), 8.0) * cdLive;
    sroClothGlow = sroClothGlow + ${v3}(0.75, 0.82, 1.0) * (cdFil * (0.25 + cdSh) * cdA * cdCl * ${f3(CLOTH_SEAL.moon)} * ${K}.x);
  } else if (cdFx.z > 2.5 && cdA > 0.0) {
    ${LV3} cdGold = ${v3}(1.0, 0.62, 0.18);
    // warm cloth, the trim turned gold
    cdC = mix(cdC, cdC * ${v3}(1.2, 0.85, 0.6), cdA * 0.45 * cdCl);
    cdC = mix(cdC, cdGold * max(0.32, cdLum * 1.8), cdA * cdW.b);
    // gold veins through the dyed cloth (ridges of a slow noise), glowing like embers that breathe
    ${LV2} cdP4 = ${uv} * 16.0 + ${v2}(0.0, cdT * 0.01);
    ${L} cdN4 = sroN(cdP4) * 0.65 + sroN(cdP4 * 2.3 + ${v2}(4.1, 2.7)) * 0.35;
    ${L} cdRg = 1.0 - abs(2.0 * cdN4 - 1.0);
    ${L} cdPx4 = cdFw * 16.0 * 4.0;
    ${L} cdVn = smoothstep(0.955 - cdPx4, 0.99, cdRg) * min(1.0, 0.1 / max(cdPx4, 0.02)) * cdCl;
    cdC = mix(cdC, cdGold * 0.8, cdVn * cdA);
    ${L} cdPulse = 0.55 + 0.45 * sin(cdT * 1.1 + sroN(${uv} * 3.0) * 6.28);
    sroClothGlow = sroClothGlow + ${v3}(1.0, 0.42, 0.08) * (cdVn * cdPulse * cdA * ${f3(CLOTH_SEAL.vein)} * ${K}.x);
    // the heat shimmer along the trim (Medium and up): bright bands rising through the gold
    ${L} cdHb = pow(0.5 + 0.5 * sin(${uv}.y * 90.0 + ${uv}.x * 30.0 - cdT * 2.5 + sroN(${uv} * 40.0 + cdT * 0.5) * 3.0), 4.0) * cdLive;
    sroClothGlow = sroClothGlow + cdGold * (cdW.b * (0.25 + cdHb) * cdA * ${f3(CLOTH_SEAL.heat)} * ${K}.x);
  }
  // the earring's seal: a tiny sparkle on the metal
  ${L} cdJw = ${strip(6)}.r;
  if (cdJw > 0.5 && cdFx.z > 0.5) {
    ${LV2} cdJc = floor(${uv} * 400.0);
    ${L} cdJh = sroH(cdJc);
    ${L} cdJs = step(0.93, cdJh) * pow(0.5 + 0.5 * sin(cdT * (2.0 + 3.0 * cdJh) + cdJh * 50.0), 12.0);
    ${LV3} cdJcol = mix(mix(${v3}(0.8, 0.7, 1.0), ${v3}(0.85, 0.9, 1.0), step(1.5, cdFx.z)), ${v3}(1.0, 0.75, 0.35), step(2.5, cdFx.z));
    sroClothGlow = sroClothGlow + cdJcol * (cdJs * ${f3(CLOTH_SEAL.jewel)} * ${K}.x);
  }
#endif
#ifdef SROWEAR
  // wear (§16.9): the pack's dirt and blood masks revealed by the level (dirt gathers first at the hems; blood from the
  // spatter's specks up), over everything above (a dirty seal dims too)
  ${L} cdDl = ${U}sroClothW.x;
  ${L} cdBl = ${U}sroClothW.y;
  ${L} cdDm = clamp(smoothstep(1.0 - cdDl * 0.85, 1.15 - cdDl * 0.85, cdWr.r) * 0.85 + cdWr.g * cdDl * 0.45, 0.0, 0.9);
  cdC = mix(cdC, cdC * 0.45 + ${v3}(0.07, 0.05, 0.03), cdDm);
  ${L} cdBm = smoothstep(1.0 - cdBl * 0.45, 1.06 - cdBl * 0.45, cdWr.b) * step(0.01, cdBl) * 0.85;
  cdC = mix(cdC, ${v3}(0.15, 0.007, 0.005) * (0.8 + 0.6 * cdF), cdBm);
  sroClothGlow = sroClothGlow * (1.0 - max(cdDm, cdBm));
#endif
  surfaceAlbedo = cdC * cdShade;
}
#endif
#endif
`
}

const EMISSIVE_GLSL = `
#ifdef SROCLOTH
finalEmissive += sroClothGlow;
#endif
`
const EMISSIVE_WGSL = `
#ifdef SROCLOTH
finalEmissive = finalEmissive + sroClothGlow;
#endif
`

/** The injections per language (tests read them). */
export function clothCode(lang: 'glsl' | 'wgsl'): Readonly<Record<string, string>> {
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: lang === 'wgsl' ? DEFS_WGSL : DEFS_GLSL,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: albedoCode(lang),
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: lang === 'wgsl' ? EMISSIVE_WGSL : EMISSIVE_GLSL,
  }
}

/** One strip row of a piece's item (RGBA8 × STRIP_W): the region colours and the effects; `jewel` the earring's. */
export function stripRow(g: GearPiece, out = new Uint8Array(STRIP_W * 4), jewel = false): Uint8Array {
  const p = paletteLinear(g)
  const fx = clothFxOf(g)
  const enc = (v: number) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2))
  DYE_REGIONS.forEach((r, i) => {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = enc(p[r][c]!)
    out[i * 4 + 3] = 255
  })
  const q = (v: number) => Math.round(255 * Math.max(0, Math.min(1, v)))
  out.set([q(fx.sheen / 2), q(fx.weave / 2), q(fx.seal / 3), q(fx.sealAmount)], 5 * 4)
  out.set([jewel ? 255 : 0, 0, 0, 255], 6 * 4)
  return out
}

/**
 * The outfit's strip (STRIP_W × STRIP_H RGBA8): row i + 1 for `pieces[i]` (the body's piece list) when worn; a piece in
 * job mode with an emblem anchor (`anchors`, emblemAnchorsOf) carries the emblem's columns (job-look.ts writeEmblem).
 */
export function outfitStrip(o: Outfit, pieces: readonly string[], anchors?: EmblemAnchors | null): Uint8Array {
  const out = new Uint8Array(STRIP_W * STRIP_H * 4)
  const worn = new Map(o.pieces.map(x => [x.piece as string, x.gear]))
  pieces.forEach((name, i) => {
    const g = worn.get(name)
    if (!g || i + 1 >= STRIP_H) return
    const row = out.subarray((i + 1) * STRIP_W * 4, (i + 2) * STRIP_W * 4)
    stripRow(g, row)
    if (g.job && anchors) writeEmblem(row, anchors.get(name), g.job)
  })
  return out
}

/** The outfit shows an emblem (a job piece with an anchor): its materials compile the SROJOB code. */
export function outfitHasEmblem(o: Outfit, anchors: EmblemAnchors | null | undefined): boolean {
  if (!anchors) return false
  return o.pieces.some(p => !!p.gear.job && Object.keys(anchors.get(p.piece) ?? {}).length > 0)
}

const anchorCache = new WeakMap<object, EmblemAnchors>()

/**
 * The job emblem's anchors of a licensed body, per wardrobe (every body of that glb shares them): measured once on its
 * LOD0 chest pieces' bind-pose data (job-look.ts emblemAnchor), the spots' height from the TOP's bounds. Empty when the
 * meshes keep no vertex data (the emblem is then left out; the job colours stay).
 */
export function emblemAnchorsOf(meshes: readonly AbstractMesh[], key: object): EmblemAnchors {
  const hit = anchorCache.get(key)
  if (hit) return hit
  const out: EmblemAnchors = new Map()
  const parts = new Map<string, { pos: ArrayLike<number>; uv: ArrayLike<number>; idx: ArrayLike<number> }[]>()
  let y0 = Infinity
  let y1 = -Infinity
  for (const m of meshes) {
    const part = partKeyOf(m.name)
    if (!part || !(EMBLEM_PIECES as readonly string[]).includes(part) || licensedLodOf(m) !== 0) continue
    const pos = m.getVerticesData('position')
    const uv = m.getVerticesData('uv')
    const idx = m.getIndices()
    if (!pos || !uv || !idx || !idx.length) continue
    parts.set(part, [...(parts.get(part) ?? []), { pos, uv, idx }])
    if (part !== 'TOP') continue
    for (let i = 1; i < pos.length; i += 3) {
      y0 = Math.min(y0, pos[i]!)
      y1 = Math.max(y1, pos[i]!)
    }
  }
  if (!(y1 > y0)) return out
  for (const [part, list] of parts) {
    const a: Partial<Record<EmblemSide, EmblemAnchor>> = {}
    for (const side of ['front', 'back'] as const) {
      const s = EMBLEM_SPOTS[side]
      let best: EmblemAnchor | null = null
      for (const d of list) {
        const h = emblemAnchor(d.pos, d.uv, d.idx, s.x, y0 + (y1 - y0) * s.yFrac, side === 'front' ? 1 : -1)
        if (h && (!best || h.z > best.z)) best = h
      }
      if (best) a[side] = best
    }
    out.set(part, a)
  }
  anchorCache.set(key, out)
  return out
}

/** The earring's strip: every row its item (the earrings are not in the owner map), the jewel flag on. */
export function earringStrip(g: GearPiece): Uint8Array {
  const out = new Uint8Array(STRIP_W * STRIP_H * 4)
  for (let r = 0; r < STRIP_H; r++) stripRow(g, out.subarray(r * STRIP_W * 4, (r + 1) * STRIP_W * 4), true)
  return out
}

export class ClothDyePlugin extends MaterialPluginBase {
  private readonly clock: ClothClock
  /**
   * `seal`: a piece of the outfit is sealed (the seal code is compiled in; plain outfits never pay for it); `wear`: the
   * material's dirt / blood level (0..1 each) and the wear map (null: none).
   */
  constructor(
    material: Material,
    readonly dye: Texture,
    readonly owner: BaseTexture,
    readonly strip: BaseTexture,
    readonly seal = false,
    readonly wear: { dirt: number; blood: number; map: BaseTexture } | null = null,
    readonly job = false,
  ) {
    super(material, CLOTH_PLUGIN, 320, { SROCLOTH: false, SROSEAL: false, SROWEAR: false, SROJOB: false }, true, false)
    this.clock = clothClockOf(material.getScene())
    // hardBindForSubMesh (the clock, the exposure, the wear) runs only for plugins registered for the extra events
    this.registerForExtraEvents = true
    this._enable(true)
  }

  override getClassName(): string {
    return CLOTH_PLUGIN
  }

  override isCompatible(): boolean {
    return true
  }

  override isReadyForSubMesh(): boolean {
    return this.dye.isReady() && this.owner.isReady() && this.strip.isReady() && (!this.wear || this.wear.map.isReady())
  }

  override prepareDefines(defines: MaterialDefines): void {
    const d = defines as MaterialDefines & Record<string, unknown>
    const want = { SROCLOTH: true, SROSEAL: this.seal, SROWEAR: !!this.wear, SROJOB: this.job }
    for (const [k, v] of Object.entries(want)) {
      if (d[k] === v) continue
      d[k] = v
      defines.markAsUnprocessed()
    }
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: CLOTH_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      fragment: shaderLanguage === ShaderLanguage.WGSL ? '' : CLOTH_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n'),
    }
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('sroDye', 'sroOwner', 'sroStrip', 'sroWear')
  }

  // every draw: the clock moves every frame (a shared material binds its uniforms once per effect otherwise)
  override hardBindForSubMesh(ubo: UniformBuffer, scene: Scene): void {
    const c = this.clock
    ubo.updateFloat4('sroClothK', exposureScale(sceneExposure(scene)), c.seconds, c.lite ? 1 : 0, c.off ? 1 : 0)
    ubo.updateFloat4('sroClothW', this.wear?.dirt ?? 0, this.wear?.blood ?? 0, 0, 0)
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    ubo.setTexture('sroDye', this.dye)
    ubo.setTexture('sroOwner', this.owner)
    ubo.setTexture('sroStrip', this.strip)
    if (this.wear) ubo.setTexture('sroWear', this.wear.map)
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return { ...clothCode(shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }
}

// ---- assets and materials ---------------------------------------------------------------------------------------------

interface ClothAssets {
  shade: Texture
  dye: Texture
  lo: Uint8ClampedArray
  loSize: number
  /** The owner map (lo's B, dilated over the UV gutters) for the shader, nearest. */
  owner: RawTexture
  /** The dirt / blood masks (null: not converted; the wear is then never drawn). */
  wear?: Texture | null
}

interface Shared {
  mat: PBRMaterial
  refs: number
  tex?: RawTexture
}

/** Per scene: the dye assets per directory + gender, the shared materials by key. */
class ClothCache {
  readonly assets = new Map<string, Promise<ClothAssets | null>>()
  readonly mats = new Map<string, Shared>()
  constructor(readonly scene: Scene) {}
}
const caches = new WeakMap<Scene, ClothCache>()
function cacheOf(scene: Scene): ClothCache {
  let c = caches.get(scene)
  if (!c) caches.set(scene, (c = new ClothCache(scene)))
  return c
}

async function decodePng(url: string): Promise<{ data: Uint8ClampedArray; size: number } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    return { data: g.getImageData(0, 0, bmp.width, bmp.height).data, size: bmp.width }
  } catch {
    return null
  }
}

function loadTexture(scene: Scene, url: string, srgb: boolean): Promise<Texture | null> {
  return new Promise(resolve => {
    const t = new Texture(url, scene, {
      invertY: false,
      gammaSpace: srgb,
      onLoad: () => {
        t.anisotropicFilteringLevel = TEXTURE_ANISOTROPY
        resolve(t)
      },
      onError: () => {
        t.dispose()
        resolve(null)
      },
    })
  })
}

/**
 * Loads the dye maps a body's sidecar names (once per scene, directory and gender): null when there is no wardrobe or
 * a map does not load (the body then keeps its glb's own outfit).
 */
export function loadClothAssets(scene: Scene, glb: string, sidecar: Record<string, unknown> | null | undefined): Promise<ClothAssets | null> {
  const w = wardrobeOf(sidecar)
  const gender = (sidecar?.licensed as { gender?: string } | undefined)?.gender
  if (!w || (gender !== 'f' && gender !== 'm')) return Promise.resolve(null)
  const dir = glb.slice(0, glb.lastIndexOf('/') + 1)
  const key = `${dir}|${gender}`
  const cache = cacheOf(scene)
  let p = cache.assets.get(key)
  if (!p) {
    p = (async () => {
      const [shade, dye, lo, wear] = await Promise.all([
        loadTexture(scene, dir + w.dye.shade, true),
        loadTexture(scene, dir + w.dye.dye, false),
        decodePng(dir + w.dye.lo.replace('{g}', gender)),
        loadTexture(scene, dir + (w.dye.wear ?? CLOTH_WEAR_FILE), false),
      ])
      if (!shade || !dye || !lo) {
        console.warn('[licensed-cloth] dye maps missing: the glb outfits stay', dir)
        return null
      }
      dilateOwners(lo.data, lo.size)
      const owner = RawTexture.CreateRGBATexture(new Uint8Array(lo.data.buffer, lo.data.byteOffset, lo.data.length), lo.size, lo.size, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE)
      owner.name = 'clothOwner'
      owner.wrapU = owner.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE
      return { shade, dye, lo: lo.data, loSize: lo.size, owner, wear }
    })()
    cache.assets.set(key, p)
  }
  return p
}

/**
 * Fills the owner of texels in the UV gutters (B = 0) from a neighbour, `passes` rings deep: the texels a piece's edge
 * samples (filtering, mips) then belong to that piece instead of "no piece".
 */
export function dilateOwners(lo: Uint8Array | Uint8ClampedArray, size: number, passes = 4): void {
  for (let p = 0; p < passes; p++) {
    const src = new Uint8Array(size * size)
    for (let i = 0; i < size * size; i++) src[i] = lo[i * 4 + 2]!
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x
        if (src[i]) continue
        const n = (x > 0 && src[i - 1]) || (x < size - 1 && src[i + 1]) || (y > 0 && src[i - size]) || (y < size - 1 && src[i + size]) || 0
        if (n) lo[i * 4 + 2] = n
      }
  }
}

function acquire(cache: ClothCache, key: string, make: () => Shared): PBRMaterial {
  let s = cache.mats.get(key)
  if (!s) cache.mats.set(key, (s = make()))
  s.refs++
  return s.mat
}

function release(cache: ClothCache, key: string): void {
  const s = cache.mats.get(key)
  if (!s || --s.refs > 0) return
  cache.mats.delete(key)
  s.mat.dispose(false, false)
  s.tex?.dispose()
}

/** What a body holds of an applied outfit (applyOutfit's handle; `release` lets go of its shared materials). */
export interface AppliedOutfit {
  key: string
  hidden: ReadonlySet<string>
  release(): void
}

/** The piece / slice a part of the body is (its node name without the LOD and primitive suffixes); null: a fixed part. */
export function partKeyOf(name: string): string | null {
  const base = name.replace(/_primitive\d+$/, '').replace(/__LOD\d$/, '')
  if (/LINGERIE/.test(base)) return /_BRA$/.test(base) ? 'LINGERIE_TOP' : 'LINGERIE_BOTTOM'
  const m = /_(BODY_PART_\d\d|TOP|SLEEVES|LAYERING|FRONT_CLOTH|SKIRT|TAILS|PANTS|CHAPS|GLOVES|SHOES|BELT(?:_cut)?|ROPE|FLOWERS)$/i.exec(base)
  return m ? m[1]!.toUpperCase() : null
}

/**
 * Dresses a licensed body in `outfit`: shows the worn pieces, hides the rest and the covered body slices, and gives
 * the cloth pieces their palette materials (LOD0/1) and the outfit's colour bake (LOD2, the crowd). `meshes`: the
 * body's parts (every LOD); `decorate`: the library's material decorator (the world's surface plugin) for the new
 * materials. Returns the handle to release, or null when the body has no wardrobe or the dye maps are not loaded
 * (await loadClothAssets first). Visibility goes through `isVisible` (the LOD switch enables a LOD's parts).
 */
export function applyOutfit(
  scene: Scene,
  meshes: readonly AbstractMesh[],
  outfit: Outfit,
  sidecar: Record<string, unknown> | null | undefined,
  assets: ClothAssets | null,
  decorate?: (mat: Material) => void,
  wear?: ClothWear | null,
): AppliedOutfit | null {
  const w = wardrobeOf(sidecar)
  if (!w || !assets) return null
  const cache = cacheOf(scene)
  const hidden = hiddenSlices(outfit, w)
  const worn = new Map<PieceKey, GearPiece>()
  for (const p of outfit.pieces) worn.set(p.piece, p.gear)
  const okey = outfitKey(outfit)
  // the wear level (dirt / blood) is part of the near materials' key; the far ones never show it
  const wk = assets.wear ? wearKey(wear) : ''
  const wearOf = wk && wear && assets.wear ? { dirt: wear.dirt / WEAR_LEVELS, blood: wear.blood / WEAR_LEVELS, map: assets.wear } : null
  const sealed = outfit.pieces.some(p => !!p.gear.seal)
  // the job emblem's spots on this body (measured once per glb; JOBS.md §3.3)
  const anchors = emblemAnchorsOf(meshes, w)
  const emblem = outfitHasEmblem(outfit, anchors)
  const held: string[] = []
  for (const m of meshes) {
    if (m.getTotalVertices() <= 0) continue
    // the girl's earrings (one part at LOD0; the lower LODs join them into the head): the worn earring's colours, or
    // the glb's own material while none is worn (the look's accessory then decides whether they show)
    if (/_EARRINGS(?:_primitive\d+)?$/.test(m.name)) {
      const base = (m.metadata as { sroClothBase?: Material } | null)?.sroClothBase ?? m.material
      if (!(base instanceof PBRMaterial) || !/^MAT_CLOTHES/.test(base.name)) continue
      m.metadata = { ...(m.metadata as object | null), sroClothBase: base }
      const ear = outfit.earring
      if (!ear) {
        m.material = base
        continue
      }
      const key = `e|${base.uniqueId}|${paletteKey(ear)}`
      m.material = acquire(cache, key, () => {
        const mat = cloneUndecorated(base, `${base.name}~earring`)
        mat.albedoTexture = assets.shade
        const strip = RawTexture.CreateRGBATexture(earringStrip(ear), STRIP_W, STRIP_H, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE)
        strip.name = 'clothStrip'
        new ClothDyePlugin(mat, assets.dye, assets.owner, strip, !!ear.seal)
        mat.metadata = { ...(mat.metadata as object | null), sroNoAtlas: true }
        decorate?.(mat)
        return { mat, refs: 0, tex: strip }
      })
      held.push(key)
      continue
    }
    const part = partKeyOf(m.name)
    if (!part) continue
    if (part.startsWith('BODY_PART_')) {
      m.isVisible = !hidden.has(part)
      continue
    }
    const gear = worn.get(part as PieceKey)
    m.isVisible = !!gear
    const base = (m.metadata as { sroClothBase?: Material } | null)?.sroClothBase ?? m.material
    if (!gear || !(base instanceof PBRMaterial) || !/^MAT_CLOTHES/.test(base.name)) continue
    // the glb's own material stays the source of every copy (a re-dress starts from it again)
    m.metadata = { ...(m.metadata as object | null), sroClothBase: base }
    const lod = licensedLodOf(m)
    if (lod < 2) {
      // one material per outfit (and base material): every worn piece colours itself from the strip by its owner row,
      // so a body's cloth is one draw per base material and the part merge joins it
      const key = `p|${base.uniqueId}|${okey}|${wk}`
      m.material = acquire(cache, key, () => {
        const mat = cloneUndecorated(base, `${base.name}~outfit`)
        mat.albedoTexture = assets.shade
        const strip = RawTexture.CreateRGBATexture(outfitStrip(outfit, w.pieces, anchors), STRIP_W, STRIP_H, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE)
        strip.name = 'clothStrip'
        strip.wrapU = strip.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE
        new ClothDyePlugin(mat, assets.dye, assets.owner, strip, sealed, wearOf, emblem)
        // the outfit merge and the crowd copy albedos into an atlas: this shade map is not a colour (they keep it apart)
        mat.metadata = { ...(mat.metadata as object | null), sroNoAtlas: true }
        decorate?.(mat)
        return { mat, refs: 0, tex: strip }
      })
      held.push(key)
    } else {
      const key = `o|${base.uniqueId}|${okey}`
      m.material = acquire(cache, key, () => {
        const mat = cloneUndecorated(base, `${base.name}~far`)
        const pal = new Map<string, ReturnType<typeof paletteLinear> | null>()
        const data = bakeOutfit(assets.lo, w.pieces, piece => {
          if (!pal.has(piece)) {
            const g = worn.get(piece as PieceKey)
            pal.set(piece, g ? farPaletteLinear(g) : null)
          }
          return pal.get(piece)!
        })
        const tex = RawTexture.CreateRGBATexture(data, assets.loSize, assets.loSize, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE)
        tex.name = `clothBake:${okey}`
        tex.gammaSpace = true
        tex.wrapU = tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE
        // the crowd atlas scales every part by one factor from its size: the bake counts as the 2048² map it stands for
        tex.metadata = { sroAtlasSize: 2048 }
        mat.albedoTexture = tex
        decorate?.(mat)
        return { mat, refs: 0, tex }
      })
      held.push(key)
    }
  }
  let released = false
  return {
    key: okey + (wk ? `|${wk}` : ''),
    hidden,
    release() {
      if (released) return
      released = true
      for (const k of held) release(cache, k)
    },
  }
}

/** Debug / tests: the shared materials alive in a scene (palette and far ones). */
export function clothMaterialCount(scene: Scene): { palette: number; far: number } {
  let palette = 0
  let far = 0
  for (const k of cacheOf(scene).mats.keys()) k.startsWith('o|') ? far++ : palette++
  return { palette, far }
}

/** The dye regions in shader order (tests). */
export const CLOTH_REGIONS = DYE_REGIONS
