/**
 * The Climb on the client (docs/CLIMB.md §2.5, §11): every mini-boss gets a boss look (the ice-look plugin's ramp) and
 * nothing else does; the derived boss rows reach the client's catalog as uniques at their size; the rewards' store
 * shows the worn title, else the newest.
 */
import { CLIMB_BOSSES, deriveClimbMobs, type MobDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { climbState } from '../src/hud/climb-state.ts'
import { climbBossLook } from '../src/world/features/climb.ts'

describe('the Climb on the client', () => {
  it('a boss look for the seven mini-bosses only', () => {
    for (const b of CLIMB_BOSSES) expect(climbBossLook(b.code), b.code).toBeDefined()
    expect(climbBossLook('MOB_CL_WEASEL_5')).toBeUndefined()
    expect(climbBossLook('MOB_CH_TIGERWOMAN')).toBeUndefined()
  })

  it('the derived boss rows are uniques drawn at their size', () => {
    const base = { code: 'MOB_WC_HYEONGCHEON', name: 'Hyeongcheon', level: 30, scale: 100, radius: 1.1 } as MobDef
    const lord = deriveClimbMobs(new Map([[base.code, base]])).find((m) => m.code === 'MOB_CL_HYEONGCHEON_25')!
    expect(lord).toMatchObject({ rarity: 'unique', scale: 140, radius: 1.54, level: 25, name: 'Hyeongcheon, the Canyon Lord' })
  })

  it('the store shows the worn title, else the newest held', () => {
    climbState.set({ t: 'climb', titles: ['climber', 'pioneer'], title: null, arts: {}, progress: {} })
    expect(climbState.shown()).toBe('climber')
    climbState.set({ t: 'climb', titles: ['climber', 'pioneer'], title: 'pioneer', arts: {}, progress: {} })
    expect(climbState.shown()).toBe('pioneer')
    climbState.reset()
    expect([climbState.known, climbState.shown()]).toEqual([false, null])
  })
})
