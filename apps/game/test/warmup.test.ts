/**
 * PERF2: the graphics warm-up behind the loading picture (screens/warmup.ts): the streamer's rebuild runs with its boot
 * budget until idle, every enabled mesh is asked isReady (compiles start for all of them, in view or not), the camera
 * turns once round and comes back, and it ends after a few quiet frames; the time cap and a cancel restore the camera
 * and the streamer budget too.
 */
import { ArcRotateCamera, MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { GraphicsWarmup, WARMUP_DEFAULTS, warmupMeshes, type WarmupStage } from '../src/screens/warmup.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const camera = new ArcRotateCamera('cam', 0.3, 1, 10, Vector3.Zero(), scene)
  const a = MeshBuilder.CreateBox('a', {}, scene)
  const b = MeshBuilder.CreateBox('b', {}, scene)
  b.position.z = -20 // behind the camera: asked all the same
  const off = MeshBuilder.CreateBox('template', {}, scene)
  off.setEnabled(false)
  const hidden = MeshBuilder.CreateBox('hidden', {}, scene)
  hidden.isVisible = false
  const stream = { busy: true, booting: false, stats: { wanted: 4, ready: 1, objectsReady: 0 } }
  let clock = 0
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  const frame = () => {
    clock += 16
    scene.render()
  }
  return { engine, scene, camera, stream, frame, now: () => clock, meshes: { a, b, off, hidden } }
}

describe('graphics warm-up (PERF2)', () => {
  it('asks the enabled, visible meshes only', () => {
    const { scene } = setup()
    expect(warmupMeshes(scene).map(m => m.name).sort()).toEqual(['a', 'b'])
  })

  it('stream, shaders, a turn of the camera, settle; the camera and the streamer budget come back', async () => {
    const { engine, scene, camera, stream, frame, now } = setup()
    const stages: WarmupStage[] = []
    const alphas = new Set<number>()
    const run = new GraphicsWarmup({ scene, engine, camera, stream }, { now, onProgress: (_f, s) => stages.at(-1) !== s && stages.push(s) })
    let result: Awaited<ReturnType<GraphicsWarmup['run']>> | null = null
    void run.run().then(r => (result = r))
    expect(stream.booting).toBe(true)
    for (let i = 0; i < 5; i++) frame()
    expect(stages).toEqual(['stream'])
    stream.busy = false
    for (let i = 0; i < 60 && !result; i++) {
      frame()
      alphas.add(Math.round(camera.alpha * 1000))
      await Promise.resolve()
    }
    await Promise.resolve()
    expect(result).not.toBeNull()
    const r = result!
    expect(r.ended).toBe('done')
    expect(r.meshes).toBe(2)
    expect(r.ready).toBe(2)
    expect(stages).toEqual(['stream', 'shaders', 'views', 'settle'])
    // Four headings a quarter turn apart, then back.
    expect(alphas.size).toBeGreaterThanOrEqual(WARMUP_DEFAULTS.viewSteps)
    expect(camera.alpha).toBe(0.3)
    expect(stream.booting).toBe(false)
  })

  it('with the player known, waits for the regions near it only (the streamer may stay busy)', async () => {
    const { engine, scene, camera, stream, frame, now } = setup()
    let release = () => {}
    const asked: number[][] = []
    const near = {
      ...stream,
      whenReady: (x: number, z: number, r: number) => {
        asked.push([x, z, r])
        return new Promise<void>(res => (release = res))
      },
      progress: () => ({ done: 1, total: 3 }),
    }
    const stages: WarmupStage[] = []
    const run = new GraphicsWarmup({ scene, engine, camera, stream: near, focus: () => ({ x: 5, z: -7 }) }, { now, onProgress: (_f, s) => stages.at(-1) !== s && stages.push(s) })
    const p = run.run()
    for (let i = 0; i < 4; i++) frame()
    expect(asked).toEqual([[5, -7, 200]])
    expect(stages).toEqual(['stream'])
    release()
    await Promise.resolve()
    for (let i = 0; i < 60 && stages.at(-1) !== 'settle'; i++) frame()
    expect(near.busy).toBe(true)
    for (let i = 0; i < 20; i++) frame()
    expect((await p).ended).toBe('done')
  })

  it('gives up at the time cap, and a cancel ends it at once', async () => {
    const { engine, scene, camera, stream, frame, now } = setup()
    const run = new GraphicsWarmup({ scene, engine, camera, stream }, { now, maxMs: 200 })
    const p = run.run()
    for (let i = 0; i < 20; i++) frame()
    const r = await p
    expect(r.ended).toBe('timeout')
    expect(stream.booting).toBe(false)
    const again = new GraphicsWarmup({ scene, engine, camera, stream }, { now })
    const q = again.run()
    frame()
    stream.busy = false
    frame()
    again.cancel()
    const c = await q
    expect(c.ended).toBe('cancelled')
    expect(stream.booting).toBe(false)
    expect(camera.alpha).toBe(0.3)
  })
})
