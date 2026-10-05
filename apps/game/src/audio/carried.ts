/**
 * What each entity carries that changes how its hits sound (docs/SOUND.md §10.3): its imbue (the attacker's element
 * SND_DMG joins every landed hit) and its buffs (a shield buff's SND_DDMG joins the hits it takes). Fed from the same
 * messages the buff bar reads: EntityState.effects (worldEnter, spawn), effectAdd, effectRemove, despawn. Pure.
 */
import type { EffectState } from '@sro/shared'
import { skillGroupOf } from './cues.ts'

/** Skill row code -> true when it is an imbue (skills.json kind 'imbue'). */
export type ImbueTest = (code: string) => boolean

interface Carried {
  group: string
  imbue: boolean
}

export class CarriedSkills {
  private readonly byEntity = new Map<number, Map<number, Carried>>()

  constructor(private readonly isImbue: ImbueTest) {}

  /** The full list an entity arrived with (replaces what was known). */
  set(id: number, effects: readonly EffectState[] | undefined): void {
    this.byEntity.delete(id)
    for (const e of effects ?? []) this.add(id, e)
  }

  add(id: number, e: EffectState): void {
    const group = skillGroupOf(e.skill)
    if (!group || !e.skill) return
    let m = this.byEntity.get(id)
    if (!m) this.byEntity.set(id, (m = new Map()))
    m.set(e.instance, { group, imbue: this.isImbue(e.skill) })
  }

  remove(id: number, instance: number): void {
    const m = this.byEntity.get(id)
    if (!m) return
    m.delete(instance)
    if (!m.size) this.byEntity.delete(id)
  }

  forget(id: number): void {
    this.byEntity.delete(id)
  }

  clear(): void {
    this.byEntity.clear()
  }

  /** The imbue group `id` carries (the newest when several are known), or null. */
  imbueOf(id: number): string | null {
    let last: string | null = null
    for (const c of this.byEntity.get(id)?.values() ?? []) if (c.imbue) last = c.group
    return last
  }

  /** Every skill group `id` carries, imbues included. */
  groupsOf(id: number): string[] {
    return [...(this.byEntity.get(id)?.values() ?? [])].map(c => c.group)
  }
}
