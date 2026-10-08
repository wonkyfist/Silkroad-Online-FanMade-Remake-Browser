/**
 * The Climb to 25 on the server (docs/CLIMB.md §20 L0/L1; apps/server/src/climb.ts):
 * - startup content: derived monsters and drops, the degree-3 squeeze, the cap-25 curve over levels.json;
 * - the level-difference EXP of a kill (CLIMB on / off), the quest credit of a derived kill as its base, the cap at 25;
 * - the summon remap (Tiger Girl's Guard), the Moon / Sun limit of the rare-weapon roll (RARITY reconciled, D41);
 * - migration 21 and the one-time move of saved characters, on a copy of a schema-20 database;
 * - the GM `climb` command;
 * - the real export (skips without work/out/data): monster levels by band after the remap, the emptied nests, the gear
 *   levels, Tiger Girl's level-25 numbers and her Moon / Sun pools, the skills export to mastery 25.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  CLIMB_BANDS,
  CLIMB_CURVE_VERSION,
  CLIMB_PLACES,
  CLIMB_BOSSES,
  CLIMB_ROSTER,
  DEFAULT_LEVEL_CAP,
  checkClimbLevels,
  climbBandAt,
  climbPlaceAt,
  climbRegionOf,
  contentEntries,
  relevelMob,
  type DropTable,
  type ItemDef,
  type LevelDef,
  type MobDef,
  type ServerMessage,
  type SkillDef,
  type UniquesFile,
} from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyClimbContent, climbGm, convertClimbCharacters, remapClimbNests } from '../src/climb.ts'
import { REPO_ROOT, loadConfig } from '../src/config.ts'
import { migrate, openStore } from '../src/db.ts'
import { layerRepoOverrides } from '../src/editors/overrides.ts'
import { GameData } from '../src/gamedata.ts'
import { gainExp } from '../src/progression.ts'
import { rollRareDrops } from '../src/rarity.ts'
import { gearPool } from '../src/uniques.ts'
import { item, mob, nest } from './fixtures.ts'
import { DUMMY, SKILL_ITEMS, SAFE_TOWN, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sro-climb-'))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

const CONTENT = join(REPO_ROOT, 'content')
const CURVE = (() => {
  const c = checkClimbLevels(JSON.parse(readFileSync(join(CONTENT, 'climb/levels.json'), 'utf8')))
  if (!('exp' in c)) throw new Error(c.problems.join('; '))
  return c.exp
})()
/** A made-up pre-Climb curve (the export's levels.json shape) with masterySp to keep. */
const OLD: LevelDef[] = Array.from({ length: 30 }, (_, i) => ({ level: i + 1, exp: 1000 * (i + 1), masterySp: i + 1 }))

describe('the config', () => {
  it('LEVEL_CAP defaults to 25, MOB_LEVEL_MAX to 30, CLIMB on, RARE_TOP_MIN_LEVEL 25', () => {
    const c = loadConfig({})
    expect(c.levelCap).toBe(25)
    expect(DEFAULT_LEVEL_CAP).toBe(25)
    expect(c.mobLevelMax).toBe(30)
    expect(c.climb).toBe(true)
    expect(c.rareTopMinLevel).toBe(25)
    expect(loadConfig({ CLIMB: 'off' }).climb).toBe(false)
  })
})

describe('applyClimbContent', () => {
  const tiger = mob('MOB_CH_WHITETIGER', { level: 18, hp: 809, skills: ['MSKILL_X'] })
  const chest = item('ITEM_CH_M_HEAVY_03_BA_C', { category: 'armor', degree: 3, reqLevel: 26 })
  const table: DropTable = { mob: tiger.code, gold: { chance: 0.7, amount: [10, 20] }, groups: [{ chance: 0.5, entries: [{ item: 'ITEM_X', weight: 1 }] }], provenance: 'p' as DropTable['provenance'] }
  it('adds the derived monsters and drops, re-spaces the gear (§4.1.2) and lays the curve over the export (masterySp kept)', () => {
    const d = new GameData({ mobs: [tiger], items: [chest], levels: OLD, drops: [table] })
    const logs: string[] = []
    const r = applyClimbContent(d, CONTENT, (l) => logs.push(l))
    expect(r.mobs).toBe(2)
    expect(d.mob('MOB_CL_WHITETIGER_18')).toMatchObject({ base: tiger.code, level: 18, skills: ['MSKILL_X'] })
    expect(d.mob('MOB_CL_TIGERGUARD_24')).toMatchObject({ base: tiger.code, level: 24, hp: 1489 })
    expect(d.drops.get('MOB_CL_TIGERGUARD_24')).toMatchObject({ mob: 'MOB_CL_TIGERGUARD_24', groups: table.groups })
    expect(d.item(chest.code)).toMatchObject({ reqLevel: 21, retailReqLevel: 26 }) // D3 15-21 (D53; the old squeeze was 26 -> 25)
    expect(r.oldNeed.slice(0, 3)).toEqual([1000, 2000, 3000])
    expect(r.levels).toBe(24)
    expect(d.levels.slice(0, 24).map((l) => l.exp)).toEqual(CURVE)
    expect(d.levels[23]).toEqual({ level: 24, exp: 244_000, masterySp: 24 })
    expect(d.levels[24]!.exp).toBe(25_000) // past the curve: the export's row
    expect(d.expToNext(24, 25)).toBe(244_000)
    expect(d.expToNext(25, 25)).toBe(0)
    expect(logs.join('\n')).toMatch(/44 without their base/)
    expect(logs.join('\n')).toMatch(/curve 1 -> 25 = 1,555,570 EXP/)
  })
  it('without the curve file, or with a broken one, the export curve stays (logged)', () => {
    const d = new GameData({ mobs: [tiger], levels: OLD })
    applyClimbContent(d, tmp(), () => {})
    expect(d.levels[0]!.exp).toBe(1000)
    const dir = tmp()
    const bad = join(dir, 'climb')
    mkdirSync(bad)
    writeFileSync(join(bad, 'levels.json'), JSON.stringify({ schema: 1, kind: 'climb-levels', exp: [5, 4] }))
    const logs: string[] = []
    applyClimbContent(d, dir, (l) => logs.push(l))
    expect(d.levels[0]!.exp).toBe(1000)
    expect(logs.join('\n')).toMatch(/skipped .*exp\[1\]/)
  })
})

describe('remapClimbNests', () => {
  it("re-levels nests by their area's band; uniques and derived codes stay", () => {
    const mobs = ['MOB_CH_STONEGHOST', 'MOB_CH_WHITETIGER', 'MOB_CH_TIGERWOMAN'].map((c) => mob(c, { level: 9 }))
    const zones = [{ region: 1, rx: 1, rz: 0, name: 'Chinese Tomb', area: null, continent: null }, { region: 2, rx: 2, rz: 0, name: 'Enterance of Qin-Shi Tomb', area: null, continent: null }, { region: 3, rx: 3, rz: 0, name: 'North-Tiger Mt.', area: null, continent: null }]
    const d = new GameData({
      mobs,
      zones: zones as never,
      nests: [
        nest(1, 'MOB_CH_STONEGHOST', 0, 0, { region: 1 }),
        nest(2, 'MOB_CH_STONEGHOST', 0, 0, { region: 2 }),
        nest(3, 'MOB_CH_WHITETIGER', 0, 0, { region: 3 }),
        nest(4, 'MOB_CH_TIGERWOMAN', 0, 0, { region: 3, uniqueGroup: 'MOB_CH_TIGERWOMAN' }),
        nest(5, 'MOB_CL_RESTLESS_15', 0, 0, { region: 2 }),
      ],
    })
    applyClimbContent(d, undefined, () => {})
    expect(remapClimbNests(d, () => {})).toBe(3)
    expect(d.nests.map((n) => [n.mob, n.level])).toEqual([
      ['MOB_CL_STONEGHOST_9', 9], ['MOB_CL_SENTINEL_13', 13], ['MOB_CL_WHITETIGER_18', 18], ['MOB_CH_TIGERWOMAN', undefined], ['MOB_CL_RESTLESS_15', undefined],
    ])
  })
})

// ---- a Gameplay on fixtures (skills-fixtures' harness) --------------------------------------------------------------

const LEVELS25: LevelDef[] = CURVE.map((exp, i) => ({ level: i + 1, exp, masterySp: 1 }))
function harness(climb: boolean) {
  const data = new GameData({ mobs: [DUMMY, mob('MOB_CH_WHITETIGER', { level: 18, hp: 809 })], items: SKILL_ITEMS, levels: LEVELS25, towns: [SAFE_TOWN] })
  applyClimbContent(data, undefined, () => {})
  const h = skillHarness({ data, config: { climb, levelCap: 25, rng: () => 0.99 } })
  cleanups.push(h.cleanup)
  return h
}
const lastGain = (inbox: ServerMessage[]) => inbox.filter((m): m is Extract<ServerMessage, { t: 'statsDelta' }> => m.t === 'statsDelta' && !!m.gain).at(-1)?.gain

describe('a kill with the Climb', () => {
  const kill = (h: ReturnType<typeof harness>, level: number, mobLevel: number, exp = 1000) => {
    const hero = h.hero({ level })
    const m = h.dummy(1, 1, { level: mobLevel, exp, spExp: exp, hp: 10 })
    m.damage.set(hero.p.id, 10)
    h.gameplay.mobDied(m, h.now, true)
    return lastGain(hero.inbox)
  }
  it('the level rule: -15 % a level from 2 below, +5 % a level above (at most +15 %); EXP and SP-EXP alike', () => {
    const h = harness(true)
    expect(kill(h, 10, 10)).toMatchObject({ exp: 1000, spExp: 1000 })
    expect(kill(h, 11, 10)).toMatchObject({ exp: 1000 })
    expect(kill(h, 12, 10)).toMatchObject({ exp: 850, spExp: 850 })
    expect(kill(h, 15, 10)).toMatchObject({ exp: 400 })
    expect(kill(h, 24, 1)).toMatchObject({ exp: 100 })
    expect(kill(h, 10, 12)).toMatchObject({ exp: 1100 })
    expect(kill(h, 10, 20)).toMatchObject({ exp: 1150 })
  })
  it('CLIMB=off: no level rule', () => {
    const h = harness(false)
    expect(kill(h, 15, 10)).toMatchObject({ exp: 1000 })
  })
  it('a derived kill also reaches the quest engine as its base (retail kill objectives count it)', () => {
    const h = harness(true)
    const spy = vi.spyOn(h.gameplay.quests, 'mobDied')
    const hero = h.hero({ level: 18 })
    const m = h.gameplay.createMob(h.data.mob('MOB_CL_WHITETIGER_18')!, 'normal', 2, 2, 0, null, h.now)
    m.damage.set(hero.p.id, 10)
    h.gameplay.mobDied(m, h.now, true)
    expect(spy.mock.calls.map((c) => c[0].def.code)).toEqual(['MOB_CL_WHITETIGER_18', 'MOB_CH_WHITETIGER'])
    expect(spy.mock.calls[1]![0].id).toBe(m.id)
    expect([...spy.mock.calls[1]![2]]).toEqual([hero.p.id])
    // a retail kill: once
    spy.mockClear()
    const r = h.gameplay.createMob(h.data.mob('MOB_CH_WHITETIGER')!, 'normal', 3, 3, 0, null, h.now)
    r.damage.set(hero.p.id, 10)
    h.gameplay.mobDied(r, h.now, true)
    expect(spy.mock.calls.map((c) => c[0].def.code)).toEqual(['MOB_CH_WHITETIGER'])
  })
  it('the cap is 25: a level-24 character fills the last bar, reaches 25 and keeps no EXP there', () => {
    const h = harness(true)
    const hero = h.hero({ level: 24 })
    h.gameplay.reward(hero.p, 243_999, 0)
    expect(hero.p.progress).toMatchObject({ level: 24, exp: 243_999 })
    h.gameplay.reward(hero.p, 500_000, 400)
    expect(hero.p.progress).toMatchObject({ level: 25, exp: 0 })
    h.gameplay.reward(hero.p, 500_000, 400)
    expect(hero.p.progress).toMatchObject({ level: 25, exp: 0 })
    expect(h.gameplay.data.expToNext(25, 25)).toBe(0)
    // the progression rule on the curve alone: 1 -> 25 is exactly the curve's total
    const p = { level: 1, exp: 0, sp: 0, spExp: 0, str: 20, int: 20, statPoints: 0 }
    expect(gainExp(p, 1_555_569, 0, 25, (l) => CURVE[l - 1] ?? 0)).toBe(23)
    expect(gainExp(p, 1, 0, 25, (l) => CURVE[l - 1] ?? 0)).toBe(1)
    expect(p).toMatchObject({ level: 25, exp: 0 })
  })
  it("GM setlevel goes to 25 and not past it (the default cap)", async () => {
    const { COMMANDS } = await import('../src/gm.ts')
    expect(COMMANDS.setlevel!.usage).toMatch(/setlevel/)
    const h = harness(true)
    h.hero({ name: 'Climber' })
    const ctx = { config: h.config, store: h.store, gameplay: h.gameplay, sockets: new Map(), world: h.world } as never
    const run = (args: string[]) => COMMANDS.setlevel!.run({ ctx, role: 'admin', args, conn: { account: 'gm' } } as never)
    expect(run(['Climber', '25'])).toMatchObject({ ok: true })
    expect(h.store.characterByName('Climber')!.level).toBe(25)
    expect(run(['Climber', '26'])).toMatchObject({ ok: false, message: expect.stringMatching(/1 to 25/) })
  })
})

describe("Tiger Girl's summons (§2.6)", () => {
  it('a summon policy with `mobs` spawns the Guard instead of the row\'s White Tigers', () => {
    const h = harness(true)
    const row = { code: 'MSKILL_T_SUMMON', summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 2, max: 2 }] } as SkillDef
    const her = h.dummy(5, 5, { code: 'MOB_CH_TIGERWOMAN', rarity: 'unique' })
    const ms = h.gameplay.mobSkills as unknown as { state(m: unknown): unknown; summon(m: unknown, s: unknown, row: SkillDef, now: number, policy: unknown): number[] }
    const ids = ms.summon(her, ms.state(her), row, h.now, { on: true, perWave: 2, maxAlive: 4, variants: ['normal'], mobs: { MOB_CH_WHITETIGER: 'MOB_CL_TIGERGUARD_24' } })
    expect(ids.map((id) => h.world.mobs.get(id)!.def.code)).toEqual(['MOB_CL_TIGERGUARD_24', 'MOB_CL_TIGERGUARD_24'])
    expect(h.world.mobs.get(ids[0]!)!.level).toBe(24)
    const plain = ms.summon(h.dummy(9, 9, { code: 'MOB_CH_TIGERWOMAN', rarity: 'unique' }), ms.state(her), row, h.now, { on: true, perWave: 1 })
    expect(plain.map((id) => h.world.mobs.get(id)!.def.code)).toEqual(['MOB_CH_WHITETIGER'])
    // a remap target this world lacks (CLIMB=off: no MOB_CL_* rows) summons the row's own monster
    const off = ms.summon(h.dummy(12, 12, { code: 'MOB_CH_TIGERWOMAN', rarity: 'unique' }), ms.state(her), row, h.now, { on: true, perWave: 1, mobs: { MOB_CH_WHITETIGER: 'MOB_CL_NOT_HERE' } })
    expect(off.map((id) => h.world.mobs.get(id)!.def.code)).toEqual(['MOB_CH_WHITETIGER'])
  })
})

describe('rare weapons and the Climb (docs/RARITY.md reconciled with CLIMB §4.1, D41, D53: the cap tier is degree 4)', () => {
  const codes = ['01', '03', '04'].flatMap((d) => ['A', 'A_RARE', 'B_RARE', 'C_RARE'].map((g) => `ITEM_CH_SWORD_${d}_${g}`))
  const items = new Map<string, ItemDef>(codes.map((c) => [c, item(c, { category: 'weapon', degree: Number(c.slice(14, 16)), reqLevel: 16 })]))
  const sun = { starPct: 0, moonPct: 0, sunPct: 100 }
  const moon = { starPct: 0, moonPct: 100, sunPct: 0 }
  const roll = (code: string, rates: typeof sun, mobLevel: number, minLevel = 25) => rollRareDrops([{ code, count: 1 }], () => 0.1, rates, (c) => items.get(c), { mobLevel, minLevel })[0]!.code
  it('a degree-4 (cap-tier) weapon comes as Moon or Sun only from a level-25 monster; below, the roll is a Seal of Star', () => {
    expect(roll('ITEM_CH_SWORD_04_A', sun, 25)).toBe('ITEM_CH_SWORD_04_C_RARE')
    expect(roll('ITEM_CH_SWORD_04_A', moon, 25)).toBe('ITEM_CH_SWORD_04_B_RARE')
    expect(roll('ITEM_CH_SWORD_04_A', sun, 24)).toBe('ITEM_CH_SWORD_04_A_RARE')
    expect(roll('ITEM_CH_SWORD_04_A', moon, 21)).toBe('ITEM_CH_SWORD_04_A_RARE')
    expect(roll('ITEM_CH_SWORD_04_A', sun, 21, 0)).toBe('ITEM_CH_SWORD_04_C_RARE')
  })
  it('degrees 1-3 keep the RARITY rates at any level (degree 3 is mid-tier now)', () => {
    expect(roll('ITEM_CH_SWORD_03_A', sun, 16)).toBe('ITEM_CH_SWORD_03_C_RARE')
    expect(roll('ITEM_CH_SWORD_03_A', moon, 20)).toBe('ITEM_CH_SWORD_03_B_RARE')
    expect(roll('ITEM_CH_SWORD_01_A', sun, 3)).toBe('ITEM_CH_SWORD_01_C_RARE')
  })
  it('D54: a degree-3 Moon or Sun only from a monster of level 21 and up (RARE_MID_MIN_LEVEL); a Star anywhere', () => {
    const mid = (code: string, rates: typeof sun, mobLevel: number) => rollRareDrops([{ code, count: 1 }], () => 0.1, rates, (c) => items.get(c), { mobLevel, minLevel: 25, midMinLevel: 21 })[0]!.code
    expect(mid('ITEM_CH_SWORD_03_A', sun, 20)).toBe('ITEM_CH_SWORD_03_A_RARE')
    expect(mid('ITEM_CH_SWORD_03_A', moon, 14)).toBe('ITEM_CH_SWORD_03_A_RARE')
    expect(mid('ITEM_CH_SWORD_03_A', sun, 21)).toBe('ITEM_CH_SWORD_03_C_RARE')
    expect(mid('ITEM_CH_SWORD_03_A', { starPct: 100, moonPct: 0, sunPct: 0 }, 5)).toBe('ITEM_CH_SWORD_03_A_RARE')
    expect(mid('ITEM_CH_SWORD_01_A', sun, 3)).toBe('ITEM_CH_SWORD_01_C_RARE')
    expect(mid('ITEM_CH_SWORD_04_A', sun, 24)).toBe('ITEM_CH_SWORD_04_A_RARE')
  })
  it('the top degree is a parameter (a catalog whose top is degree 3 keeps the old rule)', () => {
    const r = rollRareDrops([{ code: 'ITEM_CH_SWORD_03_A', count: 1 }], () => 0.1, sun, (c) => items.get(c), { mobLevel: 20, minLevel: 25, degree: 3 })
    expect(r[0]!.code).toBe('ITEM_CH_SWORD_03_A_RARE')
  })
})

// ---- migration 21 and the move of saved characters ------------------------------------------------------------------

describe('migration 21 on a copy of a schema-20 database', () => {
  it('adds curve_version; the first climb start moves every character once (20s to 0 %, the rest by bar fraction)', () => {
    const dir = tmp()
    const raw = new Database(join(dir, 'game.db'))
    expect(migrate(raw, 20)).toBe(20)
    raw.prepare("INSERT INTO accounts (id, username, password_hash, created_at) VALUES (1, 'pioneer', 'x', 0)").run()
    const add = raw.prepare("INSERT INTO characters (account_id, name, model, weapon, world, created_at, level, exp, sp, sp_exp) VALUES (1, ?, 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 0, ?, ?, ?, ?)")
    // the retail bars of 1, 15, 19 and 20 (the pre-Climb curve the live characters were saved under)
    add.run('Rookie', 1, 59, 3, 100)
    add.run('Middle', 15, 48_469, 700, 50)
    add.run('Almost', 19, 238_877, 2000, 10)
    add.run('Capped', 20, 0, 2600, 399)
    raw.close()

    const store = openStore(dir)
    cleanups.push(() => store.close())
    expect(store.schemaVersion).toBe(24)
    const before = store.db.prepare('SELECT name, level, exp, sp, sp_exp, curve_version FROM characters ORDER BY id').all()
    expect(before.map((r: any) => r.curve_version)).toEqual([0, 0, 0, 0])
    const retail: Record<number, number> = { 1: 118, 15: 96_938, 19: 238_878, 20: 282_000 }
    const logs: string[] = []
    expect(convertClimbCharacters(store.db, (l) => retail[l] ?? 0, (l) => CURVE[l - 1] ?? 0, (l) => logs.push(l))).toBe(4)
    const after = store.db.prepare('SELECT name, level, exp, sp, sp_exp, curve_version FROM characters ORDER BY id').all()
    expect(after).toEqual([
      { name: 'Rookie', level: 1, exp: 890, sp: 3, sp_exp: 100, curve_version: 1 },
      { name: 'Middle', level: 15, exp: 29_800, sp: 700, sp_exp: 50, curve_version: 1 },
      { name: 'Almost', level: 19, exp: 104_999, sp: 2000, sp_exp: 10, curve_version: 1 },
      { name: 'Capped', level: 20, exp: 0, sp: 2600, sp_exp: 399, curve_version: 1 },
    ])
    expect(logs.join('\n')).toMatch(/4 characters moved .*1 at level 20/)
    // once only: a second start (and a new character made on the curve) moves nothing
    expect(convertClimbCharacters(store.db, (l) => retail[l] ?? 0, (l) => CURVE[l - 1] ?? 0, () => {})).toBe(0)
    store.setNewCharacterCurve(CLIMB_CURVE_VERSION)
    const fresh = store.createCharacter(1, 'Fresh', 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 8)
    expect(typeof fresh === 'object' && fresh.curve_version).toBe(1)
    expect(convertClimbCharacters(store.db, () => 1, () => 2, () => {})).toBe(0)
  })
  it('a fresh database is at schema 21 and new characters start at curve 0 until the server sets the curve', () => {
    const store = openStore(tmp())
    cleanups.push(() => store.close())
    expect(store.schemaVersion).toBe(24)
    const acc = store.createAccount('a1', 'x')!
    const c = store.createCharacter(acc, 'Zero', 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 4)
    expect(typeof c === 'object' && c.curve_version).toBe(0)
  })
})

describe('GM climb', () => {
  const d = new GameData({ mobs: [mob('MOB_CH_WHITETIGER', { level: 18, hp: 809 })], levels: LEVELS25 })
  applyClimbContent(d, undefined, () => {})
  const run = (args: string[], climb = true) => climbGm({ data: d, config: { levelCap: 25, climb }, nests: () => 7 }, args)
  it('summarises the cap, the curve and the roster', () => {
    const r = run([])
    expect(r).toMatchObject({ ok: true, data: { climb: true, levelCap: 25, curveTotal: 1_555_570, derived: 2, nests: 7 } })
    expect(r.message).toMatch(/B8 22-25/)
    expect(run([], false).message).toMatch(/OFF/)
  })
  it('a derived row against its base; the level rule', () => {
    expect(run(['mob', 'mob_cl_tigerguard_24'])).toMatchObject({ ok: true, data: { code: 'MOB_CL_TIGERGUARD_24', level: 24, hp: 1489, base: 'MOB_CH_WHITETIGER' } })
    expect(run(['mob', 'MOB_CH_WHITETIGER']).message).toMatch(/derived rows: MOB_CL_WHITETIGER_18 \(18\), MOB_CL_TIGERGUARD_24 \(24\)/)
    expect(run(['mob', 'MOB_NONE'])).toMatchObject({ ok: false })
    expect(run(['exp', '15', '10'])).toMatchObject({ ok: true, data: { mul: expect.closeTo(0.4, 5) } })
    expect(run(['exp', 'x', '10'])).toMatchObject({ ok: false })
    expect(run(['nope'])).toMatchObject({ ok: false })
  })
})

// ---- the real export ------------------------------------------------------------------------------------------------

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = ['data/mobs.json', 'data/nests.json', 'data/zones.json', 'data/items.json'].every((f) => existsSync(join(OUT, f)))

describe.skipIf(!HAVE)('the Climb on the real export', () => {
  const d = GameData.load(OUT)
  const exported = d.nests.map((n) => ({ ...n }))
  const climb = applyClimbContent(d, CONTENT, () => {})
  const logs: string[] = []
  layerRepoOverrides(d, CONTENT, 'jangan', (l) => logs.push(l))
  remapClimbNests(d, () => {})
  const jangan = d.nests.filter((n) => n.world === 'jangan')
  const areaOf = (n: { region?: number }) => (n.region !== undefined ? (d.zones.get(n.region)?.name ?? null) : null)
  const bandOf = (n: { region?: number }) => climbBandAt(areaOf(n), climbRegionOf(n.region))
  const placeOf = (n: { region?: number }) => climbPlaceAt(climbRegionOf(n.region))?.name ?? areaOf(n)

  it('every derived row has its base; the repo overrides apply cleanly', () => {
    expect(climb.mobs).toBe(CLIMB_ROSTER.length + CLIMB_BOSSES.length)
    expect(logs.join('\n')).not.toMatch(/skipped/)
    expect(logs.join('\n')).toMatch(/nests-override|patched/)
  })
  it('no field nest above 25: every spawnable Jangan nest holds a derived monster (or a unique group)', () => {
    for (const n of jangan) {
      if (n.uniqueGroup) continue
      expect(n.mob, `nest ${n.id} (${areaOf(n)})`).toMatch(/^MOB_CL_/)
      expect(d.mob(n.mob)!.level, `nest ${n.id}`).toBeLessThanOrEqual(25)
    }
  })
  it("monster levels by band: each place's nests sit in its band's levels (B5's Chakji Workers and the forest-edge Yeoha are §2.2's named fallbacks)", () => {
    const off: string[] = []
    for (const n of jangan) {
      if (n.uniqueGroup) continue
      const band = bandOf(n)
      const lv = d.mob(n.mob)!.level
      if (band && (lv < band.levels[0] - 2 || lv > band.levels[1])) off.push(`${placeOf(n)} ${n.mob}`)
    }
    // the fallbacks of §2.2 rule 1: forest-edge Yeoha in the Grassland (B3 rows), the Lake Forest's low monsters (B1 rows),
    // the Hill of Ye's stone ghosts (B2 rows), 10 Chakji Workers on North-Tiger (B7's 19)
    const allowed = /^(Grassland MOB_CL_(YEOHA_10|DECAYED_10)|Lake Forest MOB_CL_(MANGNYANG_1|SMALLEYE_2)|Hill of Ye Mt\. MOB_CL_(BROKENSTONE_8|STONEGHOST_9|TOMBGHOST_8)|North-Tiger Mt\. MOB_CL_CHAKJIWORKER_19|Swamp area MOB_CL_DECAYED_10)$/
    expect(off.filter((o) => !allowed.test(o))).toEqual([])
    // the high country (2026-10-10): B7 holds 19-23, the top band 24-25 with the level-25 monsters
    const lv = (id: string) => jangan.filter((n) => !n.uniqueGroup && bandOf(n)?.id === id).map((n) => d.mob(n.mob)!.level)
    expect(new Set(lv('B7'))).toEqual(new Set([19, 20, 21, 22, 23]))
    expect(Math.min(...lv('B8'))).toBeGreaterThanOrEqual(24)
    expect(lv('B8')).toContain(25)
  })
  it('the emptied nests: every x-155 canyon nest, Hyeongcheon 30 and every nest of the drowned Western China side are gone', () => {
    expect(exported.filter((n) => n.mob === 'MOB_WC_HYEONGCHEON').length).toBeGreaterThan(0)
    expect(d.nests.some((n) => n.mob === 'MOB_WC_HYEONGCHEON')).toBe(false)
    expect(d.nests.filter((n) => n.region !== undefined && (n.region & 255) <= 155)).toEqual([])
    // the far bank is open sea (docs/COAST.md §4.1): nothing at x 156-161 north of the strait (z >= 98)
    const far = d.nests.filter((n) => n.world === 'jangan' && n.region !== undefined && (n.region & 255) <= 161 && n.region >> 8 >= 98)
    expect(far.map((n) => `${n.id} ${n.region! & 255},${n.region! >> 8}`)).toEqual([])
    // the Western China roster lives on the island's west heights now
    const cliffs = jangan.filter((n) => climbPlaceAt(climbRegionOf(n.region))?.name === 'The Sea Cliffs' && !n.uniqueGroup)
    expect(new Set(cliffs.map((n) => n.mob))).toEqual(new Set(['MOB_CL_EARTHGHOST_25', 'MOB_CL_POWDER_24', 'MOB_CL_TAOIST_25', 'MOB_CL_HYUNGNOSHAMAN_24']))
  })
  it("per-nest overrides: the old graves' Broken Stone Ghosts, the Restless Tomb Stones, the Robbers' Camp, the Sea Cliffs' casters; the B4 border is passive", () => {
    const count = (code: string) => d.nests.filter((n) => n.mob === code).length
    for (const c of ['MOB_CL_BROKENSTONE_8', 'MOB_CL_RESTLESS_15', 'MOB_CL_YEOHA_13', 'MOB_CL_POWDER_24']) expect(count(c), c).toBeGreaterThan(0)
    expect(d.nests.filter((n) => n.mob === 'MOB_CL_BROKENSTONE_8' && areaOf(n) === 'Chinese Tomb').length).toBe(10)
    const b4 = d.nests.filter((n) => areaOf(n) === 'Enterance of Qin-Shi Tomb')
    const low = d.nests.filter((n) => (bandOf(n)?.id ?? '') <= 'B2' && bandOf(n))
    for (const n of b4) if (low.some((m) => Math.hypot(n.x - m.x, n.z - m.z) < 100)) expect(n.tactics.aggressive, `nest ${n.id}`).toBe(false)
  })
  it('gear (§4.1.2, D53): four degrees inside the cap, degree 4 at 21-25 with its seals, grades ordered, nothing past 25', () => {
    const ch = [...d.items.values()].filter((i) => /^ITEM_CH_/.test(i.code) && i.category !== 'alchemy')
    const d4 = ch.filter((i) => i.degree === 4)
    expect(d4.length).toBe(306)
    expect(d4.filter((i) => /_RARE$/.test(i.code)).length).toBe(153)
    expect(Math.max(...ch.map((i) => i.reqLevel))).toBe(25)
    for (const [deg, lo, hi] of [[1, 1, 8], [2, 8, 15], [3, 15, 21], [4, 21, 25]] as const) {
      const lv = ch.filter((i) => i.degree === deg && !/_DEF$/.test(i.code)).map((i) => i.reqLevel)
      expect([Math.min(...lv), Math.max(...lv)], `degree ${deg}`).toEqual([lo, hi])
    }
    for (const i of ch) {
      const m = /^(.*)_([BC])$/.exec(i.code)
      const lower = m ? d.items.get(`${m[1]}_${m[2] === 'B' ? 'A' : 'B'}`) : undefined
      if (lower) expect(lower.reqLevel, i.code).toBeLessThanOrEqual(i.reqLevel)
    }
    // D3 is mid-tier: its grade C 18-21; D4 grade C the top normal tier 23-25; seals at their letter's grade level
    expect(new Set(ch.filter((i) => /_03_(\w\w_)?C$/.test(i.code)).map((i) => i.reqLevel))).toEqual(new Set([18, 19, 20, 21]))
    expect(new Set(d4.filter((i) => /_C$/.test(i.code)).map((i) => i.reqLevel))).toEqual(new Set([23, 24, 25]))
    expect(['A', 'B', 'C'].map((g) => d.items.get(`ITEM_CH_BLADE_04_${g}_RARE`)!.reqLevel)).toEqual([21, 22, 23])
    expect(d.items.get('ITEM_CH_M_HEAVY_04_BA_C')).toMatchObject({ reqLevel: 25, retailReqLevel: 34 })
    // models and icons came with the export
    for (const c of ['ITEM_CH_TBLADE_04_C', 'ITEM_CH_SHIELD_04_B', 'ITEM_CH_W_LIGHT_04_BA_A']) expect(d.items.get(c)!.model, c).not.toBeNull()
    expect(d.items.get('ITEM_CH_NECKLACE_04_C')!.icon).toBe('/out/icon/item/china/acc/necklace_04.png')
  })
  it('drops by band (§4.4, D53): from level 21 the derived rows drop degree 4 (the 21-23 rows half and half with their 03_C); below, their retail degree 3', () => {
    const gear = (mob: string) => new Set((d.drops.get(mob)?.groups ?? []).flatMap((g) => g.entries.map((e) => e.item)).filter((c) => /^ITEM_CH_/.test(c)).map((c) => c.match(/_0(\d)(?:_\w\w)?_([ABC])$/)!.slice(1).join('')))
    expect(gear('MOB_CL_CHAKJI_20')).toEqual(new Set(['3B']))
    for (const m of ['MOB_CL_GHOSTBUG_21', 'MOB_CL_DEVILBUG_22', 'MOB_CL_HYUNGNO_23']) expect(gear(m), m).toEqual(new Set(['3C', '4A']))
    expect(gear('MOB_CL_HYUNGNOSHAMAN_24')).toEqual(new Set(['4A']))
    expect(gear('MOB_CL_EARTHGHOST_25')).toEqual(new Set(['4B']))
    expect(gear('MOB_CL_TAOIST_25')).toEqual(new Set(['4C']))
    expect(d.items.has('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_04')).toBe(true)
  })
  it("Tiger Girl at 25: 107,770 HP, 253-304 attack, 90,240 EXP; her Guard 24; Moon and Sun pools resolve at the cap", () => {
    const file = JSON.parse(readFileSync(join(CONTENT, 'uniques.json'), 'utf8')) as UniquesFile
    const u = file.uniques[0]!
    const her = relevelMob(d.mob(u.mob)!, u.level!)
    expect(her.level).toBe(25)
    expect(Math.round(her.hp * u.tuning.hpMul)).toBe(107_770)
    expect(her.physAttack.map((a) => Math.round(a * u.tuning.attackMul))).toEqual([253, 304])
    expect(Math.round(her.exp * u.tuning.expMul)).toBe(90_240)
    expect(her.hitRate).toBe(d.mob(u.mob)!.hitRate + 10)
    expect(d.mob('MOB_CL_TIGERGUARD_24')).toMatchObject({ level: 24, hp: 1489 })
    const moon = gearPool(d.items.values(), { degree: 4, maxReqLevel: 'levelCap', rare: true, seal: 'moon' }, 25)
    const sun = gearPool(d.items.values(), { degree: 4, maxReqLevel: 'levelCap', rare: true, seal: 'sun' }, 25)
    expect(moon.length).toBeGreaterThan(0)
    expect(moon.flatMap((f) => f.grades.map((g) => g.code)).every((c) => c.endsWith('_B_RARE'))).toBe(true)
    expect(sun.flatMap((f) => f.grades.map((g) => g.code)).every((c) => c.endsWith('_C_RARE'))).toBe(true)
    const plain = gearPool(d.items.values(), { degree: 4, maxReqLevel: 'levelCap' }, 25).flatMap((f) => f.grades.map((g) => g.code))
    expect(plain).toContain('ITEM_CH_M_HEAVY_04_BA_C')
    expect(u.tuning).toMatchObject({ hpMul: 0.18, attackMul: 1.4 })
  })
  it('the skills export reaches mastery 25 (MAX_SKILL_MASTERY_LEVEL), never past it', () => {
    const skills = contentEntries<SkillDef>(JSON.parse(readFileSync(join(OUT, 'data/skills.json'), 'utf8')), 'skills').filter((s) => !s.mob)
    const top = Math.max(...skills.map((s) => s.masteryLevel))
    expect(top).toBe(25)
    for (let m = 21; m <= 25; m++) expect(skills.some((s) => s.masteryLevel === m), `mastery ${m}`).toBe(true)
  })
  it("every band's areas exist in zones.json; every high-country place is Tiger Mountain land inside the play bounds", () => {
    const names = new Set([...d.zones.values()].map((z) => z.name?.toLowerCase()))
    for (const b of CLIMB_BANDS) for (const a of b.areas) expect(names.has(a.toLowerCase()), a).toBe(true)
    for (const p of CLIMB_PLACES) {
      for (let rx = p.x[0]; rx <= p.x[1]; rx++) {
        for (let rz = p.z[0]; rz <= p.z[1]; rz++) {
          expect(d.zones.get((rz << 8) | rx)?.name, `${p.name} ${rx},${rz}`).toMatch(/^((North|South)-Tiger Mt.*)?$/) // (156, 95) is nameless
          expect(rx >= 156 && rx <= 174 && rz >= 90 && rz <= 102, `${p.name} ${rx},${rz} in bounds`).toBe(true)
        }
      }
      // and they hold nests to fight
      expect(jangan.filter((n) => climbPlaceAt(climbRegionOf(n.region)) === p && !n.uniqueGroup).length, p.name).toBeGreaterThan(20)
    }
  })
})
