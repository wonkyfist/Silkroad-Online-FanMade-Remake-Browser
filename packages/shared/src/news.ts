/**
 * The in-game "What's new" window (docs/CHANGELOG_WINDOW.md): the entry files (`content/changelog/<id>.md`, front
 * matter + a small Markdown dialect), their order, the unseen rule, and the safe HTML renderer shared by the server,
 * the game client and the admin panel's preview. Environment-neutral: no DOM, no node:*.
 *
 * Safety: the renderer never passes raw HTML through. Every piece of text and every attribute is escaped, links keep
 * only their text, and an image is drawn only when its source names a file of the changelog image store
 * (NEWS_IMAGE_NAME), whose URL the caller builds.
 */

/** Entry ids: the file name without `.md`, e.g. `2026-10-05-play-the-boss`. */
export const NEWS_ID = /^[a-z0-9][a-z0-9-]{0,79}$/
/** `yyyy-mm-dd`, optionally with a time `yyyy-mm-ddThh:mm` (UTC) to order two entries of one day. */
export const NEWS_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/
/** A file of the image store (`content/changelog/img/`, DATA_DIR overrides): lower case, web image types only. */
export const NEWS_IMAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,79}\.(?:jpg|jpeg|png|webp)$/
/** Where the server serves the image store (under /api so the dev proxies pass it through). */
export const NEWS_IMAGE_PATH = '/api/news/img/'
export const NEWS_TITLE_MAX = 120
export const NEWS_SUMMARY_MAX = 400
/** Body length (code points). */
export const NEWS_BODY_MAX = 40_000
/** Largest stored image (bytes). Authoring target: under ~250 KB, at most 1280 px wide. */
export const NEWS_IMAGE_MAX_BYTES = 400 * 1024
/** At most this many unseen entries are shown at a login (the newest). */
export const NEWS_UNSEEN_MAX = 5
/** Admin API bodies: an entry, and an image upload (base64 inside JSON). */
export const NEWS_ADMIN_BODY_MAX_BYTES = 96 * 1024
export const NEWS_IMAGE_BODY_MAX_BYTES = 600 * 1024

export interface NewsEntry {
  id: string
  /** NEWS_DATE. */
  date: string
  title: string
  /** One or two sentences: the list line and the window's lead. */
  summary: string
  /** Optional image (NEWS_IMAGE_NAME) shown above the body. */
  hero?: string
  /** Hidden from players (the admin panel still lists it). */
  draft?: boolean
  /** Markdown (see parseNewsMarkdown). */
  body: string
}

/** `GET /api/news`: every published entry, newest first, and the ids this account has not seen (newest first). */
export interface ApiNewsList {
  entries: NewsEntry[]
  unseen: string[]
}

/** `POST /api/news/seen`: everything up to and including entry `id` counts as seen for this account. */
export interface ApiNewsSeenRequest {
  id: string
}

export interface ApiNewsSeenResponse {
  unseen: string[]
}

/** Where an entry of the admin panel comes from: the repo file, a panel-only entry, or a repo file edited in the panel. */
export type NewsSource = 'repo' | 'panel' | 'edited'

export interface AdminNewsRow extends NewsEntry {
  source: NewsSource
}

/** `GET /api/admin/news`. */
export interface AdminNewsView {
  entries: AdminNewsRow[]
  /** Every file of the image store. */
  images: string[]
  /** Problems of files that could not be read (skipped). */
  problems: string[]
}

/** `PUT /api/admin/news/<id>`: the entry without its id. */
export type AdminNewsPut = Omit<NewsEntry, 'id'>

/** `POST /api/admin/news-images`: `data` is the file, base64. */
export interface AdminNewsImageUpload {
  name: string
  data: string
}

// ---- order and the unseen rule ----------------------------------------------------------------------------------

/** `yyyy-mm-ddThh:mm` (time 00:00 when absent), or null when the date is malformed. */
export function newsDateKey(date: string): string | null {
  const m = NEWS_DATE.exec(date)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00'] = m
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31 || Number(h) > 23 || Number(mi) > 59 || Number(y) < 2000) return null
  return `${y}-${mo}-${d}T${h}:${mi}`
}

/** A seen mark: the newest entry an account has acknowledged. */
export interface NewsMark {
  date: string
  id: string
}

/** Positive when `a` is newer than `b` (date, then id). */
export function compareNews(a: NewsMark, b: NewsMark): number {
  const ka = newsDateKey(a.date) ?? ''
  const kb = newsDateKey(b.date) ?? ''
  if (ka !== kb) return ka < kb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Newest first. */
export function sortNews<T extends NewsMark>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => compareNews(b, a))
}

/**
 * The entries an account has not seen yet, newest first, at most NEWS_UNSEEN_MAX. With a mark: those newer than it.
 * Without one (the account never pressed "Got it"): those dated on or after the day the account was created, so a
 * new player is not handed the whole history.
 */
export function unseenNews<T extends NewsMark>(entries: readonly T[], mark: NewsMark | null, accountCreatedAt: number): T[] {
  const sorted = sortNews(entries)
  let out: T[]
  if (mark) out = sorted.filter((e) => compareNews(e, mark) > 0)
  else {
    const day = new Date(accountCreatedAt).toISOString().slice(0, 10)
    out = sorted.filter((e) => (newsDateKey(e.date) ?? '').slice(0, 10) >= day)
  }
  return out.slice(0, NEWS_UNSEEN_MAX)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** `2026-10-05` -> `October 5, 2026` (the time, if any, is not shown). */
export function formatNewsDate(date: string): string {
  const k = newsDateKey(date)
  if (!k) return date
  return `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}, ${k.slice(0, 4)}`
}

// ---- entry files ------------------------------------------------------------------------------------------------

/** Control and bidi-override characters (kept: tab and newline in the body). */
const UNSAFE_LINE = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g
const UNSAFE_BODY = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g

const codePoints = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** A one-line text field: unsafe characters dropped, whitespace collapsed. */
export function cleanNewsLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(UNSAFE_LINE, '').replace(/\s+/g, ' ').trim()
}

/** The body: CRLF -> LF, unsafe characters dropped, trailing blank lines trimmed. */
export function cleanNewsBody(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(UNSAFE_BODY, '').replace(/\s+$/, '')
}

/**
 * Checks an entry (a parsed file or an admin save) and returns a clean copy or the problems. Every image the body
 * or the hero names must be a NEWS_IMAGE_NAME file; `images`, when given, must also contain it.
 */
export function checkNewsEntry(v: unknown, images?: ReadonlySet<string>): { entry: NewsEntry } | { problems: string[] } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { problems: ['the entry must be an object'] }
  const o = v as Record<string, unknown>
  const p: string[] = []
  for (const k of Object.keys(o)) if (!['id', 'date', 'title', 'summary', 'hero', 'draft', 'body'].includes(k)) p.push(`${k}: unknown field`)
  const id = typeof o.id === 'string' ? o.id : ''
  if (!NEWS_ID.test(id)) p.push('id: lower-case letters, digits and dashes (at most 80)')
  const date = typeof o.date === 'string' ? o.date.trim() : ''
  if (!newsDateKey(date)) p.push('date: yyyy-mm-dd or yyyy-mm-ddThh:mm')
  const title = typeof o.title === 'string' ? cleanNewsLine(o.title) : ''
  if (!title || codePoints(title) > NEWS_TITLE_MAX) p.push(`title: 1-${NEWS_TITLE_MAX} characters`)
  const summary = typeof o.summary === 'string' ? cleanNewsLine(o.summary) : ''
  if (codePoints(summary) > NEWS_SUMMARY_MAX) p.push(`summary: at most ${NEWS_SUMMARY_MAX} characters`)
  let hero: string | undefined
  if (o.hero !== undefined && o.hero !== null && o.hero !== '') {
    hero = typeof o.hero === 'string' ? newsImageName(o.hero.trim()) ?? undefined : undefined
    if (!hero) p.push('hero: an image file of the changelog image folder (lower case .jpg, .png or .webp)')
    else if (images && !images.has(hero)) p.push(`hero: no image ${hero}`)
  }
  if (o.draft !== undefined && typeof o.draft !== 'boolean') p.push('draft: true or false')
  const body = typeof o.body === 'string' ? cleanNewsBody(o.body) : null
  if (body === null) p.push('body: text')
  else if (codePoints(body) > NEWS_BODY_MAX) p.push(`body: at most ${NEWS_BODY_MAX} characters`)
  else {
    const refs = newsImageRefs(body)
    for (const bad of refs.bad) p.push(`body: image "${bad}" is not a file of the changelog image folder`)
    if (images) for (const name of refs.ok) if (!images.has(name)) p.push(`body: no image ${name}`)
  }
  if (p.length) return { problems: p }
  const entry: NewsEntry = { id, date, title, summary, ...(hero ? { hero } : {}), ...(o.draft === true ? { draft: true } : {}), body: body! }
  return { entry }
}

const FRONT_KEYS = new Set(['id', 'date', 'title', 'summary', 'hero', 'draft'])

/**
 * Reads an entry file:
 *
 *     ---
 *     id: 2026-10-05-play-the-boss
 *     date: 2026-10-05
 *     title: October 5: Play the Boss
 *     summary: One or two sentences.
 *     hero: boss-3-hud.jpg
 *     ---
 *     Markdown body...
 *
 * `fileId` (the file name without .md) is the id when the front matter has none, and must match it when it has one.
 */
export function parseNewsFile(text: string, fileId?: string, images?: ReadonlySet<string>): { entry: NewsEntry } | { problems: string[] } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src)
  if (!m) return { problems: ['the file must start with a front matter block between --- lines'] }
  const fields: Record<string, unknown> = {}
  const p: string[] = []
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 1) {
      p.push(`front matter: "${line.trim().slice(0, 40)}" is not "key: value"`)
      continue
    }
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) value = value.slice(1, -1)
    if (!FRONT_KEYS.has(key)) {
      p.push(`front matter: unknown key ${key}`)
      continue
    }
    fields[key] = key === 'draft' ? value === 'true' || value === 'yes' : value
  }
  if (fields.id === undefined && fileId !== undefined) fields.id = fileId
  if (fileId !== undefined && fields.id !== fileId) p.push(`id: ${String(fields.id)} does not match the file name ${fileId}.md`)
  if (fields.summary === undefined) fields.summary = ''
  fields.body = src.slice(m[0].length).replace(/^\n+/, '')
  const r = checkNewsEntry(fields, images)
  if ('problems' in r) return { problems: [...p, ...r.problems] }
  return p.length ? { problems: p } : r
}

/** The file text of an entry (what parseNewsFile reads back). */
export function serializeNewsFile(e: NewsEntry): string {
  const lines = ['---', `id: ${e.id}`, `date: ${e.date}`, `title: ${e.title}`, `summary: ${e.summary}`]
  if (e.hero) lines.push(`hero: ${e.hero}`)
  if (e.draft) lines.push('draft: true')
  lines.push('---', '')
  return `${lines.join('\n')}${e.body.replace(/\s+$/, '')}\n`
}

// ---- Markdown ---------------------------------------------------------------------------------------------------

export type NewsInline =
  | { k: 'text'; text: string }
  | { k: 'b'; c: NewsInline[] }
  | { k: 'i'; c: NewsInline[] }
  | { k: 'code'; text: string }

export interface NewsImage {
  /** A NEWS_IMAGE_NAME file. */
  src: string
  alt: string
  caption: string
}

export type NewsBlock =
  | { k: 'h'; level: 1 | 2 | 3; c: NewsInline[] }
  | { k: 'p'; c: NewsInline[] }
  | { k: 'ul' | 'ol'; items: NewsInline[][] }
  | { k: 'img'; img: NewsImage }
  /** Images on consecutive lines: shown side by side (wrapping on narrow screens). */
  | { k: 'row'; imgs: NewsImage[] }
  | { k: 'quote'; c: NewsInline[] }
  | { k: 'hr' }

/**
 * An image source as a file of the image store: `name.jpg`, `img/name.jpg`, `./img/name.jpg` or the served path
 * `/api/news/img/name.jpg`. Anything else (another folder, a URL, `javascript:`, `..`) is null.
 */
export function newsImageName(src: string): string | null {
  let s = src.trim()
  if (s.startsWith(NEWS_IMAGE_PATH)) s = s.slice(NEWS_IMAGE_PATH.length)
  else if (s.startsWith('./img/')) s = s.slice(6)
  else if (s.startsWith('img/')) s = s.slice(4)
  return NEWS_IMAGE_NAME.test(s) ? s : null
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)\s*$/

/** The images a body names: the allowed files, and the sources that are not allowed. */
export function newsImageRefs(md: string): { ok: string[]; bad: string[] } {
  const ok = new Set<string>()
  const bad: string[] = []
  for (const line of md.split('\n')) {
    const m = IMAGE_LINE.exec(line.trim())
    if (!m) continue
    const name = newsImageName(m[2])
    if (name) ok.add(name)
    else bad.push(m[2].slice(0, 80))
  }
  return { ok: [...ok], bad }
}

/** Inline Markdown: **bold**, *italic* / _italic_, `code`, [text](link) (text only), \-escapes. */
export function parseNewsInline(s: string): NewsInline[] {
  const out: NewsInline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ k: 'text', text })
    text = ''
  }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length && /[\\`*_[\]()!#>+-]/.test(s[i + 1])) {
      text += s[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ k: 'code', text: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ k: 'b', c: parseNewsInline(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] !== undefined && s[i + 1] !== ' ' && s[i + 1] !== ch) {
      const wordBefore = ch === '_' && i > 0 && /[A-Za-z0-9]/.test(s[i - 1])
      let end = s.indexOf(ch, i + 1)
      // `*` inside `**` belongs to the bold
      while (ch === '*' && end > 0 && s[end + 1] === '*') end = s.indexOf(ch, end + 2)
      if (!wordBefore && end > i + 1 && s[end - 1] !== ' ' && !(ch === '_' && /[A-Za-z0-9]/.test(s[end + 1] ?? ''))) {
        flush()
        out.push({ k: 'i', c: parseNewsInline(s.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(s.slice(i))
      if (m) {
        flush()
        out.push(...parseNewsInline(m[1]))
        i += m[0].length
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  // merge neighbouring text runs (links and escapes split them)
  const merged: NewsInline[] = []
  for (const n of out) {
    const last = merged[merged.length - 1]
    if (n.k === 'text' && last?.k === 'text') last.text += n.text
    else merged.push(n)
  }
  return merged
}

/**
 * The body as blocks: `#`/`##`/`###` headings, paragraphs (lines joined), `-`/`*` and `1.` lists (an indented line
 * continues the item), `![alt](img/file.jpg "caption")` on a line of its own (consecutive image lines form a row),
 * `>` notes and `---` rules. Images whose source is not a file of the image store are dropped.
 */
export function parseNewsMarkdown(md: string): NewsBlock[] {
  const blocks: NewsBlock[] = []
  let para: string[] = []
  let list: { k: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []
  let row: NewsImage[] = []
  const flushPara = () => {
    if (para.length) blocks.push({ k: 'p', c: parseNewsInline(para.join(' ')) })
    para = []
  }
  const flushList = () => {
    if (list) blocks.push({ k: list.k, items: list.items.map(parseNewsInline) })
    list = null
  }
  const flushQuote = () => {
    if (quote.length) blocks.push({ k: 'quote', c: parseNewsInline(quote.join(' ')) })
    quote = []
  }
  const flushRow = () => {
    if (row.length === 1) blocks.push({ k: 'img', img: row[0] })
    else if (row.length > 1) blocks.push({ k: 'row', imgs: row })
    row = []
  }
  const flushAll = () => {
    flushPara()
    flushList()
    flushQuote()
    flushRow()
  }
  for (const raw of cleanNewsBody(md).split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    const t = line.trim()
    if (!t) {
      flushAll()
      continue
    }
    const img = IMAGE_LINE.exec(t)
    if (img) {
      flushPara()
      flushList()
      flushQuote()
      const src = newsImageName(img[2])
      if (src) row.push({ src, alt: cleanNewsLine(img[1]), caption: cleanNewsLine(img[3] ?? img[1]) })
      continue
    }
    flushRow()
    const h = /^(#{1,3})\s+(.+?)\s*#*$/.exec(t)
    if (h) {
      flushAll()
      blocks.push({ k: 'h', level: h[1].length as 1 | 2 | 3, c: parseNewsInline(h[2]) })
      continue
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushAll()
      blocks.push({ k: 'hr' })
      continue
    }
    const ul = /^[-*+]\s+(.*)$/.exec(t)
    const ol = /^\d{1,3}[.)]\s+(.*)$/.exec(t)
    if (ul || ol) {
      flushPara()
      flushQuote()
      const k = ul ? 'ul' : 'ol'
      if (list && list.k !== k) flushList()
      if (!list) list = { k, items: [] }
      list.items.push((ul ?? ol)![1])
      continue
    }
    if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${t}`
      continue
    }
    const q = /^>\s?(.*)$/.exec(t)
    if (q) {
      flushPara()
      flushList()
      quote.push(q[1])
      continue
    }
    flushList()
    flushQuote()
    para.push(t)
  }
  flushAll()
  return blocks
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escapes text for HTML element content and quoted attributes. */
export function escapeNewsHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}

function inlineHtml(nodes: readonly NewsInline[]): string {
  return nodes
    .map((n) => {
      switch (n.k) {
        case 'text':
          return escapeNewsHtml(n.text)
        case 'code':
          return `<code>${escapeNewsHtml(n.text)}</code>`
        case 'b':
          return `<strong>${inlineHtml(n.c)}</strong>`
        case 'i':
          return `<em>${inlineHtml(n.c)}</em>`
      }
    })
    .join('')
}

export interface NewsHtmlOptions {
  /** The URL of an image store file (the name is already a NEWS_IMAGE_NAME). Default: NEWS_IMAGE_PATH + name. */
  imageUrl?: (name: string) => string
}

/** The URL of an image store file on this origin. */
export function newsImageUrl(name: string, base = ''): string {
  return `${base}${NEWS_IMAGE_PATH}${encodeURIComponent(name)}`
}

function figureHtml(img: NewsImage, url: (name: string) => string): string {
  if (!NEWS_IMAGE_NAME.test(img.src)) return ''
  const cap = img.caption ? `<figcaption>${inlineHtml(parseNewsInline(img.caption))}</figcaption>` : ''
  return `<figure class="nw-fig"><img src="${escapeNewsHtml(url(img.src))}" alt="${escapeNewsHtml(img.alt)}" loading="lazy" decoding="async" data-news-img="${escapeNewsHtml(img.src)}">${cap}</figure>`
}

/** Blocks (or a Markdown body) as HTML. Everything is escaped; no raw HTML from the body ever reaches the output. */
export function newsHtml(body: string | readonly NewsBlock[], opts: NewsHtmlOptions = {}): string {
  const url = opts.imageUrl ?? ((name: string) => newsImageUrl(name))
  const blocks = typeof body === 'string' ? parseNewsMarkdown(body) : body
  return blocks
    .map((b) => {
      switch (b.k) {
        case 'h':
          return `<h${b.level + 2} class="nw-h nw-h${b.level}">${inlineHtml(b.c)}</h${b.level + 2}>`
        case 'p':
          return `<p>${inlineHtml(b.c)}</p>`
        case 'ul':
        case 'ol':
          return `<${b.k}>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('')}</${b.k}>`
        case 'img':
          return figureHtml(b.img, url)
        case 'row':
          return `<div class="nw-row">${b.imgs.map((i) => figureHtml(i, url)).join('')}</div>`
        case 'quote':
          return `<blockquote>${inlineHtml(b.c)}</blockquote>`
        case 'hr':
          return '<hr>'
      }
    })
    .join('\n')
}
