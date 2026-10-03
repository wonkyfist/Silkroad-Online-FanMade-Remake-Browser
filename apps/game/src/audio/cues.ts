/**
 * Which file a sound event plays (docs/SOUND.md §5.7 track table, §2.6 hits, §5.9 equip), from the exported
 * SoundIndex. Pure: every function takes the index and returns file ids (SoundIndex.files keys) or null.
 */
import { STEP_FILE_RE, type ClipTrack, type HitClass, type HitSet, type ItemDef, type SoundIndex, type SoundSurface, type StarterWeapon } from '@sro/shared'

export type Rng = () => number

/** One element at random (null for an empty or missing list). */
export function pick<T>(list: readonly T[] | undefined, rng: Rng = Math.random): T | null {
  if (!list?.length) return null
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!
}

/**
 * Skill-row codes on the wire (`SKILL_CH_SWORD_SMASH_A_01`) name a level of a group; effectsound keys by the group
 * (`SKILL_CH_SWORD_SMASH_A`, WAVE_PLAN decision 11). Mob skills (MSKILL_*) are used as they are.
 */
export function skillGroupOf(code: string | undefined | null): string | null {
  if (!code) return null
  if (code.startsWith('MSKILL_')) return code
  return code.replace(/_\d+$/, '')
}

/** effectsound families of the basic attacks (SKILL_CH_<FAMILY>_BASE) and the generic hit rows (hits.<KIND>). */
const WEAPON_BASE: Record<StarterWeapon, string> = { sword: 'SWORD', blade: 'SWORD', spear: 'SPEAR', glaive: 'SPEAR', bow: 'BOW' }
const WEAPON_HITS: Record<StarterWeapon, string> = { sword: 'SWORD', blade: 'BLADE', spear: 'SPEAR', glaive: 'SPEAR', bow: 'BOW' }

/** Footstep file for a step track on `surface` (only the neutral player steps are swapped; mob walks are kept). */
export function stepFile(index: SoundIndex, track: ClipTrack, surface: SoundSurface, rng: Rng = Math.random): string | null {
  if (!STEP_FILE_RE.test(track.file)) return track.file
  const run = track.handle === 'step_run' || /^player\/mvrun/.test(track.file)
  const table = run ? index.steps.run : index.steps.walk
  return pick(table[surface], rng) ?? pick(table.Dirt, rng) ?? track.file
}

export interface TrackContext {
  /** Surface under the entity (asked only for step tracks). */
  surface(): SoundSurface
  /** Skill group the entity is performing (SKILL_CH_SWORD_SMASH_A), for the swing override. */
  skill: string | null
  /** SOUND §2.7 example 10: the effectsound skill row replaces the clip's own swing file (one constant to A/B). */
  overrideSwing: boolean
  rng: Rng
}

/** SKILL_ROWS_OVERRIDE_CLIP (docs/SOUND.md §2.7 example 10). */
export const SKILL_ROWS_OVERRIDE_CLIP = true

/** The file a fired clip track plays (§5.7 table); null = nothing. */
export function trackFile(index: SoundIndex, track: ClipTrack, ctx: TrackContext): string | null {
  switch (track.handle) {
    case 'step_walk':
    case 'step_run':
      return stepFile(index, track, ctx.surface(), ctx.rng)
    case 'swing': {
      if (ctx.overrideSwing && ctx.skill) {
        const rows = index.skills[ctx.skill]?.swing?.[track.raw.toLowerCase()]
        const f = pick(rows, ctx.rng)
        if (f) return f
      }
      return track.file
    }
    default:
      return track.file
  }
}

/** Victim size class for SND_DMG rows (§2.6: no data column; big mobs sound heavier). */
export function hitClassOf(victim: { kind: string; radius?: number; rarity?: string }): HitClass {
  if (victim.kind === 'mob' && ((victim.radius ?? 0) >= 1.2 || victim.rarity === 'giant' || victim.rarity === 'titan')) return 'b'
  return 'n'
}

export interface HitQuery {
  /** combat.skill (a skill row or MSKILL code), when set. */
  skill?: string | null
  attacker: { kind: string; model: string; family?: StarterWeapon | null; clip?: string | null } | null
  victim: { kind: string; model: string; radius?: number; rarity?: string }
  outcome: 'hit' | 'crit' | 'miss' | 'block'
  rng?: Rng
}

export interface HitSound {
  /** Files to play together at the victim (the impact, plus the crit layer). */
  files: string[]
  gain: number
}

function fromHitSet(set: HitSet, strong: boolean, cls: HitClass): string | null {
  const side = strong ? set.strong : set.weak
  return side[cls] ?? side.n ?? side.b ?? side.a ?? null
}

/** The mob attack a clip plays: ATTACKn -> the n-th of the mob's attack rows (in code order). */
export function mobAttackOf(index: SoundIndex, mob: string, clip: string | null | undefined): string | null {
  const attacks = index.mobs[mob]?.attacks
  if (!attacks) return null
  const keys = Object.keys(attacks).sort()
  if (!keys.length) return null
  const m = clip ? /^ATTACK(\d)/.exec(clip) : null
  const i = m ? Number(m[1]) - 1 : 0
  return keys[Math.min(keys.length - 1, Math.max(0, i))]!
}

/**
 * Impact sound of one hit, played on the victim (§2.6 lookup order): the skill group's SND_DMG, else the weapon
 * family's basic-attack row, else the generic weapon row; mob attacks use their own rows, else PUNCH. A crit adds
 * `hit.crit`; a block plays the block cue; a miss plays the victim player's dodge voice.
 */
export function hitSound(index: SoundIndex, q: HitQuery): HitSound | null {
  const rng = q.rng ?? Math.random
  const a = q.attacker
  if (q.outcome === 'miss') {
    const f = q.victim.kind === 'player' ? pick(index.voices[q.victim.model]?.avoid, rng) : null
    return f ? { files: [f], gain: index.voices[q.victim.model]?.gain ?? 1 } : null
  }
  if (q.outcome === 'block') {
    const cue = a?.family === 'bow' && index.cues['block.bow'] ? index.cues['block.bow'] : index.cues['block.normal']
    const f = pick(cue?.files, rng)
    return f && cue ? { files: [f], gain: cue.gain } : null
  }
  const strong = q.outcome === 'crit'
  const cls = hitClassOf(q.victim)
  const group = skillGroupOf(q.skill)
  const fromDmg = (dmg: HitSet | string[] | undefined, gain = 1): { file: string; gain: number } | null => {
    if (!dmg) return null
    const file = Array.isArray(dmg) ? pick(dmg, rng) : fromHitSet(dmg, strong, cls)
    return file ? { file, gain: Array.isArray(dmg) ? gain : dmg.gain } : null
  }
  let impact: { file: string; gain: number } | null
  if (a?.kind === 'mob') {
    const mob = index.mobs[a.model]
    const skill = group?.startsWith('MSKILL_') ? group : mobAttackOf(index, a.model, a.clip)
    impact = fromDmg(skill ? mob?.attacks[skill]?.dmg : undefined, mob?.gain ?? 1) ?? fromDmg(index.hits.PUNCH)
  } else {
    const family = a?.family ?? null
    impact = (group ? fromDmg(index.skills[group]?.dmg) : null) ??
      (family ? fromDmg(index.skills[`SKILL_CH_${WEAPON_BASE[family]}_BASE`]?.dmg) ?? fromDmg(index.hits[WEAPON_HITS[family]]) : null) ??
      fromDmg(index.hits.PUNCH)
  }
  const gain = impact?.gain ?? 1
  const files: string[] = impact ? [impact.file] : []
  if (strong) {
    const crit = pick(index.cues['hit.crit']?.files, rng)
    if (crit) files.push(crit)
  }
  return files.length ? { files, gain } : null
}

/** effectsound ITEM SND_EQUIP kind of an item (`item.equip.<KIND>` cue), §5.9. */
export function equipKind(def: Pick<ItemDef, 'category' | 'slot' | 'weaponType' | 'armorType'> | undefined): string {
  if (!def) return 'METAL'
  switch (def.category) {
    case 'weapon':
      return def.weaponType ? ({ sword: 'SWORD', blade: 'BLADE', spear: 'SPEAR', glaive: 'TBLADE', bow: 'BOW' } as const)[def.weaponType] : 'METAL'
    case 'shield':
      return 'SHIELD'
    case 'ammo':
      return 'QUIVER'
    case 'accessory':
      return def.slot === 'earring' ? 'EARRING' : def.slot === 'necklace' ? 'NECKLACE' : 'RING'
    case 'armor': {
      const cloth = def.armorType === 'garment'
      switch (def.slot) {
        case 'head': return cloth ? 'CAP' : 'HELM'
        case 'chest': return cloth ? 'ROBE' : 'BREASTPLATE'
        case 'legs': return cloth ? 'ROBE' : 'CUISSE'
        case 'shoulders': return cloth ? 'ROBE' : 'PAULDRONS'
        case 'hands': return cloth ? 'GLOVES' : 'GAUNTLET'
        case 'feet': return cloth ? 'SHOES' : 'GREAVE'
        default: return 'METAL'
      }
    }
    default:
      return 'METAL'
  }
}
