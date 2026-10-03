/**
 * Lane P-STALL (the stalls before the wave-10r playtest): WebGPU pipelines made in the background (screens/pipelines.ts),
 * the warm-up's per-frame shader budget, its second view pass and its settle on the GPU queue and on the effects
 * (screens/warmup.ts), the scene light cap kept ahead of the glTF loader (three/light-cap.ts), and an actor that is
 * not drawn while it is dressed (three/models.ts). NullEngine and fakes of Babylon's WebGPU internals (9.28).
 */
import { ArcRotateCamera, AssetContainer, HemisphericLight, MeshBuilder, NullEngine, PBRMaterial, Scene, TransformNode, Vector3, type AbstractEngine, type AbstractMesh } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PipelineWarm } from '../src/screens/pipelines.ts'
import { GraphicsWarmup, gpuQueueProbe, unreadyEffects } from '../src/screens/warmup.ts'
import { keepLightCap, raiseLightCap } from '../src/three/light-cap.ts'
import { CharacterActor, ModelLibrary } from '../src/three/models.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

/** A WebGPU engine as PipelineWarm sees it: `_draw`, the pipeline cache and the device (Babylon 9.28's shapes). */
function fakeGpu() {
  const cached = new Map<object, unknown>()
  const draws: number[] = []
  const asyncMade: Array<{ resolve: (p: unknown) => void; reject: (e: unknown) => void; descriptor: unknown }> = []
  let key: object = {}
  const cache = {
    disabled: false,
    _parameter: { token: undefined as object | undefined, pipeline: null as unknown },
    _lookupRenderPipeline(this: typeof cache) {
      this._parameter.token = key
      this._parameter.pipeline = cached.get(key) ?? null
      return this._parameter.pipeline
    },
    _buildRenderPipelineDescriptor: (_e: unknown, topology: unknown, sampleCount: number) => ({ topology, sampleCount }),
    _setRenderPipeline: (p: { token: object; pipeline: unknown }) => cached.set(p.token, p.pipeline),
  }
  const ctor = { _GetTopology: (fill: number) => `topology${fill}` }
  Object.setPrototypeOf(cache, { constructor: ctor })
  const engine = {
    isWebGPU: true,
    currentSampleCount: 4,
    _caps: { textureFloatLinearFiltering: true },
    _currentEffect: { _pipelineContext: { shaderProcessingContext: { textureNames: [] } } },
    _currentMaterialContext: { hasFloatOrDepthTextures: false, textures: {} },
    _snapshotRendering: { play: false, record: false },
    _cacheRenderPipeline: cache,
    _device: {
      createRenderPipelineAsync: (descriptor: unknown) => new Promise((resolve, reject) => asyncMade.push({ resolve, reject, descriptor })),
    },
    applyStates() {},
    _draw(_type: number, fill: number) {
      draws.push(fill)
    },
  }
  return {
    engine: engine as unknown as AbstractEngine,
    draw: (fill = 0) => (engine as unknown as { _draw(t: number, f: number, s: number, c: number): void })._draw(0, fill, 0, 3),
    setKey: (k: object) => (key = k),
    cached,
    draws,
    asyncMade,
  }
}

const settle = () => new Promise(r => setTimeout(r, 0))

describe('PipelineWarm (WebGPU pipelines in the background)', () => {
  it('is null for an engine that is not WebGPU, and one per WebGPU engine', () => {
    const engine = new NullEngine()
    cleanups.push(() => engine.dispose())
    expect(PipelineWarm.for(engine)).toBeNull()
    const g = fakeGpu()
    expect(PipelineWarm.for(g.engine)).toBe(PipelineWarm.for(g.engine))
  })

  it('outside a session every draw goes to Babylon; inside, a missing pipeline is made once in the background and the draw skipped until it is in', async () => {
    const g = fakeGpu()
    const w = PipelineWarm.for(g.engine)!
    g.draw()
    expect(g.draws).toEqual([0])
    expect(g.asyncMade).toHaveLength(0)
    const end = w.begin()
    expect(w.active).toBe(true)
    g.draw()
    g.draw()
    expect(g.draws).toEqual([0])
    expect(g.asyncMade).toHaveLength(1)
    expect(g.asyncMade[0]!.descriptor).toEqual({ topology: 'topology0', sampleCount: 4 })
    expect(w.pendingCount).toBe(1)
    expect(w.skipped).toBe(2)
    g.asyncMade[0]!.resolve('pipeline')
    await w.settled()
    expect(w.pendingCount).toBe(0)
    expect(w.made).toBe(1)
    g.draw()
    expect(g.draws).toEqual([0, 0])
    end()
    end()
    expect(w.active).toBe(false)
  })

  it('a background creation that fails is left to Babylon (drawn, and made at that draw, as before)', async () => {
    const g = fakeGpu()
    const w = PipelineWarm.for(g.engine)!
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const end = w.begin()
    g.draw(1)
    g.asyncMade[0]!.reject(new Error('invalid'))
    await w.settled()
    expect(w.failed).toBe(1)
    g.draw(1)
    expect(g.draws).toEqual([1])
    expect(g.asyncMade).toHaveLength(1)
    end()
  })

  it('a ghost mesh is never drawn, its pipelines are made; the ghost ends cleanly', async () => {
    const g = fakeGpu()
    const w = PipelineWarm.for(g.engine)!
    // A mesh as ghost() sees it: its `_draw` (Babylon's Mesh._draw → engine.drawElementsType → engine._draw).
    class FakeMesh {
      _draw(_subMesh: unknown, fill: number): void {
        g.draw(fill)
      }
    }
    const mesh = new FakeMesh()
    const unghost = w.ghost([mesh as unknown as AbstractMesh])
    mesh._draw(null, 2)
    expect(g.draws).toEqual([])
    expect(g.asyncMade).toHaveLength(1)
    g.asyncMade[0]!.resolve('p')
    await w.settled()
    // Cached now, still a ghost: not drawn.
    mesh._draw(null, 2)
    expect(g.draws).toEqual([])
    unghost()
    unghost()
    expect(Object.prototype.hasOwnProperty.call(mesh, '_draw')).toBe(false)
    mesh._draw(null, 2)
    expect(g.draws).toEqual([2])
  })
})

/** A warm-up scene: a camera, `n` boxes, a render per frame, a clock that moves 16 ms a frame. */
function warmScene(n: number) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const camera = new ArcRotateCamera('cam', 0.3, 1, 10, Vector3.Zero(), scene)
  const boxes = Array.from({ length: n }, (_, i) => MeshBuilder.CreateBox(`b${i}`, {}, scene))
  let clock = 0
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return { engine, scene, camera, boxes, frame: () => ((clock += 16), scene.render()), now: () => clock }
}

describe('the warm-up (P-STALL)', () => {
  it('asks the meshes a frame budget at a time (a slow compile does not make one long frame)', async () => {
    const { engine, scene, camera, boxes, frame, now } = warmScene(6)
    const askedPerFrame: number[] = []
    let asked = 0
    for (const b of boxes) {
      const isReady = b.isReady.bind(b)
      vi.spyOn(b, 'isReady').mockImplementation((...a: Parameters<typeof b.isReady>) => {
        // The warm-up's complete check only (the render's own isReady() calls are cheap ones).
        if (!a[0]) return isReady(...a)
        asked++
        const t = performance.now()
        while (performance.now() - t < 6) {
          // a 6 ms "compile"
        }
        return isReady(...a)
      })
    }
    scene.onAfterRenderObservable.add(() => {
      askedPerFrame.push(asked)
      asked = 0
    })
    let done = false
    void new GraphicsWarmup({ scene, engine, camera, stream: null }, { now, viewSteps: 0, quietFrames: 1, shaderBudgetMs: 8, pipelines: null, gpuQueue: null }).run().then(() => (done = true))
    for (let i = 0; i < 30 && !done; i++) {
      frame()
      await Promise.resolve()
    }
    expect(done).toBe(true)
    // Every mesh was asked, never all six in one frame (8 ms: two at most, the first always).
    expect(Math.max(...askedPerFrame)).toBeLessThanOrEqual(2)
    expect(askedPerFrame.filter(n => n > 0).length).toBeGreaterThanOrEqual(3)
  })

  it('WebGPU: the views run a second pass that holds each heading while its pipelines are made; the run reports them', async () => {
    const { engine, scene, camera, frame, now } = warmScene(1)
    const pipes = { started: 0, skipped: 0, pendingCount: 0, begin: vi.fn(() => vi.fn()) }
    const stages: string[] = []
    let result: Awaited<ReturnType<GraphicsWarmup['run']>> | null = null
    void new GraphicsWarmup({ scene, engine, camera, stream: null }, {
      now, viewSteps: 2, framesPerView: 1, quietFrames: 1, pipelines: pipes as unknown as PipelineWarm, gpuQueue: null,
      onProgress: (_f, s) => stages.at(-1) !== s && stages.push(s),
    }).run().then(r => (result = r))
    expect(pipes.begin).toHaveBeenCalledTimes(1)
    // A frame of the first pass starts three pipelines (skipped draws).
    for (let i = 0; i < 3; i++) frame()
    pipes.started = 3
    pipes.skipped = 3
    pipes.pendingCount = 3
    for (let i = 0; i < 20; i++) frame()
    expect(stages.at(-1)).toBe('views')
    expect(result).toBeNull()
    pipes.pendingCount = 0
    for (let i = 0; i < 20 && !result; i++) {
      frame()
      await Promise.resolve()
    }
    expect(result).not.toBeNull()
    expect(result!.pipelines).toBe(3)
    expect(stages).toEqual(['shaders', 'views', 'settle'])
    // The session ended with the views (before settle drew everything).
    expect(pipes.begin.mock.results[0]!.value).toHaveBeenCalled()
  })

  it('settle waits for the GPU queue to answer about as fast as a frame', async () => {
    const { engine, scene, camera, frame, now } = warmScene(1)
    const probes: Array<() => void> = []
    const gpuQueue = () => new Promise<void>(r => probes.push(r))
    let result: Awaited<ReturnType<GraphicsWarmup['run']>> | null = null
    void new GraphicsWarmup({ scene, engine, camera, stream: null }, { now, viewSteps: 0, quietFrames: 1, pipelines: null, gpuQueue }).run().then(r => (result = r))
    for (let i = 0; i < 10; i++) frame()
    expect(probes).toHaveLength(1)
    // A slow answer (a backlog): another probe follows, and the run waits.
    await new Promise(r => setTimeout(r, 120))
    probes[0]!()
    await settle()
    for (let i = 0; i < 3; i++) frame()
    expect(result).toBeNull()
    expect(probes.length).toBeGreaterThanOrEqual(2)
    // A prompt answer ends it.
    probes.at(-1)!()
    await settle()
    for (let i = 0; i < 3 && !result; i++) {
      frame()
      await settle()
    }
    expect(result).not.toBeNull()
    expect(result!.ended).toBe('done')
  })

  it('settle waits for every effect of the engine to be ready (WebGL2 programs still linking)', async () => {
    const { engine, scene, camera, frame, now } = warmScene(1)
    const cache = (engine as unknown as { _compiledEffects: Record<string, { isReady(): boolean }> })._compiledEffects
    let ready = false
    cache['linking'] = { isReady: () => ready }
    expect(unreadyEffects(engine)).toBe(1)
    let result: Awaited<ReturnType<GraphicsWarmup['run']>> | null = null
    void new GraphicsWarmup({ scene, engine, camera, stream: null }, { now, viewSteps: 0, quietFrames: 1, pipelines: null, gpuQueue: null }).run().then(r => (result = r))
    for (let i = 0; i < 10; i++) {
      frame()
      await Promise.resolve()
    }
    expect(result).toBeNull()
    ready = true
    for (let i = 0; i < 3 && !result; i++) {
      frame()
      await Promise.resolve()
    }
    expect(result).not.toBeNull()
    delete cache['linking']
  })

  it('the GPU queue probe: none on NullEngine; WebGPU uses onSubmittedWorkDone', async () => {
    const engine = new NullEngine()
    cleanups.push(() => engine.dispose())
    expect(gpuQueueProbe(engine)).toBeNull()
    const done = vi.fn(() => Promise.resolve())
    const probe = gpuQueueProbe({ isWebGPU: true, _device: { queue: { onSubmittedWorkDone: done } } } as unknown as AbstractEngine)
    await probe!()
    expect(done).toHaveBeenCalledTimes(1)
  })
})

describe('the scene light cap (glTF loader raise, P-STALL)', () => {
  it('raises every material to the light count before it compiles, and again when a light or a material comes', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene)
    new HemisphericLight('a', new Vector3(0, 1, 0), scene)
    const m1 = new PBRMaterial('m1', scene)
    expect(m1.maxSimultaneousLights).toBe(4)
    for (let i = 0; i < 4; i++) new HemisphericLight(`l${i}`, new Vector3(0, 1, 0), scene)
    const off = keepLightCap(scene)
    expect(m1.maxSimultaneousLights).toBe(5)
    new HemisphericLight('l5', new Vector3(0, 1, 0), scene)
    const m2 = new PBRMaterial('m2', scene)
    expect(m2.maxSimultaneousLights).toBe(4)
    scene.render()
    expect(m1.maxSimultaneousLights).toBe(6)
    expect(m2.maxSimultaneousLights).toBe(6)
    // Never lowered.
    m2.maxSimultaneousLights = 8
    raiseLightCap(m2, 6)
    expect(m2.maxSimultaneousLights).toBe(8)
    off()
    new HemisphericLight('l6', new Vector3(0, 1, 0), scene)
    scene.render()
    expect(m1.maxSimultaneousLights).toBe(6)
  })
})

describe('an actor is not drawn while it is dressed (P-STALL)', () => {
  it('ModelLibrary.character keeps the root disabled until everything it wears is in, then returns it enabled', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const library = new ModelLibrary(scene)
    cleanups.push(() => {
      library.dispose()
      scene.dispose()
      engine.dispose()
    })
    const root = new TransformNode('__root__', scene)
    MeshBuilder.CreateBox('body', {}, scene).parent = root
    const container = new AssetContainer(scene)
    container.transformNodes.push(root)
    container.meshes.push(...root.getChildMeshes())
    container.removeAllFromScene()
    vi.spyOn(library, 'load').mockResolvedValue({ container, sidecar: null, packs: null })
    let dressed!: () => void
    vi.spyOn(library, 'dress').mockImplementation(() => new Promise<void>(r => (dressed = r)))
    const p = library.character({ code: 'CHAR_TEST', glb: '/out/test.glb' })
    await vi.waitFor(() => expect(library.liveActors.size).toBe(1))
    const actor = [...library.liveActors][0] as CharacterActor
    expect(actor.root.isEnabled(false)).toBe(false)
    dressed()
    const got = await p
    expect(got).toBe(actor)
    expect(actor.root.isEnabled(false)).toBe(true)
  })
})
