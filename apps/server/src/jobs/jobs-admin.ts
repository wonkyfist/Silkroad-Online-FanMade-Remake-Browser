import { JOB_FLAG_RULES, type AdminEventInfo, type AdminJobsView, type JobSide } from '@sro/shared'
import type { GameContext } from '../game.ts'
import { registerAdminEvent, registerAdminRouteGroup, type AdminGroupRequest, type AdminGroupResponse } from '../admin/routes.ts'

/**
 * The job system in the admin panel (docs/JOBS.md §9.5): the route group `jobs` (`/api/admin/jobs/*`).
 * The panel's router authenticates and writes its admin_audit row; this handler re-checks the admin role and adds a
 * gm_audit row (command `job`) per write, so the GM command and the panel share one trail.
 *
 * GET '' (members by job and level, account sides, the settings, the content), PUT settings {baseRev, patch}, POST
 * settings/reset {paths?, baseRev?}, POST member {character, join?, leave?, level?, exp?, mode?, side?} (the GM verbs).
 * Layers 2-3: GET '' also lists the market and the transports; POST market {post, good, demand?, buyMul?} or {reset: true}
 * (the GM `trade` verbs).
 * Layer 7 (the "Jobs & Trade" page and the Silk Caravan): GET '' adds the members' accounts, the latest trades and
 * robberies, the open robbery warrants, the job law flags and the event; POST member also takes {revoke: days} /
 * {restore: true} / {resetWaits: true}; POST transport {character, action: heal|kill|dismiss}; POST robbery {character,
 * action: clear|jail, minutes?}; POST event/start {minutes?, post?}, POST event/stop. The Events page lists the Silk
 * Caravan with this group as its routes.
 */

const PREFIX = '/api/admin/jobs'
const DAY_MS = 86_400_000

function err(status: number, message: string, extra: Record<string, unknown> = {}): AdminGroupResponse {
  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'bad_request'
  return { status, body: { ...extra, error: code, message } }
}

/** GET /api/admin/jobs: everything the page shows. */
export function jobsView(ctx: GameContext, now: number): AdminJobsView {
  const g = ctx.gameplay
  const name = (id: number) => ctx.store.characterById(id)?.name ?? `#${id}`
  const base = g.jobs.adminView(now)
  const sides = new Map(base.accounts.map((a) => [a.accountId, a.side] as [number, JobSide]))
  let accountName: (id: number) => string = (id) => `#${id}`
  try {
    const q = ctx.store.db.prepare<[number], { username: string }>('SELECT username FROM accounts WHERE id = ?')
    accountName = (id) => q.get(id)?.username ?? `#${id}`
  } catch {
    // no accounts table in a bare store
  }
  const memberInfo = base.members.map((m) => {
    const c = ctx.store.characterById(m.characterId)
    const acc = c?.account_id ?? 0
    return { characterId: m.characterId, accountId: acc, account: accountName(acc), side: sides.get(acc) ?? null, charLevel: c?.level ?? 0 }
  })
  const safe = <T>(f: () => T, d: T): T => {
    try {
      return f()
    } catch {
      return d
    }
  }
  return {
    ...base,
    market: g.market.adminMarket(now),
    transports: g.transports.adminTransports(),
    sacks: g.robbery.adminSacks(),
    memberInfo,
    trades: safe(() => g.market.store.recent(200).map((r) => ({ id: r.id, at: r.at, name: name(r.character_id), kind: r.kind, post: r.post, good: r.good, crates: r.crates, gold: r.gold, stars: r.stars })), []),
    robberies: safe(() => g.robbery.store.recent(200).map((r) => ({ id: r.id, at: r.at, kind: r.kind, actor: name(r.actor_character), actorAccount: r.actor_account, victim: name(r.victim_character), victimAccount: r.victim_account, batch: r.batch })), []),
    robbers: g.law
      .openList()
      .filter((w) => w.row.reason === 'robbery')
      .map((w) => ({ warrant: w.row.id, characterId: w.row.character_id, name: name(w.row.character_id), bounty: w.row.bounty, issuedAt: w.row.issued_at, onlineLeftMs: w.leftMs, online: w.online })),
    flags: safe(
      () =>
        g.law.store
          .flags(300)
          .filter((f) => JOB_FLAG_RULES.includes(f.rule))
          .map((f) => ({ id: f.id, at: f.at, rule: f.rule, actor: name(f.hunter_character), actorId: f.hunter_character, actorAccount: f.hunter_account, victim: name(f.wanted_character), victimId: f.wanted_character, victimAccount: f.wanted_account, withheld: f.withheld })),
      [],
    ),
    event: g.caravan.view(now),
  }
}

export async function routeAdminJobs(ctx: GameContext, req: AdminGroupRequest): Promise<AdminGroupResponse> {
  if (req.actor.role !== 'admin') return err(403, 'admin accounts only')
  const g = ctx.gameplay
  const jobs = g.jobs
  const now = g.now
  const sub = req.path.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const b = typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {}
  const audit = (args: string[], result: string, ok: boolean) =>
    ctx.store.audit({ accountId: req.actor.accountId, characterId: null, command: 'job', args, result: `admin: ${result}`, ok })
  const character = () => {
    const c = b.character
    return typeof c === 'number' && Number.isInteger(c) ? ctx.store.characterById(c) : typeof c === 'string' && /^[^\s]{1,32}$/.test(c.trim()) ? ctx.store.characterByName(c.trim()) : undefined
  }

  if (req.method === 'GET' && sub === '') return { status: 200, body: jobsView(ctx, now) }
  if (req.method === 'POST' && sub === 'market') {
    const market = g.market
    const verbs: string[][] = []
    if (b.reset === true) verbs.push(['reset'])
    const named = typeof b.post === 'string' && typeof b.good === 'string'
    if (named && typeof b.demand === 'number') verbs.push(['price', b.post as string, b.good as string, String(b.demand)])
    if (named && typeof b.buyMul === 'number') verbs.push(['buy', b.post as string, b.good as string, String(b.buyMul)])
    if (verbs.length === 0) return err(400, 'give {reset: true} or {post, good, demand} / {post, good, buyMul}')
    let last = { ok: true, message: '' }
    for (const v of verbs) {
      last = market.gm(v, now)
      audit(['market', ...v], last.message, last.ok)
      if (!last.ok) return err(400, last.message)
    }
    return { status: 200, body: { message: last.message, market: market.adminMarket(now) } }
  }
  if (req.method === 'PUT' && sub === 'settings') {
    const r = jobs.saveSettings(b.baseRev, b.patch, req.actor.accountId, now)
    audit(['settings', JSON.stringify(b.patch ?? null).slice(0, 400)], r.ok ? `rev ${r.rev}` : r.message, r.ok)
    return r.ok ? { status: 200, body: { rev: r.rev, effective: jobs.settings, patch: jobs.patch } } : err(r.status, r.message, r.issues ? { issues: r.issues } : {})
  }
  if (req.method === 'POST' && sub === 'settings/reset') {
    if (b.baseRev !== undefined && b.baseRev !== jobs.rev) return err(409, `The settings were changed since you loaded them (rev ${jobs.rev}). Reload and try again.`)
    const r = jobs.resetSettings(b.paths, req.actor.accountId, now)
    audit(['settings-reset', JSON.stringify(b.paths ?? 'all').slice(0, 400)], r.ok ? `rev ${r.rev}` : r.message, r.ok)
    return r.ok ? { status: 200, body: { rev: r.rev, effective: jobs.settings, patch: jobs.patch } } : err(r.status, r.message)
  }
  if (req.method === 'POST' && sub === 'member') {
    const row = character()
    if (!row) return err(400, 'character must be a character name or id')
    // layer 7: licence and waits
    const extra = [b.revoke !== undefined, b.restore === true, b.resetWaits === true].filter(Boolean).length
    if (extra > 0) {
      const gmVerbs = ['join', 'leave', 'level', 'exp', 'mode', 'side'].filter((k) => b[k] !== undefined).length
      if (extra + gmVerbs !== 1) return err(400, 'give exactly one of join, leave, level, exp, mode, side, revoke, restore, resetWaits')
      if (b.resetWaits === true) {
        const ok = jobs.adminResetWaits(row.account_id)
        const msg = ok ? `${row.name}'s account may take a job and change sides again now.` : `${row.name}'s account has no job record.`
        audit([row.name, 'reset-waits'], msg, ok)
        return ok ? { status: 200, body: { message: msg } } : err(400, msg)
      }
      let until: number | null = null
      if (b.revoke !== undefined) {
        const days = b.revoke
        if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || days > 3650) return err(400, 'revoke must be a number of days (0-3650)')
        until = now + Math.round(days * DAY_MS)
      }
      const job = jobs.adminRevoke(row.id, until, now)
      const msg = job === null ? `${row.name} has no job.` : until === null ? `${row.name}'s licence is restored.` : job === 'hunter' ? `${row.name}'s Bounty Hunter licence is revoked for ${g.siege.settings.hunter.revokeDays} days (the siege's hunter.revokeDays).` : `${row.name}'s licence is revoked until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
      audit([row.name, until === null ? 'restore' : 'revoke', ...(until === null ? [] : [String(b.revoke)])], msg, job !== null)
      return job !== null ? { status: 200, body: { message: msg } } : err(400, msg)
    }
    const verbs: string[][] = []
    if (typeof b.join === 'string') verbs.push(['join', b.join])
    if (b.leave === true) verbs.push(['leave'])
    if (Number.isInteger(b.level)) verbs.push(['level', String(b.level)])
    if (Number.isInteger(b.exp)) verbs.push(['exp', String(b.exp)])
    if (typeof b.mode === 'boolean') verbs.push(['mode', b.mode ? 'on' : 'off'])
    if (typeof b.side === 'string') verbs.push(['side', b.side])
    if (verbs.length !== 1) return err(400, 'give exactly one of join, leave, level, exp, mode, side, revoke, restore, resetWaits')
    const r = jobs.gm([row.name, ...verbs[0]!], now)
    audit([row.name, ...verbs[0]!], r.message, r.ok)
    return r.ok ? { status: 200, body: { message: r.message } } : err(400, r.message)
  }
  if (req.method === 'POST' && sub === 'transport') {
    const row = character()
    if (!row) return err(400, 'character must be a character name or id')
    const a = b.action
    if (a !== 'heal' && a !== 'kill' && a !== 'dismiss') return err(400, "action must be 'heal', 'kill' or 'dismiss'")
    const r = g.transports.gm([row.name, a], now)
    audit(['transport', row.name, a], r.message, r.ok)
    return r.ok ? { status: 200, body: { message: r.message } } : err(400, r.message)
  }
  if (req.method === 'POST' && sub === 'robbery') {
    const row = character()
    if (!row) return err(400, 'character must be a character name or id')
    const a = b.action
    if (a === 'clear') {
      const r = g.robbery.gm([row.name, 'clear'], now)
      audit(['robbery', row.name, 'clear'], r.message, r.ok)
      return r.ok ? { status: 200, body: { message: r.message } } : err(400, r.message)
    }
    if (a === 'jail') {
      const min = b.minutes
      if (typeof min !== 'number' || !Number.isFinite(min) || min < 1 || min > 10_080) return err(400, 'minutes must be a number from 1 to 10080')
      const r = g.jail.gmJail(row.name, min, 'robbery (admin)', now, `admin ${req.actor.username}`)
      audit(['robbery', row.name, 'jail', String(min)], r.message, r.ok)
      return r.ok ? { status: 200, body: { message: r.message } } : err(409, r.message)
    }
    return err(400, "action must be 'clear' or 'jail'")
  }
  if (req.method === 'POST' && (sub === 'event/start' || sub === 'event/stop')) {
    if (sub === 'event/stop') {
      const r = g.caravan.stop('stopped', now, `stopped by ${req.actor.username}`)
      audit(['caravan', 'stop'], r.message, r.ok)
      return r.ok ? { status: 200, body: { message: r.message, event: g.caravan.view(now) } } : err(409, r.message)
    }
    const o: { minutes?: number; post?: string } = {}
    if (b.minutes !== undefined) {
      if (typeof b.minutes !== 'number' || !Number.isFinite(b.minutes) || b.minutes < 1 || b.minutes > 600) return err(400, 'minutes must be 1-600')
      o.minutes = b.minutes
    }
    if (b.post !== undefined && b.post !== '') {
      if (typeof b.post !== 'string') return err(400, 'post must be a trade post id')
      o.post = b.post
    }
    const r = g.caravan.start('admin', now, o)
    audit(['caravan', 'start', ...(o.minutes ? [String(o.minutes)] : []), ...(o.post ? [o.post] : [])], r.message, r.ok)
    return r.ok ? { status: 200, body: { message: r.message, event: g.caravan.view(now) } } : err(409, r.message)
  }
  return err(404, 'no such endpoint')
}

/** The Events page's entry for the Silk Caravan (docs/JOBS.md §8). */
function caravanInfo(ctx: GameContext): AdminEventInfo {
  const c = ctx.gameplay.caravan.view(ctx.gameplay.now)
  return {
    id: 'silk-caravan',
    name: 'Silk Caravan',
    about: 'Weekly trade event (off by default): one far trade post pays more, trade runs give more job EXP and a small gold reward, escorts and the den pay more, and the bandits ambush more often. Never during a siege or a Night of the Tiger.',
    state: !ctx.gameplay.jobs.placed ? 'unavailable' : c.running ? 'running' : c.nextAt !== null ? 'scheduled' : 'idle',
    spec: 'docs/JOBS.md §8',
    routes: 'jobs',
    nextAt: c.nextAt,
    settings: [],
    log: c.history.slice(0, 5).map((e) => ({ at: e.endedAt ?? e.at, text: `Silk Caravan ${e.id}: ${e.outcome}${e.post ? ` (${e.post})` : ''}${e.outcome !== 'skipped' ? `, ${e.runs} runs, ${e.rewarded} gold` : e.why ? `: ${e.why}` : ''}` })),
  }
}

let registered = false

/** Registers the route group and the Events entry once per process (several test servers share the registry). */
export function registerJobsAdmin(): void {
  if (registered) return
  registered = true
  registerAdminRouteGroup({ prefix: 'jobs', handle: routeAdminJobs })
  registerAdminEvent({ id: 'silk-caravan', info: caravanInfo })
}
