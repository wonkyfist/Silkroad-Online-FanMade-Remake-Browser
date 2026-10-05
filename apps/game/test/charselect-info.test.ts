/**
 * Character select's info window (screens/charselect.ts infoPlace): beside the selected character, never over it.
 * Anchored above the head it covered the face whenever the camera was close (user report, 2026-10-05).
 */
import { describe, expect, it } from 'vitest'
import { infoPlace } from '../src/screens/charselect.ts'

/** The character's screen box (head to feet, 0.2 of its height either side) and the window's box overlap. */
function overlaps(head: { x: number; y: number }, body: number, at: { x: number; y: number }, w: number, h: number): boolean {
  const cx0 = head.x - body * 0.2
  const cx1 = head.x + body * 0.2
  return at.x < cx1 && at.x + w > cx0 && at.y < head.y + body && at.y + h > head.y
}

describe('character select info window', () => {
  const w = 274
  const h = 168

  it('sits right of the body on a wide screen, level with the upper body, clear of the bars', () => {
    const head = { x: 800, y: 300 }
    const at = infoPlace(head, 400, w, h, 1600, 900, 97)
    expect(at.x).toBeGreaterThan(head.x + 400 * 0.2)
    expect(at.y).toBeGreaterThanOrEqual(97)
    expect(at.y + h).toBeLessThanOrEqual(900 - 97)
    expect(overlaps(head, 400, at, w, h)).toBe(false)
  })

  it('goes left of the body when the right has no room', () => {
    const head = { x: 1450, y: 300 }
    const at = infoPlace(head, 400, w, h, 1600, 900, 97)
    expect(at.x + w).toBeLessThan(head.x - 400 * 0.2)
    expect(overlaps(head, 400, at, w, h)).toBe(false)
  })

  it('on a narrow screen with no room either side, goes above the head', () => {
    const head = { x: 390, y: 410 }
    const at = infoPlace(head, 320, 330, 203, 800, 1079, 86)
    expect(at.y + 203).toBeLessThanOrEqual(head.y)
    expect(at.y).toBeGreaterThanOrEqual(86)
    expect(overlaps(head, 320, at, 330, 203)).toBe(false)
  })

  it('a character close to the camera (tall on screen) still keeps its face clear', () => {
    for (const x of [300, 640, 980]) {
      const head = { x, y: 160 }
      const at = infoPlace(head, 520, w, h, 1280, 720, 76)
      expect(overlaps(head, 520, at, w, h)).toBe(false)
    }
  })
})
