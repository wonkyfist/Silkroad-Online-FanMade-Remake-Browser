import type { GameContext } from '../game.ts'
import type { Connection } from '../connection.ts'
import type { Player } from '../world.ts'
import type { SettingsState } from './settings.ts'
import type { AdminStore } from './store.ts'

/** One authenticated admin API request, as the handlers see it (docs/ADMIN.md §3). */
export interface AdminCall {
  ctx: GameContext
  store: AdminStore
  settings: SettingsState
  admin: { id: number; username: string }
  /** sha256 of this request's admin token (a password reset keeps the caller's own session). */
  tokenHash: string
  ip: string
  now: number
  query: URLSearchParams
  /** Reads the JSON body (at most `limit` bytes; default ADMIN_BODY_MAX_BYTES), then re-checks the session and role. */
  body(limit?: number): Promise<unknown>
  /** One admin_audit row for this request. */
  audit(action: string, target: string, before?: unknown, after?: unknown, ok?: boolean, detail?: string): void
}

/** The connection of an online character (in the world), if any. */
export function onlineCharacter(ctx: GameContext, characterId: number): { conn: Connection; player: Player } | null {
  for (const conn of ctx.sockets.values()) if (conn.player?.characterId === characterId) return { conn, player: conn.player }
  return null
}
