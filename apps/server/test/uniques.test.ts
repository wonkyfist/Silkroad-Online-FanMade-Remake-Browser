/**
 * Wave 11 lane U-S: the uniques module (apps/server/src/uniques.ts), `/unique` and content/uniques.json, against
 * docs/UNIQUES.md §8.2's list: the timer windows, restarts in both phases, at most one alive, the camp roll (unplaceable
 * and disabled camps skipped), the notices (solo, party, the loot-owner group, GM kills silent, the generic /kill noticed
 * by the tick, /unique quiet), the leash reset, enrage once, the fury on a fake clock, the summon clip, the drop override
 * (field unique only, gear wearable at the cap, plus levels on the ground), the 8 s corpse, the GM commands and their
 * audit rows, UNIQUES=off = today, and a /nest edit never giving the Spawner a unique nest.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROVENANCE_PORT,
  contentEntries,
  type ClientMessage,
  type DropTable,
  type GameplayRequest,
  type ItemDef,
  type MobDef,
  type NestDef,
  type ServerMessage,
  type SkillDef,
  type UniquesFile,
  type ZoneDef,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT, type ServerConfig } from '../src/config.ts'
import type { Connection } from '../src/connection.ts'
import { applyNestDiff } from '../src/editors/live.ts'
import type { GameContext } from '../src/game.ts'
import { GameData } from '../src/gamedata.ts'
import { COMMANDS, runGm } from '../src/gm.ts'
import { SkillBook } from '../src/skills/book.ts'
import { UNIQUE_GROUP_REFUSAL } from '../src/spawner.ts'
import { UNIQUE_AREA_LINE_M, gearPool, hmm, resolveDropTable, rollUniqueDrops } from '../src/uniques.ts'
import type { Mob, Player } from '../src/world.ts'
import { item, mob, nest, seeded } from './fixtures.ts'
import { MASTERIES, SAFE_TOWN, SKILLS, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const MIN = 60_000
const TG = 'MOB_CH_TIGERWOMAN'
const REAL_FILE = JSON.parse(readFileSync(join(REPO_ROOT, 'content/uniques.json'), 'utf8')) as UniquesFile

// ---- fixtures: Tiger Girl, her adds, five camps, the loot's items, one named zone ---------------------------------

const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
function mrow(code: string, o: Partial<SkillDef>): SkillDef {
  return {
    code, id: 1, name: null, mastery: null, masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'melee', castMs: 0, actionMs: 0, cooldownMs: 0,
    range: 0, weapons: [], icon: null, group: code, kind: 'attack', targets: enemy, aniGroup: 'DEFAULT', mob: true, aiChance: 100, ...o,
  } as SkillDef
}
/** Her retail summon rows: bands 80 / 60 / 40 (aiChance); each wave holds a normal, a champion and an elite group. */
const ROWS: SkillDef[] = ([80, 60, 40] as const).map((band, i) =>
  mrow(`MSKILL_CH_TIGERWOMAN_SUMMON0${i + 1}`, {
    kind: 'buff', category: 'buff', cooldownMs: 500, aiChance: band, targets: { required: false, groups: [] },
    summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 3, max: 6 }, { mob: 'MOB_CH_BLACKTIGER', rarity: 1, min: 3, max: 6 }, { mob: 'MOB_CH_WHITETIGER', rarity: 6, min: 3, max: 6 }],
  }),
)
const still = { walkSpeed: 0, runSpeed: 0 }
const MOBS: MobDef[] = [
  mob(TG, { name: 'Tiger Girl', level: 20, rarity: 'unique', hp: 598_720, exp: 451_200, spExp: 451_200, physAttack: [181, 217], attackRange: 2.8, attackIntervalMs: 3000, radius: 2.8, aggressive: true, skills: ROWS.map((r) => r.code), ...still }),
  mob('MOB_CH_WHITETIGER', { name: 'White Tiger', level: 18, attackRange: 0.9, radius: 1.2, ...still }),
  mob('MOB_CH_BLACKTIGER', { name: 'Black Tiger', level: 17, attackRange: 0.9, radius: 1.2, ...still }),
]
const tactics = { id: 9, aggressive: true, sightRange: 14, leashRange: 50 }
const camp = (id: number, x: number, z: number, over: Partial<NestDef> = {}) =>
  nest(id, TG, x, z, { uniqueGroup: TG, respawnSec: [10_800, 21_600], radius: 100, spawnRadius: 60, tactics, ...over })
/** 5903–5905 place; 5906 is disabled; 5907 lies outside the 1 km test world (never places). */
const CAMPS: NestDef[] = [camp(5903, 50, -50), camp(5904, -60, 40), camp(5905, 120, 120), camp(5906, 0, -150, { enabled: false }), camp(5907, 900, 0)]
const PLACEABLE = [5903, 5904, 5905]

const gear = (code: string, category: ItemDef['category'], reqLevel: number, over: Partial<ItemDef> = {}) => item(code, { category, degree: 3, reqLevel, race: 'china', ...over })
const GEAR: ItemDef[] = [
  gear('ITEM_CH_SWORD_03_A', 'weapon', 16), gear('ITEM_CH_SWORD_03_B', 'weapon', 18), gear('ITEM_CH_SWORD_03_C', 'weapon', 21),
  gear('ITEM_CH_RING_03_A', 'accessory', 16), gear('ITEM_CH_RING_03_B', 'accessory', 18), gear('ITEM_CH_RING_03_C', 'accessory', 21),
  gear('ITEM_CH_M_HEAVY_03_HA_A', 'armor', 19, { reqGender: 'male' }), gear('ITEM_CH_M_HEAVY_03_HA_B', 'armor', 21, { reqGender: 'male' }),
  // no wearable grade at level 20: the family is left out
  gear('ITEM_CH_M_HEAVY_03_BA_A', 'armor', 21, { reqGender: 'male' }), gear('ITEM_CH_M_HEAVY_03_BA_B', 'armor', 23, { reqGender: 'male' }),
  // never in the pool: a creation default, a European row, another degree
  gear('ITEM_CH_SWORD_03_A_DEF', 'weapon', 1), gear('ITEM_EU_SWORD_03_A', 'weapon', 16, { race: 'europe' }), gear('ITEM_CH_SWORD_02_A', 'weapon', 12, { degree: 2 }),
  // Seal of Star rows
  // As items.json: every seal tier at the A grade's level (H11-NL-1).
  gear('ITEM_CH_SWORD_03_A_RARE', 'weapon', 16), gear('ITEM_CH_SWORD_03_B_RARE', 'weapon', 16), gear('ITEM_CH_SWORD_03_C_RARE', 'weapon', 16),
]
const LOOT: ItemDef[] = [
  ...['WEAPON', 'ARMOR', 'SHIELD', 'ACCESSARY'].map((k) => item(`ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_${k}_A`, { category: 'alchemy' })),
  item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', { category: 'alchemy', maxStack: 50 }),
  item('ITEM_ETC_HP_POTION_04', { category: 'potion', maxStack: 50 }),
  item('ITEM_ETC_MP_POTION_04', { category: 'potion', maxStack: 50 }),
]
const ITEMS: ItemDef[] = [...SKILL_ITEMS, ...GEAR, ...LOOT]
const GEAR_CODES = new Set(GEAR.map((g) => g.code))
/** Her normal drops.json row (the quest encounter keeps it). */
const NORMAL_DROPS: DropTable[] = [{ mob: TG, groups: [{ chance: 1, entries: [{ item: 'ITEM_ETC_HP_POTION_01', weight: 1 }] }], provenance: PROVENANCE_PORT }]
/** The test world's region origin and one named region over camp 5903 (the zone name ends in a full stop). */
const ORIGIN = { ox: 100, oz: 100 }
const ZONES = [{ region: (100 << 8) | 100, rx: 100, rz: 100, name: 'North-Tiger Mt.' }] as unknown as ZoneDef[]

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

interface BootOpts {
  config?: Partial<ServerConfig>
  /** Edits a copy of the shipped content/uniques.json before it is written. */
  file?: (f: UniquesFile) => void
  dataDir?: string
  /** The boot's clock (ms). */
  at?: number
  /** Seeds the module's own stream (timers, camp rolls, loot). */
  seed?: number
  /** Leave the harness open (restart tests close it themselves). */
  keep?: boolean
}

/** A world with the camps, a CONTENT_DIR holding (a copy of) the shipped uniques.json, started at `at`. */
function boot(o: BootOpts = {}) {
  const content = mkdtempSync(join(tmpdir(), 'sro-uniques-content-'))
  cleanups.push(() => rmSync(content, { recursive: true, force: true }))
  const file = structuredClone(REAL_FILE)
  o.file?.(file)
  writeFileSync(join(content, 'uniques.json'), JSON.stringify(file))
  const data = new GameData({ mobs: MOBS, items: ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN], nests: CAMPS.map((n) => ({ ...n })), zones: ZONES, drops: NORMAL_DROPS })
  const h = skillHarness({ data, book: new SkillBook([...SKILLS, ...ROWS], MASTERIES), config: { contentDir: content, ...(o.dataDir ? { dataDir: o.dataDir } : {}), ...o.config } })
  if (!o.keep) cleanups.push(h.cleanup)
  ;(h.gameplay.setup as { regionOrigin: typeof ORIGIN | null }).regionOrigin = ORIGIN
  if (h.gameplay.uniques && o.seed !== undefined) h.gameplay.uniques.rng = seeded(o.seed)
  if (o.at !== undefined) h.now = o.at
  h.gameplay.start(h.now)
  const u = () => h.gameplay.uniques!.uniques[0]
  const her = (): Mob | undefined => [...h.world.mobs.values()].find((m) => m.def.code === TG && m.ai !== 'dead')
  /** A level-20 character with 1,000,000 HP. */
  const player = (x: number, z: number, name?: string) => {
    const r = h.hero({ pos: [x, 0, z], level: 20, ...(name ? { name } : {}) })
    r.p.maxHp = r.p.hp = 1_000_000
    return r
  }
  /** Next to her (inside her reach: she cannot walk in these tests). */
  const beside = (m: Mob, dx = 2, name?: string) => player(m.pos[0] + dx, m.pos[2], name)
  const hit = (p: Player, m: Mob, d: number) => h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: d, hp: 0 }], {}, h.now)
  /** Jumps the clock to `t` (no ticks in between), then ticks 100 ms. */
  const jump = (t: number) => {
    h.now = t
    h.runTo(t + 100)
  }
  /** Spawns her now through the scheduler (timer → now, one tick). */
  const spawnNow = () => {
    expect(h.gameplay.uniques!.gm(null, ['timer', 'tiger', 'now'], h.now).ok).toBe(true)
    h.runTo(h.now + 100)
    const m = her()
    expect(m).toBeDefined()
    return m!
  }
  const notices = (inbox: ServerMessage[]) => h.all(inbox, 'uniqueNotice') as Msg<'uniqueNotice'>[]
  const lines = (inbox: ServerMessage[]) => (h.all(inbox, 'chat') as Msg<'chat'>[]).filter((c) => c.channel === 'system').map((c) => c.text)
  const req = (p: Player, msg: ClientMessage) => h.gameplay.request(p, msg as Extract<ClientMessage, { t: GameplayRequest }>, h.now)
  const adds = () => [...h.world.mobs.values()].filter((m) => m.def.code !== TG && m.ai !== 'dead' && m.def.code.endsWith('TIGER'))
  return { h, u, her, player, beside, hit, jump, spawnNow, notices, lines, req, adds, content }
}

const tmpDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sro-uniques-db-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---- the file --------------------------------------------------------------------------------------------------

describe('content/uniques.json', () => {
  it('is UNIQUES §5.3: Tiger Girl only, her retail group, the §3.2 timers, the §3.6 / §4 tuning and the §3.4 table', () => {
    expect(REAL_FILE.uniques.map((x) => x.mob)).toEqual([TG])
    expect(REAL_FILE.uniques[0]).toMatchObject({
      world: 'jangan', camps: 'uniqueGroup', respawnMin: [180, 360], firstSpawnMin: [10, 30], restartSpawnMin: [1, 2],
      tuning: { hpMul: 0.08, attackMul: 1, expMul: 1 }, summons: { on: true, perWave: 2, maxAlive: 4, variants: ['normal'] },
      enrage: { hpPct: 20, damageMul: 1.25 }, fury: { afterSec: 600, damageMul: 2 }, corpseSec: 8, announce: { appear: true, defeat: true }, drops: 'UNIQUE_TIGERWOMAN',
    })
  })

  it('a bad file fails the start: an unknown mob, no camps, a bad range, a missing drop table', () => {
    const bad: [string, (f: UniquesFile) => void, RegExp][] = [
      ['unknown mob', (f) => void (f.uniques[0].mob = 'MOB_NOPE'), /unknown mob MOB_NOPE/],
      ['no camps', (f) => void (f.uniques[0].camps = []), /camps/],
      ['unknown camp', (f) => void (f.uniques[0].camps = [42]), /unknown nest 42/],
      ['bad range', (f) => void (f.uniques[0].respawnMin = [360, 180]), /respawnMin/],
      ['no table', (f) => void (f.uniques[0].drops = 'NOPE'), /no drop table NOPE/],
      ['unknown item', (f) => void (f.dropTables.UNIQUE_TIGERWOMAN.groups[1].entries![0].item = 'ITEM_NOPE'), /unknown item ITEM_NOPE/],
    ]
    for (const [what, edit, re] of bad) expect(() => boot({ file: edit }), what).toThrow(re)
    // A group-based unique whose nests are all gone (a world without her camps): a start error too.
    expect(() => boot({ file: (f) => void (f.uniques[0].mob = 'MOB_CH_WHITETIGER') })).toThrow(/MOB_CH_WHITETIGER has no camps/)
  })

  it('a unique of another world is ignored; no CONTENT_DIR or no file = no uniques (the module is inert)', () => {
    const { h } = boot({ file: (f) => void (f.uniques[0].world = 'donwhang') })
    expect(h.gameplay.uniques!.uniques).toEqual([])
    expect(h.logs.some((l) => /uniques: none on world jangan/.test(l))).toBe(true)
    const bare = skillHarness()
    cleanups.push(bare.cleanup)
    expect(bare.gameplay.uniques!.start(bare.now)).toBeNull()
    const empty = mkdtempSync(join(tmpdir(), 'sro-uniques-none-'))
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }))
    const none = skillHarness({ config: { contentDir: empty } })
    cleanups.push(none.cleanup)
    expect(none.gameplay.uniques!.start(none.now)).toMatch(/no uniques\.json/)
  })
})

// ---- the scheduler --------------------------------------------------------------------------------------------

describe('timers (UNIQUES §3.2, persisted in the uniques table)', () => {
  it('a fresh database: the first spawn is 10–30 min after the boot, and she appears then, at full HP', () => {
    const offsets: number[] = []
    for (let seed = 1; seed <= 8; seed++) {
      const { h, u } = boot({ seed, at: 5_000_000 })
      offsets.push(u().row.due_at - 5_000_000)
      expect(u().row).toMatchObject({ phase: 'waiting', spawns: 0 })
      expect(h.store.db.prepare('SELECT phase, due_at FROM uniques WHERE code = ?').get(TG)).toEqual({ phase: 'waiting', due_at: u().row.due_at })
    }
    for (const d of offsets) expect(d).toBeGreaterThanOrEqual(10 * MIN), expect(d).toBeLessThanOrEqual(30 * MIN)
    expect(new Set(offsets).size).toBeGreaterThan(4)
    const { h, u, her, jump } = boot({ seed: 3 })
    const due = u().row.due_at
    jump(due - 1000)
    expect(her()).toBeUndefined()
    jump(due)
    const m = her()!
    expect(m.variant).toBe('unique')
    expect(m.maxHp).toBe(47_898) // 598,720 x 0.08
    expect(m.hp).toBe(m.maxHp)
    expect(m.corpseMs).toBe(8000)
    expect(m.tuning).toEqual({ hpMul: 0.08, attackMul: 1, expMul: 1 })
    // her retail camps roam 100 m and spawn within 60 m, but leash at 50 m: she lives within 40 m (uniqueHome)
    expect(m.leashRange).toBe(50)
    expect(m.roamRadius).toBe(40)
    expect(m.sightRange).toBe(14)
    expect(m.aggressive).toBe(true)
    const home = CAMPS.find((n) => n.id === u().row.camp)!
    expect(m.home).toEqual([home.x, home.z])
    expect(Math.hypot(m.pos[0] - home.x, m.pos[2] - home.z)).toBeLessThanOrEqual(40)
    expect(u().row).toMatchObject({ phase: 'alive', spawns: 1, due_at: 0 })
    expect(PLACEABLE).toContain(u().row.camp)
    expect(h.store.db.prepare('SELECT phase, camp, spawns FROM uniques').get()).toEqual({ phase: 'alive', camp: u().row.camp, spawns: 1 })
  })

  it('a kill rolls the respawn 180–360 min later', () => {
    const offsets: number[] = []
    for (let seed = 1; seed <= 6; seed++) {
      const { h, u, spawnNow, beside, hit } = boot({ seed })
      const m = spawnNow()
      hit(beside(m).p, m, 1e9)
      expect(m.ai).toBe('dead')
      offsets.push(u().row.due_at - h.now)
      expect(u().row.phase).toBe('waiting')
    }
    for (const d of offsets) expect(d).toBeGreaterThanOrEqual(180 * MIN), expect(d).toBeLessThanOrEqual(360 * MIN)
    expect(new Set(offsets).size).toBeGreaterThan(3)
  })

  it('a restart while she waits keeps the due time; one that finds it passed spawns her 1–2 min after the boot', () => {
    const dataDir = tmpDataDir()
    const a = boot({ dataDir, seed: 1, at: 1_000_000, keep: true })
    const due = a.u().row.due_at
    a.h.cleanup()
    const b = boot({ dataDir, seed: 2, at: 1_000_000 + 5 * MIN, keep: true })
    expect(b.u().row.due_at).toBe(due)
    expect(b.h.logs.some((l) => /timer kept/.test(l))).toBe(true)
    b.h.cleanup()
    const late = due + 60 * MIN
    const c = boot({ dataDir, seed: 3, at: late })
    expect(c.u().row.due_at - late).toBeGreaterThanOrEqual(1 * MIN)
    expect(c.u().row.due_at - late).toBeLessThanOrEqual(2 * MIN)
    expect(c.h.logs.some((l) => /overdue/.test(l))).toBe(true)
    c.jump(c.u().row.due_at)
    expect(c.her()).toBeDefined()
  })

  it('a restart while she is alive: gone at the boot, back 1–2 min later at a new roll, at full HP', () => {
    const dataDir = tmpDataDir()
    const a = boot({ dataDir, seed: 4, keep: true })
    const m = a.spawnNow()
    a.hit(a.beside(m).p, m, 10_000)
    expect(m.hp).toBeLessThan(m.maxHp)
    const t = a.h.now
    a.h.cleanup()
    const b = boot({ dataDir, seed: 5, at: t + 30 * MIN })
    expect(b.her()).toBeUndefined()
    expect(b.u().row.phase).toBe('waiting')
    expect(b.u().row.due_at - (t + 30 * MIN)).toBeGreaterThanOrEqual(1 * MIN)
    expect(b.u().row.due_at - (t + 30 * MIN)).toBeLessThanOrEqual(2 * MIN)
    expect(b.h.logs.some((l) => /was alive at shutdown/.test(l))).toBe(true)
    b.jump(b.u().row.due_at)
    const again = b.her()!
    expect(again.hp).toBe(again.maxHp)
    expect(b.u().row.spawns).toBe(2)
  })

  it('at most one alive: the scheduler never spawns a second, the Spawner refuses her camps, /unique spawn is refused', () => {
    const { h, u, spawnNow, jump } = boot({ seed: 6 })
    spawnNow()
    jump(h.now + 10 * 60 * MIN)
    expect([...h.world.mobs.values()].filter((m) => m.def.code === TG)).toHaveLength(1)
    expect(h.gameplay.spawner.nests.some((n) => n.def.uniqueGroup)).toBe(false)
    expect(h.gameplay.spawner.skipped.filter((s) => s.reason === UNIQUE_GROUP_REFUSAL).map((s) => s.nest).sort()).toEqual([5903, 5904, 5905, 5907])
    const r = h.gameplay.uniques!.gm(null, ['spawn', 'tiger'], h.now)
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toMatch(/already alive/)
    expect(u().row.spawns).toBe(1)
  })

  it('the camp roll is uniform over the placeable, enabled camps; a GM-disabled camp drops out at the next roll', () => {
    const { h, u, her } = boot({ seed: 7 })
    const g = h.gameplay.uniques!
    const count = (n: number) => {
      const seen = new Map<number, number>()
      for (let i = 0; i < n; i++) {
        g.gm(null, ['timer', 'tiger', 'now'], h.now)
        h.runTo(h.now + 50)
        seen.set(u().row.camp!, (seen.get(u().row.camp!) ?? 0) + 1)
        expect(her()).toBeDefined()
        expect(g.gm(null, ['despawn', 'tiger'], h.now).ok).toBe(true)
      }
      return seen
    }
    const seen = count(300)
    expect([...seen.keys()].sort()).toEqual(PLACEABLE)
    for (const id of PLACEABLE) expect(seen.get(id)!).toBeGreaterThan(70), expect(seen.get(id)!).toBeLessThan(130)
    expect(h.logs.some((l) => /camp 5907 does not place/.test(l))).toBe(true)
    // The GM spawn editor disables 5905 (data.nests re-layered): it never comes up again.
    const i = h.data.nests.findIndex((n) => n.id === 5905)
    h.data.nests[i] = { ...h.data.nests[i], enabled: false }
    expect([...count(60).keys()].sort()).toEqual([5903, 5904])
  })

  it('no camp places: no spawn, a retry every minute (logged once)', () => {
    const { h, u, her } = boot({ seed: 8 })
    for (const n of h.data.nests) if (n.id !== 5907) n.enabled = false
    h.gameplay.uniques!.gm(null, ['timer', 'tiger', 'now'], h.now)
    h.runTo(h.now + 100)
    expect(her()).toBeUndefined()
    expect(u().row.due_at).toBeGreaterThan(h.now + 50_000)
    h.runTo(u().row.due_at + 100)
    expect(h.logs.filter((l) => /no camp places/.test(l))).toHaveLength(1)
  })
})

// ---- notices ---------------------------------------------------------------------------------------------------

describe('notices (UNIQUES §3.3)', () => {
  it('appear: every player in the world gets one, with the zone name as is; the camp roll is the module rng', () => {
    const { h, player, notices, spawnNow } = boot({ seed: 9, file: (f) => void (f.uniques[0].camps = [5903]) })
    const near = player(40, -40)
    const far = player(-400, 400)
    const m = spawnNow()
    const appeared = { t: 'uniqueNotice', event: 'appeared', mob: TG, name: 'Tiger Girl', area: 'North-Tiger Mt.', at: expect.any(Number) }
    // H11-NL-5: within roarRadiusM (120 m) of where she appears, the notice also carries her roar.
    expect(notices(near.inbox)).toEqual([{ ...appeared, roar: true }])
    expect(notices(far.inbox)).toEqual([appeared])
    expect(m.home).toEqual([50, -50])
  })

  it('appear without a zone name has no area; announce.appear false is silent', () => {
    const a = boot({ seed: 10 })
    ;(a.h.gameplay.setup as { regionOrigin: typeof ORIGIN | null }).regionOrigin = null
    const p = a.player(0, 0)
    a.spawnNow()
    expect(a.notices(p.inbox)).toEqual([{ t: 'uniqueNotice', event: 'appeared', mob: TG, name: 'Tiger Girl', roar: true, at: expect.any(Number) }])
    const b = boot({ seed: 10, file: (f) => void (f.uniques[0].announce.appear = false) })
    const q = b.player(0, 0)
    b.spawnNow()
    expect(b.notices(q.inbox)).toEqual([])
  })

  it('defeat, solo: names the killer; the row keeps the last killer', () => {
    const { h, u, notices, spawnNow, beside, hit, player } = boot({ seed: 11 })
    const watcher = player(-300, -300)
    const m = spawnNow()
    const mei = beside(m, 2, 'Mei')
    hit(mei.p, m, 1e9)
    const want = { t: 'uniqueNotice', event: 'defeated', mob: TG, name: 'Tiger Girl', by: 'Mei' }
    expect(notices(mei.inbox).at(-1)).toEqual(want)
    expect(notices(watcher.inbox).at(-1)).toEqual(want)
    expect(u().row).toMatchObject({ phase: 'waiting', last_killer: 'Mei', last_killed_at: h.now })
  })

  it('defeat, party: "<top dealer>\'s party"; a solo player out-damaging each member but not the party loses the credit', () => {
    const { notices, spawnNow, beside, hit, req, h } = boot({ seed: 12 })
    const m = spawnNow()
    const a = beside(m, 2, 'Mei')
    const b = beside(m, -2, 'Ryu')
    const solo = beside(m, 1.5, 'Lone')
    req(a.p, { t: 'partyInvite', target: b.p.id })
    req(b.p, { t: 'partyRespond', inviter: a.p.id, accept: true })
    expect(h.gameplay.party.partyOf(a.p)).toBeDefined()
    // solo 400 beats each member (Mei 320, Ryu 280) but not the party (600)
    hit(solo.p, m, 400)
    hit(a.p, m, 320)
    hit(b.p, m, 200)
    m.hp = 80
    hit(b.p, m, 80)
    expect(m.ai).toBe('dead')
    expect(notices(solo.inbox).at(-1)).toEqual({ t: 'uniqueNotice', event: 'defeated', mob: TG, name: 'Tiger Girl', by: 'Mei', party: true })
  })

  it('a GM kill is silent and runs the timer: /unique kill, /unique despawn, and the generic /kill (noticed by the tick)', () => {
    const { h, u, notices, spawnNow, player, her } = boot({ seed: 13 })
    const p = player(0, 0)
    for (const how of ['unique kill', 'unique despawn', 'generic kill', 'removed'] as const) {
      const m = spawnNow()
      const before = notices(p.inbox).length
      if (how === 'unique kill') expect(h.gameplay.uniques!.gm(null, ['kill', 'Tiger', 'Girl'], h.now).ok).toBe(true)
      else if (how === 'unique despawn') expect(h.gameplay.uniques!.gm(null, ['despawn', TG], h.now).ok).toBe(true)
      else if (how === 'generic kill') h.gameplay.gmKill(m, h.now)
      else h.world.removeEntity(m.id)
      h.runTo(h.now + 100)
      expect(her(), how).toBeUndefined()
      expect(notices(p.inbox).length, how).toBe(before)
      expect(u().row.phase, how).toBe('waiting')
      expect(u().row.due_at - h.now, how).toBeGreaterThanOrEqual(180 * MIN - 200)
      expect(u().row.last_killer, how).toBeNull()
    }
    expect(h.logs.some((l) => /killed by a GM; next spawn/.test(l))).toBe(true)
    expect(h.logs.some((l) => /Tiger Girl removed; next spawn/.test(l))).toBe(true)
  })

  it('/unique quiet on hides the notices from that GM only (until the player leaves the world)', () => {
    const { h, notices, spawnNow, player, beside, hit } = boot({ seed: 14 })
    const gm = player(0, 0)
    const other = player(5, 5)
    expect(h.gameplay.uniques!.gm(gm.p, ['quiet', 'on'], h.now)).toMatchObject({ ok: true, data: { quiet: true } })
    const m = spawnNow()
    hit(beside(m).p, m, 1e9)
    expect(notices(gm.inbox)).toEqual([])
    expect(notices(other.inbox).map((n) => n.event)).toEqual(['appeared', 'defeated'])
    expect(h.gameplay.uniques!.gm(gm.p, ['quiet', 'off'], h.now).ok).toBe(true)
    spawnNow()
    expect(notices(gm.inbox).map((n) => n.event)).toEqual(['appeared'])
    h.gameplay.uniques!.gm(gm.p, ['quiet', 'on'], h.now)
    h.gameplay.uniques!.forget(gm.p)
    h.gameplay.uniques!.gm(null, ['despawn', 'tiger'], h.now)
    spawnNow()
    expect(notices(gm.inbox).map((n) => n.event)).toEqual(['appeared', 'appeared'])
  })
})

// ---- the fight ------------------------------------------------------------------------------------------------

describe('the fight (UNIQUES §3.6)', () => {
  it('summons: 2 normal tigers per wave at 80 / 60 / 40 %, 4 alive at most (MOB_SUMMONS stays 0); they leave with her', () => {
    const { h, spawnNow, beside, hit, adds } = boot({ seed: 15 })
    expect(h.config.mobSummons ?? 0).toBe(0)
    const m = spawnNow()
    const { p } = beside(m)
    hit(p, m, Math.ceil(m.maxHp * 0.25))
    h.runTo(h.now + 100)
    expect(adds().map((x) => [x.def.code, x.variant])).toEqual([['MOB_CH_WHITETIGER', 'normal'], ['MOB_CH_WHITETIGER', 'normal']])
    hit(p, m, Math.ceil(m.maxHp * 0.2))
    h.runTo(h.now + 100)
    expect(adds()).toHaveLength(4)
    hit(p, m, Math.ceil(m.maxHp * 0.2))
    h.runTo(h.now + 100)
    expect(adds()).toHaveLength(4)
    expect(adds().every((x) => x.variant === 'normal')).toBe(true)
    hit(p, m, 1e9)
    h.runTo(h.now + 100)
    expect(adds()).toHaveLength(0)
  })

  it('enrage at 20 % HP: damage x1.25 once, one line to the players within 60 m', () => {
    const { h, spawnNow, beside, hit, lines, player } = boot({ seed: 16 })
    const m = spawnNow()
    const near = beside(m)
    const far = player(m.pos[0] + UNIQUE_AREA_LINE_M + 30, m.pos[2])
    hit(near.p, m, Math.ceil(m.maxHp * 0.79))
    h.runTo(h.now + 100)
    expect(m.damageMul).toBeUndefined()
    hit(near.p, m, Math.ceil(m.maxHp * 0.02))
    h.runTo(h.now + 100)
    expect(m.damageMul).toBe(1.25)
    m.hp = m.maxHp * 0.5
    h.runTo(h.now + 100)
    m.hp = m.maxHp * 0.1
    h.runTo(h.now + 100)
    expect(m.damageMul).toBe(1.25)
    expect(lines(near.inbox).filter((t) => t === 'Tiger Girl is enraged!')).toHaveLength(1)
    expect(lines(far.inbox).filter((t) => /enraged/.test(t))).toHaveLength(0)
  })

  it('the fury: 600 s after the first damage, damage x2 (x2.5 enraged), one line; a fake clock', () => {
    const { h, u, spawnNow, beside, hit, lines, jump } = boot({ seed: 17 })
    const m = spawnNow()
    const near = beside(m)
    jump(h.now + 5 * MIN) // aggro alone starts nothing
    const t0 = h.now
    hit(near.p, m, 100)
    h.runTo(h.now + 50)
    for (let t = t0 + MIN; t < t0 + 600_000 - MIN; t += MIN) jump(t)
    jump(t0 + 599_000)
    expect(m.ai).toBe('chase')
    expect(m.damageMul).toBeUndefined()
    jump(t0 + 600_100)
    expect(m.damageMul).toBe(2)
    expect(lines(near.inbox).filter((x) => x === 'Tiger Girl grows furious!')).toHaveLength(1)
    hit(near.p, m, Math.ceil(m.hp - m.maxHp * 0.15))
    h.runTo(h.now + 100)
    expect(m.damageMul).toBe(2.5)
    // (that Mob.damageMul scales her swings: unique-seams.test.ts)
    expect(u().row.phase).toBe('alive')
  })

  it('the leash reset: past 50 m she gives up; adds leave, HP full, bands, enrage and fury re-arm', () => {
    const { h, spawnNow, beside, hit, adds, jump, lines } = boot({ seed: 18 })
    const m = spawnNow()
    const near = beside(m)
    hit(near.p, m, Math.ceil(m.maxHp * 0.85))
    h.runTo(h.now + 50)
    jump(h.now + 601_000)
    expect(adds()).toHaveLength(4)
    expect(m.damageMul).toBe(2.5)
    h.world.warp(near.p, m.home[0] + 80, 0, m.home[1], h.now)
    h.runTo(h.now + 2000)
    expect(m.ai).toBe('idle')
    expect(m.hp).toBe(m.maxHp)
    expect(m.damage.size).toBe(0)
    expect(m.damageMul).toBeUndefined()
    expect(adds()).toHaveLength(0)
    expect(h.logs.some((l) => /Tiger Girl reset \(leash\); 4 adds left/.test(l))).toBe(true)
    // A new fight: the bands, the enrage and the fury clock start over.
    h.world.warp(near.p, m.pos[0] + 2, 0, m.pos[2], h.now)
    h.runTo(h.now + 100)
    hit(near.p, m, Math.ceil(m.maxHp * 0.25))
    h.runTo(h.now + 100)
    expect(adds()).toHaveLength(2)
    hit(near.p, m, Math.ceil(m.maxHp * 0.6))
    h.runTo(h.now + 100)
    expect(m.damageMul).toBe(1.25)
    expect(lines(near.inbox).filter((x) => /enraged/.test(x))).toHaveLength(2)
  })

  it('the corpse stays 8 s (a normal mob 3 s)', () => {
    const { h, spawnNow, beside, hit } = boot({ seed: 19 })
    const m = spawnNow()
    const t0 = h.now
    hit(beside(m).p, m, 1e9)
    h.runTo(t0 + 7900)
    expect(h.world.mobs.get(m.id)?.ai).toBe('dead')
    h.runTo(t0 + 8100)
    expect(h.world.mobs.has(m.id)).toBe(false)
  })

  it('EXP: 451,200 at expMul 1 (not tuned down with her HP)', () => {
    const { h, spawnNow, beside, hit } = boot({ seed: 20 })
    const m = spawnNow()
    const { p, inbox } = beside(m)
    hit(p, m, 1e9)
    const gains = h.all(inbox, 'statsDelta').flatMap((d) => (d.gain?.from === m.id ? [d.gain] : []))
    expect(gains[0]).toMatchObject({ exp: 451_200, spExp: 451_200 })
  })
})

// ---- loot ------------------------------------------------------------------------------------------------------

describe('loot (UNIQUES §3.4)', () => {
  it('gear pools: degree 3, wearable at LEVEL_CAP, the highest grades first; Seal of Star from the _RARE rows', () => {
    const pool = gearPool(ITEMS, { degree: 3, maxReqLevel: 'levelCap', gradeWeights: [60, 40] }, 20)
    expect(pool.map((f) => [f.base, f.grades.map((g) => g.code)])).toEqual([
      ['ITEM_CH_M_HEAVY_03_HA', ['ITEM_CH_M_HEAVY_03_HA_A']],
      ['ITEM_CH_RING_03', ['ITEM_CH_RING_03_B', 'ITEM_CH_RING_03_A']],
      ['ITEM_CH_SWORD_03', ['ITEM_CH_SWORD_03_B', 'ITEM_CH_SWORD_03_A']],
    ])
    expect(gearPool(ITEMS, { degree: 3, maxReqLevel: 'levelCap', rare: true }, 20).map((f) => f.grades.map((g) => g.code))).toEqual([['ITEM_CH_SWORD_03_A_RARE']])
    expect(gearPool(ITEMS, { degree: 3, maxReqLevel: 'levelCap' }, 25).find((f) => f.base === 'ITEM_CH_SWORD_03')!.grades.map((g) => g.code)).toEqual(['ITEM_CH_SWORD_03_C', 'ITEM_CH_SWORD_03_B', 'ITEM_CH_SWORD_03_A'])
  })

  it('the table rolls as §3.4: 3 gold piles, 3 gear, 2 elixirs, 10 + 10 potions, powder 50 %, seal 20 %, plus 55/25/15/5', () => {
    const table = resolveDropTable(REAL_FILE.dropTables.UNIQUE_TIGERWOMAN, ITEMS, 20)
    const rng = seeded(42)
    const known = (c: string) => ITEMS.some((i) => i.code === c)
    const plus = [0, 0, 0, 0]
    let powder = 0
    let seal = 0
    let grade = { hi: 0, lo: 0 }
    const N = 2000
    for (let i = 0; i < N; i++) {
      const d = rollUniqueDrops(table, rng, known)
      const gold = d.filter((x) => x.gold)
      expect(gold).toHaveLength(3)
      for (const g of gold) expect(g.count).toBeGreaterThanOrEqual(2000), expect(g.count).toBeLessThanOrEqual(4000)
      const gearDrops = d.filter((x) => GEAR_CODES.has(x.code) && !x.code.endsWith('_RARE'))
      expect(gearDrops).toHaveLength(3)
      for (const x of gearDrops) {
        expect(ITEMS.find((it) => it.code === x.code)!.reqLevel).toBeLessThanOrEqual(20)
        plus[x.plus ?? 0]++
        if (x.code === 'ITEM_CH_SWORD_03_B' || x.code === 'ITEM_CH_RING_03_B') grade.hi++
        if (x.code === 'ITEM_CH_SWORD_03_A' || x.code === 'ITEM_CH_RING_03_A') grade.lo++
      }
      expect(d.filter((x) => x.code.includes('RECIPE'))).toHaveLength(2)
      expect(d.filter((x) => x.code === 'ITEM_ETC_HP_POTION_04' || x.code === 'ITEM_ETC_MP_POTION_04').map((x) => x.count)).toEqual([10, 10])
      const pw = d.filter((x) => x.code === 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03')
      for (const x of pw) expect([1, 2]).toContain(x.count)
      powder += pw.length
      seal += d.filter((x) => x.code.endsWith('_RARE')).length
    }
    const total = plus.reduce((a, b) => a + b, 0)
    expect(total).toBe(3 * N)
    expect(plus[0] / total).toBeCloseTo(0.55, 1)
    expect(plus[1] / total).toBeCloseTo(0.25, 1)
    expect(plus[2] / total).toBeCloseTo(0.15, 1)
    expect(plus[3] / total).toBeGreaterThan(0.03)
    expect(grade.hi / (grade.hi + grade.lo)).toBeCloseTo(0.6, 1)
    expect(powder / N).toBeCloseTo(0.5, 1)
    expect(seal / N).toBeCloseTo(0.2, 1)
  })

  it('the field unique drops her own table, plus levels on the ground, all owned by the loot owner; GOLD_RATE applies', () => {
    const { h, spawnNow, beside, hit } = boot({ seed: 21, config: { goldRate: 2 } })
    const m = spawnNow()
    const { p } = beside(m)
    const g = h.gameplay.uniques!
    const real = g.drops.bind(g)
    let rolled: ReturnType<typeof real> = null
    g.drops = (x, now) => (rolled = real(x, now))
    hit(p, m, 1e9)
    expect(rolled).not.toBeNull()
    const ground = [...h.world.items.values()]
    expect(ground.map((i) => [i.code, i.count, i.plus]).sort()).toEqual(rolled!.map((d) => [d.code, d.count, d.plus ?? 0]).sort())
    expect(ground.every((i) => i.owner === p.id)).toBe(true)
    for (const gold of rolled!.filter((d) => d.gold)) expect(gold.count).toBeGreaterThanOrEqual(4000)
    expect(ground.some((i) => i.code === 'ITEM_ETC_HP_POTION_01')).toBe(false)
  })

  it('plus levels reach the ground items (a forced +3)', () => {
    const { h, spawnNow, beside, hit } = boot({ seed: 22, file: (f) => void (f.dropTables.UNIQUE_TIGERWOMAN.groups[0].plus = [{ plus: 3, weight: 1 }]) })
    const m = spawnNow()
    hit(beside(m).p, m, 1e9)
    const gearOnGround = [...h.world.items.values()].filter((i) => GEAR_CODES.has(i.code) && !i.code.endsWith('_RARE'))
    expect(gearOnGround).toHaveLength(3)
    expect(gearOnGround.every((i) => i.plus === 3)).toBe(true)
  })

  it('the quest encounter and a GM `spawn` of her code are plain mobs: normal loot, no policy, no notice, no timer', () => {
    const { h, u, player, hit, notices, adds } = boot({ seed: 23 })
    const p = player(0, 0)
    const enc = h.gameplay.createMob(MOBS[0], 'unique', 2, 0, 0, null, h.now, null, { hpMul: 0.05, attackMul: 0.8, expMul: 0.1 })
    enc.encounter = { quest: 'JG_025', owners: new Set([p.characterId]), despawnAt: h.now + 600_000 }
    const gmSpawned = h.gameplay.gmSpawn(p.p, MOBS[0], 1, h.now).map((id) => h.world.mobs.get(id)!)[0]
    for (const m of [enc, gmSpawned]) {
      expect(h.gameplay.uniques!.drops(m, h.now)).toBeNull()
      expect(h.gameplay.uniques!.summonPolicy(m)).toBeNull()
      expect(m.corpseMs).toBeUndefined()
      m.hp = m.maxHp * 0.5
    }
    h.runTo(h.now + 100)
    expect(adds()).toHaveLength(0) // MOB_SUMMONS is 0: no policy, no adds
    hit(p.p, enc, 1e9)
    expect([...h.world.items.values()].map((i) => i.code)).toEqual(['ITEM_ETC_HP_POTION_01'])
    expect(notices(p.inbox)).toEqual([])
    expect(u().row).toMatchObject({ phase: 'waiting', spawns: 0 })
  })
})

// ---- GM --------------------------------------------------------------------------------------------------------

describe('/unique (gm.ts) and its audit rows', () => {
  it('list, spawn here / camp, timer, kill, despawn, quiet; every call in gm_audit', () => {
    const { h, u, player, her } = boot({ seed: 24 })
    const gm = player(10, 10)
    const acc = h.store.accountByName('acc1')!
    h.store.setRole(acc.id, 'gm')
    const replies: ServerMessage[] = []
    const conn = { accountId: acc.id, account: acc.username, role: 'gm', player: gm.p, applyRole: () => {}, send: (m: ServerMessage) => replies.push(m), error: () => {} } as unknown as Connection
    const ctx = { world: h.world, gameplay: h.gameplay, setup: h.gameplay.setup, config: h.config, data: h.data, store: h.store, sockets: new Map([[1, conn]]) } as unknown as GameContext
    let runs = 0
    const run = (line: string) => {
      runs++
      const [cmd, ...args] = line.split(' ')
      runGm(ctx, conn, cmd, args, 'chat')
      const r = replies.at(-1) as Msg<'gmResult'>
      return { ok: r.ok, message: r.message, data: r.data as Record<string, unknown> | undefined, audit: h.store.recentAudit(1)[0] }
    }
    expect(COMMANDS.help.run({ ctx, conn, role: 'gm', args: [], self: gm.p }).message).toMatch(/unique list \| spawn <name>/)
    let r = run('unique list')
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/^Tiger Girl \(MOB_CH_TIGERWOMAN\): waiting, spawns in 0:\d\d \(4 camps\)$/)
    expect(r.audit).toMatchObject({ command: 'unique', ok: 1 })
    r = run('unique spawn tiger here')
    expect(r.ok).toBe(true)
    const m = her()!
    expect([m.pos[0], m.pos[2]]).toEqual([10, 10])
    expect(m.home).toEqual([10, 10])
    expect(m.leashRange).toBe(50)
    expect(h.all(gm.inbox, 'uniqueNotice').map((n) => n.event)).toEqual(['appeared'])
    expect(r.audit).toMatchObject({ command: 'unique', args: JSON.stringify(['spawn', 'tiger', 'here']), ok: 1 })
    r = run('unique spawn tiger')
    expect(r).toMatchObject({ ok: false })
    expect(r.audit.ok).toBe(0)
    expect(run('unique list').message).toMatch(/alive \(id \d+\) at camp 5903 \(North-Tiger Mt\.\), HP 100%, not fighting$/)
    r = run('unique timer tiger 5')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/is alive/)
    r = run('unique kill tiger')
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/killed \(not announced\); next spawn in [3-6]:\d\d/)
    expect(h.all(gm.inbox, 'uniqueNotice')).toHaveLength(1)
    expect(run('unique timer tiger 5').message).toBe('Tiger Girl spawns in 0:05.')
    expect(u().row.due_at).toBe(h.now + 5 * MIN)
    expect(run('unique timer tiger clear').ok).toBe(true)
    expect(u().row.due_at - h.now).toBeGreaterThanOrEqual(180 * MIN)
    r = run('unique spawn tiger camp 5906')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not an enabled camp/)
    r = run('unique spawn tiger camp 5904')
    expect(r.ok).toBe(true)
    expect(u().row.camp).toBe(5904)
    expect(run('unique despawn tiger').ok).toBe(true)
    expect(her()).toBeUndefined()
    expect(run('unique quiet on').data).toEqual({ quiet: true })
    expect(run('unique spawn dragon').message).toMatch(/No unique matches "dragon"/)
    expect(run('unique frobnicate').message).toMatch(/^Usage: unique list/)
    const audit = h.store.recentAudit(30).filter((a) => a.command === 'unique')
    expect(audit.length).toBe(runs)
    expect(runs).toBe(14)
  })

  it('UNIQUES=off: /unique says so', () => {
    const { h, player } = boot({ config: { uniques: false } })
    const gm = player(0, 0)
    const ctx = { gameplay: h.gameplay } as unknown as GameContext
    expect(COMMANDS.unique.run({ ctx, conn: {} as never, role: 'gm', args: ['list'], self: gm.p })).toEqual({ ok: false, message: 'Uniques are off on this server (UNIQUES=off).' })
  })

  it('hmm formats h:mm, rounding up', () => {
    expect(hmm(0)).toBe('0:00')
    expect(hmm(1)).toBe('0:01')
    expect(hmm(61 * MIN)).toBe('1:01')
    expect(hmm(-5)).toBe('0:00')
  })
})

// ---- UNIQUES=off and the nest editors --------------------------------------------------------------------------

describe('UNIQUES=off = today; the nest editors never hand the Spawner a unique nest', () => {
  it('off: the Spawner spawns her group as a plain nest mob at once (3 s corpse, her drops.json row, no notices)', () => {
    const { h, player, notices, hit } = boot({ config: { uniques: false } })
    expect(h.gameplay.uniques).toBeNull()
    const tigers = [...h.world.mobs.values()].filter((m) => m.def.code === TG)
    expect(tigers).toHaveLength(1)
    const m = tigers[0]
    expect(PLACEABLE).toContain(m.nest!.id)
    expect(m.maxHp).toBe(598_720)
    expect(m.corpseMs).toBeUndefined()
    const p = player(m.pos[0] + 2, m.pos[2])
    hit(p.p, m, 1e9)
    expect([...h.world.items.values()].map((i) => i.code)).toEqual(['ITEM_ETC_HP_POTION_01'])
    expect(notices(p.inbox)).toEqual([])
    h.runTo(h.now + 3100)
    expect(h.world.mobs.has(m.id)).toBe(false)
  })

  it('on: a /nest edit or `content reload nests` of her camp is refused; her live body is never touched by it', () => {
    const { h, spawnNow, u } = boot({ seed: 25 })
    const m = spawnNow()
    const ctx = { world: h.world, gameplay: h.gameplay, config: h.config } as unknown as GameContext
    const before = h.data.nests.map((n) => ({ ...n }))
    const after = before.map((n) => (n.id === u().row.camp ? { ...n, count: 3, x: n.x + 5 } : n.id === 5906 ? { ...n, enabled: true } : n))
    expect(applyNestDiff(ctx, before, after, h.now)).toBe(2)
    expect(h.gameplay.spawner.nests.some((n) => n.def.uniqueGroup)).toBe(false)
    expect([...h.world.mobs.values()].filter((x) => x.def.code === TG)).toEqual([m])
    expect(h.gameplay.spawner.refusal(after.find((n) => n.id === 5906)!)).toBe(UNIQUE_GROUP_REFUSAL)
  })
})

// ---- the real export -------------------------------------------------------------------------------------------

const DATA = join(REPO_ROOT, 'work/out/data')
const HAVE = ['mobs.json', 'nests.json', 'items.json'].every((f) => existsSync(join(DATA, f)))

describe.skipIf(!HAVE)('content/uniques.json on the real export (work/out/data)', () => {
  const read = <T,>(f: string): T[] => contentEntries<T>(JSON.parse(readFileSync(join(DATA, f), 'utf8')))
  const items = HAVE ? read<ItemDef>('items.json') : []
  const mobs = HAVE ? read<MobDef>('mobs.json') : []
  const nests = HAVE ? read<NestDef>('nests.json') : []

  it('starts clean: her 11 camps, every item known; every gear drop wearable at LEVEL_CAP 20', () => {
    const content = mkdtempSync(join(tmpdir(), 'sro-uniques-real-'))
    cleanups.push(() => rmSync(content, { recursive: true, force: true }))
    mkdirSync(content, { recursive: true })
    writeFileSync(join(content, 'uniques.json'), JSON.stringify(REAL_FILE))
    const data = new GameData({ mobs, items, nests, levels: SKILL_LEVELS, towns: [SAFE_TOWN] })
    const h = skillHarness({ data, config: { contentDir: content, levelCap: 20 } })
    cleanups.push(h.cleanup)
    h.gameplay.start(h.now)
    const g = h.gameplay.uniques!
    expect(g.uniques.map((x) => x.def.mob)).toEqual([TG])
    expect(g.camps(g.uniques[0].def).map((n) => n.id).sort()).toEqual([5656, 5657, 5658, 5659, 5903, 5904, 5905, 5906, 5907, 5908, 5909])
    const table = resolveDropTable(REAL_FILE.dropTables.UNIQUE_TIGERWOMAN, items, 20)
    const byCode = new Map(items.map((i) => [i.code, i]))
    const pool = table.groups[0].pool!
    expect(pool.length).toBeGreaterThan(10)
    for (const f of pool) for (const it of f.grades) expect(it.reqLevel, it.code).toBeLessThanOrEqual(20)
    const rng = seeded(5)
    const plus = [0, 0, 0, 0]
    for (let i = 0; i < 500; i++) {
      for (const d of rollUniqueDrops(table, rng, (c) => byCode.has(c))) {
        if (d.gold) continue
        const def = byCode.get(d.code)!
        expect(def, d.code).toBeDefined()
        if (def.degree === 3 && ['weapon', 'shield', 'armor', 'accessory'].includes(def.category)) {
          expect(def.reqLevel, d.code).toBeLessThanOrEqual(20)
          plus[d.plus ?? 0]++
        }
      }
    }
    expect(plus[0] / plus.reduce((x, y) => x + y, 0)).toBeGreaterThan(0.45)
    expect(plus[3]).toBeGreaterThan(0)
  })
})
