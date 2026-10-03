/**
 * Mock support of lane GU-C (guilds) for ?mock=1 (docs/SYSTEMS_SOCIAL.md §9.1). Optional and first to cut
 * (docs/WAVE_PLAN2.md §6.9): the real-server e2e tests are the truth. Only that lane edits this file. Import
 * MockServer types with `import type`.
 *
 * One mock server keeps its guilds in memory (not saved). It answers every guild request with the server's rules in
 * short (names, ranks, rights, the kick rule, the notice), sends the same messages (`guild`, `guildMember`,
 * `guildMemberRemoved`, `guildEvent`, `entityUpdate {guild}`), and routes guild chat. Bots accept an invitation after
 * a second. The mock charges no gold (its bags are the core's). The mock NPC dialog does not list the 'guild'
 * service, so `?mock=1&mockguild=1` starts the player in a demo guild with the bots and two offline members.
 */
import {
  GUILD_INVITE_MS,
  GUILD_MANAGER_NPCS,
  GUILD_NAME,
  GUILD_PERMS,
  NPC_INTERACT_RANGE,
  type ClientMessage,
  type GuildEventKind,
  type GuildMember,
  type GuildPerm,
  type GuildState,
} from '@sro/shared'
import type { MockConn, MockContext, MockEntity, MockExtension } from '../mock.ts'

const MAX_MEMBERS = 50
const BOT_ANSWER_MS = 1200
const DEMO_NAME = 'Moonlight'

interface Guild {
  id: number
  name: string
  createdAt: number
  notice: { title: string; text: string; at: number }
  /** By lower-case character name. */
  members: Map<string, GuildMember>
}

interface Invite {
  guild: number
  from: string
  expiresAt: number
}

interface World {
  guilds: Map<number, Guild>
  nextId: number
  /** Connections by entity id (from their first message or enter). */
  conns: Map<number, MockConn>
  /** Pending invitations by the invitee's lower-case name. */
  invites: Map<string, Invite>
  /** Bot answers due: [time, bot name, guild id]. */
  botAnswers: [number, string, number][]
  demoDone: Set<string>
}

const worlds = new WeakMap<MockContext, World>()
function world(ctx: MockContext): World {
  let w = worlds.get(ctx)
  if (!w) {
    w = { guilds: new Map(), nextId: 1, conns: new Map(), invites: new Map(), botAnswers: [], demoDone: new Set() }
    worlds.set(ctx, w)
  }
  return w
}

const key = (name: string) => name.toLowerCase()

function players(ctx: MockContext): MockEntity[] {
  return [...ctx.entities()].filter(e => e.state.kind === 'player')
}

function byName(ctx: MockContext, name: string): MockEntity | undefined {
  const k = key(name)
  return players(ctx).find(e => key(e.state.name) === k)
}

function guildOf(w: World, name: string): Guild | undefined {
  const k = key(name)
  for (const g of w.guilds.values()) if (g.members.has(k)) return g
  return undefined
}

function stateOf(g: Guild): GuildState {
  const master = [...g.members.values()].find(m => m.rank === 'master')
  return { id: g.id, name: g.name, master: master?.characterId ?? 0, createdAt: g.createdAt, notice: { ...g.notice }, maxMembers: MAX_MEMBERS, members: [...g.members.values()].map(m => ({ ...m, perms: [...m.perms] })) }
}

function memberOf(e: MockEntity, conn: MockConn | undefined, rank: GuildMember['rank'], now: number): GuildMember {
  return {
    characterId: conn?.charId ?? 100_000 + e.state.id,
    name: e.state.name,
    model: e.state.model,
    level: e.state.level ?? 1,
    rank,
    perms: [],
    title: '',
    online: true,
    lastSeen: now,
    joinedAt: now,
  }
}

const hasPerm = (m: GuildMember, p: GuildPerm) => m.rank === 'master' || m.perms.includes(p)

/** Sends to every online real member (bots have no connection). */
function toGuild(ctx: MockContext, w: World, g: Guild, msg: Parameters<MockContext['send']>[1], except?: string): void {
  for (const m of g.members.values()) {
    if (except && key(m.name) === key(except)) continue
    const e = byName(ctx, m.name)
    const c = e ? w.conns.get(e.state.id) : undefined
    if (c) ctx.send(c, msg)
  }
}

const event = (e: GuildEventKind, name: string) => ({ t: 'guildEvent' as const, event: e, name })

function setBadge(ctx: MockContext, name: string, guild: string): void {
  const e = byName(ctx, name)
  if (e) {
    e.state.guild = guild || undefined
    ctx.broadcast({ t: 'entityUpdate', id: e.state.id, guild })
  }
}

function join(ctx: MockContext, w: World, g: Guild, e: MockEntity): void {
  const c = w.conns.get(e.state.id)
  const m = memberOf(e, c, 'member', ctx.now())
  g.members.set(key(m.name), m)
  toGuild(ctx, w, g, event('joined', m.name))
  if (c) ctx.send(c, { t: 'guild', guild: stateOf(g) })
  toGuild(ctx, w, g, { t: 'guildMember', member: m }, m.name)
  setBadge(ctx, m.name, g.name)
}

function remove(ctx: MockContext, w: World, g: Guild, m: GuildMember, how: 'left' | 'kicked'): void {
  g.members.delete(key(m.name))
  const e = byName(ctx, m.name)
  const c = e ? w.conns.get(e.state.id) : undefined
  if (c) {
    if (how === 'kicked') ctx.send(c, event('kicked', m.name))
    ctx.send(c, { t: 'guild', guild: null })
  }
  setBadge(ctx, m.name, '')
  toGuild(ctx, w, g, event(how, m.name))
  toGuild(ctx, w, g, { t: 'guildMemberRemoved', characterId: m.characterId })
}

function disband(ctx: MockContext, w: World, g: Guild): void {
  toGuild(ctx, w, g, event('disbanded', g.name))
  toGuild(ctx, w, g, { t: 'guild', guild: null })
  for (const m of g.members.values()) setBadge(ctx, m.name, '')
  w.guilds.delete(g.id)
}

function createGuild(ctx: MockContext, w: World, name: string, master: MockEntity, conn: MockConn | undefined): Guild {
  const g: Guild = { id: w.nextId++, name, createdAt: ctx.now(), notice: { title: '', text: '', at: 0 }, members: new Map() }
  const m = memberOf(master, conn, 'master', ctx.now())
  g.members.set(key(m.name), m)
  w.guilds.set(g.id, g)
  return g
}

function nameTaken(w: World, name: string): boolean {
  return [...w.guilds.values()].some(g => key(g.name) === key(name))
}

/** ?mockguild=1: the demo guild (the player as master, the bots, two offline members, a notice). */
function demo(ctx: MockContext, w: World, conn: MockConn, self: MockEntity): void {
  if (w.demoDone.has(key(self.state.name)) || guildOf(w, self.state.name)) return
  w.demoDone.add(key(self.state.name))
  let name = DEMO_NAME
  for (let i = 2; nameTaken(w, name); i++) name = `${DEMO_NAME}${i}`
  const g = createGuild(ctx, w, name, self, conn)
  const now = ctx.now()
  g.notice = { title: 'Tiger Mountain hunt tonight', text: 'Meet at the west gate of Jangan at 20:00.\nBring HP potions and a return scroll.', at: now - 3_600_000 }
  for (const bot of players(ctx).filter(e => e.bot)) {
    const m = memberOf(bot, undefined, 'member', now - 86_400_000)
    g.members.set(key(m.name), m)
    setBadge(ctx, m.name, g.name)
  }
  const first = [...g.members.values()].find(m => m.rank === 'member')
  if (first) first.perms = [...GUILD_PERMS]
  const offline: [string, number, number, string][] = [['WangFei', 17, 2 * 86_400_000, 'Scout'], ['Lin_Yao', 9, 5 * 3_600_000, '']]
  offline.forEach(([n, level, ago, title], i) => {
    g.members.set(key(n), { characterId: 200_000 + i, name: n, model: 'CHAR_CH_MAN_ADVENTURER', level, rank: 'member', perms: i === 0 ? ['invite'] : [], title, online: false, lastSeen: now - ago, joinedAt: now - 7 * 86_400_000 })
  })
  setBadge(ctx, self.state.name, g.name)
  ctx.send(conn, { t: 'guild', guild: stateOf(g) })
}

function demoWanted(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('mockguild') === '1'
  } catch {
    return false
  }
}

type GuildRequest = Extract<ClientMessage, { t: `guild${string}` }>

function request(ctx: MockContext, w: World, conn: MockConn, self: MockEntity, msg: GuildRequest): void {
  const no = (reason: Parameters<MockContext['result']>[3], message?: string) => ctx.result(conn, msg.t, false, reason, message)
  const ok = () => ctx.result(conn, msg.t, true)
  const g = guildOf(w, self.state.name)
  const me = g?.members.get(key(self.state.name))
  switch (msg.t) {
    case 'guildCreate': {
      const npc = ctx.entity(msg.npc)
      if (!npc?.npc || !GUILD_MANAGER_NPCS.includes(npc.npc.code)) return no('not_found')
      if (ctx.dist(self, npc) > NPC_INTERACT_RANGE) return no('too_far')
      if (g) return no('in_guild')
      if (!GUILD_NAME.test(msg.name)) return no('bad_name')
      if (nameTaken(w, msg.name)) return no('name_taken')
      ok()
      const created = createGuild(ctx, w, msg.name, self, conn)
      setBadge(ctx, self.state.name, created.name)
      ctx.send(conn, { t: 'guild', guild: stateOf(created) })
      ctx.send(conn, event('created', created.name))
      return
    }
    case 'guildDisband':
      if (!g || !me) return no('not_in_guild')
      if (me.rank !== 'master') return no('no_permission')
      ok()
      return disband(ctx, w, g)
    case 'guildInvite': {
      if (!g || !me) return no('not_in_guild')
      if (!hasPerm(me, 'invite')) return no('no_permission')
      const target = byName(ctx, msg.name)
      if (!target) return no('not_found', `${msg.name} is not online.`)
      if (guildOf(w, target.state.name)) return no('in_guild')
      if (g.members.size >= MAX_MEMBERS) return no('guild_full')
      if (w.invites.has(key(target.state.name))) return no('cooldown')
      ok()
      w.invites.set(key(target.state.name), { guild: g.id, from: self.state.name, expiresAt: ctx.now() + GUILD_INVITE_MS })
      const tc = w.conns.get(target.state.id)
      if (tc) ctx.send(tc, { t: 'guildInvited', guild: g.id, name: g.name, from: self.state.name, expiresInMs: GUILD_INVITE_MS })
      else if (target.bot) w.botAnswers.push([ctx.now() + BOT_ANSWER_MS, target.state.name, g.id])
      return
    }
    case 'guildRespond': {
      const inv = w.invites.get(key(self.state.name))
      if (!inv || inv.guild !== msg.guild) return no('no_invite')
      w.invites.delete(key(self.state.name))
      const target = w.guilds.get(inv.guild)
      if (!msg.accept) {
        ok()
        const from = byName(ctx, inv.from)
        const fc = from ? w.conns.get(from.state.id) : undefined
        if (fc) ctx.send(fc, event('declined', self.state.name))
        return
      }
      if (!target) return no('no_invite')
      if (g) return no('in_guild')
      if (target.members.size >= MAX_MEMBERS) return no('guild_full')
      ok()
      return join(ctx, w, target, self)
    }
    case 'guildLeave':
      if (!g || !me) return no('not_in_guild')
      if (me.rank === 'master') {
        if (g.members.size > 1) return no('no_permission', 'Pass on the mastership or disband the guild first.')
        ok()
        return disband(ctx, w, g)
      }
      ok()
      return remove(ctx, w, g, me, 'left')
    case 'guildKick': {
      if (!g || !me) return no('not_in_guild')
      const target = [...g.members.values()].find(m => m.characterId === msg.member)
      if (!target) return no('not_found')
      if (target.rank === 'master' || target === me) return no('invalid_target')
      if (me.rank !== 'master' && (!me.perms.includes('kick') || target.perms.includes('kick'))) return no('no_permission')
      ok()
      return remove(ctx, w, g, target, 'kicked')
    }
    case 'guildPerms':
    case 'guildTitle': {
      if (!g || !me) return no('not_in_guild')
      const target = [...g.members.values()].find(m => m.characterId === msg.member)
      if (!target) return no('not_found')
      if (msg.t === 'guildPerms') {
        if (me.rank !== 'master') return no('no_permission')
        if (target.rank === 'master') return no('invalid_target')
        target.perms = GUILD_PERMS.filter(p => msg.perms.includes(p))
      } else {
        if (!hasPerm(me, 'title')) return no('no_permission')
        target.title = msg.title.trim()
      }
      ok()
      toGuild(ctx, w, g, { t: 'guildMember', member: { ...target, perms: [...target.perms] } })
      toGuild(ctx, w, g, event(msg.t === 'guildPerms' ? 'perms' : 'title', target.name))
      return
    }
    case 'guildNotice':
      if (!g || !me) return no('not_in_guild')
      if (!hasPerm(me, 'notice')) return no('no_permission')
      ok()
      g.notice = { title: msg.title, text: msg.text, at: ctx.now() }
      toGuild(ctx, w, g, { t: 'guild', guild: stateOf(g) })
      toGuild(ctx, w, g, event('notice', self.state.name))
      return
    case 'guildMaster': {
      if (!g || !me) return no('not_in_guild')
      if (me.rank !== 'master') return no('no_permission')
      const target = [...g.members.values()].find(m => m.characterId === msg.member)
      if (!target || target === me) return no('not_found')
      ok()
      me.rank = 'member'
      me.perms = [...GUILD_PERMS]
      target.rank = 'master'
      toGuild(ctx, w, g, { t: 'guild', guild: stateOf(g) })
      toGuild(ctx, w, g, event('master', target.name))
      return
    }
  }
}

export const guildMock: MockExtension = {
  handle(ctx, conn, msg) {
    const w = world(ctx)
    const self = ctx.selfOf(conn)
    if (!self) return false
    w.conns.set(self.state.id, conn)
    if (msg.t === 'chat' && msg.channel === 'guild') {
      const g = guildOf(w, self.state.name)
      if (!g) {
        conn.deliver({ t: 'error', code: 'bad_request', message: 'You are not in a guild.', re: 'chat' })
        return true
      }
      toGuild(ctx, w, g, { t: 'chat', channel: 'guild', fromId: self.state.id, from: self.state.name, text: msg.text.trim() })
      return true
    }
    if (!msg.t.startsWith('guild')) return false
    request(ctx, w, conn, self, msg as GuildRequest)
    return true
  },
  enter(ctx, conn) {
    const w = world(ctx)
    const self = ctx.selfOf(conn)
    if (!self) return
    w.conns.set(self.state.id, conn)
    const g = guildOf(w, self.state.name)
    if (g) {
      const me = g.members.get(key(self.state.name))!
      me.online = true
      me.characterId = conn.charId ?? me.characterId
      self.state.guild = g.name
      ctx.broadcast({ t: 'entityUpdate', id: self.state.id, guild: g.name })
      ctx.send(conn, { t: 'guild', guild: stateOf(g) })
    } else if (demoWanted()) demo(ctx, w, conn, self)
  },
  tick(ctx, now) {
    const w = worlds.get(ctx)
    if (!w) return
    // Bots answer after a moment (always yes).
    for (let i = w.botAnswers.length - 1; i >= 0; i--) {
      const [at, name, gid] = w.botAnswers[i]!
      if (now < at) continue
      w.botAnswers.splice(i, 1)
      w.invites.delete(key(name))
      const g = w.guilds.get(gid)
      const bot = byName(ctx, name)
      if (g && bot && !guildOf(w, name) && g.members.size < MAX_MEMBERS) join(ctx, w, g, bot)
    }
    for (const [who, inv] of w.invites) {
      if (now < inv.expiresAt) continue
      w.invites.delete(who)
      const g = w.guilds.get(inv.guild)
      const from = byName(ctx, inv.from)
      const fc = from ? w.conns.get(from.state.id) : undefined
      const to = byName(ctx, who)
      if (fc) ctx.send(fc, event('expired', to?.state.name ?? who))
      const tc = to ? w.conns.get(to.state.id) : undefined
      if (tc && g) ctx.send(tc, event('expired', g.name))
    }
  },
}
