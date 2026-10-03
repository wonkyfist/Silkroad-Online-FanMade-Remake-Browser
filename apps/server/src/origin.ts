import type { IncomingMessage } from 'node:http'

/**
 * Browser origin policy for /api and /ws.
 *
 * - No Origin header: allowed. Browsers always send Origin on WebSocket upgrades and on
 *   cross-origin or non-GET fetches, so a missing header means a non-browser client (curl, tests),
 *   which CORS does not protect against anyway.
 * - Same origin (Origin host:port equals the Host header): allowed; this is the production case
 *   where the server also serves the game. The scheme is not compared, so a TLS-terminating
 *   proxy that keeps the Host header works.
 * - Listed origins (Vite dev/preview proxies, ALLOWED_ORIGINS, CORS_ORIGIN): allowed.
 * - Everything else, including `Origin: null` (sandboxed frames, file://): refused. This stops
 *   other websites from registering accounts, guessing passwords from a victim's browser, or
 *   opening game sockets (cross-site WebSocket hijacking).
 */
export function originAllowed(req: IncomingMessage, allowed: readonly string[]): boolean {
  const raw = req.headers.origin
  if (raw === undefined) return true
  let origin: URL
  try {
    origin = new URL(raw)
  } catch {
    return false
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false
  if (allowed.includes(origin.origin)) return true
  const host = req.headers.host
  if (!host) return false
  let self: URL
  try {
    self = new URL(`${origin.protocol}//${host}`)
  } catch {
    return false
  }
  return self.host === origin.host
}
