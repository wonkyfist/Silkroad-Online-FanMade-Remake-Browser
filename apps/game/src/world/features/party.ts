/**
 * World feature of lane PT-C, the party client (docs/QUESTS.md §4.5; WAVE_PLAN §5.2). Only that lane edits this file;
 * see world/features.ts for the context and hooks. It wires:
 * - the party state (`party`, `partyVitals`) into the member frames under the buff bar and the party window (P and the
 *   menu-bar Party button; binding id 'window.party', menu-bar id 'party' as W4-FC registered them);
 * - the invitation popup (`partyInvited`), the event lines (`partyEvent`) and the refusals of the invite/answer;
 * - the Invite button of the target window on player targets (Hud.addTargetAction, M3), the window's Invite /
 *   Settings / Leave buttons, and the retail chat commands `/party` (`/InviteToParty`) [name], `/LeaveTheParty`,
 *   `/BanishFromParty name`. An invitation that starts a party first asks for the EXP and item modes in the retail
 *   party setting box (`ifsetpartymode`, MessageBox.choose), which the window's Settings button also opens;
 * - party chat: a line starting with `#` goes to the party channel (ChatBox.registerPrefix);
 * - minimap pins for the members (addMarkerSource) and the party colour on their name tags (setLabelClass('party')).
 *
 * PartyController is the DOM-free part (tests drive it with a fake PartyIo); the factory binds it to the HUD.
 */
import type { ActionFailReason, ClientMessage, PartyExpMode, PartyItemMode, PartyMode, ServerMessage } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import { intent } from '../../hud/intents.ts'
import { InvitePopup, pendingInvite, type PendingInvite } from '../../hud/party-invite.ts'
import {
  DEFAULT_PARTY_MODES,
  memberMenu,
  memberPosition,
  modeLabel,
  modesFromChoice,
  PARTY_COLOR,
  PARTY_PIN,
  PartyBook,
  PartyFrame,
  PartyMenu,
  partyRows,
  partySetupGroups,
  PartyWindow,
  type PartyMenuAction,
  type PartyMenuEntry,
  type PartyModes,
  type PartyRow,
  type XZ,
} from '../../hud/party.ts'
import type { TargetAction, TargetInfo } from '../../hud/target.ts'
import { MessageBox } from '../../ui/kit/dialog.ts'
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
  /**
   * The party setting box (retail `ifsetpartymode`), starting from `current`: the chosen modes, or null when
   * cancelled. 'invite' asks before an invitation that starts a party (`name` is the invitee). Absent (tests): no
   * box, the remembered modes are used.
   */
  chooseModes?(current: PartyModes, purpose: { invite: string } | 'settings'): Promise<PartyModes | null>
  /** A player in view by name (case-insensitive), not yourself; null when none. */
  findPlayer?(name: string): PartyTarget | null
  /** The current target when it is a player. */
  targetPlayer?(): PartyTarget | null
}

/** A player the Invite button, the window or a chat command may invite. */
export type PartyTarget = Pick<TargetInfo, 'id' | 'name' | 'kind'>

/** Why a target cannot be invited (an i18n key taking {name}), or null. */
export type InviteProblem = 'party.problem.notPlayer' | 'party.problem.self' | 'party.problem.mate' | 'party.problem.notLeader' | 'party.problem.full'

const MODES_KEY = 'sro.party.modes'

/** The retail party chat commands (matched case-insensitively by ChatBox). */
export const PARTY_INVITE_COMMANDS = ['/party', '/invitetoparty'] as const
export const PARTY_LEAVE_COMMAND = '/leavetheparty'
export const PARTY_KICK_COMMAND = '/banishfromparty'

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

  /** Why `target` cannot be invited now, or null. */
  inviteProblem(target: Pick<TargetInfo, 'id' | 'kind'>): InviteProblem | null {
    if (target.kind !== 'player') return 'party.problem.notPlayer'
    const self = this.io.selfId()
    if (self === null || target.id === self) return 'party.problem.self'
    if (!this.book.inParty) return null
    if (this.book.isMate(target.id, self)) return 'party.problem.mate'
    if (!this.leader) return 'party.problem.notLeader'
    if (this.book.full) return 'party.problem.full'
    return null
  }

  /** The Invite button shows for other players who are not with us, while we can invite. */
  canInvite(target: Pick<TargetInfo, 'id' | 'kind'>): boolean {
    return this.inviteProblem(target) === null
  }

  /**
   * Invites `target`. Out of a party this starts one: the party setting box asks for the EXP and item modes first
   * (retail), starting from the remembered choice; cancelling it sends nothing. Resolves true when the invitation went out.
   */
  async inviteTarget(target: Pick<TargetInfo, 'id' | 'name'>): Promise<boolean> {
    let modes = this.modes
    if (!this.book.inParty && this.io.chooseModes) {
      if (this.choosing) return false
      this.choosing = true
      let chosen: PartyModes | null
      try {
        chosen = await this.io.chooseModes(this.modes, { invite: target.name })
      } finally {
        this.choosing = false
      }
      if (!chosen) return false
      this.remember(chosen)
      modes = chosen
    }
    // The modes only matter when this invitation starts a party (a party may have formed while the box was open).
    const msg = this.book.inParty ? intent.partyInvite(target.id) : intent.partyInvite(target.id, modes.exp, modes.items)
    if (!this.io.send(msg)) return false
    this.sent.push(target.name)
    return true
  }

  /**
   * `/party [name]` (and retail `/InviteToParty`): invites the named player in view, or the current player target.
   * Problems are chat error lines.
   */
  inviteCommand(rest: string): void {
    const name = rest.trim().split(/\s+/)[0] ?? ''
    const target = name ? (this.io.findPlayer?.(name) ?? null) : (this.io.targetPlayer?.() ?? null)
    if (!target) {
      this.io.chatError(name ? t('party.cmd.notNearby', { name }) : t('party.cmd.usage'))
      return
    }
    const problem = this.inviteProblem(target)
    if (problem) {
      this.io.chatError(t(problem, { name: target.name }))
      return
    }
    void this.inviteTarget(target)
  }

  /** `/BanishFromParty name`: the leader removes a member by name. */
  kickCommand(rest: string): void {
    const name = rest.trim().split(/\s+/)[0] ?? ''
    if (!name) return this.io.chatError(t('party.cmd.kickUsage'))
    if (!this.book.inParty) return this.io.chatError(t('action.fail.not_in_party'))
    const m = this.book.members.find(x => x.name.toLowerCase() === name.toLowerCase())
    if (!m) return this.io.chatError(t('party.cmd.noMember', { name }))
    if (!this.leader) return this.io.chatError(t('action.fail.not_leader'))
    this.kick(m.characterId)
  }

  /** `/LeaveTheParty`. */
  leaveCommand(): void {
    if (!this.book.inParty) return this.io.chatError(t('action.fail.not_in_party'))
    this.leave()
  }

  /**
   * The Settings button and the mode lines: the party setting box. In a party only its leader may change the modes
   * (partySettings with what changed); out of one it sets the modes the next party starts with.
   */
  async openSettings(): Promise<void> {
    if (this.book.inParty && !this.leader) {
      this.io.error(t('party.settingsLeaderOnly'))
      return
    }
    if (!this.io.chooseModes || this.choosing) return
    this.choosing = true
    let chosen: PartyModes | null
    try {
      chosen = await this.io.chooseModes(this.book.modes ?? this.modes, 'settings')
    } finally {
      this.choosing = false
    }
    if (!chosen) return
    const current = this.book.modes
    if (!current) return this.remember(chosen)
    // The party may have changed hands while the box was open.
    if (!this.leader) return this.io.error(t('party.settingsLeaderOnly'))
    const patch: { exp?: PartyExpMode; items?: PartyItemMode } = {}
    if (chosen.exp !== current.exp) patch.exp = chosen.exp
    if (chosen.items !== current.items) patch.items = chosen.items
    this.io.send(intent.partySettings(patch))
  }

  /** The setting box is open (one at a time). */
  private choosing = false

  private remember(m: PartyModes): void {
    if (m.exp === this.modes.exp && m.items === this.modes.items) return
    this.modes = { ...m }
    saveModes(this.modes)
    this.io.changed()
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
    chooseModes: async (current, purpose) => {
      if (MessageBox.isOpen()) return null
      const values = await MessageBox.choose({
        title: t('party.setup.title'),
        text: purpose === 'settings' ? t(ctl.book.inParty ? 'party.setup.text' : 'party.setup.textNew') : t('party.setup.textInvite', { name: purpose.invite }),
        groups: partySetupGroups(current),
        ok: purpose === 'settings' ? t('kit.ok') : t('party.invite'),
        art: app.art,
      })
      return values ? modesFromChoice(values) : null
    },
    findPlayer: name => {
      const want = name.toLowerCase()
      for (const v of ctx.views()) {
        if (v.kind === 'player' && !v.isSelf && !v.isDisposed && v.state.name.toLowerCase() === want) return { id: v.id, name: v.state.name, kind: 'player' }
      }
      return null
    },
    targetPlayer: () => {
      const v = ctx.target()
      return v && v.kind === 'player' && !v.isSelf ? { id: v.id, name: v.state.name, kind: 'player' } : null
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

  /** The window's Invite: the selected player, or a line saying what to do. */
  const inviteSelected = () => {
    const v = ctx.target()
    const tgt = v && v.kind === 'player' && !v.isSelf ? { id: v.id, name: v.state.name, kind: 'player' as const } : null
    if (!tgt) return hud.toast(t('party.selectPlayer'), 'error')
    const problem = ctl.inviteProblem(tgt)
    if (problem) return hud.toast(t(problem, { name: tgt.name }), 'error')
    void ctl.inviteTarget(tgt)
  }
  const win = new PartyWindow(app.art, hud.layer, { ...rowHandlers, invite: inviteSelected, settings: () => void ctl.openSettings(), leave: () => ctl.leave() })
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
    const invite = ctl.book.inParty && !ctl.leader ? 'notLeader' : ctl.book.full ? 'full' : 'ready'
    win.render({ rows, modes: ctl.book.modes ?? ctl.modes, inParty: ctl.book.inParty, leader: ctl.leader, targetEntity, invite })
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
  const actions: TargetAction[] = [{ id: 'partyInvite', label: t('party.invite'), title: t('party.inviteHint'), show: tgt => ctl.canInvite(tgt), run: tgt => void ctl.inviteTarget(tgt) }]
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
    // Retail chat commands (textuisystem UIIT_STT_CHAT_COMMAND_PARTY_*): /party and /InviteToParty [name], /LeaveTheParty, /BanishFromParty name.
    ...PARTY_INVITE_COMMANDS.map(c => chat.registerPrefix(c, rest => ctl.inviteCommand(rest))),
    chat.registerPrefix(PARTY_LEAVE_COMMAND, () => ctl.leaveCommand()),
    chat.registerPrefix(PARTY_KICK_COMMAND, rest => ctl.kickCommand(rest)),
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
