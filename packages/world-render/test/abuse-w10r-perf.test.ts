/**
 * H-10R adversarial hunt, lens "perf": per-frame allocations in the new update paths and worker message floods
 * (docs/WAVE_PLAN6.md §6.4; docs/COAST.md §8.4 "a stalled tab never blocks the main thread", D27 "the worker idles").
 * Every test here FAILS on e192530.
 */
import { FreeCamera, Frustum, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOceanPart, SroOcean } from '../src/ocean/index.ts'
import { OceanTileJob, type OceanWorkerIn, type OceanWorkerOut } from '../src/ocean/fft-worker.ts'
import type { ShoreFrame, ShorePart } from '../src/ocean/shore-seam.ts'
import { WORKER_TILES_M, cascadesFor } from '../src/ocean/spectrum.ts'
import { WorkerTile } from '../src/ocean/tile.ts'
import { SeaWeather } from '../src/ocean/weather.ts'
import { SHORE_X, addCoast } from './ocean-fixture.ts'
import { w10World } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A worker that serves one tick request at a time, when the test says so (a busy or throttled core). */
class SlowWorker {
  static last: SlowWorker | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readonly queue: OceanWorkerIn[] = []
  private readonly job = new OceanTileJob()
  constructor() {
    SlowWorker.last = this
  }
  postMessage(msg: OceanWorkerIn): void {
    if (msg.type !== 'tick') this.job.handle(msg)
    else this.queue.push(msg)
  }
  serve(): void {
    const msg = this.queue.shift()
    if (!msg) return
    const r = this.job.handle(msg)
    if (r) this.onmessage?.({ data: r.out })
  }
  terminate(): void {}
}

describe('H-10R perf: the ocean worker tile', () => {
  it('a worker slower than the tick rate: the requests pile up without bound and the waves never move again', () => {
    vi.stubGlobal('Worker', SlowWorker)
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    // Medium's tile: 2 × 64², 20 Hz.
    const tile = new WorkerTile(scene, cascadesFor(WORKER_TILES_M, 64), 20, { worker: true })
    cleanups.push(() => tile.dispose())
    const worker = SlowWorker.last!
    expect(worker).not.toBeNull()
    tile.setParams(new SeaWeather().params)
    // 10 s at 60 fps; the worker manages one tick per 100 ms (10 Hz, half the 20 Hz the tile asks for).
    let uploadsAt5s = 0
    for (let f = 0; f < 600; f++) {
      tile.update(f / 60, true)
      if (f % 6 === 5) worker.serve()
      if (f === 300) uploadsAt5s = tile.stats.uploads
    }
    // A bounded tile keeps ≤ 3 ticks in flight (k, k + 1, k + 2) and shows every tick the worker manages (≈ 5/s
    // here). Today it posts one new request per tick whatever is in flight: the worker computes ever staler ticks
    // (≈ 100 queued after 10 s, ≈ 30 MB of answers), every answer is already behind the render time and is dropped,
    // and the waves stay frozen until the page reloads.
    expect.soft(worker.queue.length).toBeLessThanOrEqual(3)
    expect.soft(tile.stats.uploads - uploadsAt5s).toBeGreaterThan(0)
  })

  it('on the GPU-FFT path (High/Ultra WebGPU) the CPU-query tile still packs and ships every mip level it never uploads', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const handled: OceanWorkerIn[] = []
    const answered: OceanWorkerOut[] = []
    const real = OceanTileJob.prototype.handle
    vi.spyOn(OceanTileJob.prototype, 'handle').mockImplementation(function (this: OceanTileJob, msg: OceanWorkerIn) {
      handled.push(msg)
      const r = real.call(this, msg)
      if (r) answered.push(r.out)
      return r
    })
    // SroOcean.ensureWaves makes this tile next to the GPU FFT on WebGPU: `textures: !this.gpu` = false. It only
    // feeds waveHeightAt (the ships ask 5 heights per ship per frame, so near the coast it ticks at 20 Hz for good).
    Object.defineProperty(engine, 'isWebGPU', { get: () => true, configurable: true })
    const tile = new WorkerTile(scene, cascadesFor(WORKER_TILES_M, 64), 20, { worker: false, textures: false })
    delete (engine as unknown as { isWebGPU?: boolean }).isWebGPU
    cleanups.push(() => tile.dispose())
    tile.setParams(new SeaWeather().params)
    for (let f = 0; f < 30; f++) {
      tile.update(f / 60, true)
      await Promise.resolve()
    }
    expect(tile.stats.uploads).toBe(0)
    const ticks = handled.filter((m): m is Extract<OceanWorkerIn, { type: 'tick' }> => m.type === 'tick')
    const frames = answered.filter((m): m is Extract<OceanWorkerOut, { type: 'frame' }> => m.type === 'frame')
    expect(ticks.length).toBeGreaterThan(0)
    const levelBytes = frames.reduce((n, f) => n + f.levels.reduce((k, l) => k + l.byteLength, 0), 0) / frames.length
    // The query reads `disp` only; the half-float levels (7 mips × 8 layers × 64²: 174,752 bytes a tick, ≈ 3.5 MB/s of
    // worker packing and main-thread garbage at 20 Hz) are made for a texture this tile never fills.
    expect.soft(ticks.every(t => !t.mips)).toBe(true)
    expect.soft(levelBytes).toBe(0)
  })
})

describe('H-10R perf: per-frame allocations in SroOcean.update', () => {
  it('the frustum, the swell direction and the shore frame are new objects every frame', async () => {
    const frames: Array<Readonly<ShoreFrame>> = []
    const shore: ShorePart = {
      ready: false,
      update: (f: Readonly<ShoreFrame>) => {
        frames.push(f)
      },
      bind: () => {},
      dispose: () => {},
    } as unknown as ShorePart
    const s = await w10World({ render: 'pbr', quality: 'medium', edit: fx => addCoast(fx), parts: { ocean: host => createOceanPart(host, { worker: false, shore: () => shore }) } })
    cleanups.push(s.dispose)
    const ocean = s.world.ocean as SroOcean
    await ocean.loaded
    const cam = new FreeCamera('cam', new Vector3(SHORE_X + 60, 25, -50), s.scene)
    cam.maxZ = 2000
    cam.setTarget(new Vector3(SHORE_X + 400, 0, -50))
    s.scene.activeCamera = cam
    for (let i = 0; i < 5; i++) {
      ocean.update(cam, 1 / 60)
      await new Promise(r => setTimeout(r, 0))
    }
    const planes = vi.spyOn(Frustum, 'GetPlanes')
    const before = frames.length
    for (let i = 0; i < 10; i++) ocean.update(cam, 1 / 60)
    expect(frames.length - before).toBe(10)
    // Frustum.GetPlanes makes 6 Planes (+ 6 Vector3) a frame where GetPlanesToRef into the part's own 6 would do
    // (the grass field already does that); the shore gets a fresh frame object and a fresh swellDir array each frame
    // (SeaWeather.swellDir allocates on every read: shore, bindPbr, bindClassic), plus `lat`, the nodeHasWater closure
    // and SeaWeather.update's SeaState: ≈ 20 short-lived objects per frame on every PBR preset with an ocean.
    expect.soft(planes.mock.calls.length).toBe(0)
    const last = frames.slice(before)
    expect.soft(new Set(last).size).toBe(1)
    expect.soft(new Set(last.map(f => f.swellDir)).size).toBe(1)
  })
})
