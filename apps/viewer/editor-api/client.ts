/**
 * The editor page's client of the local API (browser; ./protocol.ts is the contract). WE-U's page makes one with
 * `EditorApiClient.fromPage()`: the token comes from the URL's `k` (then sessionStorage; the URL is cleaned so the
 * token never sits in the address bar or history), the lease is claimed with `open()` and kept by a heartbeat.
 *
 *   const api = EditorApiClient.fromPage()
 *   const session = await api.open()            // session.readOnly → show session.reason
 *   const px = await api.layer('height/171_97.png')   // Uint16Array | null
 *   await api.save({ files: [...], journal: { append: [...], head } })
 */
import { decodePatch, encodePatch, type ChangePatch } from './patch.ts'
import {
  API_PREFIX, LEASE_HEADER, TOKEN_HEADER, TOKEN_PARAM, bytesToBase64, bytesToPixels, parseLayerPath, pixelsToBytes,
  type DeployState, type EditorLoad, type EditorStatus, type JournalEntry, type JournalState, type LayerFileInfo,
  type PageSaveRequest, type PublishRecord, type PublishState, type SaveFile, type SaveRequest, type SaveResult,
  type SessionInfo, type TestGameState,
} from './protocol.ts'

const TOKEN_KEY = 'sro-editor-token'
const LEASE_KEY = 'sro-editor-lease'

export class EditorApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** A layer file for `save()`: pixels (Uint8Array / Uint16Array), a JSON value, or a removal. */
export const layerFile = (path: string, px: Uint8Array | Uint16Array): SaveFile => ({ path, pixels: bytesToBase64(pixelsToBytes(px)) })
export const jsonFile = (path: string, json: unknown): SaveFile => ({ path, json })
export const removedFile = (path: string): SaveFile => ({ path, remove: true })
/** A journal row for `save()`: the change and its patch. */
export const journalChange = (entry: JournalEntry, patch: ChangePatch) => ({ entry, patch: bytesToBase64(encodePatch(patch)) })

export class EditorApiClient {
  readonly token: string
  private lease: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** Called when the tab loses (or regains) the writer lease. */
  onLease: ((readOnly: boolean) => void) | null = null

  constructor(token: string) {
    this.token = token
  }

  /** The token from the page URL (`?k=`, then removed from the address bar) or this tab's sessionStorage. */
  static fromPage(): EditorApiClient {
    const url = new URL(location.href)
    let token = url.searchParams.get(TOKEN_PARAM)
    if (token) {
      try {
        sessionStorage.setItem(TOKEN_KEY, token)
      } catch {
        // Private mode: the token lives only in this page.
      }
      url.searchParams.delete(TOKEN_PARAM)
      history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    } else {
      try {
        token = sessionStorage.getItem(TOKEN_KEY)
      } catch {
        token = null
      }
    }
    if (!token) throw new EditorApiError(401, 'Open the World Editor from its desktop shortcut (or `pnpm editor`): this page has no session.')
    return new EditorApiClient(token)
  }

  get readOnly(): boolean {
    return this.lease === null
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { [TOKEN_HEADER]: this.token }
    if (this.lease) headers[LEASE_HEADER] = this.lease
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(API_PREFIX + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
    if (!res.ok && res.status !== 404) {
      let msg = `${res.status} ${res.statusText}`
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg
      } catch {
        // not JSON
      }
      throw new EditorApiError(res.status, msg)
    }
    return res
  }

  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return (await (await this.call(method, path, body)).json()) as T
  }

  /** Opens the session: claims the writer lease (or takes it over with `force`) and starts the heartbeat. */
  async open(force = false): Promise<SessionInfo> {
    let previous: string | null = null
    try {
      previous = sessionStorage.getItem(LEASE_KEY)
    } catch {
      previous = null
    }
    const info = await this.json<SessionInfo>('POST', 'session', { lease: previous ?? undefined, force })
    this.lease = info.lease ?? null
    try {
      if (this.lease) sessionStorage.setItem(LEASE_KEY, this.lease)
    } catch {
      // ignore
    }
    if (this.timer) clearInterval(this.timer)
    if (this.lease) this.timer = setInterval(() => void this.beat(), info.beatMs)
    return info
  }

  /** This page's writer lease (in memory: a duplicated tab's copied sessionStorage never makes two writers). */
  get currentLease(): string | null {
    return this.lease
  }

  private async beat(): Promise<void> {
    if (!this.lease) return
    try {
      const r = await this.json<{ ok: boolean }>('POST', 'heartbeat', { lease: this.lease })
      if (!r.ok) {
        // DL-2: re-claim before going read-only; the server grants it unless another tab holds a live lease
        const info = await this.json<SessionInfo>('POST', 'session', { lease: this.lease, force: false })
        this.lease = info.lease ?? null
        try {
          if (this.lease) sessionStorage.setItem(LEASE_KEY, this.lease)
        } catch {
          // ignore
        }
        if (!this.lease) {
          if (this.timer) clearInterval(this.timer)
          this.timer = null
          this.onLease?.(true)
        }
      }
    } catch {
      // The server is gone or restarting: the next call says so.
    }
  }

  status(): Promise<EditorStatus> {
    return this.json('GET', 'status')
  }

  async files(): Promise<LayerFileInfo[]> {
    return (await this.json<{ files: LayerFileInfo[] }>('GET', 'files')).files
  }

  /** A layer's pixels (Uint16Array for height), or null when the file is absent. */
  async layer(path: string): Promise<Uint8Array | Uint16Array | null> {
    const p = parseLayerPath(path)
    if (!p) throw new EditorApiError(400, `${path} is not a layer file`)
    const res = await this.call('GET', `layer?path=${encodeURIComponent(path)}`)
    if (res.status === 404) return null
    return bytesToPixels(p.kind, new Uint8Array(await res.arrayBuffer()))
  }

  /** A JSON layer file, or undefined when absent. */
  async jsonLayer(name: string): Promise<unknown> {
    const res = await this.call('GET', `json?name=${encodeURIComponent(name)}`)
    return res.status === 404 ? undefined : res.json()
  }

  journal(): Promise<JournalState> {
    return this.json('GET', 'journal')
  }

  async patch(id: number): Promise<ChangePatch | null> {
    const res = await this.call('GET', `patch?id=${id}`)
    if (res.status === 404) return null
    return decodePatch(new Uint8Array(await res.arrayBuffer()))
  }

  /** Writes layers and journal changes (needs the lease); either form (WE-U's buildSave() payload is the page form). */
  save(req: SaveRequest | PageSaveRequest): Promise<SaveResult> {
    return this.json('POST', 'save', req)
  }

  /** Everything the page needs to resume (WE-U's EditSession.load() payload). */
  load(): Promise<EditorLoad> {
    return this.json('GET', 'load')
  }

  /** Clears the history (after the layers changed outside the editor). */
  resetJournal(): Promise<JournalState> {
    return this.json('POST', 'journal/reset', {})
  }

  // --- step 2: Publish, Test in game, Deploy (docs/WORLD_EDITOR.md §2.4, §6) ---

  /** The open or last publish and the job running; poll it (≈ 1 s) while `running` is set. */
  publishState(): Promise<PublishState> {
    return this.json('GET', 'publish')
  }

  /** Publish…: the checks, the staging convert and the report (202: it runs in its own process). */
  publishStart(): Promise<PublishState> {
    return this.json('POST', 'publish/start', {})
  }

  /** Keep (the report's button): the live map gets the changes and content/ is committed. */
  publishKeep(n: number): Promise<PublishState> {
    return this.json('POST', 'publish/keep', { n })
  }

  /** Go back: the staging export goes, nothing changed. */
  publishDiscard(n: number): Promise<PublishState> {
    return this.json('POST', 'publish/discard', { n })
  }

  /** Undo the newest kept publish (its files copied back). */
  publishUndo(n: number): Promise<PublishState> {
    return this.json('POST', 'publish/undo', { n })
  }

  /** The record and WE-N's report (`report`). */
  publishReport(n: number): Promise<PublishRecord & { report: unknown }> {
    return this.json('GET', `publish/report?n=${n}`)
  }

  /** report.html (put it in an iframe's srcdoc). */
  async publishPage(n: number): Promise<string> {
    return (await this.call('GET', `publish/page?n=${n}`)).text()
  }

  /** A before / after image the page rendered (`name`: a-z, 0-9, _ and -; PNG as a data URL or base64). */
  publishShot(n: number, name: string, png: string): Promise<{ ok: true }> {
    return this.json('POST', 'publish/shot', { n, name, png })
  }

  testState(): Promise<TestGameState> {
    return this.json('GET', 'test')
  }

  /** Test in game: resolves once the private game answers (≈ 10-60 s), or with the reason it could not. */
  testStart(): Promise<TestGameState> {
    return this.json('POST', 'test/start', {})
  }

  testStop(): Promise<TestGameState> {
    return this.json('POST', 'test/stop', {})
  }

  /** May the map edits go to the friends now? (`ok`, the sentence, the changes.) */
  deployPlan(): Promise<DeployState> {
    return this.json('GET', 'deploy')
  }

  /** The dialog's Deploy button (the user's OK): the assets-only deploy. */
  deployRun(): Promise<DeployState> {
    return this.json('POST', 'deploy/run', { confirm: true })
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
