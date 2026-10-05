import { PILOT_BOUNDS, PILOT_DEFAULTS, type AdminBossView, type AdminEventInfo, type PilotBlockView, type PilotEventSummary, type PilotLogLine, type PilotVolunteerView } from '@sro/shared'
import type { GameContext } from '../game.ts'
import { registerAdminEvent, registerAdminRouteGroup, type AdminGroupRequest, type AdminGroupResponse } from '../admin/routes.ts'
import { zoneOf } from './lottery.ts'
import type { Pilot } from './service.ts'
import { resetSettings, saveSettings, type SettingsResult } from './settings.ts'
import type { PilotEventRow } from './store.ts'
import type { PilotConf } from './types.ts'

/**
 * Play the Boss in the admin panel (docs/PLAY_THE_BOSS.md §6.3, docs/ADMIN.md §3.1): the route group `boss`
 * (`/api/admin/boss/*`) and the Events page's entry. The panel's router authenticates the admin and writes its
 * admin_audit row per write; this handler re-checks the role and adds a gm_audit row (command `pilot`) per write, so
 * the GM commands and the panel share one trail. Every write calls the same service functions as `/unique pilot`.
 *
 * GET '' (status, schedule, settings), PUT settings, POST settings/reset, POST start | pick | stop, GET events,
 * GET events/:id (timeline, volunteers in draw order), GET blocks, PUT | DELETE blocks/:account, GET eligibility.
 */

const PREFIX = '/api/admin/boss'

function json(status: number, body: unknown): AdminGroupResponse {
  return { status, body }
}

function err(status: number, message: string, code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'bad_request', extra: Record<string, unknown> = {}): AdminGroupResponse {
  return { status, body: { ...extra, error: code, message } }
}

export function summary(r: PilotEventRow): PilotEventSummary {
  let flags: string[] = []
  try {
    const f = JSON.parse(r.flags) as unknown
    if (Array.isArray(f)) flags = f.filter((x): x is string => typeof x === 'string')
  } catch {
    flags = []
  }
  return {
    id: r.id,
    code: r.code,
    origin: r.origin,
    phase: r.phase,
    createdAt: r.created_at,
    huntStartedAt: r.hunt_started_at,
    huntEndsAt: r.hunt_ends_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
    pilot: r.pilot_name,
    camp: r.camp,
    downs: r.downs,
    hunters: r.hunters,
    steeredMs: r.steered_ms,
    rewardGold: r.reward_gold,
    refunded: r.refunded === 1,
    flags,
  }
}

function settingsView(ctx: GameContext, conf: PilotConf): AdminBossView['settings'] {
  return { defaults: structuredClone(conf.defaults), effective: structuredClone(conf.settings), patch: structuredClone(conf.patch), rev: conf.rev, bounds: PILOT_BOUNDS, levelCap: ctx.config.levelCap }
}

function bossView(ctx: GameContext, s: Pilot, conf: PilotConf | null, now: number): AdminBossView {
  const uniques = (ctx.gameplay.uniques?.uniques ?? []).map((u) => {
    const m = u.id === null ? undefined : ctx.world.mobs.get(u.id)
    const alive = !!m && m.ai !== 'dead'
    return { code: u.def.mob, name: ctx.data.mob(u.def.mob)?.name ?? u.def.mob, alive, hpPct: alive ? Math.round((100 * m!.hp) / m!.maxHp) : null, steerable: !!u.def.pilot }
  })
  const ev = s.event
  const t = s.turn
  const mobOf = (id: number | undefined) => {
    const m = id === undefined ? undefined : ctx.world.mobs.get(id)
    return m && m.ai !== 'dead' ? m : null
  }
  const hpOf = (id: number | undefined) => {
    const m = mobOf(id)
    return m ? Math.round((100 * m.hp) / m.maxHp) : null
  }
  const current: AdminBossView['current'] =
    ev && ev.phase !== 'ended'
      ? {
          ...s.view(ev, now),
          origin: ev.origin,
          pilotName: ev.turn?.name ?? ev.offer?.name ?? null,
          flags: [...ev.flags],
          hpPct: hpOf(ev.turn?.mob),
          offerExpiresAt: ev.offer?.expiresAt ?? null,
          huntStartedAt: ev.huntStartedAt || null,
          ...(ev.turn ? { steering: ev.turn.steering, maxHp: mobOf(ev.turn.mob)?.maxHp ?? null } : {}),
          ...(ev.scale ? { scaleHunters: ev.scale.hunters } : {}),
          ...(ev.phase === 'offer' && ev.drawAt > 0 ? { drawAt: Math.round(ev.drawAt) } : {}),
        }
      : null
  const night = conf ? s.lottery.nextNight(conf) : null
  return {
    uniques,
    current,
    attach: t && !t.event ? { pilot: t.name, steering: t.steering, hpPct: hpOf(t.mob) } : null,
    nextNight: night,
    schedule: conf
      ? { tz: zoneOf(conf.settings.schedule.tz), enabled: conf.settings.enabled, nextCallAt: night === null ? null : night - conf.settings.call.minutes * 60_000 }
      : { tz: zoneOf(''), enabled: false, nextCallAt: null },
    settings: conf ? settingsView(ctx, conf) : { defaults: structuredClone(PILOT_DEFAULTS), effective: structuredClone(PILOT_DEFAULTS), patch: {}, rev: 0, bounds: PILOT_BOUNDS, levelCap: ctx.config.levelCap },
    features: ['pick', 'stop', 'call', 'schedule', 'settings', 'blocks', 'eligibility', 'scaling'],
  }
}

function bodyOf(req: AdminGroupRequest): Record<string, unknown> {
  const b = req.body
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

function blockViews(ctx: GameContext, s: Pilot, now: number): PilotBlockView[] {
  return s.store
    .blocks()
    .filter((b) => b.until > now)
    .map((b) => ({
      account: b.account_id,
      username: ctx.store.accountById(b.account_id)?.username ?? null,
      characters: ctx.store.characters(b.account_id).map((c) => c.name),
      until: b.until,
      reason: b.reason,
      by: b.by_account,
      byName: b.by_account === null ? null : (ctx.store.accountById(b.by_account)?.username ?? null),
      at: b.at,
    }))
}

function settingsAnswer(r: SettingsResult): AdminGroupResponse {
  if (r.ok) return json(200, { effective: r.effective, patch: r.patch, rev: r.rev })
  return err(r.status, r.message, r.status === 409 ? 'conflict' : 'bad_request', r.issues ? { issues: r.issues } : {})
}

/** `/api/admin/boss/*` (§6.3). */
export async function routeAdminBoss(ctx: GameContext, req: AdminGroupRequest): Promise<AdminGroupResponse> {
  if (req.actor.role !== 'admin') return err(403, 'admin accounts only', 'forbidden')
  const s = ctx.gameplay.pilot
  if (!s) return err(404, 'Play the Boss needs UNIQUES=on.')
  // The game clock (the last tick or request; Date.now() in production, the hand-driven clock in tests).
  const now = ctx.gameplay.now
  const sub = req.path.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const audit = (action: string, args: string[], result: string, ok: boolean) =>
    ctx.store.audit({ accountId: req.actor.accountId, characterId: null, command: 'pilot', args: [action, ...args], result: `admin: ${result}`, ok })
  const b = bodyOf(req)
  const codeQ = typeof b.code === 'string' ? b.code : (req.query.get('code') ?? '')
  const found = s.conf(codeQ)
  const conf = typeof found === 'string' ? null : found
  const needConf = () => err(404, typeof found === 'string' ? found : 'no steerable unique')

  if (req.method === 'GET' && sub === '') return json(200, bossView(ctx, s, conf, now))

  // ---- settings (§6.2) ----
  if (req.method === 'PUT' && sub === 'settings') {
    if (!conf) return needConf()
    const r = saveSettings(s.store, conf, b.baseRev, b.patch, req.actor.accountId, now, ctx.config.levelCap)
    audit('settings', [conf.code, JSON.stringify(b.patch ?? null).slice(0, 400)], r.ok ? `rev ${r.rev}` : r.message, r.ok)
    return settingsAnswer(r)
  }
  if (req.method === 'POST' && sub === 'settings/reset') {
    if (!conf) return needConf()
    const r = resetSettings(s.store, conf, b.paths, b.baseRev, req.actor.accountId, now, ctx.config.levelCap)
    audit('settings-reset', [conf.code, JSON.stringify(b.paths ?? 'all').slice(0, 400)], r.ok ? `rev ${r.rev}` : r.message, r.ok)
    return settingsAnswer(r)
  }

  // ---- the event: start, pick, stop ----
  if (req.method === 'POST' && sub === 'start') {
    const minutes = b.callMinutes
    if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60)) return err(400, 'callMinutes must be a whole number from 1 to 60')
    const r = s.startCall(codeQ, minutes as number | undefined, 'admin', now)
    audit('start', [codeQ, minutes === undefined ? '' : String(minutes)], r.message, r.ok)
    return r.ok ? json(200, { event: s.view(r.event, now), message: r.message }) : err(r.status, r.message)
  }
  if (req.method === 'POST' && sub === 'pick') {
    const character = typeof b.character === 'string' ? b.character.trim() : ''
    if (!/^@?[A-Za-z][A-Za-z0-9_]{2,11}$/.test(character)) return err(400, 'character must be a character name')
    const r = s.pick(codeQ, character, 'admin', now)
    audit('pick', [codeQ, character], r.message, r.ok)
    return r.ok ? json(200, { event: s.view(r.event, now), message: r.message }) : err(r.status, r.message)
  }
  if (req.method === 'POST' && sub === 'stop') {
    const r = s.stop(codeQ, `admin ${req.actor.username}`, now)
    audit('stop', [codeQ, typeof b.reason === 'string' ? b.reason.slice(0, 100) : ''], r.message, r.ok)
    return r.ok ? json(200, { message: r.message, event: r.event }) : err(r.status, r.message)
  }

  // ---- the log ----
  if (req.method === 'GET' && sub === 'events') {
    const before = Number(req.query.get('before') ?? '') || Number.MAX_SAFE_INTEGER
    const limit = Math.max(1, Math.min(200, Number(req.query.get('limit') ?? '') || 50))
    return json(200, { events: s.store.list(before, limit).map(summary) })
  }
  const m = /^events\/(\d{1,15})$/.exec(sub)
  if (req.method === 'GET' && m) {
    const row = s.store.get(Number(m[1]))
    if (!row) return err(404, 'no such event')
    const log: PilotLogLine[] = s.store.logOf(row.id).map((l) => {
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(l.data) as Record<string, unknown>
      } catch {
        data = {}
      }
      return { at: l.at, kind: l.kind, data }
    })
    // Draw order: the volunteers in the order they were offered the turn, then the others by when they volunteered.
    const offered = new Map<number, number>()
    for (const l of log) if (l.kind === 'offer' && typeof l.data.character === 'number' && !offered.has(l.data.character)) offered.set(l.data.character, offered.size)
    const volunteers: PilotVolunteerView[] = s.store
      .volunteers(row.id)
      .map((v) => ({ name: ctx.store.characterById(v.character_id)?.name ?? `#${v.character_id}`, character: v.character_id, account: v.account_id, at: v.at, draw: v.draw }))
      .sort((a, c) => (offered.get(a.character) ?? Infinity) - (offered.get(c.character) ?? Infinity) || a.at - c.at)
    return json(200, { event: summary(row), log, volunteers })
  }

  // ---- blocks ----
  if (req.method === 'GET' && sub === 'blocks') return json(200, { blocks: blockViews(ctx, s, now) })
  const bm = /^blocks\/([^/]{1,40})$/.exec(sub)
  if (bm && (req.method === 'PUT' || req.method === 'DELETE')) {
    const target = decodeURIComponent(bm[1])
    if (req.method === 'PUT') {
      const days = b.days
      if (typeof days !== 'number' || !Number.isFinite(days)) return err(400, 'days must be a number')
      if (b.reason !== undefined && typeof b.reason !== 'string') return err(400, 'reason must be text')
      const r = s.lottery.block(target, days, typeof b.reason === 'string' ? b.reason.trim() : '', req.actor.accountId, now)
      audit('block', [target, String(days), typeof b.reason === 'string' ? b.reason.slice(0, 100) : ''], r.message, r.ok)
      return r.ok ? json(200, { blocks: blockViews(ctx, s, now), message: r.message }) : err(r.status, r.message)
    }
    const r = s.lottery.unblock(target)
    audit('unblock', [target], r.message, r.ok)
    return r.ok ? json(200, { blocks: blockViews(ctx, s, now), message: r.message }) : err(r.status, r.message)
  }

  // ---- eligibility ----
  if (req.method === 'GET' && sub === 'eligibility') {
    if (!conf) return needConf()
    const name = (req.query.get('character') ?? '').trim()
    if (!/^@?[A-Za-z][A-Za-z0-9_]{2,11}$/.test(name)) return err(400, 'character must be a character name')
    const v = s.lottery.eligibilityOf(conf, name, now)
    return v ? json(200, v) : err(404, `No character named ${name}.`)
  }
  return err(404, 'no such endpoint')
}

/** The Events page's entry: running while an event or an attach session runs, its last events as the log. */
function eventInfo(ctx: GameContext): AdminEventInfo {
  const s = ctx.gameplay.pilot
  const running = !!s && ((s.event !== null && s.event.phase !== 'ended') || s.turn !== null)
  const conf = s?.steerable()[0] ?? null
  const nextAt = s && conf ? s.lottery.nextNight(conf) : null
  let log: AdminEventInfo['log'] = []
  try {
    log = (s?.store.list(Number.MAX_SAFE_INTEGER, 5) ?? []).map((r) => ({
      at: r.ended_at ?? r.created_at,
      text: `Event ${r.id}: ${r.phase === 'ended' ? (r.outcome ?? 'ended') : r.phase}${r.pilot_name ? `, pilot ${r.pilot_name}` : ''}${r.phase === 'ended' && r.hunt_started_at ? `, ${r.downs} downs, ${r.hunters} hunters` : ''}`,
    }))
  } catch {
    log = []
  }
  return {
    id: 'play-the-boss',
    name: 'Play the Boss: Night of the Tiger',
    about: 'A player steers Tiger Girl while everyone else hunts her. A weekly night (or a GM / admin start) opens a call for volunteers; one is drawn and steers her. Pick a pilot directly, edit the schedule and the numbers, and manage the lottery blocks here.',
    state: !s || !conf ? 'unavailable' : running ? 'running' : nextAt !== null ? 'scheduled' : 'idle',
    spec: 'docs/PLAY_THE_BOSS.md',
    routes: 'boss',
    nextAt,
    settings: [],
    log,
  }
}

let registered = false

/** Registers the route group and the Events entry once per process (several test servers share the registry). */
export function registerBossAdmin(): void {
  if (registered) return
  registered = true
  registerAdminRouteGroup({ prefix: 'boss', handle: routeAdminBoss })
  registerAdminEvent({ id: 'play-the-boss', info: eventInfo })
}
