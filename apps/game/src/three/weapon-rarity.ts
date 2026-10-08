/**
 * The rare weapons' look on the weapon itself (docs/RARITY.md §5): a Seal of Star / Moon / Sun weapon shares its model
 * with the regular one (itemdata names the same BSR), so each tier is made unique by
 *  - a material plugin (SroRarity) on the weapon's shared glTF material, like the alchemy glow (weapon-glow.ts): per
 *    mesh defines (SRORARE, SRORARE_LITE) and per-draw uniforms, no clone, no per-frame allocation, priority 310 after
 *    the glow's 300 (both add to the emissive). The blade gets a frame (along: ai_start → ai_end; across: its widest
 *    side; and its face normal) and each tier draws in it:
 *      Star: dark glass with deep space inside: two nebula layers at different depths (parallax with the view), twinkling
 *            stars, etched constellation lines that breathe, a white-violet razor edge;
 *      Moon: pale moonstone: a soft inner light with a blue adularescent sheen, a band of light flowing up the blade,
 *            bright silver edges, stronger at night;
 *      Sun:  molten gold: a white-hot core along the blade's spine, fire cracks that flow and pulse with heat.
 *    The art is generated (world/rarity/atlas.ts: blade-nebula, blade-masks);
 *  - the tier's motes (RarityMotes): the light near-blade layer of the rare weapons farther away (world/rarity/fx.ts
 *    draws the full effects of your own and the nearest);
 *  - the effects around it (auras, swings, crits, kills, the equip flare, drops): world/rarity/fx.ts.
 * Low (Classic) draws SRORARE_LITE (the tint, a steady rim, the tier's texture on the item's own UVs and a slow pulse).
 */
import {
  Color3,
  Material,
  MaterialPluginBase,
  Matrix,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Texture,
  Vector3,
  VertexBuffer,
  type AbstractEngine,
  type AbstractMesh,
  type Camera,
  type MaterialDefines,
  type Nullable,
  type Observer,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import type { RarityTier } from '@sro/shared'
import { sceneExposure } from '@sro/world-render'
import { BLADE_MASKS_URL, BLADE_NEBULA_URL } from '../world/rarity/atlas.ts'
import { FxBatch } from '../world/rarity/batch.ts'
import { rarityFx } from '../world/rarity/fx.ts'
import { rareKindOf, type RareKind } from '../world/rarity/kinds.ts'
import { Painter } from '../world/rarity/paint.ts'
import { isCrowdDrawn } from './crowd-vat.ts'
import { regionKindOf, weaponRegion, type WeaponRegion } from '../world/rarity/region.ts'
import { LITE_GAIN, bladeSpace, exposureScale, itemToMesh, phaseOf, type GlowItemSpec, type GlowOwner, type Rgb } from './weapon-glow.ts'

// ---- the looks --------------------------------------------------------------------------------------------------

export interface RarityLook {
  /** 1 Star, 2 Moon, 3 Sun: picks the pattern in the shader. */
  readonly kind: number
  /** The material the albedo turns to (sRGB 0..1) and how much (0..1). */
  readonly tint: Rgb
  readonly tintAmount: number
  /** Fresnel rim colour (sRGB), power (higher = thinner) and strength (display-relative, like the glow tiers). */
  readonly rim: Rgb
  readonly rimPower: number
  readonly rimGain: number
  /** The pattern's accent colour (sRGB), strength (display-relative) and speed. */
  readonly accent: Rgb
  readonly pattern: number
  readonly speed: number
  /** The motes (far LOD): count per weapon, colours (core, edge) and particle sprite (0 flare, 1 mist, 2 ember). */
  readonly motes: number
  readonly moteCore: Rgb
  readonly moteEdge: Rgb
  readonly sprite: number
  /** The retail swing trail under the seal's own ribbon: its colour (sRGB) and alpha, and its length × the row's. */
  readonly trail: Rgb
  readonly trailAlpha: number
  readonly trailLength: number
  /** 'add' glows; 'alpha' lays the colour over. */
  readonly trailBlend: 'add' | 'alpha'
}

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]

/** docs/RARITY.md §5 [decision]: one look per tier, each a clear step up (values set on the plaza at noon and night). */
export const RARITY_LOOKS: Readonly<Record<RarityTier, RarityLook>> = {
  star: {
    kind: 1, tint: hex('#0b0816'), tintAmount: 1, rim: hex('#7a3cff'), rimPower: 3.2, rimGain: 0.9,
    accent: hex('#9a62ff'), pattern: 2.3, speed: 1,
    motes: 7, moteCore: hex('#ffffff'), moteEdge: hex('#a77dff'), sprite: 0,
    trail: hex('#b892ff'), trailAlpha: 0.45, trailLength: 1.2, trailBlend: 'add',
  },
  moon: {
    kind: 2, tint: hex('#5e6c8a'), tintAmount: 1, rim: hex('#d8e8ff'), rimPower: 2.4, rimGain: 1.3,
    accent: hex('#a9c4ff'), pattern: 0.95, speed: 1.2,
    motes: 8, moteCore: hex('#ffffff'), moteEdge: hex('#9fc0ff'), sprite: 1,
    trail: hex('#d6e6ff'), trailAlpha: 0.45, trailLength: 1.35, trailBlend: 'add',
  },
  sun: {
    kind: 3, tint: hex('#e39a30'), tintAmount: 1, rim: hex('#ffbe4a'), rimPower: 1.5, rimGain: 2.4,
    accent: hex('#ffd27a'), pattern: 1.9, speed: 1,
    motes: 9, moteCore: hex('#fff2b8'), moteEdge: hex('#ff5a0a'), sprite: 2,
    trail: hex('#ffb347'), trailAlpha: 0.5, trailLength: 1.5, trailBlend: 'add',
  },
}

// ---- the shader -------------------------------------------------------------------------------------------------

export const RARITY_PLUGIN = 'SroRarity'

/**
 * Uniforms (vec4 each): sroRareA x tint amount, y rim power, z rim gain, w pattern gain (gains × the exposure factor);
 * sroRareT tint (linear), w kind; sroRareR rim colour (linear), w seconds; sroRareP accent (linear), w speed;
 * sroRareO blade origin, sroRareD blade axis, sroRareW its across axis, sroRareN its face normal (mesh space; across
 * and normal scaled to one item-root unit); sroRareM blade mask edges along t; sroRareS x blade length (m), y 1 / the
 * blade's half width, z the equip flare (0..1), w the night (0..1).
 */
export const RARITY_UNIFORMS = ['sroRareA', 'sroRareT', 'sroRareR', 'sroRareP', 'sroRareO', 'sroRareD', 'sroRareM', 'sroRareW', 'sroRareN', 'sroRareS'] as const
export const RARITY_SAMPLERS = ['sroRareNeb', 'sroRareMask'] as const

const LUMA_GLSL = 'vec3(0.2126, 0.7152, 0.0722)'
const LUMA_WGSL = 'vec3f(0.2126, 0.7152, 0.0722)'

const DEFS_GLSL = `
#ifdef SRORARE
uniform sampler2D sroRareNeb;
uniform sampler2D sroRareMask;
#endif
`
const DEFS_WGSL = `
#ifdef SRORARE
var sroRareNebSampler: sampler;
var sroRareNeb: texture_2d<f32>;
var sroRareMaskSampler: sampler;
var sroRareMask: texture_2d<f32>;
#endif
`

const ALBEDO_GLSL = `
#ifdef SRORARE
{
  float rrL = dot(surfaceAlbedo, ${LUMA_GLSL});
  vec3 rrC = sroRareT.rgb * clamp(rrL * 2.4, 0.08, 1.5);
  surfaceAlbedo = mix(surfaceAlbedo, rrC, sroRareA.x);
}
#endif
`
const ALBEDO_WGSL = `
#ifdef SRORARE
{
  let rrL = dot(surfaceAlbedo, ${LUMA_WGSL});
  let rrC = uniforms.sroRareT.rgb * clamp(rrL * 2.4, 0.08, 1.5);
  surfaceAlbedo = mix(surfaceAlbedo, rrC, uniforms.sroRareA.x);
}
#endif
`

const EMISSIVE_GLSL = `
#ifdef SRORARE
{
  float rrTime = sroRareR.w;
#ifdef SRORARE_LITE
  float rrPulse = 0.75 + 0.25 * sin(rrTime * 2.2 * sroRareP.w);
  vec3 rrLite = sroRareR.rgb * sroRareA.z + sroRareP.rgb * (sroRareA.w * rrPulse * 0.4);
#ifdef ALBEDO
  vec3 rrLn = texture2D(sroRareNeb, vAlbedoUV * 2.0 + vec2(rrTime * 0.01, 0.0)).rgb;
  vec4 rrLm = texture2D(sroRareMask, vAlbedoUV * 2.0);
  if (sroRareT.w < 1.5) {
    rrLite += (rrLn + sroRareP.rgb * rrLm.r) * sroRareA.w;
  } else if (sroRareT.w < 2.5) {
    rrLite += sroRareP.rgb * (rrLm.b * 0.4 + rrLm.a * 0.6) * sroRareA.w;
  } else {
    rrLite += vec3(1.0, 0.55, 0.12) * rrLm.g * (1.2 + 0.4 * sin(rrTime * 3.0)) * sroRareA.w;
  }
#endif
  finalEmissive += rrLite;
#else
  vec3 rrO = (world * vec4(sroRareO.xyz, 1.0)).xyz;
  vec3 rrA = (world * vec4(sroRareD.xyz, 0.0)).xyz;
  vec3 rrWa = (world * vec4(sroRareW.xyz, 0.0)).xyz;
  vec3 rrNa = (world * vec4(sroRareN.xyz, 0.0)).xyz;
  vec3 rrP = vPositionW - rrO;
  float rrT = dot(rrP, rrA) / max(dot(rrA, rrA), 1e-8);
  float rrWm = dot(rrP, rrWa) / max(dot(rrWa, rrWa), 1e-8);
  float rrW = rrWm * sroRareS.y;
  float rrMask = smoothstep(sroRareM.x, sroRareM.y, rrT) * (1.0 - smoothstep(sroRareM.z, sroRareM.w, rrT));
  float rrNdV = clamp(abs(dot(normalW, viewDirectionW)), 0.0, 1.0);
  float rrF = pow(1.0 - rrNdV, sroRareA.y);
  vec3 rrAn = normalize(rrA);
  vec3 rrWn = normalize(rrWa);
  vec3 rrNn = normalize(rrNa);
  vec2 rrV = vec2(dot(viewDirectionW, rrAn), dot(viewDirectionW, rrWn)) / max(abs(dot(viewDirectionW, rrNn)), 0.3);
  vec2 rrUV = vec2(rrT * sroRareS.x, rrWm) * 1.6;
  vec3 rrN1 = texture2D(sroRareNeb, rrUV * 0.7 - rrV * 0.07 + vec2(rrTime * 0.012, 0.0)).rgb;
  vec3 rrN2 = texture2D(sroRareNeb, rrUV * 1.7 - rrV * 0.025 + vec2(0.31, 0.57 + rrTime * 0.007)).rgb;
  vec4 rrM1 = texture2D(sroRareMask, rrUV * 1.2);
  vec4 rrM2 = texture2D(sroRareMask, rrUV * vec2(0.55, 1.4) + vec2(rrTime * 0.06 * sroRareP.w, 0.13));
  vec3 rrE = sroRareR.rgb * (rrF * sroRareA.z);
  if (sroRareT.w < 1.5) {
    float rrTw = 0.55 + 0.45 * sin(rrTime * 2.7 + rrT * 31.0 + rrW * 7.0);
    float rrLines = rrM1.r * (0.65 + 0.35 * sin(rrTime * 1.9 + rrT * 5.0));
    rrE += (rrN1 * rrN1 * 1.4 + rrN2 * rrN2 * rrN2 * 4.0 * rrTw + sroRareP.rgb * (rrLines * 1.7)) * sroRareA.w;
  } else if (sroRareT.w < 2.5) {
    float rrBand = pow(0.5 + 0.5 * sin(rrT * 9.0 - rrTime * 1.8 * sroRareP.w), 6.0);
    vec3 rrSheen = vec3(0.35, 0.55, 1.0) * rrM1.a * (1.0 - rrNdV * 0.5);
    rrE += (sroRareT.rgb * (0.1 + 0.3 * rrM1.b) + rrSheen * 0.8 + vec3(0.85, 0.9, 1.0) * rrM1.r * 0.6 + sroRareP.rgb * (rrBand * 0.35)) * sroRareA.w * (1.0 + sroRareS.w * 0.6);
  } else {
    float rrCore = 1.0 - smoothstep(0.0, 0.55, abs(rrW));
    float rrHeat = 0.78 + 0.22 * sin(rrTime * 4.1 - rrT * 9.0) * sin(rrTime * 2.3 + rrT * 3.0);
    float rrCr = max(rrM1.g, rrM2.g * 0.85);
    vec3 rrFire = mix(vec3(1.0, 0.22, 0.02), vec3(1.0, 0.86, 0.4), clamp(rrCr * 1.3, 0.0, 1.0));
    rrE += (rrFire * rrCr * 4.0 + vec3(1.0, 0.9, 0.65) * rrCore * rrCore * 2.2 + sroRareP.rgb * 0.12) * rrHeat * sroRareA.w;
  }

  // a seal shield (D.w = 1): the face reads as the tier's emblem: radial from its centre, a tier-coloured rim line
  if (sroRareD.w > 0.5) {
    float rrR = length(vec2((rrT - 0.5) * 2.0, rrW));
    float rrRim = smoothstep(0.78, 0.97, rrR) * (1.0 - smoothstep(0.97, 1.08, rrR));
    if (sroRareT.w < 1.5) {
      rrE = rrE + (sroRareP.rgb * rrM1.r * 2.2 + rrN2 * rrN2 * rrN2 * 3.0 * (1.0 - rrR * 0.5) + sroRareR.rgb * rrRim * 1.6) * sroRareA.w;
    } else if (sroRareT.w < 2.5) {
      vec3 rrIr = vec3(0.5) + vec3(0.5) * cos(6.2832 * (vec3(rrNdV * 1.4 + rrR * 0.6) + vec3(0.0, 0.33, 0.67)));
      rrE = sroRareR.rgb * (rrF * sroRareA.z * 0.35) + (vec3(0.32, 0.34, 0.55) * (0.3 + 0.7 * rrM1.b) + mix(vec3(0.6, 0.55, 0.85), rrIr, 0.45) * rrM1.a * 0.3 + vec3(0.62, 0.7, 0.95) * rrM1.r * 0.9 + sroRareR.rgb * rrRim * 1.0) * sroRareA.w * (1.0 - 0.45 * sroRareS.w);
    } else {
      float rrSc = (1.0 - smoothstep(0.0, 0.75, rrR));
      rrE = sroRareR.rgb * (rrF * sroRareA.z * 0.35) + (vec3(0.85, 0.42, 0.08) * (0.25 + rrSc * rrSc * 0.6) + vec3(1.0, 0.5, 0.1) * max(rrM1.g, rrM2.g) * 2.2 + sroRareR.rgb * rrRim * 1.3) * sroRareA.w * (1.0 - 0.45 * sroRareS.w);
    }
  }
  finalEmissive += rrE * rrMask * (1.0 + sroRareS.z * 2.5);
#endif
}
#endif
`

const EMISSIVE_WGSL = `
#ifdef SRORARE
{
  let rrTime = uniforms.sroRareR.w;
#ifdef SRORARE_LITE
  let rrPulse = 0.75 + 0.25 * sin(rrTime * 2.2 * uniforms.sroRareP.w);
  var rrLite = uniforms.sroRareR.rgb * uniforms.sroRareA.z + uniforms.sroRareP.rgb * (uniforms.sroRareA.w * rrPulse * 0.4);
#ifdef ALBEDO
  let rrLn = textureSample(sroRareNeb, sroRareNebSampler, fragmentInputs.vAlbedoUV * 2.0 + vec2f(rrTime * 0.01, 0.0)).rgb;
  let rrLm = textureSample(sroRareMask, sroRareMaskSampler, fragmentInputs.vAlbedoUV * 2.0);
  if (uniforms.sroRareT.w < 1.5) {
    rrLite = rrLite + (rrLn + uniforms.sroRareP.rgb * rrLm.r) * uniforms.sroRareA.w;
  } else if (uniforms.sroRareT.w < 2.5) {
    rrLite = rrLite + uniforms.sroRareP.rgb * (rrLm.b * 0.4 + rrLm.a * 0.6) * uniforms.sroRareA.w;
  } else {
    rrLite = rrLite + vec3f(1.0, 0.55, 0.12) * rrLm.g * (1.2 + 0.4 * sin(rrTime * 3.0)) * uniforms.sroRareA.w;
  }
#endif
  finalEmissive = finalEmissive + rrLite;
#else
  let rrO = (mesh.world * vec4f(uniforms.sroRareO.xyz, 1.0)).xyz;
  let rrA = (mesh.world * vec4f(uniforms.sroRareD.xyz, 0.0)).xyz;
  let rrWa = (mesh.world * vec4f(uniforms.sroRareW.xyz, 0.0)).xyz;
  let rrNa = (mesh.world * vec4f(uniforms.sroRareN.xyz, 0.0)).xyz;
  let rrP = fragmentInputs.vPositionW - rrO;
  let rrT = dot(rrP, rrA) / max(dot(rrA, rrA), 1e-8);
  let rrWm = dot(rrP, rrWa) / max(dot(rrWa, rrWa), 1e-8);
  let rrW = rrWm * uniforms.sroRareS.y;
  let rrMask = smoothstep(uniforms.sroRareM.x, uniforms.sroRareM.y, rrT) * (1.0 - smoothstep(uniforms.sroRareM.z, uniforms.sroRareM.w, rrT));
  let rrNdV = clamp(abs(dot(normalW, viewDirectionW)), 0.0, 1.0);
  let rrF = pow(1.0 - rrNdV, uniforms.sroRareA.y);
  let rrAn = normalize(rrA);
  let rrWn = normalize(rrWa);
  let rrNn = normalize(rrNa);
  let rrV = vec2f(dot(viewDirectionW, rrAn), dot(viewDirectionW, rrWn)) / max(abs(dot(viewDirectionW, rrNn)), 0.3);
  let rrUV = vec2f(rrT * uniforms.sroRareS.x, rrWm) * 1.6;
  let rrN1 = textureSample(sroRareNeb, sroRareNebSampler, rrUV * 0.7 - rrV * 0.07 + vec2f(rrTime * 0.012, 0.0)).rgb;
  let rrN2 = textureSample(sroRareNeb, sroRareNebSampler, rrUV * 1.7 - rrV * 0.025 + vec2f(0.31, 0.57 + rrTime * 0.007)).rgb;
  let rrM1 = textureSample(sroRareMask, sroRareMaskSampler, rrUV * 1.2);
  let rrM2 = textureSample(sroRareMask, sroRareMaskSampler, rrUV * vec2f(0.55, 1.4) + vec2f(rrTime * 0.06 * uniforms.sroRareP.w, 0.13));
  var rrE = uniforms.sroRareR.rgb * (rrF * uniforms.sroRareA.z);
  if (uniforms.sroRareT.w < 1.5) {
    let rrTw = 0.55 + 0.45 * sin(rrTime * 2.7 + rrT * 31.0 + rrW * 7.0);
    let rrLines = rrM1.r * (0.65 + 0.35 * sin(rrTime * 1.9 + rrT * 5.0));
    rrE = rrE + (rrN1 * rrN1 * 1.4 + rrN2 * rrN2 * rrN2 * 4.0 * rrTw + uniforms.sroRareP.rgb * (rrLines * 1.7)) * uniforms.sroRareA.w;
  } else if (uniforms.sroRareT.w < 2.5) {
    let rrBand = pow(0.5 + 0.5 * sin(rrT * 9.0 - rrTime * 1.8 * uniforms.sroRareP.w), 6.0);
    let rrSheen = vec3f(0.35, 0.55, 1.0) * rrM1.a * (1.0 - rrNdV * 0.5);
    rrE = rrE + (uniforms.sroRareT.rgb * (0.1 + 0.3 * rrM1.b) + rrSheen * 0.8 + vec3f(0.85, 0.9, 1.0) * rrM1.r * 0.6 + uniforms.sroRareP.rgb * (rrBand * 0.35)) * uniforms.sroRareA.w * (1.0 + uniforms.sroRareS.w * 0.6);
  } else {
    let rrCore = 1.0 - smoothstep(0.0, 0.55, abs(rrW));
    let rrHeat = 0.78 + 0.22 * sin(rrTime * 4.1 - rrT * 9.0) * sin(rrTime * 2.3 + rrT * 3.0);
    let rrCr = max(rrM1.g, rrM2.g * 0.85);
    let rrFire = mix(vec3f(1.0, 0.22, 0.02), vec3f(1.0, 0.86, 0.4), clamp(rrCr * 1.3, 0.0, 1.0));
    rrE = rrE + (rrFire * rrCr * 4.0 + vec3f(1.0, 0.9, 0.65) * rrCore * rrCore * 2.2 + uniforms.sroRareP.rgb * 0.12) * rrHeat * uniforms.sroRareA.w;
  }

  // a seal shield (D.w = 1): the face reads as the tier's emblem: radial from its centre, a tier-coloured rim line
  if (uniforms.sroRareD.w > 0.5) {
    let rrR = length(vec2f((rrT - 0.5) * 2.0, rrW));
    let rrRim = smoothstep(0.78, 0.97, rrR) * (1.0 - smoothstep(0.97, 1.08, rrR));
    if (uniforms.sroRareT.w < 1.5) {
      rrE = rrE + (uniforms.sroRareP.rgb * rrM1.r * 2.2 + rrN2 * rrN2 * rrN2 * 3.0 * (1.0 - rrR * 0.5) + uniforms.sroRareR.rgb * rrRim * 1.6) * uniforms.sroRareA.w;
    } else if (uniforms.sroRareT.w < 2.5) {
      let rrIr = vec3f(0.5) + vec3f(0.5) * cos(6.2832 * (vec3f(rrNdV * 1.4 + rrR * 0.6) + vec3f(0.0, 0.33, 0.67)));
      rrE = uniforms.sroRareR.rgb * (rrF * uniforms.sroRareA.z * 0.35) + (vec3f(0.32, 0.34, 0.55) * (0.3 + 0.7 * rrM1.b) + mix(vec3f(0.6, 0.55, 0.85), rrIr, 0.45) * rrM1.a * 0.3 + vec3f(0.62, 0.7, 0.95) * rrM1.r * 0.9 + uniforms.sroRareR.rgb * rrRim * 1.0) * uniforms.sroRareA.w * (1.0 - 0.45 * uniforms.sroRareS.w);
    } else {
      let rrSc = (1.0 - smoothstep(0.0, 0.75, rrR));
      rrE = uniforms.sroRareR.rgb * (rrF * uniforms.sroRareA.z * 0.35) + (vec3f(0.85, 0.42, 0.08) * (0.25 + rrSc * rrSc * 0.6) + vec3f(1.0, 0.5, 0.1) * max(rrM1.g, rrM2.g) * 2.2 + uniforms.sroRareR.rgb * rrRim * 1.3) * uniforms.sroRareA.w * (1.0 - 0.45 * uniforms.sroRareS.w);
    }
  }
  finalEmissive = finalEmissive + rrE * rrMask * (1.0 + uniforms.sroRareS.z * 2.5);
#endif
}
#endif
`

/** The injections per language (tests read them). */
export function rarityCode(lang: 'glsl' | 'wgsl'): Readonly<Record<string, string>> {
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: lang === 'wgsl' ? DEFS_WGSL : DEFS_GLSL,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: lang === 'wgsl' ? ALBEDO_WGSL : ALBEDO_GLSL,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: lang === 'wgsl' ? EMISSIVE_WGSL : EMISSIVE_GLSL,
  }
}

export const RARITY_DEFINES = { SRORARE: false, SRORARE_LITE: false }

/** What the plugin asks of its manager. */
export interface RaritySource {
  stateOf(mesh: AbstractMesh): MeshRarity | null
  readonly lite: boolean
  writeUniforms(ubo: UniformBuffer, r: MeshRarity): void
  /** The blade textures (null until made). */
  textures(): { nebula: Texture; masks: Texture } | null
}

/** The rarity plugin on one shared weapon material. Priority 310: after the +N glow (300). */
export class RarityPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly source: RaritySource) {
    super(material, RARITY_PLUGIN, 310, { ...RARITY_DEFINES }, true, false)
    this.registerForExtraEvents = true
    this._enable(true)
  }

  override getClassName(): string {
    return RARITY_PLUGIN
  }

  override isCompatible(): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene?: Scene, mesh?: AbstractMesh): void {
    const d = defines as MaterialDefines & Record<string, unknown>
    const on = !!mesh && this.source.stateOf(mesh) !== null
    const lite = on && (this.source.lite || d.INSTANCES === true || d.THIN_INSTANCES === true)
    if (d.SRORARE !== on || d.SRORARE_LITE !== lite) {
      d.SRORARE = on
      d.SRORARE_LITE = lite
      defines.markAsUnprocessed()
    }
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: RARITY_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      fragment: shaderLanguage === ShaderLanguage.WGSL ? '' : RARITY_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n'),
    }
  }

  override getSamplers(samplers: string[]): void {
    for (const s of RARITY_SAMPLERS) samplers.push(s)
  }

  override hardBindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const r = this.source.stateOf(subMesh.getMesh())
    if (r) this.source.writeUniforms(ubo, r)
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    if (!this.source.stateOf(subMesh.getMesh())) return
    const t = this.source.textures()
    if (!t) return
    ubo.setTexture('sroRareNeb', t.nebula)
    ubo.setTexture('sroRareMask', t.masks)
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return { ...rarityCode(shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }
}

export function rarityPluginOf(mat: Material | null | undefined): RarityPlugin | null {
  const p = mat?.pluginManager?.getPlugin(RARITY_PLUGIN)
  return p instanceof RarityPlugin ? p : null
}

// ---- the manager ------------------------------------------------------------------------------------------------

/** One rare item on one actor. */
export interface RareItem {
  readonly owner: GlowOwner
  readonly tier: RarityTier
  readonly look: RarityLook
  /** The weapon kind (world/rarity/kinds.ts): what its swing, aura and emblem look like (settled when first drawn). */
  kind: RareKind
  readonly meshes: readonly AbstractMesh[]
  readonly phase: number
  /** Blade base and tip in the first mesh's space. */
  readonly base: Vector3
  readonly tip: Vector3
  readonly length: number
  /** The blade's across axis and face normal in the first mesh's space (one item-root unit long), half width (m). */
  readonly across: Vector3
  readonly normal: Vector3
  readonly halfWidth: number
  /** The item's extent along the blade (blade units: 0 base, 1 tip; a spear's shaft below 0). */
  readonly span: readonly [number, number]
  /** The far end of the model on its own centre line (first mesh space; null: none, e.g. a shield). */
  readonly butt: Vector3 | null
  /** The look's colours in linear space (the uniforms). */
  readonly tint: Color3
  readonly rim: Color3
  readonly accent: Color3
  /** When it was lit (seconds, the manager's clock): the equip flare runs from here on your own item. */
  readonly litAt: number
  /** The equip flare plays (a new tier on your own character). */
  readonly flare: boolean
}

export interface MeshRarity {
  readonly item: RareItem
  readonly origin: Vector3
  readonly axis: Vector3
  readonly mask: readonly [number, number, number, number]
  /** Across and normal in this mesh's space (absent: a default frame). */
  readonly across?: Vector3
  readonly normal?: Vector3
}

/** Rare weapons that may show their full effects at once (your own first); farther ones show motes. Low: your own. */
export const MOTE_CAPS: Readonly<Record<'low' | 'medium' | 'high' | 'ultra', number>> = { low: 1, medium: 6, high: 10, ultra: 14 }
/** Others' rare weapons farther than this show no effects beyond the blade itself. */
export const MOTE_RANGE_M = 30

export interface RarityMode {
  lite: boolean
  moteCap: number
}

export function rarityModeFor(g: { render: 'classic' | 'pbr'; renderPreset: 'low' | 'medium' | 'high' | 'ultra' }): RarityMode {
  const lite = g.render !== 'pbr'
  return { lite, moteCap: lite ? MOTE_CAPS.low : MOTE_CAPS[g.renderPreset] }
}

const BLADE_MASK = [-0.3, -0.02, 1.12, 1.28] as const
const BOX_MASK = [-1, -0.5, 1.5, 2] as const
const linear = (c: Rgb): Color3 => new Color3(c[0], c[1], c[2]).toLinearSpace()
/** The equip flare's length (s). */
export const EQUIP_FLARE_S = 1.6

/** The night (0 noon .. 1 deep night) from the scene exposure (≈1 at noon, ~10 and more at night). */
export function nightOf(exposure: number): number {
  if (!(exposure > 0)) return 0
  return Math.max(0, Math.min(1, (Math.log(exposure) - Math.log(1.6)) / (Math.log(9) - Math.log(1.6))))
}

/** The uniform values of a rare mesh at `s` seconds: [A, T, R, P, O, D, M, W, N, S], 4 floats each. */
export function rarityValues(r: MeshRarity, s: number, lite: boolean, scale = 1, out = new Float32Array(40), night = 0): Float32Array {
  const it = r.item
  const L = it.look
  const k = scale * (lite ? LITE_GAIN : 1)
  out[0] = L.tintAmount
  out[1] = L.rimPower
  // Lite: the rim is a steady share folded into the emissive (no per-pixel fresnel).
  out[2] = L.rimGain * k * (lite ? 0.3 : 1)
  out[3] = L.pattern * k * (lite ? 0.45 : 1)
  out[4] = it.tint.r
  out[5] = it.tint.g
  out[6] = it.tint.b
  out[7] = L.kind
  out[8] = it.rim.r
  out[9] = it.rim.g
  out[10] = it.rim.b
  // Seconds kept small (float precision in the shader), per-owner phase so two swords are not in step.
  out[11] = (s % 600) + it.phase * 37
  out[12] = it.accent.r
  out[13] = it.accent.g
  out[14] = it.accent.b
  out[15] = L.speed
  out[16] = r.origin.x
  out[17] = r.origin.y
  out[18] = r.origin.z
  out[19] = 0
  out[20] = r.axis.x
  out[21] = r.axis.y
  out[22] = r.axis.z
  out[23] = it.kind === 'shield' ? 1 : 0
  for (let i = 0; i < 4; i++) out[24 + i] = r.mask[i]!
  const w = r.across
  const n = r.normal
  out[28] = w ? w.x : 0
  out[29] = w ? w.y : 1
  out[30] = w ? w.z : 0
  out[31] = 0
  out[32] = n ? n.x : 1
  out[33] = n ? n.y : 0
  out[34] = n ? n.z : 0
  out[35] = 0
  out[36] = it.length ?? 1
  out[37] = 1 / Math.max(0.005, it.halfWidth ?? 0.03)
  const since = s - (it.litAt ?? -1e9)
  out[38] = it.flare && since >= 0 && since < EQUIP_FLARE_S ? Math.sin(Math.PI * Math.min(1, since / EQUIP_FLARE_S)) ** 0.7 : 0
  out[39] = night
  return out
}

export interface WeaponRarityOptions {
  mode?: () => RarityMode
  now?: () => number
  exposure?: () => number
}

/** The scene's blade textures: the generated art, or 1×1 stand-ins where nothing loads (NullEngine tests). */
function bladeTextures(scene: Scene): { nebula: Texture; masks: Texture } {
  const engine = scene.getEngine()
  if (engine.getClassName?.() === 'NullEngine') {
    const px = (r: number, g: number, b: number, a: number) => RawTexture.CreateRGBATexture(new Uint8Array([r, g, b, a]), 1, 1, scene, false)
    return { nebula: px(20, 10, 40, 255), masks: px(0, 0, 128, 0) }
  }
  const tex = (url: string) => {
    const t = new Texture(url, scene, { noMipmap: false, invertY: false, samplingMode: Texture.TRILINEAR_SAMPLINGMODE })
    t.wrapU = Texture.WRAP_ADDRESSMODE
    t.wrapV = Texture.WRAP_ADDRESSMODE
    t.anisotropicFilteringLevel = 4
    return t
  }
  return { nebula: tex(BLADE_NEBULA_URL), masks: tex(BLADE_MASKS_URL) }
}

/** Something that draws the rare items' effects every frame (world/rarity/fx.ts registers one per scene). */
export interface RareItemsListener {
  lit(item: RareItem): void
}

const tmpInv = new Matrix()

/**
 * The rare looks of one scene's actors (ModelLibrary owns one per scene). `light(owner, spec, tier)` dresses an item's
 * meshes (null clears them); `prepare` puts the plugin on a weapon's materials when it is hung (before its first draw).
 */
export class WeaponRarity implements RaritySource {
  private readonly meshes = new WeakMap<AbstractMesh, MeshRarity>()
  private readonly hooked = new WeakSet<AbstractMesh>()
  private readonly items = new Set<RareItem>()
  private readonly plugins = new WeakMap<Material, RarityPlugin>()
  /** The last tier lit per owner (the equip flare plays on a change). */
  private readonly lastTier = new WeakMap<GlowOwner, RarityTier | null>()
  private readonly frameObs: Nullable<Observer<Scene>>
  private now: () => number
  private readonly realNow: () => number
  private readonly modeOf: () => RarityMode
  private readonly exposureOf: () => number
  private modeNow: RarityMode
  private seconds = 0
  private scale = 1
  private night = 0
  private readonly values = new Float32Array(40)
  private motesPart: RarityMotes | null = null
  private tex: { nebula: Texture; masks: Texture } | null = null
  /** The effects layer (world/rarity/fx.ts) told of every lit item. */
  listener: RareItemsListener | null = null
  private disposed = false

  constructor(readonly scene: Scene, opts: WeaponRarityOptions = {}) {
    this.realNow = opts.now ?? (() => performance.now() / 1000)
    this.now = this.realNow
    this.modeOf = opts.mode ?? (() => ({ lite: false, moteCap: MOTE_CAPS.medium }))
    this.exposureOf = opts.exposure ?? (() => sceneExposure(scene))
    this.modeNow = this.modeOf()
    this.seconds = this.now()
    this.scale = exposureScale(this.exposureOf())
    this.frameObs = scene.onBeforeRenderObservable.add(() => this.frame())
  }

  get lite(): boolean {
    return this.modeNow.lite
  }

  get mode(): RarityMode {
    return this.modeNow
  }

  /** The manager's clock (s). */
  get time(): number {
    return this.seconds
  }

  get live(): ReadonlySet<RareItem> {
    return this.items
  }

  /** A motes layer of its own (tests; the effects layer draws the scene's motes into its batch). */
  get motes(): RarityMotes | null {
    if (!this.motesPart && this.items.size && !this.disposed) this.motesPart = new RarityMotes(this.scene)
    return this.motesPart
  }

  stateOf(mesh: AbstractMesh): MeshRarity | null {
    return this.meshes.get(mesh) ?? null
  }

  textures(): { nebula: Texture; masks: Texture } | null {
    return this.tex
  }

  writeUniforms(ubo: UniformBuffer, r: MeshRarity): void {
    const v = rarityValues(r, this.seconds, this.modeNow.lite, this.scale, this.values, this.night)
    for (let i = 0; i < RARITY_UNIFORMS.length; i++) ubo.updateFloat4(RARITY_UNIFORMS[i]!, v[i * 4]!, v[i * 4 + 1]!, v[i * 4 + 2]!, v[i * 4 + 3]!)
  }

  prepare(meshes: readonly AbstractMesh[]): void {
    if (this.disposed) return
    for (const m of meshes) {
      const mat = m.material
      if (!(mat instanceof PBRMaterial) || this.plugins.has(mat)) continue
      this.tex ??= bladeTextures(this.scene)
      this.plugins.set(mat, rarityPluginOf(mat) ?? new RarityPlugin(mat, this))
    }
  }

  light(owner: GlowOwner, spec: GlowItemSpec & { slot?: 'weapon' | 'shield' }, tier: RarityTier | null | undefined): RareItem | null {
    this.clear(spec.meshes)
    const meshes = spec.meshes.filter(m => !m.isDisposed() && m.getTotalVertices() > 0)
    const prev = this.lastTier.get(owner)
    if (spec.slot !== 'shield') this.lastTier.set(owner, tier ?? null)
    if (!tier || !meshes.length || this.disposed) return null
    this.prepare(meshes)
    if (!this.listener) rarityFx(this.scene).attach(this)
    const look = RARITY_LOOKS[tier]
    const family = (owner as { family?: string | null }).family
    const kind = rareKindOf(spec.slot, family)
    // the effect frame from the model's own geometry (world/rarity/region.ts): the blade or head, on its centre line
    const space0 = bladeSpace(spec, meshes)
    const region = modelRegion(spec, meshes, kind)
    const space = region ? { base: v3(region.base), tip: v3(region.tip), blade: space0.blade } : space0
    const frame = region
      ? { across: v3(region.across), normal: v3(region.normal), halfWidth: region.halfWidth, span: region.span, halfDepth: region.halfDepth, acrossMid: 0, normalMid: 0 }
      : bladeFrame(spec, meshes, space.base, space.tip)
    const first = meshes[0]!
    const toFirst = itemToMesh(spec.root, first)
    const item: RareItem = {
      owner,
      tier,
      look,
      kind,
      meshes,
      phase: phaseOf(owner.root.uniqueId),
      base: Vector3.TransformCoordinates(space.base, toFirst),
      tip: Vector3.TransformCoordinates(space.tip, toFirst),
      length: Vector3.Distance(space.base, space.tip),
      across: Vector3.TransformNormal(frame.across, toFirst),
      normal: Vector3.TransformNormal(frame.normal, toFirst),
      halfWidth: frame.halfWidth,
      span: frame.span,
      butt: region ? Vector3.TransformCoordinates(v3(region.butt), toFirst) : null,
      tint: linear(look.tint),
      rim: linear(look.rim),
      accent: linear(look.accent),
      litAt: this.seconds,
      flare: owner.lodFull && spec.slot !== 'shield' && prev !== tier,
    }
    for (const m of meshes) {
      const toMesh = itemToMesh(spec.root, m)
      const o = Vector3.TransformCoordinates(space.base, toMesh)
      const axis = Vector3.TransformCoordinates(space.tip, toMesh).subtractInPlace(o)
      this.meshes.set(m, {
        item,
        origin: o,
        axis,
        // the whole weapon takes the tier's material (blade, head, shaft, limbs): the mask spans the model
        mask: region ? [region.span[0] - 0.15, region.span[0] + 0.01, region.span[1] - 0.01, region.span[1] + 0.15] : space.blade ? BLADE_MASK : BOX_MASK,
        across: Vector3.TransformNormal(frame.across, toMesh),
        normal: Vector3.TransformNormal(frame.normal, toMesh),
      })
      if (!this.hooked.has(m)) {
        this.hooked.add(m)
        m.onDisposeObservable.addOnce(() => this.clear([m]))
      }
    }
    this.items.add(item)
    this.listener?.lit(item)
    return item
  }

  clear(meshes: readonly AbstractMesh[]): void {
    for (const m of meshes) {
      const r = this.meshes.get(m)
      if (!r) continue
      this.meshes.delete(m)
      this.items.delete(r.item)
    }
  }

  frame(): void {
    if (this.disposed) return
    this.seconds = this.now()
    this.modeNow = this.modeOf()
    const e = this.exposureOf()
    this.scale = exposureScale(e)
    this.night = nightOf(e)
  }

  /** Holds the clock (the lab's frozen frames); null resumes. */
  hold(at: number | null): void {
    this.now = at === null ? this.realNow : () => at
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameObs) this.scene.onBeforeRenderObservable.remove(this.frameObs)
    this.items.clear()
    ;(this.listener as { detach?: (s: WeaponRarity) => void } | null)?.detach?.(this)
    this.motesPart?.dispose()
    this.motesPart = null
    this.tex?.nebula.dispose()
    this.tex?.masks.dispose()
    this.tex = null
  }
}

const tmpV = new Vector3()

/**
 * The blade's across axis, face normal and half width in item-root space: across = the widest extent of the item's
 * box corners perpendicular to the blade, normal = blade × across. Bows and shields (box axes) work the same way.
 */
export interface BladeFrame {
  across: Vector3
  normal: Vector3
  halfWidth: number
  /** The item's extent along the blade in blade units (0 base, 1 tip; a spear's shaft runs below 0). */
  span: [number, number]
  /** Half its thickness along the normal (m) and the box centre's offsets across and along the normal (m). */
  halfDepth: number
  acrossMid: number
  normalMid: number
}

export function bladeFrame(spec: GlowItemSpec, meshes: readonly AbstractMesh[], base: Vector3, tip: Vector3): BladeFrame {
  const a = tip.subtract(base)
  const len = a.length()
  if (len < 1e-6) return { across: new Vector3(0, 1, 0), normal: new Vector3(1, 0, 0), halfWidth: 0.03, span: [0, 1], halfDepth: 0.01, acrossMid: 0, normalMid: 0 }
  a.scaleInPlace(1 / len)
  spec.root.computeWorldMatrix(true).invertToRef(tmpInv)
  const pts: Vector3[] = []
  for (const m of meshes) {
    m.computeWorldMatrix(true)
    for (const p of m.getBoundingInfo().boundingBox.vectorsWorld) pts.push(Vector3.TransformCoordinates(p, tmpInv))
  }
  let best: Vector3 | null = null
  let bestExt = -1
  let bestMid = 0
  for (const axis of [Vector3.Right(), Vector3.Up(), Vector3.Forward()]) {
    // the axis made perpendicular to the blade
    const w = axis.subtract(a.scale(Vector3.Dot(axis, a)))
    const wl = w.length()
    if (wl < 0.2) continue
    w.scaleInPlace(1 / wl)
    let lo = Infinity
    let hi = -Infinity
    for (const p of pts) {
      p.subtractToRef(base, tmpV)
      const d = Vector3.Dot(tmpV, w)
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    if (hi - lo > bestExt) {
      bestExt = hi - lo
      best = w
      bestMid = (hi + lo) / 2
    }
  }
  const across = best ?? new Vector3(0, 1, 0)
  const normal = Vector3.Cross(a, across).normalize()
  const ext = (v: Vector3, k: number): [number, number] => {
    let lo = Infinity
    let hi = -Infinity
    for (const p of pts) {
      p.subtractToRef(base, tmpV)
      const d = Vector3.Dot(tmpV, v) * k
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    return Number.isFinite(lo) ? [lo, hi] : [0, 1]
  }
  const [t0, t1] = ext(a, 1 / len)
  const [n0, n1] = ext(normal, 1)
  return { across, normal, halfWidth: Math.max(0.008, bestExt / 2), span: [t0, t1], halfDepth: Math.max(0.004, (n1 - n0) / 2), acrossMid: bestMid, normalMid: (n0 + n1) / 2 }
}

const v3 = (p: { x: number; y: number; z: number }): Vector3 => new Vector3(p.x, p.y, p.z)

/** The effect region of a model, cached per geometry and kind (vertices read once, in the item root's space). */
const REGIONS = new WeakMap<object, Map<string, WeaponRegion | null>>()

export function modelRegion(spec: GlowItemSpec, meshes: readonly AbstractMesh[], kind: string): WeaponRegion | null {
  const geo = (meshes[0] as { geometry?: object | null }).geometry ?? meshes[0]!
  let byKind = REGIONS.get(geo)
  if (!byKind) REGIONS.set(geo, (byKind = new Map()))
  const rk = regionKindOf(kind)
  if (byKind.has(rk)) return byKind.get(rk)!
  const pts: number[] = []
  const inv = new Matrix()
  const p = new Vector3()
  for (const m of meshes) {
    const data = m.getVerticesData(VertexBuffer.PositionKind)
    if (!data) continue
    itemToMesh(spec.root, m).invertToRef(inv)
    for (let i = 0; i + 2 < data.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(data[i]!, data[i + 1]!, data[i + 2]!, inv, p)
      pts.push(p.x, p.y, p.z)
    }
  }
  const a = spec.dummies.get('ai_start')
  const b = spec.dummies.get('ai_end')
  const r = weaponRegion(pts, a ? { x: a.x, y: a.y, z: a.z } : null, b ? { x: b.x, y: b.y, z: b.z } : null, rk)
  byKind.set(rk, r)
  return r
}

// ---- the motes (far LOD) ----------------------------------------------------------------------------------------

/**
 * Which rare items show effects this frame: your own first, then the nearest on screen within range, at most `cap`.
 * Fills `out` (and `keys`, the sort keys) in place, nearest first: no allocation once they have grown.
 */
export function pickMotes(items: Iterable<RareItem>, cap: number, eye: Vector3 | null, out: RareItem[] = [], keys: number[] = []): RareItem[] {
  out.length = 0
  keys.length = 0
  if (cap <= 0) return out
  for (const it of items) {
    if (it.owner.isOffscreen) continue
    const m = it.meshes[0]
    // a crowd member's weapon is hidden but drawn by the crowd tier (three/crowd-tier.ts), its world matrix following it
    if (!m || m.isDisposed() || !(m.isEnabled() || isCrowdDrawn(m)) || !m.isVisible || m.visibility <= 0.05) continue
    const self = it.owner.lodFull
    const d = eye ? Vector3.Distance(eye, it.owner.root.getAbsolutePosition()) : 0
    if (!self && d > MOTE_RANGE_M) continue
    const key = self ? -1 : d
    if (out.length >= cap && key >= keys[out.length - 1]!) continue
    // Insertion into the sorted, capped list.
    let i = Math.min(out.length, cap - 1)
    if (out.length < cap) {
      out.length++
      keys.length++
    }
    while (i > 0 && keys[i - 1]! > key) {
      out[i] = out[i - 1]!
      keys[i] = keys[i - 1]!
      i--
    }
    out[i] = it
    keys[i] = key
  }
  return out
}

/** A stable 0..1 hash of two integers. */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/**
 * One mote of a tier at `seconds`: where along the blade (0 base .. 1 tip), its offset (m) up and sideways (camera
 * plane), its size (× the unit) and alpha (0..1), and the 0..1 mix from the core to the edge colour. Pure (tests).
 */
export interface Mote {
  t: number
  up: number
  side: number
  size: number
  alpha: number
  mix: number
}

export function moteAt(kind: number, i: number, phase: number, seconds: number, out: Mote = { t: 0, up: 0, side: 0, size: 0, alpha: 0, mix: 0 }): Mote {
  const seed = Math.floor(phase * 9973) + i * 131
  const h1 = hash2(seed, 1)
  const period = kind === 1 ? 1.4 + 0.9 * h1 : kind === 2 ? 2.6 + 1.2 * h1 : 0.9 + 0.5 * h1
  const cyc = seconds / period + hash2(seed, 2)
  const n = Math.floor(cyc)
  const u = cyc - n
  const t = 0.08 + 0.92 * hash2(seed, n * 7 + 3)
  const side0 = hash2(seed, n * 7 + 4) - 0.5
  const s = Math.sin(Math.PI * u)
  out.t = t
  if (kind === 1) {
    // A star sparkle: blinks on and off near the blade.
    out.up = (hash2(seed, n * 7 + 5) - 0.5) * 0.1 + u * 0.03
    out.side = side0 * 0.12
    out.size = 0.5 + 0.9 * s
    out.alpha = s * s
    out.mix = hash2(seed, n * 7 + 6)
  } else if (kind === 2) {
    // Moon mist: a soft puff that drifts off the blade and spreads.
    out.up = u * 0.16
    out.side = side0 * 0.06
    out.size = 0.8 + 1.1 * u
    out.alpha = 0.38 * s
    out.mix = u
  } else {
    // A sun ember: flies up, wobbling, cooling from yellow to red.
    out.up = Math.pow(u, 0.8) * 0.55
    out.side = side0 * 0.06 + Math.sin(u * 6 + h1 * 9) * 0.035
    out.size = 0.55 * (1 - 0.5 * u)
    out.alpha = (1 - u) * Math.min(1, u * 8)
    out.mix = u
  }
  return out
}

/** The mote size per metre of blade, and its floor (m). */
const MOTE_UNIT_PER_M = 0.11
const MOTE_UNIT_MIN = 0.05
const MOTE_SPRITES = ['flare', 'mist', 'ember'] as const

/**
 * The motes of rare weapons outside the full-effect set (and the whole rare look on a page without the effects
 * layer): a few sprites near each blade, drawn into the scene's effect batch (one draw for everything).
 */
export class RarityMotes {
  readonly batch: FxBatch
  private readonly painter: Painter
  private readonly ownBatch: boolean
  drawn = 0
  shown: RareItem[] = []
  private readonly tip = new Vector3()
  private readonly base = new Vector3()
  private readonly at = new Vector3()
  private readonly col = new Color3()
  private readonly mote: Mote = { t: 0, up: 0, side: 0, size: 0, alpha: 0, mix: 0 }
  private readonly keys: number[] = []

  constructor(readonly scene: Scene, batch?: FxBatch, painter?: Painter) {
    this.ownBatch = !batch
    this.batch = batch ?? new FxBatch(scene, 64)
    this.painter = painter ?? new Painter(this.batch)
  }

  /** Picks (your own first, nearest, capped) and draws: a frame of its own batch (tests; pages without the layer). */
  update(items: Iterable<RareItem>, mode: RarityMode, seconds: number): void {
    const camera: Camera | null = this.scene.activeCamera
    const chosen = pickMotes(items, mode.moteCap, camera?.globalPosition ?? null, this.shown, this.keys)
    this.shown = chosen
    if (this.ownBatch) this.batch.begin()
    if (camera) this.painter.frame(camera)
    const start = this.batch.count
    if (camera) for (const it of chosen) this.drawItem(it, mode.lite, seconds)
    this.drawn = this.batch.count - start
    if (this.ownBatch) this.batch.end()
  }

  /** Draws one item's motes into the batch (the painter's camera axes are this frame's). */
  drawItem(it: RareItem, lite: boolean, seconds: number, fade = 1): void {
    const m = it.meshes[0]!
    const w = m.computeWorldMatrix(true)
    Vector3.TransformCoordinatesToRef(it.tip, w, this.tip)
    Vector3.TransformCoordinatesToRef(it.base, w, this.base)
    const length = Vector3.Distance(this.tip, this.base)
    const unit = Math.max(MOTE_UNIT_MIN, MOTE_UNIT_PER_M * Math.max(0.5, Math.min(1.2, length)))
    const n = lite ? Math.ceil(it.look.motes / 2) : it.look.motes
    const L = it.look
    const p = this.painter
    const vis = m.visibility * fade
    for (let i = 0; i < n; i++) {
      const mo = moteAt(L.kind, i, it.phase, seconds, this.mote)
      if (mo.alpha <= 0.01) continue
      Vector3.LerpToRef(this.base, this.tip, mo.t, this.at)
      this.at.y += mo.up
      this.at.addInPlaceFromFloats(p.right.x * mo.side, p.right.y * mo.side, p.right.z * mo.side)
      const k = Math.min(1, mo.mix)
      this.col.set(L.moteCore[0] + (L.moteEdge[0] - L.moteCore[0]) * k, L.moteCore[1] + (L.moteEdge[1] - L.moteCore[1]) * k, L.moteCore[2] + (L.moteEdge[2] - L.moteCore[2]) * k)
      const spin = L.kind === 1 ? seconds * 1.4 + i : L.kind === 2 ? i * 1.7 + seconds * 0.2 : 0
      const bright = L.kind === 2 ? 0.9 : 2
      p.billboard(this.at.x, this.at.y, this.at.z, (unit * mo.size) / 2, spin, MOTE_SPRITES[L.sprite] ?? 'flare', p.rgb(this.col.r, this.col.g, this.col.b, mo.alpha * vis * bright))
    }
  }

  dispose(): void {
    if (this.ownBatch) this.batch.dispose()
  }
}
