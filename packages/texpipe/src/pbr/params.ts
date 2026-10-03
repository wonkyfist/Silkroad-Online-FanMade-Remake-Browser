/**
 * TP-P parameters (docs/TEXPIPE.md §3.5–3.7, docs/DETAIL.md L3): what the derivation does to one texture, resolved
 * from its RENDER class (world-render `pbr/classes.ts`: base roughness, metallic, porosity), a finer **profile** (the
 * TEXPIPE factors `delight`, normal strength, AO strength, roughness variation, which differ within one class: a
 * city wall and plaza paving are both `stone`), and the review's overrides (content/texpipe/overrides.json `pbr`).
 *
 * Profile numbers: TEXPIPE §3.5 (de-light k), §3.7 (normal strengths, tuned by eye on the prototype's 2K masters) and
 * the prototype's CLASS table (`work/tmp/texpipe/proto.ts`: AO strength, roughness variation). Actor atlases also get
 * the DETAIL L3 material masks (masks.ts) and, unless turned off, the baked detail layer (detail.ts).
 *
 * Pure (no node:*).
 */
import { classParams, type MaterialClass, type MaterialClassParams } from '../../../world-render/src/pbr/classes.ts'
import type { AlphaKind, MaskClass, MaskPaint, PbrDeriveOverride, PbrStatus } from '../format.ts'
import { isPavingFile, PAVING_TILES } from '../paving.ts'

/** Bump when a formula or a default changes: it is part of every master's cache hash. */
export const PBR_PIPELINE_VERSION = 3

export const PROFILES = [
  'paving', 'stone', 'wall', 'rock', 'roof', 'bark', 'wood', 'soil', 'grass', 'leaves', 'cloth', 'armour', 'skin',
  'hair', 'metal', 'water', 'default',
] as const
export type Profile = (typeof PROFILES)[number]

export interface ProfileParams {
  /** De-light strength k (TEXPIPE §3.5): 0 keeps the painted light, 1 divides out all low-frequency luminance. */
  delight: number
  /** Normal strength (TEXPIPE §3.7 class strengths; the runtime class `normalStrength` scales it again). */
  normal: number
  /** AO strength (cavity darkening). */
  ao: number
  /** Roughness variation around the class base (cavities rougher, bright flat texels smoother). */
  roughVar: number
}

/**
 * TEXPIPE §3.5 k and §3.7 strengths; AO and roughness variation from the prototype's CLASS table. Wall 2.5 (not 3.5) and
 * bark 3 (not 4) at first: the prototype review found both "lumpy" (TEXPIPE §7.3), and TEXPIPE §3.8's override example
 * sets the wall to 2.5; the TP-P previews agreed. Lowered again by the B0 review:
 *
 * Wall AO 0.4 / normal 1.9 (was 1 / 2.5) and bark AO 0.5 / normal 2.25 (was 1.2 / 3): the B0 review asked to halve
 * the derived AO/relief darkening on the city wall and the tree bark, and the measurement said it is the profile, not
 * those two textures (work/tmp/w9b-b0/measure.ts: the lit preview's mean display luma against retail's, same light, on
 * 6 walls and 8 opaque tree trunks of the inventory: every one 8–17 % darker). The darkening is lit(all maps) minus
 * lit(flat maps); halving the AO strength alone removed only a third of it (the normal relief is the rest), AO × 0.4
 * with normals × 0.75 halves it (city wall −10.6 → −5.4 %, bark −10.4 → −8.5 % after the de-light and tone-match fixes)
 * and makes both less blotchy (local-contrast measure 0.217 → 0.192 and 0.345 → 0.323; retail 0.163 and 0.292).
 */
export const PROFILE_PARAMS: Readonly<Record<Profile, Readonly<ProfileParams>>> = {
  paving: { delight: 0.7, normal: 3, ao: 1, roughVar: 0.2 },
  stone: { delight: 0.65, normal: 3, ao: 1, roughVar: 0.18 },
  wall: { delight: 0.6, normal: 1.9, ao: 0.4, roughVar: 0.15 },
  rock: { delight: 0.7, normal: 4, ao: 1.2, roughVar: 0.15 },
  roof: { delight: 0.5, normal: 3, ao: 1, roughVar: 0.2 },
  bark: { delight: 0.5, normal: 2.25, ao: 0.5, roughVar: 0.1 },
  wood: { delight: 0.5, normal: 3, ao: 1, roughVar: 0.12 },
  soil: { delight: 0.8, normal: 2, ao: 0.8, roughVar: 0.08 },
  grass: { delight: 0.8, normal: 2, ao: 0.8, roughVar: 0.1 },
  leaves: { delight: 0.3, normal: 1.5, ao: 0.6, roughVar: 0.15 },
  cloth: { delight: 0.3, normal: 1.5, ao: 0.8, roughVar: 0.1 },
  armour: { delight: 0.25, normal: 2, ao: 1, roughVar: 0.12 },
  skin: { delight: 0.2, normal: 1, ao: 0.6, roughVar: 0.1 },
  hair: { delight: 0.2, normal: 2, ao: 0.8, roughVar: 0.15 },
  metal: { delight: 0.25, normal: 1.5, ao: 0.8, roughVar: 0.15 },
  water: { delight: 0, normal: 0.5, ao: 0, roughVar: 0 },
  default: { delight: 0.4, normal: 2, ao: 1, roughVar: 0.12 },
}

/** De-light is capped on actors: strong de-lighting washes painted atlases out (TEXPIPE §3.5, the white chest). */
export const ACTOR_DELIGHT_MAX = 0.3
/** A set is flagged `delit` (RENDER lowers the direct light on sets without it) from this k up. */
export const DELIT_MIN = 0.5
/** Sources this small (short edge) carry too little for derived maps: flagged, the review usually picks albedo-only. */
export const TINY_SOURCE = 64

const ACTOR_GROUPS = new Set(['char', 'npc', 'mob', 'equipment', 'item'])
export const isActorGroup = (group: string) => ACTOR_GROUPS.has(group)

/**
 * Bark: a tree trunk. `trunk|bark` anywhere; `_pilla|_stem` only on a `tre_` file (`tre_bank_pilla`: the ginkgo's
 * trunk), not on the building pillars (`cj_pal_pillar`, `naru_pilla01`: painted or planed wood); and any `tre_` texture
 * of class wood, which classes.ts gives only to an OPAQUE `tre_` texture, the trunk (`tre_frie_body`, `tre_dry_01`).
 */
function isBark(file: string, cls: MaterialClass): boolean {
  if (/trunk|bark/.test(file)) return true
  if (!file.startsWith('tre_')) return false
  return /_pilla|_stem/.test(file) || cls === 'wood'
}

/** The profile of a texture from its key and class (TEXPIPE's finer classes inside one RENDER class). */
export function profileOf(key: string, cls: MaterialClass): Profile {
  const k = key.toLowerCase()
  const file = k.slice(Math.max(k.lastIndexOf('/'), k.lastIndexOf(':')) + 1)
  if (/_hair/.test(file) && /(^|\/)char\//.test(k)) return 'hair'
  if (isBark(file, cls)) return 'bark'
  // the palette's road slabs named as stone or dust (paving.ts, TEL-3)
  if (PAVING_TILES.includes(file)) return 'paving'
  switch (cls) {
    case 'stone':
      if (isPavingFile(file)) return 'paving'
      if (/wall|brick|castle/.test(file)) return 'wall'
      if (/rock|clif|cliff|stone_hm|stone_fld/.test(file)) return 'rock'
      return 'stone'
    case 'roof_tile': return 'roof'
    case 'wood': return 'wood'
    case 'ground_soil': return 'soil'
    case 'ground_grass': return 'grass'
    case 'foliage': return 'leaves'
    case 'cloth': return 'cloth'
    case 'skin': return 'skin'
    case 'metal': return 'metal'
    case 'water': return 'water'
    default: return /(^|\/)item\//.test(k) ? 'armour' : 'default'
  }
}

/**
 * The world N.y the wet preview gives a set's surface (preview.ts `WetState.up`): terrain tiles and world floors,
 * stairs and paving face up (1: puddles possible), roofs slope (0.7, a 45° roof: soaks fully, no puddles), everything
 * else is vertical (0: walls, trunks, props and actors; wet at 60 %, no puddles, WEATHER §6.3).
 */
export function surfaceUp(key: string, group: string, cls: MaterialClass): number {
  if (group === 'tile') return 1
  if (isActorGroup(group)) return 0
  const k = key.toLowerCase()
  const file = k.slice(Math.max(k.lastIndexOf('/'), k.lastIndexOf(':')) + 1)
  if (/floor|flooste|stair|pave|plaza|marble|(^|_)road/.test(file)) return 1
  if (profileOf(key, cls) === 'roof') return 0.7
  return 0
}

// ---- material masks (DETAIL L3) ---------------------------------------------------------------------------------------

/** The kind of actor atlas, which picks the mask classes and detail tilings (DETAIL's per-texture cfgs). */
export type AtlasKind = 'body' | 'hair' | 'weapon' | 'garment' | 'actor'

export function atlasKind(key: string): AtlasKind {
  const k = key.toLowerCase()
  if (/(^|\/)char\/.*_hair/.test(k)) return 'hair'
  if (/(^|\/)char\/.*_(body|face)/.test(k)) return 'body'
  if (/\/weapon\//.test(k)) return 'weapon'
  if (/_item\//.test(k)) return 'garment'
  return 'actor'
}

/** The classes the clustering may assign, per atlas kind (DETAIL's `allowed` per cfg; `wood`, `jade` only by review). */
export const MASK_ALLOWED: Readonly<Record<AtlasKind, readonly MaskClass[]>> = {
  body: ['skin', 'hair', 'cloth', 'gold', 'leather'],
  hair: ['hair'],
  weapon: ['metal', 'gold', 'leather', 'cloth'],
  garment: ['cloth', 'leather', 'gold', 'metal'],
  actor: ['cloth', 'leather', 'metal', 'gold', 'skin'],
}

/** Olive trims and bindings: leather by default, cloth on the body atlas (DETAIL cfg `olive`). */
export const MASK_OLIVE: Readonly<Record<AtlasKind, MaskClass>> = {
  body: 'cloth', hair: 'hair', weapon: 'leather', garment: 'leather', actor: 'leather',
}

/** Per mask class: base roughness (DETAIL BASE_ROUGH), how much albedo relief it keeps (MACRO), bevel height. */
export const MASK_PARAMS: Readonly<Record<MaskClass, Readonly<{ rough: number; macro: number; bevel: number }>>> = {
  cloth: { rough: 0.88, macro: 0.8, bevel: 0 },
  leather: { rough: 0.58, macro: 1, bevel: 0.45 },
  metal: { rough: 0.32, macro: 1, bevel: 0.9 },
  gold: { rough: 0.26, macro: 1.2, bevel: 0.7 },
  skin: { rough: 0.52, macro: 0.45, bevel: 0 },
  hair: { rough: 0.45, macro: 0.9, bevel: 0.2 },
  wood: { rough: 0.62, macro: 1, bevel: 0.3 },
  // Polished stone: glossy and dielectric (the metallic gate is metal + gold only), soft carved relief.
  jade: { rough: 0.22, macro: 0.8, bevel: 0.4 },
}

// ---- detail layer (DETAIL L3/L4, baked until the runtime plugin DT-4 exists) ----------------------------------------------

/**
 * Detail amplitudes per mask class: normal/roughness/height (`amp`) and albedo (`albedo`). DETAIL's AMP/AMP_ALB, with
 * metal and gold halved: sheet 2 found the scratches and the hammering "too loud (cut about 50%)".
 */
export const DETAIL_AMP: Readonly<Record<MaskClass, Readonly<{ amp: number; albedo: number }>>> = {
  cloth: { amp: 0.6, albedo: 0.35 },
  leather: { amp: 0.9, albedo: 0.8 },
  metal: { amp: 0.22, albedo: 0.35 },
  gold: { amp: 0.22, albedo: 0.3 },
  skin: { amp: 0.35, albedo: 0.4 },
  hair: { amp: 0.8, albedo: 0.8 },
  wood: { amp: 0.6, albedo: 0.5 },
  jade: { amp: 0.25, albedo: 0.35 },
}

/** Detail tiling: repeats of one detail tile per atlas width (DETAIL DEF_T and the per-cfg tweaks). */
export const DETAIL_TILING: Readonly<Record<AtlasKind, Readonly<Record<MaskClass, number>>>> = {
  body: { cloth: 12, leather: 6, metal: 5, gold: 5, skin: 28, hair: 6, wood: 4, jade: 4 },
  hair: { cloth: 8, leather: 6, metal: 5, gold: 5, skin: 6, hair: 5, wood: 4, jade: 4 },
  weapon: { cloth: 8, leather: 6, metal: 4, gold: 5, skin: 6, hair: 5, wood: 3, jade: 3 },
  garment: { cloth: 12, leather: 7, metal: 5, gold: 5, skin: 6, hair: 5, wood: 4, jade: 4 },
  actor: { cloth: 8, leather: 6, metal: 5, gold: 5, skin: 6, hair: 5, wood: 4, jade: 4 },
}

// ---- resolution ---------------------------------------------------------------------------------------------------------

/** What the derivation needs to know about one texture (an inventory entry plus its source size). */
export interface DeriveMeta {
  key: string
  /** Inventory group: tile | world | char | npc | mob | equipment | item. */
  group: string
  class: MaterialClass
  alpha: AlphaKind
  wrap: [boolean, boolean]
  /** Retail source size [w, h] (the master is `scale` × this). */
  sourceSize: [number, number]
  status?: PbrStatus
}

export interface DeriveOptions {
  /** Compute DETAIL L3 material masks for actor atlases (default true). */
  masks?: boolean
  /** Bake the detail layer where masks exist (default true; false once DT-4 samples it at runtime). */
  detail?: boolean
}

export interface ResolvedParams {
  profile: Profile
  cls: Readonly<MaterialClassParams>
  delight: number
  normal: number
  ao: number
  roughVar: number
  invertHeight: boolean
  /** × the de-lit albedo in linear light (1 = unchanged). */
  albedoGain: number
  /** × per channel in linear light after the gain ([1, 1, 1] = unchanged; grain.ts). */
  albedoTint: [number, number, number]
  /** The sand grain's amount (0 = none; grain.ts). */
  grain: number
  /** Ripple-mark amplitude blended into the height (0 = none). */
  ripples: number
  /** Master texels per source texel (the upscale factor): the scale unit of every blur (TEXPIPE's `s`). */
  scale: number
  actor: boolean
  /** Material masks: null when the texture is not an actor atlas (tileable, world, or masks off). */
  masks: null | {
    kind: AtlasKind; allowed: readonly MaskClass[]; olive: MaskClass; relabel: Record<string, MaskClass | 'fill'>; paint: readonly MaskPaint[]
  }
  /** Detail amplitude multiplier (0 = none). */
  detail: number
  delit: boolean
  tiny: boolean
  /** Derive only the de-lit albedo (review status `albedo-only`). */
  albedoOnly: boolean
}

/** The parameters of one texture at a master of `masterSize`, with the review override applied. */
export function resolveParams(meta: DeriveMeta, masterSize: [number, number], ov: PbrDeriveOverride = {}, opts: DeriveOptions = {}): ResolvedParams {
  const profile = profileOf(meta.key, meta.class)
  const p = PROFILE_PARAMS[profile]
  const actor = isActorGroup(meta.group)
  let delight = ov.delight ?? p.delight
  if (actor && ov.delight === undefined) delight = Math.min(delight, ACTOR_DELIGHT_MAX)
  const scale = Math.max(1, Math.max(masterSize[0], masterSize[1]) / Math.max(1, meta.sourceSize[0], meta.sourceSize[1]))
  const atlas = !meta.wrap[0] && !meta.wrap[1]
  const kind = atlasKind(meta.key)
  const masks = opts.masks !== false && actor && atlas
    ? { kind, allowed: ov.maskAllowed ?? MASK_ALLOWED[kind], olive: MASK_OLIVE[kind], relabel: ov.maskRelabel ?? {}, paint: ov.maskPaint ?? [] }
    : null
  return {
    profile,
    cls: ov.roughness === undefined ? classParams(meta.class) : { ...classParams(meta.class), roughness: ov.roughness },
    delight,
    normal: p.normal * (ov.normalScale ?? 1),
    ao: p.ao * (ov.aoScale ?? 1),
    roughVar: p.roughVar,
    invertHeight: ov.invertHeight ?? false,
    albedoGain: ov.albedoGain ?? 1,
    albedoTint: ov.albedoTint ? [ov.albedoTint[0], ov.albedoTint[1], ov.albedoTint[2]] : [1, 1, 1],
    grain: ov.grain ?? 0,
    ripples: ov.ripples ?? 0,
    scale,
    actor,
    masks,
    detail: masks && opts.detail !== false ? (ov.detail ?? 1) : 0,
    delit: delight >= DELIT_MIN,
    tiny: Math.min(meta.sourceSize[0], meta.sourceSize[1]) <= TINY_SOURCE,
    albedoOnly: meta.status === 'albedo-only',
  }
}
