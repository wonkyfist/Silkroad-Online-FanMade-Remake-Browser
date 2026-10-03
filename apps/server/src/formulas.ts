import type { HitOutcome, ItemDef, ItemStack, MobDef, MobVariant, PerPlusStat, Range, WeaponType } from '@sro/shared'

/**
 * Every combat and growth number the server uses, in one place. Sources:
 *  - research report §4.5 (decompiled vSRO server, tanisman/DarkEmu emulators): max HP/MP, the hit-balance
 *    roll, the damage pipeline, the level-difference bonus, the 0..1.2 balance ratio;
 *  - client textdata via mobs.json/items.json: attack ranges, defences, hit/parry/block/critical rates;
 *  - SERVER RULES (marked "rule"): values the client data and the report do not give (outright miss chance,
 *    player base stats, regeneration, variant multipliers, basic-attack cadence until skills.json exists).
 *    They are tuning knobs, not retail facts.
 */

export type Rng = () => number

/** Everything the damage pipeline needs about one side of a fight. */
export interface CombatStats {
  level: number
  physAttack: Range
  magAttack: Range
  physDefence: number
  magDefence: number
  /** Percent. */
  physAbsorb: number
  magAbsorb: number
  hitRate: number
  parryRate: number
  /** Percent chance to block (shields, some mobs). */
  blockRate: number
  /** Percent chance to land a critical hit. */
  critRate: number
  /** §4.5 balance ratio stat / (4 lvl + 28), clamped to 0..1.2: STR for physical damage; mobs use 1. */
  balance: number
  /**
   * §4.5 magical balance, INT / (4 lvl + 28) clamped to 0..1.2 (research report §4.5 "Physical / magical balance"): it
   * scales magical damage (imbues, force attacks). Absent = `balance` (mobs, older callers).
   */
  magBalance?: number
  /** Skill mods (`dru`, `spda`; docs/SKILLS.md §10.1): outgoing physical / magical damage +percent. Absent = 0. */
  physDamagePct?: number
  magDamagePct?: number
}

/** One hit of a skill (or basic attack) beyond the plain percent (docs/SKILLS.md §4, §10.1). */
export interface HitSpec {
  /** Skill percent of the attack power ('att' arg 2, or the basic attack's percent). */
  pct: number
  /** 'att' flat damage [min, max], added to the rolled attack power before defence. */
  flat?: Range
  /** Magical (force, imbue): magic attack against magic defence/absorb. */
  magic?: boolean
  /** Extra critical chance, percent ('cr'). */
  critBonus?: number
  /** Final multiplier (secondary-target reduction, down-attack 'da', ...). */
  mul?: number
}

// ---- growth -------------------------------------------------------------------------------------------

/** §4.5 (tanisman, DarkEmu; 20 STR at level 1 = 200 HP): 1.02^(lvl-1) x STR x 10. */
export function maxHpFor(level: number, str: number): number {
  return Math.max(1, Math.floor(Math.pow(1.02, level - 1) * str * 10))
}

/** Same rule with INT. */
export function maxMpFor(level: number, int: number): number {
  return Math.max(1, Math.floor(Math.pow(1.02, level - 1) * int * 10))
}

/** §4.5 decomp: stat / (4 lvl + 28), clamped to 0..1.2. */
export function balanceRatio(level: number, stat: number): number {
  return Math.min(1.2, Math.max(0, stat / (4 * level + 28)))
}

/** §4.5 decomp LevelDiffBonus: +3% per level the attacker is above the target, at most 30%. */
export function levelDiffBonus(attackerLevel: number, targetLevel: number): number {
  return Math.min(0.3, Math.max(0, (attackerLevel - targetLevel) * 0.03))
}

// ---- player derived stats (rule: base values; equipment from items.json) -----------------------------------

/** Rule: bare-hand damage range, reach (m) and base rates of a player. */
export const PLAYER_BASE = {
  fist: [3, 5] as Range,
  fistRange: 1,
  /** Attack gained per point of STR (physical) / INT (magical), added to both ends of the range. */
  attackPerStat: 0.2,
  /** Defence gained per point of STR (physical) / INT (magical). */
  defencePerStat: 0.15,
  /** Hit and parry rate: base + perLevel x level. */
  rateBase: 20,
  ratePerLevel: 2,
  critRate: 2,
  /** Body radius, metres (vSRO player BCRadius is about 5 units). */
  radius: 0.5,
} as const

/** Rule: basic attack per weapon family until skills.json provides the weapon basic-attack skills (§5.6). */
export const BASIC_ATTACK: Record<WeaponType | 'fist', { hits: number; pct: number; intervalMs: number }> = {
  fist: { hits: 1, pct: 100, intervalMs: 1000 },
  sword: { hits: 2, pct: 60, intervalMs: 1200 },
  blade: { hits: 2, pct: 60, intervalMs: 1200 },
  spear: { hits: 1, pct: 100, intervalMs: 1300 },
  glaive: { hits: 1, pct: 100, intervalMs: 1300 },
  bow: { hits: 1, pct: 100, intervalMs: 1300 },
}

const mid = (r: Range | undefined): number => (r ? (r[0] + r[1]) / 2 : 0)

/** A worn stack is broken at durability 0 (absent / null = full; docs/SYSTEMS_COMBAT.md §3.2). */
export function isBroken(stack: { durability?: number | null }): boolean {
  return stack.durability === 0
}

/** What +N adds to one stat of a worn item: ItemDef.perPlus[k] x plus (docs/SYSTEMS_COMBAT.md §4.2). */
export function plusBonus(def: ItemDef, stack: ItemStack, k: PerPlusStat): number {
  const plus = stack.plus ?? 0
  return plus > 0 ? (def.perPlus?.[k] ?? 0) * plus : 0
}

/**
 * Derived combat stats of a player from level, STR/INT and worn items (the item roll is the def's range).
 * Wave 8: a worn item at +N adds perPlus x N to each of its stats (attacks: both ends of the range); a broken worn item
 * (durability 0) gives no stats and no perPlus. A broken weapon still decides the reach and the weapon family.
 */
export function playerCombatStats(level: number, str: number, int: number, worn: { def: ItemDef; stack: ItemStack }[]): CombatStats & { range: number; weapon: WeaponType | 'fist' } {
  const wielded = worn.find((w) => w.def.category === 'weapon')
  const weapon = wielded?.def
  const armed = wielded && !isBroken(wielded.stack) ? wielded : undefined
  const phys: Range = armed?.def.stats?.physAttack ? [...armed.def.stats.physAttack] : [...PLAYER_BASE.fist]
  const mag: Range = armed?.def.stats?.magAttack ? [...armed.def.stats.magAttack] : [0, 0]
  if (armed) {
    const pa = plusBonus(armed.def, armed.stack, 'physAttack')
    const ma = plusBonus(armed.def, armed.stack, 'magAttack')
    phys[0] += pa
    phys[1] += pa
    mag[0] += ma
    mag[1] += ma
  }
  let physDefence = 0
  let magDefence = 0
  let parry = 0
  let block = 0
  let physAbsorb = 0
  let magAbsorb = 0
  let hit = 0
  let crit = 0
  for (const { def, stack } of worn) {
    const s = def.stats
    if (!s || isBroken(stack)) continue
    physDefence += mid(s.physDefence) + plusBonus(def, stack, 'physDefence')
    magDefence += mid(s.magDefence) + plusBonus(def, stack, 'magDefence')
    parry += mid(s.parryRate) + plusBonus(def, stack, 'parryRate')
    block += mid(s.blockRate)
    physAbsorb += mid(s.physAbsorb) + plusBonus(def, stack, 'physAbsorb')
    magAbsorb += mid(s.magAbsorb) + plusBonus(def, stack, 'magAbsorb')
    hit += mid(s.hitRate) + plusBonus(def, stack, 'hitRate')
    crit += mid(s.critRate)
  }
  const rate = PLAYER_BASE.rateBase + PLAYER_BASE.ratePerLevel * level
  const sa = Math.round(str * PLAYER_BASE.attackPerStat)
  const ia = Math.round(int * PLAYER_BASE.attackPerStat)
  return {
    level,
    physAttack: [Math.round(phys[0]) + sa, Math.round(phys[1]) + sa],
    magAttack: [Math.round(mag[0]) + ia, Math.round(mag[1]) + ia],
    physDefence: Math.round(physDefence + str * PLAYER_BASE.defencePerStat),
    magDefence: Math.round(magDefence + int * PLAYER_BASE.defencePerStat),
    physAbsorb: Math.round(physAbsorb),
    magAbsorb: Math.round(magAbsorb),
    hitRate: Math.round(rate + hit),
    parryRate: Math.round(rate + parry),
    blockRate: Math.round(block),
    critRate: Math.round(PLAYER_BASE.critRate + crit),
    balance: balanceRatio(level, str),
    magBalance: balanceRatio(level, int),
    range: weapon?.range ?? PLAYER_BASE.fistRange,
    weapon: weapon?.weaponType ?? 'fist',
  }
}

// ---- mobs -----------------------------------------------------------------------------------------------

/** Rule (not in client data): multipliers of a spawn variant. */
export const VARIANT_RULES: Record<MobVariant, { hp: number; exp: number; attack: number }> = {
  normal: { hp: 1, exp: 1, attack: 1 },
  champion: { hp: 2, exp: 2, attack: 1.2 },
  giant: { hp: 20, exp: 10, attack: 2 },
  titan: { hp: 30, exp: 15, attack: 2.5 },
  elite: { hp: 10, exp: 5, attack: 1.5 },
  unique: { hp: 1, exp: 1, attack: 1 },
  party: { hp: 10, exp: 5, attack: 1.5 },
}

/**
 * Rule: a mob with no physical attack but a magical one (Tomb Stone Ghost, Tomb Stone: their only attack is a force
 * skill, mobs.json `physAttack` [0, 0]) swings with its magic attack against the target's magic defence. Rolled as a
 * physical hit, its 0 attack power always came out at the 1-damage floor.
 */
export function attacksMagically(c: Pick<CombatStats, 'physAttack' | 'magAttack'>): boolean {
  return c.physAttack[1] <= 0 && c.magAttack[1] > 0
}

export function mobCombatStats(def: MobDef, variant: MobVariant, attackMul = 1): CombatStats {
  const a = VARIANT_RULES[variant].attack
  // attackMul: a quest encounter's MobTuning.attackMul, applied after the variant (same rounding as before I8).
  const at = (v: number) => (attackMul === 1 ? Math.round(v * a) : Math.round(Math.round(v * a) * attackMul))
  return {
    level: def.level,
    physAttack: [at(def.physAttack[0]), at(def.physAttack[1])],
    magAttack: [at(def.magAttack[0]), at(def.magAttack[1])],
    physDefence: def.physDefence,
    magDefence: def.magDefence,
    physAbsorb: def.physAbsorb ?? 0,
    magAbsorb: def.magAbsorb ?? 0,
    hitRate: def.hitRate,
    parryRate: def.parryRate,
    blockRate: def.blockRate ?? 0,
    critRate: def.critRate ?? 0,
    balance: 1,
  }
}

// ---- one hit --------------------------------------------------------------------------------------------

/** Rule: outright miss chance when hit rate equals parry rate; scaled by parry/hit, clamped. */
export const MISS_AT_PARITY = 0.08
export const MISS_MIN = 0.01
export const MISS_MAX = 0.5
/** Rule: extra miss chance per level the target is above the attacker. */
export const MISS_PER_LEVEL_ABOVE = 0.02
/** Rule: blocks are capped at 50%. */
export const BLOCK_MAX = 0.5
export const CRIT_MAX = 0.5
/** §4.5: critical damage x (2.0 + param); no param yet. */
export const CRIT_MULTIPLIER = 2
/** §4.5 step 11: 3-byte damage field. */
export const DAMAGE_CAP = 16_777_215

export function missChance(att: CombatStats, def: CombatStats): number {
  const ratio = Math.max(0, def.parryRate) / Math.max(1, att.hitRate)
  const above = Math.max(0, def.level - att.level) * MISS_PER_LEVEL_ABOVE
  return Math.min(MISS_MAX, Math.max(MISS_MIN, MISS_AT_PARITY * ratio + above))
}

/**
 * §4.5 hit balance (decomp CalculateHitBalance): centre = clamp(((HR/ER) x 0.5 + LevelDiffBonus) x 100, 10, 90),
 * then the minimum of 3 uniform [0, 100] rolls is added or subtracted on a coin flip, clamped to 0..100.
 * Returns the roll position in 0..1 inside the attack range.
 */
export function hitBalance(att: CombatStats, def: CombatStats, rng: Rng): number {
  const centre = Math.min(90, Math.max(10, ((att.hitRate / Math.max(1, def.parryRate)) * 0.5 + levelDiffBonus(att.level, def.level)) * 100))
  const spread = Math.min(rng() * 100, rng() * 100, rng() * 100)
  const pos = rng() < 0.5 ? centre - spread : centre + spread
  return Math.min(100, Math.max(0, pos)) / 100
}

/**
 * §4.5 damage pipeline (decomp Formulae.cpp), the steps that apply without skills/buffs:
 *  1 AP rolled inside the attack range at the hit-balance position;
 *  2 AP / (1 + absorb% / 100) - defence, floored at 0;
 *  3 x skill percent (basic attack per hit);
 *  6 x CRIT_MULTIPLIER on a critical;
 *  7 x (1 + LevelDiffBonus) when the attacker is higher;
 *  8 x balance ratio (players: STR balance for physical, INT balance for magical damage; mobs 1);
 *  9 below 5% of the raw AP: a random 1..10% of the raw AP instead (a hit always does something);
 *  11 clamp to 1..DAMAGE_CAP.
 */
export function damageRoll(att: CombatStats, def: CombatStats, pct: number, crit: boolean, rng: Rng, magic = false, extra: { flat?: Range; mul?: number } = {}): number {
  const range = magic ? att.magAttack : att.physAttack
  let ap = range[0] + (range[1] - range[0]) * hitBalance(att, def, rng)
  // Skills: the 'att' flat damage joins the attack power (so low-level skills still hurt through armour).
  if (extra.flat) ap += extra.flat[0] + (extra.flat[1] - extra.flat[0]) * rng()
  const absorb = magic ? def.magAbsorb : def.physAbsorb
  const defence = magic ? def.magDefence : def.physDefence
  let dmg = Math.max(0, ap / (1 + absorb / 100) - defence)
  dmg *= pct / 100
  if (crit) dmg *= CRIT_MULTIPLIER
  dmg *= 1 + levelDiffBonus(att.level, def.level)
  dmg *= magic ? (att.magBalance ?? att.balance) : att.balance
  // Buffs and passives (docs/SKILLS.md §10.1 mods step): damage +%.
  dmg *= 1 + ((magic ? att.magDamagePct : att.physDamagePct) ?? 0) / 100
  dmg *= extra.mul ?? 1
  if (dmg < ap * 0.05) dmg = ap * (0.01 + rng() * 0.09) * (extra.mul ?? 1)
  return Math.min(DAMAGE_CAP, Math.max(1, Math.round(dmg)))
}

/** One hit: miss (parry), block, crit or plain hit, and its damage. */
export function rollHit(att: CombatStats, def: CombatStats, pct: number, rng: Rng = Math.random): { outcome: HitOutcome; damage: number } {
  return rollSkillHit(att, def, { pct }, rng)
}

/**
 * One hit of a skill or basic attack (docs/SKILLS.md §10.1): the same miss/block/crit rolls as rollHit, then the
 * damage pipeline with the skill's flat damage, magic flag, critical bonus ('cr') and final multiplier.
 */
export function rollSkillHit(att: CombatStats, def: CombatStats, spec: HitSpec, rng: Rng = Math.random): { outcome: HitOutcome; damage: number } {
  if (rng() < missChance(att, def)) return { outcome: 'miss', damage: 0 }
  if (rng() < Math.min(BLOCK_MAX, Math.max(0, def.blockRate / 100))) return { outcome: 'block', damage: 0 }
  const crit = rng() < Math.min(CRIT_MAX, Math.max(0, (att.critRate + (spec.critBonus ?? 0)) / 100))
  return { outcome: crit ? 'crit' : 'hit', damage: damageRoll(att, def, spec.pct, crit, rng, spec.magic ?? false, { flat: spec.flat, mul: spec.mul }) }
}

/**
 * The magical component an imbue adds to a landed hit (docs/SKILLS.md §10.1 "Imbues"): its 'att' percent and flat
 * damage from the magic attack against the magic defence. No miss/block/crit roll of its own (it rides the hit).
 */
export function imbueDamage(att: CombatStats, def: CombatStats, pct: number, flat: Range, rng: Rng, mul = 1): number {
  return damageRoll(att, def, pct, false, rng, true, { flat, mul })
}

/** Secondary targets of an area skill take `reductionPct` percent less (docs/WAVE_PLAN.md §8 question 3). */
export function reductionMul(reductionPct: number): number {
  return Math.max(0, 1 - Math.min(100, Math.max(0, reductionPct)) / 100)
}

// ---- regeneration and timers (rules) ------------------------------------------------------------------------

export const REGEN = {
  /** No damage dealt or taken for this long = out of combat. */
  outOfCombatMs: 5000,
  /** Regeneration pulse. */
  intervalMs: 2000,
  /** Share of max HP/MP restored per pulse, players and resting mobs. */
  playerPct: 0.03,
  mobPct: 0.05,
} as const

/**
 * Rule: cooldown of an HP/MP item whose ItemDef.use has none (the client data has no potion cooldown; the
 * third-party port uses 1000 ms per group). Without it potions could be chained at the request rate limit.
 */
export const POTION_COOLDOWN_MS = 1000

/** A dead mob stays as a corpse this long before it despawns. */
export const CORPSE_MS = 3000
/**
 * A mob that rides something (MobDef.ride: Tiger Girl on her Blue Tiger) keeps its corpse this long, whoever spawned it
 * (the field unique, the JG_025 encounter, a GM spawn): the client draws every such mob as the ridden composite, whose
 * DIE1 lasts 5.5 s (docs/UNIQUES.md §2.3 step 5, D-U21; H11-CU-1). The uniques module may still set its own corpseSec.
 */
export const RIDDEN_CORPSE_MS = 8000
