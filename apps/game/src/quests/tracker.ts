/**
 * The on-screen quest tracker (docs/QUESTS.md §2.5): under the minimap block on the right, up to 5 tracked quests
 * (new quests are tracked automatically), one line per open objective ("Water Ghost Slave 7/12"), "Return to ..."
 * when ready, and a Use button for a useItem objective. Clicking a quest opens it in the log. Redrawn on quest events.
 */
import type { QuestObjective } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import type { QuestLookup } from './catalog.ts'
import { objectiveLine, type QuestNames } from './format.ts'
import { objectiveCount, objectiveOpen, usableObjective, type QuestState } from './state.ts'
import { ensureQuestStyles } from './style.ts'

export const TRACK_MAX = 5

export interface TrackerDeps {
  art: Art
  quests: QuestState
  catalog: QuestLookup
  names: QuestNames
  /** Tracked quest ids, in order. */
  tracked(): readonly string[]
  openLog(quest: string): void
  use(quest: string, objective: string): void
  canUse(o: Extract<QuestObjective, { type: 'useItem' }>): boolean
  /** Server time (ms). */
  now(): number
}

export class QuestTracker {
  readonly root: HTMLElement
  private uses: { btn: HTMLButtonElement; o: Extract<QuestObjective, { type: 'useItem' }> }[] = []

  constructor(parent: HTMLElement, private readonly deps: TrackerDeps) {
    ensureQuestStyles()
    this.root = el('div', 'quest-tracker')
    this.root.hidden = true
    // Clicks on the tracker never reach the world.
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.root.addEventListener('contextmenu', ev => ev.preventDefault())
    parent.append(this.root)
  }

  /** Places the tracker `top` CSS pixels from the top of its parent (under the minimap block). */
  setTop(top: number): void {
    const v = `${Math.round(top)}px`
    if (this.root.style.top !== v) this.root.style.top = v
  }

  render(): void {
    const { quests, catalog, names } = this.deps
    const blocks: HTMLElement[] = []
    this.uses = []
    for (const id of this.deps.tracked()) {
      if (blocks.length >= TRACK_MAX) break
      const p = quests.active.get(id)
      const def = catalog.quest(id)
      if (!p || !def) continue
      const head = el('button', 'quest-tracker-title', def.title)
      head.type = 'button'
      head.addEventListener('click', () => this.deps.openLog(id))
      const block = el('div', 'quest-tracker-quest', head)
      if (def.disabled) block.append(el('div', 'quest-tracker-line dim', t('quest.withdrawn')))
      else if (p.status === 'ready') block.append(el('div', 'quest-tracker-line ready', t('quest.returnTo', { npc: names.npc(def.turnIn) })))
      else {
        for (const o of def.objectives) {
          if (!objectiveOpen(o, def, p)) continue
          const line = el('div', 'quest-tracker-line', objectiveLine(o, objectiveCount(o, p), catalog, names))
          if (o.type === 'useItem') line.append(this.useButton(id, o))
          block.append(line)
        }
        const again = usableObjective(def, p, this.deps.now())
        if (again && !objectiveOpen(again, def, p)) {
          const line = el('div', 'quest-tracker-line', objectiveLine(again, 1, catalog, names))
          line.append(this.useButton(id, again))
          block.append(line)
        }
        if (!def.objectives.length) block.append(el('div', 'quest-tracker-line ready', t('quest.returnTo', { npc: names.npc(def.turnIn) })))
      }
      blocks.push(block)
    }
    this.root.replaceChildren(...blocks)
    this.root.hidden = blocks.length === 0
    this.updateUse()
  }

  private useButton(quest: string, o: Extract<QuestObjective, { type: 'useItem' }>): HTMLButtonElement {
    const b = this.deps.art.button(t('quest.use'), { key: 'ifcommon/com_button', w: 48, h: 20, className: 'quest-tracker-use' })
    b.addEventListener('click', () => this.deps.use(quest, o.id))
    this.uses.push({ btn: b, o })
    return b
  }

  /** Enables the Use buttons inside their places (call as the player moves). */
  updateUse(): void {
    for (const u of this.uses) {
      const ok = this.deps.canUse(u.o)
      if (u.btn.disabled !== !ok) u.btn.disabled = !ok
    }
  }

  get hasUse(): boolean {
    return this.uses.length > 0
  }

  dispose(): void {
    this.root.remove()
  }
}
