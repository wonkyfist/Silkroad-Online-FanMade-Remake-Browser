/**
 * Graphics warm-up behind a loading overlay (PERF2, docs/RENDER.md §11.6): on world entry and after a graphics switch
 * that rebuilds the renderer (the Modern toggle, a preset or an Advanced option that changes the render blocks), the
 * world used to stream its regions again and compile its shaders while the player played on at 4–30 fps for 10–26 s.
 * The screen now covers that with its loading picture and drives it to the end:
 *
 * 1. `stream`: the region streamer runs with its boot budget (RegionStreamer.booting) until the regions within
 *    NEAR_RADIUS_M of the player are in (terrain and objects; the rest streams in during play, as when walking);
 * 2. `shaders`: every enabled, visible mesh is asked `isReady(true)` (its material on the current path, its shadow
 *    depth effect): on WebGL2 the programs compile in parallel (KHR_parallel_shader_compile), on WebGPU the shader
 *    modules are made, for the meshes out of view as well (Babylon's own warm-up: Material.forceCompilation). A new
 *    effect costs 5-40 ms of Babylon's shader processing on the main thread, so the meshes are asked `shaderBudgetMs`
 *    (28 ms) at a time per frame (P-STALL: all 115 at once made 0.34 s frames on WebGPU and 0.7-0.9 s on WebGL2). The
 *    weather's meshes (rain, curtain, splashes, drips, the bolt) are asked too although they are off while it is dry:
 *    they exist from the weather level on, and the first rain after a dry entry must not compile them in play (W9F R1);
 *    so are the wave-10 parts' meshes, hidden with `isVisible` while they have nothing to draw (the ocean with no sea
 *    node in the fog cut, the wildlife at count 0: the fireflies by day, the butterflies away from a meadow; the grass
 *    field tiers with no cell), asked with their thin-instanced variant, the one they draw (HL-2); the `stream` stage
 *    also waits for the parts' data (`parts`: the ocean's coast field, its mesh is made on the next frame);
 *    so are world-render's warm-up hooks (warmupHooksState: the shelter map's height material, drawn only in rain; the
 *    town's crowd, whose drawables may still be loading: the stage waits for them, H11-HI-1);
 * 3. `views`: the camera turns once around (VIEW_STEPS headings, a few frames each) so every material in range is drawn
 *    once: WebGPU makes its render pipelines at the first draw, and a first draw on WebGL2 finishes the driver's work.
 *    On WebGPU the whole run is a PipelineWarm session (screens/pipelines.ts): a draw whose pipeline is missing has it
 *    made in the background (Dawn's worker threads, in parallel) and is skipped; the turn runs twice, the second time
 *    holding each heading until its pipelines are made, so nothing is left for the GPU process to compile once the
 *    picture goes;
 * 4. `settle`: until a few frames in a row compile nothing and come on time (CALM_FRAME_MS), every effect started is
 *    ready, and the GPU queue has caught up (gpuQueueProbe answers within DRAIN_OK_MS: WebGPU's submitted-work
 *    promise, WebGL2's fence). The GPU
 *    process may still be compiling what the page gave it earlier, and the first frame after the picture went then
 *    waited for it (P-STALL: 0.3-0.97 s on WebGPU, up to 1.8 s on WebGL2 High).
 *
 * It never waits longer than `maxMs` (the overlay goes, whatever is left finishes in play, as before). The frames go
 * on rendering behind the overlay, so everything above is the game's own work, only done while nobody plays.
 */
import type { AbstractEngine, AbstractMesh, Mesh, Observer, Scene } from '@babylonjs/core'
import { isWeatherMesh, warmupHooksState } from '@sro/world-render'
import { PipelineWarm } from './pipelines.ts'

export type WarmupStage = 'stream' | 'shaders' | 'views' | 'settle' | 'done'

/** The streamer's part (RegionStreamer: busy, the boot budget flag, its region counts). */
export interface WarmupStream {
  readonly busy: boolean
  booting: boolean
  readonly stats: { readonly wanted: number; readonly ready: number; readonly objectsReady: number }
  /** RegionStreamer.whenReady / progress: the regions (terrain and objects) within `radiusM` of a point. */
  whenReady?(x: number, z: number, radiusM: number): Promise<void>
  progress?(x: number, z: number, radiusM: number): { done: number; total: number }
}

export interface WarmupHost {
  scene: Scene
  engine: AbstractEngine
  /** The camera the views turn (its heading, `alpha`, is restored). */
  camera: { alpha: number }
  stream: WarmupStream | null
  /**
   * Where the player is (glTF metres): `stream` waits for the regions within NEAR_RADIUS_M of it (the rest streams in
   * during play, as when walking). Without it, or without whenReady, until the streamer is idle.
   */
  focus?: () => { x: number; z: number } | null
  /**
   * The parts' data `stream` also waits for (the ocean's coast field, SroOcean.loaded: the ocean makes its mesh on the
   * frame after, so `shaders` finds it). A rejection counts as done.
   */
  parts?: Promise<unknown> | null
}

/** The warm-up waits for the regions this close to the player (the entry's loading screen radius, READY_RADIUS_M). */
export const NEAR_RADIUS_M = 200

export interface WarmupOptions {
  /** Give up after this long (ms). */
  maxMs?: number
  /** Headings the camera takes in `views`. */
  viewSteps?: number
  /** Frames held on each heading. */
  framesPerView?: number
  /** Frames in a row without a compile that end `settle`. */
  quietFrames?: number
  /**
   * `shaders` moves on when no mesh became ready for this long (ms): one that never will is not waited for. A warm-up
   * hook still loading its data (warmupHooksState 'loading': the town's drawables) holds the stage up to `maxMs`.
   */
  stallMs?: number
  /** Main-thread time per frame for asking meshes in `shaders` (ms; at least one mesh a frame). */
  shaderBudgetMs?: number
  /** WebGPU pipelines made in the background (default: the engine's PipelineWarm; null: none, as on WebGL2). */
  pipelines?: PipelineWarm | null
  /** The GPU queue probe for `settle` (default: WebGPU's onSubmittedWorkDone; null: none, as on WebGL2). */
  gpuQueue?: (() => Promise<unknown>) | null
  now?: () => number
  onProgress?: (fraction: number, stage: WarmupStage) => void
}

export interface WarmupResult {
  ms: number
  /** Why it ended: every stage done, the time cap, or cancelled (the screen went away). */
  ended: 'done' | 'timeout' | 'cancelled'
  /** Time spent per stage (ms). */
  stages: Partial<Record<WarmupStage, number>>
  /** Meshes checked in `shaders`, and those ready at the end. */
  meshes: number
  ready: number
  /** Shader compiles seen while it ran. */
  compiles: number
  /** WebGPU render pipelines made in the background (0 on WebGL2). */
  pipelines: number
}

export const WARMUP_DEFAULTS = { maxMs: 20_000, viewSteps: 4, framesPerView: 3, quietFrames: 6, stallMs: 4000, shaderBudgetMs: 28 }

/** `settle` ends when the GPU queue probe answers within this long (ms; or 3 frames on a slower machine): caught up. */
export const DRAIN_OK_MS = 40

/**
 * A quiet frame in `settle` also came this soon after the one before (ms): a GPU process still compiling holds the
 * page's GL or GPU calls, so its frames come late (WebGL2 High: a 1.8 s frame right after the picture went, P-STALL).
 */
export const CALM_FRAME_MS = 50

/** `settle` stops waiting for unready effects when none became ready for this long (ms; a shader that never will). */
export const EFFECTS_STALL_MS = 3000

/** Effects of the engine's cache not ready yet (non-blocking on WebGL2: parallel compile's completion query). */
export function unreadyEffects(engine: AbstractEngine): number {
  const cache = (engine as unknown as { _compiledEffects?: Record<string, { isReady(): boolean }> })._compiledEffects
  let n = 0
  for (const key in cache ?? {}) {
    try {
      if (!cache![key]!.isReady()) n++
    } catch {
      // an effect that cannot answer is not waited for
    }
  }
  return n
}

/**
 * The engine's GPU queue probe, resolving when the GPU process has done everything the page gave it so far: WebGPU's
 * `queue.onSubmittedWorkDone`; on WebGL2 a fence (`fenceSync`), polled without blocking (a sync object's status only
 * changes between tasks); null without either (NullEngine). Measured on WebGL2 High (P-STALL): the fence took up to
 * 2.3 s while ANGLE linked the warm-up's programs, and the frames looked calm meanwhile.
 */
export function gpuQueueProbe(engine: AbstractEngine): (() => Promise<unknown>) | null {
  const e = engine as unknown as { isWebGPU?: boolean; _device?: { queue?: { onSubmittedWorkDone?(): Promise<unknown> } }; _gl?: WebGL2RenderingContext | null }
  if (e.isWebGPU) {
    const queue = e._device?.queue
    return typeof queue?.onSubmittedWorkDone === 'function' ? () => queue.onSubmittedWorkDone!() : null
  }
  const gl = e._gl
  if (!gl || typeof gl.fenceSync !== 'function' || typeof gl.getSyncParameter !== 'function') return null
  return () => new Promise<void>(resolve => {
    const sync = gl.isContextLost() ? null : gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!sync) return resolve()
    gl.flush()
    const poll = () => {
      if (gl.isContextLost() || gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
        if (!gl.isContextLost()) gl.deleteSync(sync)
        resolve()
      } else setTimeout(poll, 4)
    }
    setTimeout(poll, 4)
  })
}

/**
 * A wave-10 part's mesh (HL-2): the ocean (`sroWorld: 'ocean'`), the wildlife (`'life'`) and the grass field tiers
 * (`grassLod`). Each is drawn thin-instanced only and hidden with `isVisible` (never disabled) while it has nothing to
 * draw, so the warm-up asks it whatever it shows, with instancing forced (the ocean's thin-instance count is 0 then).
 */
export function isPartMesh(mesh: { metadata?: unknown } | null | undefined): boolean {
  const md = mesh?.metadata as { sroWorld?: unknown; grassLod?: unknown } | null | undefined
  return md?.sroWorld === 'ocean' || md?.sroWorld === 'life' || md?.grassLod !== undefined
}

/**
 * Meshes the warm-up asks: enabled, visible, drawable (not templates, pools or out-of-range clones); the weather's
 * own meshes whether or not they show now (they are built disabled and turned on by the rain; W9F R1); the enabled
 * wave-10 part meshes whether or not they show now (isPartMesh; HL-2).
 */
export function warmupMeshes(scene: Scene): AbstractMesh[] {
  const out: AbstractMesh[] = []
  for (const m of scene.meshes) {
    if (!m.subMeshes?.length || m.getTotalVertices() === 0) continue
    if (!isWeatherMesh(m) && !(isPartMesh(m) && m.isEnabled()) && (!m.isEnabled() || !m.isVisible)) continue
    out.push(m)
  }
  return out
}

/** Asks one mesh to get ready for its draw (a part mesh in its thin-instanced variant, the one it draws). */
export function meshReady(m: AbstractMesh): boolean {
  return isPartMesh(m) ? (m as Mesh).isReady(true, true) : m.isReady(true)
}

/** Runs the warm-up (see the file comment); resolves when it ends. One at a time per host (cancel the old one first). */
export class GraphicsWarmup {
  private cancelled = false
  /** Ends the run in progress now (set while one runs). */
  private stop: (() => void) | null = null

  constructor(
    private readonly host: WarmupHost,
    private readonly o: WarmupOptions = {},
  ) {}

  /** Ends it now (camera heading and streamer budget restored); run() resolves with `ended: 'cancelled'`. */
  cancel(): void {
    this.cancelled = true
    this.stop?.()
  }

  run(): Promise<WarmupResult> {
    const { scene, engine, camera, stream } = this.host
    const now = this.o.now ?? (() => performance.now())
    const maxMs = this.o.maxMs ?? WARMUP_DEFAULTS.maxMs
    const viewSteps = Math.max(0, this.o.viewSteps ?? WARMUP_DEFAULTS.viewSteps)
    const framesPerView = Math.max(1, this.o.framesPerView ?? WARMUP_DEFAULTS.framesPerView)
    const quietFrames = Math.max(1, this.o.quietFrames ?? WARMUP_DEFAULTS.quietFrames)
    const stallMs = this.o.stallMs ?? WARMUP_DEFAULTS.stallMs
    const shaderBudgetMs = this.o.shaderBudgetMs ?? WARMUP_DEFAULTS.shaderBudgetMs
    // Real time for the per-frame budgets (`now` may be a test clock that only moves between frames).
    const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now())
    const pipes = this.o.pipelines === undefined ? PipelineWarm.for(engine) : this.o.pipelines
    const queueProbe = this.o.gpuQueue === undefined ? gpuQueueProbe(engine) : this.o.gpuQueue
    const started0 = pipes?.started ?? 0
    let skippedSeen = pipes?.skipped ?? 0
    let probe: { at: number; ms: number; done: boolean } | null = null
    let lastUnready = -1
    let unreadyAt = 0
    /** The last frames' intervals (ms; settle's calm test). */
    const gaps: number[] = []
    let frameAt = -1
    let frameMs = 16
    const t0 = now()
    let stage: WarmupStage = 'stream'
    let stageAt = t0
    const stages: WarmupResult['stages'] = {}
    let compiles = 0
    let compiledThisFrame = false
    let meshes = 0
    let ready = 0
    let pending: AbstractMesh[] = []
    let hooksLoading = false
    let readyAt = t0
    let view = 0
    let viewFrame = 0
    /** WebGPU: the views run twice, the second pass waiting for the pipelines the first started. */
    let viewPass = 0
    let quiet = 0
    const alpha0 = camera.alpha
    const booting0 = stream?.booting ?? false
    if (stream) stream.booting = true
    // The regions near the player (when the host says where it is), else the whole queue.
    const focus = this.host.focus?.() ?? null
    let near: { x: number; z: number; done: boolean } | null = null
    if (stream?.whenReady && focus) {
      const n = { x: focus.x, z: focus.z, done: false }
      near = n
      void stream.whenReady(focus.x, focus.z, NEAR_RADIUS_M).then(() => (n.done = true))
    }
    const parts = { done: !this.host.parts }
    if (this.host.parts) {
      void this.host.parts.then(
        () => (parts.done = true),
        () => (parts.done = true),
      )
    }
    const progress = (f: number) => this.o.onProgress?.(Math.max(0, Math.min(1, f)), stage)
    const next = (s: WarmupStage) => {
      const t = now()
      stages[stage] = (stages[stage] ?? 0) + (t - stageAt)
      stage = s
      stageAt = t
    }
    return new Promise<WarmupResult>(resolve => {
      let compileObs: Observer<AbstractEngine> | null = null
      let frameObs: Observer<Scene> | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      // WebGPU: the whole run makes missing pipelines in the background (screens/pipelines.ts).
      let endPipes: (() => void) | null = null
      const finish = (ended: WarmupResult['ended']) => {
        if (stage === 'done') return
        next('done')
        this.stop = null
        endPipes?.()
        if (compileObs) engine.onAfterShaderCompilationObservable.remove(compileObs)
        if (frameObs) scene.onAfterRenderObservable.remove(frameObs)
        if (timer !== null) clearTimeout(timer)
        camera.alpha = alpha0
        if (stream) stream.booting = booting0
        resolve({ ms: now() - t0, ended, stages, meshes, ready, compiles, pipelines: pipes ? pipes.started - started0 : 0 })
      }
      if (this.cancelled) return finish('cancelled')
      endPipes = pipes?.begin() ?? null
      this.stop = () => finish('cancelled')
      compileObs = engine.onAfterShaderCompilationObservable.add(() => {
        compiles++
        compiledThisFrame = true
      })
      // The frames drive the stages; the timer ends it even when no frame comes (a hidden tab).
      timer = setTimeout(() => finish(this.cancelled ? 'cancelled' : 'timeout'), maxMs)
      const step = () => {
        if (this.cancelled) return finish('cancelled')
        if (now() - t0 >= maxMs) return finish('timeout')
        const compiled = compiledThisFrame
        compiledThisFrame = false
        const at = clock()
        const gap = frameAt >= 0 ? at - frameAt : 0
        if (frameAt >= 0) {
          frameMs = 0.8 * frameMs + 0.2 * Math.min(1000, gap)
          gaps.push(gap)
          if (gaps.length > 15) gaps.shift()
        }
        frameAt = at
        // Draws skipped in the frame just rendered for a pipeline being made (WebGPU).
        const skipped = pipes ? pipes.skipped - skippedSeen : 0
        if (pipes) skippedSeen = pipes.skipped
        switch (stage) {
          case 'stream': {
            if (near && !near.done) {
              const p = stream?.progress?.(near.x, near.z, NEAR_RADIUS_M)
              progress(p && p.total > 0 ? (0.6 * p.done) / p.total : 0)
              return
            }
            if (!near && stream?.busy) {
              const s = stream.stats
              progress(s.wanted > 0 ? (0.5 * (s.ready + s.objectsReady)) / s.wanted * 0.6 : 0)
              return
            }
            if (!parts.done) {
              progress(0.6)
              return
            }
            next('shaders')
            pending = warmupMeshes(scene)
            meshes = pending.length
            readyAt = now()
            break
          }
          case 'shaders': {
            // The pending meshes are asked in order for shaderBudgetMs a frame (at least one): an unready one starts
            // compiling (on WebGL2 in parallel, and later asks only poll it); the rest wait for the next frame.
            const still: AbstractMesh[] = []
            let i = 0
            for (; i < pending.length; i++) {
              if (i > 0 && clock() - at > shaderBudgetMs) break
              const m = pending[i]!
              if (m.isDisposed()) continue
              let ok = false
              try {
                ok = meshReady(m)
              } catch {
                ok = true // a mesh that cannot answer is not waited for
              }
              if (!ok) still.push(m)
            }
            for (; i < pending.length; i++) if (!pending[i]!.isDisposed()) still.push(pending[i]!)
            if (still.length < pending.length) readyAt = now()
            pending = still
            ready = meshes - pending.length
            const hooks = warmupHooksState(scene)
            progress(0.6 + 0.25 * (meshes ? ready / meshes : 1))
            // H11-HI-1: a hook still loading its data (the town's drawables on a slow link) holds the stage, up to maxMs;
            // the stall (counted from when it is in) only gives up on shaders that never get ready.
            if (hooks === 'loading') {
              hooksLoading = true
              break
            }
            if (hooksLoading) {
              hooksLoading = false
              readyAt = now()
            }
            if ((!pending.length && hooks === 'ready') || now() - readyAt > stallMs) next(viewSteps > 0 ? 'views' : 'settle')
            break
          }
          case 'views': {
            // WebGPU, second pass: each heading again, held while a draw was skipped or a pipeline is still being made
            // (the first pass started them all, in parallel).
            if (viewPass === 1 && (skipped > 0 || pipes!.pendingCount > 0)) {
              viewFrame = 0
              break
            }
            if (++viewFrame < framesPerView) break
            viewFrame = 0
            view++
            if (view >= viewSteps) {
              view = 0
              camera.alpha = alpha0
              if (pipes && viewPass === 0) viewPass = 1
              else next('settle')
            } else camera.alpha = alpha0 + (view * 2 * Math.PI) / viewSteps
            progress(0.85 + 0.1 * ((viewPass * viewSteps + view) / Math.max(1, (pipes ? 2 : 1) * viewSteps)))
            break
          }
          case 'settle': {
            // The pipelines' session ends once none is left to make: from here every draw is drawn.
            if (endPipes) {
              if (pipes && pipes.pendingCount > 0) break
              endPipes()
              endPipes = null
            }
            // Quiet: no compile and the frame came on time (the GPU process is not holding the page's calls): within
            // CALM_FRAME_MS, or twice the recent median on a machine whose frames are slower than that.
            const sorted = [...gaps].sort((a, b) => a - b)
            const median = sorted.length ? sorted[sorted.length >> 1]! : 0
            quiet = compiled || gap > Math.max(CALM_FRAME_MS, 2 * median) ? 0 : quiet + 1
            progress(0.95 + 0.05 * (Math.min(quiet, quietFrames) / quietFrames))
            if (quiet < quietFrames) break
            // Every compile started has finished (WebGL2: programs linking in parallel draw late, or block the frame
            // that first uses them), unless none became ready for EFFECTS_STALL_MS.
            const unready = unreadyEffects(engine)
            if (unready !== lastUnready) {
              lastUnready = unready
              unreadyAt = clock()
            }
            if (unready > 0 && clock() - unreadyAt < EFFECTS_STALL_MS) break
            if (!queueProbe) return finish('done')
            // Until the GPU queue answers a probe about as fast as a frame (the GPU process's backlog is gone).
            if (!probe) {
              const p = { at: clock(), ms: Infinity, done: false }
              probe = p
              void queueProbe().then(
                () => {
                  p.ms = clock() - p.at
                  p.done = true
                },
                () => {
                  p.ms = 0
                  p.done = true
                },
              )
              break
            }
            if (!probe.done) break
            if (probe.ms <= Math.max(DRAIN_OK_MS, 3 * frameMs)) return finish('done')
            probe = null
            break
          }
          default:
            break
        }
      }
      frameObs = scene.onAfterRenderObservable.add(step)
    })
  }
}
