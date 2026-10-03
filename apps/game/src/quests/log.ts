/**
 * The Main window's Quest tab (Q, alias L; docs/QUESTS.md §2.4, docs/UI.md §4.6, retail `ifquest.txt` `GDR_QUEST`
 * (13,38,365,355) in `sframe_wnd_` "Quest list"). The list shows one `qst_subjectwindo` row per quest (340×28): the
 * open/close toggle that drops the objectives down under the row, the colour bar (`qst_colorbar_blue` active,
 * `_green` ready to turn in, `_red` withdrawn), the title, the level, the tracker check (`qst_checkbutton`) and the
 * content button (`qst_contentview_button`) that shows the quest's page: level, giver → turn-in, summary, objectives,
 * quest items, rewards, with Track / Abandon (asks first) and, for a useItem objective, Use (enabled inside the
 * place's radius; the server decides). Chapters head their quests; "Show completed" lists finished quests.
 * Redrawn from the quest state, never edited locally.
 */
import { MAX_ACTIVE_QUESTS, type QuestDef, type QuestObjective, type QuestProgress } from '@sro/shared'
import { ensureMainStyles, MainPage } from '../hud/main-window.ts'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place } from '../ui/dom.ts'
import { button, iconButton, type KitButton } from '../ui/kit/button.ts'
import { Checkbox } from '../ui/kit/check.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { Section } from '../ui/kit/section.ts'
import type { QuestLookup } from './catalog.ts'
import { itemCell, rewardsBlock, type IconDeps } from './dialog-panel.ts'
import { cooldownNote } from './dialog.ts'
import { objectiveViews, rewardsView, type QuestNames, type QuestReader } from './format.ts'
import { usableObjective, type QuestState } from './state.ts'
import { ensureQuestStyles } from './style.ts'

export interface QuestLogDeps extends IconDeps {
  quests: QuestState
  catalog: QuestLookup
  names: QuestNames
  reader(): QuestReader
  expToNext(level: number): number
  /** Server time (ms). */
  now(): number
  isTracked(id: string): boolean
  setTracked(id: string, on: boolean): void
  /** Asks, then sends questAbandon. */
  abandon(id: string): void
  /** Sends questUseItem. */
  use(quest: string, objective: string): void
  /** Inside the objective's place (client-side hint for the Use button). */
  canUse(o: Extract<QuestObjective, { type: 'useItem' }>): boolean
  /** Whether the catalog has loaded (else a "reading" line). */
  catalogLoaded(): boolean
}

/** The colour bar of a quest row: withdrawn red, ready green, else blue. */
export function questBar(p: Pick<QuestProgress, 'status'> | null | undefined, disabled: boolean): 'red' | 'green' | 'blue' {
  if (disabled) return 'red'
  return p?.status === 'ready' ? 'green' : 'blue'
}

export class QuestLogWindow extends MainPage {
  private readonly section: Section
  private readonly list: ScrollArea
  private readonly detailBox: HTMLElement
  private readonly detailTitle: HTMLElement
  private readonly detail: ScrollArea
  private readonly buttons: HTMLElement
  private readonly doneBox: Checkbox
  private selected: string | null = null
  /** The quest whose page is shown (null = the list). */
  private viewing: string | null = null
  private readonly expanded = new Set<string>()
  private showDone = false
  private useBtn: { btn: KitButton; o: Extract<QuestObjective, { type: 'useItem' }> } | null = null

  constructor(art: Art, parent: HTMLElement, private readonly deps: QuestLogDeps) {
    ensureQuestStyles()
    super(art, parent, { id: 'quests', tab: 'quest', title: t('quest.log.title') })
    ensureMainStyles()
    this.section = new Section(art, { at: [0, 0, 365, 355], caption: t('quest.win.caption'), className: 'qst-panel' })
    // Retail row separators (com_bg_tile_c lines every 27 px, and the scroll column's edge).
    const tile = art.has('ifcommon/bg_tile/com_bg_tile_c') ? art.cssUrl('ifcommon/bg_tile/com_bg_tile_c') : ''
    for (let k = 0; k < 11; k++) this.section.root.append(place(el('div', 'qst-line'), [16, 52 + 27 * k, 327, 2]))
    this.section.root.append(place(el('div', 'qst-line'), [343, 36, 1, 290]))
    if (tile) for (const l of this.section.root.querySelectorAll<HTMLElement>('.qst-line')) l.style.backgroundImage = tile
    this.list = new ScrollArea(art, { w: 356, h: 296, className: 'qst-list' })
    place(this.list.root, [4, 27, 356, 296])
    this.doneBox = new Checkbox(art, { label: t('quest.log.completed') })
    place(this.doneBox.root, [14, 330, 180, 16])
    this.doneBox.onChange = on => {
      this.showDone = on
      this.selected = null
      this.viewing = null
      this.render()
    }
    // The quest's page (the content button), over the list.
    this.detailBox = place(el('div', 'qst-detail'), [4, 27, 356, 323])
    this.detailTitle = place(el('div', 'qst-detail-title kit-fit'), [8, 0, 340, 28])
    if (art.has('quest/qst_detailwindo')) this.detailTitle.style.backgroundImage = art.cssUrl('quest/qst_detailwindo')
    this.detail = new ScrollArea(art, { w: 346, h: 256, className: 'qst-detail-scroll' })
    place(this.detail.root, [6, 32, 346, 256])
    this.buttons = place(el('div', 'qst-buttons'), [4, 293, 348, 26])
    this.detailBox.append(this.detailTitle, this.detail.root, this.buttons)
    this.detailBox.hidden = true
    this.section.root.append(this.list.root, this.doneBox.root, this.detailBox)
    this.body.append(this.section.root)
  }

  protected override onOpen(): void {
    this.render()
  }

  /** Opens the log on one quest's page. */
  showQuest(id: string): void {
    this.showDone = false
    this.doneBox.checked = false
    this.selected = id
    this.viewing = id
    if (!this.isOpen) this.open()
    else this.render()
    this.raise()
  }

  /** Redraws when open (quest events, catalog, level). */
  refresh(): void {
    if (this.isOpen) this.render()
  }

  override dispose(): void {
    this.list.dispose()
    this.detail.dispose()
    super.dispose()
  }

  private render(): void {
    const { quests } = this.deps
    const full = quests.active.size >= MAX_ACTIVE_QUESTS
    this.section.setCaption(`${t('quest.win.caption')}  ${t('quest.log.count', { n: quests.active.size, max: MAX_ACTIVE_QUESTS })}`)
    this.section.caption.classList.toggle('full', full)
    const ids = this.showDone ? this.doneIds() : quests.activeList().map(p => p.quest)
    if (this.selected && !ids.includes(this.selected)) this.selected = null
    if (this.viewing && !ids.includes(this.viewing)) this.viewing = null
    this.renderList(ids)
    this.detailBox.hidden = !this.viewing
    this.list.root.hidden = !!this.viewing
    this.doneBox.root.hidden = !!this.viewing
    if (this.viewing) this.renderDetail(this.viewing)
  }

  private title(id: string): string {
    return this.deps.catalog.quest(id)?.title ?? t('quest.unknown', { id })
  }

  private doneIds(): string[] {
    return [...this.deps.quests.done.values()].sort((a, b) => b.lastAt - a.lastAt).map(d => d.quest)
  }

  private renderList(ids: string[]): void {
    const { catalog, quests, names } = this.deps
    const art = this.art
    const rows: HTMLElement[] = []
    if (!ids.length) {
      const text = !this.deps.catalogLoaded() && !this.showDone ? t('quest.log.loading') : this.showDone ? t('quest.log.noneCompleted') : t('quest.log.empty')
      rows.push(el('div', 'qst-empty', text))
    }
    const groups = new Map<string, string[]>()
    for (const id of ids) {
      const chapter = this.showDone ? t('quest.log.completedTitle') : catalog.quest(id)?.chapter ?? t('quest.log.other')
      const g = groups.get(chapter)
      if (g) g.push(id)
      else groups.set(chapter, [id])
    }
    for (const [chapter, list] of groups) {
      const head = el('div', 'qst-chapter', el('span', 'kit-fit', chapter))
      if (art.has('quest/qst_list_background')) head.style.backgroundImage = art.cssUrl('quest/qst_list_background')
      rows.push(head)
      for (const id of list) {
        const def = catalog.quest(id)
        const p = quests.active.get(id)
        const open = this.expanded.has(id)
        const row = el('div', 'qst-row')
        if (art.has('quest/qst_subjectwindo')) row.style.backgroundImage = art.cssUrl('quest/qst_subjectwindo')
        if (id === this.selected) row.classList.add('on')
        const toggleKey = open ? 'quest/qst_list_close_button' : 'quest/qst_list_open_button'
        const toggle = iconButton(art, toggleKey, { title: t(open ? 'quest.win.collapse' : 'quest.win.expand'), fallbackText: open ? '-' : '+', w: 12, h: 12, className: 'qst-toggle' }, ev => {
          ev.stopPropagation()
          if (open) this.expanded.delete(id)
          else this.expanded.add(id)
          this.render()
        })
        const bar = el('div', `qst-bar ${questBar(p, !!def?.disabled)}`)
        const barKey = `quest/qst_colorbar_${questBar(p, !!def?.disabled)}`
        if (art.has(barKey)) bar.style.backgroundImage = art.cssUrl(barKey)
        const title = el('div', 'qst-title kit-fit', this.title(id))
        const lv = el('div', 'qst-level kit-num', def ? t('quest.log.lv', { level: def.level }) : '')
        row.append(place(toggle, [6, 8, 12, 12]), place(bar, [21, 4, 220, 20]), place(title, [28, 7, 210, 15]), place(lv, [244, 7, 50, 15]))
        if (!this.showDone) {
          const tracked = this.deps.isTracked(id)
          const check = el('button', `qst-check${tracked ? ' on' : ''}`)
          check.type = 'button'
          check.title = t(tracked ? 'quest.untrack' : 'quest.track')
          check.setAttribute('aria-pressed', String(tracked))
          if (art.has('quest/qst_checkbutton_on')) {
            check.style.setProperty('--on', art.cssUrl('quest/qst_checkbutton_on'))
            check.style.setProperty('--off', art.cssUrl('quest/qst_checkbutton_off'))
          } else check.classList.add('no-art')
          check.addEventListener('click', ev => {
            ev.stopPropagation()
            this.deps.setTracked(id, !tracked)
            this.render()
          })
          row.append(place(check, [296, 6, 16, 16]))
        }
        const view = iconButton(art, 'quest/qst_contentview_button', { title: t('quest.win.detail'), fallbackText: '?', w: 20, h: 20, className: 'qst-view' }, ev => {
          ev.stopPropagation()
          this.selected = id
          this.viewing = id
          this.render()
        })
        row.append(place(view, [316, 4, 20, 20]))
        row.addEventListener('click', () => {
          this.selected = id
          if (open) this.expanded.delete(id)
          else this.expanded.add(id)
          this.render()
        })
        row.addEventListener('dblclick', () => {
          this.viewing = id
          this.render()
        })
        rows.push(row)
        if (open) {
          const sub = el('div', 'qst-sub')
          if (p && def) for (const v of objectiveViews(def, p, catalog, names)) sub.append(el('div', `qst-objective${v.done ? ' done' : ''}${v.locked ? ' locked' : ''}`, v.text))
          if (p?.status === 'ready' && def && !def.disabled) sub.append(el('div', 'qst-objective ready', t('quest.log.readyLine', { npc: names.npc(def.turnIn) })))
          if (!p) {
            const d = quests.done.get(id)
            if (d) sub.append(el('div', 'qst-objective done', d.times > 1 ? t('quest.log.doneTimes', { n: d.times }) : t('quest.log.doneOnce')))
          }
          if (!sub.childElementCount && def) sub.append(el('div', 'qst-objective', def.summary.replace(/\{name\}/g, this.deps.reader().name)))
          rows.push(sub)
        }
      }
    }
    this.list.view.replaceChildren(...rows)
  }

  private renderDetail(id: string): void {
    const { catalog, quests, names } = this.deps
    this.buttons.replaceChildren()
    this.useBtn = null
    const def = catalog.quest(id)
    const p = quests.active.get(id) ?? null
    const who = this.deps.reader()
    this.detailTitle.textContent = this.title(id)
    this.detailTitle.title = this.title(id)
    const parts: HTMLElement[] = []
    const back = button(this.art, { label: t('quest.win.back'), skin: 'small' }, () => {
      this.viewing = null
      this.render()
    })
    if (!def) {
      parts.push(el('div', 'quest-page-note', this.deps.catalogLoaded() ? t('quest.withdrawn') : t('quest.log.loading')))
      this.detail.view.replaceChildren(...parts)
      this.buttons.append(back)
      if (p) this.addButtons(id, null, p)
      return
    }
    const meta = [t(`quest.kind.${def.kind}`), t('quest.log.level', { level: def.level })]
    if (def.party) meta.push(t('quest.partyRecommended'))
    parts.push(el('div', 'quest-log-meta', meta.join('  ·  ')))
    parts.push(el('div', 'quest-log-route', t('quest.log.route', { giver: names.npc(def.giver), turnIn: names.npc(def.turnIn) })))
    if (def.disabled) parts.push(el('div', 'quest-page-note warn', t('quest.withdrawn')))
    parts.push(el('p', 'quest-page-text', def.summary.replace(/\{name\}/g, who.name)))
    if (p) {
      parts.push(el('div', 'quest-section', t('quest.log.objectives')))
      for (const v of objectiveViews(def, p, catalog, names)) parts.push(el('div', `quest-objective${v.done ? ' done' : ''}${v.locked ? ' locked' : ''}`, v.text))
      if (p.status === 'ready' && !def.disabled) parts.push(el('div', 'quest-log-ready', t('quest.log.readyLine', { npc: names.npc(def.turnIn) })))
      const held = p.items.filter(i => i.count > 0)
      if (held.length) {
        parts.push(el('div', 'quest-section', t('quest.log.items')))
        parts.push(el('div', 'quest-item-row', ...held.map(i => itemCell(this.deps, { code: i.code, name: names.item(i.code), icon: names.icon(i.code), count: i.count }))))
      }
    } else {
      const d = quests.done.get(id)
      if (d) parts.push(el('div', 'quest-page-note', d.times > 1 ? t('quest.log.doneTimes', { n: d.times }) : t('quest.log.doneOnce')))
      const cd = cooldownNote(def, quests, this.deps.now())
      if (cd) parts.push(el('div', 'quest-page-note', cd))
    }
    parts.push(rewardsBlock(this.deps, rewardsView(def, who, this.deps.expToNext, names)))
    this.detail.view.replaceChildren(...parts)
    this.buttons.append(back)
    if (p) this.addButtons(id, def, p)
  }

  private addButtons(id: string, def: QuestDef | null, p: QuestProgress): void {
    const art = this.art
    const tracked = this.deps.isTracked(id)
    const track = button(art, { label: t(tracked ? 'quest.untrack' : 'quest.track') }, () => {
      this.deps.setTracked(id, !tracked)
      this.render()
    })
    const abandon = button(art, { label: t('quest.abandon') }, () => this.deps.abandon(id))
    const row: HTMLElement[] = [track, abandon]
    const use = def && !def.disabled ? usableObjective(def, p, this.deps.now()) : null
    if (use) {
      const b = button(art, { label: t('quest.use'), primary: true }, () => {
        if (!b.isDisabled) this.deps.use(id, use.id)
      })
      this.useBtn = { btn: b, o: use }
      this.updateUse()
      row.unshift(b)
    }
    this.buttons.append(el('div', 'qst-buttons-right', ...row))
  }

  /** Enables the Use button inside the objective's place (call as the player moves). */
  updateUse(): void {
    const u = this.useBtn
    if (!u || !u.btn.isConnected) return
    const ok = this.deps.canUse(u.o)
    if (u.btn.isDisabled === !ok) return
    u.btn.setDisabled(!ok)
    u.btn.title = ok ? '' : t('quest.useHint', { place: this.deps.catalog.location(u.o.location)?.name ?? u.o.location })
  }
}
