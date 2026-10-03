/**
 * World feature of lane PT-C, the party client (docs/QUESTS.md §4.5; WAVE_PLAN §5.2). Only that lane edits this file;
 * see world/features.ts for the context and hooks. It wires:
 * - the party state (`party`, `partyVitals`) into the member frames under the buff bar and the party window (P and the
 *   menu-bar Party button; binding id 'window.party', menu-bar id 'party' as W4-FC registered them);
 * - the invitation popup (`partyInvited`), the event lines (`partyEvent`) and the refusals of the invite/answer;
 * - the Invite button of the target window on player targets (Hud.addTargetAction, M3);
 * - party chat: a line starting with `#` goes to the party channel (ChatBox.registerPrefix);
 * - minimap pins for the members (addMarkerSource) and the party colour on their name tags (setLabelClass('party')).
 *
 * PartyController is the DOM-free part (tests drive it with a fake PartyIo); the factory binds it to the HUD.
 */
import type { ActionFailReason, ClientMessage, PartyMode, ServerMessage } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import { intent } from '../../hud/intents.ts'
import { InvitePopup, pendingInvite, type PendingInvite } from '../../hud/party-invite.ts'
import {
  DEFAULT_PARTY_MODES,
  memberMenu,
  memberPosition,
  modeLabel,
  PARTY_COLOR,
  PARTY_PIN,
  PartyBook,
  PartyFrame,
  PartyMenu,
  partyRows,
  PartyWindow,
  type PartyMenuAction,
  type PartyMenuEntry,
  type PartyModes,
  type PartyRow,
  type XZ,
} from '../../hud/party.ts'
import type { TargetAction, TargetInfo } from '../../hud/target.ts'
import { intents } from '../intents.ts'
import type { HudMarker, HudMinimap } from '../jangan/minimap.ts'
import type { WorldFeatureFactory } from '../features.ts'

/** What the controller needs from the world (tests pass a fake). */
export interface PartyIo {
  /** Sends a built intent; false (and nothing sent) for null or when offline. */
  send(msg: ClientMessage | null): boolean
  /** Own entity id (null before worldEnter). */
  selfId(): number | null
  /** Own character name (null before worldEnter). */
  selfName(): string | null
  /** Position of an entity in view (null when it is not). */
  livePos(entity: number): XZ | null
  /** A party-coloured line in the chat log. */
  line(text: string): void
  /** A refusal: centre-screen error toast. */
  error(text: string): void
  /** A problem with a typed chat line: an error line in the chat log. */
  chatError(text: string): void
  /** Local clock in ms. */
  now(): number
  /** The party or the invitation changed: redraw. */
  changed(): void
}

const MODES_KEY = 'sro.party.modes'

function isMode(v: unknown): v is PartyMode {
  return v === 'free' || v === 'share'
}

/** The modes a new party gets (remembered per browser); defaults when nothing valid is stored. */
export function loadModes(): PartyModes {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(MODES_KEY) ?? 'null') as { exp?: unknown; items?: unknown } | null
    return { exp: isMode(raw?.exp) ? raw.exp : DEFAULT_PARTY_MODES.exp, items: isMode(raw?.items) ? raw.items : DEFAULT_PARTY_MODES.items }
  } catch {
    return { ...DEFAULT_PARTY_MODES }
  }
}

function saveModes(m: PartyModes): void {
  try {
    globalThis.localStorage?.setItem(MODES_KEY, JSON.stringify(m))
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
}

/**
 * The line for a refused partyInvite / partyRespond: the server's own sentence when it sent one (it names the player),
 * else the party's wording for the reason, else the generic reason line.
 */
export function partyFailText(re: 'partyInvite' | 'partyRespond', reason: ActionFailReason | undefined, message?: string): string {
  if (message) return message
  if (reason) {
    const key = `party.fail.${re === 'partyInvite' ? 'invite' : 'respond'}.${reason}` as StringKey
    const own = t(key)
    if (own !== key) return own
    const generic = t(`action.fail.${reason}` as StringKey)
    if (generic !== `action.fail.${reason}`) return generic
  }
  return t('action.fail.generic')
}

export class PartyController {
  readonly book = new PartyBook()
  /** The invitation waiting for an answer. */
  invite: PendingInvite | null = null
  /** Modes a party started by our invitation gets. */
  modes: PartyModes
  /** The last invitation shown, kept after it closed so a late 'expired' line names the right side. */
  private lastInvite: { name: string; answered: boolean } | null = null
  /** Names of our outstanding invitations, oldest first (for the "sent" line). */
  private readonly sent: string[] = []
  private leaving = false

  constructor(private readonly io: PartyIo, modes: PartyModes = loadModes()) {
    this.modes = { ...modes }
  }

  /** Every server message. */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'worldEnter':
        // A new visit: the server sends `party` right after the enter sequence when we are in one.
        this.book.clear()
        this.invite = null
        this.lastInvite = null
        this.sent.length = 0
        this.leaving = false
        this.io.changed()
        break
      case 'party': {
        const change = this.book.set(msg.party)
        if (change.formed) this.io.line(t('party.formed'))
        if (change.ended) {
          if (this.leaving) this.io.line(t('party.event.leftSelf'))
          this.leaving = false
        }
        if (change.modes && msg.party) this.io.line(t('party.modesLine', { exp: modeLabel('exp', msg.party.exp), items: modeLabel('items', msg.party.items) }))
        if (msg.party) this.invite = null
        this.io.changed()
        break
      }
      case 'partyVitals':
        if (this.book.applyVitals(msg.members)) this.io.changed()
        break
      case 'partyInvited':
        this.invite = pendingInvite(msg, this.io.now())
        this.lastInvite = { name: msg.name, answered: false }
        this.io.changed()
        break
      case 'partyEvent':
        this.event(msg.event, msg.name)
        break
      case 'actionResult':
        if (msg.re === 'partyInvite') {
          const name = this.sent.shift()
          if (msg.ok) {
            if (name) this.io.line(t('party.inviteSent', { name }))
          } else this.io.error(partyFailText('partyInvite', msg.reason, msg.message))
        } else if (msg.re === 'partyRespond' && !msg.ok) {
          this.io.error(partyFailText('partyRespond', msg.reason, msg.message))
        } else if (msg.re === 'partyLeave' && !msg.ok) {
          this.leaving = false
        }
        break
    }
  }

  private event(event: Extract<ServerMessage, { t: 'partyEvent' }>['event'], name: string): void {
    const self = !!name && name === this.io.selfName()
    switch (event) {
      case 'expired': {
        const fromInviter = (this.invite?.name === name) || (this.lastInvite?.name === name && !this.invite)
        if (this.invite?.name === name) {
          this.invite = null
          this.io.changed()
        }
        if (fromInviter) {
          if (!this.lastInvite?.answered) this.io.line(t('party.inviteExpiredFrom', { name }))
          this.lastInvite = null
        } else this.io.line(t('party.event.expired', { name }))
        return
      }
      case 'joined':
        this.io.line(self ? t('party.event.joinedSelf') : t('party.event.joined', { name }))
        return
      case 'left':
        this.io.line(self ? t('party.event.leftSelf') : t('party.event.left', { name }))
        return
      case 'kicked':
        this.io.line(self ? t('party.event.kickedSelf') : t('party.event.kicked', { name }))
        return
      case 'leader':
        this.io.line(self ? t('party.event.leaderSelf') : t('party.event.leader', { name }))
        return
      case 'disbanded':
        this.leaving = false
        this.io.line(t('party.event.disbanded'))
        return
      case 'declined':
        this.io.line(t('party.event.declined', { name }))
        return
      case 'offline':
        this.io.line(t('party.event.offline', { name }))
        return
      case 'online':
        this.io.line(t('party.event.online', { name }))
        return
      case 'settings':
        this.io.line(t('party.event.settings', { name }))
        return
    }
  }

  /** Drops the invitation once its time is up (the server's 'expired' line follows). */
  tick(now: number): void {
    if (this.invite && now >= this.invite.expiresAt) {
      this.invite = null
      this.io.changed()
    }
  }

  get leader(): boolean {
    return this.book.isLeader(this.io.selfId())
  }

  /** The Invite button shows for other players who are not with us, while we can invite. */
  canInvite(target: Pick<TargetInfo, 'id' | 'kind'>): boolean {
    if (target.kind !== 'player') return false
    const self = this.io.selfId()
    if (self === null || target.id === self) return false
    if (!this.book.inParty) return true
    return !this.book.isMate(target.id, self) && this.leader && !this.book.full
  }

  inviteTarget(target: Pick<TargetInfo, 'id' | 'name'>): void {
    // The modes only matter when this invitation starts a party.
    const msg = this.book.inParty ? intent.partyInvite(target.id) : intent.partyInvite(target.id, this.modes.exp, this.modes.items)
    if (this.io.send(msg)) this.sent.push(target.name)
  }

  respond(accept: boolean): void {
    const inv = this.invite
    if (!inv) return
    this.invite = null
    if (this.lastInvite) this.lastInvite.answered = true
    this.io.send(intent.partyRespond(inv.inviter, accept))
    if (!accept) this.io.line(t('party.inviteDeclinedSelf', { name: inv.name }))
    this.io.changed()
  }

  leave(): void {
    if (!this.book.inParty) return
    if (this.io.send(intent.partyLeave())) this.leaving = true
  }

  kick(characterId: number): void {
    this.io.send(intent.partyKick(characterId))
  }

  makeLeader(characterId: number): void {
    this.io.send(intent.partyLeader(characterId))
  }

  /** In a party: the leader changes it. Out of one: the modes a new party will get. */
  setMode(kind: 'exp' | 'items', mode: PartyMode): void {
    const current = this.book.modes
    if (current) {
      if (current[kind] === mode) return
      if (!this.leader) {
        this.io.error(t('action.fail.not_leader'))
        return
      }
      this.io.send(intent.partySettings(kind === 'exp' ? { exp: mode } : { items: mode }))
      return
    }
    if (this.modes[kind] === mode) return
    this.modes = { ...this.modes, [kind]: mode }
    saveModes(this.modes)
    this.io.changed()
  }

  /** `#text` typed in the chat. */
  partyChat(text: string): void {
    if (!text) return
    if (!this.book.inParty) {
      this.io.chatError(t('party.chatNoParty'))
      return
    }
    this.io.send(intents.chat(text, undefined, 'party'))
  }

  rows(): PartyRow[] {
    return partyRows(this.book.state, this.io.selfId(), e => this.io.livePos(e))
  }

  /** Minimap pins of the other online members (live position when in view, else the last `pos`). */
  markers(): HudMarker[] {
    const self = this.io.selfId()
    const out: HudMarker[] = []
    for (const m of this.book.members) {
      if (m.entity === null || m.entity === self) continue
      const p = memberPosition(m, e => this.io.livePos(e))
      if (p) out.push({ x: p.x, z: p.z, color: PARTY_COLOR, icon: PARTY_PIN, size: 10 })
    }
    return out
  }
}

/** Seconds between layout and range refreshes of the frames. */
const REFRESH_S = 0.25

export const partyFeature: WorldFeatureFactory = ctx => {
  const { hud, app, chat } = ctx
  let selfName: string | null = null
  let dirty = true
  let refresh = 0
  let shownInvite: PendingInvite | null = null

  const ctl = new PartyController({
    send: msg => !!msg && ctx.send(msg),
    selfId: () => ctx.selfId(),
    selfName: () => {
      const id = ctx.selfId()
      return (id !== null ? ctx.view(id)?.state.name : undefined) ?? selfName
    },
    livePos: entity => {
      const v = ctx.view(entity)
      return v && !v.isDisposed ? { x: v.pos.x, z: v.pos.z } : null
    },
    line: text => chat.add('party', text),
    error: text => hud.toast(text, 'error'),
    chatError: text => chat.add('error', text),
    now: () => performance.now(),
    changed: () => {
      dirty = true
    },
  })

  const targetMember = (row: PartyRow): boolean => {
    const v = row.entity !== null ? ctx.view(row.entity) : undefined
    if (!v || !v.selectable) return false
    ctx.setTarget(v)
    return true
  }

  const menu = new PartyMenu(hud.layer)
  const LABELS: Record<PartyMenuAction, StringKey> = { target: 'party.target', whisper: 'party.whisper', leader: 'party.makeLeader', kick: 'party.kick', leave: 'party.leave' }
  const openMenu = (row: PartyRow, x: number, y: number) => {
    const visible = row.entity !== null && !!ctx.view(row.entity)?.selectable
    const entries: PartyMenuEntry[] = memberMenu(row, ctl.leader, visible).map(action => ({
      label: t(LABELS[action]),
      danger: action === 'kick' || action === 'leave',
      run: () => {
        if (action === 'target') targetMember(row)
        else if (action === 'whisper') chat.startWhisper(row.name)
        else if (action === 'leader') ctl.makeLeader(row.characterId)
        else if (action === 'kick') ctl.kick(row.characterId)
        else ctl.leave()
      },
    }))
    menu.show(row.name, entries, x, y)
  }
  const rowHandlers = {
    click: (row: PartyRow) => {
      if (!row.self) targetMember(row)
    },
    menu: openMenu,
  }

  const win = new PartyWindow(app.art, hud.layer, { ...rowHandlers, setMode: (kind, mode) => ctl.setMode(kind, mode), leave: () => ctl.leave() })
  win.onClose = () => menu.hide()
  const frame = new PartyFrame(app.art, hud.layer, { ...rowHandlers, head: () => win.toggle() })
  const popup = new InvitePopup(app.art, hud.layer, accept => ctl.respond(accept))

  // ---- name tags ----
  const labelFor = (v: { id: number; kind: string; isSelf: boolean; setLabelClass(cls: string, on: boolean): void }) => {
    if (v.kind === 'player') v.setLabelClass('party', !v.isSelf && ctl.book.isMate(v.id, ctx.selfId()))
  }
  let labelKey = ''
  const syncLabels = () => {
    const key = ctl.book.members.map(m => m.entity ?? '-').join(',')
    if (key === labelKey) return
    labelKey = key
    for (const v of ctx.views()) labelFor(v)
  }

  // ---- redraw ----
  const render = () => {
    dirty = false
    const rows = ctl.rows()
    const target = ctx.target()
    const targetEntity = target ? target.id : null
    frame.render(rows.filter(r => !r.self), ctl.book.modes, targetEntity)
    win.render({ rows, modes: ctl.book.modes ?? ctl.modes, inParty: ctl.book.inParty, leader: ctl.leader, targetEntity })
    if (ctl.invite !== shownInvite) {
      shownInvite = ctl.invite
      if (shownInvite) {
        popup.show(shownInvite, performance.now())
        gameAudio()?.ui('ui.windowOpen')
      } else popup.hide()
    }
    if (!ctl.book.inParty) menu.hide()
    syncLabels()
    syncActions()
  }

  // ---- the Invite button of the target window ----
  const actions: TargetAction[] = [{ id: 'partyInvite', label: t('party.invite'), title: t('party.inviteHint'), show: tgt => ctl.canInvite(tgt), run: tgt => ctl.inviteTarget(tgt) }]
  let actionsKey = ''
  /** Re-checks the button for the current target when what it depends on changed (party, leader, size). */
  const syncActions = () => {
    const key = `${ctl.leader}|${ctl.book.full}|${labelKey}`
    if (key === actionsKey) return
    actionsKey = key
    hud.refreshTargetActions()
  }

  // ---- minimap pins (the minimap exists once the world has loaded) ----
  let pinned: HudMinimap | null = null
  let offPins: (() => void) | null = null
  const syncMinimap = () => {
    const mm = ctx.minimap()
    if (mm === pinned) return
    offPins?.()
    pinned = mm
    offPins = mm ? mm.addMarkerSource(() => ctl.markers()) : null
  }

  const offs = [
    ctx.keys.register({ id: 'window.party', keys: ['p'], label: 'keys.window.party', group: 'windows', run: () => win.toggle() }),
    hud.menubar.register({ id: 'party', art: 'mainpopup/main_sysbutton_party', label: 'party.title', hotkey: 'P', order: 50, toggle: () => win.toggle(), isOpen: () => win.isOpen }),
    ...actions.map(a => hud.addTargetAction(a)),
    chat.registerPrefix('#', rest => ctl.partyChat(rest)),
  ]
  hud.claimRequests(['partyLeave', 'partyKick', 'partyLeader', 'partySettings'])
  syncActions()
  syncMinimap()

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') selfName = msg.self.name
      ctl.handle(msg)
      if (dirty) render()
    },
    onFrame(_now, dt) {
      const now = performance.now()
      ctl.tick(now)
      popup.tick(now)
      refresh -= dt
      if (refresh <= 0) {
        refresh = REFRESH_S
        frame.layout()
        syncMinimap()
        dirty = true
      }
      if (dirty) render()
    },
    onEntityAdded(v) {
      labelFor(v)
    },
    escape() {
      if (menu.isOpen) {
        menu.hide()
        return true
      }
      if (win.isOpen) {
        win.close()
        return true
      }
      return false
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      offPins?.()
      offPins = null
      for (const v of ctx.views()) if (v.kind === 'player') v.setLabelClass('party', false)
      menu.dispose()
      popup.dispose()
      frame.dispose()
      win.dispose()
    },
  }
}
