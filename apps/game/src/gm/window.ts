/**
 * The in-game GM (Game Master) window, for gm/admin accounts only. Wave 7B UI-G (docs/UI.md §4.6, §9.1): a kit
 * Window in the retail `mframe_wnd_` frame (live title, the title strip drags it, `com_windowclose`, a resize grip),
 * `com_new_tab_*` flex tabs in two rows, the pages in an `int_window_` panel, kit lists (`com_bar01_` rows), kit
 * fields (`frame_msg_` on `com_bg_tile_e`), buttons, check box and slider. It lives in its own zoomed layer
 * (`.gm-layer`, zoom: var(--ui)) in the world screen root, so it is laid out in native px like the HUD windows.
 * Position (kit: `sro.hud.gm`), size (after a resize) and tab (`sro.gm.window`) are remembered.
 *
 * Tabs: Players (`who` list, Go to / Summon / Kick), Teleport (x/z, places, cursor point), Broadcast (`notice`),
 * Self (speed, invisibility, set level, heal), Spawn (spawn monsters, kill), Items (create items and gold), Log (results).
 * A second row holds the tabs other modules add with `registerGmTab` (the content editors: Spawns, NPCs, Quests);
 * their plain DOM gets the same retail art from gm/editors/style.ts.
 * Every message goes through src/gm/commands.ts, so it passes the shared protocol validator.
 */
import { contentEntries, DEFAULT_LEVEL_CAP, type ClientMessage, type GmPlayerInfo, type GmPreset, type MobDef, type Role, type ServerMessage } from '@sro/shared'
import { loadItemCatalog, type ItemCatalog } from '../hud/items.ts'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, Listeners } from '../ui/dom.ts'
import {
  button,
  Checkbox,
  List,
  MessageBox,
  nineSlice,
  NumberInput,
  ScrollArea,
  Slider,
  TabBar,
  TextInput,
  Window as KitWindow,
  type ButtonName,
  type KitButton,
} from '../ui/kit/index.ts'
import {
  fmtCoord,
  gm,
  GM_HOME_PRESET,
  GM_ITEM_MAX,
  GM_NOTICE_MAX,
  GM_QUICK_ITEMS,
  GM_QUICK_MOBS,
  GM_SPAWN_MAX,
  prettyMob,
  GM_SPEED_MAX,
  GM_SPEED_MIN,
  groupPlaces,
  readPlayers,
  readPresets,
  readSelfFlags,
  regionText,
  type GmBuild,
  type GmMessage,
} from './commands.ts'
import { applyGmArt, injectEditorStyles } from './editors/style.ts'

export type GmResultMsg = Extract<ServerMessage, { t: 'gmResult' }>

export interface GmHost {
  art: Art
  /** Where the window lives (the world screen root). */
  parent: HTMLElement
  /** Where modal dialogs went (app.ui); the kick box is now a kit MessageBox (its own body-level layer). */
  modalParent: HTMLElement
  /** Sends a message; false when not connected. */
  send(msg: ClientMessage): boolean
  selfName(): string
  selfPos(): { x: number; z: number } | null
  /** Ground point under the mouse cursor (last seen over the 3D view). */
  cursorGround(): { x: number; z: number } | null
}

type TabId = 'players' | 'teleport' | 'broadcast' | 'self' | 'spawn' | 'items' | 'log' | (string & {})
const TABS: { id: TabId; label: StringKey }[] = [
  { id: 'players', label: 'gm.tab.players' },
  { id: 'teleport', label: 'gm.tab.teleport' },
  { id: 'broadcast', label: 'gm.tab.broadcast' },
  { id: 'self', label: 'gm.tab.self' },
  { id: 'spawn', label: 'gm.tab.spawn' },
  { id: 'items', label: 'gm.tab.items' },
  { id: 'log', label: 'gm.tab.log' },
]

/** Default outer size (native px) of the kit window: the mframe chrome takes 32 × 60 of it. */
export const GM_WINDOW_W = 540
export const GM_WINDOW_H = 440
/** The resize grip's limits. */
export const GM_WINDOW_MIN: readonly [number, number] = [470, 360]
const STORE_KEY = 'sro.gm.window'
const LOG_MAX = 200
const PENDING_MAX = 50
/** Kick reason length (the server's argument limit is checked again by gm.kick). */
const KICK_REASON_MAX = 100

export interface GmLogEntry {
  at: number
  kind: 'sent' | 'ok' | 'fail'
  cmd: string
  text: string
}

/** GM log for this page: survives closing the window and re-entering the world. */
const history: GmLogEntry[] = []

// ---- extra tabs (lane ED-C: the content editors, docs/QUESTS.md §5; a second tab row) -------------------------

/** What an extra tab may use of its GM window. */
export interface GmTabApi {
  readonly host: GmHost
  /** Sends a built command (see GmWindow.run). */
  run(build: GmBuild, opts?: { chat?: boolean; log?: boolean }): boolean
  /** The window's status line. */
  setStatus(text: string, bad?: boolean): void
  /** Whether this tab is the one showing in an open window. */
  isShown(): boolean
}

export interface GmTab {
  readonly root: HTMLElement
  /** The tab became visible (window open and this tab selected) / stopped being visible. */
  show?(): void
  hide?(): void
  /** Every gmResult the window sees (its own commands and slash commands typed in chat). */
  onResult?(msg: GmResultMsg): void
  dispose?(): void
}

export interface GmTabSpec {
  id: string
  label: string
  make(api: GmTabApi): GmTab
}

const extraTabs: GmTabSpec[] = []
const liveWindows = new Set<GmWindow>()
/** Extra height of the window while it has extra tabs (the second tab row and room for the editors). */
const EXTRA_TABS_H = 90

/** Adds a tab to every GM window (now and later) until the returned function is called. */
export function registerGmTab(spec: GmTabSpec): () => void {
  const i = extraTabs.findIndex(s => s.id === spec.id)
  if (i >= 0) extraTabs.splice(i, 1)
  extraTabs.push(spec)
  for (const w of liveWindows) w.addExtraTab(spec)
  return () => {
    const k = extraTabs.indexOf(spec)
    if (k >= 0) extraTabs.splice(k, 1)
    for (const w of liveWindows) w.removeExtraTab(spec.id)
  }
}

interface Saved {
  tab: TabId
  /** Outer size after a resize with the grip (native px). */
  w?: number
  h?: number
}

function loadSaved(): Partial<Saved> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const v = raw ? (JSON.parse(raw) as Partial<Saved>) : {}
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function save(v: Saved): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v))
  } catch {
    // storage blocked: the tab and size are simply not remembered
  }
}

/** A remembered size that is a real number at least `min`, else undefined. */
function savedSize(v: unknown, min: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.round(v)) : undefined
}

/** The command text as a GM would type it in chat (for the log). */
export function commandText(msg: GmMessage): string {
  return `/${[msg.cmd, ...msg.args].join(' ')}`
}

function clock(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/** The kit window, telling the GM window when the grip resized it. */
class GmFrame extends KitWindow {
  onResized: (() => void) | null = null

  override resize(w: number, h: number): void {
    super.resize(w, h)
    this.onResized?.()
  }
}

/** Unselects every tab of a bar (the selected tab is in the other row). */
function clearTabs(bar: TabBar<string>): void {
  for (const b of bar.root.querySelectorAll<HTMLElement>('.kit-tab')) {
    b.classList.remove('on')
    b.setAttribute('aria-selected', 'false')
  }
}

export class GmWindow {
  readonly root: HTMLElement
  private readonly ls = new Listeners()
  private readonly layer: HTMLElement
  private readonly win: GmFrame
  private readonly undoArt: () => void
  private readonly status: HTMLElement
  private readonly mainTabs: TabBar<string>
  private extraBar: TabBar<string> | null = null
  private readonly panels = new Map<TabId, HTMLElement>()
  private readonly page: HTMLElement
  private tab: TabId
  private roleText = ''
  private cursorTimer: ReturnType<typeof setInterval> | undefined
  /** Replies the window asked for, in send order: whether each should be echoed to chat / the log. */
  private readonly pending: { cmd: string; chat: boolean; log: boolean }[] = []
  /** The GM resized the window with the grip (the extra tab row then no longer changes its size). */
  private userSized = false
  private autoSizing = false

  // players
  private players: GmPlayerInfo[] = []
  private selected = ''
  private readonly playerList: List<GmPlayerInfo>
  private readonly playerEmpty: HTMLElement
  private readonly playerCount: HTMLElement
  // teleport
  private readonly fieldX: TextInput
  private readonly fieldZ: TextInput
  private readonly placeRow: HTMLElement
  private readonly placeSearch: TextInput
  private readonly cursorText: HTMLElement
  private presets: GmPreset[] | null = null
  // broadcast
  private readonly noticeField: HTMLTextAreaElement
  private readonly noticeCount: HTMLElement
  // self
  private readonly speed: Slider
  private readonly speedValue: HTMLElement
  private readonly invis: Checkbox
  private readonly levelName: TextInput
  private readonly levelValue: NumberInput
  private selfSpeed = 1
  private selfInvisible = false
  // log
  private readonly logScroll: ScrollArea
  // heal / spawn / kill / items
  private readonly healName: TextInput
  private readonly mobList: HTMLDataListElement
  private readonly spawnCode: TextInput
  private readonly spawnCount: NumberInput
  private readonly mobQuick: HTMLElement
  private readonly killId: TextInput
  private readonly itemList: HTMLDataListElement
  private readonly itemCode: TextInput
  private readonly itemCount: NumberInput
  private readonly itemQuick: HTMLElement
  private mobNames = new Map<string, string>()
  private items: ItemCatalog | null = null
  private disposed = false
  // extra tabs (registerGmTab)
  private readonly extraRow: HTMLElement
  private readonly extras = new Map<string, { tab: GmTab; label: string; shown: boolean }>()
  private readonly savedTab: string | undefined

  constructor(
    private readonly host: GmHost,
    role: Role,
    levelCap = DEFAULT_LEVEL_CAP,
  ) {
    const art = host.art
    injectEditorStyles()
    this.undoArt = applyGmArt(host.parent, art)
    const saved = loadSaved()
    this.tab = TABS.some(x => x.id === saved.tab) ? saved.tab! : 'players'
    const w = savedSize(saved.w, GM_WINDOW_MIN[0])
    const h = savedSize(saved.h, GM_WINDOW_MIN[1])
    this.userSized = w !== undefined && h !== undefined

    // The window's own zoomed layer in the world root (native px, like .hud-root / .world-ui).
    this.layer = el('div', 'gm-layer')
    host.parent.append(this.layer)
    this.win = new GmFrame(art, this.layer, {
      id: 'gm',
      title: t('gm.title'),
      width: this.userSized ? w! : GM_WINDOW_W,
      height: this.userSized ? h! : GM_WINDOW_H,
      at: [0.75, 0.1],
      resizable: { minW: GM_WINDOW_MIN[0], minH: GM_WINDOW_MIN[1] },
      className: 'gm-kit',
    })
    this.win.onClose = () => this.afterClose()
    this.win.onResized = () => {
      if (this.autoSizing) return
      this.userSized = true
      this.persist()
    }
    if (this.win.closeButton) {
      this.win.closeButton.title = t('gm.close')
      this.win.closeButton.setAttribute('aria-label', t('gm.close'))
    }
    this.root = this.win.root
    const body = this.win.body

    this.mainTabs = new TabBar<string>(
      art,
      'flex',
      TABS.map(x => ({ id: x.id, label: t(x.label) })),
      { className: 'gm-tabs' },
    )
    for (const x of TABS) this.mainTabs.tab(x.id)?.addEventListener('click', () => this.showTab(x.id))
    this.extraRow = el('div', 'gm-tabs-extra')
    this.extraRow.hidden = true
    this.page = el('div', 'gm-page')
    nineSlice(this.page, art, 'inner')
    this.status = el('div', 'gm-status')
    this.savedTab = typeof saved.tab === 'string' ? saved.tab : undefined
    body.append(this.mainTabs.root, this.extraRow, this.page, this.status)

    // ---- Players ------------------------------------------------------------------------------
    this.playerCount = el('span', 'gm-muted')
    const refresh = this.button('gm.players.refresh')
    this.ls.on(refresh, 'click', () => this.refreshPlayers(true))
    this.playerList = new List<GmPlayerInfo>(art, { render: p => this.playerRow(p), className: 'gm-plist' })
    this.playerList.onSelect = p => this.select(p.name, p.level)
    this.playerEmpty = el('div', 'gm-empty')
    const head = el(
      'div',
      'gm-phead',
      el('span', 'gm-c-name', t('gm.players.colName')),
      el('span', 'gm-c-lv', t('gm.players.colLevel')),
      el('span', 'gm-c-pos', `${t('gm.players.colPos')} / ${t('gm.players.colRegion')}`),
      el('span', 'gm-c-act'),
    )
    this.addPanel('players', true, el('div', 'gm-bar', refresh, this.playerCount), head, this.listBox(this.playerList.root, this.playerEmpty), el('div', 'gm-hint', t('gm.players.hint')))

    // ---- Teleport -----------------------------------------------------------------------------
    this.fieldX = this.field(t('gm.tp.x'), 72)
    this.fieldZ = this.field(t('gm.tp.z'), 72)
    const go = this.button('gm.tp.go')
    const mine = this.button('gm.tp.mine', 'mid')
    this.ls.on(go, 'click', () => this.run(gm.tpFields(this.fieldX.value, this.fieldZ.value)))
    this.ls.on(mine, 'click', () => {
      const p = host.selfPos()
      if (!p) return
      this.fieldX.value = fmtCoord(p.x)
      this.fieldZ.value = fmtCoord(p.z)
    })
    for (const f of [this.fieldX, this.fieldZ]) this.onEnter(f.input, () => this.run(gm.tpFields(this.fieldX.value, this.fieldZ.value)))
    this.placeRow = el('div', 'gm-place-groups')
    this.placeSearch = this.field(t('gm.tp.search'), 180, 64)
    this.placeSearch.input.placeholder = t('gm.tp.search')
    this.ls.on(this.placeSearch.input, 'input', () => this.renderPlaces())
    const npc = this.button('gm.tp.npc', 'mid')
    npc.title = t('gm.tp.npcTitle')
    this.ls.on(npc, 'click', () => this.run(gm.tpNpc(this.placeSearch.value)))
    // Enter: the one place left by the search, else the NPC search.
    this.onEnter(this.placeSearch.input, () => {
      const hits = groupPlaces(this.presets ?? [], this.placeSearch.value).flatMap(g => g.places)
      this.run(hits.length === 1 ? gm.tpPlace(hits[0].name) : gm.tpNpc(this.placeSearch.value))
    })
    this.cursorText = el('div', 'gm-cursor')
    const here = this.button('gm.tp.here', 'mid')
    const copy = this.button('gm.tp.useCursor', 'mid')
    this.ls.on(here, 'click', () => {
      const p = host.cursorGround()
      if (!p) return this.setStatus(t('gm.err.noCursor'), true)
      this.run(gm.tpTo(p.x, p.z))
    })
    this.ls.on(copy, 'click', () => {
      const p = host.cursorGround()
      if (!p) return this.setStatus(t('gm.err.noCursor'), true)
      this.fieldX.value = fmtCoord(p.x)
      this.fieldZ.value = fmtCoord(p.z)
    })
    this.addScrollPanel(
      'teleport',
      this.section('gm.tp.coords', this.line(this.label(t('gm.tp.x')), this.fieldX.root, this.label(t('gm.tp.z')), this.fieldZ.root, go, mine)),
      this.section('gm.tp.places', this.line(this.placeSearch.root, npc), this.placeRow),
      this.section('gm.tp.cursorTitle', this.cursorText, this.line(here, copy), el('div', 'gm-hint', t('gm.tp.hint'))),
    )
    this.renderPlaces()

    // ---- Broadcast ----------------------------------------------------------------------------
    this.noticeField = el('textarea', 'gm-notice-text')
    this.noticeField.maxLength = GM_NOTICE_MAX
    this.noticeField.placeholder = t('gm.notice.placeholder')
    this.noticeField.spellcheck = true
    this.noticeField.setAttribute('aria-label', t('gm.notice.label'))
    const area = el('div', 'kit-field gm-area', this.noticeField)
    nineSlice(area, art, 'field')
    this.noticeCount = el('span', 'gm-muted')
    const send = this.button('gm.notice.send')
    const sendNotice = () => {
      if (this.run(gm.notice(this.noticeField.value))) {
        this.noticeField.value = ''
        this.updateNoticeCount()
      }
    }
    this.ls.on(send, 'click', sendNotice)
    this.ls.on(this.noticeField, 'input', () => this.updateNoticeCount())
    this.ls.on(this.noticeField, 'keydown', ev => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) sendNotice()
    })
    this.addScrollPanel('broadcast', this.section('gm.notice.label', area, el('div', 'gm-line gm-right', this.noticeCount, send)))
    this.updateNoticeCount()

    // ---- Self ---------------------------------------------------------------------------------
    this.speed = new Slider(art, { min: GM_SPEED_MIN, max: GM_SPEED_MAX, step: 0.5, value: 1, w: 170, label: t('gm.self.speed') })
    this.speed.onInput = v => this.showSpeed(v)
    this.speedValue = el('span', 'gm-value')
    const apply = this.button('gm.self.apply')
    const normal = this.button('gm.self.reset')
    this.ls.on(apply, 'click', () => this.run(gm.speed(this.speed.value)))
    this.ls.on(normal, 'click', () => {
      this.showSpeed(1)
      this.run(gm.speed(1))
    })
    this.invis = new Checkbox(art, { label: t('gm.self.invisible') })
    this.invis.onChange = want => {
      this.invis.checked = this.selfInvisible // the server's answer decides
      this.run(gm.invis(want))
    }
    this.levelName = this.field(t('gm.self.levelPlayer'), 112, 13)
    this.levelValue = new NumberInput(art, { min: 1, max: levelCap, value: 1, w: 72, label: t('gm.self.levelValue') })
    const setLevel = this.button('gm.self.levelSet')
    const doSetLevel = () => this.run(gm.setLevel(this.levelName.value, Number(this.levelValue.input.value.trim() || Number.NaN), levelCap))
    this.ls.on(setLevel, 'click', doSetLevel)
    for (const f of [this.levelName.input, this.levelValue.input]) this.onEnter(f, doSetLevel)

    // ---- Heal (Self tab) ------------------------------------------------------------------------
    this.healName = this.field(t('gm.heal.player'), 112, 13)
    const heal = this.button('gm.heal.go')
    const healMe = this.button('gm.heal.self')
    this.ls.on(heal, 'click', () => this.run(gm.heal(this.healName.value)))
    this.ls.on(healMe, 'click', () => this.run(gm.heal()))
    this.onEnter(this.healName.input, () => this.run(gm.heal(this.healName.value)))
    this.addScrollPanel(
      'self',
      this.section('gm.self.speed', this.line(this.speed.root, this.speedValue, apply, normal)),
      this.section('gm.self.invisible', this.invis.root, el('div', 'gm-hint', t('gm.self.invisibleHint'))),
      this.section(
        'gm.self.level',
        this.line(this.label(t('gm.self.levelPlayer')), this.levelName.root, this.label(t('gm.self.levelValue')), this.levelValue.root, setLevel),
        el('div', 'gm-hint', t('gm.self.levelHint')),
      ),
      this.section('gm.heal.title', this.line(this.label(t('gm.heal.player')), this.healName.root, heal, healMe), el('div', 'gm-hint', t('gm.heal.hint'))),
    )
    this.showSpeed(1)

    // ---- Spawn (monsters, kill) -------------------------------------------------------------------
    this.mobList = el('datalist')
    this.mobList.id = `gm-mobs-${++listSeq}`
    this.spawnCode = this.field(t('gm.spawn.code'), 190, 0, 'gm-code')
    this.spawnCode.input.setAttribute('list', this.mobList.id)
    this.spawnCode.value = GM_QUICK_MOBS[0]!
    this.spawnCount = new NumberInput(art, { min: 1, max: GM_SPAWN_MAX, value: 1, w: 64, label: t('gm.spawn.count') })
    const spawn = this.button('gm.spawn.go')
    const doSpawn = () => this.run(gm.spawn(this.spawnCode.value, this.spawnCount.input.value))
    this.ls.on(spawn, 'click', doSpawn)
    for (const f of [this.spawnCode.input, this.spawnCount.input]) this.onEnter(f, doSpawn)
    this.mobQuick = el('div', 'gm-places')
    this.renderMobQuick()
    this.killId = this.field(t('gm.kill.id'), 72)
    const kill = this.button('gm.kill.go')
    const killTarget = this.button('gm.kill.target', 'mid')
    this.ls.on(kill, 'click', () => this.run(gm.kill(this.killId.value)))
    this.ls.on(killTarget, 'click', () => this.run(gm.kill()))
    this.onEnter(this.killId.input, () => this.run(gm.kill(this.killId.value)))
    this.addScrollPanel(
      'spawn',
      this.section(
        'gm.spawn.title',
        this.line(this.label(t('gm.spawn.code')), this.spawnCode.root, this.label(t('gm.spawn.count')), this.spawnCount.root, spawn),
        el('div', 'gm-sub', t('gm.spawn.quick')),
        this.mobQuick,
        el('div', 'gm-hint', t('gm.spawn.hint', { max: GM_SPAWN_MAX })),
        this.mobList,
      ),
      this.section('gm.kill.title', this.line(this.label(t('gm.kill.id')), this.killId.root, kill, killTarget), el('div', 'gm-hint', t('gm.kill.hint'))),
    )

    // ---- Items ------------------------------------------------------------------------------------
    this.itemList = el('datalist')
    this.itemList.id = `gm-items-${++listSeq}`
    this.itemCode = this.field(t('gm.items.code'), 190, 0, 'gm-code')
    this.itemCode.input.setAttribute('list', this.itemList.id)
    this.itemCode.value = GM_QUICK_ITEMS[0]!.code
    this.itemCount = new NumberInput(art, { min: 1, max: GM_ITEM_MAX, value: 1, w: 96, label: t('gm.items.count') })
    const give = this.button('gm.items.go')
    const doGive = () => this.run(gm.item(this.itemCode.value, this.itemCount.input.value))
    this.ls.on(give, 'click', doGive)
    for (const f of [this.itemCode.input, this.itemCount.input]) this.onEnter(f, doGive)
    this.itemQuick = el('div', 'gm-places')
    this.renderItemQuick()
    this.addScrollPanel(
      'items',
      this.section(
        'gm.items.title',
        this.line(this.label(t('gm.items.code')), this.itemCode.root, this.label(t('gm.items.count')), this.itemCount.root, give),
        el('div', 'gm-sub', t('gm.items.quick')),
        this.itemQuick,
        el('div', 'gm-hint', t('gm.items.hint')),
        this.itemList,
      ),
    )
    void this.loadContent()

    // ---- Log ----------------------------------------------------------------------------------
    this.logScroll = new ScrollArea(art, { className: 'gm-log' })
    const clear = this.button('gm.log.clear')
    this.ls.on(clear, 'click', () => {
      history.length = 0
      this.renderLog()
    })
    this.addPanel('log', true, this.listBox(this.logScroll.root), el('div', 'gm-line gm-right', clear))
    this.renderLog()

    for (const p of this.panels.values()) this.page.append(p)
    // Keys typed in the window stay in the window (the world uses Enter / Esc / F8 on its own).
    this.ls.on(this.root, 'keydown', ev => {
      if (ev.key === 'F9') return
      ev.stopPropagation()
      if (ev.key === 'Escape') (document.activeElement as HTMLElement | null)?.blur()
    })
    this.setRole(role)
    liveWindows.add(this)
    for (const spec of extraTabs) this.addExtraTab(spec)
    this.showTab(this.tab, false)
  }

  // ---- extra tabs -------------------------------------------------------------------------------

  /** Adds (or replaces) an extra tab in the second row (registerGmTab calls this). */
  addExtraTab(spec: GmTabSpec): void {
    if (this.disposed) return
    this.removeExtraTab(spec.id)
    const api: GmTabApi = {
      host: this.host,
      run: (build, opts) => this.run(build, opts),
      setStatus: (text, bad = false) => this.setStatus(text, bad),
      isShown: () => this.isOpen && this.tab === spec.id,
    }
    let tab: GmTab
    try {
      tab = spec.make(api)
    } catch (err) {
      console.error(`[gm] tab ${spec.id} failed to start`, err)
      return
    }
    const panel = el('div', `gm-pane gm-panel-extra gm-panel-${spec.id}`, tab.root)
    panel.hidden = true
    this.panels.set(spec.id, panel)
    this.page.append(panel)
    this.extras.set(spec.id, { tab, label: spec.label, shown: false })
    this.buildExtraBar()
    this.fitExtras()
    if (this.savedTab === spec.id && !this.isOpen) this.tab = spec.id
    if (this.tab === spec.id) this.showTab(spec.id, false)
    else this.paintTabs()
  }

  removeExtraTab(id: string): void {
    const x = this.extras.get(id)
    if (!x) return
    if (x.shown) x.tab.hide?.()
    try {
      x.tab.dispose?.()
    } catch (err) {
      console.error(`[gm] tab ${id} failed to stop`, err)
    }
    this.extras.delete(id)
    this.panels.get(id)?.remove()
    this.panels.delete(id)
    this.buildExtraBar()
    this.fitExtras()
    if (this.tab === id) this.showTab('players', false)
    else this.paintTabs()
  }

  /** The second tab row: rebuilt from the extra tabs (a kit TabBar has a fixed tab set). */
  private buildExtraBar(): void {
    this.extraBar = null
    this.extraRow.replaceChildren()
    this.extraRow.hidden = !this.extras.size
    if (!this.extras.size) return
    const bar = new TabBar<string>(
      this.host.art,
      'flex',
      [...this.extras].map(([id, x]) => ({ id, label: x.label })),
      { className: 'gm-tabs' },
    )
    for (const id of this.extras.keys()) bar.tab(id)?.addEventListener('click', () => this.showTab(id))
    this.extraRow.append(bar.root)
    this.extraBar = bar
  }

  /** Grows the window for the editor tabs (and back), unless the GM sized it. */
  private fitExtras(): void {
    if (this.userSized || this.disposed) return
    const want = GM_WINDOW_H + (this.extras.size ? EXTRA_TABS_H : 0)
    if (this.win.size[1] === want) return
    this.autoSizing = true
    this.win.resize(GM_WINDOW_W, want)
    this.autoSizing = false
  }

  /** Tells the extra tabs whether they are showing (after a tab switch, open or close). */
  private syncExtras(): void {
    for (const [id, x] of this.extras) {
      const want = this.isOpen && this.tab === id
      if (want === x.shown) continue
      x.shown = want
      try {
        if (want) x.tab.show?.()
        else x.tab.hide?.()
      } catch (err) {
        console.error(`[gm] tab ${id} failed`, err)
      }
    }
  }

  // ---- building blocks --------------------------------------------------------------------------

  private button(label: StringKey, skin: ButtonName = 'std'): KitButton {
    return button(this.host.art, { label: t(label), skin, className: 'gm-button' })
  }

  private smallButton(label: StringKey): KitButton {
    return button(this.host.art, { label: t(label), skin: 'tiny', className: 'gm-button gm-small' })
  }

  private field(aria: string, w: number, maxLength = 0, className = ''): TextInput {
    return new TextInput(this.host.art, { label: aria, w, maxLength: maxLength || undefined, className })
  }

  private label(text: string): HTMLElement {
    return el('label', 'gm-label', text)
  }

  private line(...children: HTMLElement[]): HTMLElement {
    return el('div', 'gm-line', ...children)
  }

  private onEnter(f: HTMLElement, fn: () => void): void {
    this.ls.on(f, 'keydown', ev => {
      if (ev.key === 'Enter') fn()
    })
  }

  private section(title: StringKey, ...children: HTMLElement[]): HTMLElement {
    return el('div', 'gm-section', el('div', 'gm-section-title', t(title)), ...children)
  }

  /** A list box (`com_blacksquare_`) around a kit List / ScrollArea, with an optional empty-state line. */
  private listBox(content: HTMLElement, empty?: HTMLElement): HTMLElement {
    const box = el('div', 'gm-listbox', content, empty ?? null)
    nineSlice(box, this.host.art, 'black')
    return box
  }

  private addPanel(id: TabId, flex: boolean, ...children: HTMLElement[]): void {
    this.panels.set(id, el('div', `gm-pane gm-pane-${id} ${flex ? 'gm-pane-flex' : ''}`.trim(), ...children))
  }

  /** A page of sections in a kit ScrollArea (the retail scroll bar shows when the page does not fit). */
  private addScrollPanel(id: TabId, ...children: HTMLElement[]): void {
    const scroll = new ScrollArea(this.host.art, { className: `gm-pane gm-pane-${id}` })
    scroll.view.append(el('div', 'gm-scroll-body', ...children))
    this.panels.set(id, scroll.root)
  }

  /** Monster and item names for the quick picks and the code suggestions (mobs.json / items.json, optional). */
  private async loadContent(): Promise<void> {
    const [mobs, items] = await Promise.all([loadMobNames(), loadItemCatalog()])
    if (this.disposed) return
    this.mobNames = mobs
    this.items = items
    const option = (value: string, label: string) => {
      const o = el('option', '', label)
      o.value = value
      return o
    }
    this.mobList.replaceChildren(...[...mobs].map(([code, name]) => option(code, name)))
    this.itemList.replaceChildren(...items.codes.map(code => option(code, items.name(code))))
    this.renderMobQuick()
    this.renderItemQuick()
  }

  private renderMobQuick(): void {
    this.mobQuick.replaceChildren()
    for (const code of GM_QUICK_MOBS) {
      const b = button(this.host.art, { label: this.mobNames.get(code) ?? prettyMob(code), minWidth: 96, title: code, className: 'gm-button' }, () => {
        this.spawnCode.value = code
        this.run(gm.spawn(code, this.spawnCount.input.value))
      })
      this.mobQuick.append(b)
    }
  }

  private renderItemQuick(): void {
    this.itemQuick.replaceChildren()
    for (const q of GM_QUICK_ITEMS) {
      const label = q.code === 'ITEM_ETC_GOLD_01' ? t('gm.items.gold') : `${this.items?.name(q.code) ?? q.code}${q.count > 1 ? ` x${q.count}` : ''}`
      const b = button(this.host.art, { label, width: 156, title: `${q.code} x${q.count}`, className: 'gm-button gm-quick' }, () => {
        this.itemCode.value = q.code
        this.itemCount.set(q.count)
        this.run(gm.item(q.code, q.count))
      })
      this.itemQuick.append(b)
    }
  }

  // ---- window state -----------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.win.isOpen
  }

  setRole(role: Role): void {
    this.roleText = role === 'admin' ? t('gm.role.admin') : t('gm.role.gm')
    this.win.setTitle(`${t('gm.title')} (${this.roleText})`)
  }

  open(): void {
    if (this.isOpen) return
    this.win.open()
    this.showTab(this.tab, false)
    this.refreshPlayers(false)
    this.cursorTimer = setInterval(() => this.updateCursor(), 150)
    this.updateCursor()
  }

  close(): void {
    this.win.close()
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  /** The kit window closed (close button, close(), Esc on the top window). */
  private afterClose(): void {
    clearInterval(this.cursorTimer)
    this.cursorTimer = undefined
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
    this.syncExtras()
  }

  private showTab(id: TabId, persist = true): void {
    this.tab = id
    this.paintTabs()
    for (const [k, p] of this.panels) p.hidden = k !== id
    if (id === 'teleport' && this.isOpen && this.presets === null) this.run(gm.places(), { chat: false, log: false })
    if (id === 'log') this.renderLog()
    if (persist) this.persist()
    this.syncExtras()
  }

  /** One selected tab over both rows. */
  private paintTabs(): void {
    const isMain = TABS.some(x => x.id === this.tab)
    if (isMain) this.mainTabs.value = this.tab
    else clearTabs(this.mainTabs)
    if (!this.extraBar) return
    if (!isMain && this.extras.has(this.tab)) this.extraBar.value = this.tab
    else clearTabs(this.extraBar)
  }

  private persist(): void {
    const [w, h] = this.win.size
    save(this.userSized ? { tab: this.tab, w, h } : { tab: this.tab })
  }

  private setStatus(text: string, bad = false): void {
    this.status.textContent = text
    this.status.title = text
    this.status.classList.toggle('bad', bad)
  }

  // ---- commands ---------------------------------------------------------------------------------

  /**
   * Sends a built command. `chat` / `log`: whether the reply is echoed to the chat box / the Log tab
   * (window-internal queries such as the player list are not). Returns false on a validation error.
   */
  run(build: GmBuild, opts: { chat?: boolean; log?: boolean } = {}): boolean {
    if (!build.ok) {
      this.setStatus(build.error, true)
      return false
    }
    if (!this.host.send(build.msg)) {
      this.setStatus(t('gm.err.offline'), true)
      return false
    }
    const log = opts.log ?? true
    this.pending.push({ cmd: build.msg.cmd, chat: opts.chat ?? true, log })
    if (this.pending.length > PENDING_MAX) this.pending.shift()
    if (log) this.record({ at: Date.now(), kind: 'sent', cmd: build.msg.cmd, text: t('gm.log.sent', { command: commandText(build.msg) }) })
    return true
  }

  /** A slash command typed in chat (sent as chat by the world): shown in the log like the window's own. */
  noteTyped(text: string): void {
    const cmd = text.replace(/^\//, '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    this.record({ at: Date.now(), kind: 'sent', cmd, text: t('gm.log.sent', { command: text.trim() }) })
  }

  private refreshPlayers(log: boolean): void {
    if (!this.players.length) this.playerCount.textContent = t('gm.players.loading')
    this.run(gm.who(), { chat: false, log })
  }

  /**
   * A gmResult arrived (from the window or from a slash command typed in chat).
   * Returns whether the world should echo it as a chat line.
   */
  onResult(msg: GmResultMsg): boolean {
    const i = this.pending.findIndex(p => p.cmd === msg.cmd)
    const req = i >= 0 ? this.pending.splice(i, 1)[0]! : { cmd: msg.cmd, chat: true, log: true }
    // Actions that change the player list refresh it afterwards.
    let refresh = false
    if (req.log) this.record({ at: Date.now(), kind: msg.ok ? 'ok' : 'fail', cmd: msg.cmd, text: msg.message })
    if (req.log || req.chat) this.setStatus(msg.message.split('\n')[0] ?? '', !msg.ok)
    if (msg.ok) {
      switch (msg.cmd) {
        case 'who': {
          const players = readPlayers(msg.data)
          if (players) this.setPlayers(players)
          break
        }
        case 'tp': {
          const presets = readPresets(msg.data)
          if (presets) {
            this.presets = presets
            this.renderPlaces()
          } else refresh = true
          break
        }
        case 'speed':
        case 'invis':
          this.noteSelf(readSelfFlags(msg.data))
          break
        case 'summon':
        case 'kick':
        case 'setlevel':
          refresh = true
          break
      }
    }
    if (refresh && this.isOpen && msg.ok) this.refreshPlayers(false)
    for (const [id, x] of this.extras) {
      try {
        x.tab.onResult?.(msg)
      } catch (err) {
        console.error(`[gm] tab ${id} failed`, err)
      }
    }
    return req.chat
  }

  /** Self flags from a result, `who`, or an entityUpdate about our own entity. */
  noteSelf(flags: { speed?: number; invisible?: boolean }): void {
    if (flags.speed !== undefined) {
      this.selfSpeed = flags.speed
      this.showSpeed(flags.speed)
    }
    if (flags.invisible !== undefined) {
      this.selfInvisible = flags.invisible
      this.invis.checked = flags.invisible
    }
  }

  /** Our speed/invisibility reset (left the world, role change). */
  resetSelf(): void {
    this.noteSelf({ speed: 1, invisible: false })
  }

  private showSpeed(v: number): void {
    if (this.speed.value !== v) this.speed.set(v)
    this.speedValue.textContent = t('gm.self.speedValue', { value: v })
    this.speedValue.classList.toggle('changed', v !== this.selfSpeed)
  }

  private updateNoticeCount(): void {
    this.noticeCount.textContent = t('gm.notice.count', { n: [...this.noticeField.value].length, max: GM_NOTICE_MAX })
  }

  private updateCursor(): void {
    if (this.tab !== 'teleport') return
    const p = this.host.cursorGround()
    this.cursorText.textContent = p ? t('gm.tp.cursor', { x: fmtCoord(p.x), z: fmtCoord(p.z) }) : t('gm.tp.cursorNone')
  }

  // ---- players ----------------------------------------------------------------------------------

  private setPlayers(players: GmPlayerInfo[]): void {
    this.players = players
    const me = this.host.selfName().toLowerCase()
    const self = players.find(p => p.name.toLowerCase() === me)
    if (self) this.noteSelf({ speed: self.speed, invisible: self.invisible })
    this.playerCount.textContent = t('gm.players.count', { count: players.length })
    this.playerList.setItems(players)
    this.playerEmpty.textContent = players.length ? '' : t('gm.players.none')
    this.playerEmpty.hidden = players.length > 0
    const i = players.findIndex(p => p.name === this.selected)
    if (i >= 0) this.playerList.select(i)
  }

  private playerRow(p: GmPlayerInfo): HTMLElement {
    const isSelf = p.name.toLowerCase() === this.host.selfName().toLowerCase()
    const badges: (HTMLElement | null)[] = [
      p.role !== 'player' ? el('span', `gm-badge ${p.role}`, p.role === 'admin' ? t('gm.role.admin') : t('gm.role.gm')) : null,
      isSelf ? el('span', 'gm-badge you', t('gm.players.you')) : null,
      p.invisible ? el('span', 'gm-badge ghost', t('gm.players.invisible')) : null,
    ]
    const region = regionText(p)
    const goTo = this.smallButton('gm.players.goto')
    const summon = this.smallButton('gm.players.summon')
    const kick = this.smallButton('gm.players.kick')
    if (isSelf) for (const b of [goTo, summon, kick]) b.setDisabled(true)
    // The row buttons act without selecting the row.
    const act = (b: KitButton, fn: () => void) =>
      b.addEventListener('click', ev => {
        ev.stopPropagation()
        if (!b.isDisabled) fn()
      })
    act(goTo, () => this.run(gm.tpPlayer(p.name)))
    act(summon, () => this.run(gm.summon(p.name)))
    act(kick, () => this.confirmKick(p.name))
    const row = el(
      'div',
      'gm-prow',
      el('span', 'gm-c-name', el('span', 'gm-pname', p.name), ...badges),
      el('span', 'gm-c-lv', String(p.level)),
      el('span', 'gm-c-pos', `${fmtCoord(p.pos[0])}, ${fmtCoord(p.pos[2])}`, region ? el('span', 'gm-muted', ` ${region}`) : null),
      el('span', 'gm-c-act', goTo, summon, kick),
    )
    row.title = t('gm.players.rowTitle', { name: p.name, account: p.account || '?', speed: p.speed })
    return row
  }

  private select(name: string, level: number): void {
    this.selected = name
    this.levelName.value = name
    this.levelValue.set(level)
    const i = this.players.findIndex(p => p.name === name)
    if (i >= 0 && this.playerList.selected !== i) this.playerList.select(i)
  }

  /** The kick box: a kit prompt for the (optional) reason. */
  private confirmKick(name: string): void {
    void MessageBox.prompt({
      art: this.host.art,
      title: t('gm.kick.title', { name }),
      text: t('gm.kick.body'),
      maxLength: KICK_REASON_MAX,
      allowEmpty: true,
      ok: t('gm.kick.confirm'),
    }).then(reason => {
      if (reason === null || this.disposed) return
      this.run(gm.kick(name, reason))
    })
  }

  // ---- teleport places ----------------------------------------------------------------------------

  /** The places by group (Town, Fields, Coast, Bosses, Other), filtered by the search box; a click teleports. */
  private renderPlaces(): void {
    this.placeRow.replaceChildren()
    const place = (label: string, name: string, title?: string) =>
      button(this.host.art, { label, title, className: 'gm-button' }, () => this.run(gm.tpPlace(name)))
    if (this.presets === null) {
      this.placeRow.append(el('div', 'gm-places', place(t('gm.tp.home'), GM_HOME_PRESET)))
      if (this.isOpen) this.placeRow.append(el('span', 'gm-muted', t('gm.tp.placesLoading')))
      return
    }
    const groups = groupPlaces(this.presets, this.placeSearch.value)
    if (groups.length === 0) this.placeRow.append(el('div', 'gm-muted', t('gm.tp.noMatch')))
    for (const g of groups) {
      const row = el('div', 'gm-places')
      for (const p of g.places) {
        const label = p.name.toLowerCase() === GM_HOME_PRESET ? t('gm.tp.home') : p.name
        const aka = p.aliases?.length ? ` (${p.aliases.join(', ')})` : ''
        row.append(place(label, p.name, `${p.name}${aka}: ${fmtCoord(p.x)}, ${fmtCoord(p.z)}`))
      }
      this.placeRow.append(el('div', 'gm-place-group', el('div', 'gm-label gm-place-head', t(`gm.tp.group.${g.group}`)), row))
    }
  }

  // ---- log ----------------------------------------------------------------------------------------

  private record(entry: GmLogEntry): void {
    history.push(entry)
    if (history.length > LOG_MAX) history.splice(0, history.length - LOG_MAX)
    if (this.tab === 'log' && this.isOpen) this.renderLog()
  }

  private renderLog(): void {
    const lines = history.length
      ? history.map(e => el('div', `gm-log-line ${e.kind}`, el('span', 'gm-log-time', clock(e.at)), el('span', 'gm-log-text', e.text)))
      : [el('div', 'gm-empty', t('gm.log.empty'))]
    this.logScroll.view.replaceChildren(el('div', 'gm-log-body', ...lines))
    this.logScroll.refresh()
    this.logScroll.toBottom()
  }

  dispose(): void {
    this.close()
    for (const id of [...this.extras.keys()]) this.removeExtraTab(id)
    liveWindows.delete(this)
    this.disposed = true
    clearInterval(this.cursorTimer)
    this.ls.clear()
    this.win.dispose()
    this.layer.remove()
    this.undoArt()
  }
}

let listSeq = 0
let mobNames: Promise<Map<string, string>> | null = null

/**
 * Monster code -> English name from /out/data/mobs.json (Chinese mobs up to level 30, level order), once per page.
 * Empty when the file is missing: the quick picks then show prettified codes.
 */
function loadMobNames(): Promise<Map<string, string>> {
  mobNames ??= fetch('/out/data/mobs.json', { cache: 'no-cache' })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    .then(json => {
      const mobs = contentEntries<MobDef>(json, 'mobs')
        .filter(m => m && typeof m.code === 'string' && /^MOB_CH_/.test(m.code) && m.level <= 30)
        .sort((a, b) => a.level - b.level || a.code.localeCompare(b.code))
      return new Map(mobs.map(m => [m.code, m.name ? `${m.name} (Lv ${m.level})` : m.code]))
    })
    .catch(() => new Map<string, string>())
  return mobNames
}
