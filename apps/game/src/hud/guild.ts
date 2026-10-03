/**
 * The guild window of lane GU-C (docs/SYSTEMS_SOCIAL.md §9.4, docs/UI.md §4.6): the guild page of the retail
 * community window, one kit `mframe` window of 477×393 (`ginterface.txt GDR_COMMUNITY`), key U.
 *  - Tabs (13,37): Guild and Notice (`com_long_tab`), over the page `equip_window_` (13,61,451,320).
 *  - Guild page (`ifguild.txt`, page px): the header `gil_windo01` (6,4) with the name and crest, Level, the Guild
 *    Master with the race mark, the member count, and (our stand-in for the GP row) the online count and the founding
 *    date; the `frameg01_wnd_` frame (6,103,440,211); the notice subject line (15,110,428,28) with `stl_edit_button`
 *    (417,111); the member view `com_blacksquare_` (14,138,333,166) with the sort buttons `gil_subj_button02..05`
 *    between `gil_shape01` / `gil_shape` (y 141) and `gil_bar02` rows (lamp `gil_contact_on/off`, race, name, level,
 *    grade or title, status); the command buttons `com_mid_button` at (353, 142 + 27·i), shown only when allowed.
 *  - Rights (`ifguildgrantpower.txt`): a table over the member view with a check box per right, OK / Cancel.
 *  - Notice page: the full notice; Write opens the editor (`ifguildnotifywrite.txt`: title, contents, Post / Cancel)
 *    with the UTF-8 cap of §2.5.
 * Not in a guild: only the line "You do not belong to a guild." and the Guild Manager hint.
 * It draws only what the server said (GuildBook); every change is an intent through the host.
 */
import { GUILD_NOTICE_TITLE_MAX, GUILD_PERMS, type GuildMember, type GuildPerm } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place, type Rect } from '../ui/dom.ts'
import { button, iconButton, type KitButton } from '../ui/kit/button.ts'
import { Checkbox } from '../ui/kit/check.ts'
import { Frame } from '../ui/kit/frame.ts'
import { TextInput } from '../ui/kit/input.ts'
import { nineSlice } from '../ui/kit/nine.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import type { ButtonSkin } from '../ui/kit/skins.ts'
import { TabBar } from '../ui/kit/tabs.ts'
import { Window } from '../ui/kit/window.ts'
import {
  canHandOver,
  canKick,
  canTitle,
  clampNotice,
  dateText,
  DEFAULT_GUILD_SORT,
  gradeOf,
  gradeText,
  nextSort,
  noticeRoom,
  sortMembers,
  statusText,
  type GuildBook,
  type GuildRights,
  type GuildSort,
  type GuildSortKey,
} from './guild-state.ts'

export const GUILD_W = 477
export const GUILD_H = 393
const TITLE_H = 36
/** The page (`equip_window_`) in window px; every `ifguild.txt` rect is relative to it. */
const PAGE: Rect = [13, 61, 451, 320]
const ROW_H = 24

/** What the window needs from the feature. */
export interface GuildHost {
  readonly book: GuildBook
  me(): GuildMember | undefined
  rights(): GuildRights
  /** Server time (ms), for "last seen" and the dates. */
  now(): number
  invite(): void
  kick(m: GuildMember): void
  leave(): void
  title(m: GuildMember): void
  handOver(m: GuildMember): void
  /** The Rights table's OK: the rights per member as ticked. */
  applyPerms(changes: Map<number, GuildPerm[]>): void
  /** Post the notice; false = refused before sending (the editor stays open). */
  postNotice(title: string, text: string): boolean
  whisper(name: string): void
}

type Tab = 'members' | 'notice'
type Command = 'invite' | 'rights' | 'kick' | 'leave' | 'title' | 'handOver'
const COMMANDS: readonly Command[] = ['invite', 'rights', 'kick', 'leave', 'title', 'handOver']
const PERM_KEY: Record<GuildPerm, StringKey> = { invite: 'guild.perm.invite', kick: 'guild.perm.kick', title: 'guild.perm.title', notice: 'guild.perm.notice' }
const PERM_HINT: Record<GuildPerm, StringKey> = { invite: 'guild.perm.inviteHint', kick: 'guild.perm.kickHint', title: 'guild.perm.titleHint', notice: 'guild.perm.noticeHint' }
/** Rights table column order (retail: Join, Withdraw, Name, [Storage], Notice). */
const PERM_COLUMNS: readonly GuildPerm[] = ['invite', 'kick', 'title', 'notice']

/** The sort buttons over the member rows: column, art, x and width (page px, y 141). */
const SORTS: readonly { key: GuildSortKey; label: StringKey; art: string; x: number; w: number }[] = [
  { key: 'name', label: 'guild.col.name', art: 'guild/gil_subj_button02', x: 39, w: 112 },
  { key: 'level', label: 'guild.col.level', art: 'guild/gil_subj_button03', x: 151, w: 38 },
  { key: 'grade', label: 'guild.col.grade', art: 'guild/gil_subj_button04', x: 189, w: 72 },
  { key: 'status', label: 'guild.col.status', art: 'guild/gil_subj_button05', x: 261, w: 68 },
]

const CSS = `
.kit-window-guild .gd-page[hidden], .kit-window-guild [data-gd][hidden] { display: none !important; }
.kit-window-guild .gd-img { background: no-repeat 0 0 / 100% 100%; pointer-events: none; }
.kit-window-guild .gd-tile { background-repeat: repeat; pointer-events: none; }
.kit-window-guild .gd-tabs { display: flex; gap: 1px; align-items: flex-end; }
.kit-window-guild .gd-name { display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--c-heading); font: 13px/16px var(--font-title); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; }
.kit-window-guild .gd-name i { width: 16px; height: 16px; flex: none; background: no-repeat 0 0 / 100% 100%; }
.kit-window-guild .gd-label { color: var(--c-label); font: 12px/14px var(--font-body); text-shadow: var(--t-shadow); white-space: nowrap; }
.kit-window-guild .gd-value { color: var(--c-text); font: 12px/14px var(--font-body); text-shadow: var(--t-shadow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-guild .gd-value.lvl { color: var(--c-level); text-align: center; font-family: var(--font-title); }
.kit-window-guild .gd-value.master { color: var(--c-guild-name); }
.kit-window-guild .gd-subject { display: flex; align-items: center; gap: 8px; padding: 0 30px 0 9px; box-sizing: border-box; cursor: pointer; }
.kit-window-guild .gd-subject:hover .gd-subject-text { color: var(--c-highlight); text-decoration: underline; text-underline-offset: 3px; }
.kit-window-guild .gd-subject .gd-label { flex: none; }
.kit-window-guild .gd-subject-text { flex: 1; color: var(--c-text); font: 12px/14px var(--font-body); text-shadow: var(--t-shadow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-guild .gd-subject-text.empty { color: var(--c-hint); }
.kit-window-guild .gd-sort { padding: 0; }
.kit-window-guild .gd-sort .kit-btn-label { font-size: 11px; }
.kit-window-guild .gd-sort.on .kit-btn-label { color: var(--c-highlight); }
.kit-window-guild .gd-sort.on.rev .kit-btn-label::after { content: ' ▴'; }
.kit-window-guild .gd-sort.on:not(.rev) .kit-btn-label::after { content: ' ▾'; }
.kit-window-guild .gd-rows .kit-scroll-view { overflow-x: hidden; }
.kit-window-guild .gd-row {
  position: relative; width: 312px; height: ${ROW_H}px; cursor: pointer;
  background: var(--gd-bar, rgba(0, 0, 0, 0.35)) no-repeat 0 0 / 100% 100%;
  font: 12px/${ROW_H}px var(--font-body); color: var(--c-text); text-shadow: var(--t-shadow);
}
.kit-window-guild .gd-row.sel { background-image: var(--gd-bar-sel, none); box-shadow: var(--gd-sel-fallback, none); }
.kit-window-guild .gd-row.off { color: #a8a39a; }
.kit-window-guild .gd-row > * { position: absolute; top: 0; height: ${ROW_H}px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-guild .gd-row .lamp { left: 5px; top: 4px; width: 12px; height: 16px; background: no-repeat 0 0 / 100% 100%; }
.kit-window-guild .gd-row .race { left: 22px; top: 4px; width: 16px; height: 16px; background: no-repeat 0 0 / 100% 100%; }
.kit-window-guild .gd-row .nm { left: 42px; width: 90px; }
.kit-window-guild .gd-row .lv { left: 134px; width: 38px; text-align: center; color: var(--c-level); }
.kit-window-guild .gd-row.off .lv { color: #b9a867; }
.kit-window-guild .gd-row .gr { left: 172px; width: 72px; text-align: center; font-size: 11px; }
.kit-window-guild .gd-row .gr.master { color: var(--c-heading); }
.kit-window-guild .gd-row .gr.vice { color: var(--c-guild-name); }
.kit-window-guild .gd-row .gr.titled { color: var(--c-mastery); }
.kit-window-guild .gd-row .st { left: 244px; width: 66px; text-align: center; font-size: 11px; }
.kit-window-guild .gd-row .st.on { color: var(--c-good); }
.kit-window-guild .gd-cmds { display: flex; flex-direction: column; gap: 3px; }
.kit-window-guild .gd-none { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
.kit-window-guild .gd-none .gd-hint { color: var(--c-label); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); }
.kit-window-guild .gd-rights-head { display: flex; align-items: center; }
.kit-window-guild .gd-rights-head > span { flex: none; text-align: center; color: var(--c-label); font: 11px/22px var(--font-body); text-shadow: var(--t-shadow); background: no-repeat 0 0 / 100% 100%; }
.kit-window-guild .gd-rights-row { position: relative; height: ${ROW_H}px; font: 12px/${ROW_H}px var(--font-body); color: var(--c-text); text-shadow: var(--t-shadow); background: var(--gd-bar3, rgba(0, 0, 0, 0.3)) no-repeat 0 0 / 100% 100%; }
.kit-window-guild .gd-rights-row > .nm { position: absolute; left: 8px; width: 122px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-guild .gd-rights-row > .kit-toggle { position: absolute; top: 4px; }
.kit-window-guild .gd-rights-note { color: var(--c-hint); font: 10px/12px var(--font-body); text-shadow: var(--t-shadow); text-align: center; }
.kit-window-guild .gd-notice-title { color: var(--c-heading); font: 13px/16px var(--font-title); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-window-guild .gd-notice-at { color: var(--c-hint); font: 10px/16px var(--font-body); text-shadow: var(--t-shadow); text-align: right; }
.kit-window-guild .gd-notice-text { color: var(--c-text); font: 12px/17px var(--font-body); text-shadow: var(--t-shadow); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; padding: 2px 4px; }
.kit-window-guild .gd-notice-text.empty { color: var(--c-hint); }
.kit-window-guild .gd-line { height: 2px; background: no-repeat 0 0 / 100% 100%; }
.kit-window-guild .gd-area { box-sizing: border-box; }
.kit-window-guild .gd-area textarea {
  position: absolute; inset: 4px; width: calc(100% - 8px); height: calc(100% - 8px); box-sizing: border-box; resize: none; border: 0; outline: none;
  background: transparent; color: var(--c-text); font: 12px/16px var(--font-body); padding: 2px 4px;
}
.kit-window-guild .gd-room { color: var(--c-hint); font: 10px/14px var(--font-body); text-shadow: var(--t-shadow); text-align: right; }
.kit-window-guild .gd-room.low { color: var(--c-warn); }
.kit-window-guild .gd-bottom { display: flex; justify-content: center; gap: 12px; }
`

let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-guild'
  style.textContent = CSS
  document.head.append(style)
}

/** A page rect in the window body's px (the body starts under the 36-px title strip). */
function pr([x, y, w, h]: Rect): Rect {
  return [PAGE[0] + x, PAGE[1] + y - TITLE_H, w, h]
}

/** A window rect in body px. */
function wr([x, y, w, h]: Rect): Rect {
  return [x, y - TITLE_H, w, h]
}

export class GuildWindow extends Window {
  private readonly tabs: TabBar<Tab>
  private readonly tabsEl: HTMLElement
  private readonly pageFrame: HTMLElement
  private readonly members: HTMLElement
  private readonly notice: HTMLElement
  private readonly none: HTMLElement
  // header
  private readonly nameEl: HTMLElement
  private readonly levelEl: HTMLElement
  private readonly masterEl: HTMLElement
  private readonly countEl: HTMLElement
  private readonly onlineEl: HTMLElement
  private readonly foundedEl: HTMLElement
  // notice subject + member list
  private readonly subjectText: HTMLElement
  private readonly editButton: KitButton
  private readonly listBox: HTMLElement
  private readonly rows: ScrollArea
  private readonly sortButtons = new Map<GuildSortKey, KitButton>()
  private readonly cmdBox: HTMLElement
  private readonly cmds = new Map<Command, KitButton>()
  // rights
  private readonly rightsBox: HTMLElement
  private readonly rightsRows: ScrollArea
  private rightsDraft: Map<number, Set<GuildPerm>> | null = null
  // notice page
  private readonly noticeView: HTMLElement
  private readonly noticeEdit: HTMLElement
  private readonly noticeTitle: HTMLElement
  private readonly noticeAt: HTMLElement
  private readonly noticeText: HTMLElement
  private readonly noticeWrite: KitButton
  private readonly titleInput: TextInput
  private readonly textInput: HTMLTextAreaElement
  private readonly room: HTMLElement
  private editing = false

  private sort: GuildSort = { ...DEFAULT_GUILD_SORT }
  private selected: number | null = null
  private readonly barUrls: { row: string | null; sel: string | null; bar3: string | null }

  constructor(art: Art, parent: HTMLElement, private readonly host: GuildHost) {
    ensureStyles()
    super(art, parent, { id: 'guild', title: t('guild.window'), width: GUILD_W, height: GUILD_H, at: [0.55, 0.3], frame: 'main', inset: [TITLE_H, 0, 0, 0] })
    this.barUrls = {
      row: art.has('guild/gil_bar02_deselect') ? art.cssUrl('guild/gil_bar02_deselect') : null,
      sel: art.has('guild/gil_bar02_select') ? art.cssUrl('guild/gil_bar02_select') : null,
      bar3: art.has('guild/gil_bar03') ? art.cssUrl('guild/gil_bar03') : null,
    }
    const b = this.body

    // ---- tabs and the page ----
    this.tabs = new TabBar<Tab>(art, 'long', [
      { id: 'members', label: t('guild.tab.members') },
      { id: 'notice', label: t('guild.tab.notice') },
    ], { className: 'gd-tabs' })
    this.tabsEl = place(this.tabs.root, wr([13, 37, 300, 24]))
    this.tabs.onChange = () => {
      this.editing = false
      this.render()
    }
    this.pageFrame = new Frame(art, 'panel', { at: wr(PAGE), className: 'gd-page-frame' }).root
    b.append(this.pageFrame, this.tabsEl)

    // ---- not in a guild ----
    this.none = place(el('div', 'gd-page gd-none', el('div', 'kit-t-value', t('guild.none')), el('div', 'gd-hint', t('guild.noneHint'))), pr([16, 20, 419, 280]))
    b.append(this.none)

    // ---- the Guild page ----
    this.members = el('div', 'gd-page')
    const m = this.members
    m.append(this.img(art, 'guild/gil_windo01', pr([6, 4, 440, 101])))
    const mark = el('i')
    if (art.has('guild/gil_mark01')) mark.style.backgroundImage = art.cssUrl('guild/gil_mark01')
    this.nameEl = el('span')
    m.append(place(el('div', 'gd-name', mark, this.nameEl), pr([12, 14, 356, 18])))
    m.append(place(el('div', 'gd-label', t('guild.head.level')), pr([380, 16, 36, 15])))
    this.levelEl = place(el('div', 'gd-value lvl', '1'), pr([416, 16, 22, 15]))
    m.append(this.levelEl)
    m.append(place(el('div', 'gd-label', t('guild.head.master')), pr([28, 51, 60, 14])))
    m.append(this.img(art, 'ifcommon/com_kindred_china16', pr([90, 49, 16, 16])))
    this.masterEl = place(el('div', 'gd-value master'), pr([112, 51, 140, 14]))
    m.append(place(el('div', 'gd-label', t('guild.head.members')), pr([261, 51, 74, 14])))
    this.countEl = place(el('div', 'gd-value'), pr([339, 51, 96, 14]))
    m.append(place(el('div', 'gd-label', t('guild.head.online')), pr([28, 75, 60, 14])))
    this.onlineEl = place(el('div', 'gd-value'), pr([112, 75, 140, 14]))
    m.append(place(el('div', 'gd-label', t('guild.head.founded')), pr([261, 75, 74, 14])))
    this.foundedEl = place(el('div', 'gd-value'), pr([339, 75, 96, 14]))
    m.append(this.masterEl, this.countEl, this.onlineEl, this.foundedEl)

    m.append(new Frame(art, 'grey', { at: pr([6, 103, 440, 211]), className: 'gd-frame' }).root)
    m.append(this.tile(art, 'ifcommon/bg_tile/com_bg_tile_b', pr([15, 110, 428, 26])))
    // Notice subject line: a click reads the notice, the pencil writes it.
    this.subjectText = el('span', 'gd-subject-text')
    const subject = place(el('div', 'gd-subject', el('span', 'gd-label', t('guild.notice')), this.subjectText), pr([15, 110, 400, 28]))
    subject.title = t('guild.noticeOpen')
    this.ls.on(subject, 'click', () => this.showTab('notice'))
    this.editButton = place(iconButton(art, 'stall/stl_edit_button', { title: t('guild.noticeEditHint'), fallbackText: '✎', w: 22, h: 22 }, () => this.startEdit()), pr([417, 111, 22, 22]))
    m.append(subject, this.editButton)

    // Member view.
    this.listBox = el('div', 'gd-list')
    const list = this.listBox
    list.append(new Frame(art, 'black', { at: pr([14, 138, 333, 166]) }).root)
    list.append(this.img(art, 'guild/gil_shape01', pr([17, 141, 22, 22])))
    for (const s of SORTS) {
      const skin: ButtonSkin = { key: s.art, w: s.w, h: 22, slice: 4 }
      const btn = place(button(art, { label: t(s.label), skin, width: s.w, title: t('guild.sortHint'), className: 'gd-sort', sfx: 'none' }, () => {
        this.sort = nextSort(this.sort, s.key)
        this.render()
      }), pr([s.x, 141, s.w, 22]))
      this.sortButtons.set(s.key, btn)
      list.append(btn)
    }
    list.append(this.img(art, 'guild/gil_shape', pr([329, 141, 16, 22])))
    this.rows = new ScrollArea(art, { className: 'gd-rows' })
    place(this.rows.root, pr([17, 164, 328, 138]))
    list.append(this.rows.root)
    m.append(list)

    // Command buttons.
    m.append(this.tile(art, 'ifcommon/bg_tile/com_bg_tile_b', pr([349, 138, 94, 166])))
    this.cmdBox = place(el('div', 'gd-cmds'), pr([352, 142, 88, 160]))
    const cmdLabel: Record<Command, [StringKey, StringKey]> = {
      invite: ['guild.cmd.invite', 'guild.cmd.inviteHint'],
      rights: ['guild.cmd.rights', 'guild.cmd.rightsHint'],
      kick: ['guild.cmd.kick', 'guild.cmd.kickHint'],
      leave: ['guild.cmd.leave', 'guild.cmd.leaveHint'],
      title: ['guild.cmd.title', 'guild.cmd.titleHint'],
      handOver: ['guild.cmd.handOver', 'guild.cmd.handOverHint'],
    }
    for (const c of COMMANDS) {
      const [label, hint] = cmdLabel[c]
      const btn = button(art, { label: t(label), skin: 'mid', width: 88, title: t(hint) }, () => this.command(c))
      btn.dataset.gd = c
      this.cmds.set(c, btn)
      this.cmdBox.append(btn)
    }
    m.append(this.cmdBox)

    // Rights table (over the member view and the commands).
    this.rightsBox = el('div', 'gd-rights')
    this.rightsBox.hidden = true
    this.rightsBox.dataset.gd = 'rights'
    const rb = this.rightsBox
    rb.append(new Frame(art, 'black', { at: pr([14, 138, 429, 146]) }).root)
    const head = place(el('div', 'gd-rights-head'), pr([17, 141, 420, 22]))
    const headCell = (text: string, w: number, key: string, title?: string) => {
      const s = el('span', '', text)
      s.style.width = `${w}px`
      if (art.has(key)) s.style.backgroundImage = art.cssUrl(key)
      if (title) s.title = title
      return s
    }
    head.append(headCell(t('guild.col.name'), 131, 'guild/gil_subj_button02'))
    for (const p of PERM_COLUMNS) head.append(headCell(t(PERM_KEY[p]), 67, 'guild/gil_shape02', t(PERM_HINT[p])))
    head.append(headCell('', 16, 'guild/gil_shape'))
    rb.append(head)
    this.rightsRows = new ScrollArea(art, { className: 'gd-rights-rows' })
    place(this.rightsRows.root, pr([17, 164, 420, 116]))
    rb.append(this.rightsRows.root)
    rb.append(place(el('div', 'gd-rights-note', t('guild.rights.viceHint')), pr([14, 286, 429, 12])))
    const ok = button(art, { label: t('guild.rights.ok'), primary: true }, () => this.commitRights())
    const cancel = button(art, { label: t('guild.rights.cancel') }, () => this.closeRights())
    rb.append(place(el('div', 'gd-bottom', ok, cancel), pr([14, 298, 429, 24])))
    m.append(rb)
    b.append(m)

    // ---- the Notice page ----
    this.notice = el('div', 'gd-page')
    this.notice.hidden = true
    this.noticeView = el('div')
    const nv = this.noticeView
    nv.append(new Frame(art, 'inner', { at: pr([6, 6, 440, 268]) }).root)
    this.noticeTitle = place(el('div', 'gd-notice-title'), pr([20, 16, 300, 16]))
    this.noticeAt = place(el('div', 'gd-notice-at'), pr([320, 16, 112, 16]))
    const line = place(el('div', 'gd-line'), pr([18, 36, 416, 2]))
    if (art.has('ifcommon/com_grayline')) line.style.backgroundImage = art.cssUrl('ifcommon/com_grayline')
    const textScroll = new ScrollArea(art, { className: 'gd-notice-scroll' })
    place(textScroll.root, pr([16, 42, 420, 224]))
    this.noticeText = el('div', 'gd-notice-text')
    textScroll.view.append(this.noticeText)
    this.noticeWrite = button(art, { label: t('guild.noticeEdit'), title: t('guild.noticeEditHint') }, () => this.startEdit())
    nv.append(this.noticeTitle, this.noticeAt, line, textScroll.root, place(el('div', 'gd-bottom', this.noticeWrite), pr([6, 282, 440, 24])))

    this.noticeEdit = el('div')
    this.noticeEdit.hidden = true
    const ne = this.noticeEdit
    ne.append(new Frame(art, 'inner', { at: pr([6, 6, 440, 268]) }).root)
    ne.append(place(el('div', 'gd-label', t('guild.noticeTitle')), pr([20, 20, 70, 14])))
    this.titleInput = new TextInput(art, { maxLength: GUILD_NOTICE_TITLE_MAX * 2, label: t('guild.noticeTitle'), className: 'gd-notice-title-input' })
    place(this.titleInput.root, pr([92, 15, 340, 22]))
    ne.append(this.titleInput.root)
    ne.append(place(el('div', 'gd-label', t('guild.noticeText')), pr([20, 46, 100, 14])))
    const area = place(el('div', 'gd-area'), pr([18, 64, 416, 186]))
    nineSlice(area, art, 'field')
    this.textInput = el('textarea')
    this.textInput.setAttribute('aria-label', t('guild.noticeText'))
    this.textInput.spellcheck = false
    area.append(this.textInput)
    ne.append(area)
    this.room = place(el('div', 'gd-room'), pr([240, 252, 194, 14]))
    ne.append(this.room)
    const post = button(art, { label: t('guild.noticePost'), primary: true }, () => this.postNotice())
    const back = button(art, { label: t('guild.noticeCancel') }, () => {
      this.editing = false
      this.render()
    })
    ne.append(place(el('div', 'gd-bottom', post, back), pr([6, 282, 440, 24])))
    const clamp = () => {
      const c = clampNotice(this.titleInput.value, this.textInput.value)
      if (c.title !== this.titleInput.value) this.titleInput.value = c.title
      if (c.text !== this.textInput.value) this.textInput.value = c.text
      this.paintRoom()
    }
    this.ls.on(this.titleInput.input, 'input', clamp)
    this.ls.on(this.textInput, 'input', clamp)
    // Keys typed in the editor never reach the chat or the game.
    this.ls.on(this.textInput, 'keydown', ev => ev.stopPropagation())
    this.ls.on(this.titleInput.input, 'keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') {
        ev.preventDefault()
        this.textInput.focus()
      }
    })
    this.notice.append(nv, ne)
    b.append(this.notice)

    this.render()
  }

  /** The member row element of a character (tests and the browser check). */
  rowOf(characterId: number): HTMLElement | null {
    return this.rows.view.querySelector<HTMLElement>(`[data-member="${characterId}"]`)
  }

  /** The command button (tests and the browser check). */
  commandButton(c: Command): KitButton | undefined {
    return this.cmds.get(c)
  }

  get selectedMember(): GuildMember | undefined {
    return this.selected === null ? undefined : this.host.book.byId(this.selected)
  }

  showTab(tab: Tab): void {
    this.tabs.value = tab
    this.editing = false
    this.render()
  }

  /** Opens the window on the Notice page (the login line, the notice event). */
  openNotice(): void {
    this.open()
    this.showTab('notice')
  }

  override close(): void {
    this.rightsDraft = null
    this.editing = false
    super.close()
  }

  protected override onOpen(): void {
    this.render()
  }

  /** Redraws everything from the book (cheap: at most GUILD_MEMBERS_MAX rows). */
  render(): void {
    const book = this.host.book
    const g = book.state
    const inGuild = !!g
    this.none.hidden = inGuild
    this.tabsEl.hidden = !inGuild
    const tab = this.tabs.value
    this.members.hidden = !inGuild || tab !== 'members'
    this.notice.hidden = !inGuild || tab !== 'notice'
    if (!g) {
      this.rightsDraft = null
      this.editing = false
      this.selected = null
      return
    }
    const now = this.host.now()
    const rights = this.host.rights()
    const me = this.host.me()

    // Header.
    this.nameEl.textContent = g.name
    this.masterEl.textContent = book.master()?.name ?? ''
    this.countEl.textContent = t('guild.membersCount', { n: g.members.length, max: g.maxMembers })
    this.onlineEl.textContent = String(book.onlineCount)
    this.foundedEl.textContent = dateText(g.createdAt)

    // Notice subject.
    this.subjectText.textContent = g.notice.title || t('guild.noticeEmpty')
    this.subjectText.classList.toggle('empty', !g.notice.title)
    this.editButton.hidden = !rights.notice

    // Rows.
    if (this.selected !== null && !book.byId(this.selected)) this.selected = null
    for (const [key, btn] of this.sortButtons) {
      btn.classList.toggle('on', this.sort.key === key)
      btn.classList.toggle('rev', this.sort.key === key && this.sort.reverse)
    }
    const rows = sortMembers(book.members, this.sort).map(mem => this.row(mem, now))
    this.rows.view.replaceChildren(...rows)
    this.rows.refresh()

    // Commands: shown when the rank allows, enabled when the selection suits.
    const sel = this.selectedMember
    const show: Record<Command, boolean> = {
      invite: rights.invite,
      rights: rights.grant,
      kick: rights.kick,
      leave: rights.leave,
      title: rights.title,
      handOver: rights.handOver,
    }
    const enable: Record<Command, boolean> = {
      invite: !book.full,
      rights: true,
      kick: canKick(me, sel),
      leave: true,
      title: canTitle(me, sel),
      handOver: canHandOver(me, sel),
    }
    for (const c of COMMANDS) {
      const btn = this.cmds.get(c)!
      btn.hidden = !show[c]
      btn.setDisabled(!enable[c])
    }

    // Rights table.
    const rightsOpen = this.rightsDraft !== null && rights.grant
    if (!rightsOpen) this.rightsDraft = null
    this.rightsBox.hidden = !rightsOpen
    this.listBox.hidden = rightsOpen
    this.cmdBox.hidden = rightsOpen

    // Notice page.
    if (!rights.notice) this.editing = false
    this.noticeView.hidden = this.editing
    this.noticeEdit.hidden = !this.editing
    this.noticeTitle.textContent = g.notice.title || t('guild.notice')
    this.noticeAt.textContent = g.notice.at ? t('guild.noticeAt', { date: dateText(g.notice.at) }) : ''
    this.noticeText.textContent = g.notice.text || (g.notice.title ? '' : t('guild.noticeEmpty'))
    this.noticeText.classList.toggle('empty', !g.notice.text && !g.notice.title)
    this.noticeWrite.hidden = !rights.notice
    if (this.editing) this.paintRoom()
  }

  private row(mem: GuildMember, now: number): HTMLElement {
    const r = el('div', `gd-row${mem.online ? '' : ' off'}${mem.characterId === this.selected ? ' sel' : ''}`)
    r.dataset.member = String(mem.characterId)
    if (this.barUrls.row) r.style.setProperty('--gd-bar', this.barUrls.row)
    if (this.barUrls.sel) r.style.setProperty('--gd-bar-sel', this.barUrls.sel)
    else r.style.setProperty('--gd-sel-fallback', 'inset 0 0 0 1px var(--c-level)')
    const lamp = el('i', 'lamp')
    const lampKey = mem.online ? 'guild/gil_contact_on' : 'guild/gil_contact_off'
    if (this.art.has(lampKey)) lamp.style.backgroundImage = this.art.cssUrl(lampKey)
    const race = el('i', 'race')
    if (this.art.has('ifcommon/com_kindred_china16')) race.style.backgroundImage = this.art.cssUrl('ifcommon/com_kindred_china16')
    const grade = gradeOf(mem)
    const gr = el('span', `gr ${mem.title ? 'titled' : grade}`, gradeText(mem))
    const status = statusText(mem, now)
    r.append(lamp, race, el('span', 'nm', mem.name), el('span', 'lv', String(mem.level)), gr, el('span', `st${mem.online ? ' on' : ''}`, status))
    r.title = `${mem.name}\n${t('guild.rowHint', { level: mem.level, grade: gradeText(mem), status })}${mem.online && mem.name !== this.host.me()?.name ? `\n${t('guild.rowWhisper')}` : ''}`
    r.addEventListener('click', () => {
      this.selected = mem.characterId
      this.render()
    })
    r.addEventListener('dblclick', () => {
      if (mem.online && mem.name !== this.host.me()?.name) this.host.whisper(mem.name)
    })
    return r
  }

  private command(c: Command): void {
    const sel = this.selectedMember
    switch (c) {
      case 'invite':
        this.host.invite()
        return
      case 'rights':
        this.openRights()
        return
      case 'leave':
        this.host.leave()
        return
      case 'kick':
        if (sel) this.host.kick(sel)
        return
      case 'title':
        if (sel) this.host.title(sel)
        return
      case 'handOver':
        if (sel) this.host.handOver(sel)
        return
    }
  }

  // ---- rights ----

  private openRights(): void {
    const draft = new Map<number, Set<GuildPerm>>()
    for (const mem of this.host.book.members) if (mem.rank !== 'master') draft.set(mem.characterId, new Set(mem.perms))
    this.rightsDraft = draft
    const rows: HTMLElement[] = []
    for (const mem of sortMembers(this.host.book.members.filter(x => x.rank !== 'master'))) {
      const r = el('div', 'gd-rights-row', el('span', 'nm', mem.name))
      if (this.barUrls.bar3) r.style.setProperty('--gd-bar3', this.barUrls.bar3)
      PERM_COLUMNS.forEach((p, i) => {
        const box = new Checkbox(this.art, { checked: mem.perms.includes(p), title: `${mem.name}: ${t(PERM_KEY[p])}` })
        box.root.style.left = `${131 + i * 67 + 25}px`
        box.onChange = on => {
          const set = this.rightsDraft?.get(mem.characterId)
          if (!set) return
          if (on) set.add(p)
          else set.delete(p)
        }
        r.append(box.root)
      })
      rows.push(r)
    }
    this.rightsRows.view.replaceChildren(...rows)
    this.render()
    this.rightsRows.refresh()
  }

  private commitRights(): void {
    const draft = this.rightsDraft
    this.rightsDraft = null
    if (draft) this.host.applyPerms(new Map([...draft].map(([id, set]) => [id, GUILD_PERMS.filter(p => set.has(p))])))
    this.render()
  }

  private closeRights(): void {
    this.rightsDraft = null
    this.render()
  }

  // ---- notice editor ----

  private startEdit(): void {
    const g = this.host.book.state
    if (!g || !this.host.rights().notice) return
    this.tabs.value = 'notice'
    this.editing = true
    this.titleInput.value = g.notice.title
    this.textInput.value = g.notice.text
    this.render()
    this.titleInput.focus(true)
  }

  private postNotice(): void {
    if (this.host.postNotice(this.titleInput.value, this.textInput.value)) {
      this.editing = false
      this.render()
    }
  }

  private paintRoom(): void {
    const n = noticeRoom(this.titleInput.value, this.textInput.value)
    this.room.textContent = t('guild.noticeRoom', { n })
    this.room.classList.toggle('low', n <= 20)
  }

  // ---- helpers ----

  private img(art: Art, key: string, rect: Rect): HTMLElement {
    const d = place(el('div', 'gd-img'), rect)
    if (art.has(key)) d.style.backgroundImage = art.cssUrl(key)
    return d
  }

  private tile(art: Art, key: string, rect: Rect): HTMLElement {
    const d = place(el('div', 'gd-tile'), rect)
    if (art.has(key)) d.style.backgroundImage = art.cssUrl(key)
    return d
  }
}
