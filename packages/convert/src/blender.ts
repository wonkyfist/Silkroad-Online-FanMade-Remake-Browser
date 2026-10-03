/**
 * Headless Blender for the converter (docs/WAVE_PLAN6.md D19): the coast's Blender round trip (docs/COAST.md §6, lane
 * CST-B: `pnpm sro coast-export` / `coast-import`) and the movement clips (docs/MOVEMENT.md §2.2, lane MV-A:
 * `pnpm sro moves`) share this helper and the one sro.config.json key `blenderExe`.
 *
 * Every path handed to Blender must be absolute (docs/COAST.md §6.6 finding 1: Blender 5.2 wrote a relative render
 * path at the drive root). runBlender refuses a relative script, .blend or path-like argument before it spawns
 * anything. An argument that only looks like a path (it has a separator or a file extension) but is a plain value can be
 * passed as `{ value }`.
 *
 * Python exceptions fail the run (`--python-exit-code 1`). Node only.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT, type SroConfig } from './node-io.ts'

/** The Blender 5.2 default install per platform (docs/MOVEMENT.md §2.2: "the default: the 5.2 install"). */
export function defaultBlenderExe(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe'
  if (platform === 'darwin') return '/Applications/Blender.app/Contents/MacOS/Blender'
  return 'blender'
}

/**
 * An absolute path Blender cannot misread: a drive path (`C:\…`, `C:/…`) or a UNC path (`\\server\…`) on Windows, `/…`
 * elsewhere. Never Blender's `//` (relative to the .blend), and never a Windows drive-relative `\…`.
 */
export function isAbsolutePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return /^[a-z]:[\\/]/i.test(p) || /^\\\\[^\\/]/.test(p)
  return p.startsWith('/') && !p.startsWith('//')
}

/** True when an argument reads as a file path: it has a separator, or ends in a file extension. */
export function looksLikePath(arg: string): boolean {
  return /[\\/]/.test(arg) || /\.[a-z][a-z0-9]{0,5}$/i.test(arg)
}

/**
 * The executable: sro.config.json `blenderExe`, else defaultBlenderExe(). A bare command name ('blender') is kept for
 * a PATH lookup; a relative path with a separator is taken relative to the repo root.
 */
export function blenderPath(cfg?: Pick<SroConfig, 'blenderExe'>, platform: NodeJS.Platform = process.platform): string {
  const exe = cfg?.blenderExe?.trim() || defaultBlenderExe(platform)
  if (!/[\\/]/.test(exe) || isAbsolutePath(exe, platform)) return exe
  return resolve(REPO_ROOT, exe)
}

/** A Blender argument after `--`: a string (checked when it looks like a path) or `{ value }` (never checked). */
export type BlenderArg = string | { value: string }

export interface BlenderRun {
  /** The Python script (absolute). */
  script: string
  /** Script arguments, after `--`. Path-like ones must be absolute. */
  args?: readonly BlenderArg[]
  /** A .blend to open first (absolute). */
  blend?: string
  /** --background (default true); false opens the Blender window (e.g. CST-B's `--watch`). */
  background?: boolean
  /** --factory-startup: no user preferences or add-ons (default true). */
  factoryStartup?: boolean
  /** The working directory (absolute; default the repo root), so a stray relative path lands in the repo, not at C:\. */
  cwd?: string
  /** Kill after this many ms (default: none). */
  timeoutMs?: number
  /** Each output line as it arrives. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Reject when the exit code is not 0 (default true). */
  check?: boolean
}

export interface BlenderResult {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/** The relative paths among a run's script, .blend, cwd and path-like arguments (empty = the run may start). */
export function relativePaths(run: BlenderRun, platform: NodeJS.Platform = process.platform): string[] {
  const bad: string[] = []
  const check = (what: string, p: string | undefined) => {
    if (p !== undefined && !isAbsolutePath(p, platform)) bad.push(`${what} ${JSON.stringify(p)}`)
  }
  check('script', run.script)
  check('blend', run.blend)
  check('cwd', run.cwd)
  for (const a of run.args ?? []) {
    if (typeof a !== 'string') continue
    // --flag=value: the value is what Blender's script would open
    const v = /^--?[\w-]+=/.test(a) ? a.slice(a.indexOf('=') + 1) : a
    if (/^--?[a-z]/i.test(v) && !v.includes('=')) continue
    if (looksLikePath(v) && !isAbsolutePath(v, platform)) bad.push(`argument ${JSON.stringify(a)}`)
  }
  return bad
}

/** The command line for a run (after the checks): `[--background] [--factory-startup] [blend] … -P script -- args`. */
export function blenderArgs(run: BlenderRun, platform: NodeJS.Platform = process.platform): string[] {
  const bad = relativePaths(run, platform)
  if (bad.length) throw new Error(`runBlender: every path handed to Blender must be absolute (docs/COAST.md §6.6): ${bad.join(', ')}`)
  return [
    ...(run.background !== false ? ['--background'] : []),
    ...(run.factoryStartup !== false ? ['--factory-startup'] : []),
    ...(run.blend !== undefined ? [run.blend] : []),
    '--python-exit-code', '1',
    '--python', run.script,
    '--',
    ...(run.args ?? []).map(a => (typeof a === 'string' ? a : a.value)),
  ]
}

/** Runs a Blender Python script (headless by default). Refuses relative paths before spawning anything. */
export function runBlender(cfg: Pick<SroConfig, 'blenderExe'> | undefined, run: BlenderRun): Promise<BlenderResult> {
  let args: string[]
  try {
    args = blenderArgs(run)
  } catch (e) {
    return Promise.reject(e)
  }
  const exe = blenderPath(cfg)
  if (isAbsolutePath(exe) && !existsSync(exe)) {
    return Promise.reject(new Error(`runBlender: Blender not found at ${exe}; set blenderExe in sro.config.json`))
  }
  const t0 = performance.now()
  return new Promise((resolvePromise, reject) => {
    const p = spawn(exe, args, { cwd: run.cwd ?? REPO_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = { stdout: '', stderr: '' }
    const pending = { stdout: '', stderr: '' }
    const feed = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
      const text = String(d)
      out[stream] += text
      if (!run.onLine) return
      const lines = (pending[stream] + text).split(/\r?\n/)
      pending[stream] = lines.pop()!
      for (const line of lines) run.onLine(line, stream)
    }
    p.stdout.on('data', feed('stdout'))
    p.stderr.on('data', feed('stderr'))
    const timer = run.timeoutMs ? setTimeout(() => p.kill(), run.timeoutMs) : undefined
    p.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', code => {
      clearTimeout(timer)
      if (run.onLine) for (const s of ['stdout', 'stderr'] as const) if (pending[s]) run.onLine(pending[s], s)
      const result = { code, ...out, ms: performance.now() - t0 }
      if (run.check !== false && code !== 0) {
        const tail = (out.stderr.trim() || out.stdout.trim()).split(/\r?\n/).slice(-12).join('\n')
        reject(Object.assign(new Error(`Blender exited with ${code} running ${run.script}:\n${tail}`), { result }))
      } else resolvePromise(result)
    })
  })
}

/** The Blender version line ('Blender 5.2.2 LTS'), or null when the executable does not run. */
export function blenderVersion(cfg?: Pick<SroConfig, 'blenderExe'>): string | null {
  const exe = blenderPath(cfg)
  if (isAbsolutePath(exe) && !existsSync(exe)) return null
  try {
    const r = spawnSync(exe, ['--background', '--factory-startup', '--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    if (r.status !== 0) return null
    return /^Blender \S+.*$/m.exec(r.stdout ?? '')?.[0].trim() ?? null
  } catch {
    return null
  }
}
