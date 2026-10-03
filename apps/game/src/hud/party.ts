/**
 * Party HUD (docs/QUESTS.md §4.5; lane PT-C): the party state as the server describes it (`party` / `partyVitals`),
 * the member frames under the buff bar (docs/WAVE_PLAN.md decision 27), the party window (P) with the member list,
 * the distribution modes and Leave, and the right-click member menu.
 *
 * The top half is DOM-free (PartyBook, partyRows, memberMenu, ...) so tests can run it; the DOM classes below only
 * render rows and call their handlers. Server authority: nothing here changes the party, the handlers send intents.
 */
import { PARTY_MAX, PARTY_MODES, PARTY_SHARE_RANGE, type PartyExpMode, type PartyItemMode, type PartyMember, type PartyMode, type PartyState, type PartyVitals } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, Listeners, place } from '../ui/dom.ts'
import { button, type KitButton } from '../ui/kit/button.ts'
import { Section } from '../ui/kit/section.ts'
import { layerScale } from '../ui/kit/scale.ts'
import { PARTY_PITCH, PARTY_SLOTS } from './hud-layout.ts'
import { formatNumber } from './items.ts'
import { ensureMainStyles, MainPage } from './main-window.ts'

/** Party colour of names, chat and minimap dots (docs/UX_GAPS.md §6). */
export const PARTY_COLOR = '#9ae6ff'
/** The minimap pin of a party member (interface/minimap/mm_sign_party). */
export const PARTY_PIN = 'minimap/mm_sign_party'
/** The leader crown (interface/ifcommon/com_pt_leader, 12 x 12). */
const CROWN = 'ifcommon/com_pt_leader'

export interface PartyModes {
  exp: PartyExpMode
  items: PartyItemMode
}

/** Modes a new party starts with when nothing was chosen (docs/QUESTS.md §4.1). */
export const DEFAULT_PARTY_MODES: PartyModes = { exp: 'share', items: 'free' }

export interface XZ {
  x: number
  z: number
}

// ---- state -------------------------------------------------------------------------------------------

/** What a `party` message changed, for the chat lines and redraws. */
export interface PartyChange {
  /** null -> a party. */
  formed: boolean
  /** a party -> null. */
  ended: boolean
  /** The exp/items modes changed within the same party. */
  modes: boolean
  /** Who leads changed within the same party. */
  leader: boolean
}

function copyMember(m: PartyMember): PartyMember {
  const c: PartyMember = { ...m }
  if (m.pos) c.pos = [m.pos[0], m.pos[1]]
  return c
}

/** The own party as the server last described it (null = not in one). */
export class PartyBook {
  private party: PartyState | null = null

  get state(): PartyState | null {
    return this.party
  }

  get inParty(): boolean {
    return this.party !== null
  }

  get members(): readonly PartyMember[] {
    return this.party?.members ?? []
  }

  get modes(): PartyModes | null {
    return this.party ? { exp: this.party.exp, items: this.party.items } : null
  }

  get full(): boolean {
    return (this.party?.members.length ?? 0) >= PARTY_MAX
  }

  /** Replaces the whole state (`party` message). */
  set(next: PartyState | null): PartyChange {
    const prev = this.party
    this.party = next ? { ...next, members: next.members.map(copyMember) } : null
    const same = !!prev && !!next && prev.id === next.id
    return {
      formed: !prev && !!next,
      ended: !!prev && !next,
      modes: same && (prev!.exp !== next!.exp || prev!.items !== next!.items),
      leader: same && prev!.leader !== next!.leader,
    }
  }

  /** Merges changed member fields (`partyVitals`). Returns true when something changed; unknown members are ignored. */
  applyVitals(list: readonly PartyVitals[]): boolean {
    if (!this.party) return false
    let changed = false
    for (const v of list) {
      const m = this.party.members.find(x => x.characterId === v.characterId)
      if (!m) continue
      if (v.entity !== undefined && v.entity !== m.entity) {
        m.entity = v.entity
        if (v.entity === null) delete m.pos
        changed = true
      }
      for (const k of ['level', 'hp', 'maxHp', 'mp', 'maxMp'] as const) {
        const val = v[k]
        if (val !== undefined && val !== m[k]) {
          m[k] = val
          changed = true
        }
      }
      if (v.dead !== undefined && v.dead !== !!m.dead) {
        if (v.dead) m.dead = true
        else delete m.dead
        changed = true
      }
      if (v.pos && (!m.pos || m.pos[0] !== v.pos[0] || m.pos[1] !== v.pos[1])) {
        m.pos = [v.pos[0], v.pos[1]]
        changed = true
      }
    }
    return changed
  }

  member(characterId: number): PartyMember | undefined {
    return this.party?.members.find(m => m.characterId === characterId)
  }

  /** The member whose runtime entity is `entity` (online members only). */
  byEntity(entity: number | null | undefined): PartyMember | undefined {
    if (entity === null || entity === undefined || !this.party) return undefined
    return this.party.members.find(m => m.entity === entity)
  }

  /** The own member row (found by the own entity id). */
  self(selfEntity: number | null): PartyMember | undefined {
    return this.byEntity(selfEntity)
  }

  isLeader(selfEntity: number | null): boolean {
    const me = this.self(selfEntity)
    return !!me && !!this.party && me.characterId === this.party.leader
  }

  /** True when `entity` is another member of the own party. */
  isMate(entity: number, selfEntity: number | null): boolean {
    return entity !== selfEntity && !!this.byEntity(entity)
  }

  clear(): void {
    this.party = null
  }
}

// ---- views -------------------------------------------------------------------------------------------

/** One member as the frame and the window draw it. */
export interface PartyRow {
  characterId: number
  name: string
  level: number
  entity: number | null
  leader: boolean
  self: boolean
  offline: boolean
  dead: boolean
  /** Further than PARTY_SHARE_RANGE from you (no EXP or loot share). */
  far: boolean
  hp: number
  maxHp: number
  mp: number
  maxMp: number
}

/** XZ distance in metres. */
export function distanceXZ(a: XZ, b: XZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** A member's position: the live entity when it is in view, else the last `pos` the server sent. */
export function memberPosition(m: PartyMember, livePos: (entity: number) => XZ | null): XZ | null {
  if (m.entity === null) return null
  const live = livePos(m.entity)
  if (live) return live
  return m.pos ? { x: m.pos[0], z: m.pos[1] } : null
}

/**
 * The rows in join order. `livePos` gives the position of an entity in view (null otherwise); a member whose
 * position is unknown is not called far.
 */
export function partyRows(state: PartyState | null, selfEntity: number | null, livePos: (entity: number) => XZ | null): PartyRow[] {
  if (!state) return []
  const me = state.members.find(m => m.entity !== null && m.entity === selfEntity)
  const myPos = me ? memberPosition(me, livePos) : null
  return state.members.map(m => {
    const self = m === me
    const offline = m.entity === null
    const pos = self || offline ? null : memberPosition(m, livePos)
    return {
      characterId: m.characterId,
      name: m.name,
      level: m.level,
      entity: m.entity,
      leader: m.characterId === state.leader,
      self,
      offline,
      dead: !offline && (m.dead === true || (m.maxHp > 0 && m.hp <= 0)),
      far: !!myPos && !!pos && distanceXZ(myPos, pos) > PARTY_SHARE_RANGE,
      hp: m.hp,
      maxHp: m.maxHp,
      mp: m.mp,
      maxMp: m.maxMp,
    }
  })
}

export type PartyMenuAction = 'target' | 'whisper' | 'leader' | 'kick' | 'leave'

/**
 * The right-click menu of a member row (docs/QUESTS.md §4.5): Target and Whisper for others, Make leader (online) and
 * Kick when you lead, Leave always last. `visible`: the member's entity is in view (it can be targeted).
 */
export function memberMenu(row: PartyRow, selfIsLeader: boolean, visible: boolean): PartyMenuAction[] {
  if (row.self) return ['leave']
  const out: PartyMenuAction[] = []
  if (visible && !row.offline) out.push('target')
  if (!row.offline) out.push('whisper')
  if (selfIsLeader) {
    if (!row.offline) out.push('leader')
    out.push('kick')
  }
  out.push('leave')
  return out
}

export function modeLabel(kind: 'exp' | 'items', mode: PartyMode): string {
  return t(`party.mode.${kind}.${mode}` as StringKey)
}

/** "EXP: Shared · Items: Free-for-all". */
export function modesText(m: PartyModes): string {
  return t('party.modes', { exp: modeLabel('exp', m.exp), items: modeLabel('items', m.items) })
}

/** Fraction 0..1 of a gauge. */
export function gauge(value: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
}

/** A member row's hover text: level, HP, MP and state. */
export function rowTitle(r: PartyRow): string {
  const parts = [`${r.name} · ${t('party.level', { level: r.level })}`]
  if (r.leader) parts.push(t('party.leader'))
  if (r.offline) parts.push(t('party.offline'))
  else {
    parts.push(t('hud.gauge', { value: formatNumber(r.hp), max: formatNumber(r.maxHp) }) + ' HP')
    parts.push(t('hud.gauge', { value: formatNumber(r.mp), max: formatNumber(r.maxMp) }) + ' MP')
    if (r.dead) parts.push(t('party.dead'))
    else if (r.far) parts.push(t('party.outOfRange'))
  }
  return parts.join('\n')
}

// ---- styles -------------------------------------------------------------------------------------------

const CSS = `
.hud-party {
  position: absolute; left: 10px; top: 88px; width: 158px;
  display: flex; flex-direction: column; gap: 3px;
  transform-origin: 0 0; pointer-events: auto;
}
.hud-party[hidden] { display: none; }
.hud-party-head {
  font: 10px/12px var(--font-body); color: #e8d9b0; text-shadow: 0 1px 1px #000, 0 0 2px #000;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 2px; cursor: pointer;
}
.hud-party-row, .hud-party-wrow {
  position: relative; box-sizing: border-box; padding: 3px 5px 4px;
  background: linear-gradient(rgba(26, 21, 13, 0.86), rgba(8, 6, 4, 0.86));
  border: 1px solid rgba(156, 131, 80, 0.7); border-radius: 3px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  cursor: pointer; user-select: none;
}
.hud-party-row:hover, .hud-party-wrow:hover { border-color: #f3d58a; }
.hud-party-row.targeted, .hud-party-wrow.targeted { box-shadow: 0 0 0 1px #f3d58a, 0 1px 3px rgba(0, 0, 0, 0.6); }
.hud-party .top, .hud-party-wrow .top {
  display: flex; align-items: center; gap: 3px; height: 13px;
  font: 11px/13px var(--font-body); color: ${PARTY_COLOR}; text-shadow: 0 1px 1px #000; white-space: nowrap;
}
.hud-party .crown, .hud-party-wrow .crown { flex: none; width: 12px; height: 12px; background: no-repeat center / 100% 100%; }
.hud-party .crown.no-art::before, .hud-party-wrow .crown.no-art::before { content: '\\265B'; color: #ffd24a; font-size: 11px; line-height: 12px; }
.hud-party .crown[hidden], .hud-party-wrow .crown[hidden] { display: none; }
.hud-party .name, .hud-party-wrow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.hud-party .lv, .hud-party-wrow .lv { flex: none; color: #f3d7a0; font-size: 10px; }
.hud-party .state, .hud-party-wrow .state { flex: none; color: #ff9a8a; font-size: 10px; }
.hud-party .state:empty, .hud-party-wrow .state:empty { display: none; }
.hud-party .bar, .hud-party-wrow .bar { height: 5px; margin-top: 3px; background: rgba(0, 0, 0, 0.72); border: 1px solid rgba(0, 0, 0, 0.9); }
.hud-party .bar i, .hud-party-wrow .bar i { display: block; height: 100%; width: 0; background: linear-gradient(#e0473a, #9c1e16); transition: width 200ms linear; }
.hud-party .bar.mp i, .hud-party-wrow .bar.mp i { background: linear-gradient(#4a9ef0, #1a4ea8); }
.hud-party-row.offline, .hud-party-wrow.offline { opacity: 0.45; }
.hud-party-row.far, .hud-party-wrow.far { opacity: 0.62; }
.hud-party-row.dead .name, .hud-party-wrow.dead .name { color: #9a9a9a; }
.hud-party-row.dead .bar i, .hud-party-wrow.dead .bar i { filter: grayscale(1); }
.hud-party-row.offline .bar i, .hud-party-wrow.offline .bar i { width: 0 !important; }
.hud-party-wrow.self .top { color: #fff3c4; }


.hud-party-menu {
  position: fixed; z-index: 100000; min-width: 118px; padding: 3px 0; pointer-events: auto;
  background: linear-gradient(rgba(30, 24, 14, 0.96), rgba(10, 8, 5, 0.96)); border: 1px solid #9c8350; border-radius: 3px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.7); font: 12px/1 var(--font-body); color: var(--text);
}
.hud-party-menu[hidden] { display: none; }
.hud-party-menu .hpm-title { padding: 4px 10px 5px; color: ${PARTY_COLOR}; border-bottom: 1px solid rgba(156, 131, 80, 0.45); margin-bottom: 2px; white-space: nowrap; }
.hud-party-menu button { display: block; width: 100%; padding: 5px 10px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; white-space: nowrap; }
.hud-party-menu button:hover { background: rgba(243, 213, 138, 0.18); color: #fff6d8; }
.hud-party-menu button.danger { color: #ffb0a0; }

.entity-label.kind-player.party .name { color: ${PARTY_COLOR}; }
`

let injected = false
export function ensurePartyStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-party'
  style.textContent = CSS
  document.head.append(style)
}

// ---- DOM: one member row ---------------------------------------------------------------------------------

export interface PartyRowHandlers {
  /** Left click on a row. */
  click(row: PartyRow): void
  /** Right click on a row (screen position). */
  menu(row: PartyRow, x: number, y: number): void
}

class RowView {
  readonly root: HTMLElement
  private readonly crown: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly lvEl: HTMLElement
  private readonly stateEl: HTMLElement
  private readonly hp: HTMLElement
  private readonly mp: HTMLElement
  row: PartyRow

  constructor(art: Art, cls: string, row: PartyRow, h: PartyRowHandlers, ls: Listeners) {
    this.row = row
    this.crown = el('span', 'crown')
    if (art.has(CROWN)) this.crown.style.backgroundImage = art.cssUrl(CROWN)
    else this.crown.classList.add('no-art')
    this.crown.title = t('party.leader')
    this.nameEl = el('span', 'name')
    this.lvEl = el('span', 'lv')
    this.stateEl = el('span', 'state')
    this.hp = el('i')
    this.mp = el('i')
    this.root = el('div', cls, el('div', 'top', this.crown, this.nameEl, this.stateEl, this.lvEl), el('div', 'bar hp', this.hp), el('div', 'bar mp', this.mp))
    ls.on(this.root, 'click', ev => {
      ev.stopPropagation()
      h.click(this.row)
    })
    ls.on(this.root, 'contextmenu', ev => {
      ev.preventDefault()
      ev.stopPropagation()
      h.menu(this.row, ev.clientX, ev.clientY)
    })
    ls.on(this.root, 'pointerdown', ev => ev.stopPropagation())
    this.update(row, false)
  }

  update(r: PartyRow, targeted: boolean): void {
    this.row = r
    this.crown.hidden = !r.leader
    if (this.nameEl.textContent !== r.name) this.nameEl.textContent = r.name
    this.lvEl.textContent = t('party.level', { level: r.level })
    this.stateEl.textContent = r.offline ? t('party.offline') : r.dead ? t('party.dead') : ''
    this.hp.style.width = `${(gauge(r.hp, r.maxHp) * 100).toFixed(1)}%`
    this.mp.style.width = `${(gauge(r.mp, r.maxMp) * 100).toFixed(1)}%`
    const c = this.root.classList
    c.toggle('offline', r.offline)
    c.toggle('dead', r.dead)
    c.toggle('far', r.far && !r.offline)
    c.toggle('self', r.self)
    c.toggle('targeted', targeted)
    this.root.title = rowTitle(r)
  }
}

/** Keeps one RowView per member, in row order, reusing the elements between renders. */
class RowList {
  private views = new Map<number, RowView>()

  constructor(
    private readonly art: Art,
    private readonly parent: HTMLElement,
    private readonly cls: string,
    private readonly h: PartyRowHandlers,
    private readonly ls: Listeners,
  ) {}

  render(rows: readonly PartyRow[], targetEntity: number | null): void {
    const next = new Map<number, RowView>()
    const order: HTMLElement[] = []
    for (const r of rows) {
      let v = this.views.get(r.characterId)
      if (!v) v = new RowView(this.art, this.cls, r, this.h, this.ls)
      v.update(r, targetEntity !== null && r.entity === targetEntity)
      next.set(r.characterId, v)
      order.push(v.root)
    }
    for (const [id, v] of this.views) if (!next.has(id)) v.root.remove()
    this.views = next
    const same = order.length === this.parent.childElementCount && order.every((e, i) => this.parent.children[i] === e)
    if (!same) this.parent.replaceChildren(...order)
  }
}

// ---- DOM: the quick party frames (UI-H) ------------------------------------------------------------------

/** The retail quick-party slot (GDR_QPB_SLOT_n, `ifquickpartyslot.txt`): atlas plate `wa_party_slot` 122×40. */
class PartySlot {
  readonly root: HTMLElement
  private readonly face: HTMLElement
  private readonly lv: HTMLElement
  private readonly crown: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly hp: HTMLElement
  private readonly mp: HTMLElement
  row: PartyRow

  constructor(private readonly art: Art, row: PartyRow, h: PartyRowHandlers, ls: Listeners) {
    this.row = row
    this.face = place(el('div', 'uh-ps-face'), [6, 6, 28, 28])
    this.lv = place(el('div', 'uh-ps-lv'), [6, 6, 28, 28])
    this.crown = place(el('div', 'uh-ps-crown'), [30, 4, 12, 12])
    if (art.has(CROWN)) this.crown.style.backgroundImage = art.cssUrl(CROWN)
    this.crown.title = t('party.leader')
    this.nameEl = place(el('div', 'uh-ps-name'), [43, 6, 73, 14])
    this.hp = el('div', 'uh-ps-fill')
    this.mp = el('div', 'uh-ps-fill')
    if (art.has('quickparty/qpt_hp')) this.hp.style.backgroundImage = art.cssUrl('quickparty/qpt_hp')
    if (art.has('quickparty/qpt_mp')) this.mp.style.backgroundImage = art.cssUrl('quickparty/qpt_mp')
    const hpBar = place(el('div', 'uh-ps-bar hp', this.hp), [42, 24, 76, 4])
    const mpBar = place(el('div', 'uh-ps-bar mp', this.mp), [42, 30, 76, 4])
    this.root = el('div', 'uh-ps', this.face, this.lv, this.crown, this.nameEl, hpBar, mpBar)
    if (art.has('ifcommon/wa_party_slot')) this.root.style.backgroundImage = art.cssUrl('ifcommon/wa_party_slot')
    else this.root.classList.add('no-art')
    ls.on(this.root, 'click', ev => {
      ev.stopPropagation()
      h.click(this.row)
    })
    ls.on(this.root, 'contextmenu', ev => {
      ev.preventDefault()
      ev.stopPropagation()
      h.menu(this.row, ev.clientX, ev.clientY)
    })
    ls.on(this.root, 'pointerdown', ev => ev.stopPropagation())
    this.update(row, false)
  }

  update(r: PartyRow, targeted: boolean): void {
    this.row = r
    this.crown.hidden = !r.leader
    if (this.nameEl.textContent !== r.name) this.nameEl.textContent = r.name
    this.lv.textContent = r.offline ? '' : String(r.level)
    // Face: black normally, blue while out of share range or offline, red when dead or low (qpt_face_*).
    const low = !r.offline && !r.dead && r.maxHp > 0 && r.hp / r.maxHp < 0.25
    const face = r.dead || low ? 'quickparty/qpt_face_warning' : r.far || r.offline ? 'quickparty/qpt_face_faraway' : 'quickparty/qpt_face'
    this.face.style.backgroundImage = this.art.has(face) ? this.art.cssUrl(face) : ''
    const clip = (f: number) => `inset(0 ${((1 - f) * 100).toFixed(1)}% 0 0)`
    this.hp.style.clipPath = clip(r.offline ? 0 : gauge(r.hp, r.maxHp))
    this.mp.style.clipPath = clip(r.offline ? 0 : gauge(r.mp, r.maxMp))
    const c = this.root.classList
    c.toggle('offline', r.offline)
    c.toggle('dead', r.dead)
    c.toggle('far', r.far && !r.offline)
    c.toggle('targeted', targeted)
    this.root.title = rowTitle(r)
  }
}

/**
 * The other members at GDR_QUICKPARTYBOARD (4,137): up to 7 retail slots, 44 px apart (docs/UI.md §4.2). The modes
 * line is kept for the chat hint but hidden (retail shows none); the P window has the modes.
 */
export class PartyFrame {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly list: HTMLElement
  private views = new Map<number, PartySlot>()
  private readonly ls = new Listeners()

  constructor(private readonly art: Art, parent: HTMLElement, private readonly h: PartyRowHandlers & { head(): void }) {
    ensurePartyStyles()
    this.head = el('div', 'hud-party-head')
    this.head.hidden = true
    this.list = el('div', 'uh-party-list')
    this.root = el('div', 'hud-party uh-party hud-block', this.head, this.list)
    if (art.has('quickparty/qpt_grope_select')) this.root.style.setProperty('--uh-select', art.cssUrl('quickparty/qpt_grope_select'))
    this.root.hidden = true
    this.ls.on(this.head, 'click', ev => {
      ev.stopPropagation()
      h.head()
    })
    this.ls.on(this.root, 'pointerdown', ev => ev.stopPropagation())
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    parent.append(this.root)
  }

  /** `rows`: the other members; empty hides the frame. */
  render(rows: readonly PartyRow[], modes: PartyModes | null, targetEntity: number | null): void {
    this.root.hidden = rows.length === 0
    if (this.root.hidden) return
    const head = modes ? modesText(modes) : ''
    if (this.head.textContent !== head) this.head.textContent = head
    const next = new Map<number, PartySlot>()
    const order: HTMLElement[] = []
    rows.slice(0, PARTY_SLOTS).forEach((r, i) => {
      let v = this.views.get(r.characterId)
      if (!v) v = new PartySlot(this.art, r, this.h, this.ls)
      v.update(r, targetEntity !== null && r.entity === targetEntity)
      v.root.style.top = `${i * PARTY_PITCH}px`
      next.set(r.characterId, v)
      order.push(v.root)
    })
    for (const [id, v] of this.views) if (!next.has(id)) v.root.remove()
    this.views = next
    const same = order.length === this.list.childElementCount && order.every((e, i) => this.list.children[i] === e)
    if (!same) this.list.replaceChildren(...order)
  }

  /** Kept for callers: the retail board has a fixed place (hud/hud-layout.ts PARTY), nothing to follow. */
  layout(): void {}

  dispose(): void {
    this.ls.clear()
    this.root.remove()
  }
}

// ---- DOM: the P window -------------------------------------------------------------------------------------

export interface PartyWindowHandlers extends PartyRowHandlers {
  /** A mode button: the leader changes the party, anyone out of a party changes the modes for a new one. */
  setMode(kind: 'exp' | 'items', mode: PartyMode): void
  leave(): void
}

export interface PartyWindowView {
  rows: readonly PartyRow[]
  /** The party's modes, or (not in a party) the modes a new party would get. */
  modes: PartyModes
  inParty: boolean
  leader: boolean
  targetEntity: number | null
}

/** The other value of a two-way party mode (the mode lines toggle on click). */
export function nextPartyMode(mode: PartyMode): PartyMode {
  const i = PARTY_MODES.indexOf(mode)
  return PARTY_MODES[(i + 1) % PARTY_MODES.length]!
}

/**
 * The Main window's Party tab (P; docs/UI.md §4.6, retail `ifparty.txt` `GDR_PARTY` (13,38,364,337)): the
 * `sframe_wnd_` "Party information" panel with one `pt_slot` row per member (face, name, level, `pt_hp` / `pt_mp`
 * gauges), the `pt_msg` board with the EXP and item distribution lines (◆ `com_diamond`; a click toggles the mode when
 * you may change it) and the Leave button at (143, 339).
 */
export class PartyWindow extends MainPage {
  private readonly section: Section
  private readonly list: HTMLElement
  private readonly none: HTMLElement
  private readonly modeLines: Record<'exp' | 'items', HTMLButtonElement>
  private readonly leaveBtn: KitButton
  private readonly rows: RowList
  private last: PartyWindowView | null = null

  constructor(art: Art, parent: HTMLElement, private readonly h: PartyWindowHandlers) {
    super(art, parent, { id: 'party', tab: 'party', title: t('party.title') })
    ensurePartyStyles()
    ensureMainStyles()
    this.section = new Section(art, { at: [0, 0, 364, 303], caption: t('party.win.caption'), className: 'pt-panel' })
    for (const [k, v] of [['--pt-slot', 'party/pt_slot'], ['--pt-face', 'party/pt_face'], ['--pt-hp', 'party/pt_hp'], ['--pt-mp', 'party/pt_mp'], ['--pt-hp-off', 'party/pt_hp_disable'], ['--pt-mp-off', 'party/pt_mp_disable']] as const) {
      if (art.has(v)) this.body.style.setProperty(k, art.cssUrl(v))
    }
    this.list = place(el('div', 'pt-list'), [2, 30, 360, 270])
    this.none = place(el('div', 'pt-none', el('div', 'kit-t-value', t('party.none')), el('div', 'pt-none-hint', t('party.noneHint'))), [20, 60, 324, 120])
    this.section.root.append(this.list, this.none)
    const board = place(el('div', 'pt-board'), [0, 304, 364, 36])
    if (art.has('party/pt_msg')) board.style.backgroundImage = art.cssUrl('party/pt_msg')
    else board.classList.add('no-art')
    const line = (kind: 'exp' | 'items', x: number) => {
      const b = place(el('button', `pt-mode pt-mode-${kind}`), [x, 8, 160, 17])
      b.type = 'button'
      const diamond = el('span', 'pt-diamond')
      if (art.has('ifcommon/com_diamond')) diamond.style.backgroundImage = art.cssUrl('ifcommon/com_diamond')
      b.append(diamond, el('span', 'pt-mode-text'))
      this.ls.on(b, 'click', () => {
        const v = this.last
        if (!v || b.disabled) return
        h.setMode(kind, nextPartyMode(v.modes[kind]))
      })
      board.append(b)
      return b
    }
    this.modeLines = { items: line('items', 30), exp: line('exp', 186) }
    this.leaveBtn = button(art, { label: t('party.leave') }, () => h.leave())
    place(this.leaveBtn, [143, 339, 0, 24])
    this.leaveBtn.hidden = true
    this.body.append(this.section.root, board, this.leaveBtn)
    this.rows = new RowList(art, this.list, 'hud-party-wrow', h, this.ls)
  }

  render(v: PartyWindowView): void {
    this.last = v
    if (!this.isOpen) return
    this.section.setCaption(v.inParty ? `${t('party.win.caption')}  ${t('party.count', { n: v.rows.length, max: PARTY_MAX })}` : t('party.win.caption'))
    this.none.hidden = v.inParty
    this.list.hidden = !v.inParty
    this.rows.render(v.inParty ? v.rows : [], v.targetEntity)
    const editable = !v.inParty || v.leader
    const note = v.inParty ? (v.leader ? t('party.win.clickToChange') : t('party.settingsLeaderOnly')) : t('party.settingsNewHint')
    for (const kind of ['exp', 'items'] as const) {
      const b = this.modeLines[kind]
      const mode = v.modes[kind]
      const text = b.querySelector('.pt-mode-text')!
      const s = `${t(`party.mode.${kind}`)}: ${modeLabel(kind, mode)}`
      if (text.textContent !== s) text.textContent = s
      b.disabled = !editable
      b.title = `${t(`party.mode.${kind}.${mode}.hint` as StringKey)}\n${note}`
    }
    this.leaveBtn.hidden = !v.inParty
  }

  protected override onOpen(): void {
    if (this.last) this.render(this.last)
  }
}

// ---- DOM: the member menu -----------------------------------------------------------------------------------

export interface PartyMenuEntry {
  label: string
  run(): void
  danger?: boolean
}

/** A small right-click menu; closes on a choice, a click elsewhere or Esc (through the feature). */
export class PartyMenu {
  readonly root: HTMLElement
  private readonly ls = new Listeners()
  private readonly outside = new Listeners()

  constructor(private readonly parent: HTMLElement) {
    ensurePartyStyles()
    this.root = el('div', 'hud-party-menu')
    this.root.hidden = true
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    this.ls.on(this.root, 'pointerdown', ev => ev.stopPropagation())
    parent.append(this.root)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  show(title: string, entries: readonly PartyMenuEntry[], x: number, y: number): void {
    this.hide()
    if (!entries.length) return
    const items = entries.map(e => {
      const b = el('button', e.danger ? 'danger' : '', e.label)
      b.type = 'button'
      b.addEventListener('click', ev => {
        ev.stopPropagation()
        this.hide()
        e.run()
      })
      return b
    })
    this.root.replaceChildren(el('div', 'hpm-title', title), ...items)
    this.root.hidden = false
    // x, y are viewport px; the menu lives in the zoomed HUD layer (native px).
    const k = layerScale(this.parent)
    const w = this.root.offsetWidth
    const h = this.root.offsetHeight
    this.root.style.left = `${Math.max(4, Math.min(x / k, window.innerWidth / k - w - 4))}px`
    this.root.style.top = `${Math.max(4, Math.min(y / k, window.innerHeight / k - h - 4))}px`
    // Any press outside closes it (registered after this event finished).
    setTimeout(() => {
      if (this.root.hidden) return
      this.outside.on(window, 'pointerdown', ev => {
        if (!this.root.contains(ev.target as Node | null)) this.hide()
      }, { capture: true })
      this.outside.on(window, 'blur', () => this.hide())
    }, 0)
  }

  hide(): void {
    this.outside.clear()
    if (this.root.hidden) return
    this.root.hidden = true
    this.root.replaceChildren()
  }

  dispose(): void {
    this.hide()
    this.ls.clear()
    this.root.remove()
  }
}

