/**
 * Commit steps (docs/WAVE_PLAN3.md §4.1: RegionStreamer.addCommitStep, World.addCommitStep): a lane's per-region job
 * runs once per region, as its own job in the frame budget (FIELDS.md §3.6: a job is never split), after that region's
 * terrain commit or once all of its objects are placed; regions already past that point get it at once; a removed step
 * or an unloaded region skips it; a debounce waits on the streamer's clock. Synthetic 7 x 7 world, fake clock.
 */
import type { BaseTexture } from '@babylonjs/core'
import { NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { RegionStreamer, STREAM_DEFAULTS, loadWorld, type RegionData, type StreamSettings } from '../src/index.ts'
import { CX, CZ, N, ROOT_URL, WORLD_NAME, X0, fakeModels, makeFixture, makeWorld, settle } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const centre = (x: number, z: number) => ({ x: 192 * (x - CX) + 96, z: -192 * (z - CZ) - 96 })
const idOf = (d: RegionData) => d.region.id

async function setup(settings: Partial<StreamSettings> = {}) {
  const fx = makeFixture()
  const { engine, scene, world, chunks } = await makeWorld(fx)
  let clock = 0
  const models = fakeModels(scene)
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium, ...settings }, {
    now: () => clock,
    autoPump: false,
    objects: true,
    nav: chunks,
    loadModel: models.loadModel,
    disposeModel: models.disposeModel,
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  let frame = 0
  const update = (focus: { x: number; z: number }) => {
    frame++
    stream.update(focus, null)
  }
  const run = async (focus: { x: number; z: number }, frames = 600) => {
    for (let i = 0; i < frames; i++) {
      update(focus)
      await settle(2)
      if (!stream.stats.jobs && !stream.stats.fetching && stream.stats.ready + stream.stats.failed === stream.stats.resident &&
        stream.stats.objectsReady === stream.stats.ready) {
        update(focus)
        if (!stream.stats.jobs) return
      }
    }
  }
  return { world, stream, run, update, frame: () => frame, tick: (ms: number) => { clock += ms } }
}

describe('RegionStreamer.addCommitStep', () => {
  it("'terrain' steps run once per region, after its terrain, as their own job", async () => {
    // A terrain commit costs 5 ms of the 4 ms budget: one core job per frame, so a step inside it would share its frame.
    const { world, stream, run, frame, tick } = await setup({ frameBudgetMs: 4 })
    const built = new Map<number, number>()
    const t = world.terrain
    const build = t.buildRegion.bind(t)
    t.buildRegion = (data, ...rest) => {
      tick(5)
      built.set(data.region.id, frame())
      return build(data, ...rest)
    }
    const ran: Array<[number, number]> = []
    stream.addCommitStep('probe', d => {
      expect(world.terrain.region(idOf(d)), 'the terrain exists').not.toBeNull()
      ran.push([idOf(d), frame()])
    }, 'terrain')
    expect(stream.commitSteps).toEqual(['probe'])
    await run(centre(CX, CZ))
    expect(stream.stats.ready).toBe(21)
    expect(ran.map(r => r[0]).sort()).toEqual([...built.keys()].sort())
    expect(new Set(ran.map(r => r[0])).size).toBe(ran.length) // once each
    for (const [id, f] of ran) expect(f, `region ${id}`).toBeGreaterThan(built.get(id)!)
  })

  it("'objects' steps run once all of the region's objects are placed", async () => {
    const { stream, run } = await setup()
    const ran: number[] = []
    stream.addCommitStep('objs', d => {
      const c = stream.chunk(d.region.x, d.region.z)!
      expect(c.objectsReady).toBe(true)
      ran.push(idOf(d))
    }, 'objects')
    await run(centre(CX, CZ))
    expect(ran).toHaveLength(21)
    expect(new Set(ran).size).toBe(21)
  })

  it('a step added later is queued for the regions already past its dependency; a removed step never runs', async () => {
    const { stream, run, update } = await setup()
    await run(centre(CX, CZ))
    const late: number[] = []
    const gone: number[] = []
    stream.addCommitStep('late', d => late.push(idOf(d)), 'terrain')
    const remove = stream.addCommitStep('gone', d => gone.push(idOf(d)), 'objects')
    expect(late).toEqual([]) // queued as jobs, not run inline
    remove()
    expect(stream.commitSteps).toEqual(['late'])
    update(centre(CX, CZ))
    await run(centre(CX, CZ))
    expect(late).toHaveLength(21)
    expect(gone).toEqual([])
  })

  it('a debounced step waits on the clock; an unloaded region skips it', async () => {
    const { stream, run, tick, update } = await setup()
    await run(centre(CX, CZ))
    const ran: number[] = []
    stream.addCommitStep('slow', d => ran.push(idOf(d)), 'terrain', 100)
    await run(centre(CX, CZ), 5)
    expect(ran).toEqual([])
    tick(100)
    update(centre(CX, CZ))
    await run(centre(CX, CZ))
    expect(ran).toHaveLength(21)
    // Queued again, then the focus moves away before the debounce ends: the unloaded regions never run it.
    ran.length = 0
    stream.addCommitStep('slow2', d => ran.push(idOf(d)), 'terrain', 50)
    await run(centre(X0, CZ))
    tick(50)
    await run(centre(X0, CZ))
    const east = ((CZ << 8) | (CX + 2))
    expect(stream.state(CX + 2, CZ)).toBe('absent')
    expect(ran).not.toContain(east)
    for (const id of ran) expect(world(stream).regions.get(id), `region ${id} resident`).not.toBeNull()
  })

  it('World.addCommitStep delegates to the streamer', async () => {
    const { world, stream, run } = await setup()
    const ran: number[] = []
    const remove = world.addCommitStep('w', d => ran.push(idOf(d)), 'terrain')
    expect(stream.commitSteps).toEqual(['w'])
    await run(centre(CX, CZ))
    expect(ran).toHaveLength(21)
    remove()
    expect(stream.commitSteps).toEqual([])
  })
})

describe('World.addCommitStep on a whole-world load', () => {
  it("runs 'terrain' steps at once for every region and 'objects' steps once the objects are placed", async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const fx = makeFixture()
    const world = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'low' })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    const terrain: number[] = []
    const objects: number[] = []
    world.addCommitStep('t', d => terrain.push(idOf(d)), 'terrain')
    world.addCommitStep('o', d => objects.push(idOf(d)), 'objects')
    expect(terrain).toHaveLength(N * N)
    await world.objectsReady
    await settle(2)
    expect(objects).toHaveLength(N * N)
  })
})

function world(stream: RegionStreamer) {
  return stream.world
}
