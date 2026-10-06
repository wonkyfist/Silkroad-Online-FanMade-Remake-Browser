/**
 * Siege of Jangan, layer 2: where the broken stone lies and how it falls (rubble.ts), the generated stone, mound, cap
 * and timber geometry (stone.ts), the crack art's paths (cracks.ts) and the scaffold frames (scaffold.ts). Pure; seeded
 * (every client builds the same pile).
 */
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { crackPaths } from '../src/world/walls/cracks.ts'
import { WALL_TIERS } from '../src/world/walls/look.ts'
import {
  NOTCH,
  PILE_HEIGHT,
  PILE_SPREAD,
  composeInto,
  euler,
  exposedEdges,
  fallDuration,
  fallPose,
  notchShift,
  pileHeight,
  pileLayout,
  slerp,
  teethLayout,
} from '../src/world/walls/rubble.ts'
import { scaffoldBeams } from '../src/world/walls/scaffold.ts'
import { beamGeometry, capGeometry, chunkGeometry, moundGeometry, type Geometry } from '../src/world/walls/stone.ts'
import { SIDE, flatGround, walls } from './walls-fixture.ts'

const W = walls()
const S2 = W.segments[1]!
const tier = WALL_TIERS.medium

describe('pileLayout', () => {
  const pile = pileLayout(S2, 1, SIDE, flatGround, tier)

  it('is seeded by the third: the same pile on every client, another for another third', () => {
    expect(pileLayout(S2, 1, SIDE, flatGround, tier)).toEqual(pile)
    expect(pileLayout(S2, 0, SIDE, flatGround, tier)[0]!.rest).not.toEqual(pile[0]!.rest)
  })

  it('lays tier.pileChunks chunks over the gap, on the heap, each from a place inside the standing wall', () => {
    expect(pile.length).toBe(tier.pileChunks)
    const t = S2.thirds[1]
    for (const c of pile) {
      expect(c.rest.x).toBeGreaterThanOrEqual(t.from - PILE_SPREAD.ends)
      expect(c.rest.x).toBeLessThanOrEqual(t.to + PILE_SPREAD.ends)
      expect(c.rest.z).toBeGreaterThanOrEqual(SIDE.inner - PILE_SPREAD.inside)
      expect(c.rest.z).toBeLessThanOrEqual(SIDE.outer + PILE_SPREAD.outside)
      // on the ground or the heap, never above the heap's peak plus the chunk
      expect(c.rest.y).toBeGreaterThan(0)
      expect(c.rest.y).toBeLessThan(PILE_HEIGHT.ends + c.s[1])
      // in the wall: within the third, inside the body, below the wall walk
      expect(c.from.x).toBeGreaterThanOrEqual(t.from)
      expect(c.from.x).toBeLessThanOrEqual(t.to)
      expect(c.from.z).toBeGreaterThan(SIDE.inner)
      expect(c.from.z).toBeLessThan(SIDE.outer)
      expect(c.from.y).toBeLessThan(SIDE.walkY)
      expect(c.from.y).toBeGreaterThan(c.rest.y)
      expect(c.delay).toBeGreaterThanOrEqual(0)
      expect([0, 1, 2]).toContain(c.shape)
    }
  })

  it('the heap is low in the middle (people walk through) and high against the broken ends', () => {
    const depth = SIDE.outer - SIDE.inner
    const mid = pileHeight(0.5, depth * 0.55, depth)
    expect(mid).toBeCloseTo(PILE_HEIGHT.middle, 1)
    expect(pileHeight(0, depth * 0.55, depth)).toBeCloseTo(PILE_HEIGHT.ends, 1)
    expect(pileHeight(0.5, -PILE_SPREAD.inside, depth)).toBe(0)
    expect(pileHeight(0.5, depth + PILE_SPREAD.outside, depth)).toBe(0)
  })
})

describe('fallPose: the collapse', () => {
  const pile = pileLayout(S2, 1, SIDE, flatGround, tier)
  const p = { x: 0, y: 0, z: 0 }
  const q: [number, number, number, number] = [0, 0, 0, 1]

  it('sits in the wall before its delay, falls under gravity, hops once and rests exactly on its pile place', () => {
    for (const c of pile.slice(0, 20)) {
      expect(fallPose(c, 0, p, q)).toBe(c.delay <= 0 && fallDuration(c) === 0)
      if (c.delay > 0) expect([p.x, p.y, p.z]).toEqual([c.from.x, c.from.y, c.from.z])
      const end = c.delay + fallDuration(c)
      let lowest = Infinity
      for (let t = 0; t < end; t += 0.05) {
        fallPose(c, t, p, q)
        lowest = Math.min(lowest, p.y)
        expect(Math.hypot(...q)).toBeCloseTo(1, 5)
      }
      expect(lowest).toBeGreaterThanOrEqual(c.rest.y - 1e-6)
      expect(fallPose(c, end + 0.01, p, q)).toBe(true)
      expect([p.x, p.y, p.z]).toEqual([c.rest.x, c.rest.y, c.rest.z])
      expect(q).toEqual(c.rest.q)
    }
  })

  it('a 20 m wall comes down in about the spec\'s 2.5 s', () => {
    const longest = Math.max(...pile.map((c) => c.delay + fallDuration(c)))
    expect(longest).toBeGreaterThan(1.5)
    expect(longest).toBeLessThan(4)
  })
})

describe('edges, notches and teeth', () => {
  it('finds the ends of standing stone beside downed thirds, across segment joins and against the gatehouse', () => {
    const down = new Set(['S2b'])
    const e1 = exposedEdges([SIDE], W.segments, (id) => down.has(id))
    expect(e1.map((e) => [e.id, e.at, e.dir])).toEqual([['S2a>', 60, 1], ['S2c<', 75, -1]])
    const rubble = new Set(['S1a', 'S1b', 'S1c', 'S3a', 'S3b', 'S3c'])
    const e2 = exposedEdges([SIDE], W.segments, (id) => rubble.has(id))
    expect(e2.map((e) => e.id)).toEqual(['S2a<', 'S2c>', 'S-gate<'])
  })

  it('notchShift: nothing low on the end, deeper toward the top, bounded, its own per end', () => {
    for (const seed of [1, 99, 0xdeadbeef, 123456]) {
      expect(notchShift(0, 0.5, seed)).toBe(0)
      expect(notchShift(0.15, 0.5, seed)).toBe(0)
      const top = notchShift(1, 0.5, seed)
      expect(top).toBeGreaterThan(0.5)
      expect(top).toBeLessThanOrEqual(NOTCH.depth * 1.2 * 1.2 + 1e-9)
    }
    expect(notchShift(1, 0.5, 1)).not.toBe(notchShift(1, 0.5, 0x80808080))
  })

  it('teeth sit on the broken end, near the two faces, up its height', () => {
    const [edge] = exposedEdges([SIDE], W.segments, (id) => id === 'S2b')
    const teeth = teethLayout(edge!, flatGround, tier)
    expect(teeth.length).toBe(tier.teeth)
    for (const c of teeth) {
      expect(c.from).toEqual(c.rest)
      expect(c.rest.x).toBeLessThanOrEqual(edge!.at + 1)
      expect(c.rest.x).toBeGreaterThan(edge!.at - NOTCH.depth * 1.5 - 1.2)
      const wf = (c.rest.z - SIDE.inner) / (SIDE.outer - SIDE.inner)
      expect(wf < 0.2 || wf > 0.8).toBe(true)
      expect(c.rest.y).toBeGreaterThan(0.5)
      expect(c.rest.y).toBeLessThan(SIDE.walkY)
    }
    // a profile overrides where the end stands
    const flat = teethLayout(edge!, flatGround, tier, () => 0)
    for (const c of flat) expect(c.rest.x).toBeGreaterThan(edge!.at - 1)
  })
})

describe('matrix and quaternion helpers', () => {
  it('composeInto matches Babylon Matrix.Compose (thin-instance layout)', () => {
    const q = euler(0.3, 1.1, -0.4)
    const m = new Float32Array(16)
    composeInto(m, 0, 1, 2, 3, q, 1.5, 0.5, 2)
    const ref = Matrix.Compose(new Vector3(1.5, 0.5, 2), new Quaternion(...q), new Vector3(1, 2, 3))
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(ref.m[i]!, 5)
  })

  it('euler matches Quaternion.RotationYawPitchRoll; slerp ends on its endpoints', () => {
    const q = euler(0.2, -0.7, 0.9)
    const ref = Quaternion.RotationYawPitchRoll(-0.7, 0.2, 0.9)
    expect(q.map((v) => +v.toFixed(6))).toEqual([ref.x, ref.y, ref.z, ref.w].map((v) => +v.toFixed(6)))
    const out = [0, 0, 0, 0]
    slerp([0, 0, 0, 1], q, 1, out)
    out.forEach((v, i) => expect(v).toBeCloseTo(q[i]!, 6))
  })
})

/** Every triangle's stored normal agrees with its winding (counter-clockwise from outside). */
function windingAgrees(g: Geometry): boolean {
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [g.indices[t]!, g.indices[t + 1]!, g.indices[t + 2]!]
    const P = (i: number) => [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!]
    const [pa, pb, pc] = [P(a), P(b), P(c)]
    const u = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!], v = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!]
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
    const d = n[0]! * g.normals[a * 3]! + n[1]! * g.normals[a * 3 + 1]! + n[2]! * g.normals[a * 3 + 2]!
    if (d <= 0) return false
  }
  return true
}

describe('generated geometry', () => {
  it('a chunk is a closed broken block: 6 octagons and 8 corner cuts, every face pointing out, the lightmap point as UV1', () => {
    for (const look of ['brick', 'core'] as const) {
      const g = chunkGeometry(7, look, [0.25, 0.75])
      expect(g.indices.length / 3).toBe(6 * 6 + 8)
      expect(windingAgrees(g)).toBe(true)
      for (let i = 0; i < g.indices.length; i += 3) {
        // outward: the face's centroid · its normal > 0 (the block is convex about its centre)
        let c = 0
        for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) c += g.positions[(i + k) * 3 + a]! * g.normals[(i + k) * 3 + a]!
        expect(c).toBeGreaterThan(0)
      }
      for (let i = 0; i < g.uvs2.length; i += 2) expect([g.uvs2[i], g.uvs2[i + 1]]).toEqual([0.25, 0.75])
      expect(Math.max(...g.positions.map(Math.abs))).toBeLessThan(0.6)
    }
    expect(chunkGeometry(1, 'brick')).toEqual(chunkGeometry(1, 'brick'))
  })

  it('a mound faces up, sits on the ground at its rim and rises to the given height', () => {
    const g = moundGeometry({ cells: [8, 6], height: () => 2, ground: () => 1, at: (u, w) => [u * 16, w * 30], seed: 3 })
    expect(windingAgrees(g)).toBe(true)
    for (let i = 1; i < g.normals.length; i += 3) expect(g.normals[i]!).toBeGreaterThan(0)
    let lo = Infinity, hi = -Infinity
    for (let i = 1; i < g.positions.length; i += 3) {
      lo = Math.min(lo, g.positions[i]!)
      hi = Math.max(hi, g.positions[i]!)
    }
    expect(lo).toBeCloseTo(1.05, 5)
    expect(hi).toBeGreaterThan(2.5)
    expect(hi).toBeLessThan(3.3)
  })

  it('a broken end face spans the two faces\' end lines and faces into the gap', () => {
    const outer: [number, number, number][] = [[60, 0, 30], [60, 8, 30], [58, 20, 30]]
    const inner: [number, number, number][] = [[60, 0, 10], [59, 12, 10], [57, 20, 10]]
    const g = capGeometry(outer, inner, [1, 0], 5)!
    expect(windingAgrees(g)).toBe(true)
    let into = 0
    for (let i = 0; i < g.normals.length; i += 3) into += g.normals[i]!
    expect(into).toBeGreaterThan(0)
    expect(capGeometry([[0, 0, 0]], inner, [1, 0], 5)).toBeNull()
  })

  it('a beam is a closed unit box', () => {
    const g = beamGeometry()
    expect(g.indices.length).toBe(36)
    expect(windingAgrees(g)).toBe(true)
  })
})

describe('crack art and scaffold', () => {
  it('crack paths are seeded, inside the decal, deeper at level 2 (with broken-out pockets)', () => {
    for (const level of [1, 2] as const) {
      const a = crackPaths(42, level)
      expect(crackPaths(42, level)).toEqual(a)
      expect(a.lines.length).toBeGreaterThan(0)
      for (const l of a.lines) for (const [x, y] of l.pts) {
        expect(x).toBeGreaterThan(-0.05)
        expect(x).toBeLessThan(1.05)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThan(1.1)
      }
    }
    expect(crackPaths(42, 1).spalls).toEqual([])
    const deep = [1, 2, 3, 4, 5].map((s) => crackPaths(s, 2))
    expect(deep.some((a) => a.spalls.length > 0)).toBe(true)
    expect(Math.max(...deep.map((a) => a.lines[0]!.width))).toBeGreaterThan(crackPaths(1, 1).lines[0]!.width)
  })

  it('a scaffold stands against its face, over its third, from the ground to below the wall walk', () => {
    for (const outer of [true, false]) {
      const beams = scaffoldBeams(S2, 0, SIDE, outer, flatGround)
      expect(beams.length).toBeGreaterThan(40)
      for (const b of beams) {
        expect(b.x).toBeGreaterThan(S2.thirds[0].from - 1)
        expect(b.x).toBeLessThan(S2.thirds[0].to + 1)
        if (outer) expect(b.z).toBeGreaterThan(SIDE.outer)
        else expect(b.z).toBeLessThan(SIDE.inner)
        expect(b.y).toBeGreaterThan(0)
        expect(b.y).toBeLessThan(SIDE.walkY)
        expect(Math.hypot(...b.q)).toBeCloseTo(1, 6)
      }
    }
  })
})
