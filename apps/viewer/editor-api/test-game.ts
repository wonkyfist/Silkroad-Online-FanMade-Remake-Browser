/**
 * "Test in game" (docs/WORLD_EDITOR.md §2.4, D6; lane WE-A): the real game on the staging export a Publish made,
 * on this PC only, without touching the dev servers (:5180, :7000, :5173):
 *
 * - a private game server on a free port with a temporary copy of `work/server/game.db` (the copy keeps every
 *   account's role, so the user's GM account is GM there too; the editor never types a password) and
 *   WORLD_EXPORT=<world>-edit (the staging export, a WORLD_FOLDER name);
 * - a private game Vite on another free port (./test-game-vite.ts: its own dependency cache), whose /api and /ws
 *   reach that server (SRO_SERVER).
 *
 * Stop: the editor's "Stop test" button, the editor tab closing (its lease lapses), the editor stopping, or after
 * two hours; both processes end and the copy is deleted. Node only.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { TestGameState } from './protocol.ts'

export const TEST_GAME_MAX_MS = 2 * 60 * 60_000

export interface TestGameOptions {
  repoRoot: string
  workRoot: string
  world: string
  /** Starts a process (tests replace it). */
  spawnProc?: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  /** A free TCP port on 127.0.0.1 (tests replace it). */
  freePort?: () => Promise<number>
  /** True once the URL answers (tests replace it). */
  probe?: (url: string) => Promise<boolean>
  /** How long to wait for each process (default 120 s). */
  readyMs?: number
}

/** A free port: listen on 0, read it, close. */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => (port ? res(port) : rej(new Error('no free port'))))
    })
  })
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return r.status < 500
  } catch {
    return false
  }
}

const rmRetry = (dir: string) => {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
    }
  }
}

/** The server's environment: its own port, data folder and export; the private game's origin allowed. */
export function serverEnv(base: NodeJS.ProcessEnv, o: { port: number; dataDir: string; world: string; gamePort: number }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const k of ['WORLD_EXPORT', 'DATA_DIR', 'PORT', 'HOST', 'ALLOWED_ORIGINS', 'CORS_ORIGIN', 'NODE_ENV', 'SERVE_STATIC']) delete env[k]
  return {
    ...env,
    PORT: String(o.port),
    HOST: '127.0.0.1',
    DATA_DIR: o.dataDir,
    WORLD_EXPORT: `${o.world}-edit`,
    ALLOWED_ORIGINS: `http://127.0.0.1:${o.gamePort},http://localhost:${o.gamePort}`,
  }
}

export class TestGame {
  private st: TestGameState = { phase: 'off', sentence: 'Test in game is off.' }
  private procs: ChildProcess[] = []
  private dir: string
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: TestGameOptions) {
    this.dir = join(opts.workRoot, 'editor', opts.world, 'test-game')
  }

  state(): TestGameState {
    return { ...this.st }
  }

  get active(): boolean {
    return this.st.phase === 'starting' || this.st.phase === 'running'
  }

  /** Starts both processes on the staging export; refuses without one. */
  async start(at?: { x: number; z: number }): Promise<TestGameState> {
    if (this.active) return this.state()
    const staging = join(this.opts.workRoot, 'out', 'world', `${this.opts.world}-edit`, 'manifest.json')
    if (!existsSync(staging)) {
      this.st = { phase: 'off', sentence: 'Publish first: Test in game plays the map Publish builds (before you keep it).' }
      return this.state()
    }
    const since = new Date().toISOString()
    this.st = { phase: 'starting', sentence: 'Starting a private game server and game on this PC...', since, world: `${this.opts.world}-edit`, ...(at ? { at } : {}) }
    try {
      rmRetry(this.dir)
      const dataDir = join(this.dir, 'data')
      mkdirSync(dataDir, { recursive: true })
      const src = join(this.opts.repoRoot, 'work', 'server')
      for (const f of ['game.db', 'game.db-wal', 'world-clock.json']) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dataDir, f))
      const pick = this.opts.freePort ?? freePort
      const serverPort = await pick()
      let gamePort = await pick()
      while (gamePort === serverPort) gamePort = await pick()
      const spawnProc = this.opts.spawnProc ?? ((args, o) => spawn(process.execPath, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))
      const log = (name: string) => (b: Buffer) => {
        try {
          appendFileSync(join(this.dir, `${name}.log`), b)
        } catch {
          // gone with the folder
        }
      }
      const server = spawnProc(['--import', 'tsx', 'apps/server/src/main.ts'], {
        cwd: this.opts.repoRoot, env: serverEnv(process.env, { port: serverPort, dataDir, world: this.opts.world, gamePort }),
      })
      const game = spawnProc(['--import', 'tsx', 'apps/viewer/editor-api/test-game-vite.ts', String(gamePort)], {
        cwd: this.opts.repoRoot, env: { ...process.env, SRO_SERVER: `http://127.0.0.1:${serverPort}` },
      })
      this.procs = [server, game]
      for (const [p, name] of [[server, 'server'], [game, 'game']] as const) {
        p.stdout?.on('data', log(name))
        p.stderr?.on('data', log(name))
        p.on('exit', code => {
          if (!this.active) return
          void this.fail(`the private ${name} stopped (exit ${code}); see ${join(this.dir, `${name}.log`)}`)
        })
      }
      this.st = { ...this.st, serverPort, gamePort }
      const probe = this.opts.probe ?? httpOk
      const until = Date.now() + (this.opts.readyMs ?? 120_000)
      const wait = async (url: string, what: string) => {
        while (!(await probe(url))) {
          if (!this.active) throw new Error(this.st.error ?? `${what} stopped`)
          if (Date.now() > until) throw new Error(`${what} did not answer within ${Math.round((this.opts.readyMs ?? 120_000) / 1000)} s`)
          await new Promise(r => setTimeout(r, 500))
        }
      }
      await wait(`http://127.0.0.1:${serverPort}/health`, 'the private server')
      await wait(`http://127.0.0.1:${gamePort}/`, 'the private game')
      if (!this.active) return this.state()
      const url = `http://127.0.0.1:${gamePort}/`
      const where = at ? ` The edit is at x ${Math.round(at.x)}, z ${Math.round(at.z)}.` : ''
      this.st = {
        ...this.st, phase: 'running', url,
        sentence: `The game with your edit runs at ${url} (a private server with a copy of the accounts). Log in as usual.${where} Stop the test when done.`,
      }
      this.timer = setTimeout(() => void this.stop('Test in game stopped after two hours.'), TEST_GAME_MAX_MS)
      this.timer.unref?.()
    } catch (e) {
      await this.fail((e as Error).message)
    }
    return this.state()
  }

  private async fail(msg: string): Promise<void> {
    await this.stop()
    this.st = { phase: 'failed', sentence: `Test in game failed: ${msg}`, error: msg }
  }

  /** Ends both processes and deletes the database copy. */
  async stop(sentence = 'Test in game stopped; the database copy is deleted.'): Promise<TestGameState> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const procs = this.procs
    this.procs = []
    if (procs.length || this.st.phase !== 'off') this.st = { ...this.st, phase: 'stopping', sentence: 'Stopping the test...' }
    await Promise.all(procs.map(p => new Promise<void>(res => {
      if (p.exitCode !== null || p.signalCode !== null) return res()
      const t = setTimeout(res, 5000)
      p.once('exit', () => {
        clearTimeout(t)
        res()
      })
      p.kill()
    })))
    rmRetry(this.dir)
    this.st = { phase: 'off', sentence }
    return this.state()
  }

  /** The newest change's camera target (glTF x, z), for the "where" line. */
  static atOf(views: ReadonlyArray<{ view: number[] }> | undefined): { x: number; z: number } | undefined {
    const v = views?.[0]?.view
    return v && v.length >= 6 ? { x: v[3]!, z: v[5]! } : undefined
  }
}

/** For the API: the private server's log tail (the page shows it when the test fails). */
export function testLogTail(workRoot: string, world: string, name: 'server' | 'game', lines = 20): string[] {
  try {
    return readFileSync(join(workRoot, 'editor', world, 'test-game', `${name}.log`), 'utf8').split('\n').slice(-lines)
  } catch {
    return []
  }
}
