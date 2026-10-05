import { ADMIN_PAGE_SIZE_MAX, codePointLength, type ErrorCode } from '@sro/shared'

/**
 * Small request helpers of the admin API (docs/ADMIN.md §3, §4): errors that become `ApiError` answers, strict body
 * readers (unknown keys refused, bounded numbers) and the paging query.
 */

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Extra answer fields (e.g. the quest editor's `issues`). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export const bad = (message: string): AdminError => new AdminError(400, 'bad_request', message)
export const notFound = (message = 'not found'): AdminError => new AdminError(404, 'not_found', message)
export const conflict = (message: string): AdminError => new AdminError(409, 'bad_request', message)

export type Obj = Record<string, unknown>

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The body as an object with only `allowed` keys. */
export function body(v: unknown, allowed: readonly string[]): Obj {
  if (!isObj(v)) throw bad('the body must be a JSON object')
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw bad(`unexpected field ${k}`)
  return v
}

export function int(o: Obj, k: string, lo: number, hi: number): number
export function int(o: Obj, k: string, lo: number, hi: number, optional: true): number | undefined
export function int(o: Obj, k: string, lo: number, hi: number, optional = false): number | undefined {
  const v = o[k]
  if (v === undefined && optional) return undefined
  if (!Number.isSafeInteger(v) || (v as number) < lo || (v as number) > hi) throw bad(`${k} must be a whole number from ${lo} to ${hi}`)
  return v as number
}

export function num(o: Obj, k: string, lo: number, hi: number): number
export function num(o: Obj, k: string, lo: number, hi: number, optional: true): number | undefined
export function num(o: Obj, k: string, lo: number, hi: number, optional = false): number | undefined {
  const v = o[k]
  if (v === undefined && optional) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(`${k} must be a number from ${lo} to ${hi}`)
  return v
}

export function str(o: Obj, k: string, maxLen: number): string
export function str(o: Obj, k: string, maxLen: number, optional: true): string | undefined
export function str(o: Obj, k: string, maxLen: number, optional = false): string | undefined {
  const v = o[k]
  if (v === undefined && optional) return undefined
  if (typeof v !== 'string') throw bad(`${k} must be a string`)
  if (codePointLength(v) > maxLen) throw bad(`${k} is longer than ${maxLen} characters`)
  return v
}

export function flag(o: Obj, k: string): boolean | undefined {
  const v = o[k]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw bad(`${k} must be true or false`)
  return v
}

/** ?page (0-based) and ?size (1..ADMIN_PAGE_SIZE_MAX, default 50). */
export function paging(q: URLSearchParams, defaultSize = 50): { page: number; size: number } {
  const page = Number(q.get('page') ?? 0)
  const size = Number(q.get('size') ?? defaultSize)
  if (!Number.isInteger(page) || page < 0 || page > 1_000_000) throw bad('page must be a whole number >= 0')
  if (!Number.isInteger(size) || size < 1 || size > ADMIN_PAGE_SIZE_MAX) throw bad(`size must be 1-${ADMIN_PAGE_SIZE_MAX}`)
  return { page, size }
}

/** A search string from the query (trimmed, at most 64 characters). */
export function search(q: URLSearchParams, k = 'q'): string {
  return (q.get(k) ?? '').trim().slice(0, 64)
}

/** A path segment: decoded, or a 400. */
export function segment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw bad('malformed path')
  }
}

/** A positive integer id from a path segment. */
export function idOf(raw: string): number {
  const v = Number(raw)
  if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(v) || v < 1) throw bad('malformed id')
  return v
}

/** One page of an in-memory list. */
export function pageOf<T>(all: readonly T[], page: number, size: number): { total: number; page: number; size: number; rows: T[] } {
  return { total: all.length, page, size, rows: all.slice(page * size, page * size + size) }
}
