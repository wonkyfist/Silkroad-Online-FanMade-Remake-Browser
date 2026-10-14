/**
 * The weapons' cloth sim (docs/RARITY.md §6.2, three/weapon-cloth.ts): a ribbon card modelled sticking straight out
 * from a shaft must hang under gravity, stream downwind, stay pinned and unstretched, stay stable at any frame rate,
 * whip after a swing; and the level of detail (sim near and on screen, shader sway far, frozen off screen).
 */
import { describe, expect, it } from 'vitest'
import { CLOTH_H, ClothSim, buildCloth, type ClothEnv } from '../src/three/weapon-cloth.ts'
import { CLOTH_FAR_M, CLOTH_NEAR_M, clothLod } from '../src/three/weapon-sway.ts'
import { subdivideParts } from '../src/three/weapon-sway-parts.ts'

/** A shaft box along z and a 1 m × 0.2 m ribbon card sticking out along +x from its side (pinned at x = 0.02). */
function ribbon() {
  const pos: number[] = []
  const idx: number[] = []
  const sway: number[] = []
  // the shaft: a thin box (rigid)
  const o = 0
  for (let i = 0; i < 8; i++) {
    pos.push(i & 1 ? 0.02 : -0.02, i & 2 ? 0.02 : -0.02, i & 4 ? 1 : -1)
    sway.push(0, 0, 0, 0)
  }
  for (const v of [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]) idx.push(o + v)
  // the card in the xz plane: 4 columns along x, 1 row across z
  const c0 = pos.length / 3
  const cols = 4
  for (let i = 0; i <= cols; i++) {
    const x = 0.02 + i / cols
    pos.push(x, 0, 0.4, x, 0, 0.6)
    const w = i / cols
    sway.push(w, 0.3, 1, 0.45, w, 0.3, 1, 0.45)
  }
  for (let i = 0; i < cols; i++) {
    const a = c0 + 2 * i
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2)
  }
  const sub = subdivideParts({ position: { data: pos, stride: 3 }, s: { data: sway, stride: 4 } }, idx, i => sway[i * 4 + 2]! > 0, 2)
  return { pos: sub.streams.position!, idx: sub.indices, sway: sub.streams.s! }
}

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 0, 1]
const calm = (): ClothEnv => ({ windX: 1, windZ: 0, windMs: 0, time: 0, groundY: -Infinity })

function run(sim: ClothSim, env: ClothEnv, seconds: number, dt = 1 / 60, world: number[] = ID): void {
  for (let t = 0; t < seconds; t += dt) {
    env.time += dt
    sim.advance(dt, world, env)
  }
}

function model() {
  const r = ribbon()
  return buildCloth(r.pos, r.idx, r.sway)!
}

/** Mean of a coordinate over the free particles. */
function mean(sim: ClothSim, axis: number): number {
  let s = 0, n = 0
  for (let i = 0; i < sim.model.n; i++) if (sim.model.invMass[i]) {
    s += sim.x[3 * i + axis]!
    n++
  }
  return s / n
}

function maxStretch(sim: ClothSim): number {
  const m = sim.model
  let sd = 0, sr = 0
  for (let e = 0; e < m.edges.length; e += 2) {
    const a = m.edges[e]!, b = m.edges[e + 1]!
    sd += Math.hypot(sim.x[3 * a]! - sim.x[3 * b]!, sim.x[3 * a + 1]! - sim.x[3 * b + 1]!, sim.x[3 * a + 2]! - sim.x[3 * b + 2]!)
    sr += m.edgeRest[e / 2]!
  }
  return sd / sr - 1
}

describe('the cloth', () => {
  it('is built from the subdivided card: welded particles, the attachment edge pinned, the shaft a capsule', () => {
    const m = model()
    expect(m.n).toBe(17 * 5) // 4 × 4 columns + 1, 1 × 4 rows + 1
    expect(m.pins.length).toBe(5)
    for (const p of m.pins) expect(m.rest[3 * p]!).toBeCloseTo(0.02, 5)
    expect(m.bends.length).toBeGreaterThan(0)
    expect(m.shaftR).toBeGreaterThan(0)
  })

  it('hangs under gravity instead of sticking out, the pins hold, it does not stretch', () => {
    const sim = new ClothSim(model())
    sim.reset(ID)
    run(sim, calm(), 4)
    // modelled straight out along +x at y = 1.2: it falls to hang below the shaft
    expect(mean(sim, 1)).toBeLessThan(1.2 - 0.3)
    expect(mean(sim, 0)).toBeLessThan(0.2)
    for (const p of sim.model.pins) {
      expect(sim.x[3 * p + 1]!).toBeCloseTo(1.2, 5)
      expect(sim.x[3 * p]!).toBeCloseTo(0.02, 5)
    }
    expect(maxStretch(sim)).toBeLessThan(0.05)
  })

  it('streams downwind, more in a storm than in a breeze', () => {
    const along = (ms: number, x: number, z: number) => {
      const sim = new ClothSim(model())
      sim.reset(ID)
      const env = { ...calm(), windX: x, windZ: z, windMs: ms }
      run(sim, env, 4)
      let s = 0
      for (let k = 0; k < 60; k++) {
        run(sim, env, 1 / 60)
        s += mean(sim, 0) * x + (mean(sim, 2) - 0.5) * z
      }
      return { s: s / 60, stretch: maxStretch(sim), y: mean(sim, 1) }
    }
    // wind across the card's hanging plane (along z) pushes it out downwind
    const breeze = along(3, 0, 1)
    const storm = along(16, 0, 1)
    expect(breeze.s).toBeGreaterThan(0.05)
    expect(storm.s).toBeGreaterThan(breeze.s + 0.15)
    // a storm lifts it toward horizontal
    expect(storm.y).toBeGreaterThan(breeze.y)
    expect(storm.stretch).toBeLessThan(0.06)
  })

  it('running streams it behind the weapon (the relative wind)', () => {
    const sim = new ClothSim(model())
    sim.reset(ID)
    const env = calm()
    const w = [...ID]
    for (let k = 0; k < 240; k++) {
      w[14] = (k / 60) * 6 // 6 m/s along +z
      env.time += 1 / 60
      sim.advance(1 / 60, w, env)
    }
    // behind: −z of the pins
    expect(mean(sim, 2) - w[14]! - 0.5).toBeLessThan(-0.2)
  })

  it('a swing whips it: the free end lags, then catches up', () => {
    const sim = new ClothSim(model())
    sim.reset(ID)
    const env = calm()
    run(sim, env, 3)
    const w = [...ID]
    // a fast upward swing of 1 m in 0.15 s
    for (let k = 1; k <= 9; k++) {
      w[13] = 1.2 + k / 9
      env.time += 1 / 60
      sim.advance(1 / 60, w, env)
    }
    const lag = 2.2 - mean(sim, 1)
    expect(lag).toBeGreaterThan(0.45)
    run(sim, env, 2, 1 / 60, w)
    expect(2.2 - mean(sim, 1)).toBeLessThan(lag)
    expect(maxStretch(sim)).toBeLessThan(0.06)
  })

  it('the fixed step is stable at any frame rate: 30, 60, 144 fps and a hitch end in the same place', () => {
    const end = (dts: number[]) => {
      const sim = new ClothSim(model())
      sim.reset(ID)
      const env = { ...calm(), windMs: 5 }
      for (let i = 0; i < 400; i++) {
        const dt = dts[i % dts.length]!
        env.time += dt
        sim.advance(dt, ID, env)
      }
      for (let i = 0; i < sim.x.length; i++) expect(Number.isFinite(sim.x[i]!)).toBe(true)
      return { y: mean(sim, 1), stretch: maxStretch(sim) }
    }
    const a = end([1 / 30])
    const b = end([1 / 60])
    const c = end([1 / 144])
    const d = end([1 / 60, 1 / 60, 0.25])
    for (const r of [a, b, c, d]) {
      expect(r.stretch).toBeLessThan(0.06)
      expect(r.y).toBeLessThan(1.15)
      expect(Math.abs(r.y - b.y)).toBeLessThan(0.15)
      expect(r.y).toBeGreaterThan(0.1)
    }
    expect(CLOTH_H).toBeCloseTo(1 / 60)
  })

  it('rests on the ground under its owner', () => {
    const sim = new ClothSim(model())
    sim.reset(ID)
    run(sim, { ...calm(), groundY: 0.9 }, 3)
    for (let i = 0; i < sim.model.n; i++) expect(sim.x[3 * i + 1]!).toBeGreaterThanOrEqual(0.9 - 1e-6)
  })

  it('writes the particles back into the mesh space with normals', () => {
    const r = ribbon()
    const m = buildCloth(r.pos, r.idx, r.sway)!
    const sim = new ClothSim(m)
    sim.reset(ID)
    run(sim, calm(), 2)
    const pos = Float32Array.from(r.pos)
    const nrm = new Float32Array(pos.length)
    const inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.2, 0, 1]
    sim.writeBack(inv, pos, nrm)
    // the shaft untouched, the cloth moved, its normals unit
    for (let i = 0; i < 24; i++) expect(pos[i]!).toBeCloseTo(r.pos[i]!, 6)
    const v = m.clothVerts[m.clothVerts.length - 1]!
    expect(pos[3 * v + 1]!).toBeLessThan(-0.2)
    expect(Math.hypot(nrm[3 * v]!, nrm[3 * v + 1]!, nrm[3 * v + 2]!)).toBeCloseTo(1, 4)
  })
})

describe('the cloth level of detail', () => {
  it('sims near and on screen, the shader far, frozen off screen, with hysteresis', () => {
    expect(clothLod(5, true, false)).toBe('sim')
    expect(clothLod(CLOTH_NEAR_M + 1, true, false)).toBe('shader')
    expect(clothLod(CLOTH_NEAR_M + 1, true, true)).toBe('sim')
    expect(clothLod(CLOTH_FAR_M + 1, true, true)).toBe('shader')
    expect(clothLod(3, false, true)).toBe('frozen')
  })
})

describe('a scaled weapon (worn: the owner scales it ×1.84)', () => {
  it('keeps its world length: rest lengths follow the world matrix scale', () => {
    const s = 1.84
    const W = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 2, 0, 1]
    const sim = new ClothSim(model())
    sim.reset(W)
    run(sim, { ...calm(), windX: 0, windZ: 1, windMs: 3 }, 3, 1 / 60, W)
    const m = sim.model
    let sd = 0, sr = 0
    for (let e = 0; e < m.edges.length; e += 2) {
      const a = m.edges[e]!, b = m.edges[e + 1]!
      sd += Math.hypot(sim.x[3 * a]! - sim.x[3 * b]!, sim.x[3 * a + 1]! - sim.x[3 * b + 1]!, sim.x[3 * a + 2]! - sim.x[3 * b + 2]!)
      sr += m.edgeRest[e / 2]! * s
    }
    expect(Math.abs(sd / sr - 1)).toBeLessThan(0.05)
  })
})

describe("the owner's body", () => {
  it('the cloth falls round it, not through it', () => {
    const sim = new ClothSim(model())
    sim.reset(ID)
    // a torso right under the ribbon (its axis at x 0.3, z 0.5)
    const body = { x: 0.3, z: 0.5, y0: 0, y1: 1.15, r: 0.2 }
    run(sim, { ...calm(), body }, 3)
    for (let i = 0; i < sim.model.n; i++) {
      const y = sim.x[3 * i + 1]!
      if (y <= body.y0 || y >= body.y1 || !sim.model.invMass[i]) continue
      expect(Math.hypot(sim.x[3 * i]! - body.x, sim.x[3 * i + 2]! - body.z)).toBeGreaterThan(body.r - 0.03)
    }
  })
})
