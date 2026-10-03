/**
 * H-11 hunt (docs/WAVE_PLAN7.md §6.6, lens 1 "the composite apart": the death cut short). FAILS on b22f6a9.
 *
 * Found: only the uniques module's tracked field unique gets the 8 s corpse (`Mob.corpseMs` = `corpseSec`, set in
 * uniques.ts `spawn`). Every other Tiger Girl is a plain mob with the 3 s `CORPSE_MS`, yet the client draws every
 * MOB_CH_TIGERWOMAN as the ridden composite (mobs.json `ride`, keyed by the mob code, not by the variant or the
 * module): the quest encounter of JG_025 (content/quests/jangan.json, `encounter.mob` MOB_CH_TIGERWOMAN; every player
 * of the questline meets her), a GM `/spawn MOB_CH_TIGERWOMAN`, and every Tiger Girl under UNIQUES=off. Her DIE1 lasts
 * 5,533 ms (work/out/mob/china/tigerwoman.json, bluetiger.json): removed at 3 s and faded by 3.9 s, the death is cut
 * while the tiger is still rearing and she is still in the saddle: the exact look UNIQUES §2.3 step 5 / D-U21 fixed for
 * the field unique ("the death clip is cut by the 3 s corpse unless uniques linger").
 *
 * Expected (the fix's contract): a mob that rides something (`MobDef.ride`) keeps its corpse long enough for the
 * composite's death to play out (>= DIE1, i.e. the uniques' `corpseSec` 8 s), whoever spawned it. UNIQUES=off is
 * "today" by plan (uniques.test.ts asserts its 3 s corpse), so it is left out here; F-11 may extend the rule to it.
 */
import type { MobDef, MobRide } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { GameData } from '../src/gamedata.ts'
import type { Mob } from '../src/world.ts'
import { mob } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const TG = 'MOB_CH_TIGERWOMAN'
/** Her DIE1 (and the tiger's): 5,533 ms in the converted sidecars; the composite needs at least this before the fade. */
const DIE1_MS = 5533
const RIDE = { model: { glb: '/out/mob/china/bluetiger.glb', sidecar: '/out/mob/china/bluetiger.json' }, joint: 'saddle' } as unknown as MobRide
const TIGER: MobDef = mob(TG, { name: 'Tiger Girl', level: 20, rarity: 'unique', hp: 598_720, radius: 2.8, aggressive: false, walkSpeed: 0, runSpeed: 0, ride: RIDE })

function world() {
  const data = new GameData({ mobs: [TIGER], items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] })
  // No CONTENT_DIR: the uniques module is inert, as for every Tiger Girl it does not track.
  const h = skillHarness({ data })
  cleanups.push(h.cleanup)
  h.gameplay.start(h.now)
  const { p } = h.hero({ pos: [0, 0, 0], level: 20 })
  p.maxHp = p.hp = 1_000_000
  const kill = (m: Mob) => h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: 1e9, hp: 0 }], {}, h.now)
  return { h, p, kill }
}

describe('H-11 composite: the ridden Tiger Girl\'s death is cut short outside the uniques module', () => {
  it('the JG_025 quest encounter (createMob as quests/encounter.ts, tuning 0.05 / 0.8 / 0.1): corpse gone at 3 s', () => {
    const { h, kill } = world()
    // quests/encounter.ts: variant 'unique' (her rarity), no nest, the encounter's tuning.
    const m = h.gameplay.createMob(TIGER, 'unique', 4, 0, 0, null, h.now, null, { hpMul: 0.05, attackMul: 0.8, expMul: 0.1 })
    kill(m)
    expect(m.ai).toBe('dead')
    const died = h.now
    h.runTo(died + DIE1_MS + 100)
    // Today: removed at died + 3,000 ms (CORPSE_MS), 2.5 s before her DIE1 ends.
    expect(h.world.mobs.has(m.id), 'her corpse must outlive the composite\'s DIE1').toBe(true)
  })

  it('a GM /spawn of her code (gmSpawn): the same 3 s corpse under the composite', () => {
    const { h, p, kill } = world()
    const [id] = h.gameplay.gmSpawn(p, TIGER, 1, h.now)
    const m = h.world.mobs.get(id)!
    kill(m)
    const died = h.now
    h.runTo(died + DIE1_MS + 100)
    expect(h.world.mobs.has(id), 'her corpse must outlive the composite\'s DIE1').toBe(true)
  })
})
