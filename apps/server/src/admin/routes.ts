import type { AdminEventInfo, Role } from '@sro/shared'
import type { GameContext } from '../game.ts'

/**
 * Extension points of the admin API (docs/ADMIN.md §3.1): route groups that other modules plug in under
 * `/api/admin/<prefix>/*`, and the scheduled events the Events page lists. Play the Boss (docs/PLAY_THE_BOSS.md §6.3)
 * registers `{prefix: 'boss', handle: routeAdminBoss}` and its event here; the panel's router keeps doing the login,
 * the role check, the rate limit, the body limit and an admin_audit row per write, so a group only answers.
 */

/** What a route group's handler receives: the parsed JSON body (undefined for GET) and the authenticated admin. */
export interface AdminGroupRequest {
  method: string
  /** The full path, e.g. /api/admin/boss/settings. */
  path: string
  query: URLSearchParams
  body: unknown
  actor: { accountId: number; role: Role; username: string }
}

export interface AdminGroupResponse {
  status: number
  body: unknown
}

export interface AdminRouteGroup {
  /** First path segment after /api/admin/ (a-z, 0-9, -), e.g. 'boss'. */
  prefix: string
  /** Largest body accepted (default ADMIN_CONTENT_BODY_MAX_BYTES). */
  maxBody?: number
  handle(ctx: GameContext, req: AdminGroupRequest): Promise<AdminGroupResponse> | AdminGroupResponse
}

/** A scheduled event shown on the Events page; `info` is asked on every page load. */
export interface AdminEventProvider {
  id: string
  info(ctx: GameContext): AdminEventInfo
}

const GROUP_PREFIX = /^[a-z0-9-]{1,32}$/
/** Prefixes the panel itself serves (a group may not shadow them). */
export const RESERVED_PREFIXES = new Set([
  'info', 'login', 'logout', 'me', 'dashboard', 'players', 'notice', 'restart', 'accounts', 'characters', 'settings', 'audit', 'gm-audit',
  'items', 'drops', 'mobs', 'shops', 'nests', 'npcs', 'quests', 'uniques', 'events',
])

const GROUPS = new Map<string, AdminRouteGroup>()
const EVENTS = new Map<string, AdminEventProvider>()

export function registerAdminRouteGroup(group: AdminRouteGroup): void {
  if (!GROUP_PREFIX.test(group.prefix) || RESERVED_PREFIXES.has(group.prefix)) throw new Error(`admin route group prefix ${group.prefix} is not allowed`)
  GROUPS.set(group.prefix, group)
}

export function adminRouteGroup(prefix: string): AdminRouteGroup | undefined {
  return GROUPS.get(prefix)
}

export function registerAdminEvent(provider: AdminEventProvider): void {
  EVENTS.set(provider.id, provider)
}

/** Play the Boss until its module registers itself (docs/PLAY_THE_BOSS.md). */
const PLAY_THE_BOSS: AdminEventInfo = {
  id: 'play-the-boss',
  name: 'Play the Boss: Night of the Tiger',
  about: 'A player steers Tiger Girl while everyone else hunts her: a weekly schedule, a call for volunteers, a lottery, the hunt and its log.',
  state: 'unavailable',
  spec: 'docs/PLAY_THE_BOSS.md',
  routes: null,
  nextAt: null,
  settings: [],
  log: [],
}

/** Every event for the Events page (registered providers first; the Play the Boss placeholder until it registers). */
export function adminEvents(ctx: GameContext): AdminEventInfo[] {
  const out: AdminEventInfo[] = []
  for (const p of EVENTS.values()) {
    try {
      out.push(p.info(ctx))
    } catch (e) {
      ctx.config.log(`admin events: ${p.id} failed: ${(e as Error).message}`)
    }
  }
  if (!out.some((e) => e.id === PLAY_THE_BOSS.id)) out.push({ ...PLAY_THE_BOSS, routes: GROUPS.has('boss') ? 'boss' : null })
  return out
}
