/**
 * Soak test (a script, NOT part of `pnpm test`): the real server (soak-host.ts: src/main.ts's loadConfig + startServer,
 * forked with --expose-gc) on a free port with a temp DATA_DIR and WORLD_EXPORT=jangan-fields, driven for 20 minutes of
 * wall time by 24 bots built on test/helpers.ts's Client:
 *
 *   8 grinders      Grassland south of the gate: walk there, attack, pick up loot, drink potions, die, respawn, walk back;
 *                   buy potions at the Herbalist when they can afford them
 *   6 questers      Act I of "The Tiger's Shadow" (JG_001-JG_006): accept / talk / kill / collect / deliver / turn in,
 *                   sometimes abandon; at the end of the chain they delete the character and start a new one
 *   3 shoppers      town: npcTalk, shop buy / sell / buyback, storage deposit / withdraw / gold
 *   2 party pairs   invite / accept, share kills, party chat, leave, re-invite
 *   2 chatters      local chat and whispers (some to names that are not online)
 *   1 GM caster     `skill all`, then casts every learned skill at monsters (spawning more when none are near)
 *   1 GM editor     the nest editor: `nest add`, `nest near`, `nest undo`
 *
 * plus disconnect/reconnect churn (each bot: 5% per minute, half abrupt socket kills, half leaveWorld + close) and a
 * graceful server restart at 40% of the run (the database must survive and characters re-enter where they were).
 * Bots walk like the client: straight moveTo legs along routes found by an A* over the real navmesh (the server has
 * no path-finding; a click that hits a wall stops there).
 *
 * Every 30 s it samples the server process: RSS, heap used (and after a forced GC), event-loop lag, tick mean / p99 /
 * max, entity counts, the size of every Map/Set of the world and the gameplay modules, open handles, DB/WAL size.
 *
 * Pass criteria: no crash, no unhandled rejection / uncaught exception, no error-level log line, no server_error sent to
 * a client, every restarted character back where it was saved, heap (after GC) growth < 10% over the last 10 minutes
 * after warm-up, tick p99 < 20 ms.
 *
 *   pnpm tsx apps/server/test/soak/soak.ts                     # 20 minutes (see apps/server/README.md "Soak test")
 *   pnpm tsx apps/server/test/soak/soak.ts --minutes 3         # a quick smoke run
 *   options: --minutes N  --restart-at <fraction 0-1, 0 = none>  --sample-s N  --seed N  --out report.json  --keep
 *
 * Exit code 0 when every criterion passes, 1 otherwise. The JSON report (every sample, bot counters, findings) goes to
 * --out (default work/tmp/soak/soak-<time>.json).
 */
import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntityState, ItemStack, MoveState, PartyState, QuestDef, QuestProgress, ServerMessage, Vec3 } from '@sro/shared'
import { runCli } from '../../src/cli/gm.ts'
import { REPO_ROOT } from '../../src/config.ts'
import { openStore } from '../../src/db.ts'
import { MeshNav, type NavPoint } from '../../src/nav.ts'
import { Client, newAccount, sleep } from '../helpers.ts'
import { Planner } from './planner.ts'
import type { HostCommand, HostReport, HostSample } from './soak-host.ts'

// ---- options ------------------------------------------------------------------------------------------------------

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const MINUTES = Number(opt('minutes', '20'))
const RESTART_AT = Number(opt('restart-at', '0.4'))
const SAMPLE_MS = Number(opt('sample-s', '30')) * 1000
const SEED = Number(opt('seed', '1'))
const KEEP = process.argv.includes('--keep')
const DURATION_MS = MINUTES * 60_000
/** Samples taken earlier than this after a server (re)start are warm-up (JIT, caches, first spawns). */
const WARMUP_MS = Math.min(120_000, DURATION_MS / 5)
const CHURN_PER_MIN = 0.05
const TICK_P99_LIMIT_MS = 20
const HEAP_GROWTH_LIMIT = 0.1

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const CONTENT = join(REPO_ROOT, 'content')
const EXPORT = 'jangan-fields'
const HOST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'soak-host.ts')
const REPORT = opt('out', join(REPO_ROOT, 'work/tmp/soak', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))

let seed = SEED >>> 0
/** Seeded so a run's bot choices can be replayed (timing still varies). */
function rnd(): number {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a: number, b: number) => a + rnd() * (b - a)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
const t0 = Date.now()
const clock = () => `${((Date.now() - t0) / 60_000).toFixed(1).padStart(5)}m`
const say = (line: string) => console.log(`[soak ${clock()}] ${line}`)

// ---- the world the bots know (content files, navmesh) ---------------------------------------------------------------

interface NpcPos { code: string; x: number; z: number }
const npcFile = JSON.parse(readFileSync(join(OUT, 'data/npcs.json'), 'utf8')) as { entries: (NpcPos & { world?: string })[] }
const NPCS = new Map(npcFile.entries.filter((n) => (n.world ?? 'jangan') === 'jangan').map((n) => [n.code, n]))
const questFile = JSON.parse(readFileSync(join(CONTENT, 'quests/jangan.json'), 'utf8')) as {
  quests: QuestDef[]
  locations: { id: string; x: number; z: number; radius: number }[]
}
const QUESTS = new Map(questFile.quests.map((q) => [q.id, q]))
const LOCATIONS = new Map(questFile.locations.map((l) => [l.id, l]))
/** The quest chain questers play (Act I up to the ghosts; JG_007 is a side quest far east, JG_008 is level 5). */
const CHAIN = ['JG_001', 'JG_002', 'JG_003', 'JG_004', 'JG_005', 'JG_006']
const MANG = 'MOB_CH_MANGNYANG'
/** The Mangnyang grassland south of the gate (wave3-e2e's FIELD) and the spots the grinders spread over. */
const FIELD = { x: 109, z: 125 }
const FIELD_SPOTS = [{ x: 109, z: 125 }, { x: 90, z: 150 }, { x: 130, z: 110 }, { x: 120, z: 160 }, { x: 85, z: 115 }]
const TOWN_SPOTS = [{ x: 96.9, z: -130 }, { x: 84, z: -110 }, { x: 112, z: -110 }, { x: 150, z: -120 }]
const HP_POTION = 'ITEM_ETC_HP_POTION_01'

const loaded = MeshNav.load([OUT, OUT_OPT], EXPORT)
if (!loaded.nav) throw new Error(`soak: no navmesh for ${EXPORT}: ${loaded.problem}`)
const nav = loaded.nav

const planner = new Planner(nav)

// ---- the server process ------------------------------------------------------------------------------------------

interface Findings {
  crashes: string[]
  faults: string[]
  errorLines: string[]
  stderr: string[]
  serverErrorsToClients: string[]
  protocolErrors: string[]
  restartMismatches: string[]
}
const findings: Findings = { crashes: [], faults: [], errorLines: [], stderr: [], serverErrorsToClients: [], protocolErrors: [], restartMismatches: [] }
/** Log lines that are error-level (every failure path of the server logs one of these shapes). */
const ERROR_LINE = /(tick failed|module \S+ failed|save failed|refresh failed|reload failed|^error handling |^http \w+ \S+: |^gm \S+ by \S+ failed|close failed|Unhandled|Uncaught|FATAL|\n\s+at \S)/

interface Host {
  proc: ChildProcess
  url: string
  startedAt: number
  life: number
  wanted: boolean
  exited: Promise<number | null>
  pending: Map<string, (r: HostReport) => void>
}
let host: Host | null = null
let lives = 0
const samples: (HostSample & { life: number; online: number })[] = []

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function startHost(env: NodeJS.ProcessEnv): Promise<Host> {
  const life = ++lives
  const proc = fork(HOST_SCRIPT, [], {
    env,
    execArgv: [...process.execArgv, '--expose-gc'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const h: Host = {
    proc, url: '', startedAt: Date.now(), life, wanted: false, pending: new Map(),
    exited: new Promise((resolve) => proc.once('exit', (code) => resolve(code))),
  }
  proc.stdout!.on('data', () => {}) // the log lines arrive over IPC too
  let errBuf = ''
  proc.stderr!.on('data', (d: Buffer) => {
    errBuf += d.toString()
    const lines = errBuf.split('\n')
    errBuf = lines.pop()!
    for (const l of lines) if (l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l)) findings.stderr.push(`life ${life}: ${l}`)
  })
  proc.on('message', (raw) => {
    const r = raw as HostReport
    if (r.t === 'log') {
      if (ERROR_LINE.test(r.line)) findings.errorLines.push(`life ${life}: ${r.line.slice(0, 2000)}`)
    } else if (r.t === 'fault') findings.faults.push(`life ${life} ${r.kind}: ${r.message.slice(0, 2000)}`)
    const w = h.pending.get(r.t)
    if (w) {
      h.pending.delete(r.t)
      w(r)
    }
  })
  void h.exited.then((code) => {
    if (!h.wanted) findings.crashes.push(`server life ${life} exited unexpectedly with code ${code} at ${clock()}`)
  })
  const ready = await Promise.race([
    new Promise<HostReport>((resolve) => h.pending.set('ready', resolve)),
    h.exited.then((code) => {
      throw new Error(`soak host exited during startup (code ${code}); stderr: ${findings.stderr.slice(-5).join(' | ')}`)
    }),
  ])
  if (ready.t !== 'ready') throw new Error('unexpected host report')
  h.url = ready.url
  say(`server life ${life} up at ${h.url} (pid ${ready.pid})`)
  return h
}

function ask<T extends HostReport['t']>(h: Host, cmd: HostCommand, reply: T, ms = 15_000): Promise<Extract<HostReport, { t: T }> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      h.pending.delete(reply)
      resolve(null)
    }, ms)
    h.pending.set(reply, (r) => {
      clearTimeout(timer)
      resolve(r as Extract<HostReport, { t: T }>)
    })
    try {
      h.proc.send(cmd)
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

// ---- bots -----------------------------------------------------------------------------------------------------------

class Disconnected extends Error {}

type Role = 'grinder' | 'quester' | 'shopper' | 'party' | 'chatter' | 'gmCaster' | 'gmNest'

interface Ent {
  id: number
  kind: EntityState['kind']
  code: string
  name: string
  level: number
  pos: Vec3
  move: MoveState | null
  dead: boolean
  owner?: number
  ownerUntil?: number
}

const counters = new Map<string, number>()
const count = (k: string, n = 1) => counters.set(k, (counters.get(k) ?? 0) + n)
const bots: Bot[] = []
let url = ''
let serverDown = false
let finished = false
/** Character id -> position saved at the restart (checked on the first re-entry). */
const restartSnapshot = new Map<number, { x: number; y: number; z: number; name: string }>()

class Bot {
  c: Client | null = null
  token = ''
  username = ''
  charId = 0
  charName = ''
  selfId = 0
  pos: Vec3 = [0, 0, 0]
  move: MoveState | null = null
  dead = false
  hp = 1
  maxHp = 1
  level = 1
  gold = 0
  statPoints = 0
  bag: (ItemStack | null)[] = []
  ents = new Map<number, Ent>()
  quests = new Map<string, QuestProgress>()
  done = new Set<string>()
  party: PartyState | null = null
  invitedBy: number | null = null
  skills: string[] = []
  dialog: number | null = null
  storageOpen = false
  buyback = 0
  inWorld = false
  down = false
  reconnects = 0
  potionAt = 0
  lastShopAt = 0
  badTargets = new Map<number, number>()
  pair: Pair | null = null
  rerolls = 0

  constructor(
    readonly role: Role,
    readonly index: number,
    readonly localAddress: string,
  ) {}

  get label(): string {
    return `${this.role}#${this.index}`
  }

  // ---- connection -----------------------------------------------------------------------------------------------

  private attach(c: Client): void {
    c.ws.on('error', () => {})
    c.ws.on('close', (code, reason) => count(`close.${code}${reason.length ? `.${reason.toString().replace(/\s+/g, '_')}` : ''}`))
    c.ws.on('message', (data) => {
      let m: ServerMessage
      try {
        m = JSON.parse(data.toString()) as ServerMessage
      } catch {
        return
      }
      try {
        this.onMsg(m)
      } catch (e) {
        findings.protocolErrors.push(`${this.label} handling ${m.t}: ${(e as Error).message}`)
      }
    })
  }

  async connect(): Promise<void> {
    const c = await Client.login(url, this.token, { localAddress: this.localAddress })
    this.attach(c)
    this.c = c
    this.down = false
  }

  /** Enters the world with `charId`; resets the world view. */
  async enter(): Promise<void> {
    const c = this.need()
    this.ents.clear()
    this.quests.clear()
    this.done.clear()
    this.party = null
    this.dialog = null
    this.inWorld = false
    purge(c, 'worldEnter')
    purge(c, 'quests')
    c.send({ t: 'enterWorld', id: this.charId })
    const w = await this.wait(c.next('worldEnter', () => true, 15_000))
    // the quest log follows the enter sequence; a step that ran before it would re-offer finished quests
    const quests = await this.wait(c.next('quests', () => true, 15_000))
    this.quests = new Map(quests.active.map((q) => [q.quest, q]))
    this.done = new Set(quests.done.map((d) => d.quest))
    this.selfId = w.self.id
    this.pos = [...w.self.pos]
    this.move = null
    this.dead = w.self.state === 'dead'
    this.hp = w.self.hp ?? 1
    this.maxHp = w.self.maxHp ?? 1
    for (const e of w.entities) this.see(e)
    this.inWorld = true
    const snap = restartSnapshot.get(this.charId)
    if (snap) {
      restartSnapshot.delete(this.charId)
      const d = Math.hypot(w.self.pos[0] - snap.x, w.self.pos[2] - snap.z)
      count('restart.reentered')
      if (d > 1 || Math.abs(w.self.pos[1] - snap.y) > 1) {
        findings.restartMismatches.push(`${snap.name}: saved ${snap.x.toFixed(2)},${snap.y.toFixed(2)},${snap.z.toFixed(2)} re-entered ${w.self.pos.map((v) => v.toFixed(2)).join(',')} (${d.toFixed(2)} m)`)
      }
    }
  }

  need(): Client {
    const c = this.c
    if (!c || c.isClosed) throw new Disconnected()
    return c
  }

  /** Awaits `p`, turning a closed socket into Disconnected. */
  async wait<T>(p: Promise<T>): Promise<T> {
    try {
      return await p
    } catch (e) {
      if (!this.c || this.c.isClosed) throw new Disconnected()
      throw e
    }
  }

  /** Drops the connection (churn): half an abrupt socket kill, half a polite leaveWorld + close. */
  drop(): void {
    const c = this.c
    if (!c || c.isClosed) return
    count('churn.disconnects')
    if (rnd() < 0.5) c.ws.terminate()
    else {
      try {
        c.send({ t: 'leaveWorld' })
      } catch {
        // closing anyway
      }
      setTimeout(() => c.close(), 200)
    }
  }

  // ---- messages ---------------------------------------------------------------------------------------------------

  private see(e: EntityState): void {
    this.ents.set(e.id, {
      id: e.id, kind: e.kind, code: e.npc ?? e.model, name: e.name, level: e.level, pos: [...e.pos], move: e.move ?? null,
      dead: e.state === 'dead', owner: e.owner, ownerUntil: e.ownerUntil,
    })
  }

  private onMsg(m: ServerMessage): void {
    switch (m.t) {
      case 'spawn':
        this.see(m.entity)
        break
      case 'despawn':
        this.ents.delete(m.id)
        break
      case 'move':
        if (m.id === this.selfId) this.move = m.move
        else {
          const e = this.ents.get(m.id)
          if (e) e.move = m.move
        }
        break
      case 'stop':
      case 'warp':
        if (m.id === this.selfId) {
          this.pos = [...m.pos]
          this.move = null
        } else {
          const e = this.ents.get(m.id)
          if (e) {
            e.pos = [...m.pos]
            e.move = null
          }
        }
        break
      case 'entityUpdate': {
        if (m.id === this.selfId) {
          if (m.hp !== undefined) this.hp = m.hp
          if (m.maxHp !== undefined) this.maxHp = m.maxHp
          if (m.state) this.dead = m.state === 'dead'
          if (m.level !== undefined) this.level = m.level
        } else {
          const e = this.ents.get(m.id)
          if (e && m.state) e.dead = m.state === 'dead'
        }
        break
      }
      case 'stats':
        this.hp = m.stats.hp
        this.maxHp = m.stats.maxHp
        this.level = m.stats.level
        this.gold = m.stats.gold
        this.statPoints = m.stats.statPoints
        break
      case 'statsDelta':
        if (m.stats.hp !== undefined) this.hp = m.stats.hp
        if (m.stats.maxHp !== undefined) this.maxHp = m.stats.maxHp
        if (m.stats.level !== undefined) this.level = m.stats.level
        if (m.stats.gold !== undefined) this.gold = m.stats.gold
        if (m.stats.statPoints !== undefined) this.statPoints = m.stats.statPoints
        break
      case 'inventory':
        this.bag = [...m.inventory.bag]
        this.gold = m.inventory.gold
        break
      case 'inventoryUpdate':
        for (const u of m.bag ?? []) this.bag[u.slot] = u.item
        if (m.gold !== undefined) this.gold = m.gold
        break
      case 'quests':
        this.quests = new Map(m.active.map((q) => [q.quest, q]))
        this.done = new Set(m.done.map((d) => d.quest))
        break
      case 'questUpdate':
        if (m.progress) this.quests.set(m.quest, m.progress)
        else this.quests.delete(m.quest)
        if (m.done) this.done.add(m.done.quest)
        if (m.event === 'completed') count('quest.completed')
        break
      case 'party':
        this.party = m.party
        break
      case 'partyInvited':
        this.invitedBy = m.inviter
        break
      case 'skills':
        this.skills = [...m.skills]
        break
      case 'skillsUpdate':
        for (const s of m.learned ?? []) if (!this.skills.includes(s)) this.skills.push(s)
        break
      case 'npcDialog':
        this.dialog = m.npc
        break
      case 'npcDialogClose':
        this.dialog = null
        this.storageOpen = false
        break
      case 'storage':
        this.storageOpen = true
        break
      case 'buyback':
        this.buyback = m.entries.length
        break
      case 'worldLeft':
        this.inWorld = false
        break
      case 'chat':
        if (m.channel === 'whisper' && m.to === undefined) count('chat.whispersReceived')
        break
      case 'error':
        count(`error.${m.code}`)
        if (m.code === 'server_error') findings.serverErrorsToClients.push(`${this.label} ${m.re ?? ''}: ${m.message}`)
        break
    }
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------

  posNow(): Vec3 {
    const m = this.move
    if (!m) return this.pos
    return lerp(m, Date.now())
  }

  entPos(e: Ent): Vec3 {
    return e.move ? lerp(e.move, Date.now()) : e.pos
  }

  moving(): boolean {
    const m = this.move
    return !!m && Date.now() < arrival(m) + 150
  }

  /** Polls `fn` every 100 ms until it holds (true), the time runs out (false) or the socket closes (Disconnected). */
  async until(fn: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms
    for (;;) {
      this.need()
      if (fn()) return true
      if (Date.now() > end) return false
      await sleep(100)
    }
  }

  /** One request; its actionResult (null on a timeout). */
  async act(msg: Record<string, unknown> & { t: string }, ms = 6000): Promise<{ ok: boolean; reason?: string } | null> {
    const c = this.need()
    purge(c, 'actionResult', (m) => m.re === msg.t)
    c.send(msg)
    try {
      const r = await this.wait(c.next('actionResult', (m) => m.re === msg.t, ms))
      count(`act.${msg.t}.${r.ok ? 'ok' : (r.reason ?? 'fail')}`)
      return r
    } catch (e) {
      if (e instanceof Disconnected) throw e
      count(`act.${msg.t}.timeout`)
      return null
    }
  }

  async gm(cmd: string, ...args: string[]): Promise<{ ok: boolean; message: string; data?: unknown } | null> {
    const c = this.need()
    purge(c, 'gmResult', (m) => m.cmd === cmd)
    c.send({ t: 'gm', cmd, args })
    try {
      const r = await this.wait(c.next('gmResult', (m) => m.cmd === cmd, 10_000))
      count(`gm.${cmd}.${r.ok ? 'ok' : 'fail'}`)
      return r
    } catch (e) {
      if (e instanceof Disconnected) throw e
      count(`gm.${cmd}.timeout`)
      return null
    }
  }

  navPoint(): NavPoint | null {
    const p = this.posNow()
    return nav.locate(p[0], p[2], p[1]) ?? nav.place(p[0], p[2], p[1], 3)
  }

  /** Walks to x/z along a planned route of straight moveTo legs. false: dead, stuck or no route. */
  async travel(x: number, z: number, near = 2): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.dead) return false
      const here = this.posNow()
      if (Math.hypot(here[0] - x, here[2] - z) <= near) return true
      const from = this.navPoint()
      const route = from ? planner.route(from, x, z) : null
      if (!route) {
        count('travel.noRoute')
        return false
      }
      let ok = true
      for (const wp of route) {
        if (!(await this.walkLeg(wp.x, wp.z))) {
          ok = false
          break
        }
      }
      if (ok) return true
      count('travel.replan')
    }
    count('travel.stuck')
    return false
  }

  private async walkLeg(x: number, z: number): Promise<boolean> {
    const c = this.need()
    const p = this.posNow()
    const d = Math.hypot(p[0] - x, p[2] - z)
    if (d < 0.5) return true
    c.send({ t: 'moveTo', x, z })
    count('moveTo')
    await sleep(150)
    await this.until(() => !this.moving() || this.dead, (d / 5.5) * 1000 * 1.6 + 3000)
    const q = this.posNow()
    return !this.dead && Math.hypot(q[0] - x, q[2] - z) < 1.5
  }

  nearest(filter: (e: Ent) => boolean, range: number): Ent | null {
    const me = this.posNow()
    let best: Ent | null = null
    let bd = range
    const now = Date.now()
    for (const e of this.ents.values()) {
      if (!filter(e)) continue
      if ((this.badTargets.get(e.id) ?? 0) > now) continue
      const p = this.entPos(e)
      const d = Math.hypot(p[0] - me[0], p[2] - me[2])
      if (d < bd) {
        bd = d
        best = e
      }
    }
    return best
  }

  npcEnt(code: string): Ent | null {
    for (const e of this.ents.values()) if (e.kind === 'npc' && e.code === code) return e
    return null
  }

  /** Walks next to an NPC, then talks to it (the server walks the last metres). Its entity id, or null. */
  async visit(code: string): Promise<number | null> {
    const n = NPCS.get(code)
    if (!n) return null
    await this.travel(n.x, n.z, 5)
    const e = this.npcEnt(code)
    if (!e) {
      count('npc.notSeen')
      return null
    }
    this.dialog = null
    const r = await this.act({ t: 'npcTalk', npc: e.id })
    if (!r?.ok) return null
    if (!(await this.until(() => this.dialog === e.id, 12_000))) {
      count('npc.noDialog')
      return null
    }
    return e.id
  }

  async closeDialog(): Promise<void> {
    if (this.dialog !== null) await this.act({ t: 'npcClose' })
  }

  slotOf(pred: (i: ItemStack) => boolean): number {
    return this.bag.findIndex((i) => i !== null && i !== undefined && pred(i))
  }

  async respawnIfDead(): Promise<boolean> {
    if (!this.dead) return false
    count('deaths')
    await sleep(between(2000, 5000))
    const r = await this.act({ t: 'respawn' })
    if (r?.ok) await this.until(() => !this.dead, 8000)
    return true
  }

  /** Fights `target` until it dies (drinking potions), then loots. */
  async fight(target: Ent, codes?: readonly string[]): Promise<boolean> {
    const r = await this.act({ t: 'attack', target: target.id })
    if (!r?.ok) {
      this.badTargets.set(target.id, Date.now() + 60_000)
      return false
    }
    const started = Date.now()
    let killed = false
    await this.until(() => {
      if (this.dead) return true
      const e = this.ents.get(target.id)
      if (!e || e.dead) {
        killed = !!e?.dead || !this.ents.has(target.id)
        return true
      }
      if (this.hp < this.maxHp * 0.45 && Date.now() - this.potionAt > 1500) void this.drink()
      return Date.now() - started > 30_000
    }, 31_000)
    if (!killed) {
      this.badTargets.set(target.id, Date.now() + 30_000)
      if (!this.dead) await this.act({ t: 'stopAction' })
      return false
    }
    count('kills')
    void codes
    await this.loot()
    return true
  }

  async drink(): Promise<void> {
    const at = this.slotOf((i) => i.code.startsWith('ITEM_ETC_HP_POTION'))
    if (at < 0) return
    this.potionAt = Date.now()
    await this.act({ t: 'itemUse', bag: at }).catch(() => null)
  }

  async loot(): Promise<void> {
    await sleep(400)
    for (let i = 0; i < 3; i++) {
      const now = Date.now()
      const item = this.nearest((e) => e.kind === 'item' && (e.owner === undefined || e.owner === this.selfId || (e.ownerUntil ?? 0) < now), 12)
      if (!item) return
      const r = await this.act({ t: 'pickup', id: item.id })
      if (!r?.ok) {
        this.badTargets.set(item.id, Date.now() + 60_000)
        continue
      }
      if (await this.until(() => !this.ents.has(item.id), 6000)) count('pickups')
      else this.badTargets.set(item.id, Date.now() + 60_000)
    }
  }

  /** One grind step near `spot` against `codes` (any monster of level <= own + 2 when absent). */
  async grind(spot: { x: number; z: number }, codes?: readonly string[], radius = 45): Promise<void> {
    const me = this.posNow()
    if (Math.hypot(me[0] - spot.x, me[2] - spot.z) > radius + 15) {
      await this.travel(spot.x + between(-10, 10), spot.z + between(-10, 10), 4)
      return
    }
    const target = this.nearest((e) => e.kind === 'mob' && !e.dead && (codes ? codes.includes(e.code) : e.level <= this.level + 2), 40)
    if (!target) {
      await this.travel(spot.x + between(-radius, radius), spot.z + between(-radius, radius), 4)
      return
    }
    await this.fight(target, codes)
    if (this.statPoints > 0 && rnd() < 0.5) await this.act({ t: 'statUp', stat: 'str', points: 1 })
  }

  /** Buys HP potions at the Herbalist when it can afford them and runs low. */
  async restock(): Promise<void> {
    const have = this.bag.reduce((n, i) => n + (i?.code.startsWith('ITEM_ETC_HP_POTION') ? i.count : 0), 0)
    if (have >= 3 || this.gold < 600 || Date.now() - this.lastShopAt < 4 * 60_000) return
    this.lastShopAt = Date.now()
    const npc = await this.visit('NPC_CH_POTION')
    if (npc === null) return
    await this.act({ t: 'shopBuy', npc, item: HP_POTION, count: Math.min(20, Math.floor(this.gold / 60)) })
    await this.closeDialog()
  }
}

interface Pair { leader: Bot; member: Bot; spot: { x: number; z: number }; since: number; leftAt: number }

function purge<T extends ServerMessage['t']>(c: Client, t: T, where: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true): void {
  for (let i = c.queue.length - 1; i >= 0; i--) {
    const m = c.queue[i]!
    if (m.t === t && where(m as Extract<ServerMessage, { t: T }>)) c.queue.splice(i, 1)
  }
}

function arrival(m: MoveState): number {
  return m.startedAt + (Math.hypot(m.to[0] - m.from[0], m.to[2] - m.from[2]) / m.speed) * 1000
}

function lerp(m: MoveState, now: number): Vec3 {
  const d = Math.hypot(m.to[0] - m.from[0], m.to[2] - m.from[2])
  const f = d <= 0 ? 1 : Math.min(1, Math.max(0, ((now - m.startedAt) / 1000) * m.speed / d))
  return [m.from[0] + (m.to[0] - m.from[0]) * f, m.from[1] + (m.to[1] - m.from[1]) * f, m.from[2] + (m.to[2] - m.from[2]) * f]
}

// ---- behaviours (one step each; the loop repeats them) ----------------------------------------------------------------

async function grinderStep(b: Bot): Promise<void> {
  if (await b.respawnIfDead()) return
  await b.restock()
  await b.grind(FIELD_SPOTS[b.index % FIELD_SPOTS.length]!, [MANG])
}

async function questerStep(b: Bot): Promise<void> {
  if (await b.respawnIfDead()) return
  const id = CHAIN.find((q) => !b.done.has(q))
  if (!id) return reroll(b)
  const def = QUESTS.get(id)!
  const active = b.quests.get(id)
  if (!active) {
    if (b.level < def.level) return b.grind(FIELD, [MANG])
    const npc = await b.visit(def.giver)
    if (npc === null) return
    await b.act({ t: 'questAccept', npc, quest: id })
    await b.closeDialog()
    return
  }
  if (active.status === 'ready') {
    const npc = await b.visit(def.turnIn)
    if (npc === null) return
    const r = await b.act(def.rewards.choice?.length ? { t: 'questTurnIn', npc, quest: id, choice: Math.floor(rnd() * def.rewards.choice.length) } : { t: 'questTurnIn', npc, quest: id })
    if (r?.ok) count('quest.turnedIn')
    await b.closeDialog()
    return
  }
  // now and then someone gives up on a hunt and takes it again later
  if (rnd() < 0.01 && def.objectives.some((o) => o.type === 'kill' || o.type === 'collect')) {
    await b.act({ t: 'questAbandon', quest: id })
    return
  }
  const obj = def.objectives.find((o) => (active.counts[o.id] ?? 0) < ('count' in o && typeof o.count === 'number' ? o.count : 1))
  if (!obj) {
    await sleep(1000)
    return
  }
  if (obj.type === 'kill' || obj.type === 'collect') {
    const codes = obj.type === 'kill' ? obj.mobs : obj.from.map((f) => f.mob)
    const loc = (obj.hint && LOCATIONS.get(obj.hint)) || { x: FIELD.x, z: FIELD.z, radius: 50 }
    const until = Date.now() + 90_000
    while (Date.now() < until && !b.dead && b.quests.get(id)?.status === 'active') await b.grind(loc, codes, Math.min(60, loc.radius))
  } else if (obj.type === 'deliver') {
    const npc = await b.visit(obj.npc)
    if (npc === null) return
    await b.act({ t: 'questTalk', npc, quest: id, objective: obj.id })
    await b.closeDialog()
  } else if (obj.type === 'reach') {
    const loc = LOCATIONS.get(obj.location)
    if (loc) await b.travel(loc.x, loc.z, Math.max(3, loc.radius / 2))
  } else await sleep(2000)
}

/** The end of the chain: a new character (leaveWorld, charDelete, charCreate, enterWorld). */
async function reroll(b: Bot): Promise<void> {
  const c = b.need()
  purge(c, 'worldLeft')
  c.send({ t: 'leaveWorld' })
  await b.wait(c.next('worldLeft', () => true, 10_000))
  purge(c, 'charDeleted')
  c.send({ t: 'charDelete', id: b.charId })
  await b.wait(c.next('charDeleted', () => true, 10_000))
  b.charName = `SkQ${b.index}r${++b.rerolls}`
  purge(c, 'charCreated')
  c.send({ t: 'charCreate', name: b.charName, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: pick(['sword', 'blade', 'spear', 'bow'] as const) })
  b.charId = (await b.wait(c.next('charCreated', () => true, 10_000))).character.id
  count('quest.rerolls')
  await b.enter()
}

async function shopperStep(b: Bot): Promise<void> {
  if (await b.respawnIfDead()) return
  const r = rnd()
  if (r < 0.45) {
    const npc = await b.visit('NPC_CH_POTION')
    if (npc === null) return
    await b.act({ t: 'shopBuy', npc, item: pick([HP_POTION, 'ITEM_ETC_MP_POTION_01', 'ITEM_ETC_HP_POTION_02']), count: Math.ceil(between(1, 15)) })
    const at = b.slotOf((i) => i.code.startsWith('ITEM_ETC_'))
    if (at >= 0) {
      b.buyback = 0
      const sold = await b.act({ t: 'shopSell', npc, bag: at, count: 1 })
      if (sold?.ok && (await b.until(() => b.buyback > 0, 3000)) && rnd() < 0.7) await b.act({ t: 'shopBuyback', npc, index: b.buyback - 1 })
    }
    await b.closeDialog()
  } else if (r < 0.85) {
    const npc = await b.visit('NPC_CH_WAREHOUSE_W')
    if (npc === null) return
    b.storageOpen = false
    const open = await b.act({ t: 'storageOpen', npc })
    if (open?.ok && (await b.until(() => b.storageOpen, 4000))) {
      const at = b.slotOf((i) => i.code.startsWith('ITEM_ETC_'))
      if (at >= 0) {
        const dep = await b.act({ t: 'storageDeposit', npc, bag: at, count: 1 })
        if (dep?.ok) await b.act({ t: 'storageWithdraw', npc, slot: 0, count: 1 })
      }
      await b.act({ t: 'storageGold', npc, dir: 'deposit', amount: 100 })
      await b.act({ t: 'storageGold', npc, dir: 'withdraw', amount: 100 })
    }
    await b.closeDialog()
  } else {
    const spot = pick(TOWN_SPOTS)
    await b.travel(spot.x + between(-4, 4), spot.z + between(-4, 4), 2)
  }
  await sleep(between(2000, 8000))
}

async function partyStep(b: Bot): Promise<void> {
  const pair = b.pair!
  if (await b.respawnIfDead()) return
  const leader = b === pair.leader
  const partner = leader ? pair.member : pair.leader
  if (!leader && b.invitedBy !== null && !b.party) {
    const inviter = b.invitedBy
    b.invitedBy = null
    const r = await b.act({ t: 'partyRespond', inviter, accept: true })
    if (r?.ok) {
      pair.since = Date.now()
      count('party.joined')
    }
  }
  if (leader && !b.party && partner.selfId && b.ents.has(partner.selfId) && Date.now() - pair.leftAt > 45_000 && rnd() < 0.5) {
    await b.act({ t: 'partyInvite', target: partner.selfId, exp: pick(['share', 'free'] as const), items: pick(['free', 'share'] as const) })
  }
  if (b.party && rnd() < 0.05) {
    b.need().send({ t: 'chat', text: pick(['pull the next one', 'hp low', 'nice drop', 'one more', 'heading back']), channel: 'party' })
    count('chat.party')
  }
  if (!leader && b.party && Date.now() - pair.since > between(180_000, 360_000)) {
    const r = await b.act({ t: 'partyLeave' })
    if (r?.ok) {
      pair.leftAt = Date.now()
      count('party.left')
    }
  }
  // share kills: the member fights what the leader fights
  const leaderTarget = !leader && b.party ? partner.nearest((e) => e.kind === 'mob' && !e.dead && b.ents.has(e.id), 6) : null
  if (leaderTarget && rnd() < 0.7) {
    await b.fight(b.ents.get(leaderTarget.id)!)
    return
  }
  await b.grind(pair.spot, [MANG], 30)
}

const CHAT_LINES = ['anyone selling hp pots?', 'lfg mangyang', 'where is the herbalist', 'wts blade', 'gz', 'brb', 'how do I get to the tomb']

async function chatterStep(b: Bot): Promise<void> {
  if (await b.respawnIfDead()) return
  const spot = pick(TOWN_SPOTS)
  await b.travel(spot.x + between(-5, 5), spot.z + between(-5, 5), 2)
  for (let i = 0; i < 3; i++) {
    const c = b.need()
    const r = rnd()
    if (r < 0.5) {
      c.send({ t: 'chat', text: pick(CHAT_LINES) })
      count('chat.local')
    } else {
      const online = bots.filter((x) => x !== b && x.inWorld && x.charName)
      const to = r < 0.9 && online.length ? pick(online).charName : 'Nobodyhome'
      c.send({ t: 'chat', text: `psst ${pick(CHAT_LINES)}`, to })
      count('chat.whisper')
    }
    await sleep(between(3000, 8000))
  }
}

let casterReady = false
async function gmCasterStep(b: Bot): Promise<void> {
  if (await b.respawnIfDead()) {
    casterReady = false
    return
  }
  if (!casterReady) {
    await b.gm('skill', 'all')
    await b.gm('tp', '130', '150')
    await b.until(() => b.skills.length > 0, 3000)
    casterReady = true
  }
  const me = b.posNow()
  if (Math.hypot(me[0] - 130, me[2] - 150) > 60) {
    await b.gm('tp', '130', '150')
    return
  }
  let target = b.nearest((e) => e.kind === 'mob' && !e.dead, 30)
  if (!target) {
    await b.gm('spawn', MANG, '3')
    await sleep(500)
    target = b.nearest((e) => e.kind === 'mob' && !e.dead, 30)
    if (!target) return
  }
  for (let i = 0; i < 8 && !b.dead; i++) {
    const skill = b.skills.length ? pick(b.skills) : null
    if (!skill || rnd() < 0.15) await b.act({ t: 'attack', target: target.id })
    else await b.act({ t: 'useSkill', skill, target: target.id })
    await sleep(between(500, 1500))
    if (!b.ents.has(target.id) || b.ents.get(target.id)!.dead) break
  }
  if (rnd() < 0.1) await b.gm('skill', 'cooldown')
  if (rnd() < 0.05) await b.gm('heal')
}

let nestAdded = 0
async function gmNestStep(b: Bot): Promise<void> {
  if (await b.respawnIfDead()) return
  const me = b.posNow()
  if (Math.hypot(me[0] - 60, me[2] - 200) > 40) {
    await b.gm('tp', String(60 + between(-10, 10)), String(200 + between(-10, 10)))
    return
  }
  const r = rnd()
  if (r < 0.45 && nestAdded < 3) {
    const res = await b.gm('nest', 'add', pick(['MOB_CH_GYO', MANG, 'MOB_CH_BIGEYEGHOST_CLON']), String(Math.ceil(between(2, 8))), String(Math.ceil(between(10, 25))))
    if (res?.ok) nestAdded++
  } else if (r < 0.85 && nestAdded > 0) {
    const res = await b.gm('nest', 'undo')
    if (res?.ok) nestAdded--
  } else await b.gm('nest', 'near', '60')
  await sleep(between(8000, 20_000))
}

const STEP: Record<Role, (b: Bot) => Promise<void>> = {
  grinder: grinderStep, quester: questerStep, shopper: shopperStep, party: partyStep, chatter: chatterStep, gmCaster: gmCasterStep, gmNest: gmNestStep,
}

/** A bot's life: (re)connect, enter, run its behaviour; on a lost socket wait and reconnect. */
async function runBot(b: Bot): Promise<void> {
  let firstEnter = true
  while (!finished) {
    try {
      if (!b.c || b.c.isClosed) {
        await b.connect()
        await b.enter()
        if (!firstEnter) {
          b.reconnects++
          count('reconnects')
        }
        firstEnter = false
      }
      await STEP[b.role](b)
    } catch (e) {
      b.inWorld = false
      if (finished) return
      const msg = String((e as Error)?.message)
      if (e instanceof Disconnected) count('bot.lost.disconnected')
      else if (/ECONNREFUSED|ECONNRESET|socket hang up/.test(msg)) count('bot.lost.connect')
      else if (/\(closed\)/.test(msg)) count('bot.lost.closedWhileWaiting')
      else {
        count('bot.errors')
        if ((counters.get('bot.errors') ?? 0) <= 20) say(`${b.label} (${b.charName}) step failed: ${(e as Error)?.message?.slice(0, 300)}`)
      }
      b.c?.close()
      b.down = true
      // churn: 2-15 s offline; while the server restarts, retry every second
      await sleep(serverDown ? 1000 : between(2000, 15_000))
    }
  }
}

// ---- main -------------------------------------------------------------------------------------------------------------

const MIX: [Role, number][] = [['grinder', 8], ['quester', 6], ['shopper', 3], ['party', 4], ['chatter', 2], ['gmCaster', 1], ['gmNest', 1]]

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sro-soak-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    WORLD_EXPORT: EXPORT,
    OUT_DIR: OUT,
    OUT_OPT_DIR: OUT_OPT,
    CONTENT_DIR: CONTENT,
    SERVE_STATIC: '0',
    REGISTER_LIMIT: '10000',
    NODE_ENV: '',
  }
  say(`${MINUTES} min, restart at ${RESTART_AT > 0 ? `${(RESTART_AT * MINUTES).toFixed(1)} min` : 'never'}, DATA_DIR ${dataDir}`)
  host = await startHost(env)
  url = host.url

  // accounts and characters (8 grinders, 6 questers, ...), each bot on its own loopback address like a friend's own IP
  let n = 0
  for (const [role, k] of MIX) for (let i = 0; i < k; i++) bots.push(new Bot(role, i, `127.0.0.${10 + n++}`))
  const pairs: Pair[] = []
  const partyBots = bots.filter((b) => b.role === 'party')
  for (let i = 0; i + 1 < partyBots.length; i += 2) {
    const p: Pair = { leader: partyBots[i]!, member: partyBots[i + 1]!, spot: FIELD_SPOTS[(i / 2 + 2) % FIELD_SPOTS.length]!, since: 0, leftAt: 0 }
    p.leader.pair = p
    p.member.pair = p
    pairs.push(p)
  }
  for (const b of bots) {
    const acc = await newAccount(url, 'soak')
    b.token = acc.token
    b.username = acc.username
    await b.connect()
    b.charName = `Sk${b.role.slice(0, 3)}${b.index}`.replace(/^Skgm/, 'SkG')
    const c = b.need()
    c.send({ t: 'charCreate', name: b.charName, model: pick(['CHAR_CH_MAN_ADVENTURER', 'CHAR_CH_WOMAN_ADVENTURER']), weapon: pick(['sword', 'blade', 'spear', 'bow'] as const) })
    b.charId = (await c.next('charCreated', () => true, 10_000)).character.id
    c.close()
    await c.closed
  }
  // owner-side setup, as `pnpm gm grant` and a starting purse (the server notices the role change by itself)
  const store = openStore(dataDir)
  const setGold = store.db.prepare('UPDATE characters SET gold = ? WHERE id = ?')
  for (const b of bots) {
    if (b.role === 'shopper') setGold.run(200_000, b.charId)
    else if (b.role !== 'chatter') setGold.run(2_000, b.charId)
    if (b.role === 'gmCaster' || b.role === 'gmNest') runCli(['grant', b.username], { ...process.env, DATA_DIR: dataDir }, () => {}, (l) => say(l))
  }
  store.close()

  const runs = bots.map((b, i) => sleep(i * 250).then(() => runBot(b)))
  const end = t0 + DURATION_MS
  const restartAt = RESTART_AT > 0 ? t0 + DURATION_MS * RESTART_AT : Infinity
  let restarted = false
  let nextSample = Date.now() + SAMPLE_MS
  let nextChurn = Date.now() + 60_000
  const queueTrim = setInterval(() => {
    for (const b of bots) {
      const c = b.c
      if (!c) continue
      c.log.length = 0
      if (c.queue.length > 400) c.queue.splice(0, c.queue.length - 100)
    }
  }, 2000)
  const pinger = setInterval(() => {
    for (const b of bots) if (b.c && !b.c.isClosed) b.c.send({ t: 'ping', n: 1, clientTime: Date.now() })
  }, 5000)

  while (Date.now() < end) {
    await sleep(500)
    const h = host!
    if (Date.now() >= nextSample) {
      nextSample += SAMPLE_MS
      const r = await ask(h, { t: 'sample' }, 'sample')
      if (r) {
        const online = bots.filter((b) => b.inWorld).length
        samples.push({ ...r.sample, life: h.life, online })
        const s = r.sample
        say(
          `life ${h.life} up ${String(s.uptimeS).padStart(4)}s rss ${s.rssMb.toFixed(0)} MB heap ${s.heapUsedMb.toFixed(1)} (gc ${s.heapAfterGcMb.toFixed(1)}) MB ` +
          `lag p99 ${s.lagP99Ms} max ${s.lagMaxMs} ms tick mean ${s.tickMeanMs} p99 ${s.tickP99Ms} max ${s.tickMaxMs} ms | ` +
          `players ${s.entities.players} mobs ${s.entities.mobs} items ${s.entities.items} bots-in-world ${online} | ` +
          `handles ${Object.entries(s.handles).map(([k, v]) => `${k}:${v}`).join(' ')} | db ${s.dbMb} wal ${s.walMb} MB`,
        )
      } else say('sample timed out')
    }
    if (Date.now() >= nextChurn) {
      nextChurn += 60_000
      for (const b of bots) if (rnd() < CHURN_PER_MIN) setTimeout(() => !serverDown && !finished && b.drop(), between(0, 55_000))
    }
    if (!restarted && Date.now() >= restartAt) {
      restarted = true
      const pos = await ask(h, { t: 'positions' }, 'positions')
      say(`restart: ${pos?.players.length ?? 0} characters in the world; graceful shutdown`)
      serverDown = true
      h.wanted = true
      restartSnapshot.clear()
      const closed = ask(h, { t: 'shutdown' }, 'closed', 20_000)
      // positions were read just before close() persisted them; a walker moves a little in between (checked within 1 m)
      for (const p of pos?.players ?? []) if (!p.dead) restartSnapshot.set(p.characterId, { x: p.x, y: p.y, z: p.z, name: p.name })
      await closed
      const code = await h.exited
      say(`server life ${h.life} exited with ${code}`)
      await sleep(2000)
      host = await startHost(env)
      serverDown = false
      nextSample = Date.now() + SAMPLE_MS
    }
  }

  // wind down: final sample, stop bots, stop the server
  const last = await ask(host!, { t: 'sample' }, 'sample')
  if (last) samples.push({ ...last.sample, life: host!.life, online: bots.filter((b) => b.inWorld).length })
  finished = true
  clearInterval(queueTrim)
  clearInterval(pinger)
  for (const b of bots) b.c?.close()
  await Promise.race([Promise.all(runs), sleep(15_000)])
  host!.wanted = true
  await ask(host!, { t: 'shutdown' }, 'closed', 20_000)
  await Promise.race([host!.exited, sleep(10_000)])
  host!.proc.kill()

  const report = analyse()
  mkdirSync(dirname(REPORT), { recursive: true })
  writeFileSync(REPORT, JSON.stringify({ ...report, samples: samples.map(({ tickDurations, ...s }) => { void tickDurations; return s }) }, null, 1))
  say(`report: ${REPORT}`)
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else say(`kept ${root}`)
  process.exit(report.pass ? 0 : 1)
}

function regressionGrowth(xs: { at: number; v: number }[]): { perTenMin: number; first: number; last: number } | null {
  if (xs.length < 3) return null
  const n = xs.length
  const mx = xs.reduce((a, p) => a + p.at, 0) / n
  const my = xs.reduce((a, p) => a + p.v, 0) / n
  let num = 0
  let den = 0
  for (const p of xs) {
    num += (p.at - mx) * (p.v - my)
    den += (p.at - mx) ** 2
  }
  const slope = den > 0 ? num / den : 0
  return { perTenMin: (slope * 600_000) / xs[0]!.v, first: xs[0]!.v, last: xs[n - 1]!.v }
}

function analyse() {
  const warm = samples.filter((s) => s.uptimeS * 1000 >= WARMUP_MS)
  const ticks = warm.flatMap((s) => s.tickDurations).sort((a, b) => a - b)
  const p = (q: number) => (ticks.length ? ticks[Math.min(ticks.length - 1, Math.floor(ticks.length * q))]! : 0)
  const tick = { n: ticks.length, mean: ticks.reduce((a, b) => a + b, 0) / Math.max(1, ticks.length), p50: p(0.5), p99: p(0.99), p999: p(0.999), max: ticks.at(-1) ?? 0 }
  const endAt = samples.at(-1)?.at ?? Date.now()
  const lastTen = warm.filter((s) => s.at >= endAt - 600_000)
  // the last 10 minutes of one server life (after a restart that life's own warm-up is excluded)
  const lastLife = lastTen.at(-1)?.life
  const window = lastTen.filter((s) => s.life === lastLife)
  const heap = regressionGrowth(window.map((s) => ({ at: s.at, v: s.heapAfterGcMb || s.heapUsedMb })))
  const rss = regressionGrowth(window.map((s) => ({ at: s.at, v: s.rssMb })))
  const perLife = [...new Set(warm.map((s) => s.life))].map((life) => {
    const xs = warm.filter((s) => s.life === life)
    return { life, samples: xs.length, heap: regressionGrowth(xs.map((s) => ({ at: s.at, v: s.heapAfterGcMb || s.heapUsedMb }))), rss: regressionGrowth(xs.map((s) => ({ at: s.at, v: s.rssMb }))) }
  })
  // collections that only grew over the window (leak suspects)
  const grew: Record<string, [number, number]> = {}
  if (window.length >= 2) {
    const a = window[0]!.collections
    const z = window.at(-1)!.collections
    for (const k of Object.keys(z)) {
      const series = window.map((s) => s.collections[k] ?? 0)
      const monotone = series.every((v, i) => i === 0 || v >= series[i - 1]!)
      if ((a[k] ?? 0) < z[k]! && monotone && z[k]! - (a[k] ?? 0) >= 5) grew[k] = [a[k] ?? 0, z[k]!]
    }
  }
  const lag = { p99Max: Math.max(0, ...warm.map((s) => s.lagP99Ms)), max: Math.max(0, ...warm.map((s) => s.lagMaxMs)) }
  const checks = {
    noCrash: findings.crashes.length === 0,
    noFaults: findings.faults.length === 0,
    noErrorLines: findings.errorLines.length === 0 && findings.stderr.length === 0,
    noServerErrors: findings.serverErrorsToClients.length === 0 && findings.protocolErrors.length === 0,
    restartPositions: findings.restartMismatches.length === 0 && (RESTART_AT <= 0 || (counters.get('restart.reentered') ?? 0) > 0),
    heapGrowth: heap !== null && heap.perTenMin < HEAP_GROWTH_LIMIT,
    tickP99: tick.n > 0 && tick.p99 < TICK_P99_LIMIT_MS,
  }
  const pass = Object.values(checks).every(Boolean)
  const bot = Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const summary = {
    minutes: MINUTES, pass, checks, tick, lag, heapLast10Min: heap, rssLast10Min: rss, perLife, grew,
    routes: planner.stats, bots: bot, findings: { ...findings, errorLines: findings.errorLines.slice(0, 50), stderr: findings.stderr.slice(0, 50) },
  }
  console.log('\n==== soak summary ====')
  console.log(`checks: ${Object.entries(checks).map(([k, v]) => `${k} ${v ? 'PASS' : 'FAIL'}`).join(', ')}`)
  console.log(`tick after warm-up: n ${tick.n}, mean ${tick.mean.toFixed(3)} ms, p50 ${tick.p50.toFixed(3)}, p99 ${tick.p99.toFixed(3)}, p99.9 ${tick.p999.toFixed(3)}, max ${tick.max.toFixed(2)} ms`)
  console.log(`event-loop lag after warm-up: worst sample p99 ${lag.p99Max} ms, max ${lag.max} ms`)
  if (heap) console.log(`heap after GC, last 10 min (life ${lastLife}): ${heap.first.toFixed(1)} -> ${heap.last.toFixed(1)} MB, trend ${(heap.perTenMin * 100).toFixed(2)}% per 10 min`)
  if (rss) console.log(`rss, last 10 min: ${rss.first.toFixed(0)} -> ${rss.last.toFixed(0)} MB, trend ${(rss.perTenMin * 100).toFixed(2)}% per 10 min`)
  for (const l of perLife) console.log(`life ${l.life}: ${l.samples} samples after warm-up, heap trend ${l.heap ? (l.heap.perTenMin * 100).toFixed(2) : '-'}% / 10 min, rss trend ${l.rss ? (l.rss.perTenMin * 100).toFixed(2) : '-'}% / 10 min`)
  console.log(`collections that only grew (last 10 min): ${JSON.stringify(grew)}`)
  if (window.length >= 2) console.log(`heap spaces after GC, last 10 min: ${Object.keys(window.at(-1)!.spaces ?? {}).filter((k) => window.at(-1)!.spaces[k]).map((k) => `${k} ${window[0]!.spaces?.[k] ?? 0}->${window.at(-1)!.spaces[k]}`).join(', ')}`)
  console.log(`routes: ${JSON.stringify(planner.stats)}`)
  console.log(`bots: ${JSON.stringify(bot)}`)
  for (const [k, v] of Object.entries(findings)) if ((v as string[]).length) console.log(`${k} (${(v as string[]).length}):\n  ${(v as string[]).slice(0, 10).join('\n  ')}`)
  console.log(pass ? 'SOAK PASS' : 'SOAK FAIL')
  return summary
}

process.on('uncaughtException', (e) => {
  // e.g. helpers.ts's Client throws on a frame the shared parser rejects: a protocol bug, recorded, the run goes on
  findings.protocolErrors.push(`driver: ${(e as Error)?.stack ?? e}`.slice(0, 2000))
})
process.on('unhandledRejection', (e) => {
  findings.protocolErrors.push(`driver rejection: ${(e as Error)?.stack ?? e}`.slice(0, 2000))
})

await main()
