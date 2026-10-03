/**
 * The wave-8 end-to-end harness (docs/WAVE_PLAN2.md §6.7, lane I8): one real server on the REAL jangan-fields export
 * (temp DATA_DIR, work/out + work/out-opt), driven over WebSockets by helpers.ts clients whose every frame the strict
 * shared parser checks. combat-e2e, social-e2e and wave8-cross-e2e use it; `restart()` reopens the same DATA_DIR.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerMessage } from '@sro/shared'
import { expect } from 'vitest'
import { REPO_ROOT, type ServerConfig } from '../src/config.ts'
import { startServer, type GameServer } from '../src/game.ts'
import type { Npc } from '../src/world.ts'
import { seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, testConfig } from './helpers.ts'

export const OUT = join(REPO_ROOT, 'work/out')
export const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'npcs', 'shops', 'skills', 'masteries', 'cos'].map((f) => join(OUT, `data/${f}.json`))
const hasExport = (folder: string) => {
  const man = join(OUT, 'world', folder, 'manifest.json')
  if (!existsSync(man) || !DATA.every((f) => existsSync(f))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world', folder, m.nav.file))
}
/** Both exports and the wave-8 data (cos.json, MSKILL rows) are there. */
export const HAVE_W8 = hasExport('jangan') && hasExport('jangan-fields')

export type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** The Mangnyang field south of the town gate (wave3-e2e), outside the safe area. */
export const FIELD: [number, number] = [108.97, 120]
/** GATE_CH, the town return point (the manifests' spawn): inside the safe area. */
export const GATE: [number, number] = [96.9, -136.9]
export const CODES = {
  horse: 'ITEM_COS_C_HORSE1',
  kit: 'ITEM_ETC_COS_HP_POTION_01',
  sword: 'ITEM_CH_SWORD_01_A',
  elixir: 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A',
  powder: 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01',
  herb: 'ITEM_ETC_HP_POTION_01',
  gold: 'ITEM_ETC_GOLD_01',
  mang: 'MOB_CH_MANGNYANG',
  blackTiger: 'MOB_CH_WHITETIGER_CLON',
  tombGhost: 'MOB_CH_TOMBSTONE_CLON',
  smith: 'NPC_CH_SMITH',
  guildManager: 'NPC_CH_GENARAL_SP',
} as const

export async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(20)
  }
}

export type Hero = Awaited<ReturnType<W8Harness['hero']>>

export class W8Harness {
  s!: GameServer & { root: string }
  cfg!: ServerConfig
  /** The gameplay random source; a flow may pin it with pin() (null restores the seeded one). */
  private roll: () => number = seeded(81)
  private names = 0
  readonly logs: string[] = []

  constructor(
    readonly prefix: string,
    private readonly extra: Partial<ServerConfig> = {},
  ) {}

  pin(r: (() => number) | null): void {
    this.roll = r ?? seeded(82)
  }

  async start(): Promise<void> {
    const t = await startTestServer({
      logs: this.logs,
      config: {
        outDir: OUT,
        outOptDir: OUT_OPT,
        serveStatic: false,
        moveSpeed: 30,
        tickHz: 20,
        rolePollMs: 50,
        rng: () => this.roll(),
        worldExport: 'jangan-fields',
        ...this.extra,
      },
    })
    this.s = t
    this.cfg = { ...testConfig(t.root, this.logs), outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, moveSpeed: 30, tickHz: 20, rolePollMs: 50, rng: () => this.roll(), worldExport: 'jangan-fields', ...this.extra }
    expect(t.ctx.nav.kind).toBe('mesh')
  }

  /** Stops the server and starts a new one on the same DATA_DIR (a restart: runtime state is gone). */
  async restart(): Promise<void> {
    const root = this.s.root
    await this.s.close()
    const next = await startServer(this.cfg)
    this.s = Object.assign(next, { root })
  }

  async stop(): Promise<void> {
    if (!this.s) return
    await this.s.close()
    rmSync(this.s.root, { recursive: true, force: true })
  }

  get g() {
    return this.s.ctx.gameplay
  }
  player(id: number) {
    return this.s.ctx.world.players.get(id)!
  }
  npc(code: string): Npc {
    const n = [...this.s.ctx.world.npcs.values()].find((x) => x.code === code)
    if (!n) throw new Error(`no NPC ${code}`)
    return n
  }
  inv(characterId: number) {
    return this.s.ctx.store.loadInventory(characterId)
  }
  slotOf(characterId: number, code: string, from = 0): number {
    return this.inv(characterId).bag.findIndex((i, n) => n >= from && i?.code === code)
  }
  count(characterId: number, code: string): number {
    return this.inv(characterId).bag.reduce((n, i) => n + (i?.code === code ? i.count : 0), 0)
  }

  /** A fresh GM account (set as the owner CLI does) with one character in the world; the enter frames are kept. */
  async hero(opts: { level?: number } = {}) {
    const acc = await newAccount(this.s.url, this.prefix)
    const accountId = this.s.ctx.store.accountByName(acc.username)!.id
    this.s.ctx.store.setRole(accountId, 'gm')
    const c = await Client.login(this.s.url, acc.token)
    const name = `${this.prefix}${(Date.now() % 1e4).toString(36)}${++this.names}`.slice(0, 12)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
    const ch = (await c.next('charCreated')).character
    const e = await this.enter(c, ch.id)
    const hero = { c, acc, accountId, ch, name, characterId: ch.id, ...e }
    if (opts.level) await this.gm(hero.c, 'setlevel', name, String(opts.level))
    return hero
  }

  /** enterWorld; returns the worldEnter and the order of the enter frames that arrived within `settleMs`. */
  async enter(c: Client, characterId: number, settleMs = 0) {
    const from = c.log.length
    c.send({ t: 'enterWorld', id: characterId })
    const w = await c.next('worldEnter')
    const stats = await c.next('stats')
    await c.next('inventory')
    await c.next('skills')
    if (settleMs) await sleep(settleMs)
    return { w, id: w.self.id, stats, enterLog: () => c.log.slice(from) }
  }

  /** Logs `hero` in again on a new socket (the old one is closed first). */
  async relog(hero: Hero, settleMs = 300) {
    hero.c.close()
    await hero.c.closed
    await until(() => ![...this.s.ctx.world.players.values()].some((p) => p.characterId === hero.characterId), 'the old session to leave')
    const c = await Client.login(this.s.url, (await this.login(hero.acc.username)).token)
    const e = await this.enter(c, hero.characterId, settleMs)
    return { ...hero, c, ...e }
  }

  private async login(username: string): Promise<{ token: string }> {
    const res = await fetch(`${this.s.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) })
    expect(res.status).toBe(200)
    return (await res.json()) as { token: string }
  }

  async gm(c: Client, cmd: string, ...args: string[]) {
    c.send({ t: 'gm', cmd, args })
    const r = await c.next('gmResult', (m) => m.cmd === cmd)
    expect(r.ok, `${cmd} ${args.join(' ')}: ${r.message}`).toBe(true)
    return r
  }

  async act(c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
  }

  /** GM teleport and wait for the own warp. */
  async tp(h: Hero, x: number, z: number): Promise<void> {
    await this.gm(h.c, 'tp', String(x), String(z))
    await h.c.next('warp', (m) => m.id === h.id)
  }

  /** Puts `n` of `code` into the bag (GM /item); returns the first bag slot holding it. */
  async give(h: Hero, code: string, n = 1): Promise<number> {
    await this.gm(h.c, 'item', code, String(n))
    await h.c.next('inventoryUpdate')
    return this.slotOf(h.characterId, code)
  }

  /** A town point (safe area, walkable) at least `clear` m from every NPC, near GATE (stalls need one). */
  townSpot(clear = 5, skip: [number, number][] = []): [number, number] {
    const { data, config, world } = this.s.ctx
    for (let r = 0; r < 60; r += 2) {
      for (let a = 0; a < 16; a++) {
        const x = GATE[0] + r * Math.cos((a / 16) * Math.PI * 2)
        const z = GATE[1] + r * Math.sin((a / 16) * Math.PI * 2)
        if (!data.inSafeArea(config.world, x, z)) continue
        if (!world.placeFor(x, z, Infinity)) continue
        if ([...world.npcs.values()].some((n) => Math.hypot(n.pos[0] - x, n.pos[2] - z) < clear)) continue
        if (skip.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 4)) continue
        return [Math.round(x * 100) / 100, Math.round(z * 100) / 100]
      }
    }
    throw new Error('no free town spot')
  }

  /** Drops every queued (unread) frame of these clients, so the next next() waits for a fresh one. */
  drain(...heroes: { c: Client }[]): void {
    for (const x of heroes) x.c.queue.length = 0
  }

  async bye(...heroes: { c: Client }[]): Promise<void> {
    for (const x of heroes) x.c.close()
    await Promise.all(heroes.map((x) => x.c.closed))
  }
}
