import { describe, expect, it } from 'vitest'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxSimulation, scheduleMask, validateFxEffect, type FxEffect, type FxNode } from '../src/index.ts'

const LINK = {
  positionDepth: 1,
  matrixDepth: 1,
  velocityDepth: 0,
  followDepth: 1,
  localMotion: false,
  shapeMotion: false,
  keepMatrix: false,
  keepOrigin: false,
}

function node(partial: Partial<FxNode>): FxNode {
  return {
    name: 'n',
    parent: -1,
    frames: 10,
    life: 'extinct',
    emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 },
    link: { ...LINK },
    render: 'none',
    view: 'none',
    material: null,
    commands: [],
    ...partial,
  }
}

function effect(nodes: FxNode[]): FxEffect {
  return { format: FX_FORMAT, version: FX_VERSION, key: 'test.efp', fps: FX_FPS, scale: 1, textures: [], meshes: [], nodes, duration: null, provenance: 'test', warnings: [] }
}

const origin = { position: [0, 0, 0] as [number, number, number] }

describe('scheduleMask', () => {
  it('expands first + trunc(i * period)', () => {
    expect([...scheduleMask([0, 1, 3], 5)]).toEqual([1, 1, 1, 0, 0])
    expect([...scheduleMask([1, 1.5, 3], 6)]).toEqual([0, 1, 1, 0, 1, 0])
    expect([...scheduleMask([0, 1, 0], 3)]).toEqual([0, 0, 0])
  })
})

describe('FxSimulation', () => {
  it('validates the synthetic program', () => {
    expect(validateFxEffect(effect([node({})]))).toBeNull()
    expect(validateFxEffect({ ...effect([node({ parent: 0 })]) })).toMatch(/parent/)
  })

  it('emits one element that lives `frames` ticks', () => {
    const sim = new FxSimulation(effect([node({ frames: 4 })]))
    const live: number[] = []
    for (let t = 0; t < 6; t++) {
      sim.step(origin)
      live.push(sim.liveCount)
    }
    expect(live).toEqual([1, 1, 1, 1, 0, 0])
    expect(sim.finished).toBe(true)
  })

  it('caps concurrent elements with limit and refills as they retire (float accumulator)', () => {
    // Every tick for 20 ticks, rate 1, limit 3, each lives 5 ticks.
    const sim = new FxSimulation(effect([node({ frames: 5, emit: { start: 0, duration: 20, period: 1, limit: 3, rate: 1 } })]))
    const live: number[] = []
    for (let t = 0; t < 12; t++) {
      sim.step(origin)
      live.push(sim.liveCount)
    }
    expect(Math.max(...live)).toBe(3)
    expect(live.slice(0, 3)).toEqual([1, 2, 3])
    // The first retires at tick 5, freeing a slot that is refilled in the same tick.
    expect(live[5]).toBe(3)
  })

  it('accumulates fractional rates', () => {
    const sim = new FxSimulation(effect([node({ frames: 100, emit: { start: 0, duration: 8, period: 1, limit: 100, rate: 0.5 } })]))
    for (let t = 0; t < 10; t++) sim.step(origin)
    expect(sim.liveCount).toBe(4)
  })

  it('children emit from every parent element and inherit its position', () => {
    const sim = new FxSimulation(
      effect([
        node({ frames: 20, emit: { start: 0, duration: 2, period: 1, limit: 2, rate: 1 }, commands: [{ op: 'position', base: 'parent', basis: 'world', v: [1, 0, 0], at: [0, 1, 1], flags: 1 }] }),
        node({ parent: 0, frames: 20, emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 }, link: { ...LINK, positionDepth: 0, matrixDepth: 0, followDepth: 0 } }),
      ]),
    )
    sim.step(origin)
    sim.step(origin)
    expect(sim.elements[0]!.length).toBe(2)
    expect(sim.elements[1]!.length).toBe(2)
    for (const c of sim.elements[1]!) expect(c.pos[0]).toBeCloseTo(1)
  })

  it('moves by velocity each tick and follows the root when followDepth = 1', () => {
    const sim = new FxSimulation(effect([node({ frames: 50, commands: [{ op: 'velocity', basis: 'world', v: [0, 0.1, 0], at: [0, 1, 1], flags: 0 }] })]))
    sim.step({ position: [0, 0, 0] })
    for (let t = 0; t < 10; t++) sim.step({ position: [t + 1, 0, 0] })
    const e = sim.elements[0]![0]!
    expect(e.pos[1]).toBeCloseTo(1, 5)
    expect(e.pos[0]).toBeCloseTo(10, 5)
  })

  it('stays in the world when followDepth = 0', () => {
    const sim = new FxSimulation(effect([node({ frames: 50, link: { ...LINK, followDepth: 0, positionDepth: 0 } })]))
    sim.step({ position: [0, 0, 0] })
    for (let t = 0; t < 5; t++) sim.step({ position: [t + 1, 0, 0] })
    expect(sim.elements[0]![0]!.pos[0]).toBeCloseTo(0)
  })

  it('applies per-age tables and loops', () => {
    const color = { at: [0, 1, 4] as [number, number, number], values: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0] }
    const sim = new FxSimulation(effect([node({ frames: 4, life: 'loop', color })]))
    const seen: number[][] = []
    for (let t = 0; t < 6; t++) {
      sim.step(origin)
      seen.push([...sim.elements[0]![0]!.color])
    }
    expect(seen[0]).toEqual([1, 0, 0, 1])
    expect(seen[3]).toEqual([1, 1, 1, 0])
    expect(seen[4]).toEqual([1, 0, 0, 1])
    expect(sim.finished).toBe(false)
  })

  it('scales lengths by the instance scale', () => {
    const sim = new FxSimulation(effect([node({ frames: 5 })]), { scale: 2 })
    sim.step({ position: [4, 0, 0] })
    expect(sim.elements[0]![0]!.pos[0]).toBeCloseTo(2)
  })

  it('restarts when looping a finished effect', () => {
    const sim = new FxSimulation(effect([node({ frames: 2 })]), { loop: true })
    const live: number[] = []
    for (let t = 0; t < 6; t++) {
      sim.step(origin)
      live.push(sim.liveCount)
    }
    expect(live).toEqual([1, 1, 0, 1, 1, 0])
  })
})
