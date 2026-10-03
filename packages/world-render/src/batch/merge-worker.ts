/**
 * The region merge worker (docs/BATCHING.md §3.1 "Build off the main thread"; docs/WAVE_PLAN6.md §6.1 BT-M): keeps
 * the model geometry the region batch sends it (a copy per model, dropped when the batch says so) and merges a
 * region's groups and its shadow proxy (merge-core.ts), returning the typed arrays transferred. The main thread then
 * only creates the meshes, one budgeted stream job each (region-batch.ts).
 *
 * T12-M (docs/TREES.md §W3.4, §W3.6, WF10, WF15): the models it holds carry TEXCOORD_2 for the new trees (`uvs3`), and a
 * merge also transfers each tree group's `sroTreeW` bytes and, on a preset that casts foliage, the region's cut-out
 * caster arrays (`MergeResult.caster`: LOD1 only, with `sroCull`), so the main thread only uploads them
 * (`mergeTransferables` lists every buffer: none is copied back).
 *
 * Messages: in `MergeRequest`, out `MergeResponse` (merge-core.ts); the first message out is `{ ready: true }`. Nothing
 * from Babylon or the DOM (the worker bundle stays small). region-batch.ts starts it with
 * `new Worker(new URL('./merge-worker.ts', import.meta.url), { type: 'module' })` and falls back to the same handler
 * in-process (`MergeHost`) where no worker can start (Node tests, a worker that failed).
 */
import { MergeHost, mergeTransferables, type MergeRequest } from './merge-core.ts'

interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as WorkerScope
// Only when loaded as a worker (a plain import, e.g. a test, has no onmessage to take).
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  const host = new MergeHost()
  scope.onmessage = e => {
    const answer = host.handle(e.data as MergeRequest)
    if (!answer) return
    scope.postMessage(answer, 't' in answer && answer.t === 'merged' ? mergeTransferables(answer.result) : [])
  }
  scope.postMessage({ ready: true })
}
