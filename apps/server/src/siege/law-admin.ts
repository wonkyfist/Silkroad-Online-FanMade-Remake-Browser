import { CAPTURE_RULES, type AdminLawView, type CaptureRule, type ServerMessage } from '@sro/shared'
import type { AdminGroupRequest, AdminGroupResponse } from '../admin/routes.ts'
import type { GameContext } from '../game.ts'

/**
 * Siege of Jangan, layer 6: the admin panel's Law tab (docs/SIEGE.md §11.3, §11.4), under the `siege` route group
 * (event-admin.ts hands every `law` path here after its admin check; each write is a gm_audit row, command `siege`).
 *
 * GET law: open warrants, prisoners, offence records, Hunters, withheld capture rewards (suspected collusion), the latest
 * warrants. POST law/pardon {character},
 * law/jail {character, minutes, reason?}, law/release {character}, law/time {character, minutes} (add or take time),
 * law/hunter {character, action: 'revoke' | 'restore'}, law/forgive {character, all?}. `character` is a name or an id.
 */

type Audit = (action: string, args: string[], result: string, ok: boolean) => void

function json(status: number, body: unknown): AdminGroupResponse {
  return { status, body }
}

function err(status: number, message: string): AdminGroupResponse {
  return { status, body: { error: status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'bad_request', message } }
}

function parseList(s: string): unknown[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function lawView(ctx: GameContext, now: number): AdminLawView {
  const g = ctx.gameplay
  const name = (id: number) => ctx.store.characterById(id)?.name ?? `#${id}`
  const records = g.hunters.store.records().map((r) => ({
    accountId: r.account_id,
    characters: ctx.store.characters(r.account_id).map((c) => c.name),
    level: g.law.offences(r.account_id, now),
    recorded: r.offences,
    lastOffenceAt: r.last_offence_at,
    lastPlantAt: r.last_plant_at,
  }))
  return {
    clock: g.siege.settings.law.sentenceClock,
    wanted: g.law.openList().map(({ row, leftMs, online }) => ({
      warrant: row.id,
      characterId: row.character_id,
      name: name(row.character_id),
      role: row.role,
      wall: row.wall,
      offence: row.offence,
      bounty: row.bounty,
      treason: row.treason === 1,
      issuedAt: row.issued_at,
      onlineLeftMs: leftMs,
      online,
    })),
    jailed: g.jail.list(now).map((t) => ({ characterId: t.characterId, name: t.name, startsAt: t.startsAt, endsAt: t.endsAt, leftMs: t.leftMs, chores: t.chores, online: t.online })),
    records,
    hunters: g.hunters.list(now),
    flags: g.law.store
      .flags(100)
      .filter((f) => (CAPTURE_RULES as readonly string[]).includes(f.rule))
      .map((f) => ({ at: f.at, wanted: name(f.wanted_character), wantedAccount: f.wanted_account, hunter: name(f.hunter_character), hunterAccount: f.hunter_account, rule: f.rule as CaptureRule, withheld: f.withheld })),
    recent: g.law.store.recent(30).map((r) => ({
      warrant: r.id,
      name: name(r.character_id),
      status: r.status,
      role: r.role,
      wall: r.wall,
      offence: r.offence,
      bounty: r.bounty,
      issuedAt: r.issued_at,
      closedAt: r.closed_at,
      captors: parseList(r.captors).map((c) => {
        const o = c as { character?: number; gold?: number; pair?: boolean }
        return typeof o.character === 'number' ? `${name(o.character)} (${(o.gold ?? 0).toLocaleString('en-US')}${o.pair ? ', pair rule' : ''})` : '?'
      }),
    })),
  }
}

/** `/api/admin/siege/law*` (the caller checked the admin role). */
export function routeAdminLaw(ctx: GameContext, req: AdminGroupRequest, sub: string, b: Record<string, unknown>, audit: Audit): AdminGroupResponse {
  const g = ctx.gameplay
  const now = g.now
  if (req.method === 'GET' && sub === 'law') return json(200, lawView(ctx, now))
  if (req.method !== 'POST') return err(404, 'no such endpoint')
  const action = sub.slice('law/'.length)
  const c = b.character
  const row = typeof c === 'number' && Number.isInteger(c) ? ctx.store.characterById(c) : typeof c === 'string' && c.trim() ? ctx.store.characterByName(c.trim()) : null
  if (!row) return err(400, 'character must be a character name or id')
  const done = (args: string[], message: string, ok = true) => {
    audit(`law-${action}`, [row.name, ...args], message, ok)
    return ok ? json(200, { message, law: lawView(ctx, now) }) : err(409, message)
  }
  switch (action) {
    case 'pardon': {
      const n = g.law.close(row.id, 'pardoned', now).length
      if (n) {
        const msg: ServerMessage = { t: 'lawNotice', event: 'pardoned', name: row.name }
        for (const p of g.world.players.values()) p.send(msg)
      }
      return done([], n ? `${row.name} is pardoned (${n} warrant${n === 1 ? '' : 's'} closed).` : `${row.name} is not Wanted.`, n > 0)
    }
    case 'jail': {
      const min = b.minutes
      if (typeof min !== 'number' || !Number.isFinite(min) || min < 1 || min > 10_080) return err(400, 'minutes must be a number from 1 to 10080')
      const reason = typeof b.reason === 'string' ? b.reason.slice(0, 120) : ''
      const r = g.jail.gmJail(row.name, min, reason, now, `admin ${req.actor.username}`)
      return done([String(min), reason], r.message, r.ok)
    }
    case 'release': {
      const ok = g.jail.release(row.id, now, 'admin')
      return done([], ok ? `${row.name} is released.` : `${row.name} is not jailed.`, ok)
    }
    case 'time': {
      const min = b.minutes
      if (typeof min !== 'number' || !Number.isFinite(min) || min === 0 || Math.abs(min) > 10_080) return err(400, 'minutes must be a non-zero number from -10080 to 10080')
      const ok = g.jail.addTime(row.id, min * 60_000, now)
      return done([String(min)], ok ? `${row.name}: ${min > 0 ? '+' : ''}${min} min.` : `${row.name} is not jailed.`, ok)
    }
    case 'hunter': {
      const a = b.action
      if (a !== 'revoke' && a !== 'restore') return err(400, "action must be 'revoke' or 'restore'")
      const r = g.hunters.gm(row.name, a, undefined, now)
      return done([a], r.message, r.ok)
    }
    case 'forgive': {
      const r = g.law.gm(null, ['forgive', row.name, ...(b.all === true ? ['all'] : [])], now)
      return done(b.all === true ? ['all'] : [], r.message, r.ok)
    }
    default:
      return err(404, 'no such endpoint')
  }
}
