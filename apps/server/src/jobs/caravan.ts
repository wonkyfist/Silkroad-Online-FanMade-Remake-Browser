import {
  type CaravanLogEntry,
  type CaravanOrigin,
  type CaravanView,
  type GameplayRequest,
  type JobSettings,
  type TradePointId,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold } from '../inventory.ts'
import type { GameplayModule } from '../modules.ts'
import { nextSlotAt, zoneOf } from '../pilot/lottery.ts'
import type { Player } from '../world.ts'

/**
 * The job system, layer 7: the weekly **Silk Caravan** (docs/JOBS.md §8). A GameplayModule named `caravan`, after
 * `robbery`; off by default (`event.enabled`).
 *
 * - **Start**: a weekly slot (`event.slots`, `event.tz`; Saturday 20:00 by default), GM `caravan start [minutes] [post]`
 *   or the admin's Start. Never during a Siege of Jangan or a Night of the Tiger: a due slot waits up to
 *   `event.busyWaitMin`, then it is skipped; a manual start is refused. A slot more than 30 min late (the server was
 *   down) is skipped. An event running when a siege or a Night starts ends `interrupted`.
 * - **What it does** for `event.durationMin`: one far post (danger ≥ 4: the Ferry Landing or the Sea Cliffs, picked at
 *   random or named) pays demand × `event.demand`; Trader sales give job EXP × `event.expMul`; escorting Bounty Hunters
 *   × `event.escortMul`; ambushes × `event.ambushMul`; the den pays × `event.denMul`; a **completed run** (a profitable
 *   sale from a transport away from the post its load was bought at) pays `event.rewardGold`, at most `event.rewardRuns`
 *   per character per event (trade_log `caravan`). The modules ask `mul(kind)` / `demandAt(post)` / `completedRun`.
 * - **Announcement**: a server-wide notice (the NoticeBanner) and a chat line at the start and the end; a player who
 *   enters the world during it gets the chat line.
 * - **Persistence**: job_settings row `caravan_event` (the running event and the last 20 entries); a restart resumes a
 *   running event until its end.
 */

export const CARAVAN_CODE = 'caravan_event'
/** A slot found this late still starts; later it is skipped (ms). */
const MISSED_GRACE_MS = 30 * 60_000
const HISTORY = 20

interface Running {
  id: number
  startedAt: number
  endsAt: number
  post: TradePointId
  origin: CaravanOrigin
  runs: number
  rewarded: number
  /** characterId -> runs rewarded this event. */
  paid: Record<string, number>
}

interface Saved {
  seq: number
  running: Running | null
  history: CaravanLogEntry[]
}

export type CaravanMul = 'exp' | 'escort' | 'ambush' | 'den'

export class CaravanService implements GameplayModule {
  readonly name = 'caravan'
  readonly handles: readonly GameplayRequest[] = []
  private state: Saved | null = null
  private schedKey = ''
  private next: number | null = null
  private waitUntil = 0
  private booted = false

  constructor(private readonly g: Gameplay) {}

  private get s(): JobSettings['event'] {
    return this.g.jobs.settings.event
  }

  private load(): Saved {
    if (this.state) return this.state
    let v: Saved = { seq: 0, running: null, history: [] }
    try {
      const row = this.g.jobs.store.settingsOf(CARAVAN_CODE)
      if (row) {
        const o = JSON.parse(row.json) as Partial<Saved>
        v = { seq: Number(o.seq) || 0, running: o.running ?? null, history: Array.isArray(o.history) ? o.history.slice(0, HISTORY) : [] }
      }
    } catch {
      // no table (a bare test store) or a broken row: start empty
    }
    this.state = v
    return v
  }

  private save(now: number): void {
    const v = this.load()
    v.history = v.history.slice(0, HISTORY)
    try {
      this.g.jobs.store.saveSettings(CARAVAN_CODE, JSON.stringify(v), 1, now, null)
    } catch {
      // no table: the event lives in memory until the restart
    }
  }

  /** The running event, or null. */
  get running(): Readonly<Running> | null {
    return this.load().running
  }

  active(now: number): boolean {
    const r = this.load().running
    return !!r && now < r.endsAt
  }

  /** The far posts the event may boost (danger ≥ 4, else the two farthest from Jangan). */
  farPosts(): TradePointId[] {
    const posts = this.g.jobs.content.posts.filter((p) => p.id !== 'jangan')
    const far = posts.filter((p) => p.danger >= 4).map((p) => p.id)
    if (far.length) return far
    const j = this.g.jobs.content.posts.find((p) => p.id === 'jangan')
    return posts
      .slice()
      .sort((a, b) => (j ? Math.hypot(b.x - j.x, b.z - j.z) - Math.hypot(a.x - j.x, a.z - j.z) : 0))
      .slice(0, 2)
      .map((p) => p.id)
  }

  /** The demand multiplier at `post` now (1 off the event or elsewhere). */
  demandAt(post: TradePointId, now: number): number {
    const r = this.load().running
    return r && now < r.endsAt && r.post === post ? this.s.demand : 1
  }

  /** The event's multiplier of `kind` now (1 off the event). */
  mul(kind: CaravanMul, now: number): number {
    if (!this.active(now)) return 1
    const s = this.s
    return kind === 'exp' ? s.expMul : kind === 'escort' ? s.escortMul : kind === 'ambush' ? s.ambushMul : s.denMul
  }

  /** Why an event may not run now (a siege, a Night of the Tiger, the jobs off), or null. */
  busyWhy(): string | null {
    if (!this.g.jobs.settings.jobs.enabled) return 'the jobs are off'
    const siege = this.g.siege?.busyWhy?.() ?? null
    if (siege) return siege
    const ev = this.g.pilot?.event
    return ev && ev.phase !== 'ended' ? `a Night of the Tiger is on (${ev.phase})` : null
  }

  // ---- start / stop ------------------------------------------------------------------------------------------------------

  start(origin: CaravanOrigin, now: number, o: { minutes?: number; post?: string } = {}): { ok: true; message: string } | { ok: false; message: string } {
    const v = this.load()
    if (v.running) return { ok: false, message: `A Silk Caravan is running already (until ${new Date(v.running.endsAt).toISOString().slice(11, 16)} UTC).` }
    const why = this.busyWhy()
    if (why) return { ok: false, message: `No Silk Caravan now: ${why}.` }
    const far = this.farPosts()
    if (far.length === 0) return { ok: false, message: 'No trade posts on this server.' }
    let post: TradePointId
    if (o.post !== undefined) {
      const p = this.g.jobs.content.posts.find((x) => x.id === o.post || x.name.toLowerCase() === String(o.post).toLowerCase())
      if (!p || p.id === 'jangan') return { ok: false, message: `No trade post ${o.post} (one of ${this.g.jobs.content.posts.filter((x) => x.id !== 'jangan').map((x) => x.id).join(', ')}).` }
      post = p.id
    } else post = far[Math.floor(this.g.rng() * far.length) % far.length]!
    const minutes = o.minutes ?? this.s.durationMin
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) return { ok: false, message: 'minutes must be 1-600.' }
    const id = ++v.seq
    v.running = { id, startedAt: now, endsAt: now + Math.round(minutes * 60_000), post, origin, runs: 0, rewarded: 0, paid: {} }
    v.history.unshift({ id, at: now, endedAt: null, post, origin, outcome: 'running', runs: 0, rewarded: 0 })
    this.save(now)
    const name = this.postName(post)
    this.announce(`The Silk Caravan sets out! For ${Math.round(minutes)} minutes ${name} pays ${pct(this.s.demand)} for goods, trade runs give more job EXP and a reward, and the bandits are out in force.`)
    this.g.config.log(`caravan: #${id} started (${origin}) for ${minutes} min, boosted post ${post}`)
    return { ok: true, message: `The Silk Caravan #${id} runs for ${Math.round(minutes)} min; ${name} pays demand ×${this.s.demand}.` }
  }

  stop(outcome: 'ended' | 'stopped' | 'interrupted', now: number, why?: string): { ok: boolean; message: string } {
    const v = this.load()
    const r = v.running
    if (!r) return { ok: false, message: 'No Silk Caravan is running.' }
    v.running = null
    const h = v.history.find((x) => x.id === r.id)
    const entry: CaravanLogEntry = { id: r.id, at: r.startedAt, endedAt: now, post: r.post, origin: r.origin, outcome, runs: r.runs, rewarded: r.rewarded, ...(why ? { why } : {}) }
    if (h) Object.assign(h, entry)
    else v.history.unshift(entry)
    this.save(now)
    this.announce(outcome === 'ended' ? `The Silk Caravan is over: ${r.runs} run(s) completed. Prices return to normal.` : `The Silk Caravan is called off${why ? ` (${why})` : ''}. Prices return to normal.`)
    this.g.config.log(`caravan: #${r.id} ${outcome}${why ? ` (${why})` : ''}: ${r.runs} runs, ${r.rewarded} gold rewarded`)
    return { ok: true, message: `The Silk Caravan #${r.id} ${outcome === 'ended' ? 'ended' : 'stopped'} (${r.runs} run(s), ${r.rewarded.toLocaleString('en-US')} gold rewarded).` }
  }

  private skip(slot: number, why: string, now: number): void {
    const v = this.load()
    const id = ++v.seq
    v.history.unshift({ id, at: slot, endedAt: now, post: null, origin: 'schedule', outcome: 'skipped', runs: 0, rewarded: 0, why })
    this.save(now)
    this.g.config.log(`caravan: the Silk Caravan of ${new Date(slot).toISOString()} is skipped: ${why}`)
  }

  private announce(text: string): void {
    for (const p of this.g.world.players.values()) {
      p.send({ t: 'notice', text, from: 'Silk Caravan' })
      p.send({ t: 'chat', channel: 'system', text: `[Silk Caravan] ${text}` })
    }
  }

  private postName(post: TradePointId): string {
    return this.g.jobs.content.posts.find((p) => p.id === post)?.name ?? post
  }

  // ---- runs --------------------------------------------------------------------------------------------------------------

  /**
   * A sale from a transport (market.ts): a completed run when it made a profit away from the post the load was bought at.
   * Pays `event.rewardGold` up to `event.rewardRuns` times per character per event. Returns the gold paid.
   */
  completedRun(p: Player, from: TradePointId | null, post: TradePointId, profit: number, now: number): number {
    const v = this.load()
    const r = v.running
    if (!r || now >= r.endsAt || !from || from === post || !(profit > 0)) return 0
    r.runs++
    const key = String(p.characterId)
    const done = r.paid[key] ?? 0
    const gold = this.s.rewardGold
    if (done >= this.s.rewardRuns || gold <= 0) {
      this.save(now)
      return 0
    }
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addGold(d, gold, { strict: true }))
    if (!result.ok) {
      this.save(now)
      return 0
    }
    this.g.afterInventory(p, draft)
    r.paid[key] = done + 1
    r.rewarded += gold
    const h = v.history.find((x) => x.id === r.id)
    if (h) Object.assign(h, { runs: r.runs, rewarded: r.rewarded })
    this.save(now)
    this.g.market.log(p.characterId, 'caravan', post, null, 0, gold, 0, now)
    p.send({ t: 'chat', channel: 'system', text: `[Silk Caravan] A run completed: +${gold.toLocaleString('en-US')} gold (${done + 1} of ${this.s.rewardRuns}).` })
    return gold
  }

  // ---- the schedule --------------------------------------------------------------------------------------------------

  tick(now: number): void {
    const v = this.load()
    const r = v.running
    if (r) {
      if (!this.booted && now >= r.endsAt) this.close(r, 'restart', now)
      else if (now >= r.endsAt) this.stop('ended', now)
      else {
        const why = this.busyWhy()
        if (why) this.stop('interrupted', now, why)
      }
    }
    this.booted = true
    this.schedule(now)
  }

  /** A running event found ended at boot: closed without an announcement. */
  private close(r: Running, outcome: 'restart', now: number): void {
    const v = this.load()
    v.running = null
    const h = v.history.find((x) => x.id === r.id)
    if (h) Object.assign(h, { endedAt: r.endsAt, outcome, runs: r.runs, rewarded: r.rewarded })
    this.save(now)
  }

  schedule(now: number): void {
    const s = this.s
    const key = JSON.stringify([s.enabled, s.slots, s.tz])
    if (key !== this.schedKey) {
      // at boot a slot up to 30 min old still starts; a later change of the schedule looks forward only
      const from = this.schedKey === '' ? now - MISSED_GRACE_MS : now
      this.schedKey = key
      this.next = s.enabled ? nextSlotAt(s.slots, s.tz, from) : null
      this.waitUntil = 0
    }
    const slot = this.next
    if (slot === null || now < slot) return
    const advance = () => {
      this.next = nextSlotAt(s.slots, s.tz, Math.max(slot, now))
      this.waitUntil = 0
    }
    if (this.load().running) return advance()
    if (now - slot > MISSED_GRACE_MS && this.waitUntil === 0) {
      advance()
      return this.skip(slot, `${Math.round((now - slot) / 60_000)} min late (the server was down)`, now)
    }
    const why = this.busyWhy()
    if (why) {
      if (this.waitUntil === 0) this.waitUntil = slot + s.busyWaitMin * 60_000
      if (now < this.waitUntil) return
      advance()
      return this.skip(slot, why, now)
    }
    advance()
    const r = this.start('schedule', now)
    if (!r.ok) this.skip(slot, r.message, now)
  }

  enter(p: Player, now: number): void {
    const r = this.load().running
    if (!r || now >= r.endsAt) return
    p.send({ t: 'chat', channel: 'system', text: `[Silk Caravan] The Silk Caravan is on for ${Math.ceil((r.endsAt - now) / 60_000)} more minute(s): ${this.postName(r.post)} pays ${pct(this.s.demand)} for goods.` })
  }

  view(now: number): CaravanView {
    const v = this.load()
    const r = v.running
    if (this.schedKey === '') this.schedule(now)
    return {
      enabled: this.s.enabled,
      running: r ? { id: r.id, startedAt: r.startedAt, endsAt: r.endsAt, post: r.post, origin: r.origin, runs: r.runs, rewarded: r.rewarded } : null,
      nextAt: this.next,
      waitUntil: this.waitUntil > now ? this.waitUntil : null,
      zone: zoneOf(this.s.tz),
      posts: this.farPosts(),
      history: structuredClone(v.history),
    }
  }

  // ---- GM ------------------------------------------------------------------------------------------------------------

  /** `caravan [status] | caravan start [minutes] [post] | caravan stop`. */
  gm(args: readonly string[], now: number): GmResult {
    const v = (args[0] ?? 'status').toLowerCase()
    if (v === 'start') {
      const rest = args.slice(1)
      const num = rest.find((a) => /^\d+(\.\d+)?$/.test(a))
      const post = rest.find((a) => !/^\d+(\.\d+)?$/.test(a))
      const r = this.start('gm', now, { ...(num ? { minutes: Number(num) } : {}), ...(post ? { post } : {}) })
      return { ok: r.ok, message: r.message }
    }
    if (v === 'stop') return this.stop('stopped', now, 'a GM stopped it')
    if (v === 'status') {
      const c = this.view(now)
      const run = c.running
      const next = c.nextAt !== null ? `next ${new Date(c.nextAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : c.enabled ? 'no slots' : 'the weekly schedule is off'
      if (run) return { ok: true, message: `Silk Caravan #${run.id} (${run.origin}) until ${new Date(run.endsAt).toISOString().slice(11, 16)} UTC: ${this.postName(run.post)} × ${this.s.demand}; ${run.runs} run(s), ${run.rewarded} gold rewarded; ${next}.` }
      return { ok: true, message: `No Silk Caravan running; ${next}.${this.busyWhy() ? ` (${this.busyWhy()})` : ''}` }
    }
    return { ok: false, message: `Usage: ${CARAVAN_USAGE}` }
  }
}

function pct(mul: number): string {
  return `${Math.round((mul - 1) * 100)} % more`
}

export const CARAVAN_USAGE = 'caravan [status] | caravan start [minutes] [post] | caravan stop'
