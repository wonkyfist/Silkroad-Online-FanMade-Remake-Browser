/**
 * The page's side of the local editor API (docs/WORLD_EDITOR.md §2.2, §3.5, D3, D4, D18). The server and the wire
 * contract are lane WE-A's (`apps/viewer/editor-api/`: protocol.ts, client.ts); this wraps its browser client for the
 * page: the token from `?k=` (moved to sessionStorage by the client), the writer lease (a second tab is read-only),
 * the page-form Save of `EditSession.buildSave()` and the `load` that resumes it.
 *
 * Without the API (a page opened by a plain Vite, no token) the editor still runs: edits live in memory and Save says
 * how to start the editor properly.
 */
import { EditorApiClient } from '../../editor-api/client.ts'
import { API_PREFIX, LEASE_HEADER, TOKEN_HEADER, type PageSaveRequest } from '../../editor-api/protocol.ts'
import type { LoadPayload, SavePayload } from './session.ts'

export interface EditorStatusView {
  /** The GPU lock's owner line while another job holds it (the banner; previews stop). */
  gpuLock: string | null
  /** The convert lock's owner line while a convert runs. */
  convertLock: string | null
}

export class EditorApi {
  /** False when the page has no API (no token, or the server is gone): it runs without saving. */
  available = false
  readOnly = false
  readOnlyReason: string | null = null
  /** The API's one-time sentence (it took over a stale editor lock: DL-5). */
  notice: string | null = null
  /** The layer files an interrupted Save left out of step with the journal (SessionInfo.mismatched; DL-5). */
  mismatched: string[] = []
  private client: EditorApiClient | null = null

  constructor(readonly world: string) {}

  /** Connects with the page's token and claims the writer lease; false without an API. */
  async open(onReadOnly: (reason: string) => void): Promise<boolean> {
    try {
      this.client = EditorApiClient.fromPage()
    } catch {
      this.client = null
      return false
    }
    try {
      const info = await this.client.open()
      this.available = true
      this.readOnly = info.readOnly
      this.readOnlyReason = info.reason ?? null
      this.notice = info.notice ?? null
      this.mismatched = info.consistent === false ? [...(info.mismatched ?? [])] : []
      this.client.onLease = ro => {
        this.readOnly = ro
        if (ro) onReadOnly('Another World Editor tab took over: this one only looks now. Reload it to edit here.')
      }
      if (info.readOnly) onReadOnly(info.reason ?? 'Another World Editor tab is open: this one only looks.')
      return true
    } catch (err) {
      console.warn('[editor] the editor API is not answering:', err)
      this.available = false
      return false
    }
  }

  async status(): Promise<EditorStatusView | null> {
    if (!this.client || !this.available) return null
    try {
      return await this.client.status()
    } catch {
      return null
    }
  }

  async load(): Promise<LoadPayload | null> {
    if (!this.client || !this.available) return null
    const l = await this.client.load()
    return { files: l.files as LoadPayload['files'], layers: l.layers, journal: l.journal }
  }

  /** Saves the page form; null when there is no API. Throws with the server's sentence on a refusal. */
  async save(payload: SavePayload): Promise<{ written: string[] } | null> {
    if (!this.client || !this.available) return null
    const r = await this.client.save(payload as unknown as PageSaveRequest)
    return { written: r.written }
  }

  /**
   * A raw call with this session's token and writer lease, for the routes ./publish.ts uses (the API client keeps
   * its own calls private). Throws without an API.
   */
  async request(method: 'GET' | 'POST', path: string, body?: unknown, init: { keepalive?: boolean } = {}): Promise<Response> {
    if (!this.client || !this.available) throw new Error('the editor API is not running (start the editor with "pnpm editor" or the desktop shortcut)')
    const headers: Record<string, string> = { [TOKEN_HEADER]: this.client.token }
    const lease = this.client.currentLease
    if (lease && !this.readOnly) headers[LEASE_HEADER] = lease
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(API_PREFIX + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', ...(init.keepalive ? { keepalive: true } : {}),
    })
  }

  /** palette.json from the world's edits folder (null: absent or no API). */
  async palette(): Promise<unknown | null> {
    if (!this.client || !this.available) return null
    try {
      return (await this.client.jsonLayer('palette.json')) ?? null
    } catch {
      return null
    }
  }
}

/** The channel the tokenless `?at=x,z` link (the game's /editmap) uses to send the open editor tab somewhere (D5). */
export const FLY_CHANNEL = 'sro-world-editor'

export interface FlyMessage {
  type: 'fly' | 'ack'
  x?: number
  z?: number
}
