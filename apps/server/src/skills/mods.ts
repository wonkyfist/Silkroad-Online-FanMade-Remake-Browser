import type { SkillParamRecord } from '@sro/shared'
import type { CombatStats } from '../formulas.ts'

/**
 * Stat modifiers of buffs, passives and statuses (docs/SKILLS.md §4 tag table, §10.1 "Buffs / debuffs model"). They
 * are applied as the last step of the derived combat stats (Gameplay.refresh -> SkillEngine.applyMods), so `stats`
 * shows them.
 *
 * Units [decision, docs/WAVE_PLAN.md §8 question 3]: `defp` values below 20 are percent, 20 and above are flat;
 * `ru` is metres x 0.1.
 */

export type ModStat =
  | 'physDefence'
  | 'magDefence'
  | 'physDefencePct'
  | 'magDefencePct'
  | 'physDamagePct'
  | 'magDamagePct'
  | 'hitRate'
  | 'parryRate'
  | 'parryPct'
  | 'blockRate'
  | 'maxHp'
  | 'maxMp'
  /** The Climb's set bonuses and Arts (docs/CLIMB.md §4.2, §5.1): max HP + this percent (after the flat 'hpi'). */
  | 'maxHpPct'
  | 'speedPct'
  | 'range'
  /** 'spda': the equipped shield's physical defence -percent. */
  | 'shieldDefencePct'
  /** 'dgmp': this percent of incoming damage is taken from MP instead of HP. */
  | 'damageToMpPct'
  /** 'bgra': incoming abnormal-state chance -percent. */
  | 'statusResistPct'
  /**
   * Wave 8 (docs/SYSTEMS_COMBAT.md §1.3): a mount's move-speed factor (CosDef.runSpeed / PLAYER_RETAIL_RUN, e.g. 1.8),
   * from the mounts module's mod provider. Multiplicative: while it is above 0 it replaces the buff speed (`speedPct`,
   * which is ignored while mounted) in SkillEngine.applyStats. 0 = on foot.
   */
  | 'mountSpeed'

export interface StatMod {
  stat: ModStat
  value: number
}

export type ModTotals = Record<ModStat, number>

/** `defp` percent/flat boundary. */
export const DEFP_FLAT_FROM = 20

const zero = (): ModTotals => ({
  physDefence: 0,
  magDefence: 0,
  physDefencePct: 0,
  magDefencePct: 0,
  physDamagePct: 0,
  magDamagePct: 0,
  hitRate: 0,
  parryRate: 0,
  parryPct: 0,
  blockRate: 0,
  maxHp: 0,
  maxMp: 0,
  maxHpPct: 0,
  speedPct: 0,
  range: 0,
  shieldDefencePct: 0,
  damageToMpPct: 0,
  statusResistPct: 0,
  mountSpeed: 0,
})

/** The stat mods a skill row carries (its FourCC records). */
export function modsFromParams(params: readonly SkillParamRecord[] | undefined): StatMod[] {
  const out: StatMod[] = []
  const add = (stat: ModStat, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value) && value !== 0) out.push({ stat, value })
  }
  for (const { tag, args } of params ?? []) {
    switch (tag) {
      case 'defp': {
        const [pd, md] = args
        if (pd) add(pd < DEFP_FLAT_FROM ? 'physDefencePct' : 'physDefence', pd)
        if (md) add(md < DEFP_FLAT_FROM ? 'magDefencePct' : 'magDefence', md)
        break
      }
      case 'dru':
        add('physDamagePct', args[0])
        add('magDamagePct', args[1])
        break
      case 'hste':
        add('speedPct', args[0])
        break
      case 'hr':
        add('hitRate', args[0])
        break
      case 'er':
        add('parryRate', args[0])
        break
      case 'br':
        add('blockRate', args[0])
        break
      case 'hpi':
        add('maxHp', args[0])
        break
      case 'mpi':
        add('maxMp', args[0])
        break
      case 'ru':
        add('range', (args[0] ?? 0) * 0.1)
        break
      case 'spda':
        add('shieldDefencePct', -(args[0] ?? 0))
        add('physDamagePct', args[1])
        break
      case 'dgmp':
        add('damageToMpPct', args[0])
        break
      case 'bgra':
        add('statusResistPct', args[1])
        break
    }
  }
  return out
}

export function sumMods(mods: Iterable<StatMod>): ModTotals {
  const t = zero()
  for (const m of mods) t[m.stat] += m.value
  return t
}

/** Applies mod totals to derived combat stats (a new object). `shieldPd`: the worn shield's physical defence. */
export function applyMods<T extends CombatStats & { range: number }>(c: T, t: ModTotals, shieldPd = 0): T {
  const pct = (v: number) => Math.max(0, 1 + v / 100)
  return {
    ...c,
    physDefence: Math.max(0, Math.round((c.physDefence + t.physDefence + (shieldPd * t.shieldDefencePct) / 100) * pct(t.physDefencePct))),
    magDefence: Math.max(0, Math.round((c.magDefence + t.magDefence) * pct(t.magDefencePct))),
    hitRate: Math.max(0, Math.round(c.hitRate + t.hitRate)),
    parryRate: Math.max(0, Math.round((c.parryRate + t.parryRate) * pct(t.parryPct))),
    blockRate: Math.max(0, Math.round(c.blockRate + t.blockRate)),
    range: Math.max(0, c.range + t.range),
    physDamagePct: (c.physDamagePct ?? 0) + t.physDamagePct,
    magDamagePct: (c.magDamagePct ?? 0) + t.magDamagePct,
  }
}
