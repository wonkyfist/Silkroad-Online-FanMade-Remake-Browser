/**
 * W10R adversarial hunt, lens "screens-spec" (docs/SCREENS.md §12.7 H-SCR lenses 1-7, §0B.10's leak row): the stage
 * host (apps/game/src/stage/host.ts) on a NullEngine App stand-in, over world-render's synthetic streamed fixture, as
 * stage-host.test.ts drives it. No product code is changed.
 *
 * 1. Leak loop (lens 3, the §0B.10 row): world → select → create → select → world, three times: one scene on the
 *    engine after each return to the world, every stage World disposed, the engine's textures back to the baseline.
 * 2. Leak loop, retention (lens 3, the carried-over memory-growth item): the host is a page-global (`app.stage`, built
 *    once). `enter()` keeps `this.queue = run.catch(() => {})`, and a `.catch` of a fulfilled promise fulfils with the
 *    same value: the queue holds the last `Stage` → its `Built` → the disposed stage Scene, camera, key light, model
 *    library and time for the rest of the page, after the player went into the world. (The Built's `world` is nulled by
 *    teardown, so the World itself is collected on Classic; the Scene is not.)
 * 3. Flow edge case (lens 4): `reenter` arms `setTimeout(() => this.endOrbit(b), o.ms + 250)` for every orbit and never
 *    clears it. When frames come, the orbit ends by frame at `ms`; the stale timer still fires 250 ms later and ends
 *    whatever orbit runs then: select → create, then Cancel within ~250 ms of arriving, cuts the create → select orbit
 *    short (the camera jumps to the select pose part-way and `enter` resolves early).
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { ArcRotateCamera, Material, NullEngine, Observable, Scene, StandardMaterial, Vector3 } from '@babylonjs/core'
import type { ServerInfo } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROOT_URL, WORLD_NAME, heightOf, CX, CZ, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'
import type { LifePart, OceanPart, World } from '@sro/world-render'
import type { OwnedScene } from '../src/app.ts'
import { SettingsStore } from '../src/settings.ts'
import { actorTexturesFor } from '../src/three/actor-textures.ts'
import { createStageHost, type StageApp, type StageHostDeps } from '../src/stage/host.ts'
import { STAGES } from '../src/stage/stages.ts'
import type { StageDef, StageHost } from '../src/stage/types.ts'

setFlagsFromString('--expose_gc')
const gc = runInNewContext('gc') as () => void

const cleanups: Array<() => void> = []
const warn = console.warn
const info = console.info
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  console.warn = warn
  console.info = info
  vi.restoreAllMocks()
})

// Silenced by hand: a vi.spyOn mock records its arguments and would keep a world alive (abuse-w9f-leaks.test.ts).
const quiet = () => {
  console.warn = () => {}
  console.info = () => {}
}

const SPOT = { x: 96, z: -96, yHint: heightOf(CX, CZ) }
const onFixture = (d: StageDef): StageDef => ({ ...d, world: 'server', spot: { ...SPOT } })
const SELECT = onFixture(STAGES.select)
const CREATE = onFixture(STAGES.create)

/** The App's scene ownership (app.ts useScene / releaseScene) and a 4 ms render loop, as stage-host.test.ts. */
function fakeApp() {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 })
  let owned: OwnedScene | null = null
  const app = {
    engine,
    engineKind: 'WebGL2' as const,
    session: { server: { id: 's', name: 'S', status: 'online', online: 0, capacity: 1, world: WORLD_NAME } as ServerInfo, clock: { serverNow: () => Date.now() } },
    audio: { setArea: () => {}, setListener: () => {}, tick: () => {} },
    music: { play: () => {} },
    art: { musicUrl: (name: string) => `/music/${name}.ogg` },
    get scene(): Scene | null {
      return owned?.scene ?? null
    },
    useScene<T extends OwnedScene>(kind: string, build: () => T): T {
      if (owned?.kind === kind) return owned as T
      this.releaseScene()
      const o = build()
      owned = o
      return o
    },
    releaseScene(): void {
      if (!owned) return
      const o = owned
      owned = null
      o.dispose()
    },
  } satisfies StageApp & Record<string, unknown>
  const timer = setInterval(() => {
    const s = owned?.scene
    if (!s?.activeCamera || s.isDisposed) return
    engine.beginFrame()
    s.render()
    engine.endFrame()
  }, 4)
  cleanups.push(() => {
    clearInterval(timer)
    app.releaseScene()
    engine.dispose()
  })
  return { app, engine }
}

function fakeParts(): StageHostDeps['parts'] {
  const life = (): LifePart => ({
    enabled: true, setEnabled() {}, configure() {}, setThreats() {}, addSpecies: () => () => {}, addHabitat: () => () => {},
    setFocus() {}, update() {}, meshes: () => [], onFlush: new Observable(), dispose() {},
  })
  const ocean = (): OceanPart => ({ coast: null, update() {}, meshes: () => [], setQuality() {}, setVisible() {}, dispose() {} })
  return { life, ocean, batch: null }
}

function store(preset: 'low' | 'medium'): SettingsStore {
  const s = new SettingsStore(null)
  s.set({ graphics: { preset, firstRun: false, releaseMigrated: true } })
  return s
}

function makeHost(preset: 'low' | 'medium') {
  const env = fakeApp()
  const fx = makeFixture()
  const host: StageHost = createStageHost(env.app, {
    store: store(preset),
    roots: [ROOT_URL],
    io: fx.io,
    parts: fakeParts(),
    load: { objects: false },
    nightLights: { index: new Map() },
    device: { engine: 'WebGL2' },
    warmup: { maxMs: 3000, framesPerView: 1, quietFrames: 2, stallMs: 150 },
  })
  cleanups.push(() => host.release())
  return { host, ...env }
}

/** The world screen taking over (screens/world.ts: app.useScene('world', ...)), with a scene of its own. */
function goWorld(app: ReturnType<typeof fakeApp>['app'], engine: NullEngine): void {
  app.useScene('world', () => {
    const scene = new Scene(engine)
    // The world screen's ModelLibrary registers its scene's actor textures (three/actor-textures.ts), which also
    // replaces the page's `__sroActorTextures` console handle.
    actorTexturesFor(scene)
    scene.activeCamera = new ArcRotateCamera('worldCam', 0, 1, 10, Vector3.Zero(), scene)
    // The world screen makes its materials at once: Babylon's static Material.OnEventObservable keeps the last
    // material it announced (its event state), and the next material moves it on.
    new StandardMaterial('worldMat', scene)
    return { kind: 'world', scene, dispose: () => scene.dispose() }
  })
}

/**
 * Internal textures still referenced. NullEngine's `_releaseTexture` is a no-op, so a released texture (references 0)
 * stays in its cache: only the referenced ones count.
 */
const liveTextures = (engine: NullEngine) => engine.getLoadedTexturesCache().filter(t => (t as unknown as { _references: number })._references > 0).length

const isDisposed = (w: World) => (w as unknown as { disposed: boolean }).disposed

async function collect(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    gc()
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('H-SCR lens 3: world → select → create → select → world, three times', () => {
  it('leaves one scene on the engine, disposes every stage World and returns the engine textures to the baseline', async () => {
    quiet()
    const { host, app, engine } = makeHost('medium')
    goWorld(app, engine)
    const baseScenes = engine.scenes.length
    const baseTextures = liveTextures(engine)
    const worlds: World[] = []
    for (let round = 0; round < 3; round++) {
      const sel = await host.enter(SELECT)
      const world = sel.world
      worlds.push(world)
      const cre = await host.enter(CREATE, { orbitMs: 40 })
      expect(cre.world).toBe(world)
      await host.enter(SELECT, { orbitMs: 40 })
      goWorld(app, engine)
      expect(engine.scenes.length, `round ${round}: scenes`).toBe(baseScenes)
      expect(isDisposed(world), `round ${round}: the stage World`).toBe(true)
      expect(liveTextures(engine), `round ${round}: live engine textures`).toBe(baseTextures)
    }
    expect(new Set(worlds).size).toBe(3)
  }, 90_000)
})

describe('H-SCR lens 3: the page-global stage host keeps nothing of a stage once the world screen took over', () => {
  it('the last stage Scene is collected after select → world (Classic, so LEAK-2 plays no part)', async () => {
    quiet()
    // As on the page, where the engine lives on and the fog plugin's observer with it: Material.OnEventObservable has
    // an observer, so every new material moves its event state on. (The test above disposed its engine, and Babylon
    // then unregisters every material plugin; the observer list empties only after one more notify, which leaves the
    // last stage material in the event state: a test-suite artefact, not a page retention.)
    const announced = Material.OnEventObservable.add(() => {})
    cleanups.push(() => Material.OnEventObservable.remove(announced))
    const { host, app, engine } = makeHost('low')
    const refs = await (async () => {
      const sel = await host.enter(SELECT)
      expect(sel.world.render.mode).toBe('classic')
      const r = { scene: new WeakRef(sel.scene), world: new WeakRef(sel.world), camera: new WeakRef(sel.camera) }
      goWorld(app, engine)
      return r
    })()
    // The world screen renders a while (Babylon's single-slot references move on to its scene).
    await new Promise(r => setTimeout(r, 100))
    await collect()
    expect(refs.world.deref(), 'the stage World').toBeUndefined()
    // Was failing (fixed: the queue is `run.then(() => undefined, () => undefined)`, SCR-H1). Heap snapshot path:
    // StageHostImpl --queue--> Promise --result--> StageImpl --b--> Built --scene--> Scene.
    // `this.queue = run.catch(() => {})` fulfils with the Stage, so the page-global host keeps the last Stage, its
    // Built and through it the disposed Scene, camera, key light, library and time for the whole world session.
    // (With the queue reset to Promise.resolve() by hand the Scene is collected.)
    expect(refs.scene.deref(), 'the disposed stage Scene').toBeUndefined()
    expect(refs.camera.deref(), 'the stage camera').toBeUndefined()
  }, 60_000)
})

describe('H-SCR lens 4: a quick Cancel on create', () => {
  it('create → select right after the select → create orbit still orbits for the whole orbitMs', async () => {
    quiet()
    const { host } = makeHost('medium')
    const sel = await host.enter(SELECT)
    const ORBIT = 400
    await host.enter(CREATE, { orbitMs: ORBIT })
    // The player presses Cancel at once: create → select, with the same orbit.
    const t0 = performance.now()
    const alphas: number[] = []
    const probe = setInterval(() => alphas.push(sel.camera.alpha), 10)
    await host.enter(SELECT, { orbitMs: ORBIT })
    clearInterval(probe)
    const took = performance.now() - t0
    // Was failing (~240 ms; fixed, SCR-H2: the timer ends only its own orbit and is cleared with it): the first orbit's timer (armed for ORBIT + 250 ms) fires during the second orbit and ends it.
    expect(took, 'the create → select orbit ran its full length').toBeGreaterThanOrEqual(ORBIT - 30)
  }, 30_000)
})
