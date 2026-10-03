/**
 * H-11 hunt, lens "fury and leash griefing" (docs/WAVE_PLAN7.md §6.6 item 5; docs/UNIQUES.md §3.6, §10).
 *
 * Each `it` here is a finding: it states the spec's behaviour and fails on today's code. The fixtures are a compact copy of
 * uniques.test.ts (Tiger Girl who cannot walk, so every goHome is the instant warp-home path; one camp; the shipped
 * content/uniques.json).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type MobDef, type NestDef, type SkillDef, type UniquesFile } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { SkillBook } from '../src/skills/book.ts'
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

const ROWS: SkillDef[] = ([80, 60, 40] as const).map(
  (band, i) =>
    ({
      code: `MSKILL_CH_TIGERWOMAN_SUMMON0${i + 1}`, id: 1, name: null, mastery: null, masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'buff', castMs: 0, actionMs: 0,
      cooldownMs: 500, range: 0, weapons: [], icon: null, group: `SUMMON0${i + 1}`, kind: 'buff', targets: { required: false, groups: [] }, aniGroup: 'DEFAULT', mob: true, aiChance: band,
      summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 3, max: 6 }],
    }) as SkillDef,
)
const still = { walkSpeed: 0, runSpeed: 0 }
const MOBS: MobDef[] = [
  mob(TG, { name: 'Tiger Girl', level: 20, rarity: 'unique', hp: 598_720, exp: 451_200, spExp: 451_200, physAttack: [181, 217], attackRange: 2.8, attackIntervalMs: 3000, radius: 2.8, aggressive: true, skills: ROWS.map((r) => r.code), ...still }),
  mob('MOB_CH_WHITETIGER', { name: 'White Tiger', level: 18, attackRange: 0.9, radius: 1.2, ...still }),
]
/** Every item the shipped table names (so the start check passes). */
const LOOT = [...new Set(REAL_FILE.dropTables.UNIQUE_TIGERWOMAN.groups.flatMap((g) => (g.entries ?? []).map((e) => e.item)))].map((c) => item(c, { category: 'alchemy', maxStack: 50 }))
const CAMP: NestDef = nest(5903, TG, 50, -50, { uniqueGroup: TG, respawnSec: [10_800, 21_600], radius: 100, spawnRadius: 60, tactics: { id: 9, aggressive: true, sightRange: 14, leashRange: 50 } })

function boot() {
  const content = mkdtempSync(join(tmpdir(), 'sro-h11-fury-'))
  cleanups.push(() => rmSync(content, { recursive: true, force: true }))
  writeFileSync(join(content, 'uniques.json'), JSON.stringify(REAL_FILE))
  const data = new GameData({ mobs: MOBS, items: [...SKILL_ITEMS, ...LOOT], levels: SKILL_LEVELS, towns: [SAFE_TOWN], nests: [{ ...CAMP }] })
  const h = skillHarness({ data, book: new SkillBook([...SKILLS, ...ROWS], MASTERIES), config: { contentDir: content } })
  cleanups.push(h.cleanup)
  h.gameplay.uniques!.rng = seeded(11)
  h.gameplay.start(h.now)
  expect(h.gameplay.uniques!.gm(null, ['timer', 'tiger', 'now'], h.now).ok).toBe(true)
  h.runTo(h.now + 100)
  const m = [...h.world.mobs.values()].find((x) => x.def.code === TG && x.ai !== 'dead')!
  expect(m).toBeDefined()
  // Stand her on her camp's centre (her home), so the instant goHome keeps her where the players are.
  h.world.warp(m, m.home[0], 0, m.home[1], h.now)
  const player = (dx: number, name: string) => {
    const r = h.hero({ pos: [m.home[0] + dx, 0, m.home[1]], level: 20, name })
    r.p.maxHp = r.p.hp = 1_000_000
    return r
  }
  const hit = (p: Player, d: number) => h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: d, hp: 0 }], {}, h.now)
  const jump = (t: number) => {
    h.now = t
    h.runTo(t + 100)
  }
  const adds = () => [...h.world.mobs.values()].filter((x) => x.def.code === 'MOB_CH_WHITETIGER' && x.ai !== 'dead')
  return { h, m, player, hit, jump, adds }
}

/** A projectile of `p`'s (Soul Cut Blade) on `m`, landing in the skills module's tick at `at` (after the mobs think). */
function arrowAt(h: ReturnType<typeof boot>['h'], p: Player, m: Mob, at: number): void {
  const flights = (h.gameplay.skills as unknown as { flights: unknown[] }).flights
  flights.push({ at, caster: p.id, target: m.id, code: 'SKILL_CH_SWORD_GEOMGI_A_01', instance: 9001, aoe: false, hits: [{ outcome: 'hit', damage: 10, hp: 0 }], statuses: [null] })
}

describe('H-11 fury and leash griefing (UNIQUES §3.6 reset, §10 risks)', () => {
  it('a leash reset is never skipped: a hit landing in the tick she gets home must not keep the fury, the enrage or the adds', () => {
    const { h, m, player, hit, jump, adds } = boot()
    const tank = player(2, 'Tank')
    const archer = player(-3, 'Archer')
    h.runTo(h.now + 100)
    expect(m.ai).toBe('chase')
    expect(m.target).toBe(tank.p.id)
    hit(tank.p, Math.ceil(m.maxHp * 0.85)) // three bands: 4 adds (capped), enraged
    h.runTo(h.now + 50)
    jump(h.now + 601_000) // and furious
    expect(m.damageMul).toBe(2.5)
    expect(adds().length).toBeGreaterThan(0)
    // The tank runs out of the leash; in the same server tick the archer's projectile (fired before) lands on her.
    h.world.warp(tank.p, m.home[0] + 80, 0, m.home[1], h.now)
    arrowAt(h, archer.p, m, h.now + 50)
    h.runTo(h.now + 50)
    // She gave up and went home: full HP (the AI did that; minus the arrow's 10) ...
    expect(m.hp).toBe(m.maxHp - 10)
    h.runTo(h.now + 1000)
    // ... so the reset (§3.6: adds leave, enrage, fury and the fight clock clear) must have happened too.
    expect({ damageMul: m.damageMul, adds: adds().length }).toEqual({ damageMul: undefined, adds: 0 })
  })

  it('the fury clock stops once no attacker is within the leash (UNIQUES §10 "tag-and-wait" mitigation)', () => {
    const { h, m, player, hit, jump } = boot()
    // A bystander she aggroes by sight (never hits her) keeps her busy inside the leash ...
    const bait = player(2, 'Bait')
    h.runTo(h.now + 100)
    expect(m.target).toBe(bait.p.id)
    // ... while a tagger hits her once and leaves the leash.
    const tagger = player(-3, 'Tagger')
    const t0 = h.now
    hit(tagger.p, 100)
    h.runTo(h.now + 50)
    h.world.warp(tagger.p, m.home[0] + 300, 0, m.home[1], h.now)
    for (let t = t0 + MIN; t < t0 + 600_000; t += MIN) jump(t)
    jump(t0 + 600_100)
    expect(m.ai).toBe('chase')
    // Nobody inside the leash has damaged her since the tag: no fury (and the tagger 300 m away is out of the fight).
    expect(m.damageMul).toBeUndefined()
    expect([...m.damage.keys()]).not.toContain(tagger.p.id)
  })
})
