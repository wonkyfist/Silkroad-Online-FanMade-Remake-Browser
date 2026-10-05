import type { ApiError, ApiLoginRequest, ApiLoginResponse, ApiRegisterRequest, ApiRegisterResponse, ErrorCode, ServerInfo } from '@sro/shared'
import { t } from '../i18n/index.ts'

/** A failed API call or a server `error` message. `code` is a protocol ErrorCode or 'network'. */
export class GameError extends Error {
  constructor(readonly code: ErrorCode | 'network' | 'timeout', message: string) {
    super(message)
    this.name = 'GameError'
  }
}

/** The account HTTP API (protocol v1 `Api*` types). */
export interface Api {
  /** The new account is logged in: the reply is a session like login's. */
  register(req: ApiRegisterRequest): Promise<ApiRegisterResponse>
  login(req: ApiLoginRequest): Promise<ApiLoginResponse>
  servers(): Promise<ServerInfo[]>
  /** Best effort: revokes the session token (POST /api/logout, Bearer token). */
  logout(token: string): Promise<void>
}

/**
 * Whether the login screen offers Register (docs/ADMIN.md, the admin panel's switch): closed only when every server
 * says so; an empty list or an older server without the field counts as open. The server refuses anyway when closed.
 */
export function registrationOpen(servers: readonly ServerInfo[]): boolean {
  return servers.length === 0 || servers.some((s) => s.registration !== 'closed')
}

function isApiError(v: unknown): v is ApiError {
  return !!v && typeof v === 'object' && typeof (v as ApiError).error === 'string'
}

/** fetch-based client for the real server (same origin; Vite proxies /api in dev). */
export class HttpApi implements Api {
  constructor(private readonly base = '/api') {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
    let res: Response
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      throw new GameError('network', t('net.unreachable', { detail: err instanceof Error ? err.message : String(err) }))
    }
    const text = await res.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = undefined
    }
    if (!res.ok) {
      if (isApiError(data)) throw new GameError(data.error, data.message)
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new GameError('network', t('net.serverDown'))
      }
      throw new GameError('server_error', t('net.http', { status: res.status, text: res.statusText }))
    }
    return data as T
  }

  register(req: ApiRegisterRequest): Promise<ApiRegisterResponse> {
    return this.call('POST', '/register', req)
  }

  login(req: ApiLoginRequest): Promise<ApiLoginResponse> {
    return this.call('POST', '/login', req)
  }

  async logout(token: string): Promise<void> {
    await this.call('POST', '/logout', undefined, token).catch(() => {})
  }

  async servers(): Promise<ServerInfo[]> {
    const data = await this.call<ServerInfo[] | { servers: ServerInfo[] }>('GET', '/servers')
    return Array.isArray(data) ? data : data.servers
  }
}
