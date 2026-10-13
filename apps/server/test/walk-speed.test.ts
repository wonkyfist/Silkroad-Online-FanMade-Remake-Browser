import { describe, expect, it } from 'vitest'
import { WALK_SPEED_FACTOR } from '@sro/shared'
import { moveMul, walking } from '../src/walk.ts'

describe('walking ignores speed boosts', () => {
  it('runs at speedMul, walks at a fixed pace a boost never raises, and slows still apply', () => {
    const p = { speedMul: 1.5 }
    expect(moveMul(p)).toBe(1.5)
    walking.add(p)
    expect(moveMul(p)).toBe(WALK_SPEED_FACTOR)
    p.speedMul = 0.5
    expect(moveMul(p)).toBeCloseTo(WALK_SPEED_FACTOR * 0.5)
    walking.delete(p)
    expect(moveMul(p)).toBe(0.5)
  })
})
