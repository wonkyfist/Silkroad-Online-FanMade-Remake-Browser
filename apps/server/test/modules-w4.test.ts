/**
 * Wave-4 server seams (docs/WAVE_PLAN.md §5.1 W4-FS, decisions 40-44 and 48): routing of every wave-4 request to the
 * quests and party modules (exactly one answer each, the dead allowlist), migration v6 -> v7 on a copy, the
 * reward() split (computeReward + applyProgress), the mobDied credit seam (solo rule and a party's killShares), the
 * NPC 'quest' service wiring, createMob tuning, the decorators for `npc` and `ownerParty`, the GM spawn counter, the
 * wave-4 config and the CORS methods.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { GAMEPLAY_REQUESTS, parseClientMessage, parseServerMessage, type ClientMessage, type GameplayRequest, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connection } from '../src/connection.ts'
import type { WorldSetup } from '../src/content.ts'
import { SCHEMA_VERSION, migrate, openStore } from '../src/db.ts'
import { editorAllowed } from '../src/editors/overrides.ts'
import type { GameContext } from '../src/game.ts'
import { Gameplay, killExp, shareRewards, soloShares, type KillShares } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { COMMANDS, GM_SPAWN_TOTAL_MAX } from '../src/gm.ts'
import type { GameplayModule } from '../src/modules.ts'
import { FlatNav } from '../src/nav.ts'
import { World, type Npc, type Player } from '../src/world.ts'
import { startTestServer, testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sro-modules-w4-'))
  const logs: string[] = []
  const config = { ...testConfig(root, logs), rng: seeded(7) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(7) })
  let n = 0
  const enter = (pos: Vec3) => {
    const acc = store.createAccount(`w4acc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Quester${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    return { p, inbox }
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, data, setup, config, logs, enter }
}

const WAVE4_FRAMES: ClientMessage[] = [
  { t: 'questAccept', npc: 1, quest: 'JG_001' },
  { t: 'questTurnIn', npc: 1, quest: 'JG_001' },
  { t: 'questAbandon', quest: 'JG_001' },
  { t: 'questTalk', npc: 1, quest: 'JG_001', objective: 'talk' },
  { t: 'questUseItem', quest: 'JG_001', objective: 'bell' },
  { t: 'partyInvite', target: 2 },
  { t: 'partyRespond', inviter: 2, accept: true },
  { t: 'partyLeave' },
  { t: 'partyKick', member: 3 },
  { t: 'partyLeader', member: 3 },
  { t: 'partySettings', exp: 'share' },
]
const QUEST_REQUESTS: GameplayRequest[] = ['questAccept', 'questTurnIn', 'questAbandon', 'questTalk', 'questUseItem']
const PARTY_REQUESTS: GameplayRequest[] = ['partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings']

/** A server message after a trip through the client's parser (null when the client would reject it). */
function wire(m: unknown): ServerMessage | null {
  const r = parseServerMessage(JSON.stringify(m))
  return r.ok ? r.msg : null
}

function results(inbox: ServerMessage[]): Msg<'actionResult'>[] {
  return inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
}

describe('wave-4 routing', () => {
  it('the quest and party modules own exactly the eleven wave-4 requests, registered after the wave-3 modules', () => {
    const h = harness()
    expect([...QUEST_REQUESTS, ...PARTY_REQUESTS].sort()).toEqual(WAVE4_FRAMES.map((f) => f.t).sort())
    for (const t of WAVE4_FRAMES.map((f) => f.t as GameplayRequest)) expect(GAMEPLAY_REQUESTS).toContain(t)
    for (const t of QUEST_REQUESTS) expect(h.gameplay.routes.get(t), t).toBe(h.gameplay.quests)
    for (const t of PARTY_REQUESTS) expect(h.gameplay.routes.get(t), t).toBe(h.gameplay.party)
    expect(h.gameplay.modules.slice(5, 7)).toEqual([h.gameplay.quests, h.gameplay.party]) // wave 7B posture (and wave 8) come after
    expect(h.gameplay.quests.name).toBe('quests')
    expect(h.gameplay.party.name).toBe('party')
  })

  it('every wave-4 frame passes the client validator and gets exactly one actionResult (stubs: not_implemented)', () => {
    const h = harness()
    const { p, inbox } = h.enter([0, 0, 0])
    for (const f of WAVE4_FRAMES) expect(parseClientMessage(JSON.stringify(f)), f.t).toEqual({ ok: true, msg: f })
    for (const f of WAVE4_FRAMES) h.gameplay.request(p, f as Extract<ClientMessage, { t: GameplayRequest }>, Date.now())
    const res = results(inbox)
    expect(res.map((r) => r.re)).toEqual(WAVE4_FRAMES.map((f) => f.t))
    // A fresh solo player with nothing pending: every wave-4 frame is refused (the lanes' own tests cover the reasons).
    for (const r of res) expect(r, r.re).toMatchObject({ ok: false })
    for (const r of res) expect(wire(r)).toMatchObject({ t: 'actionResult', re: r.re })
  })

  it('a dead player gets past the dead check for questAbandon and the party bookkeeping, not for accept/invite', () => {
    const h = harness()
    const { p, inbox } = h.enter([0, 0, 0])
    h.gameplay.gmKill(p)
    expect(p.dead).toBe(true)
    for (const f of WAVE4_FRAMES) h.gameplay.request(p, f as Extract<ClientMessage, { t: GameplayRequest }>, Date.now())
    const byRe = new Map(results(inbox).map((r) => [r.re, r]))
    expect(byRe.size).toBe(WAVE4_FRAMES.length)
    const allowed = ['questAbandon', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings']
    expect([...(h.gameplay.quests.whileDead ?? []), ...(h.gameplay.party.whileDead ?? [])].sort()).toEqual([...allowed].sort())
    for (const [re, r] of byRe) {
      expect(r, re).toMatchObject({ ok: false })
      if (allowed.includes(re)) expect(r.reason, re).not.toBe('dead')
      else expect(r.reason, re).toBe('dead')
    }
  })

  it('enter-world order: stats, inventory, skills, quests (party only when in one)', () => {
    const h = harness()
    const { p, inbox } = h.enter([0, 0, 0])
    h.gameplay.sendEnter(p)
    expect(inbox.map((m) => m.t)).toEqual(['stats', 'inventory', 'skills', 'quests'])
  })
})

describe('migration v7 (quests)', () => {
  it('upgrades a copy of a v6 database to v7, keeping its data; the quest tables enforce QUESTS §1.4', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-migrate-v7-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const v6Dir = join(root, 'v6')
    const copyDir = join(root, 'copy')
    mkdirSync(v6Dir)
    mkdirSync(copyDir)
    const v6 = new Database(join(v6Dir, 'game.db'))
    expect(migrate(v6, 6)).toBe(6)
    v6.exec(`INSERT INTO accounts (id, username, password_hash, created_at, role, storage_gold) VALUES (1, 'veteran', 'x', 1, 'gm', 500);
      INSERT INTO characters (id, account_id, name, model, weapon, level, world, created_at, gold) VALUES (1, 1, 'Ryu', 'CHAR_CH_MAN_ADVENTURER', 'spear', 7, 'jangan', 1, 1234);
      INSERT INTO items (character_id, bag_slot, code, count) VALUES (1, 0, 'ITEM_ETC_HP_POTION_01', 7);
      INSERT INTO char_skills VALUES (1, 'SKILL_CH_SPEAR_SMASH_A', 2);
      INSERT INTO storage_items (account_id, slot, code, count) VALUES (1, 3, 'ITEM_ETC_HP_POTION_01', 2);`)
    expect(() => v6.prepare('SELECT * FROM quest_state').all()).toThrow()
    v6.close()
    copyFileSync(join(v6Dir, 'game.db'), join(copyDir, 'game.db'))

    const store = openStore(copyDir)
    try {
      expect(SCHEMA_VERSION).toBe(14)
      expect(store.schemaVersion).toBe(14)
      expect(store.db.pragma('user_version', { simple: true })).toBe(14)
      // old data intact
      expect(store.characterById(1)).toMatchObject({ name: 'Ryu', level: 7, gold: 1234 })
      expect(store.loadInventory(1).bag[0]).toMatchObject({ code: 'ITEM_ETC_HP_POTION_01', count: 7 })
      expect(store.accountRole(1)).toBe('gm')
      expect(store.db.prepare('SELECT grp, level FROM char_skills').get()).toEqual({ grp: 'SKILL_CH_SPEAR_SMASH_A', level: 2 })
      expect(store.db.prepare('SELECT storage_gold FROM accounts WHERE id = 1').get()).toEqual({ storage_gold: 500 })
      expect(store.db.prepare('SELECT slot, count FROM storage_items').get()).toEqual({ slot: 3, count: 2 })
      // v7 tables, columns and defaults
      const cols = (t: string) => (store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
      expect(cols('quest_state')).toEqual(['character_id', 'quest', 'status', 'rev', 'counts', 'accepted_at'])
      expect(cols('quest_done')).toEqual(['character_id', 'quest', 'times', 'last_at'])
      expect(cols('quest_items')).toEqual(['character_id', 'quest', 'code', 'count'])
      store.db.prepare("INSERT INTO quest_state (character_id, quest, status, accepted_at) VALUES (1, 'JG_001', 'active', 5)").run()
      expect(store.db.prepare('SELECT status, rev, counts, accepted_at FROM quest_state').get()).toEqual({ status: 'active', rev: 0, counts: '{}', accepted_at: 5 })
      store.db.prepare("INSERT INTO quest_done (character_id, quest, last_at) VALUES (1, 'JG_000', 9)").run()
      expect(store.db.prepare('SELECT times, last_at FROM quest_done').get()).toEqual({ times: 1, last_at: 9 })
      store.db.prepare("INSERT INTO quest_items VALUES (1, 'JG_001', 'QITEM_HIDE', 3)").run()
      // constraints: status, times >= 1, count >= 1, primary keys, foreign keys
      expect(() => store.db.prepare("INSERT INTO quest_state (character_id, quest, status, accepted_at) VALUES (1, 'JG_002', 'done', 1)").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare("INSERT INTO quest_state (character_id, quest, status, accepted_at) VALUES (1, 'JG_001', 'ready', 1)").run()).toThrow(/UNIQUE|PRIMARY/)
      expect(() => store.db.prepare("INSERT INTO quest_state (character_id, quest, status, accepted_at) VALUES (99, 'JG_001', 'active', 1)").run()).toThrow(/FOREIGN KEY/)
      expect(() => store.db.prepare("INSERT INTO quest_done (character_id, quest, times, last_at) VALUES (1, 'JG_003', 0, 1)").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare("INSERT INTO quest_items VALUES (1, 'JG_001', 'QITEM_BONE', 0)").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare("INSERT INTO quest_items VALUES (1, 'JG_001', 'QITEM_HIDE', 1)").run()).toThrow(/UNIQUE|PRIMARY/)
      expect(() => store.db.prepare("INSERT INTO quest_state (character_id, quest, status) VALUES (1, 'JG_004', 'active')").run()).toThrow(/NOT NULL/)
    } finally {
      store.close()
    }
    const orig = new Database(join(v6Dir, 'game.db'), { readonly: true })
    expect(orig.pragma('user_version', { simple: true })).toBe(6)
    orig.close()
  })
})

describe('reward() = computeReward + save + applyProgress (decision 42)', () => {
  function run(split: boolean, exp: number, spExp: number) {
    const h = harness()
    // The player's own inbox also gets its levelUp/entityUpdate broadcasts (broadcastAbout includes the subject).
    const { p, inbox } = h.enter([0, 0, 0])
    if (split) {
      const before = { ...p.progress }
      const { next, levels } = h.gameplay.computeReward(p, exp, spExp)
      // compute changes nothing: no save, no message, the player's progress untouched
      expect(p.progress).toEqual(before)
      expect(h.store.characterById(p.characterId)!.exp).toBe(before.exp)
      expect(inbox).toHaveLength(0)
      h.store.saveProgress(p.characterId, next)
      h.gameplay.applyProgress(p, next, levels, { exp: Math.round(exp), spExp: Math.round(spExp), from: 77 })
    } else h.gameplay.reward(p, exp, spExp, 77)
    const row = h.store.characterById(p.characterId)!
    return { progress: { ...p.progress }, hp: p.hp, maxHp: p.maxHp, level: p.level, inbox, row: { level: row.level, exp: row.exp, sp: row.sp, sp_exp: row.sp_exp } }
  }

  it('without a level-up: the same progress, save and statsDelta', () => {
    const a = run(false, 10, 250)
    const b = run(true, 10, 250)
    expect(b.progress).toEqual(a.progress)
    expect(b.row).toEqual(a.row)
    expect(b.inbox).toEqual(a.inbox)
    expect(a.inbox).toEqual([{ t: 'statsDelta', stats: { exp: 10, sp: a.progress.sp, spExp: a.progress.spExp }, gain: { exp: 10, spExp: 250, from: 77 } }])
  })

  it('with level-ups: the same refill, statsDelta, levelUp, entityUpdate and stats', () => {
    const a = run(false, 335, 40)
    const b = run(true, 335, 40)
    expect(a.level).toBeGreaterThan(2)
    expect(a.row.level).toBe(a.level)
    expect(b.progress).toEqual(a.progress)
    expect(b.row).toEqual(a.row)
    expect([b.hp, b.maxHp, b.level]).toEqual([a.hp, a.maxHp, a.level])
    expect(a.hp).toBe(a.maxHp)
    expect(a.inbox.map((m) => m.t)).toEqual(['statsDelta', 'levelUp', 'entityUpdate', 'stats'])
    expect(b.inbox).toEqual(a.inbox)
  })

  it('applyProgress carries gain.quest for quest EXP', () => {
    const h = harness()
    const { p, inbox } = h.enter([0, 0, 0])
    const { next, levels } = h.gameplay.computeReward(p, 5, 0)
    h.gameplay.applyProgress(p, next, levels, { exp: 5, spExp: 0, quest: 'JG_001' })
    expect(inbox.at(-1)).toMatchObject({ t: 'statsDelta', gain: { exp: 5, spExp: 0, quest: 'JG_001' } })
    expect(wire(inbox.at(-1))).toMatchObject({ gain: { quest: 'JG_001' } })
  })
})

describe('mobDied credit seam (decisions 40, 41)', () => {
  function spy(h: ReturnType<typeof harness>) {
    const calls: { mob: number; credit: number[] }[] = []
    const m: GameplayModule = { name: 'spy', mobDied: (mob, _now, credit) => calls.push({ mob: mob.id, credit: [...credit].sort((a, b) => a - b) }) }
    ;(h.gameplay.modules as GameplayModule[]).push(m)
    return calls
  }

  it('solo: EXP to every damage dealer still here (dead ones too, as before); credit only to the alive ones', () => {
    const h = harness()
    const calls = spy(h)
    const a = h.enter([0, 0, 0])
    const b = h.enter([1, 0, 0])
    const now = Date.now()
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, now)
    m.damage.set(a.p.id, 15)
    m.damage.set(b.p.id, 5)
    m.damage.set(999_999, 50) // gone from the world: no share, no credit
    h.gameplay.gmKill(b.p)
    h.gameplay.mobDied(m, now, true)
    const gainOf = (inbox: ServerMessage[]) => inbox.filter((x): x is Msg<'statsDelta'> => x.t === 'statsDelta' && x.gain !== undefined).map((x) => x.gain)
    expect(gainOf(a.inbox)).toEqual([{ exp: 30, spExp: 23, from: m.id }])
    expect(gainOf(b.inbox)).toEqual([{ exp: 10, spExp: 8, from: m.id }])
    expect(calls).toEqual([{ mob: m.id, credit: [a.p.id] }])
    // GM kill: no rewards, no hook
    const m2 = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, now)
    m2.damage.set(a.p.id, 5)
    h.gameplay.gmKill(m2, now)
    expect(calls).toHaveLength(1)
  })

  it('soloShares matches shareRewards and owns loot by top damage; killExp applies the variant and tuning', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    const b = h.enter([1, 0, 0])
    const now = Date.now()
    const m = h.gameplay.createMob(MANGNYANG, 'champion', 1, 0, 0, null, now, null, { expMul: 0.5 })
    m.damage.set(a.p.id, 3)
    m.damage.set(b.p.id, 9)
    const k = soloShares(m, (id) => h.world.players.get(id))
    const e = killExp(m)
    expect(k.shares).toEqual(shareRewards(m.damage, (id) => h.world.players.has(id), e.exp, e.spExp))
    expect([...k.credit].sort()).toEqual([a.p.id, b.p.id].sort())
    expect(k.lootOwners.next()).toEqual({ player: b.p, party: null })
    expect(k.lootOwners.next()).toEqual({ player: b.p, party: null })
    const plain = h.gameplay.createMob(MANGNYANG, 'champion', 1, 0, 0, null, now)
    expect(killExp(m).exp).toBeCloseTo(killExp(plain).exp * 0.5)
    expect(killExp(m).spExp).toBeCloseTo(killExp(plain).spExp * 0.5)
  })

  it("a party's killShares replaces the solo rule: its shares, its credit fan-out, its loot owners and ownerParty", () => {
    const h = harness()
    const calls = spy(h)
    const a = h.enter([0, 0, 0])
    const b = h.enter([2, 0, 0])
    const now = Date.now()
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, now)
    m.damage.set(a.p.id, 20)
    const owners = [b.p, a.p]
    let i = 0
    const party: KillShares = {
      shares: new Map([
        [a.p.id, { exp: 7, spExp: 3 }],
        [b.p.id, { exp: 9, spExp: 4 }],
      ]),
      credit: new Set([a.p.id, b.p.id]),
      lootOwners: { next: () => ({ player: owners[i++ % owners.length], party: 42 }) },
    }
    h.gameplay.party.killShares = (mob) => (mob === m ? party : null)
    h.gameplay.mobDied(m, now, true)
    expect(a.inbox.filter((x) => x.t === 'statsDelta').at(-1)).toMatchObject({ gain: { exp: 7, spExp: 3, from: m.id } })
    expect(b.inbox.filter((x) => x.t === 'statsDelta').at(-1)).toMatchObject({ gain: { exp: 9, spExp: 4, from: m.id } })
    expect(calls).toEqual([{ mob: m.id, credit: [a.p.id, b.p.id].sort((x, y) => x - y) }])
    const drops = [...h.world.items.values()]
    expect(drops.length).toBe(2) // DROPS: gold + one blade
    expect(drops.map((d) => d.owner)).toEqual([b.p.id, a.p.id])
    for (const d of drops) {
      expect(d.ownerParty).toBe(42)
      const s = h.world.state(d)
      expect(s.ownerParty).toBe(42)
      expect(wire({ t: 'spawn', entity: s })).toMatchObject({ entity: { ownerParty: 42 } })
    }
  })

  it('drops without a party carry no ownerParty', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    const now = Date.now()
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, now)
    m.damage.set(a.p.id, 20)
    h.gameplay.mobDied(m, now, true)
    const drops = [...h.world.items.values()]
    expect(drops.length).toBe(2)
    for (const d of drops) {
      expect(d.owner).toBe(a.p.id)
      expect(d.ownerParty).toBeUndefined()
      expect('ownerParty' in h.world.state(d)).toBe(false)
    }
  })
})

describe('other seams', () => {
  it("npcDialog offers 'quest' when the quest engine reports a topic (NpcDialogs.topics -> quests.hasTopics)", () => {
    const h = harness()
    h.gameplay.start()
    const npc = [...h.world.npcs.values()].find((n) => n.code === 'NPC_CH_POTION')!
    const { p, inbox } = h.enter([npc.pos[0] + 1, 0, npc.pos[2]])
    p.known.add(npc.id)
    const dialog = () => inbox.filter((m): m is Msg<'npcDialog'> => m.t === 'npcDialog').at(-1)
    h.gameplay.request(p, { t: 'npcTalk', npc: npc.id })
    expect(dialog()).toMatchObject({ code: 'NPC_CH_POTION', services: ['shop'] })
    const asked: string[] = []
    h.gameplay.quests.hasTopics = (who: Player, code: string) => {
      asked.push(`${who.id}:${code}`)
      return true
    }
    h.gameplay.request(p, { t: 'npcTalk', npc: npc.id })
    expect(dialog()).toMatchObject({ code: 'NPC_CH_POTION', services: ['shop', 'quest'] })
    expect(asked).toContain(`${p.id}:NPC_CH_POTION`)
  })

  it('createMob tuning scales HP and attack and is kept on the mob; without it nothing changes', () => {
    const h = harness()
    const now = Date.now()
    const plain = h.gameplay.createMob(MANGNYANG, 'normal', 0, 0, 0, null, now)
    const tuned = h.gameplay.createMob(MANGNYANG, 'normal', 0, 0, 0, null, now, null, { hpMul: 3, attackMul: 0.5, expMul: 0.1 })
    expect(plain.tuning).toBeUndefined()
    expect(tuned.maxHp).toBe(plain.maxHp * 3)
    expect(tuned.hp).toBe(tuned.maxHp)
    expect(tuned.combat.physAttack).toEqual(plain.combat.physAttack.map((v) => Math.round(v * 0.5)))
    expect(tuned.combat.physDefence).toBe(plain.combat.physDefence)
    expect(tuned.tuning).toEqual({ hpMul: 3, attackMul: 0.5, expMul: 0.1 })
    // I8 (MS-S's find): a restat (a buff or debuff ending) keeps the encounter's attack multiplier.
    const before = tuned.combat.physAttack
    ;(h.gameplay.skills as unknown as { restatMob(m: typeof tuned, now: number): void }).restatMob(tuned, now)
    expect(tuned.combat.physAttack).toEqual(before)
  })

  it('World decorators: an NPC wearing another model sends model + npc; a plain NPC is unchanged', () => {
    const h = harness()
    const plain: Npc = { kind: 'npc', id: h.world.newId(), code: 'NPC_CH_SMITH', name: 'Smith', pos: [0, 0, 0], yaw: 0 }
    const same: Npc = { kind: 'npc', id: h.world.newId(), code: 'NPC_CH_SMITH', model: 'NPC_CH_SMITH', name: 'Smith', pos: [0, 0, 0], yaw: 0 }
    const authored: Npc = { kind: 'npc', id: h.world.newId(), code: 'NPCX_OLD_SMITH', model: 'NPC_CH_SMITH', name: 'Old Smith Bo', pos: [0, 0, 0], yaw: 0 }
    expect(h.world.state(plain)).toMatchObject({ model: 'NPC_CH_SMITH' })
    expect('npc' in h.world.state(plain)).toBe(false)
    expect('npc' in h.world.state(same)).toBe(false)
    const s = h.world.state(authored)
    expect(s).toMatchObject({ kind: 'npc', model: 'NPC_CH_SMITH', npc: 'NPCX_OLD_SMITH', name: 'Old Smith Bo' })
    expect(wire({ t: 'spawn', entity: s })).toMatchObject({ entity: { npc: 'NPCX_OLD_SMITH', model: 'NPC_CH_SMITH' } })
  })

  it('GM spawn: encounter mobs do not count against GM_SPAWN_TOTAL_MAX', () => {
    const h = harness()
    const gm = h.enter([0, 0, 0])
    const now = Date.now()
    for (let i = 0; i < GM_SPAWN_TOTAL_MAX; i++) {
      const m = h.gameplay.createMob(MANGNYANG, 'normal', 3, 0, 3, null, now)
      m.encounter = { quest: 'JG_034', owners: new Set([gm.p.characterId]), despawnAt: now + 600_000 }
    }
    const conn = { player: gm.p, role: 'gm', account: 'gm', send: () => {} } as unknown as Connection
    const ctx = { world: h.world, gameplay: h.gameplay, setup: h.setup, config: h.config, data: h.data, sockets: new Map([[1, conn]]) } as unknown as GameContext
    expect(COMMANDS.spawn.run({ ctx, conn, role: 'gm', args: ['MOB_CH_MANGNYANG', '2'], self: gm.p })).toMatchObject({ ok: true })
    // plain GM-spawned mobs still count
    for (const m of h.world.mobs.values()) delete m.encounter
    expect(COMMANDS.spawn.run({ ctx, conn, role: 'gm', args: ['MOB_CH_MANGNYANG', '1'], self: gm.p })).toMatchObject({ ok: false })
  })

  it('wave-4 config: defaults, bounds and EDITOR_ROLE (gm or admin only)', async () => {
    const { loadConfig, REPO_ROOT } = await import('../src/config.ts')
    const d = loadConfig({ WORLD_EXPORT: 'jangan' })
    expect(d).toMatchObject({ contentDir: join(REPO_ROOT, 'content'), questDailyResetHour: 4, questCapExpToSpExp: true, editorRole: 'gm' })
    expect(loadConfig({ WORLD_EXPORT: 'jangan', CONTENT_DIR: join(REPO_ROOT, 'x'), QUEST_DAILY_RESET_HOUR: '0', QUEST_CAP_EXP_TO_SPEXP: '0', EDITOR_ROLE: 'Admin' })).toMatchObject({
      contentDir: join(REPO_ROOT, 'x'),
      questDailyResetHour: 0,
      questCapExpToSpExp: false,
      editorRole: 'admin',
    })
    expect(() => loadConfig({ QUEST_DAILY_RESET_HOUR: '24' })).toThrow(/QUEST_DAILY_RESET_HOUR/)
    expect(() => loadConfig({ EDITOR_ROLE: 'player' })).toThrow(/EDITOR_ROLE/)
    expect(() => loadConfig({ EDITOR_ROLE: 'owner' })).toThrow(/EDITOR_ROLE/)
    expect([editorAllowed('player'), editorAllowed('gm'), editorAllowed('admin')]).toEqual([false, true, true])
    expect([editorAllowed('player', 'admin'), editorAllowed('gm', 'admin'), editorAllowed('admin', 'admin')]).toEqual([false, false, true])
  })

  it('CORS preflights allow PUT and DELETE (the GM quest editor)', async () => {
    const s = await startTestServer({ config: { corsOrigin: 'http://editor.test:5180' } })
    cleanups.push(() => s.stopAndClean())
    const res = await fetch(`${s.url}/api/gm/quests/JG_001`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS')
    // ED-S routes /api/gm/*: without a bearer token the editor answers 401 (editors-e2e.test.ts covers the rest)
    expect((await fetch(`${s.url}/api/gm/quests`)).status).toBe(401)
  })
})
