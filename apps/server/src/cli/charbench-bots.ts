/**
 * The 100-player character bench, server side (docs/CHARACTERS.md §9 "The bench"). A private game server over its own
 * DATA_DIR with N scripted bot players in the Jangan plaza: mixed models (both genders, every Chinese body), every
 * weapon family, gear of every degree and armour class, +0..+12 weapons (the glow) and some Seal of Star / Moon / Sun
 * weapons, split into three behaviours: standing (some sitting, some waving), walking (a new point in the plaza every
 * few seconds) and fighting (Mangnyang spawned in the plaza, their HP held, the fighters healed). Everything is seeded,
 * so a run places and dresses the same crowd every time.
 *
 * Bench only: the server's safe-area rule is lifted in this process (no fighting in town otherwise), and the bots get
 * their gear straight into the equip slots (levels and genders checked, the level requirement not). The bots are
 * ordinary players (placed and given their monsters server side); only the bench character is an admin, granted
 * through the owner's CLI (`pnpm gm grant`) on the bench's own DATA_DIR.
 *
 * The browser character ("tab") is a GM account with a character and no socket: the page resumes with its token.
 * `charbench.ts` (the driver) starts this in-process; `startCharBench` is the API, the control endpoint (port + 1)
 * is for a person running the bench in their own browser:
 *   GET /tab            the tab's session ({ token, username, expiresAt, character })
 *   GET /status         bots, behaviours, mobs
 *   GET /behave?on=0|1  pause / resume the walkers and fighters (they stand where they are)
 */
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  EMOTE_KINDS,
  EQUIP_SLOTS,
  PLAYER_MODELS_CH,
  PROTOCOL_VERSION,
  STARTER_WEAPONS,
  equipSlotsFor,
  parseServerMessage,
  rareCodeOf,
  type EquipSlot,
  type ItemDef,
  type ServerMessage,
  type StarterOutfit,
  type StarterWeapon,
} from '@sro/shared'
import { loadConfig } from '../config.ts'
import { startServer, type GameServer } from '../game.ts'

const REPO = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

/** The plaza centre (glTF metres; the GM `tp` frame) and the disc the crowd stands in. */
export const PLAZA = { x: 101, z: -70, r: 20 } as const
/** The behaviour split (fractions of the bots, in this order: the rest stand). */
export const SPLIT = { walk: 0.3, fight: 0.3 } as const
/** Monsters the fighters attack (spawned once by a GM bot at the plaza; their HP held over half). */
export const FIGHT_MOB = 'MOB_CH_MANGNYANG'
export const FIGHT_MOBS = 20

export type Behaviour = 'stand' | 'sit' | 'wave' | 'walk' | 'fight'

export interface CharBenchOptions {
  port: number
  dataDir: string
  bots: number
  /** Origins the page is served from (the private preview). */
  origins: string[]
  seed?: number
  log?: (line: string) => void
  /** Progress lines (bots in, failures). */
  progress?: (line: string) => void
  /** The control endpoint on port + 1 (default on). */
  control?: boolean
  /** The bench character's model (default CHAR_CH_MAN_ADVENTURER; the P1 pilot runs use a woman: docs/CHARACTERS.md §15). */
  benchModel?: string
}

export interface BotInfo {
  name: string
  model: string
  weapon: StarterWeapon
  behaviour: Behaviour
  degree: number
  armor: string
  plus: number
  seal: string | null
  equip: Partial<Record<EquipSlot, string>>
}

export interface CharBench {
  server: GameServer
  tab: { token: string; username: string; expiresAt: number; character: string }
  bots: BotInfo[]
  status(): { bots: number; online: number; behaving: boolean; byBehaviour: Record<string, number>; mobs: number }
  setBehaving(on: boolean): void
  close(): Promise<void>
}

/** mulberry32: the seeded random of every choice (same seed, same crowd). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Behaviour of bot `k` of `n` (deterministic: the first walk share walks, the next fight share fights). */
export function behaviourOf(k: number, n: number): Behaviour {
  const walk = Math.round(n * SPLIT.walk)
  const fight = Math.round(n * SPLIT.fight)
  if (k < walk) return 'walk'
  if (k < walk + fight) return 'fight'
  const s = (k - walk - fight) % 5
  return s === 3 ? 'sit' : s === 4 ? 'wave' : 'stand'
}

/** A point of the plaza disc for bot `k` (a sunflower spiral: even, no two on one spot). */
export function plazaPoint(k: number, n: number, r = PLAZA.r): [number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const rr = 2 + (r - 2) * Math.sqrt((k + 0.5) / Math.max(1, n))
  return [PLAZA.x + rr * Math.cos(k * golden), PLAZA.z + rr * Math.sin(k * golden)]
}

/** The wearable Chinese gear by degree: armour per (gender, class, slot) and weapons per family. */
export function gearIndex(items: readonly ItemDef[]) {
  const armour = new Map<string, ItemDef[]>()
  const weapons = new Map<string, ItemDef[]>()
  const shields = new Map<number, ItemDef[]>()
  const degrees = new Set<number>()
  for (const d of items) {
    if (!d.slot || d.race === 'europe' || !d.model || d.degree < 1 || /_RARE|_SET_|_EVENT|_MALL|_TEST|_GM/.test(d.code)) continue
    if (d.weaponType && d.slot === 'weapon') {
      const k = `${d.weaponType}:${d.degree}`
      weapons.set(k, [...(weapons.get(k) ?? []), d])
      degrees.add(d.degree)
    } else if (d.slot === 'shield') {
      shields.set(d.degree, [...(shields.get(d.degree) ?? []), d])
    } else if (d.armorType && ['head', 'shoulders', 'chest', 'legs', 'hands', 'feet'].includes(d.slot)) {
      for (const g of d.reqGender === 'any' ? ['male', 'female'] : [d.reqGender]) {
        const k = `${g}:${d.armorType}:${d.slot}:${d.degree}`
        armour.set(k, [...(armour.get(k) ?? []), d])
      }
    }
  }
  return { armour, weapons, shields, degrees: [...degrees].sort((a, b) => a - b) }
}

/** What bot `k` wears (seeded): one degree and armour class for the set, its family's weapon, +N, maybe a seal. */
export function dressFor(
  rand: () => number,
  gender: 'male' | 'female',
  weapon: StarterWeapon,
  gear: ReturnType<typeof gearIndex>,
  data: { item(code: string): ItemDef | undefined },
): { degree: number; armor: string; plus: number; seal: string | null; equip: Partial<Record<EquipSlot, string>> } {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!
  const degs = gear.degrees.filter(d => gear.weapons.has(`${weapon}:${d}`))
  const degree = degs.length ? pick(degs) : 1
  const armor = pick(['garment', 'protector', 'armor'] as const)
  const equip: Partial<Record<EquipSlot, string>> = {}
  for (const slot of ['head', 'shoulders', 'chest', 'legs', 'hands', 'feet'] as const) {
    // a bare head now and then (the hair shows), as players do
    if (slot === 'head' && rand() < 0.35) continue
    const list = gear.armour.get(`${gender}:${armor}:${slot}:${degree}`)
    if (list?.length) equip[slot] = pick(list).code
  }
  const wl = gear.weapons.get(`${weapon}:${degree}`) ?? []
  let w = wl.length ? pick(wl).code : undefined
  // +N: a third plain, the rest +1..+12 (the glow starts at +4 or so: weapon-glow.ts)
  const plus = rand() < 0.33 ? 0 : 1 + Math.floor(rand() * 12)
  let seal: string | null = null
  const r = rand()
  if (w && r < 0.18) {
    const tier = r < 0.1 ? 'star' : r < 0.15 ? 'moon' : 'sun'
    const code = rareCodeOf(w, tier)
    if (code && data.item(code)) {
      w = code
      seal = tier
    }
  }
  if (w) equip.weapon = w
  const one = (weapon === 'sword' || weapon === 'blade') && rand() < 0.5
  const sl = gear.shields.get(degree)
  if (one && sl?.length) equip.shield = pick(sl).code
  return { degree, armor, plus, seal, equip }
}

/** A light bot socket: messages are parsed only while someone waits for one (100 bots hear 100 players). */
class Bot {
  private waiting: { t: string; pred: (m: any) => boolean; res: (m: any) => void }[] = []
  selfId = 0
  closed = false
  /** The last `error` the server sent (kept even when nobody waits). */
  lastError = ''
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d: WebSocket.RawData) => {
      const text = d.toString()
      if (text.startsWith('{"t":"error"')) this.lastError = text.slice(0, 300)
      if (!this.waiting.length) return
      const p = parseServerMessage(text)
      if (!p.ok) return
      for (let i = 0; i < this.waiting.length; i++) {
        const w = this.waiting[i]!
        if (w.t === p.msg.t && w.pred(p.msg)) {
          this.waiting.splice(i, 1)
          w.res(p.msg)
          break
        }
      }
    })
    ws.on('close', () => (this.closed = true))
    ws.on('error', () => (this.closed = true))
  }
  static async open(base: string, token: string, localAddress?: string): Promise<Bot> {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { origin: base }, ...(localAddress ? { localAddress } : {}) })
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res())
      ws.once('error', rej)
    })
    const b = new Bot(ws)
    const w = b.next('welcome')
    b.send({ t: 'hello', version: PROTOCOL_VERSION, token })
    await w
    return b
  }
  send(m: unknown): void {
    if (!this.closed) this.ws.send(JSON.stringify(m))
  }
  next<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 15000): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((res, rej) => {
      const w = { t, pred, res }
      this.waiting.push(w)
      setTimeout(() => {
        const i = this.waiting.indexOf(w)
        if (i >= 0) {
          this.waiting.splice(i, 1)
          rej(new Error(`timeout ${t}${this.lastError ? ': ' + this.lastError : ''}`))
        }
      }, ms)
    })
  }
  async gm(cmd: string, ...args: string[]): Promise<{ ok: boolean; message: string }> {
    const w = this.next('gmResult', m => m.cmd === cmd)
    this.send({ t: 'gm', cmd, args })
    return (await w) as unknown as { ok: boolean; message: string }
  }
  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {}
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function startCharBench(o: CharBenchOptions): Promise<CharBench> {
  const log = o.log ?? (() => {})
  const progress = o.progress ?? (() => {})
  const rand = seeded(o.seed ?? 1)
  const cfg = loadConfig({
    ...process.env,
    PORT: String(o.port),
    HOST: '127.0.0.1',
    DATA_DIR: o.dataDir,
    REGISTER_LIMIT: '100000',
    ALLOWED_ORIGINS: o.origins.join(','),
    UNIQUES: 'off',
    CAPACITY: String(o.bots + 10),
  })
  const server = await startServer({ ...cfg, log })
  const ctx = server.ctx as any
  // Bench only: fights in the plaza (the town's safe area would refuse every attack).
  ctx.data.inSafeArea = () => false
  const base = `http://127.0.0.1:${o.port}`
  const origin = o.origins[0] ?? base
  let serial = 0
  const register = async (prefix: string, role?: 'gm' | 'admin') => {
    const username = `${prefix}${Date.now().toString(36).slice(-5)}${++serial}`
    const password = randomBytes(9).toString('base64url')
    const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ username, password }) })
    const j = (await r.json()) as { token: string; expiresAt: number }
    if (r.status !== 201) throw new Error('register ' + JSON.stringify(j))
    // roles change only through the owner's CLI (role-policy.test.ts): the bench calls it on its own DATA_DIR
    if (role) {
      const cli = join(REPO, 'apps/server/src/cli/gm.ts')
      const tsx = join(REPO, 'node_modules/tsx/dist/cli.mjs')
      execFileSync(process.execPath, [tsx, cli, 'grant', username, '--role', role], { env: { ...process.env, DATA_DIR: o.dataDir }, stdio: 'ignore' })
    }
    return { username, token: j.token, expiresAt: j.expiresAt }
  }
  const nameOf = (p: string) => `${p}${(serial * 7919 + 13).toString(36)}`.slice(0, 12)
  async function create(bot: Bot, name: string, model: string, weapon: StarterWeapon, outfit?: StarterOutfit): Promise<number> {
    const w = bot.next('charCreated')
    bot.send({ t: 'charCreate', name, model, weapon, ...(outfit ? { outfit } : {}) })
    return (await w).character.id
  }

  // ---- the browser's character (GM: /tp, /time, /weather on this private server only) ----
  const tabAcc = await register('cbtab', 'admin')
  const tabName = 'Benchmark'
  {
    const b = await Bot.open(base, tabAcc.token)
    await create(b, tabName, o.benchModel ?? 'CHAR_CH_MAN_ADVENTURER', 'sword')
    b.close()
    // the What's new window would cover the bench's views
    const newest = ctx.news?.published?.()[0]
    if (newest) ctx.news.markSeen(ctx.store, ctx.store.accountByName(tabAcc.username).id, newest.id)
  }

  // ---- the bots ----
  const gear = gearIndex([...(ctx.data.items as Map<string, ItemDef>).values()])
  const models = PLAYER_MODELS_CH as readonly string[]
  const bots: { bot: Bot; info: BotInfo; timer: NodeJS.Timeout | null }[] = []
  const makeBot = async (k: number) => {
    const acc = await register('cb')
    // 16 sockets per IP: every bot its own loopback address
    const bot = await Bot.open(base, acc.token, `127.0.${1 + Math.floor(k / 200)}.${20 + (k % 200)}`)
    // alternate genders; every Chinese body in turn
    const female = k % 2 === 1
    const pool = models.filter(m => m.includes('_WOMAN_') === female)
    const model = pool[Math.floor(k / 2) % pool.length]!
    const weapon = STARTER_WEAPONS[k % STARTER_WEAPONS.length]!
    const name = nameOf('Cb')
    let id: number
    try {
      id = await create(bot, name, model, weapon)
      const entered = bot.next('worldEnter', () => true, 30000)
      bot.send({ t: 'enterWorld', id })
      bot.selfId = (await entered).self.id
    } catch (err) {
      bot.close()
      throw err
    }
    const p = ctx.world.players.get(bot.selfId)
    const dress = dressFor(rand, p.gender, weapon, gear, ctx.data)
    const { result, draft } = ctx.store.inventoryTx(p.characterId, (d: any) => {
      for (const slot of EQUIP_SLOTS) if (d.equip[slot] && slot !== 'weapon') d.setEquip(slot, null)
      for (const [slot, code] of Object.entries(dress.equip) as [EquipSlot, string][]) {
        const def = ctx.data.item(code) as ItemDef | undefined
        if (!def?.slot || !equipSlotsFor(def.slot).includes(slot)) continue
        d.setEquip(slot, { code, count: 1, plus: slot === 'weapon' ? dress.plus : 0 })
      }
      return { ok: true, value: undefined }
    })
    if (result.ok) ctx.gameplay.afterInventory(p, draft)
    const info: BotInfo = { name, model, weapon, behaviour: behaviourOf(k, o.bots), ...dress }
    bots.push({ bot, info, timer: null })
  }
  try {
    for (let k = 0; k < o.bots; k++) {
      for (let attempt = 1; ; attempt++) {
        try {
          await makeBot(k)
          break
        } catch (err) {
          progress(`bot ${k} attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`)
          if (attempt >= 3) throw err
          await sleep(1000)
        }
      }
      if (k % 20 === 19) progress(`${k + 1} bots in`)
    }
  } catch (err) {
    for (const b of bots) b.bot.close()
    await server.close()
    throw err
  }

  // ---- placement (server side, as the GM tp does: the bots are ordinary players, no [GM] tag) ----
  const place = (b: Bot, x: number, z: number) => {
    const p = ctx.world.players.get(b.selfId)
    if (!p) return
    ctx.world.warp(p, x, p.pos[1], z, Date.now(), ctx.world.placeFor(x, z, Infinity))
    ctx.gameplay.warped(p, 'gm')
  }
  for (let k = 0; k < bots.length; k++) {
    const [x, z] = plazaPoint(k, bots.length)
    place(bots[k]!.bot, x, z)
  }
  // ---- the fighters' monsters: spawned by the first fighter, at the plaza centre ----
  const fighters = bots.filter(b => b.info.behaviour === 'fight')
  const mobIds: number[] = []
  if (fighters.length) {
    const g = fighters[0]!.bot
    place(g, PLAZA.x, PLAZA.z)
    const def = ctx.data.mob(FIGHT_MOB)
    if (def) mobIds.push(...(ctx.gameplay.gmSpawn(ctx.world.players.get(g.selfId), def, FIGHT_MOBS) as number[]))
    // they never die: the fight goes on for the whole bench
    for (const id of mobIds) {
      const m = ctx.world.mobs.get(id)
      if (m) m.maxHp = m.hp = 1_000_000
    }
    const [x, z] = plazaPoint(bots.indexOf(fighters[0]!), bots.length)
    place(g, x, z)
  }
  const liveMob = (k: number) => {
    const live = mobIds.map(id => ctx.world.mobs.get(id)).filter((m: any) => m && m.ai !== 'dead')
    return live.length ? live[k % live.length] : null
  }

  // ---- behaviours ----
  let behaving = true
  const act = (k: number) => {
    const b = bots[k]!
    if (!behaving || b.bot.closed) return
    const kind = b.info.behaviour
    if (kind === 'walk') {
      const a = rand() * Math.PI * 2
      const rr = 3 + rand() * (PLAZA.r - 3)
      b.bot.send({ t: 'moveTo', x: +(PLAZA.x + rr * Math.cos(a)).toFixed(1), z: +(PLAZA.z + rr * Math.sin(a)).toFixed(1) })
    } else if (kind === 'fight') {
      const m = liveMob(k)
      if (m) b.bot.send({ t: 'attack', target: m.id })
    } else if (kind === 'wave') {
      b.bot.send({ t: 'emote', emote: EMOTE_KINDS[Math.floor(rand() * EMOTE_KINDS.length)] })
    }
  }
  for (let k = 0; k < bots.length; k++) {
    const b = bots[k]!
    if (b.info.behaviour === 'sit') b.bot.send({ t: 'sit', on: true })
    const every = b.info.behaviour === 'walk' ? 4000 + rand() * 3000 : b.info.behaviour === 'fight' ? 2500 : b.info.behaviour === 'wave' ? 6000 + rand() * 4000 : 0
    if (!every) continue
    setTimeout(() => act(k), rand() * 1500)
    b.timer = setInterval(() => act(k), every)
  }
  // the fight goes on: monsters held over half HP, bots never die
  const hold = setInterval(() => {
    for (const b of bots) {
      const p = ctx.world.players.get(b.bot.selfId)
      if (p && (p.dead || p.hp < p.maxHp * 0.5)) {
        if (p.dead) ctx.gameplay.gmHeal(p)
        else p.hp = p.maxHp
      }
    }
    for (const id of mobIds) {
      const m = ctx.world.mobs.get(id)
      if (m && m.ai !== 'dead' && m.hp < m.maxHp * 0.5) m.hp = m.maxHp
    }
  }, 300)

  const bench: CharBench = {
    server,
    tab: { token: tabAcc.token, username: tabAcc.username, expiresAt: tabAcc.expiresAt, character: tabName },
    bots: bots.map(b => b.info),
    status() {
      const byBehaviour: Record<string, number> = {}
      for (const b of bots) byBehaviour[b.info.behaviour] = (byBehaviour[b.info.behaviour] ?? 0) + 1
      const mobs = mobIds.filter(id => ctx.world.mobs.get(id)?.ai !== 'dead').length
      return { bots: bots.length, online: bots.filter(b => !b.bot.closed).length, behaving, byBehaviour, mobs }
    },
    setBehaving(on: boolean) {
      behaving = on
      if (!on) for (const b of bots) if (b.info.behaviour === 'walk' || b.info.behaviour === 'fight') b.bot.send({ t: 'stopAction' })
    },
    async close() {
      clearInterval(hold)
      for (const b of bots) {
        if (b.timer) clearInterval(b.timer)
        b.bot.close()
      }
      control?.close()
      await sleep(200)
      await server.close()
    },
  }

  let control: Server | null = null
  if (o.control !== false) {
    control = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x')
      const out = (v: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('access-control-allow-origin', '*')
        res.end(JSON.stringify(v))
      }
      if (u.pathname === '/tab') return out(bench.tab)
      if (u.pathname === '/status') return out(bench.status())
      if (u.pathname === '/bots') return out(bench.bots)
      if (u.pathname === '/behave') {
        bench.setBehaving(u.searchParams.get('on') !== '0')
        return out(bench.status())
      }
      res.statusCode = 404
      out({ error: 'unknown' })
    }).listen(o.port + 1, '127.0.0.1')
  }
  return bench
}
