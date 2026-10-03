/**
 * The quest pages inside the NPC dialog (docs/QUESTS.md §2.3; WAVE_PLAN decision 1). The shops lane's NpcDialogWindow
 * calls our handler (`setNpcQuestHandler`) when the player picks "Talk to this person."; this adapter then:
 * - lists the NPC's quest topics as the dialog's own option lines (one topic opens directly);
 * - draws a topic's page in a quest-owned panel docked over the dialog body (text, objectives, rewards with a
 *   selectable choice, buttons), growing the window a little while it shows;
 * - after Accept / Hand over / Complete waits for the server (`questUpdate` of that quest, or a refusal) and then moves
 *   on: the NPC's remaining topics, else back to its services.
 * The panel goes away as soon as the dialog draws anything else (Back, a new conversation, the server closing it).
 */
import type { NpcDialogOption, NpcTalkContext } from '../hud/npc-dialog.ts'
import type { TooltipLine } from '../hud/items.ts'
import type { Tooltip } from '../hud/slots.ts'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import type { NpcDialogContext, NpcDialogPage, NpcDialogPager, NpcDialogTopic, PageRewards } from './dialog.ts'
import { formatAmount, type RewardView } from './format.ts'
import { ensureQuestStyles } from './style.ts'

/** After this long without an answer, a waiting page gives up and moves on. */
const WAIT_MS = 5000

/** Item icons with tooltips (rewards, quest items). */
export interface IconDeps {
  art: Art
  tooltip: Pick<Tooltip, 'show' | 'move' | 'hide'>
  /** Tooltip lines of an item or quest item code. */
  tip(code: string, count: number): TooltipLine[]
}

/** One 36 px item cell: icon (or the name's first letter), count, tooltip on hover; `onClick` makes it selectable. */
export function itemCell(deps: IconDeps, r: Pick<RewardView, 'code' | 'name' | 'icon' | 'count'>, onClick?: () => void): HTMLElement {
  const cell: HTMLElement = onClick ? el('button', 'quest-item-cell') : el('div', 'quest-item-cell')
  if (onClick) (cell as HTMLButtonElement).type = 'button'
  const icon = el('span', 'quest-item-icon')
  if (r.icon) icon.style.backgroundImage = `url("${r.icon}")`
  else {
    icon.classList.add('fallback')
    icon.textContent = (r.name.trim()[0] ?? '?').toUpperCase()
  }
  cell.append(icon)
  if (r.count > 1) cell.append(el('span', 'quest-item-count', formatAmount(r.count)))
  cell.setAttribute('aria-label', r.count > 1 ? `${r.name} x${r.count}` : r.name)
  cell.addEventListener('pointerenter', ev => deps.tooltip.show(deps.tip(r.code, r.count), ev.clientX, ev.clientY))
  cell.addEventListener('pointermove', ev => deps.tooltip.move(ev.clientX, ev.clientY))
  cell.addEventListener('pointerleave', () => deps.tooltip.hide())
  if (onClick) {
    cell.addEventListener('click', () => {
      deps.tooltip.hide()
      onClick()
    })
  }
  return cell
}

/** The rewards block: "120 EXP · 1 SP · 150 gold", the fixed items, and the choice cells. */
export function rewardsBlock(deps: IconDeps, r: PageRewards): HTMLElement {
  const box = el('div', 'quest-rewards')
  box.append(el('div', 'quest-section', t('quest.rewards')))
  const parts: string[] = []
  if (r.exp > 0) parts.push(t('quest.exp', { n: formatAmount(r.exp) }))
  if (r.sp > 0) parts.push(t('quest.sp', { n: formatAmount(r.sp) }))
  if (r.gold > 0) parts.push(t('quest.gold', { n: formatAmount(r.gold) }))
  if (parts.length) box.append(el('div', 'quest-reward-line', parts.join('  ·  ')))
  if (r.items.length) box.append(el('div', 'quest-item-row', ...r.items.map(i => itemCell(deps, i))))
  if (r.choice.length) {
    box.append(el('div', 'quest-choose', t('quest.choose')))
    const row = el('div', 'quest-item-row choice')
    r.choice.forEach((c, i) => {
      const cell = itemCell(deps, c, r.choose ? () => r.choose!(i) : undefined)
      if (r.chosen === i) cell.classList.add('chosen')
      row.append(cell)
    })
    box.append(row)
  }
  return box
}

/** What the adapter needs of the NPC dialog window (NpcDialogWindow). */
export type QuestDialogHost = Pick<NpcTalkContext['dialog'], 'root' | 'body' | 'setContent' | 'showServices' | 'close' | 'talk' | 'isOpen'>

/** The panel docked over the dialog body. */
export class QuestDialogPanel {
  readonly root: HTMLElement
  private readonly scroll: HTMLElement
  private readonly footer: HTMLElement
  private observer: MutationObserver | null = null

  constructor(private readonly dialog: QuestDialogHost, private readonly deps: IconDeps) {
    ensureQuestStyles()
    this.scroll = el('div', 'quest-page-scroll')
    this.footer = el('div', 'quest-page-buttons')
    this.root = el('div', 'quest-page', this.scroll, this.footer)
  }

  get attached(): boolean {
    return this.root.isConnected
  }

  /** Draws `page`; `waiting` greys the buttons while a request is out. */
  render(page: NpcDialogPage, waiting: boolean): void {
    const d = this.dialog
    // Clear the host's text and option lines; the panel covers the body.
    d.setContent('', [])
    const parts: HTMLElement[] = [el('div', 'quest-page-title', page.title)]
    for (const p of page.paragraphs) parts.push(el('p', 'quest-page-text', p))
    for (const n of page.notes ?? []) parts.push(el('div', 'quest-page-note', n))
    if (page.objectives?.length) {
      parts.push(el('div', 'quest-section', t('quest.log.objectives')))
      for (const o of page.objectives) parts.push(el('div', `quest-objective${o.done ? ' done' : ''}${o.locked ? ' locked' : ''}`, o.text))
    }
    if (page.rewards) parts.push(rewardsBlock(this.deps, page.rewards))
    this.scroll.replaceChildren(...parts)
    this.scroll.scrollTop = 0
    this.footer.replaceChildren(
      ...page.buttons.map(b => {
        const btn = button(this.deps.art, { label: b.label, minWidth: 84, primary: b.kind === 'primary' })
        btn.setDisabled(waiting || !!b.disabled)
        btn.addEventListener('click', () => {
          if (btn.isDisabled) return
          this.deps.tooltip.hide()
          try {
            b.onClick()
          } catch (err) {
            console.error('[quests] dialog button failed', err)
          }
        })
        return btn
      }),
    )
    if (waiting) this.footer.append(el('span', 'quest-page-wait', t('quest.waiting')))
    if (!this.attached) {
      d.body.append(this.root)
      d.root.classList.add('quest-mode')
      // Retail quest pages are printed on paper (guide/gd_paper_02) under the qst_subwindow_title bar.
      const art = this.deps.art
      if (art.has('guide/gd_paper_02')) this.root.style.setProperty('--quest-paper', art.cssUrl('guide/gd_paper_02'))
      if (art.has('quest/qst_subwindow_title')) this.root.style.setProperty('--quest-title', art.cssUrl('quest/qst_subwindow_title'))
      this.watch()
    }
  }

  /** Removes the panel (the dialog shows its own content again). */
  detach(): void {
    this.observer?.disconnect()
    this.observer = null
    this.deps.tooltip.hide()
    this.dialog.root.classList.remove('quest-mode')
    this.root.remove()
  }

  /** The host drew option lines of its own (services, a new NPC): the panel steps aside. */
  private watch(): void {
    if (typeof MutationObserver === 'undefined') return
    const options = this.dialog.body.querySelector('.npc-options')
    if (!options) return
    this.observer = new MutationObserver(() => {
      if (options.childElementCount > 0) this.detach()
    })
    this.observer.observe(options, { childList: true })
  }

  dispose(): void {
    this.detach()
  }
}

/**
 * One conversation's quest flow: topic list, pages, waiting for the server. Created once per world visit;
 * `open(talk)` is the NPC dialog's quest handler.
 */
export class QuestDialogController implements NpcDialogPager {
  private talk: NpcTalkContext | null = null
  private page: NpcDialogPage | null = null
  /** The topic list was shown in this conversation (Back returns to it). */
  private listed = false
  private pending: { quest: string; at: number } | null = null

  constructor(
    private readonly panel: QuestDialogPanel,
    /** The topics of an NPC right now. */
    private readonly topicsOf: (ctx: NpcDialogContext) => NpcDialogTopic[],
    /** The "nothing to tell" page (no topics). */
    private readonly nothing: (talk: NpcTalkContext) => void,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** The conversation still shown by the dialog (a newer one replaces it). */
  private live(): NpcTalkContext | null {
    const talk = this.talk
    if (!talk || talk.dialog.talk !== talk || !talk.dialog.isOpen) return null
    return talk
  }

  private ctxOf(talk: NpcTalkContext): NpcDialogContext {
    return { npcId: talk.npc, npcCode: talk.code, npcName: talk.name }
  }

  /** Entry point: the player picked the quest option of `talk`. */
  open(talk: NpcTalkContext): void {
    this.talk = talk
    this.pending = null
    this.listed = false
    this.page = null
    this.flow(true)
  }

  /** Shows the topics: none -> the "nothing" page (first time) or the services; one -> its page; more -> the list. */
  private flow(first: boolean): void {
    const talk = this.live()
    if (!talk) return
    const topics = this.topicsOf(this.ctxOf(talk))
    if (!topics.length) {
      this.page = null
      this.panel.detach()
      if (first) this.nothing(talk)
      else talk.dialog.showServices()
      return
    }
    if (topics.length === 1 && !this.listed) {
      topics[0]!.open(this)
      return
    }
    this.list(talk, topics)
  }

  private list(talk: NpcTalkContext, topics: NpcDialogTopic[]): void {
    this.listed = true
    this.page = null
    this.panel.detach()
    const lines: NpcDialogOption[] = topics.map(tp => ({ label: tp.label, run: () => tp.open(this) }))
    lines.push({ label: t('quest.back'), run: () => talk.dialog.showServices() })
    lines.push({ label: t('npc.option.end'), run: () => talk.dialog.close(), end: true })
    talk.dialog.setContent(t('quest.topics'), lines)
  }

  // ---- NpcDialogPager ----
  show(page: NpcDialogPage): void {
    if (!this.live()) return
    this.page = page
    this.panel.render(page, this.pending !== null)
  }

  back(): void {
    const talk = this.live()
    if (!talk) return
    this.page = null
    this.pending = null
    if (this.listed) this.flow(false)
    else {
      this.panel.detach()
      talk.dialog.showServices()
    }
  }

  close(): void {
    this.live()?.dialog.close()
  }

  // ---- the server's side ----
  /** A request for `quest` went out from the current page: grey it until the answer. */
  sent(quest: string): void {
    if (!this.live() || !this.page) return
    this.pending = { quest, at: this.clock() }
    this.panel.render(this.page, true)
  }

  get waiting(): boolean {
    return this.pending !== null
  }

  /** A `questUpdate` arrived: the pending request is done (move on), or redraw the page with the new counts. */
  questChanged(quest: string): void {
    if (!this.live()) return
    if (this.pending) {
      if (this.pending.quest !== quest) return
      this.pending = null
      this.flow(false)
      return
    }
    if (this.page && this.panel.attached && this.page.key.split(':')[1] === quest) this.redraw()
  }

  /** A quest request was refused (the HUD toasts why): the page comes back as it was. */
  refused(): void {
    if (!this.pending) return
    this.pending = null
    if (this.live() && this.page) this.panel.render(this.page, false)
  }

  /** The catalog or level changed: redraw the page when it still exists (else back to the topics). */
  redraw(): void {
    const talk = this.live()
    if (!talk || !this.page || this.pending || !this.panel.attached) return
    const key = this.page.key
    const topic = this.topicsOf(this.ctxOf(talk)).find(tp => tp.key === key)
    if (topic) topic.open(this)
    else this.flow(false)
  }

  /** Call now and then: a request without an answer for WAIT_MS stops waiting. */
  tick(): void {
    if (this.pending && this.clock() - this.pending.at > WAIT_MS) {
      this.pending = null
      this.flow(false)
    }
  }

  /** The conversation ended (server close, new NPC, world left). */
  reset(): void {
    this.talk = null
    this.page = null
    this.pending = null
    this.listed = false
    this.panel.detach()
  }
}
