/**
 * The character look (docs/CHARACTERS.md §16.8): one record per character that every client draws that character with
 * (the licensed Waterbender bodies; a server or client without the pack draws the retail model and ignores it). Stored
 * in characters.look (migration 23, JSON), sent in EntityState.look / CharacterSummary.look / appearance.look, accepted
 * in charCreate.look (the creator, later). Every field exists now with its default so the creator and the
 * outfits-by-gear job only change values, never the shape.
 *
 * Imports nothing at runtime (protocol.ts and validate.ts import it).
 */

export type LookBody = 'f' | 'm'

/** The body sliders (0–100; CHARACTERS §5.2): 50 = the base's neutral shape unless stated. */
export interface LookBuild {
  weight: number
  muscle: number
  chest: number
  buttocks: number
  hips: number
  waist: number
  thigh: number
  shoulders: number
}

export interface CharLook {
  v: 1
  /** The pack body: its gender (always the character model's gender). */
  body: LookBody
  /** The outfit variant of that body ('01'..'04' girl, '01'..'03' boy); outfits by worn gear replace it later. */
  outfit: string
  /** The hairstyle (LOOK_HAIRS: a style and the bangs; '01'..'04' are the outfits' own). */
  hair: string
  /** The head's makeup map (`T_HEAD_<F|M>_BaseColor_<makeup>`: '16_04', '04', ...). */
  makeup: string
  /** The iris map (`T_EYES_BaseColor_<iris>`, '01'..'36'). */
  iris: string
  /** Hair colour: 0 = the pack's own, 1..31 a palette entry. */
  hairColor: number
  /** Skin tone: 0 = the pack's own, 1..23 a palette entry; `skinShift` a fine shift −50..50. */
  skinTone: number
  skinShift: number
  /** Markings (LOOK_PAINTS: the body paint, at most one) and accessories (LOOK_ACCESSORIES: earrings, hair flower, nails). */
  markings: string[]
  accessories: string[]
  /** Height 0..4 (the root scale, heightScale; mirrors characters.height). */
  height: number
  build: LookBuild
}

export const LOOK_VERSION = 1
/** The outfit variants each body has (the Waterbender pack: four girl, three boy). */
export const LOOK_OUTFITS: Readonly<Record<LookBody, readonly string[]>> = { f: ['01', '02', '03', '04'], m: ['01', '02', '03'] }
/** The makeup and iris each body starts with (the converter's FACE_DEFAULT / EYE_DEFAULT, CHARACTERS §16.3, §16.5). */
export const LOOK_MAKEUP_DEFAULT: Readonly<Record<LookBody, string>> = { f: '16_04', m: '04' }
export const LOOK_IRIS_DEFAULT: Readonly<Record<LookBody, string>> = { f: '01', m: '31' }
export const LOOK_BUILD_DEFAULT: Readonly<Record<LookBody, LookBuild>> = {
  f: { weight: 40, muscle: 30, chest: 35, buttocks: 40, hips: 45, waist: 40, thigh: 40, shoulders: 40 },
  m: { weight: 45, muscle: 45, chest: 20, buttocks: 35, hips: 40, waist: 45, thigh: 40, shoulders: 55 },
}
export const LOOK_LIMITS = {
  hairColor: [0, 31],
  skinTone: [0, 23],
  skinShift: [-50, 50],
  height: [0, 4],
  build: [0, 100],
  markings: 4,
  accessories: 6,
} as const
const IRIS = /^(0[1-9]|[12]\d|3[0-6])$/

// ---- the creator's catalogue (docs/CHARACTERS.md §16.10): what each body offers, checked by parseLook ----------------

/** The pack's head makeup maps (`T_HEAD_<F|M>_BaseColor_<id>`): 45 girl, 17 boy. The face shape itself never changes. */
export const LOOK_MAKEUPS: Readonly<Record<LookBody, readonly string[]>> = {
  f: ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '09_02', '09_03', '10', '11_01', '11_02', '11_03', '12_01', '12_02', '12_03', '13_01', '13_02', '13_03', '14_01', '14_02', '14_03', '15_01', '15_02', '16_01', '16_02', '16_03', '16_04', '16_05', '17_01', '17_02', '18', '18_01', '18_02', '19', '20', '21', '22', '23', '24', '26', '27'],
  m: ['00', '01', '02', '03', '04', '05', '06', '06_02', '07', '08', '09', '10_01', '10_02', '11_01', '12_01', '12_02', '13_01'],
}
/** The iris maps (`T_EYES_BaseColor_01..36`; 37 is not an albedo, §16.5). */
export const LOOK_IRISES: readonly string[] = Array.from({ length: 36 }, (_, i) => String(i + 1).padStart(2, '0'))

/**
 * Hairstyles: the pack's three styles, each with or without the bangs piece. '01'..'04' (girl) / '01'..'03' (boy) are
 * the hair of the outfit of that number (the looks stored before the creator), the others the remaining combinations.
 */
export interface LookHair {
  style: 1 | 2 | 3
  bangs: boolean
}
export const LOOK_HAIRS: Readonly<Record<LookBody, Readonly<Record<string, LookHair>>>> = {
  f: { '01': { style: 1, bangs: true }, '02': { style: 2, bangs: false }, '03': { style: 3, bangs: false }, '04': { style: 3, bangs: true }, '05': { style: 1, bangs: false }, '06': { style: 2, bangs: true } },
  m: { '01': { style: 1, bangs: true }, '02': { style: 2, bangs: false }, '03': { style: 3, bangs: false }, '04': { style: 1, bangs: false }, '05': { style: 2, bangs: true }, '06': { style: 3, bangs: true } },
}
/** The hair id of a style and bangs choice. */
export function lookHairId(body: LookBody, style: number, bangs: boolean): string {
  const e = Object.entries(LOOK_HAIRS[body]).find(([, h]) => h.style === style && h.bangs === bangs)
  return e ? e[0] : '01'
}

/**
 * Hair colours 1..31 (0 = the pack's own): sRGB, multiplied over the pack's white hair map (the creator's recolour).
 * Naturals first, then the dyes a fantasy wanderer might wear.
 */
export const LOOK_HAIR_COLORS: readonly string[] = [
  '#141210', '#231b16', '#33241a', '#4a3020', '#5e3d26', '#7a5234', '#966a45', '#5a2a1a', '#7e3a1e', '#a4542a',
  '#c07a48', '#cfa06a', '#dcbc8a', '#e6d2aa', '#c9c2b6', '#9a958e', '#6b6762', '#e8e4dc',
  '#1d2a4a', '#28466e', '#1f5a5a', '#2d6a4a', '#3a2a5a', '#5a2a5a', '#8a3a5a', '#c06a8a', '#7a1a24', '#4a1420', '#9ab8d8', '#b4a0d0', '#a0d0b8',
]
/**
 * Skin tones 1..23 (0 = the pack's own): linear multipliers on the pack's skin albedo, a natural range from porcelain to
 * deep brown (never green, blue or grey). `skinShift` (−50..50) brightens or darkens any tone by up to 8 %.
 */
export const LOOK_SKIN_TONES: readonly (readonly [number, number, number])[] = [
  [1.03, 1.02, 1.0], [0.99, 0.96, 0.93], [0.98, 0.93, 0.92], [0.96, 0.91, 0.84], [0.94, 0.9, 0.8], [0.92, 0.85, 0.75],
  [0.88, 0.81, 0.68], [0.85, 0.79, 0.62], [0.8, 0.71, 0.57], [0.76, 0.66, 0.51], [0.72, 0.61, 0.47], [0.67, 0.56, 0.44],
  [0.62, 0.52, 0.42], [0.6, 0.48, 0.36], [0.55, 0.43, 0.33], [0.5, 0.39, 0.3], [0.45, 0.35, 0.27], [0.4, 0.31, 0.24],
  [0.35, 0.27, 0.21], [0.31, 0.23, 0.18], [0.27, 0.2, 0.16], [0.23, 0.17, 0.14], [0.2, 0.15, 0.12],
]
/** The skin multiplier of a tone and shift (linear RGB; tone 0 = the pack's own, 1). */
export function lookSkinMultiplier(tone: number, shift: number): [number, number, number] {
  const t = LOOK_SKIN_TONES[tone - 1] ?? [1, 1, 1]
  const k = 1 + Math.max(-50, Math.min(50, shift)) * 0.0016
  return [t[0] * k, t[1] * k, t[2] * k]
}

/**
 * Markings: the pack's body paint mask (`T_BODY_*_Mask_Paint`: splashes over the body) in one of these colours; at
 * most one paint. Ids `paint_<colour>`.
 */
export const LOOK_PAINTS: Readonly<Record<string, string>> = {
  paint_white: '#e8e4dc', paint_black: '#1a1716', paint_red: '#a3262a', paint_blue: '#2a4e9a', paint_teal: '#1f7a78',
  paint_gold: '#c9962e', paint_violet: '#5c3a8a', paint_ochre: '#b0612a',
}
/** Accessories each body can wear (the pack's separate pieces). */
export const LOOK_ACCESSORIES: Readonly<Record<LookBody, readonly string[]>> = { f: ['earrings', 'hair_flower', 'nails'], m: [] }

/** The accessories an outfit variant came with (the looks before the creator: girl earrings, outfits 03 / 04 a hair flower). */
export function lookOutfitAccessories(body: LookBody, outfit: string): string[] {
  if (body !== 'f') return []
  return outfit === '03' || outfit === '04' ? ['earrings', 'hair_flower'] : ['earrings']
}
const BUILD_KEYS: readonly (keyof LookBuild)[] = ['weight', 'muscle', 'chest', 'buttocks', 'hips', 'waist', 'thigh', 'shoulders']
/** Volume 0..4 (the retail build) → the Weight slider (CHARACTERS §5.3). */
const WEIGHT_OF_VOLUME = [20, 30, 40, 55, 70]

/** The body of a character model code (`CHAR_CH_WOMAN_*` → 'f'). */
export function lookBodyOf(model: string): LookBody {
  return /^CHAR_[A-Z]+_WOMAN_/.test(model) ? 'f' : 'm'
}

/**
 * The default look of a body. `seed` (the character id) picks the outfit and its hair (migration 23 mirrors the hash), so a crowd of characters made
 * before the creator is not one outfit; `height` / `volume` carry the retail choices over.
 */
export function defaultLook(body: LookBody, seed = 0, height = 2, volume = 2): CharLook {
  const outfits = LOOK_OUTFITS[body]
  // a multiplicative hash of the id (its top 16 bits): ids that alternate genders still spread over every outfit
  const n = Math.abs(Math.trunc(seed))
  const outfit = outfits[(Math.imul(n, 0x9e3779b1) >>> 16) % outfits.length]!
  const build = { ...LOOK_BUILD_DEFAULT[body] }
  if (volume !== 2 && Number.isInteger(volume) && volume >= 0 && volume <= 4) build.weight = WEIGHT_OF_VOLUME[volume]!
  return {
    v: 1,
    body,
    outfit,
    hair: outfit,
    makeup: LOOK_MAKEUP_DEFAULT[body],
    iris: LOOK_IRIS_DEFAULT[body],
    hairColor: 0,
    skinTone: 0,
    skinShift: 0,
    markings: [],
    accessories: lookOutfitAccessories(body, outfit),
    height: Number.isInteger(height) && height >= 0 && height <= 4 ? height : 2,
    build,
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const clampInt = (x: unknown, [lo, hi]: readonly [number, number]): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : null

/**
 * Checks a look (from a client, the database or the wire): numbers are clamped to their ranges, ids must be ones the
 * body has; the version, the body and every id are strict. `body` (the character model's) must match when given.
 * Missing optional parts take the body's defaults. Returns the clean look or the first problem.
 */
export function parseLook(raw: unknown, body?: LookBody): { ok: true; look: CharLook } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'look must be an object' }
  if (raw.v !== LOOK_VERSION) return { ok: false, error: `look version ${String(raw.v)} is not ${LOOK_VERSION}` }
  if (raw.body !== 'f' && raw.body !== 'm') return { ok: false, error: 'look.body must be f or m' }
  const b = raw.body
  if (body && b !== body) return { ok: false, error: `look.body ${b} does not match the character (${body})` }
  const d = defaultLook(b)
  const outfits = LOOK_OUTFITS[b]
  const outfit = raw.outfit === undefined ? d.outfit : outfits.includes(raw.outfit as string) ? (raw.outfit as string) : null
  if (outfit === null) return { ok: false, error: `look.outfit must be one of ${outfits.join(', ')}` }
  const hairs = Object.keys(LOOK_HAIRS[b])
  const hair = raw.hair === undefined ? outfit : hairs.includes(raw.hair as string) ? (raw.hair as string) : null
  if (hair === null) return { ok: false, error: `look.hair must be one of ${hairs.join(', ')}` }
  const makeup = raw.makeup === undefined ? d.makeup : raw.makeup
  if (typeof makeup !== 'string' || !LOOK_MAKEUPS[b].includes(makeup)) return { ok: false, error: `look.makeup must be one of the ${b === 'f' ? 'girl' : 'boy'}'s makeups` }
  const iris = raw.iris === undefined ? d.iris : raw.iris
  if (typeof iris !== 'string' || !IRIS.test(iris)) return { ok: false, error: 'look.iris must be 01..36' }
  const num = (k: 'hairColor' | 'skinTone' | 'skinShift' | 'height', dv: number) => (raw[k] === undefined ? dv : clampInt(raw[k], LOOK_LIMITS[k]))
  const hairColor = num('hairColor', 0), skinTone = num('skinTone', 0), skinShift = num('skinShift', 0), height = num('height', 2)
  if (hairColor === null || skinTone === null || skinShift === null || height === null) return { ok: false, error: 'look numbers must be numbers' }
  const ids = (k: 'markings' | 'accessories', known: readonly string[]): string[] | null => {
    const v = raw[k]
    if (v === undefined) return k === 'accessories' ? lookOutfitAccessories(b, outfit) : []
    if (!Array.isArray(v) || v.length > LOOK_LIMITS[k] || !v.every(x => typeof x === 'string' && known.includes(x))) return null
    return [...new Set(v as string[])]
  }
  const markings = ids('markings', Object.keys(LOOK_PAINTS)), accessories = ids('accessories', LOOK_ACCESSORIES[b])
  if (!markings || markings.length > 1) return { ok: false, error: `look.markings: at most one of ${Object.keys(LOOK_PAINTS).join(', ')}` }
  if (!accessories) return { ok: false, error: `look.accessories: only ${LOOK_ACCESSORIES[b].join(', ') || 'none'} for this body` }
  const build = { ...d.build }
  if (raw.build !== undefined) {
    if (!isObj(raw.build)) return { ok: false, error: 'look.build must be an object' }
    for (const k of BUILD_KEYS) {
      if (raw.build[k] === undefined) continue
      const n = clampInt(raw.build[k], LOOK_LIMITS.build)
      if (n === null) return { ok: false, error: `look.build.${k} must be a number` }
      build[k] = n
    }
  }
  return { ok: true, look: { v: 1, body: b, outfit, hair, makeup, iris, hairColor, skinTone, skinShift, markings, accessories, height, build } }
}

/** The look stored for a character (JSON text, or null/garbage) or the default of its body. */
export function lookOrDefault(json: string | null | undefined, model: string, seed: number, height = 2, volume = 2): CharLook {
  const body = lookBodyOf(model)
  if (json) {
    try {
      const r = parseLook(JSON.parse(json), body)
      if (r.ok) return { ...r.look, height }
    } catch {
      // stored garbage: the default
    }
  }
  return defaultLook(body, seed, height, volume)
}
