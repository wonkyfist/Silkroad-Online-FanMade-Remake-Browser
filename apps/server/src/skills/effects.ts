import type { EffectState, SkillDef, SkillStatusKind } from '@sro/shared'
import type { StatMod } from './mods.ts'

/**
 * Effects on entities (docs/SKILLS.md §10.1 "Buffs / debuffs model", "Imbues", statuses): buffs, debuffs, imbues,
 * toggles and abnormal states / crowd control. Each has an instance id, a carrier, its stat mods and an end time
 * (0 = until cancelled). Passives are not effects: the engine rebuilds them from the learned skills.
 *
 * Stacking: a new buff, imbue or toggle replaces any effect on the carrier with the same overlap class (the low 16
 * bits of Action_Overlap, when non-zero) or the same skill group; a status replaces the same status kind.
 */

export type EffectKind = 'buff' | 'debuff' | 'imbue' | 'toggle' | 'status'

export interface Effect {
  instance: number
  carrier: number
  /** Entity id of the caster. */
  source: number
  kind: EffectKind
  /** Source skill row (buffs, imbues, toggles, debuffs; statuses: the skill that inflicted it). */
  skill?: SkillDef
  group?: string
  status?: SkillStatusKind
  level?: number
  /** Stacking class (0 = none). */
  overlap: number
  mods: StatMod[]
  startedAt: number
  /** Server ms it ends; 0 = until cancelled (toggles). */
  until: number
  /** Periodic work: burn damage, toggle MP upkeep. */
  tick?: { everyMs: number; next: number; damage?: number; mp?: number }
  /** Crystal Wall ('pw'): physical damage it still absorbs. */
  wall?: number
}

/**
 * Status rules [decision, docs/WAVE_PLAN.md §4.3 "Units still unknown"]: durations the data does not give, whether
 * the status stops actions/moves, and whether it is an abnormal state (cured by Force Cure and pills; gated by level).
 */
export const STATUS_RULES: Record<SkillStatusKind, { durationMs: number; blocks: boolean; abnormal: boolean; tickMs?: number }> = {
  freeze: { durationMs: 2000, blocks: true, abnormal: true },
  frostbite: { durationMs: 5000, blocks: false, abnormal: true },
  shock: { durationMs: 5000, blocks: false, abnormal: true },
  burn: { durationMs: 5000, blocks: false, abnormal: true, tickMs: 1000 },
  poison: { durationMs: 5000, blocks: false, abnormal: true, tickMs: 1000 },
  zombie: { durationMs: 5000, blocks: false, abnormal: true },
  darkness: { durationMs: 5000, blocks: false, abnormal: true },
  stun: { durationMs: 3000, blocks: true, abnormal: false },
  knockdown: { durationMs: 2000, blocks: true, abnormal: false },
  knockback: { durationMs: 1000, blocks: true, abnormal: false },
}

/** Overlap class of a row: Action_Overlap's low 16 bits (the high byte marks attack skills). */
export const overlapClass = (s: SkillDef | undefined): number => (s?.overlap ?? 0) & 0xffff

export class EffectTable {
  private readonly byCarrier = new Map<number, Map<number, Effect>>()

  list(carrier: number): Effect[] {
    const m = this.byCarrier.get(carrier)
    return m ? [...m.values()] : []
  }

  carriers(): number[] {
    return [...this.byCarrier.keys()]
  }

  get(carrier: number, instance: number): Effect | undefined {
    return this.byCarrier.get(carrier)?.get(instance)
  }

  /** Effects that `e` would replace (same overlap class or group; same status kind). */
  replacedBy(e: Effect): Effect[] {
    return this.list(e.carrier).filter((o) => {
      if (e.kind === 'status') return o.kind === 'status' && o.status === e.status
      if (o.kind === 'status') return false
      if (e.group !== undefined && o.group === e.group) return true
      return e.overlap !== 0 && o.overlap === e.overlap
    })
  }

  add(e: Effect): void {
    let m = this.byCarrier.get(e.carrier)
    if (!m) this.byCarrier.set(e.carrier, (m = new Map()))
    m.set(e.instance, e)
  }

  remove(carrier: number, instance: number): Effect | undefined {
    const m = this.byCarrier.get(carrier)
    const e = m?.get(instance)
    if (!m || !e) return undefined
    m.delete(instance)
    if (m.size === 0) this.byCarrier.delete(carrier)
    return e
  }

  /** Drops every effect of a carrier without messages (it left the world). */
  drop(carrier: number): Effect[] {
    const list = this.list(carrier)
    this.byCarrier.delete(carrier)
    return list
  }

  status(carrier: number, kind: SkillStatusKind, now: number): Effect | undefined {
    return this.list(carrier).find((e) => e.status === kind && (e.until === 0 || e.until > now))
  }

  /** Stunned, frozen or knocked down: no actions, no moves. */
  blocked(carrier: number, now: number): boolean {
    if (!this.byCarrier.has(carrier)) return false
    return this.list(carrier).some((e) => e.kind === 'status' && e.status !== undefined && STATUS_RULES[e.status].blocks && (e.until === 0 || e.until > now))
  }

  imbue(carrier: number): Effect | undefined {
    return this.list(carrier).find((e) => e.kind === 'imbue')
  }
}

/** Wire form of an effect (docs/SKILLS.md §10.2 EffectState). */
export function effectState(e: Effect, now: number): EffectState {
  const s: EffectState = { instance: e.instance, remainingMs: e.until === 0 ? 0 : Math.max(1, Math.min(86_400_000, Math.round(e.until - now))) }
  // A status shows as the state itself (its icon), not as the skill that inflicted it.
  if (e.skill && e.kind !== 'status') s.skill = e.skill.code
  if (e.status) s.status = e.status
  if (e.level !== undefined) s.level = Math.max(0, Math.round(e.level))
  s.source = e.source
  return s
}
