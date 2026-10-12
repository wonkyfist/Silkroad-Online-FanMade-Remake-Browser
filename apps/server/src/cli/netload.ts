/**
 * Network load test (docs/NETWORK_AUDIT.md §7): N headless protocol bots against a LOCAL game server started by this
 * script in its own process (own temp DATA_DIR, NET_STATS=1), so the server's CPU, memory and tick times are its own.
 * No browsers, no rendering: each bot is one WebSocket that registers, creates a character, enters the world and then
 * plays at human rates — walks (a new point every 4–10 s), fights (30 %: the nearest monster every 3 s), chats (one
 * local line every 30–90 s), trades (every 60–120 s a trade request to a bot it sees, answered and then cancelled)
 * and pings every 5 s (the client's own cadence; RTT is measured from these).
 *
 *   pnpm netload --bots 100 --scenario town|spread [--duration 60] [--warmup 20] [--port 18900] [--out file.json]
 *   (the server takes GATEWAYS, AOI_JOBS, DB_WRITER, SVC_BUS and the P0 switches from the environment; the report splits the
 *   CPU by process and thread and shows the DB writer's queue and latency)
 *
 * town   = everyone stays in Jangan (the crowded-plaza case: every bot sees every other one).
 * spread = a GM bot teleports to the world's GM places in turn and summons an equal share of the bots to each.
 *
 * Never point this at the live server: it starts its own on 127.0.0.1.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, createWriteStream, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, STARTER_WEAPONS, PLAYER_MODELS_CH } from '@sro/shared'

const REPO = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const TSX = join(REPO, 'node_modules/tsx/dist/cli.mjs')

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def
}

const N = Number(arg('bots', '50'))
const SCENARIO = arg('scenario', 'town') as 'town' | 'spread'
const DURATION_S = Number(arg('duration', '60'))
const WARMUP_S = Number(arg('warmup', '20'))
const PORT = Number(arg('port', '18900'))
const OUT = arg('out', '')
/** --prof <dir>: the server writes a V8 CPU profile there on exit (SIGINT; main.ts saves and exits). */
const PROF = arg('prof', '')
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/ws`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rnd = (a: number, b: number) => a + Math.random() * (b - a)

// ---- the server ----------------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'sro-netload-'))
const serverLog = join(dataDir, 'server.log')
let server: ChildProcess | null = null

async function startServer(): Promise<void> {
  const log = createWriteStream(serverLog)
  // node --import tsx: one process (the tsx CLI would put a second node between us and the server)
  server = spawn(process.execPath, [...(PROF ? ['--cpu-prof', '--cpu-prof-dir', PROF] : []), '--import', 'tsx', join(REPO, 'apps/server/src/main.ts')], {
    cwd: REPO,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, REGISTER_LIMIT: '100000', CAPACITY: String(N + 20),
      NET_STATS: '1', AUTO_UPDATE: 'off', NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout!.pipe(log)
  server.stderr!.pipe(log)
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start in 180 s (log: ${serverLog})`)), 180_000)
    server!.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(t)
        res()
      }
    })
    server!.once('exit', (c) => rej(new Error(`server exited ${c} (log: ${serverLog})`)))
  })
}

async function register(prefix: string): Promise<{ username: string; token: string }> {
  const username = `${prefix}${randomBytes(4).toString('hex')}`.slice(0, 16)
  const password = randomBytes(9).toString('base64url')
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    const j = (await r.json()) as { token: string }
    if (r.status === 201) return { username, token: j.token }
    if (attempt > 20) throw new Error(`register ${r.status} ${JSON.stringify(j)}`)
    await sleep(500)
  }
}

// ---- the bots --------------------------------------------------------------------------------------
interface Ent { kind: string; pos: [number, number, number] }
const clientStats = {
  inBytes: 0,
  inMsgs: new Map<string, number>(),
  outMsgs: new Map<string, number>(),
  rtts: [] as number[],
  closes: new Map<string, number>(),
  errors: new Map<string, number>(),
  measuring: false,
}

class Bot {
  ws!: WebSocket
  selfId = 0
  name = ''
  pos: [number, number, number] = [0, 0, 0]
  home: [number, number] = [0, 0]
  ents = new Map<number, Ent>()
  timers: NodeJS.Timeout[] = []
  waiters: { t: string; res: (m: any) => void }[] = []
  fighter = false
  closed = false
  pingN = 0

  constructor(readonly k: number) {}

  open(token: string): Promise<void> {
    // 16 sockets per IP on the server: every bot its own loopback address
    this.ws = new WebSocket(WS_URL, { localAddress: `127.0.${1 + Math.floor(this.k / 200)}.${20 + (this.k % 200)}` })
    this.ws.on('message', (data: Buffer) => this.onMessage(data))
    this.ws.on('close', (code, reason) => {
      this.closed = true
      for (const t of this.timers) clearInterval(t)
      const key = `${code} ${reason.toString()}`.trim()
      clientStats.closes.set(key, (clientStats.closes.get(key) ?? 0) + 1)
    })
    this.ws.on('error', () => {})
    return new Promise((res, rej) => {
      this.ws.once('open', () => {
        this.send({ t: 'hello', version: PROTOCOL_VERSION, token })
        this.next('welcome').then(() => res(), rej)
      })
      this.ws.once('error', rej)
    })
  }

  send(m: { t: string } & Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    if (clientStats.measuring) clientStats.outMsgs.set(m.t, (clientStats.outMsgs.get(m.t) ?? 0) + 1)
    this.ws.send(JSON.stringify(m))
  }

  next(t: string, ms = 30_000): Promise<any> {
    return new Promise((res, rej) => {
      const w = { t, res }
      this.waiters.push(w)
      setTimeout(() => {
        const i = this.waiters.indexOf(w)
        if (i >= 0) {
          this.waiters.splice(i, 1)
          rej(new Error(`bot ${this.k}: no ${t} in ${ms} ms`))
        }
      }, ms)
    })
  }

  onMessage(data: Buffer): void {
    const m = JSON.parse(data.toString('utf8'))
    if (clientStats.measuring) {
      clientStats.inBytes += data.length
      clientStats.inMsgs.set(m.t, (clientStats.inMsgs.get(m.t) ?? 0) + 1)
    }
    const i = this.waiters.findIndex((w) => w.t === m.t)
    if (i >= 0) this.waiters.splice(i, 1)[0]!.res(m)
    switch (m.t) {
      case 'worldEnter':
        this.selfId = m.self.id
        this.pos = m.self.pos
        for (const e of m.entities ?? []) this.ents.set(e.id, { kind: e.kind, pos: e.pos })
        break
      case 'spawn':
        this.ents.set(m.entity.id, { kind: m.entity.kind, pos: m.entity.pos })
        break
      case 'despawn':
        this.ents.delete(m.id)
        break
      case 'move': {
        const e = m.id === this.selfId ? null : this.ents.get(m.id)
        if (e) e.pos = m.move.to
        if (m.id === this.selfId) this.pos = m.move.to
        break
      }
      case 'stop':
      case 'warp':
        if (m.id === this.selfId) this.pos = m.pos
        else {
          const e = this.ents.get(m.id)
          if (e) e.pos = m.pos
        }
        if (m.t === 'warp' && m.id === this.selfId) this.home = [m.pos[0], m.pos[2]]
        break
      case 'pong':
        if (clientStats.measuring) clientStats.rtts.push(performance.now() - m.clientTime)
        break
      case 'tradeRequested':
        this.send({ t: 'tradeRespond', from: m.from, accept: true })
        break
      case 'trade':
        // an open trade window: the requester cancels it a moment later (no items change hands)
        setTimeout(() => this.send({ t: 'tradeCancel' }), 2000)
        break
      case 'error':
        if (clientStats.measuring) clientStats.errors.set(`${m.re ?? '-'} ${m.code}`, (clientStats.errors.get(`${m.re ?? '-'} ${m.code}`) ?? 0) + 1)
        break
    }
  }

  nearest(kind: string, maxD = 40): number | null {
    let best: number | null = null
    let bd = maxD * maxD
    for (const [id, e] of this.ents) {
      if (e.kind !== kind) continue
      const d = (e.pos[0] - this.pos[0]) ** 2 + (e.pos[2] - this.pos[2]) ** 2
      if (d < bd) {
        bd = d
        best = id
      }
    }
    return best
  }

  /** Human-rate play (see the header). Every timer is jittered so the bots do not act in lockstep. */
  play(): void {
    const every = (lo: number, hi: number, fn: () => void) => {
      const loop = () => {
        if (this.closed) return
        try {
          fn()
        } catch {}
        this.timers.push(setTimeout(loop, rnd(lo, hi)))
      }
      this.timers.push(setTimeout(loop, rnd(0, hi)))
    }
    every(4000, 10_000, () => {
      if (this.fighter && this.nearest('mob') !== null) return
      this.send({ t: 'moveTo', x: Math.round((this.home[0] + rnd(-25, 25)) * 100) / 100, z: Math.round((this.home[1] + rnd(-25, 25)) * 100) / 100 })
    })
    if (this.fighter) every(3000, 3000, () => {
      const id = this.nearest('mob')
      if (id !== null) this.send({ t: 'attack', target: id })
    })
    every(30_000, 90_000, () => this.send({ t: 'chat', channel: 'local', text: `hello from bot ${this.k}` }))
    every(60_000, 120_000, () => {
      const id = this.nearest('player', 30)
      if (id !== null) this.send({ t: 'tradeRequest', target: id })
    })
    every(5000, 5000, () => this.send({ t: 'ping', n: ++this.pingN, clientTime: performance.now() }))
  }
}

async function makeBot(k: number): Promise<Bot> {
  const acc = await register('nl')
  const b = new Bot(k)
  await b.open(acc.token)
  const models = PLAYER_MODELS_CH as readonly string[]
  const name = `Nl${k.toString(36)}${randomBytes(3).toString('hex')}`.slice(0, 12)
  b.name = name
  b.send({ t: 'charCreate', name, model: models[k % models.length]!, weapon: STARTER_WEAPONS[k % STARTER_WEAPONS.length]! })
  const created = await b.next('charCreated')
  const entered = b.next('worldEnter', 60_000)
  b.send({ t: 'enterWorld', id: created.character.id })
  await entered
  b.home = [b.pos[0], b.pos[2]]
  b.fighter = k % 10 < 3
  return b
}

async function pool<T>(n: number, conc: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = []
  let i = 0
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < n) {
      const k = i++
      out[k] = await fn(k)
    }
  }))
  return out
}

/** spread: a GM bot (role granted through the owner's CLI on this run's DATA_DIR) summons the bots to the GM places. */
async function spread(bots: Bot[]): Promise<void> {
  const acc = await register('nlgm')
  execFileSync(process.execPath, [TSX, join(REPO, 'apps/server/src/cli/gm.ts'), 'grant', acc.username, '--role', 'gm'], { env: { ...process.env, DATA_DIR: dataDir }, stdio: 'ignore' })
  const gm = new Bot(9999)
  await gm.open(acc.token)
  gm.send({ t: 'charCreate', name: `Nlgm${randomBytes(2).toString('hex')}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
  const c = await gm.next('charCreated')
  gm.send({ t: 'enterWorld', id: c.character.id })
  await gm.next('worldEnter')
  await sleep(500) // the role poll
  const gmCmd = async (cmd: string, args: string[]) => {
    const r = gm.next('gmResult')
    gm.send({ t: 'gm', cmd, args })
    const res = await r
    await sleep(210) // the GM budget: 5/s
    return res
  }
  const list = await gmCmd('tp', [])
  const places: string[] = ((list.data?.presets ?? []) as { name: string }[]).map((p) => p.name).filter((n) => n !== 'spawn')
  if (!places.length) throw new Error('spread: no GM places in this world')
  const per = Math.ceil(bots.length / places.length)
  for (let p = 0; p * per < bots.length; p++) {
    await gmCmd('tp', [places[p % places.length]!])
    for (const b of bots.slice(p * per, (p + 1) * per)) await gmCmd('summon', [b.name])
  }
  gm.ws.close()
  console.log(`spread: ${bots.length} bots over ${Math.min(places.length, Math.ceil(bots.length / per))} places`)
}

async function netstats(reset = false): Promise<any> {
  return (await fetch(`${BASE}/netstats${reset ? '?reset=1' : ''}`)).json()
}

const pct = (a: number[], p: number) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10
}

async function main(): Promise<void> {
  console.log(`netload: ${N} bots, ${SCENARIO}, warmup ${WARMUP_S} s, measure ${DURATION_S} s, port ${PORT}`)
  const t0 = Date.now()
  await startServer()
  console.log(`server up in ${((Date.now() - t0) / 1000).toFixed(1)} s (log ${serverLog})`)
  const idle = await netstats()
  const t1 = Date.now()
  const bots = await pool(N, 8, makeBot)
  console.log(`${N} bots in the world in ${((Date.now() - t1) / 1000).toFixed(1)} s`)
  if (SCENARIO === 'spread') await spread(bots)
  for (const b of bots) b.play()
  await sleep(WARMUP_S * 1000)
  const a = await netstats(true)
  clientStats.measuring = true
  const rss: number[] = []
  const end = Date.now() + DURATION_S * 1000
  while (Date.now() < end) {
    await sleep(5000)
    rss.push((await netstats()).process.rssMb)
  }
  clientStats.measuring = false
  const b = await netstats()
  const dt = (b.at - a.at) / 1000
  const online = bots.filter((x) => !x.closed).length
  const cpuPct = Math.round(((b.process.cpuUserMs + b.process.cpuSystemMs - a.process.cpuUserMs - a.process.cpuSystemMs) / (dt * 1000)) * 1000) / 10
  // docs/SERVER_ARCHITECTURE.md P1: the tick thread alone, each gateway process, the AoI worker threads
  const pctOf = (ms: number) => Math.round((ms / (dt * 1000)) * 1000) / 10
  const mainThreadPct = b.process.mainThreadCpuMs !== undefined && a.process.mainThreadCpuMs !== undefined ? pctOf(b.process.mainThreadCpuMs - a.process.mainThreadCpuMs) : undefined
  type Gw = { index: number; cpuUserMs: number; cpuSystemMs: number; outMs: number; inMs: number; outFrames: number; loop: { p99Ms: number }; rssMb: number; conns: number; slowCloses: number }
  const gwA: Gw[] = a.gateways?.list ?? []
  const gateways = (b.gateways?.list ?? []).map((g: Gw) => {
    const g0 = gwA.find((x) => x.index === g.index)
    const cpu = g.cpuUserMs + g.cpuSystemMs - (g0 ? g0.cpuUserMs + g0.cpuSystemMs : 0)
    return { index: g.index, conns: g.conns, cpuPct: pctOf(cpu), writeMsPerS: Math.round(((g.outMs - (g0?.outMs ?? 0)) / dt) * 10) / 10, readMsPerS: Math.round(((g.inMs - (g0?.inMs ?? 0)) / dt) * 10) / 10, framesOutPerS: Math.round((g.outFrames - (g0?.outFrames ?? 0)) / dt), loopP99Ms: g.loop.p99Ms, rssMb: g.rssMb, slowCloses: g.slowCloses }
  })
  const aoi = b.aoiJobs ? { ...b.aoiJobs, workerCpuPct: pctOf(b.aoiJobs.workerCpuMs - (a.aoiJobs?.workerCpuMs ?? 0)) } : undefined
  const totalCpuPct = Math.round((cpuPct + gateways.reduce((x: number, g: { cpuPct: number }) => x + g.cpuPct, 0)) * 10) / 10
  // docs/SERVER_ARCHITECTURE.md P2: the DB writer thread (queue, latency, group commit, its CPU), the services, the transfers
  const db = b.db
    ? {
        writerCpuPct: pctOf(b.db.writerCpuMs - (a.db?.writerCpuMs ?? 0)),
        entriesPerS: Math.round(((b.db.entries - (a.db?.entries ?? 0)) / dt) * 10) / 10,
        opsPerS: Math.round(((b.db.ops - (a.db?.ops ?? 0)) / dt) * 10) / 10,
        groupsPerS: Math.round(((b.db.groups - (a.db?.groups ?? 0)) / dt) * 10) / 10,
        latencyMs: `${b.db.latencyP50Ms} / ${b.db.latencyP95Ms} / ${b.db.latencyMaxMs}`,
        commitMs: `${b.db.commitP50Ms} / ${b.db.commitP95Ms}`,
        queue: { now: b.db.queued, max: b.db.maxQueued, maxOldestMs: b.db.maxOldestMs },
        groupOps: b.db.groupOps, walMb: b.db.walMb, memDbMb: b.db.memDbMb, restarts: b.db.restarts, divergences: b.db.divergences,
      }
    : undefined
  const services = b.services
    ? Object.fromEntries(Object.entries(b.services as Record<string, { requests: number; p95Ms: number }>).filter(([, v]) => v.requests > 0).map(([k, v]) => [k, `${Math.round(((v.requests - (a.services?.[k]?.requests ?? 0)) / dt) * 10) / 10}/s p95 ${v.p95Ms} ms`]))
    : undefined
  const top = (o: Record<string, { n: number; bytes: number }>) =>
    Object.entries(o).sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 15).map(([t, c]) => ({ t, perS: Math.round((c.n / dt) * 10) / 10, kBps: Math.round(c.bytes / dt / 102.4) / 10 }))
  const report = {
    bots: N, scenario: SCENARIO, online, seconds: Math.round(dt),
    tick: b.tick,
    server: { cpuPct, ...(mainThreadPct !== undefined ? { mainThreadPct } : {}), totalCpuPct, rssMbIdle: idle.process.rssMb, rssMbMax: Math.max(...rss, b.process.rssMb), heapMb: b.process.heapMb },
    ...(gateways.length ? { gateways } : {}),
    ...(aoi ? { aoiJobs: aoi } : {}),
    ...(db ? { db } : {}),
    ...(services ? { services } : {}),
    ...(b.economy ? { economy: b.economy } : {}),
    bandwidth: {
      outKBps: Math.round(b.outTotal.bytes / dt / 102.4) / 10,
      inKBps: Math.round(b.inTotal.bytes / dt / 102.4) / 10,
      outPerPlayerKBps: Math.round(b.outTotal.bytes / dt / online / 102.4) / 10,
      inPerPlayerBps: Math.round(b.inTotal.bytes / dt / online),
      outMsgsPerPlayerS: Math.round((b.outTotal.n / dt / online) * 10) / 10,
    },
    outByType: top(b.out),
    inByType: top(b.in),
    rttMs: { p50: pct(clientStats.rtts, 0.5), p95: pct(clientStats.rtts, 0.95), max: pct(clientStats.rtts, 1), n: clientStats.rtts.length },
    // docs/SERVER_ARCHITECTURE.md P0: the server's own per-phase split, rates, backlog, event loop and switches
    ...(b.phases ? { phases: Object.fromEntries(Object.entries(b.phases.phases as Record<string, { avgMs: number; p95Ms: number }>).map(([k, v]) => [k, `${v.avgMs} / ${v.p95Ms}`])), busyMs: b.phases.busyMs, modules: (b.phases.modules as { name: string; avgMs: number }[]).slice(0, 6) } : {}),
    ...(b.rates ? { rates: b.rates } : {}),
    ...(b.queue ? { queue: b.queue } : {}),
    ...(b.loop ? { loop: b.loop } : {}),
    ...(b.switches ? { switches: b.switches } : {}),
    serverDisconnects: b.disconnects,
    serverDropped: b.dropped,
    botCloses: Object.fromEntries(clientStats.closes),
    botErrors: Object.fromEntries(clientStats.errors),
    botProcessRssMb: Math.round(process.memoryUsage().rss / 1048576),
  }
  const line = (a: { t: string; perS: number; kBps: number }[]) => a.slice(0, 8).map((x) => `${x.t} ${x.perS}/s ${x.kBps} kB/s`).join(', ')
  console.log(JSON.stringify({ ...report, outByType: line(report.outByType), inByType: line(report.inByType) }))
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1))
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    if (PROF) await fetch(`${BASE}/netstats?exit=1`).catch(() => {})
    else server?.kill()
    await sleep(PROF ? 8000 : 1500)
    if (!process.exitCode) try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {}
    process.exit()
  })
