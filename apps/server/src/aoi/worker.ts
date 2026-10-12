/**
 * An AoI job worker thread (docs/SERVER_ARCHITECTURE.md §3.5, phase P1b): runs aoi/kernel.ts on its slice of the
 * viewers of each snapshot the tick thread shares (SharedArrayBuffer), posts the result list on its result port and
 * marks the job done in the control array (Atomics), where the tick thread waits for it. Loaded with Node's own type
 * stripping (no loader): erasable syntax and .ts imports only.
 */
import { parentPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { IntList, buildGrid, buildIndex, runSlice, type AoiLayout, type AoiParams } from './kernel.ts'

interface Job {
  gen: number
  I: SharedArrayBuffer
  F: SharedArrayBuffer
  L: AoiLayout
  p: AoiParams
  from: number
  to: number
}

const { slot, ctl, port } = workerData as { slot: number; ctl: SharedArrayBuffer; port: MessagePort }
const done = new Int32Array(ctl)
const out = new IntList(1 << 14)
const threadCpu = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage

parentPort!.on('message', (job: Job) => {
  const c0 = threadCpu ? threadCpu.call(process) : null
  const t0 = performance.now()
  const I = new Int32Array(job.I, 0, job.L.iLen)
  const F = new Float64Array(job.F, 0, job.L.fLen)
  let res: Int32Array | null = null
  let error: string | null = null
  try {
    const grid = buildGrid(F, job.L, job.p)
    const index = buildIndex(I, job.L, job.p)
    out.n = 0
    runSlice(I, F, job.L, job.p, grid, index, job.from, job.to, out)
    res = out.take()
  } catch (e) {
    error = (e as Error).stack ?? String(e)
  }
  const c1 = threadCpu ? threadCpu.call(process) : null
  const cpuMs = c0 && c1 ? (c1.user - c0.user + c1.system - c0.system) / 1000 : 0
  port.postMessage({ gen: job.gen, res, error, ms: performance.now() - t0, cpuMs }, res ? [res.buffer as ArrayBuffer] : [])
  Atomics.store(done, slot, job.gen)
  Atomics.notify(done, slot)
})
