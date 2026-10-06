import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSION, parseServerMessage, type ApiLoginResponse, type ServerMessage } from '@sro/shared'
import WebSocket from 'ws'
import type { ServerConfig } from '../src/config.ts'
import { startServer, type GameServer } from '../src/game.ts'

export interface TestServer extends GameServer {
  root: string
  stopAndClean(): Promise<void>
}

/** The test servers' configuration (temp DATA_DIR / OUT_DIR / GAME_DIST under root). */
export function testConfig(root: string, logs?: string[]): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: join(root, 'data'),
    outDir: join(root, 'out'),
    gameDist: join(root, 'dist'),
    world: 'jangan',
    moveSpeed: 5.5,
    tickHz: 20,
    spawn: null,
    serveStatic: true,
    corsOrigin: '',
    allowedOrigins: [],
    capacity: 50,
    registerPerHour: 1000,
    saveIntervalS: 30,
    helloTimeoutMs: 5000,
    trustProxy: false,
    levelCap: 20,
    rolePollMs: 50,
    viewRange: 120,
    mobLevelMax: 25,
    spawnMobs: true,
    giantPct: 0,
    // docs/WINTER.md: off in tests, so a run in December still sees the schedule's rain (winter tests turn it on)
    winterEnabled: false,
    log: (m) => logs?.push(m),
  }
}

/** Starts a real server on an ephemeral port with temp DATA_DIR / OUT_DIR / GAME_DIST. */
export async function startTestServer(
  opts: { config?: Partial<ServerConfig>; files?: Record<string, string>; logs?: string[]; /** Runs before the server starts (e.g. to write an old database). */ prepare?: (root: string) => void } = {},
): Promise<TestServer> {
  const root = mkdtempSync(join(tmpdir(), 'sro-server-'))
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  opts.prepare?.(root)
  const config: ServerConfig = { ...testConfig(root, opts.logs), ...opts.config }
  const server = await startServer(config)
  return {
    ...server,
    root,
    async stopAndClean() {
      await server.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function api(base: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

let accountCounter = 0

/** Registers a fresh account and returns its token. */
export async function newAccount(base: string, prefix = 'user'): Promise<{ username: string; token: string }> {
  const username = `${prefix}${++accountCounter}`
  const r = await api(base, '/api/register', { username, password: 'password1' })
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.json)}`)
  return { username, token: (r.json as ApiLoginResponse).token }
}

/** Raw GET with an unnormalized path (fetch would resolve `..` client-side). */
export function rawGet(base: string, path: string): Promise<{ status: number; type: string; body: string }> {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

export class Client {
  readonly queue: ServerMessage[] = []
  /** Every message received, in order (the queue loses what next() takes). */
  readonly log: ServerMessage[] = []
  private waiters: (() => void)[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  isClosed = false

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = parseServerMessage(data.toString())
      if (!parsed.ok) throw new Error(`server sent an invalid frame: ${parsed.error}: ${data.toString()}`)
      this.queue.push(parsed.msg)
      this.log.push(parsed.msg)
      this.wake()
    })
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.isClosed = true
        this.wake()
        resolve({ code, reason: reason.toString() })
      })
    })
  }

  private wake(): void {
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }

  /** `opts`: ws client options, e.g. a loopback `localAddress` (127.0.0.x) so many soak bots are not one IP. */
  static async connect(base: string, opts?: WebSocket.ClientOptions): Promise<Client> {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', opts)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return new Client(ws)
  }

  /** Connects and completes hello; resolves after `welcome`. */
  static async login(base: string, token: string, opts?: WebSocket.ClientOptions): Promise<Client> {
    const c = await Client.connect(base, opts)
    c.send({ t: 'hello', version: PROTOCOL_VERSION, token })
    await c.next('welcome')
    return c
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg))
  }

  /** Waits for (and removes) the first queued message of type `t` that matches `where`. */
  async next<T extends ServerMessage['t']>(t: T, where: (m: Msg<T>) => boolean = () => true, timeoutMs = 3000): Promise<Msg<T>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const i = this.queue.findIndex((m) => m.t === t && where(m as Msg<T>))
      if (i >= 0) return this.queue.splice(i, 1)[0] as Msg<T>
      const left = deadline - Date.now()
      if (left <= 0 || this.isClosed) {
        throw new Error(`timed out waiting for ${t}; queue: ${JSON.stringify(this.queue)}${this.isClosed ? ' (closed)' : ''}`)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** Asserts nothing of type `t` arrives within `ms`. */
  async none(t: ServerMessage['t'], ms = 200): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
    const found = this.queue.find((m) => m.t === t)
    if (found) throw new Error(`unexpected ${t}: ${JSON.stringify(found)}`)
  }

  close(): void {
    this.ws.close()
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
