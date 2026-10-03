/**
 * TP-P worker entry (worker_threads): runs one `PbrJob` per message and answers `{ id, result }` or `{ id, error }`.
 * Loaded as a .ts file: under `pnpm tsx` through tsx's loader, under vitest through Node 24's built-in type stripping
 * (every file it imports uses erasable syntax only).
 */
import { parentPort } from 'node:worker_threads'
import { runJob, type PbrJob } from './job.ts'

interface Request {
  id: number
  job: PbrJob
}

parentPort?.on('message', (msg: Request) => {
  runJob(msg.job).then(
    result => parentPort!.postMessage({ id: msg.id, result }),
    (e: unknown) => parentPort!.postMessage({ id: msg.id, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) }),
  )
})
