/**
 * Every weapon its own rarity (docs/RARITY.md §5.1): the Seal of Star / Moon / Sun effects are designed per weapon
 * kind, not only for the sword. A rare item's kind comes from its slot (a shield) or the wearer's weapon family; each
 * (tier, kind) has a profile the effect layers read: how a swing draws (an arc that follows the blade, a straight
 * thrust from the tip, a wide sweep, a shot), how wide, where the tier's emblem sits and how loud the aura is. Pure
 * data and functions (tests).
 */
import type { RarityTier } from '@sro/shared'

export type RareKind = 'sword' | 'blade' | 'spear' | 'glaive' | 'bow' | 'shield'
export const RARE_KINDS: readonly RareKind[] = ['sword', 'blade', 'spear', 'glaive', 'bow', 'shield']

/** The item code's weapon kind (Chinese and European families; null: not a weapon or shield). */
export function rareKindOfCode(code: string | null | undefined): RareKind | null {
  if (!code) return null
  const m = /^ITEM_(?:CH|EU)_([A-Z]+)_/.exec(code)
  if (!m) return null
  switch (m[1]) {
    case 'SWORD':
    case 'DAGGER':
      return 'sword'
    case 'BLADE':
    case 'AXE':
      return 'blade'
    case 'SPEAR':
    case 'STAFF':
    case 'WAND':
    case 'DARKSTAFF':
      return 'spear'
    case 'TBLADE':
    case 'TSWORD':
    case 'TSTAFF':
      return 'glaive'
    case 'BOW':
    case 'CROSSBOW':
      return 'bow'
    case 'SHIELD':
      return 'shield'
    default:
      return null
  }
}

/** The kind of a rare item from its slot and the wearer's weapon family (CharacterActor.family). */
export function rareKindOf(slot: 'weapon' | 'shield' | undefined, family: string | null | undefined): RareKind {
  if (slot === 'shield') return 'shield'
  switch (family) {
    case 'blade':
    case 'spear':
    case 'glaive':
    case 'bow':
      return family
    default:
      return 'sword'
  }
}

/** How a swing draws: 'arc' follows the blade (a ribbon between base and tip), 'thrust' shoots from the tip along
 * the stab, 'sweep' is an arc swept wide past the tip (long weapons), 'shot' draws nothing on the bow itself (the
 * arrow carries it), 'none' (a shield). */
export type SwingShape = 'arc' | 'thrust' | 'sweep' | 'shot' | 'none'

export interface RareProfile {
  readonly swing: SwingShape
  /** The ribbon's reach past the blade (× the blade length; a sweep throws it out wider). */
  readonly reach: number
  /** The ribbon's width as a share of the blade (1: base to tip). */
  readonly width: number
  /** How long the ribbon lingers after the blade has passed (s). */
  readonly linger: number
  /** Aura motes per weapon (× the tier's), e.g. a long glaive carries more. */
  readonly motes: number
  /** Where the tier's emblem shows: on a shield's face, else nowhere (no emblems behind the wearer since round 3). */
  readonly emblem: 'shield' | 'none'
}

const BASE: Readonly<Record<RareKind, RareProfile>> = {
  sword: { swing: 'arc', reach: 1.15, width: 1, linger: 0.35, motes: 1, emblem: 'none' },
  blade: { swing: 'arc', reach: 1.3, width: 1, linger: 0.4, motes: 1, emblem: 'none' },
  spear: { swing: 'thrust', reach: 2.2, width: 0.18, linger: 0.45, motes: 1.2, emblem: 'none' },
  glaive: { swing: 'sweep', reach: 1.6, width: 0.55, linger: 0.5, motes: 1.4, emblem: 'none' },
  bow: { swing: 'shot', reach: 0, width: 0, linger: 0.6, motes: 1.1, emblem: 'none' },
  shield: { swing: 'none', reach: 0, width: 0, linger: 0, motes: 0.8, emblem: 'shield' },
}

/** Per tier: each a clearly bigger step (Star < Moon < Sun) in reach, linger and presence. */
const TIER_SCALE: Readonly<Record<RarityTier, { reach: number; linger: number; motes: number }>> = {
  star: { reach: 1, linger: 1, motes: 1 },
  moon: { reach: 1.12, linger: 1.5, motes: 1.15 },
  sun: { reach: 1.25, linger: 1.3, motes: 1.35 },
}

export function rareProfile(tier: RarityTier, kind: RareKind): RareProfile {
  const b = BASE[kind]
  const s = TIER_SCALE[tier]
  return { ...b, reach: b.reach * s.reach, linger: b.linger * s.linger, motes: b.motes * s.motes }
}
