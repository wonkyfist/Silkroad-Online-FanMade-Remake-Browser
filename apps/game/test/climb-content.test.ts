/**
 * The Climb on the client (docs/CLIMB.md §2.2, §4.1.1): the content tables derive the server's `MOB_CL_*` monsters from
 * their retail bases (so a re-levelled monster finds its model, clips and skills) and read the degree-3 chests at 25.
 */
import { CLIMB_ROSTER, DEFAULT_LEVEL_CAP, type ItemDef, type MobDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { builtinTables, mergeTables } from '../src/content/gameplay.ts'

const tiger: MobDef = {
  code: 'MOB_CH_WHITETIGER', id: 1, name: 'White Tiger', typeId: [1, 2, 1, 1], rarity: 'normal', level: 18, hp: 809, mp: 0, physAttack: [100, 120], magAttack: [0, 0],
  physDefence: 40, magDefence: 60, hitRate: 61, parryRate: 61, attackRange: 1, attackIntervalMs: 1500, radius: 1.2, walkSpeed: 1.6, runSpeed: 7.5,
  aggressive: true, exp: 423, scale: 100, model: { glb: 'mob/china/whitetiger.glb', sidecar: 'mob/china/whitetiger.json' }, skills: ['MSKILL_CH_WHITETIGER_ATTACK01'],
}
const chest = { code: 'ITEM_CH_W_LIGHT_03_BA_C', category: 'armor', degree: 3, reqLevel: 26 } as ItemDef

describe('content tables with the Climb', () => {
  it("derives the roster rows whose base is exported, with the base's model and the row's level", () => {
    const wrap = (kind: string, entries: unknown[]) => ({ schema: 1, kind, entries })
    const t = mergeTables(builtinTables(), { mobs: wrap('mobs', [tiger]), items: wrap('items', [chest]) })
    const guard = t.mobs.get('MOB_CL_TIGERGUARD_24')!
    expect(guard).toMatchObject({ base: tiger.code, name: "Tiger Girl's Guard", level: 24, hp: 1489, model: tiger.model, skills: tiger.skills })
    expect(t.mobs.get('MOB_CL_WHITETIGER_18')).toMatchObject({ level: 18, model: tiger.model })
    // rows without an exported base are not invented
    const derived = [...t.mobs.keys()].filter((c) => c.startsWith('MOB_CL_'))
    expect(derived.every((c) => t.mobs.get(CLIMB_ROSTER.find((r) => r.code === c)!.base))).toBe(true)
    expect(t.items.get(chest.code)!.reqLevel).toBe(21) // CLIMB §4.1.2 (D53): degree 3 at 15-21 (the old squeeze: 25)
    expect(DEFAULT_LEVEL_CAP).toBe(25)
  })
})
