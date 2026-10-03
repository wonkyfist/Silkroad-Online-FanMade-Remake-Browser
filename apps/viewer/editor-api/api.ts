/**
 * The World Editor's local API (docs/WORLD_EDITOR.md §2.2 D3, D4, §3.4, §3.5; docs/WAVE_PLAN8.md §6.2 lane WE-A): a
 * Connect middleware the editor's Vite server mounts (./plugin.ts). Routes and messages: ./protocol.ts.
 *
 * Every request must carry the session token, a Host of 127.0.0.1:<port> (no DNS rebinding), and, when the browser
 * sends them, an Origin of http://127.0.0.1:<port> and a same-origin Sec-Fetch-Site; a POST must send that Origin and
 * a JSON body. Writes go only under the world's layer folder and its work folder (./atomic.ts WriteScope), and only
 * from the tab holding the lease while this process holds `work/editor/editor.lock`.
 *
 * Step 2 (WE-A): Publish runs in its own process (./runner.ts starts ./publish-cli.ts: the converter never runs inside
 * this server), Test in game starts a private server and game (./test-game.ts), Deploy hands off to the assets-only
 * deploy with its refusals (./deploy.ts). Their writes are their own (the staging exports, work/out* at Keep, git);
 * this process writes only the before / after images under work/editor/.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { WorldEditsContext } from '../../../packages/shared/src/world-edits/validate.ts'
import { PathError, WriteScope, writeFileAtomic } from './atomic.ts'
import { DeployHandOff, type DeployOptions } from './deploy.ts'
import { JournalError } from './journal.ts'
import { LeaseManager, takeEditorLock, takeOverSentence, type EditorLock } from './lock.ts'
import {
  API_PREFIX, DEFAULT_EDITOR_WORLD, EDITOR_HOST, EDITOR_PORT, LEASE_BEAT_MS, LEASE_HEADER, LEASE_TTL_MS, MAX_BODY_BYTES,
  TOKEN_HEADER, pixelsToBytes, type EditorStatus, type PageSaveRequest, type SaveRequest, type SessionInfo,
} from './protocol.ts'
import { renderReportHtml } from './report-html.ts'
import { PublishBusyError, PublishRunner, type PublishRunnerOptions } from './runner.ts'
import { EditorStore, SaveError } from './store.ts'
import { TestGame, type TestGameOptions } from './test-game.ts'
import { TownStore, type TownSaveRequest } from '../src/editor/town/town-store.ts'

export interface EditorApiOptions {
  /** The repository root (content/ lives under it). */
  repoRoot: string
  /** The converter's work folder (sro.config.json workDir; default <repo>/work). */
  workRoot: string
  world?: string
  port?: number
  /** A fixed token (tests); default: 24 random bytes, base64url. */
  token?: string
  /** Overrides for tests: the layer folder, the editor work folder. */
  layerRoot?: string
  editorRoot?: string
  leaseTtlMs?: number
  now?: () => number
  journalCap?: { maxChanges?: number; maxBytes?: number }
  /** Process liveness for the editor lock (tests). */
  alive?: (pid: number) => boolean
  /** How often a read-only editor looks again for a stale lock to take over (tests; default LOCK_REFRESH_MS, 0 never). */
  lockWatchMs?: number
  /** The tabs' lease (the plugin keeps one across Vite's in-process restarts). */
  leases?: LeaseManager
  /** Step 2's process starters and probes (tests replace them; the real ones spawn node). */
  step2?: {
    spawnJob?: PublishRunnerOptions['spawnJob']
    testGame?: Partial<TestGameOptions>
    deploy?: Partial<DeployOptions>
    /** How often the API looks for a closed editor tab to stop Test in game (default 5 s; 0: never). */
    watchMs?: number
  }
}

export interface EditorApi {
  readonly token: string
  readonly world: string
  readonly port: number
  readonly lock: EditorLock
  readonly store: EditorStore
  readonly publish: PublishRunner
  readonly testGame: TestGame
  readonly deploy: DeployHandOff
  /** The page's URL path with the token: `/editor.html?world=<world>&k=<token>`. */
  readonly pagePath: string
  handle(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void
  close(): void
}

const WORLD_NAME = /^[a-z0-9-]{1,64}$/

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Type', type)
  res.end(body instanceof Uint8Array ? body : JSON.stringify(body))
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

function sameSecret(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The request checks (D3), in order: Host, Sec-Fetch-Site, Origin, token. Returns the refusal (status, sentence) or
 * null when the request may proceed.
 */
export function checkRequest(req: IncomingMessage, expect: { host: string; origin: string; token: string }): { status: number; error: string } | null {
  if (header(req, 'host') !== expect.host) return { status: 403, error: `the editor API answers only on ${expect.host}` }
  const site = header(req, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403, error: 'cross-site requests are refused' }
  const origin = header(req, 'origin')
  const reads = req.method === 'GET' || req.method === 'HEAD'
  if (origin !== undefined ? origin !== expect.origin : !reads) return { status: 403, error: `the editor API answers only to ${expect.origin}` }
  if (!sameSecret(header(req, TOKEN_HEADER), expect.token)) {
    return { status: 401, error: 'this editor session has ended or the link is wrong: open the World Editor from its shortcut again' }
  }
  return null
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = header(req, 'content-type') ?? ''
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'expected a JSON body')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new HttpError(413, `the request is larger than ${Math.round(limit / 1048576)} MB`)
    chunks.push(c as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'the body is not valid JSON')
  }
}

const ownerLine = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8').trim() || '(starting)'
  } catch {
    return null
  }
}

export function createEditorApi(opts: EditorApiOptions): EditorApi {
  const world = opts.world ?? DEFAULT_EDITOR_WORLD
  if (!WORLD_NAME.test(world)) throw new Error(`editor: ${JSON.stringify(world)} is not a world folder name (a-z, 0-9, -)`)
  const port = opts.port ?? EDITOR_PORT
  const token = opts.token ?? randomBytes(24).toString('base64url')
  const layerRoot = opts.layerRoot ?? join(opts.repoRoot, 'content', 'world-edits')
  const editorRoot = opts.editorRoot ?? join(opts.workRoot, 'editor')
  const layerDir = join(layerRoot, world)
  const workDir = join(editorRoot, world)
  // D3: this process writes only under content/world-edits/ and work/editor/ (the before / after images included);
  // work/out*/ is written by the publish process (./publish.ts: staging exports, the Keep swap), content/town/ by WE-T.
  const scope = new WriteScope([layerRoot, editorRoot])
  // DL-5: a lock a killed editor left is taken over (now, or later by a read-only editor once that one is gone), and
  // the first tab that opens the session is told so
  let lockNotice: string | null = null
  const lock = takeEditorLock(join(editorRoot, 'editor.lock'), port, opts.alive, {
    ...(opts.lockWatchMs !== undefined ? { watchMs: opts.lockWatchMs } : {}),
    onTakeOver: stale => {
      lockNotice = takeOverSentence(stale)
    },
  })
  if (lock.tookOver) lockNotice = takeOverSentence(lock.tookOver)
  const leases = opts.leases ?? new LeaseManager({ ttlMs: opts.leaseTtlMs ?? LEASE_TTL_MS, now: opts.now })
  const expect = { host: `${EDITOR_HOST}:${port}`, origin: `http://${EDITOR_HOST}:${port}`, token }

  // The export's context for the validators: the world, its origin and regions (re-read when the manifest changes).
  const manifestFile = join(opts.workRoot, 'out', 'world', world, 'manifest.json')
  let ctxCache: { mtime: number; ctx: WorldEditsContext } | null = null
  const context = (): WorldEditsContext => {
    let mtime: number
    try {
      mtime = statSync(manifestFile).mtimeMs
    } catch {
      return { world }
    }
    if (ctxCache?.mtime === mtime) return ctxCache.ctx
    try {
      const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        space?: { originRegion?: { x: number; z: number } }
        regions?: Array<{ x: number; z: number }>
      }
      const regions = new Set((m.regions ?? []).map(r => `${r.x}_${r.z}`))
      const ctx: WorldEditsContext = { world, exported: (x, z) => regions.has(`${x}_${z}`) }
      if (m.space?.originRegion) ctx.originRegion = { x: m.space.originRegion.x, z: m.space.originRegion.z }
      ctxCache = { mtime, ctx }
      return ctx
    } catch {
      return { world }
    }
  }

  const store = new EditorStore({ world, layerDir, workDir, scope, context, journalCap: opts.journalCap })

  // step 2: Publish (its own process), Test in game, Deploy
  const step2 = opts.step2 ?? {}
  const publish = new PublishRunner({ repoRoot: opts.repoRoot, workRoot: opts.workRoot, world, ...(step2.spawnJob ? { spawnJob: step2.spawnJob } : {}) })
  const testGame = new TestGame({ repoRoot: opts.repoRoot, workRoot: opts.workRoot, world, ...step2.testGame })
  /** The open publish's number (prepared, not kept or discarded), or null. */
  const openPublish = (): number | null => {
    const c = publish.current()
    if (c && (c.phase === 'preparing' || c.phase === 'ready' || c.phase === 'stopped' || c.phase === 'keeping')) return c.n
    return publish.state().running?.n ?? null
  }
  const deploy = new DeployHandOff({ repoRoot: opts.repoRoot, workRoot: opts.workRoot, world, openPublish, ...step2.deploy })
  // Test in game ends with the editor tab and with the editor (close()). A lapsed lease alone is not a closed tab:
  // Chrome wakes a hidden tab's timers once a minute (the user is playing in the Test in game tab), so the tab counts
  // as closed only after TAB_GONE_MS without a heartbeat (DL-2).
  const watchMs = step2.watchMs ?? 5000
  const TAB_GONE_MS = 10 * 60_000
  const watch = watchMs > 0 ? setInterval(() => {
    if (testGame.active && leases.idleMs() > TAB_GONE_MS) void testGame.stop('Test in game stopped: the World Editor tab was closed.')
  }, watchMs) : null
  watch?.unref?.()
  const pubDirOf = (n: number) => join(editorRoot, world, `publish-${n}`)
  const numberParam = (v: unknown): number => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'expected a publish number')
    return n
  }
  const shotsOf = (n: number) => {
    const dir = join(pubDirOf(n), 'shots')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(f => /^[a-z0-9_-]{1,64}\.png$/.test(f)).sort()
      .map(f => ({ name: f, dataUrl: `data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}` }))
  }
  const readReport = (n: number) => {
    try {
      return JSON.parse(readFileSync(join(pubDirOf(n), 'report.json'), 'utf8'))
    } catch {
      return null
    }
  }
  const startJob = (job: 'prepare' | 'keep' | 'discard' | 'undo', n?: number) => {
    try {
      publish.start(job, n)
    } catch (e) {
      if (e instanceof PublishBusyError) throw new HttpError(409, e.message)
      throw e
    }
  }
  // WE-T (D3, §4.11): the town's route overlay and dressing rows, written only under content/town/
  const town = new TownStore(join(opts.repoRoot, 'content', 'town'))

  const status = (): EditorStatus => ({
    gpuLock: ownerLine(join(opts.workRoot, 'tools', 'gpu.lock', 'owner')),
    convertLock: ownerLine(join(opts.workRoot, 'out', '.convert.lock', 'owner')),
  })

  const lockedSentence = () => `Another World Editor is open (${lock.owner}). This one can look but not change anything.`

  /** Writes need this process's lock and the tab's lease. */
  const mayWrite = (req: IncomingMessage) => {
    if (!lock.held) throw new HttpError(423, lockedSentence())
    if (!leases.check(header(req, LEASE_HEADER))) {
      throw new HttpError(409, 'Another editor tab is making changes; this tab is read-only. Close the other tab or take over.')
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET'
    const is = (m: string, p: string) => method === m && path === p
    if (is('POST', 'session')) {
      const body = (await readBody(req, 64 * 1024)) as { lease?: unknown; force?: unknown }
      const claim = lock.held
        ? leases.claim(typeof body?.lease === 'string' ? body.lease : undefined, body?.force === true)
        : { granted: false }
      const { consistent, mismatched } = store.consistency()
      const info: SessionInfo = {
        world,
        readOnly: !claim.granted,
        leaseTtlMs: opts.leaseTtlMs ?? LEASE_TTL_MS,
        beatMs: LEASE_BEAT_MS,
        files: store.listFiles(),
        journal: store.journalState(),
        consistent,
        mismatched,
        status: status(),
      }
      if (claim.granted) {
        info.lease = claim.lease
        if (lockNotice) {
          info.notice = lockNotice
          lockNotice = null
        }
      }
      else info.reason = lock.held ? 'Another editor tab is making changes; this tab is read-only. Close the other tab or take over.' : lockedSentence()
      return send(res, 200, info)
    }
    if (is('POST', 'heartbeat')) {
      const body = (await readBody(req, 64 * 1024)) as { lease?: unknown }
      const ok = lock.held && leases.beat(typeof body?.lease === 'string' ? body.lease : undefined)
      return send(res, 200, { ok, readOnly: !ok })
    }
    if (is('GET', 'status')) return send(res, 200, status())
    if (is('GET', 'files')) return send(res, 200, { files: store.fileInfo() })
    if (is('GET', 'layer')) {
      const px = store.readLayer(q.get('path') ?? '')
      if (!px) return send(res, 404, { ok: false, error: 'no such layer file' })
      return send(res, 200, pixelsToBytes(px), 'application/octet-stream')
    }
    if (is('GET', 'json')) {
      const json = store.readJson(q.get('name') ?? '')
      if (json === undefined) return send(res, 404, { ok: false, error: 'no such file' })
      return send(res, 200, json)
    }
    if (is('GET', 'journal')) return send(res, 200, store.journalState())
    if (is('GET', 'load')) return send(res, 200, store.load())
    if (is('GET', 'patch')) {
      const bytes = store.readPatch(Number(q.get('id')))
      if (!bytes) return send(res, 404, { ok: false, error: 'no such change' })
      return send(res, 200, bytes, 'application/octet-stream')
    }
    if (is('POST', 'save')) {
      mayWrite(req)
      const body = (await readBody(req, MAX_BODY_BYTES)) as SaveRequest | PageSaveRequest
      return send(res, 200, store.save(body))
    }
    if (is('GET', 'town')) return send(res, 200, town.load())
    if (is('POST', 'town')) {
      mayWrite(req)
      return send(res, 200, town.save((await readBody(req, MAX_BODY_BYTES)) as TownSaveRequest))
    }
    if (is('POST', 'journal/reset')) {
      mayWrite(req)
      await readBody(req, 64 * 1024)
      return send(res, 200, store.resetJournal())
    }

    // --- step 2: Publish ---
    if (is('GET', 'publish')) return send(res, 200, publish.state())
    if (is('POST', 'publish/start')) {
      mayWrite(req)
      await readBody(req, 64 * 1024)
      if (publish.running) throw new HttpError(409, 'Publish is already running.')
      if (testGame.active) await testGame.stop('Test in game stopped for the new publish.')
      startJob('prepare')
      return send(res, 202, publish.state())
    }
    for (const job of ['keep', 'discard', 'undo'] as const) {
      if (!is('POST', `publish/${job}`)) continue
      mayWrite(req)
      const body = (await readBody(req, 64 * 1024)) as { n?: unknown }
      const n = numberParam(body?.n)
      const rec = publish.record(n)
      if (!rec) throw new HttpError(404, `publish ${n} does not exist`)
      if (job === 'keep' && (rec.phase !== 'ready' || rec.verdict === 'stop')) {
        throw new HttpError(409, `Publish ${n} cannot be kept (${rec.phase === 'ready' ? 'a check stopped it' : rec.phase}).`)
      }
      if (job === 'undo' && publish.lastKept() !== n) throw new HttpError(409, 'Only the newest kept publish can be undone.')
      if (job !== 'undo' && testGame.active) await testGame.stop(`Test in game stopped (${job === 'keep' ? 'Keep' : 'Go back'}).`)
      startJob(job, n)
      return send(res, 202, publish.state())
    }
    if (is('GET', 'publish/report') || is('GET', 'publish/page')) {
      const n = numberParam(q.get('n'))
      const rec = publish.record(n)
      if (!rec) return send(res, 404, { ok: false, error: 'no such publish' })
      if (path === 'publish/report') return send(res, 200, { ...rec, report: readReport(n) })
      return send(res, 200, renderReportHtml(rec, readReport(n), shotsOf(n)), 'text/html; charset=utf-8')
    }
    if (is('POST', 'publish/shot')) {
      mayWrite(req)
      const body = (await readBody(req, 32 * 1024 * 1024)) as { n?: unknown; name?: unknown; png?: unknown }
      const n = numberParam(body?.n)
      if (!publish.record(n)) throw new HttpError(404, `publish ${n} does not exist`)
      if (typeof body.name !== 'string' || !/^[a-z0-9_-]{1,60}$/.test(body.name)) throw new HttpError(400, 'a shot name of a-z, 0-9, _ and - (up to 60)')
      if (typeof body.png !== 'string') throw new HttpError(400, 'expected png (base64)')
      const bytes = Buffer.from(body.png.replace(/^data:image\/png;base64,/, ''), 'base64')
      if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new HttpError(400, 'that is not a PNG')
      writeFileAtomic(scope, join(pubDirOf(n), 'shots', `${body.name}.png`), bytes)
      return send(res, 200, { ok: true })
    }
    // --- step 2: Test in game ---
    if (is('GET', 'test')) return send(res, 200, testGame.state())
    if (is('POST', 'test/start')) {
      mayWrite(req)
      await readBody(req, 64 * 1024)
      const c = publish.current()
      if (publish.running) throw new HttpError(409, 'Wait for the publish to finish.')
      if (!c || (c.phase !== 'ready' && c.phase !== 'stopped')) throw new HttpError(409, 'Publish first: Test in game plays the map Publish builds (before you keep it).')
      return send(res, 200, await testGame.start(TestGame.atOf(c.views)))
    }
    if (is('POST', 'test/stop')) {
      await readBody(req, 64 * 1024)
      return send(res, 200, await testGame.stop())
    }
    // --- step 2: Deploy ---
    if (is('GET', 'deploy')) {
      const running = deploy.state()
      return send(res, 200, running?.run?.phase === 'running' ? running : await deploy.plan())
    }
    if (is('POST', 'deploy/run')) {
      mayWrite(req)
      const body = (await readBody(req, 64 * 1024)) as { confirm?: unknown }
      return send(res, 200, await deploy.start(body?.confirm === true))
    }
    throw new HttpError(404, `no such editor API route: ${method} ${path}`)
  }

  const handle = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const url = req.url ?? ''
    if (!url.startsWith(API_PREFIX)) return next()
    const refused = checkRequest(req, expect)
    if (refused) return send(res, refused.status, { ok: false, error: refused.error })
    let parsed: URL
    try {
      parsed = new URL(url, expect.origin)
    } catch {
      return send(res, 400, { ok: false, error: 'bad URL' })
    }
    const path = parsed.pathname.slice(API_PREFIX.length)
    route(req, res, path, parsed.searchParams).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status
        : e instanceof SaveError || e instanceof PathError || e instanceof JournalError || e instanceof SyntaxError ? 400
          : 500
      if (!res.headersSent) send(res, status, { ok: false, error: (e as Error).message ?? String(e) })
      else res.destroy()
    })
  }

  return {
    token,
    world,
    port,
    lock,
    store,
    publish,
    testGame,
    deploy,
    pagePath: `/editor.html?world=${encodeURIComponent(world)}&k=${token}`,
    handle,
    close: () => {
      if (watch) clearInterval(watch)
      void testGame.stop()
      publish.stop()
      lock.release()
    },
  }
}
