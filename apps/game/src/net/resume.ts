/**
 * Refresh keeps you logged in (docs/UX_GAPS.md L1): the login token lives in sessionStorage (per tab, gone when the
 * tab closes) from the moment a game server accepted it until logout or an expired / refused token. On boot the app
 * reconnects with it and lands on character select instead of the splash and login screens.
 * Every storage access is guarded: blocked storage simply means no resume.
 */
import type { App } from '../app.ts'
import { t } from '../i18n/index.ts'
import { GameError } from './api.ts'
import { openSession } from './transport.ts'

export interface SavedSession {
  token: string
  username: string
  /** ms since epoch (ApiLoginResponse.expiresAt). */
  expiresAt: number
}

/** The part of Storage used here (tests pass a map, or one that throws). */
export interface ResumeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Separate keys for the real server and the in-browser mock, so neither tries the other's token. */
export const sessionKey = (mock: boolean) => (mock ? 'sro.session.mock' : 'sro.session')

/** How long the boot resume waits for the game server before falling back to the server list. */
const RESUME_TIMEOUT_MS = 10_000

function tabStorage(): ResumeStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function saveSession(s: SavedSession, mock = false, storage: ResumeStorage | null = tabStorage()): void {
  if (!s.token || !(s.expiresAt > 0)) return
  try {
    storage?.setItem(sessionKey(mock), JSON.stringify({ token: s.token, username: s.username, expiresAt: s.expiresAt }))
  } catch {
    // storage blocked or full: a refresh goes back to the login screen
  }
}

/** The saved session, or null when there is none, it is malformed, or its token has expired. */
export function loadSession(mock = false, now = Date.now(), storage: ResumeStorage | null = tabStorage()): SavedSession | null {
  let raw: unknown
  try {
    const text = storage?.getItem(sessionKey(mock))
    if (!text) return null
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const o = raw as Partial<SavedSession> | null
  if (!o || typeof o !== 'object' || typeof o.token !== 'string' || !o.token || typeof o.expiresAt !== 'number') return null
  // A minute of margin: a token about to expire would only fail a moment later.
  if (!Number.isFinite(o.expiresAt) || o.expiresAt - 60_000 <= now) {
    clearSession(mock, storage)
    return null
  }
  return { token: o.token, username: typeof o.username === 'string' ? o.username : '', expiresAt: o.expiresAt }
}

export function clearSession(mock = false, storage: ResumeStorage | null = tabStorage()): void {
  try {
    storage?.removeItem(sessionKey(mock))
  } catch {
    // nothing to clear
  }
}

/**
 * Codes after which the saved token must not be tried again (as opposed to a server that is down for a moment).
 * A version mismatch keeps it: reloading the page is what fixes that, and the reload should not ask for a login.
 * 'replaced' drops it in the tab that lost, so two tabs of one account do not keep taking the socket from each other.
 */
export function tokenRefused(code: string | undefined): boolean {
  return code === 'unauthorized' || code === 'forbidden' || code === 'replaced' || code === 'kicked' || code === 'abuse'
}

/**
 * Boot: reconnects with the saved token and opens character select. Returns false when there is nothing to resume
 * (or the token was refused): the caller shows the splash / login as usual. When the server cannot be reached, the
 * token is kept and the server list opens (its own error line says why).
 */
export async function resumeSession(app: App): Promise<boolean> {
  const mock = app.transport.mock
  const saved = loadSession(mock)
  if (!saved) return false
  const session = openSession(app.transport, saved.token)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      session.connect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new GameError('timeout', 'resume timed out')), RESUME_TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    session.close()
    const code = err instanceof GameError ? err.code : undefined
    if (tokenRefused(code)) {
      clearSession(mock)
      console.info(`[resume] saved session refused (${code}); showing the login screen`)
      return false
    }
    app.token = saved.token
    app.username = saved.username
    app.tokenExpiresAt = saved.expiresAt
    if (code === 'version_mismatch') {
      // A cached old client: the login screen says to reload (the token stays for that reload).
      await app.go('login', { error: t('net.versionMismatch') })
      return true
    }
    console.warn('[resume] game server unreachable; showing the server list', err)
    await app.go('servers')
    return true
  } finally {
    clearTimeout(timer)
  }
  app.token = saved.token
  app.username = saved.username
  app.tokenExpiresAt = saved.expiresAt
  app.setSession(session)
  await app.go('charselect')
  return true
}
