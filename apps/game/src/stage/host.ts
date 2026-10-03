/**
 * The stage host (docs/SCREENS.md §0B, §4.3–§4.6; lane SCR-R): the one stage `World` of the character screens, on the
 * Jangan palace steps, loaded through the world screen's own renderer path. Screens only call
 * `app.stage.enter(STAGES.select | STAGES.create)`; they never call `loadWorld` or make a `Scene`.
 *
 * - **One scene, one World.** The scene is owned through `App.useScene('stage:<export>')`, so the world screen's
 *   `useScene('world')` (or login's backdrop) releases it before building its own: the stage's `WorldGraphics` (a
 *   page-global render-scale handler) and its ambience (`GameAudio.setArea`, page-global) are gone before the world's
 *   are made. `enter(create)` after select on the same export keeps the World; only the camera moves (it orbits with
 *   `orbitMs`). A different export, or a scene someone else released, loads again.
 * - **Graphics** (§4.3): the first-run device check (`runReleaseMigration` + `runFirstRun`) runs before the first
 *   `enter` (select is now the first 3D world a new player sees); `effectiveGraphics` picks the path, preset, sky and
 *   weather level, so Low is the Classic path; `WorldGraphics` links the settings (path switches, the render blocks,
 *   the character-material decoration), with `frame(ms, false)`: its watchdog never judges (and saves) a preset from a
 *   menu. After each of its applies the host puts back what it resets: the stage stream (150 m, 12 fetches, §0B.4),
 *   create's draw-range cap `min(preset, 0.6)` (§0B.9), the key light's path, the weather level.
 * - **Load** (§0B.4): 150 m around the spot, ready at 150 m, objects waited for, no minimap; the retail tufts stay
 *   (`hideRetailTufts: false`, the placed flower beds, D24); the screen's `preload` (its characters) runs beside it.
 *   Then the screen's `actors`, then `GraphicsWarmup` with 2 views (the select and create headings, so the first orbit
 *   builds no WebGPU pipeline), once per World; `enter` resolves after the stage has rendered once.
 * - **Per frame** (before the render): the camera (fixed pose, the select idle drift, the orbit), `world.update(camera,
 *   spot)` (the PBR post stack attaches there), `graphics.frame(ms, false)`, the sunset hold, the server weather at
 *   half intensity, the key light, the wildlife's switch (no ground flocks, D25) and the ocean's visibility (D27),
 *   the ambience listener.
 * - **Time and weather** (stage-time.ts): the server's clock from `app.session.server` at the lobby socket's server
 *   time; at night the sunset hold, until the next `enter`. **Sound**: `maintheme_cut` goes on playing (a no-op when it
 *   plays), the town ambience under it; `setArea(null)` on release.
 * - **Characters**: `addActor` hands the model's meshes to the renderer's shadows and the key light (PBR); the library's
 *   decorator is `WorldGraphics.decorate` (6 lights per material on PBR). Classic (Low) gets no key light.
 * - A load that fails (no export, a throw) rejects and releases everything: the screens run today's scenes (§0B.4).
 * - **No stall when an actor appears** (lane P-STALL): every select/create turn used to stall 0.1 s on WebGPU (the
 *   frame the new actors first drew compiled 14 shaders and built 9 render pipelines) and the first one 0.5 s on
 *   WebGL2 High. Now (1) the effects of a removed actor stay referenced until the stage goes (`kept`): Babylon released
 *   them with the actor, so the same characters compiled again on every turn and missed WebGPU's pipeline cache, which
 *   is keyed by the effect; (2) an actor added after the warm-up is prepared before it shows (`prepareActor`): hidden
 *   while its shaders compile PREPARE_BUDGET_MS a frame (its material and its shadow depth passes), then on WebGPU
 *   drawn as a ghost (screens/pipelines.ts: its draws skipped, its pipelines made in the background) until its
 *   pipelines are made, and shown when the orbit has ended; (3) a re-entered stage hands the screen's `actors` the
 *   stage as soon as its `preload` is done, so the preparation runs during the orbit.
 */
import { ArcRotateCamera, Color3, Color4, DirectionalLight, HemisphericLight, Vector3, type AbstractEngine, type AbstractMesh, type Effect, type Mesh, type Observer, type Scene, type TransformNode } from '@babylonjs/core'
import { checkNonFloatVertexBuffers } from '@babylonjs/core/Buffers/buffer.nonFloatVertexBuffers.js'
import type { ServerInfo } from '@sro/shared'
import {
  CLEAR_FRAME,
  attachNightLights,
  loadWorld,
  resolveAssetBase,
  type LifePart,
  type LoadWorldOptions,
  type NightLights,
  type NightLightsOptions,
  type OceanPart,
  type WeatherFrame,
  type World,
  type WorldIO,
  type WorldParts,
} from '@sro/world-render'
import type { OwnedScene } from '../app.ts'
import type { EngineKind } from '../engine.ts'
import { PipelineWarm } from '../screens/pipelines.ts'
import { GraphicsWarmup, type WarmupOptions, type WarmupResult } from '../screens/warmup.ts'
import { deviceHintOf, effectiveGraphics, qualityFor, runFirstRun, runReleaseMigration, settings, type DeviceHint, type SettingsStore } from '../settings.ts'
import { newScene } from '../three/backdrop.ts'
import { keepLightCap } from '../three/light-cap.ts'
import { ModelLibrary } from '../three/models.ts'
import { WeatherClient } from '../world/features/weather.ts'
import { WorldGraphics, worldTown, worldTreesOption, type WorldTownSeam } from '../world/graphics.ts'
import { ASSET_ROOTS, urlQuality } from '../world/jangan/ground.ts'
import { StageKeyLight } from './key-light.ts'
import { stopStagePrefetch } from './prefetch.ts'
import { arcPose, slotPoints, stagePose, type CameraPose } from './slots.ts'
import { STAGE_DRIFT, STAGE_STREAM, stageWorld } from './stages.ts'
import { StageTime, stageWeather } from './stage-time.ts'
import type { Stage, StageDef, StageEnterOptions, StageHost } from './types.ts'

/** Kept for the seam's callers: the message of a host that cannot build (no engine). */
export const STAGE_NOT_BUILT = 'stage host: not built'

/** The ocean on the stage (D27, open question 12): shown unless LAB-10R measures more than 0.3 ms there. */
export const STAGE_OCEAN_VISIBLE = true

/** The warm-up's views: the select and the create headings (§0B.4, fc-B 4). */
export const STAGE_WARMUP_VIEWS = 2

/**
 * WebGL2's warm-up views: eight headings 45° apart from the select heading, so the whole select ↔ create orbit is drawn
 * behind the loading picture. P-STALL: with the two end headings only, the first orbit each way drew its side views
 * for the first time and, on WebGL2 High, frames near its end waited 0.15-0.56 s on the driver (the second orbit was
 * clean; the same in the build before P-STALL). WebGPU's orbit draws them without a stall (its pipelines are keyed by
 * the effect, which the front views made), so it keeps the two.
 */
export const STAGE_WARMUP_VIEWS_GL = 8

/**
 * WebGL2's warm-up cap on the stage (ms; WebGPU keeps WARMUP_DEFAULTS.maxMs, 20 s). A cold shader cache at High took
 * 15-20 s here (the driver compiling the stage's programs; 15.6 s before P-STALL with 2 views), and what the cap cut off
 * stalled the select screen (a 1.3 s frame). Only a first visit pays it.
 */
export const STAGE_WARMUP_MAX_MS_GL = 30_000

/** `enter` waits this long at most for the first rendered frame (a hidden tab renders none). */
export const FIRST_FRAME_WAIT_MS = 2000

/** The music the character screens play (§0B.5; select and create call it too: a no-op while it plays). */
export const STAGE_MUSIC = 'maintheme_cut'

/** The ambience under it (§0B.5; scope cut 2). */
export const STAGE_AREA = 'JANGAN_TOWN'
/**
 * Wave 11 (docs/TOWN_LIFE.md §12.4, WAVE_PLAN7 D17): no townsperson walks within this many metres of the stage spot
 * (the palace steps where the characters stand): World.town.configure({ noFolk }).
 */
export const STAGE_NO_FOLK_M = 12

/** Main-thread time per frame for preparing actors (ms; at least one submesh a frame): see prepareActor. */
export const PREPARE_BUDGET_MS = 8

/** An actor is shown after this long whatever is left (ms; a hidden tab renders no frame). */
export const PREPARE_MAX_MS = 4000

/** Progress shares: the world, the actors, the warm-up. */
const P_WORLD = 0.7
const P_ACTORS = 0.8

/** The part of App the host uses (App satisfies it; tests pass a fake). */
export interface StageApp {
  readonly engine: AbstractEngine
  readonly engineKind: EngineKind
  readonly session: { readonly server: ServerInfo | null; readonly clock: { serverNow(): number } } | null
  readonly audio?: { setArea(id: string | null): void; setListener(feet: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }): void; tick(): void } | null
  readonly music?: { play(url: string | null | undefined): void } | null
  readonly art?: { musicUrl(name: string): string | undefined } | null
  readonly scene: Scene | null
  useScene<T extends OwnedScene>(kind: string, build: () => T): T
  releaseScene(): void
}

/** Test hooks (the game passes none). */
export interface StageHostDeps {
  store?: SettingsStore
  roots?: readonly string[]
  io?: WorldIO
  parts?: WorldParts
  /** false: no warm-up; else its options over the stage's (2 views). */
  warmup?: false | WarmupOptions
  /** Night lights' options (tests: an empty ambient index); false: none. */
  nightLights?: false | Omit<NightLightsOptions, 'focus'>
  /** false: an actor shows at once when added (as before P-STALL; tests). */
  prepare?: false
  /** WebGPU's background pipelines for the ghost frames (default the engine's; null: none). */
  pipelines?: PipelineWarm | null
  oceanVisible?: boolean
  now?: () => number
  /** The device hint (default: read from the engine). */
  device?: DeviceHint
  /** More loadWorld options (tests: `objects: false`). */
  load?: Partial<LoadWorldOptions>
}

/** Everything one loaded stage owns. */
interface Built {
  readonly kind: string
  readonly worldName: string
  readonly scene: Scene
  readonly camera: ArcRotateCamera
  readonly hemi: HemisphericLight
  readonly sun: DirectionalLight
  readonly library: ModelLibrary
  readonly key: StageKeyLight
  readonly time: StageTime
  world: World | null
  graphics: WorldGraphics | null
  nightLights: NightLights | null
  weather: WeatherClient | null
  readonly weatherBuf: WeatherFrame
  stage: StageImpl | null
  def: StageDef
  spot: { x: number; z: number }
  ground: number
  zoom: number
  enteredAt: number
  orbit: { from: { alpha: number; beta: number; radius: number; target: Vector3 }; t0: number; ms: number; done: () => void } | null
  warming: GraphicsWarmup | null
  warmed: boolean
  lastLife: LifePart | null | undefined
  lastOcean: OceanPart | null | undefined
  /** Wave 11: the town part `noFolk` was handed to (a path switch re-makes it). */
  lastTown: WorldTownSeam | null | undefined
  lastClockOn: boolean
  /** The ambience area was set (released with the stage). */
  area: boolean
  readonly actors: Map<TransformNode, AbstractMesh[]>
  /** Effects of removed actors, one reference each, released with the stage (P-STALL). */
  readonly kept: Set<Effect>
  /** Actors being prepared before they show (prepareActor), and the frame observer that drives them. */
  readonly preps: Map<TransformNode, Prep>
  prepObs: Observer<Scene> | null
  readonly observers: Array<() => void>
  lastFrameAt: number
  disposed: boolean
}

/** An actor being prepared (prepareActor): its meshes compiling, then its ghost frames on WebGPU. */
interface Prep {
  readonly root: TransformNode
  readonly meshes: AbstractMesh[]
  /** Meshes still compiling. */
  pending: AbstractMesh[]
  phase: 'compile' | 'ghost'
  /** Ends the ghost (WebGPU). */
  unghost: (() => void) | null
  ghostFrames: number
  /** PipelineWarm.started at the last ghost frame. */
  startedSeen: number
  readonly t0: number
}

/** The effects a mesh's submeshes hold now, in every pass (the main draw, the shadow maps). */
function meshEffects(m: AbstractMesh, out: Set<Effect>): void {
  for (const sm of m.subMeshes ?? []) {
    for (const w of sm._drawWrappers ?? []) if (w?.effect && !w.effect.isDisposed) out.add(w.effect)
  }
}

/**
 * Asks one mesh to compile what its first draw needs: its material for every submesh, and the depth effect of every
 * shadow generator of its lights in each pass of the shadow map (as Mesh.isReady, but also while the mesh is not in the
 * caster list: the actor is hidden while it compiles). Stops early when `over()` says the frame's budget is spent.
 * True when everything is ready.
 */
function compileMesh(m: AbstractMesh, over: () => boolean): boolean {
  const engine = m.getEngine()
  let ok = true
  for (const sm of m.subMeshes ?? []) {
    if (over()) return false
    const mat = sm.getMaterial()
    if (!mat) continue
    if (mat._storeEffectOnSubMeshes ? !mat.isReadyForSubMesh(m, sm, false) : !mat.isReady(m, false)) ok = false
    const transparent = mat.needAlphaBlendingForMesh(m)
    const pass = engine.currentRenderPassId
    for (const light of m.lightSources) {
      const gens = light.getShadowGenerators()
      if (!gens) continue
      for (const g of gens.values()) {
        for (const id of g.getShadowMap()?.renderPassIds ?? [pass]) {
          engine.currentRenderPassId = id
          if (!g.isReady(sm, false, transparent)) ok = false
        }
        engine.currentRenderPassId = pass
      }
    }
    // WebGPU rebuilds an effect's shader for a mesh whose vertex data is not float (a skinned actor's joint indices)
    // when it first builds a pipeline for it (Babylon's checkNonFloatVertexBuffers, 40-60 ms a shader): done here, a
    // frame's budget at a time, instead of in the frame that first draws the actor. A no-op on WebGL2 and once done.
    const buffers = (m as Mesh).geometry?.getVertexBuffers()
    if (!buffers) continue
    for (const w of sm._drawWrappers ?? []) {
      const effect = w?.effect
      if (!effect?.isReady() || effect.isDisposed) continue
      if (over()) return false
      checkNonFloatVertexBuffers(buffers, effect)
    }
  }
  return ok
}

const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now())

/** A stage (the object screens hold): its def follows the host's current one. */
class StageImpl implements Stage {
  constructor(private readonly host: StageHostImpl, private readonly b: Built) {}

  get def(): StageDef {
    return this.b.def
  }

  get scene(): Scene {
    return this.b.scene
  }

  get world(): World {
    return this.b.world!
  }

  get camera(): ArcRotateCamera {
    return this.b.camera
  }

  get library(): ModelLibrary {
    return this.b.library
  }

  get ground(): number {
    return this.b.ground
  }

  setCameraTime(_t: number): void {
    this.host.placeCamera(this.b, 0)
  }

  setZoom(f: number): void {
    this.b.zoom = Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0))
  }

  slots(n: number, selected = -1): { x: number; y: number; z: number; yaw: number }[] {
    const b = this.b
    const cam = this.host.pose(b, 0, 0).position
    return slotPoints(b.def, b.spot, n, cam, selected).map(p => ({ x: p.x, y: b.world?.heightAt(p.x, p.z, b.ground + 1) ?? b.ground, z: p.z, yaw: p.yaw }))
  }

  addActor(root: TransformNode): void {
    const b = this.b
    if (b.disposed || !b.world || b.actors.has(root)) return
    const all = root.getChildMeshes(false)
    const set = new Set<unknown>(all)
    // The topmost meshes (each part's root; the renderer walks their children), as world/graphics.ts characterMeshes.
    const top = all.filter(m => !set.has(m.parent))
    b.actors.set(root, top)
    for (const m of top) b.world.render.addCharacter(m)
    b.key.add(root)
    // After the warm-up an actor shows once its shaders and pipelines are made (the warm-up covers the first ones).
    if (b.warmed && !b.warming) this.host.prepareActor(b, root)
  }

  isShown(root: TransformNode): boolean {
    return root.isEnabled(false) && !this.b.preps.has(root)
  }

  removeActor(root: TransformNode): void {
    const b = this.b
    const top = b.actors.get(root)
    if (!top) return
    this.host.endPrep(b, root, false)
    b.actors.delete(root)
    if (!b.disposed) this.host.keepEffects(b, root)
    if (!b.disposed && b.world) for (const m of top) b.world.render.removeCharacter(m)
    b.key.remove(root)
  }
}

const abortError = () => {
  const err = new Error('stage enter aborted')
  err.name = 'AbortError'
  return err
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

class StageHostImpl implements StageHost {
  private readonly store: SettingsStore
  private readonly now: () => number
  private built: Built | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private device: DeviceHint | null = null
  private firstRunDone = false

  constructor(
    private readonly app: StageApp,
    private readonly deps: StageHostDeps = {},
  ) {
    this.store = deps.store ?? settings
    this.now = deps.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()))
  }

  enter(def: StageDef, opts: StageEnterOptions = {}): Promise<Stage> {
    const run = this.queue.then(() => this.enterNow(def, opts), () => this.enterNow(def, opts))
    // The queue only orders the calls: it must not hold the Stage (a fulfilled `.catch` keeps its value, and the host
    // lives for the page, so the last stage's disposed Scene would stay reachable through the world session; SCR-H1).
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  release(): void {
    stopStagePrefetch()
    const b = this.built
    if (!b) return
    if (!b.disposed && this.app.scene === b.scene) this.app.releaseScene()
    else this.teardown(b)
  }

  // ---- enter ------------------------------------------------------------------------------------------------------

  private async enterNow(def: StageDef, opts: StageEnterOptions): Promise<Stage> {
    if (!this.app.engine) throw new Error(STAGE_NOT_BUILT)
    if (opts.signal?.aborted) throw abortError()
    // The select screen starts its own load: the login-time prefetch has done its part.
    stopStagePrefetch()
    const device = this.deviceHint()
    const worldName = stageWorld(def, this.app.session?.server?.world)
    const b = this.built
    if (b && !b.disposed && b.world && b.worldName === worldName && this.app.scene === b.scene) return this.reenter(b, def, opts)
    return this.load(def, worldName, device, opts)
  }

  /** The first-run device check, once, before the first stage (§4.3 fact-check). */
  private deviceHint(): DeviceHint {
    if (!this.device) this.device = this.deps.device ?? deviceHintOf(this.app.engine, this.app.engineKind)
    if (!this.firstRunDone) {
      this.firstRunDone = true
      runReleaseMigration(this.store)
      runFirstRun(this.store, this.device)
    }
    return this.device
  }

  private async load(def: StageDef, worldName: string, device: DeviceHint, opts: StageEnterOptions): Promise<Stage> {
    const progress = (f: number) => opts.onProgress?.(Math.max(0, Math.min(1, f)))
    progress(0)
    const kind = `stage:${worldName}`
    const b = this.app.useScene(kind, () => this.buildScene(kind, worldName, def)) as OwnedScene & { built?: Built }
    const built = b.built
    if (!built) throw new Error(`stage host: the scene '${kind}' is not a stage`)
    this.built = built
    try {
      const preload = opts.preload ? Promise.resolve(opts.preload(built.scene, built.library)) : Promise.resolve()
      // An early failure of the screen's preload is reported after the world, not as an unhandled rejection.
      preload.catch(() => {})
      const store = this.store
      const quality = urlQuality() ?? store.get().graphics.preset
      const eg = effectiveGraphics(store.get(), { gpu: device, preset: quality })
      const roots = this.deps.roots ?? ASSET_ROOTS
      const base = await resolveAssetBase(roots, worldName, this.deps.io)
      if (!base) throw new Error(`no world export at ${roots.map(r => `${r}world/${worldName}/`).join(' or ')}`)
      this.check(built, opts)
      const world = await loadWorld(built.scene, {
        baseUrl: base,
        world: worldName,
        quality,
        render: eg.render,
        sky: eg.sky,
        weatherLevel: eg.weather,
        stream: 'auto',
        focus: { x: def.spot.x, z: def.spot.z },
        streamSettings: { ...STAGE_STREAM },
        readyRadiusM: def.readyRadiusM ?? STAGE_STREAM.loadRadiusM,
        waitForObjects: true,
        minimap: false,
        // The stage keeps the placed flower beds and tufts (GRASS_LIFE D24).
        hideRetailTufts: false,
        // Wave 12 (W12-G): the stage shows the same trees as the world (Options → Trees; 'retail' on Classic).
        trees: worldTreesOption(eg),
        onProgress: p => progress(P_WORLD * p.fraction),
        ...(this.deps.io ? { io: this.deps.io } : {}),
        ...(this.deps.parts ? { parts: this.deps.parts } : {}),
        ...(this.deps.load ?? {}),
      })
      if (built.disposed) {
        world.dispose()
        throw abortError()
      }
      built.world = world
      for (const w of world.warnings) console.warn('[stage]', w)
      this.check(built, opts)
      this.attachWorld(built, device)
      this.setDef(built, def, 0)
      progress(P_WORLD)
      await preload
      this.check(built, opts)
      if (opts.actors) await opts.actors(built.stage!)
      this.check(built, opts)
      progress(P_ACTORS)
      await this.warmUp(built, f => progress(P_ACTORS + (1 - P_ACTORS) * f))
      this.check(built, opts)
      await this.firstFrame(built)
      progress(1)
      return built.stage!
    } catch (err) {
      // Nothing is left behind: the screens run their fallback scene (§0B.4) or leave.
      if (!built.disposed) this.release()
      throw err
    }
  }

  /** A reused World: the new stage's camera, time and range cap; the orbit when asked. */
  private async reenter(b: Built, def: StageDef, opts: StageEnterOptions): Promise<Stage> {
    const progress = (f: number) => opts.onProgress?.(Math.max(0, Math.min(1, f)))
    const preload = opts.preload ? Promise.resolve(opts.preload(b.scene, b.library)) : Promise.resolve()
    preload.catch(() => {})
    const from = { alpha: b.camera.alpha, beta: b.camera.beta, radius: b.camera.radius, target: b.camera.target.clone() }
    const turned = def.camera.yaw !== b.def.camera.yaw
    this.setDef(b, def, turned ? (opts.orbitMs ?? 0) : 0, from)
    const orbit = b.orbit ? new Promise<void>(resolve => {
      const o = b.orbit!
      const prev = o.done
      // Frames may not come (a hidden tab): the orbit ends on time anyway. Only this orbit: the timer is cleared when it
      // ends, so a later orbit is never cut short by it (SCR-H2).
      const timer = setTimeout(() => {
        if (b.orbit === o) this.endOrbit(b)
      }, o.ms + 250)
      o.done = () => {
        clearTimeout(timer)
        prev()
        resolve()
      }
    }) : Promise.resolve()
    // The screen's actors as soon as they are loaded, while the camera still turns: each is prepared (prepareActor)
    // during the orbit and shows when it ends.
    await preload
    this.check(b, opts)
    if (opts.actors) await opts.actors(b.stage!)
    this.check(b, opts)
    await orbit
    this.check(b, opts)
    await this.firstFrame(b)
    progress(1)
    return b.stage!
  }

  private check(b: Built, opts: StageEnterOptions): void {
    if (b.disposed || opts.signal?.aborted) throw abortError()
  }

  // ---- the scene --------------------------------------------------------------------------------------------------

  private buildScene(kind: string, worldName: string, def: StageDef): OwnedScene & { built: Built } {
    const scene = newScene(this.app.engine, new Color4(0.62, 0.74, 0.88, 1))
    // Only the screens' own picks (the slots' cylinders) are used: no per-move pick over the whole world (§0B.2).
    scene.skipPointerMovePicking = true
    // The characters' lights, as the world screen makes them (WorldGraphics takes them; off on PBR).
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
    hemi.intensity = 0.7
    hemi.groundColor = new Color3(0.3, 0.28, 0.24)
    const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5).normalize(), scene)
    sun.intensity = 1.2
    const camera = new ArcRotateCamera('stageCam', -Math.PI / 2, 1.2, 4, new Vector3(def.spot.x, def.spot.yHint + 1, def.spot.z), scene, false)
    camera.minZ = 0.1
    camera.maxZ = 2000
    camera.fov = (def.camera.fovDeg * Math.PI) / 180
    // No active camera until the world is attached: the app's loop renders nothing before the first world.update
    // (§4.3: the PBR post stack attaches there), and nothing compiles for a half-loaded, unlit scene.
    // The key light exists before any actor compiles (§4.4).
    const key = new StageKeyLight(scene)
    const library = new ModelLibrary(scene)
    const built: Built = {
      kind, worldName, scene, camera, hemi, sun, library, key,
      time: new StageTime(),
      world: null, graphics: null, nightLights: null, weather: null,
      weatherBuf: {} as WeatherFrame,
      stage: null,
      def,
      spot: { x: def.spot.x, z: def.spot.z },
      ground: def.spot.yHint,
      zoom: 0,
      enteredAt: this.now(),
      orbit: null,
      warming: null,
      warmed: false,
      lastLife: undefined,
      lastOcean: undefined,
      lastTown: undefined,
      lastClockOn: true,
      area: false,
      actors: new Map(),
      kept: new Set(),
      preps: new Map(),
      prepObs: null,
      observers: [],
      lastFrameAt: -1,
      disposed: false,
    }
    built.stage = new StageImpl(this, built)
    // P-STALL: the glTF loader's light-cap raise happens before each material's first compile, not at a later load.
    built.observers.push(keepLightCap(scene))
    return { kind, scene, built, dispose: () => this.teardown(built) }
  }

  /** The loaded world's links: graphics, night lights, the frame loop, the settings listener, the ambience. */
  private attachWorld(b: Built, device: DeviceHint): void {
    const world = b.world!
    world.isolateLights([b.hemi, b.sun])
    const graphics = new WorldGraphics({
      world,
      camera: b.camera,
      lights: { hemi: b.hemi, sun: b.sun },
      gpu: device,
      engine: this.app.engine,
      store: this.store,
      // Wave 11: the townsfolk behind the stage walk on the shared server clock, like the world's.
      townClock: () => this.serverNow() / 1000,
    })
    b.graphics = graphics
    b.observers.push(b.library.addMaterialDecorator(mat => graphics.decorate(mat)))
    // After WorldGraphics' own listener (registered first): put back what its apply resets.
    b.observers.push(this.store.onChange((s, prev) => {
      if (JSON.stringify(s.graphics) !== JSON.stringify(prev.graphics)) this.afterApply(b)
    }))
    void world.objectsReady.then(() => {
      if (b.disposed) return
      graphics.apply()
      this.afterApply(b)
    })
    if (this.deps.nightLights !== false) {
      try {
        b.nightLights = attachNightLights(world, { ...(this.deps.nightLights ?? {}), focus: () => b.camera.target })
      } catch (err) {
        console.warn('[stage] night lights failed', err)
      }
    }
    const obs: Observer<Scene> = b.scene.onBeforeRenderObservable.add(() => this.frame(b))
    b.observers.push(() => b.scene.onBeforeRenderObservable.remove(obs))
    this.placeCamera(b, 0)
    b.scene.activeCamera = b.camera
    // The title theme goes on (a no-op while it plays); the town's ambience under it (§0B.5).
    this.app.music?.play(this.app.art?.musicUrl(STAGE_MUSIC))
    if (this.app.audio) {
      this.app.audio.setArea(STAGE_AREA)
      b.area = true
    }
    this.afterApply(b)
  }

  /** What WorldGraphics.apply resets, back to the stage's (after every graphics change and the late objects apply). */
  private afterApply(b: Built): void {
    const world = b.world
    const g = b.graphics
    if (b.disposed || !world || !g) return
    world.stream?.setSettings({ ...STAGE_STREAM })
    this.applyRangeCap(b)
    b.key.setPath(world.render.mode === 'pbr')
    world.setWeatherLevel(g.effective.weather)
    if (g.effective.clock !== b.lastClockOn) {
      b.lastClockOn = g.effective.clock
      this.applyTime(b)
    }
    if (!g.effective.weatherShown) world.setWeather(CLEAR_FRAME)
    this.syncParts(b)
  }

  /** Create's draw-range cap (§0B.9): min(the preset's, the stage's cap) while it is up; the preset's otherwise. */
  private applyRangeCap(b: Built): void {
    const world = b.world
    if (!world) return
    const preset = qualityFor(this.store.get(), world.quality).drawDistance
    const cap = b.def.rangeScaleCap
    world.objects.setRangeScale(cap !== undefined ? Math.min(preset, cap) : preset)
  }

  /** The wildlife without ground flocks (D25) and the ocean's visibility (D27), for each part the world (re)builds. */
  private syncParts(b: Built): void {
    const world = b.world
    if (!world) return
    if (world.life !== b.lastLife) {
      b.lastLife = world.life
      world.life?.configure({ groundFlocks: false })
    }
    if (world.ocean !== b.lastOcean) {
      b.lastOcean = world.ocean
      world.ocean?.setVisible?.(this.deps.oceanVisible ?? STAGE_OCEAN_VISIBLE)
    }
    // Wave 11 (D17): the townsfolk keep off the steps where the characters stand.
    const town = worldTown(world)
    if (town !== b.lastTown) {
      b.lastTown = town
      town?.configure?.({ noFolk: { x: b.spot.x, z: b.spot.z, r: STAGE_NO_FOLK_M } })
    }
  }

  /** A new stage def on the loaded world: range cap, time policy (the hold ends here), weather, the camera. */
  private setDef(b: Built, def: StageDef, orbitMs: number, from?: { alpha: number; beta: number; radius: number; target: Vector3 }): void {
    b.def = def
    b.spot = { x: def.spot.x, z: def.spot.z }
    b.ground = b.world?.heightAt(def.spot.x, def.spot.z, def.spot.yHint + 1) ?? def.spot.yHint
    b.zoom = 0
    b.enteredAt = this.now()
    this.applyRangeCap(b)
    this.applyTime(b)
    const server = this.app.session?.server
    if (def.weather === 'server' && server?.weather) {
      const now = this.serverNow()
      b.weather ??= new WeatherClient(null, now)
      b.weather.enter(server.weather, now)
    } else b.weather = null
    this.endOrbit(b)
    if (orbitMs > 0 && from) b.orbit = { from, t0: this.now(), ms: orbitMs, done: () => {} }
    else this.placeCamera(b, 0)
  }

  private serverNow(): number {
    const s = this.app.session
    return s ? s.clock.serverNow() : Date.now()
  }

  private applyTime(b: Built): void {
    const world = b.world
    if (!world) return
    const clockOn = b.graphics?.effective.clock ?? effectiveGraphics(this.store.get(), { gpu: this.device }).clock
    b.lastClockOn = clockOn
    b.time.enter(world, b.def.time, this.app.session?.server?.clock ?? null, () => this.serverNow(), clockOn)
  }

  // ---- the camera -------------------------------------------------------------------------------------------------

  /** The stage's camera pose now (drift in m; `zoom` 0..1). */
  pose(b: Built, zoom: number, driftM: number): CameraPose {
    const engine = this.app.engine
    return stagePose(b.def, { spot: b.spot, ground: b.ground, width: engine.getRenderWidth(), height: engine.getRenderHeight(), zoom, driftM })
  }

  /** Puts the camera on the stage's pose (the select idle drift on top). */
  placeCamera(b: Built, driftM: number): void {
    const p = this.pose(b, b.zoom, driftM)
    const a = arcPose(p.position, p.target)
    const cam = b.camera
    cam.target.set(p.target.x, p.target.y, p.target.z)
    cam.alpha = a.alpha
    cam.beta = a.beta
    cam.radius = a.radius
    cam.fov = p.fovRad
  }

  private endOrbit(b: Built): void {
    const o = b.orbit
    if (!o) return
    b.orbit = null
    if (!b.disposed) this.placeCamera(b, 0)
    o.done()
  }

  /** One orbit frame: alpha turns the short way (π: counter-clockwise), the rest blends; eased in and out. */
  private orbitFrame(b: Built): void {
    const o = b.orbit!
    const f = Math.min(1, (this.now() - o.t0) / o.ms)
    if (f >= 1) return this.endOrbit(b)
    const e = easeInOut(f)
    const to = this.pose(b, b.zoom, 0)
    const a = arcPose(to.position, to.target)
    let da = a.alpha - o.from.alpha
    while (da > Math.PI + 1e-6) da -= 2 * Math.PI
    while (da < -Math.PI - 1e-6) da += 2 * Math.PI
    const cam = b.camera
    cam.alpha = o.from.alpha + da * e
    cam.beta = o.from.beta + (a.beta - o.from.beta) * e
    cam.radius = o.from.radius + (a.radius - o.from.radius) * e
    cam.target.set(
      o.from.target.x + (to.target.x - o.from.target.x) * e,
      o.from.target.y + (to.target.y - o.from.target.y) * e,
      o.from.target.z + (to.target.z - o.from.target.z) * e,
    )
    cam.fov = to.fovRad
  }

  // ---- per frame --------------------------------------------------------------------------------------------------

  private frame(b: Built): void {
    const world = b.world
    if (b.disposed || !world) return
    const now = this.now()
    const ms = b.lastFrameAt < 0 ? 16 : now - b.lastFrameAt
    b.lastFrameAt = now
    // The warm-up turns the camera itself (its two views); nothing moves it meanwhile.
    if (!b.warming) {
      if (b.orbit) this.orbitFrame(b)
      else {
        const t = (now - b.enteredAt) / 1000
        const drift = b.def.id === 'select' ? STAGE_DRIFT.amplitudeM * Math.sin((2 * Math.PI * t) / STAGE_DRIFT.periodS) : 0
        this.placeCamera(b, drift)
      }
    }
    b.time.update(world)
    const g = b.graphics
    if (b.weather && g?.effective.weatherShown) {
      const sNow = this.serverNow()
      world.setWeather(stageWeather(b.weather.frame(sNow, ms / 1000), b.weatherBuf))
    }
    world.update(b.camera, b.spot)
    g?.frame(ms, false)
    b.key.update(b.camera, now)
    this.syncParts(b)
    const audio = this.app.audio
    if (audio) {
      const c = b.camera
      audio.setListener({ x: b.spot.x, y: b.ground, z: b.spot.z }, { x: c.target.x - c.position.x, y: 0, z: c.target.z - c.position.z })
      audio.tick()
    }
  }

  /** GraphicsWarmup behind the loading picture, once per World: shaders, then the select and create headings. */
  private async warmUp(b: Built, onProgress: (f: number) => void): Promise<WarmupResult | null> {
    if (b.warmed || this.deps.warmup === false) {
      b.warmed = true
      return null
    }
    const world = b.world!
    const run = new GraphicsWarmup(
      {
        scene: b.scene,
        engine: this.app.engine,
        camera: b.camera,
        stream: world.stream ?? null,
        focus: () => b.spot,
        // HL-1: the ocean's coast field sets the terrain's wet band (a terrain-wide recompile): waited for, as in the world.
        parts: (world.ocean as { loaded?: Promise<unknown> } | null)?.loaded ?? null,
      },
      {
        ...(this.app.engineKind === 'WebGPU' ? { viewSteps: STAGE_WARMUP_VIEWS } : { viewSteps: STAGE_WARMUP_VIEWS_GL, maxMs: STAGE_WARMUP_MAX_MS_GL }),
        ...(this.deps.warmup ?? {}),
        onProgress: f => onProgress(f),
      },
    )
    this.placeCamera(b, 0)
    b.warming = run
    try {
      return await run.run()
    } finally {
      if (b.warming === run) b.warming = null
      b.warmed = true
      if (!b.disposed) this.placeCamera(b, 0)
    }
  }

  // ---- actors that appear after the warm-up (P-STALL) ---------------------------------------------------------------

  /**
   * Prepares an actor before it shows: hidden (disabled) while its shaders compile PREPARE_BUDGET_MS a frame
   * (compileMesh), then on WebGPU enabled as a ghost (its draws skipped, its pipelines made in the background) until no
   * pipeline is left to make, and shown once the orbit has ended. PREPARE_MAX_MS shows it whatever is left.
   */
  prepareActor(b: Built, root: TransformNode): void {
    if (this.deps.prepare === false || b.disposed || b.preps.has(root) || !root.isEnabled(false)) return
    root.setEnabled(false)
    const meshes = root.getChildMeshes(false)
    b.preps.set(root, { root, meshes, pending: [...meshes], phase: 'compile', unghost: null, ghostFrames: 0, startedSeen: 0, t0: this.now() })
    b.prepObs ??= b.scene.onAfterRenderObservable.add(() => this.tickPreps(b))
    // A hidden tab renders no frame: the actor shows on time anyway.
    setTimeout(() => {
      const p = b.preps.get(root)
      if (p && p.t0 + PREPARE_MAX_MS <= this.now()) this.endPrep(b, root, true)
    }, PREPARE_MAX_MS + 50)
  }

  /** Ends an actor's preparation: shown (`show`), or left as the screen had it (enabled) when it is being removed. */
  endPrep(b: Built, root: TransformNode, show: boolean): void {
    const p = b.preps.get(root)
    if (!p) return
    b.preps.delete(root)
    p.unghost?.()
    p.unghost = null
    if (!root.isDisposed() && (show || !b.disposed)) root.setEnabled(true)
    if (!b.preps.size && b.prepObs) {
      b.scene.onAfterRenderObservable.remove(b.prepObs)
      b.prepObs = null
    }
  }

  /** Holds one reference to each effect a removed actor's meshes use, until the stage goes (released in teardown). */
  keepEffects(b: Built, root: TransformNode): void {
    const found = new Set<Effect>()
    for (const m of root.getChildMeshes(false)) meshEffects(m, found)
    for (const e of found) {
      if (b.kept.has(e)) continue
      e._refCount++
      b.kept.add(e)
    }
  }

  /** One frame of the preparations, after the render (the budget is shared by every actor being prepared). */
  private tickPreps(b: Built): void {
    if (b.disposed) return
    const t = clock()
    const pipes = this.deps.pipelines === undefined ? PipelineWarm.for(this.app.engine) : this.deps.pipelines
    let asked = false
    const over = () => {
      if (!asked) {
        asked = true
        return false
      }
      return clock() - t > PREPARE_BUDGET_MS
    }
    for (const p of [...b.preps.values()]) {
      if (p.root.isDisposed()) {
        this.endPrep(b, p.root, false)
        continue
      }
      if (this.now() - p.t0 > PREPARE_MAX_MS) {
        this.endPrep(b, p.root, true)
        continue
      }
      if (p.phase === 'compile') {
        // Each mesh in turn while the budget lasts (an unready one compiles meanwhile: in parallel on WebGL2).
        const still: AbstractMesh[] = []
        for (const m of p.pending) {
          if (m.isDisposed()) continue
          if (!compileMesh(m, over)) still.push(m)
        }
        p.pending = still
        if (still.length) continue
        if (!pipes) {
          if (!b.orbit) this.endPrep(b, p.root, true)
          continue
        }
        // WebGPU: drawn as a ghost (nothing shows) so its pipelines are made in the background. Re-added to the
        // renderer so the next shadow refresh puts it in the caster list (it was disabled at the last one).
        p.phase = 'ghost'
        p.unghost = pipes.ghost(p.meshes)
        p.startedSeen = pipes.started
        p.root.setEnabled(true)
        for (const m of b.actors.get(p.root) ?? []) b.world?.render.addCharacter(m)
        continue
      }
      // Ghost: a frame that started no pipeline and none left pending (two frames at least: the shadow refresh).
      p.ghostFrames++
      const quiet = pipes!.started === p.startedSeen && pipes!.pendingCount === 0
      p.startedSeen = pipes!.started
      if (p.ghostFrames >= 2 && quiet && !b.orbit) this.endPrep(b, p.root, true)
    }
  }

  /** Resolves after the stage rendered a frame (or FIRST_FRAME_WAIT_MS: a hidden tab renders none). */
  private firstFrame(b: Built): Promise<void> {
    return new Promise<void>(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        b.scene.onAfterRenderObservable.remove(obs)
        resolve()
      }
      const obs = b.scene.onAfterRenderObservable.addOnce(finish)
      const timer = setTimeout(finish, FIRST_FRAME_WAIT_MS)
    })
  }

  // ---- release ----------------------------------------------------------------------------------------------------

  /** Disposes one stage: graphics link first (the page-global render-scale handler), the ambience, the world, the scene. */
  private teardown(b: Built): void {
    if (b.disposed) return
    b.disposed = true
    if (this.built === b) this.built = null
    b.warming?.cancel()
    b.warming = null
    const orbit = b.orbit
    b.orbit = null
    orbit?.done()
    for (const off of b.observers.splice(0)) {
      try {
        off()
      } catch {
        // a listener that is already gone
      }
    }
    b.graphics?.dispose()
    b.graphics = null
    if (b.area) this.app.audio?.setArea(null)
    b.nightLights?.dispose()
    b.nightLights = null
    for (const root of [...b.actors.keys()]) b.stage?.removeActor(root)
    for (const root of [...b.preps.keys()]) this.endPrep(b, root, false)
    b.key.dispose()
    b.library.dispose()
    b.world?.dispose()
    b.world = null
    b.weather = null
    b.scene.dispose()
    // The removed actors' effects (P-STALL): the stage's references go with it.
    for (const e of b.kept) e.dispose()
    b.kept.clear()
  }
}

/** The page's stage host (app.ts builds it on first use). */
export function createStageHost(app: StageApp, deps: StageHostDeps = {}): StageHost {
  return new StageHostImpl(app, deps)
}
