import { MAINTENANCE_COUNTDOWN_MAX_MIN, MAINTENANCE_DURATION_MAX_MIN } from '@sro/shared'
import type { GameContext } from '../game.ts'
import type { MaintResult } from '../maintenance.ts'
import { registerAdminRouteGroup, type AdminGroupRequest, type AdminGroupResponse } from './routes.ts'

/**
 * Maintenance mode in the admin panel (docs/ADMIN.md §8): the route group `maintenance` (`/api/admin/maintenance/*`).
 * The panel's router logs the account in, rate-limits it and writes the admin_audit row of every write; this handler
 * re-checks the admin role and adds a gm_audit row (command `maintenance`), so the panel and the GM command share one
 * trail.
 *
 * GET '' (the state), POST start {minutes 0..MAX, reason?, durationMin?}, POST cancel, POST end {silent?}.
 */

const PREFIX = '/api/admin/maintenance'

function err(status: number, message: string): AdminGroupResponse {
  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'bad_request'
  return { status, body: { error: code, message } }
}

function bodyOf(req: AdminGroupRequest): Record<string, unknown> | null {
  const b = req.body ?? {}
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null
}

export function routeAdminMaintenance(ctx: GameContext, req: AdminGroupRequest): AdminGroupResponse {
  if (req.actor.role !== 'admin') return err(403, 'admin accounts only')
  const m = ctx.maintenance
  if (!m) return err(409, 'Maintenance mode is not available on this server.')
  const sub = req.path.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
  if (req.method === 'GET' && sub === '') return { status: 200, body: m.view() }
  if (req.method !== 'POST' || !['start', 'cancel', 'end'].includes(sub)) return err(404, 'no such endpoint')
  const b = bodyOf(req)
  if (!b) return err(400, 'body must be an object')
  const allowed = sub === 'start' ? ['minutes', 'reason', 'durationMin'] : sub === 'end' ? ['silent'] : []
  const extra = Object.keys(b).find((k) => !allowed.includes(k))
  if (extra) return err(400, `unexpected field ${extra.slice(0, 32)}`)
  const by = req.actor.username
  let r: MaintResult
  let args: string[]
  if (sub === 'start') {
    const min = b.minutes
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 0 || min > MAINTENANCE_COUNTDOWN_MAX_MIN) return err(400, `minutes must be a whole number from 0 to ${MAINTENANCE_COUNTDOWN_MAX_MIN}`)
    const dur = b.durationMin ?? 0
    if (typeof dur !== 'number' || !Number.isInteger(dur) || dur < 0 || dur > MAINTENANCE_DURATION_MAX_MIN) return err(400, `durationMin must be a whole number from 0 to ${MAINTENANCE_DURATION_MAX_MIN}`)
    if (b.reason !== undefined && typeof b.reason !== 'string') return err(400, 'reason must be text')
    r = m.start({ delayS: min * 60, reason: b.reason as string | undefined, durationMin: dur, by, via: 'panel' })
    args = ['start', String(min), ...(dur ? [`~${dur}min`] : []), ...(typeof b.reason === 'string' && b.reason ? [b.reason.slice(0, 160)] : [])]
  } else if (sub === 'cancel') {
    r = m.cancel(by, 'panel')
    args = ['cancel']
  } else {
    if (b.silent !== undefined && typeof b.silent !== 'boolean') return err(400, 'silent must be true or false')
    r = m.end(by, 'panel', b.silent === true)
    args = ['end', ...(b.silent === true ? ['silent'] : [])]
  }
  ctx.store.audit({ accountId: req.actor.accountId, characterId: null, command: 'maintenance', args, result: `admin: ${r.message}`, ok: r.ok })
  return r.ok ? { status: 200, body: { message: r.message, view: m.view() } } : err(r.status, r.message)
}

let registered = false
export function registerMaintenanceAdmin(): void {
  if (registered) return
  registered = true
  registerAdminRouteGroup({ prefix: 'maintenance', handle: routeAdminMaintenance })
}
