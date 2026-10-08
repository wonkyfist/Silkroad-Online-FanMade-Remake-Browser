/**
 * Weapon rarity (docs/RARITY.md): the retail seal rows. A weapon family `ITEM_CH_<KIND>_<DD>` has the ordinary grades
 * `_A`, `_B`, `_C` (regular weapons) and three seal rows `_A_RARE` (Seal of Star), `_B_RARE` (Seal of Moon) and
 * `_C_RARE` (Seal of Sun): the rare weapons. On a seal row the letter is the seal, not a grade (itemdata gives all three
 * the A grade's level; Star has the C grade's stats, Moon ×1.3, Sun ×1.65). Environment-neutral (server, client, admin).
 */

/** The rare tiers, lowest first. */
export type RarityTier = 'star' | 'moon' | 'sun'
export const RARITY_TIERS: readonly RarityTier[] = ['star', 'moon', 'sun']

export interface RarityInfo {
  tier: RarityTier
  /** 1 (Star) .. 3 (Sun). */
  rank: number
  /** The seal letter of the code (`_A_RARE`). */
  letter: 'A' | 'B' | 'C'
  /** Retail name of the seal. */
  name: string
  /** Name colour (CSS hex) and its light companion (banner text, beam core). */
  color: string
  light: string
}

/** docs/RARITY.md §3 [decision]: violet starlight, jade moonlight, sun gold. */
export const RARITY: Readonly<Record<RarityTier, RarityInfo>> = {
  star: { tier: 'star', rank: 1, letter: 'A', name: 'Seal of Star', color: '#b98cff', light: '#e6dcff' },
  moon: { tier: 'moon', rank: 2, letter: 'B', name: 'Seal of Moon', color: '#6ff0cf', light: '#d8fff4' },
  sun: { tier: 'sun', rank: 3, letter: 'C', name: 'Seal of Sun', color: '#ffb02e', light: '#fff0c4' },
}

/** `<family>_<seal>_RARE`; a family is `ITEM_CH_SWORD_03` or, for armour, `ITEM_CH_M_HEAVY_03_BA`. */
const SEAL_RE = /^(ITEM_[A-Z]+_.+_\d\d(?:_[A-Z]{2})?)_([ABC])_RARE$/
const GRADE_RE = /^(ITEM_[A-Z]+_.+_\d\d(?:_[A-Z]{2})?)_([ABC])$/
const LETTER_TIER: Readonly<Record<string, RarityTier>> = { A: 'star', B: 'moon', C: 'sun' }

/** The tier of a seal code (`ITEM_CH_SWORD_03_B_RARE` → 'moon'); null for every other code (regular items, `_DEF`). */
export function rarityOf(code: string | null | undefined): RarityTier | null {
  if (!code) return null
  const m = SEAL_RE.exec(code)
  return m ? LETTER_TIER[m[2]!]! : null
}

/** The rank of a code: 0 regular, 1 Star, 2 Moon, 3 Sun. */
export function rarityRank(code: string | null | undefined): number {
  const t = rarityOf(code)
  return t ? RARITY[t].rank : 0
}

/** The family of a regular grade or a seal code (`ITEM_CH_SWORD_03_B` → `ITEM_CH_SWORD_03`); null otherwise. */
export function rarityFamily(code: string): string | null {
  return SEAL_RE.exec(code)?.[1] ?? GRADE_RE.exec(code)?.[1] ?? null
}

/** The seal code of `tier` in `code`'s family (`ITEM_CH_SWORD_03_A`, 'sun' → `ITEM_CH_SWORD_03_C_RARE`). */
export function rareCodeOf(code: string, tier: RarityTier): string | null {
  const f = rarityFamily(code)
  return f ? `${f}_${RARITY[tier].letter}_RARE` : null
}

/**
 * The regular row a seal shares its model with (the family's `_A` grade): seal rows name the same BSR and icon as the
 * ordinary ones (itemdata col 52/54) and are not in the equipment manifest. Other codes come back unchanged.
 */
export function modelCodeOf(code: string): string {
  const m = SEAL_RE.exec(code)
  return m ? `${m[1]}_A` : code
}

/** Rare-drop knobs (percent of an ordinary weapon drop that turns into a seal; docs/RARITY.md §4). */
export interface RarityRates {
  starPct: number
  moonPct: number
  sunPct: number
}

/**
 * docs/RARITY.md §4.2 [decision, CLIMB D54; the user: "very very low, like in the 1%–2%"]: of every gear drop, Star
 * 1.5 %, Moon 0.4 %, Sun 0.1 % (2 % in all), monsters and bosses alike; each knob at most RARE_PCT_MAX.
 * `topMinLevel` (the Climb, docs/CLIMB.md §4.1 D41, D53): a weapon of the cap tier (degree 4) comes as Moon or Sun only
 * from a monster of at least this level (the cap band); a lower monster's Moon or Sun roll becomes Star. 0 = no limit.
 * `midMinLevel` (D54): the same for the degree below the cap tier (degree 3) from level 21.
 */
export const RARITY_DEFAULTS = { starPct: 1.5, moonPct: 0.4, sunPct: 0.1, announceFrom: 3, topMinLevel: 25, midMinLevel: 21 } as const
/** The admin's ceiling for each seal chance (percent of a gear drop; D54). */
export const RARE_PCT_MAX = 2

/**
 * Rolls the tier of one ordinary weapon drop: one roll `r` in [0, 100) against Sun, then Sun + Moon, then the sum (the
 * rarest first, so the tiers never overlap; the sum is capped at 100). Null = it stays regular.
 */
export function rollRarity(rng: () => number, rates: RarityRates): RarityTier | null {
  const sun = Math.max(0, rates.sunPct)
  const moon = Math.max(0, rates.moonPct)
  const star = Math.max(0, rates.starPct)
  if (!(sun + moon + star > 0)) return null
  const r = rng() * 100
  if (r < sun) return 'sun'
  if (r < sun + moon) return 'moon'
  if (r < sun + moon + star) return 'star'
  return null
}
