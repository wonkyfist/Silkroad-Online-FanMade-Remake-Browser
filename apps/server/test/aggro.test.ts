/**
 * Who attacks on sight (docs/PROTOCOL.md §3, docs/DATA.md "Aggression and variants"):
 * - the rule: a nest's retail tactics (port aggressTypeRaw 0), else the MobDef default; a champion uses its champion
 *   tactics, aggressive in vSRO, unless the mob links none (MobDef.championAggressive false); giants and uniques keep theirs;
 * - a real server with fixtures: a champion of a passive nest acquires a player in sight, the passive mobs do not;
 * - the real export (skips without work/out/data): the aggressive set of the Jangan nests, pinned by count and by name.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MobDef, NestDef } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobAggressive } from '../src/ai.ts'
import { REPO_ROOT } from '../src/config.ts'
import { layerRepoOverrides } from '../src/editors/overrides.ts'
import { GameData } from '../src/gamedata.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { LEVELS, mob, nest, seeded, contentFiles } from './fixtures.ts'

describe('mobAggressive', () => {
  const passive = { aggressive: false }
  const aggressive = { aggressive: true }
  it('takes the nest tactics over the MobDef default, for normal, giant and unique spawns', () => {
    expect(mobAggressive(passive, 'normal', { aggressive: true })).toBe(true)
    expect(mobAggressive(aggressive, 'normal', { aggressive: false })).toBe(false)
    expect(mobAggressive(aggressive, 'normal', null)).toBe(true)
    expect(mobAggressive(passive, 'normal')).toBe(false)
    expect(mobAggressive(passive, 'giant', { aggressive: false })).toBe(false)
    expect(mobAggressive(aggressive, 'unique', { aggressive: true })).toBe(true)
  })

  it('a champion attacks on sight unless its mob links no champion tactics', () => {
    expect(mobAggressive(passive, 'champion', { aggressive: false })).toBe(true)
    expect(mobAggressive({ aggressive: false, championAggressive: true }, 'champion', { aggressive: false })).toBe(true)
    expect(mobAggressive({ aggressive: false, championAggressive: false }, 'champion', { aggressive: false })).toBe(false)
    expect(mobAggressive({ aggressive: true, championAggressive: false }, 'champion', { aggressive: true })).toBe(true)
    expect(mobAggressive({ aggressive: false, championAggressive: false }, 'normal', null)).toBe(false)
  })
})

// ---- a real server on fixtures ----------------------------------------------------------------------

const WEASEL = mob('MOB_CH_GYO', { name: 'Weasel', level: 5, hp: 500 })
const OLD_WEASEL = mob('MOB_CH_GYO_CLON', { name: 'Old Weasel', level: 4, hp: 500, championAggressive: false })
const STONE = mob('MOB_CH_STONEGHOST', { name: 'Stone Ghost', level: 9, hp: 500, aggressive: true })
const TACTICS = (aggressive: boolean) => ({ id: 1, aggressive, sightRange: 10, leashRange: 40 })
const NESTS: NestDef[] = [
  nest(1, WEASEL.code, 100, -100, { radius: 0, spawnRadius: 0, championPct: 100, tactics: TACTICS(false) }),
  nest(2, OLD_WEASEL.code, 200, -100, { radius: 0, spawnRadius: 0, championPct: 100, tactics: TACTICS(false) }),
  nest(3, WEASEL.code, 300, -100, { radius: 0, spawnRadius: 0, championPct: 0, tactics: TACTICS(false) }),
  nest(4, STONE.code, 100, -300, { radius: 0, spawnRadius: 0, championPct: 0, tactics: TACTICS(true) }),
]

describe('aggression on a running server', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, rng: seeded(61), mobLevelMax: 25 },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [50, 0, -50], bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ mobs: [WEASEL, OLD_WEASEL, STONE], nests: NESTS, levels: LEVELS }),
      },
    })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  const mobOf = (nestId: number) => [...s.ctx.world.mobs.values()].find((m) => m.nest?.id === nestId)!

  it('spawns champions of a passive nest aggressive (with the nest sight), but not those of a mob without champion tactics', () => {
    expect(mobOf(1)).toMatchObject({ variant: 'champion', aggressive: true, sightRange: 10 })
    expect(mobOf(2)).toMatchObject({ variant: 'champion', aggressive: false })
    expect(mobOf(3)).toMatchObject({ variant: 'normal', aggressive: false })
    expect(mobOf(4)).toMatchObject({ variant: 'normal', aggressive: true })
  })

  it('an aggressive mob or champion acquires a player 6 m away; passive ones leave the player alone', async () => {
    const acc = await newAccount(s.url, 'aggro')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: 'Aggrotest', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const me = (await c.next('worldEnter')).self.id
    const visit = async (nestId: number): Promise<number | null> => {
      const m = mobOf(nestId)
      const [x, , z] = s.ctx.world.positionAt(m, Date.now())
      c.send({ t: 'gm', cmd: 'tp', args: [String(x + 6), String(z)] })
      expect((await c.next('gmResult')).ok).toBe(true)
      await sleep(600)
      const target = m.target
      c.send({ t: 'gm', cmd: 'tp', args: ['50', '-50'] })
      await c.next('gmResult')
      c.send({ t: 'gm', cmd: 'heal', args: [] })
      await c.next('gmResult')
      return target
    }
    expect(await visit(4)).toBe(me)
    expect(await visit(1)).toBe(me)
    expect(await visit(2)).toBeNull()
    expect(await visit(3)).toBeNull()
    c.close()
    await c.closed
  })
})

// ---- the real export --------------------------------------------------------------------------------

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = ['data/mobs.json', 'data/nests.json'].every((f) => existsSync(join(OUT, f)))

describe.skipIf(!HAVE)('the retail aggressive set (real export)', () => {
  let d: GameData
  /** nests.json as exported, before content/nests.override.json. */
  let exported: NestDef[]
  let mobs: ReadonlyMap<string, MobDef>
  beforeAll(() => {
    d = GameData.load(OUT)
    exported = d.nests.map((n) => ({ ...n, tactics: { ...n.tactics } }))
    layerRepoOverrides(d, join(REPO_ROOT, 'content'), 'jangan', () => {})
    mobs = d.mobs
  })
  const nestsOf = (code: string, list: NestDef[] = d.nests) => list.filter((n) => n.mob === code)

  it('398 of the 825 Jangan nests attack on sight (397 with the repo override of the tomb entrance pack)', () => {
    expect(exported).toHaveLength(825)
    expect(exported.filter((n) => n.tactics.aggressive)).toHaveLength(398)
    expect(d.nests.filter((n) => n.tactics.aggressive)).toHaveLength(397)
    // PLAYTEST §12 decision 8: the Broken Stone Ghosts at the Qin-Shi Tomb entrance only fight back
    expect(exported.find((n) => n.id === 5416)).toMatchObject({ mob: 'MOB_CH_STONEGHOST_CLON', tactics: { aggressive: true } })
    expect(d.nests.find((n) => n.id === 5416)!.tactics.aggressive).toBe(false)
  })

  it('every mob has one tactics for all its nests, and its MobDef default agrees with them', () => {
    for (const m of mobs.values()) {
      const list = nestsOf(m.code, exported)
      expect(list.length, m.code).toBeGreaterThan(0)
      expect(new Set(list.map((n) => n.tactics.aggressive)), m.code).toEqual(new Set([m.aggressive]))
    }
  })

  it('names: Jangan starter mobs and the meek / young variants are passive, the rest of the fields are aggressive', () => {
    const passive = ['MOB_CH_MANGNYANG', 'MOB_CH_BIGEYEGHOST', 'MOB_CH_GYO', 'MOB_CH_WATERGHOST', 'MOB_CH_TIGER_CLON', 'MOB_CH_BANDIT_CLON', 'MOB_CH_YEOHA_CLON', 'MOB_WC_GUNPOWDERGHOST_CLON']
    const aggressive = ['MOB_CH_STONEGHOST', 'MOB_CH_TOMBSTONE', 'MOB_CH_YEOHA', 'MOB_CH_TIGER', 'MOB_CH_BANDIT', 'MOB_CH_BANDITARCHER', 'MOB_CH_WHITETIGER', 'MOB_CH_CHAKJI']
    for (const code of passive) expect(mobs.get(code)?.aggressive, code).toBe(false)
    for (const code of aggressive) expect(mobs.get(code)?.aggressive, code).toBe(true)
    expect(mobs.get('MOB_CH_TIGER_CLON')!.name).toBe('Young Tiger')
    expect(mobs.get('MOB_WC_GUNPOWDERGHOST_CLON')!.name).toBe('Meek Gun Powder')
    expect(nestsOf('MOB_CH_TIGER')[0].tactics).toMatchObject({ aggressive: true, sightRange: 10 })
    expect(nestsOf('MOB_CH_MANGNYANG')[0].tactics).toMatchObject({ aggressive: false, sightRange: 11.533 })
    expect(mobs.size).toBe(32)
    expect([...mobs.values()].filter((m) => m.aggressive)).toHaveLength(16)
  })

  it('Tiger Girl: aggressive with sight 14 m at all 11 camps (docs/UNIQUES.md)', () => {
    const camps = nestsOf('MOB_CH_TIGERWOMAN')
    expect(camps).toHaveLength(11)
    for (const n of camps) expect(n.tactics).toMatchObject({ aggressive: true, sightRange: 14 })
    expect(mobAggressive(mobs.get('MOB_CH_TIGERWOMAN')!, 'unique', camps[0].tactics)).toBe(true)
  })

  it('champions of the passive starter mobs attack on sight', () => {
    for (const code of ['MOB_CH_MANGNYANG', 'MOB_CH_BIGEYEGHOST', 'MOB_CH_GYO', 'MOB_CH_WATERGHOST']) {
      const m = mobs.get(code)!
      expect(m.championAggressive, code).not.toBe(false)
      expect(mobAggressive(m, 'champion', nestsOf(code)[0].tactics), code).toBe(true)
      expect(mobAggressive(m, 'normal', nestsOf(code)[0].tactics), code).toBe(false)
    }
    // an export with the field (port mobs.json combat.championTacticsId) names the passive mobs without champion tactics
    const tagged = [...mobs.values()].filter((m) => m.championAggressive !== undefined)
    if (tagged.length > 0) {
      expect(tagged.every((m) => !m.aggressive)).toBe(true)
      expect(tagged.filter((m) => m.championAggressive).map((m) => m.code).sort()).toEqual(['MOB_CH_BIGEYEGHOST', 'MOB_CH_GYO', 'MOB_CH_MANGNYANG', 'MOB_CH_WATERGHOST'])
    }
  })
})
