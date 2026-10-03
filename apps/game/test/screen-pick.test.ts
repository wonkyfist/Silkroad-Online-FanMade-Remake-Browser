import { describe, expect, it } from 'vitest'
import { nearestOnScreen, PICK_SLACK_PX, segmentDistance } from '../src/world/screen-pick.ts'

describe('screen picking fallback', () => {
  it('measures the distance to a segment, clamped to its ends', () => {
    expect(segmentDistance(5, 0, 0, 10, 0, -10)).toBe(5)
    expect(segmentDistance(0, 20, 0, 10, 0, -10)).toBe(10)
    expect(segmentDistance(3, 4, 0, 0, 0, 0)).toBe(5)
  })

  it('selects the figure the click is nearest to, within the slack only', () => {
    const npc = { item: 'npc', ax: 100, ay: 200, bx: 100, by: 150 }
    const mob = { item: 'mob', ax: 130, ay: 200, bx: 130, by: 170 }
    expect(nearestOnScreen(104, 180, [npc, mob])).toBe('npc')
    expect(nearestOnScreen(126, 185, [npc, mob])).toBe('mob')
    expect(nearestOnScreen(100 + PICK_SLACK_PX + 1, 175, [npc])).toBeNull()
    expect(nearestOnScreen(100, 150 - PICK_SLACK_PX + 2, [npc])).toBe('npc')
  })
})
