/**
 * TP-P worker pool (docs/TEXPIPE.md §7.2: "PBR 4–5 min on 6 workers" for the whole inventory): runs `PbrJob`s over
 * `size` worker_threads, one job per worker at a time, in the given order (run.ts sorts the largest first, so the
 * workers finish together). A job that throws becomes a result with `error` (the batch goes on); a worker that dies
 * is replaced and its job reported as failed. `size` 0 runs the jobs in-process, one after another (tests, debugging).
 */
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { runJob, type PbrJob, type PbrJobResult } from './job.ts'

/** Default pool size: the cores minus one for the main thread, at most 6 (TEXPIPE's measured plan). */
export function defaultWorkers(): number {
  return Math.max(1, Math.min(6, availableParallelism() - 1))
}

interface Reply {
  id: number
  result?: PbrJobResult
  error?: string
}

export async function runPool(jobs: readonly PbrJob[], size = defaultWorkers(), onResult?: (r: PbrJobResult, done: number, total: number) => void): Promise<PbrJobResult[]> {
  const results: PbrJobResult[] = new Array(jobs.length)
  let done = 0
  const finish = (i: number, r: PbrJobResult) => {
    results[i] = r
    done++
    onResult?.(r, done, jobs.length)
  }
  const failed = (job: PbrJob, error: string): PbrJobResult => ({ key: job.key, outDir: job.outDir, inputKind: job.inputKind, skipped: false, ms: 0, error })
  if (size <= 0) {
    for (let i = 0; i < jobs.length; i++) {
      try {
        finish(i, await runJob(jobs[i]!))
      } catch (e) {
        finish(i, failed(jobs[i]!, (e as Error).message))
      }
    }
    return results
  }
  const queue = jobs.map((_, i) => i)
  const url = new URL('./worker.ts', import.meta.url)
  await new Promise<void>(resolve => {
    let live = 0
    const spawn = () => {
      if (!queue.length) {
        if (live === 0) resolve()
        return
      }
      live++
      const worker = new Worker(url)
      let current = -1
      const next = () => {
        const i = queue.shift()
        if (i === undefined) {
          current = -1
          live--
          void worker.terminate()
          if (live === 0) resolve()
          return
        }
        current = i
        worker.postMessage({ id: i, job: jobs[i]! })
      }
      worker.on('message', (m: Reply) => {
        finish(m.id, m.result ?? failed(jobs[m.id]!, m.error ?? 'no result'))
        next()
      })
      worker.on('error', e => {
        if (current >= 0) finish(current, failed(jobs[current]!, `worker died: ${e.message}`))
        current = -1
        live--
        spawn()
      })
      next()
    }
    for (let k = 0; k < Math.min(size, jobs.length); k++) spawn()
    if (!jobs.length) resolve()
  })
  return results
}
