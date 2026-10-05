/**
 * Which file a sound event plays (docs/SOUND.md §5.7 track table, §2.6 hits, §5.9 equip), from the exported
 * SoundIndex. Pure: every function takes the index and returns file ids (SoundIndex.files keys) or null.
 */
import { STEP_FILE_RE, type ClientMessage, type ClipTrack, type EquipSlot, type HitClass, type HitSet, type ItemDef, type SoundIndex, type SoundSurface, type StarterWeapon } from '@sro/shared'

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

/** A basic attack's group (SKILL_CH_<FAMILY>_BASE, fists SKILL_PUNCH), or no skill at all. */
export function isBasicGroup(group: string | null | undefined): boolean {
  return !group || /_BASE$/.test(group) || group === 'SKILL_PUNCH'
}

/** Berserk swing cue of a weapon family (effectsound PLAYER SND_SWING3 HWAN <weapon>; fists: PUNCH). */
export function hwanSwingCue(family: StarterWeapon | null | undefined): string {
  return `swing.hwan.${family ? WEAPON_HITS[family] : 'PUNCH'}`
}

/** A basic swing track (snd_swing1, snd_swing2, ...): what Berserk replaces with its own swing. */
const BASIC_SWING_RAW = /^snd_swing\d$/i

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
  /** Berserk: the weapon's SND_SWING3 HWAN files, which replace the basic swings (§10.3); null/empty outside it. */
  hwanSwing?: readonly string[] | null
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
      if (ctx.hwanSwing?.length && isBasicGroup(ctx.skill) && BASIC_SWING_RAW.test(track.raw)) return pick(ctx.hwanSwing, ctx.rng) ?? track.file
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
  /** The imbue group the attacker carries (SKILL_CH_COLD_GIGONGTA_A): its SND_DMG joins every landed hit (§10.3). */
  imbue?: string | null
  /** The attacker was in Berserk (CombatHit.hwan): HWAN hit and crit rows (§10.3). */
  hwan?: boolean
  /** Skill groups the victim carries: a shield buff's SND_DDMG (Ice Wall's csk_cold_hosin_hit) joins the hit. */
  guards?: readonly string[]
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
 * `hit.crit`; a block plays the block cue; a miss plays the victim player's dodge voice. Layers of §10.3 on a landed
 * hit: a Berserk basic attack plays `hit.hwan` (crit: `hit.hwanCrit`), an imbued attacker adds the imbue's SND_DMG,
 * a victim under a shield buff with a SND_DDMG row adds that.
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
    const hwan = q.hwan && isBasicGroup(group) ? index.cues['hit.hwan'] : undefined
    const hwanFile = pick(hwan?.files, rng)
    impact = (hwanFile ? { file: hwanFile, gain: hwan!.gain } : null) ??
      (group ? fromDmg(index.skills[group]?.dmg) : null) ??
      (family ? fromDmg(index.skills[`SKILL_CH_${WEAPON_BASE[family]}_BASE`]?.dmg) ?? fromDmg(index.hits[WEAPON_HITS[family]]) : null) ??
      fromDmg(index.hits.PUNCH)
  }
  const gain = impact?.gain ?? 1
  const files: string[] = impact ? [impact.file] : []
  if (strong) {
    const crit = (q.hwan ? pick(index.cues['hit.hwanCrit']?.files, rng) : null) ?? pick(index.cues['hit.crit']?.files, rng)
    if (crit) files.push(crit)
  }
  if (q.imbue && q.imbue !== group) {
    const layer = fromDmg(index.skills[q.imbue]?.dmg)
    if (layer && !files.includes(layer.file)) files.push(layer.file)
  }
  for (const g of q.guards ?? []) {
    const ddmg = pick(index.skills[g]?.swing?.snd_ddmg, rng)
    if (ddmg && !files.includes(ddmg)) {
      files.push(ddmg)
      break
    }
  }
  return files.length ? { files, gain } : null
}

/**
 * The item an own inventory request puts into a slot (bag move or split, equip, unequip), or null: its SND_EQUIP
 * sound plays when the server accepts the request (docs/SOUND.md §10.3). Read before sending, while the item is
 * still where the request takes it from.
 */
export function placedItem(
  msg: ClientMessage,
  inv: { item(slot: number): { code: string } | null; equipped(slot: EquipSlot): { code: string } | null },
): string | null {
  switch (msg.t) {
    case 'itemMove':
    case 'itemSplit':
      return inv.item(msg.from)?.code ?? null
    case 'itemEquip':
      return inv.item(msg.bag)?.code ?? null
    case 'itemUnequip':
      return inv.equipped(msg.slot)?.code ?? null
    default:
      return null
  }
}

/**
 * The cue an item drop plays where it lands (effectsound ITEM SND_DROPITEM): gold `item.dropGold`, a Seal of Star
 * (`_RARE`) item `item.dropRare`, elixirs and alchemy materials `item.dropElixir`. Other items have no row (the BOX and
 * BAG rows are commented out in 1.188), so they drop silently: null.
 */
export function dropCue(code: string, def: Pick<ItemDef, 'category'> | undefined): string | null {
  if (/^ITEM_ETC_GOLD_/.test(code)) return 'item.dropGold'
  if (/_RARE(?:_|$)/.test(code)) return 'item.dropRare'
  if (def?.category === 'alchemy') return 'item.dropElixir'
  return null
}

/**
 * effectsound ITEM SND_EQUIP kind of an item (`item.equip.<KIND>` cue), §5.9. The table also has kinds for items
 * nobody wears (POTION, SCROLL, HERB, TABLET, MOBPIECE): SND_EQUIP is the sound of an item put into a slot, so
 * consumables have one too (§10.3: potions POTION, cure pills HERB, scrolls SCROLL, arrows QUIVER, alchemy
 * elixirs and powders POTION, quest items MOBPIECE [our rule: no row names them]).
 */
export function equipKind(def: Pick<ItemDef, 'category' | 'slot' | 'weaponType' | 'armorType'> | undefined): string {
  if (!def) return 'METAL'
  switch (def.category) {
    case 'potion':
    case 'alchemy':
      return 'POTION'
    case 'pill':
      return 'HERB'
    case 'scroll':
      return 'SCROLL'
    case 'quest':
      return 'MOBPIECE'
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
