/**
 * Quest marks over NPCs and quest markers on the minimap (docs/QUESTS.md §2.2, §2.6).
 * - NPC marks go through `EntityView.setBadge('quest', glyph, cls)` (WAVE_PLAN §5.2: no entities.ts edit); the CSS in
 *   quests/style.ts lifts the badge above the name. Marks are recomputed on quest events, level changes and NPC spawns,
 *   never per frame, and a view is only touched when its mark changes.
 * - The minimap source returns translucent gold circles for the hint/location of open objectives of tracked quests,
 *   and pins for the NPCs where a tracked quest is ready or has a talk/deliver objective.
 * No DOM.
 */
import type { QuestDef } from '@sro/shared'
import type { QuestLookup } from './catalog.ts'
import { objectiveLocation } from './format.ts'
import { npcIdentity, objectiveOpen, type NpcMark, type QuestMark, type QuestState } from './state.ts'

/** Glyph and CSS class of each mark (gold !, gold ?, gold …, blue !, grey ?, grey !). */
export const MARK_GLYPHS: Record<QuestMark, { text: string; cls: string }> = {
  ready: { text: '?', cls: 'quest-mark gold' },
  talk: { text: '…', cls: 'quest-mark gold talk' },
  available: { text: '!', cls: 'quest-mark gold' },
  repeatable: { text: '!', cls: 'quest-mark blue' },
  progress: { text: '?', cls: 'quest-mark grey' },
  soon: { text: '!', cls: 'quest-mark grey soon' },
}

/** What markers need of an entity view (EntityView; tests pass plain objects). */
export interface MarkableView {
  readonly kind: string
  readonly state: { npc?: string; model: string }
  setBadge(key: string, text: string | null, cls?: string): void
}

/** Keeps the 'quest' badge of every NPC view in step with the quest state. */
export class NpcMarkers {
  /** Last badge written per view ('' = none). */
  private readonly shown = new WeakMap<MarkableView, string>()

  constructor(private readonly markOf: (npc: string) => NpcMark | null) {}

  /** Sets (or clears) the badge of one view; non-NPC views are ignored. */
  update(v: MarkableView): void {
    if (v.kind !== 'npc') return
    let mark: NpcMark | null = null
    try {
      mark = this.markOf(npcIdentity(v.state))
    } catch (err) {
      console.error('[quests] marker failed', err)
    }
    const g = mark ? MARK_GLYPHS[mark.mark] : null
    const sig = g ? `${g.text}|${g.cls}` : ''
    if ((this.shown.get(v) ?? '') === sig) return
    this.shown.set(v, sig)
    v.setBadge('quest', g ? g.text : null, g?.cls)
  }

  updateAll(views: Iterable<MarkableView>): void {
    for (const v of views) this.update(v)
  }

  /** Removes the badges (feature dispose). */
  clear(views: Iterable<MarkableView>): void {
    for (const v of views) {
      if (v.kind !== 'npc' || !this.shown.get(v)) continue
      this.shown.set(v, '')
      v.setBadge('quest', null)
    }
  }
}

/** A minimap marker (world/jangan/minimap.ts HudMarker). */
export interface QuestMapMarker {
  x: number
  z: number
  color: string
  size?: number
  radius?: number
  icon?: string
}

export const AREA_COLOR = '#ffd35a'
export const PIN_COLOR = '#ffd35a'
export const PIN_ICON = 'minimap/mm_sign_questnpc'

/**
 * Minimap markers of the tracked quests: circles for open objectives' places, pins for NPCs to report to or talk to.
 * `npcAt` finds an NPC identity's position (content data, else the view in sight).
 */
export function questMapMarkers(
  tracked: readonly string[],
  quests: QuestState,
  catalog: QuestLookup,
  npcAt: (npc: string) => { x: number; z: number } | null,
): QuestMapMarker[] {
  const out: QuestMapMarker[] = []
  const areas = new Set<string>()
  const pins = new Set<string>()
  const pin = (npc: string) => {
    if (pins.has(npc)) return
    pins.add(npc)
    const at = npcAt(npc)
    if (at) out.push({ x: at.x, z: at.z, color: PIN_COLOR, size: 5, icon: PIN_ICON })
  }
  for (const id of tracked) {
    const p = quests.active.get(id)
    const def: QuestDef | undefined = catalog.quest(id)
    if (!p || !def) continue
    if (p.status === 'ready') {
      if (!def.disabled) pin(def.turnIn)
      continue
    }
    for (const o of def.objectives) {
      if (!objectiveOpen(o, def, p)) continue
      if (o.type === 'talk' || o.type === 'deliver') pin(o.npc)
      const loc = objectiveLocation(o, catalog)
      if (loc && !areas.has(loc.id)) {
        areas.add(loc.id)
        out.push({ x: loc.x, z: loc.z, color: AREA_COLOR, radius: loc.radius })
      }
    }
  }
  return out
}
