// H-12 hunt, lens "editor data loss" (docs/WAVE_PLAN8.md §6.7 lens 1): a crash mid-Save, two tabs, the lock left
// behind, a journal at its cap, revert of a change whose base hash moved (a coast re-run), undo after a Publish.
// Every test here FAILS on 95d49e2 and documents one finding; F-12 makes them pass. No product code is changed here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyHeightLayer, encodeHeightLayer, paintWord, regionIdOf, validateWorldEditPlacements,
} from '../../../packages/shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../../../packages/convert/src/world/manifest.ts'
import { PUBLISH_CHECKS, WORLD_EDITS_REPORT_FORMAT, WORLD_EDITS_REPORT_VERSION, type WorldEditsReport } from '../../../packages/convert/src/world/edits/checks.ts'
import { WriteScope } from '../editor-api/atomic.ts'
import { createEditorApi, type EditorApi } from '../editor-api/api.ts'
import { layerFile } from '../editor-api/client.ts'
import { takeEditorLock } from '../editor-api/lock.ts'
import { API_PREFIX, LEASE_HEADER, MAX_BODY_BYTES, TOKEN_HEADER, type SessionInfo } from '../editor-api/protocol.ts'
import { preparePublish, publishPaths, writePublished, type PrepareOptions, type PublishPaths } from '../editor-api/publish.ts'
import { EditorStore } from '../editor-api/store.ts'
import { CELLS, GRID } from '../src/editor/lattice.ts'
import { EditSession } from '../src/editor/session.ts'
import { encodeChange, heightLabel, JOURNAL_CAP } from '../src/editor/history.ts'
import { ObjectEdits, retailRef } from '../src/editor/object-edits.ts'

const WORLD = 'jangan-fields'
const TOKEN = 'abuse-token-0123456789abcdef'
const PORT = 5185
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://${HOST}`

const tmps: string[] = []
const apis: EditorApi[] = []
afterEach(() => {
  for (const a of apis.splice(0)) a.close()
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})
const tmp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `sro-abuse-w12-dl-${tag}-`))
  tmps.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

// --- the API without a socket (as editor-api.test.ts) ------------------------------------------------------------------

function makeApi(extra: Partial<Parameters<typeof createEditorApi>[0]> = {}): { api: EditorApi; repo: string; work: string } {
  const root = tmp('api')
  const repo = join(root, 'repo')
  const work = join(root, 'work')
  mkdirSync(join(repo, 'content', 'world-edits', WORLD), { recursive: true })
  mkdirSync(work, { recursive: true })
  const api = createEditorApi({ repoRoot: repo, workRoot: work, world: WORLD, port: PORT, token: TOKEN, step2: { watchMs: 0 }, ...extra })
  apis.push(api)
  return { api, repo, work }
}

function request(api: EditorApi, path: string, body: unknown, headers: Record<string, string | undefined> = {}): Promise<{ status: number; json: () => any }> {
  const all = Object.fromEntries(Object.entries({ host: HOST, [TOKEN_HEADER]: TOKEN, origin: ORIGIN, 'content-type': 'application/json', ...headers }).filter(([, v]) => v !== undefined))
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', url: API_PREFIX + path, headers: all })
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false, setHeader: () => {},
      end: (data?: string | Uint8Array) => {
        const b = Buffer.from(data ?? '')
        resolve({ status: res.statusCode, json: () => JSON.parse(b.toString('utf8')) })
      },
      destroy: () => reject(new Error('destroyed')),
    }
    api.handle(req, res as unknown as ServerResponse, () => resolve({ status: -1, json: () => null }))
  })
}
const session = async (api: EditorApi, body: { lease?: string; force?: boolean } = {}) => (await request(api, 'session', body)).json() as SessionInfo
const pageSave = (api: EditorApi, lease: string | undefined, label: string) =>
  request(api, 'save', { world: WORLD, files: {}, layers: [], journal: [{ id: 1, at: new Date(0).toISOString(), label, tool: 'raise', regions: [(97 << 8) | 171], state: 'done' }] }, { [LEASE_HEADER]: lease })

// --- an engine-free session (as editor-core.test.ts) -------------------------------------------------------------------

const OX = 168, OZ = 97
const REGIONS = [168, 169, 170].flatMap(x => [97, 98].map(z => regionIdOf(x, z)))
const globalH = (GX: number, GZ: number) => Math.fround(5 + 0.137 * Math.sin(GX * 0.21) * 7 + 0.0731 * GZ + 0.01 * ((GX * 31 + GZ * 17) % 13))

function makeRegions(bump = 0) {
  const m = new Map<number, { heights: Float32Array; words: Uint16Array }>()
  for (const id of REGIONS) {
    const rx = id & 0xff, rz = id >> 8
    const heights = new Float32Array(GRID * GRID)
    const words = new Uint16Array(GRID * GRID)
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        heights[gz * GRID + gx] = globalH(rx * CELLS + gx, rz * CELLS + gz) + (bump && gx > 60 ? bump : 0)
        words[gz * GRID + gx] = paintWord(gx < 48 ? 2 : 0, 1)
      }
    }
    m.set(id, { heights, words })
  }
  return m
}

function setup(opts: { bump?: number; resident?: (id: number) => boolean } = {}) {
  const regions = makeRegions(opts.bump ?? 0)
  const resident = opts.resident ?? (() => true)
  const s = new EditSession({
    world: WORLD, originRegion: { x: OX, z: OZ }, regions: REGIONS, placements: [],
    host: { heights: id => (resident(id) ? regions.get(id)?.heights ?? null : null), words: id => (resident(id) ? regions.get(id)?.words ?? null : null) },
  })
  for (const [id, r] of regions) {
    if (!resident(id)) continue
    s.heights.captureBase(id, r.heights)
    s.paint.captureBase(id, r.words)
  }
  return { s, regions }
}

function raise(s: EditSession, x0: number, z0: number, x1: number, z1: number) {
  s.heights.begin('raise', { radiusM: 14, strength: 0.8, softness: 0.5 }, { seed: s.history.peekId() })
  for (let i = 0; i < 20; i++) s.heights.stamp(x0 + ((x1 - x0) * i) / 19, z0 + ((z1 - z0) * i) / 19)
  const c = s.heights.end()!
  return s.record({ height: c }, heightLabel('raise', c), c.regions)
}

// --- a Publish fixture (as editor-publish.test.ts) ---------------------------------------------------------------------

const MANIFEST = (tag: string) => JSON.stringify({
  tag, space: { originRegion: { x: 168, z: 97 } }, regions: [], tiles: [], placements: [], models: [], warnings: [], places: [], spawn: { x: 0, y: 0, z: 0 },
})
const passReport = (): WorldEditsReport => ({
  format: WORLD_EDITS_REPORT_FORMAT, version: WORLD_EDITS_REPORT_VERSION, world: WORLD, verdict: 'pass', complete: true,
  checks: PUBLISH_CHECKS.map(c => ({ id: c.id, key: c.key, title: c.title, status: 'pass' as const, summary: 'ok' })),
  nav: { regions: [], totals: { touched: 0, closed: 0, opened: 0, closedSlope: 0, closedWater: 0, objects: 0 }, problems: [] },
  swim: { deepWaterTiles: 0, deepWaterM2: 0, regions: [] }, timingsMs: {},
})
function publishFixture(): PublishPaths {
  const root = tmp('pub')
  const p = publishPaths(join(root, 'repo'), join(root, 'work'), WORLD)
  mkdirSync(p.layerDir, { recursive: true })
  put(join(p.liveDir, 'manifest.json'), MANIFEST('live'))
  put(join(p.liveDir, 'terrain', 'a.bin'), 'published hill')
  put(join(p.liveDir, 'nav.bin'), 'nav')
  return p
}
const stubs = (calls: string[]): Partial<PrepareOptions> => ({
  convert: async o => {
    calls.push(`convert ${o.edits === null ? 'base' : 'edited'} ${o.only.join(',')}`)
    rmSync(o.stagingDir, { recursive: true, force: true })
    put(join(o.stagingDir, 'manifest.json'), MANIFEST(o.edits === null ? 'base' : 'edited'))
    put(join(o.stagingDir, 'terrain', 'a.bin'), 'retail ground')
    put(join(o.stagingDir, 'nav.bin'), 'nav')
    return { changed: ['terrain/a.bin', 'manifest.json'], removed: [], regions: { core: o.only, ring: [], nav: [] }, drift: [], coast: 'snapshot' }
  },
  optimize: async () => ({ written: [], removed: [] }),
  runTests: async () => ({ ok: true, summary: 'ok' }),
  checks: () => passReport(),
})

// ======================================================================================================================

describe('H-12 editor data loss: two tabs and the writer lease', () => {
  it('a late heartbeat with no other tab open keeps the lease (a hidden or sleeping tab must not strand its unsaved work)', async () => {
    let t = 1_000_000
    const { api } = makeApi({ now: () => t, leaseTtlMs: 15_000 })
    const a = await session(api)
    expect(a.readOnly).toBe(false)
    // Chrome throttles a hidden tab's timers to one wake-up a minute after 5 min (the user is playing Test in game in
    // the other tab), or the PC slept: the next beat comes 60 s later. Nobody else claimed the lease meanwhile.
    t += 60_000
    const beat = await request(api, 'heartbeat', { lease: a.lease })
    // 95d49e2: { ok: false } -> the page goes read-only ("Another World Editor tab took over") although no tab did,
    // never re-claims, and Save is blocked: everything since the last autosave is lost on the reload it asks for.
    expect(beat.json().ok).toBe(true)
    expect((await pageSave(api, a.lease, 'my unsaved stroke')).status).toBe(200)
  })

  it('a duplicated tab (sessionStorage is copied) never gets a second writer lease', async () => {
    const { api } = makeApi()
    const a = await session(api)
    // Chrome "Duplicate tab" copies sessionStorage, so the copy sends tab A's lease back as its "previous" one
    const b = await session(api, { lease: a.lease })
    const sa = await pageSave(api, a.lease, 'tab A')
    const sb = await pageSave(api, b.lease, 'tab B')
    // 95d49e2: B is granted A's very lease; both tabs write, each Save replacing the other's journal and layers
    const writers = [sa.status, sb.status].filter(s => s === 200).length
    expect(writers).toBeLessThanOrEqual(1)
  })
})

describe('H-12 editor data loss: a crash mid-Save', () => {
  it('a Save that fails after its first rename leaves the layers as they were (all or nothing)', () => {
    const root = tmp('save')
    const layerDir = join(root, 'content', 'world-edits', WORLD)
    const workDir = join(root, 'work', 'editor', WORLD)
    mkdirSync(layerDir, { recursive: true })
    const store = new EditorStore({ world: WORLD, layerDir, workDir, scope: new WriteScope([join(root, 'content', 'world-edits'), join(root, 'work', 'editor')]) })
    const layer = (dh: number) => {
      const h = emptyHeightLayer()
      for (let i = 2000; i < 2400; i++) {
        h.mask[i] = 1
        h.delta[i] = dh
      }
      return encodeHeightLayer(h)
    }
    // save 1: a stroke across the 168/169 seam, both halves
    store.save({ files: [layerFile('height/168_97.png', layer(1)), layerFile('height/169_97.png', layer(1))] })
    const before = readFileSync(join(layerDir, 'height', '168_97.png'))
    const before169 = readFileSync(join(layerDir, 'height', '169_97.png'))
    // save 2 is interrupted after its first rename (simulated: the second target refuses the rename, as a file held
    // open by an indexer / git / an editor does on Windows past the retries, or a killed process would leave it)
    rmSync(join(layerDir, 'height', '169_97.png'))
    mkdirSync(join(layerDir, 'height', '169_97.png', 'held'), { recursive: true })
    expect(() => store.save({ files: [layerFile('height/168_97.png', layer(2)), layerFile('height/169_97.png', layer(2))] })).toThrow()
    // F-12: the simulation itself removed 169_97 (to put a folder in its way); the holder lets go and the file is back
    // as save 1 left it, so the consistency check below sees only what the interrupted Save did
    rmSync(join(layerDir, 'height', '169_97.png'), { recursive: true })
    writeFileSync(join(layerDir, 'height', '169_97.png'), before169)
    // 95d49e2: 168_97 already holds save 2 while 169_97 and the journal hold save 1: a 1 m cliff along the seam that
    // no journal entry can undo, and the page never looks at `consistent` / `mismatched` on load
    expect(readFileSync(join(layerDir, 'height', '168_97.png')).equals(before)).toBe(true)
    expect(store.consistency().consistent).toBe(true)
  })
})

describe('H-12 editor data loss: the lock left behind', () => {
  it('a lock whose pid now belongs to another program (Windows reuses pids, e.g. after a reboot) does not lock the editor out', () => {
    const file = join(tmp('lock'), 'editor.lock')
    // the owner line a killed editor left: its pid is alive again, but as some other process (here: the test runner's
    // parent), and no editor answers on its port
    writeFileSync(file, `pid=${process.ppid} host=${hostname()} port=59997 2026-09-30T08:00:00.000Z\n`)
    const lock = takeEditorLock(file, PORT)
    // 95d49e2: held=false forever ("Another World Editor is open ... this one can look but not change anything"),
    // with no take-over in the page; only deleting work/editor/editor.lock by hand gets the editor back
    expect(lock.held).toBe(true)
    lock.release()
  })
})

describe('H-12 editor data loss: a journal at its cap', () => {
  it('the page journal always fits one Save request (it must fold before Save starts failing with 413)', () => {
    const { s } = setup()
    // one full-size grass stroke (Size 60 = radius 30 m, dragged 200 m), as the slider allows
    s.grass.begin('more', { radiusM: 30, strength: 1, softness: 0.5 })
    for (let x = 100; x <= 300; x += 2) s.grass.stamp(x, -100)
    const g = s.grass.end()!
    const c = s.record({ grass: g }, 'grass', g.regions)
    const bytes = JSON.stringify(encodeChange(c)).length
    // the page sends EVERY record with every Save (session.buildSave -> journal: history.changes.map(encodeChange));
    // 95d49e2: History capped only the count (JOURNAL_CAP = 2,000), never the bytes, and the API refuses bodies over
    // 128 MB: ~400 such strokes, and from then on Save, the 2-minute autosave and Publish (which saves first) all
    // failed with "the request is larger than 128 MB" until the page was reloaded, losing everything since the last save.
    // F-12 (DL-3): the journal folds by bytes too. The hunter's assertion (128 MB / one stroke >= JOURNAL_CAP) could
    // only pass by raising the body limit past 600 MB; it now checks what matters: after JOURNAL_CAP such strokes the
    // records a Save sends stay well under the body limit, with room for the layers.
    for (let i = 1; i < JOURNAL_CAP; i++) s.history.push({ grass: g }, 'grass', g.regions)
    expect(s.history.changes.length * bytes).toBeLessThanOrEqual(MAX_BODY_BYTES * 0.6)
    expect(s.history.changes.length).toBeGreaterThan(100)
    expect(s.history.folded).toBeGreaterThan(0)
  })
})

describe('H-12 editor data loss: the base under an edit moved (a coast re-run)', () => {
  it("Save keeps the base hash the height edit was made on, so Publish can still say 'the ground under your edit changed'", async () => {
    const a = setup()
    raise(a.s, 200, -150, 260, -150)
    const saved = await a.s.buildSave()
    const base0 = saved.files['edits.json'].regions.find(r => r.x === 169 && r.z === 97)!.base
    expect(base0).toMatch(/^[0-9a-f]{64}$/)
    // the coast re-run changes the export's ground in 169,97; the user opens the editor and saves (autosave will)
    const b = setup({ bump: 0.75 })
    b.s.load(JSON.parse(JSON.stringify(saved)))
    const again = await b.s.buildSave()
    // 95d49e2: buildSave recomputes `base` from the export as it is now, so the converter's baseChanged check never fires
    expect(again.files['edits.json'].regions.find(r => r.x === 169 && r.z === 97)!.base).toBe(base0)
  })

  it('a Save while an edited region is not streamed in keeps its base hash (never an empty one)', async () => {
    const a = setup()
    raise(a.s, 200, -150, 260, -150)
    const saved = await a.s.buildSave()
    const far = regionIdOf(169, 97)
    // the editor reopened somewhere else: 169,97 is not resident yet when the first autosave runs
    const b = setup({ resident: id => id !== far })
    b.s.load(JSON.parse(JSON.stringify(saved)))
    const again = await b.s.buildSave()
    // 95d49e2: base '' (baseOf -> null) and the converter only compares when `want` is truthy: the detector is gone
    expect(again.files['edits.json'].regions.find(r => r.x === 169 && r.z === 97)!.base).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a moved object whose export placement changed since is reported, not silently re-based on the next Save', () => {
    const TREE = 'res\\nature\\common\\tree\\tre_tree01.bsr'
    const ROCK = 'res\\nature\\common\\stone_field03.bsr'
    const r0 = regionIdOf(168, 97)
    const pl = (source: string, position: [number, number, number]): WorldPlacement => ({
      objId: 7, source, models: [0], compound: false, position, rotation: [0, 0, 0, 1], yaw: 0,
      flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid: 32770, region: r0, group: 3, inConvertedRegion: true,
    })
    const v1 = new ObjectEdits([pl(TREE, [150, 4, -150])], { x: OX, z: OZ }, WORLD)
    const ref = retailRef(r0, 32770)
    v1.set(ref, { ...v1.current(ref)!, position: [160, 4, -150] })
    const file1 = v1.toFile()
    // a re-export: (168_97, 32770) is now another object, 6 m away (the coast moved it, or retail data changed)
    const v2Placement = pl(ROCK, [150, 4, -144])
    const v2 = new ObjectEdits([v2Placement], { x: OX, z: OZ }, WORLD)
    const loadProblems = v2.loadFile(file1)
    const file2 = v2.toFile()
    const validate = validateWorldEditPlacements(file2, {
      world: WORLD, originRegion: { x: OX, z: OZ },
      placement: (region, uid) => (region === r0 && uid === 32770 ? { source: ROCK, position: v2Placement.position, yaw: 0 } : undefined),
    })
    // 95d49e2: loadFile ignores `from` and `source`, and toFile writes the NEW export's source and position as `from`,
    // so the validator's "the object changed / moved under the edit" can never fire after one Save: the move is
    // silently applied to a different object (WORLD_EDITOR §3.2: "never a silent apply")
    expect([...loadProblems, ...validate.problems].some(p => /changed|moved/.test(p))).toBe(true)
  })
})

describe('H-12 editor data loss: undo after a Publish', () => {
  it('undoing the only published change and publishing again takes the change off the map', async () => {
    const p = publishFixture()
    const r = (97 << 8) | 171
    // publish 1 kept change 1 (a raise in 171,97); the user then pressed Undo (or "revert" on that row): the change is
    // a page record with state 'undone', no new id, and the now empty height layer was removed by the Save
    writePublished(p.editorDir, { kept: [{ n: 1, at: new Date(0).toISOString(), journalId: 1, changes: ['Raised the ground at 171,97'] }], deployedThrough: 0 })
    put(join(p.editorDir, 'journal.ndjson'), [
      JSON.stringify({ format: 'sro-editor-journal', version: 1, world: WORLD, head: 0, folded: 0, nextId: 2, files: {} }),
      JSON.stringify({ id: 1, label: 'Raised the ground at 171,97', tool: 'raise', regions: [r], record: true, state: 'undone' }),
    ].join('\n') + '\n')
    const calls: string[] = []
    const rec = await preparePublish({ paths: p, ...stubs(calls) })
    // 95d49e2: "Nothing to publish: there are no edits since the last publish." The live map (and Deploy) keep the
    // hill the editor no longer shows; only a full convert or Undo publish (newest only) removes it
    expect(rec.sentence).not.toMatch(/Nothing to publish/)
    expect(calls.some(c => c.startsWith('convert edited'))).toBe(true)
  })
})
