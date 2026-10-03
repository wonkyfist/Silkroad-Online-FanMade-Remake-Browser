/**
 * Guild server module (docs/SYSTEMS_SOCIAL.md §5, §10.7; lane GU-S): create at the Guild Manager (gold and guild in one
 * transaction, each §5.2 refusal, the UNIQUE race mapped to name_taken), invite / respond / expiry, leave, kick (G4),
 * rights, titles, the notice, mastership, disband (G9), guild chat to members only (G7), nameplates through the
 * decorator and `entityUpdate guild`, the enter-world order (D35), online/offline, the level sync, relog, the restart
 * test (the guild persists, a stall or trade does not), deleted-character pruning and the GM `guilds` command.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUILD_INVITE_MS,
  parseServerMessage,
  type ClientMessage,
  type GameplayRequest,
  type NpcDef,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import type { GmCall } from '../src/gm.ts'
import { addGold } from '../src/inventory.ts'
import { FlatNav } from '../src/nav.ts'
import { GUILD_LEVEL_SYNC_MS } from '../src/social/guild.ts'
import { runGuildsCommand } from '../src/social/gm-guild.ts'
import { World, type Player } from '../src/world.ts'
import { Client, newAccount, startTestServer, testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, contentFiles, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const LEEBAEK: NpcDef = { code: 'NPC_CH_GENARAL_SP', name: 'Leebaek', x: 10, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client' }

interface P {
  p: Player
  inbox: ServerMessage[]
}

/** A game on `root` (a restart is a second boot on the same root). */
function boot(root: string, extra: Partial<ServerConfig> = {}) {
  const logs: string[] = []
  const config: ServerConfig = { ...testConfig(root, logs), rng: seeded(3), ...extra }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: [...NPCS, LEEBAEK], shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(3) })
  gameplay.start()
  const npc = [...world.npcs.values()].find((n) => n.code === 'NPC_CH_GENARAL_SP')!.id
  return { root, config, logs, store, world, gameplay, guilds: gameplay.guilds, npc }
}

function harness(extra: Partial<ServerConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-guild-'))
  let game = boot(root, extra)
  let n = 0
  cleanups.push(() => {
    game.store.close()
    rmSync(root, { recursive: true, force: true })
  })
  /** A new character in the world, level 10 with 50,000 gold (every player knows every other). */
  const enter = (pos: Vec3 = [5, 0, 0], opts: { level?: number; gold?: number; name?: string } = {}): P => {
    const acc = game.store.createAccount(`gacc${++n}`, 'x')!
    const row = game.store.createCharacter(acc, opts.name ?? `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    game.store.inventoryTx(row.id, (d) => addGold(d, opts.gold ?? 50_000))
    game.store.setLevel(row.id, opts.level ?? 10)
    return rejoin(row.id, pos)
  }
  /** (Re-)enters an existing character: a new entity, as after a relog; runs sendEnter like connection.ts. */
  const rejoin = (characterId: number, pos: Vec3 = [5, 0, 0], opts: { sendEnter?: boolean } = {}): P => {
    const row = game.store.characterById(characterId)!
    const inbox: ServerMessage[] = []
    const p = game.world.add({ ...game.gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: row.level, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    for (const q of game.world.players.values()) {
      q.known.add(p.id)
      p.known.add(q.id)
    }
    if (opts.sendEnter) game.gameplay.sendEnter(p)
    return { p, inbox }
  }
  const leave = (x: P) => {
    game.world.remove(x.p.id)
    game.gameplay.forget(x.p)
  }
  const req = (x: P, msg: ClientMessage, now = Date.now()) => {
    const before = x.inbox.length
    game.gameplay.request(x.p, msg as Extract<ClientMessage, { t: GameplayRequest }>, now)
    const res = x.inbox.slice(before).filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
    expect(res.length, msg.t).toBe(1)
    return res[0]
  }
  /** Creates guild `name` for `x` at Leebaek. */
  const create = (x: P, name = 'Tigers') => expect(req(x, { t: 'guildCreate', npc: game.npc, name })).toMatchObject({ ok: true })
  /** `a` invites `b` by name and `b` accepts. */
  const invite = (a: P, b: P) => {
    expect(req(a, { t: 'guildInvite', name: b.p.name })).toMatchObject({ ok: true })
    const inv = of(b, 'guildInvited').at(-1)!
    expect(req(b, { t: 'guildRespond', guild: inv.guild, accept: true })).toMatchObject({ ok: true })
  }
  /** Shuts the game down and boots it again on the same database (players must re-enter). */
  const restart = (extra2: Partial<ServerConfig> = extra) => {
    game.store.close()
    game = boot(root, extra2)
  }
  return {
    get g() {
      return game
    },
    enter,
    rejoin,
    leave,
    req,
    create,
    invite,
    restart,
  }
}

const of = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t)
const lastGuild = (x: P) => of(x, 'guild').at(-1)?.guild
const events = (x: P) => of(x, 'guildEvent').map((e) => `${e.event}:${e.name}`)
const nameplates = (x: P, id: number) => of(x, 'entityUpdate').filter((u) => u.id === id && u.guild !== undefined).map((u) => u.guild)
const wire = (m: unknown) => {
  const r = parseServerMessage(JSON.stringify(m))
  if (!r.ok) throw new Error(r.error)
  return r.msg
}

describe('guildCreate', () => {
  it('at Leebaek: gold and guild in one step; state, event, nameplate for viewers; the frames parse', () => {
    const h = harness()
    const a = h.enter()
    const v = h.enter([6, 0, 0])
    h.create(a, 'Tigers')
    expect(a.p.gold).toBe(40_000)
    expect(h.g.store.loadInventory(a.p.characterId).gold).toBe(40_000)
    const st = lastGuild(a)!
    expect(st).toMatchObject({ name: 'Tigers', master: a.p.characterId, maxMembers: 50, notice: { title: '', text: '', at: 0 } })
    expect(st.members).toMatchObject([{ characterId: a.p.characterId, name: a.p.name, rank: 'master', perms: ['invite', 'kick', 'notice', 'title'], online: true, level: 10 }])
    expect(events(a)).toEqual(['created:Tigers'])
    expect(nameplates(v, a.p.id)).toEqual(['Tigers'])
    expect(nameplates(a, a.p.id)).toEqual(['Tigers'])
    expect(h.g.world.state(a.p).guild).toBe('Tigers')
    expect(h.g.world.state(v.p).guild).toBeUndefined()
    for (const m of [...of(a, 'guild'), ...of(a, 'guildEvent'), ...of(v, 'entityUpdate')]) expect(wire(m)).toEqual(m)
    // actionResult comes first, then the gold.
    const ts = a.inbox.map((m) => m.t)
    expect(ts.indexOf('actionResult')).toBeLessThan(ts.indexOf('statsDelta'))
  })

  it('refusals in §5.2 order; nothing is paid', () => {
    const h = harness({ guildRecreateDays: 15 })
    const a = h.enter([5, 0, 0], { level: 9, gold: 5_000 })
    const npc = h.g.npc
    expect(h.req(a, { t: 'guildCreate', npc: 999_999, name: 'Tigers' })).toMatchObject({ ok: false, reason: 'not_found' })
    const far = h.enter([40, 0, 0])
    expect(h.req(far, { t: 'guildCreate', npc, name: 'Tigers' })).toMatchObject({ ok: false, reason: 'too_far' })
    expect(h.req(a, { t: 'guildCreate', npc, name: 'Tigers' })).toMatchObject({ ok: false, reason: 'requirements', message: 'Requires level 10.' })
    a.p.level = 10
    expect(h.req(a, { t: 'guildCreate', npc, name: '1abc' })).toMatchObject({ ok: false, reason: 'bad_name' })
    expect(h.req(a, { t: 'guildCreate', npc, name: 'Ti gers' })).toMatchObject({ ok: false, reason: 'bad_name' })
    expect(h.req(a, { t: 'guildCreate', npc, name: 'Admin' })).toMatchObject({ ok: false, reason: 'bad_name' })
    const b = h.enter()
    h.create(b, 'Tigers')
    expect(h.req(a, { t: 'guildCreate', npc, name: 'tIGERS' })).toMatchObject({ ok: false, reason: 'name_taken' })
    expect(h.req(a, { t: 'guildCreate', npc, name: 'Lions' })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(h.req(b, { t: 'guildCreate', npc, name: 'Lions' })).toMatchObject({ ok: false, reason: 'in_guild' })
    // Recreate clock (config days) after a disband.
    expect(h.req(b, { t: 'guildDisband', npc })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'guildCreate', npc, name: 'Lions' })).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.req(b, { t: 'guildCreate', npc, name: 'Lions' }, Date.now() + 16 * 86_400_000)).toMatchObject({ ok: true })
    expect(h.g.store.loadInventory(a.p.characterId).gold).toBe(5_000)
    // Dead: refused before the module.
    a.p.dead = true
    expect(h.req(a, { t: 'guildCreate', npc, name: 'Wolves' })).toMatchObject({ ok: false, reason: 'dead' })
  })

  it('config: create level and cost; a free guild (cost 0) pays nothing', () => {
    const h = harness({ guildCreateLevel: 1, guildCreateGold: 0 })
    const a = h.enter([5, 0, 0], { level: 1, gold: 0 })
    h.create(a, 'Free')
    expect(h.g.store.loadInventory(a.p.characterId).gold).toBe(0)
    expect(of(a, 'statsDelta')).toEqual([])
  })

  it('G6/UNIQUE race: a clash inside the transaction answers name_taken and rolls the gold back', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    h.create(b, 'Tigers')
    // The pre-check misses (another request won between check and insert): the unique index decides.
    const real = h.g.guilds.store.liveByName
    Object.assign(h.g.guilds.store, { liveByName: () => undefined })
    try {
      expect(h.req(a, { t: 'guildCreate', npc: h.g.npc, name: 'TIGERS' })).toMatchObject({ ok: false, reason: 'name_taken' })
    } finally {
      Object.assign(h.g.guilds.store, { liveByName: real })
    }
    expect(h.g.store.loadInventory(a.p.characterId).gold).toBe(50_000)
    expect(h.g.guilds.guildOf(a.p)).toBeNull()
    expect(of(a, 'inventoryUpdate')).toEqual([])
  })
})

describe('invite and respond', () => {
  it('invite by name -> guildInvited; accept -> joined to all, state to the joiner, guildMember to the others, nameplate', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([6, 0, 0])
    const v = h.enter([7, 0, 0])
    h.create(a)
    expect(h.req(a, { t: 'guildInvite', name: b.p.name.toUpperCase() })).toMatchObject({ ok: true })
    const inv = of(b, 'guildInvited')[0]
    expect(inv).toMatchObject({ name: 'Tigers', from: a.p.name, expiresInMs: GUILD_INVITE_MS })
    expect(wire(inv)).toEqual(inv)
    expect(h.req(b, { t: 'guildRespond', guild: inv.guild + 1, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    expect(h.req(b, { t: 'guildRespond', guild: inv.guild, accept: true })).toMatchObject({ ok: true })
    expect(events(a)).toContain(`joined:${b.p.name}`)
    expect(events(b)).toEqual([`joined:${b.p.name}`])
    expect(lastGuild(b)!.members.map((m) => [m.name, m.rank, m.online])).toEqual([[a.p.name, 'master', true], [b.p.name, 'member', true]])
    expect(of(a, 'guildMember').at(-1)!.member).toMatchObject({ characterId: b.p.characterId, rank: 'member', perms: [], title: '' })
    expect(nameplates(v, b.p.id)).toEqual(['Tigers'])
    expect(h.g.world.state(b.p).guild).toBe('Tigers')
    for (const m of [...of(a, 'guildMember'), ...of(b, 'guild')]) expect(wire(m)).toEqual(m)
    // The invite is used up.
    expect(h.req(b, { t: 'guildRespond', guild: inv.guild, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
  })

  it('decline -> the inviter gets declined; expiry -> both get expired', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    h.create(a)
    h.req(a, { t: 'guildInvite', name: b.p.name })
    expect(h.req(b, { t: 'guildRespond', guild: of(b, 'guildInvited')[0].guild, accept: false })).toMatchObject({ ok: true })
    expect(events(a)).toContain(`declined:${b.p.name}`)
    const t0 = Date.now()
    h.req(a, { t: 'guildInvite', name: c.p.name }, t0)
    h.g.guilds.tick(t0 + GUILD_INVITE_MS - 1)
    expect(h.g.guilds.invites.size).toBe(1)
    h.g.guilds.tick(t0 + GUILD_INVITE_MS)
    expect(h.g.guilds.invites.size).toBe(0)
    expect(events(a)).toContain(`expired:${c.p.name}`)
    expect(events(c)).toContain('expired:Tigers')
    expect(h.req(c, { t: 'guildRespond', guild: of(c, 'guildInvited')[0].guild, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
  })

  it('invite refusals: not_in_guild, no_permission, not_found (offline, invisible GM), in_guild, guild_full, cooldown', () => {
    const h = harness({ guildMaxMembers: 2 })
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    const d = h.enter()
    expect(h.req(b, { t: 'guildInvite', name: c.p.name })).toMatchObject({ ok: false, reason: 'not_in_guild' })
    h.create(a)
    h.invite(a, b)
    expect(h.req(b, { t: 'guildInvite', name: c.p.name })).toMatchObject({ ok: false, reason: 'no_permission' })
    expect(h.req(a, { t: 'guildInvite', name: 'Nobody' })).toMatchObject({ ok: false, reason: 'not_found' })
    d.p.invisible = true
    expect(h.req(a, { t: 'guildInvite', name: d.p.name })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(a, { t: 'guildInvite', name: a.p.name })).toMatchObject({ ok: false, reason: 'invalid_target' })
    h.create(c, 'Lions')
    expect(h.req(a, { t: 'guildInvite', name: c.p.name })).toMatchObject({ ok: false, reason: 'in_guild' })
    d.p.invisible = false
    expect(h.req(a, { t: 'guildInvite', name: d.p.name })).toMatchObject({ ok: false, reason: 'guild_full' })
    // A pending invite from another guild.
    expect(h.req(c, { t: 'guildInvite', name: d.p.name })).toMatchObject({ ok: true })
    expect(h.req(c, { t: 'guildInvite', name: d.p.name })).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('accept re-checks the cap and in_guild; the rejoin clock (config hours) blocks invites and accepts', () => {
    const h = harness({ guildMaxMembers: 2, guildRejoinHours: 72 })
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    h.create(a)
    h.req(a, { t: 'guildInvite', name: b.p.name })
    h.req(a, { t: 'guildInvite', name: c.p.name })
    expect(h.req(b, { t: 'guildRespond', guild: of(b, 'guildInvited')[0].guild, accept: true })).toMatchObject({ ok: true })
    expect(h.req(c, { t: 'guildRespond', guild: of(c, 'guildInvited')[0].guild, accept: true })).toMatchObject({ ok: false, reason: 'guild_full' })
    const t0 = Date.now()
    expect(h.req(b, { t: 'guildLeave' }, t0)).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'guildInvite', name: b.p.name }, t0 + 3_600_000)).toMatchObject({ ok: false, reason: 'cooldown', message: expect.stringContaining('71 hours') })
    expect(h.req(a, { t: 'guildInvite', name: b.p.name }, t0 + 72 * 3_600_000)).toMatchObject({ ok: true })
  })
})

describe('leave, kick, rights, titles, notice, mastership', () => {
  function trio() {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    const v = h.enter()
    h.create(a)
    h.invite(a, b)
    h.invite(a, c)
    return { h, a, b, c, v }
  }

  it('a member leaves: left + guildMemberRemoved to the rest, guild null, nameplate cleared, rejoin clock set', () => {
    const { h, a, b, v } = trio()
    const t0 = Date.now()
    expect(h.req(b, { t: 'guildLeave' }, t0)).toMatchObject({ ok: true })
    expect(events(a)).toContain(`left:${b.p.name}`)
    expect(of(a, 'guildMemberRemoved').at(-1)).toEqual({ t: 'guildMemberRemoved', characterId: b.p.characterId })
    expect(lastGuild(b)).toBeNull()
    expect(nameplates(v, b.p.id).at(-1)).toBe('')
    expect(h.g.world.state(b.p).guild).toBeUndefined()
    expect(h.g.guilds.store.penalties(b.p.characterId).guild_left_at).toBe(t0)
    expect(h.req(b, { t: 'guildLeave' })).toMatchObject({ ok: false, reason: 'not_in_guild' })
  })

  it('the master cannot leave with members; alone, leaving disbands', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    h.create(a)
    h.invite(a, b)
    expect(h.req(a, { t: 'guildLeave' })).toMatchObject({ ok: false, reason: 'no_permission', message: 'Pass on the mastership or disband the guild first.' })
    h.req(b, { t: 'guildLeave' })
    expect(h.req(a, { t: 'guildLeave' })).toMatchObject({ ok: true })
    expect(events(a)).toContain('disbanded:Tigers')
    expect(lastGuild(a)).toBeNull()
    expect(h.g.guilds.store.liveByName('Tigers')).toBeUndefined()
  })

  it('kick (G4): the kick right; the master and fellow officers are safe; offline members can be expelled', () => {
    const { h, a, b, c } = trio()
    expect(h.req(b, { t: 'guildKick', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'no_permission' })
    h.req(a, { t: 'guildPerms', member: b.p.characterId, perms: ['kick'] })
    h.req(a, { t: 'guildPerms', member: c.p.characterId, perms: ['kick'] })
    expect(h.req(b, { t: 'guildKick', member: a.p.characterId })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(b, { t: 'guildKick', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'no_permission' })
    expect(h.req(b, { t: 'guildKick', member: b.p.characterId })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(b, { t: 'guildKick', member: 424242 })).toMatchObject({ ok: false, reason: 'not_found' })
    h.leave(c)
    expect(h.req(a, { t: 'guildKick', member: c.p.characterId })).toMatchObject({ ok: true })
    expect(events(b)).toContain(`kicked:${c.p.name}`)
    expect(h.g.guilds.store.guildIdOf(c.p.characterId)).toBeUndefined()
    // No rejoin clock for a kick.
    expect(h.g.guilds.store.penalties(c.p.characterId).guild_left_at).toBeNull()
    // An online kicked member hears it and loses the window.
    h.req(a, { t: 'guildPerms', member: b.p.characterId, perms: [] })
    expect(h.req(a, { t: 'guildKick', member: b.p.characterId })).toMatchObject({ ok: true })
    expect(events(b).at(-1)).toBe(`kicked:${b.p.name}`)
    expect(lastGuild(b)).toBeNull()
  })

  it('rights: master only, never on the master; perms event and guildMember', () => {
    const { h, a, b, c } = trio()
    expect(h.req(b, { t: 'guildPerms', member: c.p.characterId, perms: ['invite'] })).toMatchObject({ ok: false, reason: 'no_permission' })
    expect(h.req(a, { t: 'guildPerms', member: a.p.characterId, perms: [] })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'guildPerms', member: b.p.characterId, perms: ['title', 'invite'] })).toMatchObject({ ok: true })
    expect(of(c, 'guildMember').at(-1)!.member).toMatchObject({ characterId: b.p.characterId, perms: ['invite', 'title'] })
    expect(events(c)).toContain(`perms:${b.p.name}`)
    // With the invite right, b can invite.
    const d = h.enter()
    expect(h.req(b, { t: 'guildInvite', name: d.p.name })).toMatchObject({ ok: true })
  })

  it('titles: the title right; cleaned and bounded; "" clears', () => {
    const { h, a, b, c } = trio()
    expect(h.req(b, { t: 'guildTitle', member: c.p.characterId, title: 'Scout' })).toMatchObject({ ok: false, reason: 'no_permission' })
    h.req(a, { t: 'guildPerms', member: b.p.characterId, perms: ['title'] })
    expect(h.req(b, { t: 'guildTitle', member: c.p.characterId, title: '  Scout‮ ' })).toMatchObject({ ok: true })
    expect(of(a, 'guildMember').at(-1)!.member).toMatchObject({ characterId: c.p.characterId, title: 'Scout' })
    expect(events(a)).toContain(`title:${c.p.name}`)
    expect(h.req(b, { t: 'guildTitle', member: a.p.characterId, title: 'Boss' })).toMatchObject({ ok: false, reason: 'no_permission' })
    expect(h.req(a, { t: 'guildTitle', member: a.p.characterId, title: 'Boss' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'guildTitle', member: c.p.characterId, title: '' })).toMatchObject({ ok: true })
    expect(h.g.guilds.store.members(h.g.guilds.guildOf(a.p)!.id).map((m) => m.title)).toEqual(['Boss', '', ''])
  })

  it('notice: the notice right; stored with its time; notice event and the full state to everyone', () => {
    const { h, a, b, c } = trio()
    expect(h.req(b, { t: 'guildNotice', title: 'Hi', text: 'x' })).toMatchObject({ ok: false, reason: 'no_permission' })
    h.req(a, { t: 'guildPerms', member: b.p.characterId, perms: ['notice'] })
    const t0 = Date.now()
    expect(h.req(b, { t: 'guildNotice', title: 'Raid', text: 'Tiger Girl at 8' }, t0)).toMatchObject({ ok: true })
    expect(lastGuild(c)!.notice).toEqual({ title: 'Raid', text: 'Tiger Girl at 8', at: t0 })
    expect(events(c)).toContain(`notice:${b.p.name}`)
    expect(h.g.guilds.store.guild(lastGuild(c)!.id)).toMatchObject({ notice_title: 'Raid', notice_text: 'Tiger Girl at 8', notice_at: t0 })
  })

  it('mastership: master only; to an offline member; ranks swap and the old master keeps every right', () => {
    const { h, a, b, c } = trio()
    expect(h.req(b, { t: 'guildMaster', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'no_permission' })
    expect(h.req(a, { t: 'guildMaster', member: 999 })).toMatchObject({ ok: false, reason: 'not_found' })
    h.leave(c)
    expect(h.req(a, { t: 'guildMaster', member: c.p.characterId })).toMatchObject({ ok: true })
    const st = lastGuild(b)!
    expect(st.master).toBe(c.p.characterId)
    expect(st.members.map((m) => [m.name, m.rank, m.perms.length])).toEqual([[a.p.name, 'member', 4], [b.p.name, 'member', 0], [c.p.name, 'master', 4]])
    expect(events(b)).toContain(`master:${c.p.name}`)
    // The old master may leave now.
    expect(h.req(a, { t: 'guildLeave' })).toMatchObject({ ok: true })
  })

  it('G10: mastership to a character deleted while the guild was loaded -> not_found (pruned)', () => {
    const { h, a, b, c } = trio()
    h.leave(c)
    h.g.store.softDeleteCharacter(c.p.characterId, h.g.store.characterById(c.p.characterId)!.account_id)
    expect(h.req(a, { t: 'guildMaster', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(of(b, 'guildMemberRemoved').at(-1)).toMatchObject({ characterId: c.p.characterId })
    expect(h.g.guilds.store.guildIdOf(c.p.characterId)).toBeUndefined()
  })

  it('bookkeeping while dead: leave, kick, rights, titles, notice, mastership and respond', () => {
    const { h, a, b } = trio()
    a.p.dead = true
    b.p.dead = true
    expect(h.req(a, { t: 'guildNotice', title: 'x', text: 'y' })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'guildTitle', member: b.p.characterId, title: 'z' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'guildLeave' })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'guildInvite', name: b.p.name })).toMatchObject({ ok: false, reason: 'dead' })
  })
})

describe('disband (G9) and chat (G7)', () => {
  it('disband at Leebaek: master only; every online member gets disbanded, null and a cleared nameplate; the name is free', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const v = h.enter()
    h.create(a)
    h.invite(a, b)
    expect(h.req(b, { t: 'guildDisband', npc: h.g.npc })).toMatchObject({ ok: false, reason: 'no_permission' })
    a.p.pos = [40, 0, 0]
    expect(h.req(a, { t: 'guildDisband', npc: h.g.npc })).toMatchObject({ ok: false, reason: 'too_far' })
    a.p.pos = [5, 0, 0]
    expect(h.req(v, { t: 'guildDisband', npc: h.g.npc })).toMatchObject({ ok: false, reason: 'not_in_guild' })
    expect(h.req(a, { t: 'guildDisband', npc: h.g.npc })).toMatchObject({ ok: true })
    for (const x of [a, b]) {
      expect(events(x).at(-1)).toBe('disbanded:Tigers')
      expect(lastGuild(x)).toBeNull()
      expect(nameplates(v, x.p.id).at(-1)).toBe('')
      expect(h.g.world.state(x.p).guild).toBeUndefined()
    }
    expect(h.g.guilds.store.penalties(a.p.characterId).guild_disbanded_at).not.toBeNull()
    h.create(b, 'TIGERS')
  })

  it('guild chat reaches the online members only; a non-member gets false', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const out = h.enter()
    h.create(a)
    h.invite(a, b)
    expect(h.g.guilds.chat(a.p, 'hello')).toBe(true)
    const line = { t: 'chat', channel: 'guild', fromId: a.p.id, from: a.p.name, text: 'hello' }
    expect(of(a, 'chat')).toEqual([line])
    expect(of(b, 'chat')).toEqual([line])
    expect(of(out, 'chat')).toEqual([])
    expect(wire(line)).toEqual(line)
    expect(h.g.guilds.chat(out.p, 'psst')).toBe(false)
  })
})

describe('lifecycle', () => {
  it('enter-world: guild comes after party (D35); the others see online; leaving sends offline with lastSeen', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    h.create(a)
    h.invite(a, b)
    // b forms a party with a, then relogs.
    h.req(a, { t: 'partyInvite', target: b.p.id })
    h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })
    const t0 = Date.now()
    h.leave(b)
    const off = of(a, 'guildMember').at(-1)!.member
    expect(off).toMatchObject({ characterId: b.p.characterId, online: false })
    expect(off.lastSeen).toBeGreaterThanOrEqual(t0)
    expect(events(a)).toContain(`offline:${b.p.name}`)
    const b2 = h.rejoin(b.p.characterId, [5, 0, 0], { sendEnter: true })
    const ts = b2.inbox.map((m) => m.t)
    expect(ts.slice(0, 2)).toEqual(['stats', 'inventory'])
    expect(ts.indexOf('party')).toBeGreaterThan(-1)
    expect(ts.indexOf('guild')).toBeGreaterThan(ts.indexOf('party'))
    expect(lastGuild(b2)!.members.find((m) => m.characterId === b.p.characterId)).toMatchObject({ online: true })
    expect(events(a)).toContain(`online:${b.p.name}`)
    expect(of(a, 'guildMember').at(-1)!.member).toMatchObject({ characterId: b.p.characterId, online: true })
    // The relogged entity carries the guild on its nameplate from the first state (worldEnter.self).
    expect(h.g.world.state(b2.p).guild).toBe('Tigers')
  })

  it('level changes of online members go out at most every 2 s', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    h.create(a)
    h.invite(a, b)
    const t0 = Date.now() + 10_000
    h.g.guilds.tick(t0)
    const before = of(a, 'guildMember').length
    b.p.level = 11
    h.g.guilds.tick(t0 + 1)
    expect(of(a, 'guildMember').length).toBe(before)
    h.g.guilds.tick(t0 + GUILD_LEVEL_SYNC_MS)
    expect(of(a, 'guildMember').at(-1)!.member).toMatchObject({ characterId: b.p.characterId, level: 11 })
    h.g.guilds.tick(t0 + 2 * GUILD_LEVEL_SYNC_MS)
    expect(of(a, 'guildMember').length).toBe(before + 1)
  })

  it('restart: the guild, members, rights, titles and notice persist; a stall or trade does not', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    h.create(a)
    h.invite(a, b)
    h.req(a, { t: 'guildPerms', member: b.p.characterId, perms: ['invite'] })
    h.req(a, { t: 'guildTitle', member: b.p.characterId, title: 'Scout' })
    h.req(a, { t: 'guildNotice', title: 'Raid', text: 'Tonight' })
    // Whatever the social lanes build, their state is runtime only.
    h.req(a, { t: 'stallCreate', title: 'Shop' })
    h.req(a, { t: 'tradeRequest', target: b.p.id })
    const aid = a.p.characterId
    const bid = b.p.characterId
    h.restart()
    const a2 = h.rejoin(aid, [5, 0, 0], { sendEnter: true })
    const st = lastGuild(a2)!
    expect(st).toMatchObject({ name: 'Tigers', master: aid, notice: { title: 'Raid', text: 'Tonight' } })
    expect(st.members.map((m) => [m.characterId, m.rank, m.perms, m.title, m.online])).toEqual([
      [aid, 'master', ['invite', 'kick', 'notice', 'title'], '', true],
      [bid, 'member', ['invite'], 'Scout', false],
    ])
    const state = h.g.world.state(a2.p)
    expect(state.guild).toBe('Tigers')
    expect(state.stall).toBeUndefined()
    const b2 = h.rejoin(bid, [6, 0, 0], { sendEnter: true })
    expect(h.g.world.state(b2.p).guild).toBe('Tigers')
    expect(h.req(a2, { t: 'stallClose' }).ok).toBe(false)
    expect(h.req(b2, { t: 'tradeCancel' }).ok).toBe(false)
    // And the guild still works.
    expect(h.g.guilds.chat(b2.p, 'back')).toBe(true)
    expect(of(a2, 'chat').at(-1)).toMatchObject({ channel: 'guild', text: 'back' })
  })

  it('deleted characters are pruned at start: a deleted master hands over to the earliest joiner', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    h.create(a)
    h.invite(a, b)
    h.invite(a, c)
    const [aid, bid] = [a.p.characterId, b.p.characterId]
    h.leave(a)
    h.leave(b)
    h.leave(c)
    h.g.store.softDeleteCharacter(aid, h.g.store.characterById(aid)!.account_id)
    h.restart()
    const b2 = h.rejoin(bid, [5, 0, 0], { sendEnter: true })
    expect(lastGuild(b2)).toMatchObject({ master: bid })
    expect(lastGuild(b2)!.members.map((m) => m.characterId)).not.toContain(aid)
    expect(h.g.logs.some((l) => l.includes('removed characters') && l.includes(String(aid)))).toBe(true)
  })
})

describe('GM guilds', () => {
  function gm(h: ReturnType<typeof harness>, ...args: string[]) {
    return runGuildsCommand({ ctx: { gameplay: h.g.gameplay, store: h.g.store } as unknown as GmCall['ctx'], conn: null as unknown as GmCall['conn'], role: 'gm', args, self: null })
  }

  it('list, info, rename, kick and disband', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    const v = h.enter()
    expect(gm(h, 'list')).toMatchObject({ ok: true, message: 'No guilds.' })
    h.create(a, 'Tigers')
    h.invite(a, b)
    h.invite(a, c)
    expect(gm(h, 'list').message).toContain('Tigers (id')
    const info = gm(h, 'info', 'tigers')
    expect(info.ok).toBe(true)
    expect(info.message).toContain(`${a.p.name} Lv 10 online [Master]`)
    expect(gm(h, 'info', 'Nope')).toMatchObject({ ok: false })
    expect(gm(h, 'rename', 'Tigers', '1bad')).toMatchObject({ ok: false })
    expect(gm(h, 'rename', 'Tigers', 'Lions')).toMatchObject({ ok: true, message: 'Renamed Tigers to Lions.' })
    expect(nameplates(v, b.p.id).at(-1)).toBe('Lions')
    expect(lastGuild(c)!.name).toBe('Lions')
    expect(h.g.world.state(a.p).guild).toBe('Lions')
    expect(gm(h, 'kick', 'Lions', c.p.name)).toMatchObject({ ok: true })
    expect(lastGuild(c)).toBeNull()
    expect(events(c).at(-1)).toBe(`kicked:${c.p.name}`)
    expect(gm(h, 'kick', 'Lions', a.p.name)).toMatchObject({ ok: true, message: expect.stringContaining(`${b.p.name} is the Guild Master now.`) })
    expect(lastGuild(b)!.master).toBe(b.p.characterId)
    expect(gm(h, 'disband', 'Lions')).toMatchObject({ ok: true })
    expect(lastGuild(b)).toBeNull()
    expect(nameplates(v, b.p.id).at(-1)).toBe('')
    // A GM disband starts no recreate clock.
    expect(h.g.guilds.store.penalties(b.p.characterId).guild_disbanded_at).toBeNull()
    expect(gm(h, 'bogus')).toMatchObject({ ok: false })
    expect(gm(h)).toMatchObject({ ok: false })
  })
})

describe('over the socket', () => {
  it('worldEnter.self carries the guild; guild chat reaches members only; a GM `/guilds info` line reaches the GM path', async () => {
    const s = await startTestServer({
      config: { rng: seeded(5), spawnMobs: false },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [10, 0, -10] }),
        ...contentFiles({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS }),
      },
    })
    try {
      let seq = 0
      const make = async () => {
        const acc = await newAccount(s.url, 'gld')
        const c = await Client.login(s.url, acc.token)
        c.send({ t: 'charCreate', name: `Gd${Date.now() % 1e5}${++seq}`.slice(0, 12), model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
        const ch = (await c.next('charCreated')).character
        return { c, acc, ch }
      }
      const a = await make()
      const b = await make()
      const x = await make()
      const store = s.ctx.gameplay.guilds.store
      const gid = store.create('Wolves', a.ch.id, Date.now())
      store.join(gid, b.ch.id, Date.now())
      const enter = async (m: { c: Client; ch: { id: number } }) => {
        m.c.send({ t: 'enterWorld', id: m.ch.id })
        return (await m.c.next('worldEnter')).self
      }
      expect((await enter(a)).guild).toBe('Wolves')
      expect((await a.c.next('guild')).guild).toMatchObject({ name: 'Wolves' })
      expect((await enter(b)).guild).toBe('Wolves')
      expect((await enter(x)).guild).toBeUndefined()
      await b.c.next('guild')
      await a.c.next('guildEvent', (e) => e.event === 'online')
      a.c.send({ t: 'chat', text: 'howl', channel: 'guild' })
      expect(await b.c.next('chat', (m) => m.channel === 'guild')).toMatchObject({ from: a.ch.name, text: 'howl' })
      expect(await a.c.next('chat', (m) => m.channel === 'guild')).toMatchObject({ text: 'howl' })
      await x.c.none('chat')
      x.c.send({ t: 'chat', text: 'hi', channel: 'guild' })
      expect(await x.c.next('error')).toMatchObject({ code: 'bad_request', message: 'You are not in a guild.' })
      // A staff line /guilds reaches the GM command (the client's /guild prefix never reaches the server).
      s.ctx.store.setRole(s.ctx.store.accountByName(a.acc.username)!.id, 'gm')
      s.ctx.refreshRoles(true)
      a.c.send({ t: 'chat', text: '/guilds info wolves' })
      const r = await a.c.next('gmResult')
      expect(r).toMatchObject({ ok: true, cmd: 'guilds' })
      expect(r.message).toContain('Wolves (id')
    } finally {
      await s.stopAndClean()
    }
  })
})
