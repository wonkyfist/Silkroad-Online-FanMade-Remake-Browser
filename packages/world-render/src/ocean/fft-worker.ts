/**
 * The ocean's worker (docs/COAST.md §8.4): the spectrum (spectrum.ts) and the FFT tile (fft-core.ts) off the main
 * thread. Messages in:
 * - `{ type: 'setup', cascades }`: the tile's cascades (one size);
 * - `{ type: 'params', params }`: a spectrum rebuild (new h0, the same hashed Gaussians; the foam carries on);
 * - `{ type: 'tick', id, t, knobs, mips }`: evaluate at t (s, mod 3,600), answer `{ type: 'frame', id, t, levels,
 *   disp }` with the RGBA16F layers of every mip level (packFrame's layout for one set) and the float displacement
 *   (the CPU query's source), all transferred;
 * - `{ type: 'h0', id, cascades, params }`: the GPU FFT's initial amplitudes (answer `{ type: 'h0', id, h0, omega,
 *   hs }`, transferred).
 * The first message out is `{ ready: true }`. Nothing from Babylon (the worker bundle stays small).
 */
import { WaveTile, mipCount, packFrame, type TileParams } from './fft-core.ts'
import { buildH0, type Cascade, type SpectrumParams } from './spectrum.ts'

export type OceanWorkerIn =
  | { type: 'setup'; cascades: Cascade[] }
  | { type: 'params'; params: SpectrumParams }
  | { type: 'tick'; id: number; t: number; knobs: TileParams; mips: boolean; levels?: boolean }
  | { type: 'h0'; id: number; cascades: Cascade[]; params: SpectrumParams }

export type OceanWorkerOut =
  | { type: 'frame'; id: number; t: number; levels: Uint16Array[]; disp: Float32Array[]; hs: number }
  | { type: 'h0'; id: number; h0: Float32Array[]; omega: Float32Array[]; hs: number }
  | { type: 'error'; id: number; error: string }

/** The worker's state machine (also run on the main thread when no worker is available). */
export class OceanTileJob {
  private tile: WaveTile | null = null
  private cascades: Cascade[] = []
  private params: SpectrumParams | null = null
  private dirty = true
  private hs = 0

  handle(msg: OceanWorkerIn): { out: OceanWorkerOut; transfer: ArrayBuffer[] } | null {
    if (msg.type === 'setup') {
      this.cascades = msg.cascades
      this.tile = new WaveTile(msg.cascades)
      this.dirty = true
      return null
    }
    if (msg.type === 'params') {
      this.params = msg.params
      this.dirty = true
      return null
    }
    if (msg.type === 'h0') {
      const b = buildH0(msg.cascades, msg.params)
      const h0 = b.cascades.map(c => c.h0)
      const omega = b.cascades.map(c => c.omega)
      return { out: { type: 'h0', id: msg.id, h0, omega, hs: b.hs }, transfer: [...h0, ...omega].map(a => a.buffer as ArrayBuffer) }
    }
    const tile = this.tile
    if (!tile || !this.params) return { out: { type: 'error', id: msg.id, error: 'the tile is not set up' }, transfer: [] }
    if (this.dirty) {
      const b = buildH0(this.cascades, this.params)
      tile.setH0(b.cascades)
      this.hs = b.hs
      this.dirty = false
    }
    tile.params = msg.knobs
    const frame = tile.evaluate(msg.t)
    const n = tile.size
    const layers = frame.disp.length * 2
    // `levels: false`: a query-only tile (the GPU FFT draws), the displacement alone.
    const count = msg.levels === false ? 0 : msg.mips ? mipCount(n) : 1
    const levels: Uint16Array[] = []
    for (let m = 0, s = n; m < count; m++, s >>= 1) levels.push(new Uint16Array(s * s * 4 * layers))
    if (count) packFrame(frame, n, levels, 0)
    // The float displacement for the CPU queries (copied: the tile reuses nothing, but keep the frame private).
    const disp = frame.disp.map(d => d.slice())
    return {
      out: { type: 'frame', id: msg.id, t: msg.t, levels, disp, hs: this.hs },
      transfer: [...levels.map(l => l.buffer as ArrayBuffer), ...disp.map(d => d.buffer as ArrayBuffer)],
    }
  }
}

interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as WorkerScope
// Only when loaded as a worker (a plain import, e.g. a test, has no onmessage to take).
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  const job = new OceanTileJob()
  scope.onmessage = e => {
    const msg = e.data as OceanWorkerIn
    try {
      const r = job.handle(msg)
      if (r) scope.postMessage(r.out, r.transfer)
    } catch (err) {
      scope.postMessage({ type: 'error', id: 'id' in msg ? msg.id : -1, error: err instanceof Error ? err.message : String(err) })
    }
  }
  scope.postMessage({ ready: true })
}
