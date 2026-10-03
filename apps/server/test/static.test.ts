/**
 * Production static serving (docs/ASSETS.md §5.4): /out-opt and /out with MIME types, precompressed .br/.gz
 * siblings by Accept-Encoding, on-the-fly gzip otherwise, ETag/304 per variant, caching headers, and the
 * path-traversal rules of /out applied to /out-opt.
 */
import { utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acceptedEncodings, isHashedName } from '../src/static.ts'
import { startTestServer, type TestServer } from './helpers.ts'

const JSON_BODY = JSON.stringify({ hello: 'world', list: Array.from({ length: 200 }, (_, i) => ({ i, name: `entry ${i}` })) })
const BIN = 'binary-ish '.repeat(100)
const BR = brotliCompressSync(Buffer.from(JSON_BODY))
const GZ = gzipSync(Buffer.from(BIN))

let s: TestServer

beforeAll(async () => {
  s = await startTestServer({
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [10, 0, -10] }),
      'out/index.json': JSON_BODY,
      'out-opt/index.json': JSON_BODY,
      'out-opt/world/jangan/nav.bin': BIN,
      'out-opt/world/jangan/tiles/a.webp': 'RIFF....WEBPVP8 '.repeat(64),
      'out-opt/char/man.glb': 'glTF'.repeat(200),
      'out-opt/music/town.ogg': 'OggS'.repeat(200),
      'out-opt/fonts/ui.ttf': 'font'.repeat(200),
      'out-opt/icons/a.png': 'png'.repeat(200),
      'out-opt/small.json': '{"a":1}',
      'out-opt/stale.json': JSON_BODY,
      'secret.txt': 'TOP SECRET',
      'dist/index.html': '<!doctype html><title>game</title>',
      'dist/assets/index-BxYz12_a.js': 'console.log("hashed")',
    },
    prepare: (root) => {
      // binary siblings (the files map writes UTF-8 text)
      writeFileSync(`${root}/out-opt/index.json.br`, BR)
      writeFileSync(`${root}/out-opt/world/jangan/nav.bin.gz`, GZ)
      writeFileSync(`${root}/out-opt/stale.json.br`, BR)
    },
  })
  // The .br of stale.json is older than the file: it must be ignored.
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(`${s.root}/out-opt/stale.json.br`, old, old)
})

afterAll(async () => {
  await s.stopAndClean()
})

interface Raw {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Raw> {
  const u = new URL(s.url)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('static serving of /out-opt and /out', () => {
  it('serves the precompressed brotli sibling when accepted, with the original type and its own ETag', async () => {
    const r = await get('/out-opt/index.json', { 'Accept-Encoding': 'gzip, deflate, br' })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(r.headers['content-encoding']).toBe('br')
    expect(r.headers.vary).toBe('Accept-Encoding')
    expect(Number(r.headers['content-length'])).toBe(BR.length)
    expect(r.body.equals(BR)).toBe(true)
    expect(String(r.headers.etag)).toMatch(/-br"$/)
    expect(r.headers['cache-control']).toBe('no-cache')
    // revalidation of the same variant
    const again = await get('/out-opt/index.json', { 'Accept-Encoding': 'br', 'If-None-Match': String(r.headers.etag) })
    expect(again.status).toBe(304)
    expect(again.body.length).toBe(0)
    // HEAD: headers only
    const head = await get('/out-opt/index.json', { 'Accept-Encoding': 'br' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-encoding']).toBe('br')
    expect(head.body.length).toBe(0)
  })

  it('gzips on the fly without a sibling (or without br), and sends identity when nothing is accepted', async () => {
    const gz = await get('/out-opt/index.json', { 'Accept-Encoding': 'gzip' })
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(gz.headers['content-length']).toBeUndefined()
    expect(gunzipSync(gz.body).toString()).toBe(JSON_BODY)
    expect(String(gz.headers.etag)).toMatch(/-gz"$/)
    expect((await get('/out-opt/index.json', { 'Accept-Encoding': 'gzip', 'If-None-Match': String(gz.headers.etag) })).status).toBe(304)
    // the plain ETag does not validate the gzip variant
    const plain = await get('/out-opt/index.json')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.toString()).toBe(JSON_BODY)
    expect(Number(plain.headers['content-length'])).toBe(Buffer.byteLength(JSON_BODY))
    expect((await get('/out-opt/index.json', { 'Accept-Encoding': 'gzip', 'If-None-Match': String(plain.headers.etag) })).status).toBe(200)
    // br refused with q=0, gzip wanted
    const q0 = await get('/out-opt/index.json', { 'Accept-Encoding': 'br;q=0, gzip;q=0.5' })
    expect(q0.headers['content-encoding']).toBe('gzip')
    // a precompressed .gz sibling
    const bin = await get('/out-opt/world/jangan/nav.bin', { 'Accept-Encoding': 'gzip' })
    expect(bin.headers['content-type']).toBe('application/octet-stream')
    expect(bin.headers['content-encoding']).toBe('gzip')
    expect(Number(bin.headers['content-length'])).toBe(GZ.length)
    expect(gunzipSync(bin.body).toString()).toBe(BIN)
    // tiny files are not worth it
    expect((await get('/out-opt/small.json', { 'Accept-Encoding': 'gzip' })).headers['content-encoding']).toBeUndefined()
    // a stale .br (older than its file) is ignored
    const stale = await get('/out-opt/stale.json', { 'Accept-Encoding': 'br, gzip' })
    expect(stale.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(stale.body).toString()).toBe(JSON_BODY)
    // /out gets the same treatment
    const out = await get('/out/index.json', { 'Accept-Encoding': 'gzip' })
    expect(out.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(out.body).toString()).toBe(JSON_BODY)
  })

  it('MIME types; images, audio never compressed; glb and ttf are', async () => {
    const cases: [string, string, string | undefined][] = [
      ['/out-opt/world/jangan/tiles/a.webp', 'image/webp', undefined],
      ['/out-opt/char/man.glb', 'model/gltf-binary', 'gzip'],
      ['/out-opt/world/jangan/nav.bin', 'application/octet-stream', 'gzip'],
      ['/out-opt/index.json', 'application/json; charset=utf-8', 'gzip'],
      ['/out-opt/music/town.ogg', 'audio/ogg', undefined],
      ['/out-opt/fonts/ui.ttf', 'font/ttf', 'gzip'],
      ['/out-opt/icons/a.png', 'image/png', undefined],
    ]
    for (const [path, type, enc] of cases) {
      const r = await get(path, { 'Accept-Encoding': 'gzip' })
      expect(r.status, path).toBe(200)
      expect(r.headers['content-type'], path).toBe(type)
      expect(r.headers['content-encoding'], path).toBe(enc)
      if (!enc) expect(r.headers.vary, path).toBeUndefined()
    }
  })

  it('caches content-hashed files for a year, everything else revalidates', async () => {
    const hashed = await get('/assets/index-BxYz12_a.js', { 'Accept-Encoding': 'gzip' })
    expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect((await get('/out-opt/char/man.glb')).headers['cache-control']).toBe('no-cache')
    expect((await get('/')).headers['cache-control']).toBe('no-cache')
    expect(isHashedName('index-BxYz12_a.js')).toBe(true)
    expect(isHashedName('cho-won-001-m.glb')).toBe(false)
    expect(isHashedName('geomin-won-01-m.glb')).toBe(false)
    expect(isHashedName('slim-report.json')).toBe(false)
    // If-Modified-Since without an ETag
    const first = await get('/out-opt/char/man.glb')
    expect((await get('/out-opt/char/man.glb', { 'If-Modified-Since': String(first.headers['last-modified']) })).status).toBe(304)
  })

  it('blocks path traversal under /out-opt', async () => {
    for (const path of [
      '/out-opt/../secret.txt',
      '/out-opt/%2e%2e/secret.txt',
      '/out-opt/..%2fsecret.txt',
      '/out-opt/..%5csecret.txt',
      '/out-opt/%00/index.json',
      '/out-opt/.hidden',
      '/out-opt/C:/Windows/win.ini',
      '/out-opt//etc/passwd',
      '/out-opt/%252e%252e/secret.txt',
      '/out-optx/index.json',
    ]) {
      const r = await get(path, { 'Accept-Encoding': 'br, gzip' })
      expect(r.body.toString(), path).not.toContain('TOP SECRET')
      expect([400, 404], `${path} -> ${r.status}`).toContain(r.status)
    }
    expect((await get('/out-opt/missing.json')).status).toBe(404)
  })

  it('parses Accept-Encoding', () => {
    expect(acceptedEncodings('gzip, deflate, br')).toEqual({ br: true, gzip: true })
    expect(acceptedEncodings('br;q=0, gzip')).toEqual({ br: false, gzip: true })
    expect(acceptedEncodings('*')).toEqual({ br: true, gzip: true })
    expect(acceptedEncodings('*;q=0, gzip')).toEqual({ br: false, gzip: true })
    expect(acceptedEncodings(undefined)).toEqual({ br: false, gzip: false })
    expect(acceptedEncodings('identity')).toEqual({ br: false, gzip: false })
  })
})
