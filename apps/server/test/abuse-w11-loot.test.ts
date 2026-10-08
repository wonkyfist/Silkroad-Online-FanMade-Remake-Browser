/**
 * H-11 adversarial hunt, lens = loot and EXP (docs/WAVE_PLAN7.md §6.6 lens 4): summon-reset farming, unwearable gear,
 * plus levels, the owner window, Berserk, the bell encounter and JG_025.
 *
 * Tests named "BUG:" reproduce a real defect and FAIL until it is fixed; their assertions state the correct behaviour
 * (docs/UNIQUES.md §3.4 / §3.8 / §3.10 and the plan's decisions). The harness is uniques.test.ts' (copied, trimmed) and
 * abuse-quests.test.ts' quest world (copied, trimmed).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HWAN_MAX,
  PROVENANCE_PORT,
  contentEntries,
  type DropTable,
  type ItemDef,
  type MobDef,
  type NestDef,
  type NpcDef,
  type QuestDef,
  type QuestEncounter,
  type QuestFile,
  type ServerMessage,
  type SkillDef,
  type UniquesFile,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay, type GameplayMessage } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { QuestBook } from '../src/quests/book.ts'
import { questRefs } from '../src/quests/engine.ts'
import { SkillBook } from '../src/skills/book.ts'
import { resolveDropTable, rollUniqueDrops } from '../src/uniques.ts'
import { World, type Mob, type Npc, type Player } from '../src/world.ts'
import { ITEMS as BASE_ITEMS, LEVELS, NPCS, SHOPS, item, mob, nest, seeded } from './fixtures.ts'
import { testConfig } from './helpers.ts'
import { MASTERIES, SAFE_TOWN, SKILLS, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const TG = 'MOB_CH_TIGERWOMAN'
const REAL_FILE = JSON.parse(readFileSync(join(REPO_ROOT, 'content/uniques.json'), 'utf8')) as UniquesFile
// The loot mechanics below are checked on degree 3 at a cap of 20 (the fixture gear); the file's pools are degree 4
// since the Climb's D53, so they are put back to degree 3 here.
for (const g of REAL_FILE.dropTables.UNIQUE_TIGERWOMAN!.groups) if (g.pool) g.pool.degree = 3
const DATA = join(REPO_ROOT, 'work/out/data')
const HAVE_ITEMS = existsSync(join(DATA, 'items.json'))

// ---- the uniques world (uniques.test.ts' fixtures, trimmed) ---------------------------------------------------------

const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
function mrow(code: string, o: Partial<SkillDef>): SkillDef {
  return {
    code, id: 1, name: null, mastery: null, masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'melee', castMs: 0, actionMs: 0, cooldownMs: 0,
    range: 0, weapons: [], icon: null, group: code, kind: 'attack', targets: enemy, aniGroup: 'DEFAULT', mob: true, aiChance: 100, ...o,
  } as SkillDef
}
const ROWS: SkillDef[] = ([80, 60, 40] as const).map((band, i) =>
  mrow(`MSKILL_CH_TIGERWOMAN_SUMMON0${i + 1}`, {
    kind: 'buff', category: 'buff', cooldownMs: 500, aiChance: band, targets: { required: false, groups: [] },
    summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 3, max: 6 }],
  }),
)
const still = { walkSpeed: 0, runSpeed: 0 }
const MOBS: MobDef[] = [
  mob(TG, { name: 'Tiger Girl', level: 20, rarity: 'unique', hp: 598_720, exp: 451_200, spExp: 451_200, physAttack: [181, 217], attackRange: 2.8, attackIntervalMs: 3000, radius: 2.8, aggressive: true, skills: ROWS.map((r) => r.code), ...still }),
  mob('MOB_CH_WHITETIGER', { name: 'White Tiger', level: 18, attackRange: 0.9, radius: 1.2, ...still }),
]
const tactics = { id: 9, aggressive: true, sightRange: 14, leashRange: 50 }
const CAMPS: NestDef[] = [nest(5903, TG, 50, -50, { uniqueGroup: TG, respawnSec: [10_800, 21_600], radius: 100, spawnRadius: 60, tactics })]
const gear = (code: string, category: ItemDef['category'], reqLevel: number, over: Partial<ItemDef> = {}) => item(code, { category, degree: 3, reqLevel, race: 'china', ...over })
const GEAR: ItemDef[] = [
  gear('ITEM_CH_SWORD_03_A', 'weapon', 16), gear('ITEM_CH_SWORD_03_B', 'weapon', 18), gear('ITEM_CH_SWORD_03_C', 'weapon', 21),
  gear('ITEM_CH_RING_03_A', 'accessory', 16), gear('ITEM_CH_RING_03_B', 'accessory', 18),
  // The Seal rows as the real items.json has them: every seal tier at the A grade's level (16).
  gear('ITEM_CH_SWORD_03_A_RARE', 'weapon', 16), gear('ITEM_CH_SWORD_03_B_RARE', 'weapon', 16), gear('ITEM_CH_SWORD_03_C_RARE', 'weapon', 16),
]
const LOOT: ItemDef[] = [
  ...['WEAPON', 'ARMOR', 'SHIELD', 'ACCESSARY'].map((k) => item(`ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_${k}_A`, { category: 'alchemy' })),
  item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', { category: 'alchemy', maxStack: 50 }),
  item('ITEM_ETC_HP_POTION_04', { category: 'potion', maxStack: 50 }),
  item('ITEM_ETC_MP_POTION_04', { category: 'potion', maxStack: 50 }),
]
const GEAR_CODES = new Set(GEAR.map((g) => g.code))
const NORMAL_DROPS: DropTable[] = [{ mob: TG, groups: [{ chance: 1, entries: [{ item: 'ITEM_ETC_HP_POTION_01', weight: 1 }] }], provenance: PROVENANCE_PORT }]

function boot(o: { file?: (f: UniquesFile) => void; config?: Record<string, unknown>; seed?: number } = {}) {
  const content = mkdtempSync(join(tmpdir(), 'sro-h11-loot-'))
  cleanups.push(() => rmSync(content, { recursive: true, force: true }))
  const file = structuredClone(REAL_FILE)
  o.file?.(file)
  writeFileSync(join(content, 'uniques.json'), JSON.stringify(file))
  const data = new GameData({ mobs: MOBS, items: [...SKILL_ITEMS, ...GEAR, ...LOOT], levels: SKILL_LEVELS, towns: [SAFE_TOWN], nests: CAMPS.map((n) => ({ ...n })), drops: NORMAL_DROPS })
  const h = skillHarness({ data, book: new SkillBook([...SKILLS, ...ROWS], MASTERIES), config: { contentDir: content, ...o.config } })
  cleanups.push(h.cleanup)
  if (h.gameplay.uniques && o.seed !== undefined) h.gameplay.uniques.rng = seeded(o.seed)
  h.gameplay.start(h.now)
  const her = (): Mob | undefined => [...h.world.mobs.values()].find((m) => m.def.code === TG && m.ai !== 'dead')
  const spawnNow = () => {
    expect(h.gameplay.uniques!.gm(null, ['timer', 'tiger', 'now'], h.now).ok).toBe(true)
    h.runTo(h.now + 100)
    return her()!
  }
  const beside = (m: Mob) => {
    const r = h.hero({ pos: [m.pos[0] + 2, 0, m.pos[2]], level: 20 })
    r.p.maxHp = r.p.hp = 1_000_000
    return r
  }
  const hit = (p: Player, m: Mob, d: number) => h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: d, hp: 0 }], {}, h.now)
  return { h, spawnNow, beside, hit }
}

// ---- 1. the Seal of Star group ---------------------------------------------------------------------------------------

describe('the Seal of Star drop (UNIQUES §3.4: "one degree-3 _A_RARE item (Seal of Star)")', () => {
  it('BUG: the rare group treats the seal letter as a grade: 60 % Seal of Sun (_C_RARE), 40 % Seal of Moon (_B_RARE), never Seal of Star (_A_RARE)', () => {
    // The fixture rows mirror items.json: every _RARE tier needs the A grade's level (16), so all three pass the
    // `reqLevel <= LEVEL_CAP` filter and GRADE_RE's letter sorts C (Sun) first. uniques.test.ts' fixture gives
    // _C_RARE level 21, which hides this.
    const t = resolveDropTable(REAL_FILE.dropTables.UNIQUE_TIGERWOMAN, GEAR, 20)
    const rare = t.groups.find((g) => g.pool && g.pool.some((f) => f.grades.some((x) => x.code.endsWith('_RARE'))))!
    const rng = seeded(11)
    const got = new Map<string, number>()
    for (let i = 0; i < 400; i++) {
      for (const d of rollUniqueDrops({ groups: [{ ...rare, chance: 1 }] }, rng, () => true)) got.set(d.code, (got.get(d.code) ?? 0) + 1)
    }
    // Correct: every Seal drop is a Seal of Star row.
    expect([...got.keys()].filter((c) => !c.endsWith('_A_RARE')), JSON.stringify(Object.fromEntries(got))).toEqual([])
  })

  it.skipIf(!HAVE_ITEMS)('BUG: on the real items.json every one of the 45 seal families picks _C_RARE first (sell price 3.4x the Star row)', () => {
    const items = contentEntries<ItemDef>(JSON.parse(readFileSync(join(DATA, 'items.json'), 'utf8')))
    const t = resolveDropTable(REAL_FILE.dropTables.UNIQUE_TIGERWOMAN, items, 20)
    const rare = t.groups.find((g) => g.pool && g.pool.some((f) => f.grades.some((x) => x.code.endsWith('_RARE'))))!
    expect(rare.pool!.length).toBeGreaterThan(10)
    // grades[0] carries gradeWeights[0] (60 %). Correct: the Star row (or only the Star row) is what drops.
    const firstPicks = rare.pool!.map((f) => f.grades[0].code)
    expect(firstPicks.filter((c) => !c.endsWith('_A_RARE'))).toEqual([])
  })
})

// ---- 2. the drop ring ------------------------------------------------------------------------------------------------

describe('where her loot lands (UNIQUES §3.4: "a ring of 2.5–4 m around the corpse\'s root")', () => {
  it('BUG: her ~13 drops land 1–1.5 m from the root, inside her 2.8 m body (the normal-mob ring)', () => {
    const { h, spawnNow, beside, hit } = boot({ seed: 3 })
    const m = spawnNow()
    const corpse = [...m.pos] as [number, number, number]
    hit(beside(m).p, m, 1e9)
    const ground = [...h.world.items.values()]
    expect(ground.length).toBeGreaterThanOrEqual(10)
    const dist = ground.map((i) => Math.hypot(i.pos[0] - corpse[0], i.pos[2] - corpse[2]))
    // Correct: every drop at 2.5–4 m (clear of the tiger's bulk, still inside the pickup reach of a walk).
    expect(Math.min(...dist)).toBeGreaterThanOrEqual(2.5)
    expect(Math.max(...dist)).toBeLessThanOrEqual(4.01)
  })
})

// ---- 3. plus levels vs the server's plus cap -------------------------------------------------------------------------

describe('plus levels (UNIQUES §3.4) against ALCHEMY_MAX_PLUS', () => {
  it('BUG: the unique table drops +3 gear on a server whose ALCHEMY_MAX_PLUS is 2 (a plus no player can reach there)', () => {
    const { h, spawnNow, beside, hit } = boot({ seed: 4, config: { alchemyMaxPlus: 2 }, file: (f) => void (f.dropTables.UNIQUE_TIGERWOMAN.groups[0].plus = [{ plus: 3, weight: 1 }]) })
    const m = spawnNow()
    hit(beside(m).p, m, 1e9)
    const gearOnGround = [...h.world.items.values()].filter((i) => GEAR_CODES.has(i.code) && !i.code.endsWith('_RARE'))
    expect(gearOnGround.length).toBe(3)
    // Correct: a dropped plus is clipped to the server's ALCHEMY_MAX_PLUS.
    expect(Math.max(...gearOnGround.map((i) => i.plus))).toBeLessThanOrEqual(2)
  })
})

// ---- 4. the bell: a repeatable private unique -------------------------------------------------------------------------

/** JG_025's real bell encounter (content/quests/jangan.json): hpMul 0.05, expMul 0.1, cooldownSec 120. */
const JG = (JSON.parse(readFileSync(join(REPO_ROOT, 'content/quests/jangan.json'), 'utf8')) as QuestFile).quests.find((q) => q.id === 'JG_025')!
const BELL_ENC = (JG.objectives.find((o) => o.id === 'bell') as { encounter: QuestEncounter }).encounter

function questWorld() {
  const root = mkdtempSync(join(tmpdir(), 'sro-h11-bell-'))
  const logs: string[] = []
  const roll = seeded(7)
  const config = { ...testConfig(root, logs), rng: roll }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const TIGER_GIRL = mob(TG, { name: 'Tiger Girl', level: 20, rarity: 'unique', hp: 598_720, exp: 451_200, spExp: 451_200 })
  const data = new GameData({ mobs: [TIGER_GIRL], items: BASE_ITEMS, levels: LEVELS, npcs: [...NPCS, { code: 'NPC_T_GIVER', name: 'Giver', x: 0, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client' } as NpcDef], shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: roll })
  // JG_025's objectives as shipped (its encounter numbers), with a test giver and shrine.
  const q: QuestDef = {
    ...JG, level: 1, giver: 'NPC_T_GIVER', turnIn: 'NPC_T_GIVER', requires: undefined, giveOnAccept: [{ item: 'QITEM_BINDING_BELL', count: 1 }], rewards: { exp: 1, sp: 0, gold: 0 },
    objectives: JG.objectives.map((o) => ({ ...o, ...('location' in o ? { location: 'LOC_SHRINE' } : {}), ...('hint' in o ? { hint: undefined } : {}) })) as QuestDef['objectives'],
  }
  const file: QuestFile = {
    schema: 1, kind: 'quests', id: 'h11', title: 'H11', world: 'jangan',
    items: [{ code: 'QITEM_BINDING_BELL', name: 'Bell' }, { code: 'QITEM_JADE_SEAL', name: 'Seal' }],
    locations: [{ id: 'LOC_SHRINE', name: 'Shrine', x: -100, z: 0, radius: 10 }],
    quests: [q],
  }
  const book = QuestBook.fromFiles([{ name: 'h11.json', json: file }], { refs: questRefs(gameplay) })
  expect(book.files.flatMap((f) => f.issues).filter((i) => i.severity === 'error')).toEqual([])
  gameplay.quests.setContent(book)
  const giver: Npc = { kind: 'npc', id: world.newId(), code: 'NPC_T_GIVER', name: 'Giver', pos: [0, 0, 0], yaw: 0 }
  world.addEntity(giver)
  let n = 0
  const enter = () => {
    const acc = store.createAccount(`h11b${++n}`, 'x')!
    const row = store.createCharacter(acc, `Bell${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4, {})
    if (typeof row === 'string') throw new Error(row)
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: row.level, weapon: row.weapon, pos: [1, 0, 0], yaw: 0, send: (m) => inbox.push(m) })
    p.known.add(giver.id)
    gameplay.sendEnter(p)
    return { p, inbox }
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const act = (p: Player, inbox: ServerMessage[], msg: GameplayMessage, now: number) => {
    gameplay.request(p, msg, now)
    return inbox.filter((m): m is Extract<ServerMessage, { t: 'actionResult' }> => m.t === 'actionResult').at(-1)!
  }
  return { world, gameplay, store, giver, enter, act }
}

describe('the Binding Bell\'s Tiger Girl (UNIQUES §3.2: private, weaker, not the boss) as a farm', () => {
  it(`BUG: rung every ${BELL_ENC.cooldownSec} s, she hands a helper a full Berserk gauge (and ${Math.round(451_200 * (BELL_ENC.expMul ?? 1))} EXP) per kill: 5 gauges in 10 minutes`, () => {
    expect(BELL_ENC).toMatchObject({ hpMul: 0.05, expMul: 0.1, cooldownSec: 120 })
    const w = questWorld()
    const ringer = w.enter()
    const helper = w.enter() // not in the ringer's party: kills each Tiger Girl, so the ringer's kill objective stays open
    const t0 = Date.now()
    expect(w.act(ringer.p, ringer.inbox, { t: 'questAccept', npc: w.giver.id, quest: 'JG_025' }, t0)).toMatchObject({ ok: true })
    w.world.warp(ringer.p, -100, 0, 0)
    w.world.warp(helper.p, -98, 0, 0)
    let fullGauges = 0
    let kills = 0
    for (let k = 0; k < 5; k++) {
      const now = t0 + k * (BELL_ENC.cooldownSec! * 1000 + 1000) + 1
      const r = w.act(ringer.p, ringer.inbox, { t: 'questUseItem', quest: 'JG_025', objective: 'bell' }, now)
      if (!r.ok) continue
      const her = [...w.world.mobs.values()].find((m) => m.encounter?.quest === 'JG_025' && m.ai !== 'dead')!
      w.gameplay.berserk.gm(helper.p, ['0'])
      her.damage.set(helper.p.id, her.maxHp)
      w.gameplay.mobDied(her, now + 500, true)
      kills++
      if (w.gameplay.berserk.points(helper.p) >= HWAN_MAX) fullGauges++
    }
    expect(w.gameplay.quests.logOf(ringer.p).active.get('JG_025')!.counts).toMatchObject({ bell: 1 })
    // The field unique is the scarce full gauge (one per 3–6 h for the server); a normal kill gives 1 point at 12 %.
    expect(kills).toBe(5)
    // Correct: the private quest copy is not a repeatable full-gauge source (either it stops being a Berserk 'unique'
    // or the bell stops re-summoning a killed one): at most one full gauge in these 10 minutes.
    expect(fullGauges).toBeLessThanOrEqual(1)
  })
})
