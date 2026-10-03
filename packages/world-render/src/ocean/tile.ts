/**
 * The worker FFT tile on the main thread (docs/COAST.md §8.4): Medium's waves, and High/Ultra's where there is no
 * compute. The worker (fft-worker.ts) evaluates the tile at fixed ticks (T_k = k / tickHz, 20 Hz); the main thread keeps
 * the two ticks around the render time in one RGBA16F texture array ([set 0: disp c…, deriv c…][set 1: …], set 0 =
 * tick k, set 1 = tick k + 1) and the shader interpolates between them (`sroOcT`). It asks one tick ahead, uploads
 * once per tick (the whole array, every mip level: ≈ 350 KB at 2 × 64²), and holds the last tick if the worker is late
 * (a stalled tab never blocks the main thread). With no node selected it asks for nothing (D27: the worker idles).
 *
 * Mips: on WebGPU the worker computes them and each level is uploaded (`updateMipLevel`), because Babylon's own mip
 * generation for a 2D array fills layer 0 only; on WebGL2 the driver's `generateMipmap` fills every layer when half
 * floats are renderable, else the tile has no mips (bilinear).
 *
 * Without a Worker (Node tests, a blocked worker) the same job runs synchronously on the main thread.
 */
import { Constants, NullEngine, RawTexture, RawTexture2DArray, Texture, type BaseTexture, type Scene } from '@babylonjs/core'
import { DEFAULT_TILE_PARAMS, mipCount, type TileParams } from './fft-core.ts'
import { OceanTileJob, type OceanWorkerIn, type OceanWorkerOut } from './fft-worker.ts'
import type { Cascade, SpectrumParams } from './spectrum.ts'

interface Tick {
  k: number
  levels: Uint16Array[]
  disp: Float32Array[]
  hs: number
}

/** A worker, or the same job on this thread. */
interface Channel {
  post(msg: OceanWorkerIn, transfer?: ArrayBuffer[]): void
  dispose(): void
}

export interface TileStats {
  /** Ticks received, uploads done, ticks the render had to hold (the worker was late). */
  ticks: number
  uploads: number
  held: number
  /** Last worker tick time (ms, measured in the worker's answer turnaround). */
  lastTurnaroundMs: number
  worker: boolean
}

/** Tick requests in flight at most (k, k + 1, k + 2). */
const MAX_IN_FLIGHT = 3
/** The furthest a request is asked ahead of the render tick (ticks). */
const MAX_LEAD = 20
/** A request unanswered this long is given up (ms). */
const LOST_MS = 5000

export class WorkerTile {
  /** The wave array (a plain stand-in texture on NullEngine, which has no 2D arrays: tests upload nothing). */
  readonly texture: BaseTexture
  private readonly array: RawTexture2DArray | null
  readonly n: number
  readonly layersPerSet: number
  readonly mips: boolean
  private readonly workerMips: boolean
  private readonly staging: Uint16Array[]
  private readonly ticks = new Map<number, Tick>()
  private readonly asked = new Map<number, number>()
  private channel: Channel
  private nextId = 1
  private shown = -1
  private paramsSent: SpectrumParams | null = null
  private knobs: TileParams | null = null
  private lastTick: Tick | null = null
  private disposed = false
  /** Whether the ticks go to the texture array (false: the GPU FFT draws; this tile only feeds the CPU query). */
  private readonly textures: boolean
  readonly stats: TileStats = { ticks: 0, uploads: 0, held: 0, lastTurnaroundMs: 0, worker: false }
  /** tick lerp (0..1) and the layer bases of the previous and next tick (the shader's sroOcT.x..z). */
  lerp = 0
  prevBase = 0
  nextBase = 0

  constructor(
    readonly scene: Scene,
    readonly cascades: readonly Cascade[],
    readonly tickHz: number,
    opts: { worker?: boolean; textures?: boolean } = {},
  ) {
    this.textures = opts.textures ?? true
    this.n = cascades[0]!.size
    this.layersPerSet = cascades.length * 2
    const engine = scene.getEngine()
    const webgpu = !!engine.isWebGPU
    this.workerMips = webgpu
    this.mips = webgpu || !!engine.getCaps().textureHalfFloatRender
    // A query-only tile (RP-5: the GPU FFT draws) stages, packs and allocates no texture levels.
    const levels = !this.textures ? 0 : this.workerMips ? mipCount(this.n) : 1
    this.staging = []
    for (let m = 0, s = this.n; m < levels; m++, s >>= 1) this.staging.push(new Uint16Array(s * s * 4 * this.layersPerSet * 2))
    if (engine instanceof NullEngine || !this.textures) {
      this.array = null
      this.texture = new RawTexture(new Uint8Array(4), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false)
    } else {
      this.array = new RawTexture2DArray(
        this.staging[0]!, this.n, this.n, this.layersPerSet * 2, Constants.TEXTUREFORMAT_RGBA, scene, this.mips, false,
        this.mips ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT,
      )
      this.texture = this.array
    }
    this.texture.name = 'sroOcWaves'
    this.texture.wrapU = Texture.WRAP_ADDRESSMODE
    this.texture.wrapV = Texture.WRAP_ADDRESSMODE
    this.texture.anisotropicFilteringLevel = 4
    const internal = this.array?.getInternalTexture()
    if (internal && this.workerMips) {
      // The GPU texture and its view hold every level; the levels come from the worker from now on (Babylon's own
      // generation would fill layer 0 only), and the sampler keeps using them.
      internal.generateMipMaps = false
      internal.useMipMaps = true
    }
    this.channel = this.openChannel(opts.worker ?? true)
    this.channel.post({ type: 'setup', cascades: this.cascades.map(c => ({ ...c })) })
  }

  /** New spectrum parameters (a rebuild: the worker makes a new h0 before its next tick). */
  setParams(p: SpectrumParams): void {
    if (p === this.paramsSent) return
    this.paramsSent = p
    this.channel.post({ type: 'params', params: p })
  }

  /** The tick knobs (choppiness, whitecap bias, gains) sent with the next requests. */
  setKnobs(k: TileParams): void {
    // In place (per frame): a tick message is structured-cloned (worker) or read at once (local job).
    const o = (this.knobs ??= { choppiness: 0, foamBias: 0, gains: [] })
    o.choppiness = k.choppiness
    o.foamBias = k.foamBias
    const g = o.gains as number[]
    g.length = k.gains.length
    for (let i = 0; i < g.length; i++) g[i] = k.gains[i]!
  }

  /** The newest tick's float displacement per cascade (the CPU query's source), and its Hs. */
  get latest(): { disp: Float32Array[]; hs: number } | null {
    return this.lastTick ? { disp: this.lastTick.disp, hs: this.lastTick.hs } : null
  }

  /** Whether the array holds a tick yet. */
  get ready(): boolean {
    return this.shown >= 0
  }

  /**
   * Per frame at ocean time `time` (s, not wrapped): asks for the ticks it needs (when `active`), uploads when the
   * render time crossed a tick, and sets `lerp` / `prevBase` / `nextBase`.
   */
  update(time: number, active: boolean): void {
    if (this.disposed || !this.paramsSent) return
    const k = Math.floor(time * this.tickHz)
    this.renderK = k
    if (active) {
      // RP-4: at most MAX_IN_FLIGHT requests in flight, asked far enough ahead that their answers are still due when
      // they arrive (a worker slower than tickHz then shows every tick it manages instead of freezing on stale ones).
      if (this.pending.size >= MAX_IN_FLIGHT) {
        // A request lost for good (never answered) must not block the tile.
        const old = now() - LOST_MS
        for (const [id, p] of this.pending) if (p.at < old) this.pending.delete(id)
      }
      // (+ 1: an answer is first seen by the update after it lands.)
      const lead = Math.min(MAX_LEAD, this.lagTicks ? this.lagTicks + 1 : 0)
      for (let want = k + lead; want <= k + lead + 2 && this.pending.size < MAX_IN_FLIGHT; want++) this.ask(want)
    }
    // Drop ticks the render has passed.
    for (const key of this.ticks.keys()) if (key < k - 1) this.ticks.delete(key)
    for (const key of this.asked.keys()) if (key < k - 1) this.asked.delete(key)
    const prev = this.ticks.get(k) ?? null
    const next = this.ticks.get(k + 1) ?? null
    if (prev && next) {
      if (this.shown !== k) {
        this.upload(prev, next)
        this.shown = k
      }
      this.lerp = Math.min(1, Math.max(0, time * this.tickHz - k))
    } else if (prev && this.shown !== k) {
      // Its successor is late: show this tick still (a slow worker's own rate).
      this.upload(prev, prev)
      this.shown = k
      this.lerp = 0
    } else if (this.shown >= 0) {
      // Late: hold what is shown (no jump; the waves pause for a moment).
      this.stats.held++
      this.lerp = this.shown === k ? Math.min(1, Math.max(0, time * this.tickHz - k)) : 1
    } else if (prev || this.lastTick) {
      // The very first tick: show it still until its successor arrives.
      const t = prev ?? this.lastTick!
      this.upload(t, t)
      this.shown = t.k
      this.lerp = 0
    }
    this.prevBase = 0
    this.nextBase = this.layersPerSet
  }

  dispose(): void {
    this.disposed = true
    this.channel.dispose()
    this.texture.dispose()
    this.ticks.clear()
  }

  private ask(k: number): void {
    if (this.ticks.has(k) || this.asked.has(k)) return
    const id = this.nextId++
    this.asked.set(k, id)
    const t = ((k / this.tickHz) % 3600 + 3600) % 3600
    this.pending.set(id, { k, at: now(), from: this.renderK })
    this.channel.post({ type: 'tick', id, t, knobs: this.knobs ?? DEFAULT_TILE_PARAMS, mips: this.textures && this.workerMips, levels: this.textures })
  }

  private readonly pending = new Map<number, { k: number; at: number; from: number }>()
  /** The render tick of the last update, and how many ticks the last answer took (in render time: the ask lead). */
  private renderK = 0
  private lagTicks = 0

  private receive(msg: OceanWorkerOut): void {
    if (this.disposed) return
    if (msg.type === 'error') {
      if (msg.id >= 0) this.pending.delete(msg.id)
      console.warn('[ocean] tile worker:', msg.error)
      return
    }
    if (msg.type !== 'frame') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    this.stats.ticks++
    this.stats.lastTurnaroundMs = now() - p.at
    this.lagTicks = Math.max(0, this.renderK - p.from)
    const tick: Tick = { k: p.k, levels: msg.levels, disp: msg.disp, hs: msg.hs }
    this.ticks.set(p.k, tick)
    if (!this.lastTick || tick.k >= this.lastTick.k) this.lastTick = tick
  }

  /** Writes tick a into set 0 and b into set 1 of every staged level, then uploads the levels. */
  private upload(a: Tick, b: Tick): void {
    if (!this.textures) return
    for (let m = 0; m < this.staging.length; m++) {
      const dst = this.staging[m]!
      const la = a.levels[m], lb = b.levels[m]
      if (!la || !lb) continue
      dst.set(la, 0)
      dst.set(lb, la.length)
    }
    const arr = this.array
    if (arr && this.workerMips) for (let m = 0; m < this.staging.length; m++) arr.updateMipLevel(this.staging[m]!, m)
    else arr?.update(this.staging[0]!)
    this.stats.uploads++
  }

  private openChannel(wantWorker: boolean): Channel {
    if (wantWorker && typeof Worker !== 'undefined') {
      try {
        const w = new Worker(new URL('./fft-worker.ts', import.meta.url), { type: 'module', name: 'sro-ocean' })
        w.onmessage = (e: MessageEvent) => {
          const m = e.data as OceanWorkerOut | { ready: true }
          if ('ready' in m) return
          this.receive(m)
        }
        w.onerror = (e: ErrorEvent) => {
          e.preventDefault?.()
          console.warn('[ocean] tile worker failed; running the tile on the main thread:', e.message)
          this.fallBack()
        }
        this.stats.worker = true
        return { post: (msg, transfer) => w.postMessage(msg, transfer ?? []), dispose: () => w.terminate() }
      } catch (err) {
        console.warn('[ocean] no tile worker; running the tile on the main thread:', err)
      }
    }
    return this.localChannel()
  }

  /** The job on this thread: answers arrive on the next microtask, like a worker's. */
  private localChannel(): Channel {
    const job = new OceanTileJob()
    let live = true
    this.stats.worker = false
    return {
      post: msg => {
        const r = job.handle(msg)
        if (r) void Promise.resolve().then(() => live && this.receive(r.out))
      },
      dispose: () => {
        live = false
      },
    }
  }

  private fallBack(): void {
    this.channel.dispose()
    this.channel = this.localChannel()
    this.channel.post({ type: 'setup', cascades: this.cascades.map(c => ({ ...c })) })
    if (this.paramsSent) this.channel.post({ type: 'params', params: this.paramsSent })
    this.asked.clear()
    this.pending.clear()
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
