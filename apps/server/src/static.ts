import { createReadStream, type Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import { createGzip } from 'node:zlib'

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // Wave 10: THIRD_PARTY_NOTICES.md ships next to the game files (apps/game/vite.config.ts).
  '.md': 'text/markdown; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.dds': 'image/vnd-ms.dds',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

/**
 * Types worth compressing (docs/ASSETS.md §5.4): text, glTF/binary buffers, uncompressed fonts, and PCM .wav (the
 * sound export's `--codec wav` fallback, docs/SOUND.md §3). Images, Ogg audio and woff2 are already entropy-coded and
 * are never compressed.
 */
export const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.txt', '.svg', '.glb', '.gltf', '.bin', '.wasm', '.ttf', '.otf', '.wav'])

/** Files smaller than this are sent as they are (compression would not pay for its headers). */
const GZIP_MIN_BYTES = 256

/**
 * Content-hashed file names (Vite's `index-BxYz12_a.js`): `-`, exactly 8 base64url characters with at least one
 * upper-case letter, then the extension. Such files never change, so they are cached for a year. The converted asset
 * trees are all lower case (0 of their ~16,000 names match), so they keep `no-cache` + ETag.
 */
export function isHashedName(name: string): boolean {
  const m = /-([A-Za-z0-9_-]{8})\.[a-z0-9]+$/.exec(name)
  return m !== null && /[A-Z]/.test(m[1])
}

/**
 * Maps a URL path (already stripped of its mount prefix) to a file under `root`, or null when the
 * path is malformed or escapes the root (.., encoded separators, NUL, dot-files, symlinks out).
 */
export async function resolveSafe(root: string, urlPath: string): Promise<string | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/').filter((s) => s !== '')
  if (segments.some((s) => s === '..' || s.startsWith('.') || s.includes(':'))) return null
  const absRoot = resolve(root)
  const candidate = resolve(absRoot, ...segments)
  if (candidate !== absRoot && !candidate.startsWith(absRoot + sep)) return null
  try {
    const [realRoot, real] = await Promise.all([realpath(absRoot), realpath(candidate)])
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null
    return real
  } catch {
    return null
  }
}

/** Encodings the client accepts (Accept-Encoding, q=0 excluded; `*` counts for both). */
export function acceptedEncodings(header: string | string[] | undefined): { br: boolean; gzip: boolean } {
  const out = { br: false, gzip: false }
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '')
  let star: boolean | null = null
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)).find((m) => m !== null)
    const ok = !q || Number(q[1]) > 0
    if (name === 'br') out.br = ok
    else if (name === 'gzip' || name === 'x-gzip') out.gzip = ok
    else if (name === '*') star = ok
  }
  if (star !== null) {
    if (!/\bbr\b/i.test(raw)) out.br = star
    if (!/\bgzip\b/i.test(raw)) out.gzip = star
  }
  return out
}

/** A precompressed sibling (`x.json.br`) inside the real root, not older than the file itself. */
async function sibling(file: string, st: Stats, suffix: string, realRoot: string): Promise<{ path: string; st: Stats } | null> {
  try {
    const real = await realpath(file + suffix)
    if (!real.startsWith(realRoot + sep)) return null
    const s = await stat(real)
    // A stale sibling (the file was rewritten without re-compressing) is ignored; 2 s covers coarse mtimes.
    if (!s.isFile() || s.mtimeMs + 2000 < st.mtimeMs) return null
    return { path: real, st: s }
  } catch {
    return null
  }
}

function etagOf(st: Stats, suffix = ''): string {
  return `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${suffix}"`
}

/** If-None-Match (a list, weak tags compare equal) or, without it, If-Modified-Since. */
function notModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const inm = req.headers['if-none-match']
  if (inm !== undefined) {
    if (inm.trim() === '*') return true
    return inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))
  }
  const ims = req.headers['if-modified-since']
  if (ims) {
    const t = Date.parse(ims)
    return Number.isFinite(t) && Math.floor(mtimeMs / 1000) * 1000 <= t
  }
  return false
}

export interface ServeOptions {
  /** A directory serves its index.html. */
  index?: boolean
  /** Cache-Control override. Default: a year + immutable for content-hashed names, else no-cache (+ ETag). */
  cache?: string
}

/**
 * Serves `urlPath` from `root`. Returns false (nothing written) when there is no such file so the
 * caller can fall back (SPA index, 404).
 *
 * Compression (docs/ASSETS.md §5.4), for COMPRESSIBLE types only, by the client's Accept-Encoding:
 * 1. a precompressed `x.br` sibling (brotli, written by optimize-out --precompress), else `x.gz`;
 * 2. otherwise gzip on the fly (level 6) for files of GZIP_MIN_BYTES or more;
 * 3. otherwise the file as it is.
 * Each variant has its own ETag (suffix -br / -gz); the Content-Type is always the original file's; `Vary:
 * Accept-Encoding` is set on every compressible response. HEAD sends the headers only.
 */
export async function serveFile(req: IncomingMessage, res: ServerResponse, root: string, urlPath: string, opts: ServeOptions = {}): Promise<boolean> {
  let file = await resolveSafe(root, urlPath)
  if (!file) return false
  let st = await stat(file).catch(() => null)
  if (st?.isDirectory() && opts.index) {
    file = join(file, 'index.html')
    st = await stat(file).catch(() => null)
  }
  if (!st || !st.isFile()) return false
  const ext = extname(file).toLowerCase()
  const compressible = COMPRESSIBLE.has(ext)
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': opts.cache ?? (isHashedName(basename(file)) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  }
  let body: { path: string; st: Stats; encoding: 'br' | 'gzip' | null; stream: 'file' | 'gzip' } = { path: file, st, encoding: null, stream: 'file' }
  let etag = etagOf(st)
  if (compressible) {
    headers.Vary = 'Accept-Encoding'
    const accept = acceptedEncodings(req.headers['accept-encoding'])
    const realRoot = await realpath(resolve(root)).catch(() => null)
    const br = accept.br && realRoot ? await sibling(file, st, '.br', realRoot) : null
    const gz = !br && accept.gzip && realRoot ? await sibling(file, st, '.gz', realRoot) : null
    if (br) {
      body = { path: br.path, st: br.st, encoding: 'br', stream: 'file' }
      etag = etagOf(st, '-br')
    } else if (gz) {
      body = { path: gz.path, st: gz.st, encoding: 'gzip', stream: 'file' }
      etag = etagOf(st, '-gz')
    } else if (accept.gzip && st.size >= GZIP_MIN_BYTES) {
      body = { path: file, st, encoding: 'gzip', stream: 'gzip' }
      etag = etagOf(st, '-gz')
    }
  }
  headers.ETag = etag
  if (body.encoding) headers['Content-Encoding'] = body.encoding
  if (notModified(req, etag, st.mtimeMs)) {
    res.writeHead(304, headers)
    res.end()
    return true
  }
  if (body.stream === 'file') headers['Content-Length'] = body.st.size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  const stream = createReadStream(body.path)
  stream.on('error', () => res.destroy())
  if (body.stream === 'gzip') {
    const gzip = createGzip({ level: 6 })
    gzip.on('error', () => res.destroy())
    stream.pipe(gzip).pipe(res)
  } else stream.pipe(res)
  return true
}
