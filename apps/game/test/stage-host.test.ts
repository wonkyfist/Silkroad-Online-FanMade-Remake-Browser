/**
 * The stage host (docs/SCREENS.md §0B.3, §0B.4, §0B.9, §0B.10 `stage-host.test.ts`; lane SCR-R), headless: a NullEngine
 * App stand-in with the App's own scene ownership (`useScene` / `releaseScene`) and a render loop, over world-render's
 * synthetic streamed fixture (a `WorldIO` in memory). The fixture's centre region spans x 0..192, z −192..0; the stages
 * are moved onto it (spot (96, −96)); everything else is the real STAGES rows.
 */
import { ArcRotateCamera, NullEngine, Observable, PBRMaterial, TransformNode, MeshBuilder, type Scene } from '@babylonjs/core'
import { DEFAULT_CLOCK, phaseForSolarTime, sunriseSunset, type ServerInfo, type WorldClockState } from '@sro/shared'
import { World, type LifeConfig, type LifePart, type OceanPart } from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROOT_URL, WORLD_NAME, heightOf, CX, CZ, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'
import { FakeBatch } from '../../../packages/world-render/test/w10-fixture.ts'
import type { OwnedScene } from '../src/app.ts'
import { GraphicsWarmup } from '../src/screens/warmup.ts'
import { SettingsStore, setRenderScaleHandler } from '../src/settings.ts'
import { KEY_LIGHT_INTENSITY } from '../src/stage/key-light.ts'
import { STAGE_AREA, STAGE_WARMUP_VIEWS, STAGE_WARMUP_VIEWS_GL, createStageHost, type StageApp, type StageHostDeps } from '../src/stage/host.ts'
import { STAGES, STAGE_STREAM } from '../src/stage/stages.ts'
import type { StageDef, StageHost } from '../src/stage/types.ts'
import { WorldGraphics } from '../src/world/graphics.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

/** The stages on the fixture's centre region (the real rows otherwise). */
const SPOT = { x: 96, z: -96, yHint: heightOf(CX, CZ) }
const onFixture = (d: StageDef): StageDef => ({ ...d, world: 'server', spot: { ...SPOT } })
const SELECT = onFixture(STAGES.select)
const CREATE = onFixture(STAGES.create)

/** A fake App: the real scene ownership rules (app.ts useScene / releaseScene), a render loop, sound and music. */
function fakeApp(opts: { server?: Partial<ServerInfo>; serverNow?: () => number; engineKind?: 'WebGPU' | 'WebGL2' } = {}) {
  const engine = new NullEngine({ renderWidth: 1920, renderHeight: 1080, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 })
  let owned: OwnedScene | null = null
  const log: string[] = []
  const renders = { count: 0 }
  const app = {
    engine,
    engineKind: opts.engineKind ?? ('WebGL2' as 'WebGPU' | 'WebGL2'),
    session: { server: { id: 's', name: 'S', status: 'online', online: 0, capacity: 1, world: WORLD_NAME, ...opts.server } as ServerInfo, clock: { serverNow: opts.serverNow ?? (() => Date.now()) } },
    audio: {
      setArea: (id: string | null) => log.push(`area ${id}`),
      setListener: () => {},
      tick: () => {},
    },
    music: { play: (url: string | null | undefined) => log.push(`music ${url}`) },
    art: { musicUrl: (name: string) => `/music/${name}.ogg` },
    get scene(): Scene | null {
      return owned?.scene ?? null
    },
    useScene<T extends OwnedScene>(kind: string, build: () => T): T {
      if (owned?.kind === kind) return owned as T
      this.releaseScene()
      const o = build()
      owned = o
      log.push(`use ${kind}`)
      return o
    },
    releaseScene(): void {
      if (!owned) return
      const o = owned
      owned = null
      log.push(`release ${o.kind}`)
      o.dispose()
    },
  } satisfies StageApp & Record<string, unknown>
  const timer = setInterval(() => {
    const s = owned?.scene
    if (!s?.activeCamera || s.isDisposed) return
    engine.beginFrame()
    s.render()
    engine.endFrame()
    renders.count++
  }, 4)
  cleanups.push(() => {
    clearInterval(timer)
    app.releaseScene()
    engine.dispose()
  })
  return { app, engine, log, renders }
}

/** A wildlife part that records configure; an ocean part that records setVisible. */
function fakeParts() {
  const configs: LifeConfig[] = []
  const visible: boolean[] = []
  const life = (): LifePart => ({
    enabled: true,
    setEnabled() {},
    configure: c => configs.push(c),
    setThreats() {},
    addSpecies: () => () => {},
    addHabitat: () => () => {},
    setFocus() {},
    update() {},
    meshes: () => [],
    onFlush: new Observable(),
    dispose() {},
  })
  const ocean = (): OceanPart => ({ coast: null, update() {}, meshes: () => [], setQuality() {}, setVisible: on => visible.push(on), dispose() {} })
  return { configs, visible, parts: { life, ocean, batch: null } }
}

function makeHost(store: SettingsStore, extra: Partial<StageHostDeps> & { app?: ReturnType<typeof fakeApp> } = {}) {
  const env = extra.app ?? fakeApp()
  const fx = makeFixture()
  const parts = fakeParts()
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // NullEngine: no LUT grade, no clustered lights, no ambient
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const host: StageHost = createStageHost(env.app, {
    store,
    roots: [ROOT_URL],
    io: fx.io,
    parts: parts.parts,
    load: { objects: false },
    nightLights: { index: new Map() },
    device: { engine: 'WebGL2' },
    warmup: { maxMs: 3000, framesPerView: 1, quietFrames: 2, stallMs: 150 },
    ...extra,
  })
  cleanups.push(() => host.release())
  return { host, ...env, fx, parts }
}

function mediumStore(): SettingsStore {
  const store = new SettingsStore(null)
  store.set({ graphics: { preset: 'medium', firstRun: false, releaseMigrated: true } })
  return store
}

/** A running clock whose solar time is `t` now. */
function clockAtT(t: number, now: number): WorldClockState {
  return { ...DEFAULT_CLOCK, anchorMs: now, anchorDays: 3 + phaseForSolarTime(t, DEFAULT_CLOCK.nightSpeedup) }
}

describe('the stage host (SCREENS §0B.10)', () => {
  it('enter(select) then enter(create) on the same export reuse the World; release disposes it all', async () => {
    const store = mediumStore()
    const { host, app, log } = makeHost(store)
    const listeners = () => (store as unknown as { listeners: Set<unknown> }).listeners.size
    const before = listeners()
    const sel = await host.enter(SELECT)
    expect(sel.def).toBe(SELECT)
    expect(app.scene).toBe(sel.scene)
    expect(sel.scene.skipPointerMovePicking).toBe(true)
    const world = sel.world
    const cre = await host.enter(CREATE)
    expect(cre.world).toBe(world)
    expect(cre.scene).toBe(sel.scene)
    expect(cre.def).toBe(CREATE)
    expect(log.filter(l => l.startsWith('use '))).toEqual([`use stage:${WORLD_NAME}`])
    // The stream is the stage's (150 m, 12 fetches), not the preset's 400 m.
    expect(world.stream!.settings.loadRadiusM).toBe(STAGE_STREAM.loadRadiusM)
    expect(world.stream!.settings.maxFetches).toBe(STAGE_STREAM.maxFetches)
    expect(listeners()).toBeGreaterThan(before)
    const scene = sel.scene
    const disposeWorld = vi.spyOn(world, 'dispose')
    host.release()
    expect(disposeWorld).toHaveBeenCalledTimes(1)
    expect(scene.isDisposed).toBe(true)
    expect(scene.meshes.length).toBe(0)
    expect(scene.textures.length).toBe(0)
    expect(app.scene).toBeNull()
    expect(listeners()).toBe(before)
    expect(log).toContain(`release stage:${WORLD_NAME}`)
    // Safe again, and a new enter loads a new World.
    expect(() => host.release()).not.toThrow()
    const again = await host.enter(SELECT)
    expect(again.world).not.toBe(world)
  })

  it('updates the world before the first render, draws a non-empty active-mesh list with the default filter, and never lets the watchdog judge', async () => {
    const store = mediumStore()
    const order: string[] = []
    const frames = vi.spyOn(WorldGraphics.prototype, 'frame')
    const { host } = makeHost(store)
    const update = World.prototype.update
    vi.spyOn(World.prototype, 'update').mockImplementation(function (this: World, ...a: Parameters<World['update']>) {
      if (!order.includes('update')) order.push('update')
      return update.apply(this, a)
    })
    // preload gets the scene at once, before the world loads: nothing renders until the world was updated.
    const stage = await host.enter(SELECT, { preload: async scene => scene.onAfterRenderObservable.addOnce(() => order.push('render')) })
    expect(order.slice(0, 2)).toEqual(['update', 'render'])
    expect(stage.world.activeMeshes).not.toBeNull()
    expect(stage.scene.getActiveMeshes().length).toBeGreaterThan(0)
    expect(frames).toHaveBeenCalled()
    for (const call of frames.mock.calls) expect(call[1]).toBe(false)
  })

  it('Low loads the Classic path (no key light on the actors); Medium the PBR path with the world\'s sky cube, not a studio cube', async () => {
    const low = mediumStore()
    low.set({ graphics: { preset: 'low' } })
    const a = makeHost(low)
    const s1 = await a.host.enter(SELECT)
    expect(s1.world.render.mode).toBe('classic')
    const actor = new TransformNode('actor', s1.scene)
    MeshBuilder.CreateBox('body', { size: 1 }, s1.scene).parent = actor
    s1.addActor(actor)
    const key = s1.scene.getLightByName('stageKey')!
    expect(key.intensity).toBe(0)
    expect(key.includedOnlyMeshes.map(m => m.name)).toEqual(['stageKeyAnchor'])
    a.host.release()

    const b = makeHost(mediumStore())
    const s2 = await b.host.enter(SELECT)
    expect(s2.world.render.mode).toBe('pbr')
    const actor2 = new TransformNode('actor', s2.scene)
    MeshBuilder.CreateBox('body', { size: 1 }, s2.scene).parent = actor2
    s2.addActor(actor2)
    const key2 = s2.scene.getLightByName('stageKey')!
    expect(key2.intensity).toBe(KEY_LIGHT_INTENSITY)
    expect(key2.includedOnlyMeshes.map(m => m.name)).toEqual(['stageKeyAnchor', 'body'])
    expect(s2.scene.textures.some(t => t.name === 'studioEnvironment')).toBe(false)
    s2.removeActor(actor2)
    expect(key2.includedOnlyMeshes.map(m => m.name)).toEqual(['stageKeyAnchor'])
  })

  it('runs the first-run device check before the first enter', async () => {
    const store = new SettingsStore(null)
    expect(store.get().graphics.firstRun).toBe(true)
    const { host } = makeHost(store)
    await host.enter(SELECT)
    expect(store.get().graphics.firstRun).toBe(false)
    expect(store.get().graphics.recommended).toBeTruthy()
    expect(store.get().graphics.releaseMigrated).toBe(true)
  })

  it('create caps the draw range at min(preset, 0.6), keeps it through a graphics change, and select restores the preset\'s', async () => {
    const store = mediumStore()
    store.set({ graphics: { preset: 'high' } })
    const { host } = makeHost(store)
    const sel = await host.enter(SELECT)
    expect(sel.world.objects.drawRangeScale).toBeCloseTo(1.4, 6)
    await host.enter(CREATE)
    expect(sel.world.objects.drawRangeScale).toBeCloseTo(0.6, 6)
    // A graphics change runs WorldGraphics.apply (it sets the preset's range) and resets the stream: both come back.
    store.set({ graphics: { sight: 'far' } })
    expect(sel.world.objects.drawRangeScale).toBeCloseTo(0.6, 6)
    store.set({ graphics: { preset: 'medium' } })
    expect(sel.world.objects.drawRangeScale).toBeCloseTo(0.6, 6)
    expect(sel.world.stream!.settings.loadRadiusM).toBe(STAGE_STREAM.loadRadiusM)
    // A preset below the cap is kept as it is.
    store.set({ graphics: { preset: 'low', sight: 'normal' } })
    expect(sel.world.objects.drawRangeScale).toBeCloseTo(0.6, 6)
    await host.enter(SELECT)
    expect(sel.world.objects.drawRangeScale).toBeCloseTo(0.6, 6)
    store.set({ graphics: { preset: 'high' } })
    expect(sel.world.objects.drawRangeScale).toBeCloseTo(1.4, 6)
  })

  it('warms up once per World: on WebGPU 2 views (the select and the create headings), on WebGL2 8 (the orbit too)', async () => {
    const gpu = makeHost(mediumStore(), { app: fakeApp({ engineKind: 'WebGPU' }) })
    const runGpu = vi.spyOn(GraphicsWarmup.prototype, 'run')
    await gpu.host.enter(SELECT)
    expect((runGpu.mock.instances[0] as unknown as { o: { viewSteps: number } }).o.viewSteps).toBe(STAGE_WARMUP_VIEWS)
    expect(STAGE_WARMUP_VIEWS).toBe(2)
    gpu.host.release()
    runGpu.mockRestore()
    const run = vi.spyOn(GraphicsWarmup.prototype, 'run')
    const { host } = makeHost(mediumStore())
    const alphas = new Set<string>()
    const stage = await host.enter(SELECT, { actors: async s => {
      s.scene.onAfterRenderObservable.add(() => alphas.add((((s.camera.alpha % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toFixed(2)))
    } })
    expect(run).toHaveBeenCalledTimes(1)
    const warm = run.mock.instances[0] as unknown as { o: { viewSteps: number } }
    expect(warm.o.viewSteps).toBe(STAGE_WARMUP_VIEWS_GL)
    expect(STAGE_WARMUP_VIEWS_GL).toBe(8)
    // Both headings were drawn (select looks +Z, create −Z: alpha differs by π).
    const values = [...alphas].map(Number)
    expect(values.some(a => values.some(b => Math.abs(Math.abs(a - b) - Math.PI) < 0.05))).toBe(true)
    await host.enter(CREATE)
    expect(run).toHaveBeenCalledTimes(1)
    expect(stage.camera).toBeInstanceOf(ArcRotateCamera)
  })

  it('the stage\'s WorldGraphics is disposed before the world screen builds its own (the render-scale handler survives)', async () => {
    const { host, app } = makeHost(mediumStore())
    await host.enter(SELECT)
    const dispose = vi.spyOn(WorldGraphics.prototype, 'dispose')
    const order: string[] = []
    dispose.mockImplementation(function (this: WorldGraphics) {
      order.push('stage graphics disposed')
      dispose.mockRestore()
      return this.dispose()
    })
    app.useScene('world', () => {
      order.push('world scene built')
      // The world screen's WorldGraphics sets its handler here; nothing of the stage's clears it afterwards.
      setRenderScaleHandler(() => true)
      return { kind: 'world', scene: null as unknown as Scene, dispose() {} }
    })
    expect(order).toEqual(['stage graphics disposed', 'world scene built'])
  })

  it('a load error rejects and leaves nothing (the screens run their fallback)', async () => {
    const env = fakeApp({ server: { world: 'missing' } })
    const { host, app, log } = makeHost(mediumStore(), { app: env })
    await expect(host.enter(SELECT)).rejects.toThrow(/no world export/)
    expect(app.scene).toBeNull()
    expect(log).toContain('release stage:missing')
    expect(log.filter(l => l.startsWith('area'))).toEqual([])
  })

  it('an aborted enter rejects and releases the stage', async () => {
    const { host, app } = makeHost(mediumStore())
    const ctl = new AbortController()
    const p = host.enter(SELECT, { signal: ctl.signal })
    ctl.abort()
    await expect(p).rejects.toThrow(/abort/)
    expect(app.scene).toBeNull()
  })

  it('the wildlife gets no ground flocks, the ocean its visibility switch; the town ambience under the title theme until release', async () => {
    const { host, parts, log } = makeHost(mediumStore())
    await host.enter(SELECT)
    expect(parts.configs).toEqual([{ groundFlocks: false }])
    expect(parts.visible).toEqual([true])
    expect(log).toContain('music /music/maintheme_cut.ogg')
    expect(log).toContain(`area ${STAGE_AREA}`)
    host.release()
    expect(log.at(-1)).toBe('area null')
  })

  it('I-10R (WAVE_PLAN6 §6.3): the stage world with batching, life without ground flocks and the ocean switch; the create cap re-applied after a graphics change reaches the batch; the tufts stay', async () => {
    const store = mediumStore()
    store.set({ graphics: { preset: 'high' } })
    const fakes = fakeParts()
    const made: FakeBatch[] = []
    const parts = { ...fakes.parts, batch: ((host: { scene: Scene }) => {
      const b = new FakeBatch(host.scene)
      made.push(b)
      return b
    }) as never }
    const { host } = makeHost(store, { parts, load: { objects: true } })
    const sel = await host.enter(SELECT)
    const world = sel.world
    expect(world.render.mode).toBe('pbr')
    expect(world.batch).toBe(made.at(-1))
    expect(world.retailTuftsHidden).toBe(false) // the stage keeps the placed tufts and flower beds (D24)
    expect(fakes.configs).toEqual([{ groundFlocks: false }])
    expect(fakes.visible.length).toBe(1)
    const scales = () => made.at(-1)!.scales
    expect(scales().at(-1)).toBeCloseTo(1.4, 6)
    await host.enter(CREATE)
    expect(scales().at(-1)).toBeCloseTo(0.6, 6)
    // A graphics change (WorldGraphics.apply sets the preset's range, then the host puts the cap back): the batch too.
    store.set({ graphics: { sight: 'far' } })
    expect(world.objects.drawRangeScale).toBeCloseTo(0.6, 6)
    expect(scales().at(-1)).toBeCloseTo(0.6, 6)
    // Low and back (a path switch releases the batch and makes a new one): the new batch gets the cap; the wildlife
    // made again gets no ground flocks; the ocean keeps its switch.
    store.set({ graphics: { preset: 'low' } })
    expect(world.render.mode).toBe('classic')
    expect(world.batch).toBeNull()
    expect(made.at(-1)!.released).toBeGreaterThan(0)
    store.set({ graphics: { preset: 'high' } })
    expect(world.render.mode).toBe('pbr')
    expect(world.batch).toBe(made.at(-1))
    expect(made.length).toBe(2)
    expect(world.objects.drawRangeScale).toBeCloseTo(0.6, 6)
    expect(scales().at(-1)).toBeCloseTo(0.6, 6)
    expect(world.retailTuftsHidden).toBe(false)
    await vi.waitFor(() => expect(fakes.configs.length).toBe(2))
    expect(fakes.configs.every(c => c.groundFlocks === false)).toBe(true)
    await host.enter(SELECT)
    expect(scales().at(-1)).toBeCloseTo(1.4, 6)
  })

  it('at night the stage holds at sunset; the next enter by day runs the live clock (the server-time offset)', async () => {
    let now = 50_000_000
    const clock = clockAtT(0.1, now)
    const env = fakeApp({ server: { clock }, serverNow: () => now })
    const { host } = makeHost(mediumStore(), { app: env })
    const sel = await host.enter(SELECT)
    expect(sel.world.worldClock).toBeNull()
    expect(sel.world.timeOfDay).toBeCloseTo(sunriseSunset(clock.declination).set, 6)
    // Morning comes while select is up: the sunset frame stays.
    now += 30 * 60_000
    await new Promise(r => setTimeout(r, 30))
    expect(sel.world.timeOfDay).toBeCloseTo(sunriseSunset(clock.declination).set, 6)
    // The next enter (select → create) takes the live clock.
    await host.enter(CREATE)
    expect(sel.world.worldClock).toBe(clock)
  })

  it('select → create orbits round the spot when asked, and ends on the create camera', async () => {
    const { host } = makeHost(mediumStore())
    const sel = await host.enter(SELECT)
    const a0 = sel.camera.alpha
    const t0 = performance.now()
    await host.enter(CREATE, { orbitMs: 120 })
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100)
    const d = Math.abs(Math.atan2(Math.sin(sel.camera.alpha - a0), Math.cos(sel.camera.alpha - a0)))
    // Create looks the other way (the truck turns the pose a little off π).
    expect(d).toBeGreaterThan(Math.PI - 0.3)
    // The slots follow the stage: create stands one character on the spot, facing south.
    const [slot] = sel.slots(1)
    expect(slot).toMatchObject({ x: SPOT.x, z: SPOT.z, yaw: CREATE.facing })
    expect(slot!.y).toBeCloseTo(SPOT.yHint, 3)
  })

  it('select\'s slots stand on the nav around the spot, facing the camera', async () => {
    const { host } = makeHost(mediumStore())
    const sel = await host.enter(SELECT)
    const slots = sel.slots(4, 1)
    expect(slots).toHaveLength(4)
    for (const s of slots) {
      expect(s.y).toBeCloseTo(SPOT.yHint, 3)
      const toCam = Math.atan2(sel.camera.position.x - s.x, sel.camera.position.z - s.z)
      expect(Math.abs(Math.atan2(Math.sin(s.yaw - toCam), Math.cos(s.yaw - toCam)))).toBeLessThan(0.2)
    }
    expect(sel.ground).toBeCloseTo(SPOT.yHint, 3)
  })
})

/** An actor: a root with one PBR box, as the screens hand them to the stage. */
function pbrActor(scene: Scene, name = 'actor') {
  const root = new TransformNode(name, scene)
  const box = MeshBuilder.CreateBox(`${name}_body`, { size: 1 }, scene)
  box.material = new PBRMaterial(`${name}_mat`, scene)
  box.parent = root
  return { root, box }
}

describe('the stage host without stalls (P-STALL)', () => {
  it('a removed actor\'s effects stay referenced until the stage goes, so the next actor finds them compiled', async () => {
    const { host } = makeHost(mediumStore())
    const stage = await host.enter(SELECT)
    const a = pbrActor(stage.scene)
    stage.addActor(a.root)
    await vi.waitFor(() => expect(stage.isShown(a.root)).toBe(true), { timeout: 3000 })
    await vi.waitFor(() => expect(a.box.subMeshes[0]!._drawWrappers.some(w => w?.effect)).toBe(true), { timeout: 3000 })
    const effects = [...new Set(a.box.subMeshes.flatMap(sm => sm._drawWrappers.map(w => w?.effect)).filter((e): e is NonNullable<typeof e> => !!e))]
    const refs = effects.map(e => e._refCount)
    stage.removeActor(a.root)
    expect(effects.map(e => e._refCount)).toEqual(refs.map(r => r + 1))
    a.root.dispose()
    host.release()
    for (const [i, e] of effects.entries()) expect(e._refCount < refs[i]! + 1 || e.isDisposed).toBe(true)
  })

  it('an actor added after the warm-up is hidden while its shaders compile, then shown; a removal mid-way gives it back', async () => {
    const { host } = makeHost(mediumStore())
    const stage = await host.enter(SELECT)
    const a = pbrActor(stage.scene, 'late')
    stage.addActor(a.root)
    expect(a.root.isEnabled(false)).toBe(false)
    expect(stage.isShown(a.root)).toBe(false)
    await vi.waitFor(() => expect(stage.isShown(a.root)).toBe(true), { timeout: 3000 })
    expect(a.root.isEnabled(false)).toBe(true)
    // Removed while it is being prepared: enabled again, as the screen had it, and no longer tracked.
    const b = pbrActor(stage.scene, 'gone')
    stage.addActor(b.root)
    expect(b.root.isEnabled(false)).toBe(false)
    stage.removeActor(b.root)
    expect(b.root.isEnabled(false)).toBe(true)
    // Actors placed during the first load show at once (the warm-up compiles them behind the loading picture).
    const c = await host.enter(SELECT)
    expect(c).toBe(stage)
  })

  it('a re-entered stage hands the screen its actors during the orbit; they show when it ends', async () => {
    const { host } = makeHost(mediumStore())
    const sel = await host.enter(SELECT)
    let actorsAt = -1
    let shownDuringOrbit = false
    let actor: TransformNode | null = null
    const t0 = performance.now()
    const p = host.enter(CREATE, {
      orbitMs: 600,
      actors: async s => {
        actorsAt = performance.now() - t0
        const a = pbrActor(s.scene, 'create')
        actor = a.root
        s.addActor(a.root)
        s.scene.onAfterRenderObservable.add(() => {
          if (performance.now() - t0 < 450 && s.isShown(a.root)) shownDuringOrbit = true
        })
      },
    })
    await p
    expect(actorsAt).toBeGreaterThanOrEqual(0)
    expect(actorsAt).toBeLessThan(400)
    expect(shownDuringOrbit).toBe(false)
    await vi.waitFor(() => expect(sel.isShown(actor!)).toBe(true), { timeout: 3000 })
  })

  it('HL-1: the warm-up waits for the ocean\'s coast field (its wet band recompiles the terrain)', async () => {
    const run = vi.spyOn(GraphicsWarmup.prototype, 'run')
    const fakes = fakeParts()
    const loaded = Promise.resolve(null)
    const parts = { ...fakes.parts, ocean: () => ({ ...fakes.parts.ocean(), loaded }) as OceanPart }
    const { host } = makeHost(mediumStore(), { parts })
    await host.enter(SELECT)
    const warm = run.mock.instances[0] as unknown as { host: { parts?: Promise<unknown> | null } }
    expect(warm.host.parts).toBe(loaded)
  })

  it('every scene material carries the scene\'s light cap before it compiles (the glTF loader\'s raise changes nothing later)', async () => {
    const { host } = makeHost(mediumStore())
    const stage = await host.enter(SELECT)
    const lights = stage.scene.lights.length
    expect(lights).toBeGreaterThan(4)
    const capped = stage.scene.materials.filter(m => typeof (m as { maxSimultaneousLights?: number }).maxSimultaneousLights === 'number')
    expect(capped.length).toBeGreaterThan(0)
    for (const m of capped) expect((m as PBRMaterial).maxSimultaneousLights).toBeGreaterThanOrEqual(lights)
  })
})
