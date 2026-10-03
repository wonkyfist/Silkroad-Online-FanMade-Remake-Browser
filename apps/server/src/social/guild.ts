import {
  GUILD_INVITE_MS,
  GUILD_NOTICE_MAX,
  GUILD_NOTICE_TITLE_MAX,
  GUILD_REQUESTS,
  GUILD_TITLE_MAX,
  type GameplayRequest,
  type GuildEventKind,
  type GuildMember,
  type GuildPerm,
  type GuildRank,
  type GuildState,
  type ServerMessage,
} from '@sro/shared'
import { knob } from '../config.ts'
import { cleanChat, isReservedName } from '../connection.ts'
import type { Gameplay } from '../gameplay.ts'
import { addGold, done, fail, type InvDraft, type Result } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Entity, Player } from '../world.ts'
import {
  ALL_PERMS_BITS,
  HOUR_MS,
  bitsToPerms,
  cleanText,
  createRefusal,
  formatWait,
  hasPerm,
  kickRefusal,
  masterOnlyRefusal,
  nameRefusal,
  penaltyLeftMs,
  permsToBits,
  titleRefusal,
} from './guild-rules.ts'
import { isUniqueError, openGuildStore, type GuildStore, type MemberRow, type PruneResult } from './guild-store.ts'

/**
 * Guilds (docs/SYSTEMS_SOCIAL.md §5; docs/WAVE_PLAN2.md §6.5 lane GU-S). Persistent: guild-store.ts holds the
 * statements, this module keeps the loaded guilds in memory and in step with every write (G8: requests read
 * membership from here, and here is loaded from the database).
 *
 * - Requests (§5.2): create and disband at the Guild Manager (`requireService(p, npc, 'guild')`), invite by character
 *   name, respond, leave, kick, rights, titles, the notice, mastership. A create pays the gold and inserts the guild
 *   in one `inventoryTx`; a name clash from the unique index maps to `name_taken`.
 * - Messages: the full `guild` state on enter-world (last, D35) and on structural changes (create, join for the joiner,
 *   notice, mastership, rename); `guildMember` for one changed member (joined, online/offline, level, rights, title);
 *   `guildMemberRemoved`; `guildEvent` lines; `guildInvited` to an invitee.
 * - Nameplates: the `EntityState.guild` decorator reads a per-character cache (worldEnter.self is built before the
 *   modules' `enter`, §5.4); `entityUpdate {guild}` goes to viewers on create, join, leave, kick, disband and rename.
 * - Lifecycle: `enter` marks the member online, `forget` offline (with `lastSeen`); `tick` expires invites (30 s) and
 *   sends level changes of online members at most every 2 s.
 * - Deleted characters are pruned at start, when a guild is loaded and when a member enters: a deleted master hands
 *   over to the member who joined earliest, and a guild left empty is disbanded.
 *
 * Event names: 'created' {guild} to the creator; 'joined' {joiner} to every online member (the joiner too); 'left'
 * {leaver} and 'kicked' {kicked} to the members who stay (the kicked member gets 'kicked' too); 'master' {new master};
 * 'disbanded' {guild} to the online members; 'declined' {invitee} to the inviter; 'expired' {the other side} to both
 * sides of an invite; 'online' / 'offline' {member} to the others; 'notice' {author}; 'perms' / 'title' {member}.
 */

/** Level changes of online members go out at most this often (§5.4). */
export const GUILD_LEVEL_SYNC_MS = 2000

interface MemberRec {
  characterId: number
  name: string
  model: string
  /** Last known level (the character row; online members are refreshed from the player). */
  level: number
  rank: GuildRank
  perms: GuildPerm[]
  title: string
  joinedAt: number
  /** characters.last_played, or the time it left the world. */
  lastSeen: number
}

export interface Guild {
  id: number
  name: string
  /** characterId of the master. */
  master: number
  createdAt: number
  notice: { title: string; text: string; at: number }
  /** characterId -> member, in join order. */
  members: Map<number, MemberRec>
}

interface Invite {
  guild: number
  guildName: string
  from: number
  fromName: string
  to: number
  toName: string
  expiresAt: number
}

export class GuildService implements GameplayModule {
  readonly name = 'guilds'
  readonly handles: readonly GameplayRequest[] = GUILD_REQUESTS
  /** Guild bookkeeping stays possible while dead (§2.7); create, disband and invite do not. */
  readonly whileDead: readonly GameplayRequest[] = ['guildRespond', 'guildLeave', 'guildKick', 'guildPerms', 'guildTitle', 'guildNotice', 'guildMaster']

  readonly store: GuildStore
  /** Loaded live guilds by id. */
  private readonly guilds = new Map<number, Guild>()
  /** characterId -> its guild, or null when known to be in none (the decorator's cache). */
  private readonly byChar = new Map<number, Guild | null>()
  /** Invited characterId -> the pending invite (one at a time per invitee). */
  readonly invites = new Map<number, Invite>()
  private nextLevelSyncAt = 0

  constructor(readonly g: Gameplay) {
    this.store = openGuildStore(g.store)
    for (const r of this.store.pruneDeleted()) this.logPrune(r)
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player') return
      const guild = this.guildOf(e.characterId)
      if (guild) s.guild = guild.name
    })
  }

  // ---- queries -------------------------------------------------------------------------------------------

  /** The guild of a character (loaded from the database on first use; null = none). */
  guildOf(p: Player | number): Guild | null {
    const id = typeof p === 'number' ? p : p.characterId
    const hit = this.byChar.get(id)
    if (hit !== undefined) return hit
    const gid = this.store.guildIdOf(id)
    const guild = gid === undefined ? null : this.load(gid)
    if (!guild || !guild.members.has(id)) {
      this.byChar.set(id, null)
      return null
    }
    return guild
  }

  /** A live guild by name (case-insensitive), loaded. */
  guildNamed(name: string): Guild | null {
    const row = this.store.liveByName(name)
    return row ? this.load(row.id) : null
  }

  private load(gid: number): Guild | null {
    const have = this.guilds.get(gid)
    if (have) return have
    for (const r of this.store.pruneDeleted(gid)) this.logPrune(r)
    const row = this.store.guild(gid)
    if (!row || row.disbanded_at !== null) return null
    const guild: Guild = {
      id: row.id,
      name: row.name,
      master: row.master_id,
      createdAt: row.created_at,
      notice: { title: row.notice_title, text: row.notice_text, at: row.notice_at },
      members: new Map(),
    }
    for (const m of this.store.members(gid)) guild.members.set(m.character_id, this.fromRow(m))
    if (guild.members.size === 0) return null
    this.guilds.set(gid, guild)
    for (const id of guild.members.keys()) this.byChar.set(id, guild)
    return guild
  }

  private fromRow(m: MemberRow): MemberRec {
    return {
      characterId: m.character_id,
      name: m.name,
      model: m.model,
      level: m.level,
      rank: m.rank,
      perms: bitsToPerms(m.perms),
      title: m.title,
      joinedAt: m.joined_at,
      lastSeen: m.last_played,
    }
  }

  /** The online player of a character (entering the world again gives it a new entity id). */
  private online(characterId: number): Player | undefined {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return undefined
  }

  private maxMembers(): number {
    return knob(this.g.config, 'guildMaxMembers')
  }

  /** One member as the members see it (`offline` forces online: false, e.g. while it leaves the world). */
  member(rec: MemberRec, offline = false): GuildMember {
    const p = offline ? undefined : this.online(rec.characterId)
    if (p) rec.level = p.level
    return {
      characterId: rec.characterId,
      name: rec.name,
      model: rec.model,
      level: rec.level,
      rank: rec.rank,
      perms: [...rec.perms],
      title: rec.title,
      online: p !== undefined,
      lastSeen: rec.lastSeen,
      joinedAt: rec.joinedAt,
    }
  }

  /** The guild as its members see it (also what the client parser accepts). */
  state(guild: Guild): GuildState {
    return {
      id: guild.id,
      name: guild.name,
      master: guild.master,
      createdAt: guild.createdAt,
      notice: { ...guild.notice },
      maxMembers: Math.max(this.maxMembers(), guild.members.size),
      members: [...guild.members.values()].map((m) => this.member(m)),
    }
  }

  // ---- requests ------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'guildCreate':
        return this.create(p, msg.npc, msg.name, answer, now)
      case 'guildDisband':
        return this.disbandAtNpc(p, msg.npc, answer, now)
      case 'guildInvite':
        return this.invite(p, msg.name, answer, now)
      case 'guildRespond':
        return this.respond(p, msg.guild, msg.accept, answer, now)
      case 'guildLeave':
        return this.leave(p, answer, now)
      case 'guildKick':
        return this.kick(p, msg.member, answer)
      case 'guildPerms':
        return this.setPerms(p, msg.member, msg.perms, answer)
      case 'guildTitle':
        return this.setTitle(p, msg.member, msg.title, answer)
      case 'guildNotice':
        return this.setNotice(p, msg.title, msg.text, answer, now)
      case 'guildMaster':
        return this.setMaster(p, msg.member, answer, now)
    }
    answer(fail('not_found'))
  }

  /** The requester's guild and member record, or the not_in_guild refusal. */
  private mine(p: Player): { guild: Guild; me: MemberRec } | null {
    const guild = this.guildOf(p)
    const me = guild?.members.get(p.characterId)
    return guild && me ? { guild, me } : null
  }

  private create(p: Player, npc: number, name: string, answer: Answer, now: number): void {
    const at = this.g.npcs.requireService(p, npc, 'guild', now)
    if (!at.ok) return answer(at)
    const cost = knob(this.g.config, 'guildCreateGold')
    const refusal = createRefusal({
      inGuild: this.guildOf(p) !== null,
      level: p.level,
      minLevel: knob(this.g.config, 'guildCreateLevel'),
      name,
      reserved: isReservedName,
      taken: this.store.liveByName(name) !== undefined,
      disbandedAt: this.store.penalties(p.characterId).guild_disbanded_at,
      recreateDays: knob(this.g.config, 'guildRecreateDays'),
      gold: p.gold,
      cost,
      now,
    })
    if (refusal) return answer(refusal)
    let gid = 0
    let out: { result: Result<undefined>; draft: InvDraft }
    try {
      out = this.g.store.inventoryTx(p.characterId, (d) => (cost > 0 ? addGold(d, -cost) : done(undefined)), () => {
        gid = this.store.create(name, p.characterId, now)
      })
    } catch (e) {
      if (isUniqueError(e)) return answer(fail('name_taken', 'The selected guild name already exists.'))
      throw e
    }
    if (!out.result.ok) return answer(out.result)
    answer(true)
    this.g.afterInventory(p, out.draft)
    this.dropInvite(p.characterId)
    const guild = this.load(gid)!
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, guild: guild.name })
    p.send({ t: 'guild', guild: this.state(guild) })
    p.send(this.event('created', guild.name))
    this.g.config.log(`guild ${guild.id} "${guild.name}" created by ${p.name} (${cost} gold)`)
  }

  private disbandAtNpc(p: Player, npc: number, answer: Answer, now: number): void {
    const at = this.g.npcs.requireService(p, npc, 'guild', now)
    if (!at.ok) return answer(at)
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    if (mine.me.rank !== 'master') return answer(fail('no_permission', 'Only the Guild Master can disband the guild.'))
    answer(true)
    this.disband(mine.guild, now, p.characterId)
  }

  /** Disbands `guild`: the store, then every online member's window and nameplate. `penalize` starts the recreate clock. */
  disband(guild: Guild, now: number, penalize: number | null): void {
    this.store.disband(guild.id, now, penalize)
    this.forgetGuild(guild)
    this.g.config.log(`guild ${guild.id} "${guild.name}" disbanded`)
  }

  /** Drops a (disbanded) guild from memory: members get `disbanded`, `guild: null` and a cleared nameplate. */
  private forgetGuild(guild: Guild): void {
    this.guilds.delete(guild.id)
    for (const rec of guild.members.values()) {
      this.byChar.set(rec.characterId, null)
      const q = this.online(rec.characterId)
      if (!q) continue
      q.send(this.event('disbanded', guild.name))
      q.send({ t: 'guild', guild: null })
      this.g.world.broadcastAbout(q, { t: 'entityUpdate', id: q.id, guild: '' })
    }
    for (const [to, inv] of [...this.invites]) if (inv.guild === guild.id) this.invites.delete(to)
  }

  private invite(p: Player, name: string, answer: Answer, now: number): void {
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    const { guild, me } = mine
    if (!hasPerm(me, 'invite')) return answer(fail('no_permission', 'You have no right to invite members.'))
    const t = this.g.world.byName(name)
    if (!t || !this.g.world.canSee(p, t)) return answer(fail('not_found', `${name} is not online.`))
    if (t.id === p.id) return answer(fail('invalid_target', 'You cannot invite yourself.'))
    if (this.guildOf(t)) return answer(fail('in_guild', `${t.name} is already in a guild.`))
    if (guild.members.size >= this.maxMembers()) return answer(fail('guild_full'))
    if (this.invites.has(t.characterId)) return answer(fail('cooldown', `${t.name} already has a guild invitation.`))
    const wait = this.rejoinWait(t.characterId, now)
    if (wait > 0) return answer(fail('cooldown', `${t.name} left a guild recently and can join again in ${formatWait(wait)}.`))
    this.invites.set(t.characterId, {
      guild: guild.id,
      guildName: guild.name,
      from: p.characterId,
      fromName: p.name,
      to: t.characterId,
      toName: t.name,
      expiresAt: now + GUILD_INVITE_MS,
    })
    answer(true)
    t.send({ t: 'guildInvited', guild: guild.id, name: guild.name, from: p.name, expiresInMs: GUILD_INVITE_MS })
  }

  private rejoinWait(characterId: number, now: number): number {
    return penaltyLeftMs(this.store.penalties(characterId).guild_left_at, knob(this.g.config, 'guildRejoinHours') * HOUR_MS, now)
  }

  private respond(p: Player, gid: number, accept: boolean, answer: Answer, now: number): void {
    const inv = this.invites.get(p.characterId)
    if (!inv || inv.guild !== gid) return answer(fail('no_invite'))
    this.invites.delete(p.characterId)
    if (!accept) {
      answer(true)
      this.online(inv.from)?.send(this.event('declined', p.name))
      return
    }
    const guild = this.guilds.get(gid) ?? this.load(gid)
    if (!guild) return answer(fail('no_invite', 'The guild no longer exists.'))
    if (this.guildOf(p)) return answer(fail('in_guild'))
    if (guild.members.size >= this.maxMembers()) return answer(fail('guild_full'))
    const wait = this.rejoinWait(p.characterId, now)
    if (wait > 0) return answer(fail('cooldown', `You left a guild recently. You can join again in ${formatWait(wait)}.`))
    try {
      this.store.join(guild.id, p.characterId, now)
    } catch (e) {
      if (isUniqueError(e)) return answer(fail('in_guild'))
      throw e
    }
    answer(true)
    const rec: MemberRec = { characterId: p.characterId, name: p.name, model: p.model, level: p.level, rank: 'member', perms: [], title: '', joinedAt: now, lastSeen: now }
    guild.members.set(p.characterId, rec)
    this.byChar.set(p.characterId, guild)
    this.broadcast(guild, this.event('joined', p.name))
    p.send({ t: 'guild', guild: this.state(guild) })
    this.broadcast(guild, { t: 'guildMember', member: this.member(rec) }, p.characterId)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, guild: guild.name })
    this.g.config.log(`guild ${guild.id}: ${p.name} joined (${guild.members.size} members)`)
  }

  private leave(p: Player, answer: Answer, now: number): void {
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    const { guild, me } = mine
    if (me.rank === 'master') {
      if (guild.members.size > 1) return answer(fail('no_permission', 'Pass on the mastership or disband the guild first.'))
      answer(true)
      return this.disband(guild, now, p.characterId)
    }
    this.store.leave(p.characterId, now)
    answer(true)
    this.removeMember(guild, me, 'left')
  }

  /** Takes a member out of memory after its row went: its window, its nameplate, and the others' lists. */
  private removeMember(guild: Guild, rec: MemberRec, how: 'left' | 'kicked' | null): void {
    guild.members.delete(rec.characterId)
    this.byChar.set(rec.characterId, null)
    const gone = this.online(rec.characterId)
    if (gone) {
      if (how === 'kicked') gone.send(this.event('kicked', rec.name))
      gone.send({ t: 'guild', guild: null })
      this.g.world.broadcastAbout(gone, { t: 'entityUpdate', id: gone.id, guild: '' })
    }
    if (how) this.broadcast(guild, this.event(how, rec.name))
    this.broadcast(guild, { t: 'guildMemberRemoved', characterId: rec.characterId })
    this.g.config.log(`guild ${guild.id}: ${rec.name} ${how === 'kicked' ? 'was expelled' : how === 'left' ? 'left' : 'was removed'}`)
  }

  private kick(p: Player, member: number, answer: Answer): void {
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    const target = mine.guild.members.get(member)
    const refusal = kickRefusal(mine.me, target)
    if (refusal) return answer(refusal)
    this.store.kick(member)
    answer(true)
    this.removeMember(mine.guild, target!, 'kicked')
  }

  private setPerms(p: Player, member: number, perms: GuildPerm[], answer: Answer): void {
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    const target = mine.guild.members.get(member)
    const refusal = masterOnlyRefusal(mine.me, target, 'grant rights')
    if (refusal) return answer(refusal)
    const bits = permsToBits(perms)
    this.store.setPerms(member, bits)
    answer(true)
    target!.perms = bitsToPerms(bits)
    this.changed(mine.guild, target!, 'perms')
  }

  private setTitle(p: Player, member: number, raw: string, answer: Answer): void {
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    const target = mine.guild.members.get(member)
    const refusal = titleRefusal(mine.me, target)
    if (refusal) return answer(refusal)
    const title = cleanText(raw, GUILD_TITLE_MAX, cleanChat)
    if (title === null) return answer(fail('bad_name', `A title has at most ${GUILD_TITLE_MAX} characters.`))
    this.store.setTitle(member, title)
    answer(true)
    target!.title = title
    this.changed(mine.guild, target!, 'title')
  }

  /** One member changed (rights, title): its row to every online member, and the event line. */
  private changed(guild: Guild, rec: MemberRec, event: GuildEventKind): void {
    this.broadcast(guild, { t: 'guildMember', member: this.member(rec) })
    this.broadcast(guild, this.event(event, rec.name))
  }

  private setNotice(p: Player, rawTitle: string, rawText: string, answer: Answer, now: number): void {
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    if (!hasPerm(mine.me, 'notice')) return answer(fail('no_permission', 'You have no right to write the notice.'))
    const title = cleanText(rawTitle, GUILD_NOTICE_TITLE_MAX, cleanChat)
    const text = cleanText(rawText, GUILD_NOTICE_MAX, cleanChat)
    if (title === null || text === null) return answer(fail('bad_name', 'The notice is too long.'))
    this.store.setNotice(mine.guild.id, title, text, now)
    answer(true)
    mine.guild.notice = { title, text, at: now }
    this.broadcast(mine.guild, this.event('notice', p.name))
    this.sendState(mine.guild)
  }

  private setMaster(p: Player, member: number, answer: Answer, now: number): void {
    const mine = this.mine(p)
    if (!mine) return answer(fail('not_in_guild'))
    // G10: a character deleted while the guild was loaded is pruned first, and then is no member.
    if (mine.guild.members.has(member) && this.g.store.characterById(member)?.deleted_at != null) this.refreshDeleted(mine.guild, now)
    const target = mine.guild.members.get(member)
    const refusal = masterOnlyRefusal(mine.me, target, 'pass on the mastership')
    if (refusal) return answer(refusal)
    this.store.transferMaster(mine.guild.id, p.characterId, member)
    answer(true)
    this.applyMaster(mine.guild, member, p.characterId)
  }

  /** Mastership moved to `to` (in memory; the store already has it): ranks, the event and the full state. */
  private applyMaster(guild: Guild, to: number, from: number | null): void {
    const next = guild.members.get(to)
    if (!next) return
    const old = from === null ? undefined : guild.members.get(from)
    if (old) {
      old.rank = 'member'
      old.perms = bitsToPerms(ALL_PERMS_BITS)
    }
    next.rank = 'master'
    next.perms = bitsToPerms(ALL_PERMS_BITS)
    guild.master = to
    this.broadcast(guild, this.event('master', next.name))
    this.sendState(guild)
    this.g.config.log(`guild ${guild.id}: ${next.name} is the Guild Master`)
  }

  // ---- deleted characters --------------------------------------------------------------------------------

  /** Prunes deleted characters of a loaded guild (§5.2) and tells the members. */
  private refreshDeleted(guild: Guild, now: number): void {
    for (const r of this.store.pruneDeleted(guild.id, now)) this.applyRemoval(r)
  }

  /** A store removal (pruning, GM kick) mirrored in memory. */
  private applyRemoval(r: PruneResult): void {
    this.logPrune(r)
    const guild = this.guilds.get(r.guildId)
    if (!guild) {
      for (const id of r.removed) this.byChar.set(id, null)
      return
    }
    const removed = r.removed.map((id) => guild.members.get(id)).filter((m): m is MemberRec => m !== undefined)
    // Disbanded: every member (the removed ones too) gets the disband, `guild: null` and a cleared nameplate.
    if (r.disbanded) return this.forgetGuild(guild)
    for (const rec of removed) this.removeMember(guild, rec, null)
    if (r.newMaster !== undefined) this.applyMaster(guild, r.newMaster, null)
  }

  private logPrune(r: PruneResult): void {
    if (r.removed.length === 0 && !r.disbanded) return
    const what = r.disbanded ? 'disbanded (no members left)' : r.newMaster !== undefined ? `master is now character ${r.newMaster}` : 'members removed'
    this.g.config.log(`guild ${r.guildId}: removed characters ${r.removed.join(', ') || '-'}; ${what}`)
  }

  // ---- lifecycle hooks -----------------------------------------------------------------------------------

  /** Enter-world: the full `guild` (last in the sequence, D35), and the others see the member come online. */
  enter(p: Player, now: number): void {
    let guild = this.guildOf(p)
    if (!guild) return
    this.refreshDeleted(guild, now)
    guild = this.guildOf(p)
    const rec = guild?.members.get(p.characterId)
    if (!guild || !rec) return
    rec.level = p.level
    p.send({ t: 'guild', guild: this.state(guild) })
    this.broadcast(guild, { t: 'guildMember', member: this.member(rec) }, p.characterId)
    this.broadcast(guild, this.event('online', p.name), p.characterId)
  }

  /** Left the world: its pending invite ends, and the members see it go offline. */
  forget(p: Player): void {
    const now = Date.now()
    const inv = this.invites.get(p.characterId)
    if (inv) {
      this.invites.delete(p.characterId)
      this.online(inv.from)?.send(this.event('expired', p.name))
    }
    const guild = this.byChar.get(p.characterId)
    const rec = guild?.members.get(p.characterId)
    if (!guild || !rec) return
    rec.level = p.level
    rec.lastSeen = now
    this.broadcast(guild, { t: 'guildMember', member: this.member(rec, true) }, p.characterId)
    this.broadcast(guild, this.event('offline', p.name), p.characterId)
  }

  tick(now: number): void {
    for (const [to, inv] of [...this.invites]) {
      if (now < inv.expiresAt) continue
      this.invites.delete(to)
      this.online(inv.from)?.send(this.event('expired', inv.toName))
      this.online(to)?.send(this.event('expired', inv.guildName))
    }
    if (now < this.nextLevelSyncAt) return
    this.nextLevelSyncAt = now + GUILD_LEVEL_SYNC_MS
    for (const p of this.g.world.players.values()) {
      const guild = this.byChar.get(p.characterId)
      const rec = guild?.members.get(p.characterId)
      if (!guild || !rec || rec.level === p.level) continue
      rec.level = p.level
      this.broadcast(guild, { t: 'guildMember', member: this.member(rec) })
    }
  }

  // ---- GM (social/gm-guild.ts) ---------------------------------------------------------------------------

  /** GM rename: validated like a create; nameplates and windows follow. */
  gmRename(guild: Guild, name: string): string | null {
    const bad = nameRefusal(name, isReservedName)
    if (bad) return bad.message ?? 'Bad name.'
    const other = this.store.liveByName(name)
    if (other && other.id !== guild.id) return `A guild named ${other.name} exists.`
    try {
      this.store.rename(guild.id, name)
    } catch (e) {
      if (isUniqueError(e)) return `A guild named ${name} exists.`
      throw e
    }
    guild.name = name
    for (const inv of this.invites.values()) if (inv.guild === guild.id) inv.guildName = name
    for (const rec of guild.members.values()) {
      const q = this.online(rec.characterId)
      if (q) this.g.world.broadcastAbout(q, { t: 'entityUpdate', id: q.id, guild: name })
    }
    this.sendState(guild)
    return null
  }

  /** GM expel: any member; the master hands over to the member who joined earliest, a guild left empty is disbanded. */
  gmKick(guild: Guild, characterId: number, now = Date.now()): void {
    const rec = guild.members.get(characterId)
    if (!rec) return
    const r = this.store.remove(guild.id, [characterId], now)
    const q = this.online(characterId)
    if (q && !r.disbanded) q.send(this.event('kicked', rec.name))
    this.applyRemoval(r)
  }

  // ---- messages ------------------------------------------------------------------------------------------

  private event(event: GuildEventKind, name: string): ServerMessage {
    return { t: 'guildEvent', event, name }
  }

  private sendState(guild: Guild): void {
    this.broadcast(guild, { t: 'guild', guild: this.state(guild) })
  }

  /** Sends to every online member (except one character). */
  private broadcast(guild: Guild, msg: ServerMessage, exceptChar?: number): void {
    for (const rec of guild.members.values()) {
      if (rec.characterId === exceptChar) continue
      this.online(rec.characterId)?.send(msg)
    }
  }

  /** A pending invite of `characterId` ends (it created or joined a guild). */
  private dropInvite(characterId: number): void {
    const inv = this.invites.get(characterId)
    if (!inv) return
    this.invites.delete(characterId)
    this.online(inv.from)?.send(this.event('expired', inv.toName))
  }

  // ---- chat (§5.3) ---------------------------------------------------------------------------------------

  /**
   * Guild chat: `text` (cleaned) from `p` to every online member. False when `p` is in no guild (chat.ts then answers
   * `error bad_request`). Recipients come from the member list only (G7).
   */
  chat(p: Player, text: string): boolean {
    const guild = this.guildOf(p)
    if (!guild) return false
    this.broadcast(guild, { t: 'chat', channel: 'guild', fromId: p.id, from: p.name, text })
    return true
  }

  /** The guild name of an entity for callers outside the decorator (null = none or not a player). */
  guildNameOf(e: Entity): string | null {
    return e.kind === 'player' ? (this.guildOf(e.characterId)?.name ?? null) : null
  }
}
