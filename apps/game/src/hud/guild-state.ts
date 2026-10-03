/**
 * Guild client state of lane GU-C (docs/SYSTEMS_SOCIAL.md §5, §9.4; docs/WAVE_PLAN2.md §6.5), DOM-free so the tests
 * drive it directly:
 * - GuildBook: the server's `guild` state with the `guildMember` upserts and `guildMemberRemoved` removals applied;
 * - the grade rule (a member with all four rights shows as Vice Master), the rights checks behind the command buttons,
 *   the member sort (online, grade, level) and the "last seen" text;
 * - guildIntent: the guild requests, each passing the shared validator or null;
 * - the notice editor's UTF-8 cap (§2.5: the whole frame stays under 900 bytes);
 * - GuildController: every guild message and answer, the chat lines, the pending invitation and the commands.
 * The world binding is world/features/guild.ts; the window is hud/guild.ts.
 */
import {
  CHARACTER_NAME,
  GUILD_NAME,
  GUILD_NOTICE_MAX,
  GUILD_NOTICE_TITLE_MAX,
  GUILD_PERMS,
  GUILD_TITLE_MAX,
  utf8Length,
  type ActionFailReason,
  type ClientMessage,
  type GameplayRequest,
  type GuildEventKind,
  type GuildMember,
  type GuildPerm,
  type GuildState,
  type ServerMessage,
} from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'

type Msg<K extends ClientMessage['t']> = Extract<ClientMessage, { t: K }>

// ---- grades and rights ---------------------------------------------------------------------------------------------

/** What the member list shows in the Grade column (§5.1: all four rights = Vice Master; no separate rank). */
export type GuildGrade = 'master' | 'vice' | 'member'
const GRADE_ORDER: Record<GuildGrade, number> = { master: 0, vice: 1, member: 2 }
const GRADE_KEY: Record<GuildGrade, StringKey> = { master: 'guild.master', vice: 'guild.vice', member: 'guild.member' }

export function gradeOf(m: Pick<GuildMember, 'rank' | 'perms'>): GuildGrade {
  if (m.rank === 'master') return 'master'
  return GUILD_PERMS.every(p => m.perms.includes(p)) ? 'vice' : 'member'
}

/** The grade's label (Guild Master / Vice Master / Member). */
export function gradeLabel(m: Pick<GuildMember, 'rank' | 'perms'>): string {
  return t(GRADE_KEY[gradeOf(m)])
}

/** The Grade column: the member's title when set, else the grade (§9.4). */
export function gradeText(m: Pick<GuildMember, 'rank' | 'perms' | 'title'>): string {
  return m.title ? m.title : gradeLabel(m)
}

/** The master holds every right implicitly. */
export function hasPerm(m: Pick<GuildMember, 'rank' | 'perms'> | null | undefined, p: GuildPerm): boolean {
  return !!m && (m.rank === 'master' || m.perms.includes(p))
}

/** GuildPerm[] without duplicates, in GUILD_PERMS order (what guildPerms carries). */
export function normalizePerms(perms: readonly GuildPerm[]): GuildPerm[] {
  return GUILD_PERMS.filter(p => perms.includes(p))
}

// ---- the book --------------------------------------------------------------------------------------------------------

/** The guild as the server last described it. */
export class GuildBook {
  state: GuildState | null = null

  get inGuild(): boolean {
    return this.state !== null
  }

  get members(): readonly GuildMember[] {
    return this.state?.members ?? []
  }

  get full(): boolean {
    return !!this.state && this.state.members.length >= this.state.maxMembers
  }

  get onlineCount(): number {
    return this.members.filter(m => m.online).length
  }

  clear(): void {
    this.state = null
  }

  /** A full `guild` state (null = in none). */
  set(g: GuildState | null): void {
    this.state = g ? { ...g, notice: { ...g.notice }, members: g.members.map(m => ({ ...m, perms: [...m.perms] })) } : null
  }

  /** `guildMember`: adds or replaces one member; the previous row (null when new, or when in no guild). */
  upsert(m: GuildMember): GuildMember | null {
    const g = this.state
    if (!g) return null
    const copy = { ...m, perms: [...m.perms] }
    const i = g.members.findIndex(x => x.characterId === m.characterId)
    if (i < 0) {
      g.members.push(copy)
      return null
    }
    const prev = g.members[i]!
    g.members[i] = copy
    // A mastership change arrives as two member rows: keep the guild's master pointer in step.
    if (copy.rank === 'master') g.master = copy.characterId
    return prev
  }

  /** `guildMemberRemoved`: the removed row, if it was there. */
  remove(characterId: number): GuildMember | null {
    const g = this.state
    if (!g) return null
    const i = g.members.findIndex(x => x.characterId === characterId)
    if (i < 0) return null
    return g.members.splice(i, 1)[0]!
  }

  byId(characterId: number): GuildMember | undefined {
    return this.members.find(m => m.characterId === characterId)
  }

  /** Our own row, found by character name (names are unique; the client knows its name, not its characterId). */
  me(selfName: string | null): GuildMember | undefined {
    if (!selfName) return undefined
    const lower = selfName.toLowerCase()
    return this.members.find(m => m.name.toLowerCase() === lower)
  }

  master(): GuildMember | undefined {
    const g = this.state
    if (!g) return undefined
    return this.members.find(m => m.characterId === g.master) ?? this.members.find(m => m.rank === 'master')
  }
}

// ---- what the command buttons may do ---------------------------------------------------------------------------------

export interface GuildRights {
  invite: boolean
  /** The Rights table (master only, with another member to grant to). */
  grant: boolean
  kick: boolean
  leave: boolean
  title: boolean
  handOver: boolean
  notice: boolean
}

/** Which command buttons are shown at all (by our rank and rights; SOCIAL §9.4 "shown only when allowed"). */
export function guildRights(book: GuildBook, me: GuildMember | undefined): GuildRights {
  if (!book.inGuild || !me) return { invite: false, grant: false, kick: false, leave: false, title: false, handOver: false, notice: false }
  const master = me.rank === 'master'
  const others = book.members.length > 1
  return {
    invite: hasPerm(me, 'invite'),
    grant: master && others,
    kick: hasPerm(me, 'kick') && others,
    // The master cannot leave while others are in the guild (§5.2); alone, leaving disbands it.
    leave: !master || !others,
    title: hasPerm(me, 'title'),
    handOver: master && others,
    notice: hasPerm(me, 'notice'),
  }
}

/** §5.2 kick rules: never the master, never yourself, and a member with `kick` cannot kick another holder of `kick`. */
export function canKick(me: GuildMember | undefined, target: GuildMember | undefined): boolean {
  if (!me || !target || target.characterId === me.characterId || target.rank === 'master') return false
  if (me.rank === 'master') return true
  return me.perms.includes('kick') && !target.perms.includes('kick')
}

/** Titles: the master or the `title` right, on any member. */
export function canTitle(me: GuildMember | undefined, target: GuildMember | undefined): boolean {
  return !!target && hasPerm(me, 'title')
}

/** Mastership: master only, to another member. */
export function canHandOver(me: GuildMember | undefined, target: GuildMember | undefined): boolean {
  return !!me && !!target && me.rank === 'master' && target.characterId !== me.characterId
}

// ---- member list -------------------------------------------------------------------------------------------------------

export type GuildSortKey = 'default' | 'name' | 'level' | 'grade' | 'status'
export interface GuildSort {
  key: GuildSortKey
  /** Reverses the key's natural order. */
  reverse: boolean
}
export const DEFAULT_GUILD_SORT: GuildSort = { key: 'default', reverse: false }

const byName = (a: GuildMember, b: GuildMember) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
const byGrade = (a: GuildMember, b: GuildMember) => GRADE_ORDER[gradeOf(a)] - GRADE_ORDER[gradeOf(b)]
const byLevel = (a: GuildMember, b: GuildMember) => b.level - a.level
/** Online first, then the most recently seen. */
const byStatus = (a: GuildMember, b: GuildMember) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen

/**
 * The member rows in display order. Default (§10.8): online first, then grade (Master, Vice, Member), then level
 * (high first), then name. A sort button orders by its column first, then falls back to the default order.
 */
export function sortMembers(members: readonly GuildMember[], sort: GuildSort = DEFAULT_GUILD_SORT): GuildMember[] {
  const base = (a: GuildMember, b: GuildMember) => Number(b.online) - Number(a.online) || byGrade(a, b) || byLevel(a, b) || byName(a, b)
  const first: Record<GuildSortKey, ((a: GuildMember, b: GuildMember) => number) | null> = {
    default: null,
    name: byName,
    level: byLevel,
    grade: byGrade,
    status: byStatus,
  }
  const key = first[sort.key]
  const dir = sort.reverse ? -1 : 1
  return [...members].sort((a, b) => (key ? dir * key(a, b) || base(a, b) : dir * base(a, b)))
}

/** A click on a sort button: a new column sorts in its natural order, the same column again reverses it. */
export function nextSort(current: GuildSort, key: GuildSortKey): GuildSort {
  return current.key === key ? { key, reverse: !current.reverse } : { key, reverse: false }
}

/** "3 d ago" for an offline member (lastSeen 0 = never seen: a dash). */
export function lastSeenText(lastSeen: number, now: number): string {
  if (!lastSeen) return t('guild.ago.never')
  const s = Math.max(0, (now - lastSeen) / 1000)
  if (s < 60) return t('guild.ago.now')
  if (s < 3600) return t('guild.ago.min', { n: Math.floor(s / 60) })
  if (s < 86_400) return t('guild.ago.hour', { n: Math.floor(s / 3600) })
  return t('guild.ago.day', { n: Math.floor(s / 86_400) })
}

/** The Status column: Online, or how long ago the member was last seen. */
export function statusText(m: Pick<GuildMember, 'online' | 'lastSeen'>, now: number): string {
  return m.online ? t('guild.status.online') : lastSeenText(m.lastSeen, now)
}

/** "2026-09-28" for a server time (ms). */
export function dateText(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return t('guild.ago.never')
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---- the notice editor ---------------------------------------------------------------------------------------------------

/** §2.5: the client stops notice input at 900 UTF-8 bytes for the whole frame (the frame limit is 1024). */
export const NOTICE_FRAME_BYTES = 900

const cp = (s: string) => [...s].length

/** UTF-8 bytes of the guildNotice frame that would carry this notice. */
export function noticeFrameBytes(title: string, text: string): number {
  return utf8Length(JSON.stringify({ t: 'guildNotice', title, text }))
}

/** True when the notice passes the code-point bounds and the byte cap. */
export function noticeFits(title: string, text: string): boolean {
  return cp(title) <= GUILD_NOTICE_TITLE_MAX && cp(text) <= GUILD_NOTICE_MAX && noticeFrameBytes(title, text) <= NOTICE_FRAME_BYTES
}

/**
 * The notice as the editor keeps it: the title cut to its code-point limit, then the text cut (by whole code points)
 * until the code-point limit and the frame's byte cap both hold. Never splits a surrogate pair.
 */
export function clampNotice(title: string, text: string): { title: string; text: string } {
  const tt = [...title].slice(0, GUILD_NOTICE_TITLE_MAX).join('')
  let chars = [...text].slice(0, GUILD_NOTICE_MAX)
  // Drop from the end until it fits (at most GUILD_NOTICE_MAX steps; the title alone always fits: 32 × 12 bytes).
  while (chars.length && noticeFrameBytes(tt, chars.join('')) > NOTICE_FRAME_BYTES) chars = chars.slice(0, -1)
  return { title: tt, text: chars.join('') }
}

/** What is left for the text: code points, bounded by the byte cap as well (for the editor's counter). */
export function noticeRoom(title: string, text: string): number {
  return Math.max(0, Math.min(GUILD_NOTICE_MAX - cp(text), NOTICE_FRAME_BYTES - noticeFrameBytes(title, text)))
}

// ---- intents ---------------------------------------------------------------------------------------------------------------

const entityId = (n: number) => Number.isSafeInteger(n) && n >= 0
const memberId = (n: number) => Number.isSafeInteger(n) && n >= 1

/** Guild names typed by the player: trimmed; GUILD_NAME decides. */
export function guildNameOk(name: string): boolean {
  return GUILD_NAME.test(name.trim())
}

export const guildIntent = {
  create(npc: number, name: string): Msg<'guildCreate'> | null {
    const n = name.trim()
    return entityId(npc) && GUILD_NAME.test(n) ? { t: 'guildCreate', npc, name: n } : null
  },
  disband(npc: number): Msg<'guildDisband'> | null {
    return entityId(npc) ? { t: 'guildDisband', npc } : null
  },
  invite(name: string): Msg<'guildInvite'> | null {
    const n = name.trim()
    return CHARACTER_NAME.test(n) ? { t: 'guildInvite', name: n } : null
  },
  respond(guild: number, accept: boolean): Msg<'guildRespond'> | null {
    return memberId(guild) ? { t: 'guildRespond', guild, accept } : null
  },
  leave(): Msg<'guildLeave'> {
    return { t: 'guildLeave' }
  },
  kick(member: number): Msg<'guildKick'> | null {
    return memberId(member) ? { t: 'guildKick', member } : null
  },
  perms(member: number, perms: readonly GuildPerm[]): Msg<'guildPerms'> | null {
    return memberId(member) ? { t: 'guildPerms', member, perms: normalizePerms(perms) } : null
  },
  title(member: number, title: string): Msg<'guildTitle'> | null {
    const s = title.trim()
    return memberId(member) && cp(s) <= GUILD_TITLE_MAX ? { t: 'guildTitle', member, title: s } : null
  },
  notice(title: string, text: string): Msg<'guildNotice'> | null {
    const tt = title.trim()
    const tx = text.trim()
    return noticeFits(tt, tx) ? { t: 'guildNotice', title: tt, text: tx } : null
  },
  master(member: number): Msg<'guildMaster'> | null {
    return memberId(member) ? { t: 'guildMaster', member } : null
  },
}

// ---- the invitation ---------------------------------------------------------------------------------------------------------

export interface PendingGuildInvite {
  guild: number
  /** The guild's name. */
  name: string
  /** Who invited us. */
  from: string
  /** Local ms (the caller's clock) when the server drops it. */
  expiresAt: number
}

export function pendingGuildInvite(msg: Extract<ServerMessage, { t: 'guildInvited' }>, now: number): PendingGuildInvite {
  return { guild: msg.guild, name: msg.name, from: msg.from, expiresAt: now + Math.max(0, msg.expiresInMs) }
}

export function inviteSecondsLeft(inv: PendingGuildInvite, now: number): number {
  return Math.max(0, Math.ceil((inv.expiresAt - now) / 1000))
}

export function inviteLine(inv: PendingGuildInvite): string {
  return t('guild.invited', { from: inv.from, name: inv.name })
}

// ---- refusal texts ---------------------------------------------------------------------------------------------------------------

export const GUILD_REQUEST_TYPES: readonly GameplayRequest[] = [
  'guildCreate', 'guildDisband', 'guildInvite', 'guildRespond', 'guildLeave', 'guildKick', 'guildPerms', 'guildTitle', 'guildNotice', 'guildMaster',
]
const FAIL_GROUP: Partial<Record<GameplayRequest, string>> = {
  guildCreate: 'create',
  guildDisband: 'disband',
  guildInvite: 'invite',
  guildRespond: 'respond',
  guildLeave: 'leave',
  guildKick: 'kick',
}

/** Values the refusal lines may name (the create cost and level from WorldInfo.social). */
export interface GuildFailVars {
  gold?: number
  level?: number
}

/**
 * The line for a refused guild request: the server's own sentence when it sent one, else the guild's wording for that
 * request and reason (`guild.fail.<group>.<reason>`), else the generic reason line (`action.fail.<reason>`).
 */
export function guildFailText(re: GameplayRequest, reason: ActionFailReason | undefined, message?: string, vars: GuildFailVars = {}): string {
  if (message) return message
  if (reason) {
    const group = FAIL_GROUP[re]
    if (group) {
      const key = `guild.fail.${group}.${reason}` as StringKey
      const own = t(key, { gold: (vars.gold ?? 0).toLocaleString('en-US'), level: vars.level ?? 0 })
      if (own !== key) return own
    }
    const generic = t(`action.fail.${reason}` as StringKey)
    if (generic !== `action.fail.${reason}`) return generic
  }
  return t('action.fail.generic')
}

// ---- the controller ---------------------------------------------------------------------------------------------------------------

/** What the controller needs from the world (tests pass a fake). */
export interface GuildIo {
  /** Sends a built intent; false (and nothing sent) for null or when offline. */
  send(msg: ClientMessage | null): boolean
  /** Own character name (null before worldEnter). */
  selfName(): string | null
  /** A guild-coloured line in the chat log (the Guild tab). */
  line(text: string): void
  /** A system line (the login notice). */
  system(text: string): void
  /** A refusal: centre-screen error toast. */
  error(text: string): void
  /** A problem with a typed chat line: an error line in the chat log. */
  chatError(text: string): void
  /** Local clock in ms. */
  now(): number
  /** The guild, the invitation or a setting changed: redraw. */
  changed(): void
}

/** Guild creation terms from WorldInfo.social (defaults: the server's config defaults). */
export interface GuildTerms {
  gold: number
  level: number
}
export const DEFAULT_GUILD_TERMS: GuildTerms = { gold: 10_000, level: 10 }

export class GuildController {
  readonly book = new GuildBook()
  invite: PendingGuildInvite | null = null
  terms: GuildTerms = { ...DEFAULT_GUILD_TERMS }
  /** The `guild` message of this visit has not arrived yet (its notice is the login line). */
  private awaitingFirst = true
  /** The last invitation shown, kept after it closed so a late 'expired' line names the right side. */
  private lastInvite: { name: string; from: string; answered: boolean } | null = null
  /** Names of our outstanding invitations, oldest first (for the "invited" line). */
  private readonly sent: string[] = []

  constructor(private readonly io: GuildIo) {}

  get me(): GuildMember | undefined {
    return this.book.me(this.io.selfName())
  }

  get rights(): GuildRights {
    return guildRights(this.book, this.me)
  }

  /** Every server message. */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'worldEnter': {
        this.book.clear()
        this.invite = null
        this.lastInvite = null
        this.sent.length = 0
        this.awaitingFirst = true
        const s = msg.world.social
        this.terms = s ? { gold: s.guildCreateGold, level: s.guildCreateLevel } : { ...DEFAULT_GUILD_TERMS }
        this.io.changed()
        break
      }
      case 'guild': {
        const first = this.awaitingFirst
        this.awaitingFirst = false
        this.book.set(msg.guild)
        if (msg.guild) {
          this.invite = null
          // Retail shows the notice once at login: Guild post "<title>".
          if (first && msg.guild.notice.title) this.io.system(t('guild.post', { title: msg.guild.notice.title }))
        }
        this.io.changed()
        break
      }
      case 'guildMember':
        this.book.upsert(msg.member)
        this.io.changed()
        break
      case 'guildMemberRemoved':
        this.book.remove(msg.characterId)
        this.io.changed()
        break
      case 'guildInvited':
        this.invite = pendingGuildInvite(msg, this.io.now())
        this.lastInvite = { name: msg.name, from: msg.from, answered: false }
        this.io.changed()
        break
      case 'guildEvent':
        this.event(msg.event, msg.name)
        break
      case 'actionResult':
        this.result(msg.re, msg.ok, msg.reason, msg.message)
        break
    }
  }

  private event(event: GuildEventKind, name: string): void {
    const selfName = this.io.selfName()
    const self = !!name && !!selfName && name.toLowerCase() === selfName.toLowerCase()
    const guildName = this.book.state?.name ?? ''
    switch (event) {
      case 'created':
        this.io.line(t('guild.created', { name: name || guildName }))
        return
      case 'joined':
        this.io.line(self ? t('guild.joinedSelf', { name: guildName || this.lastInvite?.name || '' }) : t('guild.joined', { name }))
        return
      case 'left':
        // The leaver's own line comes from its guildLeave answer (the server tells only the members who stay).
        if (!self) this.io.line(t('guild.left', { name }))
        return
      case 'kicked':
        this.io.line(self ? t('guild.kickedSelf') : t('guild.kicked', { name }))
        return
      case 'master':
        this.io.line(self ? t('guild.masterSelf') : t('guild.masterChanged', { name }))
        return
      case 'disbanded':
        this.io.line(t('guild.disbanded', { name: name || guildName }))
        return
      case 'declined':
        this.io.line(t('guild.declined', { name }))
        return
      case 'expired': {
        // To the invitee the line names the guild (or the inviter); to the inviter, the invitee.
        const inv = this.invite ?? (this.lastInvite && !this.lastInvite.answered ? this.lastInvite : null)
        const mine = !!inv && (name === inv.name || name === inv.from || !name)
        if (mine) {
          if (this.invite) {
            this.invite = null
            this.io.changed()
          }
          this.lastInvite = null
          this.io.line(t('guild.inviteExpiredSelf'))
        } else this.io.line(t('guild.expired', { name }))
        return
      }
      case 'online':
        if (!self) this.io.line(t('guild.online', { name }))
        return
      case 'offline':
        if (!self) this.io.line(t('guild.offline', { name }))
        return
      case 'notice':
        this.io.line(name ? t('guild.noticeBy', { name }) : t('guild.noticeChanged'))
        return
      case 'perms':
        this.io.line(self ? t('guild.permsSelf') : t('guild.permsChanged', { name }))
        return
      case 'title':
        this.io.line(self ? t('guild.titleSelf') : t('guild.titleChanged', { name }))
        return
    }
  }

  private result(re: GameplayRequest, ok: boolean, reason?: ActionFailReason, message?: string): void {
    if (!GUILD_REQUEST_TYPES.includes(re)) return
    if (re === 'guildInvite') {
      const name = this.sent.shift()
      if (ok && name) this.io.line(t('guild.inviteSent', { name }))
    }
    if (re === 'guildLeave' && ok) this.io.line(t('guild.leftSelf'))
    if (!ok) this.io.error(guildFailText(re, reason, message, this.terms))
  }

  /** Drops the invitation once its time is up (the server's 'expired' line follows). */
  tick(now: number): void {
    if (this.invite && now >= this.invite.expiresAt) {
      this.invite = null
      this.io.changed()
    }
  }

  // ---- commands ----

  /** Guild Manager: create (the name is checked here first, so a typo gets the rule at once). */
  create(npc: number, name: string): boolean {
    const msg = guildIntent.create(npc, name)
    if (!msg) {
      this.io.error(t('guild.nameRule'))
      return false
    }
    return this.io.send(msg)
  }

  disband(npc: number): boolean {
    return this.io.send(guildIntent.disband(npc))
  }

  /** Invite by character name (the window's prompt, the target action, `/guild <name>`). */
  inviteName(name: string): boolean {
    const msg = guildIntent.invite(name)
    if (!msg) {
      this.io.error(t('guild.badCharName'))
      return false
    }
    if (!this.book.inGuild) {
      this.io.error(t('action.fail.not_in_guild'))
      return false
    }
    if (!this.io.send(msg)) return false
    this.sent.push(msg.name)
    return true
  }

  /** The Guild invite button shows for other players who are in no guild, while we may invite. */
  canInvitePlayer(target: { kind: string; name: string }, targetGuild: string | undefined, isSelf: boolean): boolean {
    if (target.kind !== 'player' || isSelf || targetGuild) return false
    return this.rights.invite && !this.book.full
  }

  respond(accept: boolean): void {
    const inv = this.invite
    if (!inv) return
    this.invite = null
    if (this.lastInvite) this.lastInvite.answered = true
    this.io.send(guildIntent.respond(inv.guild, accept))
    if (!accept) this.io.line(t('guild.inviteDeclinedSelf', { name: inv.name }))
    this.io.changed()
  }

  /** `/join`: accepts the pending invitation. */
  joinCommand(): void {
    if (!this.invite) {
      this.io.chatError(t('guild.noInvite'))
      return
    }
    this.respond(true)
  }

  leave(): boolean {
    if (!this.book.inGuild) return false
    return this.io.send(guildIntent.leave())
  }

  kick(member: number): boolean {
    return this.io.send(guildIntent.kick(member))
  }

  /** The Rights table's OK: one guildPerms per member whose rights changed. Returns how many were sent. */
  applyPerms(changes: ReadonlyMap<number, readonly GuildPerm[]>): number {
    let n = 0
    for (const [member, perms] of changes) {
      const m = this.book.byId(member)
      if (!m || m.rank === 'master') continue
      const next = normalizePerms(perms)
      if (next.join(',') === normalizePerms(m.perms).join(',')) continue
      if (this.io.send(guildIntent.perms(member, next))) n++
    }
    return n
  }

  setTitle(member: number, title: string): boolean {
    return this.io.send(guildIntent.title(member, title))
  }

  setNotice(title: string, text: string): boolean {
    const msg = guildIntent.notice(title, text)
    if (!msg) {
      this.io.error(t('guild.noticeTooLong'))
      return false
    }
    return this.io.send(msg)
  }

  handOver(member: number): boolean {
    return this.io.send(guildIntent.master(member))
  }

  /** `@text` or `/g text` typed in the chat. */
  chat(text: string): void {
    if (!text) return
    if (!this.book.inGuild) {
      this.io.chatError(t('guild.chatNoGuild'))
      return
    }
    this.io.send({ t: 'chat', text, channel: 'guild' })
  }
}

// ---- the name badge option ---------------------------------------------------------------------------------------------------------

/** "Display Guild Name" (retail `UIIT_STT_GUILDVIEW_SIGN`), per browser; default on. */
export const SHOW_GUILD_KEY = 'sro.showGuild'

export function loadShowGuild(): boolean {
  try {
    return globalThis.localStorage?.getItem(SHOW_GUILD_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveShowGuild(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(SHOW_GUILD_KEY, on ? '1' : '0')
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
}

/** The badge a player's name tag carries: the guild name, or null (none, or names switched off). */
export function guildBadgeText(guild: string | undefined, show: boolean): string | null {
  return show && guild ? guild : null
}
