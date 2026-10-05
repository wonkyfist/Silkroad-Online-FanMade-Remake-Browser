import { HOTBAR_SLOTS, MASTERY_CODES, MOUSE_SLOT, type HotbarEntry, type MasteryCode } from '@sro/shared'
import type { Store } from '../db.ts'
import type { Progress } from '../progression.ts'

/**
 * Skill persistence on the v5 tables (docs/WAVE_PLAN.md §3.1 migration 5): masteries, the highest learned level per
 * skill group, and the 40 hotbar slots; migration 11 adds the mouse quick slot (MOUSE_SLOT). Cooldowns are not stored
 * (decision 8).
 */

export interface SkillSave {
  masteries: Record<MasteryCode, number>
  /** group -> highest learned skill level. */
  skills: Map<string, number>
  hotbar: (HotbarEntry | null)[]
  /** The mouse quick slot (MOUSE_SLOT), used by the middle mouse button. */
  mouse: HotbarEntry | null
}

export const emptyMasteries = (): Record<MasteryCode, number> => Object.fromEntries(MASTERY_CODES.map((c) => [c, 0])) as Record<MasteryCode, number>

export class SkillStore {
  private readonly q

  constructor(readonly store: Store) {
    const db = store.db
    this.q = {
      masteries: db.prepare<[number], { code: string; level: number }>('SELECT code, level FROM char_masteries WHERE character_id = ?'),
      skills: db.prepare<[number], { grp: string; level: number }>('SELECT grp, level FROM char_skills WHERE character_id = ?'),
      hotbar: db.prepare<[number], { slot: number; kind: 'skill' | 'item'; code: string }>('SELECT slot, kind, code FROM char_hotbar WHERE character_id = ?'),
      setMastery: db.prepare<[number, string, number]>(
        'INSERT INTO char_masteries (character_id, code, level) VALUES (?, ?, ?) ON CONFLICT (character_id, code) DO UPDATE SET level = excluded.level',
      ),
      setSkill: db.prepare<[number, string, number]>(
        'INSERT INTO char_skills (character_id, grp, level) VALUES (?, ?, ?) ON CONFLICT (character_id, grp) DO UPDATE SET level = excluded.level',
      ),
      setSlot: db.prepare<[number, number, string, string]>(
        'INSERT INTO char_hotbar (character_id, slot, kind, code) VALUES (?, ?, ?, ?) ON CONFLICT (character_id, slot) DO UPDATE SET kind = excluded.kind, code = excluded.code',
      ),
      clearSlot: db.prepare<[number, number]>('DELETE FROM char_hotbar WHERE character_id = ? AND slot = ?'),
      mouse: db.prepare<[number], { kind: 'skill' | 'item'; code: string }>('SELECT kind, code FROM char_mouse_slot WHERE character_id = ?'),
      setMouse: db.prepare<[number, string, string]>(
        'INSERT INTO char_mouse_slot (character_id, kind, code) VALUES (?, ?, ?) ON CONFLICT (character_id) DO UPDATE SET kind = excluded.kind, code = excluded.code',
      ),
      clearMouse: db.prepare<[number]>('DELETE FROM char_mouse_slot WHERE character_id = ?'),
      clearMasteries: db.prepare<[number]>('DELETE FROM char_masteries WHERE character_id = ?'),
      clearSkills: db.prepare<[number]>('DELETE FROM char_skills WHERE character_id = ?'),
    }
  }

  load(characterId: number): SkillSave {
    const masteries = emptyMasteries()
    for (const r of this.q.masteries.all(characterId)) if (r.code in masteries) masteries[r.code as MasteryCode] = r.level
    const skills = new Map<string, number>()
    for (const r of this.q.skills.all(characterId)) skills.set(r.grp, r.level)
    const hotbar: (HotbarEntry | null)[] = Array.from({ length: HOTBAR_SLOTS }, () => null)
    for (const r of this.q.hotbar.all(characterId)) if (r.slot >= 0 && r.slot < HOTBAR_SLOTS) hotbar[r.slot] = { kind: r.kind, code: r.code }
    const m = this.q.mouse.get(characterId)
    return { masteries, skills, hotbar, mouse: m ? { kind: m.kind, code: m.code } : null }
  }

  /** Mastery / skill changes and the SP they cost, in one transaction. */
  learn(characterId: number, change: { mastery?: [MasteryCode, number][]; skills?: [string, number][]; progress?: Progress }): void {
    this.store.db.transaction(() => {
      for (const [code, level] of change.mastery ?? []) this.q.setMastery.run(characterId, code, level)
      for (const [grp, level] of change.skills ?? []) this.q.setSkill.run(characterId, grp, level)
      if (change.progress) this.store.saveProgress(characterId, change.progress)
    })()
  }

  setHotbar(characterId: number, slot: number, entry: HotbarEntry | null): void {
    if (slot === MOUSE_SLOT) {
      if (entry) this.q.setMouse.run(characterId, entry.kind, entry.code)
      else this.q.clearMouse.run(characterId)
      return
    }
    if (entry) this.q.setSlot.run(characterId, slot, entry.kind, entry.code)
    else this.q.clearSlot.run(characterId, slot)
  }

  /** GM `skill reset`: forgets every mastery and skill (the hotbar stays). */
  reset(characterId: number): void {
    this.store.db.transaction(() => {
      this.q.clearMasteries.run(characterId)
      this.q.clearSkills.run(characterId)
    })()
  }
}
