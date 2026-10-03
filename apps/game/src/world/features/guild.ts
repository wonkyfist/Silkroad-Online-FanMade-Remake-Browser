/**
 * World feature of lane GU-C, guilds (docs/SYSTEMS_SOCIAL.md §9.4; docs/WAVE_PLAN2.md §6.5). Only that lane edits
 * this file; see world/features.ts for the context and hooks. It wires:
 * - the guild state (`guild`, `guildMember`, `guildMemberRemoved`, `guildEvent`) into the community window
 *   (hud/guild.ts; key U, binding 'window.guild', and the MENU popup row 'guild' with `ub_new_icon_guild`, M5);
 * - the invitation popup (`guildInvited`, hud/guild-invite.ts) and the refusals of every guild request;
 * - the Guild invite button of the target window on players in no guild (Hud.addTargetAction, M3);
 * - the Guild Manager's 'guild' NPC service (registerNpcService, M7): create and disband, in the NPC dialog;
 * - guild chat: the Guild chat tab while in a guild (M4) and the prefixes `@text`, `/g text` (guild chat),
 *   `/guild name` (invite) and `/join` (accept the invitation) (D9, §3.6);
 * - the guild name above player names (`setBadge('guild', name, 'guild-line')`, token --c-guild-name) and its
 *   option row "Display guild names" in Options → Interface (M10, D18).
 * GuildController (hud/guild-state.ts) is the DOM-free part; this factory binds it to the HUD.
 */
import { GUILD_TITLE_MAX, type GuildMember, type GuildPerm } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { t } from '../../i18n/index.ts'
import { GuildWindow } from '../../hud/guild.ts'
import { GuildInvitePopup } from '../../hud/guild-invite.ts'
import { GuildController, guildBadgeText, guildNameOk, loadShowGuild, saveShowGuild, type PendingGuildInvite } from '../../hud/guild-state.ts'
import { registerNpcService, type NpcDialogOption, type NpcTalkContext } from '../../hud/npc-dialog.ts'
import { registerOptionRow } from '../../hud/options.ts'
import type { TargetAction } from '../../hud/target.ts'
import { MessageBox } from '../../ui/kit/dialog.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeatureFactory } from '../features.ts'

/** Seconds between redraws of the open window (the "last seen" column). */
const REFRESH_S = 30

const CSS = `
.entity-label .badge-guild.guild-line {
  display: block; text-align: center; margin: 0 0 1px; color: var(--c-guild-name, #8fd18f);
  font: 11px/13px var(--font-body); text-shadow: var(--t-outline, 0 0 2px #000, 0 1px 2px #000);
}
.entity-label:has(> .badge-guild) { text-align: center; }
`
let injected = false
function ensureBadgeStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'guild-line'
  s.textContent = CSS
  document.head.append(s)
}

/** Sets or clears a player's guild line; the line is kept first in the label so it sits above every other badge. */
export function applyGuildBadge(v: Pick<EntityView, 'setBadge' | 'label'>, text: string | null): void {
  v.setBadge('guild', text, 'guild-line')
  if (text === null) return
  const b = v.label.querySelector<HTMLElement>(':scope > .badge-guild')
  if (b && v.label.firstElementChild !== b) v.label.prepend(b)
}

export const guildFeature: WorldFeatureFactory = ctx => {
  const { hud, app, chat } = ctx
  const art = app.art
  let selfName: string | null = null
  let dirty = true
  let refresh = REFRESH_S
  let showNames = loadShowGuild()
  let shownInvite: PendingGuildInvite | null = null
  ensureBadgeStyles()

  const ctl = new GuildController({
    send: msg => !!msg && ctx.send(msg),
    selfName: () => {
      const id = ctx.selfId()
      return (id !== null ? ctx.view(id)?.state.name : undefined) ?? selfName
    },
    line: text => chat.add('guild', text),
    system: text => chat.add('system', text),
    error: text => hud.toast(text, 'error'),
    chatError: text => chat.add('error', text),
    now: () => performance.now(),
    changed: () => {
      dirty = true
    },
  })

  // ---- name badges ----
  const badge = (v: EntityView) => {
    if (v.kind !== 'player') return
    applyGuildBadge(v, guildBadgeText(v.state.guild, showNames))
  }
  const setShowNames = (on: boolean) => {
    showNames = on
    saveShowGuild(on)
    for (const v of ctx.views()) badge(v)
  }
  /** Our own guild name from the `guild` state (the server's entityUpdate also brings it). */
  const syncSelfBadge = () => {
    const id = ctx.selfId()
    const v = id !== null ? ctx.view(id) : undefined
    if (!v) return
    const name = ctl.book.state?.name
    if ((v.state.guild ?? '') === (name ?? '')) return
    v.state.guild = name || undefined
    badge(v)
  }

  // ---- prompts (kit message boxes, M13) ----
  const playerTargetName = (): string => {
    const tgt = ctx.target()
    return tgt && tgt.kind === 'player' && !tgt.isSelf && !tgt.state.guild ? tgt.state.name : ''
  }
  const invitePrompt = async () => {
    const name = await MessageBox.prompt({ title: t('guild.cmd.invite'), text: t('guild.invitePrompt'), maxLength: 12, initial: playerTargetName(), art })
    if (name) ctl.inviteName(name)
  }
  const confirm = (text: string, title = t('guild.window')) => MessageBox.confirm({ title, text, art })

  const win = new GuildWindow(art, hud.layer, {
    book: ctl.book,
    me: () => ctl.me,
    rights: () => ctl.rights,
    now: () => ctx.serverNow(),
    invite: () => void invitePrompt(),
    kick: m => {
      void confirm(t('guild.kickConfirm', { name: m.name })).then(ok => ok && ctl.kick(m.characterId))
    },
    leave: () => {
      const g = ctl.book.state
      if (!g) return
      const alone = g.members.length <= 1
      void confirm(t(alone ? 'guild.leaveDisbandConfirm' : 'guild.leaveConfirm', { name: g.name })).then(ok => ok && ctl.leave())
    },
    title: (m: GuildMember) => {
      void MessageBox.prompt({ title: t('guild.cmd.title'), text: t('guild.titlePrompt', { name: m.name }), maxLength: GUILD_TITLE_MAX, initial: m.title, allowEmpty: true, art }).then(title => {
        if (title !== null && title !== m.title) ctl.setTitle(m.characterId, title)
      })
    },
    handOver: m => {
      void confirm(t('guild.handOverConfirm', { name: m.name })).then(ok => ok && ctl.handOver(m.characterId))
    },
    applyPerms: (changes: Map<number, GuildPerm[]>) => {
      ctl.applyPerms(changes)
    },
    postNotice: (title, text) => ctl.setNotice(title, text),
    whisper: name => chat.startWhisper(name),
  })
  const popup = new GuildInvitePopup(art, hud.layer, accept => ctl.respond(accept))

  // ---- the Guild Manager (M7) ----
  const managerMenu = (talk: NpcTalkContext) => {
    const g = ctl.book.state
    const me = ctl.me
    const text = g ? t('guild.npc.member', { name: g.name }) : t('guild.npc.text', { gold: ctl.terms.gold.toLocaleString('en-US'), level: ctl.terms.level })
    const options: NpcDialogOption[] = []
    if (!g) options.push({ label: t('guild.npc.create'), run: () => void create(talk) })
    if (g && me?.rank === 'master') options.push({ label: t('guild.npc.disband'), run: () => void disband(talk) })
    options.push({ label: t('guild.npc.back'), run: () => talk.dialog.showServices(), end: true })
    talk.dialog.setContent(text, options)
  }
  const create = async (talk: NpcTalkContext) => {
    const name = await MessageBox.prompt({ title: t('guild.npc.create'), text: t('guild.enterName'), maxLength: 12, art })
    if (!name) return
    // A typo gets the rule at once, before the cost is asked.
    if (!guildNameOk(name)) {
      hud.toast(t('guild.nameRule'), 'error')
      return
    }
    const gold = ctl.terms.gold.toLocaleString('en-US')
    if (await confirm(t('guild.createConfirm', { gold, name: name.trim() }), t('guild.npc.create'))) ctl.create(talk.npc, name)
  }
  const disband = async (talk: NpcTalkContext) => {
    const g = ctl.book.state
    if (!g) return
    if (await confirm(t('guild.disbandConfirm', { name: g.name }), t('guild.npc.disband'))) ctl.disband(talk.npc)
  }

  // ---- the Guild invite button of the target window (M3) ----
  const inviteAction: TargetAction = {
    id: 'guildInvite',
    label: t('guild.inviteAction'),
    title: t('guild.inviteActionHint'),
    show: tgt => {
      const v = ctx.view(tgt.id)
      return ctl.canInvitePlayer(tgt, v?.state.guild, !!v?.isSelf)
    },
    run: tgt => {
      ctl.inviteName(tgt.name)
    },
  }
  let actionsKey = ''
  const syncActions = () => {
    const tgt = ctx.target()
    const key = `${ctl.rights.invite}|${ctl.book.full}|${tgt?.id ?? ''}|${tgt?.state.guild ?? ''}`
    if (key === actionsKey) return
    actionsKey = key
    hud.refreshTargetActions()
  }

  // ---- redraw ----
  let tabShown: boolean | null = null
  const render = () => {
    dirty = false
    win.render()
    if (ctl.invite !== shownInvite) {
      shownInvite = ctl.invite
      if (shownInvite) {
        popup.show(shownInvite, performance.now())
        gameAudio()?.ui('ui.windowOpen')
      } else popup.hide()
    }
    const inGuild = ctl.book.inGuild
    if (tabShown !== inGuild) {
      tabShown = inGuild
      chat.setTabVisible('guild', inGuild)
    }
    syncSelfBadge()
    syncActions()
  }

  const offs = [
    ctx.keys.register({ id: 'window.guild', keys: ['u'], label: 'keys.window.guild', group: 'windows', run: () => win.toggle() }),
    hud.menubar.register({ id: 'guild', art: 'guild/gil_sysbutton_guild', label: 'keys.window.guild', hotkey: 'U', order: 55, icon: 'underbar/ub_new_icon_guild', toggle: () => win.toggle(), isOpen: () => win.isOpen }),
    hud.addTargetAction(inviteAction),
    registerNpcService('guild', managerMenu),
    registerOptionRow('interface', {
      id: 'ui.guildNames',
      kind: 'toggle',
      label: 'guild.option.showNames',
      get: () => showNames,
      patch: v => {
        setShowNames(v)
        return {}
      },
    }),
    chat.registerPrefix('@', rest => ctl.chat(rest)),
    chat.registerPrefix('/g', rest => ctl.chat(rest)),
    chat.registerPrefix('/guild', rest => {
      const name = rest || playerTargetName()
      if (!name) chat.add('error', t('guild.inviteUsage'))
      else ctl.inviteName(name)
    }),
    chat.registerPrefix('/join', () => ctl.joinCommand()),
  ]
  render()

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') selfName = msg.self.name
      ctl.handle(msg)
      if (msg.t === 'entityUpdate' && msg.guild !== undefined) {
        const v = ctx.view(msg.id)
        if (v && v.kind === 'player') {
          v.state.guild = msg.guild || undefined
          badge(v)
          dirty = true
        }
      }
      if (dirty) render()
    },
    onFrame(_now, dt) {
      const now = performance.now()
      ctl.tick(now)
      popup.tick(now)
      refresh -= dt
      if (refresh <= 0) {
        refresh = REFRESH_S
        if (win.isOpen) dirty = true
      }
      if (dirty) render()
      else syncActions()
    },
    onEntityAdded(v) {
      badge(v)
    },
    escape() {
      if (win.isOpen) {
        win.close()
        return true
      }
      return false
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      chat.setTabVisible('guild', false)
      for (const v of ctx.views()) if (v.kind === 'player') v.setBadge('guild', null)
      popup.dispose()
      win.dispose()
    },
  }
}
