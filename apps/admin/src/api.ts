import { ADMIN_API_VERSION, type AdminInfo, type AdminLoginResponse, type ApiError } from '@sro/shared'

/**
 * The admin API client (docs/ADMIN.md §2.1, §3) with server profiles: every call goes to the active profile's server
 * with that server's own session token. Profiles (name and URL only, never a password or token) are kept in
 * localStorage; tokens per server and the active profile live in sessionStorage, so they end with the tab. The default
 * profile is the server that served this page.
 */

export interface Profile {
  id: string
  name: string
  /** Origin of the game server, e.g. http://192.168.1.50:7000; '' = the server that served this page. */
  url: string
}

export const HERE: Profile = { id: 'here', name: 'This server', url: '' }

const PROFILES_KEY = 'sro.admin.servers'
const ACTIVE_KEY = 'sro.admin.active'
const tokenKey = (id: string) => `sro.admin.token.${id}`
const nameKey = (id: string) => `sro.admin.name.${id}`

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message)
  }
}

function read(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key)
  } catch {
    return null
  }
}

function write(store: 'local' | 'session', key: string, value: string | null): void {
  try {
    const s = store === 'local' ? localStorage : sessionStorage
    if (value === null) s.removeItem(key)
    else s.setItem(key, value)
  } catch {
    // no storage (private mode): profiles and sessions last as long as the page
  }
}

/** A server URL as an origin (http(s) only), or null. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

const memory = new Map<string, string>()

export const servers = {
  list(): Profile[] {
    let saved: Profile[] = []
    try {
      const raw = JSON.parse(read('local', PROFILES_KEY) ?? '[]') as unknown
      if (Array.isArray(raw)) {
        saved = raw.flatMap((p) => {
          const o = p as Partial<Profile>
          const url = typeof o.url === 'string' ? normalizeUrl(o.url) : null
          return typeof o.id === 'string' && typeof o.name === 'string' && url ? [{ id: o.id, name: o.name.slice(0, 40), url }] : []
        })
      }
    } catch {
      saved = []
    }
    return [{ ...HERE, url: '' }, ...saved]
  },
  save(list: Profile[]): void {
    write('local', PROFILES_KEY, JSON.stringify(list.filter((p) => p.id !== HERE.id).map((p) => ({ id: p.id, name: p.name, url: p.url }))))
  },
  add(name: string, url: string): Profile {
    const p = { id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, name, url }
    servers.save([...servers.list(), p])
    return p
  },
  remove(id: string): void {
    if (id === HERE.id) return
    servers.save(servers.list().filter((p) => p.id !== id))
    session.clear(id)
    if (servers.activeId === id) servers.activeId = HERE.id
  },
  get activeId(): string {
    return read('session', ACTIVE_KEY) ?? HERE.id
  },
  set activeId(id: string) {
    write('session', ACTIVE_KEY, id)
  },
  active(): Profile {
    const id = servers.activeId
    return servers.list().find((p) => p.id === id) ?? HERE
  },
  /** The address shown for a profile ('' = this page's origin). */
  display(p: Profile): string {
    return p.url || location.origin
  },
}

/** The admin session of each server, by profile. */
export const session = {
  token(id = servers.activeId): string | null {
    return memory.get(id) ?? read('session', tokenKey(id))
  },
  name(id = servers.activeId): string {
    return read('session', nameKey(id)) ?? ''
  },
  set(r: AdminLoginResponse, id = servers.activeId): void {
    memory.set(id, r.token)
    write('session', tokenKey(id), r.token)
    write('session', nameKey(id), r.account.username)
  },
  clear(id = servers.activeId): void {
    memory.delete(id)
    write('session', tokenKey(id), null)
    write('session', nameKey(id), null)
  },
}

let onUnauthorized: () => void = () => {}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

/** A server's icon path (/admin/out/...) as a URL on that server. */
export function assetUrl(path: string | null | undefined, p: Profile = servers.active()): string | null {
  if (!path) return null
  return `${p.url}${path}`
}

async function request(p: Profile, method: string, path: string, body: unknown, token: string | null): Promise<unknown> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(`${p.url}/api/admin/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', mode: 'cors' })
  } catch (e) {
    throw new AdminApiError(0, 'network', `${p.name} (${servers.display(p)}) is not reachable${p.url ? ', or it does not allow this page\'s origin (ALLOWED_ORIGINS)' : ''}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const text = await res.text()
  let data: unknown = undefined
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!res.ok) {
    const err = data as Partial<ApiError> & { issues?: { path: string; message: string }[] }
    throw new AdminApiError(res.status, err?.error ?? 'http', err?.message ?? `HTTP ${res.status}`, err?.issues ?? [])
  }
  return data
}

export async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const p = servers.active()
  try {
    return (await request(p, method, path, body, path === 'login' ? null : session.token(p.id))) as T
  } catch (e) {
    if (e instanceof AdminApiError && e.status === 401 && path !== 'login') {
      session.clear(p.id)
      onUnauthorized()
    }
    throw e
  }
}

export const get = <T>(path: string) => call<T>('GET', path)
export const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body)
export const put = <T>(path: string, body?: unknown) => call<T>('PUT', path, body)
export const del = <T>(path: string) => call<T>('DELETE', path)

export type Health = { ok: true; info: AdminInfo } | { ok: false; reason: string }

/** Whether a server answers and runs this admin API version (no session needed). */
export async function health(p: Profile): Promise<Health> {
  try {
    const info = (await request(p, 'GET', 'info', undefined, null)) as Partial<AdminInfo> | undefined
    if (!info || info.admin !== true || typeof info.apiVersion !== 'number') return { ok: false, reason: 'no admin API (an older server)' }
    if (info.apiVersion < ADMIN_API_VERSION) return { ok: false, reason: `admin API v${info.apiVersion} is older than this panel (v${ADMIN_API_VERSION}); deploy the server` }
    return { ok: true, info: info as AdminInfo }
  } catch (e) {
    if (e instanceof AdminApiError && e.status === 404) return { ok: false, reason: 'no admin API (an older server, or ADMIN_PANEL=off)' }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** The active server's identity (cached per profile; refreshed by the Servers page and on switching). */
const infos = new Map<string, AdminInfo>()

export async function activeInfo(refresh = false): Promise<AdminInfo | null> {
  const p = servers.active()
  if (!refresh && infos.has(p.id)) return infos.get(p.id)!
  const h = await health(p)
  if (h.ok) infos.set(p.id, h.info)
  else infos.delete(p.id)
  return h.ok ? h.info : null
}

export function cachedInfo(id = servers.activeId): AdminInfo | undefined {
  return infos.get(id)
}

/** A query string from the defined, non-empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}
