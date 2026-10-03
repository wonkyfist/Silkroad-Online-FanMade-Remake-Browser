/**
 * NEWPLAYER: a headless new player on "The Tiger's Shadow" at REAL speed (not part of the default test run; see
 * apps/server/README.md "New-player playtest").
 *
 *   pnpm tsx apps/server/test/soak/newplayer.ts [--minutes 40] [--out work/tmp/newplayer-report.json]
 *     [--data work/tmp/np/char-a]   keep the DATA_DIR and the account: the next run continues the same character
 *     [--debug]                     print every route
 *
 * Starts its own server in-process on a free port with a temp DATA_DIR, the real defaults of loadConfig (move speed,
 * tick rate, spawner, rewards; WORLD_EXPORT=jangan-fields) and the repo quest file, then plays over the WebSocket
 * protocol only, like the browser client: register, create a character with the creation screen's default look
 * (first male model, blade, clothes), enter at the Jangan spawn, and follow the questline from Soldier Fengil. No GM
 * commands, no teleports, no speed-ups. What it uses besides the socket is what the client has too: NPC positions
 * (the client's npcs.json / minimap pins), the quest catalog (GET /api/quests), items/skills data, and the navmesh
 * to click waypoints around walls (newplayer-route.ts; the server walker stops at the first wall).
 *
 * It fights with basic attacks and learned skills, drinks potions, buys them with its gold, loots, sells junk,
 * buys better weapon/shield/armour pieces, spends stat points (STR) and SP (Bicheon mastery, Strike Smash, Illusion
 * Chain), equips rewards, steers around visible aggressive monsters, and records every friction point (long walks,
 * deaths, sparse hunting spots, errors, refused requests), per-monster fight stats, and how long each quest took.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  PROTOCOL_VERSION,
  NPC_INTERACT_RANGE,
  parseServerMessage,
  type ApiQuestCatalog,
  type EntityState,
  type ItemStack,
  type MoveState,
  type PlayerStats,
  type QuestDef,
  type QuestLocation,
  type QuestObjective,
  type QuestProgress,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import WebSocket from 'ws'
import { REPO_ROOT, loadConfig } from '../../src/config.ts'
import { startServer, type GameServer } from '../../src/game.ts'
import { route } from './newplayer-route.ts'

// ---- options ---------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2)
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const MINUTES = Number(opt('minutes', '40'))
const DEBUG = argv.includes('--debug')
const OUT_FILE = resolve(REPO_ROOT, opt('out', 'work/tmp/newplayer-report.json'))
const T0 = Date.now()
const DEADLINE = T0 + MINUTES * 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const wall = () => Math.round((Date.now() - T0) / 1000)
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// ---- report ----------------------------------------------------------------------------------------------------

interface Friction {
  at: number
  kind: string
  text: string
}
const report = {
  startedAt: new Date(T0).toISOString(),
  minutes: MINUTES,
  character: '',
  quests: {} as Record<string, { title: string; acceptedAt?: number; readyAt?: number; completedAt?: number; kills: number; deaths: number; walkS: number; fightS: number }>,
  levels: [] as { level: number; at: number }[],
  deaths: [] as { at: number; by: string; level: number; where: string }[],
  friction: [] as Friction[],
  refused: {} as Record<string, number>,
  gearBought: [] as string[],
  /** Per monster code: fights, kills, seconds fighting and damage taken (all hits on the player during those fights). */
  mobs: {} as Record<string, { name: string; fights: number; kills: number; secs: number; damageTaken: number; maxHpFrac: number }>,
  serverErrors: [] as string[],
  totals: { walkS: 0, fightS: 0, kills: 0, potionsUsed: 0, goldEarned: 0, goldSpent: 0, walkM: 0, skillsCast: 0, blockedChases: 0 },
  final: {} as Record<string, unknown>,
  log: [] as string[],
}
const say = (s: string) => {
  const line = `[${mmss(wall())}] ${s}`
  report.log.push(line)
  console.log(line)
}
const friction = (kind: string, text: string) => {
  report.friction.push({ at: wall(), kind, text })
  say(`FRICTION ${kind}: ${text}`)
}
let saving = false
const saveReport = () => {
  if (saving) return
  saving = true
  try {
    mkdirSync(dirname(OUT_FILE), { recursive: true })
    writeFileSync(OUT_FILE, JSON.stringify(report, null, 1))
  } finally {
    saving = false
  }
}

// ---- server ----------------------------------------------------------------------------------------------------

/** --data DIR keeps the server's DATA_DIR (and the account) so a later run continues the same character ("the next evening"). */
const KEEP_DIR = opt('data', '')
const dataDir = KEEP_DIR ? resolve(REPO_ROOT, KEEP_DIR) : mkdtempSync(join(tmpdir(), 'sro-newplayer-'))
mkdirSync(dataDir, { recursive: true })
const SESSION_FILE = join(dataDir, 'newplayer-account.json')
const config = loadConfig({ ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, WORLD_EXPORT: 'jangan-fields', SERVE_STATIC: 'false', NODE_ENV: '' })
const serverLog: string[] = []
config.log = (m) => {
  serverLog.push(m)
  if (/error|exception|failed|uncaught/i.test(m) && !/0 errors/.test(m)) report.serverErrors.push(m)
}
const server: GameServer = await startServer(config)
const nav = server.ctx.nav
const data = server.ctx.data
say(`server on ${server.url} (tick ${config.tickHz} Hz, move ${config.moveSpeed} m/s, export ${config.worldExport}, nav ${nav.kind})`)

async function api(path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(server.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

// ---- static client knowledge -----------------------------------------------------------------------------------

/** NPC positions the client knows (content npcs.json -> minimap pins). */
const npcPos = new Map<string, { x: number; z: number; name: string }>()
for (const n of server.ctx.world.npcs.values()) npcPos.set(n.code, { x: n.pos[0], z: n.pos[2], name: n.name })
const itemDef = (code: string) => data.item(code)
const levelRows = data.levels
/** skills.json + masteries.json (the client has them too). */
const skillRows = server.ctx.gameplay.skills.book

// ---- the client ------------------------------------------------------------------------------------------------

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

class Bot {
  ws!: WebSocket
  myId = 0
  charId = 0
  stats!: PlayerStats
  bag: (ItemStack | null)[] = []
  gold = 0
  equip: Record<string, ItemStack | undefined> = {}
  ents = new Map<number, EntityState>()
  self!: EntityState
  dead = false
  active = new Map<string, QuestProgress>()
  done = new Map<string, { times: number; availableAt?: number }>()
  masteries: Record<string, number> = {}
  skills: string[] = []
  skillReadyAt = new Map<string, number>()
  itemReadyAt = new Map<string, number>()
  lastAttackedBy: { id: number; at: number } | null = null
  results: Msg<'actionResult'>[] = []
  waiters: (() => void)[] = []
  dialogs: Msg<'npcDialog'>[] = []
  sys: string[] = []
  killsByMe = 0
  damageTaken = 0
  lastKillAt = 0

  async connect(token: string): Promise<void> {
    this.ws = new WebSocket(server.url.replace(/^http/, 'ws') + '/ws')
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res())
      this.ws.once('error', rej)
    })
    this.ws.on('message', (d) => this.onMessage(d.toString()))
    this.ws.on('close', (code, reason) => say(`socket closed ${code} ${reason}`))
    this.send({ t: 'hello', version: PROTOCOL_VERSION, token })
    await this.wait(() => this.welcome, 5000, 'welcome')
  }

  welcome = false
  created: Msg<'charCreated'> | null = null
  charList: Msg<'charList'> | null = null
  entered = false

  send(m: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  private wake(): void {
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }

  async wait<T>(fn: () => T | null | undefined | false, ms: number, what = ''): Promise<T | null> {
    const end = Date.now() + ms
    for (;;) {
      const v = fn()
      if (v) return v
      const left = end - Date.now()
      if (left <= 0) {
        if (what) say(`(timed out waiting for ${what})`)
        return null
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 100))
        this.waiters.push(() => {
          clearTimeout(t)
          r()
        })
      })
    }
  }

  /** Sends a gameplay request and waits for its actionResult. */
  async act(m: { t: string } & Record<string, unknown>, ms = 4000): Promise<Msg<'actionResult'> | null> {
    const from = this.results.length
    this.send(m)
    const r = await this.wait(() => this.results.slice(from).find((x) => x.re === m.t), ms, `actionResult ${m.t}`)
    if (r && !r.ok) {
      const k = `${m.t}:${r.reason}`
      report.refused[k] = (report.refused[k] ?? 0) + 1
    }
    return r
  }

  onMessage(raw: string): void {
    const parsed = parseServerMessage(raw)
    if (!parsed.ok) {
      friction('protocol', `server sent an invalid frame: ${parsed.error}: ${raw.slice(0, 200)}`)
      return
    }
    const m = parsed.msg
    switch (m.t) {
      case 'welcome':
        this.welcome = true
        break
      case 'charCreated':
        this.created = m
        break
      case 'charList':
        this.charList = m
        break
      case 'error':
        say(`server error ${m.code}: ${m.message} (re ${m.re})`)
        if (m.code !== 'rate_limited') friction('error', `${m.code}: ${m.message} (re ${m.re})`)
        break
      case 'worldEnter':
        this.myId = m.self.id
        this.self = m.self
        this.ents.clear()
        for (const e of m.entities) this.ents.set(e.id, e)
        this.entered = true
        break
      case 'spawn':
        this.ents.set(m.entity.id, m.entity)
        break
      case 'despawn':
        this.ents.delete(m.id)
        break
      case 'move': {
        const e = m.id === this.myId ? this.self : this.ents.get(m.id)
        if (e) {
          e.move = m.move
          e.pos = [...m.move.from]
        }
        break
      }
      case 'stop':
      case 'warp': {
        const e = m.id === this.myId ? this.self : this.ents.get(m.id)
        if (e) {
          e.pos = [...m.pos]
          e.move = undefined
        }
        break
      }
      case 'entityUpdate': {
        const e = m.id === this.myId ? this.self : this.ents.get(m.id)
        if (e) {
          if (m.hp !== undefined) e.hp = m.hp
          if (m.maxHp !== undefined) e.maxHp = m.maxHp
          if (m.state) e.state = m.state
          if (m.level !== undefined) e.level = m.level
        }
        if (m.id === this.myId && m.state) this.dead = m.state === 'dead'
        break
      }
      case 'combat': {
        const t = m.target === this.myId ? this.self : this.ents.get(m.target)
        const last = m.hits[m.hits.length - 1]
        if (t && last) t.hp = last.hp
        if (m.killed && t) t.state = 'dead'
        if (m.target === this.myId) {
          this.lastAttackedBy = { id: m.attacker, at: Date.now() }
          for (const h of m.hits) this.damageTaken += h.damage
        }
        if (m.attacker === this.myId && m.killed) {
          this.killsByMe++
          this.lastKillAt = Date.now()
        }
        break
      }
      case 'stats':
        this.stats = m.stats
        this.gold = m.stats.gold
        this.dead = m.stats.hp <= 0 && this.dead
        break
      case 'statsDelta':
        if (this.stats) Object.assign(this.stats, m.stats)
        if (m.stats.gold !== undefined) this.gold = m.stats.gold
        if (m.stats.hp !== undefined && this.self) this.self.hp = m.stats.hp
        break
      case 'levelUp':
        if (m.id === this.myId) {
          report.levels.push({ level: m.level, at: wall() })
          say(`LEVEL UP -> ${m.level}`)
        }
        break
      case 'inventory':
        this.bag = [...m.inventory.bag]
        this.equip = { ...m.inventory.equip }
        this.gold = m.inventory.gold
        break
      case 'inventoryUpdate':
        for (const b of m.bag ?? []) this.bag[b.slot] = b.item
        for (const e of m.equip ?? []) this.equip[e.slot] = e.item ?? undefined
        if (m.gold !== undefined) {
          if (m.gold > this.gold) report.totals.goldEarned += m.gold - this.gold
          else report.totals.goldSpent += this.gold - m.gold
          this.gold = m.gold
        }
        break
      case 'skills':
        this.masteries = { ...m.masteries }
        this.skills = [...m.skills]
        break
      case 'skillsUpdate':
        Object.assign(this.masteries, m.masteries ?? {})
        for (const s of m.learned ?? []) {
          const def = skillRows.skill(s)
          const g = def?.group ?? s
          this.skills = this.skills.filter((x) => (skillRows.skill(x)?.group ?? x) !== g)
          this.skills.push(s)
        }
        break
      case 'itemCooldown':
        this.itemReadyAt.set(m.group, Date.now() + m.readyInMs)
        break
      case 'quests':
        this.active = new Map(m.active.map((a) => [a.quest, a]))
        this.done = new Map(m.done.map((d) => [d.quest, d]))
        break
      case 'questUpdate': {
        const q = report.quests[m.quest]
        if (m.progress) this.active.set(m.quest, m.progress)
        else this.active.delete(m.quest)
        if (m.done) this.done.set(m.quest, m.done)
        if (q) {
          if (m.event === 'accepted') q.acceptedAt = wall()
          if (m.event === 'ready' || (m.progress?.status === 'ready' && q.readyAt === undefined)) q.readyAt = wall()
          if (m.event === 'completed') q.completedAt = wall()
        }
        if (m.event !== 'progress') say(`quest ${m.quest} ${m.event}${m.progress ? ' ' + JSON.stringify(m.progress.counts) : ''}`)
        break
      }
      case 'npcDialog':
        this.dialogs.push(m)
        break
      case 'chat':
        if (m.channel === 'system') {
          this.sys.push(m.text)
          if (!/\(\d+\/\d+\)$/.test(m.text)) say(`system: ${m.text}`)
          if (/cannot get to|cannot fight/i.test(m.text)) friction('system-line', m.text)
        }
        break
      case 'actionResult':
        this.results.push(m)
        if (this.results.length > 500) this.results.splice(0, 250)
        break
    }
    this.wake()
  }

  // ---- derived state ----------------------------------------------------------------------------------------

  pos(e: EntityState = this.self): [number, number] {
    return livePos(e.pos, e.move)
  }
  hpFrac(): number {
    return this.stats ? this.stats.hp / Math.max(1, this.stats.maxHp) : 1
  }
  mpFrac(): number {
    return this.stats ? this.stats.mp / Math.max(1, this.stats.maxMp) : 1
  }
  count(code: string): number {
    return this.bag.reduce((n, i) => n + (i?.code === code ? i.count : 0), 0)
  }
  slotOf(code: string): number {
    return this.bag.findIndex((i) => i?.code === code)
  }
  free(): number {
    return this.bag.filter((i) => !i).length
  }
  npcEntity(code: string): EntityState | undefined {
    for (const e of this.ents.values()) if (e.kind === 'npc' && (e.npc ?? e.model) === code) return e
    return undefined
  }
}

function livePos(pos: Vec3, move?: MoveState): [number, number] {
  if (!move) return [pos[0], pos[2]]
  const dx = move.to[0] - move.from[0]
  const dz = move.to[2] - move.from[2]
  const d = Math.hypot(dx, dz)
  const t = Math.max(0, (Date.now() - move.startedAt) / 1000)
  const f = d > 0 ? Math.min(1, (move.speed * t) / d) : 1
  return [move.from[0] + dx * f, move.from[2] + dz * f]
}

// ---- game logic ------------------------------------------------------------------------------------------------

const bot = new Bot()
let catalog: ApiQuestCatalog
const quests = new Map<string, QuestDef>()
const locations = new Map<string, QuestLocation>()
let questNow = '-'
const Q = () => report.quests[questNow]

const HP_POTIONS = ['ITEM_ETC_HP_POTION_01', 'ITEM_ETC_HP_POTION_02', 'ITEM_ETC_HP_POTION_03']
const MP_POTIONS = ['ITEM_ETC_MP_POTION_01', 'ITEM_ETC_MP_POTION_02', 'ITEM_ETC_MP_POTION_03']
const WEAPON = 'blade'
const SKILL_LINES = ['SKILL_CH_SWORD_SMASH_A', 'SKILL_CH_SWORD_CHAIN_A']

function where(): string {
  const [x, z] = bot.pos()
  return `(${x.toFixed(0)}, ${z.toFixed(0)})`
}

/** Potions of HP_POTION_02 the `have` objective of an open quest needs (never drink those). */
function reservedCount(code: string): number {
  let n = 0
  for (const a of bot.active.values()) {
    const def = quests.get(a.quest)
    for (const o of def?.objectives ?? []) if (o.type === 'have' && o.item === code) n = Math.max(n, o.count)
  }
  return n
}

async function drinkIfNeeded(): Promise<void> {
  if (!bot.stats || bot.dead) return
  const now = Date.now()
  if (bot.hpFrac() < 0.5 && (bot.itemReadyAt.get('hp') ?? 0) <= now) {
    for (const code of HP_POTIONS) {
      if (bot.count(code) - reservedCount(code) <= 0) continue
      const r = await bot.act({ t: 'itemUse', bag: bot.slotOf(code) })
      if (r?.ok) report.totals.potionsUsed++
      break
    }
  }
  if (bot.skills.length > 0 && bot.mpFrac() < 0.25 && (bot.itemReadyAt.get('mp') ?? 0) <= now) {
    for (const code of MP_POTIONS) {
      if (bot.count(code) <= 0) continue
      const r = await bot.act({ t: 'itemUse', bag: bot.slotOf(code) })
      if (r?.ok) report.totals.potionsUsed++
      break
    }
  }
}

/** Walks to x/z by waypoints (re-routing when a leg ends short). Fights back if attacked on the way. */
async function walkTo(x: number, z: number, why: string, arrive = 2): Promise<boolean> {
  const t0 = Date.now()
  let fails = 0
  const [sx, sz] = bot.pos()
  const straight = Math.hypot(x - sx, z - sz)
  if (straight <= arrive) return true
  let walked = 0
  const deaths = report.deaths.length
  while (Date.now() < DEADLINE) {
    if (bot.dead || report.deaths.length !== deaths) return false
    const [px, pz] = bot.pos()
    if (Math.hypot(x - px, z - pz) <= arrive) break
    const from = nav.locate(px, pz, bot.self.pos[1]) ?? nav.place(px, pz, bot.self.pos[1], 3)
    if (!from) {
      friction('stuck', `no surface under the player at ${where()} while walking to ${why}`)
      return false
    }
    // fine grid first; a coarse one when the fine search gives up (long trips across the map, tight starting spots)
    let legs: [number, number][] | null = null
    for (const step of [3, 6, 8]) {
      legs = route(nav, from, { x, z }, { arrive: Math.max(1, arrive - 0.5), step, maxExpand: step === 3 ? 250_000 : 600_000, penalty: dangerAt() })
      if (legs) break
    }
    if (DEBUG) say(`route ${why} from (${px.toFixed(1)}, ${pz.toFixed(1)}): ${legs ? legs.map(([a, b]) => `(${a.toFixed(1)}, ${b.toFixed(1)})`).join(' ') : 'none'}`)
    if (!legs) {
      friction('no-route', `no walkable way from ${where()} to ${why} (${x.toFixed(0)}, ${z.toFixed(0)})`)
      if (report.friction.filter((f) => f.kind === 'no-route').length > 20) throw new Error('giving up: too many unroutable walks')
      return false
    }
    let ok = true
    for (const [lx, lz] of legs) {
      const [ax, az] = bot.pos()
      const d = Math.hypot(lx - ax, lz - az)
      bot.send({ t: 'moveTo', x: lx, z: lz })
      const end = Date.now() + (d / config.moveSpeed) * 1000 + 2500
      let lastAt = Date.now()
      while (Date.now() < end) {
        await sleep(150)
        if (bot.dead) return false
        await drinkIfNeeded()
        // attacked on the way: fight back first (a human would)
        const att = bot.lastAttackedBy
        if (att && Date.now() - att.at < 1500) {
          const mob = bot.ents.get(att.id)
          if (mob?.kind === 'mob' && mob.state !== 'dead') {
            say(`attacked by ${mob.name} (Lv ${mob.level}) on the way to ${why}`)
            await fight(mob.id, 'self-defence')
            ok = false
            break
          }
        }
        const [cx, cz] = bot.pos()
        if (!bot.self.move && Date.now() - lastAt > 300) break
        if (bot.self.move) lastAt = Date.now()
        if (Math.hypot(lx - cx, lz - cz) < 0.6) break
      }
      if (!ok) break
      const [cx, cz] = bot.pos()
      walked += d
      if (Math.hypot(lx - cx, lz - cz) > 1.5) {
        fails++
        ok = false
        break
      }
    }
    if (fails > 6) {
      friction('stuck', `walk to ${why} keeps stopping short at ${where()}`)
      return false
    }
  }
  const secs = (Date.now() - t0) / 1000
  report.totals.walkS += secs
  report.totals.walkM += walked
  if (Q()) Q().walkS += secs
  if (secs > 90) friction('long-walk', `${secs.toFixed(0)} s walking (${walked.toFixed(0)} m) to ${why}`)
  return true
}

/**
 * A human steers around monsters that attack on sight: extra route cost near every visible, living, aggressive mob
 * (mobs.json `aggressive`; players learn which ones quickly) unless it is far below the character's level.
 */
function dangerAt(): ((x: number, z: number) => number) | undefined {
  const lvl = bot.stats?.level ?? 1
  const mobs = [...bot.ents.values()]
    .filter((e) => e.kind === 'mob' && e.state !== 'dead' && data.mobs.get(e.model)?.aggressive && e.level >= lvl - 4)
    .map((e) => livePos(e.pos, e.move))
  if (mobs.length === 0) return undefined
  const R = 20
  return (x, z) => {
    let p = 0
    for (const [mx, mz] of mobs) {
      const d = Math.hypot(mx - x, mz - z)
      if (d < R) p += 8 * (1 - d / R)
    }
    return p
  }
}

/** A walkable stand point next to an NPC (its platform may be a separate navmesh component). */
function standNear(x: number, z: number, r = 2.5): { x: number; z: number } {
  const p = nav.place(x, z, NaN, 6)
  if (p && Math.hypot(p.x - x, p.z - z) < NPC_INTERACT_RANGE - 1) return { x: p.x, z: p.z }
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2
    const q = nav.place(x + Math.sin(a) * r, z + Math.cos(a) * r, NaN, 3)
    if (q) return { x: q.x, z: q.z }
  }
  return { x, z }
}

async function goNpc(code: string): Promise<EntityState | null> {
  const at = npcPos.get(code)
  if (!at) {
    friction('npc', `no position for ${code}`)
    return null
  }
  const stand = standNear(at.x, at.z)
  const [px, pz] = bot.pos()
  if (Math.hypot(at.x - px, at.z - pz) > NPC_INTERACT_RANGE - 1) {
    if (!(await walkTo(stand.x, stand.z, at.name, 1.5))) return null
  }
  const e = await bot.wait(() => bot.npcEntity(code), 3000, `NPC ${code} entity`)
  if (!e) return null
  const [qx, qz] = bot.pos()
  const d = Math.hypot(at.x - qx, at.z - qz)
  if (d > NPC_INTERACT_RANGE) friction('npc-reach', `${at.name}: closest stand point is ${d.toFixed(1)} m away (talk range ${NPC_INTERACT_RANGE} m)`)
  const from = bot.dialogs.length
  const r = await bot.act({ t: 'npcTalk', npc: e.id })
  if (!r?.ok) friction('npc-talk', `npcTalk ${at.name} refused: ${r?.reason} ${r?.message ?? ''}`)
  await bot.wait(() => bot.dialogs.slice(from).find((x) => x.npc === e.id), 8000, `dialog of ${at.name}`)
  return e
}

function offerable(def: QuestDef): boolean {
  if (def.disabled) return false
  if (bot.active.has(def.id)) return false
  if (bot.stats.level < def.level) return false
  if (def.maxLevel !== undefined && bot.stats.level > def.maxLevel) return false
  for (const r of def.requires?.quests ?? []) if (!bot.done.has(r)) return false
  const d = bot.done.get(def.id)
  if (d && (d.availableAt === undefined || d.availableAt > Date.now())) return false
  return true
}

function objectiveOpen(def: QuestDef, a: QuestProgress, o: QuestObjective): boolean {
  const n = a.counts[o.id] ?? 0
  const need = 'count' in o ? o.count : 1
  if (n >= need) return false
  if (o.after && (a.counts[o.after] ?? 0) < 1) return false
  return true
}

function choiceFor(def: QuestDef): number | undefined {
  const picks = def.rewards.choice ?? []
  if (picks.length === 0) return undefined
  const w = picks.findIndex((c) => new RegExp(`_${WEAPON.toUpperCase()}_`).test(c.item))
  if (w >= 0) return w
  const hp = picks.findIndex((c) => /HP_POTION/.test(c.item))
  return hp >= 0 ? hp : 0
}

async function turnIn(def: QuestDef): Promise<void> {
  questNow = def.id
  const e = await goNpc(def.turnIn)
  if (!e) return
  const r = await bot.act({ t: 'questTurnIn', npc: e.id, quest: def.id, ...(choiceFor(def) !== undefined ? { choice: choiceFor(def) } : {}) })
  if (!r?.ok) friction('turn-in', `${def.id} turn-in refused at ${def.turnIn}: ${r?.reason} ${r?.message ?? ''}`)
  else {
    const q = report.quests[def.id]
    say(`TURNED IN ${def.id} "${def.title}" (${q?.acceptedAt !== undefined ? mmss(wall() - q.acceptedAt) : '?'} since accept)`)
  }
  await sleep(300)
  await maintenance()
}

async function accept(def: QuestDef): Promise<boolean> {
  questNow = def.id
  const e = await goNpc(def.giver)
  if (!e) return false
  report.quests[def.id] ??= { title: def.title, kills: 0, deaths: 0, walkS: 0, fightS: 0 }
  const r = await bot.act({ t: 'questAccept', npc: e.id, quest: def.id })
  if (!r?.ok) {
    friction('accept', `${def.id} accept refused: ${r?.reason} ${r?.message ?? ''}`)
    return false
  }
  say(`ACCEPTED ${def.id} "${def.title}" (Lv ${def.level}) from ${npcPos.get(def.giver)?.name}: ${def.summary}`)
  return true
}

// ---- combat ----------------------------------------------------------------------------------------------------

const badTargets = new Map<number, number>()

async function fight(id: number, why: string): Promise<boolean> {
  const mob = bot.ents.get(id)
  if (!mob || mob.kind !== 'mob' || mob.state === 'dead') return false
  const t0 = Date.now()
  const taken0 = bot.damageTaken
  const r = await bot.act({ t: 'attack', target: id })
  if (!r?.ok) {
    badTargets.set(id, Date.now() + 60_000)
    if (r?.reason !== 'safe_zone') say(`attack ${mob.name} refused: ${r?.reason}`)
    return false
  }
  let lastHp = mob.hp ?? 0
  let chases = 0
  let lastProgress = Date.now()
  while (Date.now() < DEADLINE) {
    await sleep(120)
    if (bot.dead) break
    const m = bot.ents.get(id)
    if (!m || m.state === 'dead') break
    if ((m.hp ?? 0) < lastHp) {
      lastHp = m.hp ?? 0
      lastProgress = Date.now()
    }
    // the server's attack walk is one straight chord: a mob behind a fence or rock leaves the player standing; a human
    // clicks around the obstacle, then on the mob again
    const [mx, mz] = livePos(m.pos, m.move)
    const [ax, az] = bot.pos()
    if (chases < 2 && Date.now() - lastProgress > 3000 && !bot.self.move && Math.hypot(mx - ax, mz - az) > 4) {
      chases++
      report.totals.blockedChases++
      say(`attack walk to ${m.name} stopped ${Math.hypot(mx - ax, mz - az).toFixed(1)} m short at ${where()}: walking around`)
      const stand = nav.place(mx, mz, NaN, 3)
      if (stand) await walkTo(stand.x, stand.z, m.name, 2)
      await bot.act({ t: 'attack', target: id })
      lastProgress = Date.now()
      continue
    }
    if (Date.now() - lastProgress > 15_000) {
      friction('stuck-fight', `${m.name} (Lv ${m.level}) at ${where()} took no damage for 15 s (unreachable?)`)
      badTargets.set(id, Date.now() + 120_000)
      bot.send({ t: 'stopAction' })
      break
    }
    await drinkIfNeeded()
    // skills: attack rows on cooldown order
    for (const code of bot.skills) {
      const s = skillRows.skill(code)
      if (!s || s.kind !== 'attack' || (bot.skillReadyAt.get(code) ?? 0) > Date.now() || bot.stats.mp < s.mp) continue
      const sr = await bot.act({ t: 'useSkill', skill: code, target: id })
      bot.skillReadyAt.set(code, Date.now() + Math.max(s.cooldownMs, 1000))
      if (sr?.ok) report.totals.skillsCast++
      break
    }
    // keep the auto-attack going (a skill may have ended it)
    if (Date.now() - lastProgress > 4000 && (Date.now() - lastProgress) % 4000 < 150) await bot.act({ t: 'attack', target: id })
  }
  const secs = (Date.now() - t0) / 1000
  report.totals.fightS += secs
  if (Q()) Q().fightS += secs
  const m = bot.ents.get(id)
  const killed = !m || m.state === 'dead'
  const ms = (report.mobs[mob.model] ??= { name: `${mob.name} Lv ${mob.level}`, fights: 0, kills: 0, secs: 0, damageTaken: 0, maxHpFrac: 0 })
  ms.fights++
  ms.secs += secs
  ms.damageTaken += bot.damageTaken - taken0
  ms.maxHpFrac = Math.max(ms.maxHpFrac, (bot.damageTaken - taken0) / Math.max(1, bot.stats.maxHp))
  if (killed) ms.kills++
  if (killed && !bot.dead) {
    report.totals.kills++
    if (Q()) Q().kills++
    await loot()
  }
  if (bot.dead) await died(mob)
  return killed
}

async function loot(): Promise<void> {
  await sleep(500)
  for (let round = 0; round < 6; round++) {
    const [px, pz] = bot.pos()
    const items = [...bot.ents.values()].filter((e) => e.kind === 'item' && (e.owner === undefined || e.owner === bot.myId) && Math.hypot(e.pos[0] - px, e.pos[2] - pz) < 12)
    if (items.length === 0) return
    const it = items[0]
    if (bot.free() === 0 && !/GOLD/.test(it.model)) {
      await sellJunkSoon()
      return
    }
    const r = await bot.act({ t: 'pickup', id: it.id })
    if (!r?.ok) {
      bot.ents.delete(it.id)
      continue
    }
    await bot.wait(() => !bot.ents.has(it.id), 5000)
    bot.ents.delete(it.id)
  }
}

let needSell = false
async function sellJunkSoon(): Promise<void> {
  needSell = true
}

async function died(by: EntityState | undefined): Promise<void> {
  report.deaths.push({ at: wall(), by: by ? `${by.name} Lv ${by.level}` : '?', level: bot.stats.level, where: where() })
  if (Q()) Q().deaths++
  friction('death', `died to ${by?.name ?? '?'} (Lv ${by?.level}) at ${where()} as Lv ${bot.stats.level}, HP potions left ${HP_POTIONS.map((c) => bot.count(c)).join('/')}`)
  await sleep(3000)
  const r = await bot.act({ t: 'respawn' })
  if (r?.ok) {
    bot.dead = false
    await bot.wait(() => bot.stats.hp > 0, 3000)
    say(`respawned at ${where()}`)
  }
}

/** Mobs of `codes` near (cx, cz) within r, alive, not blacklisted; nearest to the player first. */
function targets(codes: Set<string>, cx: number, cz: number, r: number): EntityState[] {
  const [px, pz] = bot.pos()
  const now = Date.now()
  return [...bot.ents.values()]
    .filter((e) => e.kind === 'mob' && e.state !== 'dead' && codes.has(e.model) && (badTargets.get(e.id) ?? 0) < now)
    .filter((e) => {
      const [x, z] = livePos(e.pos, e.move)
      return Math.hypot(x - cx, z - cz) <= r
    })
    .sort((a, b) => {
      const [ax, az] = livePos(a.pos, a.move)
      const [bx, bz] = livePos(b.pos, b.move)
      return Math.hypot(ax - px, az - pz) - Math.hypot(bx - px, bz - pz)
    })
}

/** Hunts `codes` around `loc` until `enough()` (or the deadline / `maxMs`). */
async function hunt(loc: QuestLocation | null, wanted: Set<string> | (() => Set<string>), enough: () => boolean, label: string, maxMs = 20 * 60_000): Promise<void> {
  const center = loc ?? (() => {
    const [x, z] = bot.pos()
    return { id: 'here', name: 'here', x, z, radius: 60 }
  })()
  const t0 = Date.now()
  let [px, pz] = bot.pos()
  if (Math.hypot(center.x - px, center.z - pz) > center.radius) {
    const stand = nav.place(center.x, center.z, NaN, 30)
    if (!stand) friction('location', `${center.name}: no walkable ground within 30 m of its centre`)
    if (!(await walkTo(stand?.x ?? center.x, stand?.z ?? center.z, center.name, 5))) {
      if (!bot.dead) await sleep(5000)
      return
    }
  }
  const codesOf = () => (typeof wanted === 'function' ? wanted() : wanted)
  let codes = codesOf()
  const seen = targets(codes, center.x, center.z, center.radius)
  const all = [...bot.ents.values()].filter((e) => e.kind === 'mob' && codes.has(e.model))
  say(`hunting ${label} at ${center.name}: ${seen.length} targets inside the circle (r ${center.radius}), ${all.length} in view`)
  if (seen.length < 3) friction('sparse', `${label}: only ${seen.length} targets inside ${center.name} (r ${center.radius} m) on arrival, ${all.length} in view range`)
  let idleSince = Date.now()
  let wanders = 0
  let killsHere = 0
  while (!enough() && Date.now() < DEADLINE && Date.now() - t0 < maxMs) {
    if (bot.dead) {
      await died(bot.lastAttackedBy ? bot.ents.get(bot.lastAttackedBy.id) : undefined)
      return
    }
    // back in town after a death (fight() respawns): restock first, like a player would
    ;[px, pz] = bot.pos()
    if (Math.hypot(center.x - px, center.z - pz) > center.radius + 150) return
    await maintenance()
    if (bot.hpFrac() < 0.4 && HP_POTIONS.every((c) => bot.count(c) - reservedCount(c) <= 0)) {
      // no potions: sit until regen brings HP back (a human would too)
      const t = Date.now()
      await bot.wait(() => bot.hpFrac() > 0.8 || bot.dead, 60_000)
      friction('no-potions', `out of HP potions at ${where()} (Lv ${bot.stats.level}, ${bot.gold} gold): waited ${((Date.now() - t) / 1000).toFixed(0)} s to regenerate`)
    }
    // anything hitting me first
    const att = bot.lastAttackedBy
    if (att && Date.now() - att.at < 2000) {
      const m = bot.ents.get(att.id)
      if (m && m.kind === 'mob' && m.state !== 'dead') {
        await fight(m.id, 'defence')
        continue
      }
    }
    codes = codesOf()
    const list = targets(codes, center.x, center.z, center.radius + 25)
    if (list.length > 0) {
      idleSince = Date.now()
      if (await fight(list[0].id, label)) killsHere++
      continue
    }
    // nothing in sight: wander inside the circle
    if (Date.now() - idleSince > 1500) {
      wanders++
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * center.radius
      const stand = nav.place(center.x + Math.sin(a) * r, center.z + Math.cos(a) * r, NaN, 10)
      if (stand) await walkTo(stand.x, stand.z, `a search point in ${center.name}`, 3)
      idleSince = Date.now()
    }
    await sleep(200)
  }
  const secs = (Date.now() - t0) / 1000
  say(`hunt ${label}: ${killsHere} kills in ${secs.toFixed(0)} s, ${wanders} searches`)
  if (wanders > 12) friction('sparse', `${label} at ${center.name}: ${wanders} empty searches, ${killsHere} kills in ${secs.toFixed(0)} s`)
}

// ---- upkeep ----------------------------------------------------------------------------------------------------

const cannotWear = new Set<string>()

async function maintenance(): Promise<void> {
  if (!bot.stats || bot.dead) return
  if (bot.stats.statPoints > 0) await bot.act({ t: 'statUp', stat: 'str', points: bot.stats.statPoints })
  // SP: the next skill level of a line when its mastery allows, else the weapon mastery
  for (let guard = 0; guard < 10; guard++) {
    let spent = false
    for (const line of SKILL_LINES) {
      const have = bot.skills.map((c) => skillRows.skill(c)).find((s) => (s?.group ?? s?.code) === line)
      const next = skillRows.row(line, (have?.skillLevel ?? 0) + 1)
      if (!next || (bot.masteries.BICHEON ?? 0) < next.masteryLevel || bot.stats.sp < next.sp) continue
      const r = await bot.act({ t: 'skillLearn', skill: next.code })
      if (r?.ok) {
        say(`learned ${next.name} ${next.skillLevel} (${next.sp} SP)`)
        spent = true
        await bot.wait(() => bot.skills.includes(next.code), 2000)
      }
    }
    const mlv = bot.masteries.BICHEON ?? 0
    const cost = levelRows[mlv]?.masterySp ?? Infinity
    if (mlv < bot.stats.level && bot.stats.sp >= cost) {
      const r = await bot.act({ t: 'masteryUp', mastery: 'BICHEON' })
      if (r?.ok) {
        spent = true
        await bot.wait(() => (bot.masteries.BICHEON ?? 0) > mlv, 2000)
        say(`Bicheon mastery -> ${bot.masteries.BICHEON}`)
      }
    }
    if (!spent) break
  }
  // equip rewards that fit
  for (let i = 0; i < bot.bag.length; i++) {
    const it = bot.bag[i]
    if (!it) continue
    const def = itemDef(it.code)
    if (!def || !def.slot || def.reqLevel > bot.stats.level) continue
    if (/_(SWORD|SPEAR|TBLADE|BOW|SHIELD)_/.test(it.code)) continue
    const slotKey = def.slot === 'ring' ? (bot.equip.ring1 ? 'ring2' : 'ring1') : def.slot === 'earring' ? 'earring' : def.slot
    const worn = bot.equip[slotKey as string]
    const wornDef = worn && itemDef(worn.code)
    if (wornDef && (wornDef.reqLevel ?? 0) >= def.reqLevel && worn.code !== it.code && !/DEF$/.test(worn.code)) continue
    if (cannotWear.has(it.code)) continue
    const r = await bot.act({ t: 'itemEquip', bag: i })
    if (r?.ok) say(`equipped ${def.name ?? it.code}`)
    else cannotWear.add(it.code)
  }
}

const GEAR_SLOTS = ['weapon', 'shield', 'head', 'shoulders', 'chest', 'legs', 'hands', 'feet'] as const
const gearChecked = new Map<string, number>()

/**
 * Better gear from the smith (blade, shield) and Mrs Jang (armour of the class the character wears, its gender),
 * the best reqLevel <= level for each slot that is empty or worse, while it keeps `reserve` gold for potions.
 * The starter outfit covers only chest, legs and feet; a player soon notices the empty head, shoulder and hand slots.
 */
async function buyGear(reserve = 1200): Promise<void> {
  const level = bot.stats.level
  const worn = (slot: string) => bot.equip[slot]
  const cls = /_(CLOTHES|LIGHT|HEAVY)_/.exec(worn('chest')?.code ?? '')?.[1] ?? 'CLOTHES'
  const gender = /CHAR_CH_WOMAN/.test(report.character) ? 'W' : 'M'
  for (const npc of ['NPC_CH_SMITH', 'NPC_CH_ARMOR']) {
    if ((gearChecked.get(npc) ?? -1) >= level) continue
    const goods = (data.shopOf(npc)?.tabs ?? []).flatMap((t) => t.items).map((c) => itemDef(c)).filter((d) => d && d.slot && d.reqLevel <= level)
    const wants: { code: string; price: number; slot: string }[] = []
    for (const slot of GEAR_SLOTS) {
      const fits = goods.filter((d) => d!.slot === slot && (slot === 'weapon' ? /_BLADE_/.test(d!.code) : slot === 'shield' ? /_SHIELD_/.test(d!.code) : d!.code.includes(`_${gender}_${cls}_`)))
      fits.sort((a, b) => b!.reqLevel - a!.reqLevel || b!.price - a!.price)
      const best = fits[0]
      const have = worn(slot)
      const haveDef = have && itemDef(have.code)
      if (!best || (haveDef && haveDef.reqLevel >= best.reqLevel)) continue
      if (have?.code === best.code) continue
      wants.push({ code: best.code, price: best.price, slot })
    }
    if (wants.length === 0 || bot.gold - Math.min(...wants.map((w) => w.price)) < reserve) {
      gearChecked.set(npc, level)
      continue
    }
    const e = await goNpc(npc)
    if (!e) continue
    for (const w of wants.sort((a, b) => a.price - b.price)) {
      if (bot.gold - w.price < reserve) break
      const r = await bot.act({ t: 'shopBuy', npc: e.id, item: w.code, count: 1 })
      if (!r?.ok) continue
      await bot.wait(() => bot.slotOf(w.code) >= 0, 2000)
      const slot = bot.slotOf(w.code)
      const q = await bot.act({ t: 'itemEquip', bag: slot })
      say(`bought and ${q?.ok ? 'equipped' : 'could not equip'} ${itemDef(w.code)?.name} (${w.slot}, ${w.price} gold, left ${bot.gold})`)
      report.gearBought.push(`${wall()}s Lv ${level}: ${w.code} ${w.price}`)
    }
    gearChecked.set(npc, level)
  }
}

async function shop(): Promise<void> {
  // sell junk (not potions, not return scrolls) and buy HP potions
  const e = await goNpc('NPC_CH_POTION')
  if (!e) return
  for (let i = 0; i < bot.bag.length; i++) {
    const it = bot.bag[i]
    if (!it || /POTION|HERB|SCROLL_RETURN|CURE|SPOTION/.test(it.code)) continue
    const def = itemDef(it.code)
    if (def?.slot && def.reqLevel > bot.stats.level && def.reqLevel <= bot.stats.level + 4) continue
    const r = await bot.act({ t: 'shopSell', npc: e.id, bag: i })
    if (r?.ok) say(`sold ${it.count}x ${def?.name ?? it.code}`)
  }
  needSell = false
  const code = bot.stats.level >= 8 ? 'ITEM_ETC_HP_POTION_02' : 'ITEM_ETC_HP_POTION_01'
  const price = itemDef(code)?.price ?? 60
  const want = 30 - HP_POTIONS.reduce((n, c) => n + bot.count(c), 0)
  const afford = Math.floor(Math.max(0, bot.gold - 100) / price)
  const n = Math.min(want, afford)
  if (n > 0) {
    const r = await bot.act({ t: 'shopBuy', npc: e.id, item: code, count: n })
    if (r?.ok) say(`bought ${n}x ${itemDef(code)?.name} for ${n * price} gold (left ${bot.gold})`)
  } else if (want > 10) friction('gold', `wanted ${want} HP potions but can afford ${afford} (${bot.gold} gold, Lv ${bot.stats.level})`)
  const mp = 'ITEM_ETC_MP_POTION_01'
  const mpWant = bot.skills.length > 0 ? 15 - MP_POTIONS.reduce((n, c) => n + bot.count(c), 0) : 0
  const mpAfford = Math.floor(Math.max(0, bot.gold - 300) / (itemDef(mp)?.price ?? 60))
  if (mpWant > 0 && mpAfford > 0) await bot.act({ t: 'shopBuy', npc: e.id, item: mp, count: Math.min(mpWant, mpAfford) })
}

function inTown(): boolean {
  const [x, z] = bot.pos()
  return data.inSafeArea(config.world, x, z)
}

// ---- the quest driver ------------------------------------------------------------------------------------------

function loc(o: QuestObjective): QuestLocation | null {
  const id = o.type === 'reach' || o.type === 'useItem' ? o.location : o.hint
  return id ? locations.get(id) ?? null : null
}

/** One unit of quest work on `def` (an open objective). */
async function work(def: QuestDef, a: QuestProgress): Promise<void> {
  questNow = def.id
  const open = def.objectives.filter((o) => objectiveOpen(def, a, o))
  // talk / deliver / reach / useItem / have first where cheap, then the fights (all kill/collect of this quest at once)
  const o = open.find((x) => x.type === 'talk' || x.type === 'deliver') ?? open.find((x) => x.type === 'have') ?? open.find((x) => x.type === 'reach') ?? open.find((x) => x.type === 'useItem') ?? open[0]
  if (!o) return
  switch (o.type) {
    case 'talk':
    case 'deliver': {
      const e = await goNpc(o.npc)
      if (!e) return
      const r = await bot.act({ t: 'questTalk', npc: e.id, quest: def.id, objective: o.id })
      if (!r?.ok) friction('talk', `${def.id}/${o.id} at ${o.npc}: ${r?.reason} ${r?.message ?? ''}`)
      return
    }
    case 'have': {
      const need = o.count - bot.count(o.item)
      const price = itemDef(o.item)?.price ?? 0
      if (bot.gold < need * price) friction('gold', `${def.id}: needs ${need}x ${o.item} (${need * price} gold) but has ${bot.gold}`)
      const e = await goNpc('NPC_CH_POTION')
      if (e && need > 0) {
        const r = await bot.act({ t: 'shopBuy', npc: e.id, item: o.item, count: need })
        if (!r?.ok) friction('have', `${def.id}: buying ${need}x ${o.item} failed: ${r?.reason}`)
      }
      return
    }
    case 'reach': {
      const l = locations.get(o.location)!
      const p = nav.place(l.x, l.z, NaN, 30)
      await walkTo(p?.x ?? l.x, p?.z ?? l.z, l.name, Math.max(3, l.radius * 0.5))
      await sleep(1500)
      return
    }
    case 'useItem': {
      const l = locations.get(o.location)!
      const p = nav.place(l.x, l.z, NaN, 30)
      await walkTo(p?.x ?? l.x, p?.z ?? l.z, l.name, Math.max(3, l.radius * 0.5))
      const r = await bot.act({ t: 'questUseItem', quest: def.id, objective: o.id })
      if (!r?.ok) friction('use-item', `${def.id}/${o.id}: ${r?.reason} ${r?.message ?? ''}`)
      if (o.encounter && r?.ok) {
        const codes = new Set([o.encounter.mob])
        await hunt(l, codes, () => !objectiveOpen(def, bot.active.get(def.id) ?? a, o) && !(bot.active.get(def.id)?.status === 'active' && targets(codes, l.x, l.z, l.radius + 30).length > 0), 'encounter', 5 * 60_000)
      }
      return
    }
    case 'kill':
    case 'collect': {
      // every kill/collect objective of every active quest that hints at the same place counts on the way
      const l = loc(o)
      // what is still wanted here, re-read every pick: the main/side objectives first, a daily's "any beast" last
      const codesNow = () => {
        const main = new Set<string>()
        const any = new Set<string>()
        for (const aa of bot.active.values()) {
          const d = quests.get(aa.quest)
          if (!d || aa.status === 'ready') continue
          for (const x of d.objectives) {
            if (!objectiveOpen(d, aa, x)) continue
            const xl = loc(x)
            if (l && xl && Math.hypot(xl.x - l.x, xl.z - l.z) > l.radius + xl.radius) continue
            const set = d.kind === 'repeatable' ? any : main
            if (x.type === 'kill') x.mobs.forEach((m) => set.add(m))
            if (x.type === 'collect') x.from.forEach((f) => set.add(f.mob))
          }
        }
        return main.size > 0 ? main : any
      }
      const codes = codesNow()
      const label = `${def.id} ${[...codes].map((c) => c.replace('MOB_CH_', '')).join('+')}`
      // stay until this quest has nothing left to hunt here (a player finishes the spot before walking back)
      const here = (x: QuestObjective) => (x.type === 'kill' || x.type === 'collect') && (!l || !loc(x) || dist(loc(x)!, l.x, l.z) <= l.radius + loc(x)!.radius)
      await hunt(l, codesNow, () => {
        const cur = bot.active.get(def.id)
        return !cur || cur.status === 'ready' || !def.objectives.some((x) => here(x) && objectiveOpen(def, cur, x))
      }, label, 12 * 60_000)
      return
    }
  }
}

function questOrder(): QuestDef[] {
  return [...quests.values()]
}

async function play(): Promise<void> {
  let stall = 0
  while (Date.now() < DEADLINE) {
    if (bot.dead) {
      await died(undefined)
      continue
    }
    await maintenance()
    // 1. turn in what is ready (nearest turn-in NPC first)
    const ready = [...bot.active.values()].filter((a) => a.status === 'ready').map((a) => quests.get(a.quest)!).filter(Boolean)
    // work within 250 m comes first unless the turn-in NPC is close (a player finishes the spot, then walks back)
    const [wx, wz] = bot.pos()
    const workNear = [...bot.active.values()].some((a) => a.status === 'active' && workDist(a, wx, wz) < 250)
    if (ready.length > 0 && (!workNear || ready.some((d) => dist(npcPos.get(d.turnIn), wx, wz) < 150))) {
      const [px, pz] = bot.pos()
      ready.sort((a, b) => dist(npcPos.get(a.turnIn), px, pz) - dist(npcPos.get(b.turnIn), px, pz))
      await turnIn(ready[0])
      stall = 0
      continue
    }
    // 2. shop when in town and low on potions or bag full
    const hpPots = HP_POTIONS.reduce((n, c) => n + bot.count(c), 0)
    const shopNear = dist(npcPos.get('NPC_CH_POTION'), ...bot.pos()) < 450
    if (DEBUG) say(`shop check: pots ${hpPots} gold ${bot.gold} free ${bot.free()} inTown ${inTown()} stall ${stall} near ${shopNear}`)
    if ((needSell || bot.free() < 6 || (hpPots < 12 && bot.gold >= 250)) && (inTown() || stall > 0 || (hpPots < 5 && shopNear))) {
      await shop()
    }
    if ((inTown() && bot.gold > 1500) || (bot.gold > 3000 && dist(npcPos.get('NPC_CH_SMITH'), ...bot.pos()) < 450)) await buyGear()
    // 3. accept offers (main line and sides; the repeatable patrol too), nearest giver first
    const offers = questOrder().filter(offerable)
    if (offers.length > 0 && bot.active.size < 6) {
      const [px, pz] = bot.pos()
      offers.sort((a, b) => dist(npcPos.get(a.giver), px, pz) - dist(npcPos.get(b.giver), px, pz))
      const near = offers.filter((d) => dist(npcPos.get(d.giver), px, pz) < (workNear ? 120 : 450) || (d.kind === 'main' && !workNear))
      if (near.length > 0) {
        if (await accept(near[0])) {
          stall = 0
          continue
        }
      }
    }
    // 4. work: main quests first, then the nearest objective
    const actives = [...bot.active.values()].filter((a) => a.status === 'active').map((a) => ({ a, def: quests.get(a.quest)! })).filter((x) => x.def)
    if (actives.length > 0) {
      const [px, pz] = bot.pos()
      const score = (x: { a: QuestProgress; def: QuestDef }) => workDist(x.a, px, pz) + (x.def.kind === 'main' ? 0 : 150) + (x.def.kind === 'repeatable' ? 400 : 0)
      actives.sort((p, q) => score(p) - score(q))
      await work(actives[0].def, actives[0].a)
      stall = 0
      continue
    }
    // 5. nothing to do: the next main quest needs a higher level -> grind where its hint points
    stall++
    const next = questOrder().find((d) => !bot.done.has(d.id) && !bot.active.has(d.id) && d.kind === 'main' && (d.requires?.quests ?? []).every((r) => bot.done.has(r)))
    if (next) {
      friction('level-gate', `${next.id} "${next.title}" needs Lv ${next.level}; character is Lv ${bot.stats.level} (${bot.stats.exp}/${bot.stats.expToNext} EXP): grinding`)
      const prevLoc = [...bot.done.keys()].map((id) => quests.get(id)).reverse().flatMap((d) => d?.objectives ?? []).map(loc).find(Boolean) ?? null
      const codes = new Set<string>()
      for (const d of quests.values()) if (d.level <= bot.stats.level + 1) for (const o of d.objectives) if (o.type === 'kill') o.mobs.forEach((m) => codes.add(m))
      const lvl = bot.stats.level
      questNow = `grind`
      await hunt(prevLoc, codes, () => bot.stats.level > lvl, `grind to Lv ${next.level}`, 8 * 60_000)
      continue
    }
    say('nothing left to do')
    break
  }
}

/** How far the next open objective of an active quest is (its location or NPC; 0 when anywhere). */
function workDist(a: QuestProgress, x: number, z: number): number {
  const def = quests.get(a.quest)
  if (!def) return 1e9
  const o = def.objectives.find((oo) => objectiveOpen(def, a, oo))
  if (!o) return 1e9
  const l = loc(o)
  const npc = o.type === 'talk' || o.type === 'deliver' ? npcPos.get(o.npc) : o.type === 'have' ? npcPos.get('NPC_CH_POTION') : undefined
  return l ? Math.max(0, dist(l, x, z) - l.radius) : npc ? dist(npc, x, z) : 0
}

function dist(p: { x: number; z: number } | undefined, x: number, z: number): number {
  return p ? Math.hypot(p.x - x, p.z - z) : 1e9
}

// ---- run -------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const saved = existsSync(SESSION_FILE) ? (JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as { username: string; password: string }) : null
  const username = saved?.username ?? `np${Date.now().toString(36)}`
  const password = saved?.password ?? `pw${Math.random().toString(36).slice(2, 12)}`
  const reg = saved ? await api('/api/login', { username, password }) : await api('/api/register', { username, password })
  if (reg.status !== (saved ? 200 : 201)) throw new Error(`${saved ? 'login' : 'register'} failed ${reg.status} ${JSON.stringify(reg.json)}`)
  if (KEEP_DIR && !saved) writeFileSync(SESSION_FILE, JSON.stringify({ username, password }))
  const token = reg.json.token as string
  const cat = await api('/api/quests', undefined, token)
  catalog = cat.json as ApiQuestCatalog
  for (const f of catalog.files) {
    for (const q of f.quests) quests.set(q.id, q)
    for (const l of f.locations) locations.set(l.id, l)
  }
  say(`catalog rev ${catalog.rev}: ${quests.size} quests, ${locations.size} locations`)
  await bot.connect(token)
  // the creation screen's defaults: male, first selectable model, blade, clothes, height/volume default
  const model = 'CHAR_CH_MAN_ADVENTURER'
  bot.send({ t: 'charList' })
  const list = await bot.wait(() => bot.charList, 5000, 'charList')
  const old = list?.characters[0]
  if (old) {
    report.character = `${old.name} ${old.model} ${old.weapon} (continued, Lv ${old.level})`
    bot.charId = old.id
  } else {
    const name = `Np${Date.now().toString(36).slice(-6)}`
    bot.send({ t: 'charCreate', name, model, weapon: WEAPON })
    const created = await bot.wait(() => bot.created, 5000, 'charCreated')
    if (!created) throw new Error('charCreate failed')
    report.character = `${name} ${model} ${WEAPON}`
    bot.charId = created.character.id
  }
  bot.send({ t: 'enterWorld', id: bot.charId })
  await bot.wait(() => bot.entered && bot.stats && bot.bag.length > 0, 8000, 'worldEnter')
  say(`entered at ${where()} Lv ${bot.stats.level} HP ${bot.stats.hp}/${bot.stats.maxHp} gold ${bot.gold}; weapon ${bot.equip.weapon?.code}; bag ${bot.bag.filter(Boolean).map((i) => `${i!.count}x${i!.code}`).join(' ')}`)
  const [sx, sz] = bot.pos()
  say(`nearest NPCs: ${[...npcPos.entries()].map(([c, p]) => ({ c, d: Math.hypot(p.x - sx, p.z - sz) })).sort((a, b) => a.d - b.d).slice(0, 4).map((x) => `${x.c} ${x.d.toFixed(0)} m`).join(', ')}`)
  const tick = setInterval(saveReport, 15_000)
  try {
    await play()
  } finally {
    clearInterval(tick)
  }
}

let exitCode = 0
try {
  await main()
} catch (e) {
  exitCode = 1
  friction('crash', String((e as Error).stack ?? e))
} finally {
  report.final = {
    wallS: wall(),
    level: bot.stats?.level,
    exp: `${bot.stats?.exp}/${bot.stats?.expToNext}`,
    sp: bot.stats?.sp,
    gold: bot.gold,
    masteries: bot.masteries,
    skills: bot.skills,
    done: [...bot.done.keys()],
    active: [...bot.active.values()].map((a) => `${a.quest} ${a.status} ${JSON.stringify(a.counts)}`),
    equip: Object.fromEntries(Object.entries(bot.equip).map(([k, v]) => [k, v?.code])),
    potions: [...HP_POTIONS, ...MP_POTIONS].map((c) => `${c}:${bot.count(c)}`),
  }
  report.serverErrors.push(...serverLog.filter((l) => /warn/i.test(l)).slice(0, 20))
  saveReport()
  say(`report: ${OUT_FILE}`)
  try {
    bot.ws?.close()
    await server.close()
  } catch {}
  if (!KEEP_DIR) rmSync(dataDir, { recursive: true, force: true })
  process.exit(exitCode)
}
