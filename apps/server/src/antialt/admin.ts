import type { GameContext } from '../game.ts'
import { registerAdminRouteGroup, type AdminGroupRequest, type AdminGroupResponse } from '../admin/routes.ts'
import { DETECT_MODES, defaultPolicy } from './policy.ts'
import { WINDOW_UNITS } from './window.ts'

/**
 * The admin panel's "Registration & anti-alt" page (docs/ANTI_ALT.md §8): `/api/admin/antialt/*`. The panel's router
 * authenticates, rate limits and writes an admin_audit row per write; this handler answers.
 *
 * GET  ''               {policy, defaults, units, modes, env, lists}
 * POST policy           {policy} → the saved policy (admins only)
 * GET  log?limit&outcome
 * POST lift             {id}  → lifts the block of a log row (admins only)
 * GET  allow
 * POST allow            {kind, value, note} (admins only)
 * POST allow/delete     {id} (admins only)
 * GET  linked/<account> the accounts sharing a device, IP, subnet or fingerprint
 */

const PREFIX = '/api/admin/antialt'

const err = (status: number, message: string): AdminGroupResponse => ({ status, body: { error: status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'bad_request', message } })
const obj = (b: unknown): Record<string, unknown> | null => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null)

export function routeAdminAntiAlt(ctx: GameContext, req: AdminGroupRequest): AdminGroupResponse {
  const aa = ctx.antiAlt
  if (!aa) return err(404, 'anti-alt is not running on this server')
  const sub = req.path.slice(PREFIX.length).replace(/^\//, '')
  const admin = req.actor.role === 'admin'
  if (req.method === 'GET') {
    if (sub === '') {
      const c = ctx.config
      return {
        status: 200,
        body: {
          policy: aa.policy(),
          defaults: defaultPolicy(c.registerPerHour),
          units: WINDOW_UNITS,
          modes: DETECT_MODES,
          env: {
            captchaConfigured: !!aa.opts.captcha,
            lookupProvider: aa.opts.lookup?.provider.name ?? null,
            trustProxy: c.trustProxy,
            trustedProxies: c.trustedProxies ?? '',
            clientIpHeader: c.clientIpHeader ?? 'x-forwarded-for',
          },
          lists: { hosting: aa.opts.lists.hosting.size, tor: aa.opts.lists.tor.size },
        },
      }
    }
    if (sub === 'log') {
      const outcome = req.query.get('outcome')
      return { status: 200, body: { log: aa.logRows(Number(req.query.get('limit') ?? 200) || 200, outcome === 'blocked' || outcome === 'flagged' ? outcome : undefined) } }
    }
    if (sub === 'allow') return { status: 200, body: { allow: aa.allowRows() } }
    const m = /^linked\/(\d{1,12})$/.exec(sub)
    if (m) return { status: 200, body: { linked: aa.linked(Number(m[1])) } }
    return err(404, 'no such route')
  }
  if (req.method !== 'POST') return err(404, 'no such route')
  if (!admin) return err(403, 'admin accounts only')
  const b = obj(req.body)
  if (!b) return err(400, 'a JSON object is needed')
  const by = req.actor.username
  if (sub === 'policy') {
    const r = aa.setPolicy(b.policy)
    if ('problem' in r) return err(400, r.problem)
    ctx.config.log(`admin ${by}: anti-alt policy saved`)
    return { status: 200, body: { policy: r.after } }
  }
  if (sub === 'lift') {
    const r = aa.lift(Number(b.id), by)
    if ('problem' in r) return err(400, r.problem)
    ctx.config.log(`admin ${by}: anti-alt lift #${String(b.id)}: ${r.message}`)
    return { status: 200, body: r }
  }
  if (sub === 'allow') {
    const r = aa.addAllow(String(b.kind ?? ''), String(b.value ?? ''), String(b.note ?? ''), by)
    if ('problem' in r) return err(400, r.problem)
    return { status: 200, body: { allow: aa.allowRows() } }
  }
  if (sub === 'allow/delete') {
    if (!aa.removeAllow(Number(b.id))) return err(404, 'no such allowlist entry')
    return { status: 200, body: { allow: aa.allowRows() } }
  }
  return err(404, 'no such route')
}

let registered = false
export function registerAntiAltAdmin(): void {
  if (registered) return
  registered = true
  registerAdminRouteGroup({ prefix: 'antialt', handle: routeAdminAntiAlt })
}
