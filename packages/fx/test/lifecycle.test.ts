/**
 * Effect lifecycle (W5-V): a stopped looping effect finishes instead of restarting, and FxStreak (arrow shafts,
 * imbue glows) builds a finite camera-facing strip and disposes its mesh while the shared material stays.
 */
import { ArcRotateCamera, NullEngine, Scene, Vector3, VertexBuffer } from '@babylonjs/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxSimulation, FxStreak, streakMaterial, type FxEffect } from '../src/index.ts'

const LINK = { positionDepth: 1, matrixDepth: 1, velocityDepth: 0, followDepth: 1, localMotion: false, shapeMotion: true, keepMatrix: false, keepOrigin: false }

/** A root that emits one plate per tick for 4 ticks; each plate lives 3 ticks. Finite: 7 ticks. */
const blink: FxEffect = {
  format: FX_FORMAT,
  version: FX_VERSION,
  key: 'test/blink.efp',
  fps: FX_FPS,
  scale: 1,
  textures: [],
  meshes: [],
  nodes: [
    { name: 'root', parent: -1, frames: 4, life: 'extinct', emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 }, link: { ...LINK }, render: 'none', view: 'none', material: null, commands: [] },
    { name: 'p', parent: 0, frames: 3, life: 'extinct', emit: { start: 0, duration: 4, period: 1, limit: 10, rate: 1 }, link: { ...LINK }, render: 'none', view: 'none', material: null, commands: [] },
  ],
  duration: null,
  provenance: 'test',
  warnings: [],
}

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true
  new ArcRotateCamera('cam', 0.5, 1, 6, Vector3.Zero(), scene)
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
})

describe('FxSimulation loop and stop', () => {
  it('restarts a looping effect, but not once it was stopped', () => {
    const sim = new FxSimulation(blink, { loop: true })
    const pose = { position: [0, 0, 0] as [number, number, number] }
    let restarts = 0
    let wasLive = false
    for (let t = 0; t < 40; t++) {
      sim.step(pose)
      if (sim.liveCount > 0 && !wasLive) restarts++
      wasLive = sim.liveCount > 0
    }
    expect(restarts).toBeGreaterThan(2)
    sim.stop()
    expect(sim.isStopped).toBe(true)
    let ticks = 0
    while (!sim.finished && ticks < 50) {
      sim.step(pose)
      ticks++
    }
    expect(sim.finished).toBe(true)
    // Stepping on never brings it back.
    for (let t = 0; t < 30; t++) sim.step(pose)
    expect(sim.liveCount).toBe(0)
    expect(sim.finished).toBe(true)
    // An explicit restart does.
    sim.restart()
    sim.step(pose)
    expect(sim.liveCount).toBeGreaterThan(0)
  })
})

describe('FxStreak', () => {
  it('draws a finite strip between two points and disposes its mesh', () => {
    const before = scene.meshes.length
    const s = new FxStreak(scene, 'fx:test-streak')
    expect(s.mesh.isVisible).toBe(false)
    s.set([0, 1, 0], [0, 1, 2], 0.2, [1, 0.5, 0.2, 0], [1, 1, 1, 1])
    expect(s.mesh.isVisible).toBe(true)
    const pos = s.mesh.getVerticesData(VertexBuffer.PositionKind)!
    const col = s.mesh.getVerticesData(VertexBuffer.ColorKind)!
    expect(pos).toHaveLength(18)
    expect([...pos].every(Number.isFinite)).toBe(true)
    // Edges transparent, centre line coloured.
    expect([col[3], col[7], col[11], col[15], col[19], col[23]]).toEqual([0, 0, 0, 0, 1, 0])
    // Width 0.2 across the axis (the strip is perpendicular to z).
    expect(Math.hypot(pos[0]! - pos[6]!, pos[1]! - pos[7]!, pos[2]! - pos[8]!)).toBeCloseTo(0.2, 5)
    // Degenerate input stays finite.
    s.set([1, 1, 1], [1, 1, 1], 0.1, [1, 1, 1, 1], [1, 1, 1, 1])
    expect([...s.mesh.getVerticesData(VertexBuffer.PositionKind)!].every(Number.isFinite)).toBe(true)
    const mat = s.mesh.material
    expect(mat).toBe(streakMaterial(scene))
    s.dispose()
    s.dispose()
    expect(s.isDisposed).toBe(true)
    expect(scene.meshes.length).toBe(before)
    expect(scene.materials.includes(mat!)).toBe(true)
  })
})
