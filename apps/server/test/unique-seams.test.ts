/**
 * Wave 11 server seams for the uniques module (docs/WAVE_PLAN7.md §4.2, docs/UNIQUES.md §8.1 U-SEAM-S; lane W11-SV):
 * the Spawner's unique-group refusal (UNIQUES on/off; `updateNest` honours it), the UNIQUES config, migration 10,
 * `Mob.damageMul` through mobSkills.swing and the basic attack, `Mob.corpseMs`, the loot-owner group handed to the
 * modules before `m.damage.clear()`, the loot override with a `plus`, the per-mob summon policy, and the no-op stub.
 */
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentEntries, type ClientMessage, type GameplayRequest, type MobDef, type NestDef, type SkillDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT, loadConfig, type ServerConfig } from '../src/config.ts'
import { SCHEMA_VERSION, migrate, openStore } from '../src/db.ts'
import { CORPSE_MS } from '../src/formulas.ts'
import { GameData } from '../src/gamedata.ts'
import type { KillOwner } from '../src/modules.ts'
import { SkillBook } from '../src/skills/book.ts'
import { Spawner, UNIQUE_GROUP_REFUSAL } from '../src/spawner.ts'
import { Uniques } from '../src/uniques.ts'
import type { Mob, Player } from '../src/world.ts'
import { mob, seeded } from './fixtures.ts'
import { DUMMY, MASTERIES, SAFE_TOWN, SKILLS, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

// ---- the Spawner on the real nests (work/out/data) -------------------------------------------------------------------

const DATA = join(REPO_ROOT, 'work/out/data')
const HAVE = existsSync(join(DATA, 'nests.json')) && existsSync(join(DATA, 'mobs.json'))
const read = <T,>(f: string): T[] => contentEntries<T>(JSON.parse(readFileSync(join(DATA, f), 'utf8')))
const TIGER_NESTS = [5656, 5657, 5658, 5659, 5903, 5904, 5905, 5906, 5907, 5908, 5909]

describe.skipIf(!HAVE)('the Spawner and the unique groups (real nests)', () => {
  const nests = HAVE ? read<NestDef>('nests.json') : []
  const mobs = new Map(HAVE ? read<MobDef>('mobs.json').map((m) => [m.code, m]) : [])
  /** Fill, then six deaths of the group's mob, each followed by a tick past its respawn: where it spawned and when. */
  const run = (skipUniqueGroups?: boolean) => {
    const sp = new Spawner(nests, (c) => mobs.get(c), { world: 'jangan', mobLevelMax: 25, rng: seeded(7), ...(skipUniqueGroups === undefined ? {} : { skipUniqueGroups }) })
    let id = 0
    const where: number[] = []
    const spawn = (n: { def: NestDef }) => {
      if (n.def.uniqueGroup) where.push(n.def.id)
      return ++id
    }
    const total = sp.fill(spawn)
    const dues: number[] = []
    let t = 0
    for (let i = 0; i < 6; i++) {
      const n = sp.nests.find((x) => x.def.uniqueGroup && x.alive.size > 0)
      if (!n) break
      dues.push(Math.round(sp.died([...n.alive][0], t)! - t))
      t += 30_000_000
      sp.tick(t, spawn)
    }
    return { sp, total, where, dues }
  }

  it('UNIQUES=off (or the option absent) spawns her group exactly as HEAD did (a snapshot of wave 10)', () => {
    // Captured on HEAD 96b1149 with the same script, before the seam existed.
    const head = { total: 6944, cap: 6944, nests: 791, skipped: 34, where: [5656, 5907, 5658, 5659, 5659, 5658, 5658], dues: [12484242, 16398747, 14773953, 16575187, 21361818, 20280020] }
    for (const opt of [undefined, false]) {
      const r = run(opt)
      expect({ total: r.total, cap: r.sp.capacity, nests: r.sp.nests.length, skipped: r.sp.skipped.length, where: r.where, dues: r.dues }).toEqual(head)
      expect(r.sp.nests.filter((n) => n.def.uniqueGroup).map((n) => n.def.id)).toEqual(TIGER_NESTS)
    }
  })

  it('UNIQUES=on refuses the 11 nests (in refusal, so updateNest refuses them too); every other nest is unchanged', () => {
    const off = run(false)
    const on = run(true)
    expect(on.where).toEqual([])
    expect(on.sp.nests.some((n) => n.def.uniqueGroup)).toBe(false)
    expect(on.sp.skipped.filter((s) => s.reason === UNIQUE_GROUP_REFUSAL).map((s) => s.nest).sort()).toEqual(TIGER_NESTS)
    expect(on.sp.nests.length).toBe(off.sp.nests.length - 11)
    expect(on.total).toBe(off.total - 1)
    expect(on.sp.capacity).toBe(off.sp.capacity - 1)
    // A GM /nest edit or `content reload nests` (updateNest) never re-attaches one.
    const def = nests.find((n) => n.id === 5906)!
    expect(on.sp.refusal(def)).toBe(UNIQUE_GROUP_REFUSAL)
    expect(on.sp.updateNest(5906, { ...def, count: 1 })).toEqual({ nest: null, despawn: [], reason: UNIQUE_GROUP_REFUSAL })
    expect(on.sp.updateNest(5906, { ...def, x: def.x + 5 })).toMatchObject({ nest: null, reason: UNIQUE_GROUP_REFUSAL })
    expect(on.sp.nest(5906)).toBeUndefined()
    expect(on.sp.skipped.filter((s) => s.nest === 5906)).toEqual([{ nest: 5906, reason: UNIQUE_GROUP_REFUSAL }])
    // A plain nest is still editable.
    const plain = on.sp.nests.find((n) => !n.def.uniqueGroup)!
    expect(on.sp.updateNest(plain.def.id, { ...plain.def, count: plain.def.count + 1 }).nest).not.toBeNull()
  })
})

// ---- config and wiring -------------------------------------------------------------------------------------------------

describe('UNIQUES and the module slot', () => {
  it('UNIQUES: on by default; on/off/1/0; anything else fails the start', () => {
    expect(loadConfig({}).uniques).toBe(true)
    expect(loadConfig({ UNIQUES: 'off' }).uniques).toBe(false)
    expect(loadConfig({ UNIQUES: 'OFF' }).uniques).toBe(false)
    expect(loadConfig({ UNIQUES: '0' }).uniques).toBe(false)
    expect(loadConfig({ UNIQUES: 'on' }).uniques).toBe(true)
    expect(() => loadConfig({ UNIQUES: 'maybe' })).toThrow(/UNIQUES must be on or off/)
  })

  it('on (and absent): the uniques module is registered last and the Spawner skips unique groups; off: null and today', () => {
    const on = skillHarness()
    cleanups.push(on.cleanup)
    expect(on.gameplay.uniques).toBeInstanceOf(Uniques)
    expect(on.gameplay.modules.at(-1)).toBe(on.gameplay.uniques)
    expect(on.gameplay.spawner.opts.skipUniqueGroups).toBe(true)
    // The stub is a no-op: nothing to start, normal loot, no summon policy.
    expect(on.gameplay.uniques!.start(on.now)).toBeNull()
    const d = on.dummy(0, 0)
    expect(on.gameplay.uniques!.drops(d, on.now)).toBeNull()
    expect(on.gameplay.uniques!.summonPolicy(d)).toBeNull()
    expect(on.gameplay.mobSkills.summonPolicy(d)).toBeNull()
    const off = skillHarness({ config: { uniques: false } })
    cleanups.push(off.cleanup)
    expect(off.gameplay.uniques).toBeNull()
    expect(off.gameplay.modules.map((m) => m.name)).not.toContain('uniques')
    expect(off.gameplay.spawner.opts.skipUniqueGroups).toBe(false)
    expect(off.gameplay.mobSkills.summonPolicy(d)).toBeNull()
  })
})

// ---- migration 10 ------------------------------------------------------------------------------------------------------

const cols = (db: Database.Database, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[])

describe('migration 10 (the uniques table)', () => {
  it('applies on a 9-version database and keeps its data', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-migrate-w11-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const v9 = new Database(join(root, 'game.db'))
    expect(migrate(v9, 9)).toBe(9)
    v9.exec(`INSERT INTO accounts (id, username, password_hash, created_at, role) VALUES (1, 'veteran', 'x', 1, 'gm');
      INSERT INTO characters (id, account_id, name, model, weapon, level, world, created_at, gold) VALUES (1, 1, 'Ryu', 'CHAR_CH_MAN_ADVENTURER', 'spear', 12, 'jangan', 1, 4321);`)
    expect(() => v9.prepare('SELECT * FROM uniques').all()).toThrow()
    v9.close()
    const store = openStore(root)
    cleanups.push(() => store.close())
    expect(SCHEMA_VERSION).toBe(10)
    expect(store.schemaVersion).toBe(10)
    expect(store.db.pragma('user_version', { simple: true })).toBe(10)
    expect(store.characterById(1)).toMatchObject({ name: 'Ryu', level: 12, gold: 4321 })
    expect(cols(store.db, 'uniques').map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])).toEqual([
      ['code', 'TEXT', 0, null, 1],
      ['phase', 'TEXT', 1, null, 0],
      ['due_at', 'INTEGER', 1, '0', 0],
      ['camp', 'INTEGER', 0, null, 0],
      ['spawns', 'INTEGER', 1, '0', 0],
      ['last_killer', 'TEXT', 0, null, 0],
      ['last_killed_at', 'INTEGER', 0, null, 0],
    ])
    store.db.prepare("INSERT INTO uniques (code, phase) VALUES ('MOB_CH_TIGERWOMAN', 'waiting')").run()
    expect(store.db.prepare('SELECT * FROM uniques').all()).toEqual([{ code: 'MOB_CH_TIGERWOMAN', phase: 'waiting', due_at: 0, camp: null, spawns: 0, last_killer: null, last_killed_at: null }])
  })

  const REAL = join(REPO_ROOT, 'work/server/game.db')
  it.skipIf(!existsSync(REAL))('applies on a TEMP COPY of the real work/server/game.db (the original is never opened for writing)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-migrate-w11-real-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'data')
    mkdirSync(dir)
    for (const f of ['game.db', 'game.db-wal', 'game.db-shm']) if (existsSync(join(REPO_ROOT, 'work/server', f))) copyFileSync(join(REPO_ROOT, 'work/server', f), join(dir, f))
    const before = new Database(join(dir, 'game.db'))
    const version = before.pragma('user_version', { simple: true }) as number
    const chars = (before.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n
    before.close()
    expect(version).toBeGreaterThanOrEqual(9)
    const store = openStore(dir)
    cleanups.push(() => store.close())
    expect(store.schemaVersion).toBe(10)
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n).toBe(chars)
    expect(cols(store.db, 'uniques').map((c) => c.name)).toEqual(['code', 'phase', 'due_at', 'camp', 'spawns', 'last_killer', 'last_killed_at'])
  })
})

// ---- combat, corpse, kill path, summons --------------------------------------------------------------------------------

const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
function mrow(code: string, o: Partial<SkillDef>): SkillDef {
  return {
    code, id: 1, name: null, mastery: null, masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'melee', castMs: 0, actionMs: 0, cooldownMs: 0,
    range: 0, weapons: [], icon: null, group: code, kind: 'attack', targets: enemy, aniGroup: 'DEFAULT', mob: true, aiChance: 100, ...o,
  } as SkillDef
}
const ROWS: SkillDef[] = [
  mrow('MSKILL_CH_MANGNYANG_ATTACK01', { actionMs: 2400, cooldownMs: 3000, range: 1, animation: { shot: 'ATTACK1' }, damage: { physPct: 200, magPct: 0, flat: [17, 19], hits: 1 } }),
  ...([80, 60, 40] as const).map((band, i) =>
    mrow(`MSKILL_CH_TIGERWOMAN_SUMMON0${i + 1}`, {
      kind: 'buff', category: 'buff', cooldownMs: 500, aiChance: band, targets: { required: false, groups: [] },
      // a normal group, a champion group and an elite group: the policy keeps the normal one only
      summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 3, max: 6 }, { mob: 'MOB_CH_BLACKTIGER', rarity: 1, min: 3, max: 6 }, { mob: 'MOB_CH_WHITETIGER', rarity: 6, min: 3, max: 6 }],
    }),
  ),
]
const still = { walkSpeed: 0, runSpeed: 0 }
const MOBS: MobDef[] = [
  mob('MOB_CH_MANGNYANG', { level: 1, hp: 500, physAttack: [17, 19], attackRange: 1, attackIntervalMs: 3000, radius: 0.6, skills: ['MSKILL_CH_MANGNYANG_ATTACK01'], ...still }),
  mob('MOB_CH_PLAIN', { level: 1, hp: 500, physAttack: [17, 19], attackRange: 1, attackIntervalMs: 3000, radius: 0.6, ...still }),
  mob('MOB_CH_WHITETIGER', { level: 18, attackRange: 0.9, radius: 1.2, walkSpeed: 2, runSpeed: 4 }),
  mob('MOB_CH_BLACKTIGER', { level: 17, attackRange: 0.9, radius: 1.2, walkSpeed: 2, runSpeed: 4 }),
  mob('MOB_CH_TIGERWOMAN', { level: 20, rarity: 'unique', hp: 10_000, physAttack: [181, 217], attackRange: 2.8, attackIntervalMs: 3000, radius: 2.8, skills: ROWS.slice(1).map((r) => r.code), ...still }),
]

function setup(config: Partial<ServerConfig> = {}) {
  const data = new GameData({ mobs: [DUMMY, ...MOBS], items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] })
  const h = skillHarness({ data, book: new SkillBook([...SKILLS, ...ROWS], MASTERIES), config })
  cleanups.push(h.cleanup)
  h.runTo(h.now + 50)
  const spawn = (code: string, x: number, z: number) => h.gameplay.createMob(h.data.mob(code)!, h.data.mob(code)!.rarity === 'unique' ? 'unique' : 'normal', x, z, 0, null, h.now)
  /** A 1,000 HP mob that takes the hits as given (a plain hit of exactly `d`, capped at the HP left). */
  const target = (x: number, z: number) => {
    const m = spawn('MOB_CH_PLAIN', x, z)
    m.maxHp = m.hp = 1000
    return m
  }
  const hit = (p: Player, m: Mob, d: number) => h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: d, hp: 0 }], {}, h.now)
  const player = (x: number, z: number) => {
    const r = h.hero({ pos: [x, 0, z], level: 20 })
    r.p.maxHp = r.p.hp = 1_000_000
    return r
  }
  return { h, spawn, player, target, hit }
}

describe('Mob.damageMul', () => {
  it('a mob with damageMul 2 deals x2 through mobSkills.swing (next to MOB_DAMAGE_RATE) and through the basic attack', () => {
    const { h, spawn, player } = setup()
    const { p, inbox } = player(0, 1.5)
    const dealt = (code: string, mul?: number) => {
      const m = spawn(code, 0, 0)
      if (mul !== undefined) m.damageMul = mul
      const before = inbox.length
      h.gameplay.mobSkills.swing(m, p, h.now)
      const hits = h.all(inbox.slice(before), 'combat').filter((c) => c.attacker === m.id).flatMap((c) => c.hits)
      h.world.removeEntity(m.id)
      expect(hits.length).toBe(1)
      return hits[0].damage
    }
    const one = dealt('MOB_CH_MANGNYANG')
    expect(one).toBeGreaterThan(2)
    expect(dealt('MOB_CH_MANGNYANG', 1)).toBe(one)
    expect(Math.abs(dealt('MOB_CH_MANGNYANG', 2) - 2 * one)).toBeLessThanOrEqual(1)
    const basic = dealt('MOB_CH_PLAIN')
    expect(basic).toBeGreaterThan(2)
    expect(Math.abs(dealt('MOB_CH_PLAIN', 2) - 2 * basic)).toBeLessThanOrEqual(1)
  })
})

describe('Mob.corpseMs', () => {
  it('corpseMs 8,000 keeps the corpse 8 s; a normal mob keeps CORPSE_MS (3 s)', () => {
    const { h, spawn } = setup()
    expect(CORPSE_MS).toBe(3000)
    const boss = spawn('MOB_CH_PLAIN', 10, 10)
    boss.corpseMs = 8000
    const plain = spawn('MOB_CH_PLAIN', -10, -10)
    const t0 = h.now
    h.gameplay.gmKill(boss, t0)
    h.gameplay.gmKill(plain, t0)
    h.runTo(t0 + 2950)
    expect(h.world.mobs.has(plain.id)).toBe(true)
    h.runTo(t0 + 3050)
    expect(h.world.mobs.has(plain.id)).toBe(false)
    expect(h.world.mobs.get(boss.id)?.ai).toBe('dead')
    h.runTo(t0 + 7950)
    expect(h.world.mobs.has(boss.id)).toBe(true)
    h.runTo(t0 + 8050)
    expect(h.world.mobs.has(boss.id)).toBe(false)
  })
})

describe('the kill path', () => {
  const req = (h: ReturnType<typeof setup>['h'], p: Player, msg: ClientMessage) => h.gameplay.request(p, msg as Extract<ClientMessage, { t: GameplayRequest }>, h.now)

  /** Spies on the uniques module's mobDied hook: what it saw, and m.damage at that moment. */
  const spy = (h: ReturnType<typeof setup>['h']) => {
    const seen: { m: Mob; credit: number[]; owner: KillOwner; damageAtHook: number }[] = []
    h.gameplay.uniques!.mobDied = (m, _now, credit, owner) => {
      seen.push({ m, credit: [...credit], owner, damageAtHook: m.damage.size })
    }
    return seen
  }
  const byId = (d: ReadonlyMap<number, number>) => [...d.entries()].sort((x, y) => x[0] - y[0])

  it('solo: the loot-owner group (the top dealer) reaches the hook with the damage map intact; m.damage is cleared after', () => {
    const { h, player, target, hit } = setup()
    const a = player(0, 2).p
    const b = player(2, 0).p
    const seen = spy(h)
    const m = target(0, 0)
    hit(a, m, 250)
    hit(b, m, 300)
    hit(a, m, 150)
    expect(m.ai).not.toBe('dead')
    hit(b, m, 5000)
    expect(m.ai).toBe('dead')
    expect(seen.length).toBe(1)
    const s = seen[0]
    expect(s.owner.player).toBe(b)
    expect(s.owner.party).toBeNull()
    expect(byId(s.owner.damage)).toEqual(byId(new Map([[a.id, 400], [b.id, 600]])))
    expect(s.credit.sort()).toEqual([a.id, b.id].sort())
    // The hook still runs after the clear (the quest engine's order is unchanged); the owner carries its own copy.
    expect(s.damageAtHook).toBe(0)
    expect(m.damage.size).toBe(0)
    expect(s.owner.damage.size).toBe(2)
  })

  it('party: a party that out-damages a stronger solo player owns the loot and is named by its top dealer', () => {
    const { h, player, target, hit } = setup()
    const a = player(0, 2)
    const b = player(2, 0)
    const solo = player(-2, 0).p
    req(h, a.p, { t: 'partyInvite', target: b.p.id })
    req(h, b.p, { t: 'partyRespond', inviter: a.p.id, accept: true })
    const party = h.gameplay.party.partyOf(a.p)
    expect(party).toBeDefined()
    expect(h.gameplay.party.partyOf(b.p)).toBe(party)
    const seen = spy(h)
    const m = target(0, 0)
    // solo 400 beats each member (a 320, b 200 + 80) but not the party (600)
    hit(solo, m, 400)
    hit(a.p, m, 320)
    hit(b.p, m, 200)
    hit(b.p, m, 5000)
    expect(seen.length).toBe(1)
    expect(seen[0].owner.party).toBe(party!.id)
    expect(seen[0].owner.player).toBe(a.p)
    expect(byId(seen[0].owner.damage)).toEqual(byId(new Map([[solo.id, 400], [a.p.id, 320], [b.p.id, 280]])))
  })

  it('a GM kill runs no hook (the module notices it in its tick); a loot override with plus 2 reaches the ground item', () => {
    const { h, player, target, hit } = setup()
    const a = player(0, 2).p
    const seen = spy(h)
    const gm = target(5, 5)
    h.gameplay.gmKill(gm, h.now)
    expect(seen.length).toBe(0)
    const m = target(0, 0)
    h.gameplay.uniques!.drops = (x) => (x === m ? [{ code: 'ITEM_CH_SHIELD_01_A', count: 1, plus: 2 }, { code: 'ITEM_ETC_HP_POTION_01', count: 10 }] : null)
    hit(a, m, 5000)
    const items = [...h.world.items.values()]
    expect(items.map((i) => [i.code, i.count, i.plus, i.owner]).sort()).toEqual([
      ['ITEM_CH_SHIELD_01_A', 1, 2, a.id],
      ['ITEM_ETC_HP_POTION_01', 10, 0, a.id],
    ])
    expect(seen.length).toBe(1)
  })
})

describe('the summon policy (mob-skills.ts)', () => {
  const tigers = (h: ReturnType<typeof setup>['h']) => [...h.world.mobs.values()].filter((m) => m.def.code !== 'MOB_CH_TIGERWOMAN' && m.ai !== 'dead' && m.def.code.endsWith('TIGER'))

  it('a policy turns her SUMMON rows on with MOB_SUMMONS off: 2 normal tigers per wave, 4 alive at most', () => {
    const { h, spawn, player } = setup()
    expect(h.config.mobSummons ?? 0).toBe(0)
    const { p } = player(0, 5)
    const tg = spawn('MOB_CH_TIGERWOMAN', 0, 0)
    tg.ai = 'chase'
    tg.target = p.id
    // Without a policy nothing fires (MOB_SUMMONS off).
    tg.hp = tg.maxHp * 0.7
    h.runTo(h.now + 100)
    expect(tigers(h).length).toBe(0)
    h.gameplay.uniques!.summonPolicy = (m) => (m === tg ? { on: true, perWave: 2, maxAlive: 4, variants: ['normal'] } : null)
    h.runTo(h.now + 100)
    expect(tigers(h).map((m) => [m.def.code, m.variant])).toEqual([['MOB_CH_WHITETIGER', 'normal'], ['MOB_CH_WHITETIGER', 'normal']])
    expect(tigers(h).every((m) => m.target === p.id)).toBe(true)
    tg.hp = tg.maxHp * 0.5
    h.runTo(h.now + 100)
    expect(tigers(h).length).toBe(4)
    tg.hp = tg.maxHp * 0.3
    h.runTo(h.now + 100)
    expect(tigers(h).length).toBe(4)
  })

  it('policy off silences her with MOB_SUMMONS on; other mobs keep the global rule', () => {
    const { h, spawn, player } = setup({ mobSummons: 1, mobSummonCap: 30 })
    const { p } = player(0, 5)
    const tg = spawn('MOB_CH_TIGERWOMAN', 0, 0)
    tg.ai = 'chase'
    tg.target = p.id
    h.gameplay.uniques!.summonPolicy = (m) => (m === tg ? { on: false } : null)
    tg.hp = tg.maxHp * 0.7
    h.runTo(h.now + 100)
    expect(tigers(h).length).toBe(0)
    const other = spawn('MOB_CH_TIGERWOMAN', 3, 3)
    other.ai = 'chase'
    other.target = p.id
    other.hp = other.maxHp * 0.7
    h.runTo(h.now + 100)
    // the global rule: every group of the row (normal, champion, elite), 3..6 each
    expect(tigers(h).length).toBeGreaterThanOrEqual(9)
    expect(new Set(tigers(h).map((m) => m.variant))).toEqual(new Set(['normal', 'champion', 'elite']))
  })
})
