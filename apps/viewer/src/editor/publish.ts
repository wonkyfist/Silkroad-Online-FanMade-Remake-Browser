/**
 * Publish, Test in game and Deploy from the page (docs/WORLD_EDITOR.md §2.4, §6.1, §6.2, §6.4, D6, D35, D36;
 * docs/WAVE_PLAN8.md §6.0 step 2, lane WE-U): the page saves, asks the editor API (lane WE-A) to prepare a publish,
 * follows its steps, takes the before / after pictures of the views the API lists (the editor's own renderer, with
 * the edits taken out for "before") and sends them back, then shows the report (./publish-report.ts, drawn by
 * ./publish-panel.ts) with Keep, Go back and Test in game. Test in game opens the real game on a private server (a
 * copy of the database) and the staging export, and stops both when the game's tab closes.
 *
 * The routes and their messages are WE-A's (`apps/viewer/editor-api/protocol.ts`, "step 2"); `PublishBackend` is the
 * page's view of them, so the flows run against a fake in the tests. An API without them answers 404 "no such editor
 * API route": the page then says plainly that Publish is not there yet.
 */
import type {
  DeployState, PublishRecord, PublishState, TestGameState,
} from '../../editor-api/protocol.ts'
import type { WorldEditsReport } from '../../../../packages/convert/src/world/edits/checks.ts'
import type { PublishRunView, PublishState as RunState, StepState, TestInGameView } from './publish-report.ts'

export const PUBLISH_ROUTES = {
  state: 'publish',
  start: 'publish/start',
  keep: 'publish/keep',
  discard: 'publish/discard',
  undo: 'publish/undo',
  report: 'publish/report',
  page: 'publish/page',
  shot: 'publish/shot',
  test: 'test',
  testStart: 'test/start',
  testStop: 'test/stop',
  deploy: 'deploy',
  deployRun: 'deploy/run',
} as const

/** A publish record with the checks' report (GET publish/report). */
export type PublishRecordReport = PublishRecord & { report?: WorldEditsReport | null }

export class PublishApiError extends Error {
  constructor(readonly status: number, message: string, readonly missing = false) {
    super(message)
  }
}

/** The editor API's step-2 routes as the page uses them. */
export interface PublishBackend {
  state(): Promise<PublishState>
  start(): Promise<PublishState>
  keep(n: number): Promise<PublishState>
  discard(n: number): Promise<PublishState>
  undo(n: number): Promise<PublishState>
  report(n: number): Promise<PublishRecordReport>
  /** The API's own report page (HTML), for "Open the full report". */
  page(n: number): Promise<string>
  /** A before / after picture the page rendered (PNG, base64). */
  shot(n: number, name: string, png: string): Promise<void>
  test(): Promise<TestGameState>
  testStart(): Promise<TestGameState>
  testStop(keepalive?: boolean): Promise<TestGameState>
  deploy(): Promise<DeployState>
  deployRun(): Promise<DeployState>
}

export type Requester = (method: 'GET' | 'POST', path: string, body?: unknown, init?: { keepalive?: boolean }) => Promise<Response>

const MISSING_ROUTE = /no such editor API route/i

/** The sentence when the API has no Publish (an editor started before the step-2 API). */
export const NO_PUBLISH = 'Publish is not in this editor yet: its local API has no Publish. Your changes are saved on this PC; restart the editor with the desktop shortcut (or "pnpm editor") after the next build step.'

export class HttpPublishBackend implements PublishBackend {
  constructor(private readonly request: Requester) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, init?: { keepalive?: boolean }): Promise<Response> {
    const res = await this.request(method, path, body, init)
    if (res.ok) return res
    let msg = `${res.status} ${res.statusText}`
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg
    } catch {
      // not JSON
    }
    const missing = res.status === 404 && MISSING_ROUTE.test(msg)
    throw new PublishApiError(res.status, missing ? NO_PUBLISH : msg, missing)
  }

  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown, init?: { keepalive?: boolean }): Promise<T> {
    return (await (await this.call(method, path, body, init)).json()) as T
  }

  state(): Promise<PublishState> {
    return this.json('GET', PUBLISH_ROUTES.state)
  }

  start(): Promise<PublishState> {
    return this.json('POST', PUBLISH_ROUTES.start, {})
  }

  keep(n: number): Promise<PublishState> {
    return this.json('POST', PUBLISH_ROUTES.keep, { n })
  }

  discard(n: number): Promise<PublishState> {
    return this.json('POST', PUBLISH_ROUTES.discard, { n })
  }

  undo(n: number): Promise<PublishState> {
    return this.json('POST', PUBLISH_ROUTES.undo, { n })
  }

  report(n: number): Promise<PublishRecordReport> {
    return this.json('GET', `${PUBLISH_ROUTES.report}?n=${n}`)
  }

  async page(n: number): Promise<string> {
    return (await this.call('GET', `${PUBLISH_ROUTES.page}?n=${n}`)).text()
  }

  async shot(n: number, name: string, png: string): Promise<void> {
    await this.call('POST', PUBLISH_ROUTES.shot, { n, name, png })
  }

  test(): Promise<TestGameState> {
    return this.json('GET', PUBLISH_ROUTES.test)
  }

  testStart(): Promise<TestGameState> {
    return this.json('POST', PUBLISH_ROUTES.testStart, {})
  }

  testStop(keepalive = false): Promise<TestGameState> {
    return this.json('POST', PUBLISH_ROUTES.testStop, {}, { keepalive })
  }

  deploy(): Promise<DeployState> {
    return this.json('GET', PUBLISH_ROUTES.deploy)
  }

  deployRun(): Promise<DeployState> {
    return this.json('POST', PUBLISH_ROUTES.deployRun, { confirm: true })
  }
}

// ---- the API's record as the report reads it ---------------------------------------------------------------------------

const PHASE: Record<PublishRecord['phase'], RunState> = {
  preparing: 'running', ready: 'ready', stopped: 'stopped', failed: 'failed', keeping: 'running', kept: 'kept', discarded: 'discarded', undone: 'undone',
}
const STEP: Record<string, StepState> = { wait: 'waiting', run: 'running', done: 'done', fail: 'failed', skip: 'skipped' }

/** One picture pair the page took (blob URLs) for a view of the record. */
export interface TakenShot {
  view: number
  label: string
  before: string
  after: string
}

/** The API's state (and, once there, the record with the checks) -> the run the report draws. */
export function runOf(state: PublishState, record: PublishRecordReport | null, shots: readonly TakenShot[] = []): PublishRunView | null {
  const cur = state.current
  // A prepare whose record is not written yet (an older API answers the previous publish, or none for publish 1):
  // the run is that new publish, starting (V-12: the panel stayed on "Starting" until a reload).
  if (state.running?.job === 'prepare' && (!cur || cur.n < state.running.n)) {
    const run: PublishRunView = { id: state.running.n, state: 'running', steps: [{ key: 'send', label: 'Starting', state: 'running' }], job: 'prepare' }
    if (state.convertLock) run.waiting = state.convertLock
    return run
  }
  if (!cur) return null
  // the state's record is the newest; the report record only adds the checks (the same publish)
  const rec = cur
  const busy = !!state.running && state.running.n === cur.n
  const run: PublishRunView = {
    id: rec.n,
    state: busy ? 'running' : PHASE[rec.phase] ?? 'failed',
    steps: rec.steps.map(s => ({ key: s.key, label: s.title, state: STEP[s.status] ?? 'waiting', ...(s.ms !== undefined ? { ms: s.ms } : {}), ...(s.note ? { note: s.note } : {}) })),
    regions: rec.regions?.core ?? [],
    changes: rec.changes,
    sentence: rec.sentence,
    report: (record && record.n === cur.n ? record.report : null) ?? null,
    sheet: shots.map(s => ({ label: s.label, before: s.before, after: s.after })),
  }
  if (busy && state.running) run.job = state.running.job
  if (rec.error) run.error = rec.error
  if (rec.commit) run.commit = rec.commit
  if (rec.tests) run.tests = rec.tests.summary
  if (rec.hero?.length) run.hero = rec.hero.map(h => h.tile)
  if (rec.drift?.length) run.drift = rec.drift.length
  if (state.convertLock && busy) run.waiting = state.convertLock
  return run
}

// ---- the Publish flow --------------------------------------------------------------------------------------------------

export interface PublishHost {
  /** Saves first; false stops the Publish (the host said why). */
  save(): Promise<boolean>
  /** False when there is nothing to publish (the host said so). */
  hasChanges(): boolean
  /** Draws the run (the panel), every time it changes. */
  show(run: PublishRunView): void
  say(text: string, kind?: 'ok' | 'warn' | 'error'): void
  /** Renders the before / after pictures of the views (PNG base64 + a URL to show), or none. */
  takeShots?(views: NonNullable<PublishRecord['views']>, progress: (done: number, total: number) => void): Promise<Array<TakenShot & { beforePng: string; afterPng: string }>>
  /** The page's own views (its journal's cameras) when the record lists none. */
  fallbackViews?(): NonNullable<PublishRecord['views']>
  /** After Keep or Undo: the export on this PC changed. */
  exportChanged?(run: PublishRunView): void
}

export interface FlowOptions {
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Give up following a job after this long (the API keeps running it; Publish… shows it again). */
  maxFollowMs?: number
  now?: () => number
}

const SETTLED = new Set<RunState>(['ready', 'stopped', 'failed', 'kept', 'discarded', 'undone'])

export class PublishFlow {
  run: PublishRunView | null = null
  busy = false
  private state: PublishState | null = null
  private record: PublishRecordReport | null = null
  private shots: TakenShot[] = []
  private shotsFor = -1
  /** Publishes whose pictures were tried (once each). */
  private readonly tried = new Set<number>()
  private readonly pollMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxFollowMs: number
  private readonly now: () => number

  constructor(private readonly backend: PublishBackend, private readonly host: PublishHost, opts: FlowOptions = {}) {
    this.pollMs = opts.pollMs ?? 1000
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.maxFollowMs = opts.maxFollowMs ?? 30 * 60_000
    this.now = opts.now ?? (() => performance.now())
  }

  private wake: (() => void) | null = null

  /** One poll interval; `poke()` (the tab shown again, the panel opened) ends it early. */
  private nap(): Promise<void> {
    return new Promise<void>(resolve => {
      let done = false
      const end = () => {
        if (done) return
        done = true
        if (this.wake === end) this.wake = null
        resolve()
      }
      this.wake = end
      void this.sleep(this.pollMs).then(end)
    })
  }

  /** Ask the API now instead of at the next poll (a hidden tab's timers are slowed by the browser). */
  poke(): void {
    this.wake?.()
  }

  /** A publish whose staging export exists and waits (Test in game plays it; a stopped one too, to see why). */
  get ready(): boolean {
    return this.run?.state === 'ready' || this.run?.state === 'stopped'
  }

  private update(state: PublishState): void {
    this.state = state
    if (state.current && this.record && this.record.n !== state.current.n) this.record = null
    if (state.current && this.shotsFor !== state.current.n) {
      this.shots = []
      this.shotsFor = state.current.n
    }
    this.run = runOf(state, this.record, this.shots)
    if (this.run) this.host.show(this.run)
  }

  private fail(err: unknown, what: string): PublishRunView {
    const missing = err instanceof PublishApiError && err.missing
    this.run = { id: this.run?.id ?? 0, state: 'failed', error: missing ? NO_PUBLISH : (err as Error).message }
    this.host.show(this.run)
    this.host.say(missing ? NO_PUBLISH : `${what}: ${(err as Error).message}`, 'error')
    return this.run
  }

  /** Publish…: save, prepare, follow, pictures, report. */
  async start(): Promise<PublishRunView | null> {
    if (this.busy) {
      if (this.run) this.host.show(this.run)
      return this.run
    }
    if (this.run?.state === 'ready' || this.run?.state === 'running') {
      this.host.show(this.run)
      if (this.run.state === 'ready') this.host.say('A Publish is waiting for you: Keep it or Go back first.', 'warn')
      return this.run
    }
    this.busy = true
    try {
      if (!(await this.host.save())) return null
      if (!this.host.hasChanges()) return null
      this.run = { id: 0, state: 'running', steps: [{ key: 'send', label: 'Starting', state: 'running' }] }
      this.host.show(this.run)
      try {
        this.update(await this.backend.start())
      } catch (err) {
        return this.fail(err, 'Publish could not start')
      }
      return await this.follow()
    } finally {
      this.busy = false
    }
  }

  /** The page's start: a publish that is preparing or waiting for Keep comes back on screen. */
  async resume(): Promise<PublishRunView | null> {
    let st: PublishState
    try {
      st = await this.backend.state()
    } catch {
      return null
    }
    const cur = st.current
    if (!st.running && (!cur || (cur.phase !== 'ready' && cur.phase !== 'preparing' && cur.phase !== 'keeping'))) {
      this.state = st
      return null
    }
    this.update(st)
    if (!st.running && cur?.phase === 'ready') this.host.say('A Publish is waiting for you: Keep it or Go back.', 'warn')
    return this.follow()
  }

  /** Polls until no job runs, then fetches the report (and takes the pictures once for a ready publish). */
  private async follow(): Promise<PublishRunView | null> {
    const t0 = this.now()
    // the publish this follow is about: the job's own number (its record may not exist yet)
    const want = this.state?.running?.n ?? this.state?.current?.n ?? null
    // a job runs (whatever `current` says), or the record still says preparing / keeping (an orphan job finishing)
    const going = () => !!this.state && (!!this.state.running || (!!this.state.current && this.run?.state === 'running'))
    while (going()) {
      if (this.now() - t0 > this.maxFollowMs) {
        this.host.say('Publish is taking long: it keeps running; press Publish… to see it again.', 'warn')
        return this.run
      }
      await this.nap()
      try {
        this.update(await this.backend.state())
      } catch (err) {
        this.host.say(`Lost touch with the editor API: ${(err as Error).message} Trying again…`, 'warn')
      }
    }
    const cur = this.state?.current
    if (want !== null && (!cur || cur.n < want)) {
      // the job ended without writing its record (its process failed to start, or died): say so, never "Starting"
      return this.fail(new Error(`publish ${want} ended before it wrote its record (see publish.log in the editor folder).`), 'Publish could not finish')
    }
    if (!cur) return this.run
    if (cur.phase === 'ready' || cur.phase === 'stopped' || cur.phase === 'failed') {
      try {
        this.record = await this.backend.report(cur.n)
      } catch {
        this.record = null
      }
      this.update(this.state!)
      if (cur.phase === 'ready' && this.shotsFor === cur.n && !this.shots.length && !this.tried.has(cur.n) && this.host.takeShots) {
        this.tried.add(cur.n)
        const views = cur.views?.length ? cur.views : this.host.fallbackViews?.() ?? []
        if (views.length) await this.pictures(cur, views)
      }
    }
    const r = this.run
    if (r) {
      const warn = r.report?.verdict === 'warn'
      if (r.state === 'ready') this.host.say(warn ? 'Publish is ready, with amber rows to look at. Keep, Test in game or Go back.' : 'Publish is ready: everything checks out. Keep, Test in game or Go back.', warn ? 'warn' : 'ok')
      else if (r.state === 'stopped') this.host.say('Publish stopped: see the red rows. Nothing changed on the map.', 'error')
      else if (r.state === 'failed') this.host.say(`Publish could not finish: ${r.error ?? 'a step failed.'} Nothing changed on the map.`, 'error')
    }
    return r
  }

  private async pictures(cur: PublishRecord, views: NonNullable<PublishRecord['views']>): Promise<void> {
    try {
      const taken = await this.host.takeShots!(views, (done, total) => this.host.say(`Taking the before / after pictures… ${done} of ${total}`))
      const kept: TakenShot[] = []
      for (const s of taken) {
        await this.backend.shot(cur.n, `${s.view}-before`, s.beforePng)
        await this.backend.shot(cur.n, `${s.view}-after`, s.afterPng)
        kept.push({ view: s.view, label: s.label, before: s.before, after: s.after })
      }
      this.shots = kept
    } catch (err) {
      this.host.say(`The before / after pictures could not be made: ${(err as Error).message} The rest of the report stands.`, 'warn')
    }
    if (this.state) this.update(this.state)
  }

  private async job(what: string, call: () => Promise<PublishState>): Promise<PublishRunView | null> {
    this.busy = true
    try {
      this.update(await call())
      return await this.follow()
    } catch (err) {
      this.host.say(`${what} did not go through: ${(err as Error).message}`, 'error')
      return this.run
    } finally {
      this.busy = false
    }
  }

  async keep(): Promise<PublishRunView | null> {
    const r = this.run
    if (!r || r.state !== 'ready' || this.busy) return r
    const out = await this.job('Keep', () => this.backend.keep(r.id))
    if (out?.state === 'kept') {
      this.host.say('Kept: this is now the map on this PC. Restart the local game server to play it here.')
      this.host.exportChanged?.(out)
    }
    return out
  }

  async goBack(): Promise<PublishRunView | null> {
    const r = this.run
    if (!r || (r.state !== 'ready' && r.state !== 'stopped') || this.busy) return r
    const out = await this.job('Go back', () => this.backend.discard(r.id))
    if (out?.state === 'discarded') this.host.say('Gone back: the test build is thrown away. Your edits are all still here.')
    return out
  }

  /** "Undo this publish": the kept publish's replaced files go back. */
  async undo(): Promise<PublishRunView | null> {
    const r = this.run
    if (!r || r.state !== 'kept' || this.busy) return r
    const out = await this.job('Undo this publish', () => this.backend.undo(r.id))
    if (out?.state === 'undone') {
      this.host.say('This publish is undone: the map on this PC is as it was before it. Your edits are all still here.')
      this.host.exportChanged?.(out)
    }
    return out
  }
}

// ---- Test in game ------------------------------------------------------------------------------------------------------

/** The game's tab as the page holds it (a WindowProxy: `closed` and `location` work across origins). */
export interface GameWindow {
  readonly closed: boolean
  location: { href: string }
  document?: Document
  close(): void
}

export interface TestHost {
  /** Opens the game's tab at once (inside the click, so no popup blocker stops it); null when blocked. */
  openWindow(): GameWindow | null
  say(text: string, kind?: 'ok' | 'warn' | 'error'): void
  /** The top bar's chip. */
  onState(v: TestInGameView): void
}

const TEST_PHASE: Record<TestGameState['phase'], TestInGameView['state']> = {
  off: 'stopped', starting: 'starting', running: 'ready', stopping: 'stopping', failed: 'failed',
}

/** The API's test state -> the chip's. */
export function testOf(s: TestGameState): TestInGameView {
  const v: TestInGameView = { state: TEST_PHASE[s.phase] ?? 'failed', message: s.error ?? s.sentence }
  if (s.url) v.url = s.url
  return v
}

/** A page for the game's tab while the test server starts (same origin: about:blank). */
function waitPage(win: GameWindow, text: string): void {
  try {
    const d = win.document
    if (!d) return
    d.title = 'Test in game'
    d.body.style.cssText = 'margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#15120e;color:#f1e6d0;font:16px/1.4 "Segoe UI",system-ui,sans-serif;text-align:center;padding:0 24px'
    d.body.textContent = text
  } catch {
    // the tab already left for the game (another origin)
  }
}

export class TestInGame {
  state: TestInGameView = { state: 'idle' }
  private win: GameWindow | null = null
  private watch: ReturnType<typeof setInterval> | null = null
  private readonly pollMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxWaitMs: number
  private readonly now: () => number
  private run = 0

  constructor(private readonly backend: PublishBackend, private readonly host: TestHost, opts: FlowOptions & { maxWaitMs?: number } = {}) {
    this.pollMs = opts.pollMs ?? 1000
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.maxWaitMs = opts.maxWaitMs ?? 10 * 60_000
    this.now = opts.now ?? (() => performance.now())
  }

  get active(): boolean {
    return this.state.state === 'building' || this.state.state === 'starting' || this.state.state === 'ready'
  }

  private set(v: TestInGameView): void {
    this.state = v
    this.host.onState(v)
  }

  /**
   * Call it from the click (the game's tab opens before the first await). `before`: what must happen first (save,
   * and a publish's staging build when none waits); false stops it.
   */
  async start(before?: () => Promise<boolean>): Promise<TestInGameView> {
    if (this.active) {
      if (this.state.url && this.win && !this.win.closed) this.host.say('The test game is already open in its own tab.')
      return this.state
    }
    const token = ++this.run
    this.win = this.host.openWindow()
    if (this.win) waitPage(this.win, 'Building the test map and starting a private game server… This tab turns into the game when it is ready (a minute or two).')
    this.set({ state: 'building', message: 'Building the test map…' })
    if (before && !(await before())) {
      this.closeWindow()
      this.set({ state: 'idle' })
      return this.state
    }
    if (token !== this.run) return this.state
    let v: TestInGameView
    try {
      v = testOf(await this.backend.testStart())
    } catch (err) {
      const msg = err instanceof PublishApiError && err.missing ? NO_PUBLISH.replace('Publish is not', 'Test in game is not') : (err as Error).message
      return this.fail(msg)
    }
    this.set(v)
    const t0 = this.now()
    while (v.state === 'building' || v.state === 'starting') {
      if (token !== this.run) return this.state
      if (this.now() - t0 > this.maxWaitMs) return this.fail('the test server did not start within ten minutes.')
      await this.sleep(this.pollMs)
      try {
        v = testOf(await this.backend.test())
      } catch (err) {
        return this.fail((err as Error).message)
      }
      if (token !== this.run) return this.state
      this.set(v)
    }
    if (v.state !== 'ready' || !v.url) return this.fail(v.message ?? 'the test server stopped.')
    if (this.win && !this.win.closed) {
      this.win.location.href = v.url
      this.host.say('Test in game: the game opened in its own tab. Log in with your own account (the test server uses a copy of the database). Close that tab to stop the test server.')
      this.watchWindow()
    } else {
      this.win = null
      this.host.say(`Test in game is ready at ${v.url} (the browser blocked the new tab: use "open" in the top bar). Press Stop when you are done.`, 'warn')
    }
    return this.state
  }

  private fail(msg: string): TestInGameView {
    if (this.win && !this.win.closed) waitPage(this.win, `Test in game could not start: ${msg}`)
    this.set({ state: 'failed', message: msg })
    this.host.say(`Test in game could not start: ${msg}`, 'error')
    return this.state
  }

  private watchWindow(): void {
    if (this.watch) clearInterval(this.watch)
    this.watch = setInterval(() => {
      if (!this.win || this.win.closed) void this.stop()
    }, 2000)
  }

  private closeWindow(): void {
    try {
      this.win?.close()
    } catch {
      // ignore
    }
    this.win = null
  }

  /** Stops the test server and the game's Vite (the API deletes the database copy). */
  async stop(keepalive = false): Promise<TestInGameView> {
    this.run++
    if (this.watch) clearInterval(this.watch)
    this.watch = null
    this.win = null
    if (this.state.state === 'idle' || this.state.state === 'stopped') return this.state
    const wasFailed = this.state.state === 'failed'
    this.set({ state: 'stopping', message: 'Stopping the test server…' })
    try {
      const v = testOf(await this.backend.testStop(keepalive))
      this.set(v.state === 'stopped' ? { state: 'idle' } : v)
      if (!keepalive && !wasFailed) this.host.say('Test in game stopped: the private server and its copy of the database are gone.')
    } catch (err) {
      this.set(wasFailed ? { state: 'idle' } : { state: 'failed', message: (err as Error).message })
      if (!keepalive && !wasFailed) this.host.say(`The test server did not stop cleanly: ${(err as Error).message}`, 'warn')
    }
    return this.state
  }
}
