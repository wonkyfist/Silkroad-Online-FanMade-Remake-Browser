import {
  SIEGE_EVENT_BOUNDS,
  SIEGE_SETTING_PATHS,
  WALL_SEGMENT_ID,
  checkSiegeEventSettings,
  mergeSiegePatch,
  pruneSiegePatch,
  unsetSiegePaths,
  type AdminEventInfo,
  type AdminSiegeView,
  type SiegeContribView,
  type SiegeEventPatch,
  type SiegeEventSummary,
  type SiegeLogLine,
  type SiegeTopLine,
} from '@sro/shared'
import type { GameContext } from '../game.ts'
import { registerAdminEvent, registerAdminRouteGroup, type AdminGroupRequest, type AdminGroupResponse } from '../admin/routes.ts'
import { zoneOf } from '../pilot/lottery.ts'
import type { SiegeEventRow } from './event-store.ts'
import { SIEGE_SETTINGS_CODE, type SiegeService } from './event.ts'
import { routeAdminLaw } from './law-admin.ts'

/**
 * Siege of Jangan in the admin panel (docs/SIEGE.md §11.3, §11.4): the route group `siege` (`/api/admin/siege/*`) and
 * the Events page's entry. The panel's router authenticates the account and writes its admin_audit row; this handler
 * re-checks the admin role and adds a gm_audit row (command `siege`) per write, so the GM command and the panel share
 * one trail. Every write calls the same service functions as `/siege` and `/wall`.
 *
 * GET '' (walls, the siege now, the schedule, the settings, the lanes), PUT settings, POST settings/reset, POST start |
 * stop, POST wall ({seg, pct} or {seg: 'all', repair: true}), GET events, GET events/:id (timeline, contributors);
 * layer 6: GET law, POST law/pardon | jail | release | time | hunter | forgive (law-admin.ts).
 */

const PREFIX = '/api/admin/siege'

function json(status: number, body: unknown): AdminGroupResponse {
  return { status, body }
}

function err(status: number, message: string, extra: Record<string, unknown> = {}): AdminGroupResponse {
  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'bad_request'
  return { status, body: { ...extra, error: code, message } }
}

function parse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export function siegeSummary(r: SiegeEventRow, top: SiegeTopLine[] = []): SiegeEventSummary {
  return {
    id: r.id,
    origin: r.origin,
    phase: r.phase,
    createdAt: r.created_at,
    wave1At: r.wave1_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
    approaches: parse<string[]>(r.approaches, []),
    defenders: r.defenders,
    breaches: r.breaches,
    top,
  }
}

export function siegeView(ctx: GameContext, s: SiegeService, now: number): AdminSiegeView {
  const ev = s.ev
  const bell = s.bellMob()
  const lord = ev?.warlord !== null && ev?.warlord !== undefined ? ctx.world.mobs.get(ev.warlord) : undefined
  const alive = lord && lord.ai !== 'dead' ? lord : null
  return {
    walls: s.walls.views().map((v) => ({ id: v.id, stage: v.stage, pct: v.pct, queued: v.queued ?? 0 })),
    geometry: geometryOf(s),
    current: ev
      ? {
          ...s.view(ev, now),
          origin: ev.origin,
          createdAt: ev.createdAt,
          wave1At: ev.phase === 'warning' ? null : ev.wave1At,
          bellHp: bell ? Math.round(bell.hp) : null,
          bellMaxHp: bell ? bell.maxHp : null,
          warlordHp: alive ? Math.round(alive.hp) : null,
          warlordMaxHp: alive ? alive.maxHp : null,
          scale: Math.round(ev.scale * 100) / 100,
          contributors: ev.contrib.size,
        }
      : null,
    next: s.next,
    waitingUntil: s.waitUntil > now ? s.waitUntil : null,
    schedule: { tz: zoneOf(s.settings.schedule.tz), enabled: s.settings.enabled },
    settings: { defaults: structuredClone(s.defaults), effective: structuredClone(s.settings), patch: structuredClone(s.patch), rev: s.rev, bounds: SIEGE_EVENT_BOUNDS },
    lanes: s.lanes.map((a) => ({ approach: a.approach, name: a.name, segments: a.lanes.map((l) => l.seg), dropped: a.dropped.map((d) => `${d.seg}: ${d.why}`) })),
    problems: s.problem ? [s.problem] : [],
  }
}

function geometryOf(s: SiegeService): AdminSiegeView['geometry'] {
  const w = s.walls.walls
  if (!w) return null
  const big = (n: number) => Math.abs(n) > 10_000
  return {
    sides: w.sides.map((x) => ({ side: x.side, axis: x.axis, line: x.line })),
    segs: w.segments.map((x) => ({ id: x.id, from: x.from, to: x.to })),
    fixed: w.sides.flatMap((x) => x.fixed.filter((f) => !big(f.from) && !big(f.to)).map((f) => ({ id: f.id, side: x.side, from: f.from, to: f.to }))),
    bell: s.bellAt,
  }
}

type SettingsResult = { ok: true; rev: number } | { ok: false; status: number; message: string; issues?: { path: string; message: string }[] }

/** PUT settings: `delta` over the stored patch, based on `baseRev`. */
export function saveSiegeSettings(s: SiegeService, baseRev: unknown, delta: unknown, by: number | null, now: number): SettingsResult {
  if (!Number.isInteger(baseRev)) return { ok: false, status: 400, message: 'baseRev must be the rev you loaded.' }
  if (baseRev !== s.rev) return { ok: false, status: 409, message: `The settings were changed since you loaded them (rev ${s.rev}, yours ${String(baseRev)}). Reload and try again.` }
  const issues = checkSiegeEventSettings(delta)
  if (issues.length) return { ok: false, status: 422, message: 'Some values are out of bounds.', issues }
  const patch = pruneSiegePatch(mergeSiegePatch(s.patch, delta as SiegeEventPatch), s.defaults)
  return save(s, patch, by, now)
}

/** POST settings/reset: `paths` (none = all) back to their defaults. */
export function resetSiegeSettings(s: SiegeService, paths: unknown, baseRev: unknown, by: number | null, now: number): SettingsResult {
  if (baseRev !== undefined && baseRev !== s.rev) return { ok: false, status: 409, message: `The settings were changed since you loaded them (rev ${s.rev}). Reload and try again.` }
  if (paths === undefined) return save(s, {}, by, now)
  const groups = new Set(SIEGE_SETTING_PATHS.map((p) => p.split('.')[0]))
  if (!Array.isArray(paths) || paths.length > 64 || !paths.every((p) => typeof p === 'string' && (SIEGE_SETTING_PATHS.includes(p) || groups.has(p)))) {
    return { ok: false, status: 422, message: 'paths must name settings (e.g. "timing.warningMin", or a group: "timing").', issues: [{ path: 'paths', message: 'unknown setting' }] }
  }
  return save(s, unsetSiegePaths(s.patch, paths as string[]), by, now)
}

function save(s: SiegeService, patch: SiegeEventPatch, by: number | null, now: number): SettingsResult {
  const rev = s.rev + 1
  s.store.saveSettings(SIEGE_SETTINGS_CODE, JSON.stringify(patch), rev, now, by)
  s.applyPatch(patch, rev)
  return { ok: true, rev }
}

function bodyOf(req: AdminGroupRequest): Record<string, unknown> {
  const b = req.body
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

/** `/api/admin/siege/*` (§11.3). */
export async function routeAdminSiege(ctx: GameContext, req: AdminGroupRequest): Promise<AdminGroupResponse> {
  if (req.actor.role !== 'admin') return err(403, 'admin accounts only')
  const s = ctx.gameplay.siege
  const now = ctx.gameplay.now
  const sub = req.path.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const audit = (action: string, args: string[], result: string, ok: boolean) =>
    ctx.store.audit({ accountId: req.actor.accountId, characterId: null, command: 'siege', args: [action, ...args], result: `admin: ${result}`, ok })
  const b = bodyOf(req)

  if (req.method === 'GET' && sub === '') return json(200, siegeView(ctx, s, now))
  // layer 6: the Law tab (law-admin.ts)
  if (sub === 'law' || sub.startsWith('law/')) return routeAdminLaw(ctx, req, sub, b, audit)

  if (req.method === 'PUT' && sub === 'settings') {
    const r = saveSiegeSettings(s, b.baseRev, b.patch, req.actor.accountId, now)
    audit('settings', [JSON.stringify(b.patch ?? null).slice(0, 400)], r.ok ? `rev ${r.rev}` : r.message, r.ok)
    return r.ok ? json(200, { rev: r.rev, effective: s.settings, patch: s.patch }) : err(r.status, r.message, r.issues ? { issues: r.issues } : {})
  }
  if (req.method === 'POST' && sub === 'settings/reset') {
    const r = resetSiegeSettings(s, b.paths, b.baseRev, req.actor.accountId, now)
    audit('settings-reset', [JSON.stringify(b.paths ?? 'all').slice(0, 400)], r.ok ? `rev ${r.rev}` : r.message, r.ok)
    return r.ok ? json(200, { rev: r.rev, effective: s.settings, patch: s.patch }) : err(r.status, r.message, r.issues ? { issues: r.issues } : {})
  }

  if (req.method === 'POST' && sub === 'start') {
    const w = b.warningMin
    if (w !== undefined && (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 60)) return err(400, 'warningMin must be a number from 0 to 60')
    const r = s.start('admin', w as number | undefined, now)
    audit('start', [w === undefined ? '' : String(w)], r.message, r.ok)
    return r.ok ? json(200, { message: r.message, event: r.event.id }) : err(r.status, r.message)
  }
  if (req.method === 'POST' && sub === 'stop') {
    const r = s.stop(`admin ${req.actor.username}`, now)
    audit('stop', [], r.message, r.ok)
    return r.ok ? json(200, { message: r.message }) : err(r.status, r.message)
  }

  if (req.method === 'POST' && sub === 'wall') {
    const walls = ctx.gameplay.walls
    if (!walls.on) return err(409, `The walls are off on this server (${walls.problem || 'no walls.json'}).`)
    const seg = typeof b.seg === 'string' ? b.seg.toUpperCase() : ''
    if (seg === 'ALL' && b.repair === true) {
      const r = walls.gm(['repair', 'all'], now)
      audit('wall', ['repair', 'all'], r.message, r.ok)
      return r.ok ? json(200, { message: r.message }) : err(400, r.message)
    }
    if (!WALL_SEGMENT_ID.test(seg) || walls.stageOf(seg) === null) return err(400, 'seg must be a wall segment id (N1..E7) or "all" with repair: true')
    if (b.repair === true) {
      const r = walls.gm(['repair', seg], now)
      audit('wall', ['repair', seg], r.message, r.ok)
      return r.ok ? json(200, { message: r.message }) : err(400, r.message)
    }
    const pct = b.pct
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < walls.settings.rubblePct || pct > 100) return err(400, `pct must be a number from ${walls.settings.rubblePct} to 100`)
    const r = walls.gm([seg, String(pct)], now)
    audit('wall', [seg, String(pct)], r.message, r.ok)
    return r.ok ? json(200, { message: r.message }) : err(400, r.message)
  }

  if (req.method === 'GET' && sub === 'events') {
    const before = Number(req.query.get('before') ?? '') || Number.MAX_SAFE_INTEGER
    const limit = Math.max(1, Math.min(200, Number(req.query.get('limit') ?? '') || 50))
    const rows = s.store.list(before, limit)
    return json(200, { events: rows.map((r) => siegeSummary(r, topOf(ctx, s, r.id, 3))) })
  }
  const m = /^events\/(\d{1,15})$/.exec(sub)
  if (req.method === 'GET' && m) {
    const row = s.store.get(Number(m[1]))
    if (!row) return err(404, 'no such event')
    const log: SiegeLogLine[] = s.store.logOf(row.id).map((l) => ({ at: l.at, kind: l.kind, data: parse<Record<string, unknown>>(l.data, {}) }))
    const contributors: SiegeContribView[] = s.store.contribOf(row.id).map((c) => ({ name: ctx.store.characterById(c.character_id)?.name ?? `#${c.character_id}`, character: c.character_id, points: c.points, gold: c.gold, seals: c.seals }))
    return json(200, { event: siegeSummary(row, contributors.slice(0, 3).map((c) => ({ name: c.name, points: c.points }))), log, contributors })
  }
  return err(404, 'no such endpoint')
}

function topOf(ctx: GameContext, s: SiegeService, id: number, n: number): SiegeTopLine[] {
  return s.store
    .contribOf(id)
    .slice(0, n)
    .map((c) => ({ name: ctx.store.characterById(c.character_id)?.name ?? `#${c.character_id}`, points: c.points }))
}

/** The Events page's entry. */
function eventInfo(ctx: GameContext): AdminEventInfo {
  const s = ctx.gameplay.siege
  let log: AdminEventInfo['log'] = []
  try {
    log = s.store.list(Number.MAX_SAFE_INTEGER, 5).map((r) => ({
      at: r.ended_at ?? r.created_at,
      text: `Siege ${r.id}: ${r.phase === 'ended' ? (r.outcome ?? 'ended') : r.phase}${r.phase === 'ended' && r.outcome !== 'skipped' ? `, ${r.breaches} breaches, ${r.defenders} defenders` : ''}`,
    }))
  } catch {
    log = []
  }
  return {
    id: 'siege-of-jangan',
    name: 'Siege of Jangan',
    about: "Bandit armies march on Jangan: sappers blow holes in the walls, the Bandit Warlord leads the last wave, and the Town Bell must not fall. Start one, set the weekly slot (off by default), tune the waves and rewards, and repair the walls here.",
    state: !s.on ? 'unavailable' : s.running() ? 'running' : s.next !== null ? 'scheduled' : 'idle',
    spec: 'docs/SIEGE.md',
    routes: 'siege',
    nextAt: s.next,
    settings: [],
    log,
  }
}

let registered = false

/** Registers the route group and the Events entry once per process (several test servers share the registry). */
export function registerSiegeAdmin(): void {
  if (registered) return
  registered = true
  registerAdminRouteGroup({ prefix: 'siege', handle: routeAdminSiege })
  registerAdminEvent({ id: 'siege-of-jangan', info: eventInfo })
}
