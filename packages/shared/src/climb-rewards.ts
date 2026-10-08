/**
 * The Climb's rewards (docs/CLIMB.md §4.2, §5.1, §7.3; build plan §20 layer L7): titles, set bonuses and skill Arts.
 * Pure data and rules, shared by the server (climb/rewards.ts, the skill engine) and the client (tooltips, the
 * character and skill windows). Like the roster, the data lives here and not in `content/climb/*.json`: the client
 * cannot read `content/` and must show the same numbers.
 */
import type { ItemDef, SkillDef } from './content.ts'
import type { MasteryCode } from './protocol.ts'

// ---- titles (§7.3) -------------------------------------------------------------------------------------------------

/** A Climb achievement: its title code (a pilot_honors code, shown as EntityState.honor) and how it is earned. */
export interface ClimbAchievement {
  /** The title code (a-z, 0-9, _; the client names it `pilot.honor.<code>`). */
  code: string
  name: string
  /** What earns it (the character window's line). */
  how: string
  /** kill: `n` kills of `mobs` (credited like quest kills); level: reach `level`; deathless: reach the cap with no penalised death from 15; pioneer: migration 22. */
  rule: { kind: 'kill'; mobs: readonly string[]; n: number } | { kind: 'level'; level: number } | { kind: 'deathless' } | { kind: 'pioneer' }
}

export const CLIMB_ACHIEVEMENTS: readonly ClimbAchievement[] = [
  { code: 'pioneer', name: 'Pioneer', how: 'A hero of Jangan before the Climb.', rule: { kind: 'pioneer' } },
  { code: 'climber', name: 'Climber', how: 'Reach level 25.', rule: { kind: 'level', level: 25 } },
  { code: 'deathless', name: 'Deathless', how: 'Climb from 15 to 25 without a death that cost EXP.', rule: { kind: 'deathless' } },
  { code: 'scar_breaker', name: 'Scar-Breaker', how: 'Defeat Old Scar, the Weasel King, 10 times.', rule: { kind: 'kill', mobs: ['MOB_CL_OLDSCAR_6'], n: 10 } },
  { code: 'magistrate_breaker', name: 'Magistrate-Breaker', how: 'Defeat the Drowned Magistrate 10 times.', rule: { kind: 'kill', mobs: ['MOB_CL_MAGISTRATE_10'], n: 10 } },
  { code: 'chief_breaker', name: 'Chief-Breaker', how: 'Defeat Gwangmu the Robber Chief 10 times.', rule: { kind: 'kill', mobs: ['MOB_CL_GWANGMU_14'], n: 10 } },
  { code: 'warden_breaker', name: 'Warden-Breaker', how: 'Defeat the Gate Warden 10 times.', rule: { kind: 'kill', mobs: ['MOB_CL_GATEWARDEN_16'], n: 10 } },
  { code: 'wind_breaker', name: 'Wind-Breaker', how: 'Defeat Heukpung, the Black Wind, 10 times.', rule: { kind: 'kill', mobs: ['MOB_CL_HEUKPUNG_19'], n: 10 } },
  { code: 'warlord_breaker', name: 'Warlord-Breaker', how: 'Defeat Mo-Dun, the Hyungno Warlord, 10 times.', rule: { kind: 'kill', mobs: ['MOB_CL_MODUN_23'], n: 10 } },
  { code: 'canyon_breaker', name: 'Canyon-Breaker', how: 'Defeat Hyeongcheon, the Canyon Lord, 10 times.', rule: { kind: 'kill', mobs: ['MOB_CL_HYEONGCHEON_25'], n: 10 } },
  { code: 'tiger_queens_bane', name: "Tiger Queen's Bane", how: 'Defeat Tiger Girl at level 25.', rule: { kind: 'kill', mobs: ['MOB_CH_TIGERWOMAN'], n: 1 } },
]

/** Every title a character may wear by name: the Climb's and the events' (Play the Boss, the Siege). */
export const TITLE_NAMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(CLIMB_ACHIEVEMENTS.map((a) => [a.code, a.name])),
  tiger_spirit: 'Spirit of the Tiger',
  jangan_defender: 'Defender of Jangan',
}

// ---- set bonuses (§4.2) --------------------------------------------------------------------------------------------

/** The armour slots a family set counts (the six pieces). */
const ARMOUR_SLOTS: ReadonlySet<string> = new Set(['head', 'shoulders', 'chest', 'legs', 'hands', 'feet'])
/** The degree names on the tooltip line ("Iron set (4/6)"). */
export const CLIMB_SET_NAMES: Readonly<Record<number, string>> = { 1: 'Copper', 2: 'Bronze', 3: 'Iron', 4: 'General' }

export interface ClimbSetMods {
  maxHpPct: number
  defencePct: number
  damagePct: number
}

export interface ClimbSetLine {
  /** 'family:<degree>' or 'seal'. */
  id: string
  name: string
  count: number
  /** Pieces for the full bonus. */
  of: number
  /** The bonus text of the step reached ('' = none yet). */
  bonus: string
  /** The next step's text and pieces, if any. */
  next?: { at: number; bonus: string }
}

/**
 * §4.2 (one mod provider): a family is a degree (any grade and armour class, the six armour pieces): 4 pieces +3 % max
 * HP, 6 pieces +5 % max HP and +3 % physical and magical defence. The Seal set is any `_RARE` items worn: 3 pieces +5 %
 * damage, 5 pieces +8 % damage and +5 % max HP. The steps do not add up (the higher replaces the lower); the two sets do.
 */
export function climbSetBonus(worn: readonly Pick<ItemDef, 'code' | 'degree' | 'category' | 'slot'>[]): { mods: ClimbSetMods; lines: ClimbSetLine[] } {
  const mods: ClimbSetMods = { maxHpPct: 0, defencePct: 0, damagePct: 0 }
  const lines: ClimbSetLine[] = []
  const byDegree = new Map<number, number>()
  let seals = 0
  for (const it of worn) {
    if (/_RARE$/.test(it.code)) seals++
    if (it.category === 'armor' && it.slot && ARMOUR_SLOTS.has(it.slot) && it.degree) byDegree.set(it.degree, (byDegree.get(it.degree) ?? 0) + 1)
  }
  for (const [degree, n] of [...byDegree].sort((a, b) => a[0] - b[0])) {
    const name = `${CLIMB_SET_NAMES[degree] ?? `Degree ${degree}`} set`
    if (n >= 6) {
      mods.maxHpPct += 5
      mods.defencePct += 3
      lines.push({ id: `family:${degree}`, name, count: n, of: 6, bonus: '+5 % max HP, +3 % defence' })
    } else if (n >= 4) {
      mods.maxHpPct += 3
      lines.push({ id: `family:${degree}`, name, count: n, of: 6, bonus: '+3 % max HP', next: { at: 6, bonus: '+5 % max HP, +3 % defence' } })
    } else lines.push({ id: `family:${degree}`, name, count: n, of: 6, bonus: '', next: { at: 4, bonus: '+3 % max HP' } })
  }
  if (seals >= 5) {
    mods.damagePct += 8
    mods.maxHpPct += 5
    lines.push({ id: 'seal', name: 'Seal set', count: seals, of: 5, bonus: '+8 % damage, +5 % max HP' })
  } else if (seals >= 3) {
    mods.damagePct += 5
    lines.push({ id: 'seal', name: 'Seal set', count: seals, of: 5, bonus: '+5 % damage', next: { at: 5, bonus: '+8 % damage, +5 % max HP' } })
  } else if (seals > 0) lines.push({ id: 'seal', name: 'Seal set', count: seals, of: 5, bonus: '', next: { at: 3, bonus: '+5 % damage' } })
  return { mods, lines }
}

/** The set line an item's tooltip shows (the set it belongs to, counted on the worn items), or null. */
export function climbSetLineFor(item: Pick<ItemDef, 'code' | 'degree' | 'category' | 'slot'>, lines: readonly ClimbSetLine[]): ClimbSetLine | null {
  if (/_RARE$/.test(item.code)) return lines.find((l) => l.id === 'seal') ?? { id: 'seal', name: 'Seal set', count: 0, of: 5, bonus: '', next: { at: 3, bonus: '+5 % damage' } }
  if (item.category !== 'armor' || !item.slot || !ARMOUR_SLOTS.has(item.slot) || !item.degree) return null
  const id = `family:${item.degree}`
  return lines.find((l) => l.id === id) ?? { id, name: `${CLIMB_SET_NAMES[item.degree] ?? `Degree ${item.degree}`} set`, count: 0, of: 6, bonus: '', next: { at: 4, bonus: '+3 % max HP' } }
}

// ---- Arts (§5.1) ---------------------------------------------------------------------------------------------------

/** A tree of Arts: a weapon mastery, or FORCE = the best of the force masteries (cold, lightning, fire, force). */
export type ClimbArtTree = 'BICHEON' | 'HEUKSAL' | 'PACHEON' | 'FORCE'
export const CLIMB_ART_TREES: readonly ClimbArtTree[] = ['BICHEON', 'HEUKSAL', 'PACHEON', 'FORCE']
export const CLIMB_ART_TIERS: readonly number[] = [10, 15, 20]
const FORCE_MASTERIES: readonly MasteryCode[] = ['COLD', 'LIGHTNING', 'FIRE', 'FORCE']
/** §5.1: changing a tier's pick costs this × the tier's index (1, 2, 3); the first pick is free. */
export const CLIMB_ART_RESPEC_GOLD = 10_000

/** What an Art changes on a skill row at cast time (every field optional; `groups` / `kinds` say which rows). */
export interface ClimbArtRowMod {
  groups?: readonly string[]
  kinds?: readonly string[]
  /** Only the chain segment with this chainIndex (Illusion Chain's 3rd). */
  chainIndex?: number
  damagePct?: number
  cooldownMs?: number
  cooldownPct?: number
  mpPct?: number
  /** A new range (m) when the row's is at least 1 m; `rangeAdd` adds to it. */
  range?: number
  rangeAdd?: number
  maxTargets?: number
  areaDistance?: number
  statusMs?: number
  statusChanceMul?: number
  healPct?: number
}

export interface ClimbArt {
  id: string
  tree: ClimbArtTree
  tier: number
  name: string
  text: string
  row?: ClimbArtRowMod
  /** Executioner: + this % damage on a target under 30 % HP with the tree's rows. */
  lowHpDamagePct?: number
  /** Stat mods while worn (Iron Lung: Cheolsam learned; Ward: a guard active; Demon Soul: its buff active). */
  mods?: { maxHpPct?: number; defencePct?: number; damagePct?: number; whileGroups: readonly string[]; when: 'learned' | 'active' }
  /** Rebirth: the Soul Rebirth Art refunds all of a friend's death penalty. */
  rebirth?: true
  /** Not in effect yet (no row number carries it: basic-attack speed, critical, a monster's flight). */
  later?: true
}

const SMASH = ['SKILL_CH_SWORD_SMASH_A']
export const CLIMB_ARTS: readonly ClimbArt[] = [
  { id: 'heavy_smash', tree: 'BICHEON', tier: 10, name: 'Heavy Smash', text: 'Strike Smash +25 % damage, cooldown +1 s.', row: { groups: SMASH, damagePct: 25, cooldownMs: 1000 } },
  { id: 'swift_smash', tree: 'BICHEON', tier: 10, name: 'Swift Smash', text: 'Strike Smash cooldown -1 s, -10 % damage.', row: { groups: SMASH, damagePct: -10, cooldownMs: -1000 } },
  { id: 'long_reach', tree: 'BICHEON', tier: 15, name: 'Long Reach', text: 'Soul Cut Blade range 12 -> 16 m, +10 % damage.', row: { groups: ['SKILL_CH_SWORD_GEOMGI_A'], range: 16, damagePct: 10 } },
  { id: 'chain_momentum', tree: 'BICHEON', tier: 15, name: 'Chain Momentum', text: "Illusion Chain's 3rd segment +50 % damage.", row: { groups: ['SKILL_CH_SWORD_CHAIN_A'], chainIndex: 3, damagePct: 50 } },
  { id: 'executioner', tree: 'BICHEON', tier: 20, name: 'Executioner', text: '+30 % damage with Bicheon skills to targets under 30 % HP.', lowHpDamagePct: 30 },
  { id: 'flowing_steel', tree: 'BICHEON', tier: 20, name: 'Flowing Steel', text: 'Basic attack 10 % faster (not in effect yet).', later: true },
  { id: 'wide_bite', tree: 'HEUKSAL', tier: 10, name: 'Wide Bite', text: 'Wolf Bite Spear pierces 3.', row: { groups: ['SKILL_CH_SPEAR_PIERCE_A'], maxTargets: 3 } },
  { id: 'deep_bite', tree: 'HEUKSAL', tier: 10, name: 'Deep Bite', text: 'Wolf Bite Spear +20 % damage.', row: { groups: ['SKILL_CH_SPEAR_PIERCE_A'], damagePct: 20 } },
  { id: 'demons_reach', tree: 'HEUKSAL', tier: 15, name: "Demon's Reach", text: 'Dancing Demon Spear hits 4.', row: { groups: ['SKILL_CH_SPEAR_FRONTAREA_A'], maxTargets: 4 } },
  { id: 'iron_lung', tree: 'HEUKSAL', tier: 15, name: 'Iron Lung', text: 'Cheolsam Force: +5 % max HP more.', mods: { maxHpPct: 5, whileGroups: ['SKILL_CH_SPEAR_PASSIVE_A'], when: 'learned' } },
  { id: 'thunder_stun', tree: 'HEUKSAL', tier: 20, name: 'Thunder Stun', text: 'Soul Spear - Move stun +1 s.', row: { groups: ['SKILL_CH_SPEAR_STUN_A'], statusMs: 1000 } },
  { id: 'petal_storm', tree: 'HEUKSAL', tier: 20, name: 'Petal Storm', text: 'Ghost Spear - Petal radius 2 -> 3 m.', row: { groups: ['SKILL_CH_SPEAR_ROUNDAREA_A'], areaDistance: 3 } },
  { id: 'steady_aim', tree: 'PACHEON', tier: 10, name: 'Steady Aim', text: 'Anti Devil Bow - Missile +15 % critical (not in effect yet).', later: true },
  { id: 'quick_draw', tree: 'PACHEON', tier: 10, name: 'Quick Draw', text: '2 Arrow Combo cooldown -1.5 s.', row: { groups: ['SKILL_CH_BOW_CHAIN_A'], cooldownMs: -1500 } },
  { id: 'flame_pierce', tree: 'PACHEON', tier: 15, name: 'Flame Pierce', text: 'Autumn Wind - Flame pierces 4.', row: { groups: ['SKILL_CH_BOW_PIERCE_A'], maxTargets: 4 } },
  { id: 'hawks_eye', tree: 'PACHEON', tier: 15, name: "Hawk's Eye", text: 'White Hawk Summon also +2 m range.', row: { groups: ['SKILL_CH_BOW_CALL_A'], rangeAdd: 2 } },
  { id: 'pinning_shot', tree: 'PACHEON', tier: 20, name: 'Pinning Shot', text: "A bow hit ends a monster's flight (not in effect yet).", later: true },
  { id: 'demon_soul', tree: 'PACHEON', tier: 20, name: 'Demon Soul', text: 'Demon Soul Arrow +10 % damage while it is on.', mods: { damagePct: 10, whileGroups: ['SKILL_CH_BOW_NORMAL_A'], when: 'active' } },
  { id: 'deep_imbue', tree: 'FORCE', tier: 10, name: 'Deep Imbue', text: "The imbue's status chance x 1.5.", row: { kinds: ['imbue'], statusChanceMul: 1.5 } },
  { id: 'lean_imbue', tree: 'FORCE', tier: 10, name: 'Lean Imbue', text: 'The imbue costs 25 % less MP.', row: { kinds: ['imbue'], mpPct: -25 } },
  { id: 'mender', tree: 'FORCE', tier: 15, name: 'Mender', text: 'Heal - Medical Hand +20 %.', row: { groups: ['SKILL_CH_WATER_HEAL_A'], healPct: 20 } },
  { id: 'ward', tree: 'FORCE', tier: 15, name: 'Ward', text: 'Weak Guard of Ice and Basic Fire protection: +3 % defence.', mods: { defencePct: 3, whileGroups: ['SKILL_CH_COLD_GANGGI_A', 'SKILL_CH_FIRE_GANGGI_A'], when: 'active' } },
  { id: 'rebirth', tree: 'FORCE', tier: 20, name: 'Rebirth', text: "Soul Rebirth Art refunds all of a friend's death-penalty loss.", rebirth: true },
  { id: 'second_wind', tree: 'FORCE', tier: 20, name: 'Second Wind', text: 'Self Breathe Heal cooldown -50 %.', row: { groups: ['SKILL_CH_WATER_SELFHEAL_A'], cooldownPct: -50 } },
]

/** The picks of a character: "<tree>:<tier>" -> art id. */
export type ClimbArtPicks = Readonly<Record<string, string>>

export const climbArtKey = (tree: ClimbArtTree, tier: number): string => `${tree}:${tier}`
export const climbArt = (id: string): ClimbArt | undefined => CLIMB_ARTS.find((a) => a.id === id)

/** A tree's mastery level: the weapon mastery, or the best force mastery. */
export function climbTreeLevel(tree: ClimbArtTree, masteries: Readonly<Partial<Record<MasteryCode, number>>>): number {
  if (tree !== 'FORCE') return masteries[tree] ?? 0
  return Math.max(0, ...FORCE_MASTERIES.map((m) => masteries[m] ?? 0))
}

/** The Arts in effect: the valid picks whose tier the tree's mastery still reaches (a lowered mastery switches them off). */
export function climbActiveArts(picks: ClimbArtPicks, masteries: Readonly<Partial<Record<MasteryCode, number>>>): ClimbArt[] {
  const out: ClimbArt[] = []
  for (const [key, id] of Object.entries(picks)) {
    const a = climbArt(id)
    if (!a || climbArtKey(a.tree, a.tier) !== key) continue
    if (climbTreeLevel(a.tree, masteries) >= a.tier) out.push(a)
  }
  return out
}

/** Parses a saved picks JSON (bad JSON or unknown ids are dropped). */
export function parseClimbArts(json: string | null | undefined): Record<string, string> {
  try {
    const v = JSON.parse(json ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, id] of Object.entries(v as Record<string, unknown>)) {
      const a = typeof id === 'string' ? climbArt(id) : undefined
      if (a && climbArtKey(a.tree, a.tier) === k) out[k] = a.id
    }
    return out
  } catch {
    return {}
  }
}

const matches = (m: ClimbArtRowMod, row: SkillDef): boolean =>
  (!m.groups || m.groups.includes(row.group ?? '')) && (!m.kinds || m.kinds.includes(row.kind ?? '')) && (m.chainIndex === undefined || row.chainIndex === m.chainIndex) && (!!m.groups || !!m.kinds)

/** §5.1 (S-ARTS): the row a caster with `arts` uses (a copy with the numbers changed), or `row` itself when no Art applies. */
export function applyClimbArts(row: SkillDef, arts: readonly ClimbArt[]): SkillDef {
  let out = row
  for (const a of arts) {
    const m = a.row
    if (!m || !matches(m, row)) continue
    const r: SkillDef = out === row ? { ...row } : out
    if (m.damagePct && r.damage) r.damage = { ...r.damage, physPct: Math.round(r.damage.physPct * (1 + m.damagePct / 100)), magPct: Math.round(r.damage.magPct * (1 + m.damagePct / 100)) }
    if (m.cooldownMs) r.cooldownMs = Math.max(0, r.cooldownMs + m.cooldownMs)
    if (m.cooldownPct) r.cooldownMs = Math.max(0, Math.round(r.cooldownMs * (1 + m.cooldownPct / 100)))
    if (m.mpPct) r.mp = Math.max(0, Math.round(r.mp * (1 + m.mpPct / 100)))
    if (m.range !== undefined && r.range >= 1) r.range = m.range
    if (m.rangeAdd) r.range = r.range + m.rangeAdd
    if (m.maxTargets && r.area) r.area = { ...r.area, maxTargets: Math.max(r.area.maxTargets, m.maxTargets) }
    if (m.areaDistance && r.area) r.area = { ...r.area, distance: Math.max(r.area.distance, m.areaDistance) }
    if ((m.statusMs || m.statusChanceMul) && r.statuses) {
      r.statuses = r.statuses.map((s) => ({
        ...s,
        ...(m.statusMs && s.durationMs !== undefined ? { durationMs: s.durationMs + m.statusMs } : {}),
        ...(m.statusChanceMul ? { chancePct: Math.min(100, s.chancePct * m.statusChanceMul) } : {}),
      }))
    }
    if (m.healPct && r.heal) r.heal = { ...r.heal, hp: Math.round(r.heal.hp * (1 + m.healPct / 100)), hpPct: r.heal.hpPct * (1 + m.healPct / 100) }
    out = r
  }
  return out
}

/** Executioner (§5.1): the damage factor of a hit by a caster with `arts` with `row` on a target at `targetHpPct`. */
export function climbArtsHitMul(arts: readonly ClimbArt[], row: SkillDef, targetHpPct: number): number {
  let mul = 1
  for (const a of arts) if (a.lowHpDamagePct && row.mastery === a.tree && targetHpPct < 30) mul *= 1 + a.lowHpDamagePct / 100
  return mul
}
