import {
  NEWS_ADMIN_BODY_MAX_BYTES,
  NEWS_ID,
  NEWS_IMAGE_BODY_MAX_BYTES,
  NEWS_IMAGE_MAX_BYTES,
  checkNewsEntry,
  type AdminNewsRow,
  type AdminNewsView,
} from '@sro/shared'
import type { AdminCall } from './call.ts'
import { AdminError, bad, body, notFound, str } from './http.ts'

/**
 * The admin panel's News page (docs/CHANGELOG_WINDOW.md §4): the "What's new" entries with where each comes from,
 * saving an entry (the panel's copy in DATA_DIR/content/changelog, layered over the repo file), reverting it, and
 * uploading images (already resized in the browser). Every write adds an admin_audit row.
 */

export function listNews(c: AdminCall): AdminNewsView {
  const news = c.ctx.news
  return { entries: news.all(), images: news.images(), problems: news.problems }
}

function idOf(raw: string): string {
  if (!NEWS_ID.test(raw)) throw bad('the id must be lower-case letters, digits and dashes (at most 80)')
  return raw
}

export function newsDetail(c: AdminCall, raw: string): AdminNewsRow {
  const e = c.ctx.news.get(idOf(raw))
  if (!e) throw notFound('no such entry')
  return e
}

export async function putNews(c: AdminCall, raw: string): Promise<AdminNewsRow> {
  const id = idOf(raw)
  const o = body(await c.body(NEWS_ADMIN_BODY_MAX_BYTES), ['date', 'title', 'summary', 'hero', 'draft', 'body'])
  const news = c.ctx.news
  const r = checkNewsEntry({ ...o, id }, new Set(news.images()))
  if ('problems' in r) {
    c.audit('news.put', `news:${id}`, undefined, undefined, false, r.problems.join('; ').slice(0, 500))
    throw new AdminError(400, 'bad_request', r.problems.join('; '), { issues: r.problems.map((message) => ({ path: message.split(':')[0], message })) })
  }
  const before = news.get(id)
  news.save(r.entry)
  c.audit('news.put', `news:${id}`, before ? { title: before.title, date: before.date, draft: before.draft ?? false } : undefined, { title: r.entry.title, date: r.entry.date, draft: r.entry.draft ?? false })
  c.ctx.config.log(`admin ${c.admin.username}: news ${id} saved${r.entry.draft ? ' (draft)' : ''}`)
  return news.get(id)!
}

export function deleteNews(c: AdminCall, raw: string): { reverted: boolean; entry: AdminNewsRow | null } {
  const id = idOf(raw)
  const news = c.ctx.news
  const before = news.get(id)
  if (!news.revert(id)) throw notFound(before ? 'this entry has no panel copy to remove (it comes from the repo)' : 'no such entry')
  const after = news.get(id) ?? null
  c.audit('news.delete', `news:${id}`, before ? { title: before.title } : undefined, after ? { title: after.title, source: after.source } : undefined)
  return { reverted: true, entry: after }
}

export async function uploadNewsImage(c: AdminCall): Promise<{ name: string; bytes: number; images: string[] }> {
  const o = body(await c.body(NEWS_IMAGE_BODY_MAX_BYTES), ['name', 'data'])
  const name = str(o, 'name', 90).trim().toLowerCase()
  const data = str(o, 'data', Math.ceil((NEWS_IMAGE_MAX_BYTES * 4) / 3) + 8)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw bad('data must be base64')
  const bytes = Buffer.from(data, 'base64')
  const news = c.ctx.news
  const replaced = news.hasImage(name)
  const r = news.saveImage(name, bytes)
  if ('error' in r) {
    c.audit('news.image', `news-image:${name.slice(0, 90)}`, undefined, undefined, false, r.error)
    throw bad(r.error)
  }
  c.audit('news.image', `news-image:${name}`, undefined, { bytes: bytes.length }, true, replaced ? 'replaced' : 'added')
  return { name, bytes: bytes.length, images: news.images() }
}
