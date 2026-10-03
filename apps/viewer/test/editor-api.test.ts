// The World Editor's local API (WE-A, docs/WORLD_EDITOR.md §2.2, §3.4, §3.5; docs/WAVE_PLAN8.md §6.2): the request
// checks (token, Host, Origin, cross-site), one editor at a time (the process lock, the tab lease), atomic layer I/O
// (temp + fsync + rename, two-phase, nothing outside its folders), the layer PNGs (also against sharp, the
// converter's codec), and the journal: replay after a restart, undo / redo / a new change truncating the redo tail,
// the cap folding the oldest changes, and the consistency check when the layers change outside the editor.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeHeightLayer, encodeHeightLayer, encodePaintLayer, emptyHeightLayer, emptyPaintLayer, paintWord,
} from '../../../packages/shared/src/world-edits/codecs.ts'
import { WORLD_EDITS_PLACEMENTS_FORMAT } from '../../../packages/shared/src/world-edits/types.ts'
import { commitFiles, PathError, resolveUnder, WriteScope } from '../editor-api/atomic.ts'
import { createEditorApi, type EditorApi } from '../editor-api/api.ts'
import { journalChange, jsonFile, layerFile } from '../editor-api/client.ts'
import { takeEditorLock } from '../editor-api/lock.ts'
import {
  applyPatch, decodePatch, diffPixels, emptyLayerPixels, emptyLayerState, encodePatch, type ChangePatch, type LayerState,
  type PatchOp,
} from '../editor-api/patch.ts'
import { decodePng, encodePng } from '../editor-api/png.ts'
import {
  API_PREFIX, LAYER_FORMATS, LEASE_HEADER, TOKEN_HEADER, bytesToPixels, type JournalEntry, type SaveRequest,
  type SessionInfo,
} from '../editor-api/protocol.ts'
import { layerPixelsFromPng } from '../editor-api/store.ts'

const TOKEN = 'test-token-0123456789abcdef'
const PORT = 5185
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://${HOST}`
const WORLD = 'jangan-fields'

const tmps: string[] = []
const apis: EditorApi[] = []
afterEach(() => {
  for (const a of apis.splice(0)) a.close()
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})

function sandbox(): { repo: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'sro-editor-api-'))
  tmps.push(root)
  const repo = join(root, 'repo')
  const work = join(root, 'work')
  mkdirSync(join(repo, 'content', 'world-edits', WORLD), { recursive: true })
  mkdirSync(work, { recursive: true })
  return { repo, work }
}

function makeApi(box: { repo: string; work: string }, extra: Partial<Parameters<typeof createEditorApi>[0]> = {}): EditorApi {
  const api = createEditorApi({ repoRoot: box.repo, workRoot: box.work, world: WORLD, port: PORT, token: TOKEN, ...extra })
  apis.push(api)
  return api
}

interface Reply {
  status: number
  type: string
  body: Buffer
  json: () => any
}

/** One request through the middleware (no socket). */
function request(api: EditorApi, opts: { method?: string; path: string; headers?: Record<string, string | undefined>; body?: unknown }): Promise<Reply> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST')
  const defaults: Record<string, string | undefined> = { host: HOST, [TOKEN_HEADER]: TOKEN }
  if (method === 'POST') {
    defaults.origin = ORIGIN
    defaults['content-type'] = 'application/json'
  }
  const headers = Object.fromEntries(Object.entries({ ...defaults, ...opts.headers }).filter(([, v]) => v !== undefined))
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage
  Object.assign(req, { method, url: API_PREFIX + opts.path, headers })
  return new Promise((resolve, reject) => {
    const out: Record<string, string> = {}
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader: (k: string, v: string) => {
        out[k.toLowerCase()] = v
      },
      end: (data?: string | Uint8Array) => {
        const body = Buffer.from(data ?? '')
        resolve({ status: res.statusCode, type: out['content-type'] ?? '', body, json: () => JSON.parse(body.toString('utf8')) })
      },
      destroy: () => reject(new Error('destroyed')),
    }
    api.handle(req, res as unknown as ServerResponse, () => resolve({ status: -1, type: '', body: Buffer.alloc(0), json: () => null }))
  })
}

async function openSession(api: EditorApi, body: { lease?: string; force?: boolean } = {}): Promise<SessionInfo> {
  const r = await request(api, { path: 'session', body })
  expect(r.status).toBe(200)
  return r.json() as SessionInfo
}

const save = (api: EditorApi, lease: string | undefined, body: SaveRequest | Record<string, unknown>) =>
  request(api, { path: 'save', body, headers: { [LEASE_HEADER]: lease } })

// --- request checks ---------------------------------------------------------------------------------------------

describe('the request checks (D3)', () => {
  it('answers only with the token, on 127.0.0.1:<port>, to its own origin', async () => {
    const api = makeApi(sandbox())
    expect((await request(api, { path: 'status' })).status).toBe(200)
    // Host: DNS rebinding and other names.
    for (const host of ['evil.example:5185', 'localhost:5185', '127.0.0.1:5173', '127.0.0.1', undefined]) {
      const r = await request(api, { path: 'status', headers: { host } })
      expect(r.status, String(host)).toBe(403)
    }
    // Token: missing, wrong, prefix.
    for (const t of [undefined, 'nope', TOKEN.slice(0, -1), TOKEN + 'x']) {
      const r = await request(api, { path: 'status', headers: { [TOKEN_HEADER]: t } })
      expect(r.status, String(t)).toBe(401)
    }
    // Origin: another site, another port; a POST without one.
    for (const origin of ['http://evil.example', 'http://127.0.0.1:5173', 'http://localhost:5185', 'null']) {
      expect((await request(api, { path: 'status', headers: { origin } })).status, origin).toBe(403)
      expect((await request(api, { path: 'session', body: {}, headers: { origin } })).status, origin).toBe(403)
    }
    expect((await request(api, { path: 'session', body: {}, headers: { origin: undefined } })).status).toBe(403)
    // Cross-site fetch metadata.
    expect((await request(api, { path: 'status', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await request(api, { path: 'status', headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403)
    expect((await request(api, { path: 'status', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
    // A POST must be JSON (no form posts).
    expect((await request(api, { path: 'session', body: {}, headers: { 'content-type': 'text/plain' } })).status).toBe(415)
  })

  it('leaves every other URL to the next middleware and refuses unknown routes', async () => {
    const api = makeApi(sandbox())
    let passed = false
    const req = Object.assign(Readable.from([]), { method: 'GET', url: '/editor.html?k=x', headers: { host: 'evil.example' } })
    api.handle(req as unknown as IncomingMessage, {} as ServerResponse, () => {
      passed = true
    })
    expect(passed).toBe(true)
    expect((await request(api, { path: 'nope' })).status).toBe(404)
    expect((await request(api, { path: 'save' })).status).toBe(404) // GET save
  })
})

// --- one editor at a time ---------------------------------------------------------------------------------------

describe('one editor at a time (D4)', () => {
  it('a second editor process serves read-only while another holds the lock; a stale lock is taken over', async () => {
    const box = sandbox()
    const lockFile = join(box.work, 'editor', 'editor.lock')
    const host = (await import('node:os')).hostname()
    const first = makeApi(box)
    expect(first.lock.held).toBe(true)
    expect(readFileSync(lockFile, 'utf8')).toMatch(new RegExp(`^pid=${process.pid} host=\\S+ port=${PORT} `))
    first.close()
    expect(existsSync(lockFile)).toBe(false)
    // Another editor process (a live pid on this host) holds it: this one is read-only, its writes are refused.
    // (a fresh time: a line older than LOCK_STALE_MS is stale whatever its pid, H-12 DL-8)
    const otherOwner = `pid=999999 host=${host} port=5185 ${new Date().toISOString()}`
    writeFileSync(lockFile, otherOwner + '\n')
    const second = makeApi(box, { port: 5186, alive: () => true })
    expect(second.lock.held).toBe(false)
    const H2 = { host: '127.0.0.1:5186', origin: 'http://127.0.0.1:5186' }
    const s = await request(second, { path: 'session', body: {}, headers: H2 })
    expect(s.json().readOnly).toBe(true)
    expect(s.json().reason).toMatch(/Another World Editor is open/)
    expect((await request(second, { path: 'save', body: {}, headers: H2 })).status).toBe(423)
    second.close()
    expect(readFileSync(lockFile, 'utf8').trim()).toBe(otherOwner) // never removes another's lock
    // A lock left by a dead process on this host is taken over.
    const third = makeApi(box, { alive: () => false })
    expect(third.lock.held).toBe(true)
    // Vite restarting its server in this process takes its own lock again; the old server's release keeps the new one.
    const restarted = takeEditorLock(lockFile, PORT, () => true)
    expect(restarted.held).toBe(true)
    third.close()
    expect(existsSync(lockFile)).toBe(true)
    restarted.release()
    expect(existsSync(lockFile)).toBe(false)
  })

  it('DL-5: a killed editor\'s lock is taken over with a message, once; a read-only editor takes it once that one dies', async () => {
    const box = sandbox()
    const lockFile = join(box.work, 'editor', 'editor.lock')
    const host = (await import('node:os')).hostname()
    mkdirSync(join(box.work, 'editor'), { recursive: true })
    // the line a killed editor leaves (its pid gone)
    writeFileSync(lockFile, `pid=999998 host=${host} port=5185 ${new Date().toISOString()}\n`)
    const logs: string[] = []
    const lock = takeEditorLock(lockFile, PORT, () => false, { log: l => logs.push(l) })
    expect(lock.held).toBe(true)
    expect(lock.tookOver).toMatch(/^pid=999998 /)
    expect(logs[0]).toMatch(/process 999998\) did not close cleanly.*took over its lock/)
    expect(readFileSync(lockFile, 'utf8')).toMatch(new RegExp(`^pid=${process.pid} `))
    lock.release()
    expect(existsSync(lockFile)).toBe(false)
    // through the API: the first tab is told, once
    writeFileSync(lockFile, `pid=999998 host=${host} port=5185 ${new Date().toISOString()}\n`)
    const api = makeApi(box, { alive: () => false })
    expect(api.lock.held).toBe(true)
    const a = await openSession(api)
    expect(a.readOnly).toBe(false)
    expect(a.notice).toMatch(/did not close cleanly/)
    expect((await openSession(api, { lease: a.lease })).notice).toBeUndefined()
    api.close()
    // a second editor started while the first runs is read-only, then takes the lock once the first is killed
    let firstAlive = true
    writeFileSync(lockFile, `pid=999997 host=${host} port=5185 ${new Date().toISOString()}\n`)
    const second = makeApi(box, { port: 5186, alive: () => firstAlive, lockWatchMs: 10 })
    const H2 = { host: '127.0.0.1:5186', origin: 'http://127.0.0.1:5186' }
    expect(second.lock.held).toBe(false)
    expect((await request(second, { path: 'session', body: {}, headers: H2 })).json().readOnly).toBe(true)
    firstAlive = false
    for (let i = 0; i < 100 && !second.lock.held; i++) await new Promise(r => setTimeout(r, 10))
    expect(second.lock.held).toBe(true)
    const s = (await request(second, { path: 'session', body: {}, headers: H2 })).json() as SessionInfo
    expect(s.readOnly).toBe(false)
    expect(s.notice).toMatch(/process 999997\) did not close cleanly/)
    second.close()
    expect(existsSync(lockFile)).toBe(false)
  })

  it('DL-5: a takeover is safe: another editor taking it over right now wins; one that died half way is cleared', async () => {
    const box = sandbox()
    const dir = join(box.work, 'editor')
    mkdirSync(dir, { recursive: true })
    const lockFile = join(dir, 'editor.lock')
    const host = (await import('node:os')).hostname()
    const stale = `pid=999996 host=${host} port=5185 ${new Date().toISOString()}`
    writeFileSync(lockFile, stale + '\n')
    // another process holds the takeover gate this instant: this one does not remove the lock under it
    mkdirSync(`${lockFile}.takeover`)
    const busy = takeEditorLock(lockFile, PORT, () => false, { watchMs: 0, log: () => {} })
    expect(busy.held).toBe(false)
    expect(readFileSync(lockFile, 'utf8').trim()).toBe(stale)
    busy.release()
    // a gate left by a process that died half way (older than TAKEOVER_STALE_MS) is cleared, and the lock taken
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${lockFile}.takeover`, old, old)
    const lock = takeEditorLock(lockFile, PORT, () => false, { watchMs: 0, log: () => {} })
    expect(lock.held).toBe(true)
    expect(existsSync(`${lockFile}.takeover`)).toBe(false)
    lock.release()
  })

  it('one tab writes; a second tab is read-only until the lease lapses or it takes over; a reload keeps its lease', async () => {
    let now = 1_000_000
    const api = makeApi(sandbox(), { now: () => now, leaseTtlMs: 15_000 })
    const a = await openSession(api)
    expect(a.readOnly).toBe(false)
    const b = await openSession(api)
    expect(b.readOnly).toBe(true)
    expect(b.lease).toBeUndefined()
    expect(b.reason).toMatch(/Another editor tab/)
    expect((await save(api, undefined, {})).status).toBe(409)
    expect((await save(api, 'forged-lease-forged-lease', {})).status).toBe(409)
    expect((await save(api, a.lease, {})).status).toBe(200)
    // A reload of tab A keeps the writer lease under a new id (H-12 DL-1: the old id stops working, so a duplicated
    // tab that copied sessionStorage never makes two writers).
    now += 10_000
    const a2 = await openSession(api, { lease: a.lease })
    expect(a2.readOnly).toBe(false)
    expect(a2.lease).not.toBe(a.lease)
    expect((await save(api, a.lease, {})).status).toBe(409)
    // Heartbeats keep it alive; a late one (a hidden tab's throttled timer) still renews it while nobody else took it
    // (H-12 DL-2); then tab A goes quiet and B gets it.
    now += 14_000
    expect((await request(api, { path: 'heartbeat', body: { lease: a2.lease } })).json().ok).toBe(true)
    now += 16_000
    expect((await request(api, { path: 'heartbeat', body: { lease: a2.lease } })).json().ok).toBe(true)
    now += 16_000
    const b2 = await openSession(api)
    expect(b2.readOnly).toBe(false)
    expect((await request(api, { path: 'heartbeat', body: { lease: a2.lease } })).json().ok).toBe(false)
    expect((await save(api, a2.lease, {})).status).toBe(409)
    // Take over (force).
    const a3 = await openSession(api, { lease: a.lease, force: true })
    expect(a3.readOnly).toBe(false)
    expect((await save(api, b2.lease, {})).status).toBe(409)
    expect((await save(api, a3.lease, {})).status).toBe(200)
  })
})

// --- atomic I/O ---------------------------------------------------------------------------------------------------

describe('atomic layer I/O (D18)', () => {
  it('refuses paths that leave the folders', () => {
    const root = join(tmpdir(), 'sro-x')
    for (const bad of ['../x.png', 'height/../../x', '/etc/passwd', 'C:/x', 'C:\\x', 'height\\1_1.png', 'a//b', './a', '', 'a\0b']) {
      expect(() => resolveUnder(root, bad), bad).toThrow(PathError)
    }
    expect(resolveUnder(root, 'height/171_97.png')).toBe(join(root, 'height', '171_97.png'))
    const scope = new WriteScope([join(root, 'content')])
    expect(() => scope.check(join(root, 'content-evil', 'x'))).toThrow(PathError)
    expect(() => scope.check(join(root, 'content'))).toThrow(PathError)
    expect(scope.check(join(root, 'content', 'a', 'b'))).toBe(join(root, 'content', 'a', 'b'))
  })

  it('writes all temps before any rename: a failed prepare changes nothing and leaves no temp', () => {
    const { repo } = sandbox()
    const dir = join(repo, 'content', 'world-edits', WORLD)
    const scope = new WriteScope([join(repo, 'content', 'world-edits')])
    writeFileSync(join(dir, 'a.json'), 'old-a')
    writeFileSync(join(dir, 'blocker'), 'a file where a folder should be')
    expect(() => commitFiles(scope, [
      { file: join(dir, 'a.json'), data: 'new-a' },
      { file: join(dir, 'blocker', 'b.json'), data: 'b' },
    ])).toThrow()
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('old-a')
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    // Outside the scope: refused before anything is written.
    expect(() => commitFiles(scope, [{ file: join(dir, 'a.json'), data: 'x' }, { file: join(repo, 'evil.txt'), data: 'x' }])).toThrow(PathError)
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('old-a')
    const r = commitFiles(scope, [{ file: join(dir, 'a.json'), data: 'new-a' }, { file: join(dir, 'gone.json'), remove: true }])
    expect(r.written).toEqual([join(dir, 'a.json')])
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('new-a')
  })

  it('saves pixel and JSON layers, reads them back exactly, refuses what cannot be a layer and removes emptied layers', async () => {
    const box = sandbox()
    const api = makeApi(box)
    const s = await openSession(api)
    const h = emptyHeightLayer()
    for (let i = 0; i < 400; i++) {
      h.mask[1000 + i] = 1
      h.delta[1000 + i] = (i - 200) / 256
    }
    h.mask[5] = 1 // an exact zero delta stays an exact zero
    const hpx = encodeHeightLayer(h)
    const p = emptyPaintLayer()
    p.mask[42] = 1
    p.words[42] = paintWord(321, 5)
    const placements = { format: WORLD_EDITS_PLACEMENTS_FORMAT, version: 1, world: WORLD, move: [], drop: [], add: [] }
    const r = await save(api, s.lease, { files: [layerFile('height/171_97.png', hpx), layerFile('paint/171_97.png', encodePaintLayer(p)), jsonFile('placements.json', placements)] })
    expect(r.status, r.body.toString()).toBe(200)
    expect(r.json().written.sort()).toEqual(['height/171_97.png', 'paint/171_97.png', 'placements.json'])
    expect(r.json().warnings).toEqual([])
    const dir = join(box.repo, 'content', 'world-edits', WORLD)
    expect(readdirSync(dir).filter(f => f.startsWith('.'))).toEqual([])
    // Read back through the API: the same values.
    const got = await request(api, { path: 'layer?path=height/171_97.png' })
    expect(got.type).toBe('application/octet-stream')
    const back = bytesToPixels('height', new Uint8Array(got.body))!
    expect(Array.from(back)).toEqual(Array.from(hpx))
    const dec = decodeHeightLayer(back)
    expect(dec.delta[5]).toBe(0)
    expect(dec.delta[1000]).toBe(-200 / 256)
    expect((await request(api, { path: 'json?name=placements.json' })).json()).toEqual(placements)
    expect(readFileSync(join(dir, 'placements.json'), 'utf8')).toBe(JSON.stringify(placements, null, 2) + '\n')
    expect((await request(api, { path: 'layer?path=grass/171_97.png' })).status).toBe(404)
    // Not layers: refused, nothing written.
    for (const bad of ['height/171_97.bin', 'height/256_1.png', 'height/01_1.png', 'notes.txt', '../x.json', 'height/../placements.json']) {
      const rr = await save(api, s.lease, { files: [{ path: bad, json: {} }] })
      expect(rr.status, bad).toBe(400)
    }
    expect((await save(api, s.lease, { files: [{ path: 'height/1_1.png', pixels: 'AAAA' }] })).status).toBe(400)
    expect((await request(api, { path: 'layer?path=../../x.png' })).status).toBe(400)
    // The validators speak as warnings (Save never loses work); Publish refuses them.
    const warn = await save(api, s.lease, { files: [jsonFile('lights.json', [{ id: 'l1', x: 0, y: 0, z: 0, kind: 'torch', colour: [1, 1, 1], intensity: 1, radiusM: 5 }])] })
    expect(warn.status).toBe(200)
    expect(warn.json().warnings.join('\n')).toMatch(/lights\.json/)
    // An emptied layer is removed (an empty edit layer exports byte-identical).
    const rm = await save(api, s.lease, { files: [layerFile('paint/171_97.png', encodePaintLayer(emptyPaintLayer()))] })
    expect(rm.json().removed).toEqual(['paint/171_97.png'])
    expect(existsSync(join(dir, 'paint', '171_97.png'))).toBe(false)
  })
})

// --- PNG ----------------------------------------------------------------------------------------------------------

describe('the layer PNGs', () => {
  it('round-trip every layer kind exactly', () => {
    for (const [kind, f] of Object.entries(LAYER_FORMATS)) {
      const n = f.width * f.height * f.channels
      const data = f.depth === 16 ? new Uint16Array(n) : new Uint8Array(n)
      for (let i = 0; i < n; i++) data[i] = (i * 7919 + (i >> 3)) % (f.depth === 16 ? 65536 : 256)
      const img = decodePng(encodePng({ ...f, data }))
      expect([img.width, img.height, img.channels, img.depth], kind).toEqual([f.width, f.height, f.channels, f.depth])
      expect(Array.from(img.data).every((v, i) => v === data[i]), kind).toBe(true)
    }
  })

  it('reads what sharp (the converter) writes and sharp reads what the API writes', async () => {
    const sharp = createRequire(new URL('../../../packages/convert/package.json', import.meta.url))('sharp')
    const h = emptyHeightLayer()
    for (let i = 0; i < 97 * 97; i += 3) {
      h.mask[i] = 1
      h.delta[i] = ((i % 2000) - 1000) / 256
    }
    const px = encodeHeightLayer(h)
    const fromSharp: Buffer = await sharp(px, { raw: { width: 97, height: 97, channels: 2 } }).toColourspace('grey16').png().toBuffer()
    expect(Array.from(layerPixelsFromPng('height', fromSharp))).toEqual(Array.from(px))
    const ours = encodePng({ ...LAYER_FORMATS.height, data: px })
    const { data, info } = await sharp(ours).toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(2)
    expect(Array.from(new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2))).toEqual(Array.from(px))
  })
})

// --- the journal --------------------------------------------------------------------------------------------------

/** A seeded random walk of edits on two height layers, a paint layer and the placement adds. */
function makeChanges(count: number, seed = 7): Array<{ entry: JournalEntry; patch: ChangePatch }> {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296)
  const state = emptyLayerState()
  const out: Array<{ entry: JournalEntry; patch: ChangePatch }> = []
  for (let id = 1; id <= count; id++) {
    const ops: PatchOp[] = []
    const kind = id % 4
    if (kind === 3) {
      if (!state.json.has('placements.json')) {
        const file = { format: WORLD_EDITS_PLACEMENTS_FORMAT, version: 1, world: WORLD, move: [], drop: [], add: [] }
        ops.push({ op: 'file', file: 'placements.json', before: null, after: file })
        state.json.set('placements.json', JSON.parse(JSON.stringify(file)))
      }
      const adds = (state.json.get('placements.json') as { add: Array<{ id: string }> }).add
      if (adds.length && rnd() < 0.4) {
        const at = Math.floor(rnd() * adds.length)
        ops.push({ op: 'row', file: 'placements.json', list: 'add', key: adds[at]!.id, at, before: adds[at], after: null })
      } else {
        const row = { id: `ed-${id}`, source: 'res\\nature\\common\\stone_field03.bsr', position: [rnd() * 100, 2, -rnd() * 100], yaw: rnd(), scale: 1 }
        ops.push({ op: 'row', file: 'placements.json', list: 'add', key: row.id, at: adds.length, before: null, after: row })
      }
    } else {
      const path = kind === 2 ? 'paint/171_97.png' : `height/${170 + kind}_97.png`
      const k = kind === 2 ? 'paint' : 'height'
      const before = state.pixels.get(path) ?? emptyLayerPixels(k)
      const after = before.slice()
      const c = Math.floor(rnd() * 9000)
      for (let i = 0; i < 300; i++) {
        const v = (c + Math.floor(rnd() * 600)) % (97 * 97)
        if (k === 'height') {
          after[v * 2] = 32768 + Math.round((rnd() - 0.5) * 2000)
          after[v * 2 + 1] = rnd() < 0.1 && id > 8 ? 0 : 0xffff
          if (!after[v * 2 + 1]) after[v * 2] = 32768
        } else {
          after[v * 4] = Math.floor(rnd() * 256)
          after[v * 4 + 1] = Math.floor(rnd() * 4)
          after[v * 4 + 3] = 255
        }
      }
      const op = diffPixels(path, before, after)
      if (op) ops.push(op)
    }
    const patch = { ops }
    applyPatch(state, patch)
    out.push({ entry: { id, label: `change ${id}`, tool: kind === 3 ? 'place' : kind === 2 ? 'paint' : 'raise', regions: [97 * 256 + 171] }, patch })
  }
  return out
}

/** The files a working copy saves (pixels of every layer that changed, JSON files), as save() takes them. */
function filesOf(state: LayerState, paths: Iterable<string>) {
  return [...paths].map(p => {
    if (p.endsWith('.json')) return state.json.has(p) ? jsonFile(p, state.json.get(p)) : { path: p, remove: true as const }
    const kind = p.split('/')[0] as 'height' | 'paint'
    return layerFile(p, state.pixels.get(p) ?? emptyLayerPixels(kind))
  })
}

const PATHS = ['height/171_97.png', 'height/170_97.png', 'paint/171_97.png', 'placements.json']

/** The working copy as the API reads it from disk. */
async function readState(api: EditorApi): Promise<LayerState> {
  const state = emptyLayerState()
  for (const p of PATHS) {
    if (p.endsWith('.json')) {
      const r = await request(api, { path: `json?name=${p}` })
      if (r.status === 200) state.json.set(p, r.json())
    } else {
      const r = await request(api, { path: `layer?path=${p}` })
      if (r.status === 200) state.pixels.set(p, bytesToPixels(p.startsWith('height') ? 'height' : 'paint', new Uint8Array(r.body))!)
    }
  }
  return state
}

function sameState(a: LayerState, b: LayerState): void {
  expect([...a.pixels.keys()].sort()).toEqual([...b.pixels.keys()].sort())
  for (const [k, v] of a.pixels) expect(Array.from(v).every((x, i) => x === b.pixels.get(k)![i]), k).toBe(true)
  expect([...a.json.keys()].sort()).toEqual([...b.json.keys()].sort())
  for (const [k, v] of a.json) expect(JSON.stringify(v), k).toBe(JSON.stringify(b.json.get(k)))
}

describe('the journal (D16, D17)', () => {
  it('patches round-trip through their bytes and apply exactly forwards and backwards', () => {
    const changes = makeChanges(24)
    const state = emptyLayerState()
    for (const c of changes) applyPatch(state, decodePatch(encodePatch(c.patch)))
    const end = emptyLayerState()
    for (const c of changes) applyPatch(end, c.patch)
    sameState(state, end)
    for (const c of [...changes].reverse()) applyPatch(state, decodePatch(encodePatch(c.patch)), false)
    sameState(state, emptyLayerState())
    // A patch that does not fit the state is refused and leaves it untouched.
    const s2 = emptyLayerState()
    expect(() => applyPatch(s2, changes[1]!.patch, false)).toThrow(/does not match/)
    sameState(s2, emptyLayerState())
  })

  it('replays after a restart: the saved layers equal the journal applied to nothing; undo all gives nothing back', async () => {
    const box = sandbox()
    let api = makeApi(box)
    let s = await openSession(api)
    const changes = makeChanges(30)
    const state = emptyLayerState()
    // Save in batches, as the page's autosave would.
    for (let i = 0; i < changes.length; i += 7) {
      const batch = changes.slice(i, i + 7)
      for (const c of batch) applyPatch(state, c.patch)
      const head = Math.min(i + 7, changes.length)
      const r = await save(api, s.lease, { files: filesOf(state, PATHS), journal: { append: batch.map(c => journalChange(c.entry, c.patch)), head } })
      expect(r.status, r.body.toString()).toBe(200)
      expect(r.json().journal.head).toBe(head)
    }
    // Restart: a new API on the same folders.
    api.close()
    api = makeApi(box)
    s = await openSession(api)
    expect(s.consistent).toBe(true)
    expect(s.journal.entries.map(e => e.id)).toEqual(changes.map(c => c.entry.id))
    expect(s.journal.head).toBe(30)
    expect(s.journal.entries.every(e => typeof e.time === 'string' && (e.bytes ?? 0) > 0)).toBe(true)
    const replay = emptyLayerState()
    for (const e of s.journal.entries) {
      const r = await request(api, { path: `patch?id=${e.id}` })
      expect(r.status).toBe(200)
      applyPatch(replay, decodePatch(new Uint8Array(r.body)))
    }
    const disk = await readState(api)
    sameState(replay, disk)
    sameState(replay, state)
    // Undo everything (the page applies backwards and saves the cursor): no layer file is left.
    for (const e of [...s.journal.entries].reverse()) {
      applyPatch(state, decodePatch(new Uint8Array((await request(api, { path: `patch?id=${e.id}` })).body)), false)
    }
    const r = await save(api, s.lease, { files: filesOf(state, PATHS), journal: { head: 0 } })
    expect(r.status, r.body.toString()).toBe(200)
    expect(readdirSync(join(box.repo, 'content', 'world-edits', WORLD), { recursive: true }).filter(f => String(f).endsWith('.png') || String(f).endsWith('.json'))).toEqual([])
    expect(r.json().journal.head).toBe(0)
    expect(r.json().journal.entries).toHaveLength(30) // still redoable
  })

  it('a new change after undo drops the redo tail and its patches; ids never go back', async () => {
    const box = sandbox()
    const api = makeApi(box)
    const s = await openSession(api)
    const changes = makeChanges(6)
    const state = emptyLayerState()
    for (const c of changes) applyPatch(state, c.patch)
    expect((await save(api, s.lease, { files: filesOf(state, PATHS), journal: { append: changes.map(c => journalChange(c.entry, c.patch)), head: 6 } })).status).toBe(200)
    // Undo 5 and 6, then make change 7.
    for (const c of changes.slice(4).reverse()) applyPatch(state, c.patch, false)
    const seven = makeChanges(7)[6]!
    const r = await save(api, s.lease, { journal: { dropAfterId: 4, append: [journalChange({ ...seven.entry, id: 7 }, { ops: [] })], head: 5 } })
    expect(r.status, r.body.toString()).toBe(200)
    expect(r.json().journal.entries.map((e: JournalEntry) => e.id)).toEqual([1, 2, 3, 4, 7])
    const patches = readdirSync(join(box.work, 'editor', WORLD, 'patches')).sort()
    expect(patches).toEqual(['1.bin', '2.bin', '3.bin', '4.bin', '7.bin'])
    expect(r.json().journal.nextId).toBe(8)
    // An id at or below the last one, or a head past the end, is refused and nothing changes.
    const bad = await save(api, s.lease, { journal: { append: [journalChange({ ...seven.entry, id: 6 }, { ops: [] })], head: 6 } })
    expect(bad.status).toBe(400)
    expect((await save(api, s.lease, { journal: { head: 9 } })).status).toBe(400)
    expect((await request(api, { path: 'journal' })).json().entries.map((e: JournalEntry) => e.id)).toEqual([1, 2, 3, 4, 7])
  })

  it('folds the oldest applied changes into the saved state at the cap', async () => {
    const box = sandbox()
    const api = makeApi(box, { journalCap: { maxChanges: 5 } })
    const s = await openSession(api)
    const changes = makeChanges(8)
    const r = await save(api, s.lease, { journal: { append: changes.map(c => journalChange(c.entry, c.patch)), head: 8 } })
    expect(r.status, r.body.toString()).toBe(200)
    const j = r.json().journal
    expect(j.entries.map((e: JournalEntry) => e.id)).toEqual([4, 5, 6, 7, 8])
    expect(j.head).toBe(5)
    expect(j.folded).toBe(3)
    expect(readdirSync(join(box.work, 'editor', WORLD, 'patches')).sort()).toEqual(['4.bin', '5.bin', '6.bin', '7.bin', '8.bin'])
    expect((await request(api, { path: 'patch?id=2' })).status).toBe(404)
    // The byte cap folds too.
    const api2 = makeApi(sandbox(), { journalCap: { maxBytes: 1 } })
    const s2 = await openSession(api2)
    const r2 = await save(api2, s2.lease, { journal: { append: changes.slice(0, 3).map(c => journalChange(c.entry, c.patch)), head: 3 } })
    expect(r2.json().journal.entries).toEqual([])
    expect(r2.json().journal.folded).toBe(3)
  })

  it('takes the page form (WE-U buildSave: layers with their format, a files map, every change record) and loads it back', async () => {
    const box = sandbox()
    const api = makeApi(box)
    const s = await openSession(api)
    const h = emptyHeightLayer()
    h.mask[300] = 1
    h.delta[300] = 1.5
    const b64 = (px: Uint8Array | Uint16Array) => layerFile('x/1_1.png', px).pixels!
    const placements = { format: WORLD_EDITS_PLACEMENTS_FORMAT, version: 1, world: WORLD, move: [], drop: [], add: [] }
    const rec = (id: number, state: string) => ({ id, at: '2026-10-02T06:00:00.000Z', label: `Raised the ground (${id})`, state, regions: [24747], height: { keys: 'AAAA', before: 'AAAA', after: 'AQID' } })
    const page = {
      world: WORLD,
      files: { 'placements.json': placements },
      layers: [{ kind: 'height', x: 171, z: 96, width: 97, height: 97, channels: 2, depth: 16, pixels: b64(encodeHeightLayer(h)) }],
      journal: [rec(1, 'done'), rec(2, 'done'), rec(3, 'done')],
    }
    const r = await save(api, s.lease, page)
    expect(r.status, r.body.toString()).toBe(200)
    expect(r.json().written.sort()).toEqual(['height/171_96.png', 'placements.json'])
    expect(r.json().journal.head).toBe(3)
    const patchDir = join(box.work, 'editor', WORLD, 'patches')
    const t2 = readFileSync(join(patchDir, '2.bin'), 'utf8')
    // Undo 3, drop nothing: only record 3 is rewritten; then a new change 4 after undoing 3 drops 3 (the page's tail).
    const r2 = await save(api, s.lease, { ...page, journal: [rec(1, 'done'), rec(2, 'done'), rec(3, 'undone')] })
    expect(r2.json().journal.head).toBe(2)
    expect(readFileSync(join(patchDir, '2.bin'), 'utf8')).toBe(t2)
    expect(JSON.parse(readFileSync(join(patchDir, '3.bin'), 'utf8')).state).toBe('undone')
    const r3 = await save(api, s.lease, { ...page, layers: [{ kind: 'height', x: 171, z: 96, width: 0, height: 0, channels: 1, depth: 8, pixels: null }], journal: [rec(1, 'done'), rec(2, 'done'), rec(4, 'done')] })
    expect(r3.status, r3.body.toString()).toBe(200)
    expect(r3.json().removed).toEqual(['height/171_96.png'])
    expect(r3.json().journal.entries.map((e: JournalEntry) => e.id)).toEqual([1, 2, 4])
    expect(r3.json().journal.folded).toBe(0)
    expect(readdirSync(patchDir).sort()).toEqual(['1.bin', '2.bin', '4.bin'])
    // load: what the page resumes from.
    await save(api, s.lease, { layers: page.layers })
    const loaded = (await request(api, { path: 'load' })).json()
    expect(loaded.world).toBe(WORLD)
    expect(loaded.files['placements.json']).toEqual(placements)
    expect(loaded.layers).toEqual(page.layers)
    expect(loaded.journal).toEqual([rec(1, 'done'), rec(2, 'done'), rec(4, 'done')])
    // A layer whose format does not match its kind, ids that do not increase, another world: refused, nothing written.
    const bad = [
      { layers: [{ ...page.layers[0], channels: 4 }] },
      { journal: [rec(2, 'done'), rec(1, 'done')] },
      { world: 'jangan' },
    ]
    for (const b of bad) expect((await save(api, s.lease, b)).status, JSON.stringify(b).slice(0, 60)).toBe(400)
    expect((await request(api, { path: 'journal' })).json().entries.map((e: JournalEntry) => e.id)).toEqual([1, 2, 4])
  })

  it('notices layers changed outside the editor, and a reset records them as the new saved state', async () => {
    const box = sandbox()
    const api = makeApi(box)
    const s = await openSession(api)
    const changes = makeChanges(3)
    const state = emptyLayerState()
    for (const c of changes) applyPatch(state, c.patch)
    await save(api, s.lease, { files: filesOf(state, PATHS), journal: { append: changes.map(c => journalChange(c.entry, c.patch)), head: 3 } })
    // (a reload: the lease comes back under a new id, H-12 DL-1)
    const s1 = await openSession(api, { lease: s.lease })
    expect(s1.consistent).toBe(true)
    // git checkout / another tool rewrites a layer.
    const file = join(box.repo, 'content', 'world-edits', WORLD, 'height', '171_97.png')
    const px = layerPixelsFromPng('height', readFileSync(file)) as Uint16Array
    px[1] = 0xffff
    px[0] = 33000
    writeFileSync(file, encodePng({ ...LAYER_FORMATS.height, data: px }))
    const after = await openSession(api, { lease: s1.lease })
    expect(after.consistent).toBe(false)
    expect(after.mismatched).toEqual(['height/171_97.png'])
    const reset = await request(api, { path: 'journal/reset', body: {}, headers: { [LEASE_HEADER]: after.lease } })
    expect(reset.status).toBe(200)
    expect(reset.json().entries).toEqual([])
    expect(reset.json().folded).toBe(3)
    expect((await openSession(api, { lease: after.lease })).consistent).toBe(true)
    expect(readdirSync(join(box.work, 'editor', WORLD, 'patches'))).toEqual([])
  })
})
