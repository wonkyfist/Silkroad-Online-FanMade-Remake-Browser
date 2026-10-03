/**
 * Wave 11 content (docs/WAVE_PLAN7.md §3.2, docs/UNIQUES.md §2.2, §5.3): `MobDef.ride` in checkMobDef and
 * checkContentFile, and content/uniques.json through checkUniquesFile.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkContentFile, checkMobDef, checkMobRide, checkUniquesFile, type MobDef, type UniquesFile } from '../src/index.ts'

const mob: MobDef = {
  code: 'MOB_CH_TIGERWOMAN', id: 1954, name: 'Tiger Girl', typeId: [1, 2, 1, 1], rarity: 'unique', level: 20, hp: 598_725, mp: 100,
  physAttack: [300, 400], magAttack: [300, 400], physDefence: 200, magDefence: 200, hitRate: 200, parryRate: 100,
  attackRange: 1, attackIntervalMs: 3000, radius: 1, walkSpeed: 2, runSpeed: 6, aggressive: true, exp: 451_200, scale: 100,
  model: { bsr: 'res/mob/china/tigerwoman.bsr', glb: '/out/mob/china/tigerwoman.glb', sidecar: '/out/mob/china/tigerwoman.json' },
}
const ride = { model: { bsr: 'res/mob/china/bluetiger.bsr', glb: '/out/mob/china/bluetiger.glb', sidecar: '/out/mob/china/bluetiger.json' }, joint: 'saddle' }
const file = (entries: unknown[]) => ({ schema: 1, kind: 'mobs', generatedAt: '2026-10-01T00:00:00Z', sources: [], entries })

describe('MobDef.ride', () => {
  it('an old mobs.json without ride validates', () => {
    expect(checkMobDef(mob)).toEqual([])
    expect(checkContentFile('mobs', file([mob, { ...mob, code: 'MOB_CH_TIGER', rarity: 'normal' }]))).toEqual([])
  })

  it('the exported mobs.json validates (when converted)', () => {
    const p = fileURLToPath(new URL('../../../work/out/data/mobs.json', import.meta.url))
    if (!existsSync(p)) return
    expect(checkContentFile('mobs', JSON.parse(readFileSync(p, 'utf8')))).toEqual([])
  })

  it('a ride with a model under /out/ and a joint validates', () => {
    expect(checkMobDef({ ...mob, ride })).toEqual([])
    expect(checkMobRide(ride)).toEqual([])
  })

  it('a ride with an empty or missing joint fails', () => {
    expect(checkMobDef({ ...mob, ride: { ...ride, joint: '' } })).toEqual(['mob.ride.joint: expected a non-empty string'])
    expect(checkContentFile('mobs', file([{ ...mob, ride: { model: ride.model } }]))).toEqual(['mobs.json[0].ride.joint: expected a non-empty string'])
  })

  it('a ride without a full model, or with one outside /out/, fails', () => {
    expect(checkMobDef({ ...mob, ride: { ...ride, model: null } })).toEqual(['mob.ride.model: expected {bsr, glb, sidecar}'])
    expect(checkMobDef({ ...mob, ride: { ...ride, model: { glb: '/out/x.glb' } } })).toHaveLength(1)
    expect(checkMobDef({ ...mob, ride: { ...ride, model: { ...ride.model, glb: 'C:/work/out/mob/china/bluetiger.glb' } } })).toEqual(['mob.ride.model.glb: expected a .glb path under /out/'])
    expect(checkMobDef({ ...mob, ride: 'bluetiger' })).toEqual(['mob.ride: expected {model, joint}'])
  })
})

const uniques = (): UniquesFile => ({
  schema: 1,
  kind: 'uniques',
  uniques: [{
    mob: 'MOB_CH_TIGERWOMAN',
    world: 'jangan',
    camps: 'uniqueGroup',
    respawnMin: [180, 360],
    firstSpawnMin: [10, 30],
    restartSpawnMin: [1, 2],
    tuning: { hpMul: 0.08, attackMul: 1, expMul: 1 },
    summons: { on: true, perWave: 2, maxAlive: 4, variants: ['normal'] },
    enrage: { hpPct: 20, damageMul: 1.25 },
    fury: { afterSec: 600, damageMul: 2 },
    corpseSec: 8,
    announce: { appear: true, defeat: true, roarRadiusM: 120 },
    drops: 'UNIQUE_TIGERWOMAN',
  }],
  dropTables: {
    UNIQUE_TIGERWOMAN: {
      gold: { chance: 1, piles: 3, amount: [2000, 4000] },
      groups: [
        { chance: 1, rolls: 3, pool: { degree: 3, maxReqLevel: 'levelCap', gradeWeights: [60, 40] }, plus: [{ plus: 0, weight: 55 }, { plus: 1, weight: 25 }, { plus: 2, weight: 15 }, { plus: 3, weight: 5 }] },
        { chance: 1, rolls: 2, entries: [{ item: 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', weight: 40 }, { item: 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A', weight: 40 }] },
        { chance: 0.5, entries: [{ item: 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', weight: 1, count: [1, 2] }] },
        { chance: 1, entries: [{ item: 'ITEM_ETC_HP_POTION_03', weight: 1, count: [10, 10] }] },
        { chance: 0.2, pool: { degree: 3, maxReqLevel: 20, rare: true } },
      ],
    },
  },
})

describe('checkUniquesFile', () => {
  it('accepts the §5.3 shape, with and without reference tables', () => {
    expect(checkUniquesFile(uniques())).toEqual([])
    expect(checkUniquesFile(uniques(), { mob: (c) => c === 'MOB_CH_TIGERWOMAN', item: () => true })).toEqual([])
    const explicit = uniques()
    explicit.uniques[0]!.camps = [5906, 5909]
    expect(checkUniquesFile(explicit, { nest: (id) => id === 5906 || id === 5909 })).toEqual([])
  })

  it('fails on an unknown mob, no camps, a bad range, a missing drop table', () => {
    const f = uniques()
    expect(checkUniquesFile(f, { mob: () => false })).toEqual(['uniques.json.uniques[0].mob: unknown mob MOB_CH_TIGERWOMAN'])
    const u = f.uniques[0]!
    u.camps = []
    u.respawnMin = [360, 180]
    u.firstSpawnMin = [-1, 5]
    u.drops = 'NOPE'
    expect(checkUniquesFile(f)).toEqual([
      "uniques.json.uniques[0].camps: expected 'uniqueGroup' or a non-empty list of nest ids",
      'uniques.json.uniques[0].respawnMin: expected [min, max] with min <= max',
      'uniques.json.uniques[0].firstSpawnMin: expected minutes >= 0',
      'uniques.json.uniques[0].drops: no drop table NOPE',
    ])
  })

  it('fails on an unknown camp nest, a duplicate unique, bad sub-objects', () => {
    const f = uniques()
    f.uniques[0]!.camps = [1]
    expect(checkUniquesFile(f, { nest: () => false })).toEqual(['uniques.json.uniques[0].camps: unknown nest 1'])
    const g = uniques()
    g.uniques.push({ ...g.uniques[0]! })
    expect(checkUniquesFile(g)).toEqual(['uniques.json.uniques[1].mob: listed twice'])
    const h = uniques() as unknown as { uniques: Record<string, unknown>[] }
    h.uniques[0]!.enrage = { hpPct: 120, damageMul: 1.25 }
    h.uniques[0]!.summons = { on: 'yes', perWave: 2, maxAlive: 4, variants: ['boss'] }
    delete h.uniques[0]!.fury
    expect(checkUniquesFile(h)).toEqual([
      'uniques.json.uniques[0].summons.on: expected a boolean',
      'uniques.json.uniques[0].summons.variants: expected a list of mob variants',
      'uniques.json.uniques[0].enrage.hpPct: expected 0..100',
      'uniques.json.uniques[0].fury: expected an object',
    ])
  })

  it('fails on a bad drop table', () => {
    const f = uniques()
    const t = f.dropTables.UNIQUE_TIGERWOMAN!
    t.groups[0]!.chance = 1.5
    t.groups[1]!.pool = { degree: 3, maxReqLevel: 'levelCap' }
    t.groups[2]!.entries = [{ item: 'ITEM_X', weight: -1 }]
    t.groups[0]!.plus = [{ plus: -1, weight: 1 }]
    t.gold!.piles = 0
    expect(checkUniquesFile(f, { item: (c) => c !== 'ITEM_X' })).toEqual([
      'uniques.json.dropTables.UNIQUE_TIGERWOMAN.gold.piles: expected a finite number >= 1',
      'uniques.json.dropTables.UNIQUE_TIGERWOMAN.groups[0].chance: expected 0..1',
      'uniques.json.dropTables.UNIQUE_TIGERWOMAN.groups[0].plus[0]: expected {plus: integer >= 0, weight >= 0}',
      'uniques.json.dropTables.UNIQUE_TIGERWOMAN.groups[1]: expected either entries[] or a pool',
      'uniques.json.dropTables.UNIQUE_TIGERWOMAN.groups[2].entries[0].item: unknown item ITEM_X',
      'uniques.json.dropTables.UNIQUE_TIGERWOMAN.groups[2].entries[0].weight: expected a finite number >= 0',
    ])
  })

  it('fails on a bad wrapper', () => {
    expect(checkUniquesFile(null)).toEqual(['uniques.json: expected an object'])
    expect(checkUniquesFile({ schema: 2, kind: 'mobs', dropTables: {}, uniques: [] })).toEqual(['uniques.json.schema: expected 1', "uniques.json.kind: expected 'uniques'"])
    expect(checkUniquesFile({ schema: 1, kind: 'uniques', dropTables: {} })).toEqual(['uniques.json.uniques: expected an array'])
  })
})
