/**
 * The Quest Editor window (docs/QUESTS.md §5.4; lane ED-C), opened from the GM window's Quests tab.
 * - Left: every quest (`GET /api/gm/quests`) with filters (chapter, source, issues, search).
 * - Right: a form over the quest schema (quest-form.ts), with NPC / mob / item / location pickers ("Target" takes the
 *   NPC you are targeting, "Here" makes a location at your position), prerequisites, objectives (add, remove, reorder,
 *   the type selector swaps the fields), rewards (EXP suggestion, SP from EXP, {G}/{ARMOR} preview), the three dialog
 *   texts with a preview in the NPC dialog's style, and the quest items and locations this quest adds.
 * - Buttons: Validate (POST validate), Save & reload (PUT: hot reload, players see it without relogging), Revert to repo
 *   (DELETE), Disable / Enable. Issues are listed; clicking one focuses its field.
 * The quest bodies come from `GET /api/quests` (the merged catalog the players use). Nothing here touches roles.
 */
import {
  QUEST_ID,
  QUEST_KINDS,
  QUEST_LOCATION_ID,
  type ApiGmQuestList,
  type ApiGmQuestPut,
  type ContentChangeKind,
  type ItemDef,
  type LevelDef,
  type MobDef,
  type NpcDef,
  type QuestDef,
  type QuestFile,
  type QuestIssue,
  type QuestItemDef,
  type QuestKind,
  type QuestLocation,
  type QuestObjectiveType,
} from '@sro/shared'
import { t } from '../../i18n/index.ts'
import type { Art } from '../../ui/art.ts'
import { el, Listeners } from '../../ui/dom.ts'
import type { GmTab, GmTabApi } from '../window.ts'
import type { GmQuestApi } from './api.ts'
import {
  OBJECTIVE_TYPES,
  cloneForm,
  emptyEncounter,
  emptyObjective,
  fieldFor,
  fixAfter,
  formToQuest,
  freeId,
  freeObjectiveId,
  issueKey,
  issueTarget,
  itemOut,
  itemToForm,
  locationOut,
  locationToForm,
  moveObjective,
  newQuestForm,
  objectiveFields,
  questToForm,
  rewardPreview,
  sortIssues,
  stableJson,
  suggestExp,
  suggestSp,
  type ItemForm,
  type LocationForm,
  type ObjectiveForm,
  type QuestForm,
  type RewardForm,
} from './quest-form.ts'
import { edArea, edButton, edCheck, edDatalist, edField, edSection, edSelect, edSmall, fillDatalist, miniButton, setOptions, srcLabel } from './ui.ts'

export interface QuestEditorDeps {
  art: Art
  /** Where the window lives (the world screen root). */
  parent: HTMLElement
  api: GmQuestApi
  content(): { mobs: ReadonlyMap<string, MobDef>; items: ReadonlyMap<string, ItemDef>; npcs: ReadonlyMap<string, NpcDef>; levels: readonly LevelDef[] }
  selfPos(): { x: number; z: number } | null
  selfName(): string
  /** NPC identity of the GM's target (`state.npc ?? state.model`), when it is an NPC. */
  targetNpc(): string | null
  /** No game server (?mock=1): the editor has nothing to talk to. */
  offline: boolean
}

type ListEntry = ApiGmQuestList['quests'][number]

interface Current {
  id: string
  isNew: boolean
  /** The rev the edit started from (the quest's own rev; 0 for a new quest). */
  baseRev: number
  source: 'repo' | 'override' | 'new'
  form: QuestForm
  items: ItemForm[]
  locations: LocationForm[]
  /** stableJson of the last loaded / saved state (unsaved changes = differs). */
  snapshot: string
}

const W = 880
const H = 600
const STORE_KEY = 'sro.gm.questEditor'
const CONFIRM_MS = 4000

const KIND_LABEL: Record<QuestKind, () => string> = {
  main: () => t('gm.qe.kind.main'),
  side: () => t('gm.qe.kind.side'),
  repeatable: () => t('gm.qe.kind.repeatable'),
}

function typeLabel(type: QuestObjectiveType): string {
  switch (type) {
    case 'kill':
      return t('gm.qe.obj.kill')
    case 'collect':
      return t('gm.qe.obj.collect')
    case 'talk':
      return t('gm.qe.obj.talk')
    case 'deliver':
      return t('gm.qe.obj.deliver')
    case 'have':
      return t('gm.qe.obj.have')
    case 'reach':
      return t('gm.qe.obj.reach')
    case 'useItem':
      return t('gm.qe.obj.useItem')
  }
}

export class QuestEditorWindow {
  readonly root: HTMLElement
  private readonly ls = new Listeners()
  private openState = false
  private x: number
  private y: number
  private disposed = false

  // data
  private list: ApiGmQuestList | null = null
  private files: QuestFile[] = []
  private defs = new Map<string, { def: QuestDef; file: QuestFile }>()
  private qitems = new Map<string, QuestItemDef>()
  private locs = new Map<string, QuestLocation>()
  private cur: Current | null = null
  private issues: QuestIssue[] = []
  private loading: Promise<void> | null = null
  private busy = false
  private armed: { what: string; until: number } | null = null
  private previewKey: 'offer' | 'progress' | 'complete' = 'offer'

  // view
  private readonly listEl: HTMLElement
  private readonly chapterSel: HTMLSelectElement
  private readonly sourceSel: HTMLSelectElement
  private readonly issuesBox: HTMLInputElement
  private readonly search: HTMLInputElement
  private readonly form: HTMLElement
  private readonly issuesEl: HTMLElement
  private readonly status: HTMLElement
  private readonly dirtyEl: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly validateB: HTMLButtonElement
  private readonly saveB: HTMLButtonElement
  private readonly revertB: HTMLButtonElement
  private readonly disableB: HTMLButtonElement
  private readonly fields = new Map<string, HTMLElement>()
  private previewEl: HTMLElement | null = null
  // pickers (datalists live in the window root)
  private readonly npcList: HTMLDataListElement
  private readonly mobList: HTMLDataListElement
  private readonly qitemList: HTMLDataListElement
  private readonly itemList: HTMLDataListElement
  private readonly allItemList: HTMLDataListElement
  private readonly chapterList: HTMLDataListElement
  private pickersLoaded = false

  constructor(private readonly deps: QuestEditorDeps) {
    const art = deps.art
    const saved = loadPos()
    this.x = saved?.x ?? Math.max(8, Math.round((window.innerWidth - W) / 2))
    this.y = saved?.y ?? 60

    this.root = el('div', 'gm-window gm-qe')
    // The editor handles Esc itself (blur a field, else close): the HUD's close-the-top-window rule leaves it alone.
    this.root.dataset.ownEsc = ''
    this.root.style.width = `${W}px`
    this.root.style.height = `${H}px`
    if (art.has('outer/unity_window')) this.root.style.setProperty('--frame', art.cssUrl('outer/unity_window'))
    else this.root.classList.add('no-art')
    this.root.hidden = true

    this.titleEl = el('span', 'gm-title', t('gm.qe.title'))
    const close = el('button', 'gm-close')
    close.type = 'button'
    close.title = t('gm.close')
    close.setAttribute('aria-label', t('gm.close'))
    if (art.has('ifcommon/com_windowclose')) {
      close.style.setProperty('--img', art.cssUrl('ifcommon/com_windowclose'))
      close.style.setProperty('--img-focus', art.cssUrl(art.has('ifcommon/com_windowclose_focus') ? 'ifcommon/com_windowclose_focus' : 'ifcommon/com_windowclose'))
      close.style.setProperty('--img-press', art.cssUrl(art.has('ifcommon/com_windowclose_press') ? 'ifcommon/com_windowclose_press' : 'ifcommon/com_windowclose'))
    } else {
      close.classList.add('no-art')
      close.textContent = 'x'
    }
    this.ls.on(close, 'click', () => this.close())
    const header = el('div', 'gm-header', this.titleEl, close)
    this.setupDrag(header)

    // ---- left: the quest list ----
    this.chapterSel = edSelect([['', t('gm.qe.filter.allChapters')]])
    this.sourceSel = edSelect([
      ['', t('gm.qe.filter.allSources')],
      ['repo', t('gm.editor.src.repo')],
      ['override', t('gm.editor.src.override')],
    ])
    const issues = edCheck(t('gm.qe.filter.issues'))
    this.issuesBox = issues.box
    this.search = edField('', t('gm.qe.filter.search'))
    this.search.placeholder = t('gm.qe.filter.search')
    for (const f of [this.chapterSel, this.sourceSel, this.issuesBox]) this.ls.on(f, 'change', () => this.renderList())
    this.ls.on(this.search, 'input', () => this.renderList())
    const refresh = edSmall(art, t('gm.editor.refresh'), 58)
    this.ls.on(refresh, 'click', () => void this.reload(true))
    const newQ = edSmall(art, t('gm.qe.new'), 58, t('gm.qe.newHint'))
    this.ls.on(newQ, 'click', () => this.newQuest())
    this.listEl = el('div', 'gm-list')
    const left = el('div', 'gm-qe-left', el('div', 'gm-qe-filters', this.search, this.chapterSel, this.sourceSel, issues.root), this.listEl, el('div', 'gm-line', refresh, newQ))

    // ---- right: the form ----
    this.form = el('div', 'gm-qe-form', el('div', 'gm-qe-empty', t('gm.qe.pick')))
    this.issuesEl = el('div', 'gm-qe-issues')
    this.issuesEl.hidden = true
    this.validateB = edButton(art, t('gm.qe.validate'), 76, t('gm.qe.validateHint'))
    this.saveB = edButton(art, t('gm.qe.save'), 104, t('gm.qe.saveHint'))
    this.revertB = edButton(art, t('gm.qe.revert'), 104, t('gm.qe.revertHint'))
    this.disableB = edButton(art, t('gm.qe.disable'), 72)
    this.dirtyEl = el('span', 'gm-qe-dirty')
    this.ls.on(this.validateB, 'click', () => void this.validate())
    this.ls.on(this.saveB, 'click', () => void this.save())
    this.ls.on(this.revertB, 'click', () => void this.revert())
    this.ls.on(this.disableB, 'click', () => void this.toggleDisabled())
    const actions = el('div', 'gm-qe-actions', this.validateB, this.saveB, this.revertB, this.disableB, el('span', 'spacer'), this.dirtyEl)
    const right = el('div', 'gm-qe-right', this.form, this.issuesEl, actions)

    this.status = el('div', 'gm-status')
    this.npcList = edDatalist('gm-qe-npcs')
    this.mobList = edDatalist('gm-qe-mobs')
    this.qitemList = edDatalist('gm-qe-qitems')
    this.itemList = edDatalist('gm-qe-items')
    this.allItemList = edDatalist('gm-qe-allitems')
    this.chapterList = edDatalist('gm-qe-chapters')
    this.root.append(header, el('div', 'gm-qe-main', left, right), this.status, this.npcList, this.mobList, this.qitemList, this.itemList, this.allItemList, this.chapterList)

    // Keys typed in the editor stay in the editor.
    this.ls.on(this.root, 'keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Escape') {
        const a = document.activeElement as HTMLElement | null
        if (a && this.root.contains(a)) a.blur()
        else this.close()
      }
      if (ev.key === 's' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault()
        void this.save()
      }
    })
    this.ls.on(this.root, 'keyup', ev => ev.stopPropagation())
    this.ls.on(window, 'resize', () => this.applyPosition())
    deps.parent.append(this.root)
    this.syncButtons()
  }

  get isOpen(): boolean {
    return this.openState
  }

  /** Opens the window (on quest `id`, when given). */
  open(id?: string): void {
    if (!this.openState) {
      this.openState = true
      this.root.hidden = false
      this.applyPosition()
      this.loadPickers()
    }
    if (this.deps.offline) {
      this.setStatus(t('gm.qe.offline'), true)
      return
    }
    void this.reload(false).then(() => {
      if (id) this.pick(id)
    })
  }

  close(): void {
    if (!this.openState) return
    this.openState = false
    this.root.hidden = true
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }

  /** `contentChanged`: another GM saved, or a reload. Refreshes the list; the open quest too when it has no edits. */
  contentChanged(kind: ContentChangeKind): void {
    if (kind !== 'quests' || !this.openState || this.deps.offline) return
    void this.reload(true)
  }

  dispose(): void {
    this.disposed = true
    this.close()
    this.ls.clear()
    this.root.remove()
  }

  // ---- data ------------------------------------------------------------------------------------------------

  /** Loads the list and the catalog (once, or again with `force`). */
  private reload(force: boolean): Promise<void> {
    if (this.loading) return this.loading
    if (!force && this.list) return Promise.resolve()
    this.loading = (async () => {
      const [list, cat] = await Promise.all([this.deps.api.list(), this.deps.api.catalog()])
      if (this.disposed) return
      if (!list.ok) {
        this.setStatus(list.message, true)
        if (!this.list) this.listEl.replaceChildren(el('div', 'gm-empty', list.message))
        return
      }
      this.list = list.data
      if (cat.ok) this.setCatalog(cat.data.files)
      else this.setStatus(cat.message, true)
      this.renderChapters()
      this.renderList()
      // The open quest follows the server when it has no unsaved edits.
      const cur = this.cur
      if (cur && !cur.isNew && !this.dirty()) {
        const entry = this.entry(cur.id)
        if (entry && this.defs.has(cur.id)) this.load(cur.id, true)
        else if (entry) {
          cur.baseRev = entry.rev
          cur.source = entry.source
        }
      } else if (cur && !cur.isNew) {
        const entry = this.entry(cur.id)
        if (entry && entry.rev !== cur.baseRev) this.setStatus(t('gm.qe.changedMeanwhile', { id: cur.id }), true)
      }
      this.syncButtons()
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private setCatalog(files: QuestFile[]): void {
    this.files = files
    this.defs.clear()
    this.qitems.clear()
    this.locs.clear()
    for (const f of files) {
      for (const q of f.quests ?? []) this.defs.set(q.id, { def: q, file: f })
      for (const i of f.items ?? []) this.qitems.set(i.code, i)
      for (const l of f.locations ?? []) this.locs.set(l.id, l)
    }
    this.fillQuestItemList()
  }

  private entry(id: string): ListEntry | undefined {
    return this.list?.quests.find(q => q.id === id)
  }

  // ---- list ------------------------------------------------------------------------------------------------

  private renderChapters(): void {
    const chapters = new Set<string>()
    for (const { def } of this.defs.values()) if (def.chapter) chapters.add(def.chapter)
    setOptions(this.chapterSel, [['', t('gm.qe.filter.allChapters')], ...[...chapters].map(c => [c, c] as [string, string])])
    fillDatalist(
      this.chapterList,
      [...chapters].map(c => [c, c] as [string, string]),
    )
  }

  private renderList(): void {
    this.listEl.replaceChildren()
    const quests = this.list?.quests ?? []
    const chapter = this.chapterSel.value
    const source = this.sourceSel.value
    const onlyIssues = this.issuesBox.checked
    const q = this.search.value.trim().toLowerCase()
    const shown = quests.filter(e => {
      if (chapter && this.defs.get(e.id)?.def.chapter !== chapter) return false
      if (source && e.source !== source) return false
      if (onlyIssues && !e.issues.length) return false
      if (q && !e.id.toLowerCase().includes(q) && !e.title.toLowerCase().includes(q)) return false
      return true
    })
    if (!shown.length) {
      this.listEl.append(el('div', 'gm-empty', this.list ? t('gm.qe.noMatch') : t('gm.editor.loading')))
      return
    }
    for (const e of shown) {
      const errors = e.issues.filter(i => i.severity === 'error').length
      const warnings = e.issues.length - errors
      const badges = el(
        'span',
        'badges',
        e.source === 'override' ? el('span', 'gm-ed-src override', srcLabel('override')) : null,
        e.disabled ? el('span', 'gm-ed-src disabled', srcLabel('disabled')) : null,
        errors ? el('span', 'gm-qe-issues-n', `!${errors}`) : null,
        warnings ? el('span', 'gm-qe-warn-n', `?${warnings}`) : null,
        this.defs.has(e.id) ? null : el('span', 'gm-qe-issues-n', t('gm.qe.notLoaded')),
      )
      const row = el('div', `gm-qe-qrow${this.cur?.id === e.id ? ' selected' : ''}${e.disabled ? ' off' : ''}`, badges, el('span', 'id', e.id), el('span', 'title', e.title))
      row.title = `${e.id} (${e.file}, rev ${e.rev})`
      row.dataset.id = e.id
      this.ls.on(row, 'click', () => this.pick(e.id))
      this.listEl.append(row)
    }
  }

  /** A click in the list: asks once before dropping unsaved edits. */
  private pick(id: string): void {
    if (this.cur?.id === id && !this.cur.isNew) return
    if (this.dirty() && !this.confirm('switch', t('gm.qe.discardFirst', { id: this.cur!.id }))) return
    this.load(id)
  }

  private newQuest(): void {
    if (this.deps.offline) return this.setStatus(t('gm.qe.offline'), true)
    if (this.dirty() && !this.confirm('new', t('gm.qe.discardFirst', { id: this.cur!.id }))) return
    const used = new Set<string>([...(this.list?.quests.map(q => q.id) ?? []), ...this.defs.keys()])
    const id = freeId('GM_QUEST', used)
    const npc = this.deps.targetNpc() ?? ''
    const form = newQuestForm(id, npc)
    this.cur = { id, isNew: true, baseRev: 0, source: 'new', form, items: [], locations: [], snapshot: '' }
    this.cur.snapshot = this.snapshotOf(this.cur)
    this.issues = []
    this.renderForm()
    this.renderList()
    this.setStatus(t('gm.qe.newStarted', { id }))
  }

  /** Loads quest `id` into the form (from the catalog). */
  private load(id: string, keepStatus = false): void {
    const entry = this.entry(id)
    const found = this.defs.get(id)
    if (!found) {
      this.setStatus(t('gm.qe.cannotLoad', { id }), true)
      return
    }
    // Quest items and locations this quest's own override file adds (override files are named after their quest).
    const local = this.files.find(f => f.id === id)
    this.cur = {
      id,
      isNew: false,
      baseRev: entry?.rev ?? found.def.rev ?? 0,
      source: entry?.source ?? 'repo',
      form: questToForm(found.def),
      items: (local?.items ?? []).map(itemToForm),
      locations: (local?.locations ?? []).map(locationToForm),
      snapshot: '',
    }
    this.cur.snapshot = this.snapshotOf(this.cur)
    this.issues = entry?.issues ?? []
    this.renderForm()
    this.renderIssues()
    this.renderList()
    if (!keepStatus) this.setStatus(t('gm.qe.loaded', { id, source: srcLabel(this.cur.source === 'new' ? 'override' : this.cur.source), rev: this.cur.baseRev }))
  }

  // ---- state helpers ---------------------------------------------------------------------------------------

  private body(c: Current): ApiGmQuestPut {
    return { quest: formToQuest(c.form), items: c.items.map(itemOut), locations: c.locations.map(locationOut), baseRev: c.baseRev }
  }

  private snapshotOf(c: Current): string {
    const b = this.body(c)
    return stableJson({ quest: b.quest, items: b.items, locations: b.locations })
  }

  private dirty(): boolean {
    return !!this.cur && this.snapshotOf(this.cur) !== this.cur.snapshot
  }

  /** Two-click confirmation: true when `what` was asked for within the last few seconds. */
  private confirm(what: string, ask: string): boolean {
    const now = Date.now()
    if (this.armed && this.armed.what === what && now < this.armed.until) {
      this.armed = null
      return true
    }
    this.armed = { what, until: now + CONFIRM_MS }
    this.setStatus(ask, true)
    return false
  }

  private touched(): void {
    this.dirtyEl.textContent = this.dirty() ? t('gm.qe.unsaved') : ''
    this.updatePreview()
  }

  private syncButtons(): void {
    const c = this.cur
    const off = this.deps.offline || this.busy
    this.validateB.disabled = off || !c
    this.saveB.disabled = off || !c
    this.revertB.disabled = off || !c || c.isNew || c.source !== 'override'
    this.disableB.disabled = off || !c || c.isNew
    const disabled = c ? (this.entry(c.id)?.disabled ?? c.form.disabled === true) : false
    const label = this.disableB.querySelector('.label')
    if (label) label.textContent = disabled ? t('gm.qe.enable') : t('gm.qe.disable')
    this.titleEl.textContent = c ? t('gm.qe.titleWith', { id: c.id }) : t('gm.qe.title')
    this.dirtyEl.textContent = this.dirty() ? t('gm.qe.unsaved') : ''
  }

  private setStatus(text: string, bad = false): void {
    this.status.textContent = text
    this.status.classList.toggle('bad', bad)
  }

  // ---- server calls ----------------------------------------------------------------------------------------

  private async run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null
    this.busy = true
    this.syncButtons()
    try {
      return await fn()
    } finally {
      this.busy = false
      this.syncButtons()
    }
  }

  private localProblem(c: Current): string | null {
    const id = c.form.id.trim()
    if (!QUEST_ID.test(id)) return t('gm.qe.err.id')
    if (!c.isNew && id !== c.id) return t('gm.qe.err.idChanged', { id: c.id })
    if (c.isNew && this.entry(id)) return t('gm.qe.err.idTaken', { id })
    return null
  }

  private async validate(): Promise<void> {
    const c = this.cur
    if (!c) return
    const problem = this.localProblem(c)
    if (problem) return this.setStatus(problem, true)
    const res = await this.run(() => this.deps.api.validate(this.body(c)))
    if (!res || this.cur !== c) return
    if (!res.ok) {
      this.issues = res.result?.issues ?? []
      this.renderIssues()
      return this.setStatus(res.message, true)
    }
    this.issues = res.data.issues
    this.renderIssues()
    const errors = res.data.issues.filter(i => i.severity === 'error').length
    if (res.data.ok) this.setStatus(res.data.issues.length ? t('gm.qe.validWarnings', { n: res.data.issues.length }) : t('gm.qe.valid'))
    else this.setStatus(t('gm.editor.api.invalid', { count: errors }), true)
  }

  private async save(): Promise<void> {
    const c = this.cur
    if (!c) return
    const problem = this.localProblem(c)
    if (problem) return this.setStatus(problem, true)
    const id = c.form.id.trim()
    const res = await this.run(() => this.deps.api.save(id, this.body(c)))
    if (!res || this.cur !== c) return
    if (!res.ok) {
      this.issues = res.result?.issues ?? []
      this.renderIssues()
      if (res.status === 409) {
        this.setStatus(t('gm.qe.stale', { id }), true)
        void this.reload(true)
      } else this.setStatus(res.message, true)
      return
    }
    c.isNew = false
    c.id = id
    c.source = 'override'
    c.baseRev = res.data.rev
    c.form.rev = res.data.rev
    c.snapshot = this.snapshotOf(c)
    this.issues = res.data.issues
    this.renderIssues()
    this.renderForm()
    this.setStatus(t('gm.qe.saved', { id, rev: res.data.rev }))
    await this.reload(true)
  }

  private async revert(): Promise<void> {
    const c = this.cur
    if (!c || c.isNew || c.source !== 'override') return
    if (!this.confirm('revert', t('gm.qe.revertAsk', { id: c.id }))) return
    const res = await this.run(() => this.deps.api.revert(c.id))
    if (!res || this.cur !== c) return
    if (!res.ok) return this.setStatus(res.message, true)
    c.snapshot = this.snapshotOf(c) // the form is replaced by the repo version below
    await this.reload(true)
    if (this.defs.has(c.id) && this.entry(c.id)) {
      this.load(c.id, true)
      this.setStatus(t('gm.qe.reverted', { id: c.id }))
    } else {
      this.cur = null
      this.issues = []
      this.renderForm()
      this.renderIssues()
      this.setStatus(t('gm.qe.removed', { id: c.id }))
    }
    this.syncButtons()
  }

  private async toggleDisabled(): Promise<void> {
    const c = this.cur
    if (!c || c.isNew) return
    const disabled = !(this.entry(c.id)?.disabled ?? c.form.disabled === true)
    if (this.dirty() && !this.confirm('disable', t('gm.qe.disableDirty'))) return
    const res = await this.run(() => this.deps.api.setDisabled(c.id, disabled))
    if (!res || this.cur !== c) return
    if (!res.ok) {
      this.issues = res.result?.issues ?? []
      this.renderIssues()
      return this.setStatus(res.message, true)
    }
    c.snapshot = ''
    await this.reload(true)
    if (this.defs.has(c.id)) this.load(c.id, true)
    this.setStatus(disabled ? t('gm.qe.disabled', { id: c.id }) : t('gm.qe.enabled', { id: c.id }))
  }

  // ---- issues ----------------------------------------------------------------------------------------------

  private renderIssues(): void {
    this.issuesEl.replaceChildren()
    for (const f of this.fields.values()) f.classList.remove('gm-bad', 'gm-warn')
    const list = sortIssues(this.issues)
    this.issuesEl.hidden = list.length === 0
    for (const issue of list) {
      const key = this.keyOf(issue.path)
      const f = key ? this.fields.get(key) : undefined
      f?.classList.add(issue.severity === 'error' ? 'gm-bad' : 'gm-warn')
      const row = el('div', `gm-qe-issue ${issue.severity}`, el('span', 'p', issueTarget(issue.path).path || issue.path || t('gm.qe.issueFile')), issue.message)
      row.title = `${issue.path}: ${issue.message}`
      this.ls.on(row, 'click', () => {
        if (!f) return
        f.scrollIntoView({ block: 'center' })
        f.focus()
      })
      this.issuesEl.append(row)
    }
  }

  private keyOf(path: string): string | null {
    const target = issueTarget(path)
    return fieldFor(issueKey(target), k => this.fields.has(k))
  }

  // ---- the form --------------------------------------------------------------------------------------------

  private reg<T extends HTMLElement>(key: string, e: T): T {
    this.fields.set(key, e)
    return e
  }

  /** A text input bound to a form value. */
  private text(key: string, get: () => string, set: (v: string) => void, cls = '', aria = key): HTMLInputElement {
    const f = edField(cls, aria, get())
    this.ls.on(f, 'input', () => {
      set(f.value)
      f.classList.remove('gm-bad', 'gm-warn')
      this.touched()
    })
    return this.reg(key, f)
  }

  private area(key: string, get: () => string, set: (v: string) => void, aria = key): HTMLTextAreaElement {
    const a = edArea(aria, get())
    this.ls.on(a, 'input', () => {
      set(a.value)
      a.classList.remove('gm-bad', 'gm-warn')
      this.touched()
    })
    return this.reg(key, a)
  }

  private select(key: string, options: readonly (readonly [string, string])[], get: () => string, set: (v: string) => void, rerender = false): HTMLSelectElement {
    const s = edSelect(options, get())
    this.ls.on(s, 'change', () => {
      set(s.value)
      s.classList.remove('gm-bad', 'gm-warn')
      if (rerender) this.renderForm()
      else this.touched()
    })
    return this.reg(key, s)
  }

  /** A code field with suggestions and, for NPCs, a "Target" button. */
  private picker(key: string, list: HTMLDataListElement, get: () => string, set: (v: string) => void, npc = false): HTMLElement {
    const f = this.text(key, get, set, 'gm-ed-code', key)
    f.setAttribute('list', list.id)
    f.style.textTransform = 'uppercase'
    const wrap = el('div', 'gm-qe-pick', f)
    if (npc) {
      const b = miniButton(t('gm.editor.target'), t('gm.qe.targetHint'))
      this.ls.on(b, 'click', () => {
        const code = this.deps.targetNpc()
        if (!code) return this.setStatus(t('gm.editor.npc.noTarget'), true)
        f.value = code
        set(code)
        this.touched()
      })
      wrap.append(b)
    }
    return wrap
  }

  /** A location select (LOC_* of the catalog and of this quest) with "Here": a new location at the GM's position. */
  private locationPicker(key: string, get: () => string, set: (v: string) => void, optional: boolean): HTMLElement {
    const options: [string, string][] = optional ? [['', t('gm.qe.none')]] : [['', t('gm.qe.chooseLocation')]]
    for (const id of this.locationIds()) options.push([id, `${id} (${this.locationName(id)})`])
    const cur = get()
    if (cur && !options.some(([v]) => v === cur)) options.push([cur, `${cur} (?)`])
    const s = this.select(key, options, get, set)
    const here = miniButton(t('gm.qe.here'), t('gm.qe.hereHint'))
    this.ls.on(here, 'click', () => {
      const id = this.addLocationHere()
      if (!id) return
      set(id)
      this.renderForm()
    })
    return el('div', 'gm-qe-pick', s, here)
  }

  private locationIds(): string[] {
    const ids = new Set<string>([...this.locs.keys()])
    for (const l of this.cur?.locations ?? []) if (l.id.trim()) ids.add(l.id.trim())
    return [...ids].sort()
  }

  private locationName(id: string): string {
    return this.cur?.locations.find(l => l.id.trim() === id)?.name ?? this.locs.get(id)?.name ?? '?'
  }

  /** Adds a local location at the GM's position; its id, or null when the position is unknown. */
  private addLocationHere(): string | null {
    const c = this.cur
    const p = this.deps.selfPos()
    if (!c || !p) {
      this.setStatus(t('gm.qe.noPosition'), true)
      return null
    }
    const used = new Set(this.locationIds())
    const id = freeId(`LOC_${c.form.id.trim() || 'GM'}`, used)
    if (!QUEST_LOCATION_ID.test(id)) {
      this.setStatus(t('gm.qe.err.id'), true)
      return null
    }
    c.locations.push({ id, name: c.form.title.trim() || id, x: String(Math.round(p.x)), z: String(Math.round(p.z)), radius: '30' })
    this.setStatus(t('gm.qe.locationAdded', { id, x: Math.round(p.x), z: Math.round(p.z) }))
    return id
  }

  private renderForm(): void {
    const scroll = this.form.scrollTop
    this.fields.clear()
    this.previewEl = null
    const c = this.cur
    if (!c) {
      this.form.replaceChildren(el('div', 'gm-qe-empty', this.deps.offline ? t('gm.qe.offline') : t('gm.qe.pick')))
      this.syncButtons()
      return
    }
    const f = c.form
    this.form.replaceChildren(this.identitySection(c), this.grantsSection(f), this.objectivesSection(f), this.rewardsSection(f), this.dialogSection(f), this.itemsSection(c), this.locationsSection(c))
    this.form.scrollTop = scroll
    this.renderIssues()
    this.syncButtons()
    this.updatePreview()
  }

  private identitySection(c: Current): HTMLElement {
    const f = c.form
    const id = this.text('id', () => f.id, v => (f.id = v.trim().toUpperCase()), '', t('gm.qe.f.id'))
    id.style.textTransform = 'uppercase'
    id.readOnly = !c.isNew
    id.title = c.isNew ? t('gm.qe.f.idNew') : t('gm.qe.f.idFixed')
    const kind = this.select('kind', QUEST_KINDS.map(k => [k, KIND_LABEL[k]()] as [string, string]), () => f.kind, v => (f.kind = v as QuestKind))
    const title = this.text('title', () => f.title, v => (f.title = v), '', t('gm.qe.f.title'))
    const chapter = this.text('chapter', () => f.chapter, v => (f.chapter = v), '', t('gm.qe.f.chapter'))
    chapter.setAttribute('list', this.chapterList.id)
    const level = this.text('level', () => f.level, v => (f.level = v), 'gm-ed-short', t('gm.qe.f.level'))
    const maxLevel = this.text('maxLevel', () => f.maxLevel, v => (f.maxLevel = v), 'gm-ed-short', t('gm.qe.f.maxLevel'))
    maxLevel.placeholder = '-'
    const repeat = this.select(
      'repeat',
      [
        ['', t('gm.qe.repeat.none')],
        ['daily', t('gm.qe.repeat.daily')],
        ['cooldown', t('gm.qe.repeat.cooldown')],
      ],
      () => f.repeatMode,
      v => (f.repeatMode = v as QuestForm['repeatMode']),
      true,
    )
    const cooldown = this.text('repeat.cooldownSec', () => f.cooldownSec, v => (f.cooldownSec = v), 'gm-ed-mid', t('gm.qe.f.cooldown'))
    cooldown.placeholder = t('gm.qe.f.seconds')
    cooldown.hidden = f.repeatMode !== 'cooldown'
    const party = edCheck(t('gm.qe.f.party'), t('gm.qe.f.partyHint'))
    party.box.checked = f.party === true
    this.ls.on(party.box, 'change', () => {
      f.party = party.box.checked ? true : f.party === undefined ? undefined : false
      this.touched()
    })
    this.reg('party', party.root)
    const summary = this.area('summary', () => f.summary, v => (f.summary = v), t('gm.qe.f.summary'))
    summary.style.height = '36px'
    const lvl = el('div', 'gm-qe-pick', level, el('span', 'gm-label', t('gm.qe.f.maxLevel')), maxLevel)
    const grid = el(
      'div',
      'gm-qe-grid',
      el('label', '', t('gm.qe.f.id')),
      id,
      el('label', '', t('gm.qe.f.kind')),
      kind,
      el('label', '', t('gm.qe.f.title')),
      el('div', 'gm-qe-wide', title),
      el('label', '', t('gm.qe.f.chapter')),
      chapter,
      el('label', '', t('gm.qe.f.level')),
      lvl,
      el('label', '', t('gm.qe.f.giver')),
      this.picker('giver', this.npcList, () => f.giver, v => (f.giver = v.trim().toUpperCase()), true),
      el('label', '', t('gm.qe.f.turnIn')),
      this.picker('turnIn', this.npcList, () => f.turnIn, v => (f.turnIn = v.trim().toUpperCase()), true),
      el('label', '', t('gm.qe.f.repeat')),
      el('div', 'gm-qe-pick', repeat, cooldown),
      el('label', '', ''),
      party.root,
      el('label', '', t('gm.qe.f.requires')),
      el('div', 'gm-qe-wide', this.requiresEditor(f)),
      el('label', '', t('gm.qe.f.summary')),
      el('div', 'gm-qe-wide', summary),
    )
    return edSection(t('gm.qe.s.quest'), grid)
  }

  private requiresEditor(f: QuestForm): HTMLElement {
    const chips = this.reg('requires', el('div', 'gm-qe-chips'))
    ;(f.requires ?? []).forEach((id, i) => {
      const x = el('button', 'gm-qe-x', 'x')
      x.type = 'button'
      x.title = t('gm.qe.removeRow')
      this.ls.on(x, 'click', () => {
        f.requires!.splice(i, 1)
        if (!f.requires!.length) delete f.requires
        this.renderForm()
      })
      const chip = el('span', 'gm-qe-chip', `${id} ${this.defs.get(id)?.def.title ?? ''}`.trim(), x)
      this.reg(`requires.quests[${i}]`, chip)
      chips.append(chip)
    })
    const others = (this.list?.quests ?? []).filter(q => q.id !== f.id && !(f.requires ?? []).includes(q.id))
    const add = edSelect([['', t('gm.qe.addRequire')], ...others.map(q => [q.id, `${q.id} ${q.title}`] as [string, string])])
    this.ls.on(add, 'change', () => {
      if (!add.value) return
      ;(f.requires ??= []).push(add.value)
      this.renderForm()
    })
    chips.append(add)
    return chips
  }

  private grantsSection(f: QuestForm): HTMLElement {
    const rows = el('div', 'gm-qe-list')
    ;(f.giveOnAccept ?? []).forEach((g, i) => {
      const p = `giveOnAccept[${i}]`
      rows.append(
        el(
          'div',
          'gm-qe-line',
          this.picker(`${p}.item`, this.qitemList, () => g.item, v => (g.item = v.trim().toUpperCase())),
          el('span', 'gm-label', 'x'),
          this.text(`${p}.count`, () => g.count, v => (g.count = v), 'gm-ed-short', t('gm.qe.f.count')),
          this.removeButton(() => {
            f.giveOnAccept!.splice(i, 1)
            if (!f.giveOnAccept!.length) delete f.giveOnAccept
          }),
        ),
      )
    })
    const add = miniButton(t('gm.qe.addGrant'))
    this.ls.on(add, 'click', () => {
      ;(f.giveOnAccept ??= []).push({ item: '', count: '1' })
      this.renderForm()
    })
    return edSection(t('gm.qe.s.grants'), this.reg('giveOnAccept', rows), el('div', 'gm-qe-line', add, el('span', 'gm-hint', t('gm.qe.grantsHint'))))
  }

  private removeButton(fn: () => void): HTMLButtonElement {
    const x = el('button', 'gm-qe-x', 'x')
    x.type = 'button'
    x.title = t('gm.qe.removeRow')
    this.ls.on(x, 'click', () => {
      fn()
      this.renderForm()
    })
    return x
  }

  private objectivesSection(f: QuestForm): HTMLElement {
    const list = this.reg('objectives', el('div', 'gm-qe-list'))
    f.objectives.forEach((o, i) => list.append(this.objectiveCard(f, o, i)))
    const add = miniButton(t('gm.qe.addObjective'))
    this.ls.on(add, 'click', () => {
      f.objectives.push(emptyObjective('kill', freeObjectiveId(f.objectives, 'kill')))
      this.renderForm()
    })
    if (f.objectives.length >= 8) add.disabled = true
    return edSection(t('gm.qe.s.objectives'), list, el('div', 'gm-qe-line', add, el('span', 'gm-hint', t('gm.qe.objectivesHint'))))
  }

  private objectiveCard(f: QuestForm, o: ObjectiveForm, i: number): HTMLElement {
    const p = `objectives[${i}]`
    const type = this.select(
      `${p}.type`,
      OBJECTIVE_TYPES.map(x => [x, typeLabel(x)] as [string, string]),
      () => o.type,
      v => {
        o.type = v as QuestObjectiveType
      },
      true,
    )
    const id = this.text(`${p}.id`, () => o.id, v => (o.id = v.trim()), 'gm-ed-mid', t('gm.qe.f.objectiveId'))
    id.title = t('gm.qe.f.objectiveIdHint')
    const up = miniButton('^', t('gm.qe.moveUp'))
    const down = miniButton('v', t('gm.qe.moveDown'))
    up.disabled = i === 0
    down.disabled = i === f.objectives.length - 1
    this.ls.on(up, 'click', () => {
      f.objectives = moveObjective(f.objectives, i, -1)
      this.renderForm()
    })
    this.ls.on(down, 'click', () => {
      f.objectives = moveObjective(f.objectives, i, 1)
      this.renderForm()
    })
    const remove = this.removeButton(() => {
      f.objectives.splice(i, 1)
      f.objectives = fixAfter(f.objectives)
    })
    const head = el('div', 'gm-qe-card-head', el('span', 'n', `${i + 1}.`), type, id, el('span', 'spacer'), up, down, remove)
    head.querySelector<HTMLElement>('.spacer')!.style.flex = '1'

    const grid = el('div', 'gm-qe-grid')
    const row = (label: string, field: HTMLElement, wide = false) => {
      grid.append(el('label', '', label), wide ? el('div', 'gm-qe-wide', field) : field)
    }
    for (const field of objectiveFields(o.type)) {
      switch (field) {
        case 'mobs':
          row(t('gm.qe.f.mobs'), this.mobsEditor(o, p), true)
          break
        case 'count':
          row(t('gm.qe.f.count'), this.text(`${p}.count`, () => o.count, v => (o.count = v), 'gm-ed-short', t('gm.qe.f.count')))
          break
        case 'item':
          row(
            t('gm.qe.f.item'),
            this.picker(`${p}.item`, o.type === 'have' ? this.itemList : o.type === 'deliver' ? this.allItemList : this.qitemList, () => o.item, v => (o.item = v.trim().toUpperCase())),
          )
          break
        case 'from':
          row(t('gm.qe.f.from'), this.sourcesEditor(o, p), true)
          break
        case 'npc':
          row(t('gm.qe.f.npc'), this.picker(`${p}.npc`, this.npcList, () => o.npc, v => (o.npc = v.trim().toUpperCase()), true))
          break
        case 'text': {
          const a = this.area(`${p}.text`, () => o.text, v => (o.text = v), t('gm.qe.f.text'))
          a.style.height = '40px'
          row(o.type === 'useItem' ? t('gm.qe.f.textOptional') : t('gm.qe.f.text'), a, true)
          break
        }
        case 'location':
          row(t('gm.qe.f.location'), this.locationPicker(`${p}.location`, () => o.location, v => (o.location = v), false))
          break
        case 'consume': {
          const cb = edCheck(t('gm.qe.f.consume'), t('gm.qe.f.consumeHint'))
          cb.box.checked = o.consume === true
          this.ls.on(cb.box, 'change', () => {
            o.consume = cb.box.checked ? true : o.consume === undefined ? undefined : false
            this.touched()
          })
          row('', this.reg(`${p}.consume`, cb.root))
          break
        }
        case 'encounter':
          row(t('gm.qe.f.encounter'), this.encounterEditor(o, p), true)
          break
      }
    }
    // common: label, hint, after
    const label = this.text(`${p}.label`, () => o.label, v => (o.label = v), '', t('gm.qe.f.label'))
    label.placeholder = t('gm.qe.f.labelAuto')
    row(t('gm.qe.f.label'), label, true)
    row(t('gm.qe.f.hint'), this.locationPicker(`${p}.hint`, () => o.hint, v => (o.hint = v), true))
    const earlier = f.objectives.slice(0, i).map(x => x.id).filter(Boolean)
    const after = this.select(`${p}.after`, [['', t('gm.qe.none')], ...earlier.map(x => [x, x] as [string, string])], () => o.after, v => (o.after = v))
    row(t('gm.qe.f.after'), after)
    const card = el('div', 'gm-qe-card', head, grid)
    this.reg(p, card)
    return card
  }

  private mobsEditor(o: ObjectiveForm, p: string): HTMLElement {
    const chips = this.reg(`${p}.mobs`, el('div', 'gm-qe-chips'))
    const mobs = this.deps.content().mobs
    o.mobs.forEach((m, i) => {
      const chip = el('span', 'gm-qe-chip', `${mobs.get(m)?.name ?? m} `, el('span', 'gm-muted', m), this.removeButton(() => o.mobs.splice(i, 1)))
      chip.title = m
      this.reg(`${p}.mobs[${i}]`, chip)
      chips.append(chip)
    })
    const f = edField('gm-ed-code', t('gm.qe.f.mobs'))
    f.setAttribute('list', this.mobList.id)
    f.placeholder = t('gm.qe.addMob')
    f.style.textTransform = 'uppercase'
    const add = () => {
      const code = f.value.trim().toUpperCase()
      if (!code) return
      if (!o.mobs.includes(code)) o.mobs.push(code)
      this.renderForm()
    }
    const b = miniButton(t('gm.qe.add'))
    this.ls.on(b, 'click', add)
    this.ls.on(f, 'keydown', ev => ev.key === 'Enter' && add())
    chips.append(f, b)
    return chips
  }

  private sourcesEditor(o: ObjectiveForm, p: string): HTMLElement {
    const rows = this.reg(`${p}.from`, el('div', 'gm-qe-list'))
    o.from.forEach((s, i) => {
      const sp = `${p}.from[${i}]`
      const chance = this.text(`${sp}.chance`, () => s.chance, v => (s.chance = v), 'gm-ed-short', t('gm.qe.f.chance'))
      chance.title = t('gm.qe.f.chanceHint')
      rows.append(
        el(
          'div',
          'gm-qe-line',
          this.picker(`${sp}.mob`, this.mobList, () => s.mob, v => (s.mob = v.trim().toUpperCase())),
          el('span', 'gm-label', t('gm.qe.f.chance')),
          chance,
          this.removeButton(() => o.from.splice(i, 1)),
        ),
      )
    })
    const add = miniButton(t('gm.qe.addSource'))
    this.ls.on(add, 'click', () => {
      o.from.push({ mob: o.mobs[0] ?? '', chance: '0.5' })
      this.renderForm()
    })
    rows.append(add)
    return rows
  }

  private encounterEditor(o: ObjectiveForm, p: string): HTMLElement {
    const on = edCheck(t('gm.qe.f.encounterOn'), t('gm.qe.f.encounterHint'))
    on.box.checked = !!o.encounter
    this.ls.on(on.box, 'change', () => {
      if (on.box.checked) o.encounter = emptyEncounter()
      else delete o.encounter
      this.renderForm()
    })
    const wrap = this.reg(`${p}.encounter`, el('div', 'gm-qe-list', on.root))
    const e = o.encounter
    if (!e) return wrap
    const ep = `${p}.encounter`
    const n = (k: keyof typeof e, label: string, ph = '') => {
      const f = this.text(`${ep}.${k}`, () => e[k], v => (e[k] = v), 'gm-ed-short', label)
      if (ph) f.placeholder = ph
      return [el('span', 'gm-label', label), f]
    }
    wrap.append(
      el('div', 'gm-qe-line', this.picker(`${ep}.mob`, this.mobList, () => e.mob, v => (e.mob = v.trim().toUpperCase())), ...n('count', t('gm.qe.f.count'))),
      el('div', 'gm-qe-line', ...n('hpMul', t('gm.qe.f.hpMul'), '1'), ...n('attackMul', t('gm.qe.f.attackMul'), '1'), ...n('expMul', t('gm.qe.f.expMul'), '1')),
      el('div', 'gm-qe-line', ...n('despawnSec', t('gm.qe.f.despawn')), ...n('cooldownSec', t('gm.qe.f.cooldownSec'), '60')),
    )
    return wrap
  }

  private rewardsSection(f: QuestForm): HTMLElement {
    const exp = this.text('rewards.exp', () => f.exp, v => (f.exp = v), 'gm-ed-mid', t('gm.qe.f.exp'))
    const suggest = miniButton(t('gm.qe.suggest'), t('gm.qe.suggestHint'))
    this.ls.on(suggest, 'click', () => {
      const level = Number(f.level)
      const levels = this.deps.content().levels
      if (!Number.isInteger(level) || level < 1 || !levels.length) return this.setStatus(t('gm.qe.err.levelFirst'), true)
      f.exp = String(suggestExp(level, l => levels[l - 1]?.exp ?? 0))
      this.renderForm()
    })
    const pct = this.text('rewards.expPctOfLevel', () => f.expPctOfLevel, v => (f.expPctOfLevel = v), 'gm-ed-short', t('gm.qe.f.expPct'))
    pct.placeholder = '-'
    pct.title = t('gm.qe.f.expPctHint')
    const sp = this.text('rewards.sp', () => f.sp, v => (f.sp = v), 'gm-ed-short', t('gm.qe.f.sp'))
    const spFrom = miniButton(t('gm.qe.spFromExp'), t('gm.qe.spFromExpHint'))
    this.ls.on(spFrom, 'click', () => {
      f.sp = String(suggestSp(Number(f.exp)))
      this.renderForm()
    })
    const gold = this.text('rewards.gold', () => f.gold, v => (f.gold = v), 'gm-ed-mid', t('gm.qe.f.gold'))
    const grid = el(
      'div',
      'gm-qe-grid',
      el('label', '', t('gm.qe.f.exp')),
      el('div', 'gm-qe-pick', exp, suggest),
      el('label', '', t('gm.qe.f.expPct')),
      pct,
      el('label', '', t('gm.qe.f.sp')),
      el('div', 'gm-qe-pick', sp, spFrom),
      el('label', '', t('gm.qe.f.gold')),
      gold,
    )
    return edSection(
      t('gm.qe.s.rewards'),
      grid,
      el('div', 'gm-sub', t('gm.qe.f.rewardItems')),
      this.rewardRows(f, 'rewardItems', 'rewards.items'),
      el('div', 'gm-sub', t('gm.qe.f.choice')),
      this.rewardRows(f, 'choice', 'rewards.choice'),
      el('div', 'gm-hint', t('gm.qe.rewardsHint')),
    )
  }

  private rewardRows(f: QuestForm, key: 'rewardItems' | 'choice', path: string): HTMLElement {
    const rows = this.reg(path, el('div', 'gm-qe-list'))
    const items = this.deps.content().items
    const list: RewardForm[] = f[key] ?? []
    list.forEach((r, i) => {
      const p = `${path}[${i}]`
      const count = this.text(`${p}.count`, () => r.count, v => (r.count = v), 'gm-ed-short', t('gm.qe.f.count'))
      count.placeholder = '1'
      const preview = el('div', 'gm-qe-preview')
      const showPreview = () => {
        const code = r.item.trim().toUpperCase()
        if (!code.includes('{')) {
          preview.textContent = code ? (items.get(code)?.name ?? (code ? t('gm.qe.unknownItem') : '')) : ''
          return
        }
        preview.textContent = rewardPreview(code)
          .map(x => `${x.who}: ${items.get(x.code)?.name ?? `${x.code} (?)`}`)
          .join(' | ')
      }
      const picker = this.picker(`${p}.item`, this.allItemList, () => r.item, v => {
        r.item = v.trim().toUpperCase()
        showPreview()
      })
      showPreview()
      rows.append(
        el(
          'div',
          'gm-qe-line',
          picker,
          el('span', 'gm-label', 'x'),
          count,
          this.removeButton(() => {
            list.splice(i, 1)
            if (!list.length) delete f[key]
          }),
        ),
        preview,
      )
    })
    const add = miniButton(key === 'choice' ? t('gm.qe.addChoice') : t('gm.qe.addReward'))
    this.ls.on(add, 'click', () => {
      ;(f[key] ??= []).push({ item: '', count: '' })
      this.renderForm()
    })
    rows.append(add)
    return rows
  }

  private dialogSection(f: QuestForm): HTMLElement {
    const box = (k: 'offer' | 'progress' | 'complete', label: string) => {
      const a = this.area(`dialog.${k}`, () => f[k], v => (f[k] = v), label)
      this.ls.on(a, 'focus', () => {
        this.previewKey = k
        this.updatePreview()
      })
      return el('div', '', el('div', 'gm-sub', label), a)
    }
    this.previewEl = el('div', 'gm-qe-npcpage')
    const tabs = el('div', 'gm-qe-tabs3')
    for (const [k, label] of [
      ['offer', t('gm.qe.f.offer')],
      ['progress', t('gm.qe.f.progress')],
      ['complete', t('gm.qe.f.complete')],
    ] as const) {
      const b = miniButton(label)
      this.ls.on(b, 'click', () => {
        this.previewKey = k
        this.updatePreview()
      })
      tabs.append(b)
    }
    return edSection(
      t('gm.qe.s.dialog'),
      box('offer', t('gm.qe.f.offer')),
      box('progress', t('gm.qe.f.progress')),
      box('complete', t('gm.qe.f.complete')),
      el('div', 'gm-qe-line', el('span', 'gm-sub', t('gm.qe.preview')), tabs),
      this.previewEl,
    )
  }

  private updatePreview(): void {
    const c = this.cur
    if (!this.previewEl || !c) return
    const npcCode = this.previewKey === 'offer' ? c.form.giver : c.form.turnIn
    const npcName = this.deps.content().npcs.get(npcCode)?.name ?? npcCode
    const text = c.form[this.previewKey].replaceAll('{name}', this.deps.selfName() || 'Hero')
    this.previewEl.replaceChildren(el('span', 'who', `${npcName || '?'} - ${c.form.title || c.form.id}`), text || t('gm.qe.previewEmpty'))
  }

  private itemsSection(c: Current): HTMLElement {
    const rows = el('div', 'gm-qe-list')
    c.items.forEach((it, i) => {
      const p = `item:${i}`
      const code = this.text(`${p}.code`, () => it.code, v => (it.code = v.trim().toUpperCase()), 'gm-ed-code', t('gm.qe.f.itemCode'))
      code.style.textTransform = 'uppercase'
      const name = this.text(`${p}.name`, () => it.name, v => (it.name = v), 'gm-ed-name', t('gm.qe.f.itemName'))
      const icon = this.text(`${p}.iconItem`, () => it.iconItem, v => (it.iconItem = v.trim().toUpperCase()), 'gm-ed-code', t('gm.qe.f.icon'))
      icon.placeholder = t('gm.qe.f.icon')
      icon.setAttribute('list', this.allItemList.id)
      const stack = this.text(`${p}.maxStack`, () => it.maxStack, v => (it.maxStack = v), 'gm-ed-short', t('gm.qe.f.maxStack'))
      stack.placeholder = '99'
      const desc = this.text(`${p}.description`, () => it.description, v => (it.description = v), '', t('gm.qe.f.description'))
      desc.placeholder = t('gm.qe.f.description')
      desc.style.flex = '1'
      this.reg(p, code)
      rows.append(
        el(
          'div',
          'gm-qe-card',
          el('div', 'gm-qe-line', code, name, this.removeButton(() => c.items.splice(i, 1))),
          el('div', 'gm-qe-line', desc),
          el('div', 'gm-qe-line', el('span', 'gm-label', t('gm.qe.f.icon')), icon, el('span', 'gm-label', t('gm.qe.f.maxStack')), stack),
        ),
      )
    })
    const add = miniButton(t('gm.qe.addItem'))
    this.ls.on(add, 'click', () => {
      const used = new Set<string>([...this.qitems.keys(), ...c.items.map(x => x.code)])
      c.items.push({ code: freeId(`QITEM_${c.form.id.trim() || 'GM'}`, used), name: '', description: '', iconItem: '', maxStack: '' })
      this.renderForm()
      this.fillQuestItemList()
    })
    return edSection(t('gm.qe.s.items'), rows, el('div', 'gm-qe-line', add, el('span', 'gm-hint', t('gm.qe.itemsHint'))))
  }

  private locationsSection(c: Current): HTMLElement {
    const rows = el('div', 'gm-qe-list')
    c.locations.forEach((l, i) => {
      const p = `location:${i}`
      const id = this.text(`${p}.id`, () => l.id, v => (l.id = v.trim().toUpperCase()), 'gm-ed-code', t('gm.qe.f.locationId'))
      id.style.textTransform = 'uppercase'
      const name = this.text(`${p}.name`, () => l.name, v => (l.name = v), 'gm-ed-name', t('gm.qe.f.locationName'))
      const x = this.text(`${p}.x`, () => l.x, v => (l.x = v), 'gm-ed-short', 'X')
      const z = this.text(`${p}.z`, () => l.z, v => (l.z = v), 'gm-ed-short', 'Z')
      const r = this.text(`${p}.radius`, () => l.radius, v => (l.radius = v), 'gm-ed-short', t('gm.qe.f.radius'))
      const here = miniButton(t('gm.qe.here'), t('gm.qe.moveLocationHint'))
      this.ls.on(here, 'click', () => {
        const pos = this.deps.selfPos()
        if (!pos) return this.setStatus(t('gm.qe.noPosition'), true)
        l.x = String(Math.round(pos.x))
        l.z = String(Math.round(pos.z))
        this.renderForm()
      })
      this.reg(p, id)
      rows.append(
        el(
          'div',
          'gm-qe-card',
          el('div', 'gm-qe-line', id, name, this.removeButton(() => c.locations.splice(i, 1))),
          el('div', 'gm-qe-line', el('span', 'gm-label', 'X'), x, el('span', 'gm-label', 'Z'), z, el('span', 'gm-label', t('gm.qe.f.radius')), r, here),
        ),
      )
    })
    const add = miniButton(t('gm.qe.addLocation'), t('gm.qe.hereHint'))
    this.ls.on(add, 'click', () => {
      if (this.addLocationHere()) this.renderForm()
    })
    return edSection(t('gm.qe.s.locations'), rows, el('div', 'gm-qe-line', add, el('span', 'gm-hint', t('gm.qe.locationsHint'))))
  }

  // ---- pickers ---------------------------------------------------------------------------------------------

  private loadPickers(): void {
    if (this.pickersLoaded) return
    const content = this.deps.content()
    if (!content.mobs.size && !content.npcs.size) return
    this.pickersLoaded = true
    const npcs = [...content.npcs.values()].sort((a, b) => a.code.localeCompare(b.code))
    fillDatalist(
      this.npcList,
      npcs.map(n => [n.code, n.name ?? n.code] as [string, string]),
    )
    const mobs = [...content.mobs.values()].filter(m => /^MOB_/.test(m.code)).sort((a, b) => a.level - b.level || a.code.localeCompare(b.code))
    fillDatalist(
      this.mobList,
      mobs.slice(0, 2000).map(m => [m.code, `${m.name ?? m.code} (Lv ${m.level})`] as [string, string]),
    )
    const items = [...content.items.values()].sort((a, b) => a.code.localeCompare(b.code)).slice(0, 5000)
    fillDatalist(
      this.itemList,
      items.map(i => [i.code, i.name ?? i.code] as [string, string]),
    )
    this.fillQuestItemList()
  }

  private fillQuestItemList(): void {
    const q = new Map<string, string>()
    for (const [code, it] of this.qitems) q.set(code, it.name)
    for (const it of this.cur?.items ?? []) if (it.code) q.set(it.code, it.name || it.code)
    fillDatalist(this.qitemList, q)
    const all = new Map(q)
    for (const i of this.deps.content().items.values()) if (all.size < 5000) all.set(i.code, i.name ?? i.code)
    fillDatalist(this.allItemList, all)
  }

  // ---- window position -------------------------------------------------------------------------------------

  private applyPosition(): void {
    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1
    const w = W * scale
    this.x = Math.min(Math.max(this.x, 60 - w), window.innerWidth - 60)
    this.y = Math.min(Math.max(this.y, 0), window.innerHeight - 30)
    this.root.style.left = `${this.x}px`
    this.root.style.top = `${this.y}px`
  }

  private setupDrag(header: HTMLElement): void {
    let drag: { id: number; sx: number; sy: number; x: number; y: number } | null = null
    this.ls.on(header, 'pointerdown', ev => {
      if (ev.button !== 0 || (ev.target as HTMLElement).closest('button')) return
      drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, x: this.x, y: this.y }
      header.setPointerCapture(ev.pointerId)
      ev.preventDefault()
    })
    this.ls.on(header, 'pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id) return
      this.x = drag.x + ev.clientX - drag.sx
      this.y = drag.y + ev.clientY - drag.sy
      this.applyPosition()
    })
    const end = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return
      drag = null
      savePos({ x: this.x, y: this.y })
    }
    this.ls.on(header, 'pointerup', end)
    this.ls.on(header, 'pointercancel', end)
  }
}

function loadPos(): { x: number; y: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { x?: unknown; y?: unknown } | null
    return v && typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null
  } catch {
    return null
  }
}

function savePos(p: { x: number; y: number }): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p))
  } catch {
    // storage blocked: not remembered
  }
}

// ---- the GM window's Quests tab ---------------------------------------------------------------------------------

/** A short list of the quests and the button that opens the Quest Editor window. */
export class QuestsTab implements GmTab {
  readonly root: HTMLElement
  private readonly listEl: HTMLElement
  private readonly summary: HTMLElement
  private list: ApiGmQuestList | null = null
  private loading = false

  constructor(
    private readonly tabApi: GmTabApi,
    private readonly editor: { open(id?: string): void; close(): void },
    private readonly api: GmQuestApi,
    private readonly offline: boolean,
  ) {
    const art = tabApi.host.art
    const open = edButton(art, t('gm.qe.open'), 120, t('gm.qe.openHint'))
    open.addEventListener('click', () => this.editor.open())
    const refresh = edSmall(art, t('gm.editor.refresh'), 58)
    refresh.addEventListener('click', () => void this.refresh())
    this.summary = el('span', 'gm-muted')
    this.listEl = el('div', 'gm-list')
    this.root = el('div', 'gm-ed gm-ed-quests', el('div', 'gm-bar', open, refresh, this.summary), this.listEl, el('div', 'gm-hint', t('gm.qe.tabHint')))
    this.render()
  }

  show(): void {
    if (!this.list) void this.refresh()
  }

  contentChanged(): void {
    if (this.tabApi.isShown()) void this.refresh()
    else this.list = null
  }

  dispose(): void {
    this.editor.close()
  }

  private async refresh(): Promise<void> {
    if (this.offline) {
      this.summary.textContent = t('gm.qe.offline')
      return
    }
    if (this.loading) return
    this.loading = true
    const res = await this.api.list()
    this.loading = false
    if (!res.ok) {
      this.summary.textContent = res.message
      this.tabApi.setStatus(res.message, true)
      return
    }
    this.list = res.data
    this.render()
  }

  private render(): void {
    this.listEl.replaceChildren()
    const quests = this.list?.quests ?? []
    if (!this.list) {
      this.listEl.append(el('div', 'gm-empty', this.offline ? t('gm.qe.offline') : t('gm.editor.loading')))
      return
    }
    const overrides = quests.filter(q => q.source === 'override').length
    const withIssues = quests.filter(q => q.issues.some(i => i.severity === 'error')).length
    this.summary.textContent = t('gm.qe.summary', { n: quests.length, o: overrides, e: withIssues })
    for (const q of quests) {
      const row = el(
        'div',
        `gm-qe-qrow${q.disabled ? ' off' : ''}`,
        el(
          'span',
          'badges',
          q.source === 'override' ? el('span', 'gm-ed-src override', srcLabel('override')) : null,
          q.disabled ? el('span', 'gm-ed-src disabled', srcLabel('disabled')) : null,
          q.issues.some(i => i.severity === 'error') ? el('span', 'gm-qe-issues-n', '!') : null,
        ),
        el('span', 'id', q.id),
        el('span', 'title', q.title),
      )
      row.addEventListener('click', () => this.editor.open(q.id))
      this.listEl.append(row)
    }
  }
}
