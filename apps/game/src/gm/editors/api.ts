/**
 * The Quest Editor's HTTP client (docs/QUESTS.md §5.4, docs/WAVE_PLAN.md §2.3; lane ED-C): Bearer calls to the
 * `/api/gm/quests*` routes of apps/server/src/editors/quest-api.ts, plus `GET /api/quests` for the quest bodies.
 * Same origin (Vite proxies /api in dev). Never throws: every answer is a `GmApiAnswer`.
 */
import { GM_API_MAX_BODY_BYTES, utf8Length, type ApiGmQuestList, type ApiGmQuestPut, type ApiGmQuestResult, type ApiQuestCatalog, type QuestIssue } from '@sro/shared'
import { t } from '../../i18n/index.ts'

export type GmApiAnswer<T> = { ok: true; status: number; data: T } | { ok: false; status: number; message: string; result?: ApiGmQuestResult }

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function readIssues(v: unknown): QuestIssue[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(isRecord)
    .map(i => ({ path: typeof i.path === 'string' ? i.path : '', message: typeof i.message === 'string' ? i.message : String(i.message ?? ''), severity: i.severity === 'warning' ? ('warning' as const) : ('error' as const) }))
}

/** An ApiGmQuestResult body; null when it is not one. */
export function readQuestResult(v: unknown): ApiGmQuestResult | null {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return null
  return { ok: v.ok, rev: typeof v.rev === 'number' && Number.isFinite(v.rev) ? v.rev : 0, issues: readIssues(v.issues) }
}

/** An ApiGmQuestList body; null when it is not one. */
export function readQuestList(v: unknown): ApiGmQuestList | null {
  if (!isRecord(v) || !Array.isArray(v.quests)) return null
  const quests: ApiGmQuestList['quests'] = []
  for (const q of v.quests) {
    if (!isRecord(q) || typeof q.id !== 'string') continue
    quests.push({
      id: q.id,
      title: typeof q.title === 'string' ? q.title : q.id,
      file: typeof q.file === 'string' ? q.file : '',
      source: q.source === 'override' ? 'override' : 'repo',
      rev: typeof q.rev === 'number' && Number.isFinite(q.rev) ? q.rev : 0,
      disabled: q.disabled === true,
      issues: readIssues(q.issues),
    })
  }
  return { rev: typeof v.rev === 'number' && Number.isFinite(v.rev) ? v.rev : 0, quests }
}

/** An ApiQuestCatalog body (files kept as sent: the server validated them); null when it is not one. */
export function readCatalog(v: unknown): ApiQuestCatalog | null {
  if (!isRecord(v) || !Array.isArray(v.files)) return null
  return { rev: typeof v.rev === 'number' && Number.isFinite(v.rev) ? v.rev : 0, files: v.files.filter(isRecord) as unknown as ApiQuestCatalog['files'] }
}

/** The English line for a failed call. */
function failText(status: number, body: unknown): string {
  if (isRecord(body) && typeof body.message === 'string' && body.message) {
    if (status === 403) return t('gm.editor.api.forbidden')
    return body.message
  }
  if (status === 0) return t('gm.editor.api.offline')
  if (status === 401) return t('gm.editor.api.unauthorized')
  if (status === 403) return t('gm.editor.api.forbidden')
  if (status === 413) return t('gm.editor.api.tooLarge')
  if (status === 429) return t('gm.editor.api.rateLimited')
  if (status === 409) return t('gm.editor.api.stale')
  if (status === 502 || status === 503 || status === 504) return t('gm.editor.api.offline')
  return t('gm.editor.api.http', { status })
}

export class GmQuestApi {
  constructor(
    private readonly token: () => string,
    private readonly base = '/api',
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, read: (v: unknown) => T | null, body?: unknown): Promise<GmApiAnswer<T>> {
    const headers: Record<string, string> = {}
    const tok = this.token()
    if (tok) headers.Authorization = `Bearer ${tok}`
    let text: string | undefined
    if (body !== undefined) {
      text = JSON.stringify(body)
      if (utf8Length(text) > GM_API_MAX_BODY_BYTES) return { ok: false, status: 413, message: t('gm.editor.api.tooLarge') }
      headers['Content-Type'] = 'application/json'
    }
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}`, { method, headers, body: text, cache: 'no-cache' })
    } catch {
      return { ok: false, status: 0, message: t('gm.editor.api.offline') }
    }
    let data: unknown
    try {
      const raw = await res.text()
      data = raw ? JSON.parse(raw) : undefined
    } catch {
      data = undefined
    }
    if (res.ok) {
      const v = read(data)
      return v === null ? { ok: false, status: res.status, message: t('gm.editor.api.badAnswer') } : { ok: true, status: res.status, data: v }
    }
    const result = readQuestResult(data) ?? undefined
    const first = result?.issues.find(i => i.severity === 'error')
    const message = res.status === 409 ? t('gm.editor.api.stale') : res.status === 422 ? t('gm.editor.api.invalid', { count: result?.issues.filter(i => i.severity === 'error').length ?? 0 }) : first ? first.message : failText(res.status, data)
    return { ok: false, status: res.status, message, ...(result ? { result } : {}) }
  }

  /** GET /api/gm/quests: every quest with source, rev, disabled flag and issues. */
  list(): Promise<GmApiAnswer<ApiGmQuestList>> {
    return this.call('GET', '/gm/quests', readQuestList)
  }

  /** GET /api/quests: the merged catalog (the quest bodies, quest items and locations). */
  catalog(): Promise<GmApiAnswer<ApiQuestCatalog>> {
    return this.call('GET', '/quests', readCatalog)
  }

  validate(body: ApiGmQuestPut): Promise<GmApiAnswer<ApiGmQuestResult>> {
    return this.call('POST', '/gm/quests/validate', readQuestResult, body)
  }

  /** Writes the override and hot-reloads (422 with issues, 409 when `baseRev` is stale). */
  save(id: string, body: ApiGmQuestPut): Promise<GmApiAnswer<ApiGmQuestResult>> {
    return this.call('PUT', `/gm/quests/${encodeURIComponent(id)}`, readQuestResult, body)
  }

  /** Drops the override: the repo version returns (or an override-only quest disappears). */
  revert(id: string): Promise<GmApiAnswer<ApiGmQuestResult>> {
    return this.call('DELETE', `/gm/quests/${encodeURIComponent(id)}`, readQuestResult)
  }

  setDisabled(id: string, disabled: boolean): Promise<GmApiAnswer<ApiGmQuestResult>> {
    return this.call('POST', `/gm/quests/${encodeURIComponent(id)}/${disabled ? 'disable' : 'enable'}`, readQuestResult)
  }
}
