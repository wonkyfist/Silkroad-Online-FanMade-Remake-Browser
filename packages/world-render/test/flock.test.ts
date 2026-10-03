/**
 * GL-L, the bird flight (docs/GRASS_LIFE.md §5.3, X12; docs/WAVE_PLAN6.md §6.1 GL-L): circle → land → ground → flush →
 * circle; a threat at 9 m starts the first bird within 0.25 s and has every bird airborne within 0.6 s; the birds never
 * go below the ground; no allocation per update; the fly-over crosses and ends.
 */
import { describe, expect, it } from 'vitest'
import { BIRD_STRIDE, FLUSH_M, Flock, FlyOver, type FlockGround, type FlockThreat } from '../src/life/flock.ts'

const DT = 1 / 60
const flat: FlockGround = { heightAt: () => 0 }
/** A tilted, rolling ground. */
const hilly: FlockGround = { heightAt: (x, z) => 0.3 * x + Math.sin(z * 0.2) * 1.5 }

function run(f: Flock, s: number, threats: readonly FlockThreat[], ground: FlockGround, each?: () => void): void {
  for (let t = 0; t < s; t += DT) {
    f.update(DT, threats, ground)
    each?.()
  }
}

/** A flock grounded at (0, g, 0), by landing from the air. */
function landed(n: number, seed: number, ground = flat): Flock {
  const f = new Flock(n, seed)
  f.spawnCircle(30, (ground.heightAt(30, 0) ?? 0) + 15, 0)
  f.land(0, ground.heightAt(0, 0) ?? 0, 0, ground)
  run(f, 20, [], ground)
  return f
}

describe('the flock state machine', () => {
  it('circles, lands, stays on the ground, flushes when a threat comes near, then circles again', () => {
    const f = new Flock(12, 7)
    f.spawnCircle(0, 15, 0)
    expect(f.state).toBe('circle')
    run(f, 5, [], flat)
    expect(f.state).toBe('circle')
    expect(f.grounded()).toBe(0)
    // Circling: the birds stay near their ring, high above the ground.
    for (let i = 0; i < f.n; i++) expect(f.pos[i * 3 + 1]!).toBeGreaterThan(5)
    // Asked to land, each bird glides to its slot and folds its wings.
    f.land(40, 0, 10, flat)
    expect(f.state).toBe('land')
    run(f, 20, [], flat)
    expect(f.state).toBe('ground')
    expect(f.grounded()).toBe(f.n)
    for (let i = 0; i < f.n; i++) {
      expect(Math.hypot(f.pos[i * 3]! - 40, f.pos[i * 3 + 2]! - 10)).toBeLessThan(4)
      expect(f.pos[i * 3 + 1]!).toBeLessThan(0.15)
    }
    // A threat 12 m away does nothing; one at 9 m flushes it.
    const far = [{ x: 52, y: 0, z: 10 }]
    run(f, 2, far, flat)
    expect(f.state).toBe('ground')
    const near = [{ x: 49, y: 0, z: 10 }]
    f.update(DT, near, flat)
    expect(f.state).toBe('flush')
    expect(f.flushed).toBe(true)
    f.update(DT, near, flat)
    expect(f.flushed).toBe(false)
    run(f, 3, near, flat)
    expect(f.state).toBe('circle')
    expect(f.grounded()).toBe(0)
    // It circles away from where the threat stood.
    expect(f.centre[0]!).toBeLessThan(40)
  })

  it('wants to land after its 20–40 s of circling, and postpones on request', () => {
    const f = new Flock(8, 3)
    f.spawnCircle(0, 15, 0)
    run(f, 19.9, [], flat)
    expect(f.wantsLanding()).toBe(false)
    run(f, 20.2, [], flat)
    expect(f.wantsLanding()).toBe(true)
    f.postpone(5)
    expect(f.wantsLanding()).toBe(false)
    run(f, 5.1, [], flat)
    expect(f.wantsLanding()).toBe(true)
  })

  it('goes round again when somebody walks up to the spot while it lands', () => {
    const f = new Flock(10, 11)
    f.spawnCircle(30, 15, 0)
    f.land(0, 0, 0, flat)
    run(f, 0.5, [{ x: 5, y: 0, z: 0 }], flat)
    expect(f.state).toBe('circle')
  })

  it('a threat at 9 m: the first bird is up within 0.25 s, every bird within 0.6 s (X12), for any seed and size', () => {
    let worstFirst = 0, worstAll = 0
    for (let seed = 1; seed <= 60; seed++) {
      const n = 8 + (seed % 9)
      const f = landed(n, seed)
      expect(f.state).toBe('ground')
      // The threat stands exactly 9 m from the landing spot, in a direction that changes with the seed.
      const a = seed * 0.7
      const threat = [{ x: Math.cos(a) * FLUSH_M, y: 0, z: Math.sin(a) * FLUSH_M }]
      let t = 0, first = -1, all = -1
      while (t < 1.5 && all < 0) {
        f.update(DT, threat, flat)
        t += DT
        let up = 0
        for (let i = 0; i < n; i++) if (f.airborne(i)) up++
        if (up > 0 && first < 0) first = t
        if (up === n) all = t
        // Airborne means off the ground: above its slot.
        if (f.state === 'flush') for (let i = 0; i < n; i++) if (f.airborne(i)) expect(f.pos[i * 3 + 1]!).toBeGreaterThan(0.02)
      }
      expect(first, `seed ${seed}: first bird`).toBeGreaterThan(0)
      expect(first, `seed ${seed}: first bird`).toBeLessThanOrEqual(0.25)
      expect(all, `seed ${seed}: every bird`).toBeGreaterThan(0)
      expect(all, `seed ${seed}: every bird`).toBeLessThanOrEqual(0.6)
      worstFirst = Math.max(worstFirst, first)
      worstAll = Math.max(worstAll, all)
    }
    expect(worstFirst).toBeLessThanOrEqual(0.25)
    expect(worstAll).toBeLessThanOrEqual(0.6)
  })

  it('never puts a bird below the ground, on hilly ground, through a whole cycle and a leave', () => {
    const f = new Flock(16, 5)
    f.spawnCircle(20, (hilly.heightAt(20, 0) ?? 0) + 15, 0)
    let worst = Infinity
    const check = () => {
      for (let i = 0; i < f.n; i++) {
        const g = hilly.heightAt(f.pos[i * 3]!, f.pos[i * 3 + 2]!)!
        worst = Math.min(worst, f.pos[i * 3 + 1]! - g)
      }
    }
    run(f, 10, [], hilly, check)
    f.land(0, hilly.heightAt(0, 0)!, 0, hilly)
    run(f, 20, [], hilly, check)
    expect(f.state).toBe('ground')
    run(f, 4, [{ x: 6, y: hilly.heightAt(6, 3)!, z: 3 }], hilly, check)
    run(f, 20, [], hilly, check)
    f.leave(1, 0)
    run(f, 5, [], hilly, check)
    expect(worst).toBeGreaterThanOrEqual(-1e-3)
  })

  it('perches at a fixed height (a roof) and sits still there', () => {
    const f = new Flock(2, 9, { hops: false, spreadM: 0.3, flushM: 6 })
    f.spawnCircle(30, 20, 0)
    f.land(0, 12, 0, flat, true)
    run(f, 20, [], flat)
    expect(f.state).toBe('ground')
    for (let i = 0; i < 2; i++) expect(f.pos[i * 3 + 1]!).toBeCloseTo(12.02, 2)
    // Somebody on the ground below, 12 m down, does not flush a percher (3D distance).
    run(f, 1, [{ x: 0, y: 0, z: 0 }], flat)
    expect(f.state).toBe('ground')
    run(f, 0.1, [{ x: 3, y: 11, z: 0 }], flat)
    expect(f.state).toBe('flush')
  })

  it('does not allocate per update (the state lives in fixed typed arrays)', () => {
    const f = landed(16, 21)
    const arrays = [f.pos, f.vel, f.head, f.fold, f.phase, f.delay, f.hop, f.up, f.centre, f.spot, f.mean]
    const threats = [{ x: 30, y: 0, z: 30 }]
    const buf = new Float32Array(16 * BIRD_STRIDE)
    f.spawnCircle(0, 15, 0)
    f.postpone(1e9)
    // Warm up (the JIT), then rounds of 200 calls: a round with a GC in it shrinks (ignored); the cleanest round shows
    // what a call allocates. The per-bird Math.hypot this replaced boxed ≈ 460 KB per round of updates; the flock now
    // allocates nothing per bird (a few boxed doubles per update: its clock fields, ≈ 3 KB per round).
    const cleanest = (fn: () => void): number => {
      for (let k = 0; k < 5000; k++) fn()
      const rounds: number[] = []
      for (let r = 0; r < 12; r++) {
        const before = process.memoryUsage().heapUsed
        for (let k = 0; k < 200; k++) fn()
        const grown = process.memoryUsage().heapUsed - before
        if (grown >= 0) rounds.push(grown)
      }
      return rounds.length ? Math.min(...rounds) : 0
    }
    expect(cleanest(() => f.update(DT, threats, hilly))).toBeLessThan(32 * 1024)
    // The record write: in place (a helper taking the 15 doubles as arguments boxed them: ≈ 750 KB per round).
    expect(cleanest(() => {
      f.write(buf, 0, 1.3, 0, 0)
    })).toBeLessThan(192 * 1024)
    expect([f.pos, f.vel, f.head, f.fold, f.phase, f.delay, f.hop, f.up, f.centre, f.spot, f.mean]).toEqual(arrays)
    for (let i = 0; i < 3; i++) expect(arrays[i]).toBe([f.pos, f.vel, f.head][i])
  })

  it('writes the bird shader record: forward, flap phase, bank, fold, scale, amplitude, colours, position', () => {
    const f = landed(4, 2)
    const buf = new Float32Array(4 * BIRD_STRIDE)
    expect(f.write(buf, 0, 1.3, 123, 456, 0.8)).toBe(4)
    for (let i = 0; i < 4; i++) {
      const o = i * BIRD_STRIDE
      expect(Math.hypot(buf[o]!, buf[o + 1]!, buf[o + 2]!)).toBeCloseTo(1, 3)
      expect(buf[o + 5]).toBeGreaterThan(0.9) // folded on the ground
      expect(buf[o + 6]).toBeCloseTo(1.3)
      expect(buf[o + 7]).toBe(0) // no flap while folded
      expect(buf[o + 8]).toBe(123)
      expect(buf[o + 9]).toBe(456)
      expect(buf[o + 12]).toBeCloseTo(f.pos[i * 3]!)
      expect(buf[o + 13]).toBeCloseTo(f.pos[i * 3 + 1]!)
      expect(buf[o + 15]).toBe(1)
    }
  })
})

describe('the fly-over', () => {
  it('crosses the area at its height above the ground, then is done', () => {
    const p = new FlyOver(5, 4, 0, 0, 1, 0, { heightM: 14, speedMs: 11, flapHz: 3, halfLengthM: 90 })
    let minAbove = Infinity
    let t = 0
    while (!p.done && t < 60) {
      p.update(DT, hilly)
      t += DT
      for (let i = 0; i < p.n; i++) {
        const g = hilly.heightAt(p.pos[i * 3]!, p.pos[i * 3 + 2]!)!
        minAbove = Math.min(minAbove, p.pos[i * 3 + 1]! - g)
      }
    }
    expect(p.done).toBe(true)
    // 180 m plus the group's length at 11 m/s.
    expect(t).toBeGreaterThan(15)
    expect(t).toBeLessThan(25)
    expect(minAbove).toBeGreaterThan(2)
    for (let i = 0; i < p.n; i++) expect(p.pos[i * 3]!).toBeGreaterThan(80)
  })
})
