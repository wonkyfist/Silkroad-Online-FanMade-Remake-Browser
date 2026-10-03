/**
 * H-10R adversarial hunt, lens "leaks", the game's side: world -> select -> create -> world, three times, on ONE page
 * engine, with the wave-10 parts real (the grass field, the wildlife, the ocean and its shore on a synthetic coast;
 * the stage world of the palace steps between the world visits). Whatever still reaches a disposed World afterwards
 * keeps the whole visit alive. NullEngine (the WebGL path of the W9F LEAK-2 effect fix); `gc` through v8 flags so
 * WeakRefs prove reachability. No product code is changed by this file.
 *
 * Result of the hunt: this PASSES (a guard, not a finding). Every stage World and every world-screen World is collected
 * once the next screen owns the engine; the engine's texture cache only keeps NullEngine's never-released render
 * targets (NullEngine._releaseTexture does not drop them: all at 0 references). A heap snapshot of an earlier draft
 * showed the only retention was the test's own frame holding the last Stage, hence one function per screen.
 * WebGPU keeps the LEAK-2 effect closures by design (render/babylon-fixes.ts), so this guard covers WebGL only.
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { loadWorld, type World } from '@sro/world-render'
import { afterEach, describe, expect, it } from 'vitest'
import { addCoast } from '../../../packages/world-render/test/ocean-fixture.ts'
import { CX, CZ, ROOT_URL, WORLD_NAME, heightOf, makeFixture, settle } from '../../../packages/world-render/test/stream-fixture.ts'
import type { OwnedScene } from '../src/app.ts'
import { SettingsStore } from '../src/settings.ts'
import { createStageHost, type StageApp } from '../src/stage/host.ts'
import { STAGES } from '../src/stage/stages.ts'
import type { StageDef } from '../src/stage/types.ts'

setFlagsFromString('--expose_gc')
const gc = runInNewContext('gc') as () => void

// console.warn/info are silenced by hand: a vi.spyOn mock records its arguments and would keep them (and a world) alive.
const warn = console.warn
const info = console.info
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  console.warn = warn
  console.info = info
})

async function collect(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    gc()
    await new Promise(r => setTimeout(r, 10))
  }
}

const SPOT = { x: 96, z: -96, yHint: heightOf(CX, CZ) }
const onFixture = (d: StageDef): StageDef => ({ ...d, world: 'server', spot: { ...SPOT } })

/** The App's scene ownership (app.ts useScene / releaseScene) and a render loop on one NullEngine. */
function pageApp() {
  const engine = new NullEngine({ renderWidth: 640, renderHeight: 360, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 })
  let owned: OwnedScene | null = null
  const app = {
    engine,
    engineKind: 'WebGL2' as const,
    session: { server: { id: 's', name: 'S', status: 'online', online: 0, capacity: 1, world: WORLD_NAME }, clock: { serverNow: () => Date.now() } },
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
  } as unknown as StageApp & { useScene<T extends OwnedScene>(kind: string, build: () => T): T }
  const timer = setInterval(() => {
    const s = (app as { scene: Scene | null }).scene
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

describe('world -> select -> create -> world x3 keeps no visit alive', () => {
  it('every stage World and every world-screen World is collected once the next screen took the engine', async () => {
    console.warn = () => {}
    console.info = () => {}
    const { app } = pageApp()
    const fx = makeFixture()
    addCoast(fx)
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'medium', firstRun: false, releaseMigrated: true } })
    const host = createStageHost(app, {
      store, roots: [ROOT_URL], io: fx.io, load: { objects: false }, nightLights: { index: new Map() },
      device: { engine: 'WebGL2' }, warmup: { maxMs: 1500, framesPerView: 1, quietFrames: 2, stallMs: 100 },
    })
    cleanups.push(() => host.release())
    const stageWorlds: WeakRef<World>[] = []
    const gameWorlds: WeakRef<World>[] = []
    const visitWorld = async () => {
      // screens/world.ts: useScene('world') releases the stage, then builds the world's own scene and World.
      let world: World | null = null
      const owned = app.useScene('world', () => {
        const scene = new Scene(app.engine)
        scene.useRightHandedSystem = true
        return { kind: 'world', scene, dispose: () => { world?.dispose(); scene.dispose() } }
      })
      world = await loadWorld(owned.scene, {
        baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, quality: 'medium', weatherLevel: 'high', sky: 'modern', render: 'pbr',
      })
      const cam = new ArcRotateCamera('cam', 0, 1, 10, new Vector3(96, 10, -96), owned.scene)
      owned.scene.activeCamera = cam
      for (let i = 0; i < 20; i++) {
        world.update(cam)
        await settle(2)
      }
      gameWorlds.push(new WeakRef(world))
    }
    await visitWorld()
    // Each screen in a function of its own: no local of the test's frame keeps a Stage.
    const visitStage = async () => {
      const sel = await host.enter(onFixture(STAGES.select))
      const cre = await host.enter(onFixture(STAGES.create))
      if (cre.world !== sel.world) throw new Error('create did not reuse the select World')
      stageWorlds.push(new WeakRef(sel.world))
      await settle(10)
    }
    for (let round = 0; round < 3; round++) {
      await visitStage()
      await visitWorld()
    }
    // One more stage visit so the last world-screen World is released as well.
    await (async () => {
      await host.enter(onFixture(STAGES.select))
    })()
    await settle(20)
    // The create orbit's end timer (stage/host.ts reenter: orbitMs + 250 ms) holds its stage until it fires.
    await new Promise(r => setTimeout(r, 3000))
    await collect()
    const alive = (refs: WeakRef<World>[]) => refs.map(r => !!r.deref())
    expect({ stage: alive(stageWorlds), game: alive(gameWorlds) }).toEqual({ stage: [false, false, false], game: [false, false, false, false] })
  }, 180000)
})
