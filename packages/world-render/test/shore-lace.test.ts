/**
 * CST-S, the foam lace (docs/COAST.md §8.8, §12.5; shore/lace.ts): deterministic (the same bytes every run, and the
 * sliced generation the part uses equals the reference run), tileable (the wrap seam is no rougher than the inside),
 * and shaped as the shader expects (R spans strands → open cells, G bubbles only near strands, B a mottling, A a value
 * per cell).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LACE_SIZE, LACE_TILE_M, fillLace, makeLace, makeLaceSliced } from '../src/shore/lace.ts'

const SIZE = 128
const md5 = (d: Uint8Array) => createHash('md5').update(d).digest('hex')

describe('the lace texture (SurfFoam.js makeLaceTexture)', () => {
  it('is 512² and 2.2 m per tile in the game (the look check; COAST §8.8 named 3.5 m)', () => {
    expect(LACE_SIZE).toBe(512)
    expect(LACE_TILE_M).toBe(2.2)
  })

  it('is deterministic: two runs give the same bytes, and the sliced run equals the reference run', async () => {
    const a = makeLace(SIZE)
    const b = makeLace(SIZE)
    expect(md5(a)).toBe(md5(b))
    const queue: Array<() => void> = []
    const p = makeLaceSliced(SIZE, 7, () => false, fn => void queue.push(fn))
    while (queue.length) queue.shift()!()
    const sliced = await p
    expect(sliced).not.toBeNull()
    expect(md5(sliced!)).toBe(md5(a))
    // A partial fill touches only its rows.
    const part = new Uint8Array(SIZE * SIZE * 4)
    fillLace(part, SIZE, 10, 20)
    expect(md5(part.subarray(10 * SIZE * 4, 20 * SIZE * 4))).toBe(md5(a.subarray(10 * SIZE * 4, 20 * SIZE * 4)))
    expect(part.subarray(0, 10 * SIZE * 4).every(v => v === 0)).toBe(true)
  })

  it('stops when cancelled', async () => {
    const queue: Array<() => void> = []
    let cancel = false
    const p = makeLaceSliced(SIZE, 8, () => cancel, fn => void queue.push(fn))
    queue.shift()!()
    queue.shift()!()
    cancel = true
    while (queue.length) queue.shift()!()
    expect(await p).toBeNull()
  })

  it('tiles: the step across the wrap seam is no larger than the steps inside', () => {
    const d = makeLace(SIZE)
    const at = (x: number, y: number, c: number) => d[((y % SIZE) * SIZE + (x % SIZE)) * 4 + c]!
    for (const c of [0, 2]) {
      let inside = 0, seamX = 0, seamY = 0
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE - 1; x++) inside += Math.abs(at(x, y, c) - at(x + 1, y, c))
        seamX += Math.abs(at(SIZE - 1, y, c) - at(0, y, c))
        seamY += Math.abs(at(y, SIZE - 1, c) - at(y, 0, c))
      }
      const meanInside = inside / (SIZE * (SIZE - 1))
      expect(seamX / SIZE).toBeLessThan(meanInside * 2.5 + 1)
      expect(seamY / SIZE).toBeLessThan(meanInside * 2.5 + 1)
    }
  })

  it('has strands and open cells (R), bubbles only near strands (G), a mottling (B) and a value per cell (A)', () => {
    const d = makeLace(SIZE)
    const n = SIZE * SIZE
    let strands = 0, open = 0, bubbles = 0, farBubbles = 0
    let bMin = 255, bMax = 0
    const aValues = new Set<number>()
    for (let i = 0; i < n; i++) {
      const r = d[i * 4]!, g = d[i * 4 + 1]!, b = d[i * 4 + 2]!, a = d[i * 4 + 3]!
      if (r < 40) strands++
      if (r > 200) open++
      if (g > 128) {
        bubbles++
        if (r > 140) farBubbles++
      }
      bMin = Math.min(bMin, b)
      bMax = Math.max(bMax, b)
      aValues.add(a)
    }
    expect(strands / n).toBeGreaterThan(0.05)
    expect(open / n).toBeGreaterThan(0.05)
    expect(bubbles / n).toBeGreaterThan(0.005)
    expect(farBubbles).toBe(0)
    expect(bMax - bMin).toBeGreaterThan(60)
    expect(aValues.size).toBeGreaterThan(20)
  })
})
