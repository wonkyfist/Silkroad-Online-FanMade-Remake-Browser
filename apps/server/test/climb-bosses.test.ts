/**
 * The Climb's band mini-bosses (docs/CLIMB.md §2.5, layer L2; D53, D54): the seven entries of content/uniques.json on
 * the uniques module (an authored spot each, adds instead of summon rows, no enrage or fury, the server-wide notices),
 * their derived rows (packages/shared CLIMB_BOSSES: level, HP, size, unique), their loot (one gear piece of the band's
 * degree, seals at 1.5 / 0.4 / 0.1 % at most) and CLIMB=off (they are left out, never a start failure).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIMB_BOSSES, checkUniquesFile, deriveClimbMobs, type ItemDef, type MobDef, type ServerMessage, type UniquesFile } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { resolveDropTable, rollUniqueDrops, UNIQUE_ADD_DELAY_MS, UNIQUE_SPOT_CAMP_BASE } from '../src/uniques.ts'
import type { Mob } from '../src/world.ts'
import { item, mob, seeded } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const REAL = JSON.parse(readFileSync(join(REPO_ROOT, 'content/uniques.json'), 'utf8')) as UniquesFile
const BOSSES = REAL.uniques.filter((u) => u.mob.startsWith('MOB_CL_'))
const still = { walkSpeed: 0, runSpeed: 0, attackRange: 2, aggressive: true }
/** Every base the bosses and their adds stand on. */
const BASES: MobDef[] = [
  'MOB_CH_GYO', 'MOB_CH_WATERGHOST', 'MOB_CH_WATERGHOST_CLON', 'MOB_CH_BANDIT_CLON', 'MOB_CH_BANDITARCHER', 'MOB_CH_STONEGHOST', 'MOB_CH_TOMBSTONE_CLON',
  'MOB_CH_BANDIT', 'MOB_WC_HYUNGNO', 'MOB_WC_HYUNGNO_CLON', 'MOB_WC_HYEONGCHEON', 'MOB_WC_EARTHGHOST', 'MOB_WC_EARTHKING',
].map((code) => mob(code, { name: code, level: 10, scale: 100, radius: 1, ...still }))
const gear = (code: string, degree: number, reqLevel: number, category: ItemDef['category'] = 'weapon') => item(code, { category, degree, reqLevel, race: 'china', slot: category === 'armor' ? 'chest' : 'weapon' })
const ITEMS: ItemDef[] = [
  ...SKILL_ITEMS,
  ...['WEAPON', 'ARMOR', 'SHIELD', 'ACCESSARY'].map((k) => item(`ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_${k}_A`, { category: 'alchemy' })),
  ...[1, 2, 3, 4].map((n) => item(`ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_0${n}`, { category: 'alchemy', maxStack: 50 })),
  item('ITEM_ETC_HP_POTION_04', { category: 'potion', maxStack: 50 }),
  item('ITEM_ETC_MP_POTION_04', { category: 'potion', maxStack: 50 }),
  gear('ITEM_CH_SWORD_01_A', 1, 1), gear('ITEM_CH_SWORD_01_B', 1, 3), gear('ITEM_CH_SWORD_01_C', 1, 4), gear('ITEM_CH_SWORD_01_A_RARE', 1, 1),
  gear('ITEM_CH_SWORD_04_A', 4, 21), gear('ITEM_CH_SWORD_04_B', 4, 22), gear('ITEM_CH_SWORD_04_C', 4, 23), gear('ITEM_CH_SWORD_04_A_RARE', 4, 21),
  gear('ITEM_CH_SWORD_04_B_RARE', 4, 22), gear('ITEM_CH_SWORD_04_C_RARE', 4, 23),
]

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** A world with the derived monsters (CLIMB on: `climb`) and the shipped file, the bosses' spots moved into the 1 km test world. */
function boot(o: { climb?: boolean } = {}) {
  const content = mkdtempSync(join(tmpdir(), 'sro-mb-'))
  cleanups.push(() => rmSync(content, { recursive: true, force: true }))
  const file = structuredClone(REAL)
  file.uniques.forEach((u, i) => {
    if (u.spot) u.spot = { x: -300 + 80 * i, z: 100 }
  })
  writeFileSync(join(content, 'uniques.json'), JSON.stringify(file))
  const base = new Map(BASES.map((m) => [m.code, m]))
  const mobs = [...BASES, mob('MOB_CH_TIGERWOMAN', { name: 'Tiger Girl', level: 20, rarity: 'unique', ...still }), ...(o.climb === false ? [] : deriveClimbMobs(base))]
  const data = new GameData({ mobs, items: ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN], nests: [{ ...nestTG }] })
  const h = skillHarness({ data, config: { contentDir: content, climb: o.climb !== false, levelCap: 25 } })
  cleanups.push(h.cleanup)
  h.gameplay.uniques!.rng = seeded(11)
  h.gameplay.start(h.now)
  const live = (code: string): Mob | undefined => [...h.world.mobs.values()].find((m) => m.def.code === code && m.ai !== 'dead')
  const spawn = (name: string) => {
    const r = h.gameplay.uniques!.gm(null, ['spawn', name], h.now)
    expect(r.ok, r.message).toBe(true)
    return live(BOSSES.find((b) => b.mob.toLowerCase().includes(name.toLowerCase()))!.mob)!
  }
  return { h, live, spawn, file }
}
// Tiger Girl needs one camp of her group
const nestTG = { id: 5903, mob: 'MOB_CH_TIGERWOMAN', x: 0, z: -300, radius: 30, spawnRadius: 20, count: 1, respawnSec: [10_800, 21_600] as [number, number], tactics: { id: 9, aggressive: true, sightRange: 14, leashRange: 50 }, world: 'jangan', provenance: 'vsro-server-db via third-party port' as const, source: { file: 't', zone: '', x: 0, z: 0 }, uniqueGroup: 'MOB_CH_TIGERWOMAN' }

describe('content: the seven mini-bosses', () => {
  it('lists MB1–MB5, MB7 and MB8 with a spot each, adds, §2.5 respawns, no enrage or fury, the notices on, and a valid file', () => {
    expect(BOSSES.map((b) => b.mob)).toEqual(CLIMB_BOSSES.map((b) => b.code))
    expect(BOSSES.map((b) => b.respawnMin)).toEqual([[20, 30], [25, 40], [30, 45], [30, 45], [40, 60], [45, 75], [60, 90]])
    for (const b of BOSSES) {
      expect(b.spot, b.mob).toBeDefined()
      expect(b.adds?.length, b.mob).toBeGreaterThan(0)
      expect(b.tuning).toEqual({ hpMul: 1, attackMul: 1, expMul: 1 })
      expect([b.enrage.damageMul, b.fury.damageMul]).toEqual([1, 1])
      expect(b.announce).toMatchObject({ appear: true, defeat: true })
    }
    // Hyeongcheon at the Sea Cliffs lair marker (content/places.json canyon-lord-lair)
    const lair = (JSON.parse(readFileSync(join(REPO_ROOT, 'content/places.json'), 'utf8')) as { places: { name: string; x: number; z: number }[] }).places.find((p) => p.name === 'canyon-lord-lair')!
    expect(BOSSES.at(-1)!.spot).toMatchObject({ x: lair.x, z: lair.z })
    expect(checkUniquesFile(REAL)).toEqual([])
  })

  it('D53/D54: one gear piece always (degree 4 from MB7), seals at most 2 % in all (Moon and Sun only for the level-25 lord)', () => {
    const degree = BOSSES.map((b) => REAL.dropTables[b.drops]!.groups[0]!.pool!.degree)
    expect(degree).toEqual([1, 2, 2, 3, 3, 4, 4])
    for (const b of BOSSES) {
      const t = REAL.dropTables[b.drops]!
      expect(t.groups[0]!.chance).toBe(1)
      const seals = t.groups.filter((g) => g.pool?.rare)
      const total = seals.reduce((s, g) => s + g.chance * (g.rolls ?? 1), 0)
      expect(total, b.mob).toBeLessThanOrEqual(0.02)
      expect(seals.some((g) => g.pool!.seal === 'moon' || g.pool!.seal === 'sun'), b.mob).toBe(b.mob === 'MOB_CL_HYEONGCHEON_25')
    }
  })

  it('the checker: a spot replaces the camps; bad adds are refused', () => {
    const f = structuredClone(REAL)
    f.uniques[1]!.adds = [{ mob: 'nope', n: 0, atPct: 120 }]
    expect(checkUniquesFile(f).join('\n')).toMatch(/adds\[0\]/)
    const g = structuredClone(REAL)
    ;(g.uniques[1] as { camps: unknown }).camps = []
    expect(checkUniquesFile(g)).toEqual([])
  })
})

describe('the derived boss rows', () => {
  it('are uniques at their size and §2.5 numbers (MB7 x 2.0, MB8 x 2.5 HP: D53)', () => {
    const base = new Map(BASES.map((m) => [m.code, m]))
    const d = new Map(deriveClimbMobs(base).map((m) => [m.code, m]))
    const lord = d.get('MOB_CL_HYEONGCHEON_25')!
    expect(lord).toMatchObject({ level: 25, hp: 54_675, physAttack: [236, 282], exp: 12_936, rarity: 'unique', scale: 140, name: 'Hyeongcheon, the Canyon Lord', base: 'MOB_WC_HYEONGCHEON' })
    expect(d.get('MOB_CL_MODUN_23')).toMatchObject({ level: 23, hp: 45_504, scale: 200 })
    expect(d.get('MOB_CL_OLDSCAR_6')).toMatchObject({ level: 6, hp: 2004, scale: 135 })
  })
})

describe('the uniques module with the mini-bosses', () => {
  it('spawns a boss at its spot with its numbers, notices it to everyone, adds join 1.5 s after the band and leave on a reset', () => {
    const { h, spawn, file } = boot()
    const far = h.hero({ pos: [400, 0, 400], level: 20 })
    const m = spawn('oldscar')
    const spot = file.uniques.find((u) => u.mob === 'MOB_CL_OLDSCAR_6')!.spot!
    expect(Math.hypot(m.pos[0] - spot.x, m.pos[2] - spot.z)).toBeLessThanOrEqual(6.01)
    expect(m).toMatchObject({ variant: 'unique', maxHp: 2004, level: 6 })
    expect(h.gameplay.uniques!.unique('MOB_CL_OLDSCAR_6')!.camp!.id).toBe(UNIQUE_SPOT_CAMP_BASE + 1)
    const seen = h.all(far.inbox, 'uniqueNotice') as Msg<'uniqueNotice'>[]
    expect(seen.at(-1)).toMatchObject({ event: 'appeared', mob: 'MOB_CL_OLDSCAR_6', name: 'Old Scar, the Weasel King' })
    // into the 50 % band: no adds before 1.5 s, two Weasels after
    const { p, inbox } = h.hero({ pos: [m.pos[0] + 1.5, 0, m.pos[2]], level: 6 })
    p.maxHp = p.hp = 1e6
    h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: 1100, hp: 0 }], {}, h.now)
    const weasels = () => [...h.world.mobs.values()].filter((x) => x.def.code === 'MOB_CL_WEASEL_5' && x.ai !== 'dead')
    h.runTo(h.now + 500)
    expect(weasels()).toHaveLength(0)
    h.runTo(h.now + UNIQUE_ADD_DELAY_MS)
    expect(weasels()).toHaveLength(2)
    // no enrage or fury lines on a x 1 boss
    const lines = (h.all(inbox, 'chat') as Msg<'chat'>[]).map((c) => c.text)
    expect(lines.some((t) => /enraged|furious/.test(t))).toBe(false)
    // a GM kill ends it silently and the adds leave with it; the respawn rolls 20–30 min
    expect(h.gameplay.uniques!.gm(null, ['kill', 'oldscar'], h.now).ok).toBe(true)
    h.runTo(h.now + 100)
    expect(weasels()).toHaveLength(0)
    const row = h.gameplay.uniques!.uniques.find((u) => u.def.mob === 'MOB_CL_OLDSCAR_6')!.row
    expect(row.due_at - h.now).toBeGreaterThanOrEqual(20 * 60_000 - 200)
    expect(row.due_at - h.now).toBeLessThanOrEqual(30 * 60_000)
  })

  it('a rewarded kill is noticed server-wide with the killer; the loot is the boss table (one gear piece of its degree)', () => {
    const { h, spawn } = boot()
    const lord = spawn('hyeongcheon')
    expect(lord).toMatchObject({ maxHp: 54_675, level: 25 })
    const { p, inbox } = h.hero({ pos: [lord.pos[0] + 2, 0, lord.pos[2]], level: 25, name: 'Slayer' })
    p.maxHp = p.hp = 1e7
    h.gameplay.dealHits(p, lord, [{ outcome: 'hit', damage: 1e7, hp: 0 }], {}, h.now)
    h.runTo(h.now + 100)
    const n = (h.all(inbox, 'uniqueNotice') as Msg<'uniqueNotice'>[]).at(-1)
    expect(n).toMatchObject({ event: 'defeated', mob: 'MOB_CL_HYEONGCHEON_25', by: 'Slayer' })
    const table = resolveDropTable(REAL.dropTables.CLIMB_MB8!, ITEMS, 25)
    for (let s = 1; s <= 20; s++) {
      const drops = rollUniqueDrops(table, seeded(s), (c) => ITEMS.some((i) => i.code === c))
      const gearDrops = drops.filter((d) => d.code.startsWith('ITEM_CH_SWORD_04_') && !d.code.endsWith('_RARE'))
      expect(gearDrops).toHaveLength(1)
    }
  })

  it('CLIMB=off: no derived codes, the seven are left out (logged), Tiger Girl stays', () => {
    const { h } = boot({ climb: false })
    expect(h.gameplay.uniques!.uniques.map((u) => u.def.mob)).toEqual(['MOB_CH_TIGERWOMAN'])
    expect(h.logs.some((l) => /7 Climb mini-bosses off/.test(l))).toBe(true)
  })
})
