/**
 * W9F adversarial hunt, lens "leaks" (docs/WAVE_PLAN3.md §6.19 item 11; docs/BACKLOG.md "memory growth when going
 * world → character select"). The game keeps ONE Babylon engine for the page; every world visit makes a new Scene and
 * World on it and disposes both on the way back to character select. Whatever still reaches them afterwards keeps the
 * whole visit alive (the World holds its manifest, regions, nav and terrain data; the Scene its meshes' JS side).
 *
 * 1. (world-render) The engine's compiled-effect cache keeps a closure (`_processCodeAfterIncludes`) of the first
 *    material plugin manager that compiled each shader variant. Through SroTerrainPlugin → TerrainPbr → SharedUniforms
 *    → a TerrainRenderer listener → WorldRender.shelterOf → World, a disposed PBR world stays reachable for the rest of
 *    the page: the first one, and every later visit that compiles a variant nobody compiled before (another preset,
 *    another terrain layer set). Classic-only visits are collected (the control test).
 * 2. (world-render) NightPointLights.dispose (every Modern off → on, every change of the cluster size) disposes its
 *    ClusteredLightContainer without `disposeMaterialAndTextures`, so Babylon's "ProxyMaterial" ShaderMaterial (and its
 *    UBO) stays in scene.materials: one more per toggle until the scene dies. Browser (WebGL2, High, Modern on, five
 *    toggles): scene.materials 763 → 764 → … → 768 and engine UBOs 810 → 811 → … → 815, each new one "ProxyMaterial".
 * 3. (game) ChatBox (world/chat.ts) calls `watchLayout(this.root, …)`, drops the stop function it returns and has no
 *    dispose. watchLayout stops by itself only on the next window `resize` after the element left the page, so the
 *    `resize` listener keeps the ChatBox, whose send callback is a closure of worldScreen (screens/world.ts): that
 *    context holds the scene, the camera, the ModelLibrary and `heights` (EntityHeights → World), which dispose never
 *    clears. Browser: an instrumented visit left exactly one live listener of the world screen after the return to
 *    character select: `window resize` ← watchLayout ← new ChatBox ← worldScreen.
 *
 * NullEngine, and stubs instead of a DOM; `gc` is exposed through v8 flags so WeakRefs can prove reachability. No
 * product code is changed.
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { NightPointLights, RENDER_PRESETS, loadWorld, type World } from '../../../packages/world-render/src/index.ts'
import { ROOT_URL, WORLD_NAME, makeFixture, settle } from '../../../packages/world-render/test/stream-fixture.ts'
import { watchLayout } from '../src/hud/hud-layout.ts'

setFlagsFromString('--expose_gc')
const gc = runInNewContext('gc') as () => void

// console.warn is silenced by hand: a vi.spyOn mock records its arguments and would keep them (and a world) alive.
const warn = console.warn
const quiet = () => {
  console.warn = () => {}
}
const saved: Record<string, unknown> = {}
const G = globalThis as unknown as Record<string, unknown>
afterEach(() => {
  console.warn = warn
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete G[k]
    else G[k] = v
    delete saved[k]
  }
})

/** Full collections with task turns between them (WeakRef targets are kept until the job that made them ends). */
async function collect(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    gc()
    await new Promise(r => setTimeout(r, 10))
  }
}

type Visit = { render: 'pbr' | 'classic'; quality: 'medium' | 'high' | 'ultra' }

/**
 * One world visit on the page's engine, as the world screen makes it: a new scene, a fixture World, frames, then
 * World.dispose and Scene.dispose (screens/world.ts dispose → ground.dispose, app.releaseScene). Only WeakRefs leave
 * this function.
 */
async function visit(engine: NullEngine, v: Visit): Promise<{ scene: WeakRef<Scene>; world: WeakRef<World> }> {
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const fx = makeFixture()
  const world = await loadWorld(scene, {
    baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false,
    quality: v.quality, weatherLevel: 'high', sky: 'modern', render: v.render,
  })
  const cam = new ArcRotateCamera('cam', 0, 1, 10, new Vector3(96, 10, -96), scene)
  scene.activeCamera = cam
  for (let i = 0; i < 12; i++) {
    world.update(cam)
    engine.beginFrame()
    scene.render()
    engine.endFrame()
    await settle(3)
  }
  world.dispose()
  scene.dispose()
  engine.beginFrame()
  engine.endFrame()
  await settle(10)
  return { scene: new WeakRef(scene), world: new WeakRef(world) }
}

describe('world → character select: a disposed world must not stay reachable from the page engine', () => {
  it('a Classic visit is collected (control)', async () => {
    quiet()
    const engine = new NullEngine()
    const first = await visit(engine, { render: 'classic', quality: 'high' })
    // A later visit: Babylon keeps a few single-slot references to the LAST scene (floating-origin overrides).
    await visit(engine, { render: 'classic', quality: 'high' })
    await collect()
    expect(first.world.deref(), 'the Classic world after dispose').toBeUndefined()
    engine.dispose()
  }, 60000)

  it('a Modern (PBR) visit is collected once disposed', async () => {
    quiet()
    const engine = new NullEngine()
    const first = await visit(engine, { render: 'pbr', quality: 'high' })
    await visit(engine, { render: 'classic', quality: 'high' })
    await collect()
    // Fails: engine._compiledEffects → Effect._processCodeAfterIncludes → MaterialPluginManager → SroTerrainPlugin
    // → TerrainPbr → SharedUniforms → TerrainRenderer listener → WorldRender.shelterOf → World (and its scene).
    expect(first.world.deref(), 'the first PBR world after dispose').toBeUndefined()
    expect(first.scene.deref(), 'its scene').toBeUndefined()
    engine.dispose()
  }, 60000)

  it('char select → world → char select at Medium, High and Ultra keeps none of the three worlds', async () => {
    quiet()
    const engine = new NullEngine()
    const refs = []
    for (const quality of ['medium', 'high', 'ultra'] as const) refs.push(await visit(engine, { render: 'pbr', quality }))
    await visit(engine, { render: 'classic', quality: 'high' })
    await collect()
    // Fails with all three alive: each visit compiled variants nobody compiled before, and pins its own world.
    expect(refs.map(r => !!r.world.deref())).toEqual([false, false, false])
    engine.dispose()
  }, 90000)
})

describe('Modern toggles: the night point lights leave nothing behind', () => {
  it('five rebuilds of the clustered point lights leave no ProxyMaterial in the scene', () => {
    quiet()
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const q = RENDER_PRESETS.high.nightLights
    expect(q.cluster, 'High uses the clustered container').toBeGreaterThan(0)
    const before = scene.materials.length
    // NightLights.applyQuality: every Modern off → on (and every change of the cluster size) disposes the old driver and
    // builds a new one. NullEngine takes the unsupported branch (the container is disposed in the constructor); the
    // browser takes the supported one (disposed in NightPointLights.dispose). Both call container.dispose() without
    // disposeMaterialAndTextures, so Babylon's proxy mesh goes but its ShaderMaterial stays.
    for (let i = 0; i < 5; i++) new NightPointLights(scene, q).dispose()
    const proxies = scene.materials.filter(m => m.name === 'ProxyMaterial')
    expect(proxies.map(m => m.name), 'clustered-light proxy materials left in scene.materials').toEqual([])
    expect(scene.materials.length).toBe(before)
    scene.dispose()
    engine.dispose()
  })
})

// ---- the chat's layout watcher (no DOM: stubs) --------------------------------------------------------------------

type Listener = (ev?: unknown) => void

function stub(name: string, value: unknown): void {
  if (!(name in saved)) saved[name] = G[name]
  G[name] = value
}

/** A window with listener bookkeeping, and a frame queue the test runs by hand. */
function fakePage() {
  const listeners = new Map<string, Set<Listener>>()
  const frames: Array<(t: number) => void> = []
  stub('window', {
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
  })
  stub('requestAnimationFrame', (fn: (t: number) => void) => frames.push(fn))
  stub('cancelAnimationFrame', () => {})
  stub('document', { documentElement: {} })
  stub('getComputedStyle', () => ({ getPropertyValue: () => '1' }))
  return {
    listeners: (type: string) => listeners.get(type)?.size ?? 0,
    runFrames: (n = 5) => {
      for (let i = 0; i < n; i++) for (const f of frames.splice(0)) f(i * 16)
    },
  }
}

describe('world → character select: the chat layout watcher', () => {
  it('stops listening to window resize once the chat left the page, with no resize in between', () => {
    const page = fakePage()
    const chatRoot = { isConnected: true, currentCSSZoom: 1 } as unknown as HTMLElement
    let placed = 0
    // ChatBox's call: the returned stop function is dropped (world/chat.ts, `watchLayout(this.root, …)`).
    watchLayout(chatRoot, () => placed++)
    page.runFrames()
    expect(placed, 'placed once while shown').toBe(1)
    expect(page.listeners('resize')).toBe(1)
    // World → character select: the world screen removes its DOM (root.remove()); the chat is detached for good.
    ;(chatRoot as unknown as { isConnected: boolean }).isConnected = false
    page.runFrames(120) // two seconds of character select; the player does not resize the window
    // Fails: the listener (and through ChatBox's callbacks the whole world screen: scene, World) is still there.
    expect(page.listeners('resize'), 'window resize listeners left after the chat was removed').toBe(0)
  })
})
