import { spawn } from 'node:child_process'

/**
 * Child processes of the updater and the supervisor (docs/UPDATES.md): fixed commands and argument lists (no shell,
 * except for pnpm's .cmd shim on Windows with constant arguments), a timeout that kills the whole process tree, and the
 * tail of the output kept for the log. Node-only (no packages): the supervisor runs this file with plain `node`.
 */

export interface RunOptions {
  cwd: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  shell?: boolean
  /** Every output line as it comes (both streams). */
  onLine?: (line: string) => void
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Most bytes of each stream kept. */
const KEEP = 256 * 1024

/** Kills a process and its children (Windows: taskkill /T; elsewhere the process itself, then SIGKILL). */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // already gone
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }, 5000).unref()
  } catch {
    // already gone
  }
}

export function run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let partial = ''
    const lines = (chunk: string) => {
      if (!opts.onLine) return
      partial += chunk
      const parts = partial.split(/\r?\n/)
      partial = parts.pop() ?? ''
      for (const l of parts) if (l.trim()) opts.onLine(l)
    }
    let child
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: opts.shell ?? false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message, timedOut: false })
      return
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killTree(child.pid)
        }, opts.timeoutMs)
      : null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout = (stdout + d).slice(-KEEP)
      lines(d)
    })
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-KEEP)
      lines(d)
    })
    let done = false
    const finish = (code: number | null, err?: Error) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (partial.trim() && opts.onLine) opts.onLine(partial)
      resolve({ code, stdout, stderr: err ? `${stderr}${err.message}` : stderr, timedOut })
    }
    child.on('error', (e) => finish(null, e))
    child.on('close', (code) => finish(code))
  })
}

/** The last `n` non-empty lines of a command's output (for the update log). */
export function tail(r: RunResult, n = 15): string[] {
  return `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n)
}

/**
 * How to run pnpm: through the pnpm that started us (npm_execpath, a .js / .cjs file run by this node) when there is
 * one, else `pnpm` on the PATH (on Windows a .cmd shim, which needs a shell; the arguments are constants).
 */
export function pnpmCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[]; shell: boolean } {
  const exec = env.npm_execpath
  if (exec && /pnpm/i.test(exec) && /\.(c?js|mjs)$/i.test(exec)) return { cmd: process.execPath, args: [exec, ...args], shell: false }
  return { cmd: 'pnpm', args: [...args], shell: process.platform === 'win32' }
}
