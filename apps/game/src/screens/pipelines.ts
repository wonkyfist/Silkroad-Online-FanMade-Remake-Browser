/**
 * WebGPU render pipelines made in the background (lane P-STALL; docs/RENDER.md §11.6). Babylon 9.28 makes a render
 * pipeline the first time a draw needs it, with the synchronous `device.createRenderPipeline`, and Chrome compiles it
 * (WGSL to HLSL to DXIL, then the driver's pipeline state) on the GPU process's main thread. Every later GPU call of
 * the page queues behind that work, so a warm-up that drew 30-odd new pipelines left the GPU process 2-3 s behind:
 * measured on the select stage (WebGPU Medium, dev PC), `onSubmittedWorkDone` took up to 2.9 s after the warm-up's
 * views, and a `writeBuffer` 1.5-2.4 s after the select screen appeared blocked for 0.3-0.97 s (the stall the deploy
 * check saw as 2.3 s on the first login to character select).
 *
 * `PipelineWarm` replaces that with `createRenderPipelineAsync`, which Dawn compiles on its worker threads, in
 * parallel and without holding the GPU process's command stream:
 *
 * - **A session** (`begin`): a draw whose pipeline is not in Babylon's pipeline cache starts its creation in the
 *   background with that draw's exact state (Babylon's own `preWarmPipeline` path: the cache lookup sets the state,
 *   `_buildRenderPipelineDescriptor` builds the descriptor from it) and is skipped. The pipeline is stored in the cache
 *   when it is made, and the same draw finds it on a later frame. Only for frames nobody sees (behind a loading
 *   picture): a skipped draw is missing from that frame.
 * - **Ghost meshes** (`ghost`): their draws are never issued while they are ghosts, their pipelines are still made in
 *   the background. An actor about to appear is drawn this way for a few frames, then shown with every pipeline made.
 *
 * Draws outside a session and not of a ghost go straight to Babylon (one branch per draw). Not WebGPU, a Babylon whose
 * internals differ, or a disabled pipeline cache: `PipelineWarm.for` returns null and everything is as before.
 */
import type { AbstractEngine, AbstractMesh } from '@babylonjs/core'

type Token = object

interface PipelineParam {
  token: Token | undefined
  pipeline: unknown
}

/** The part of Babylon's WebGPUCacheRenderPipeline used here (9.28). */
interface PipelineCache {
  disabled?: boolean
  _parameter: PipelineParam
  _lookupRenderPipeline(fillMode: number, effect: unknown, sampleCount: number, textureState: number): unknown
  _buildRenderPipelineDescriptor(effect: unknown, topology: unknown, sampleCount: number): unknown
  _setRenderPipeline(param: PipelineParam): void
}

interface TextureLike {
  type?: number
  format?: number
}

interface EngineInternals {
  isWebGPU?: boolean
  _draw(drawType: number, fillMode: number, start: number, count: number, instancesCount?: number): void
  applyStates(): void
  _currentEffect: { _pipelineContext?: { shaderProcessingContext?: { textureNames?: readonly string[] } } } | null
  _currentMaterialContext: { hasFloatOrDepthTextures?: boolean; textures?: Record<string, { texture?: TextureLike | null } | undefined> } | null
  _caps: { textureFloatLinearFiltering?: boolean }
  _cacheRenderPipeline?: PipelineCache & { constructor: { _GetTopology?(fillMode: number): unknown } }
  _device?: { createRenderPipelineAsync?(descriptor: unknown): Promise<unknown> }
  _snapshotRendering?: { play?: boolean; record?: boolean }
  readonly currentSampleCount: number
}

type MeshDraw = (subMesh: unknown, fillMode: number, instancesCount?: number) => unknown

const engines = new WeakMap<AbstractEngine, PipelineWarm | null>()

/** Babylon's texture state bits of the current draw (webgpuEngine.pure.js `_draw`, 9.28): float or depth textures. */
function textureStateOf(e: EngineInternals): number {
  const ctx = e._currentMaterialContext
  if (!ctx?.hasFloatOrDepthTextures) return 0
  const names = e._currentEffect?._pipelineContext?.shaderProcessingContext?.textureNames ?? []
  let state = 0
  let bit = 1
  for (const name of names) {
    const t = ctx.textures?.[name]?.texture
    const depth = !!t && t.format !== undefined && t.format >= 13 && t.format <= 18
    if ((t?.type === 1 && !e._caps.textureFloatLinearFiltering) || depth) state |= bit
    bit <<= 1
  }
  return state
}

export class PipelineWarm {
  /** Pipelines being made, by their cache node. */
  private readonly pending = new Map<Token, Promise<void>>()
  /** Cache nodes whose background creation failed: Babylon makes them at their draw (and reports the error). */
  private readonly failedTokens = new WeakSet<Token>()
  private sessions = 0
  private ghostDepth = 0
  /** Background creations started, made, failed; draws skipped for a missing pipeline (counters for the warm-up). */
  started = 0
  made = 0
  failed = 0
  skipped = 0

  /** The engine's PipelineWarm (one per engine; null when the engine is not WebGPU or its internals differ). */
  static for(engine: AbstractEngine): PipelineWarm | null {
    if (engines.has(engine)) return engines.get(engine) ?? null
    const e = engine as unknown as EngineInternals
    const cache = e._cacheRenderPipeline
    const ok = !!e.isWebGPU && typeof e._draw === 'function' && typeof e.applyStates === 'function' && !!cache
      && typeof cache._lookupRenderPipeline === 'function' && typeof cache._buildRenderPipelineDescriptor === 'function'
      && typeof cache._setRenderPipeline === 'function' && typeof cache.constructor?._GetTopology === 'function'
      && typeof e._device?.createRenderPipelineAsync === 'function'
    const w = ok ? new PipelineWarm(e) : null
    engines.set(engine, w)
    return w
  }

  private constructor(private readonly e: EngineInternals) {
    const draw = e._draw
    const self = this
    e._draw = function (this: EngineInternals, drawType: number, fillMode: number, start: number, count: number, instancesCount?: number) {
      if (self.sessions === 0 && self.ghostDepth === 0) return draw.call(this, drawType, fillMode, start, count, instancesCount)
      const snap = this._snapshotRendering
      if (snap?.play || snap?.record) return draw.call(this, drawType, fillMode, start, count, instancesCount)
      const state = self.prepare(this, fillMode)
      if (self.ghostDepth > 0) return
      if (state === 'cached') return draw.call(this, drawType, fillMode, start, count, instancesCount)
      self.skipped++
    }
  }

  /** Pipelines started and not made yet. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** A session is open. */
  get active(): boolean {
    return this.sessions > 0
  }

  /** Opens a session (see the file comment); the returned function ends it (once). */
  begin(): () => void {
    this.sessions++
    let open = true
    return () => {
      if (!open) return
      open = false
      this.sessions--
    }
  }

  /** Resolves when every pipeline started so far is made (or failed). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()])
  }

  /**
   * Makes these meshes ghosts (see the file comment) until the returned function runs (once). Their draws are skipped
   * whatever the cache holds; a missing pipeline is started in the background.
   */
  ghost(meshes: readonly AbstractMesh[]): () => void {
    const undo: Array<() => void> = []
    for (const m of meshes) {
      const target = m as unknown as { _draw?: MeshDraw }
      const draw = target._draw
      if (typeof draw !== 'function') continue
      const own = Object.prototype.hasOwnProperty.call(target, '_draw')
      const self = this
      target._draw = function (this: unknown, subMesh: unknown, fillMode: number, instancesCount?: number) {
        self.ghostDepth++
        try {
          return draw.call(this, subMesh, fillMode, instancesCount)
        } finally {
          self.ghostDepth--
        }
      }
      undo.push(() => {
        if (own) target._draw = draw
        else delete target._draw
      })
    }
    let done = false
    return () => {
      if (done) return
      done = true
      for (const u of undo) u()
    }
  }

  /** The draw's pipeline: in the cache ('cached'), or being made now ('pending'; started here when it was not). */
  private prepare(e: EngineInternals, fillMode: number): 'cached' | 'pending' {
    const cache = e._cacheRenderPipeline!
    const effect = e._currentEffect
    if (cache.disabled || !effect) return 'cached'
    e.applyStates()
    const textureState = textureStateOf(e)
    const sampleCount = e.currentSampleCount > 1 ? 4 : 1
    if (cache._lookupRenderPipeline(fillMode, effect, sampleCount, textureState)) return 'cached'
    const token = cache._parameter.token
    if (!token || this.failedTokens.has(token)) return 'cached'
    if (this.pending.has(token)) return 'pending'
    let descriptor: unknown
    try {
      descriptor = cache._buildRenderPipelineDescriptor(effect, cache.constructor._GetTopology!(fillMode), sampleCount)
    } catch {
      // Babylon draws it itself (and reports whatever is wrong with it, as it would have).
      return 'cached'
    }
    const param: PipelineParam = { token, pipeline: null }
    this.started++
    const job = e._device!.createRenderPipelineAsync!(descriptor).then(
      pipeline => {
        param.pipeline = pipeline
        cache._setRenderPipeline(param)
        this.made++
      },
      (err: unknown) => {
        this.failed++
        this.failedTokens.add(token)
        if (this.failed <= 3) console.warn('[pipelines] background pipeline failed; it is made at its first draw', err)
      },
    ).finally(() => this.pending.delete(token))
    this.pending.set(token, job)
    return 'pending'
  }
}
